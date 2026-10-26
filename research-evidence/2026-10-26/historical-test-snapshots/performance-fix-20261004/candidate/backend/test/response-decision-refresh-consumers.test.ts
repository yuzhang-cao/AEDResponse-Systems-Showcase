/**
 * Targeted DI tests for the post-refresh consumers.
 *
 * The caller audit fixed several places where a use case kept using the event object
 * it opened its transaction with, after `refreshRecruitmentForEvent` had already
 * written to that event and handed back its own view.  Those fixes are only worth
 * anything if the consumers are actually threaded to the returned value, and the
 * default test setup cannot show that: the real refresh mutates the object in place
 * under the legacy adapter, so a stale reference and a current one are the same
 * object and both tests pass.
 *
 * So the refresh dependency here deliberately returns a **detached copy** whose
 * `coordinationRevision` differs.  Ids are left exactly as they are: they are
 * immutable by contract, and changing one to make a test fail would be testing
 * something the adapter is not allowed to do.  The mutable revision is the honest
 * discriminator, and it is what a transaction-backed adapter will really differ by.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  runResponseDecision,
  type ResponseDecisionUseCaseDependencies
} from "../src/response-decision.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import type { StateStore } from "../src/store.js";
import type { DevicePrincipal } from "../src/identity-access.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const DELIVERY_ID = uuid(500);
const DEVICE_ID = uuid(100);
const USER_ID = uuid(200);
const REVISION_BUMP = 7;


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
    createdAt: AT
  } as never;
  state.deliveries[DELIVERY_ID] = {
    id: DELIVERY_ID,
    eventId: EVENT_ID,
    deviceInstanceId: DEVICE_ID,
    request: { occurredAt: AT, expiresAt: new Date(NOW.getTime() + 30_000).toISOString() },
    status: "SENT",
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

interface Captured {
  participantDeviceIds: EventRecord[];
  enqueueDecisionNotification: EventRecord[];
  enqueueAssignmentEmissions: EventRecord[];
  recruitmentUpdate: EventRecord[];
  detached: EventRecord | undefined;
  /** The revision of the event the refresh was handed, for relative assertions. */
  refreshInputRevision: number | undefined;
}

function dependencies(state: PersistentState): {
  deps: ResponseDecisionUseCaseDependencies;
  captured: Captured;
} {
  const captured: Captured = {
    participantDeviceIds: [],
    enqueueDecisionNotification: [],
    enqueueAssignmentEmissions: [],
    recruitmentUpdate: [],
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
    markDeviceSeen: () => {},
    ensureParticipantInterval: () => {},
    isEligibleNearbyResponder: () => true,
    participantDeviceIds: (_state: PersistentState, event: EventRecord) => {
      captured.participantDeviceIds.push(event);
      return [DEVICE_ID];
    },
    replanAssignments: () => [],
    refreshRecruitmentForEvent: (_state: PersistentState, event: EventRecord) => {
      // A detached copy with a different revision and unchanged ids - the shape a
      // transaction-backed adapter genuinely produces.
      captured.refreshInputRevision = event.coordinationRevision;
      const detached = { ...structuredClone(event),
        coordinationRevision: event.coordinationRevision + REVISION_BUMP } as EventRecord;
      captured.detached = detached;
      return { requests: [], previousAudience: [], expiredOffers: [], event: detached };
    },
    recruitmentUpdate: (_state: PersistentState, event: EventRecord) => {
      captured.recruitmentUpdate.push(event);
      return { coordination: {} } as never;
    },
    enqueueDecisionNotification: (_state: PersistentState, event: EventRecord) => {
      captured.enqueueDecisionNotification.push(event);
    },
    enqueueAssignmentEmissions: (_state: PersistentState, event: EventRecord) => {
      captured.enqueueAssignmentEmissions.push(event);
    }
  } as unknown as ResponseDecisionUseCaseDependencies;
  return { deps, captured };
}

test("the refresh really does return a detached object with a different revision", async () => {
  // Guard on the harness itself.  If the refresh returned the same object, or the
  // same revision, every assertion below would pass without proving anything.
  const state = world();
  const { deps, captured } = dependencies(state);
  await runResponseDecision(deps, principal, EVENT_ID, DELIVERY_ID,
    { decision: "ACCEPT", decidedAt: AT });

  const opened = state.events[EVENT_ID]!;
  assert.ok(captured.detached, "the refresh must have been called");
  assert.notEqual(captured.detached, opened, "the refresh returns a detached object");
  assert.notEqual(captured.detached.coordinationRevision, opened.coordinationRevision,
    "with a revision that differs from the one the transaction opened with");
  // Relative, not hardcoded: the use case bumps the revision itself before calling
  // the refresh, so pinning an absolute number here would test that increment rather
  // than the property under test.
  assert.equal(captured.detached.coordinationRevision,
    captured.refreshInputRevision! + REVISION_BUMP);
  assert.equal(captured.detached.id, opened.id, "and ids untouched: they are immutable");
  assert.equal(captured.detached.patientUserId, opened.patientUserId);
});

test("every post-refresh consumer receives the refreshed event, not the opened one", async () => {
  const state = world();
  const { deps, captured } = dependencies(state);
  await runResponseDecision(deps, principal, EVENT_ID, DELIVERY_ID,
    { decision: "ACCEPT", decidedAt: AT });

  const detached = captured.detached!;
  assert.equal(captured.participantDeviceIds.length, 1);
  assert.equal(captured.recruitmentUpdate.length, 1);
  assert.equal(captured.enqueueDecisionNotification.length, 1);

  for (const [name, events] of [
    ["participantDeviceIds", captured.participantDeviceIds],
    ["recruitmentUpdate", captured.recruitmentUpdate],
    ["enqueueDecisionNotification", captured.enqueueDecisionNotification]
  ] as const) {
    assert.equal(events[0], detached,
      `${name} must receive the object the refresh returned; a stale reference here `
      + "is invisible under the legacy adapter because it mutates in place");
    assert.equal(events[0]!.coordinationRevision, detached.coordinationRevision, name);
  }
});
