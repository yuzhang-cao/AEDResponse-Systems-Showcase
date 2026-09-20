import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { EntityTransaction } from "../src/entity-transaction.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import { AEDResponseService, RECRUITMENT_RADIUS_STAGES_METERS,
  type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore, SQLiteStateStore, isShadowValidationEnabled,
  setShadowValidationEnabled, type StateStore } from "../src/store.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const AT = "2026-08-31T01:02:00.000Z";
const BEFORE = "2026-08-31T01:01:59.000Z";
const NOW = new Date(AT);
const RESPONDER = uuid(100);
const EVENT = uuid(400);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };
const FAR = { latitude: 40, longitude: 116 };
const WIDEST = RECRUITMENT_RADIUS_STAGES_METERS.at(-1)!;
const config = loadConfig({}, tmpdir());
const publisher = { emitToDevices: (ids: readonly string[]) => ids };
const initialShadowValidation = isShadowValidationEnabled();
// Measure the production change-set path, with the explicit development-only
// full-state shadow validator disabled; atomicity still uses real stores.
test.before(() => setShadowValidationEnabled(false));
test.after(() => setShadowValidationEnabled(initialShadowValidation));
const principal: DevicePrincipal = {
  kind: "DEVICE", deviceKind: "IPHONE", deviceInstanceId: RESPONDER,
  companionPairId: uuid(9_100), userId: uuid(200), tokenHash: "position-test-token-hash",
  sessionId: uuid(210), scopes: ["position:write"], expiresAt: "2026-09-01T00:00:00.000Z"
};
const update = {
  positionUpdateId: uuid(990), observedAt: AT,
  responderPosition: { kind: "R" as const, ...PATIENT, accuracyMeters: 12 }
};

function device(id: string, userId: string, position = FAR) {
  return {
    deviceInstanceId: id, deviceKind: "IPHONE", userId, companionPairId: uuid(9_000 + Number.parseInt(id.slice(-4), 16)),
    agreements: Object.fromEntries(["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => [kind, { version: "2.0", acceptedAt: BEFORE }])),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: BEFORE, lastSeenAt: BEFORE, lastBootstrapAt: BEFORE,
    latestPosition: { positionUpdateId: uuid(9_500), observedAt: BEFORE, serverReceivedAt: BEFORE,
      position: { kind: "R", ...position, accuracyMeters: 12 } }
  } as never;
}

function delivery(id: string, eventId: string, deviceInstanceId: string) {
  return {
    id, eventId, deviceInstanceId, status: "REFUSED", decision: "REFUSE", statusOccurredAt: BEFORE,
    request: { schemaVersion: "2.0", messageId: `response-requested:${id}`, eventId,
      deliveryId: id, deliveryStatus: "SENT", occurredAt: BEFORE, eventType: "FALL_ASSISTANCE",
      positioningTier: "SEARCH_RING", distanceRange: "DISTANCE_500_1000M", etaRange: "ETA_5_10_MIN",
      currentRecruitmentRadiusMeters: WIDEST, expiresAt: AT }
  } as never;
}

function receipt(eventId: string, id: string, deviceInstanceId = RESPONDER) {
  return { canonical: { schemaVersion: "2.0", receiptId: id, eventId,
    aedId: uuid(800), deviceInstanceId, acquiredAt: BEFORE }, fingerprint: id } as never;
}

/** A moving responder enters the ring; its old assignment belongs to a resolved event. */
function world(unrelated = 0, quiet = false): PersistentState {
  const state = emptyState();
  state.devices[RESPONDER] = device(RESPONDER, uuid(200));
  state.devices[uuid(300)] = device(uuid(300), uuid(301), PATIENT);
  state.events[EVENT] = {
    id: EVENT, state: "ACTIVE", recruitmentState: "RECRUITING", patientUserId: uuid(301),
    patientDeviceIds: [uuid(300)], patientPairId: state.devices[uuid(300)]!.companionPairId,
    unavailableAedIds: [], observationFingerprint: "position-test", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    observation: { schemaVersion: "2.0", eventId: EVENT, observationKind: "FALL_CONTEXT",
      fallDetectedAt: BEFORE, patientPositionObservedAt: BEFORE, fallResolution: "UNRESPONSIVE",
      appHelpResponse: "NEEDS_HELP", patientPosition: { kind: "P", ...PATIENT, accuracyMeters: 12 } },
    patientPosition: { positionUpdateId: uuid(9_600), source: "IPHONE_PRIMARY", observedAt: BEFORE,
      serverReceivedAt: BEFORE, position: { kind: "P", ...PATIENT, accuracyMeters: 12 } },
    currentRecruitmentRadiusMeters: RECRUITMENT_RADIUS_STAGES_METERS[0], recruitmentStageStartedAt: BEFORE,
    coordinationRevision: 1, assignmentRevision: 1, createdAt: BEFORE
  } as never;
  state.events[uuid(401)] = { ...structuredClone(state.events[EVENT] as EventRecord), id: uuid(401),
    state: "RESOLVED", recruitmentState: "COMPLETED", resolvedAt: BEFORE };
  state.assignments[uuid(600)] = {
    id: uuid(600), eventId: uuid(401), deviceInstanceId: RESPONDER,
    role: "GO_TO_PATIENT", status: "COMPLETED", revision: 1, createdAt: BEFORE, updatedAt: BEFORE
  } as never;
  state.aedReceiptsById[uuid(700)] = receipt(EVENT, uuid(700));
  if (quiet) {
    // A Watch-only patient and an already-refused responder have no authorized
    // notification audience. Radius expansion still computes all four candidate
    // classes and writes event/timeline, while the real outbox worker has no work.
    state.devices[uuid(300)]!.deviceKind = "WATCH";
    state.deliveries[uuid(500)] = delivery(uuid(500), EVENT, RESPONDER);
  }
  for (let index = 0; index < unrelated; index += 1) {
    const deviceId = uuid(10_000 + index);
    const eventId = uuid(20_000 + index);
    state.devices[deviceId] = device(deviceId, uuid(30_000 + index));
    state.events[eventId] = { ...structuredClone(state.events[uuid(401)]!), id: eventId };
    state.assignments[uuid(40_000 + index)] = {
      ...state.assignments[uuid(600)]!, id: uuid(40_000 + index), eventId, deviceInstanceId: deviceId
    };
    state.deliveries[uuid(50_000 + index)] = delivery(uuid(50_000 + index), eventId, deviceId);
    state.aedReceiptsById[uuid(60_000 + index)] = receipt(eventId, uuid(60_000 + index), deviceId);
  }
  return state;
}

type Kind = "Memory" | "SQLite";
async function openStore(kind: Kind, seed: PersistentState) {
  if (kind === "Memory") {
    return { store: new MemoryStateStore(seed) as StateStore,
      cleanup: async () => {}, reopen: undefined };
  }
  const directory = await mkdtemp(join(tmpdir(), "aed-position-transaction-"));
  const path = join(directory, "state.sqlite");
  const store = await SQLiteStateStore.open(path, []);
  await store.transact(state => Object.assign(state, structuredClone(seed)));
  return { store: store as StateStore,
    cleanup: async () => { store.close(); await rm(directory, { recursive: true, force: true }); },
    reopen: async () => {
      const reader = await SQLiteStateStore.open(path, []);
      try { return reader.read(state => state); } finally { reader.close(); }
    } };
}

function committedIndexes(store: StateStore) {
  const projection = store.projections!();
  return structuredClone({
    geographic: store.devicePositions!(), assignment: store.assignmentIndex!(),
    delivery: store.deliveryIndex!(), expiry: store.positionExpiry!(),
    activeEvents: projection.read("activeRecruitingEvents"),
    deliveriesByEvent: projection.readGrouped("deliveriesByEventId"),
    receiptsByEvent: projection.readGrouped("aedReceiptsByEventId")
  });
}

interface Hooks {
  failAfter?: string;
  commitThenReject?: boolean;
  noEntityTransactions?: boolean;
  overselectDevices?: boolean;
}

/** Wraps real stores and transactions; production writes and the outbox worker still run. */
function instrument(base: StateStore, hooks: Hooks = {}) {
  const writes: string[] = [];
  const transactions: string[][] = [];
  let entityCalls = 0;
  let legacyCalls = 0;
  let businessMetrics: ReturnType<typeof snapshotMetrics> | undefined;
  const failure = new Error(`injected after ${hooks.failAfter}`);
  const store = new Proxy(base, {
    get(target, property) {
      if (property === "transact") return <T>(mutation: (state: PersistentState) => T | Promise<T>) => {
        legacyCalls += 1;
        return target.transact(mutation);
      };
      if (property === "transactEntities") {
        if (hooks.noEntityTransactions) return undefined;
        return async <T>(mutation: (tx: EntityTransaction) => T | Promise<T>): Promise<T> => {
          entityCalls += 1;
          const transactionWrites: string[] = [];
          transactions.push(transactionWrites);
          let delayedFailure: unknown;
          const result = await target.transactEntities!<T>(async tx => {
            const intercepted = new Proxy(tx, {
              get(transaction, member) {
                const value = Reflect.get(transaction, member, transaction);
                if (member === "append" || member === "update" || member === "remove" || member === "set") {
                  return (...args: unknown[]) => {
                    const result = Reflect.apply(value, transaction, args);
                    writes.push(String(args[0]));
                    transactionWrites.push(String(args[0]));
                    if (args[0] === hooks.failAfter) throw failure;
                    return result;
                  };
                }
                return typeof value === "function" ? value.bind(transaction) : value;
              }
            });
            try { return await mutation(intercepted); } catch (error) {
              if (!hooks.commitThenReject) throw error;
              // Deliberately broken adapter for the rollback guard's negative control:
              // commit the staged prefix, then report the same failure to the caller.
              delayedFailure = error;
              return undefined as T;
            }
          });
          businessMetrics ??= snapshotMetrics();
          if (delayedFailure) throw delayedFailure;
          return result;
        };
      }
      if (property === "devicePositions" && hooks.overselectDevices) {
        return () => ({ query: () => target.readEntities!(view => view.keys("devices")) });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { store, writes, failure,
    stats: () => ({ entityCalls, legacyCalls, businessMetrics, transactions }) };
}

function assertRolledBack(store: StateStore, state: PersistentState, indexes: unknown): void {
  assert.deepEqual(store.read(current => current), state, "all business records must roll back");
  assert.deepEqual(committedIndexes(store), indexes, "all four committed indexes and projections must stay unchanged");
}

for (const kind of ["Memory", "SQLite"] as const) {
  for (const collection of ["devices", "positionUpdateReceiptsById", "events", "deliveries",
    "timelineByEventId", "notificationOutboxById"]) {
    test(`${kind}: position operation rolls back after staging ${collection}`, async () => {
      const fixture = await openStore(kind, world());
      try {
        const observed = instrument(fixture.store, { failAfter: collection });
        const service = new AEDResponseService(observed.store, config, undefined, () => NOW);
        const before = fixture.store.read(state => state);
        const indexes = committedIndexes(fixture.store);
        resetMetrics();
        await assert.rejects(service.updateResponderPosition(principal, update), error => error === observed.failure);
        assert.ok(observed.writes.includes(collection), "failure injection must actually be reached");
        assert.equal(observed.stats().entityCalls, 1, "one business transaction owns the entire staged prefix");
        assert.equal(observed.stats().legacyCalls, 0, "a failed entity transaction must never retry through Legacy");
        assertRolledBack(fixture.store, before, indexes);
        if (fixture.reopen) assert.deepEqual(await fixture.reopen(), before, "SQLite durable rows must also roll back");
      } finally { await fixture.cleanup(); }
    });
  }

  test(`${kind}: successful recruiting position write uses one business entity transaction before real outbox work`, async () => {
    const fixture = await openStore(kind, world());
    try {
      const observed = instrument(fixture.store);
      const service = new AEDResponseService(observed.store, config, publisher, () => NOW);
      committedIndexes(fixture.store);
      resetMetrics();
      const result = await service.updateResponderPosition(principal, update);
      assert.equal(result.applied, true);
      assert.ok(observed.stats().entityCalls > 1, "outbox attempt/completion also use entity transactions");
      assert.ok(observed.stats().transactions.slice(1).every(writes => writes.every(collection => collection === "notificationOutboxById")),
        "only the first transaction may change business facts; later transactions only advance outbox rows");
      for (const collection of ["devices", "positionUpdateReceiptsById", "events", "deliveries",
        "timelineByEventId", "notificationOutboxById"]) assert.ok(observed.writes.includes(collection));
      const business = observed.stats().businessMetrics!;
      assert.equal(business.totalFullStateClones, 0);
      assert.equal(business.storage.fullStateFlattens, 0);
      assert.equal(business.storage.historyComparedEntities, 0);
      assert.equal(observed.stats().legacyCalls, 0, "the real outbox must also commit incrementally");
      assert.equal(snapshotMetrics().totalFullStateClones, 0, "the complete operation must not clone state");
      const persisted = fixture.store.read(state => state);
      assert.equal(persisted.devices[RESPONDER]!.latestPosition!.positionUpdateId, update.positionUpdateId);
      assert.ok(persisted.positionUpdateReceiptsById[update.positionUpdateId]);
      assert.equal(Object.keys(persisted.deliveries).length, 1);
      assert.ok(Object.values(persisted.notificationOutboxById).every(row => row.attempts > 0));
      if (fixture.reopen) assert.deepEqual(await fixture.reopen(), persisted);
    } finally { await fixture.cleanup(); }
  });
}

async function structure(kind: Kind, unrelated: number, overselectDevices = false) {
  const fixture = await openStore(kind, world(unrelated, true));
  try {
    const observed = instrument(fixture.store, { overselectDevices });
    const service = new AEDResponseService(observed.store, config, undefined, () => NOW);
    committedIndexes(fixture.store);
    resetMetrics();
    const result = await service.updateResponderPosition(principal, update);
    const metrics = snapshotMetrics();
    assert.equal(result.applied, true);
    assert.equal(observed.stats().entityCalls, 1);
    assert.equal(observed.stats().legacyCalls, 0);
    assert.equal(metrics.totalFullStateClones, 0);
    assert.equal(metrics.storage.fullStateFlattens, 0);
    assert.equal(metrics.storage.historyComparedEntities, 0);
    assert.equal(fixture.store.read(state => Object.keys(state.notificationOutboxById).length), 0);
    const business = observed.stats().businessMetrics!.operation;
    const candidates = {
      devices: business.deviceCandidatesVisited,
      deliveries: business.deliveryCandidatesVisited,
      assignments: business.assignmentCandidatesVisited,
      aedReceipts: business.aedReceiptCandidatesVisited
    };
    for (const [name, count] of Object.entries(candidates)) assert.ok(count > 0, `${name} counter must be exercised`);
    return { candidates, wholeOperation: {
      devices: metrics.operation.deviceCandidatesVisited,
      deliveries: metrics.operation.deliveryCandidatesVisited,
      assignments: metrics.operation.assignmentCandidatesVisited,
      aedReceipts: metrics.operation.aedReceiptCandidatesVisited
    } };
  } finally { await fixture.cleanup(); }
}

for (const kind of ["Memory", "SQLite"] as const) {
  test(`${kind}: business recruitment visits stay bounded while the real response tail remains separately measured`, async t => {
    const large = await structure(kind, 250);
    const small = await structure(kind, 0);
    assert.deepEqual(large.candidates, small.candidates,
      "unrelated devices, events, deliveries, assignments and AED receipts must not grow candidate visits");
    assert.deepEqual(large.wholeOperation, small.wholeOperation,
      "response construction must also be independent of unrelated history");
    t.diagnostic(JSON.stringify({ unrelated: [0, 250], business: small.candidates,
      wholeOperation: [small.wholeOperation, large.wholeOperation] }));
  });
}

test("position capability fallback, indexed recruitment and tick have distinct per-operation metrics", async () => {
  const indexed = instrument(new MemoryStateStore(world(0, true)));
  const service = new AEDResponseService(indexed.store, config, undefined, () => NOW);
  resetMetrics();
  await service.updateResponderPosition(principal, update);
  let metrics = snapshotMetrics().operation;
  assert.deepEqual([metrics.indexedRecruitmentRuns, metrics.legacyRecruitmentRuns, metrics.recruitmentFallbackRuns], [1, 0, 0]);
  await service.tick();
  metrics = snapshotMetrics().operation;
  assert.deepEqual([metrics.indexedRecruitmentRuns, metrics.legacyRecruitmentRuns, metrics.recruitmentFallbackRuns], [2, 0, 0]);

  const fallback = instrument(new MemoryStateStore(world(0, true)), { noEntityTransactions: true });
  const legacy = new AEDResponseService(fallback.store, config, undefined, () => NOW);
  resetMetrics();
  assert.equal((await legacy.updateResponderPosition(principal, update)).applied, true);
  metrics = snapshotMetrics().operation;
  assert.deepEqual([metrics.indexedRecruitmentRuns, metrics.legacyRecruitmentRuns, metrics.recruitmentFallbackRuns], [0, 0, 1]);
  assert.equal(fallback.stats().entityCalls, 0);
  assert.equal(fallback.stats().legacyCalls, 1, "capability fallback must actually execute the position mutation");
});

test("rollback guard rejects a store that commits the staged prefix before reporting failure", async () => {
  const base = new MemoryStateStore(world());
  const observed = instrument(base, { failAfter: "notificationOutboxById", commitThenReject: true });
  const service = new AEDResponseService(observed.store, config, undefined, () => NOW);
  const before = base.read(state => state);
  const indexes = committedIndexes(base);
  await assert.rejects(service.updateResponderPosition(principal, update), error => error === observed.failure);
  assert.throws(() => assertRolledBack(base, before, indexes), /all business records must roll back/);
});

test("structural guard rejects a geographic candidate query that includes unrelated history", async () => {
  const small = await structure("Memory", 0, true);
  const large = await structure("Memory", 25, true);
  assert.throws(() => assert.deepEqual(large.candidates, small.candidates), assert.AssertionError);
  assert.ok(large.candidates.devices > small.candidates.devices, "negative control must exercise the broadened candidate query");
});

/**
 * The candidate source on this path must not enumerate the device collection.
 *
 * An independent review of the first G13-A batch caught a regression here: the
 * shared candidate helper was called with `tx.keys("devices")` bound eagerly and
 * with a patient-sibling `keysWhere(...)` evaluated as an argument, so both scans
 * ran on every position write even though the geographic, identity and ordinal
 * indexes answered every question.  Device-key enumeration went from 15 to 765 to
 * 3,015 at 0/250/1,000 unrelated devices.
 *
 * The counters above cannot see it: `deviceCandidatesVisited` counts surviving
 * candidates and stayed flat.  These assertions count the enumeration itself,
 * through the real prototype, so the regression cannot return unnoticed.
 */
for (const kind of ["Memory", "SQLite"] as const) {
  test(`${kind}: a position write does not enumerate device keys once the indexes answer`, async t => {
    const counts = { keys: 0, keysWhere: 0, predicateChecks: 0 };
    const originalKeys = EntityTransaction.prototype.keys;
    const originalKeysWhere = EntityTransaction.prototype.keysWhere;
    EntityTransaction.prototype.keys = function (collection: string) {
      if (collection === "devices") counts.keys += 1;
      return originalKeys.call(this, collection as never);
    };
    EntityTransaction.prototype.keysWhere = function (
      collection: string,
      predicate: never,
      limit: number
    ) {
      if (collection !== "devices") {
        return originalKeysWhere.call(this, collection as never, predicate, limit);
      }
      counts.keysWhere += 1;
      const counted = (item: never): boolean => {
        counts.predicateChecks += 1;
        return (predicate as unknown as (value: never) => boolean)(item);
      };
      return originalKeysWhere.call(this, collection as never, counted as never, limit);
    };
    const fixture = await openStore(kind, world(1_000, true));
    try {
      const service = new AEDResponseService(fixture.store, config, undefined, () => NOW);
      committedIndexes(fixture.store);
      const result = await service.updateResponderPosition(principal, update);
      assert.equal(result.applied, true);
    } finally {
      EntityTransaction.prototype.keys = originalKeys;
      EntityTransaction.prototype.keysWhere = originalKeysWhere;
      await fixture.cleanup();
    }

    assert.equal(counts.keys, 0,
      "the transaction adapter must take collection order from the ordinal index, "
      + "not from keys(\"devices\"); a growing count here is the fleet-sized scan "
      + "the index exists to remove");
    assert.equal(counts.keysWhere, 0,
      "and the patient-sibling question must be answered by the identity index, not "
      + "by a scan that runs even when its answer is discarded");
    assert.equal(counts.predicateChecks, 0);
  });
}
