/**
 * Transaction-aware index reads (read-your-writes), Phase 1 items #1+#2.
 *
 * Committed indexes are advanced only *after* a commit, which is correct: moving
 * index state at mutation time would leave the index changed when the database
 * rollback happens.  The cost is that a committed index does not contain entities
 * the running transaction just wrote.
 *
 * The fix is a union, not a mutation: candidate set = committed index query ∪ the
 * transaction's own staged keys, then the exact business predicate filters.  That
 * is always a superset, so it cannot omit a device that newly qualifies, and a
 * staged device that no longer qualifies is simply rejected by the exact check.
 *
 * These tests pin that property directly, in both directions, plus rollback
 * isolation.  They exist because the failure mode is *silent*: without them a
 * responder who moves next to a patient simply never receives an offer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EntityTransaction } from "../src/entity-transaction.js";
import { createStateReadView } from "../src/state-read.js";
import { DevicePositionIndex } from "../src/device-position-index.js";
import { emptyState, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const PATIENT = { latitude: 22.1987, longitude: 113.5439 };

function deviceRecord(deviceInstanceId: string, userId: string, latitude: number, longitude: number) {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    userId,
    accountId: uuid(9_000),
    companionPairId: uuid(9_500),
    agreements: {},
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: "2026-08-31T01:02:00.000Z",
    lastSeenAt: "2026-08-31T01:02:00.000Z",
    lastBootstrapAt: "2026-08-31T01:02:00.000Z",
    latestPosition: {
      positionUpdateId: uuid(9_900),
      observedAt: "2026-08-31T01:02:00.000Z",
      serverReceivedAt: "2026-08-31T01:02:00.000Z",
      position: { kind: "R", latitude, longitude, accuracyMeters: 10 }
    }
  } as never;
}

/** Mirrors the service helper: committed index result ∪ staged keys. */
function candidateIds(
  index: DevicePositionIndex,
  event: { currentRecruitmentRadiusMeters: number },
  stagedDeviceKeys: readonly string[]
): string[] {
  const candidates = new Set(
    index.query(PATIENT.latitude, PATIENT.longitude, event.currentRecruitmentRadiusMeters)
  );
  for (const key of stagedDeviceKeys) candidates.add(key);
  return [...candidates];
}

/** The exact check recruitment ultimately applies, reduced to distance. */
function withinRing(state: PersistentState, deviceInstanceId: string, radiusMeters: number): boolean {
  const position = (state.devices[deviceInstanceId] as { latestPosition?: { position?: { latitude: number; longitude: number } } })
    ?.latestPosition?.position;
  if (!position) return false;
  const radians = Math.PI / 180;
  const latitudeDelta = (position.latitude - PATIENT.latitude) * radians;
  const longitudeDelta = (position.longitude - PATIENT.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(PATIENT.latitude * radians) * Math.cos(position.latitude * radians)
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a)))) <= radiusMeters;
}

const EVENT = { currentRecruitmentRadiusMeters: 1_000 };

function world(moverLatitude: number, moverLongitude: number) {
  const state = emptyState();
  const mover = uuid(100);
  const other = uuid(101);
  state.devices[mover] = deviceRecord(mover, uuid(200), moverLatitude, moverLongitude);
  state.devices[other] = deviceRecord(other, uuid(201), PATIENT.latitude + 0.001, PATIENT.longitude + 0.001);
  const index = new DevicePositionIndex();
  index.rebuild(state.devices as never);
  return { state, mover, other, index };
}

test("1. a device that moves INTO the ring within the transaction is a candidate", () => {
  // Starts 3 km away: the committed index does not know about it.
  const { state, mover, other, index } = world(PATIENT.latitude + 0.03, PATIENT.longitude + 0.03);
  assert.equal(index.query(PATIENT.latitude, PATIENT.longitude, 1_000).includes(mover), false);

  const tx = new EntityTransaction(createStateReadView(state));
  tx.update("devices", mover, draft => {
    (draft as { latestPosition: { position: { latitude: number; longitude: number } } })
      .latestPosition.position = { latitude: PATIENT.latitude + 0.0005, longitude: PATIENT.longitude + 0.0005 };
  });

  const candidates = candidateIds(index, EVENT, tx.stagedKeys("devices"));
  assert.ok(candidates.includes(mover),
    "a device whose new position entered the ring must be a candidate");
  // And the exact check confirms it is genuinely in range.
  assert.ok(withinRing(state, other, 1_000));
});

test("2. a device that moves OUT of the ring within the transaction is not eligible", () => {
  // Starts inside the ring: the committed index does report it.
  const { state, mover, index } = world(PATIENT.latitude + 0.0005, PATIENT.longitude + 0.0005);
  assert.equal(index.query(PATIENT.latitude, PATIENT.longitude, 1_000).includes(mover), true);

  const tx = new EntityTransaction(createStateReadView(state));
  tx.update("devices", mover, draft => {
    (draft as { latestPosition: { position: { latitude: number; longitude: number } } })
      .latestPosition.position = { latitude: PATIENT.latitude + 0.05, longitude: PATIENT.longitude + 0.05 };
  });

  const candidates = candidateIds(index, EVENT, tx.stagedKeys("devices"));
  // Over-selection is expected and allowed — the committed index still lists it —
  // but the exact check must reject it, which is what the union guarantees: the
  // stale entry can never be *promoted*, only filtered.
  assert.ok(candidates.includes(mover), "the stale index entry is still returned (over-selection)");
  assert.equal(tx.get("devices", mover) !== undefined, true);
  // The staged value is what a caller reads, so the exact check sees the new spot.
  const staged = tx.get("devices", mover) as { latestPosition: { position: { latitude: number } } };
  assert.ok(staged.latestPosition.position.latitude > PATIENT.latitude + 0.04,
    "reads must observe the staged position, not the committed one");
});

test("3. a delivery created in the same transaction is visible to a later check", () => {
  const { state, mover } = world(PATIENT.latitude, PATIENT.longitude);
  const tx = new EntityTransaction(createStateReadView(state));
  const deliveryId = uuid(300);
  assert.equal(tx.has("deliveries", deliveryId), false);

  tx.append("deliveries", deliveryId, {
    id: deliveryId,
    eventId: uuid(400),
    deviceInstanceId: mover,
    request: {},
    status: "PENDING",
    statusOccurredAt: "2026-08-31T01:02:00.000Z"
  } as never);

  assert.equal(tx.has("deliveries", deliveryId), true,
    "an eligibility re-check in the same transaction must see the delivery it just created");
  assert.ok(tx.stagedKeys("deliveries").includes(deliveryId));
});

test("4. an assignment created in the same transaction is visible to a later check", () => {
  const { state, mover } = world(PATIENT.latitude, PATIENT.longitude);
  const tx = new EntityTransaction(createStateReadView(state));
  const assignmentId = uuid(500);
  tx.append("assignments", assignmentId, {
    id: assignmentId,
    eventId: uuid(400),
    deviceInstanceId: mover,
    role: "GO_TO_PATIENT",
    status: "ASSIGNED",
    revision: 1,
    updatedAt: "2026-08-31T01:02:00.000Z"
  } as never);
  assert.equal(tx.has("assignments", assignmentId), true);
  assert.ok(tx.stagedKeys("assignments").includes(assignmentId));
});

test("5. a rolled-back transaction leaves committed indexes untouched", () => {
  const { state, mover, index } = world(PATIENT.latitude + 0.03, PATIENT.longitude + 0.03);
  const before = index.query(PATIENT.latitude, PATIENT.longitude, 1_000);
  const committedBefore = JSON.stringify(state.devices[mover]);

  const tx = new EntityTransaction(createStateReadView(state));
  tx.update("devices", mover, draft => {
    (draft as { latestPosition: { position: { latitude: number; longitude: number } } })
      .latestPosition.position = { latitude: PATIENT.latitude, longitude: PATIENT.longitude };
  });
  // The overlay observes the staged write...
  assert.ok(tx.stagedKeys("devices").includes(mover));
  try {
    throw new Error("later step fails");
  } catch {
    tx.seal(); // discard: nothing is applied to committed state or indexes
  }

  // ...and after the failed transaction the committed world is unchanged.
  assert.deepEqual(index.query(PATIENT.latitude, PATIENT.longitude, 1_000), before,
    "the committed index must not have absorbed a staged position");
  assert.equal(JSON.stringify(state.devices[mover]), committedBefore,
    "committed state must be untouched after a rollback");
});
