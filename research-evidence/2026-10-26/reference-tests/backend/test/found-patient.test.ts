/**
 * 通过用户发现患者 —— an additional way to start a case.
 *
 * The requirement for this trigger is deliberately narrow: it is ONE MORE WAY to
 * open an event, not a second product.  So the tests assert two things at once:
 *
 *   - it works end to end through the SAME machinery (ACTIVE/RECRUITING event,
 *     nearby responders recruited, the reporter becomes the patient-side position
 *     source, and the case can then be ended like any other);
 *   - it does not invent a fall.  The stored observation has no fall fields, and a
 *     projection must never report a `fallResolution` that nobody measured.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import type { Aed, PatientPosition } from "../src/contracts.js";
import { emptyState } from "../src/models.js";
import { MemoryStateStore } from "../src/store.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";

const BASE_TIME = "2026-09-14T08:00:00.000Z";
const PATIENT_POSITION: PatientPosition = {
  kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10
};
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (seconds: number): string =>
  new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();

const inventory: Aed[] = [{
  id: "found-aed", name: "Found AED",
  aedPosition: { kind: "A", latitude: 22.1991, longitude: 113.5439, accuracyMeters: 5 },
  openFrom: "00:00", openUntil: "00:00", floor: "1F", floorTransferSeconds: 0,
  accessNote: "lobby", accessDelaySeconds: 0, verificationSeconds: 0, available: true
}];

const config: BackendConfig = {
  host: "127.0.0.1", port: 0, dataFile: "unused-found-patient.json",
  fixtureFile: "unused-in-memory-fixture.json", sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 2_000, positionMaxAgeSeconds: 600, maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50, bootstrapLimitPerMinute: 100,
  operatorToken: "found-patient-operator", production: false
};

async function harness(): Promise<{
  service: AEDResponseService;
  store: MemoryStateStore;
  setNow(seconds: number): void;
}> {
  let now = new Date(BASE_TIME);
  const store = new MemoryStateStore(emptyState(inventory));
  const service = new AEDResponseService(store, config, {
    emitToDevices() { return []; }
  }, () => now);
  return {
    service, store,
    setNow(seconds: number) { now = new Date(at(seconds)); }
  };
}

async function bootstrap(
  service: AEDResponseService,
  deviceInstanceId: string,
  pairing: { companionPairId: string; availableForResponse?: boolean }
): Promise<DevicePrincipal> {
  const session = await service.bootstrap({
    deviceInstanceId,
    deviceKind: "IPHONE",
    companionPairId: pairing.companionPairId,
    agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
        kind, version: "2.0", acceptedAt: BASE_TIME
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: pairing.availableForResponse ?? true
  } as never, `synthetic:${deviceInstanceId}`);
  const principal = service.authenticateToken(session.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  return principal as DevicePrincipal;
}

test("a person can start a case by reporting the patient they found", async () => {
  const { service, store, setNow } = await harness();
  const passerby = await bootstrap(service, uuid(2), { companionPairId: uuid(1), availableForResponse: false });
  const responder = await bootstrap(service, uuid(4), { companionPairId: uuid(5) });
  await service.updateResponderPosition(responder, {
    positionUpdateId: uuid(6), observedAt: at(0),
    responderPosition: { kind: "R", latitude: 22.1990, longitude: 113.5439, accuracyMeters: 10 }
  });
  setNow(1);
  const eventId = uuid(500);
  const result = await service.reportFoundPatient(passerby, {
    eventId, observedAt: at(1), patientPosition: PATIENT_POSITION
  });
  assert.equal(result.created, true);
  assert.equal(result.event.id, eventId);

  const event = store.read(state => state.events[eventId]!);
  assert.equal(event.state, "ACTIVE");
  assert.equal(event.recruitmentState, "RECRUITING");
  assert.equal(event.triggerSource, "USER_REPORTED_PATIENT");
  // The reporter's phone is the patient-side position source, exactly as a patient's
  // phone would be; nothing else about the reporter is copied into the case.
  assert.deepEqual(event.patientDeviceIds, [passerby.deviceInstanceId]);
  assert.equal(event.patientUserId, passerby.userId);
  assert.equal(event.observation.observationKind, "USER_REPORTED_PATIENT");
  assert.equal("fallResolution" in event.observation, false,
    "the report must not claim a fall verdict nobody measured");
  assert.equal("fallDetectedAt" in event.observation, false);
  assert.equal(event.patientPosition?.source, "IPHONE_PRIMARY");
  assert.equal(event.patientPosition?.position.latitude, PATIENT_POSITION.latitude);

  // Recruitment is the existing machinery: the nearby standby responder is offered
  // the case without any new code path.
  const deliveries = store.read(state => Object.values(state.deliveries)
    .filter(row => row.eventId === eventId));
  assert.equal(deliveries.length, 1, "the nearby responder is recruited");
  assert.equal(deliveries[0]!.deviceInstanceId, responder.deviceInstanceId);

  // The reporter sees the case as the patient, and can publish the patient position.
  const view = service.getEvent(passerby, eventId);
  assert.equal(view.viewerRelationship, "PATIENT");
  assert.equal(view.triggerSource, "USER_REPORTED_PATIENT");
  await service.updatePatientPosition(passerby, eventId, {
    positionUpdateId: uuid(7), observedAt: at(2),
    patientPosition: { ...PATIENT_POSITION, latitude: 22.1990 }
  } as never);
  assert.equal(store.read(state => state.events[eventId]!.patientPosition!.position.latitude), 22.1990);

  // And the case ends through the existing path.
  setNow(3);
  const ended = await service.endEvent(passerby, eventId, {
    resolutionId: uuid(700), reason: "PROBLEM_RESOLVED", endedAt: at(3)
  });
  assert.equal(ended.state, "RESOLVED");
});

test("a replayed report returns the case it already opened, and a different event id opens another", async () => {
  const { service, store, setNow } = await harness();
  const passerby = await bootstrap(service, uuid(2), { companionPairId: uuid(1), availableForResponse: false });
  setNow(1);
  const eventId = uuid(501);
  const first = await service.reportFoundPatient(passerby, {
    eventId, observedAt: at(1), patientPosition: PATIENT_POSITION
  });
  // A lost acknowledgement must not open a second case for the same patient.
  const replay = await service.reportFoundPatient(passerby, {
    eventId, observedAt: at(1), patientPosition: PATIENT_POSITION
  });
  assert.equal(replay.created, false);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(store.read(state => Object.keys(state.events).length), 1);

  // A different person cannot hijack the same event id.
  const other = await bootstrap(service, uuid(8), { companionPairId: uuid(9), availableForResponse: false });
  await assert.rejects(
    service.reportFoundPatient(other, { eventId, observedAt: at(1), patientPosition: PATIENT_POSITION }),
    /already used by a different report/
  );
});

test("a device without current agreements cannot open a case, and the report is bounded", async () => {
  const { service, store, setNow } = await harness();
  // A device whose accepted agreement VERSIONS are stale is a real state (the app
  // ships a new policy version), and it must not be able to open a case.
  const stale = await bootstrap(service, uuid(3), { companionPairId: uuid(4), availableForResponse: false });
  await store.transact(state => {
    const device = state.devices[stale.deviceInstanceId]!;
    for (const record of Object.values(device.agreements)) {
      if (record) record.version = "1.0";
    }
  });
  setNow(1);
  await assert.rejects(
    service.reportFoundPatient(stale, {
      eventId: uuid(502), observedAt: at(1), patientPosition: PATIENT_POSITION
    }),
    /four current agreements/
  );
  // A position from the future is refused by the same clock boundary every other
  // write uses, so this trigger cannot become a way around it.
  const passerby = await bootstrap(service, uuid(5), { companionPairId: uuid(6), availableForResponse: false });
  await assert.rejects(
    service.reportFoundPatient(passerby, {
      eventId: uuid(503), observedAt: at(600), patientPosition: PATIENT_POSITION
    }),
    /clock-skew allowance/
  );
});
