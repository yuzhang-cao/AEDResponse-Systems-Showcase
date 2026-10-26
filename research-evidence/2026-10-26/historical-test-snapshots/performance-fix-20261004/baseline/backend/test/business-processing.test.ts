import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BackendConfig } from "../src/config.js";
import type {
  EventPositionBatch,
  ResponderPosition,
  WatchEmergencyObservation
} from "../src/contracts.js";
import { distanceMeters } from "../src/domain.js";
import { HttpProblem } from "../src/errors.js";
import {
  AEDResponseService,
  type AccountPrincipal,
  type DevicePrincipal,
  type RealtimeEventName,
  type RealtimePublisher
} from "../src/service.js";
import { SQLiteStateStore } from "../src/store.js";

// These scenarios begin with already-decoded business data. No transport or
// production authentication provider is constructed by this test harness.
const BASE_TIME = "2026-09-05T01:00:00.000Z";
const PATIENT_POSITION = {
  kind: "P" as const, latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12
};
const RESPONDER_POSITION = {
  kind: "R" as const, latitude: 22.198, longitude: 113.543, accuracyMeters: 10
};
const SUMMARY_CENTER = {
  kind: "R" as const,
  latitude: PATIENT_POSITION.latitude,
  longitude: PATIENT_POSITION.longitude,
  accuracyMeters: 10
};

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function at(seconds: number): string {
  return new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();
}

function responderAtMeters(meters: number): ResponderPosition {
  const latitudeDelta = meters / 6_371_008.8 * 180 / Math.PI;
  return {
    kind: "R",
    latitude: PATIENT_POSITION.latitude + latitudeDelta,
    longitude: PATIENT_POSITION.longitude,
    accuracyMeters: 10
  };
}

function responderAtInclusiveBoundary(meters: number): ResponderPosition {
  let low = SUMMARY_CENTER.latitude;
  let high = SUMMARY_CENTER.latitude + meters / 6_371_008.8 * 180 / Math.PI;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const middle = (low + high) / 2;
    const candidate = {
      ...SUMMARY_CENTER,
      latitude: middle
    };
    if (distanceMeters(SUMMARY_CENTER, candidate) <= meters) low = middle;
    else high = middle;
  }
  return {
    ...SUMMARY_CENTER,
    latitude: low
  };
}

interface Emission {
  deviceIds: string[];
  name: RealtimeEventName;
  payload: unknown;
}

async function makeHarness(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-business-processing-"));
  const sqliteFile = join(directory, "state.sqlite");
  let store: SQLiteStateStore | undefined;
  t.after(async () => {
    try {
      await store?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  let now = new Date(BASE_TIME);
  const emissions: Emission[] = [];
  const publisher: RealtimePublisher = {
    emitToDevices(deviceIds, name, payload) {
      emissions.push({ deviceIds: [...deviceIds], name, payload: structuredClone(payload) });
      return deviceIds;
    }
  };
  const config: BackendConfig = {
    host: "127.0.0.1",
    port: 0,
    dataFile: sqliteFile,
    fixtureFile: join(directory, "unused-fixture.json"),
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    production: false
  };
  store = await SQLiteStateStore.open(sqliteFile, []);
  let service = new AEDResponseService(store, config, publisher, () => now);
  return {
    get service() { return service; },
    get store() { return store!; },
    emissions,
    setNow(seconds: number) { now = new Date(at(seconds)); },
    async reopen() {
      await store!.close();
      store = await SQLiteStateStore.open(sqliteFile, []);
      service = new AEDResponseService(store, config, publisher, () => now);
    }
  };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

async function bootstrapIPhone(h: Harness, id: number, sameUser?: DevicePrincipal) {
  const request = {
    deviceInstanceId: uuid(id),
    companionPairId: uuid(id + 100),
    deviceKind: "IPHONE" as const,
    agreementAcceptances: [
      { kind: "PATIENT" as const, version: "2.0", acceptedAt: BASE_TIME },
      { kind: "VOLUNTEER_RESPONDER" as const, version: "2.0", acceptedAt: BASE_TIME },
      { kind: "PRIVACY_POLICY" as const, version: "2.0", acceptedAt: BASE_TIME },
      { kind: "SENSITIVE_PERSONAL_INFORMATION" as const, version: "2.0", acceptedAt: BASE_TIME }
    ],
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  };
  // Reuse a synthetic direct-bootstrap identity to model its second phone;
  // this principal is test-only and never comes from a login endpoint.
  const account: AccountPrincipal | undefined = sameUser ? {
    kind: "ACCOUNT",
    tokenHash: sameUser.tokenHash,
    sessionId: sameUser.sessionId,
    userId: sameUser.userId!,
    accountId: sameUser.accountId!,
    scopes: ["session:bootstrap"],
    expiresAt: sameUser.expiresAt
  } : undefined;
  const session = account
    ? await h.service.bootstrap(account, request, `synthetic:${id}`)
    : await h.service.bootstrap(request, `synthetic:${id}`);
  const principal = h.service.authenticateToken(session.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Expected synthetic device principal");
  return { principal, token: session.sessionToken };
}

async function activate(h: Harness) {
  const patient = await bootstrapIPhone(h, 1);
  const session = await h.service.bootstrap({
    deviceInstanceId: uuid(2),
    deviceKind: "WATCH",
    companionPairId: patient.principal.companionPairId
  }, "synthetic:watch");
  const watch = h.service.authenticateToken(session.sessionToken);
  assert.equal(watch.kind, "DEVICE");
  if (watch.kind !== "DEVICE") throw new Error("Expected synthetic Watch principal");
  const eventId = uuid(500);
  const observation: WatchEmergencyObservation = {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1),
    patientPositionObservedAt: at(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: PATIENT_POSITION
  };
  h.setNow(1);
  const result = await h.service.reportWatchObservation(watch, eventId, observation);
  assert.equal(result.created, true);
  return { patient, watch, eventId, observation };
}

function batch(eventId: string, id: number, seconds: number[], kind: "P" | "R" = "P"):
EventPositionBatch {
  return {
    schemaVersion: "2.0",
    eventId,
    batchId: uuid(id),
    records: seconds.map((second, index) => index % 2 === 0 ? {
      recordId: uuid(id + index + 1),
      slotAt: at(second),
      status: "FIX" as const,
      fixObservedAt: at(second + 0.5),
      position: kind === "P"
        ? { ...PATIENT_POSITION, latitude: PATIENT_POSITION.latitude + second * 0.000001 }
        : { ...RESPONDER_POSITION, latitude: RESPONDER_POSITION.latitude + second * 0.000001 }
    } : {
      recordId: uuid(id + index + 1),
      slotAt: at(second),
      status: "NO_NEW_FIX" as const,
      gapReason: "NO_FIX" as const
    })
  };
}

function submit(h: Harness, principal: DevicePrincipal, value: EventPositionBatch) {
  return h.service.recordEventPositionBatch(principal, value.eventId, value.batchId, value);
}

function problem(status: number, detail?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, status);
    if (detail) assert.match(error.detail, detail);
    return true;
  };
}

function assertCoarsePrivacy(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertCoarsePrivacy);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(![
      "latitude", "longitude", "patientPosition", "patientLocationCard", "patientUserId",
      "triggerSource", "fallDetectedAt", "fallResolution", "appHelpResponse",
      "callFirstObservedAt", "coordination", "currentAssignment"
    ].includes(key), `candidate payload leaked ${key}`);
    assertCoarsePrivacy(child);
  }
}

test("business lifecycle: neutral R, patient P, private offers, acceptance, exit and durable replay", async (t) => {
  const h = await makeHarness(t);
  const responder = await bootstrapIPhone(h, 3);
  assert.equal((await h.service.getPresence(responder.principal)).positioningTier, "STANDBY");
  await h.service.updateResponderPosition(responder.principal, {
    positionUpdateId: uuid(600), observedAt: at(0), responderPosition: RESPONDER_POSITION
  });
  h.setNow(0.5);
  await h.service.updateResponderPosition(responder.principal, {
    positionUpdateId: uuid(601), observedAt: at(0.5),
    responderPosition: { ...RESPONDER_POSITION, latitude: 22.1981 }
  });
  assert.equal(h.store.read((state) => state.devices[uuid(3)]?.latestPosition?.positionUpdateId), uuid(601));
  assert.deepEqual(h.store.read((state) => state.eventPositionBatchesById), {});

  const { patient, watch, eventId, observation } = await activate(h);
  const secondPhone = await bootstrapIPhone(h, 4, patient.principal);
  assert.equal(secondPhone.principal.userId, patient.principal.userId);
  const pending = h.service.getEvent(responder.principal, eventId);
  assert.equal(pending.viewerRelationship, "NEUTRAL");
  assert.equal(pending.positioningTier, "SEARCH_RING");
  assert.equal(pending.canPublishEventPosition, false);
  assertCoarsePrivacy(pending);
  const delivery = h.store.read((state) => Object.values(state.deliveries)
    .find((candidate) => candidate.eventId === eventId && candidate.deviceInstanceId === uuid(3)));
  assert.ok(delivery);
  const offers = h.emissions.filter((item) => item.name === "response:requested"
    && item.deviceIds.includes(uuid(3)));
  assert.equal(offers.length, 1);
  offers.forEach((item) => assertCoarsePrivacy(item.payload));

  h.setNow(6);
  await assert.rejects(submit(h, responder.principal, batch(eventId, 700, [2], "R")), problem(403));
  const patientBatch = batch(eventId, 710, [1, 2, 3, 4, 5]);
  const firstAck = await submit(h, patient.principal, patientBatch);
  assert.equal(firstAck.acceptedRecordCount, 5);
  assert.equal(firstAck.idempotent, false);
  assert.equal(firstAck.records.filter((record) => record.appliedToLatest).length, 3);
  const patientView = h.service.getEvent(patient.principal, eventId);
  assert.equal(patientView.viewerRelationship, "PATIENT");
  assert.equal(patientView.canPublishEventPosition, true);
  const secondView = h.service.getEvent(secondPhone.principal, eventId);
  assert.equal(secondView.viewerRelationship, "PATIENT");
  assert.equal(secondView.canPublishEventPosition, false);
  assert.equal(secondView.eventPositionParticipationStartedAt, null);
  assert.deepEqual(secondView.patientPosition, patientView.patientPosition);
  await assert.rejects(submit(h, secondPhone.principal, batch(eventId, 720, [2])), problem(403));
  for (const phone of [patient, secondPhone]) {
    await assert.rejects(h.service.updateResponderPosition(phone.principal, {
      positionUpdateId: uuid(phone === patient ? 730 : 731),
      observedAt: at(6), responderPosition: RESPONDER_POSITION
    }), problem(409, /active patient/));
  }
  h.emissions.filter((item) => item.deviceIds.includes(uuid(3)))
    .forEach((item) => assertCoarsePrivacy(item.payload));

  h.setNow(10);
  const accepted = await h.service.respond(responder.principal, eventId, delivery.id, {
    decision: "ACCEPT", decidedAt: at(10)
  });
  assert.equal(accepted.assignment?.role, "GO_TO_PATIENT");
  const responderView = h.service.getEvent(responder.principal, eventId);
  assert.equal(responderView.viewerRelationship, "RESPONDER");
  assert.equal(responderView.canPublishEventPosition, true);
  assert.deepEqual(responderView.patientPosition, patientView.patientPosition);
  assert.equal(responderView.coordination?.acceptedResponderCount, 1);
  h.setNow(15);
  const responderBatch = batch(eventId, 740, [10, 11, 12, 13, 14], "R");
  assert.equal((await submit(h, responder.principal, responderBatch)).acceptedRecordCount, 5);

  h.setNow(20);
  const exit = {
    exitId: uuid(750),
    exitedAt: at(20),
    reason: "synthetic responder unavailable",
    soleResponderConfirmed: true as const
  };
  assert.equal((await h.service.exitEvent(responder.principal, eventId, exit)).idempotent, false);
  assert.throws(() => h.service.getEvent(responder.principal, eventId), problem(404));
  assert.deepEqual(h.service.listEvents(responder.principal), []);
  assert.equal((await h.service.getPresence(responder.principal)).position, null);
  const lateBatch = batch(eventId, 760, [15, 16, 17, 18, 19], "R");
  const lateAck = await submit(h, responder.principal, lateBatch);
  assert.equal(lateAck.acceptedRecordCount, 5);
  assert.ok(lateAck.records.every((record) => !record.appliedToLatest));
  assert.equal((await h.service.getPresence(responder.principal)).position, null);
  await assert.rejects(submit(h, responder.principal, batch(eventId, 770, [20], "R")), problem(409));
  const otherResponderPhone = await bootstrapIPhone(h, 5, responder.principal);
  for (const phone of [responder, otherResponderPhone]) {
    await assert.rejects(h.service.respond(phone.principal, eventId, delivery.id, {
      decision: "ACCEPT", decidedAt: at(20)
    }), problem(403, /exited responder/));
  }
  const emissionBoundary = h.emissions.length;
  h.setNow(22);
  await submit(h, patient.principal, batch(eventId, 780, [20, 21]));
  assert.ok(h.emissions.slice(emissionBoundary).every((item) =>
    !item.deviceIds.includes(uuid(3)) && !item.deviceIds.includes(uuid(5))));

  const beforeRestart = h.store.read((state) => ({
    batches: state.eventPositionBatchesById,
    intervals: state.participantIntervalsById,
    timeline: state.timelineByEventId[eventId]
  }));
  await h.reopen();
  assert.equal(h.service.authenticateToken(patient.token).kind, "DEVICE");
  assert.equal(h.service.authenticateToken(responder.token).kind, "DEVICE");
  const replayEmissionBoundary = h.emissions.length;
  assert.equal((await h.service.reportWatchObservation(watch, eventId, observation)).created, false);
  assert.deepEqual(await submit(h, patient.principal, patientBatch), { ...firstAck, idempotent: true });
  assert.deepEqual(await submit(h, responder.principal, lateBatch), { ...lateAck, idempotent: true });
  assert.equal((await h.service.exitEvent(responder.principal, eventId, exit)).idempotent, true);
  assert.deepEqual(h.store.read((state) => ({
    batches: state.eventPositionBatchesById,
    intervals: state.participantIntervalsById,
    timeline: state.timelineByEventId[eventId]
  })), beforeRestart);
  assert.equal(h.emissions.length, replayEmissionBoundary);
  assert.throws(() => h.service.getEvent(responder.principal, eventId), problem(404));
});

test("concurrent identical batches append once and conflicting same-second batches have one winner", async (t) => {
  const h = await makeHarness(t);
  const { patient, eventId } = await activate(h);
  h.setNow(10);
  const value = batch(eventId, 800, [1, 2, 3, 4, 5]);
  const acks = await Promise.all(Array.from({ length: 3 }, () => submit(h, patient.principal, value)));
  assert.equal(acks.filter((ack) => !ack.idempotent).length, 1);
  assert.equal(acks.filter((ack) => ack.idempotent).length, 2);
  assert.equal(h.store.read((state) => Object.keys(state.eventPositionBatchesById).length), 1);
  const alternatives = [batch(eventId, 810, [6]), batch(eventId, 820, [6])];
  const raced = await Promise.allSettled(alternatives.map((candidate) => submit(h, patient.principal, candidate)));
  assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = raced.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  problem(409, /slotAt/)(rejected.reason);
  const evidence = h.store.read((state) => Object.values(state.eventPositionBatchesById)
    .flatMap((stored) => stored.records));
  assert.equal(evidence.length, 6);
  assert.equal(new Set(evidence.map((record) => record.slotAt)).size, 6);
});

test("a rejected mixed batch leaves evidence, latest projection and emissions unchanged", async (t) => {
  const h = await makeHarness(t);
  const { patient, eventId } = await activate(h);
  h.setNow(10);
  await submit(h, patient.principal, batch(eventId, 900, [2]));
  const before = h.store.read((state) => state);
  const emissionBoundary = h.emissions.length;
  await assert.rejects(submit(h, patient.principal, batch(eventId, 910, [1, 2])), problem(409, /slotAt/));
  assert.deepEqual(h.store.read((state) => state), before);
  assert.equal(h.emissions.length, emissionBoundary);
  assert.equal((await submit(h, patient.principal, batch(eventId, 920, [1]))).acceptedRecordCount, 1);
});

test("an unfinished final second rejects the whole batch then accepts the original retry at the boundary", async (t) => {
  const h = await makeHarness(t);
  const { patient, eventId } = await activate(h);
  const value = batch(eventId, 1_000, [1, 2, 3, 4, 5]);
  h.setNow(5.999);
  const before = h.store.read((state) => state);
  const emissionBoundary = h.emissions.length;
  await assert.rejects(submit(h, patient.principal, value), problem(425));
  assert.deepEqual(h.store.read((state) => state), before);
  assert.equal(h.emissions.length, emissionBoundary);
  h.setNow(6);
  assert.equal((await submit(h, patient.principal, value)).acceptedRecordCount, 5);
});

test("sixty participant seconds recover out of order without fabricated fixes or latest-position regression", async (t) => {
  const h = await makeHarness(t);
  const { patient, eventId } = await activate(h);
  h.setNow(61);
  const values = Array.from({ length: 12 }, (_, index) => batch(
    eventId, 2_000 + index * 10,
    Array.from({ length: 5 }, (_, slot) => 1 + index * 5 + slot)
  ));
  for (const value of [...values].reverse()) await submit(h, patient.principal, value);
  const records = h.store.read((state) => Object.values(state.eventPositionBatchesById)
    .flatMap((stored) => stored.records));
  assert.equal(records.length, 60);
  assert.deepEqual(records.map((record) => record.slotAt).sort(),
    Array.from({ length: 60 }, (_, index) => at(index + 1)));
  assert.equal(records.filter((record) => record.status === "FIX").length, 36);
  assert.equal(records.filter((record) => record.status === "NO_NEW_FIX").length, 24);
  assert.ok(records.filter((record) => record.status === "NO_NEW_FIX")
    .every((record) => !("position" in record) && !("fixObservedAt" in record)));
  assert.equal(h.service.getEvent(patient.principal, eventId).patientPositionObservedAt, at(60.5));
  await h.reopen();
  for (const value of values) assert.equal((await submit(h, patient.principal, value)).idempotent, true);
  assert.equal(h.store.read((state) => Object.values(state.eventPositionBatchesById)
    .reduce((count, stored) => count + stored.records.length, 0)), 60);
  assert.equal(h.service.getEvent(patient.principal, eventId).patientPositionObservedAt, at(60.5));
});

test("nearby volunteer summary uses the viewer R sample and cumulative unique users", async (t) => {
  const h = await makeHarness(t);
  const viewer = await bootstrapIPhone(h, 3_000);
  await h.service.updateResponderPosition(viewer.principal, {
    positionUpdateId: uuid(3_100),
    observedAt: at(0),
    responderPosition: responderAtMeters(0)
  });
  const viewerSecondPhone = await bootstrapIPhone(h, 3_006, viewer.principal);
  await h.service.updateResponderPosition(viewerSecondPhone.principal, {
    positionUpdateId: uuid(3_206),
    observedAt: at(0),
    responderPosition: responderAtMeters(500)
  });

  const withinOneKilometre = await bootstrapIPhone(h, 3_001);
  const sameUserSecondPhone = await bootstrapIPhone(h, 3_002, withinOneKilometre.principal);
  const withinOneAndHalfKilometres = await bootstrapIPhone(h, 3_003);
  const withinTwoKilometres = await bootstrapIPhone(h, 3_004);
  const outsideTwoKilometres = await bootstrapIPhone(h, 3_005);
  for (const [device, meters, sequence] of [
    [withinOneKilometre, 800, 3_201],
    [sameUserSecondPhone, 1_900, 3_202],
    [withinOneAndHalfKilometres, 1_200, 3_203],
    [withinTwoKilometres, 1_800, 3_204],
    [outsideTwoKilometres, 2_100, 3_205]
  ] as const) {
    await h.service.updateResponderPosition(device.principal, {
      positionUpdateId: uuid(sequence),
      observedAt: at(0),
      responderPosition: responderAtMeters(meters)
    });
  }

  const before = h.store.read((state) => structuredClone(state));
  const summary = h.service.getNearbyVolunteerSummary(viewer.principal);
  assert.equal(summary.generatedAt, at(0));
  assert.deepEqual(Object.keys(summary).sort(), ["generatedAt", "ranges"]);
  assert.ok(summary.ranges.every((range) =>
    Object.keys(range).sort().join(",") === "count,radiusMeters"
  ));
  assert.deepEqual(summary.ranges, [
    { radiusMeters: 1_000, count: 1 },
    { radiusMeters: 1_500, count: 2 },
    { radiusMeters: 2_000, count: 3 }
  ]);
  assert.ok(summary.ranges[0]!.count <= summary.ranges[1]!.count);
  assert.ok(summary.ranges[1]!.count <= summary.ranges[2]!.count);
  assert.deepEqual(h.store.read((state) => state), before);
});

test("nearby volunteer summary requires a fresh viewer location and excludes unusable responders", async (t) => {
  const h = await makeHarness(t);
  const viewer = await bootstrapIPhone(h, 3_010);
  await assert.rejects(
    async () => h.service.getNearbyVolunteerSummary(viewer.principal),
    problem(422, /fresh responder position/i)
  );

  await h.service.updateResponderPosition(viewer.principal, {
    positionUpdateId: uuid(3_110),
    observedAt: at(0),
    responderPosition: responderAtMeters(0)
  });
  await h.service.updatePresence(viewer.principal, {
    presenceUpdateId: uuid(3_210),
    occurredAt: at(1),
    availableForResponse: false,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  await assert.rejects(
    async () => h.service.getNearbyVolunteerSummary(viewer.principal),
    problem(403, /available/i)
  );
  await h.service.updatePresence(viewer.principal, {
    presenceUpdateId: uuid(3_211),
    occurredAt: at(2),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  await h.service.updatePresence(viewer.principal, {
    presenceUpdateId: uuid(3_212),
    occurredAt: at(3),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: false }
  });
  await assert.rejects(
    async () => h.service.getNearbyVolunteerSummary(viewer.principal),
    problem(403, /permissions/i)
  );
  await h.service.updatePresence(viewer.principal, {
    presenceUpdateId: uuid(3_213),
    occurredAt: at(4),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  const noPosition = await bootstrapIPhone(h, 3_011);
  const unavailable = await bootstrapIPhone(h, 3_012);
  const noNotification = await bootstrapIPhone(h, 3_013);
  const stale = await bootstrapIPhone(h, 3_014);
  await h.service.updateResponderPosition(unavailable.principal, {
    positionUpdateId: uuid(3_112), observedAt: at(0), responderPosition: responderAtMeters(500)
  });
  await h.service.updatePresence(unavailable.principal, {
    presenceUpdateId: uuid(3_214),
    occurredAt: at(1),
    availableForResponse: false,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  await h.service.updateResponderPosition(noNotification.principal, {
    positionUpdateId: uuid(3_113), observedAt: at(0), responderPosition: responderAtMeters(500)
  });
  await h.service.updatePresence(noNotification.principal, {
    presenceUpdateId: uuid(3_215),
    occurredAt: at(1),
    availableForResponse: true,
    capabilities: { notificationAuthorized: false, locationAuthorized: true }
  });
  await h.service.updateResponderPosition(stale.principal, {
    positionUpdateId: uuid(3_114), observedAt: at(0), responderPosition: responderAtMeters(500)
  });

  // Permission/availability exclusions are evaluated while all samples are
  // fresh, so they cannot be accidentally masked by the later stale check.
  const freshSummary = h.service.getNearbyVolunteerSummary(viewer.principal);
  assert.deepEqual(freshSummary.ranges, [
    { radiusMeters: 1_000, count: 1 },
    { radiusMeters: 1_500, count: 1 },
    { radiusMeters: 2_000, count: 1 }
  ]);

  h.setNow(601);
  await h.service.updateResponderPosition(viewer.principal, {
    positionUpdateId: uuid(3_111),
    observedAt: at(601),
    responderPosition: responderAtMeters(0)
  });

  const summary = h.service.getNearbyVolunteerSummary(viewer.principal);
  assert.deepEqual(summary.ranges, [
    { radiusMeters: 1_000, count: 0 },
    { radiusMeters: 1_500, count: 0 },
    { radiusMeters: 2_000, count: 0 }
  ]);
  assert.equal(h.store.read((state) => state.devices[noPosition.principal.deviceInstanceId]
    ?.latestPosition), undefined);
});

test("nearby volunteer summary excludes active patient and accepted responder identities", async (t) => {
  const h = await makeHarness(t);
  const { patient, eventId } = await activate(h);
  const viewer = await bootstrapIPhone(h, 3_020);
  await h.service.updateResponderPosition(viewer.principal, {
    positionUpdateId: uuid(3_120),
    observedAt: at(1),
    responderPosition: responderAtMeters(0)
  });

  // Model a stale R left on a device that is now the active patient. The
  // aggregate must exclude the stable patient identity before inspecting its
  // old sample.
  await h.store.transact((state) => {
    const patientDevice = state.devices[patient.principal.deviceInstanceId];
    if (!patientDevice) throw new Error("patient device missing from test state");
    patientDevice.latestPosition = {
      positionUpdateId: uuid(3_121),
      position: responderAtMeters(500),
      observedAt: at(1),
      serverReceivedAt: at(1)
    };
  });

  const accepted = await bootstrapIPhone(h, 3_021);
  await h.service.updateResponderPosition(accepted.principal, {
    positionUpdateId: uuid(3_122),
    observedAt: at(1),
    responderPosition: responderAtMeters(700)
  });
  const delivery = h.store.read((state) => Object.values(state.deliveries)
    .find((candidate) => candidate.eventId === eventId
      && candidate.deviceInstanceId === accepted.principal.deviceInstanceId));
  assert.ok(delivery);
  await h.service.respond(accepted.principal, eventId, delivery.id, {
    decision: "ACCEPT",
    decidedAt: at(1)
  });
  await assert.rejects(
    async () => h.service.getNearbyVolunteerSummary(accepted.principal),
    problem(403, /neutral standby/i)
  );

  const acceptedSecondPhone = await bootstrapIPhone(h, 3_022, accepted.principal);
  await h.service.updateResponderPosition(acceptedSecondPhone.principal, {
    positionUpdateId: uuid(3_123),
    observedAt: at(1),
    responderPosition: responderAtMeters(300)
  });
  // A pending offer alone does not change the viewer's neutral identity.
  // Only actual acceptance makes that user an event participant.
  const summary = h.service.getNearbyVolunteerSummary(viewer.principal);
  assert.deepEqual(summary.ranges, [
    { radiusMeters: 1_000, count: 0 },
    { radiusMeters: 1_500, count: 0 },
    { radiusMeters: 2_000, count: 0 }
  ]);
});

test("nearby volunteer summary includes the inclusive 1 km, 1.5 km and 2 km boundaries", async (t) => {
  const h = await makeHarness(t);
  const viewer = await bootstrapIPhone(h, 3_030);
  await h.service.updateResponderPosition(viewer.principal, {
    positionUpdateId: uuid(3_130),
    observedAt: at(0),
    responderPosition: responderAtMeters(0)
  });

  for (const [index, radiusMeters] of [1_000, 1_500, 2_000].entries()) {
    const candidate = await bootstrapIPhone(h, 3_031 + index);
    const position = responderAtInclusiveBoundary(radiusMeters);
    assert.ok(distanceMeters(SUMMARY_CENTER, position) <= radiusMeters);
    await h.service.updateResponderPosition(candidate.principal, {
      positionUpdateId: uuid(3_131 + index),
      observedAt: at(0),
      responderPosition: position
    });
  }

  assert.deepEqual(h.service.getNearbyVolunteerSummary(viewer.principal).ranges, [
    { radiusMeters: 1_000, count: 1 },
    { radiusMeters: 1_500, count: 2 },
    { radiusMeters: 2_000, count: 3 }
  ]);
});
