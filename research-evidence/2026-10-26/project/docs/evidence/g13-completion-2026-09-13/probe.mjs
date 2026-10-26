import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repositoryRoot, outputFile, mode = 'instrumented'] = process.argv.slice(2);
assert.ok(repositoryRoot && outputFile, 'usage: probe.mjs repositoryRoot outputFile [mode]');
const moduleAt = name => import(pathToFileURL(join(repositoryRoot, 'backend/src', name)).href);
const { AEDResponseService } = await moduleAt('service.ts');
const { MemoryStateStore, SQLiteStateStore, setShadowValidationEnabled } = await moduleAt('store.ts');
const { emptyState } = await moduleAt('models.ts');
const { distanceMeters } = await moduleAt('domain.ts');
const { DevicePositionIndex } = await moduleAt('device-position-index.ts');
const { resetMetrics, snapshotMetrics } = await moduleAt('runtime-metrics.ts');
setShadowValidationEnabled(false);

const BASE = Date.parse('2026-09-13T00:00:00.000Z');
const at = seconds => new Date(BASE + seconds * 1000).toISOString();
const uuid = value => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const P = { kind: 'P', latitude: 0, longitude: 0, accuracyMeters: 10 };
const R = { kind: 'R', latitude: [COORDINATE_REMOVED], longitude: 0, accuracyMeters: 10 };
const rows = [];
const checks = [];

function newProbe() {
  return { active: true, distanceCalls: 0, farDistanceCalls: 0, gridQueries: 0,
    gridCellsVisited: 0, gridCandidateReturns: 0, gridRebuilds: 0, gridRebuildDeviceVisits: 0 };
}

async function measure(kind, farUsers, phase, operation, summarize = value => value) {
  resetMetrics();
  const counter = newProbe();
  globalThis.__aedSpatialProbe = counter;
  let value;
  try { value = await operation(); } finally { counter.active = false; }
  const metrics = snapshotMetrics();
  const row = {
    store: kind, farUsers, totalDevices: farUsers + 5, phase,
    ...counter, active: undefined,
    candidateVisits: metrics.operation.deviceCandidatesVisited,
    stateFullCollectionKeyVisits: metrics.operation.stateFullCollectionKeyVisits,
    stateRelationKeyVisits: metrics.operation.stateRelationKeyVisits,
    stateEntityLoads: metrics.operation.stateEntityLoads,
    outboxScheduleVisits: metrics.operation.outboxScheduleVisits,
    fullStateClones: metrics.totalFullStateClones,
    fullStateFlattens: metrics.storage.fullStateFlattens,
    serializedEntities: metrics.storage.serializedEntities,
    indexedRecruitmentRuns: metrics.operation.indexedRecruitmentRuns,
    legacyRecruitmentRuns: metrics.operation.legacyRecruitmentRuns,
    outcome: summarize(value)
  };
  rows.push(row);
  return value;
}

async function makeHarness(kind) {
  let dbdir;
  if (kind === 'SQLite') dbdir = await mkdtemp(join(tmpdir(), 'aed-grid-case-'));
  const dbfile = dbdir ? join(dbdir, 'state.sqlite') : undefined;
  const store = dbfile ? await SQLiteStateStore.open(dbfile, []) : new MemoryStateStore(emptyState());
  let now = new Date(BASE);
  const config = {
    host: '127.0.0.1', port: 0, dataFile: dbfile ?? 'unused-memory',
    sessionTtlSeconds: 3600, nearbyRadiusMeters: 1000, positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120, maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100, production: false
  };
  const service = new AEDResponseService(store, config, { emitToDevices() { return []; } }, () => now);
  return {
    store, service, dbfile,
    setNow(seconds) { now = new Date(BASE + seconds * 1000); },
    async cleanup() { await store.close?.(); if (dbdir) await rm(dbdir, { recursive: true, force: true }); }
  };
}

async function phone(h, id, pairId, available = true) {
  const session = await h.service.bootstrap({
    deviceInstanceId: id, deviceKind: 'IPHONE', companionPairId: pairId,
    agreementAcceptances: ['PATIENT', 'VOLUNTEER_RESPONDER', 'PRIVACY_POLICY', 'SENSITIVE_PERSONAL_INFORMATION']
      .map(kind => ({ kind, version: '2.0', acceptedAt: at(0) })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: available
  }, `synthetic-phone:${id}`);
  return h.service.authenticateToken(session.sessionToken);
}

const inviteIds = (store, eventId) => store.read(state => Object.values(state.deliveries)
  .filter(delivery => delivery.eventId === eventId).map(delivery => delivery.deviceInstanceId).sort());

for (const kind of ['Memory', 'SQLite']) {
  for (const farUsers of [0, 250, 1000]) {
    const h = await makeHarness(kind);
    try {
      const patient = await phone(h, uuid(100), uuid(101), false);
      const watchSession = await h.service.bootstrap({ deviceInstanceId: uuid(102), deviceKind: 'WATCH',
        companionPairId: uuid(101) }, 'synthetic-watch');
      const watch = h.service.authenticateToken(watchSession.sessionToken);
      const responders = [];
      for (let i = 0; i < 3; i++) {
        const actor = await phone(h, uuid(200 + i), uuid(300 + i));
        responders.push(actor);
        await h.service.updateResponderPosition(actor, { positionUpdateId: uuid(400 + i),
          responderPosition: { ...R, latitude: [COORDINATE_REMOVED] + i * 0.0001 }, observedAt: at(0) });
      }
      await h.store.transact(state => {
        const template = state.devices[uuid(200)];
        for (let i = 0; i < farUsers; i++) {
          const device = structuredClone(template);
          device.deviceInstanceId = uuid(10000 + i);
          device.companionPairId = uuid(20000 + i);
          device.userId = uuid(30000 + i);
          device.accountId = uuid(40000 + i);
          device.latestPosition = { ...device.latestPosition, positionUpdateId: uuid(50000 + i),
            position: { kind: 'R', latitude: 30 + i * 0.00001, longitude: 120, accuracyMeters: 10 } };
          state.devices[device.deviceInstanceId] = device;
        }
      });
      const expected = responders.map(r => r.deviceInstanceId).sort();
      const exactGridIds = () => h.store.devicePositions().query(0, 0, 1000).filter(id => {
        const sample = h.store.readEntities(view => view.get('devices', id)?.latestPosition?.position);
        return sample && distanceMeters(P, sample) <= 1000;
      }).sort();

      const gridIds = await measure(kind, farUsers, 'grid_then_exact', exactGridIds);
      assert.deepEqual(gridIds, expected);
      const bruteIds = await measure(kind, farUsers, 'brute_force_control', () => h.store.read(state =>
        Object.values(state.devices).filter(device => device.latestPosition
          && distanceMeters(P, device.latestPosition.position) <= 1000)
          .map(device => device.deviceInstanceId).sort()));
      assert.deepEqual(bruteIds, gridIds);

      const eventId = uuid(600);
      h.setNow(1);
      await measure(kind, farUsers, 'create_event', () => h.service.reportWatchObservation(watch, eventId, {
        schemaVersion: '2.0', eventId, observationKind: 'FALL_CONTEXT', fallDetectedAt: at(1),
        patientPositionObservedAt: at(0), fallResolution: 'UNRESPONSIVE',
        appHelpResponse: 'NEEDS_HELP', patientPosition: P
      }), result => ({ created: result.created, invitedIds: inviteIds(h.store, eventId) }));
      assert.deepEqual(inviteIds(h.store, eventId), expected);

      h.setNow(2);
      await measure(kind, farUsers, 'responder_position', () => h.service.updateResponderPosition(responders[0], {
        positionUpdateId: uuid(700), responderPosition: { ...R, latitude: [COORDINATE_REMOVED] }, observedAt: at(2)
      }), result => ({ applied: result.applied, positioningTier: result.positioningTier,
        invitedIds: inviteIds(h.store, eventId) }));

      h.setNow(3);
      await measure(kind, farUsers, 'scheduler_tick', () => h.service.tick(), () => ({
        invitedIds: inviteIds(h.store, eventId) }));

      h.setNow(4);
      const summary = await measure(kind, farUsers, 'nearby_summary', () =>
        h.service.getNearbyVolunteerSummary(responders[0]), value => value.ranges);
      assert.ok(summary.ranges.every(range => range.count === 2));

      const deliveryId = h.store.read(state => Object.values(state.deliveries).find(delivery =>
        delivery.eventId === eventId && delivery.deviceInstanceId === responders[0].deviceInstanceId).id);
      h.setNow(5);
      await measure(kind, farUsers, 'accept_response', () => h.service.respond(responders[0], eventId, deliveryId, {
        decision: 'ACCEPT', decidedAt: at(5)
      }), () => h.store.read(state => ({
        acceptedCount: Object.values(state.deliveries).filter(delivery => delivery.eventId === eventId
          && delivery.status === 'ACCEPTED').length,
        role: Object.values(state.assignments).find(assignment => assignment.eventId === eventId
          && assignment.deviceInstanceId === responders[0].deviceInstanceId)?.role
      })));

      h.setNow(6);
      await h.service.updateResponderPosition(responders[2], { positionUpdateId: uuid(701),
        responderPosition: { ...R, latitude: 0.2 }, observedAt: at(6) });
      assert.ok(!h.store.devicePositions().query(0, 0, 1000).includes(responders[2].deviceInstanceId));
      h.setNow(7);
      await h.service.updateResponderPosition(responders[2], { positionUpdateId: uuid(702),
        responderPosition: { ...R, latitude: [COORDINATE_REMOVED] }, observedAt: at(7) });
      assert.ok(h.store.devicePositions().query(0, 0, 1000).includes(responders[2].deviceInstanceId));
      checks.push({ store: kind, farUsers, check: 'cross_cell_move_out_and_back', passed: true });
      if (h.dbfile) {
        await h.store.close();
        const reopened = await SQLiteStateStore.open(h.dbfile, []);
        try {
          assert.deepEqual(reopened.devicePositions().query(0, 0, 1000).sort(), expected);
          checks.push({ store: kind, farUsers, check: 'sqlite_reopen_index', passed: true });
        } finally { await reopened.close(); }
      }
      console.log(`${kind} far=${farUsers}: seven phases and correctness checks passed`);
    } finally { await h.cleanup(); }
  }
}

const boundaryIndex = new DevicePositionIndex();
boundaryIndex.upsert('adjacent-cell', 0.00501, 0);
assert.ok(boundaryIndex.query(0.00499, 0, 10).includes('adjacent-cell'));
checks.push({ check: 'adjacent_cell_within_10m', passed: true });

if (mode === 'instrumented') {
  for (const kind of ['Memory', 'SQLite']) {
    const select = phase => rows.filter(row => row.store === kind && row.phase === phase);
    for (const row of select('grid_then_exact')) {
      assert.equal(row.distanceCalls, 3);
      assert.equal(row.farDistanceCalls, 0);
      assert.equal(row.gridCellsVisited, 16);
    }
    for (const row of select('brute_force_control')) assert.equal(row.distanceCalls, row.farUsers + 3);
    for (const row of select('create_event')) if (row.farUsers > 0) assert.ok(row.farDistanceCalls >= row.farUsers);
    for (const row of select('scheduler_tick')) if (row.farUsers > 0) assert.ok(row.farDistanceCalls >= row.farUsers);
  }
}
await writeFile(outputFile, JSON.stringify({ mode, node: process.version,
  subject: repositoryRoot, shadowValidation: false, instrumentedTimingsAreNotBenchmarks: true,
  rows, checks }, null, 2));
console.log(`Saved ${rows.length} phase observations and ${checks.length} correctness checks to ${outputFile}`);
