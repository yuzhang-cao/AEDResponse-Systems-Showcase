/**
 * `refreshRecruitmentForEvent` — the composite operation.
 *
 * Two things are locked here that the earlier rounds could not reach:
 *
 *   1. the delivery expiration sweep, which both READS deliveries by event and
 *      WRITES to them, so it is the first place a stale local binding after an
 *      `updateDelivery` would go unnoticed;
 *   2. the device loop whose sort is business selection order, because each
 *      iteration creates an offer — the first device of an identity to be reached
 *      gets the delivery and the rest are then blocked by the user-level guard.
 *
 * As elsewhere, the write-visibility properties are asserted against the shared
 * staged double, because the legacy adapter mutates committed state and therefore
 * satisfies them for the wrong reason.
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
const OTHER_EVENT_ID = uuid(401);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "/tmp/aedresponse-refresh-test.json",
  fixtureFile: "/tmp/aedresponse-refresh-fixture.json",
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

function world(eventOverrides: Record<string, unknown> = {}) {
  const state = emptyState();
  const patientDevice = uuid(300);
  state.devices[patientDevice] = device(patientDevice, uuid(301));
  state.devices[patientDevice]!.latestPosition!.position =
    { kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
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
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentState: "RECRUITING",
    recruitmentStageStartedAt: AT,
    coordinationRevision: 1,
    createdAt: AT,
    ...eventOverrides
  } as never;
  return { state };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

interface RefreshResult {
  changed: boolean;
  requests: { deliveryId: string; messageId: string }[];
  previousAudience: string[];
  expiredOffers: { deliveryId: string; deviceInstanceId: string; reason: string }[];
  event: EventRecord;
}

function refresh(
  ctx: unknown,
  state: PersistentState,
  now: Date = NOW,
  forceRevision = false
): RefreshResult {
  // The event must come from the SAME context, not from the committed state.  Asking
  // a staged context to refresh while handing it the committed object is precisely
  // the stale-view mistake these tests exist to catch: the second pass would start
  // from the committed revision and silently disagree with the first.
  const context = ctx as { getEvent(eventId: string): EventRecord | undefined };
  const current = context.getEvent(EVENT_ID) ?? state.events[EVENT_ID]!;
  return (service() as unknown as {
    refreshRecruitmentForEvent: (
      c: unknown, e: unknown, n: Date, f?: boolean) => RefreshResult;
  }).refreshRecruitmentForEvent(ctx, current, now, forceRevision);
}

/**
 * A delivery row whose map key and `id` field always agree.
 *
 * This matters: the context finds deliveries by `id` and then writes through
 * `state.deliveries[id]`, so a row whose key and `id` disagree is silently
 * un-updatable. The first version of this fixture had exactly that bug, and the
 * sweep test then asserted a status that had never been written.
 */
interface OfferRow {
  id: string;
  eventId: string;
  deviceInstanceId: string;
  request: { expiresAt: string };
  status: string;
  statusOccurredAt: string;
}

function offerFor(id: string, deviceInstanceId: string,
  overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id,
    eventId: EVENT_ID,
    deviceInstanceId,
    request: { expiresAt: new Date(NOW.getTime() + 30_000).toISOString() },
    status: "SENT",
    statusOccurredAt: AT,
    ...overrides
  };
}

test("sweep: an offer past its window expires once, with its own reason", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const offer = offerFor(uuid(500), candidate, {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  });
  state.deliveries[offer.id] = offer as never;

  const result = refresh(draftRecruitmentContext(state), state);

  assert.equal(result.expiredOffers.length, 1);
  assert.equal(result.expiredOffers[0]!.deliveryId, offer.id);
  assert.equal(result.expiredOffers[0]!.reason, "OFFER_EXPIRED");
  assert.equal(state.deliveries[offer.id]!.status, "EXPIRED");
  assert.equal(state.deliveries[offer.id]!.statusOccurredAt, AT);
  const timeline = state.timelineByEventId[EVENT_ID] ?? [];
  assert.ok(timeline.some(entry => /30-second offer window/.test(entry.message)),
    "the timed-out message is the window one, not the eligibility one");
});

test("sweep: an offer whose device stopped being eligible expires with the other reason", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  state.deliveries[uuid(500)] = offerFor(uuid(500), candidate) as never;
  // Still inside its window, but no longer eligible: out of the ring.
  (state.devices[candidate] as { availableForResponse: boolean }).availableForResponse = false;

  const result = refresh(draftRecruitmentContext(state), state);

  assert.equal(result.expiredOffers.length, 1);
  assert.equal(result.expiredOffers[0]!.reason, "OFFER_NO_LONGER_ELIGIBLE");
  assert.equal(state.deliveries[uuid(500)]!.status, "EXPIRED");
  const timeline = state.timelineByEventId[EVENT_ID] ?? [];
  assert.ok(timeline.some(entry => /server-side eligibility changed/.test(entry.message)));
});

test("sweep: another event's offers are untouched", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const foreign = offerFor(uuid(501), candidate, {
    eventId: OTHER_EVENT_ID,
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  });
  state.deliveries[foreign.id] = foreign as never;

  const result = refresh(draftRecruitmentContext(state), state);

  assert.deepEqual(result.expiredOffers, [],
    "the sweep asks for this event's deliveries, so a foreign one is never reached");
  assert.equal(state.deliveries[foreign.id]!.status, "SENT", "and it keeps its status");
});

test("sweep: a live offer to a still-eligible device is left alone", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  state.deliveries[uuid(500)] = offerFor(uuid(500), candidate) as never;

  const result = refresh(draftRecruitmentContext(state), state);

  assert.deepEqual(result.expiredOffers, []);
  assert.equal(state.deliveries[uuid(500)]!.status, "SENT");
});

test("sweep on a staged context: expiry is staged, and the sweep sees its own writes", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const offer = offerFor(uuid(502), candidate, {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  });
  state.deliveries[offer.id] = offer as never;
  const ctx = stagedRecruitmentContext(state);

  const result = refresh(ctx, state);

  assert.equal(result.expiredOffers.length, 1);
  const staged = ctx.stagedDeliveries().find(entry => entry.id === offer.id);
  assert.ok(staged, "the expiry must be staged through the context");
  assert.equal(staged.status, "EXPIRED");
  assert.equal(staged.statusOccurredAt, AT);
  assert.equal(state.deliveries[offer.id]!.status, "SENT",
    "and the committed row must be untouched: an in-place write would have landed here");
});

test("selection order: the lexicographically first device of an identity gets the offer", () => {
  const { state } = world();
  const user = uuid(200);
  const small = uuid(100);
  const large = uuid(101);
  // Inserted large first, so candidate enumeration order would favour `large`.
  state.devices[large] = device(large, user);
  state.devices[small] = device(small, user);

  const result = refresh(draftRecruitmentContext(state), state);

  assert.equal(result.requests.length, 1,
    "only one offer: the user-level guard blocks the second device");
  assert.equal(result.requests[0]!.messageId, `response-requested:${EVENT_ID}:${small}`,
    "the algorithm sorts candidates before offering, so the smallest device id wins "
    + "regardless of enumeration order. This is business selection order, not "
    + "presentation order: the winner is the device that gets a delivery.");
  assert.equal(Object.values(state.deliveries).length, 1);
  assert.equal(Object.values(state.deliveries)[0]!.deviceInstanceId, small);
});

test("selection order holds when the candidate source is reversed", () => {
  const { state } = world();
  const user = uuid(200);
  const small = uuid(100);
  const large = uuid(101);
  state.devices[small] = device(small, user);
  state.devices[large] = device(large, user);

  const ctx = draftRecruitmentContext(state);
  // A candidate source that enumerates in the opposite order. Contract: unordered.
  const reversed = {
    ...ctx,
    candidateDevices: (event: EventRecord) => [...ctx.candidateDevices(event)].reverse()
  };

  const result = refresh(reversed, state);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]!.messageId, `response-requested:${EVENT_ID}:${small}`,
    "the algorithm owns the ordering, so an adapter cannot change who wins by "
    + "enumerating differently");
});

test("offers are created for every ineligible-free candidate, in device id order", () => {
  const { state } = world();
  const ids = [uuid(105), uuid(103), uuid(104)];
  ids.forEach((id, index) => { state.devices[id] = device(id, uuid(220 + index)); });

  const result = refresh(draftRecruitmentContext(state), state);

  assert.deepEqual(result.requests.map(entry => entry.messageId),
    [...ids].sort((l, r) => l.localeCompare(r))
      .map(id => `response-requested:${EVENT_ID}:${id}`),
    "creation order follows the sorted candidate order");
});

test("the revision advances once, through the context, when anything changed", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const ctx = stagedRecruitmentContext(state);

  const result = refresh(ctx, state);

  assert.equal(result.changed, true);
  assert.equal(result.event.coordinationRevision, 2,
    "exactly one increment for the whole operation, not one per write");
  assert.equal(ctx.stagedEvent(EVENT_ID)!.coordinationRevision, 2);
  assert.equal(state.events[EVENT_ID]!.coordinationRevision, 1,
    "and the committed event is untouched");
});

test("an inactive event writes nothing and reports no offers", () => {
  const { state } = world({ state: "RESOLVED" });
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));

  const result = refresh(draftRecruitmentContext(state), state);

  assert.equal(result.changed, false);
  assert.deepEqual(result.requests, []);
  assert.equal(result.event.coordinationRevision, 1);
  assert.equal(Object.keys(state.deliveries).length, 0);
});

test("a non-recruiting event only bumps the revision, and only when forced", () => {
  const { state } = world({ recruitmentState: "SATURATED" });
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const ctx = stagedRecruitmentContext(state);

  const unforced = refresh(ctx, state);
  assert.equal(unforced.changed, false);
  assert.equal(unforced.event.coordinationRevision, 1);
  assert.deepEqual(ctx.eventUpdateCalls(), [], "no write registered");

  const forced = refresh(ctx, state, NOW, true);
  assert.equal(forced.changed, true);
  assert.equal(forced.event.coordinationRevision, 2);
  assert.deepEqual(ctx.eventUpdateCalls(), [EVENT_ID]);
});

test("read-your-writes: an offer created here is seen by the sweep's own lookup", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const ctx = stagedRecruitmentContext(state);

  const first = refresh(ctx, state);
  assert.equal(first.requests.length, 1);
  const deliveryId = first.requests[0]!.deliveryId;

  // The second pass asks about this device again. It must find the offer created by
  // the first pass, which is only true if creation was visible to the same context.
  const second = refresh(ctx, state);
  assert.deepEqual(second.requests, [],
    "the offer from the previous pass must suppress a duplicate");
  assert.equal(ctx.deliveryCreateCalls().length, 1,
    "exactly one delivery was ever created across both passes");
  assert.equal(ctx.deliveryForDevice(EVENT_ID, candidate)?.id, deliveryId);
});

/**
 * Three responders with live offers already outstanding.
 *
 * With fewer than RECRUITMENT_TARGET_ACCEPTED (3) potential responders the ring
 * widens on EVERY pass, which makes "the second pass changed nothing" impossible to
 * observe.  Three live offers hold `potential` at the target so the stage clock -
 * not the candidate count - decides.
 */
function addThreeHolders(state: PersistentState): void {
  state.devices[uuid(101)] = device(uuid(101), uuid(201));
  state.devices[uuid(102)] = device(uuid(102), uuid(202));
  state.devices[uuid(103)] = device(uuid(103), uuid(203));
  const live = new Date(NOW.getTime() + 30_000).toISOString();
  for (const [index, id] of [uuid(101), uuid(102), uuid(103)].entries()) {
    state.deliveries[uuid(600 + index)] = offerFor(uuid(600 + index), id,
      { request: { expiresAt: live } }) as never;
  }
}

test("offer deadline: staged create, live AT the deadline, expired one ms later", () => {
  const { state } = world({
    // The widest ring, derived from the expansion rule rather than tuned: at the
    // widest stage `nextRadius === undefined` and `advanceRecruitmentStage` breaks on
    // its first iteration, so the stage can never widen or write.  Without this the
    // ring would widen on every pass (potential is below the target of three) and the
    // stage's own timeline entries would sit next to the ones under assertion.
    currentRecruitmentRadiusMeters:
      RECRUITMENT_RADIUS_STAGES_METERS[RECRUITMENT_RADIUS_STAGES_METERS.length - 1],
    recruitmentStageStartedAt: AT
  });
  const candidate = uuid(100);
  const user = uuid(200);
  state.devices[candidate] = device(candidate, user);
  const committedBefore = structuredClone(state);
  const ctx = stagedRecruitmentContext(state);
  const instance = service();

  // A genuine creation through the context, not a hand-built row: this is the code
  // that actually mints `expiresAt`, so the deadline under test is the production one.
  const created = (instance as unknown as {
    createDeliveryIfEligible: (c: unknown, e: unknown, d: DeviceRecord, n: Date) =>
      { deliveryId: string; expiresAt: string } | undefined;
  }).createDeliveryIfEligible(ctx, ctx.getEvent(EVENT_ID)!, state.devices[candidate]!, NOW);
  assert.ok(created, "the candidate must receive an offer");
  assert.deepEqual(ctx.deliveryCreateCalls(), [created.deliveryId]);
  const deadline = new Date(Date.parse(created.expiresAt));
  assert.ok(deadline.getTime() > NOW.getTime(), "the deadline is in the future");
  assert.equal(ctx.deliveryForDevice(EVENT_ID, candidate)!.status, "SENT");

  // Exactly at the deadline the offer is STILL live, because `deliveryIsLive` compares
  // `now <= expiresAt`.  That is the frozen rule taken from the original
  // implementation, so asserting EXPIRED here would encode its opposite.
  const writesAfterCreate = ctx.writeLog().length;
  const atDeadline = refresh(ctx, state, deadline);
  assert.deepEqual(atDeadline.expiredOffers, [],
    "at exactly the deadline the offer has not expired");
  assert.equal(ctx.deliveryForDevice(EVENT_ID, candidate)!.status, "SENT");
  assert.equal(ctx.deliveryForUser(EVENT_ID, user)!.status, "SENT");
  // Positive proof that the fixture really did take the stage out of the picture: a
  // live offer at its deadline plus an inert stage means this pass writes nothing at
  // all.  If the ring could still widen, this would be non-zero and the assertions
  // above would be sitting next to unrelated stage writes.
  assert.equal(atDeadline.changed, false);
  assert.equal(ctx.writeLog().length, writesAfterCreate,
    "the widest ring cannot widen further, so this pass emitted no write");

  // One millisecond past it, both lookups must report EXPIRED.
  const past = new Date(deadline.getTime() + 1);
  const expired = refresh(ctx, state, past);
  assert.equal(expired.expiredOffers.length, 1, "exactly one expiry");
  assert.equal(expired.expiredOffers[0]!.deliveryId, created.deliveryId);
  assert.equal(expired.expiredOffers[0]!.reason, "OFFER_EXPIRED");
  assert.equal(ctx.deliveryForDevice(EVENT_ID, candidate)!.status, "EXPIRED",
    "the device query sees the deadline it just crossed");
  assert.equal(ctx.deliveryForUser(EVENT_ID, user)!.status, "EXPIRED",
    "and so does the user query");

  // Refreshing again changes nothing: a dead offer is not pending any more.
  const writesAfterExpiry = ctx.writeLog().length;
  const again = refresh(ctx, state, past);
  assert.deepEqual(again.expiredOffers, [], "a dead offer cannot expire twice");
  assert.deepEqual(again.requests, [], "and the device is not offered again");
  assert.equal(ctx.writeLog().length, writesAfterExpiry, "no further write was emitted");

  // The whole committed state, not just the event fields: every write above went to
  // the staged delta, so the committed tree must be byte-identical.
  assert.deepEqual(state, committedBefore,
    "the entire committed state must be unchanged after a staged create, an expiry "
    + "at the deadline and a repeat refresh");
});

test("after an expiry both the device and the user lookup report EXPIRED", () => {
  const { state } = world();
  const user = uuid(200);
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, user);
  state.deliveries[uuid(500)] = offerFor(uuid(500), candidate, {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  }) as never;
  const ctx = stagedRecruitmentContext(state);

  refresh(ctx, state);

  assert.equal(ctx.deliveryForDevice(EVENT_ID, candidate)!.status, "EXPIRED",
    "the device query must see the expiry it just wrote");
  assert.equal(ctx.deliveryForUser(EVENT_ID, user)!.status, "EXPIRED",
    "and so must the user query");
  assert.equal(state.deliveries[uuid(500)]!.status, "SENT",
    "while the committed row keeps the pre-transaction status");
});

test("repeat refresh: the second pass emits no duplicate effects", () => {
  const { state } = world();
  const user = uuid(200);
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, user);
  state.deliveries[uuid(500)] = offerFor(uuid(500), candidate, {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  }) as never;
  addThreeHolders(state);
  const ctx = stagedRecruitmentContext(state);

  const first = refresh(ctx, state);
  assert.equal(first.expiredOffers.length, 1);
  const writesAfterFirst = {
    creates: ctx.deliveryCreateCalls().length,
    timeline: ctx.stagedTimeline().length,
    notifications: ctx.stagedNotifications().length,
    updates: ctx.writeLog().filter(entry => entry === "delivery-update").length
  };

  const second = refresh(ctx, state);
  assert.deepEqual(second.expiredOffers, [],
    "an already-expired offer is not pending, so it cannot expire twice");
  assert.deepEqual(second.requests, [], "and the first pass's offer suppresses a second");
  assert.equal(ctx.deliveryCreateCalls().length, writesAfterFirst.creates,
    "no further delivery was created");
  assert.equal(ctx.stagedTimeline().length, writesAfterFirst.timeline,
    "no further timeline entry");
  assert.equal(ctx.stagedNotifications().length, writesAfterFirst.notifications,
    "no further notification");
  assert.equal(ctx.writeLog().filter(entry => entry === "delivery-update").length,
    writesAfterFirst.updates, "no further delivery update");
});

test("cumulative revision: one per changed pass, and the committed event stays put", () => {
  const { state } = world();
  const user = uuid(200);
  state.devices[uuid(100)] = device(uuid(100), user);
  state.deliveries[uuid(500)] = offerFor(uuid(500), uuid(100), {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  }) as never;
  addThreeHolders(state);
  const ctx = stagedRecruitmentContext(state);

  const first = refresh(ctx, state);
  assert.equal(first.expiredOffers.length, 1);
  assert.equal(first.event.coordinationRevision, 2, "one increment for the first pass");

  const second = refresh(ctx, state);
  assert.equal(second.event.coordinationRevision, 2,
    "the second pass changed nothing, so the revision holds");

  // A third pass with a real change advances it again, from the staged value.  The
  // change is registered THROUGH the context: mutating the committed event object
  // directly would leave the staged view untouched, so the third pass would not take
  // the branch this test claims to be exercising.
  const staged = ctx.updateEvent(EVENT_ID, (draft) => {
    (draft as { recruitmentState: string }).recruitmentState = "SATURATED";
  });
  assert.equal((staged as { recruitmentState: string }).recruitmentState, "SATURATED",
    "the context write took effect in the staged view");
  const third = refresh(ctx, state, NOW, true);
  assert.equal(third.event.coordinationRevision, 3,
    "cumulative: the increment reads the staged revision, not the committed one");
  assert.equal(ctx.getEvent(EVENT_ID)!.recruitmentState, "SATURATED");

  assert.equal(state.events[EVENT_ID]!.coordinationRevision, 1,
    "and the committed event never moved");
  assert.equal((state.events[EVENT_ID] as { recruitmentState: string }).recruitmentState,
    "RECRUITING", "the committed recruitment state never moved either");
});

test("cross-collection write order: expiries, then the event, then new offers", () => {
  const { state } = world();
  // One offer to expire; three already holding live offers, so the ring does not widen
  // and this test observes the sweep plus the revision write and nothing else.
  state.devices[uuid(100)] = device(uuid(100), uuid(200));
  state.deliveries[uuid(500)] = offerFor(uuid(500), uuid(100), {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  }) as never;
  addThreeHolders(state);
  const ctx = stagedRecruitmentContext(state);

  refresh(ctx, state);

  assert.deepEqual(ctx.writeLog(),
    ["delivery-update", "notification", "timeline", "event"],
    "The sweep's order is update -> NOTIFICATION -> timeline, which is the opposite "
    + "of `createDeliveryIfEligible`'s delivery -> timeline -> notification. The two "
    + "paths genuinely differ in the original implementation, so this is not an "
    + "inconsistency to normalise away: reordering either one is a behaviour change. "
    + "The revision write comes last.");
});

test("a missing updateDelivery aborts before any notification or timeline effect", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  state.deliveries[uuid(500)] = offerFor(uuid(500), candidate, {
    request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
  }) as never;
  const committedBefore = structuredClone(state);
  const ctx = stagedRecruitmentContext(state);

  // An adapter whose read side and write side disagree: the sweep can see the offer
  // but cannot update it.  `updateDelivery` is contracted to throw rather than do
  // nothing, and the point of this test is WHERE it throws - before the two effects
  // that would otherwise record an expiry that never happened.
  const notifications: unknown[] = [];
  const timeline: unknown[] = [];
  let updateAttempts = 0;
  const inconsistent = {
    ...ctx,
    updateDelivery: () => {
      updateAttempts += 1;
      throw new Error("no such delivery in this context's view");
    },
    insertNotification: (...args: unknown[]) => {
      notifications.push(args);
      (ctx.insertNotification as (...a: unknown[]) => void)(...args);
    },
    appendTimeline: (...args: unknown[]) => {
      timeline.push(args);
      (ctx.appendTimeline as (...a: unknown[]) => void)(...args);
    }
  };

  assert.throws(() => refresh(inconsistent, state), /no such delivery/);

  assert.equal(updateAttempts, 1, "the failure is the first write attempt");
  assert.deepEqual(notifications, [],
    "no offer-expired notification may precede the delivery write it describes");
  assert.deepEqual(timeline, [],
    "and no timeline entry may claim the offer expired");
  assert.deepEqual(ctx.writeLog(), [], "nothing reached the staged delta");
  assert.deepEqual(state, committedBefore, "and nothing reached the committed state");
});
