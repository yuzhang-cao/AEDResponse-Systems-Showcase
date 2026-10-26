/**
 * Composite delivery lookups (Phase 1 step #4).
 *
 * `deliveryForDevice` / `deliveryForUser` scan every retained delivery and are
 * called per candidate device, making eligibility O(candidates x all deliveries).
 * These tests pin the composite index that replaces them, and — because it is a
 * single-valued map — the uniqueness invariant that justifies it.
 *
 * The last test deliberately exercises all three indexes at once, on the real
 * recruitment predicate, because per-index tests can all pass while the composed
 * behaviour is still wrong.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AssignmentIndex } from "../src/assignment-index.js";
import { DeliveryIndex } from "../src/delivery-index.js";
import { DevicePositionIndex } from "../src/device-position-index.js";
import { EntityTransaction } from "../src/entity-transaction.js";
import { createStateReadView } from "../src/state-read.js";
import { emptyState, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const AT = "2026-08-31T01:02:00.000Z";
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };

function device(deviceInstanceId: string, userId: string | undefined, latitude: number, longitude: number) {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000),
    agreements: {},
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: AT,
    lastSeenAt: AT,
    lastBootstrapAt: AT,
    latestPosition: {
      positionUpdateId: uuid(9_900), observedAt: AT, serverReceivedAt: AT,
      position: { kind: "R", latitude, longitude, accuracyMeters: 10 }
    }
  } as never;
}

function delivery(id: string, eventId: string, deviceInstanceId: string) {
  return { id, eventId, deviceInstanceId, request: {}, status: "SENT", statusOccurredAt: AT } as never;
}

function event(id: string, state: string) {
  return { id, state, patientUserId: uuid(700), patientDeviceIds: [uuid(701)], patientPairId: uuid(702),
    observation: {}, observationFingerprint: "f", triggerSource: "SIMULATED_TEST",
    patientPosition: null, currentRecruitmentRadiusMeters: 1_000, recruitmentState: "RECRUITING",
    coordinationRevision: 1, createdAt: AT } as never;
}

function identityOf(record: unknown): string {
  const value = record as { userId?: string; deviceInstanceId: string };
  return value.userId ? `user:${value.userId}` : `device:${value.deviceInstanceId}`;
}

/** Mirrors the service helper: committed index ∪ staged keys, then tx predicate. */
function deliveryIdForDevice(
  index: DeliveryIndex, tx: EntityTransaction, eventId: string, deviceInstanceId: string
): string | undefined {
  const candidates = new Set<string>();
  const fromIndex = index.deliveryIdForDevice(eventId, deviceInstanceId);
  if (fromIndex !== undefined) candidates.add(fromIndex);
  for (const key of tx.stagedKeys("deliveries")) candidates.add(key);
  for (const id of candidates) {
    const record = tx.get("deliveries", id) as { eventId: string; deviceInstanceId: string } | undefined;
    if (record && record.eventId === eventId && record.deviceInstanceId === deviceInstanceId) return id;
  }
  return undefined;
}

function deliveryIdForUser(
  index: DeliveryIndex, tx: EntityTransaction, eventId: string, userId: string
): string | undefined {
  const candidates = new Set<string>();
  const fromIndex = index.deliveryIdForUser(eventId, userId);
  if (fromIndex !== undefined) candidates.add(fromIndex);
  for (const key of tx.stagedKeys("deliveries")) candidates.add(key);
  // A device bound inside this transaction gains a user key the committed index
  // cannot have, so its deliveries must be considered too.
  for (const deviceKey of tx.stagedKeys("devices")) {
    for (const id of index.deliveryIdsForDevice(deviceKey)) candidates.add(id);
  }
  for (const id of candidates) {
    const record = tx.get("deliveries", id) as { eventId: string; deviceInstanceId: string } | undefined;
    if (!record || record.eventId !== eventId) continue;
    const owner = tx.get("devices", record.deviceInstanceId) as { userId?: string } | undefined;
    if (owner?.userId === userId) return id;
  }
  return undefined;
}

function world(seed: (state: PersistentState) => void) {
  const state = emptyState();
  seed(state);
  const index = new DeliveryIndex();
  index.rebuild(state as never);
  return { state, index, tx: new EntityTransaction(createStateReadView(state)) };
}

test("1. a committed delivery is found by (event, device)", () => {
  const responder = uuid(100);
  const eventId = uuid(400);
  const deliveryId = uuid(300);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200), PATIENT.latitude, PATIENT.longitude);
    s.deliveries[deliveryId] = delivery(deliveryId, eventId, responder);
  });
  assert.equal(deliveryIdForDevice(index, tx, eventId, responder), deliveryId);
  assert.equal(deliveryIdForDevice(index, tx, uuid(401), responder), undefined, "other event");
  assert.equal(index.duplicates, 0);
  void state;
});

test("2. a committed delivery is found by (event, user)", () => {
  const responder = uuid(100);
  const userId = uuid(200);
  const eventId = uuid(400);
  const deliveryId = uuid(300);
  const { index, tx } = world(s => {
    s.devices[responder] = device(responder, userId, PATIENT.latitude, PATIENT.longitude);
    s.deliveries[deliveryId] = delivery(deliveryId, eventId, responder);
  });
  assert.equal(deliveryIdForUser(index, tx, eventId, userId), deliveryId);
  assert.equal(deliveryIdForUser(index, tx, eventId, uuid(201)), undefined);
});

test("3. a delivery created in the same transaction is visible to both lookups", () => {
  const responder = uuid(100);
  const userId = uuid(200);
  const eventId = uuid(400);
  const { index, tx } = world(s => {
    s.devices[responder] = device(responder, userId, PATIENT.latitude, PATIENT.longitude);
    s.events[eventId] = event(eventId, "ACTIVE");
  });
  // The committed index cannot know about it yet.
  assert.equal(deliveryIdForDevice(index, tx, eventId, responder), undefined);

  const deliveryId = uuid(300);
  tx.append("deliveries", deliveryId, delivery(deliveryId, eventId, responder));
  assert.equal(deliveryIdForDevice(index, tx, eventId, responder), deliveryId);
  assert.equal(deliveryIdForUser(index, tx, eventId, userId), deliveryId,
    "the user-side lookup must also see a delivery created in this transaction");
});

test("4. a device bound inside the transaction makes its delivery findable by user", () => {
  const responder = uuid(100);
  const userId = uuid(200);
  const eventId = uuid(400);
  const deliveryId = uuid(300);
  const { index, tx } = world(s => {
    s.devices[responder] = device(responder, undefined, PATIENT.latitude, PATIENT.longitude);
    s.deliveries[deliveryId] = delivery(deliveryId, eventId, responder);
    s.events[eventId] = event(eventId, "ACTIVE");
  });
  // Indexed without a user key while the device is unbound.
  assert.equal(index.deliveryIdForUser(eventId, userId), undefined);

  tx.update("devices", responder, draft => { (draft as { userId?: string }).userId = userId; });
  assert.equal(deliveryIdForUser(index, tx, eventId, userId), deliveryId,
    "binding the device inside the transaction must expose the (event, user) key");
});

test("5. a stale index entry is rejected by the transaction predicate", () => {
  const responder = uuid(100);
  const other = uuid(101);
  const eventId = uuid(400);
  const deliveryId = uuid(300);
  const { index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200), PATIENT.latitude, PATIENT.longitude);
    s.devices[other] = device(other, uuid(201), PATIENT.latitude, PATIENT.longitude);
    s.deliveries[deliveryId] = delivery(deliveryId, eventId, responder);
  });
  // Committed index says this delivery belongs to `responder`.
  assert.equal(index.deliveryIdForDevice(eventId, responder), deliveryId);

  // Move it to another device in the same transaction: the old key still returns
  // it (over-selection is allowed), but the predicate must reject it.
  tx.remove("deliveries", deliveryId);
  tx.append("deliveries", deliveryId, delivery(deliveryId, eventId, other));
  assert.equal(deliveryIdForDevice(index, tx, eventId, responder), undefined,
    "the exact predicate must reject the superseded entry");
  assert.equal(deliveryIdForDevice(index, tx, eventId, other), deliveryId,
    "and the staged key must make it findable under its new device");
});

test("6. the uniqueness invariant holds and a violation is surfaced, not silently resolved", () => {
  const first = uuid(100);
  const second = uuid(101);
  const eventId = uuid(400);
  const { index, tx } = world(s => {
    s.devices[first] = device(first, uuid(200), PATIENT.latitude, PATIENT.longitude);
    s.devices[second] = device(second, uuid(201), PATIENT.latitude, PATIENT.longitude);
  });
  index.upsert(uuid(300), eventId, first, uuid(200));
  assert.equal(index.duplicates, 0);

  // A second delivery for the same (event, device) cannot occur through the real
  // creation path, which returns early when either key already matches.  If it
  // ever does, the index records it instead of quietly picking one.
  index.upsert(uuid(301), eventId, first, uuid(200));
  // Both composite keys collide for this delivery, so both are counted: the
  // device key and the user key are independently single-valued.
  assert.equal(index.duplicates, 2, "a broken invariant must be visible on every key it breaks");
  assert.equal(index.deliveryIdForDevice(eventId, first), uuid(300),
    "the first delivery stays authoritative, matching .find() insertion order");
});

test("7. a rolled-back transaction leaves the committed delivery index untouched", () => {
  const responder = uuid(100);
  const eventId = uuid(400);
  const { index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200), PATIENT.latitude, PATIENT.longitude);
    s.events[eventId] = event(eventId, "ACTIVE");
  });
  const before = index.size;

  const deliveryId = uuid(300);
  tx.append("deliveries", deliveryId, delivery(deliveryId, eventId, responder));
  assert.equal(deliveryIdForDevice(index, tx, eventId, responder), deliveryId,
    "the overlay sees it during the transaction");
  tx.seal(); // transaction fails

  assert.equal(index.size, before, "the committed index must not have absorbed it");
  assert.equal(index.deliveryIdForDevice(eventId, responder), undefined);
});

test("8. lookups visit only the candidates the composite key names, not the whole collection", () => {
  const responder = uuid(100);
  const userId = uuid(200);
  const eventId = uuid(400);
  const mine = uuid(300);
  const { index, tx } = world(s => {
    s.devices[responder] = device(responder, userId, PATIENT.latitude, PATIENT.longitude);
    s.deliveries[mine] = delivery(mine, eventId, responder);
    // 100,000 unrelated deliveries across other events and devices.
    for (let n = 0; n < 100_000; n += 1) {
      s.deliveries[`bulk-${n}`] = delivery(`bulk-${n}`, `event-${n % 500}`, `dev-${n % 5_000}`);
    }
  });
  assert.equal(index.size, 100_001);

  let visited = 0;
  const counted = {
    deliveryIdForDevice: (e: string, d: string) => { visited += 1; return index.deliveryIdForDevice(e, d); },
    deliveryIdForUser: (e: string, u: string) => { visited += 1; return index.deliveryIdForUser(e, u); }
  };
  assert.equal(counted.deliveryIdForDevice(eventId, responder), mine);
  assert.equal(counted.deliveryIdForUser(eventId, userId), mine);
  assert.equal(visited, 2, "each lookup is a single composite-key probe");
});

test("the composed eligibility path agrees with a full scan, and reacts within one transaction", () => {
  const responder = uuid(100);
  const userId = uuid(200);
  const eventId = uuid(400);
  const assignmentId = uuid(300);

  const state = emptyState();
  state.devices[responder] = device(responder, userId, PATIENT.latitude, PATIENT.longitude);
  state.events[eventId] = event(eventId, "ACTIVE");

  const geo = new DevicePositionIndex();
  geo.rebuild(state.devices as never);
  const assignments = new AssignmentIndex();
  assignments.rebuild(state as never);
  const deliveries = new DeliveryIndex();
  deliveries.rebuild(state as never);

  /**
   * Composed eligibility: geographic candidates, then the assignment index, then
   * the delivery composites — every read through the transaction view, with each
   * index unioned against the transaction's staged keys.
   */
  const eligible = (tx: EntityTransaction): boolean => {
    const identity = identityOf(state.devices[responder]);
    const candidateDevices = new Set(geo.query(PATIENT.latitude, PATIENT.longitude, 1_000));
    for (const key of tx.stagedKeys("devices")) candidateDevices.add(key);
    if (!candidateDevices.has(responder)) return false;

    // No live assignment on an ACTIVE event for this device or identity.
    const candidateAssignments = new Set<string>();
    for (const id of candidateDevices) {
      for (const candidate of assignments.assignmentIdsForDevice(id)) candidateAssignments.add(candidate);
      for (const candidate of assignments.deviceIdsForIdentity(identity)) {
        for (const viaTwin of assignments.assignmentIdsForDevice(candidate)) candidateAssignments.add(viaTwin);
      }
    }
    for (const key of tx.stagedKeys("assignments")) candidateAssignments.add(key);
    for (const id of candidateAssignments) {
      const record = tx.get("assignments", id) as { status: string; eventId: string; deviceInstanceId: string } | undefined;
      if (!record) continue;
      if (record.status === "TIMED_OUT" || record.status === "CANCELLED") continue;
      const owner = tx.get("events", record.eventId) as { state: string } | undefined;
      if (owner?.state !== "ACTIVE") continue;
      const assigned = tx.get("devices", record.deviceInstanceId) as { userId?: string } | undefined;
      if (record.deviceInstanceId === responder
        || (assigned && identityOf(assigned) === identity)) return false;
    }

    // No delivery yet for this event, by device or by user.
    if (deliveryIdForDevice(deliveries, tx, eventId, responder) !== undefined) return false;
    if (deliveryIdForUser(deliveries, tx, eventId, userId) !== undefined) return false;
    return true;
  };

  const tx = new EntityTransaction(createStateReadView(state));
  assert.equal(eligible(tx), true, "an unencumbered nearby responder is eligible");

  // Same transaction: create the delivery, then re-check.
  const deliveryId = uuid(500);
  tx.append("deliveries", deliveryId, delivery(deliveryId, eventId, responder));
  assert.equal(eligible(tx), false,
    "creating the delivery in this transaction must immediately make the device ineligible");

  // And an assignment in the same transaction has the same effect on a twin.
  const twin = uuid(101);
  const second = new EntityTransaction(createStateReadView({
    ...state,
    devices: { ...state.devices, [twin]: device(twin, userId, PATIENT.latitude, PATIENT.longitude) }
  } as never));
  assert.equal(eligible(second), true);
  second.append("assignments", assignmentId,
    { id: assignmentId, deviceInstanceId: responder, eventId, role: "GO_TO_PATIENT",
      status: "ASSIGNED", revision: 1, updatedAt: AT } as never);
  assert.equal(eligible(second), false,
    "an assignment created in this transaction must block a same-identity device immediately");
});
