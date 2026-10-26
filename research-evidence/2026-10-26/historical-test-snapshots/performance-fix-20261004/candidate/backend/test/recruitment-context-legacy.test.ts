/**
 * Legacy recruitment adapter — the "no optimisation happened here" guard.
 *
 * Commit 1 of step #5 is an access-abstraction change ONLY.  Its success criterion
 * is the opposite of a performance test: after it, the legacy adapter must still
 * be scanning whole collections, because the indexed path does not exist yet and
 * any narrowing at this stage would mean the algorithm itself changed silently
 * during what was supposed to be a mechanical extraction.
 *
 * So these tests assert the *unoptimised* shape explicitly.  If a later edit
 * narrows `candidateDevices` (or filters deliveries before handing them over),
 * these fail — which is the intended signal that commit 1 stopped being commit 1.
 *
 * The matching requirement for commit 2 is the mirror image: the Tx adapter must
 * report 0 whole-collection scans.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { deviceIdentityKey } from "../src/domain.js";
import { emptyState, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const AT = "2026-08-31T01:02:00.000Z";

function device(deviceInstanceId: string, userId?: string) {
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
    lastBootstrapAt: AT
  } as never;
}

function event(id: string, state: string): PersistentState["events"][string] {
  return { id, state, patientUserId: uuid(700), patientDeviceIds: [uuid(701)],
    patientPairId: uuid(702), observation: {}, observationFingerprint: "f",
    triggerSource: "SIMULATED_TEST", patientPosition: null,
    currentRecruitmentRadiusMeters: 1_000, recruitmentState: "RECRUITING",
    coordinationRevision: 1, createdAt: AT } as never;
}

/** A world with a lot of unrelated data, so narrowing would be visible. */
function crowdedWorld() {
  const state = emptyState();
  const near = uuid(100);
  state.devices[near] = device(near, uuid(200));
  for (let index = 0; index < 500; index += 1) {
    const id = `far-${index}`;
    state.devices[id] = device(id, `user-far-${index}`);
  }
  state.events[uuid(400)] = event(uuid(400), "ACTIVE");
  const mine = uuid(300);
  state.deliveries[mine] = { id: mine, eventId: uuid(400), deviceInstanceId: near,
    request: {}, status: "SENT", statusOccurredAt: AT } as never;
  for (let index = 0; index < 500; index += 1) {
    const id = `d-${index}`;
    state.deliveries[id] = { id, eventId: `other-${index}`, deviceInstanceId: near,
      request: {}, status: "SENT", statusOccurredAt: AT } as never;
  }
  return { state, near, eventId: uuid(400) };
}

test("candidateDevices still answers with the whole collection (not yet narrowed)", () => {
  const { state, eventId } = crowdedWorld();
  const ctx = draftRecruitmentContext(state);
  const candidates = ctx.candidateDevices(ctx.getEvent(eventId)!);
  assert.equal(candidates.length, Object.keys(state.devices).length,
    "commit 1 must not narrow the candidate set — the indexed adapter is commit 2");
  assert.ok(candidates.some(candidate => candidate.deviceInstanceId.startsWith("far-")),
    "distant devices must still be handed to the predicate, which is what filters them");
});

test("deliveriesOfEvent still filters the whole collection rather than using an index", () => {
  const { state, eventId, near } = crowdedWorld();
  const ctx = draftRecruitmentContext(state);
  const deliveries = ctx.deliveriesOfEvent(eventId);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.deviceInstanceId, near);
  // The unrelated 500 deliveries are still consulted and rejected, which is the
  // behaviour commit 1 must preserve.
  assert.equal(Object.keys(state.deliveries).length, 501);
});

test("hasActiveAssignmentForDevice answers the same question the inline scan did", () => {
  const { state, near } = crowdedWorld();
  const eventId = uuid(400);
  const ctx = draftRecruitmentContext(state);
  assert.equal(ctx.hasActiveAssignmentForDevice(state.devices[near]!), false,
    "no assignment yet");

  const assignmentId = uuid(500);
  state.assignments[assignmentId] = { id: assignmentId, deviceInstanceId: near,
    eventId, role: "GO_TO_PATIENT", status: "ASSIGNED", revision: 1, updatedAt: AT } as never;
  assert.equal(ctx.hasActiveAssignmentForDevice(state.devices[near]!), true,
    "a live assignment on an ACTIVE event counts");

  // Exited participation stops counting.
  (state.assignments[assignmentId] as { status: string }).status = "CANCELLED";
  assert.equal(ctx.hasActiveAssignmentForDevice(state.devices[near]!), false);

  // A non-ACTIVE event stops counting.
  (state.assignments[assignmentId] as { status: string }).status = "ASSIGNED";
  (state.events[eventId] as { state: string }).state = "RESOLVED";
  assert.equal(ctx.hasActiveAssignmentForDevice(state.devices[near]!), false);
});

test("hasActiveAssignmentForDevice matches on identity, not only on the device", () => {
  const state = emptyState();
  const holder = uuid(100);
  const twin = uuid(101);
  const userId = uuid(200);
  state.devices[holder] = device(holder, userId);
  state.devices[twin] = device(twin, userId);
  const eventId = uuid(400);
  state.events[eventId] = event(eventId, "ACTIVE");
  const assignmentId = uuid(500);
  state.assignments[assignmentId] = { id: assignmentId, deviceInstanceId: holder,
    eventId, role: "GO_TO_PATIENT", status: "ASSIGNED", revision: 1, updatedAt: AT } as never;

  const ctx = draftRecruitmentContext(state);
  assert.equal(deviceIdentityKey(state.devices[twin]!), deviceIdentityKey(state.devices[holder]!));
  assert.equal(ctx.hasActiveAssignmentForDevice(state.devices[twin]!), true,
    "a device sharing the holder's identity must also be considered busy");
});

test("the context writes through to the same state the algorithm used to mutate", () => {
  const { state, eventId, near } = crowdedWorld();
  const ctx = draftRecruitmentContext(state);

  ctx.updateEvent(eventId, draft => { (draft as { coordinationRevision: number }).coordinationRevision += 1; });
  assert.equal((state.events[eventId] as { coordinationRevision: number }).coordinationRevision, 2);

  const created = uuid(600);
  ctx.createDelivery({ id: created, eventId, deviceInstanceId: near,
    request: {}, status: "SENT", statusOccurredAt: AT } as never);
  assert.equal(state.deliveries[created]?.id, created);

  ctx.updateDelivery(created, draft => { (draft as { status: string }).status = "EXPIRED"; });
  assert.equal((state.deliveries[created] as { status: string }).status, "EXPIRED");

  ctx.appendTimeline(eventId, AT, "PASSIVE_OBSERVATION", "context write-through");
  assert.equal(state.timelineByEventId[eventId]?.length, 1);
});
