/**
 * Behaviour locks for the coordination audience, plus the permanent regression
 * test for the committed-vs-draft accident.
 *
 * `coordinationAudienceDeviceIds` is simple — patient-side viewers plus accepted
 * responders — but it is the composition every adapter must reproduce identically,
 * and it is where the draft/committed distinction has real consequences.  These
 * tests pin the four things that must not drift, and then pin the failure mode
 * itself so the reason for the two named factories stays executable rather than
 * living only in a comment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDraftContext,
  committedRecruitmentContext,
  draftRecruitmentContext,
  type DraftRecruitmentContext
} from "../src/recruitment-context.js";
import {
  coordinationAudienceDeviceIds,
  patientViewerDeviceIds
} from "../src/service.js";
import { emptyState, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const AT = "2026-08-31T01:02:00.000Z";
const EVENT_ID = uuid(400);

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

function acceptedDelivery(id: string, deviceInstanceId: string) {
  return {
    id,
    eventId: EVENT_ID,
    deviceInstanceId,
    request: {},
    status: "ACCEPTED",
    decision: "ACCEPT",
    statusOccurredAt: AT
  } as never;
}

/**
 * One event, one patient iPhone, and a responder that has accepted.
 *
 * `observation.observationKind` is not a simulation, so `permitsSimulationDevice`
 * admits every device and the audience is decided purely by ownership.
 */
function world() {
  const state = emptyState();
  const patientDevice = uuid(100);
  const patientUser = uuid(200);
  const responderDevice = uuid(101);
  const responderUser = uuid(201);
  state.devices[patientDevice] = device(patientDevice, patientUser);
  state.devices[responderDevice] = device(responderDevice, responderUser);
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: patientUser,
    patientDeviceIds: [patientDevice],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT" },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: null,
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentState: "RECRUITING",
    coordinationRevision: 1,
    createdAt: AT
  } as never;
  return { state, patientDevice, patientUser, responderDevice, responderUser };
}

test("lock 1: with no accepted responder the audience is patient-side only", () => {
  const { state, patientDevice, responderDevice } = world();
  const event = state.events[EVENT_ID]!;
  const ctx = draftRecruitmentContext(state);

  assert.deepEqual(patientViewerDeviceIds(ctx, event), [patientDevice]);
  assert.deepEqual(coordinationAudienceDeviceIds(ctx, event), [patientDevice],
    "a device that was merely offered to must not be in the coordination audience");
  assert.ok(!coordinationAudienceDeviceIds(ctx, event).includes(responderDevice));
});

test("lock 2: an accepted responder joins the audience, patient first", () => {
  const { state, patientDevice, responderDevice } = world();
  state.deliveries[uuid(500)] = acceptedDelivery(uuid(500), responderDevice);
  const ctx = draftRecruitmentContext(state);

  assert.deepEqual(coordinationAudienceDeviceIds(ctx, state.events[EVENT_ID]!),
    [patientDevice, responderDevice],
    "order matters: the audience is patient-side viewers first, then responders");
});

test("lock 3: two devices of one identity contribute a single audience entry", () => {
  const { state, patientDevice, responderDevice, responderUser } = world();
  // A second iPhone bound to the same user, lexicographically smaller so that a
  // dedup that kept the wrong survivor would be visible in the output order.
  const twin = uuid(99);
  state.devices[twin] = device(twin, responderUser);
  const low = uuid(500);
  const high = uuid(501);
  state.deliveries[low] = acceptedDelivery(low, responderDevice);
  state.deliveries[high] = acceptedDelivery(high, twin);

  const audience = coordinationAudienceDeviceIds(draftRecruitmentContext(state),
    state.events[EVENT_ID]!);
  assert.deepEqual(audience, [patientDevice, twin],
    "acceptedDeviceIds sorts before deduping, so the lexicographically smallest "
    + "device survives; the composition must not change that");
  assert.equal(audience.length, new Set(audience).size, "no duplicates");
});

test("lock 4: a draft context sees an acceptance written in the same transaction", () => {
  const { state, patientDevice, responderDevice } = world();
  const ctx = draftRecruitmentContext(state);
  const event = state.events[EVENT_ID]!;

  assert.deepEqual(coordinationAudienceDeviceIds(ctx, event), [patientDevice]);

  // The write the ACCEPT transaction performs, observed through the same context.
  state.deliveries[uuid(500)] = acceptedDelivery(uuid(500), responderDevice);

  assert.deepEqual(coordinationAudienceDeviceIds(ctx, event),
    [patientDevice, responderDevice],
    "recruitment must read its own writes; this is the value of the draft mode");
  assert.deepEqual(coordinationAudienceDeviceIds(draftRecruitmentContext(state), event),
    [patientDevice, responderDevice],
    "and a freshly built draft context over the same state agrees");
});

test("the accident: a committed context cannot see an in-transaction acceptance", () => {
  const { state, patientDevice, responderDevice } = world();
  const event = state.events[EVENT_ID]!;

  // The acceptance this transaction just wrote.
  state.deliveries[uuid(500)] = acceptedDelivery(uuid(500), responderDevice);

  // Exactly the shape that broke ACCEPT: the index still reflects only committed
  // state, so the delivery created in this transaction is invisible.
  const stale = committedRecruitmentContext(state, { deliveriesOfEvent: () => [] });

  assert.deepEqual(coordinationAudienceDeviceIds(stale, event), [patientDevice],
    "documents the silent failure: the accepted responder is missing entirely");
  assert.ok(!coordinationAudienceDeviceIds(stale, event).includes(responderDevice));

  // Whereas a committed context over a genuinely committed index is correct, so the
  // modes differ in what they may read, not in what the code looks like.
  const current = committedRecruitmentContext(state, { deliveriesOfEvent: eventId =>
    Object.values(state.deliveries).filter(delivery => delivery.eventId === eventId) });
  assert.deepEqual(coordinationAudienceDeviceIds(current, event),
    [patientDevice, responderDevice]);
});

test("assertDraftContext rejects committed semantics and accepts draft", () => {
  const { state } = world();
  const committed = committedRecruitmentContext(state, { deliveriesOfEvent: () => [] });
  const draft = draftRecruitmentContext(state);

  assert.throws(() => assertDraftContext(committed, "refreshRecruitmentForEvent"),
    /requires a draft-semantics recruitment context but received mode="committed"/);
  assert.equal(assertDraftContext(draft, "refreshRecruitmentForEvent").mode, "draft");
  // A Phase 2 transaction context is draft-compatible: it carries its own delta.
  assert.equal(
    assertDraftContext({ ...draft, mode: "transaction" }, "refreshRecruitmentForEvent").mode,
    "transaction");
});

test("the mode is carried on the value, not implied by the factory name", () => {
  const { state } = world();
  assert.equal(draftRecruitmentContext(state).mode, "draft");
  assert.equal(
    committedRecruitmentContext(state, { deliveriesOfEvent: () => [] }).mode,
    "committed");
});

test("a committed context cannot satisfy the draft type (compile-time lock)", () => {
  const { state } = world();
  const committed = committedRecruitmentContext(state, { deliveriesOfEvent: () => [] });

  // The assertion below is the point of the whole exercise: it must NOT compile.
  // `npm run check` fails with "unused '@ts-expect-error' directive" if the brand
  // is ever weakened — for instance by widening DraftRecruitmentContext back to
  // RecruitmentContext, or by dropping the `mode` field.  That turns "remember not
  // to use the committed context in a transaction" into a build failure.
  // @ts-expect-error a committed context is not draft-compatible
  const misuse: DraftRecruitmentContext = committed;
  assert.equal(misuse.mode, "committed", "reached only if the directive was unused");

  // A transaction context is accepted where draft semantics are required, because
  // it carries its own staged delta.
  const transaction: DraftRecruitmentContext = { ...draftRecruitmentContext(state),
    mode: "transaction" } as unknown as DraftRecruitmentContext;
  assert.equal(transaction.mode, "transaction");
});
