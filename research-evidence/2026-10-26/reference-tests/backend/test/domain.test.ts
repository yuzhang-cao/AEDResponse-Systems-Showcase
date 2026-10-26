import { AmapAedRouteProvider } from "../src/amap-route-provider.js";
import type { AedRouteProvider } from "../src/route-provider.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendConfig } from "../src/config.js";
import type {
  Aed,
  EventPositionBatch,
  ResponderPosition,
  WatchFallbackPositionUpdate,
  WatchEmergencyObservation
} from "../src/contracts.js";
import {
  eventPositionBatchSchema,
  uuidSchema
} from "../src/contracts.js";
import {
  assignmentTransitionAllowed,
  distanceMeters,
  fingerprint,
  makeAedRoute,
  planAssignments
} from "../src/domain.js";
import { HttpProblem } from "../src/errors.js";
import {
  emptyState,
  type CoordinationSummary,
  type EmergencyEventView,
  type PatientEmergencyEventView,
  type ResponderEmergencyEventView
} from "../src/models.js";
import {
  AEDResponseService,
  type DevicePrincipal,
  type RealtimeEventName,
  type RealtimePublisher
} from "../src/service.js";
import { MemoryStateStore, SQLiteStateStore, type StateStore } from "../src/store.js";

const BASE_TIME = "2026-08-31T01:02:00.000Z";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function atOffset(seconds: number): string {
  return new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();
}

const patientPosition = {
  kind: "P" as const,
  latitude: 22.1987,
  longitude: 113.5439,
  accuracyMeters: 12
};

const nearbyResponderPosition = {
  kind: "R" as const,
  latitude: 22.198,
  longitude: 113.543,
  accuracyMeters: 10
};

test("event position batches enforce unique UTC-second slots and strict FIX/gap shapes", () => {
  const eventId = uuid(980);
  const batchId = uuid(981);
  const validFix = {
    recordId: uuid(982),
    slotAt: atOffset(0),
    status: "FIX" as const,
    fixObservedAt: new Date(Date.parse(atOffset(0)) + 500).toISOString(),
    position: patientPosition
  };
  const validGap = {
    recordId: uuid(983),
    slotAt: atOffset(1),
    status: "NO_NEW_FIX" as const,
    gapReason: "NO_FIX" as const
  };
  const parse = (records: unknown[]) => eventPositionBatchSchema.parse({
    schemaVersion: "2.0",
    eventId,
    batchId,
    records
  });

  assert.equal(parse([validFix, validGap]).records[0]?.slotAt, atOffset(0));
  assert.equal(parse([{
    ...validFix,
    recordId: uuid(984),
    slotAt: atOffset(0).replace(".000Z", "Z"),
    fixObservedAt: new Date(Date.parse(atOffset(0)) + 999).toISOString()
  }]).records[0]?.slotAt, atOffset(0));
  assert.throws(() => parse([{
    ...validGap,
    recordId: uuid(985),
    slotAt: new Date(Date.parse(atOffset(2)) + 1).toISOString()
  }]));
  assert.throws(() => parse([{
    ...validGap,
    recordId: uuid(986),
    slotAt: "2026-02-30T01:02:00.000Z"
  }]));
  assert.throws(() => parse([validFix, {
    ...validGap,
    recordId: uuid(987),
    slotAt: atOffset(0)
  }]));
  assert.throws(() => parse([{ ...validFix, recordId: uuid(988), fixObservedAt: atOffset(1) }]));
  assert.throws(() => parse([{ ...validFix, recordId: uuid(989), gapReason: "NO_FIX" }]));
  assert.throws(() => parse([{ ...validGap, recordId: uuid(990), position: patientPosition }]));
  assert.throws(() => parse([{ ...validGap, recordId: uuid(991), fixObservedAt: atOffset(1) }]));
  assert.throws(() => parse(Array.from({ length: 6 }, (_, index) => ({
    ...validGap,
    recordId: uuid(992 + index),
    slotAt: atOffset(index + 2)
  }))));
});

const aeds: Aed[] = [
  {
    id: "aed-near",
    name: "Near AED",
    aedPosition: {
      kind: "A",
      latitude: 22.199,
      longitude: 113.544,
      accuracyMeters: 5
    },
    openFrom: "00:00",
    openUntil: "00:00",
    floor: "2F",
    floorTransferSeconds: 45,
    accessNote: "front desk",
    accessDelaySeconds: 60,
    verificationSeconds: 30,
    available: true
  },
  {
    id: "aed-backup",
    name: "Backup AED",
    aedPosition: {
      kind: "A",
      latitude: 22.201,
      longitude: 113.547,
      accuracyMeters: 8
    },
    openFrom: "00:00",
    openUntil: "00:00",
    floor: "1F",
    floorTransferSeconds: 0,
    accessNote: "lobby",
    accessDelaySeconds: 20,
    verificationSeconds: 10,
    available: true
  }
];

interface Emission {
  deviceIds: string[];
  name: RealtimeEventName;
  payload: unknown;
}

interface Harness {
  config: BackendConfig;
  service: AEDResponseService;
  store: StateStore;
  emissions: Emission[];
  setNow(value: string): void;
}

function makeHarness(configOverrides: Partial<BackendConfig> = {}, store: StateStore = new MemoryStateStore(emptyState(aeds)), routeProvider?: AedRouteProvider): Harness {
  let currentTime = new Date(BASE_TIME);
  const emissions: Emission[] = [];
  const publisher: RealtimePublisher = {
    emitToDevices(deviceIds, name, payload) {
      emissions.push({ deviceIds: [...deviceIds], name, payload });
      return deviceIds;
    }
  };
  const config: BackendConfig = {
    host: "127.0.0.1",
    port: 0,
    dataFile: "/tmp/aedresponse-domain-test.json",
    fixtureFile: "/tmp/aedresponse-domain-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    operatorToken: "operator-test-token",
    production: false,
    ...configOverrides
  };
  return {
    config,
    service: new AEDResponseService(store, config, publisher, () => currentTime, {}, routeProvider),
    store,
    emissions,
    setNow(value) {
      currentTime = new Date(value);
    }
  };
}

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
  }, `iphone:${deviceInstanceId}`);
  const principal = harness.service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  return principal as DevicePrincipal;
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
  }, `watch:${deviceInstanceId}`);
  const principal = harness.service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  return principal as DevicePrincipal;
}

let positionUpdateSequence = 10_000;
async function publishResponderPosition(
  harness: Harness,
  principal: DevicePrincipal,
  responderPosition: ResponderPosition,
  observedAt: string
) {
  positionUpdateSequence += 1;
  return harness.service.updateResponderPosition(principal, {
    positionUpdateId: uuid(positionUpdateSequence),
    responderPosition,
    observedAt
  });
}

function observation(
  eventId: string,
  appHelpResponse: "NEEDS_HELP" | "NO_RESPONSE" = "NEEDS_HELP"
): WatchEmergencyObservation {
  return {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: atOffset(1),
    patientPositionObservedAt: atOffset(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse,
    ...(appHelpResponse === "NO_RESPONSE" ? {
      callFirstObservedAt: atOffset(2),
      callObservationSemantics: "FIRST_OBSERVED_OUTGOING_STATE" as const
    } : {}),
    patientPosition
  };
}

test("Watch history survives receipt cache limits across events and SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-watch-history-limit-"));
  const path = join(directory, "state.sqlite");
  let durable: SQLiteStateStore | undefined;
  try {
    durable = await SQLiteStateStore.open(path, aeds);
    const harness = makeHarness({}, durable);
    const { patient, watch, eventId } = await seedScenario(0, harness);
    const eventIds = [eventId, uuid(42_001)];
    const firstId = uuid(42_100);
    const facts: WatchFallbackPositionUpdate[] = [];
    for (const [eventIndex, id] of eventIds.entries()) {
      const start = eventIndex * 1_000;
      if (eventIndex > 0) {
        harness.setNow(atOffset(start));
        await harness.service.reportWatchObservation(watch, id, { ...observation(id),
          fallDetectedAt: atOffset(start + 1), patientPositionObservedAt: atOffset(start) });
      }
      harness.setNow(atOffset(start + 400));
      await harness.service.endEvent(patient, id, {
        resolutionId: uuid(42_010 + eventIndex), reason: "PROBLEM_RESOLVED", endedAt: atOffset(start + 400)
      });
      for (let index = 0; index < 70; index += 1) {
        const sample = { schemaVersion: "2.0" as const, eventId: id,
          positionUpdateId: uuid(42_100 + eventIndex * 100 + index),
          observedAt: atOffset(start + 5 + index * 5), patientPosition,
          activationState: "NOT_ACTIVATED" as const, iphoneReachable: false, networkAvailable: true };
        harness.setNow(atOffset(start + 500 + index));
        await harness.service.updateWatchFallbackPatientPosition(watch, id, sample.positionUpdateId, sample);
        facts.push(sample);
      }
    }
    for (let index = 0; index < 70; index += 1) {
      harness.setNow(atOffset(1_600 + index));
      await publishResponderPosition(harness, patient, nearbyResponderPosition, atOffset(1_600 + index));
    }
    const records = durable.read(state => Object.values(state.positionUpdateReceiptsById));
    assert.equal(records.filter(row => row.watchFallbackFact).length, 140);
    assert.equal(records.filter(row => row.deviceInstanceId === patient.deviceInstanceId).length, 64);
    await durable.close();
    durable = await SQLiteStateStore.open(path, []);
    const restarted = makeHarness({}, durable);
    restarted.setNow(atOffset(2_000));
    assert.deepEqual(durable.read(state => facts.map(fact => state.positionUpdateReceiptsById[fact.positionUpdateId]?.watchFallbackFact)), facts);
    assert.equal((await restarted.service.updateWatchFallbackPatientPosition(watch, eventId, firstId, facts[0]!)).idempotent, true);
  } finally {
    await durable?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Watch history rejects corrupt or reversed authoritative event windows", async () => {
  for (const invalid of [
    { createdAt: atOffset(0), resolvedAt: "invalid-end-time" },
    { createdAt: "invalid-start-time", resolvedAt: atOffset(20) },
    { createdAt: atOffset(40), resolvedAt: atOffset(20) }
  ]) {
    const { harness, patient, watch, eventId } = await seedScenario(0);
    harness.setNow(atOffset(20));
    await harness.service.endEvent(patient, eventId, {
      resolutionId: uuid(42_500), reason: "PROBLEM_RESOLVED", endedAt: atOffset(20)
    });
    await harness.store.transact(state => Object.assign(state.events[eventId]!, invalid));
    harness.setNow(atOffset(30));
    const sample = { schemaVersion: "2.0" as const, eventId, positionUpdateId: uuid(42_501),
      observedAt: atOffset(10), patientPosition, activationState: "NOT_ACTIVATED" as const,
      iphoneReachable: false, networkAvailable: true };
    await assert.rejects(harness.service.updateWatchFallbackPatientPosition(watch, eventId, sample.positionUpdateId, sample),
      assertHttpProblem(409, /active time window/));
    assert.equal(harness.store.read(state => state.positionUpdateReceiptsById[sample.positionUpdateId]), undefined);
  }
});

test("a rebound Watch cannot replay or append facts for the previous patient identity", async () => {
  const { harness, watch, responders, eventId } = await seedScenario(1);
  const other = responders[0]!;
  assert.ok(other.userId && other.accountId);
  const rebound: DevicePrincipal = { ...watch, userId: other.userId, accountId: other.accountId };
  await harness.store.transact(state => {
    const device = state.devices[watch.deviceInstanceId]!;
    device.userId = other.userId!;
    device.accountId = other.accountId!;
  });
  await assert.rejects(harness.service.reportWatchObservation(rebound, eventId, observation(eventId)),
    assertHttpProblem(403, /Watch that triggered/));
  await assert.rejects(harness.service.updateWatchFallbackPatientPosition(rebound, eventId, uuid(41_030), {
    schemaVersion: "2.0", eventId, positionUpdateId: uuid(41_030), observedAt: atOffset(10),
    patientPosition, activationState: "NOT_ACTIVATED", iphoneReachable: false, networkAvailable: true
  }), assertHttpProblem(403, /Watch that triggered/));
  assert.throws(() => harness.service.getWatchEventState(rebound, eventId), assertHttpProblem(403));
});

test("terminal Watch fallback accepts immutable in-window history without reviving current state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-watch-history-"));
  const path = join(directory, "state.sqlite");
  let durable: SQLiteStateStore | undefined;
  try {
  durable = await SQLiteStateStore.open(path, aeds);
  const { harness, patient, watch, eventId } = await seedScenario(0, makeHarness({}, durable));
  harness.setNow(atOffset(20));
  await harness.service.endEvent(patient, eventId, {
    resolutionId: uuid(41_001), reason: "PROBLEM_RESOLVED", endedAt: atOffset(20)
  });
  const terminal = harness.store.read(state => state.events[eventId]);
  const update = {
    schemaVersion: "2.0" as const, eventId, positionUpdateId: uuid(41_002),
    observedAt: atOffset(10), patientPosition, activationState: "NOT_ACTIVATED" as const,
    iphoneReachable: false, networkAvailable: true
  };
  harness.setNow(atOffset(3_600));
  const ack = await harness.service.updateWatchFallbackPatientPosition(watch, eventId, update.positionUpdateId, update);
  assert.equal(ack.applied, false);
  assert.equal(ack.positionObservedAt, atOffset(10));
  assert.equal(ack.serverReceivedAt, atOffset(3_600));
  assert.deepEqual(harness.store.read(state => state.events[eventId]), terminal);
  const record = harness.store.read(state => state.positionUpdateReceiptsById[update.positionUpdateId]);
  assert.deepEqual(record?.watchFallbackFact, update);
  assert.equal((await harness.service.updateWatchFallbackPatientPosition(watch, eventId, update.positionUpdateId, update)).idempotent, true);
  await assert.rejects(harness.service.updateWatchFallbackPatientPosition(watch, eventId, update.positionUpdateId,
    { ...update, observedAt: atOffset(11) }), assertHttpProblem(409, /different content/));
  for (const [index, seconds] of [-1, 20, 21].entries()) {
    const outside = { ...update, positionUpdateId: uuid(41_010 + index), observedAt: atOffset(seconds) };
    await assert.rejects(harness.service.updateWatchFallbackPatientPosition(watch, eventId, outside.positionUpdateId, outside),
      assertHttpProblem(409, /active time window/));
  }
  await assert.rejects(harness.store.transact(state => {
    state.positionUpdateReceiptsById[update.positionUpdateId]!.watchFallbackFact!.observedAt = atOffset(11);
  }));
  await assert.rejects(harness.store.transact(state => {
    delete state.positionUpdateReceiptsById[update.positionUpdateId];
  }), /immutable and cannot be deleted/);
  assert.deepEqual(harness.store.read(state => state.positionUpdateReceiptsById[update.positionUpdateId]), record);
  await durable.close();
  durable = await SQLiteStateStore.open(path, []);
  assert.deepEqual(durable.read(state => state.positionUpdateReceiptsById[update.positionUpdateId]), record);
  assert.deepEqual(durable.read(state => state.events[eventId]), terminal);
  } finally {
    await durable?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Watch trigger uses the original fix time rather than the later fall or call time", async () => {
  const h = makeHarness();
  const patient = await bootstrapIPhone(h, uuid(40_001), uuid(40_002));
  const watch = await bootstrapWatch(h, uuid(40_003), uuid(40_002));
  const responder = await bootstrapIPhone(h, uuid(40_004), uuid(40_005));
  await publishResponderPosition(h, responder, nearbyResponderPosition, atOffset(0));
  const eventId = uuid(40_006);
  const report = { ...observation(eventId, "NO_RESPONSE"), patientPositionObservedAt: atOffset(-700) };
  await h.service.reportWatchObservation(watch, eventId, report);
  const persisted = h.store.read(state => state.events[eventId]!);
  assert.equal(persisted.patientPosition?.observedAt, atOffset(-700));
  assert.equal(persisted.patientPosition?.serverReceivedAt, atOffset(0));
  assert.deepEqual(persisted.observation, report);
  assert.equal(Object.keys(h.store.read(state => state.deliveries)).length, 0);
  assert.equal((h.service.getEvent(patient, eventId) as PatientEmergencyEventView).patientPositionObservedAt,
    atOffset(-700));
  assert.equal((await h.service.reportWatchObservation(watch, eventId, report)).created, false);
  await assert.rejects(h.service.reportWatchObservation(watch, eventId, {
    ...report, patientPositionObservedAt: atOffset(-699)
  }), assertHttpProblem(409, /different Watch observation/));
});

test("untimed legacy trigger coordinates remain evidence but never become current patient P", async () => {
  const h = makeHarness();
  const patient = await bootstrapIPhone(h, uuid(40_011), uuid(40_012));
  const watch = await bootstrapWatch(h, uuid(40_013), uuid(40_012));
  const responder = await bootstrapIPhone(h, uuid(40_014), uuid(40_015));
  await publishResponderPosition(h, responder, nearbyResponderPosition, atOffset(0));
  const eventId = uuid(40_016);
  const report = { ...observation(eventId) };
  delete (report as Record<string, unknown>).patientPositionObservedAt;
  await h.service.reportWatchObservation(watch, eventId, report);
  assert.deepEqual(h.store.read(state => state.events[eventId]!.observation), report);
  assert.equal(h.store.read(state => state.events[eventId]!.patientPosition), undefined);
  const view = h.service.getEvent(patient, eventId) as PatientEmergencyEventView;
  assert.equal(view.state, "ACTIVE");
  assert.equal(view.patientPosition, null);
  assert.equal(view.patientPositionObservedAt, null);
  assert.equal(Object.keys(h.store.read(state => state.deliveries)).length, 0);
  assert.equal((await h.service.reportWatchObservation(watch, eventId, report)).created, false);
  await h.store.transact(state => {
    // Simulates the already-persisted projection emitted by the previous server.
    state.events[eventId]!.patientPosition = {
      positionUpdateId: eventId, source: "WATCH_TRIGGER_SNAPSHOT", position: patientPosition,
      observedAt: atOffset(1), serverReceivedAt: atOffset(0)
    };
  });
  const legacyView = h.service.getEvent(patient, eventId) as PatientEmergencyEventView;
  assert.equal(legacyView.patientPosition, null);
  assert.equal(legacyView.patientPositionObservedAt, null);
  h.setNow(atOffset(2));
  await h.service.updatePatientPosition(patient, eventId, {
    positionUpdateId: uuid(40_017), patientPosition, observedAt: atOffset(2)
  });
  const restored = h.service.getEvent(patient, eventId) as PatientEmergencyEventView;
  assert.equal(restored.patientPositionSource, "IPHONE_PRIMARY");
  assert.equal(restored.patientPositionObservedAt, atOffset(2));
  assert.ok(Object.keys(h.store.read(state => state.deliveries)).length > 0);
  assert.deepEqual(h.store.read(state => state.events[eventId]!.observation), report);
});

test("Watch fix timestamps reject future clock violations and timestamps without coordinates", async () => {
  const h = makeHarness();
  await bootstrapIPhone(h, uuid(40_021), uuid(40_022));
  const watch = await bootstrapWatch(h, uuid(40_023), uuid(40_022));
  const eventId = uuid(40_024);
  await assert.rejects(h.service.reportWatchObservation(watch, eventId, {
    ...observation(eventId), patientPositionObservedAt: atOffset(121)
  }), assertHttpProblem(409, /patientPositionObservedAt/));
  await assert.rejects(h.service.reportWatchObservation(watch, eventId, {
    ...observation(eventId), patientPosition: null, locationUnavailableReason: "No OS fix"
  }), assertHttpProblem(400, /fix timestamp requires/));
  assert.equal(Object.keys(h.store.read(state => state.events)).length, 0);
});

async function publishWatchFallbackPosition(
  harness: Harness,
  watch: DevicePrincipal,
  eventId: string,
  positionUpdateId: string,
  observedAt: string,
  latitude = patientPosition.latitude,
  activationState: "NOT_ACTIVATED" | "INACTIVE" | "ACTIVATED" = "INACTIVE",
  iphoneReachable = false,
  networkAvailable = true
) {
  return harness.service.updateWatchFallbackPatientPosition(
    watch,
    eventId,
    positionUpdateId,
    {
      schemaVersion: "2.0",
      eventId,
      positionUpdateId,
      observedAt,
      patientPosition: { ...patientPosition, latitude },
      activationState,
      iphoneReachable,
      networkAvailable
    }
  );
}

async function seedIPhonePrimaryThenFallback(
  idBase: number,
  configOverrides: Partial<BackendConfig> = {}
) {
  const harness = makeHarness(configOverrides);
  const pairId = uuid(idBase);
  const patient = await bootstrapIPhone(harness, uuid(idBase + 1), pairId);
  const watch = await bootstrapWatch(harness, uuid(idBase + 2), pairId);
  const eventId = uuid(idBase + 3);
  await harness.service.reportWatchObservation(watch, eventId, observation(eventId));
  harness.setNow(atOffset(2));
  const primaryUpdate = {
    positionUpdateId: uuid(idBase + 4),
    observedAt: atOffset(2),
    patientPosition: { ...patientPosition, latitude: 22.18 }
  };
  await harness.service.updatePatientPosition(patient, eventId, primaryUpdate);
  harness.setNow(atOffset(3));
  const candidateId = uuid(idBase + 7);
  const candidate = await publishWatchFallbackPosition(
    harness,
    watch,
    eventId,
    candidateId,
    atOffset(3),
    22.3
  );
  assert.equal(candidate.applied, false);
  harness.setNow(atOffset(12));
  await publishWatchFallbackPosition(
    harness,
    watch,
    eventId,
    candidateId,
    atOffset(3),
    22.3
  );
  assert.equal(asPatientView(harness.service.getEvent(patient, eventId)).patientPositionSource, "WATCH_FALLBACK");
  return { harness, patient, watch, eventId, primaryUpdate };
}

async function seedScenario(responderCount: number, harness = makeHarness()) {
  const patientPairId = uuid(100);
  const patient = await bootstrapIPhone(harness, uuid(101), patientPairId);
  const watch = await bootstrapWatch(harness, uuid(102), patientPairId);
  const responders: DevicePrincipal[] = [];
  for (let index = 0; index < responderCount; index += 1) {
    const responder = await bootstrapIPhone(
      harness,
      uuid(200 + index),
      uuid(300 + index)
    );
    await publishResponderPosition(
      harness,
      responder,
      {
        ...nearbyResponderPosition,
        latitude: nearbyResponderPosition.latitude + index * 0.00005
      },
      BASE_TIME
    );
    responders.push(responder);
  }
  const eventId = uuid(500);
  await harness.service.reportWatchObservation(watch, eventId, observation(eventId));
  return { harness, patient, watch, responders, eventId };
}

function deliveryIdFor(harness: Harness, eventId: string, deviceInstanceId: string): string {
  return harness.store.read((state) => {
    const delivery = Object.values(state.deliveries).find((candidate) =>
      candidate.eventId === eventId && candidate.deviceInstanceId === deviceInstanceId
    );
    assert.ok(delivery, `missing delivery for ${deviceInstanceId}`);
    return delivery.id;
  });
}

function deliveryIdForOptional(
  harness: Harness,
  eventId: string,
  deviceInstanceId: string
): string | undefined {
  return harness.store.read((state) => Object.values(state.deliveries).find((candidate) =>
    candidate.eventId === eventId && candidate.deviceInstanceId === deviceInstanceId
  )?.id);
}

async function accept(
  harness: Harness,
  principal: DevicePrincipal,
  eventId: string,
  index: number
) {
  harness.setNow(atOffset(10 + index));
  return harness.service.respond(
    principal,
    eventId,
    deliveryIdFor(harness, eventId, principal.deviceInstanceId),
    {
      decision: "ACCEPT",
      decidedAt: atOffset(10 + index)
    }
  );
}

function assertHttpProblem(status: number, detailPattern?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, status);
    if (detailPattern) assert.match(error.detail, detailPattern);
    return true;
  };
}

function asPatientView(view: EmergencyEventView): PatientEmergencyEventView {
  assert.equal(view.viewerRelationship, "PATIENT");
  if (view.viewerRelationship !== "PATIENT") {
    throw new Error("Expected a patient event projection");
  }
  return view;
}

function asResponderView(view: EmergencyEventView): ResponderEmergencyEventView {
  assert.equal(view.viewerRelationship, "RESPONDER");
  if (view.viewerRelationship !== "RESPONDER") {
    throw new Error("Expected a responder event projection");
  }
  return view;
}

function coordinationOf(view: EmergencyEventView): CoordinationSummary {
  if (!("coordination" in view)) throw new Error("Expected coordination in participant projection");
  return view.coordination;
}

test("frozen assignment formula returns N=1...5 and only P/A route roles", () => {
  const expected = [
    { acceptedCount: 1, patientCount: 1, aedCount: 0 },
    { acceptedCount: 2, patientCount: 1, aedCount: 1 },
    { acceptedCount: 3, patientCount: 2, aedCount: 1 },
    { acceptedCount: 4, patientCount: 3, aedCount: 1 },
    { acceptedCount: 5, patientCount: 3, aedCount: 2 }
  ];
  for (const plan of expected) assert.deepEqual(planAssignments(plan.acceptedCount), plan);
  assert.throws(() => planAssignments(-1), RangeError);
  assert.throws(() => planAssignments(1.5), RangeError);

  const route = makeAedRoute(nearbyResponderPosition, patientPosition, aeds[0]!);
  assert.deepEqual(route.path.map((position) => position.kind), ["R", "A", "P"]);
  assert.equal(route.distanceMeters, distanceMeters(nearbyResponderPosition, aeds[0]!.aedPosition)
    + distanceMeters(aeds[0]!.aedPosition, patientPosition));
  assert.equal(route.distanceSource, "GEODESIC_ESTIMATE");
  assert.equal("etaSeconds" in route, false);
  assert.equal(makeAedRoute(nearbyResponderPosition, patientPosition, {
    ...aeds[0]!, floorTransferSeconds: 9999, accessDelaySeconds: 9999, verificationSeconds: 9999
  }).distanceMeters, route.distanceMeters);
  assert.ok(Math.abs(
    distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
      - Math.PI * 6_371_008.8
  ) < 0.001);
});

test("assignment transition graph rejects role mixing and dedicated AED states", () => {
  assert.equal(assignmentTransitionAllowed("GO_TO_PATIENT", "ASSIGNED", "EN_ROUTE"), true);
  assert.equal(assignmentTransitionAllowed("GO_TO_PATIENT", "EN_ROUTE", "ARRIVED_AT_PATIENT"), true);
  assert.equal(assignmentTransitionAllowed("GO_TO_PATIENT", "EN_ROUTE", "ARRIVED_AT_AED"), false);
  assert.equal(assignmentTransitionAllowed("FETCH_AED", "EN_ROUTE", "ARRIVED_AT_AED"), true);
  assert.equal(assignmentTransitionAllowed("FETCH_AED", "ARRIVED_AT_AED", "AED_ACQUIRED"), false);
  assert.equal(assignmentTransitionAllowed("FETCH_AED", "AED_ACQUIRED", "EN_ROUTE_TO_PATIENT"), true);
});

test("fingerprints are stable across object key order but distinguish changed observations", () => {
  assert.equal(fingerprint({ a: 1, b: { c: 2 } }), fingerprint({ b: { c: 2 }, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test("canonical version-neutral UUID fixture strings remain accepted", () => {
  assert.equal(
    uuidSchema.parse("REDACTED-ID-0081"),
    "REDACTED-ID-0081"
  );
});

test("bootstrap requires four separate v2 iPhone agreements and a pre-initialized Watch pair", async () => {
  const harness = makeHarness();
  const pairId = uuid(1);

  await assert.rejects(
    harness.service.bootstrap({
      deviceInstanceId: uuid(2),
      deviceKind: "IPHONE",
      companionPairId: pairId,
      agreementAcceptances: [
        { kind: "PATIENT", version: "2.0", acceptedAt: BASE_TIME }
      ],
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    }, "invalid-iphone"),
    assertHttpProblem(400, /separate PATIENT and VOLUNTEER_RESPONDER/)
  );
  await assert.rejects(
    harness.service.bootstrap({
      deviceInstanceId: uuid(3),
      deviceKind: "WATCH",
      companionPairId: pairId
    }, "unpaired-watch"),
    assertHttpProblem(403, /initialized iPhone/)
  );

  const iphone = await bootstrapIPhone(harness, uuid(4), pairId);
  await assert.rejects(
    bootstrapIPhone(harness, uuid(40), pairId),
    assertHttpProblem(409, /already bound to another iPhone/)
  );
  const watch = await bootstrapWatch(harness, uuid(5), pairId);
  assert.deepEqual(iphone.scopes, [
    "events:read",
    "events:write",
    "responses:write",
    "position:write",
    "assignments:write"
  ]);
  assert.deepEqual(watch.scopes, ["watch:report", "watch:fallback"]);
  assert.notEqual(iphone.sessionId, watch.sessionId);
});

test("Watch observation is idempotent, conflicting reuse is rejected, and timeline only appends once", async () => {
  const { harness, watch, eventId } = await seedScenario(0);
  const report = observation(eventId);
  const timelineBeforeRetry = harness.store.read((state) => state.timelineByEventId[eventId]?.length);

  const retry = await harness.service.reportWatchObservation(watch, eventId, report);
  assert.equal(retry.created, false);
  assert.equal(retry.event.state, "ACTIVE");
  assert.equal(
    harness.store.read((state) => state.timelineByEventId[eventId]?.length),
    timelineBeforeRetry
  );

  await assert.rejects(
    harness.service.reportWatchObservation(watch, eventId, {
      ...report,
      fallResolution: "CONFIRMED"
    }),
    assertHttpProblem(409, /different Watch observation/)
  );
});

test("Watch Fall responses choose the only two legal trigger sources and enforce 120/35-minute bounds", async () => {
  const harness = makeHarness();
  const pairId = uuid(12_000);
  await bootstrapIPhone(harness, uuid(12_001), pairId);
  const watch = await bootstrapWatch(harness, uuid(12_002), pairId);
  const helpEventId = uuid(12_004);
  const help = await harness.service.reportWatchObservation(
    watch,
    helpEventId,
    observation(helpEventId, "NEEDS_HELP")
  );
  assert.equal(help.created, true);
  const helpView = asPatientView(help.event);
  assert.equal(helpView.triggerSource, "WATCH_FALL_HELP_CONFIRMED");
  assert.equal(helpView.appHelpResponse, "NEEDS_HELP");
  assert.equal(helpView.callFirstObservedAt, null);

  const noResponseEventId = uuid(12_005);
  const noResponse = await harness.service.reportWatchObservation(
    watch,
    noResponseEventId,
    observation(noResponseEventId, "NO_RESPONSE")
  );
  assert.equal(noResponse.created, true);
  const noResponseView = asPatientView(noResponse.event);
  assert.equal(noResponseView.triggerSource, "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED");
  assert.equal(noResponseView.callFirstObservedAt, atOffset(2));

  await assert.rejects(
    harness.service.reportWatchObservation(watch, uuid(12_006), {
      ...observation(uuid(12_006), "NEEDS_HELP"),
      appHelpResponse: "DECLINED"
    } as unknown as WatchEmergencyObservation),
    assertHttpProblem(400, /appHelpResponse/)
  );
  assert.equal(harness.store.read((state) => state.events[uuid(12_006)]), undefined);

  harness.setNow(atOffset(122));
  await assert.rejects(
    harness.service.reportWatchObservation(watch, uuid(12_007), {
      ...observation(uuid(12_007), "NO_RESPONSE"),
      callFirstObservedAt: atOffset(122)
    }),
    assertHttpProblem(400, /120 seconds/)
  );

  const exactEventId = uuid(12_008);
  const exactObservation: WatchEmergencyObservation = {
    ...observation(exactEventId, "NEEDS_HELP"),
    fallDetectedAt: BASE_TIME
  };
  harness.setNow(atOffset(35 * 60));
  assert.equal(
    (await harness.service.reportWatchObservation(watch, exactEventId, exactObservation)).created,
    true
  );
  harness.setNow(atOffset(35 * 60 + 1));
  await assert.rejects(
    harness.service.reportWatchObservation(watch, uuid(12_009), {
      ...exactObservation,
      eventId: uuid(12_009)
    }),
    assertHttpProblem(400, /35-minute/)
  );
});

test("Watch fallback stores a candidate, promotes after 10 seconds, and iPhone P wins immediately", async () => {
  const harness = makeHarness();
  const pairId = uuid(12_100);
  const patient = await bootstrapIPhone(harness, uuid(12_101), pairId);
  const watch = await bootstrapWatch(harness, uuid(12_102), pairId);
  const otherWatch = await bootstrapWatch(harness, uuid(12_103), pairId);
  const eventId = uuid(12_104);
  await harness.service.reportWatchObservation(watch, eventId, observation(eventId));

  harness.setNow(atOffset(1));
  await assert.rejects(
    publishWatchFallbackPosition(
      harness,
      watch,
      eventId,
      uuid(12_105),
      atOffset(1),
      22.25,
      "INACTIVE",
      false,
      false
    ),
    assertHttpProblem(403, /network/)
  );
  await assert.rejects(
    publishWatchFallbackPosition(
      harness,
      watch,
      eventId,
      uuid(12_106),
      atOffset(1),
      22.25,
      "ACTIVATED",
      true
    ),
    assertHttpProblem(403, /unreachable/)
  );
  await assert.rejects(
    publishWatchFallbackPosition(harness, otherWatch, eventId, uuid(12_107), atOffset(1), 22.25),
    assertHttpProblem(403, /triggered/)
  );

  const candidateId = uuid(12_108);
  const candidate = await publishWatchFallbackPosition(
    harness,
    watch,
    eventId,
    candidateId,
    atOffset(1),
    22.25
  );
  assert.equal(candidate.applied, false);
  assert.equal(candidate.ignoredAsStale, false);
  assert.equal(asPatientView(harness.service.getEvent(patient, eventId)).patientPositionSource, "WATCH_TRIGGER_SNAPSHOT");
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.watchFallbackCandidate?.positionUpdateId),
    candidateId
  );

  harness.setNow(atOffset(5));
  const newerCandidateId = uuid(12_109);
  const newerCandidate = await publishWatchFallbackPosition(
    harness,
    watch,
    eventId,
    newerCandidateId,
    atOffset(5),
    22.26
  );
  assert.equal(newerCandidate.applied, false);
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.watchFallbackCadence?.positionUpdateId),
    newerCandidateId
  );

  harness.setNow(atOffset(10));
  const promoted = await publishWatchFallbackPosition(
    harness,
    watch,
    eventId,
    newerCandidateId,
    atOffset(5),
    22.26
  );
  assert.equal(promoted.applied, true);
  assert.equal(asPatientView(harness.service.getEvent(patient, eventId)).patientPositionSource, "WATCH_FALLBACK");

  harness.setNow(atOffset(11));
  const iphone = await harness.service.updatePatientPosition(patient, eventId, {
    positionUpdateId: uuid(12_110),
    observedAt: atOffset(11),
    patientPosition: { ...patientPosition, latitude: 22.19 }
  });
  assert.equal(iphone.applied, true);
  assert.equal(asPatientView(harness.service.getEvent(patient, eventId)).patientPositionSource, "IPHONE_PRIMARY");
  const staleWatch = await publishWatchFallbackPosition(
    harness,
    watch,
    eventId,
    uuid(12_111),
    atOffset(10),
    22.30
  );
  assert.equal(staleWatch.ignoredAsStale, true);
  assert.equal(asPatientView(harness.service.getEvent(patient, eventId)).patientPositionSource, "IPHONE_PRIMARY");
});

test("R position and presence updates are idempotent, latest-wins and clock-skew bounded", async () => {
  const harness = makeHarness();
  const phone = await bootstrapIPhone(harness, uuid(900), uuid(901));
  harness.setNow(atOffset(10));
  const firstUpdate = {
    positionUpdateId: uuid(902),
    responderPosition: nearbyResponderPosition,
    observedAt: atOffset(1)
  };
  const first = await harness.service.updateResponderPosition(phone, firstUpdate);
  assert.equal(first.applied, true);

  const secondUpdate = {
    positionUpdateId: uuid(903),
    responderPosition: { ...nearbyResponderPosition, latitude: 22.199 },
    observedAt: atOffset(2)
  };
  const second = await harness.service.updateResponderPosition(phone, secondUpdate);
  const replay = await harness.service.updateResponderPosition(phone, secondUpdate);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.serverReceivedAt, second.serverReceivedAt);

  const stale = await harness.service.updateResponderPosition(phone, {
    positionUpdateId: uuid(904),
    responderPosition: { ...nearbyResponderPosition, latitude: 22.197 },
    observedAt: atOffset(1.5)
  });
  assert.equal(stale.ignoredAsStale, true);
  assert.equal(
    harness.store.read((state) => state.devices[phone.deviceInstanceId]?.latestPosition?.position.latitude),
    22.199
  );
  await assert.rejects(
    harness.service.updateResponderPosition(phone, {
      ...secondUpdate,
      responderPosition: { ...secondUpdate.responderPosition, longitude: 113.6 }
    }),
    assertHttpProblem(409, /positionUpdateId/)
  );
  const skewBoundary = await harness.service.updateResponderPosition(phone, {
    positionUpdateId: uuid(905),
    responderPosition: { ...nearbyResponderPosition, latitude: 22.2 },
    observedAt: atOffset(130)
  });
  assert.equal(skewBoundary.applied, true);
  await assert.rejects(
    harness.service.updateResponderPosition(phone, {
      positionUpdateId: uuid(90_005),
      responderPosition: nearbyResponderPosition,
      observedAt: atOffset(131)
    }),
    assertHttpProblem(409, /clock-skew/)
  );

  const presence = {
    presenceUpdateId: uuid(906),
    occurredAt: atOffset(3),
    availableForResponse: false,
    capabilities: { notificationAuthorized: false, locationAuthorized: true }
  };
  await harness.service.updatePresence(phone, presence);
  const presenceReplay = await harness.service.updatePresence(phone, presence);
  assert.equal(presenceReplay.availableForResponse, false);
  await harness.service.updatePresence(phone, {
    presenceUpdateId: uuid(907),
    occurredAt: atOffset(2),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  assert.equal((await harness.service.getPresence(phone)).availableForResponse, false);
  await assert.rejects(
    harness.service.updatePresence(phone, {
      presenceUpdateId: uuid(908),
      occurredAt: atOffset(3),
      availableForResponse: true,
      capabilities: { notificationAuthorized: true, locationAuthorized: true }
    }),
    assertHttpProblem(409, /same occurredAt/)
  );
  await assert.rejects(
    harness.service.updatePresence(phone, {
      presenceUpdateId: uuid(909),
      occurredAt: atOffset(131),
      availableForResponse: true,
      capabilities: { notificationAuthorized: true, locationAuthorized: true }
    }),
    assertHttpProblem(409, /clock-skew/)
  );

  await bootstrapIPhone(harness, phone.deviceInstanceId, phone.companionPairId);
  const afterRotation = await harness.service.getPresence(phone);
  assert.equal(afterRotation.availableForResponse, false);
  assert.equal(afterRotation.capabilities.notificationAuthorized, false);
});

test("position idempotency receipts are bounded and contain no coordinate history", async () => {
  const harness = makeHarness();
  const phone = await bootstrapIPhone(harness, uuid(910), uuid(911));
  harness.setNow(atOffset(100));
  for (let index = 0; index < 70; index += 1) {
    await harness.service.updateResponderPosition(phone, {
      positionUpdateId: uuid(10_100 + index),
      responderPosition: {
        ...nearbyResponderPosition,
        latitude: nearbyResponderPosition.latitude + index * 0.000001
      },
      observedAt: atOffset(index + 1)
    });
  }
  const receipts = harness.store.read((state) => Object.values(
    state.positionUpdateReceiptsById
  ).filter((receipt) => receipt.deviceInstanceId === phone.deviceInstanceId));
  assert.equal(receipts.length, 64);
  const serialized = JSON.stringify(receipts);
  assert.equal(serialized.includes("latitude"), false);
  assert.equal(serialized.includes("longitude"), false);
});

test("patient iPhone P updates recruit, move and replay without retaining a position timeline", async () => {
  const harness = makeHarness();
  const pairId = uuid(920);
  const patient = await bootstrapIPhone(harness, uuid(921), pairId);
  const watch = await bootstrapWatch(harness, uuid(922), pairId);
  const responder = await bootstrapIPhone(harness, uuid(923), uuid(924));
  await publishResponderPosition(harness, responder, nearbyResponderPosition, BASE_TIME);
  const eventId = uuid(925);
  await harness.service.reportWatchObservation(watch, eventId, {
    ...observation(eventId),
    patientPosition: null,
    patientPositionObservedAt: undefined,
    locationUnavailableReason: "watch location unavailable"
  });
  assert.equal(deliveryIdForOptional(harness, eventId, responder.deviceInstanceId), undefined);
  assert.deepEqual(
    harness.store.read((state) => ({
      radius: state.events[eventId]?.currentRecruitmentRadiusMeters,
      stageStartedAt: state.events[eventId]?.recruitmentStageStartedAt
    })),
    { radius: 1_000, stageStartedAt: null }
  );

  const update = {
    positionUpdateId: uuid(926),
    patientPosition,
    observedAt: atOffset(3)
  };
  const applied = await harness.service.updatePatientPosition(patient, eventId, update);
  assert.equal(applied.applied, true);
  assert.ok(deliveryIdForOptional(harness, eventId, responder.deviceInstanceId));
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.recruitmentStageStartedAt),
    BASE_TIME
  );
  const firstView = asPatientView(harness.service.getEvent(patient, eventId));
  assert.equal(firstView.coordination.nearbyCandidateCount, 1);
  assert.equal(firstView.coordination.pendingOfferCount, 1);
  assert.equal(firstView.patientLocationCard, null);

  const revision = firstView.coordination.revision;
  const replay = await harness.service.updatePatientPosition(patient, eventId, update);
  assert.equal(replay.idempotent, true);
  assert.equal(coordinationOf(harness.service.getEvent(patient, eventId)).revision, revision);

  await harness.service.updatePatientPosition(patient, eventId, {
    positionUpdateId: uuid(927),
    patientPosition: { ...patientPosition, latitude: 23.5 },
    observedAt: atOffset(4)
  });
  const moved = asPatientView(harness.service.getEvent(patient, eventId));
  assert.equal(moved.coordination.nearbyCandidateCount, 0);
  assert.equal(moved.coordination.pendingOfferCount, 0);
  assert.equal(
    harness.store.read((state) => Object.values(state.deliveries).find(
      (delivery) => delivery.eventId === eventId
        && delivery.deviceInstanceId === responder.deviceInstanceId
    )?.status),
    "EXPIRED"
  );
  assert.equal(
    harness.store.read((state) => (state.timelineByEventId[eventId] ?? [])
      .filter((entry) => entry.kind === "PATIENT_POSITION_UPDATED").length),
    2
  );
  const patientPositionAudit = harness.store.read((state) => (state.timelineByEventId[eventId] ?? [])
    .filter((entry) => entry.kind === "PATIENT_POSITION_UPDATED"));
  assert.equal(JSON.stringify(patientPositionAudit).includes("latitude"), false);
  assert.equal(JSON.stringify(patientPositionAudit).includes("longitude"), false);
  await assert.rejects(
    harness.service.updatePatientPosition(responder, eventId, {
      positionUpdateId: uuid(928),
      patientPosition,
      observedAt: atOffset(5)
    }),
    assertHttpProblem(403, /associated patient/)
  );
});

test("recruitment expands only when potential is insufficient or a stage times out", async () => {
  const harness = makeHarness();
  const patientPairId = uuid(1_000);
  const patient = await bootstrapIPhone(harness, uuid(1_001), patientPairId);
  const watch = await bootstrapWatch(harness, uuid(1_002), patientPairId);
  const initialResponders: DevicePrincipal[] = [];
  const outerResponders: DevicePrincipal[] = [];
  for (let index = 0; index < 3; index += 1) {
    const responder = await bootstrapIPhone(
      harness,
      uuid(1_010 + index),
      uuid(1_020 + index)
    );
    await publishResponderPosition(
      harness,
      responder,
      {
        ...nearbyResponderPosition,
        latitude: patientPosition.latitude + 0.004 + index * 0.0001,
        longitude: patientPosition.longitude
      },
      BASE_TIME
    );
    initialResponders.push(responder);
  }
  for (let index = 0; index < 3; index += 1) {
    const responder = await bootstrapIPhone(
      harness,
      uuid(1_030 + index),
      uuid(1_040 + index)
    );
    await publishResponderPosition(
      harness,
      responder,
      {
        ...nearbyResponderPosition,
        latitude: patientPosition.latitude + 0.011 + index * 0.0001,
        longitude: patientPosition.longitude
      },
      BASE_TIME
    );
    outerResponders.push(responder);
  }

  const eventId = uuid(1_050);
  await harness.service.reportWatchObservation(watch, eventId, observation(eventId));
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.currentRecruitmentRadiusMeters),
    1_000
  );
  await accept(harness, initialResponders[0]!, eventId, 0);
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.currentRecruitmentRadiusMeters),
    1_000,
    "one acceptance from three potential identities must not expand early"
  );

  harness.setNow(atOffset(30));
  await harness.service.tick();
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.currentRecruitmentRadiusMeters),
    1_000,
    "the exact 30.000-second offer/stage boundary is still live"
  );

  harness.setNow(atOffset(30.001));
  await harness.service.tick();
  const afterFirstStage = harness.store.read((state) => ({
    radius: state.events[eventId]?.currentRecruitmentRadiusMeters,
    stageStartedAt: state.events[eventId]?.recruitmentStageStartedAt,
    deliveries: Object.values(state.deliveries)
      .filter((delivery) => delivery.eventId === eventId)
      .map((delivery) => ({ deviceId: delivery.deviceInstanceId, status: delivery.status }))
  }));
  assert.equal(afterFirstStage.radius, 1_500);
  assert.equal(afterFirstStage.stageStartedAt, atOffset(30.001));
  assert.equal(
    afterFirstStage.deliveries.filter((delivery) =>
      initialResponders.slice(1).some((responder) => responder.deviceInstanceId === delivery.deviceId)
        && delivery.status === "EXPIRED"
    ).length,
    2
  );
  assert.deepEqual(
    afterFirstStage.deliveries
      .filter((delivery) => outerResponders.some((responder) => responder.deviceInstanceId === delivery.deviceId))
      .map((delivery) => delivery.deviceId),
    outerResponders.map((responder) => responder.deviceInstanceId).sort()
  );

  harness.setNow(atOffset(31));
  await harness.service.respond(
    outerResponders[0]!,
    eventId,
    deliveryIdFor(harness, eventId, outerResponders[0]!.deviceInstanceId),
    {
      decision: "ACCEPT",
      decidedAt: atOffset(31)
    }
  );
  harness.setNow(atOffset(32));
  await harness.service.respond(
    outerResponders[1]!,
    eventId,
    deliveryIdFor(harness, eventId, outerResponders[1]!.deviceInstanceId),
    {
      decision: "ACCEPT",
      decidedAt: atOffset(32)
    }
  );
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.currentRecruitmentRadiusMeters),
    1_500,
    "accepted target reached must stop further expansion"
  );
  harness.setNow(atOffset(100));
  await harness.service.tick();
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.currentRecruitmentRadiusMeters),
    1_500,
    "expired pending offers must not reopen a ring after three acceptances"
  );
});

test("offers are accepted at exactly 30 seconds and expire after the boundary", async () => {
  const exact = await seedScenario(1);
  const exactResponder = exact.responders[0]!;
  const exactDeliveryId = deliveryIdFor(exact.harness, exact.eventId, exactResponder.deviceInstanceId);
  exact.harness.setNow(atOffset(30));
  await exact.harness.service.tick();
  const accepted = await exact.harness.service.respond(exactResponder, exact.eventId, exactDeliveryId, {
    decision: "ACCEPT",
    decidedAt: atOffset(30)
  });
  assert.equal(accepted.decision, "ACCEPT");
  assert.equal(
    exact.harness.store.read((state) => state.deliveries[exactDeliveryId]?.status),
    "ACCEPTED"
  );

  const expired = await seedScenario(1);
  const expiredResponder = expired.responders[0]!;
  const expiredDeliveryId = deliveryIdFor(expired.harness, expired.eventId, expiredResponder.deviceInstanceId);
  expired.harness.setNow(atOffset(30.001));
  await expired.harness.service.tick();
  assert.equal(
    expired.harness.store.read((state) => state.deliveries[expiredDeliveryId]?.status),
    "EXPIRED"
  );
  await assert.rejects(
    expired.harness.service.respond(expiredResponder, expired.eventId, expiredDeliveryId, {
      decision: "ACCEPT",
      decidedAt: atOffset(30.001)
    }),
    assertHttpProblem(409, /[Ee]xpired/)
  );
});

test("client action time claims are causal, server-capped, replay-stable, and end-exclusive", async () => {
  const { harness, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  const deliveryId = deliveryIdFor(harness, eventId, responder.deviceInstanceId);
  const pendingView = harness.service.getEvent(responder, eventId);
  assert.equal(pendingView.eventPositionParticipationStartedAt, null);
  assert.equal(pendingView.eventPositionParticipationEndedAt, null);

  await assert.rejects(
    harness.service.respond(responder, eventId, deliveryId, {
      decision: "ACCEPT",
      decidedAt: atOffset(-1)
    }),
    assertHttpProblem(400, /decidedAt.*response request\/current delivery time/)
  );

  const futureDecision = { decision: "ACCEPT" as const, decidedAt: atOffset(60) };
  await harness.service.respond(responder, eventId, deliveryId, futureDecision);
  let interval = harness.store.read((state) => Object.values(state.participantIntervalsById)
    .find((candidate) => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId));
  assert.equal(interval?.acceptedAt, BASE_TIME, "future claim must be capped at server receipt");
  let responderView = asResponderView(harness.service.getEvent(responder, eventId));
  assert.equal(responderView.eventPositionParticipationStartedAt, BASE_TIME);
  assert.equal(responderView.eventPositionParticipationEndedAt, null);

  harness.setNow(atOffset(10));
  await harness.service.respond(responder, eventId, deliveryId, futureDecision);
  interval = harness.store.read((state) => Object.values(state.participantIntervalsById)
    .find((candidate) => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId));
  assert.equal(interval?.acceptedAt, BASE_TIME, "replay must not move acceptedAt forward");

  harness.setNow(atOffset(16));
  const existingEvidenceBatchId = uuid(1_056);
  await harness.service.recordEventPositionBatch(
    responder,
    eventId,
    existingEvidenceBatchId,
    {
      schemaVersion: "2.0",
      eventId,
      batchId: existingEvidenceBatchId,
      records: [{
        recordId: uuid(1_057),
        slotAt: atOffset(15),
        status: "FIX",
        fixObservedAt: new Date(Date.parse(atOffset(16)) - 1).toISOString(),
        position: nearbyResponderPosition
      }]
    }
  );

  const slowClockExit = {
    exitId: uuid(1_050),
    exitedAt: atOffset(-1),
    soleResponderConfirmed: true as const
  };
  const exited = await harness.service.exitEvent(responder, eventId, slowClockExit);
  assert.equal(exited.exitedAt, atOffset(16));
  interval = harness.store.read((state) => Object.values(state.participantIntervalsById)
    .find((candidate) => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId));
  assert.equal(interval?.endedAt, atOffset(16));
  assert.throws(
    () => harness.service.getEvent(responder, eventId),
    assertHttpProblem(404, /not visible/)
  );

  harness.setNow(atOffset(40));
  assert.deepEqual(await harness.service.exitEvent(responder, eventId, slowClockExit), {
    exitId: slowClockExit.exitId,
    eventId,
    exitedAt: atOffset(16),
    idempotent: true
  });
  await assert.rejects(
    harness.service.recordEventPositionBatch(responder, eventId, uuid(1_054), {
      schemaVersion: "2.0",
      eventId,
      batchId: uuid(1_054),
      records: [{
        recordId: uuid(1_055),
        slotAt: atOffset(16),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }),
    assertHttpProblem(409, /active time window/)
  );
});

test("event resolution uses an authoritative end and exposes only the viewer's own evidence window", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  await accept(harness, responder, eventId, 0);
  harness.setNow(atOffset(16));
  const evidenceBatchId = uuid(1_063);
  await harness.service.recordEventPositionBatch(responder, eventId, evidenceBatchId, {
    schemaVersion: "2.0",
    eventId,
    batchId: evidenceBatchId,
    records: [{
      recordId: uuid(1_064),
      slotAt: atOffset(15),
      status: "FIX",
      fixObservedAt: new Date(Date.parse(atOffset(16)) - 1).toISOString(),
      position: nearbyResponderPosition
    }]
  });
  const request = {
    resolutionId: uuid(1_060),
    reason: "PROBLEM_RESOLVED" as const,
    endedAt: atOffset(-1)
  };
  const patientTerminal = await harness.service.endEvent(patient, eventId, request);
  assert.equal(patientTerminal.resolvedAt, atOffset(16));
  assert.equal(patientTerminal.eventPositionParticipationStartedAt, BASE_TIME);
  assert.equal(patientTerminal.eventPositionParticipationEndedAt, atOffset(16));
  assert.equal(harness.store.read((state) => Object.values(state.participantIntervalsById)
    .find((interval) => interval.eventId === eventId)?.endedAt), atOffset(16));

  const responderTerminal = harness.service.getEvent(responder, eventId);
  assert.equal(responderTerminal.viewerRelationship, "NEUTRAL");
  assert.equal(responderTerminal.eventPositionParticipationStartedAt, atOffset(10));
  assert.equal(responderTerminal.eventPositionParticipationEndedAt, atOffset(16));
  assert.equal("patientPosition" in responderTerminal, false);
  assert.equal("coordination" in responderTerminal, false);

  harness.setNow(atOffset(40));
  const replay = await harness.service.endEvent(patient, eventId, request);
  assert.equal(replay.resolvedAt, atOffset(16));
  assert.equal(replay.eventPositionParticipationEndedAt, atOffset(16));
});

test("an open or fast-clock position slot returns retryable 425 and cannot block patient end", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  await accept(harness, responder, eventId, 0);
  const assignment = harness.store.read((state) => Object.values(state.assignments)
    .find((candidate) => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId));
  assert.ok(assignment);
  await harness.service.updateAssignmentStatus(
    responder,
    eventId,
    assignment.id,
    "EN_ROUTE",
    atOffset(20)
  );
  assert.equal(
    harness.store.read((state) => state.assignments[assignment.id]?.updatedAt),
    atOffset(10),
    "future assignment claim must be capped and must not block patient end"
  );
  const futureBatchId = uuid(1_066);
  await assert.rejects(
    harness.service.recordEventPositionBatch(responder, eventId, futureBatchId, {
      schemaVersion: "2.0",
      eventId,
      batchId: futureBatchId,
      records: [{
        recordId: uuid(1_067),
        slotAt: atOffset(11),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }),
    assertHttpProblem(425, /retry at or after/)
  );
  assert.equal(
    harness.store.read((state) => state.eventPositionBatchesById[futureBatchId]),
    undefined
  );

  const ended = await harness.service.endEvent(patient, eventId, {
    resolutionId: uuid(1_068),
    reason: "PROBLEM_RESOLVED",
    endedAt: atOffset(10)
  });
  assert.equal(ended.state, "RESOLVED");
  assert.equal(ended.resolvedAt, atOffset(10));
});

test("inclusive radius, freshness and accuracy boundaries exclude only values above policy", async () => {
  const boundaryPosition: ResponderPosition = {
    kind: "R",
    latitude: patientPosition.latitude + 0.005,
    longitude: patientPosition.longitude,
    accuracyMeters: 50
  };
  const radius = distanceMeters(boundaryPosition, patientPosition);
  const harness = makeHarness({ nearbyRadiusMeters: radius });
  const pairId = uuid(930);
  await bootstrapIPhone(harness, uuid(931), pairId);
  const watch = await bootstrapWatch(harness, uuid(932), pairId);
  const boundary = await bootstrapIPhone(harness, uuid(933), uuid(934));
  const outside = await bootstrapIPhone(harness, uuid(935), uuid(936));
  const stale = await bootstrapIPhone(harness, uuid(937), uuid(938));
  const inaccurate = await bootstrapIPhone(harness, uuid(939), uuid(940));
  const unsigned = await bootstrapIPhone(harness, uuid(941), uuid(942));
  const unavailable = await bootstrapIPhone(harness, uuid(943), uuid(944));
  const noNotification = await bootstrapIPhone(harness, uuid(945), uuid(946));
  const noLocation = await bootstrapIPhone(harness, uuid(947), uuid(948));

  await publishResponderPosition(harness, boundary, boundaryPosition, atOffset(-600));
  await publishResponderPosition(harness, outside, {
    ...boundaryPosition,
    latitude: boundaryPosition.latitude + 0.000001
  }, BASE_TIME);
  await publishResponderPosition(harness, stale, nearbyResponderPosition, atOffset(-600.001));
  await publishResponderPosition(harness, inaccurate, {
    ...nearbyResponderPosition,
    accuracyMeters: 50.001
  }, BASE_TIME);
  await publishResponderPosition(harness, unsigned, nearbyResponderPosition, BASE_TIME);
  await publishResponderPosition(harness, unavailable, nearbyResponderPosition, BASE_TIME);
  await publishResponderPosition(harness, noNotification, nearbyResponderPosition, BASE_TIME);
  await publishResponderPosition(harness, noLocation, nearbyResponderPosition, BASE_TIME);
  await harness.store.transact((state) => {
    delete state.devices[unsigned.deviceInstanceId]!.agreements.VOLUNTEER_RESPONDER;
  });
  await harness.service.updatePresence(unavailable, {
    presenceUpdateId: uuid(949),
    occurredAt: atOffset(1),
    availableForResponse: false,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  await harness.service.updatePresence(noNotification, {
    presenceUpdateId: uuid(950),
    occurredAt: atOffset(1),
    availableForResponse: true,
    capabilities: { notificationAuthorized: false, locationAuthorized: true }
  });
  await harness.service.updatePresence(noLocation, {
    presenceUpdateId: uuid(951),
    occurredAt: atOffset(1),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: false }
  });

  const eventId = uuid(952);
  await harness.service.reportWatchObservation(watch, eventId, observation(eventId));
  const recipients = harness.store.read((state) => Object.values(state.deliveries)
    .filter((delivery) => delivery.eventId === eventId)
    .map((delivery) => delivery.deviceInstanceId));
  // The initial ring has fewer than three potential identities, so the
  // service widens to 2 km before issuing offers. Both positions remain
  // within that final ring; stale, inaccurate, unsigned and unavailable
  // devices are still excluded.
  assert.deepEqual(recipients, [boundary.deviceInstanceId, outside.deviceInstanceId]);
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.currentRecruitmentRadiusMeters),
    2_000
  );
});

test("a responder with an active assignment is excluded from another event", async () => {
  const harness = makeHarness();
  const firstPair = uuid(960);
  await bootstrapIPhone(harness, uuid(961), firstPair);
  const firstWatch = await bootstrapWatch(harness, uuid(962), firstPair);
  const busy = await bootstrapIPhone(harness, uuid(963), uuid(964));
  await publishResponderPosition(harness, busy, nearbyResponderPosition, BASE_TIME);
  const firstEventId = uuid(965);
  await harness.service.reportWatchObservation(firstWatch, firstEventId, observation(firstEventId));
  await accept(harness, busy, firstEventId, 0);

  const secondPair = uuid(966);
  await bootstrapIPhone(harness, uuid(967), secondPair);
  const secondWatch = await bootstrapWatch(harness, uuid(968), secondPair);
  const secondEventId = uuid(969);
  await harness.service.reportWatchObservation(secondWatch, secondEventId, observation(secondEventId));
  assert.equal(deliveryIdForOptional(harness, secondEventId, busy.deviceInstanceId), undefined);
});

test("acceptance revalidates the persisted R sample in the same transaction", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  const deliveryId = deliveryIdFor(harness, eventId, responder.deviceInstanceId);
  harness.setNow(atOffset(20));
  assert.equal((await harness.service.getPresence(responder)).lastSeenAt, atOffset(20));
  await harness.store.transact((state) => {
    const device = state.devices[responder.deviceInstanceId];
    if (!device?.latestPosition || device.latestPosition.position.kind !== "R") return;
    device.latestPosition = {
      positionUpdateId: device.latestPosition.positionUpdateId,
      position: {
        ...device.latestPosition.position,
        latitude: 23.5
      },
      observedAt: atOffset(20),
      serverReceivedAt: atOffset(20)
    };
  });
  await assert.rejects(
    harness.service.respond(responder, eventId, deliveryId, {
      decision: "ACCEPT",
      decidedAt: atOffset(20)
    }),
    assertHttpProblem(409, /no longer eligible/)
  );
  const snapshot = harness.store.read((state) => ({
    delivery: state.deliveries[deliveryId],
    assignments: Object.values(state.assignments).filter(
      (assignment) => assignment.eventId === eventId
    )
  }));
  assert.equal(snapshot.delivery?.status, "EXPIRED");
  assert.deepEqual(snapshot.assignments, []);
  assert.equal(coordinationOf(harness.service.getEvent(patient, eventId)).acceptedResponderCount, 0);
});

test("nearby filtering uses server positions, freshness and accuracy; projections are least-privilege", async () => {
  const harness = makeHarness();
  const patientPairId = uuid(10);
  const patient = await bootstrapIPhone(harness, uuid(11), patientPairId);
  const watch = await bootstrapWatch(harness, uuid(12), patientPairId);
  const near = await bootstrapIPhone(harness, uuid(13), uuid(113));
  const far = await bootstrapIPhone(harness, uuid(14), uuid(114));
  const stale = await bootstrapIPhone(harness, uuid(15), uuid(115));
  const inaccurate = await bootstrapIPhone(harness, uuid(16), uuid(116));
  const noPosition = await bootstrapIPhone(harness, uuid(17), uuid(117));

  await publishResponderPosition(harness, near, nearbyResponderPosition, BASE_TIME);
  await publishResponderPosition(harness, far, {
    ...nearbyResponderPosition,
    latitude: 22.30
  }, BASE_TIME);
  await publishResponderPosition(harness, stale, nearbyResponderPosition, atOffset(-601));
  await publishResponderPosition(harness, inaccurate, {
    ...nearbyResponderPosition,
    accuracyMeters: 51
  }, BASE_TIME);

  const eventId = uuid(18);
  await harness.service.reportWatchObservation(watch, eventId, observation(eventId));
  const deliveryDevices = harness.store.read((state) => Object.values(state.deliveries)
    .map((delivery) => delivery.deviceInstanceId));
  assert.deepEqual(deliveryDevices, [near.deviceInstanceId]);

  assert.equal(harness.service.getEvent(patient, eventId).viewerRelationship, "PATIENT");
  assert.throws(
    () => harness.service.getEvent(watch, eventId),
    assertHttpProblem(403, /limited to iPhone/)
  );
  const nearView = harness.service.getEvent(near, eventId);
  assert.equal(nearView.viewerRelationship, "NEUTRAL");
  assert.ok(nearView.pendingResponseRequest);
  for (const sensitiveField of [
    "patientPosition",
    "patientLocationCard",
    "fallDetectedAt",
    "fallResolution",
    "appHelpResponse",
    "callFirstObservedAt",
    "coordination"
  ]) {
    assert.equal(sensitiveField in nearView, false, `${sensitiveField} leaked before acceptance`);
  }
  for (const unrelated of [far, stale, inaccurate, noPosition]) {
    assert.deepEqual(harness.service.listEvents(unrelated), []);
    assert.throws(() => harness.service.getEvent(unrelated, eventId), assertHttpProblem(404));
  }

  await accept(harness, near, eventId, 0);
  const acceptedView = asResponderView(harness.service.getEvent(near, eventId));
  assert.equal(acceptedView.viewerRelationship, "RESPONDER");
  assert.equal(acceptedView.pendingResponseRequest, null);
  assert.equal("patientPosition" in acceptedView, true);
  assert.equal("fallResolution" in acceptedView, false);
  assert.equal(acceptedView.currentAssignment?.role, "GO_TO_PATIENT");
});

test("coarse patient accuracy creates the patient event without recruiting responders", async () => {
  for (const accuracyMeters of [51]) {
    const harness = makeHarness();
    const pairId = uuid(120 + (accuracyMeters ?? 0));
    const patient = await bootstrapIPhone(harness, uuid(220 + (accuracyMeters ?? 0)), pairId);
    const watch = await bootstrapWatch(harness, uuid(320 + (accuracyMeters ?? 0)), pairId);
    const responder = await bootstrapIPhone(
      harness,
      uuid(420 + (accuracyMeters ?? 0)),
      uuid(520 + (accuracyMeters ?? 0))
    );
    await publishResponderPosition(harness, responder, nearbyResponderPosition, BASE_TIME);
    const eventId = uuid(620 + (accuracyMeters ?? 0));
    await harness.service.reportWatchObservation(watch, eventId, {
      ...observation(eventId),
      patientPosition: { ...patientPosition, accuracyMeters }
    });
    assert.equal(harness.service.getEvent(patient, eventId).state, "ACTIVE");
    assert.equal(
      harness.store.read((state) => Object.values(state.deliveries).some(
        (delivery) => delivery.eventId === eventId
      )),
      false
    );
  }
});

test("an active patient is never recruited as a responder for another event", async () => {
  const harness = makeHarness();
  const firstPair = uuid(30);
  const firstPatient = await bootstrapIPhone(harness, uuid(31), firstPair);
  const firstWatch = await bootstrapWatch(harness, uuid(32), firstPair);
  await publishResponderPosition(harness, firstPatient, nearbyResponderPosition, BASE_TIME);

  const secondPair = uuid(33);
  await bootstrapIPhone(harness, uuid(34), secondPair);
  const secondWatch = await bootstrapWatch(harness, uuid(35), secondPair);

  const firstEventId = uuid(36);
  await harness.service.reportWatchObservation(firstWatch, firstEventId, observation(firstEventId));
  assert.equal(
    harness.store.read((state) => state.devices[firstPatient.deviceInstanceId]?.latestPosition),
    undefined
  );
  await assert.rejects(
    publishResponderPosition(
      harness,
      firstPatient,
      nearbyResponderPosition,
      atOffset(3)
    ),
    assertHttpProblem(409, /active patient cannot publish an R position/i)
  );
  const secondEventId = uuid(37);
  await harness.service.reportWatchObservation(secondWatch, secondEventId, observation(secondEventId));

  const wasRecruited = harness.store.read((state) => Object.values(state.deliveries).some(
    (delivery) => delivery.eventId === secondEventId
      && delivery.deviceInstanceId === firstPatient.deviceInstanceId
  ));
  assert.equal(wasRecruited, false);
});

test("becoming a patient expires an existing acceptance and replans the old event", async () => {
  const harness = makeHarness();

  const firstPatientPair = uuid(130);
  await bootstrapIPhone(harness, uuid(131), firstPatientPair);
  const firstWatch = await bootstrapWatch(harness, uuid(132), firstPatientPair);

  const futurePatientPair = uuid(133);
  const futurePatient = await bootstrapIPhone(harness, uuid(134), futurePatientPair);
  const futurePatientWatch = await bootstrapWatch(harness, uuid(135), futurePatientPair);
  const peer = await bootstrapIPhone(harness, uuid(136), uuid(137));
  await publishResponderPosition(harness, futurePatient, nearbyResponderPosition, BASE_TIME);
  await publishResponderPosition(harness, peer, {
    ...nearbyResponderPosition,
    latitude: nearbyResponderPosition.latitude + 0.0001
  }, BASE_TIME);

  const firstEventId = uuid(138);
  await harness.service.reportWatchObservation(
    firstWatch,
    firstEventId,
    observation(firstEventId)
  );
  await accept(harness, futurePatient, firstEventId, 0);
  await accept(harness, peer, firstEventId, 1);

  const patientEventId = uuid(139);
  // End the old participant interval after its historical evidence slots so
  // an offline pre-exit upload remains admissible but the end boundary stays
  // exclusive.
  harness.setNow(atOffset(20));
  await harness.service.reportWatchObservation(
    futurePatientWatch,
    patientEventId,
    observation(patientEventId)
  );

  const snapshot = harness.store.read((state) => ({
    patientEventCreatedAt: state.events[patientEventId]?.createdAt,
    patientPriorityInterval: Object.values(state.participantIntervalsById).find((interval) =>
      interval.eventId === firstEventId
        && interval.deviceInstanceId === futurePatient.deviceInstanceId
    ),
    futurePatientDelivery: Object.values(state.deliveries).find((delivery) =>
      delivery.eventId === firstEventId
        && delivery.deviceInstanceId === futurePatient.deviceInstanceId
    ),
    assignments: Object.values(state.assignments).filter((assignment) =>
      assignment.eventId === firstEventId
    )
  }));
  assert.equal(snapshot.patientEventCreatedAt, atOffset(20));
  assert.equal(snapshot.patientPriorityInterval?.endedAt, snapshot.patientEventCreatedAt);
  assert.equal(snapshot.patientPriorityInterval?.endReason, "PATIENT_PRIORITY");
  assert.equal(snapshot.futurePatientDelivery?.decision, "ACCEPT");
  assert.equal(snapshot.futurePatientDelivery?.status, "EXPIRED");
  assert.equal(
    snapshot.assignments.some((assignment) =>
      assignment.deviceInstanceId === futurePatient.deviceInstanceId
        && !["CANCELLED", "COMPLETED", "AED_UNAVAILABLE", "TIMED_OUT"].includes(assignment.status)
    ),
    false
  );
  const peerCurrent = snapshot.assignments
    .filter((assignment) => assignment.deviceInstanceId === peer.deviceInstanceId)
    .sort((left, right) => right.revision - left.revision)[0];
  assert.equal(peerCurrent?.role, "GO_TO_PATIENT");
  assert.equal(peerCurrent?.status, "ASSIGNED");
  const priorityLateEvidence = await harness.service.recordEventPositionBatch(
    futurePatient,
    firstEventId,
    uuid(140),
    {
      schemaVersion: "2.0",
      eventId: firstEventId,
      batchId: uuid(140),
      records: [{
        recordId: uuid(141),
        slotAt: atOffset(19),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }
  );
  assert.equal(priorityLateEvidence.records[0]?.persisted, true);
  await assert.rejects(
    harness.service.recordEventPositionBatch(futurePatient, firstEventId, uuid(142), {
      schemaVersion: "2.0",
      eventId: firstEventId,
      batchId: uuid(142),
      records: [{
        recordId: uuid(143),
        slotAt: atOffset(20),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }),
    assertHttpProblem(409, /active time window/)
  );
  assert.equal(harness.service.getEvent(futurePatient, patientEventId).viewerRelationship, "PATIENT");
});

test("an expired responder request cannot be revived after the patient event ends", async () => {
  const harness = makeHarness();
  const firstPatientPair = uuid(160);
  await bootstrapIPhone(harness, uuid(161), firstPatientPair);
  const firstWatch = await bootstrapWatch(harness, uuid(162), firstPatientPair);

  const futurePatientPair = uuid(163);
  const futurePatient = await bootstrapIPhone(harness, uuid(164), futurePatientPair);
  const futurePatientWatch = await bootstrapWatch(harness, uuid(165), futurePatientPair);
  await publishResponderPosition(harness, futurePatient, nearbyResponderPosition, BASE_TIME);

  const firstEventId = uuid(166);
  await harness.service.reportWatchObservation(firstWatch, firstEventId, observation(firstEventId));
  const expiredDeliveryId = deliveryIdFor(
    harness,
    firstEventId,
    futurePatient.deviceInstanceId
  );
  const patientEventId = uuid(167);
  await harness.service.reportWatchObservation(
    futurePatientWatch,
    patientEventId,
    observation(patientEventId)
  );
  harness.setNow(atOffset(20));
  await harness.service.confirmFalseAlarm(futurePatient, patientEventId);

  await assert.rejects(
    harness.service.respond(futurePatient, firstEventId, expiredDeliveryId, {
      decision: "ACCEPT",
      decidedAt: atOffset(21)
    }),
    assertHttpProblem(409, /cannot be revived/)
  );
});

test("patient priority preserves another responder's already acquired AED work", async () => {
  const harness = makeHarness();
  const originalPatientPair = uuid(140);
  await bootstrapIPhone(harness, uuid(141), originalPatientPair);
  const originalWatch = await bootstrapWatch(harness, uuid(142), originalPatientPair);

  const firstPair = uuid(143);
  const firstResponder = await bootstrapIPhone(harness, uuid(144), firstPair);
  const firstWatch = await bootstrapWatch(harness, uuid(145), firstPair);
  const secondPair = uuid(146);
  const secondResponder = await bootstrapIPhone(harness, uuid(147), secondPair);
  const secondWatch = await bootstrapWatch(harness, uuid(148), secondPair);
  await publishResponderPosition(harness, firstResponder, nearbyResponderPosition, BASE_TIME);
  await publishResponderPosition(harness, secondResponder, {
    ...nearbyResponderPosition,
    latitude: nearbyResponderPosition.latitude + 0.0002
  }, BASE_TIME);

  const eventId = uuid(149);
  await harness.service.reportWatchObservation(originalWatch, eventId, observation(eventId));
  await accept(harness, firstResponder, eventId, 0);
  await accept(harness, secondResponder, eventId, 1);
  const assignments = harness.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId));
  const fetch = assignments.find((assignment) => assignment.role === "FETCH_AED");
  const go = assignments.find((assignment) => assignment.role === "GO_TO_PATIENT");
  assert.ok(fetch?.route);
  assert.ok(go);
  const byDevice = new Map([
    [firstResponder.deviceInstanceId, { principal: firstResponder, watch: firstWatch }],
    [secondResponder.deviceInstanceId, { principal: secondResponder, watch: secondWatch }]
  ]);
  const fetchOwner = byDevice.get(fetch.deviceInstanceId)!;
  const futurePatient = byDevice.get(go.deviceInstanceId)!;
  harness.setNow(atOffset(40));
  await harness.service.updateAssignmentStatus(
    fetchOwner.principal,
    eventId,
    fetch.id,
    "EN_ROUTE",
    atOffset(40)
  );
  harness.setNow(atOffset(41));
  await harness.service.updateAssignmentStatus(
    fetchOwner.principal,
    eventId,
    fetch.id,
    "ARRIVED_AT_AED",
    atOffset(41)
  );
  const receipt = {
    receiptId: uuid(150),
    eventId,
    assignmentId: fetch.id,
    aedId: fetch.route.aedId,
    acquiredAt: atOffset(42)
  };
  harness.setNow(atOffset(42));
  await harness.service.acquireAed(fetchOwner.principal, eventId, fetch.id, receipt);

  const patientEventId = uuid(151);
  await harness.service.reportWatchObservation(
    futurePatient.watch,
    patientEventId,
    observation(patientEventId)
  );

  const preserved = harness.store.read((state) => state.assignments[fetch.id]);
  assert.equal(preserved?.status, "AED_ACQUIRED");
  assert.deepEqual(preserved?.aedAcquiredReceipt, receipt);
  assert.equal(
    harness.store.read((state) => Object.values(state.participantIntervalsById).find((interval) =>
      interval.eventId === eventId
        && interval.deviceInstanceId === futurePatient.principal.deviceInstanceId)?.endReason),
    "PATIENT_PRIORITY"
  );
  assert.equal(
    harness.service.getEvent(futurePatient.principal, patientEventId).viewerRelationship,
    "PATIENT"
  );
});

test("accepted responders are replanned to the frozen N=1...5 role counts", async () => {
  const expectedCounts = [
    [1, 0],
    [1, 1],
    [2, 1],
    [3, 1],
    [3, 2]
  ] as const;

  for (let count = 1; count <= 5; count += 1) {
    const { harness, responders, eventId } = await seedScenario(count);
    for (let index = 0; index < responders.length; index += 1) {
      await accept(harness, responders[index]!, eventId, index);
    }
    const assignments = harness.store.read((state) => Object.values(state.assignments)
      .filter((assignment) => assignment.eventId === eventId));
    assert.equal(assignments.length, count, `N=${count}`);
    assert.equal(
      assignments.filter((assignment) => assignment.role === "GO_TO_PATIENT").length,
      expectedCounts[count - 1]![0],
      `N=${count} GO_TO_PATIENT`
    );
    assert.equal(
      assignments.filter((assignment) => assignment.role === "FETCH_AED").length,
      expectedCounts[count - 1]![1],
      `N=${count} FETCH_AED`
    );
    for (const assignment of assignments.filter((item) => item.role === "FETCH_AED")) {
      assert.deepEqual(assignment.route?.path.map((position) => position.kind), ["R", "A", "P"]);
    }
    const aedIds = assignments
      .filter((item) => item.role === "FETCH_AED")
      .map((item) => item.route?.aedId);
    assert.equal(new Set(aedIds).size, aedIds.length, `N=${count} unique AED assignments`);
  }
});

test("new acceptances fill role gaps without changing an in-action assignment", async () => {
  const { harness, responders, eventId } = await seedScenario(5);
  await accept(harness, responders[0]!, eventId, 0);
  const original = harness.store.read((state) => Object.values(state.assignments).find(
    (assignment) => assignment.eventId === eventId
      && assignment.deviceInstanceId === responders[0]!.deviceInstanceId
  ));
  assert.ok(original);
  harness.setNow(atOffset(20));
  await harness.service.updateAssignmentStatus(
    responders[0]!,
    eventId,
    original.id,
    "EN_ROUTE",
    atOffset(20)
  );
  for (let index = 1; index < responders.length; index += 1) {
    await accept(harness, responders[index]!, eventId, 10 + index);
  }
  const after = harness.store.read((state) => state.assignments[original.id]);
  assert.equal(after?.role, "GO_TO_PATIENT");
  assert.equal(after?.status, "EN_ROUTE");
  const current = harness.store.read((state) => responders.map((responder) =>
    Object.values(state.assignments)
      .filter((assignment) => assignment.eventId === eventId
        && assignment.deviceInstanceId === responder.deviceInstanceId)
      .sort((left, right) => right.revision - left.revision)[0]
  ));
  assert.equal(current.filter((assignment) => assignment?.role === "GO_TO_PATIENT").length, 3);
  assert.equal(current.filter((assignment) => assignment?.role === "FETCH_AED").length, 2);
});

test("TIMED_OUT and CANCELLED exit N while COMPLETED and AED_UNAVAILABLE remain participants", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(2);
  await accept(harness, responders[0]!, eventId, 0);
  await accept(harness, responders[1]!, eventId, 1);
  const assignments = harness.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId));
  assert.equal(assignments.length, 2);
  const patientAssignment = assignments.find((assignment) => assignment.role === "GO_TO_PATIENT");
  const aedAssignment = assignments.find((assignment) => assignment.role === "FETCH_AED");
  assert.ok(patientAssignment);
  assert.ok(aedAssignment);
  await harness.store.transact((state) => {
    state.assignments[patientAssignment.id]!.status = "COMPLETED";
    state.assignments[aedAssignment.id]!.status = "TIMED_OUT";
  });
  let summary = coordinationOf(harness.service.getEvent(patient, eventId));
  assert.equal(summary.acceptedResponderCount, 1);
  assert.equal(summary.goToPatientCount + summary.fetchAedCount, 1);
  assert.equal(summary.completedAssignmentCount, 1);

  await harness.store.transact((state) => {
    state.assignments[patientAssignment.id]!.status = "CANCELLED";
    state.assignments[aedAssignment.id]!.status = "AED_UNAVAILABLE";
  });
  summary = coordinationOf(harness.service.getEvent(patient, eventId));
  assert.equal(summary.acceptedResponderCount, 1);
  assert.equal(summary.goToPatientCount + summary.fetchAedCount, 1);
});

test("AED_ACQUIRED is idempotent and completion never auto-resolves the patient event", async () => {
  const { harness, responders, eventId } = await seedScenario(2);
  for (let index = 0; index < responders.length; index += 1) {
    await accept(harness, responders[index]!, eventId, index);
  }
  const assignments = harness.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId));
  const patientAssignment = assignments.find((assignment) => assignment.role === "GO_TO_PATIENT");
  const aedAssignment = assignments.find((assignment) => assignment.role === "FETCH_AED");
  assert.ok(patientAssignment);
  assert.ok(aedAssignment?.route);
  const patientPrincipal = responders.find((item) => item.deviceInstanceId === patientAssignment.deviceInstanceId)!;
  const aedPrincipal = responders.find((item) => item.deviceInstanceId === aedAssignment.deviceInstanceId)!;

  harness.setNow(atOffset(25));
  await harness.service.updateAssignmentStatus(
    patientPrincipal,
    eventId,
    patientAssignment.id,
    "EN_ROUTE",
    atOffset(20)
  );
  await harness.service.updateAssignmentStatus(
    patientPrincipal,
    eventId,
    patientAssignment.id,
    "ARRIVED_AT_PATIENT",
    atOffset(21)
  );
  await harness.service.updateAssignmentStatus(
    patientPrincipal,
    eventId,
    patientAssignment.id,
    "COMPLETED",
    atOffset(22)
  );
  await harness.service.updateAssignmentStatus(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    "EN_ROUTE",
    atOffset(23)
  );
  await harness.service.updateAssignmentStatus(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    "ARRIVED_AT_AED",
    atOffset(24)
  );

  const receipt = {
    receiptId: uuid(600),
    eventId,
    assignmentId: aedAssignment.id,
    aedId: aedAssignment.route.aedId,
    acquiredAt: atOffset(25)
  };
  assert.equal((await harness.service.acquireAed(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    receipt
  )).created, true);
  assert.equal((await harness.service.acquireAed(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    receipt
  )).created, false);
  const sameBusinessReceipt = { ...receipt, receiptId: uuid(601) };
  const businessRetry = await harness.service.acquireAed(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    sameBusinessReceipt
  );
  assert.equal(businessRetry.created, false);
  assert.deepEqual(businessRetry.receipt, receipt);
  const repeatedBusinessRetry = await harness.service.acquireAed(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    sameBusinessReceipt
  );
  assert.equal(repeatedBusinessRetry.created, false);
  assert.deepEqual(repeatedBusinessRetry.receipt, receipt);
  harness.setNow(atOffset(28));
  await harness.service.updateAssignmentStatus(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    "EN_ROUTE_TO_PATIENT",
    atOffset(26)
  );
  await harness.service.updateAssignmentStatus(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    "ARRIVED_AT_PATIENT",
    atOffset(27)
  );
  await harness.service.updateAssignmentStatus(
    aedPrincipal,
    eventId,
    aedAssignment.id,
    "COMPLETED",
    atOffset(28)
  );

  harness.setNow(atOffset(86_400));
  const event = harness.store.read((state) => state.events[eventId]);
  assert.equal(event?.state, "ACTIVE");
  assert.equal(event?.recruitmentState, "COMPLETED");
  assert.equal(event?.resolvedAt, undefined);
  assert.equal(
    harness.store.read((state) => state.aedReceiptsById[receipt.receiptId]?.canonical.aedId),
    receipt.aedId
  );
});

test("AED_UNAVAILABLE is idempotent and creates an R-A-P replacement using another AED", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(2);
  for (let index = 0; index < responders.length; index += 1) {
    await accept(harness, responders[index]!, eventId, index);
  }
  const first = harness.store.read((state) => Object.values(state.assignments).find(
    (assignment) => assignment.eventId === eventId && assignment.role === "FETCH_AED"
  ));
  assert.ok(first?.route);
  const principal = responders.find((item) => item.deviceInstanceId === first.deviceInstanceId)!;
  const report = {
    reportId: uuid(700),
    eventId,
    assignmentId: first.id,
    aedId: first.route.aedId,
    reportedAt: atOffset(30),
    reason: "cabinet unavailable"
  };

  assert.equal((await harness.service.reportAedUnavailable(
    principal,
    eventId,
    first.id,
    report
  )).created, true);
  assert.equal((await harness.service.reportAedUnavailable(
    principal,
    eventId,
    first.id,
    report
  )).created, false);

  const ownAssignments = harness.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId
      && assignment.deviceInstanceId === principal.deviceInstanceId)
    .sort((left, right) => left.revision - right.revision));
  assert.equal(ownAssignments[0]?.status, "AED_UNAVAILABLE");
  assert.equal(ownAssignments[1]?.status, "ASSIGNED");
  assert.notEqual(ownAssignments[1]?.route?.aedId, first.route.aedId);
  assert.deepEqual(ownAssignments[1]?.route?.path.map((position) => position.kind), ["R", "A", "P"]);
  assert.ok(harness.emissions.some((emission) => {
    if (emission.name !== "assignment:created"
      || !emission.deviceIds.includes(principal.deviceInstanceId)) return false;
    const payload = emission.payload as { assignment?: { id?: string } };
    return payload.assignment?.id === ownAssignments[1]?.id;
  }));
  assert.ok(harness.emissions.some((emission) => emission.name === "aed:unavailable"
    && emission.deviceIds.includes(patient.deviceInstanceId)
    && responders.every((responder) => emission.deviceIds.includes(responder.deviceInstanceId))));
});

test("a second AED_UNAVAILABLE report in one event commits its own outbox intent", async () => {
  // Regression: the outbox identity is (name, messageId, deviceInstanceId). A
  // constant aed:unavailable messageId collided across assignments, so the
  // second report threw "Notification identity was reused" inside its own
  // business transaction and rolled the whole report back.
  const { harness, patient, responders, eventId } = await seedScenario(5);
  for (let index = 0; index < responders.length; index += 1) {
    await accept(harness, responders[index]!, eventId, index);
  }
  const fetchAed = harness.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId
      && assignment.role === "FETCH_AED")
    .sort((left, right) => left.id.localeCompare(right.id)));
  assert.equal(fetchAed.length, 2);
  assert.ok(fetchAed[0]?.route && fetchAed[1]?.route);
  assert.notEqual(fetchAed[0].route.aedId, fetchAed[1].route.aedId);

  for (const [index, assignment] of fetchAed.entries()) {
    const owner = responders.find(
      (item) => item.deviceInstanceId === assignment.deviceInstanceId
    );
    assert.ok(owner);
    harness.setNow(atOffset(30 + index * 5));
    assert.equal((await harness.service.reportAedUnavailable(owner, eventId, assignment.id, {
      reportId: uuid(45_001 + index),
      eventId,
      assignmentId: assignment.id,
      aedId: assignment.route?.aedId ?? "",
      reportedAt: atOffset(30 + index * 5),
      reason: "cabinet unavailable"
    })).created, true);
  }

  const unavailable = harness.store.read((state) => Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId
      && assignment.status === "AED_UNAVAILABLE"));
  assert.equal(unavailable.length, 2);
  const broadcasts = harness.store.read((state) => Object.values(state.notificationOutboxById)
    .filter((row) => row.name === "aed:unavailable"));
  assert.equal(
    new Set(broadcasts.map((row) => String(row.payload.messageId))).size,
    2,
    "each unavailable report needs its own stable outbox identity"
  );
  assert.ok(harness.emissions.some((emission) => emission.name === "aed:unavailable"
    && emission.deviceIds.includes(patient.deviceInstanceId)));
});

test("AED replacement assignment notification commits with the unavailable report", async () => {
  const { harness, responders, eventId } = await seedScenario(2);
  await accept(harness, responders[0]!, eventId, 0);
  await accept(harness, responders[1]!, eventId, 1);
  const first = harness.store.read(state => Object.values(state.assignments).find(
    assignment => assignment.eventId === eventId && assignment.role === "FETCH_AED"
      && assignment.status === "ASSIGNED"
  ));
  assert.ok(first?.route);
  const owner = responders.find(responder => responder.deviceInstanceId === first.deviceInstanceId);
  assert.ok(owner);
  const unavailable: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    unavailable.push({ deviceIds: [...deviceIds], name, payload });
    return [];
  } });
  harness.setNow(atOffset(30));
  await harness.service.reportAedUnavailable(owner, eventId, first.id, {
    reportId: uuid(40_121), eventId, assignmentId: first.id, aedId: first.route.aedId,
    reportedAt: atOffset(30), reason: "cabinet unavailable"
  });
  const pending = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:created" && row.status === "PENDING"));
  assert.equal(pending.length, 1);
  assert.equal(unavailable.filter(item => item.name === "assignment:created").length, 1);
  const recovered: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recovered.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const created = recovered.filter(item => item.name === "assignment:created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.deviceIds, [owner.deviceInstanceId]);
  assert.ok(harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:created" && row.attempts > 0)
    .every(row => row.status === "DISPATCHED" || row.status === "SUPPRESSED")));
});

test("explicit patient false-alarm confirmation cancels coordination but elapsed time does not", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  await accept(harness, responders[0]!, eventId, 0);

  harness.setNow(atOffset(3_600));
  assert.equal(harness.service.getEvent(patient, eventId).state, "ACTIVE");
  const cancelled = await harness.service.confirmFalseAlarm(patient, eventId);
  assert.equal(cancelled.state, "CANCELLED_CONFIRMED_FALSE_ALARM");
  assert.equal(cancelled.recruitmentState, "STOPPED");
  assert.equal(
    harness.store.read((state) => Object.values(state.assignments).find(
      (assignment) => assignment.eventId === eventId
    )?.status),
    "CANCELLED"
  );
  assert.ok(harness.emissions.some((emission) =>
    emission.name === "event:false-alarm-confirmed"
      && emission.deviceIds.includes(patient.deviceInstanceId)
      && emission.deviceIds.includes(responders[0]!.deviceInstanceId)
  ));
  await assert.rejects(
    harness.service.confirmFalseAlarm(responders[0]!, eventId),
    assertHttpProblem(403, /associated patient/)
  );
});

test("committed end survives publisher failure and retries its durable messages once available", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(2);
  await accept(harness, responders[0]!, eventId, 0);
  harness.setNow(atOffset(20));
  const request = { resolutionId: uuid(40_110), reason: "PROBLEM_RESOLVED" as const, endedAt: atOffset(20) };
  harness.service.setPublisher({ emitToDevices() { throw new Error("injected transport unavailable"); } });
  const ended = await harness.service.endEvent(patient, eventId, request);
  assert.equal(ended.state, "RESOLVED");
  const committed = harness.store.read(state => state);
  assert.equal(Object.keys(committed.resolutionsById).length, 1);
  assert.ok(Object.values(committed.notificationOutboxById).some(row => row.status === "PENDING"));
  const received: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    received.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const terminal = received.filter(item => item.name === "event:resolved");
  assert.deepEqual(terminal.flatMap(item => item.deviceIds).sort(),
    [patient.deviceInstanceId, responders[0]!.deviceInstanceId].sort());
  assert.ok(terminal.every(item => (item.payload as { messageId: string }).messageId === `event-resolved:${request.resolutionId}`));
  assert.equal(received.filter(item => item.name === "response:offer-expired").length, 1);
  const count = received.length;
  await harness.service.endEvent(patient, eventId, request);
  await harness.service.tick();
  assert.equal(received.length, count);
  assert.deepEqual(harness.store.read(state => state.assignments), committed.assignments);
  await assert.rejects(harness.service.endEvent(patient, eventId, { ...request, reason: "FALSE_ALARM" }),
    assertHttpProblem(409, /different content/));
});

test("response decision fan-out commits in the outbox and replays once after reconnect", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  const deliveryId = deliveryIdFor(harness, eventId, responder.deviceInstanceId);
  const unavailableEmissions: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    unavailableEmissions.push({ deviceIds: [...deviceIds], name, payload });
    return [];
  } });
  harness.setNow(atOffset(10));
  const accepted = await harness.service.respond(responder, eventId, deliveryId, {
    decision: "ACCEPT",
    decidedAt: atOffset(10)
  });
  assert.equal(accepted.decision, "ACCEPT");
  const queued = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "response:decision-recorded"));
  const queuedAssignments = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:created"));
  assert.equal(queued.length, 2);
  assert.ok(queued.every(row => row.status === "PENDING" && row.completedAt === undefined));
  assert.equal(queuedAssignments.length, 1);
  assert.equal(queuedAssignments[0]?.status, "PENDING");
  assert.equal(unavailableEmissions.filter(item => item.name === "response:decision-recorded").length, 1);
  assert.equal(unavailableEmissions.filter(item => item.name === "assignment:created").length, 1);

  harness.setNow(atOffset(11));
  await harness.service.respond(responder, eventId, deliveryId, {
    decision: "ACCEPT",
    decidedAt: atOffset(10)
  });
  assert.equal(harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "response:decision-recorded")).length, 2);
  assert.equal(harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:created")).length, 1);

  const recoveredEmissions: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recoveredEmissions.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const decisionEvents = recoveredEmissions.filter(item => item.name === "response:decision-recorded");
  assert.equal(decisionEvents.length, 1);
  assert.deepEqual(decisionEvents[0]!.deviceIds.sort(),
    [patient.deviceInstanceId, responder.deviceInstanceId].sort());
  const assignmentEvents = recoveredEmissions.filter(item => item.name === "assignment:created");
  assert.equal(assignmentEvents.length, 1);
  assert.deepEqual(assignmentEvents[0]!.deviceIds, [responder.deviceInstanceId]);
  assert.ok(harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "response:decision-recorded")
    .every(row => row.status === "DISPATCHED")));
  const count = recoveredEmissions.length;
  await harness.service.tick();
  assert.equal(recoveredEmissions.length, count);
});

test("pending response decision delivery rechecks exit authorization before handoff", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  const deliveryId = deliveryIdFor(harness, eventId, responder.deviceInstanceId);
  harness.service.setPublisher({ emitToDevices() { return []; } });
  harness.setNow(atOffset(10));
  await harness.service.respond(responder, eventId, deliveryId, {
    decision: "ACCEPT",
    decidedAt: atOffset(10)
  });
  harness.setNow(atOffset(20));
  await harness.service.exitEvent(responder, eventId, {
    exitId: uuid(40_117),
    exitedAt: atOffset(20),
    soleResponderConfirmed: true
  });
  const recovered: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recovered.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const decisionEvents = recovered.filter(item => item.name === "response:decision-recorded");
  assert.equal(decisionEvents.length, 1);
  assert.deepEqual(decisionEvents[0]!.deviceIds, [patient.deviceInstanceId]);
  const rows = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "response:decision-recorded"));
  assert.equal(rows.filter(row => row.status === "DISPATCHED").length, 1);
  assert.equal(rows.filter(row => row.status === "SUPPRESSED").length, 1);
});

test("ordinary assignment updates commit in the outbox and replay after reconnect", async () => {
  const { harness, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  await accept(harness, responder, eventId, 0);
  const assignment = harness.store.read(state => Object.values(state.assignments).find(
    candidate => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId
      && candidate.status === "ASSIGNED"
  ));
  assert.ok(assignment);
  const unavailable: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    unavailable.push({ deviceIds: [...deviceIds], name, payload });
    return [];
  } });
  harness.setNow(atOffset(20));
  await harness.service.updateAssignmentStatus(
    responder, eventId, assignment.id, "EN_ROUTE", atOffset(20)
  );
  const queued = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:updated"));
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.status, "PENDING");
  assert.equal(unavailable.filter(item => item.name === "assignment:updated").length, 1);

  const recovered: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recovered.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const updates = recovered.filter(item => item.name === "assignment:updated");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.deviceIds, [responder.deviceInstanceId]);
  assert.equal(harness.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "assignment:updated")?.status), "DISPATCHED");
  const count = recovered.length;
  await harness.service.updateAssignmentStatus(
    responder, eventId, assignment.id, "EN_ROUTE", atOffset(20)
  );
  await harness.service.tick();
  assert.equal(recovered.length, count);
});

test("pending assignment update is suppressed after the owner exits", async () => {
  const { harness, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  await accept(harness, responder, eventId, 0);
  const assignment = harness.store.read(state => Object.values(state.assignments).find(
    candidate => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId
      && candidate.status === "ASSIGNED"
  ));
  assert.ok(assignment);
  harness.service.setPublisher({ emitToDevices() { return []; } });
  harness.setNow(atOffset(20));
  await harness.service.updateAssignmentStatus(
    responder, eventId, assignment.id, "EN_ROUTE", atOffset(20)
  );
  harness.setNow(atOffset(21));
  await harness.service.exitEvent(responder, eventId, {
    exitId: uuid(40_118), exitedAt: atOffset(21), soleResponderConfirmed: true
  });
  const recovered: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recovered.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  assert.equal(recovered.filter(item => item.name === "assignment:updated").length, 0);
  assert.equal(harness.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "assignment:updated")?.status), "SUPPRESSED");
});

test("exit replan assignment notifications commit and replay for the remaining responder", async () => {
  const { harness, responders, eventId } = await seedScenario(2);
  await accept(harness, responders[0]!, eventId, 0);
  await accept(harness, responders[1]!, eventId, 1);
  const exiting = responders[0]!;
  const remaining = responders[1]!;
  const unavailable: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    unavailable.push({ deviceIds: [...deviceIds], name, payload });
    return [];
  } });
  harness.setNow(atOffset(20));
  await harness.service.exitEvent(exiting, eventId, {
    exitId: uuid(40_119), exitedAt: atOffset(20), reason: "replan test"
  });
  const pending = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => (row.name === "assignment:created" || row.name === "assignment:updated")
      && row.status === "PENDING"));
  assert.ok(pending.length > 0);
  assert.equal(unavailable.filter(item => item.name === "assignment:created"
    || item.name === "assignment:updated").length, pending.length);

  const recovered: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recovered.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const assignmentEvents = recovered.filter(item => item.name === "assignment:created"
    || item.name === "assignment:updated");
  assert.equal(assignmentEvents.length, pending.length);
  assert.ok(assignmentEvents.every(item => item.deviceIds.length === 1
    && item.deviceIds[0] === remaining.deviceInstanceId));
  assert.ok(harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:created" || row.name === "assignment:updated")
    .filter(row => row.attempts > 0)
    .every(row => row.status === "DISPATCHED" || row.status === "SUPPRESSED")));
});

test("patient route refresh assignment notifications commit with the position transaction", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(2);
  await accept(harness, responders[0]!, eventId, 0);
  await accept(harness, responders[1]!, eventId, 1);
  const fetchAssignment = harness.store.read(state => Object.values(state.assignments).find(
    assignment => assignment.eventId === eventId
      && assignment.role === "FETCH_AED"
      && assignment.status === "ASSIGNED"
  ));
  assert.ok(fetchAssignment?.route);
  const owner = responders.find(responder => responder.deviceInstanceId === fetchAssignment.deviceInstanceId);
  assert.ok(owner);
  harness.service.setPublisher({ emitToDevices() { return []; } });
  harness.setNow(atOffset(20));
  await harness.service.updatePatientPosition(patient, eventId, {
    positionUpdateId: uuid(40_120),
    observedAt: atOffset(20),
    patientPosition: { ...patientPosition, latitude: 22.205 }
  });
  const pending = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.name === "assignment:updated" && row.status === "PENDING"));
  assert.equal(pending.length, 1);
  const recovered: Emission[] = [];
  harness.service.setPublisher({ emitToDevices(deviceIds, name, payload) {
    recovered.push({ deviceIds: [...deviceIds], name, payload });
    return deviceIds;
  } });
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const updates = recovered.filter(item => item.name === "assignment:updated");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.deviceIds, [owner.deviceInstanceId]);
  assert.equal(harness.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "assignment:updated" && row.payload.eventId === eventId
      && row.status === "DISPATCHED")?.status), "DISPATCHED");
});

test("outbox completes only the connected subset of an authorized audience", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  await accept(harness, responders[0]!, eventId, 0);
  harness.setNow(atOffset(20));
  harness.service.setPublisher({ emitToDevices(deviceIds) {
    return deviceIds.filter(id => id === patient.deviceInstanceId);
  } });
  await harness.service.endEvent(patient, eventId, {
    resolutionId: uuid(40_118), reason: "PROBLEM_RESOLVED", endedAt: atOffset(20)
  });
  const rows = harness.store.read(state => Object.values(state.notificationOutboxById));
  const terminalRows = rows.filter(row => row.name === "event:false-alarm-confirmed"
    || row.name === "event:resolved"
    || row.name === "event:closed-unconfirmed-no-response"
    || (row.name === "event:coordination-updated"
      && row.payload.occurredAt === atOffset(20))
    || row.name === "response:offer-expired");
  const decisionRows = rows.filter(row => row.name === "response:decision-recorded");
  const assignmentRows = rows.filter(row => row.name === "assignment:created"
    || row.name === "assignment:updated");
  assert.equal(terminalRows.length, 4);
  assert.equal(decisionRows.length, 2);
  assert.equal(assignmentRows.length, 1);
  assert.ok(decisionRows.every(row => row.status === "DISPATCHED"));
  assert.ok(assignmentRows.every(row => row.status === "DISPATCHED"));
  for (const row of terminalRows) {
    const connected = row.recipient.deviceInstanceId === patient.deviceInstanceId;
    assert.equal(row.status, connected ? "DISPATCHED" : "PENDING");
    assert.equal(row.completedAt !== undefined, connected);
  }
});

test("no publisher cannot consume a durable terminal notification", async () => {
  const { harness, patient, eventId } = await seedScenario(0);
  const time = new Date(atOffset(20));
  const withoutPublisher = new AEDResponseService(harness.store, harness.config, undefined, () => time);
  await withoutPublisher.endEvent(patient, eventId, {
    resolutionId: uuid(40_119), reason: "PROBLEM_RESOLVED", endedAt: time.toISOString()
  });
  const terminalRows = Object.values(harness.store.read(state => state.notificationOutboxById))
    .filter(row => row.name === "event:false-alarm-confirmed"
      || row.name === "event:resolved"
      || row.name === "event:closed-unconfirmed-no-response"
      || (row.name === "event:coordination-updated"
        && row.payload.occurredAt === time.toISOString())
      || row.name === "response:offer-expired");
  assert.ok(terminalRows
    .every(row => row.status === "PENDING" && row.completedAt === undefined));
  harness.setNow(atOffset(100));
  await harness.service.tick();
  assert.equal(harness.emissions.filter(item => item.name === "event:resolved").length, 1);
});

test("outbox restart uses persisted messages and suppresses rebound or withdrawn audiences", async () => {
  for (const changeAudience of [false, true]) {
  const { harness: seed, patient, responders, eventId } = await seedScenario(2);
  await accept(seed, responders[0]!, eventId, 0);
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-outbox-"));
  const path = join(directory, "state.sqlite");
  let store: SQLiteStateStore | undefined;
  try {
    store = await SQLiteStateStore.open(path, aeds);
    await store.transact(state => Object.assign(state, seed.store.read(value => value)));
    const beforeRestart = makeHarness({}, store);
    beforeRestart.setNow(atOffset(20));
    beforeRestart.service.setPublisher({ emitToDevices() { throw new Error("injected outage"); } });
    await beforeRestart.service.endEvent(patient, eventId, {
      resolutionId: uuid(40_120), reason: "FALSE_ALARM", endedAt: atOffset(20)
    });
    const queued = store.read(state => state.notificationOutboxById);
    const queuedTerminal = Object.values(queued).filter(row => row.name === "event:false-alarm-confirmed"
      || row.name === "event:resolved"
      || row.name === "event:closed-unconfirmed-no-response"
      || (row.name === "event:coordination-updated"
        && row.payload.occurredAt === atOffset(20))
      || row.name === "response:offer-expired");
    const queuedDecision = Object.values(queued).filter(row => row.name === "response:decision-recorded");
    const queuedAssignment = Object.values(queued).filter(row => row.name === "assignment:created"
      || row.name === "assignment:updated");
    assert.equal(queuedTerminal.length, 5);
    assert.equal(queuedDecision.length, 2);
    assert.equal(queuedAssignment.length, 1);
    assert.ok(queuedTerminal.every(row => row.status === "PENDING"));
    assert.ok(queuedDecision.every(row => row.status === "DISPATCHED"));
    assert.ok(queuedAssignment.every(row => row.status === "DISPATCHED"));
    await store.close();
    store = await SQLiteStateStore.open(path, []);
    assert.deepEqual(store.read(state => state.notificationOutboxById), queued);
    if (changeAudience) await store.transact(state => {
      state.devices[patient.deviceInstanceId]!.companionPairId = uuid(40_121);
      state.events[eventId]!.exitedResponderUserIds = [responders[0]!.userId!];
    });
    const restarted = makeHarness({}, store);
    restarted.setNow(atOffset(100));
    await restarted.service.tick();
    if (changeAudience) {
      assert.equal(restarted.emissions.length, 1);
      assert.equal(restarted.emissions[0]?.name, "response:offer-expired");
      assert.deepEqual(restarted.emissions[0]?.deviceIds, [responders[1]!.deviceInstanceId]);
    } else {
      const terminal = restarted.emissions.filter(item => item.name === "event:false-alarm-confirmed");
      assert.equal(terminal.length, 1);
      assert.deepEqual(terminal[0]?.deviceIds.sort(), [patient.deviceInstanceId, responders[0]!.deviceInstanceId].sort());
      assert.ok(Object.values(store.read(state => state.notificationOutboxById))
        .every(row => row.status === "DISPATCHED" || row.status === "SUPPRESSED"));
    }
    const suppressedTerminal = store.read(state => Object.values(state.notificationOutboxById)
      .filter(row => row.status === "SUPPRESSED"
        && (row.name === "event:false-alarm-confirmed"
          || row.name === "event:resolved"
          || row.name === "event:closed-unconfirmed-no-response"
          || row.name === "event:coordination-updated"
          || row.name === "response:offer-expired")));
    assert.equal(suppressedTerminal.length, changeAudience ? 4 : 0);
    const saved = store.read(state => state.notificationOutboxById);
    await store.close();
    store = await SQLiteStateStore.open(path, []);
    assert.deepEqual(store.read(state => state.notificationOutboxById), saved);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
  }
});

test("a failed end commit emits nothing and failed dispatch acknowledgement retries the same message", async () => {
  const { harness: seed, patient, eventId } = await seedScenario(0);
  const before = seed.store.read(state => state);
  let failBusinessCommit = true;
  let failDispatchCommit = false;
  const wrapped: StateStore = {
    read: reader => seed.store.read(reader),
    transact: mutation => seed.store.transact(async state => {
      const old = structuredClone(state.notificationOutboxById);
      const result = await mutation(state);
      if (failBusinessCommit && state.events[eventId]?.state !== "ACTIVE") throw new Error("injected commit failure");
      if (failDispatchCommit && Object.values(state.notificationOutboxById).some(row =>
        row.name === "event:resolved"
          && old[row.id]?.status === "PENDING" && row.status === "DISPATCHED")) {
        failDispatchCommit = false;
        throw new Error("injected acknowledgement failure");
      }
      return result;
    })
  };
  const harness = makeHarness({}, wrapped);
  harness.setNow(atOffset(20));
  const request = { resolutionId: uuid(40_130), reason: "PROBLEM_RESOLVED" as const, endedAt: atOffset(20) };
  await assert.rejects(harness.service.endEvent(patient, eventId, request), /commit failure/);
  assert.deepEqual(seed.store.read(state => state), before);
  assert.equal(harness.emissions.length, 0);
  failBusinessCommit = false;
  failDispatchCommit = true;
  await harness.service.endEvent(patient, eventId, request);
  const first = harness.emissions.filter(item => item.name === "event:resolved");
  assert.equal(first.length, 1);
  assert.equal(seed.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "event:resolved")?.status), "PENDING");
  harness.setNow(atOffset(100));
  await harness.service.tick();
  const attempts = harness.emissions.filter(item => item.name === "event:resolved");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(Object.keys(seed.store.read(state => state.resolutionsById)).length, 1);
  assert.equal(seed.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "event:resolved")?.status), "DISPATCHED");
});

test("accept and end serialize without terminal assignments or new participation", async () => {
  for (const acceptFirst of [true, false]) {
    const { harness, patient, responders, eventId } = await seedScenario(1);
    const responder = responders[0]!;
    harness.setNow(atOffset(10));
    const decide = () => harness.service.respond(responder, eventId,
      deliveryIdFor(harness, eventId, responder.deviceInstanceId),
      { decision: "ACCEPT", decidedAt: atOffset(10) });
    const finish = () => harness.service.endEvent(patient, eventId, {
      resolutionId: uuid(40_100), reason: "PROBLEM_RESOLVED", endedAt: atOffset(10)
    });
    const results = await Promise.allSettled(acceptFirst
      ? [decide(), finish()] : [finish(), decide()]);
    assert.equal(results[acceptFirst ? 1 : 0]?.status, "fulfilled");
    const decision = results[acceptFirst ? 0 : 1]!;
    assert.equal(decision.status, acceptFirst ? "fulfilled" : "rejected");
    if (decision.status === "rejected") assertHttpProblem(409)(decision.reason);
    const state = harness.store.read(value => value);
    assert.equal(state.events[eventId]?.state, "RESOLVED");
    const intervals = Object.values(state.participantIntervalsById)
      .filter(interval => interval.eventId === eventId && interval.deviceInstanceId === responder.deviceInstanceId);
    assert.equal(intervals.length, acceptFirst ? 1 : 0);
    for (const interval of intervals) {
      assert.equal(interval.endedAt, atOffset(10));
      assert.equal(interval.endReason, "EVENT_ENDED");
    }
    const tasks = Object.values(state.assignments).filter(item => item.eventId === eventId);
    assert.equal(tasks.length, acceptFirst ? 1 : 0);
    assert.ok(tasks.every(item => item.status === "CANCELLED"));
    assert.equal(state.devices[responder.deviceInstanceId]?.currentAssignmentId, undefined);
    assert.deepEqual(state.aeds, aeds);
  }
});

test("the canonical patient end action maps each reason exactly once", async () => {
  const cases = [
    {
      reason: "FALSE_ALARM" as const,
      state: "CANCELLED_CONFIRMED_FALSE_ALARM" as const,
      recruitmentState: "STOPPED" as const
    },
    {
      reason: "PROBLEM_RESOLVED" as const,
      state: "RESOLVED" as const,
      recruitmentState: "COMPLETED" as const
    },
    {
      reason: "PROFESSIONAL_TAKEOVER" as const,
      state: "RESOLVED" as const,
      recruitmentState: "COMPLETED" as const
    }
  ];
  for (const [index, expected] of cases.entries()) {
    const { harness, patient, eventId } = await seedScenario(0);
    const request = {
      resolutionId: uuid(800 + index),
      reason: expected.reason,
      endedAt: atOffset(20 + index),
      note: "single confirmed patient end action"
    };
    const ended = await harness.service.endEvent(patient, eventId, request);
    assert.equal(ended.state, expected.state);
    assert.equal(ended.recruitmentState, expected.recruitmentState);
    assert.equal(
      harness.store.read((state) => state.events[eventId]?.terminalReason),
      expected.reason
    );
    const replay = await harness.service.endEvent(patient, eventId, request);
    assert.equal(replay.state, expected.state);
    assert.equal(
      harness.store.read((state) => state.timelineByEventId[eventId]
        ?.filter((entry) => entry.kind === "EVENT_RESOLVED" || entry.kind === "FALSE_ALARM_CONFIRMED")
        .length),
      1
    );
  }
});

test("responder exit revokes event access and permanently blocks stable user re-entry", async () => {
  const { harness, patient, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  const deliveryId = deliveryIdFor(harness, eventId, responder.deviceInstanceId);
  await accept(harness, responder, eventId, 0);
  const exit = {
    exitId: uuid(900),
    exitedAt: atOffset(20),
    reason: "responder unavailable",
    soleResponderConfirmed: true as const
  };
  harness.setNow(atOffset(20));
  const exited = await harness.service.exitEvent(responder, eventId, exit);
  assert.equal(exited.idempotent, false);
  assert.equal(
    harness.store.read((state) => state.events[eventId]?.exitedResponderUserIds
      ?.includes(responder.userId!)),
    true
  );
  assert.equal(
    harness.store.read((state) => Object.values(state.assignments)
      .find((assignment) => assignment.eventId === eventId
        && assignment.deviceInstanceId === responder.deviceInstanceId)?.status),
    "CANCELLED"
  );
  assert.deepEqual(
    harness.store.read((state) => Object.values(state.participantIntervalsById).find((interval) =>
      interval.eventId === eventId && interval.deviceInstanceId === responder.deviceInstanceId)),
    {
      eventId,
      userId: responder.userId,
      deviceInstanceId: responder.deviceInstanceId,
      acceptedAt: atOffset(10),
      endedAt: atOffset(20),
      endReason: "RESPONDER_EXIT"
    }
  );
  assert.equal(
    harness.store.read((state) => state.devices[responder.deviceInstanceId]?.latestPosition),
    undefined
  );
  assert.throws(
    () => harness.service.getEvent(responder, eventId),
    assertHttpProblem(404, /not visible/)
  );
  await assert.rejects(
    harness.service.respond(responder, eventId, deliveryId, {
      decision: "REFUSE",
      decidedAt: atOffset(21)
    }),
    assertHttpProblem(403, /no event communication/)
  );
  const preExitBatch = await harness.service.recordEventPositionBatch(responder, eventId, uuid(901), {
    schemaVersion: "2.0",
    eventId,
    batchId: uuid(901),
    records: [{
      recordId: uuid(902),
      slotAt: atOffset(19),
      status: "NO_NEW_FIX",
      gapReason: "NO_FIX"
    }]
  });
  assert.equal(preExitBatch.records[0]?.persisted, true);
  assert.equal(preExitBatch.records[0]?.appliedToLatest, false);
  await assert.rejects(
    harness.service.recordEventPositionBatch(responder, eventId, uuid(904), {
      schemaVersion: "2.0",
      eventId,
      batchId: uuid(904),
      records: [{
        recordId: uuid(905),
        slotAt: atOffset(20),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }),
    assertHttpProblem(409, /active time window/)
  );
  assert.equal((await harness.service.exitEvent(responder, eventId, exit)).idempotent, true);
  await assert.rejects(
    harness.service.exitEvent(responder, eventId, {
      ...exit,
      exitId: uuid(903)
    }),
    assertHttpProblem(403, /exited responder/)
  );
  assert.equal(harness.service.getEvent(patient, eventId).viewerRelationship, "PATIENT");
});

test("a timed-out responder may ACK pre-exit evidence but cannot restore access or latest position", async () => {
  const { harness, responders, eventId } = await seedScenario(1);
  const responder = responders[0]!;
  await accept(harness, responder, eventId, 0);
  const assignment = harness.store.read((state) => Object.values(state.assignments).find(
    (candidate) => candidate.eventId === eventId
      && candidate.deviceInstanceId === responder.deviceInstanceId
  ));
  assert.ok(assignment);
  const initialPositionUpdateId = harness.store.read((state) =>
    state.devices[responder.deviceInstanceId]?.latestPosition?.positionUpdateId
  );
  assert.ok(initialPositionUpdateId);
  harness.setNow(atOffset(20));
  await harness.store.transact((state) => {
    const current = state.assignments[assignment.id];
    assert.ok(current);
    current.status = "TIMED_OUT";
    current.updatedAt = atOffset(20);
  });
  assert.equal(
    harness.store.read((state) => Object.values(state.participantIntervalsById).find((interval) =>
      interval.eventId === eventId && interval.deviceInstanceId === responder.deviceInstanceId)
      ?.endReason),
    "TIMED_OUT"
  );
  const batch = {
    schemaVersion: "2.0" as const,
    eventId,
    batchId: uuid(910),
    records: [{
      recordId: uuid(911),
      slotAt: atOffset(15),
      status: "FIX" as const,
      fixObservedAt: atOffset(15),
      position: { ...nearbyResponderPosition, latitude: 22.199 }
    }]
  } satisfies EventPositionBatch;
  const ack = await harness.service.recordEventPositionBatch(
    responder,
    eventId,
    batch.batchId,
    batch
  );
  assert.equal(ack.records[0]?.persisted, true);
  assert.equal(ack.records[0]?.appliedToLatest, false);
  assert.equal(
    harness.store.read((state) => state.devices[responder.deviceInstanceId]?.latestPosition
      ?.positionUpdateId),
    initialPositionUpdateId
  );
  harness.setNow(atOffset(25));
  const exited = await harness.service.exitEvent(responder, eventId, {
    exitId: uuid(912),
    exitedAt: atOffset(25),
    soleResponderConfirmed: true
  });
  assert.equal(exited.idempotent, false);
  assert.equal(
    (await harness.service.recordEventPositionBatch(
      responder,
      eventId,
      batch.batchId,
      batch
    )).idempotent,
    true
  );
  const preExitAfterTimeout = await harness.service.recordEventPositionBatch(
    responder,
    eventId,
    uuid(913),
    {
      schemaVersion: "2.0",
      eventId,
      batchId: uuid(913),
      records: [{
        recordId: uuid(914),
        slotAt: atOffset(16),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }
  );
  assert.equal(preExitAfterTimeout.records[0]?.persisted, true);
  await assert.rejects(
    harness.service.recordEventPositionBatch(responder, eventId, uuid(915), {
      schemaVersion: "2.0",
      eventId,
      batchId: uuid(915),
      records: [{
        recordId: uuid(916),
        slotAt: atOffset(25),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    }),
    assertHttpProblem(409, /active time window/)
  );
});

test("status confirmation requests at T+30, restarts on CONTINUE, and closes only at T+35", async () => {
  const { harness, patient, eventId } = await seedScenario(0);
  harness.setNow(atOffset(1_800 - 1));
  await harness.service.tick();
  assert.equal(harness.store.read((state) => state.events[eventId]?.statusConfirmation), undefined);
  harness.setNow(atOffset(1_800));
  await harness.service.tick();
  const first = harness.store.read((state) => state.events[eventId]?.statusConfirmation);
  assert.ok(first);
  assert.equal(first.state, "PENDING");
  assert.equal(first.responseDeadlineAt, atOffset(2_100));
  assert.equal(
    asPatientView(harness.service.getEvent(patient, eventId)).statusConfirmation?.confirmationId,
    first.confirmationId
  );
  const requestedCount = harness.emissions.filter((emission) =>
    emission.name === "event:status-confirmation-requested"
  ).length;
  await harness.service.tick();
  assert.equal(
    harness.emissions.filter((emission) => emission.name === "event:status-confirmation-requested").length,
    requestedCount
  );

  harness.setNow(atOffset(2_099));
  await harness.service.tick();
  assert.equal(harness.store.read((state) => state.events[eventId]?.state), "ACTIVE");
  harness.setNow(atOffset(2_100));
  await harness.service.tick();
  const closed = harness.store.read((state) => state.events[eventId]);
  assert.equal(closed?.state, "CLOSED_UNCONFIRMED_NO_RESPONSE");
  assert.equal(closed?.recruitmentState, "STOPPED");
  assert.equal(closed?.terminalReason, "CLOSED_UNCONFIRMED_NO_RESPONSE");
  assert.equal(closed?.statusConfirmationHistory?.[0]?.state, "CLOSED_UNCONFIRMED_NO_RESPONSE");
  assert.ok((harness.store.read((state) => state.timelineByEventId[eventId] ?? [])
    .some((entry) => entry.kind === "STATUS_CONFIRMATION_TIMED_OUT")));
  assert.ok(harness.emissions.some((emission) =>
    emission.name === "event:closed-unconfirmed-no-response"
      && emission.deviceIds.includes(patient.deviceInstanceId)
  ));
});

test("CONTINUE is idempotent and restarts a durable status-confirmation cycle", async () => {
  const { harness, patient, eventId } = await seedScenario(0);
  harness.setNow(atOffset(1_800));
  await harness.service.tick();
  const confirmation = harness.store.read((state) => state.events[eventId]?.statusConfirmation);
  assert.ok(confirmation);
  harness.setNow(atOffset(2_000));
  await assert.rejects(
    harness.service.respondToStatusConfirmation(patient, eventId, {
      confirmationId: confirmation.confirmationId,
      response: "CONTINUE",
      respondedAt: atOffset(1_799)
    }),
    assertHttpProblem(400, /respondedAt.*status confirmation sentAt/)
  );
  const request = {
    confirmationId: confirmation.confirmationId,
    response: "CONTINUE" as const,
    respondedAt: atOffset(2_050)
  };
  const continued = await harness.service.respondToStatusConfirmation(patient, eventId, request);
  assert.equal(continued.idempotent, false);
  assert.equal(continued.respondedAt, atOffset(2_000));
  assert.equal(continued.nextCheckAt, atOffset(3_800));
  assert.equal(harness.store.read((state) => state.events[eventId]?.state), "ACTIVE");
  harness.setNow(atOffset(2_025));
  const replay = await harness.service.respondToStatusConfirmation(patient, eventId, request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.respondedAt, atOffset(2_000));
  harness.setNow(atOffset(2_100));
  await harness.service.tick();
  assert.equal(harness.store.read((state) => state.events[eventId]?.state), "ACTIVE");
  harness.setNow(atOffset(3_800));
  await harness.service.tick();
  const state = harness.store.read((current) => current.events[eventId]);
  assert.equal(state?.state, "ACTIVE");
  assert.equal(state?.statusConfirmationHistory?.length, 2);
  assert.equal(state?.statusConfirmation?.state, "PENDING");
});


test("expired Watch trigger recovery replays only the existing exact observation without recreating a terminal event", async () => {
  const { harness, patient, watch, eventId } = await seedScenario(0);
  const report = observation(eventId);
  harness.setNow(atOffset(20));
  await harness.service.endEvent(patient, eventId, {
    resolutionId: uuid(43_001), reason: "PROBLEM_RESOLVED", endedAt: atOffset(20)
  });
  const before = harness.store.read(state => ({ event: state.events[eventId], timeline: state.timelineByEventId[eventId],
    tasks: state.assignments, messages: state.notificationOutboxById }));
  harness.setNow(atOffset(7200));
  assert.equal(harness.service.getWatchEventState(watch, eventId).state, "RESOLVED");
  const recovered = await harness.service.reportWatchObservation(watch, eventId, report);
  assert.equal(recovered.created, false);
  assert.equal(recovered.event.state, "RESOLVED");
  assert.deepEqual(harness.store.read(state => ({ event: state.events[eventId], timeline: state.timelineByEventId[eventId],
    tasks: state.assignments, messages: state.notificationOutboxById })), before);
  await assert.rejects(harness.service.reportWatchObservation(watch, eventId, { ...report, fallResolution: "DISMISSED" }),
    assertHttpProblem(409, /different Watch observation/));
  const unknown = uuid(43_002);
  await assert.rejects(harness.service.reportWatchObservation(watch, unknown, { ...report, eventId: unknown }),
    assertHttpProblem(400, /35-minute/));
  assert.equal(harness.store.read(state => state.events[unknown]), undefined);
});


test("Watch absent snapshot may precede a trigger transaction already admitted before the creation deadline", async () => {
  const h = makeHarness();
  const pair = uuid(43_011);
  await bootstrapIPhone(h, uuid(43_012), pair);
  const watch = await bootstrapWatch(h, uuid(43_013), pair);
  const id = uuid(43_014);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = h.store.transact(async () => { entered(); await gate; });
  await ready;
  const incoming = h.service.reportWatchObservation(watch, id, observation(id));
  try {
    h.setNow(atOffset(3600));
    assert.throws(() => h.service.getWatchEventState(watch, id), assertHttpProblem(404, /does not exist/));
  } finally { release(); }
  await held;
  assert.equal((await incoming).created, true);
  assert.equal(h.service.getWatchEventState(watch, id).state, "ACTIVE");
  assert.equal((await h.service.reportWatchObservation(watch, id, observation(id))).created, false);
});


test("Watch state recovery uses only selected entities and preserves original projection and denial semantics", async () => {
  const { harness, watch, patient, eventId } = await seedScenario(0);
  const expected = harness.service.getWatchEventState(watch, eventId);
  const previousRead = harness.store.read;
  harness.store.read = () => { throw new Error("legacy full-state read was used"); };
  try {
    assert.deepEqual(harness.service.getWatchEventState(watch, eventId), expected);
    assert.throws(() => harness.service.getWatchEventState(patient, eventId), assertHttpProblem(403));
    assert.throws(() => harness.service.getWatchEventState(watch, uuid(44_001)), assertHttpProblem(404));
    assert.throws(() => harness.service.getWatchEventState({ ...watch, deviceInstanceId: uuid(44_002) }, eventId), assertHttpProblem(403));
  } finally { harness.store.read = previousRead; }
});


test("Watch creation rolls back atomically and activation outbox survives lost dispatch ACK", async () => {
  const base = new MemoryStateStore(emptyState(aeds));
  const eventId = uuid(49_001);
  let failCreate = false;
  let failAck = false;
  const wrapped: StateStore = {
    read: reader => base.read(reader),
    readEntities: reader => base.readEntities(reader),
    transact: mutation => base.transact(async state => {
      const previous = structuredClone(state.notificationOutboxById);
      const result = await mutation(state);
      if (failCreate && state.events[eventId]) throw new Error("injected event commit failure");
      if (failAck && Object.values(state.notificationOutboxById).some(row =>
        row.name === "event:patient-activated" && row.status === "DISPATCHED" && previous[row.id]?.status === "PENDING")) {
        failAck = false;
        throw new Error("injected activation ACK failure");
      }
      return result;
    })
  };
  const first = makeHarness({}, wrapped);
  const patient = await bootstrapIPhone(first, uuid(49_002), uuid(49_003));
  const watch = await bootstrapWatch(first, uuid(49_004), uuid(49_003));
  const before = base.read(state => state);
  failCreate = true;
  await assert.rejects(first.service.reportWatchObservation(watch, eventId, observation(eventId)));
  assert.deepEqual(base.read(state => state), before);
  failCreate = false;
  failAck = true;
  assert.equal((await first.service.reportWatchObservation(watch, eventId, observation(eventId))).created, true);
  const firstActivation = first.emissions.find(item => item.name === "event:patient-activated")!;
  assert.ok(firstActivation);
  const restarted = makeHarness({}, base);
  restarted.setNow(atOffset(10));
  await restarted.service.tick();
  const replay = restarted.emissions.find(item => item.name === "event:patient-activated");
  assert.deepEqual(replay, firstActivation);
  assert.equal((await restarted.service.reportWatchObservation(watch, eventId, observation(eventId))).created, false);
  assert.equal(base.read(state => Object.keys(state.events).length), 1);
  assert.equal(base.read(state => state.devices[patient.deviceInstanceId]!.currentEventId), eventId);
});


test("answered status-confirmation notification is suppressed when delayed outbox retries", async () => {
  const { harness, patient, eventId } = await seedScenario(0);
  harness.service.setPublisher({ emitToDevices: () => [] });
  harness.setNow(atOffset(1800));
  await harness.service.tick();
  const confirmation = harness.store.read(state => state.events[eventId]!.statusConfirmation)!;
  assert.ok(confirmation);
  harness.setNow(atOffset(1801));
  await harness.service.respondToStatusConfirmation(patient, eventId, {
    confirmationId: confirmation.confirmationId, response: "CONTINUE", respondedAt: atOffset(1801)
  });
  const sent: string[] = [];
  harness.service.setPublisher({ emitToDevices: (ids, name) => { sent.push(name); return ids; } });
  harness.setNow(atOffset(1810));
  await harness.service.tick();
  assert.ok(!sent.includes("event:status-confirmation-requested"));
  assert.equal(harness.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "event:status-confirmation-requested")?.status), "SUPPRESSED");
});


test("reachable iPhone admits Watch only after server silence and never promotes expired candidate", async () => {
  const { harness, watch, patient, eventId } = await seedScenario(0);
  harness.setNow(atOffset(1));
  assert.equal(harness.service.getWatchEventState(watch, eventId).fallbackAllowed, false);
  await publishWatchFallbackPosition(harness, watch, eventId, uuid(49_101), atOffset(1), 22.25);
  harness.setNow(atOffset(700));
  const old = await publishWatchFallbackPosition(harness, watch, eventId, uuid(49_101), atOffset(1), 22.25);
  assert.equal(old.applied, false);
  assert.notEqual(asPatientView(harness.service.getEvent(patient, eventId)).patientPositionSource, "WATCH_FALLBACK");
  assert.equal(harness.service.getWatchEventState(watch, eventId).fallbackAllowed, true);
  const fresh = await publishWatchFallbackPosition(harness, watch, eventId, uuid(49_102), atOffset(700), 22.26, "ACTIVATED", true);
  assert.equal(fresh.applied, true);
});


test("prepared walking quotes supply committed AED assignments instead of geometric distance", async () => {
  const provider = new AmapAedRouteProvider({ route: async input => ({ kind: "AVAILABLE", value: {
    aedId: input.aed.id, path: [input.responder, input.aed.aedPosition, input.patient],
    distanceMeters: 331, distanceSource: "AMAP_WALKING"
  } }) });
  const harness = makeHarness({}, new MemoryStateStore(emptyState(aeds)), provider);
  const scenario = await seedScenario(2, harness);
  await accept(harness, scenario.responders[0]!, scenario.eventId, 0);
  await accept(harness, scenario.responders[1]!, scenario.eventId, 1);
  const assigned = harness.store.read(state => Object.values(state.assignments)
    .find(assignment => assignment.role === "FETCH_AED"));
  assert.ok(assigned?.route);
  assert.equal(assigned.route.distanceSource, "AMAP_WALKING");
  assert.equal(assigned.route.distanceMeters, 331);
});

test("client MapKit distances require accepted membership and server confirmation before AED assignment", async () => {
  const harness = makeHarness({ navigationMode: "CLIENT_MAPKIT" });
  const { responders, patient, eventId } = await seedScenario(2, harness);
  assert.throws(() => harness.service.clientAedRouteContext(responders[0]!, eventId), assertHttpProblem(403));
  await accept(harness, responders[0]!, eventId, 0);
  await accept(harness, responders[1]!, eventId, 1);
  assert.equal(harness.store.read(state => Object.values(state.assignments).filter(a => a.role === "FETCH_AED").length), 0);
  const context = harness.service.clientAedRouteContext(responders[0]!, eventId)!;
  assert.ok(context.aeds.length > 0);
  const submission = { calculationId: context.calculationId, routes: context.aeds.map((aed, i) => ({
    aedId: aed.id,
    toAedMeters: distanceMeters(context.responder, aed.aedPosition) + 100 + i * 500,
    toPatientMeters: distanceMeters(aed.aedPosition, context.patient) + 100
  })) };
  await assert.rejects(harness.service.submitClientAedRoutes(responders[1]!, eventId, submission), assertHttpProblem(409));
  const result = await harness.service.submitClientAedRoutes(responders[0]!, eventId, submission);
  assert.equal("currentAssignment" in result && result.currentAssignment?.role, "FETCH_AED");
  const assignment = harness.store.read(state => Object.values(state.assignments).find(a => a.role === "FETCH_AED"));
  assert.equal(assignment?.route?.distanceSource, "CLIENT_MAPKIT");
  assert.equal(assignment?.route?.distanceMeters, submission.routes[0]!.toAedMeters + submission.routes[0]!.toPatientMeters);
  await harness.store.transact(state => { state.assignments[assignment!.id]!.status = "EN_ROUTE"; });
  const otherContext = harness.service.clientAedRouteContext(responders[1]!, eventId)!;
  await harness.service.submitClientAedRoutes(responders[1]!, eventId, {
    calculationId: otherContext.calculationId, routes: otherContext.aeds.map(aed => ({ aedId: aed.id,
      toAedMeters: distanceMeters(otherContext.responder, aed.aedPosition) + 10,
      toPatientMeters: distanceMeters(aed.aedPosition, otherContext.patient) + 10 }))
  });
  assert.equal(harness.store.read(state => Object.values(state.assignments).filter(a => a.role === "FETCH_AED").length), 1);
  assert.equal(harness.store.read(state => state.assignments[assignment!.id]!.deviceInstanceId), responders[0]!.deviceInstanceId);
  await assert.rejects(harness.service.submitClientAedRoutes(patient, eventId, submission), assertHttpProblem(403));
  harness.setNow(atOffset(80));
  await assert.rejects(harness.service.submitClientAedRoutes(responders[0]!, eventId, submission), assertHttpProblem(409));
});
