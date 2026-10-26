/**
 * The transaction-backed recruitment context, exercised through a REAL
 * `transactEntities`, not a test double.
 *
 * Three questions, kept apart because they fail differently:
 *
 *   behaviour  — Legacy and Tx must produce the same event fields, deliveries,
 *                notifications and timeline, in the same order;
 *   transaction— read-your-writes inside one transaction, rollback on failure, and
 *                no leakage between transactions;
 *   structure  — the target path's access counts must not grow with unrelated
 *                history.  Counts, not elapsed time: timing on this VM has already
 *                proven non-reproducible, and a write-set size says nothing about
 *                how much was read to compute it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { txRecruitmentContext } from "../src/tx-recruitment-context.js";
import { AEDResponseService, RECRUITMENT_RADIUS_STAGES_METERS } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };
const WIDEST = RECRUITMENT_RADIUS_STAGES_METERS[RECRUITMENT_RADIUS_STAGES_METERS.length - 1];

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "/tmp/aedresponse-txctx.json",
  fixtureFile: "/tmp/aedresponse-txctx-fixture.json",
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
      positionUpdateId: uuid(9_500),
      observedAt: AT,
      serverReceivedAt: AT,
      position: { kind: "R", latitude: PATIENT.latitude + 0.005,
        longitude: PATIENT.longitude, accuracyMeters: 12 }
    },
    ...overrides
  } as never;
}

/**
 * The widest ring and a started stage clock, so `advanceRecruitmentStage` cannot
 * write: at the widest stage `nextRadius === undefined` and it breaks immediately.
 * Derived from the expansion rule, so this fixture isolates the sweep and the offer
 * loop from the stage rather than relying on a tuned radius.
 */
function world(): PersistentState {
  const state = emptyState();
  state.devices[uuid(300)] = device(uuid(300), uuid(301));
  state.devices[uuid(300)]!.latestPosition!.position =
    { kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    recruitmentState: "RECRUITING",
    patientUserId: uuid(301),
    patientDeviceIds: [uuid(300)],
    unavailableAedIds: [],
    patientPairId: uuid(702),
    // The full FALL_CONTEXT shape: the store validates against the Watch trigger
    // schema, so a partial literal is rejected before any recruitment runs.
    observation: {
      schemaVersion: "2.0",
      eventId: EVENT_ID,
      observationKind: "FALL_CONTEXT",
      fallDetectedAt: AT,
      patientPositionObservedAt: AT,
      fallResolution: "UNRESPONSIVE",
      appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", ...PATIENT, accuracyMeters: 12 }
    },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    patientPosition: {
      positionUpdateId: uuid(9_600),
      source: "IPHONE_PRIMARY",
      observedAt: AT,
      serverReceivedAt: AT,
      position: { kind: "P", ...PATIENT, accuracyMeters: 12 }
    },
    currentRecruitmentRadiusMeters: WIDEST,
    recruitmentStageStartedAt: AT,
    coordinationRevision: 1,
    assignmentRevision: 1,
    createdAt: AT
  } as never;
  return state;
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

/** A delivery request that satisfies the least-privilege offer schema. */
function offerRequest(id: string, deviceInstanceId: string, expiresAt: string,
  eventId: string = EVENT_ID) {
  return {
    schemaVersion: "2.0",
    messageId: `response-requested:${eventId}:${deviceInstanceId}`,
    eventId,
    deliveryId: id,
    deliveryStatus: "SENT",
    occurredAt: AT,
    eventType: "FALL_ASSISTANCE",
    positioningTier: "SEARCH_RING",
    distanceRange: "DISTANCE_500_1000M",
    etaRange: "ETA_5_10_MIN",
    currentRecruitmentRadiusMeters: WIDEST,
    expiresAt
  };
}

interface RefreshResult {
  changed: boolean;
  requests: { deliveryId: string; messageId: string }[];
  previousAudience: string[];
  expiredOffers: { deliveryId: string; deviceInstanceId: string; reason: string }[];
  event: EventRecord;
}

function refreshWith(ctx: unknown, event: EventRecord): RefreshResult {
  return (service() as unknown as {
    refreshRecruitmentForEvent: (c: unknown, e: unknown, n: Date) => RefreshResult;
  }).refreshRecruitmentForEvent(ctx, event, NOW);
}

/** Generated ids replaced by stable placeholders in insertion order. */
function normalize(state: PersistentState) {
  const aliases = new Map<string, string>();
  let counter = 0;
  const alias = (id: string): string => {
    if (!aliases.has(id)) { counter += 1; aliases.set(id, `g${counter}`); }
    return aliases.get(id)!;
  };
  const deliveries = Object.values(state.deliveries);
  for (const delivery of deliveries) alias(delivery.id);
  const notifications = Object.values(state.notificationOutboxById);
  for (const notification of notifications) alias(notification.id);
  const timeline = [...(state.timelineByEventId[EVENT_ID] ?? [])];
  for (const entry of timeline) alias(entry.id);
  const pairs = [...aliases];
  const rw = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [id, name] of pairs) out = out.split(id).join(name);
      return out;
    }
    if (Array.isArray(value)) return value.map(rw);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [k, rw(v)]));
    }
    return value;
  };
  return {
    event: rw(state.events[EVENT_ID]),
    deliveries: deliveries.map(delivery => rw({
      id: delivery.id, deviceInstanceId: delivery.deviceInstanceId,
      status: delivery.status, statusOccurredAt: delivery.statusOccurredAt,
      request: delivery.request
    })),
    notifications: notifications.map(notification => rw({
      id: notification.id, name: notification.name,
      recipient: notification.recipient, payload: notification.payload
    })),
    timeline: timeline.map(entry => rw({
      id: entry.id, kind: entry.kind, occurredAt: entry.occurredAt, message: entry.message
    }))
  };
}

/**
 * Legacy draft context over the same state object, in place.
 *
 * The seed is put through a store first, so both sides start from the same
 * `validateState` normalisation.  Comparing a raw literal against a normalised one
 * reports fixture differences (`exitedResponderUserIds: []`, the derived
 * `iphonePatientPosition`) as if they were behaviour differences.
 */
function runLegacy(seed: PersistentState): { result: RefreshResult; state: unknown } {
  const normalized = structuredClone(new MemoryStateStore(seed).read(s => s));
  const result = refreshWith(draftRecruitmentContext(normalized),
    normalized.events[EVENT_ID]!);
  return { result, state: normalize(normalized) };
}

/** The real thing: one committed store, one entity transaction, one Tx context. */
async function runTx(seed: PersistentState): Promise<{ result: RefreshResult; state: unknown }> {
  const store = new MemoryStateStore(seed);
  const outcome = await store.transactEntities!((tx) => {
    const ctx = txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    });
    const event = tx.get("events", EVENT_ID) as EventRecord;
    return refreshWith(ctx, event);
  });
  return { result: outcome, state: normalize(store.read(s => s)) };
}

const SCENARIOS: Array<[string, (state: PersistentState) => void]> = [
  ["a free candidate receives an offer", (state) => {
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
  }],
  ["mixed identities, offers in sorted order", (state) => {
    state.devices[uuid(104)] = device(uuid(104), uuid(204));
    state.devices[uuid(101)] = device(uuid(101), uuid(201));
    state.devices[uuid(102)] = device(uuid(102), uuid(202));
    state.devices[uuid(103)] = device(uuid(103), uuid(202));
  }],
  ["an expired offer is swept inside the transaction", (state) => {
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
    state.deliveries[uuid(500)] = {
      id: uuid(500), eventId: EVENT_ID, deviceInstanceId: uuid(100),
      request: offerRequest(uuid(500), uuid(100),
        new Date(NOW.getTime() - 1).toISOString()),
      status: "SENT", statusOccurredAt: AT
    } as never;
  }],
  ["an eligible holder of a live offer is left alone", (state) => {
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
    state.deliveries[uuid(500)] = {
      id: uuid(500), eventId: EVENT_ID, deviceInstanceId: uuid(100),
      request: offerRequest(uuid(500), uuid(100),
        new Date(NOW.getTime() + 30_000).toISOString()),
      status: "SENT", statusOccurredAt: AT
    } as never;
  }],
  ["an accepted responder blocks its own identity's second device", (state) => {
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
    state.devices[uuid(101)] = device(uuid(101), uuid(200));
    state.deliveries[uuid(500)] = {
      id: uuid(500), eventId: EVENT_ID, deviceInstanceId: uuid(100),
      request: offerRequest(uuid(500), uuid(100),
        new Date(NOW.getTime() + 30_000).toISOString()),
      status: "ACCEPTED", decision: "ACCEPT", statusOccurredAt: AT
    } as never;
  }],
  ["an offer on a device that became ineligible is swept", (state) => {
    state.devices[uuid(100)] = device(uuid(100), uuid(200), { availableForResponse: false });
    state.deliveries[uuid(500)] = {
      id: uuid(500), eventId: EVENT_ID, deviceInstanceId: uuid(100),
      request: offerRequest(uuid(500), uuid(100),
        new Date(NOW.getTime() + 30_000).toISOString()),
      status: "SENT", statusOccurredAt: AT
    } as never;
  }],
  ["another event's expired offer is not touched", (state) => {
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
    const otherEvent = uuid(20_500);
    state.deliveries[uuid(500)] = {
      id: uuid(500), eventId: otherEvent, deviceInstanceId: uuid(100),
      request: offerRequest(uuid(500), uuid(100),
        new Date(NOW.getTime() - 1).toISOString(), otherEvent),
      status: "SENT", statusOccurredAt: AT
    } as never;
  }],
  ["a non-recruiting event only bumps the revision when forced", (state) => {
    (state.events[EVENT_ID] as { recruitmentState: string }).recruitmentState = "SATURATED";
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
  }],
  ["an inactive event writes nothing", (state) => {
    (state.events[EVENT_ID] as { state: string }).state = "RESOLVED";
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
  }],
  ["the ring widens while potential is below target", (state) => {
    // Back to the first stage so the expansion rule has somewhere to go.
    (state.events[EVENT_ID] as { currentRecruitmentRadiusMeters: number })
      .currentRecruitmentRadiusMeters = RECRUITMENT_RADIUS_STAGES_METERS[0];
    state.devices[uuid(100)] = device(uuid(100), uuid(200));
  }],
  // NOTE: the "unrecognised radius is snapped to the first stage" branch is NOT
  // compared here.  A store-validated state cannot hold an unsupported radius at all
  // (`currentRecruitmentRadiusMeters is unsupported`), so the branch is reachable only
  // from an unvalidated legacy/migration snapshot.  It stays covered by the baseline
  // differential, which runs on raw state objects.
];

for (const [name, build] of SCENARIOS) {
  test(`behaviour: Legacy and Tx agree - ${name}`, async () => {
    const legacyState = world();
    build(legacyState);
    const legacy = runLegacy(legacyState);

    const txState = world();
    build(txState);
    const tx = await runTx(txState);

    assert.deepEqual(tx.state, legacy.state,
      "the same event fields, deliveries, notifications and timeline, in the same order");
    assert.deepEqual(tx.result.expiredOffers, legacy.result.expiredOffers);
    assert.deepEqual(tx.result.previousAudience, legacy.result.previousAudience);
    assert.deepEqual(tx.result.requests.map(r => r.messageId),
      legacy.result.requests.map(r => r.messageId));
    assert.equal(tx.result.event.coordinationRevision,
      legacy.result.event.coordinationRevision);
  });
}

test("transaction: a position moved in this transaction yields the transaction's device", async () => {
  // The device starts OUTSIDE the ring, so the committed index would not place it
  // among the candidates.  The transaction moves it inside.  Only the staged-keys
  // union makes it offerable, and the object handed to the predicate must be the
  // transaction's, not the committed one.
  const state = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200), {
    latestPosition: {
      positionUpdateId: uuid(9_501),
      observedAt: AT,
      serverReceivedAt: AT,
      position: { kind: "R", latitude: PATIENT.latitude + 0.5,
        longitude: PATIENT.longitude, accuracyMeters: 12 }
    }
  });
  const store = new MemoryStateStore(state);

  const outcome = await store.transactEntities!((tx) => {
    tx.update("devices", candidate, (draft) => {
      (draft as { latestPosition: unknown }).latestPosition = {
        positionUpdateId: uuid(9_502),
        observedAt: AT,
        serverReceivedAt: AT,
        position: { kind: "R", latitude: PATIENT.latitude + 0.005,
          longitude: PATIENT.longitude, accuracyMeters: 12 }
      };
    });
    const ctx = txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    });
    const seen = ctx.candidateDevices(tx.get("events", EVENT_ID) as EventRecord)
      .find(entry => entry.deviceInstanceId === candidate);
    assert.ok(seen, "a device moved into the ring by this transaction is a candidate");
    assert.equal((seen.latestPosition!.position as { latitude: number }).latitude,
      PATIENT.latitude + 0.005,
      "and it is the transaction's object, not the committed one the index knows");
    return refreshWith(ctx, tx.get("events", EVENT_ID) as EventRecord);
  });

  assert.equal(outcome.requests.some(r => r.messageId.endsWith(candidate)), true,
    "so it receives an offer in the same transaction");
});

test("transaction: consecutive refreshes in ONE transaction share their writes", async () => {
  const state = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const store = new MemoryStateStore(state);

  const outcome = await store.transactEntities!((tx) => {
    const ctx = txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    });
    const first = refreshWith(ctx, tx.get("events", EVENT_ID) as EventRecord);
    const second = refreshWith(ctx, tx.get("events", EVENT_ID) as EventRecord);
    return { first, second, stagedDeliveries: tx.seal().filter(c => c.collection === "deliveries") };
  });

  assert.equal(outcome.first.requests.length, 1, "the first refresh offers");
  assert.equal(outcome.second.requests.length, 0,
    "the second must see the first refresh's offer and not repeat it");
  assert.equal(outcome.stagedDeliveries.length, 1,
    "exactly one delivery was registered across both refreshes");
});

test("transaction: a missing identity index still finds a sibling's active assignment", async () => {
  const state = world();
  const candidate = uuid(100);
  const sibling = uuid(101);
  state.devices[candidate] = device(candidate, uuid(200));
  state.devices[sibling] = device(sibling, uuid(200));
  state.assignments[uuid(600)] = {
    id: uuid(600), eventId: EVENT_ID, deviceInstanceId: sibling,
    role: "GO_TO_PATIENT", status: "ASSIGNED", revision: 1,
    createdAt: AT, updatedAt: AT
  } as never;
  const store = new MemoryStateStore(state);

  await store.transactEntities!((tx) => {
    const ctx = txRecruitmentContext(tx, {
      assignmentIdsForDevice: id => [...store.assignmentIndex().assignmentIdsForDevice(id)]
    });
    assert.equal(ctx.hasActiveAssignmentForDevice(ctx.getDevice(candidate)!), true,
      "an optional missing identity index must not allow the same person to be recruited twice");
    assert.equal(refreshWith(ctx, tx.get("events", EVENT_ID) as EventRecord).requests.length, 0);
  });
});

test("transaction: delivery lookups recheck event membership after a staged update", async () => {
  const state = world();
  const candidate = uuid(100);
  const deliveryId = uuid(500);
  const otherEvent = uuid(401);
  state.devices[candidate] = device(candidate, uuid(200));
  state.deliveries[deliveryId] = {
    id: deliveryId, eventId: EVENT_ID, deviceInstanceId: candidate,
    request: offerRequest(deliveryId, candidate, AT),
    status: "SENT", statusOccurredAt: AT
  } as never;
  const store = new MemoryStateStore(state);

  await store.transactEntities!((tx) => {
    tx.update("deliveries", deliveryId, draft => {
      draft.eventId = otherEvent;
      draft.request = offerRequest(deliveryId, candidate, AT, otherEvent) as never;
    });
    const ctx = txRecruitmentContext(tx, {
      deliveryIdsForEvent: id => [...store.deliveryIndex().deliveryIdsForEvent(id)]
    });
    assert.deepEqual(ctx.deliveriesOfEvent(EVENT_ID), [],
      "a committed index hit is only a candidate, not proof of current event membership");
    assert.equal(ctx.deliveriesOfEvent(otherEvent)[0]?.id, deliveryId);
  });
});

test("transaction: a mid-way failure rolls everything back", async () => {
  const state = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  state.deliveries[uuid(500)] = {
    id: uuid(500), eventId: EVENT_ID, deviceInstanceId: candidate,
    request: offerRequest(uuid(500), candidate,
      new Date(NOW.getTime() - 1).toISOString()),
    status: "SENT", statusOccurredAt: AT
  } as never;
  const store = new MemoryStateStore(state);
  const before = normalize(store.read(s => s));

  await assert.rejects(store.transactEntities!((tx) => {
    const ctx = txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    });
    // An adapter that lost the delivery it was just asked to expire: the contract
    // says this throws rather than silently doing nothing.
    const broken = {
      ...ctx,
      updateDelivery: () => { throw new Error("delivery vanished mid-transaction"); }
    };
    refreshWith(broken, tx.get("events", EVENT_ID) as EventRecord);
  }), /vanished mid-transaction/);

  assert.deepEqual(normalize(store.read(s => s)), before,
    "entities, notifications and timeline must all be exactly as they were");
});

test("transaction: separate transactions do not share state, and see each other's commits", async () => {
  const state = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const store = new MemoryStateStore(state);

  const first = await store.transactEntities!((tx) =>
    refreshWith(txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    }), tx.get("events", EVENT_ID) as EventRecord));
  assert.equal(first.requests.length, 1);

  // A later transaction sees the committed offer and does not duplicate it.
  const second = await store.transactEntities!((tx) => {
    const ctx = txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    });
    assert.ok(ctx.deliveryForDevice(EVENT_ID, candidate),
      "the committed offer is visible to a new transaction");
    return refreshWith(ctx, tx.get("events", EVENT_ID) as EventRecord);
  });
  assert.equal(second.requests.length, 0, "so no second offer is created");
  assert.equal(Object.keys(store.read(s => s.deliveries)).length, 1);
});

test("structure: the target path's access counts do not grow with unrelated history", async () => {
  async function measure(unrelated: number):
    Promise<{ devices: number; deliveries: number; assignments: number }> {
    const state = world();
    const candidate = uuid(100);
    state.devices[candidate] = device(candidate, uuid(200));
    for (let index = 0; index < unrelated; index += 1) {
      // Unrelated history: other devices, other events, other deliveries.
      // UUID-shaped: the least-privilege offer schema validates every id field, so a
      // readable placeholder like `hist-event-0` is rejected as malformed.
      const histDevice = uuid(10_000 + index);
      const histEvent = uuid(20_000 + index);
      const histDelivery = uuid(30_000 + index);
      // Far outside every ring stage: history that is geographically inside the ring
      // is not unrelated history, it is a legitimate candidate, and the count SHOULD
      // then grow.
      state.devices[histDevice] = device(histDevice, uuid(40_000 + index), {
        latestPosition: {
          positionUpdateId: uuid(60_000 + index), observedAt: AT, serverReceivedAt: AT,
          position: { kind: "R", latitude: 40 + index * 0.01, longitude: 100,
            accuracyMeters: 12 }
        }
      });
      // Unrelated assignments as well: without them the assignment assertion would
      // be measuring a collection nothing ever grows.
      state.assignments[uuid(50_000 + index)] = {
        id: uuid(50_000 + index), eventId: histEvent, deviceInstanceId: histDevice,
        role: "GO_TO_PATIENT", status: "ASSIGNED", revision: 1,
        createdAt: AT, updatedAt: AT
      } as never;
      state.deliveries[histDelivery] = {
        id: histDelivery, eventId: histEvent, deviceInstanceId: histDevice,
        request: offerRequest(histDelivery, histDevice, AT, histEvent),
        status: "SENT", statusOccurredAt: AT
      } as never;
    }
    const store = new MemoryStateStore(state);
    resetMetrics();
    await store.transactEntities!((tx) =>
      refreshWith(txRecruitmentContext(tx, {
      devicePositions: {
        query: (latitude, longitude, radiusMeters) =>
          store.devicePositions?.()?.query(latitude, longitude, radiusMeters) ?? []
      },
      deliveryIdsForEvent: eventId =>
        [...(store.deliveryIndex?.()?.deliveryIdsForEvent(eventId) ?? [])],
      assignmentIdsForDevice: deviceInstanceId =>
        [...(store.assignmentIndex?.()?.assignmentIdsForDevice(deviceInstanceId) ?? [])],
      deviceIdsForIdentity: identityKey =>
        [...(store.assignmentIndex?.()?.deviceIdsForIdentity(identityKey) ?? [])]
    }), tx.get("events", EVENT_ID) as EventRecord));
    const metrics = snapshotMetrics().operation;
    return {
      devices: metrics.deviceCandidatesVisited as number,
      deliveries: metrics.deliveryCandidatesVisited as number,
      assignments: metrics.assignmentCandidatesVisited as number
    };
  }

  const small = await measure(0);
  const large = await measure(500);

  assert.equal(large.devices, small.devices,
    `the candidate set must not grow with unrelated devices (${small.devices} -> ${large.devices})`);
  assert.equal(large.deliveries, small.deliveries,
    "and neither may the delivery lookups: the by-event index answers the sweep, so "
    + `unrelated deliveries are never visited (${small.deliveries} -> ${large.deliveries})`);
  assert.equal(large.assignments, small.assignments,
    "nor the assignment lookups: the structural assignment index answers the "
    + "eligibility check, so unrelated assignments are never visited "
    + `(${small.assignments} -> ${large.assignments})`);
});
