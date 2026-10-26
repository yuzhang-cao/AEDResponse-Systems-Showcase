/**
 * Two defects that only appear ACROSS events, i.e. after the first event's
 * records are retained history rather than the current situation.
 *
 *   R09  the position-reclamation exemption looked at one arbitrary ACCEPTED
 *        delivery, so a finished earlier event could mask an active later one
 *        and the responder's current R projection was reclaimed while they were
 *        still responding.
 *   R02  AED availability was computed per event, so a device another event had
 *        already handed to a responder could be assigned to a second responder
 *        in a different event — sending them to an empty cabinet.
 *
 * Both are exercised through the service and a real store; no private method is
 * called directly, so the entry points are the ones production uses.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import type { Aed, PatientPosition, ResponderPosition, WatchEmergencyObservation } from "../src/contracts.js";
import { emptyState, type DeviceRecord, type PersistentState } from "../src/models.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore, type StateStore } from "../src/store.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";
const PATIENT_POSITION: PatientPosition = {
  kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10
};
/** ~150 m south of the first patient. */
const SECOND_PATIENT_POSITION: PatientPosition = {
  kind: "P", latitude: 22.19735, longitude: 113.5439, accuracyMeters: 10
};

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function at(seconds: number): string {
  return new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();
}

function responderAt(meters: number, longitudeOffset = 0): ResponderPosition {
  return {
    kind: "R",
    latitude: PATIENT_POSITION.latitude + meters / 6_371_008.8 * 180 / Math.PI,
    longitude: PATIENT_POSITION.longitude + longitudeOffset,
    accuracyMeters: 10
  };
}

function inventory(count: number): Aed[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `synthetic-aed-${index}`,
    name: `Synthetic AED ${index}`,
    aedPosition: {
      kind: "A" as const,
      latitude: PATIENT_POSITION.latitude + 0.0004 + index * 0.0001,
      longitude: PATIENT_POSITION.longitude,
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
  companionPairId: string
): Promise<DevicePrincipal> {
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
    availableForResponse: true
  }, `synthetic-iphone:${deviceInstanceId}`);
  const principal = harness.service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Synthetic device principal required");
  return principal;
}

async function bootstrapWatch(
  harness: Harness,
  deviceInstanceId: string,
  companionPairId: string
): Promise<DevicePrincipal> {
  const result = await harness.service.bootstrap({
    deviceInstanceId,
    deviceKind: "WATCH",
    companionPairId
  }, `synthetic-watch:${deviceInstanceId}`);
  const principal = harness.service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Synthetic Watch principal required");
  return principal;
}

/** Patient phone + Watch pair for one household. */
async function patientPair(harness: Harness, phoneId: string, watchId: string) {
  const pairId = uuid(Number.parseInt(phoneId.slice(-4), 16));
  const phone = await bootstrapIPhone(harness, phoneId, pairId);
  const watch = await bootstrapWatch(harness, watchId, pairId);
  return { phone, watch };
}

async function raiseEvent(
  harness: Harness,
  watch: DevicePrincipal,
  eventId: string,
  patientPosition: PatientPosition,
  seconds: number
): Promise<void> {
  const observation: WatchEmergencyObservation = {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(seconds),
    patientPositionObservedAt: at(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition
  };
  await harness.service.reportWatchObservation(watch, eventId, observation);
}

async function placeResponder(
  harness: Harness,
  responder: DevicePrincipal,
  position: ResponderPosition,
  sequence: number,
  seconds: number
): Promise<void> {
  await harness.service.updateResponderPosition(responder, {
    positionUpdateId: uuid(sequence),
    observedAt: at(seconds),
    responderPosition: position
  });
}

function deliveryFor(store: StateStore, eventId: string, deviceInstanceId: string) {
  return store.read(state => Object.values(state.deliveries).find(delivery =>
    delivery.eventId === eventId && delivery.deviceInstanceId === deviceInstanceId));
}

function aedAssignments(store: StateStore, eventId: string) {
  return store.read(state => Object.values(state.assignments).filter(assignment =>
    assignment.eventId === eventId && assignment.role === "FETCH_AED"));
}

// ---------------------------------------------------------------------------
// R09 — historical ACCEPTED deliveries must not mask active participation
// ---------------------------------------------------------------------------

/** Device row with one stored sample, plus the events/deliveries/assignments. */
function participationWorld(activeEventState: "ACTIVE" | "RESOLVED"): PersistentState {
  const state = emptyState();
  const device = uuid(100);
  state.devices[device] = {
    deviceInstanceId: device,
    deviceKind: "IPHONE",
    userId: uuid(200),
    companionPairId: uuid(300),
    agreements: Object.fromEntries(["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind =>
        [kind, { version: "2.0", acceptedAt: at(0) }])),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: at(0),
    lastSeenAt: at(0),
    lastBootstrapAt: at(0),
    latestPosition: {
      positionUpdateId: uuid(260),
      observedAt: at(0),
      serverReceivedAt: at(0),
      position: { kind: "R", latitude: 22.199, longitude: 113.5439, accuracyMeters: 10 }
    }
  } as never;

  const seedEvent = (id: string, eventState: "ACTIVE" | "RESOLVED") => {
    state.events[id] = {
      id,
      state: eventState,
      recruitmentState: eventState === "ACTIVE" ? "COMPLETED" : "COMPLETED",
      patientUserId: uuid(210),
      patientDeviceIds: [uuid(211)],
      patientPairId: uuid(212),
      unavailableAedIds: [],
      observationFingerprint: `fingerprint-${id}`,
      triggerSource: "WATCH_FALL_HELP_CONFIRMED",
      observation: {
        schemaVersion: "2.0",
        eventId: id,
        observationKind: "FALL_CONTEXT",
        fallDetectedAt: at(0),
        patientPositionObservedAt: at(0),
        fallResolution: "UNRESPONSIVE",
        appHelpResponse: "NEEDS_HELP",
        patientPosition: { ...PATIENT_POSITION }
      },
      patientPosition: { positionUpdateId: uuid(213), source: "IPHONE_PRIMARY",
        observedAt: at(0), serverReceivedAt: at(0),
        position: { ...PATIENT_POSITION } },
      currentRecruitmentRadiusMeters: 1_000,
      recruitmentStageStartedAt: at(0),
      coordinationRevision: 1,
      assignmentRevision: 1,
      createdAt: at(0),
      ...(eventState === "RESOLVED" ? { resolvedAt: at(1) } : {})
    } as never;
  };
  seedEvent(uuid(400), "RESOLVED");
  seedEvent(uuid(401), activeEventState);

  // The finished event's delivery sorts FIRST, which is exactly what made the
  // old limit-1 lookup stop before reaching the live participation.
  const delivery = (id: string, eventId: string) => {
    state.deliveries[id] = {
      id,
      eventId,
      deviceInstanceId: device,
      status: "ACCEPTED",
      decision: "ACCEPT",
      statusOccurredAt: at(0),
      request: {
        schemaVersion: "2.0",
        messageId: `response-requested:${eventId}:${device}`,
        eventId,
        deliveryId: id,
        deliveryStatus: "SENT",
        occurredAt: at(0),
        eventType: "FALL_ASSISTANCE",
        positioningTier: "SEARCH_RING",
        distanceRange: "DISTANCE_500_1000M",
        etaRange: "ETA_5_10_MIN",
        currentRecruitmentRadiusMeters: 1_000,
        expiresAt: at(600)
      }
    } as never;
    state.assignments[uuid(Number.parseInt(id.slice(-4), 16) + 1)] = {
      id: uuid(Number.parseInt(id.slice(-4), 16) + 1),
      eventId,
      deviceInstanceId: device,
      role: "GO_TO_PATIENT",
      status: "EN_ROUTE",
      revision: 1,
      createdAt: at(0),
      updatedAt: at(0)
    } as never;
  };
  delivery(uuid(500), uuid(400));
  delivery(uuid(501), uuid(401));
  return state;
}

async function presenceHarness(state: PersistentState) {
  const store = new MemoryStateStore(state);
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
  let now = new Date(at(0));
  const service = new AEDResponseService(store, config, {
    emitToDevices() { return []; }
  }, () => now);
  const principal: DevicePrincipal = {
    kind: "DEVICE",
    deviceKind: "IPHONE",
    deviceInstanceId: uuid(100),
    companionPairId: uuid(300),
    userId: uuid(200),
    tokenHash: "cross-event-test-token",
    sessionId: uuid(350),
    scopes: ["events:read", "position:write"],
    expiresAt: at(3_600)
  };
  return {
    service,
    store,
    principal,
    /** Past the 10-minute retention window of the stored R sample. */
    expirePosition() { now = new Date(at(1_200)); }
  };
}

test("R09: an active responder keeps its position when an older event's ACCEPTED delivery sorts first", async () => {
  const harness = await presenceHarness(participationWorld("ACTIVE"));
  harness.expirePosition();

  // `getPresence` is the reclamation entry point; the sample is 20 minutes old
  // and would be deleted unless the exemption recognises the ACTIVE event.
  const presence = await harness.service.getPresence(harness.principal);
  assert.equal(presence.position !== null, true,
    "the R sample must survive reclamation: the responder is still participating");
  assert.equal(harness.store.read(state => state.devices[uuid(100)]?.latestPosition !== undefined),
    true,
    "and the committed state must still carry it");
});

test("R09 control: a responder with no live participation does have its old position reclaimed", async () => {
  const harness = await presenceHarness(participationWorld("RESOLVED"));
  harness.expirePosition();

  await harness.service.getPresence(harness.principal);
  assert.equal(harness.store.read(state => state.devices[uuid(100)]?.latestPosition),
    undefined,
    "with both events finished there is no exemption, so the expired sample is reclaimed");
});

// ---------------------------------------------------------------------------
// R02 — one physical AED belongs to one event at a time
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R02 — one physical AED belongs to one event at a time
// ---------------------------------------------------------------------------

/**
 * One emergency is raised through the real Watch entry point; responders accept
 * in call order until the event has taken an AED, leaving that claim committed
 * while a second, independent emergency recruits.
 */
async function twoEventsSharingOneAed(
  aedCount: number,
  secondEventResponderCount: number
) {
  const harness = makeHarness(aedCount);
  const first = await patientPair(harness, uuid(2_001), uuid(2_002));
  const second = await patientPair(harness, uuid(2_003), uuid(2_004));
  const responders = [
    await bootstrapIPhone(harness, uuid(2_101), uuid(2_201)),
    await bootstrapIPhone(harness, uuid(2_102), uuid(2_202)),
    await bootstrapIPhone(harness, uuid(2_103), uuid(2_203)),
    await bootstrapIPhone(harness, uuid(2_104), uuid(2_204)),
    await bootstrapIPhone(harness, uuid(2_105), uuid(2_205))
  ];
  for (const [index, responder] of responders.entries()) {
    await placeResponder(harness, responder, responderAt(140 + index * 10), 2_300 + index, 0);
  }

  harness.setNow(1);
  await raiseEvent(harness, first.watch, uuid(2_400), PATIENT_POSITION, 1);
  // Two acceptances plan one AED role and one patient role on the first event.
  for (const [index, responder] of responders.slice(0, 2).entries()) {
    const delivery = deliveryFor(harness.store, uuid(2_400), responder.deviceInstanceId);
    assert.ok(delivery, "the first event must offer to a nearby responder");
    harness.setNow(2 + index);
    await harness.service.respond(responder, uuid(2_400), delivery.id, {
      decision: "ACCEPT", decidedAt: at(2 + index)
    });
  }
  const firstAed = aedAssignments(harness.store, uuid(2_400));
  assert.equal(firstAed.length, 1, "the first event must take an AED");
  const heldAedId = firstAed[0]!.route!.aedId;

  // A second, independent emergency starts while that AED is being carried.
  harness.setNow(6);
  await raiseEvent(harness, second.watch, uuid(2_401), SECOND_PATIENT_POSITION, 6);
  // `planAssignments` gives floor(N/3 + 0.5) AED roles, so the number of
  // acceptances decides whether the second event wants an AED at all.
  for (const [index, responder] of responders.slice(2, 2 + secondEventResponderCount).entries()) {
    const delivery = deliveryFor(harness.store, uuid(2_401), responder.deviceInstanceId);
    assert.ok(delivery, "the second event must offer to the remaining responders");
    harness.setNow(7 + index);
    await harness.service.respond(responder, uuid(2_401), delivery.id, {
      decision: "ACCEPT", decidedAt: at(7 + index)
    });
  }
  return { harness, first, second, responders, firstEventId: uuid(2_400), secondEventId: uuid(2_401), heldAedId };
}

test("R02: a new event never assigns an AED that another event already holds", async () => {
  // Two acceptances on the second event produce exactly one AED role for it,
  // which must go unfilled because the only device is already being carried.
  const { harness, secondEventId, heldAedId } = await twoEventsSharingOneAed(1, 2);
  const assignments = harness.store.read(state => Object.values(state.assignments)
    .filter(assignment => assignment.eventId === secondEventId));
  assert.equal(assignments.filter(assignment => assignment.role === "FETCH_AED").length, 0,
    `the only AED (${heldAedId}) is already carried by the first event and must not be reassigned`);
  assert.equal(assignments.filter(assignment => assignment.role === "GO_TO_PATIENT").length, 2,
    "both second-event responders go straight to the patient instead");
  assert.equal(aedAssignments(harness.store, secondEventId).length, 0);
  assert.ok(harness.store.read(state => state.timelineByEventId[secondEventId]?.some(entry =>
    entry.kind === "PASSIVE_OBSERVATION"
      && entry.message.includes("AED resource shortfall"))),
  "the unfillable AED role is recorded rather than silently ignored");
  assert.equal(harness.store.read(state => Object.values(state.assignments)
    .filter(assignment => assignment.eventId === secondEventId
      && assignment.route?.aedId === heldAedId).length), 0,
  "the held AED must appear in no second-event assignment");
});

test("R02 control: a second AED still lets both events each hold one", async () => {
  // Four acceptances on the second event produce one AED role for it.
  const { harness, secondEventId } = await twoEventsSharingOneAed(2, 4);
  const secondAed = aedAssignments(harness.store, secondEventId);
  assert.equal(secondAed.length, 1,
    "with a free device in inventory the second event must still plan its AED role");
  assert.equal(aedAssignments(harness.store, uuid(2_400)).length, 1);
  const held = harness.store.read(state => Object.values(state.assignments)
    .filter(assignment => assignment.role === "FETCH_AED" && assignment.route)
    .map(assignment => assignment.route!.aedId));
  assert.equal(new Set(held).size, held.length,
    "no two assignments may name the same physical device");
});


test("G06: actual acquisition and holder exit keep an AED unavailable until a verified return", async () => {
  const { harness: h, responders, second, firstEventId, secondEventId, heldAedId } = await twoEventsSharingOneAed(1, 2);
  const assignment = aedAssignments(h.store, firstEventId)[0]!;
  const holder = responders.find(row => row.deviceInstanceId === assignment.deviceInstanceId)!;
  h.setNow(9); await h.service.updateAssignmentStatus(holder, firstEventId, assignment.id, "EN_ROUTE", at(9));
  h.setNow(10); await h.service.updateAssignmentStatus(holder, firstEventId, assignment.id, "ARRIVED_AT_AED", at(10));
  h.setNow(11); await h.service.acquireAed(holder, firstEventId, assignment.id, {
    receiptId: uuid(2600), eventId: firstEventId, assignmentId: assignment.id, aedId: heldAedId, acquiredAt: at(11)
  });
  assert.equal(h.store.read(s => s.aedAssetsById[heldAedId]!.status), "IN_USE");
  h.setNow(12); await h.service.exitEvent(holder, firstEventId, { exitId: uuid(2601), exitedAt: at(12), soleResponderConfirmed: true });
  assert.equal(h.store.read(s => s.aedAssetsById[heldAedId]!.status), "AWAITING_RETURN");
  h.setNow(13); await h.service.updatePatientPosition(second.phone, secondEventId, {
    positionUpdateId: uuid(2602), observedAt: at(13), patientPosition: SECOND_PATIENT_POSITION
  });
  assert.equal(aedAssignments(h.store, secondEventId).length, 0);
  const asset = h.store.read(s => s.aedAssetsById[heldAedId]!);
  h.setNow(14);
  const action = { requestId: uuid(2603), action: "CONFIRM_RETURN" as const, expectedRevision: asset.revision,
    reason: "synthetic controlled physical-return confirmation", physicallyConfirmedAt: at(14), registration: {
      aed: inventory(1)[0]!, source: "synthetic fixture", permission: "test-only synthetic data", maintenanceOwner: "test operator",
      verifiedAt: at(14), validUntil: at(86400)
    } };
  await assert.rejects(h.service.updateAedAsset(holder, heldAedId, action), /operator credential/);
  await h.service.updateAedAsset({ kind: "OPERATOR" }, heldAedId, action);
  await h.service.updateAedAsset({ kind: "OPERATOR" }, heldAedId, action); // A repeated return cannot advance revision twice.
  assert.equal(h.store.read(s => s.aedAssetsById[heldAedId]!.revision), asset.revision + 1);
  h.setNow(15); await h.service.updatePatientPosition(second.phone, secondEventId, {
    positionUpdateId: uuid(2604), observedAt: at(15), patientPosition: SECOND_PATIENT_POSITION
  });
  const nextOffer = deliveryFor(h.store, secondEventId, responders[4]!.deviceInstanceId)!;
  h.setNow(16); await h.service.respond(responders[4]!, secondEventId, nextOffer.id, { decision: "ACCEPT", decidedAt: at(16) });
  assert.equal(aedAssignments(h.store, secondEventId).length, 1);
  assert.equal(aedAssignments(h.store, secondEventId)[0]!.route!.aedId, heldAedId);
});

test("patient withdrawal has its own terminal fact and permits later account logout", async () => {
  const h = makeHarness(0); const patient = await patientPair(h, uuid(2701), uuid(2702)); const eventId = uuid(2703);
  h.setNow(1); await raiseEvent(h, patient.watch, eventId, PATIENT_POSITION, 1);
  h.setNow(2);
  await assert.rejects(h.service.endEvent(patient.phone, eventId, { resolutionId: uuid(2704), reason: "ASSISTANCE_WITHDRAWN", endedAt: at(2) }), /confirmation flow/);
  assert.equal(h.store.read(s => s.events[eventId]!.state), "ACTIVE");
  const command = { resolutionId: uuid(2704), reason: "ASSISTANCE_WITHDRAWN" as const, endedAt: at(2), withdrawalConfirmed: true as const };
  await h.service.endEvent(patient.phone, eventId, command);
  await h.service.endEvent(patient.phone, eventId, command);
  assert.equal(h.store.read(s => s.events[eventId]!.state), "CANCELLED_ASSISTANCE_WITHDRAWN");
  assert.equal(h.store.read(s => s.events[eventId]!.terminalReason), "ASSISTANCE_WITHDRAWN");
  assert.ok(h.store.read(s => Object.values(s.notificationOutboxById).some(row => row.name === "event:assistance-withdrawn")));
  await h.service.logout(patient.phone);
  assert.equal(h.store.read(s => s.devices[patient.phone.deviceInstanceId]!.loginState), "SIGNED_OUT");
  assert.ok(h.store.read(s => s.timelineByEventId[eventId]?.length));
});
