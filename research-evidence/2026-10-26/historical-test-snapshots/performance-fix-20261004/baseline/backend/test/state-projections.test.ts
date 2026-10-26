/**
 * The active-recruitment projection is derived data that decides whether a
 * standby position change triggers recruitment work.  A stale or wrong entry
 * would silently skip a real update, so these tests cover both the maintenance
 * mechanics and the property the index exists for: cost that does not grow with
 * ended-event history (plan §4.2, second test).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, type PersistentState } from "../src/models.js";
import { MemoryStateStore, SQLiteStateStore } from "../src/store.js";
import {
  ProjectionRegistry,
  type GroupedStateProjection,
  type StateProjection
} from "../src/state-projections.js";

interface Entry { latitude: number; longitude: number; radiusMeters: number }

const projection: StateProjection<Entry> = {
  name: "activeRecruitingEvents",
  collection: "events",
  derive(entity) {
    const event = entity as {
      state?: string; recruitmentState?: string;
      currentRecruitmentRadiusMeters?: number;
      patientPosition?: { position?: { latitude: number; longitude: number } };
    };
    if (event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") return undefined;
    const point = event.patientPosition?.position;
    if (!point) return undefined;
    return {
      latitude: point.latitude,
      longitude: point.longitude,
      radiusMeters: event.currentRecruitmentRadiusMeters ?? 1_000
    };
  }
};

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    state: "ACTIVE",
    recruitmentState: "RECRUITING",
    currentRecruitmentRadiusMeters: 1_000,
    patientPosition: { position: { latitude: 22.19, longitude: 113.54 } },
    ...overrides
  };
}

function registryWith(events: Record<string, unknown>): ProjectionRegistry {
  const state = emptyState() as unknown as Record<string, unknown>;
  (state as { events: Record<string, unknown> }).events = events;
  const registry = new ProjectionRegistry();
  registry.attachSource(() => state);
  registry.register(projection);
  return registry;
}

test("projection indexes only actively recruiting events", () => {
  const registry = registryWith({
    ended: event({ state: "RESOLVED" }),
    paused: event({ recruitmentState: "STAGE_TIMEOUT" }),
    activeA: event({}),
    activeB: event({ currentRecruitmentRadiusMeters: 1_500 })
  });
  const entries = registry.read<Entry>("activeRecruitingEvents");
  assert.deepEqual([...entries.keys()].sort(), ["activeA", "activeB"]);
  assert.equal(entries.get("activeB")?.radiusMeters, 1_500);
});

test("incremental maintenance tracks activation, deactivation and payload changes", () => {
  const registry = registryWith({ a: event({}) });
  assert.deepEqual([...registry.read<Entry>("activeRecruitingEvents").keys()], ["a"]);

  // New recruiting event appears via a change set.
  registry.applyChanges([{
    collection: "events", key: "b", before: undefined, after: event({ state: "ACTIVE" }),
    mutationOrdinal: 0
  }]);
  assert.deepEqual([...registry.read<Entry>("activeRecruitingEvents").keys()].sort(), ["a", "b"]);

  // Radius change must be reflected, not cached from first derivation.
  registry.applyChanges([{
    collection: "events", key: "b",
    before: event({ state: "ACTIVE" }),
    after: event({ state: "ACTIVE", currentRecruitmentRadiusMeters: 2_000 }),
    mutationOrdinal: 1
  }]);
  assert.equal(registry.read<Entry>("activeRecruitingEvents").get("b")?.radiusMeters, 2_000);

  // Patient movement must be reflected.
  registry.applyChanges([{
    collection: "events", key: "b",
    before: event({}),
    after: event({ patientPosition: { position: { latitude: 1, longitude: 2 } } }),
    mutationOrdinal: 2
  }]);
  assert.equal(registry.read<Entry>("activeRecruitingEvents").get("b")?.latitude, 1);

  // Deactivation drops it.
  registry.applyChanges([{
    collection: "events", key: "b", before: event({}), after: event({ state: "RESOLVED" }),
    mutationOrdinal: 3
  }]);
  assert.deepEqual([...registry.read<Entry>("activeRecruitingEvents").keys()], ["a"]);

  // Deletion drops it.
  registry.applyChanges([{ collection: "events", key: "a", before: event({}), after: undefined,
    mutationOrdinal: 4 }]);
  assert.equal(registry.read<Entry>("activeRecruitingEvents").size, 0);
});

test("a whole-state commit invalidates the index and it rebuilds from committed state", () => {
  const state = emptyState() as unknown as { events: Record<string, unknown> };
  state.events = { a: event({}) };
  const registry = new ProjectionRegistry();
  registry.attachSource(() => state);
  registry.register(projection);
  assert.equal(registry.read<Entry>("activeRecruitingEvents").size, 1);

  // The whole-state path cannot report a change set, so it marks stale; a later
  // read must observe the new committed truth rather than the old index.
  state.events.b = event({});
  state.events.a = event({ state: "RESOLVED" });
  registry.invalidateAll();
  const rebuilt = registry.read<Entry>("activeRecruitingEvents");
  assert.deepEqual([...rebuilt.keys()], ["b"]);
});

const STORE_TIME = "2026-09-01T00:00:00.000Z";
const STORE_EVENT = "REDACTED-SUPPLEMENT-ID-11e594f48195";
const STORE_DEVICE = "REDACTED-SUPPLEMENT-ID-e79acd97ac88";
const STORE_RECEIPT = "REDACTED-SUPPLEMENT-ID-993224b4fe85";

function storeProjectionState(): PersistentState {
  const state = emptyState();
  const point = { kind: "P" as const, latitude: 22.19, longitude: 113.54, accuracyMeters: 10 };
  state.devices[STORE_DEVICE] = {
    deviceInstanceId: STORE_DEVICE, deviceKind: "IPHONE", companionPairId: STORE_DEVICE,
    agreements: {}, capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: STORE_TIME,
    lastSeenAt: STORE_TIME, lastBootstrapAt: STORE_TIME
  };
  state.events[STORE_EVENT] = {
    id: STORE_EVENT, state: "ACTIVE", recruitmentState: "RECRUITING",
    patientUserId: STORE_EVENT, patientDeviceIds: [], patientPairId: STORE_EVENT,
    unavailableAedIds: [], createdAt: STORE_TIME, observationFingerprint: "projection-fixture",
    triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    observation: {
      schemaVersion: "2.0", eventId: STORE_EVENT, observationKind: "FALL_CONTEXT",
      fallDetectedAt: STORE_TIME, fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPositionObservedAt: STORE_TIME, patientPosition: point
    },
    patientPosition: { positionUpdateId: STORE_EVENT, source: "IPHONE_PRIMARY",
      observedAt: STORE_TIME, serverReceivedAt: STORE_TIME, position: point },
    currentRecruitmentRadiusMeters: 1_000, recruitmentStageStartedAt: STORE_TIME,
    coordinationRevision: 1, assignmentRevision: 1, exitedResponderUserIds: []
  };
  return state;
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: devices and receipt commit preserves the materialized recruitment projection`, async t => {
    let store: MemoryStateStore | SQLiteStateStore;
    if (backend === "memory") store = new MemoryStateStore(storeProjectionState());
    else {
      const directory = await mkdtemp(join(tmpdir(), "aed-projection-commit-"));
      const sqlite = await SQLiteStateStore.open(join(directory, "state.sqlite"), []);
      store = sqlite;
      t.after(async () => { await sqlite.close(); await rm(directory, { recursive: true, force: true }); });
      await store.transact(draft => Object.assign(draft, storeProjectionState()));
    }
    store.projections().register(projection);
    const before = [...store.projections().read<Entry>(projection.name)];
    assert.deepEqual(before.map(([key]) => key), [STORE_EVENT], "the guard starts with a populated projection");
    const eventBefore = store.readEntities(view => view.get("events", STORE_EVENT));
    await store.transactEntities(tx => {
      tx.update("devices", STORE_DEVICE, draft => {
        draft.latestPosition = { positionUpdateId: STORE_RECEIPT,
          observedAt: STORE_TIME, serverReceivedAt: STORE_TIME,
          position: { kind: "R", latitude: 22.30, longitude: 113.54, accuracyMeters: 10 } };
      });
      tx.append("positionUpdateReceiptsById", STORE_RECEIPT, {
        deviceInstanceId: STORE_DEVICE, kind: "R", fingerprint: "position-receipt",
        recordedAt: STORE_TIME, result: { positionUpdateId: STORE_RECEIPT,
          applied: true, idempotent: false, ignoredAsStale: false,
          positionObservedAt: STORE_TIME, serverReceivedAt: STORE_TIME }
      });
      assert.deepEqual(tx.stagedKeys("events"), [], "this commit must not stage event writes");
      assert.deepEqual([...store.projections().read<Entry>(projection.name)], before);
    });
    assert.deepEqual([...store.projections().read<Entry>(projection.name)], before);
    assert.deepEqual(store.readEntities(view => view.get("events", STORE_EVENT)), eventBefore);
    assert.ok(store.readEntities(view => view.get("positionUpdateReceiptsById", STORE_RECEIPT)));
    assert.equal(store.readEntities(view => view.get("devices", STORE_DEVICE))
      ?.latestPosition?.position.latitude, 22.30);
  });
}

test("index size and lookup do not grow with ended-event history (plan §4.2 test 2)", () => {
  const build = (endedCount: number) => {
    const events: Record<string, unknown> = { live: event({}) };
    for (let index = 0; index < endedCount; index += 1) {
      events[`ended-${index}`] = event({ state: "RESOLVED" });
    }
    return registryWith(events);
  };
  const small = build(10);
  const large = build(10_000);

  // The indexed working set is identical; history contributes nothing.
  assert.equal(small.read<Entry>("activeRecruitingEvents").size, 1);
  assert.equal(large.read<Entry>("activeRecruitingEvents").size, 1);
  assert.deepEqual(
    [...small.read<Entry>("activeRecruitingEvents").keys()],
    [...large.read<Entry>("activeRecruitingEvents").keys()]
  );

  // An incremental commit to an ended event costs the same in both cases: one
  // derivation for the changed entity, with no walk over the collection.
  let derivations = 0;
  const counting: StateProjection<Entry> = {
    ...projection,
    derive(entity) { derivations += 1; return projection.derive(entity); }
  };
  const registry = build(10_000);
  (registry as unknown as { definitions: Map<string, StateProjection<unknown>> })
    .definitions.set(projection.name, counting as StateProjection<unknown>);
  registry.read<Entry>("activeRecruitingEvents");
  derivations = 0;
  registry.applyChanges([{
    collection: "events", key: "ended-1", before: event({ state: "RESOLVED" }), after: event({ state: "RESOLVED" }),
    mutationOrdinal: 0
  }]);
  assert.equal(derivations, 1, "one changed entity, one derivation");
});

/** Grouped index: deliveries of one event, replacing a whole-collection scan. */
const deliveryIndex: GroupedStateProjection<{ id: string }> = {
  name: "deliveriesByEventId",
  collection: "deliveries",
  groupKey(entity) {
    const delivery = entity as { eventId?: unknown };
    return typeof delivery.eventId === "string" ? delivery.eventId : undefined;
  },
  derive(entity) { return entity as { id: string }; }
};

function registryWithDeliveries(deliveries: Record<string, unknown>): ProjectionRegistry {
  const state = emptyState() as unknown as Record<string, unknown>;
  (state as { deliveries: Record<string, unknown> }).deliveries = deliveries;
  const registry = new ProjectionRegistry();
  registry.attachSource(() => state);
  registry.registerGrouped(deliveryIndex);
  return registry;
}

const delivery = (id: string, eventId: string) => ({ id, eventId });

test("grouped projection indexes deliveries per event", () => {
  const registry = registryWithDeliveries({
    d1: delivery("d1", "eventA"),
    d2: delivery("d2", "eventA"),
    d3: delivery("d3", "eventB")
  });
  const grouped = registry.readGrouped<{ id: string }>("deliveriesByEventId");
  assert.deepEqual([...grouped.keys()].sort(), ["eventA", "eventB"]);
  assert.deepEqual([...grouped.get("eventA")!.keys()].sort(), ["d1", "d2"]);
  assert.deepEqual([...grouped.get("eventB")!.keys()], ["d3"]);
});

test("grouped membership follows the group key and tracks deletions", () => {
  const registry = registryWithDeliveries({ d1: delivery("d1", "eventA") });
  assert.deepEqual([...registry.readGrouped<{ id: string }>("deliveriesByEventId").keys()], ["eventA"]);

  // A delivery that moves to another event must leave no stale membership behind.
  registry.applyChanges([{
    collection: "deliveries", key: "d1",
    before: delivery("d1", "eventA"), after: delivery("d1", "eventB"), mutationOrdinal: 0
  }]);
  const moved = registry.readGrouped<{ id: string }>("deliveriesByEventId");
  assert.equal(moved.get("eventA"), undefined, "old group must not still list the delivery");
  assert.deepEqual([...moved.get("eventB")!.keys()], ["d1"]);

  // Append into an existing group.
  registry.applyChanges([{
    collection: "deliveries", key: "d2", before: undefined, after: delivery("d2", "eventB"),
    mutationOrdinal: 1
  }]);
  assert.deepEqual(
    [...registry.readGrouped<{ id: string }>("deliveriesByEventId").get("eventB")!.keys()].sort(),
    ["d1", "d2"]
  );

  // Deletion removes it.
  registry.applyChanges([{
    collection: "deliveries", key: "d1", before: delivery("d1", "eventB"), after: undefined,
    mutationOrdinal: 2
  }]);
  assert.deepEqual(
    [...registry.readGrouped<{ id: string }>("deliveriesByEventId").get("eventB")!.keys()],
    ["d2"]
  );
});

test("grouped index entries for one event do not grow with other events' history", () => {
  const build = (otherCount: number) => {
    const deliveries: Record<string, unknown> = { target: delivery("target", "eventA") };
    for (let index = 0; index < otherCount; index += 1) {
      deliveries[`other-${index}`] = delivery(`other-${index}`, `event-${index}`);
    }
    return registryWithDeliveries(deliveries);
  };
  const small = build(10).readGrouped<{ id: string }>("deliveriesByEventId");
  const large = build(10_000).readGrouped<{ id: string }>("deliveriesByEventId");
  assert.equal(small.get("eventA")!.size, 1);
  assert.equal(large.get("eventA")!.size, 1, "the queried group is unaffected by unrelated history");
  assert.equal(large.size, 10_001, "the index still covers every group");
});
