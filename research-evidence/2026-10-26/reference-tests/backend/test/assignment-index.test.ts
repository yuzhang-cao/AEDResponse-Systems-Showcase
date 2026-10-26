/**
 * Structural assignment index + the transaction-view eligibility predicate
 * (Phase 1 step #3).
 *
 * The predicate is "does this device, or any device sharing its identity, hold an
 * assignment on an ACTIVE event that has not exited?".
 *
 * The index deliberately answers only the *structural* half — "which assignments
 * could relate to this device?" — because the business half (`event.state`,
 * exited-partition status) is mutable within a transaction.  Baking it into
 * derived data would reintroduce the same silent-omission bug the geographic
 * index already demonstrated once: a committed index cannot see a state flip that
 * happens in the running transaction.
 *
 * Every case below is a way for that silent omission to happen; each is a case
 * where a responder would simply never be recruited and nothing would report it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AssignmentIndex } from "../src/assignment-index.js";
import { MemoryStateStore } from "../src/store.js";
import { EntityTransaction } from "../src/entity-transaction.js";
import { createStateReadView } from "../src/state-read.js";
import { emptyState, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const OBSERVED_AT = "2026-08-31T01:02:00.000Z";

function device(deviceInstanceId: string, userId: string | undefined) {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000),
    agreements: {},
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    lastBootstrapAt: OBSERVED_AT
  } as never;
}

function assignment(id: string, deviceInstanceId: string, eventId: string, status: string) {
  return { id, deviceInstanceId, eventId, role: "GO_TO_PATIENT", status, revision: 1, updatedAt: OBSERVED_AT } as never;
}

function event(id: string, state: string) {
  return { id, state, patientUserId: uuid(700), patientDeviceIds: [uuid(701)], patientPairId: uuid(702),
    observation: {}, observationFingerprint: "f", triggerSource: "SIMULATED_TEST",
    patientPosition: null, currentRecruitmentRadiusMeters: 1_000, recruitmentState: "RECRUITING",
    coordinationRevision: 1, createdAt: OBSERVED_AT } as never;
}

function identityOf(record: unknown): string {
  const value = record as { userId?: string; deviceInstanceId: string };
  return value.userId ? `user:${value.userId}` : `device:${value.deviceInstanceId}`;
}

/**
 * Mirrors `AEDResponseService.hasActiveAssignmentInTransaction` against the
 * structural index.  Kept as a local function so the test exercises the index and
 * the union rules directly, without standing up the whole service.
 */
function hasActiveAssignment(
  state: PersistentState,
  index: AssignmentIndex,
  tx: EntityTransaction,
  deviceInstanceId: string,
  identity: string
): number {
  const candidateDeviceIds = new Set<string>([deviceInstanceId]);
  for (const id of index.deviceIdsForIdentity(identity)) candidateDeviceIds.add(id);
  for (const key of tx.stagedKeys("devices")) candidateDeviceIds.add(key);

  const candidateAssignmentIds = new Set<string>();
  for (const id of candidateDeviceIds) {
    for (const assignmentId of index.assignmentIdsForDevice(id)) candidateAssignmentIds.add(assignmentId);
  }
  for (const key of tx.stagedKeys("assignments")) candidateAssignmentIds.add(key);

  let visited = 0;
  for (const assignmentId of candidateAssignmentIds) {
    const record = tx.get("assignments", assignmentId) as { status: string; eventId: string; deviceInstanceId: string } | undefined;
    if (!record) continue;
    visited += 1;
    if (record.status === "TIMED_OUT" || record.status === "CANCELLED") continue;
    const owner = tx.get("events", record.eventId) as { state: string } | undefined;
    if (owner?.state !== "ACTIVE") continue;
    const assignedDevice = tx.get("devices", record.deviceInstanceId);
    if (record.deviceInstanceId === deviceInstanceId
      || (assignedDevice !== undefined && identityOf(assignedDevice) === identity)) {
      return visited;
    }
  }
  return -visited; // negative = no active assignment found; magnitude = visited
}

function world(seed: (state: PersistentState) => void) {
  const state = emptyState();
  seed(state);
  const index = new AssignmentIndex();
  index.rebuild(state as never);
  const tx = new EntityTransaction(createStateReadView(state));
  return { state, index, tx };
}

test("device ordinals survive identity updates and follow deletion, recreation, clear and rebuild", () => {
  const index = new AssignmentIndex();
  index.rebuild({ devices: {
    laterKey: { deviceInstanceId: "laterKey" },
    earlierKey: { deviceInstanceId: "earlierKey", userId: "patient" }
  } });
  assert.equal(index.deviceOrdinal("laterKey"), 0);
  assert.equal(index.deviceOrdinal("earlierKey"), 1);
  index.upsertDevice("laterKey", "user:patient");
  assert.equal(index.deviceOrdinal("laterKey"), 0, "binding changes identity, never original enumeration order");
  index.upsertDevice("laterKey", "user:patient");
  assert.equal(index.deviceOrdinal("laterKey"), 0, "an unchanged identity keeps the same ordinal");
  index.removeDevice("laterKey");
  assert.equal(index.deviceOrdinal("laterKey"), undefined);
  index.upsertDevice("laterKey", "user:patient");
  assert.ok(index.deviceOrdinal("laterKey")! > index.deviceOrdinal("earlierKey")!,
    "a removed and re-created key moves to the end, like a JS object property");
  index.clear();
  assert.equal(index.deviceOrdinal("earlierKey"), undefined);
  index.upsertDevice("newFirst", "user:patient");
  assert.equal(index.deviceOrdinal("newFirst"), 0);
  index.rebuild({ devices: { rebuilt: { deviceInstanceId: "rebuilt" } } });
  assert.equal(index.deviceOrdinal("newFirst"), undefined);
  assert.equal(index.deviceOrdinal("rebuilt"), 0);
});

test("store device ordinals preserve creation order across canonical entity change sets", async () => {
  const first = uuid(900);
  const second = uuid(800);
  const state = emptyState();
  state.devices[first] = device(first, undefined);
  state.devices[second] = device(second, uuid(700));
  const store = new MemoryStateStore(state);
  const index = store.assignmentIndex();
  const firstOrdinal = index.deviceOrdinal(first);
  const createdFirst = uuid(600);
  const createdSecond = uuid(500);
  await store.transactEntities(tx => {
    tx.append("devices", createdFirst, device(createdFirst, uuid(700)));
    tx.update("devices", first, draft => { draft.userId = uuid(700); });
    tx.append("devices", createdSecond, device(createdSecond, uuid(700)));
    assert.equal(index.deviceOrdinal(createdFirst), undefined, "staging must not alter committed ordinals");
  });
  const publishedKeys = store.readEntities(view => view.keys("devices"));
  assert.deepEqual(publishedKeys, [first, second, createdFirst, createdSecond]);
  const restored = [...index.deviceIdsForIdentity(`user:${uuid(700)}`)]
    .sort((left, right) => index.deviceOrdinal(left)! - index.deviceOrdinal(right)!);
  assert.deepEqual(restored, publishedKeys, "candidate order restores actual committed object enumeration");
  assert.equal(index.deviceOrdinal(first), firstOrdinal, "a staged binding preserves the original key ordinal");
});

test("1. an assignment created in the same transaction blocks immediately", () => {
  const responder = uuid(100);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
  });
  // Committed index knows nothing about the new assignment yet.
  assert.equal(index.assignmentIdsForDevice(responder).size, 0);

  const assignmentId = uuid(300);
  tx.append("assignments", assignmentId, assignment(assignmentId, responder, uuid(400), "ASSIGNED"));
  const visited = hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`);
  assert.ok(visited > 0, "the freshly created assignment must block a second recruitment");
});

test("2. an assignment that exits within the same transaction stops blocking", () => {
  const responder = uuid(100);
  const assignmentId = uuid(300);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
    s.assignments[assignmentId] = assignment(assignmentId, responder, uuid(400), "ASSIGNED");
  });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) > 0);

  tx.update("assignments", assignmentId, draft => {
    (draft as { status: string }).status = "CANCELLED";
  });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) <= 0,
    "an assignment cancelled in this transaction must no longer block recruitment");
});

test("3. an event leaving ACTIVE in the same transaction invalidates its assignment", () => {
  const responder = uuid(100);
  const assignmentId = uuid(300);
  const eventId = uuid(400);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[eventId] = event(eventId, "ACTIVE");
    s.assignments[assignmentId] = assignment(assignmentId, responder, eventId, "ASSIGNED");
  });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) > 0);

  tx.update("events", eventId, draft => { (draft as { state: string }).state = "RESOLVED"; });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) <= 0,
    "the assignment's event is no longer ACTIVE in this transaction");
});

test("4. an event entering ACTIVE in the same transaction activates its existing assignment", () => {
  // This is the case that a state-baked index ("devices on an active assignment")
  // would MISS: the committed index has no entry, and the transaction never
  // touches the assignment, so unioning staged assignments would not help either.
  const responder = uuid(100);
  const assignmentId = uuid(300);
  const eventId = uuid(400);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[eventId] = event(eventId, "RECRUITING");
    s.assignments[assignmentId] = assignment(assignmentId, responder, eventId, "ASSIGNED");
  });
  // Structural index still offers the assignment as a candidate...
  assert.equal(index.assignmentIdsForDevice(responder).has(assignmentId), true);
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) <= 0,
    "while the event is not ACTIVE the assignment must not block");

  tx.update("events", eventId, draft => { (draft as { state: string }).state = "ACTIVE"; });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) > 0,
    "once the event is ACTIVE in this transaction the existing assignment must block");
});

test("5. a second device sharing the identity is blocked too", () => {
  const holder = uuid(100);
  const twin = uuid(101);
  const userId = uuid(200);
  const assignmentId = uuid(300);
  const { state, index, tx } = world(s => {
    s.devices[holder] = device(holder, userId);
    s.devices[twin] = device(twin, userId);      // same person, second iPhone
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
    s.assignments[assignmentId] = assignment(assignmentId, holder, uuid(400), "ASSIGNED");
  });
  // The twin itself holds nothing...
  assert.equal(index.assignmentIdsForDevice(twin).size, 0);
  // ...but shares an identity, so it must not be recruited again.
  assert.ok(hasActiveAssignment(state, index, tx, twin, `user:${userId}`) > 0,
    "a device sharing the holder's identity must not be recruited again");
});

test("6. one of several assignments exiting leaves the device still busy", () => {
  const responder = uuid(100);
  const first = uuid(300);
  const second = uuid(301);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
    s.events[uuid(401)] = event(uuid(401), "ACTIVE");
    s.assignments[first] = assignment(first, responder, uuid(400), "ASSIGNED");
    s.assignments[second] = assignment(second, responder, uuid(401), "ASSIGNED");
  });
  assert.equal(index.assignmentIdsForDevice(responder).size, 2,
    "both assignments must be tracked, not collapsed into a boolean");

  tx.update("assignments", first, draft => { (draft as { status: string }).status = "CANCELLED"; });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`) > 0,
    "the remaining live assignment must keep the device busy");
});

test("7. an unbound device whose identity appears in this transaction is still found", () => {
  // Identity is one-way mutable: `device:<id>` becomes `user:<uid>` on binding.
  const responder = uuid(100);
  const userId = uuid(200);
  const assignmentId = uuid(300);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, undefined);   // unbound at commit time
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
    s.assignments[assignmentId] = assignment(assignmentId, responder, uuid(400), "ASSIGNED");
  });
  // Indexed under the device form, so a lookup by user identity finds nothing.
  assert.equal(index.deviceIdsForIdentity(`user:${userId}`).size, 0);
  assert.equal(index.deviceIdsForIdentity(`device:${responder}`).size, 1);

  tx.update("devices", responder, draft => { (draft as { userId?: string }).userId = userId; });
  assert.ok(hasActiveAssignment(state, index, tx, responder, `user:${userId}`) > 0,
    "a device bound inside this transaction must still be found by its new identity");
});

test("8. the check visits only the device's own assignments, not the whole collection", () => {
  const responder = uuid(100);
  const mine = uuid(300);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
    s.assignments[mine] = assignment(mine, responder, uuid(400), "ASSIGNED");
    // 100,000 unrelated assignments belonging to other devices.
    for (let n = 0; n < 100_000; n += 1) {
      const id = `bulk-${n}`;
      s.assignments[id] = assignment(id, `other-${n % 5_000}`, uuid(400), "ASSIGNED");
    }
  });
  assert.equal(index.assignmentCount, 100_001);

  const visited = hasActiveAssignment(state, index, tx, responder, `user:${uuid(200)}`);
  assert.ok(visited > 0);
  assert.ok(visited <= 4,
    `expected a handful of candidate assignments, inspected ${visited} out of 100,001`);
});

test("9. a rolled-back transaction leaves the committed index untouched", () => {
  const responder = uuid(100);
  const { state, index, tx } = world(s => {
    s.devices[responder] = device(responder, uuid(200));
    s.events[uuid(400)] = event(uuid(400), "ACTIVE");
  });
  const before = index.assignmentCount;

  const assignmentId = uuid(300);
  tx.append("assignments", assignmentId, assignment(assignmentId, responder, uuid(400), "ASSIGNED"));
  tx.seal(); // the transaction fails; nothing is published

  assert.equal(index.assignmentCount, before,
    "a discarded transaction must not have absorbed its assignment into the committed index");
  assert.equal(index.assignmentIdsForDevice(responder).size, 0);
});
