/**
 * Targeted DI test for the responder-exit post-refresh consumer.
 *
 * `enqueueParticipantExitNotification` is called after `refreshRecruitmentForEvent`
 * has already written to the event and handed back its own view.  The fix threads the
 * returned event there, and this test is what makes that fix observable.
 *
 * The refresh dependency returns a **detached copy** with a bumped
 * `coordinationRevision`; ids are untouched, because they are immutable by contract
 * and an adapter that changed one would be doing something it is not allowed to do.
 * The mutable revision is the honest discriminator.
 *
 * Without this test the fix is untestable: under the legacy adapter the refresh
 * mutates the event in place, so a stale reference and a current one are literally
 * the same object and every assertion passes either way.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  runResponderExit,
  type ResponderExitUseCaseDependencies
} from "../src/responder-exit.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import type { StateStore } from "../src/store.js";
import type { DevicePrincipal } from "../src/identity-access.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const DEVICE_ID = uuid(100);
const USER_ID = uuid(200);
const EXIT_ID = uuid(700);
const REVISION_BUMP = 11;

function world(): PersistentState {
  const state = emptyState();
  state.devices[DEVICE_ID] = {
    deviceInstanceId: DEVICE_ID,
    deviceKind: "IPHONE",
    userId: USER_ID,
    companionPairId: uuid(9_000),
    agreements: {},
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: AT,
    lastSeenAt: AT,
    lastBootstrapAt: AT
  } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    recruitmentState: "RECRUITING",
    patientUserId: uuid(301),
    patientDeviceIds: [uuid(300)],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT", fallDetectedAt: AT },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: null,
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentStageStartedAt: AT,
    coordinationRevision: 1,
    assignmentRevision: 1,
    createdAt: AT
  } as never;
  state.deliveries[uuid(500)] = {
    id: uuid(500),
    eventId: EVENT_ID,
    deviceInstanceId: DEVICE_ID,
    request: { occurredAt: AT },
    status: "ACCEPTED",
    decision: "ACCEPT",
    statusOccurredAt: AT
  } as never;
  return state;
}

const principal = {
  kind: "DEVICE",
  deviceInstanceId: DEVICE_ID,
  userId: USER_ID,
  accountId: uuid(600)
} as unknown as DevicePrincipal;

function dependencies(state: PersistentState) {
  const captured: {
    enqueueParticipantExitNotification: EventRecord[];
    enqueueAssignmentEmissions: EventRecord[];
    detached: EventRecord | undefined;
    refreshInputRevision: number | undefined;
  } = {
    enqueueParticipantExitNotification: [],
    enqueueAssignmentEmissions: [],
    detached: undefined,
    refreshInputRevision: undefined
  };

  const deps = {
    store: {
      transact: async <T,>(mutate: (draft: PersistentState) => T): Promise<T> => mutate(state)
    } as unknown as StateStore,
    now: () => NOW,
    validateActionTime: (value: string) => value,
    effectiveActionTime: (claimedAt: string) => claimedAt,
    // Two accepted devices, so the sole-responder confirmation guard is not in play.
    acceptedDeviceIds: () => [DEVICE_ID, uuid(101)],
    participantIntervalForDevice: () => ({ eventId: EVENT_ID, userId: USER_ID }),
    endParticipantInterval: () => {},
    hasCurrentPatientPosition: () => false,
    coordinationAudienceDeviceIds: () => [DEVICE_ID],
    replanAssignments: () => [],
    refreshRecruitmentForEvent: (_s: PersistentState, event: EventRecord) => {
      captured.refreshInputRevision = event.coordinationRevision;
      const detached = { ...structuredClone(event),
        coordinationRevision: event.coordinationRevision + REVISION_BUMP } as EventRecord;
      captured.detached = detached;
      return { requests: [], previousAudience: [], expiredOffers: [], event: detached };
    },
    recruitmentUpdate: () => ({ coordination: { revision: 0 } }) as never,
    enqueueAssignmentEmissions: (_s: PersistentState, event: EventRecord) => {
      captured.enqueueAssignmentEmissions.push(event);
    },
    enqueueParticipantExitNotification: (_s: PersistentState, event: EventRecord) => {
      captured.enqueueParticipantExitNotification.push(event);
    },
    recruitmentTargetAccepted: 3
  } as unknown as ResponderExitUseCaseDependencies;

  return { deps, captured };
}

test("the exit refresh returns a detached object with a different revision", async () => {
  const state = world();
  const { deps, captured } = dependencies(state);
  await runResponderExit(deps, principal, EVENT_ID,
    { exitId: EXIT_ID, exitedAt: AT, soleResponderConfirmed: true });

  const opened = state.events[EVENT_ID]!;
  assert.ok(captured.detached, "the refresh must have been called");
  assert.notEqual(captured.detached, opened, "detached, not the opened object");
  assert.equal(captured.detached.coordinationRevision,
    captured.refreshInputRevision! + REVISION_BUMP,
    "with a revision the opened object does not have");
  assert.equal(captured.detached.id, opened.id, "ids untouched: they are immutable");
  assert.equal(captured.detached.patientUserId, opened.patientUserId);
});

test("the exit notification receives the refreshed event, not the opened one", async () => {
  const state = world();
  const { deps, captured } = dependencies(state);
  const result = await runResponderExit(deps, principal, EVENT_ID,
    { exitId: EXIT_ID, exitedAt: AT, soleResponderConfirmed: true });

  assert.equal(result.ack.exitId, EXIT_ID, "the exit itself succeeded");
  const detached = captured.detached!;
  assert.equal(captured.enqueueParticipantExitNotification.length, 1);
  assert.equal(captured.enqueueParticipantExitNotification[0], detached,
    "enqueueParticipantExitNotification must receive the object the refresh "
    + "returned; a stale reference is invisible under the legacy adapter because it "
    + "mutates in place");
  assert.equal(captured.enqueueParticipantExitNotification[0]!.coordinationRevision,
    captured.refreshInputRevision! + REVISION_BUMP);
});
