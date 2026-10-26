import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { emptyState, type DeviceRecord, type PersistentState } from "../src/models.js";
import type { PushDeliveryRequest } from "../src/push-provider.js";
import { AEDResponseService } from "../src/service.js";
import { createStateReadView, readStateByEntity, type EntityCollection } from "../src/state-read.js";
import { MemoryStateStore, type StateStore } from "../src/store.js";

/** No validation or background jobs: counts the exact detached entity boundary. */
function observedStore(initial: PersistentState) {
  let committed = initial;
  let fullReads = 0, views = 0;
  const cloned: string[] = [], enumerated: string[] = [];
  const store: StateStore = {
    read: reader => { fullReads += 1; return reader(structuredClone(committed)); },
    readEntities: reader => {
      views += 1;
      const view = createStateReadView(committed);
      return reader({ ...view,
        get: (collection, key) => {
          const value = view.get(collection, key);
          if (value !== undefined) cloned.push(`${collection}:${key}`);
          return value;
        },
        keys: collection => { enumerated.push(collection); return view.keys(collection); },
        select: () => { throw new Error("Lazy reads must not select/clone whole collections"); }
      });
    },
    transact: async () => { throw new Error("Read test attempted a write"); }
  };
  return { store, cloned, enumerated, stats: () => ({ fullReads, views }),
    replace: (next: PersistentState) => { committed = next; } };
}

test("lazy entity lookup caches detached values without enumerating or cloning history", () => {
  const initial = emptyState();
  initial.users.one = { userId: "one", createdAt: "first", updatedAt: "first" };
  initial.quarantinedLegacyEventPositionBatchesById.history = Array.from({ length: 100 }, (_, i) => ({ i }));
  const observed = observedStore(initial);
  readStateByEntity(observed.store, state => {
    assert.deepEqual(Object.keys(state), Object.keys(initial));
    assert.equal(state.schemaVersion, "2.0");
    assert.equal(state.users.one, state.users.one);
    assert.deepEqual(state.users.one, initial.users.one);
  });
  assert.deepEqual(observed.cloned, ["users:one"]);
  assert.deepEqual(observed.enumerated, []);
  assert.deepEqual(observed.stats(), { fullReads: 0, views: 1 });
});

test("key enumeration does not clone; values and entries include the entire collection in order", () => {
  const initial = emptyState();
  for (const key of ["later", "2", "1", "last"]) initial.accountIdByProviderKey[key] = `account:${key}`;
  const observed = observedStore(initial);
  readStateByEntity(observed.store, state => {
    assert.deepEqual(Object.keys(state.accountIdByProviderKey), Object.keys(initial.accountIdByProviderKey));
    assert.equal("later" in state.accountIdByProviderKey, true);
    assert.equal(Object.hasOwn(state.accountIdByProviderKey, "missing"), false);
    assert.deepEqual(observed.cloned, []);
    assert.deepEqual(Object.values(state.accountIdByProviderKey), Object.values(initial.accountIdByProviderKey));
    assert.deepEqual(Object.entries(state.accountIdByProviderKey), Object.entries(initial.accountIdByProviderKey));
  });
  assert.equal(observed.cloned.length, 4);
  assert.deepEqual(observed.enumerated, ["accountIdByProviderKey"]);
});

test("every entity namespace is available, including scalar indexes and array history", () => {
  const initial = emptyState();
  const collections = Object.keys(initial).filter(key => key !== "aeds" && key !== "schemaVersion") as EntityCollection[];
  for (const collection of collections) {
    const table = initial[collection] as Record<string, unknown>;
    table.first = collection.endsWith("ByBusinessKey") ? "scalar" : { collection };
    table.second = [{ collection }];
  }
  const observed = observedStore(initial);
  readStateByEntity(observed.store, state => {
    for (const collection of collections) {
      assert.deepEqual(Object.keys(state[collection]), ["first", "second"]);
      assert.deepEqual(Object.entries(state[collection]), Object.entries(initial[collection]));
    }
  });
  assert.equal(observed.cloned.length, collections.length * 2);
  assert.equal(observed.stats().fullReads, 0);
});

test("unknown and special keys are own-key safe and cannot change prototypes", () => {
  const initial = emptyState();
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    Object.defineProperty(initial.accountIdByProviderKey, key, { value: `own:${key}`, enumerable: true });
  }
  const observed = observedStore(initial);
  readStateByEntity(observed.store, state => {
    assert.equal(Object.getPrototypeOf(state), null);
    assert.equal(Object.getPrototypeOf(state.accountIdByProviderKey), null);
    assert.deepEqual(Object.entries(state.accountIdByProviderKey), Object.entries(initial.accountIdByProviderKey));
    assert.equal(state.accountIdByProviderKey.missing, undefined);
    assert.equal("missing" in state.accountIdByProviderKey, false);
    assert.equal(Object.getOwnPropertyDescriptor(state.accountIdByProviderKey, "missing"), undefined);
    assert.equal(Reflect.get(state.accountIdByProviderKey, Symbol.iterator), undefined);
    assert.equal(Reflect.get(state, "__proto__"), undefined);
    assert.equal(Reflect.get(state, "unknownCollection"), undefined);
    assert.throws(() => Object.setPrototypeOf(state.accountIdByProviderKey, {}), TypeError);
  });
  assert.equal(observed.cloned.length, 4);
});

test("root, collection, detached objects and nested arrays reject mutation", () => {
  const initial = emptyState();
  initial.quarantinedLegacyEventPositionBatchesById.entry = { values: [{ count: 1 }] };
  const observed = observedStore(initial);
  const detached = readStateByEntity(observed.store, state => {
    assert.throws(() => { (state as PersistentState).schemaVersion = "2.0"; }, TypeError);
    assert.throws(() => Reflect.deleteProperty(state.quarantinedLegacyEventPositionBatchesById, "entry"), TypeError);
    assert.throws(() => Object.defineProperty(state.quarantinedLegacyEventPositionBatchesById, "entry", { value: 2 }), TypeError);
    assert.throws(() => Reflect.set(state.quarantinedLegacyEventPositionBatchesById, "entry", 2), TypeError);
    assert.throws(() => Object.preventExtensions(state.quarantinedLegacyEventPositionBatchesById), TypeError);
    return state.quarantinedLegacyEventPositionBatchesById.entry as { values: { count: number }[] };
  });
  assert.throws(() => { detached.values[0]!.count = 2; }, TypeError);
  assert.throws(() => detached.values.push({ count: 2 }), TypeError);
  assert.deepEqual(initial.quarantinedLegacyEventPositionBatchesById.entry, { values: [{ count: 1 }] });
  assert.notEqual(detached, initial.quarantinedLegacyEventPositionBatchesById.entry);
});

test("one reader captures one committed entity view, even for records read later", () => {
  const initial = emptyState();
  initial.accountIdByProviderKey.first = "old-first";
  initial.accountIdByProviderKey.second = "old-second";
  const observed = observedStore(initial);
  readStateByEntity(observed.store, state => {
    assert.equal(state.accountIdByProviderKey.first, "old-first");
    const replacement = structuredClone(initial);
    replacement.accountIdByProviderKey.second = "new-second";
    observed.replace(replacement);
    assert.equal(state.accountIdByProviderKey.second, "old-second");
  });
  assert.equal(observed.stats().views, 1);
});

test("AED catalog is real, detached, and fetched only on first access", () => {
  const initial = emptyState();
  initial.aeds = [{ id: "real-catalog-entry" }] as PersistentState["aeds"];
  const observed = observedStore(initial);
  const catalog = readStateByEntity(observed.store, state => {
    assert.equal(observed.stats().fullReads, 0);
    assert.deepEqual(state.aeds, initial.aeds);
    assert.equal(state.aeds, state.aeds);
    return state.aeds;
  });
  assert.equal(observed.stats().fullReads, 1);
  assert.notEqual(catalog, initial.aeds);
  assert.throws(() => catalog.pop(), TypeError);
  assert.equal(initial.aeds.length, 1);
});

test("legacy stores use their existing full read and asynchronous readers are rejected", () => {
  const initial = emptyState();
  initial.accountIdByProviderKey.one = "account";
  const observed = observedStore(initial);
  const legacy: StateStore = { read: observed.store.read, transact: observed.store.transact };
  readStateByEntity(legacy, state => {
    assert.throws(() => { state.accountIdByProviderKey.one = "detached-only"; }, TypeError);
  });
  assert.equal(initial.accountIdByProviderKey.one, "account");
  assert.equal(observed.stats().fullReads, 1);
  assert.equal(observed.stats().views, 0);
  assert.throws(() => readStateByEntity(observed.store, async () => 1), /must be synchronous/);
  assert.throws(() => readStateByEntity(legacy, async () => 1), /must be synchronous/);
});

const at = "2026-10-04T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const patientId = uuid(1), responderId = uuid(2), aliasId = uuid(3), eventId = uuid(4), otherEventId = uuid(5);

function device(id: string, userId: string): DeviceRecord {
  return { deviceInstanceId: id, deviceKind: "IPHONE", userId, companionPairId: uuid(10),
    agreements: Object.fromEntries(["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
      .map(kind => [kind, { version: "2.0", acceptedAt: at }])),
    capabilities: { locationAuthorized: true, notificationAuthorized: true }, availableForResponse: true,
    presenceObservedAt: at, lastSeenAt: at, lastBootstrapAt: at,
    latestPosition: { positionUpdateId: uuid(11), observedAt: at, serverReceivedAt: at,
      position: { kind: "R", latitude: 0, longitude: 0, accuracyMeters: 10 } },
    pushRegistration: { token: "a".repeat(64), environment: "SANDBOX", bundleId: "dev.codex.aedresponse", registeredAt: at, updatedAt: at } };
}

function notificationWorld(): PersistentState {
  const state = emptyState();
  state.devices[patientId] = device(patientId, "patient");
  state.devices[responderId] = device(responderId, "responder");
  state.devices[aliasId] = device(aliasId, "responder");
  state.events[eventId] = { id: eventId, state: "ACTIVE", recruitmentState: "RECRUITING",
    patientUserId: "patient", patientDeviceIds: [patientId], patientPairId: uuid(10),
    observationFingerprint: "synthetic", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    observation: { schemaVersion: "2.0", observationKind: "FALL_CONTEXT", eventId, fallDetectedAt: at,
      fallResolution: "CONFIRMED", appHelpResponse: "NEEDS_HELP", patientPositionObservedAt: at,
      patientPosition: { kind: "P", latitude: 0, longitude: 0, accuracyMeters: 10 } },
    patientPosition: { positionUpdateId: uuid(16), source: "IPHONE_PRIMARY", observedAt: at, serverReceivedAt: at,
      position: { kind: "P", latitude: 0, longitude: 0, accuracyMeters: 10 } },
    currentRecruitmentRadiusMeters: 1000, recruitmentStageStartedAt: at, createdAt: at,
    coordinationRevision: 0, assignmentRevision: 0, unavailableAedIds: [] };
  const request = { schemaVersion: "2.0" as const, messageId: uuid(12), eventId, occurredAt: at,
    deliveryId: uuid(13), deliveryStatus: "SENT" as const, eventType: "FALL_ASSISTANCE" as const,
    positioningTier: "SEARCH_RING" as const, distanceRange: "DISTANCE_0_500M" as const, etaRange: "ETA_0_5_MIN" as const,
    currentRecruitmentRadiusMeters: 1000, expiresAt: "2026-10-04T00:00:30.000Z" };
  state.deliveries[uuid(13)] = { id: uuid(13), eventId, deviceInstanceId: responderId, status: "SENT", statusOccurredAt: at, request };
  state.notificationOutboxById.offer = { id: "offer", eventId, name: "response:requested",
    recipient: { deviceInstanceId: responderId, companionPairId: uuid(10), userId: "responder" },
    payload: request, status: "PENDING", attempts: 0, nextAttemptAt: at };
  return state;
}

function service(store: StateStore, sent: PushDeliveryRequest[] = []) {
  return new AEDResponseService(store, loadConfig({}, tmpdir()), { emitToDevices: ids => [...ids] }, () => new Date(at), {}, undefined,
    { name: "synthetic", isConfigured: () => true, send: async request => { sent.push(request); return { status: "DELIVERED" }; } });
}

const cases: { name: string; eligible: boolean; modify: (state: PersistentState) => void }[] = [
  { name: "eligible responder", eligible: true, modify: () => {} },
  { name: "same-user device is patient on another ACTIVE event", eligible: false, modify: state => {
    state.events[otherEventId] = { ...structuredClone(state.events[eventId]!), id: otherEventId,
      patientUserId: "responder", patientDeviceIds: [aliasId] };
  } },
  { name: "same-user device holds assignment on another ACTIVE event", eligible: false, modify: state => {
    state.events[otherEventId] = { ...structuredClone(state.events[eventId]!), id: otherEventId };
    state.assignments[uuid(14)] = { id: uuid(14), eventId: otherEventId, deviceInstanceId: aliasId,
      role: "GO_TO_PATIENT", status: "EN_ROUTE", revision: 1, createdAt: at, updatedAt: at };
  } },
  { name: "same-user device already accepted this event", eligible: false, modify: state => {
    state.deliveries[uuid(15)] = { ...structuredClone(state.deliveries[uuid(13)]!), id: uuid(15),
      deviceInstanceId: aliasId, status: "ACCEPTED", decision: "ACCEPT" };
  } },
  { name: "other event has resolved", eligible: true, modify: state => {
    state.events[otherEventId] = { ...structuredClone(state.events[eventId]!), id: otherEventId,
      state: "RESOLVED", recruitmentState: "COMPLETED", resolvedAt: at, patientUserId: "responder", patientDeviceIds: [aliasId] };
    state.assignments[uuid(14)] = { id: uuid(14), eventId: otherEventId, deviceInstanceId: aliasId,
      role: "GO_TO_PATIENT", status: "COMPLETED", revision: 1, createdAt: at, updatedAt: at };
  } },
  { name: "recipient missing", eligible: false, modify: state => { delete state.devices[responderId]; } }
];

for (const scenario of cases) test(`dispatch and push eligibility match full state: ${scenario.name}`, async () => {
  const seed = notificationWorld(); scenario.modify(seed);
  const raw = observedStore(seed), svc = service(raw.store);
  const rows = Object.values(seed.notificationOutboxById);
  const full = raw.store.read(state => svc["dispatchNotifications"](state, rows, false));
  const lazy = readStateByEntity(raw.store, state => svc["dispatchNotifications"](state, rows, false));
  assert.deepEqual(lazy, full);
  assert.equal(lazy.get("offer"), scenario.eligible ? "PENDING" : "SUPPRESSED");

  const entity = new MemoryStateStore(seed), legacyInner = new MemoryStateStore(seed);
  let fullReads = 0;
  const counted: StateStore = {
    read: reader => { fullReads += 1; return entity.read(reader); },
    readEntities: reader => entity.readEntities(reader),
    transact: mutation => entity.transact(mutation),
    transactEntities: mutation => entity.transactEntities(mutation)
  };
  const legacy: StateStore = { read: reader => legacyInner.read(reader), transact: mutation => legacyInner.transact(mutation) };
  const entitySent: PushDeliveryRequest[] = [], legacySent: PushDeliveryRequest[] = [];
  await service(counted, entitySent).flushNotificationPushes();
  await service(legacy, legacySent).flushNotificationPushes();
  assert.deepEqual(entitySent, legacySent);
  assert.equal(entitySent.length, scenario.eligible ? 1 : 0);
  assert.equal(fullReads, 0, "outbox dispatch and push qualification must both use the lazy entity facade");
  assert.deepEqual(entity.read(state => state), legacyInner.read(state => state));
});
