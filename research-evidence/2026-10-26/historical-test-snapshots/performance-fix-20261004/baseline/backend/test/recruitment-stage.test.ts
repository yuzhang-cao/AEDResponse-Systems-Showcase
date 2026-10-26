/**
 * `advanceRecruitmentStage` — the first migrated function that WRITES through the
 * context rather than only reading.
 *
 * The reason this is worth its own round is not the read side.  It is that
 * `event.currentRecruitmentRadiusMeters = ...` on a caller-supplied object works
 * perfectly under the legacy adapter (it mutates the state itself) and silently
 * fails under a transaction adapter, which hands out its own current-view object:
 * the in-memory object would look updated while the transaction registered no
 * change.  That is strictly worse than a stale index, because nothing downstream
 * can observe it.
 *
 * So the locks are: the four event fields end up identical, a write is visible to
 * the same context immediately, and the caller is told to stop using the object it
 * passed in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { AEDResponseService, RECRUITMENT_RADIUS_STAGES_METERS } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type DeviceRecord, type EventRecord, type PersistentState } from "../src/models.js";
import { stagedRecruitmentContext } from "./helpers/staged-recruitment-context.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "/tmp/aedresponse-stage-test.json",
  fixtureFile: "/tmp/aedresponse-stage-fixture.json",
  sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100,
  operatorToken: "operator-test-token",
  production: false
};

const AGREEMENTS = {
  PATIENT: { version: "2.0", acceptedAt: AT },
  VOLUNTEER_RESPONDER: { version: "2.0", acceptedAt: AT },
  PRIVACY_POLICY: { version: "2.0", acceptedAt: AT },
  SENSITIVE_PERSONAL_INFORMATION: { version: "2.0", acceptedAt: AT }
};

function device(deviceInstanceId: string, userId: string | undefined): DeviceRecord {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000),
    agreements: structuredClone(AGREEMENTS),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: AT,
    lastSeenAt: AT,
    lastBootstrapAt: AT,
    latestPosition: {
      observedAt: AT,
      position: { kind: "R", latitude: PATIENT.latitude + 0.005,
        longitude: PATIENT.longitude, accuracyMeters: 12 }
    }
  } as never;
}

/** An event with a valid P, no responders, and no stage clock yet. */
function world(overrides: Record<string, unknown> = {}) {
  const state = emptyState();
  const patientDevice = uuid(300);
  state.devices[patientDevice] = device(patientDevice, uuid(301));
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: uuid(301),
    patientDeviceIds: [patientDevice],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT", fallDetectedAt: AT },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: { source: "PATIENT_APP", observedAt: AT,
      position: { kind: "P", ...PATIENT, accuracyMeters: 12 } },
    currentRecruitmentRadiusMeters: RECRUITMENT_RADIUS_STAGES_METERS[0],
    recruitmentState: "RECRUITING",
    recruitmentStageStartedAt: null,
    coordinationRevision: 1,
    createdAt: AT,
    ...overrides
  } as never;
  return { state };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

function advance(state: PersistentState, now: Date = NOW): {
  changed: boolean;
  event: PersistentState["events"][string];
  ctx: ReturnType<typeof draftRecruitmentContext>;
} {
  const instance = service();
  const ctx = draftRecruitmentContext(state);
  const result = (instance as unknown as {
    advanceRecruitmentStage: (c: unknown, e: unknown, n: Date) =>
      { changed: boolean; event: PersistentState["events"][string] };
  }).advanceRecruitmentStage(ctx, state.events[EVENT_ID], now);
  return { ...result, ctx };
}

/**
 * Eligible responders inside the ring, each with its own user so identity
 * de-duplication cannot collapse them.
 *
 * The expansion rule needs at least `RECRUITMENT_TARGET_ACCEPTED` (3) of these to
 * exercise the timeout branch at all:
 *
 *   expand  <=>  accepted < 3 AND (potential < 3 OR (potential >= 3 AND timedOut))
 *
 * So with fewer than three potential responders the ring widens immediately and
 * keeps widening until potential reaches three or the stages run out.  That is why
 * the very first test below expects the widest ring from a single call.
 */
function addResponders(state: PersistentState, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = uuid(100 + index);
    state.devices[id] = device(id, uuid(200 + index));
  }
}

/** The four fields this function is allowed to touch. */
function snapshot(event: PersistentState["events"][string]) {
  return {
    recruitmentState: event.recruitmentState,
    currentRecruitmentRadiusMeters: event.currentRecruitmentRadiusMeters,
    recruitmentStageStartedAt: event.recruitmentStageStartedAt,
    coordinationRevision: event.coordinationRevision
  };
}

test("no patient position: nothing is written and the stage clock stays unset", () => {
  const { state } = world({ patientPosition: null });
  const before = snapshot(state.events[EVENT_ID]!);
  const { changed, event } = advance(state);

  assert.equal(changed, false);
  assert.deepEqual(snapshot(event), before, "four fields unchanged");
  assert.equal(state.events[EVENT_ID]!.recruitmentStageStartedAt, null,
    "no stage clock without a valid P");
  assert.equal(state.timelineByEventId[EVENT_ID], undefined, "no timeline entry either");
});

test("first valid P starts the stage clock, then widens while short of target", () => {
  const { state } = world();
  const before = snapshot(state.events[EVENT_ID]!);
  assert.equal(before.recruitmentStageStartedAt, null);

  const { changed, event } = advance(state);
  assert.equal(changed, true);
  assert.equal(event.recruitmentStageStartedAt, AT, "clock started at `now`");

  // Zero potential responders is below the target of three, so the timeout is not
  // consulted and the loop widens on every attempt until the stages run out.
  const widest = RECRUITMENT_RADIUS_STAGES_METERS[RECRUITMENT_RADIUS_STAGES_METERS.length - 1];
  assert.equal(event.currentRecruitmentRadiusMeters, widest,
    "short of target with a fresh clock still widens: the timeout gate only applies "
    + "once potential has reached the target");
  assert.equal(event.recruitmentState, before.recruitmentState);
  assert.equal(event.coordinationRevision, before.coordinationRevision,
    "revision is the caller's business, not this function's");
  const timeline = state.timelineByEventId[EVENT_ID] ?? [];
  assert.equal(timeline.length, RECRUITMENT_RADIUS_STAGES_METERS.length - 1,
    "one entry per widening step");
  assert.deepEqual(timeline.map(entry => entry.kind),
    timeline.map(() => "PASSIVE_OBSERVATION"));
});

test("an unrecognised radius is snapped to the first stage and the clock restarted", () => {
  const { state } = world({
    currentRecruitmentRadiusMeters: 12_345,
    recruitmentStageStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString()
  });
  // At target, so the snap is what the assertions see rather than a widening.
  addResponders(state, 3);
  const { changed, event } = advance(state);

  assert.equal(changed, true);
  assert.equal(event.currentRecruitmentRadiusMeters, RECRUITMENT_RADIUS_STAGES_METERS[0]);
  assert.equal(event.recruitmentStageStartedAt, AT, "the stage clock restarted");
});

test("at target with a fresh clock nothing widens", () => {
  const { state } = world({ recruitmentStageStartedAt: AT });
  addResponders(state, 3);
  const { changed, event } = advance(state);

  assert.equal(changed, false);
  assert.equal(event.currentRecruitmentRadiusMeters, RECRUITMENT_RADIUS_STAGES_METERS[0],
    "expansion at target requires the stage timeout; a fresh clock blocks it");
  assert.equal(state.timelineByEventId[EVENT_ID], undefined);
});

test("at target with a stale clock the ring widens exactly one stage", () => {
  const { state } = world({
    recruitmentStageStartedAt: new Date(NOW.getTime()
      - (30 + 1) * 1_000).toISOString()
  });
  addResponders(state, 3);
  const { changed, event } = advance(state);

  assert.equal(changed, true);
  assert.equal(event.currentRecruitmentRadiusMeters, RECRUITMENT_RADIUS_STAGES_METERS[1],
    "one stage, not all of them: the clock restarts on the way");
  assert.equal(event.recruitmentStageStartedAt, AT, "restarted, so the next call waits again");
  const timeline = state.timelineByEventId[EVENT_ID] ?? [];
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]!.kind, "PASSIVE_OBSERVATION");
  assert.match(timeline[0]!.message,
    new RegExp(`radius expanded to ${RECRUITMENT_RADIUS_STAGES_METERS[1]} meters`));
});

test("exactly at the stage timeout does not widen", () => {
  const { state } = world({
    recruitmentStageStartedAt: new Date(NOW.getTime() - 30 * 1_000).toISOString()
  });
  addResponders(state, 3);
  const { changed } = advance(state);
  assert.equal(changed, false,
    "the timeout comparison is strictly `>`, so exactly 30s is not yet timed out");
});

test("read-your-writes: the same context sees the write it just made", () => {
  const { state } = world();
  const ctx = draftRecruitmentContext(state);
  const instance = service();
  const advanceOnce = (): { changed: boolean; event: PersistentState["events"][string] } =>
    (instance as unknown as {
      advanceRecruitmentStage: (c: unknown, e: unknown, n: Date) =>
        { changed: boolean; event: PersistentState["events"][string] };
    }).advanceRecruitmentStage(ctx, state.events[EVENT_ID], NOW);

  assert.equal(state.events[EVENT_ID]!.recruitmentStageStartedAt, null);
  const first = advanceOnce();
  assert.equal(first.event.recruitmentStageStartedAt, AT);

  // Read back through the context, not through the object we were handed.
  assert.equal(ctx.getEvent(EVENT_ID)!.recruitmentStageStartedAt, AT,
    "the write must be visible to the context that performed it, without waiting "
    + "for a commit");

  // A second call through the same context observes the state the first one left,
  // so it does not start the clock again or widen on a fresh stage.
  const second = advanceOnce();
  assert.equal(second.changed, false, "the clock started by the first call is visible");
});

test("the updated event object is returned so the caller can rebind", () => {
  const { state } = world({
    recruitmentStageStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString()
  });
  // At target, so the ring advances a single stage rather than running to the widest.
  addResponders(state, 3);
  const handed = state.events[EVENT_ID]!;
  const { event } = advance(state);

  assert.equal(event.currentRecruitmentRadiusMeters, RECRUITMENT_RADIUS_STAGES_METERS[1]);
  assert.equal(event.id, EVENT_ID, "and it is the same event");
  // Under the legacy adapter the returned object IS the handed one, so this asserts
  // the contract without assuming a copy. A transaction adapter may legitimately
  // return a different object, which is exactly why the caller must rebind.
  assert.equal(handed.currentRecruitmentRadiusMeters, RECRUITMENT_RADIUS_STAGES_METERS[1]);

  // The guarantee that matters: whatever object comes back is the one that agrees
  // with the state the transaction is building.
  assert.equal(event.recruitmentStageStartedAt,
    state.events[EVENT_ID]!.recruitmentStageStartedAt);
});

test("updateEvent returns undefined for an event this view does not have", () => {
  const { state } = world();
  const ctx = draftRecruitmentContext(state);
  let mutated = false;
  const result = ctx.updateEvent(uuid(999), () => { mutated = true; });
  assert.equal(result, undefined);
  assert.equal(mutated, false, "the callback is not run for a missing event");
});

test("stage expansion stops at the widest ring even when short of target", () => {
  const widest = RECRUITMENT_RADIUS_STAGES_METERS[RECRUITMENT_RADIUS_STAGES_METERS.length - 1]!;
  const { state } = world({
    currentRecruitmentRadiusMeters: widest,
    recruitmentStageStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString()
  });
  const { changed, event } = advance(state);

  assert.equal(changed, false, "there is no next stage, however short of target");
  assert.equal(event.currentRecruitmentRadiusMeters, widest);
  assert.equal(state.timelineByEventId[EVENT_ID], undefined, "and nothing is logged");
});

test("the algorithm is already transaction-shaped: writes go through the context", () => {
  const { state } = world({
    recruitmentStageStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString()
  });
  addResponders(state, 3);
  const committedBefore = snapshot(state.events[EVENT_ID]!);
  const ctx = stagedRecruitmentContext(state);

  const result = (service() as unknown as {
    advanceRecruitmentStage: (c: unknown, e: unknown, n: Date) =>
      { changed: boolean; event: EventRecord };
  }).advanceRecruitmentStage(ctx, state.events[EVENT_ID], NOW);

  assert.equal(result.changed, true);
  assert.equal(ctx.eventUpdateCalls().length, 1,
    "exactly one widening step was registered with the transaction");

  // 1. The committed state was not written through.
  assert.deepEqual(snapshot(state.events[EVENT_ID]!), committedBefore,
    "the committed event is untouched: an in-place write would have landed here "
    + "while the transaction heard nothing about it");

  // 2. The staged view holds the change.
  const staged = ctx.stagedEvent(EVENT_ID)!;
  assert.equal(staged.currentRecruitmentRadiusMeters, RECRUITMENT_RADIUS_STAGES_METERS[1]);
  assert.equal(staged.recruitmentStageStartedAt, AT);

  // 3. The returned object agrees with the staged view, so rebinding is safe.
  assert.equal(result.event.currentRecruitmentRadiusMeters,
    RECRUITMENT_RADIUS_STAGES_METERS[1]);
  assert.equal(result.event.recruitmentStageStartedAt, AT);

  // 4. Reading back through the context agrees too.
  assert.equal(ctx.getEvent(EVENT_ID)!.currentRecruitmentRadiusMeters,
    RECRUITMENT_RADIUS_STAGES_METERS[1]);
});

test("a second call through the staged context sees the first call's staged state", () => {
  const { state } = world({
    recruitmentStageStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString()
  });
  addResponders(state, 3);
  const ctx = stagedRecruitmentContext(state);
  const run = (): { changed: boolean; event: EventRecord } =>
    (service() as unknown as {
      advanceRecruitmentStage: (c: unknown, e: unknown, n: Date) =>
        { changed: boolean; event: EventRecord };
    }).advanceRecruitmentStage(ctx, ctx.getEvent(EVENT_ID)!, NOW);

  const first = run();
  assert.equal(first.event.currentRecruitmentRadiusMeters,
    RECRUITMENT_RADIUS_STAGES_METERS[1]);

  // The clock was restarted by the first call, so the second must not widen again -
  // which is only true if the staged write was visible to it.
  const second = run();
  assert.equal(second.changed, false,
    "the restarted stage clock from the first call must be visible in the second");
  assert.equal(second.event.currentRecruitmentRadiusMeters,
    RECRUITMENT_RADIUS_STAGES_METERS[1]);
});

test("an adapter that stages a change but returns nothing is refused, not absorbed", () => {
  const { state } = world({
    recruitmentStageStartedAt: new Date(NOW.getTime() - 3_600_000).toISOString()
  });
  addResponders(state, 3);
  const ctx = stagedRecruitmentContext(state);
  // A contract-violating adapter: it registers the change but hands back no current
  // view.  Falling back to the object we already hold would keep widening from a
  // stale radius while the transaction silently diverged.
  const broken = {
    ...ctx,
    updateEvent: (eventId: string, mutate: (event: EventRecord) => void) => {
      ctx.updateEvent(eventId, mutate);
      return undefined;
    }
  };

  assert.throws(() => (service() as unknown as {
    advanceRecruitmentStage: (c: unknown, e: unknown, n: Date) => unknown;
  }).advanceRecruitmentStage(broken, state.events[EVENT_ID], NOW),
    /could not register a change to event .* no such event in its current view/,
    "the failure must be loud: silently continuing is how writes get lost");
});
