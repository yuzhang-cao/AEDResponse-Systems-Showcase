import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type PersistentState } from "../src/models.js";
import { SQLiteStateStore } from "../src/store.js";
import { isInstrumentationEnabled, setInstrumentationEnabled } from "../src/runtime-metrics.js";

const AT = "2026-08-31T01:02:00.000Z";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const DEVICE = id(1), USER = id(2), EVENT = id(3), DELIVERY = id(4), ASSIGNMENT = id(5);

function seed(state: PersistentState): void {
  state.devices[DEVICE] = {
    deviceInstanceId: DEVICE, deviceKind: "IPHONE", companionPairId: id(6), userId: USER,
    agreements: {}, capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: AT, lastSeenAt: AT, lastBootstrapAt: AT,
    latestPosition: { positionUpdateId: id(7), observedAt: AT, serverReceivedAt: AT,
      position: { kind: "R", latitude: 22.198, longitude: 113.543, accuracyMeters: 10 } }
  };
  state.assignments[ASSIGNMENT] = {
    id: ASSIGNMENT, deviceInstanceId: DEVICE, eventId: EVENT, role: "GO_TO_PATIENT",
    status: "ASSIGNED", revision: 1, createdAt: AT, updatedAt: AT
  };
  state.deliveries[DELIVERY] = {
    id: DELIVERY, deviceInstanceId: DEVICE, eventId: EVENT, status: "SENT", statusOccurredAt: AT,
    request: { schemaVersion: "2.0", messageId: `response-requested:${EVENT}:${DEVICE}`,
      eventId: EVENT, deliveryId: DELIVERY, deliveryStatus: "SENT", occurredAt: AT,
      eventType: "FALL_ASSISTANCE", positioningTier: "SEARCH_RING",
      distanceRange: "DISTANCE_500_1000M", etaRange: "ETA_5_10_MIN",
      currentRecruitmentRadiusMeters: 1000, expiresAt: "2026-08-31T01:02:30.000Z" }
  };
}

function register(store: SQLiteStateStore): void {
  store.projections().register({ name: "deviceUsers", collection: "devices",
    derive: entity => (entity as { userId?: string }).userId });
}

function assertCurrent(store: SQLiteStateStore): void {
  assert.deepEqual([...store.projections().read("deviceUsers")], [[DEVICE, USER]]);
  assert.deepEqual(store.devicePositions().query(22.198, 113.543, 1000), [DEVICE]);
  assert.equal(store.positionExpiry().size, 1);
  assert.deepEqual([...store.assignmentIndex().assignmentIdsForDevice(DEVICE)], [ASSIGNMENT]);
  assert.deepEqual([...store.assignmentIndex().deviceIdsForIdentity(`user:${USER}`)], [DEVICE]);
  assert.deepEqual([...store.deliveryIndex().deliveryIdsForEvent(EVENT)], [DELIVERY]);
  assert.equal(store.deliveryIndex().deliveryIdForUser(EVENT, USER), DELIVERY);
}

for (const measuring of [true, false]) {
  test(`SQLite full commits maintain all indexes with instrumentation=${measuring}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "aed-index-lifecycle-"));
    const store = await SQLiteStateStore.open(join(directory, "state.sqlite"), []);
    const previous = isInstrumentationEnabled();
    t.after(async () => {
      setInstrumentationEnabled(previous);
      await store.close();
      await rm(directory, { recursive: true, force: true });
    });
    register(store);
    assert.equal(store.projections().read("deviceUsers").size, 0);
    setInstrumentationEnabled(measuring);
    await store.transact(seed);
    assertCurrent(store);
  });
}

test("SQLite reopen initializes assignment, identity and delivery indexes before any write", async t => {
  const directory = await mkdtemp(join(tmpdir(), "aed-index-reopen-"));
  const path = join(directory, "state.sqlite");
  let store = await SQLiteStateStore.open(path, []);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.transact(seed);
  await store.close();
  store = await SQLiteStateStore.open(path, []);
  register(store);
  assertCurrent(store);
  assert.equal(store.read(s => Object.keys(s.deliveries).length), 1);
});
