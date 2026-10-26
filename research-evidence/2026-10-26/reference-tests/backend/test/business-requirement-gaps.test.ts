import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import {
  participantExitRequestSchema,
  type Aed,
  type PatientPosition,
  type ResponderPosition
} from "../src/contracts.js";
import { HttpProblem } from "../src/errors.js";
import { emptyState } from "../src/models.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";

// These assertions express the frozen requirements, including known failures.
// Only the in-process service, memory store and deterministic clock are used.
const BASE_TIME = "2026-09-05T00:00:00.000Z";
const patientPosition: PatientPosition = {
  kind: "P",
  latitude: 0,
  longitude: 0,
  accuracyMeters: 10
};
const responderPosition: ResponderPosition = {
  kind: "R",
  latitude: 0.001,
  longitude: 0,
  accuracyMeters: 10
};

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function at(seconds: number): string {
  return new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();
}

function inventory(count: number): Aed[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `synthetic-aed-${index}`,
    name: `Synthetic AED ${index}`,
    aedPosition: {
      kind: "A" as const,
      latitude: 0.0005 + index * 0.0001,
      longitude: 0,
      accuracyMeters: 5
    },
    openFrom: "00:00",
    openUntil: "00:00",
    floor: "1F",
    floorTransferSeconds: 0,
    accessNote: "Synthetic unrestricted access",
    accessDelaySeconds: 0,
    verificationSeconds: 0,
    available: true
  }));
}

function makeHarness(aedCount: number) {
  let now = new Date(BASE_TIME);
  const store = new MemoryStateStore(emptyState(inventory(aedCount)));
  const config: BackendConfig = {
    host: "127.0.0.1",
    port: 0,
    dataFile: "unused-memory-store.json",
    fixtureFile: "unused-in-memory-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    production: false
  };
  const service = new AEDResponseService(store, config, {
    emitToDevices() { return []; }
  }, () => now);
  return {
    service,
    store,
    setNow(seconds: number) { now = new Date(at(seconds)); }
  };
}

type Harness = ReturnType<typeof makeHarness>;

async function bootstrapIPhone(
  harness: Harness,
  deviceInstanceId: string,
  companionPairId: string,
  availableForResponse = true
): Promise<DevicePrincipal> {
  // This legacy in-process fixture supplies synthetic identities; it does not
  // call the phone/Apple authentication providers or any session HTTP route.
  const result = await harness.service.bootstrap({
    deviceInstanceId,
    deviceKind: "IPHONE",
    companionPairId,
    agreementAcceptances: [
      { kind: "PATIENT", version: "2.0", acceptedAt: BASE_TIME },
      { kind: "VOLUNTEER_RESPONDER", version: "2.0", acceptedAt: BASE_TIME },
      { kind: "PRIVACY_POLICY", version: "2.0", acceptedAt: BASE_TIME },
      { kind: "SENSITIVE_PERSONAL_INFORMATION", version: "2.0", acceptedAt: BASE_TIME }
    ],
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse
  }, `synthetic-iphone:${deviceInstanceId}`);
  const principal = harness.service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Synthetic device principal required");
  return principal;
}

async function seedScenario(aedCount: number, responderCount: number) {
  const harness = makeHarness(aedCount);
  const pairId = uuid(100);
  const patient = await bootstrapIPhone(harness, uuid(101), pairId);
  const watchSession = await harness.service.bootstrap({
    deviceInstanceId: uuid(102),
    deviceKind: "WATCH",
    companionPairId: pairId
  }, "synthetic-watch");
  const watch = harness.service.authenticateToken(watchSession.sessionToken);
  const responders: DevicePrincipal[] = [];
  for (let index = 0; index < responderCount; index += 1) {
    const responder = await bootstrapIPhone(harness, uuid(200 + index), uuid(300 + index));
    await harness.service.updateResponderPosition(responder, {
      positionUpdateId: uuid(400 + index),
      responderPosition: {
        ...responderPosition,
        latitude: responderPosition.latitude + index * 0.00005
      },
      observedAt: BASE_TIME
    });
    responders.push(responder);
  }
  const eventId = uuid(500);
  harness.setNow(1);
  await harness.service.reportWatchObservation(watch, eventId, {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1),
    patientPositionObservedAt: at(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition
  });
  return { ...harness, patient, responders, eventId };
}

type Scenario = Awaited<ReturnType<typeof seedScenario>>;

test("sampling tier remains geographic after refused or expired offers and is recomputed on replay", async () => {
  const expiredScenario = await seedScenario(0, 1);
  expiredScenario.setNow(180);
  assert.equal(
    (await expiredScenario.service.getPresence(expiredScenario.responders[0]!)).positioningTier,
    "SEARCH_RING", "An expired offer does not remove a user from the active geographic search circle"
  );
  const scenario = await seedScenario(0, 1);
  const responder = scenario.responders[0]!;
  scenario.setNow(2);
  const request = {
    positionUpdateId: uuid(900), responderPosition, observedAt: at(2)
  };
  const first = await scenario.service.updateResponderPosition(responder, request);
  assert.equal(first.positioningTier, "SEARCH_RING");
  const delivery = scenario.store.read((state) => Object.values(state.deliveries).find(
    (item) => item.eventId === scenario.eventId && item.deviceInstanceId === responder.deviceInstanceId
  ));
  assert.ok(delivery);
  scenario.setNow(3);
  await scenario.service.respond(responder, scenario.eventId, delivery.id, {
    decision: "REFUSE", decidedAt: at(3)
  });
  assert.equal((await scenario.service.getPresence(responder)).positioningTier, "SEARCH_RING");
  scenario.setNow(180);
  assert.equal((await scenario.service.getPresence(responder)).positioningTier, "SEARCH_RING");
  const outside = await scenario.service.updateResponderPosition(responder, {
    positionUpdateId: uuid(901), responderPosition: { ...responderPosition, latitude: 0.1 },
    observedAt: at(180)
  });
  assert.equal(outside.positioningTier, "STANDBY");
  const replay = await scenario.service.updateResponderPosition(responder, request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.positioningTier, "STANDBY", "An old receipt must not resurrect old sampling metadata");
});

async function acceptAll(scenario: Scenario) {
  for (const [index, responder] of scenario.responders.entries()) {
    const delivery = scenario.store.read((state) => Object.values(state.deliveries).find(
      (item) => item.eventId === scenario.eventId && item.deviceInstanceId === responder.deviceInstanceId
    ));
    assert.ok(delivery, "Synthetic nearby responder must first have a live offer");
    scenario.setNow(10 + index);
    await assert.doesNotReject(
      scenario.service.respond(responder, scenario.eventId, delivery.id, {
        decision: "ACCEPT",
        decidedAt: at(10 + index)
      }),
      `V2-A09: responder ${index + 1} must remain accepted when AED inventory cannot satisfy round(N/3)`
    );
  }
}

function coordination(scenario: Scenario) {
  const event = scenario.service.getEvent(scenario.patient, scenario.eventId);
  assert.ok("coordination" in event, "The synthetic patient must see aggregate coordination");
  return event.coordination;
}

function activeAssignments(scenario: Scenario) {
  return scenario.store.read((state) => Object.values(state.assignments).filter(
    (assignment) => assignment.eventId === scenario.eventId
      && assignment.status !== "CANCELLED" && assignment.status !== "TIMED_OUT"
  ));
}

test("V2-A09 control: five accepted responders use two distinct AEDs and three patient tasks", async () => {
  const scenario = await seedScenario(2, 5);
  await acceptAll(scenario);
  const summary = coordination(scenario);
  assert.equal(summary.acceptedResponderCount, 5);
  assert.equal(summary.goToPatientCount, 3);
  assert.equal(summary.fetchAedCount, 2);
  const aedAssignments = activeAssignments(scenario).filter((item) => item.role === "FETCH_AED");
  assert.equal(new Set(aedAssignments.map((item) => item.route?.aedId)).size, 2);
  for (const assignment of aedAssignments) {
    assert.deepEqual(assignment.route?.path.map((position) => position.kind), ["R", "A", "P"]);
  }
});

test("V2-A09: no available AED must still accept two responders and send both to the patient", async () => {
  const scenario = await seedScenario(0, 2);
  await acceptAll(scenario);
  const summary = coordination(scenario);
  assert.equal(summary.acceptedResponderCount, 2);
  assert.equal(summary.goToPatientCount, 2);
  assert.equal(summary.fetchAedCount, 0);
});

test("V2-A09: one available AED at N=5 must yield one AED task and four patient tasks", async () => {
  const scenario = await seedScenario(1, 5);
  await acceptAll(scenario);
  const summary = coordination(scenario);
  assert.equal(summary.acceptedResponderCount, 5);
  assert.equal(summary.goToPatientCount, 4);
  assert.equal(summary.fetchAedCount, 1);
  assert.equal(activeAssignments(scenario).filter((item) => item.role === "FETCH_AED").length, 1);
  assert.ok(scenario.store.read((state) => state.timelineByEventId[scenario.eventId]
    ?.some((entry) => entry.kind === "PASSIVE_OBSERVATION"
      && entry.message.includes("AED resource shortfall"))));
});

test("V2-A08/A11: an unstarted AED responder exiting N=3 must refill the AED role at N=2", async () => {
  const scenario = await seedScenario(2, 3);
  await acceptAll(scenario);
  const aedAssignment = activeAssignments(scenario).find((item) => item.role === "FETCH_AED");
  assert.ok(aedAssignment);
  assert.equal(aedAssignment.status, "ASSIGNED");
  const exiting = scenario.responders.find((item) => item.deviceInstanceId === aedAssignment.deviceInstanceId);
  assert.ok(exiting);
  scenario.setNow(20);
  await scenario.service.exitEvent(exiting, scenario.eventId, {
    exitId: uuid(600),
    exitedAt: at(20),
    reason: "Synthetic responder exit before starting the AED task"
  });
  const summary = coordination(scenario);
  assert.equal(summary.acceptedResponderCount, 2);
  assert.deepEqual(
    { patient: summary.goToPatientCount, aed: summary.fetchAedCount },
    { patient: 1, aed: 1 },
    "V2-A08/A11: N changed to 2 with all remaining tasks flexible; a role deficit must be filled"
  );
});

test("V2-A11: an unconfirmed sole-responder exit is rejected without transaction mutation", async () => {
  const scenario = await seedScenario(1, 1);
  await acceptAll(scenario);
  await scenario.service.flushNotificationPushes();
  const responder = scenario.responders[0]!;
  const before = scenario.store.read((state) => JSON.stringify(state));

  scenario.setNow(20);
  await assert.rejects(
    scenario.service.exitEvent(responder, scenario.eventId, {
      exitId: uuid(610),
      exitedAt: at(20),
      reason: "synthetic unconfirmed exit"
    }),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 409
      && error.title === "Sole responder confirmation required"
      && error.detail === "你是当前任务唯一一名响应者，确定要退出吗。"
      && error.type === "https://aedresponse.invalid/problems/sole-responder-confirmation-required"
  );
  assert.equal(scenario.store.read((state) => JSON.stringify(state)), before);
  assert.equal(coordination(scenario).acceptedResponderCount, 1);
  assert.equal(activeAssignments(scenario).length, 1);
});

test("V2-A11: a verified sole-responder exit is idempotent and the assertion is fingerprinted", async () => {
  const scenario = await seedScenario(1, 1);
  await acceptAll(scenario);
  const responder = scenario.responders[0]!;
  const request = {
    exitId: uuid(620),
    exitedAt: at(20),
    reason: "synthetic confirmed exit",
    soleResponderConfirmed: true as const
  };

  scenario.setNow(20);
  assert.equal((await scenario.service.exitEvent(responder, scenario.eventId, request)).idempotent, false);
  assert.equal((await scenario.service.exitEvent(responder, scenario.eventId, request)).idempotent, true);
  await assert.rejects(
    scenario.service.exitEvent(responder, scenario.eventId, {
      ...request,
      soleResponderConfirmed: undefined,
      exitId: request.exitId
    }),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 409
      && error.detail.includes("exitId was already used with different content")
  );
  const state = scenario.store.read((value) => value);
  assert.equal(state.events[scenario.eventId]?.state, "ACTIVE");
  assert.equal(state.events[scenario.eventId]?.recruitmentState, "RECRUITING");
  assert.equal(state.events[scenario.eventId]?.exitedResponderUserIds?.length, 1);
  assert.equal(Object.values(state.participantExitsById).length, 1);
});

test("V2-A11: serialized N=2 to N=1 exits require confirmation only for the second transaction", async () => {
  const scenario = await seedScenario(2, 2);
  await acceptAll(scenario);
  const [first, second] = scenario.responders;
  assert.ok(first);
  assert.ok(second);
  scenario.setNow(20);
  const results = await Promise.allSettled([
    scenario.service.exitEvent(first, scenario.eventId, {
      exitId: uuid(630),
      exitedAt: at(20),
      reason: "first concurrent exit"
    }),
    scenario.service.exitEvent(second, scenario.eventId, {
      exitId: uuid(631),
      exitedAt: at(20),
      reason: "second concurrent exit"
    })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof HttpProblem);
  assert.equal((rejected as PromiseRejectedResult).reason.status, 409);
  assert.equal((rejected as PromiseRejectedResult).reason.title, "Sole responder confirmation required");
  assert.equal(coordination(scenario).acceptedResponderCount, 1);
  assert.equal(Object.values(scenario.store.read((state) => state.participantExitsById)).length, 1);
});

test("V2-A11: N=0 with no patient P remains ACTIVE and does not invoke a P-dependent replan", async () => {
  const scenario = await seedScenario(0, 1);
  await acceptAll(scenario);
  await scenario.store.transact((state) => {
    const event = state.events[scenario.eventId];
    assert.ok(event);
    delete event.patientPosition;
    delete event.iphonePatientPosition;
    delete event.watchFallbackPosition;
    event.observation.patientPosition = null;
    if (event.observation.observationKind === "FALL_CONTEXT") {
      delete event.observation.patientPositionObservedAt;
    }
    event.observation.locationUnavailableReason = "synthetic no P";
    event.recruitmentState = "COMPLETED";
  });

  scenario.setNow(20);
  await assert.doesNotReject(scenario.service.exitEvent(scenario.responders[0]!, scenario.eventId, {
    exitId: uuid(640),
    exitedAt: at(20),
    reason: "no P safety exit",
    soleResponderConfirmed: true
  }));
  const event = scenario.store.read((state) => state.events[scenario.eventId]);
  assert.equal(event?.state, "ACTIVE");
  assert.equal(event?.recruitmentState, "RECRUITING");
  assert.equal(scenario.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === scenario.eventId
      && assignment.status !== "CANCELLED" && assignment.status !== "TIMED_OUT").length), 0);
});

test("V2-A11: reopening recruitment after N=0 can issue a fresh offer without ending the event", async () => {
  const scenario = await seedScenario(0, 1);
  await acceptAll(scenario);
  const replacement = await bootstrapIPhone(scenario, uuid(670), uuid(671), false);
  scenario.setNow(2);
  await scenario.service.updateResponderPosition(replacement, {
    positionUpdateId: uuid(672),
    responderPosition,
    observedAt: at(2)
  });
  assert.equal(scenario.store.read((state) => Object.values(state.deliveries).some((delivery) =>
    delivery.eventId === scenario.eventId && delivery.deviceInstanceId === replacement.deviceInstanceId)), false);
  await scenario.store.transact((state) => {
    state.events[scenario.eventId]!.recruitmentState = "COMPLETED";
  });
  scenario.setNow(20);
  await scenario.service.exitEvent(scenario.responders[0]!, scenario.eventId, {
    exitId: uuid(673),
    exitedAt: at(20),
    reason: "last responder exit",
    soleResponderConfirmed: true
  });
  assert.equal(scenario.store.read((state) => state.events[scenario.eventId]?.state), "ACTIVE");
  assert.equal(scenario.store.read((state) => state.events[scenario.eventId]?.recruitmentState), "RECRUITING");

  scenario.setNow(21);
  await scenario.service.updatePresence(replacement, {
    presenceUpdateId: uuid(674),
    occurredAt: at(21),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  assert.ok(scenario.store.read((state) => Object.values(state.deliveries).find((delivery) =>
    delivery.eventId === scenario.eventId && delivery.deviceInstanceId === replacement.deviceInstanceId)));
});

test("V2-A11: a completed recruitment phase reopens and immediately replenishes below the target", async () => {
  const scenario = await seedScenario(0, 1);
  await acceptAll(scenario);
  await scenario.store.transact((state) => {
    state.events[scenario.eventId]!.recruitmentState = "COMPLETED";
  });
  const replacement = await bootstrapIPhone(scenario, uuid(675), uuid(676));
  scenario.setNow(2);
  await scenario.service.updateResponderPosition(replacement, {
    positionUpdateId: uuid(677),
    responderPosition,
    observedAt: at(2)
  });
  scenario.setNow(20);
  await scenario.service.exitEvent(scenario.responders[0]!, scenario.eventId, {
    exitId: uuid(678),
    exitedAt: at(20),
    reason: "completed phase recovery",
    soleResponderConfirmed: true
  });
  const state = scenario.store.read((value) => value);
  assert.equal(state.events[scenario.eventId]?.state, "ACTIVE");
  assert.equal(state.events[scenario.eventId]?.recruitmentState, "RECRUITING");
  assert.ok(Object.values(state.deliveries).some((delivery) =>
    delivery.eventId === scenario.eventId
      && delivery.deviceInstanceId === replacement.deviceInstanceId
      && delivery.status === "SENT"));
});

test("V2-A11: exit-triggered replan timestamps changed assignments at receipt time, not a slow client claim", async () => {
  const scenario = await seedScenario(2, 3);
  await acceptAll(scenario);
  const aedAssignment = activeAssignments(scenario).find((assignment) => assignment.role === "FETCH_AED");
  assert.ok(aedAssignment);
  const exiting = scenario.responders.find((responder) => responder.deviceInstanceId === aedAssignment.deviceInstanceId);
  assert.ok(exiting);
  const before = scenario.store.read((state) => Object.fromEntries(
    Object.values(state.assignments)
      .filter((assignment) => assignment.eventId === scenario.eventId)
      .map((assignment) => [assignment.id, { revision: assignment.revision, updatedAt: assignment.updatedAt }])
  ));
  scenario.setNow(20);
  await scenario.service.exitEvent(exiting, scenario.eventId, {
    exitId: uuid(680),
    exitedAt: at(3),
    reason: "slow client clock exit"
  });
  const changed = scenario.store.read((state) => Object.values(state.assignments).filter((assignment) => {
    const previous = before[assignment.id];
    return assignment.eventId === scenario.eventId
      && previous !== undefined
      && assignment.revision > previous.revision
      && assignment.status !== "CANCELLED";
  }));
  assert.ok(changed.length > 0, "exit should replan at least one unstarted role");
  assert.ok(changed.every((assignment) => assignment.updatedAt === at(20)));
});

test("V2-A11 contract: soleResponderConfirmed accepts only true or omission", () => {
  const base = { exitId: uuid(690), exitedAt: BASE_TIME };
  assert.doesNotThrow(() => participantExitRequestSchema.parse(base));
  assert.doesNotThrow(() => participantExitRequestSchema.parse({ ...base, soleResponderConfirmed: true }));
  assert.throws(() => participantExitRequestSchema.parse({ ...base, soleResponderConfirmed: false }));
  assert.throws(() => participantExitRequestSchema.parse({ ...base, soleResponderConfirmed: 2 }));
});

test("V2-A08/A11: exit replan preserves an acquired AED assignment and never reuses its AED", async () => {
  const scenario = await seedScenario(2, 3);
  await acceptAll(scenario);
  const assignments = activeAssignments(scenario);
  const aedAssignment = assignments.find((assignment) => assignment.role === "FETCH_AED");
  assert.ok(aedAssignment?.route);
  const aedOwner = scenario.responders.find((responder) =>
    responder.deviceInstanceId === aedAssignment.deviceInstanceId);
  assert.ok(aedOwner);
  scenario.setNow(20);
  await scenario.service.updateAssignmentStatus(
    aedOwner,
    scenario.eventId,
    aedAssignment.id,
    "EN_ROUTE",
    at(20)
  );
  scenario.setNow(21);
  await scenario.service.updateAssignmentStatus(
    aedOwner,
    scenario.eventId,
    aedAssignment.id,
    "ARRIVED_AT_AED",
    at(21)
  );
  const receipt = {
    receiptId: uuid(650),
    eventId: scenario.eventId,
    assignmentId: aedAssignment.id,
    aedId: aedAssignment.route.aedId,
    acquiredAt: at(22)
  };
  scenario.setNow(22);
  await scenario.service.acquireAed(aedOwner, scenario.eventId, aedAssignment.id, receipt);
  const exiting = scenario.responders.find((responder) => responder.deviceInstanceId !== aedOwner.deviceInstanceId);
  assert.ok(exiting);
  scenario.setNow(23);
  await scenario.service.exitEvent(exiting, scenario.eventId, {
    exitId: uuid(651),
    exitedAt: at(23),
    reason: "unstarted responder exit"
  });

  const after = scenario.store.read((state) => ({
    acquired: state.assignments[aedAssignment.id],
    current: Object.values(state.assignments).filter((assignment) => assignment.eventId === scenario.eventId
      && assignment.status !== "CANCELLED" && assignment.status !== "TIMED_OUT"),
    exitedAedRoutes: Object.values(state.assignments).filter((assignment) => assignment.eventId === scenario.eventId
      && assignment.status === "CANCELLED" && assignment.deviceInstanceId === exiting.deviceInstanceId)
      .map((assignment) => assignment.route?.aedId)
  }));
  assert.equal(after.acquired?.status, "AED_ACQUIRED");
  assert.deepEqual(after.acquired?.aedAcquiredReceipt, receipt);
  assert.equal(after.current.filter((assignment) => assignment.role === "FETCH_AED").length, 1);
  assert.equal(after.current.find((assignment) => assignment.role === "FETCH_AED")?.route?.aedId, receipt.aedId);
  assert.equal(new Set(after.current
    .filter((assignment) => assignment.role === "FETCH_AED")
    .map((assignment) => assignment.route?.aedId)).size, 1);
});

test("V2-A08/A11: an exiting AED owner leaves a handoff gap and the acquired AED stays reserved", async () => {
  const scenario = await seedScenario(2, 3);
  await acceptAll(scenario);
  const acquiredAssignment = activeAssignments(scenario).find((assignment) => assignment.role === "FETCH_AED");
  assert.ok(acquiredAssignment?.route);
  const owner = scenario.responders.find((responder) =>
    responder.deviceInstanceId === acquiredAssignment.deviceInstanceId);
  assert.ok(owner);
  scenario.setNow(20);
  await scenario.service.updateAssignmentStatus(owner, scenario.eventId, acquiredAssignment.id, "EN_ROUTE", at(20));
  scenario.setNow(21);
  await scenario.service.updateAssignmentStatus(owner, scenario.eventId, acquiredAssignment.id, "ARRIVED_AT_AED", at(21));
  scenario.setNow(22);
  const receipt = {
    receiptId: uuid(652),
    eventId: scenario.eventId,
    assignmentId: acquiredAssignment.id,
    aedId: acquiredAssignment.route.aedId,
    acquiredAt: at(22)
  };
  await scenario.service.acquireAed(owner, scenario.eventId, acquiredAssignment.id, receipt);
  scenario.setNow(23);
  await scenario.service.exitEvent(owner, scenario.eventId, {
    exitId: uuid(653),
    exitedAt: at(23),
    reason: "AED owner exit"
  });
  const snapshot = scenario.store.read((state) => ({
    oldAssignment: state.assignments[acquiredAssignment.id],
    activeAedIds: Object.values(state.assignments)
      .filter((assignment) => assignment.eventId === scenario.eventId
        && assignment.status !== "CANCELLED" && assignment.status !== "TIMED_OUT"
        && assignment.role === "FETCH_AED")
      .map((assignment) => assignment.route?.aedId),
    hasHandoffGap: state.timelineByEventId[scenario.eventId]?.some((entry) =>
      entry.message.includes("handoff remains pending"))
  }));
  assert.equal(snapshot.oldAssignment?.status, "CANCELLED");
  assert.deepEqual(snapshot.oldAssignment?.aedAcquiredReceipt, receipt);
  assert.ok(snapshot.hasHandoffGap);
  assert.ok(snapshot.activeAedIds.every((aedId) => aedId !== receipt.aedId));
});

test("V2-A08/A11: exit replacement ranks the complete local R-A-P distance, not only R-A distance", async () => {
  const scenario = await seedScenario(2, 3);
  await scenario.store.transact((state) => {
    state.aeds = [
      {
        id: "aed-near-responder",
        name: "Near responder but far from patient",
        aedPosition: { kind: "A", latitude: 0.0012, longitude: 0, accuracyMeters: 5 },
        openFrom: "00:00",
        openUntil: "00:00",
        floor: "1F",
        floorTransferSeconds: 0,
        accessNote: "Synthetic",
        accessDelaySeconds: 0,
        verificationSeconds: 0,
        available: true
      },
      {
        id: "aed-near-patient",
        name: "Farther from responder but near patient",
        aedPosition: { kind: "A", latitude: 0.0001, longitude: 0, accuracyMeters: 5 },
        openFrom: "00:00",
        openUntil: "00:00",
        floor: "3F",
        floorTransferSeconds: 2,
        accessNote: "Synthetic",
        accessDelaySeconds: 3,
        verificationSeconds: 4,
        available: true
      }
    ];
  });
  await acceptAll(scenario);
  const aedAssignment = activeAssignments(scenario).find((assignment) => assignment.role === "FETCH_AED");
  assert.ok(aedAssignment);
  const exiting = scenario.responders.find((responder) => responder.deviceInstanceId === aedAssignment.deviceInstanceId);
  assert.ok(exiting);
  scenario.setNow(20);
  await scenario.service.exitEvent(exiting, scenario.eventId, {
    exitId: uuid(660),
    exitedAt: at(20),
    reason: "force complete-route replan"
  });
  const remainingAed = scenario.store.read((state) => Object.values(state.assignments).find(
    (assignment) => assignment.eventId === scenario.eventId
      && assignment.role === "FETCH_AED"
      && assignment.status !== "CANCELLED"
      && assignment.status !== "TIMED_OUT"
  ));
  assert.equal(remainingAed?.route?.aedId, "aed-near-patient");
  assert.deepEqual(remainingAed?.route?.path.map((position) => position.kind), ["R", "A", "P"]);
  assert.ok((remainingAed?.route?.distanceMeters ?? 0) > 0);
});
