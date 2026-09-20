/**
 * Old-baseline / new-implementation differential for the recruitment chain.
 *
 * ## Baseline provenance
 *
 * `test/baseline/recruitment-baseline.ts` is a **verbatim copy** of the pre-refactor
 * recruitment chain, extracted from `git show 64c4759:backend/src/service.ts` by a
 * brace-matching extractor that located each symbol by name and copied its exact
 * source lines.  Nothing was retyped.  At extraction time all 34 blocks were
 * re-extracted from the git blob and confirmed to appear byte-for-byte in the
 * installed file.  The module records the commit, path, and per-symbol source line
 * numbers in `BASELINE_PROVENANCE`.
 *
 * The two sides are therefore genuinely independent: one is frozen text from before
 * the change, the other is the current implementation reached through
 * `RecruitmentContext`.  Comparing the refactored function against itself, or against
 * a hand-written expectation, would prove nothing.
 *
 * ## Generated-ID normalisation
 *
 * Both sides mint ids with `randomUUID` in the same order (delivery ids, timeline
 * entry ids, notification ids are all fingerprinted or randomised), so direct
 * equality is impossible.  Every comparison therefore runs through
 * `normalize()`, which replaces each generated id with `delivery-1`, `timeline-2`,
 * ... **in order of first appearance** while walking the result in a fixed order.
 * That ordering is the point: two runs that generate the same ids in a different
 * sequence are a real difference, and normalisation must not hide it.  Anything not
 * identified as generated is compared literally.
 *
 * ## What is deliberately NOT compared
 *
 * Derived indexes, caches, metrics counters, and the wall-clock duration.  They are
 * not part of the observable result of a recruitment refresh, and one of them
 * (`coordinationRevision` handling) is exactly what a naive differential would be
 * reduced to if the baseline were only the revision write.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import { BaselineRecruitment, BASELINE_PROVENANCE } from "./baseline/recruitment-baseline.js";

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
  dataFile: "/tmp/aedresponse-differential.json",
  fixtureFile: "/tmp/aedresponse-differential-fixture.json",
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

function device(deviceInstanceId: string, userId: string | undefined,
  overrides: Record<string, unknown> = {}) {
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
    },
    ...overrides
  } as never;
}

interface Scenario {
  name: string;
  build(state: PersistentState): void;
  now?: Date;
  forceRevision?: boolean;
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: uuid(301),
    patientDeviceIds: [uuid(300)],
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
    ...overrides
  } as never;
}

function baseWorld(eventOverrides: Record<string, unknown> = {}) {
  const state = emptyState();
  state.devices[uuid(300)] = device(uuid(300), uuid(301));
  state.devices[uuid(300)]!.latestPosition!.position =
    { kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
  state.events[EVENT_ID] = baseEvent(eventOverrides);
  // Pre-seeded so the write probe sees every append.  `appendTimeline` creates this
  // array with `??=` on first use, and the assignment path bypasses the proxy's get
  // trap - which left the FIRST timeline write unlogged on both sides, hiding a
  // reorder between that write and the notification next to it.
  state.timelineByEventId[EVENT_ID] = [];
  return state;
}

function offer(id: string, deviceInstanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventId: EVENT_ID,
    deviceInstanceId,
    request: { expiresAt: new Date(NOW.getTime() + 30_000).toISOString() },
    status: "SENT",
    statusOccurredAt: AT,
    ...overrides
  } as never;
}

const SCENARIOS: Scenario[] = [
  {
    name: "one free candidate receives an offer",
    build(state) { state.devices[uuid(100)] = device(uuid(100), uuid(200)); }
  },
  {
    name: "several candidates, mixed identities, offers in sorted order",
    build(state) {
      state.devices[uuid(104)] = device(uuid(104), uuid(204));
      state.devices[uuid(101)] = device(uuid(101), uuid(201));
      state.devices[uuid(103)] = device(uuid(103), uuid(202));
      state.devices[uuid(102)] = device(uuid(102), uuid(202));
    }
  },
  {
    name: "an expired offer is swept and the candidate is re-offered",
    build(state) {
      state.devices[uuid(100)] = device(uuid(100), uuid(200));
      state.deliveries[uuid(500)] = offer(uuid(500), uuid(100),
        { request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() } });
    }
  },
  {
    name: "an offer whose device became ineligible is swept",
    build(state) {
      state.devices[uuid(100)] = device(uuid(100), uuid(200));
      state.devices[uuid(101)] = device(uuid(101), uuid(201), { availableForResponse: false });
      state.deliveries[uuid(500)] = offer(uuid(500), uuid(101));
    }
  },
  {
    name: "a live offer to an eligible device is left alone",
    build(state) {
      state.devices[uuid(100)] = device(uuid(100), uuid(200));
      state.deliveries[uuid(500)] = offer(uuid(500), uuid(100));
    }
  },
  {
    name: "another event's expired offer is not touched",
    build(state) {
      state.devices[uuid(100)] = device(uuid(100), uuid(200));
      state.deliveries[uuid(500)] = offer(uuid(500), uuid(100), {
        eventId: OTHER_EVENT_ID,
        request: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }
      });
    }
  },
  {
    name: "the ring widens when potential is below target",
    build(state) { state.devices[uuid(100)] = device(uuid(100), uuid(200)); }
  },
  {
    name: "the ring widens only one stage at target with a stale clock",
    build(state) {
      for (let index = 0; index < 3; index += 1) {
        state.devices[uuid(100 + index)] = device(uuid(100 + index), uuid(200 + index));
      }
    },
    now: new Date(NOW.getTime() + 31_000)
  },
  {
    name: "an inactive event",
    build(state) { state.devices[uuid(100)] = device(uuid(100), uuid(200)); },
  },
  {
    name: "a non-recruiting event with forceRevision",
    build(state) { state.devices[uuid(100)] = device(uuid(100), uuid(200)); },
    forceRevision: true
  },
  {
    name: "an accepted responder blocks its own identity's second device",
    build(state) {
      state.devices[uuid(100)] = device(uuid(100), uuid(200));
      state.deliveries[uuid(500)] = offer(uuid(500), uuid(100),
        { status: "ACCEPTED", decision: "ACCEPT" });
      state.devices[uuid(101)] = device(uuid(101), uuid(200));
    }
  },
  {
    name: "an unrecognised radius is snapped before widening",
    build(state) {
      state.devices[uuid(100)] = device(uuid(100), uuid(200));
      (state.events[EVENT_ID] as { currentRecruitmentRadiusMeters: number })
        .currentRecruitmentRadiusMeters = 12_345;
    }
  }
];

// Two scenarios need state that the builder cannot express through the event literal.
SCENARIOS[8]!.build = (state) => {
  state.devices[uuid(100)] = device(uuid(100), uuid(200));
  (state.events[EVENT_ID] as { state: string }).state = "RESOLVED";
};
SCENARIOS[9]!.build = (state) => {
  state.devices[uuid(100)] = device(uuid(100), uuid(200));
  (state.events[EVENT_ID] as { recruitmentState: string }).recruitmentState = "SATURATED";
};

/**
 * Capture one side's observable output, with generated ids replaced by stable
 * placeholders.
 *
 * Aliases are assigned in **insertion order** — `Object.values` over the delivery and
 * notification collections, and array order for the timeline.  That order is
 * deterministic and, more importantly, it is itself part of what is being compared:
 * if the two sides mint the same offers in a different sequence, the aliases differ
 * and the comparison fails.  An earlier version sorted by id first, which sorted by a
 * random UUID and so handed out different aliases on every run — the aliases have to
 * follow creation order or they hide the very thing under test.
 *
 * Replacement is substring-based, because generated ids appear inside timeline
 * messages and inside `messageId` values, not only as standalone fields.
 */
function capture(state: PersistentState, result: unknown) {
  const aliases = new Map<string, string>();
  let counter = 0;
  const alias = (id: string): string => {
    if (!aliases.has(id)) { counter += 1; aliases.set(id, `generated-${counter}`); }
    return aliases.get(id)!;
  };

  const deliveries = Object.values(state.deliveries);
  for (const delivery of deliveries) alias(delivery.id);
  const notifications = Object.values(state.notificationOutboxById);
  for (const notification of notifications) alias(notification.id);
  const timeline = [...(state.timelineByEventId[EVENT_ID] ?? [])];
  for (const entry of timeline) alias(entry.id);

  const pairs = [...aliases];
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [id, name] of pairs) out = out.split(id).join(name);
      return out;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, inner]) => [key, rewrite(inner)]));
    }
    return value;
  };

  // Only the four fields the pre-refactor function returned.  The refactored version
  // additionally returns the refreshed `event` object; that is a convenience equal to
  // `state.events[id]`, which the `event` field below already compares, so including
  // it here would report an intentional API addition as a behaviour change.
  const raw = result as Record<string, unknown>;
  return {
    result: rewrite({
      changed: raw.changed,
      requests: raw.requests,
      previousAudience: raw.previousAudience,
      expiredOffers: raw.expiredOffers
    }),
    state: {
      event: rewrite(state.events[EVENT_ID]),
      deliveries: deliveries.map(delivery => rewrite({
        id: delivery.id,
        eventId: delivery.eventId,
        deviceInstanceId: delivery.deviceInstanceId,
        status: delivery.status,
        statusOccurredAt: delivery.statusOccurredAt,
        decision: delivery.decision,
        request: delivery.request
      })),
      notifications: notifications.map(notification => rewrite({
        id: notification.id,
        name: notification.name,
        recipient: notification.recipient,
        payload: notification.payload
      })),
      timeline: timeline.map(entry => rewrite({
        id: entry.id,
        kind: entry.kind,
        occurredAt: entry.occurredAt,
        message: entry.message
      }))
    }
  };
}

/**
 * A cross-collection write log shared by both sides.
 *
 * Per-collection comparison cannot see a reorder BETWEEN collections, so a run that
 * emitted the notification before the timeline would compare equal to one that did
 * the reverse.  That is not hypothetical: a deliberate swap in the expiry sweep left
 * the differential fully green.
 *
 * The probe wraps the three collections both implementations write through.  It is
 * attached identically to both sides, so it cannot favour either, and it observes
 * real writes rather than being told what happened.  `timelineByEventId` is wrapped
 * lazily because `appendTimeline` creates the per-event array on first use.
 */
function withWriteLog(state: PersistentState): { state: PersistentState; log: string[] } {
  const log: string[] = [];
  const arrays = new WeakMap<object, unknown>();
  const arrayProxy = (target: unknown[]): unknown[] => {
    const cached = arrays.get(target);
    if (cached) return cached as unknown[];
    const proxied = new Proxy(target, {
      get(t, property, receiver) {
        if (property === "push") {
          return (...items: unknown[]) => { log.push("timeline"); return t.push(...(items as never[])); };
        }
        return Reflect.get(t, property, receiver);
      }
    });
    arrays.set(target, proxied);
    return proxied;
  };

  const wrapped = new Proxy(state, {
    get(target, property, receiver) {
      if (property === "deliveries" || property === "notificationOutboxById") {
        const collection = Reflect.get(target, property, receiver) as object;
        const cached = arrays.get(collection);
        if (cached) return cached;
        const name = property === "deliveries" ? "delivery" : "notification";
        const proxied = new Proxy(collection, {
          set(t, key, value, recv) {
            log.push(name);
            return Reflect.set(t, key, value, recv);
          }
        });
        arrays.set(collection, proxied);
        return proxied;
      }
      if (property === "timelineByEventId") {
        const collection = Reflect.get(target, property, receiver) as Record<string, unknown[]>;
        const cached = arrays.get(collection);
        if (cached) return cached;
        const proxied = new Proxy(collection, {
          get(t, key, recv) {
            const value = Reflect.get(t, key, recv);
            return Array.isArray(value) ? arrayProxy(value) : value;
          },
          set(t, key, value, recv) {
            // Store the raw array: the get trap wraps on read.  Wrapping here too
            // would nest two proxies over the same array and log every push twice.
            return Reflect.set(t, key, value, recv);
          }
        });
        arrays.set(collection, proxied);
        return proxied;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  return { state: wrapped, log };
}

function runBaseline(scenario: Scenario): unknown {
  const raw = baseWorld();
  scenario.build(raw);
  const { state, log } = withWriteLog(raw);
  const baseline = new BaselineRecruitment(config);
  const now = scenario.now ?? NOW;
  const result = (baseline as unknown as {
    refreshRecruitmentForEvent: (
      s: PersistentState, e: EventRecord, n: Date, f?: boolean) => unknown;
  }).refreshRecruitmentForEvent(state, state.events[EVENT_ID]!, now,
    scenario.forceRevision ?? false);
  return { ...capture(state, result), writeLog: log };
}

function runCurrent(scenario: Scenario): unknown {
  const raw = baseWorld();
  scenario.build(raw);
  const { state, log } = withWriteLog(raw);
  const service = new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
  const now = scenario.now ?? NOW;
  const ctx = draftRecruitmentContext(state);
  const result = (service as unknown as {
    refreshRecruitmentForEvent: (
      c: unknown, e: EventRecord, n: Date, f?: boolean) => unknown;
  }).refreshRecruitmentForEvent(ctx, state.events[EVENT_ID]!, now,
    scenario.forceRevision ?? false);
  return { ...capture(state, result), writeLog: log };
}

/** The result object, with every generated id replaced by its placeholder. */
function normalizeResult(result: unknown, state: PersistentState): unknown {
  const aliases = new Map<string, string>();
  let counter = 0;
  for (const delivery of Object.values(state.deliveries).sort((l, r) => l.id.localeCompare(r.id))) {
    counter += 1;
    aliases.set(delivery.id, `generated-${counter}`);
  }
  // Only the four fields the pre-refactor function returned.  The refactored version
  // additionally returns the refreshed `event` object; that is a convenience equal to
  // `state.events[id]`, which the caller-side `normalize()` already compares, so
  // including it here would report an intentional API addition as a behaviour change.
  const comparable = (value: unknown): unknown => {
    const record = value as Record<string, unknown>;
    return {
      changed: record.changed,
      requests: record.requests,
      previousAudience: record.previousAudience,
      expiredOffers: record.expiredOffers
    };
  };
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [id, name] of aliases) out = out.split(id).join(name);
      return out;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, rewrite(v)]));
    }
    return value;
  };
  return rewrite(comparable(result));
}

test("the baseline is a verbatim copy, not a retelling", () => {
  assert.equal(BASELINE_PROVENANCE.commit, "64c4759");
  assert.equal(BASELINE_PROVENANCE.path, "backend/src/service.ts");
  assert.ok(Object.keys(BASELINE_PROVENANCE.extractedLines).length >= 30,
    "every extracted symbol records where it came from");
});

for (const scenario of SCENARIOS) {
  test(`differential: ${scenario.name}`, () => {
    const baseline = runBaseline(scenario);
    const current = runCurrent(scenario);
    assert.deepEqual(current, baseline,
      "the refactored chain must produce the same event fields, deliveries, "
      + "notifications and timeline, in the same order, as the frozen pre-refactor "
      + "implementation");
  });
}

test("differential: the comparison actually distinguishes the two sides", () => {
  // A guard on the guard.  If `normalize` collapsed everything to an empty shape, or
  // the scenario builder were ignored, every comparison above would pass vacuously.
  const scenario = SCENARIOS[0]!;
  const baseline = runBaseline(scenario) as { state: { deliveries: unknown[] } };
  assert.equal(baseline.state.deliveries.length, 1,
    "the scenario must actually produce a delivery, or there is nothing to compare");
  const other = SCENARIOS[1]!;
  const otherBaseline = runBaseline(other);
  assert.notDeepEqual(otherBaseline, baseline,
    "two different scenarios must not normalise to the same value");
});
