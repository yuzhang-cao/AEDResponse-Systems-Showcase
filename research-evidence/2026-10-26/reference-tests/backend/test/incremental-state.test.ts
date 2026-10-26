import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { emptyState, type DeviceRecord, type EventRecord } from "../src/models.js";
import { MemoryStateStore, SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";
import type { StateStore } from "../src/store.js";
import { readState, transactState, stateRows, registerStateQueries, NOTIFICATION_DEADLINES } from "../src/incremental-state.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";
import { AEDResponseService } from "../src/service.js";
import { loadConfig } from "../src/config.js";
import { DeadlineIndex } from "../src/deadline-index.js";
import { enqueueNotification } from "../src/notification-outbox.js";

const EVENT = "REDACTED-ID-0108";
const AT = "2026-09-13T00:00:00.000Z";
const P = { kind: "P" as const, latitude: 0, longitude: 0, accuracyMeters: 10 };
function device(id: string, latitude: number): DeviceRecord {
  return { deviceInstanceId: id, deviceKind: "IPHONE", userId: `user-${id}`, companionPairId: `pair-${id}`,
    agreements: Object.fromEntries(["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
      .map(kind => [kind, { version: "2.0", acceptedAt: AT }])), capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: AT, lastSeenAt: AT, lastBootstrapAt: AT,
    latestPosition: { positionUpdateId: `position-${id}`, observedAt: AT, serverReceivedAt: AT,
      position: { kind: "R", latitude, longitude: 0, accuracyMeters: 10 } } } as DeviceRecord;
}
function world() {
  const state = emptyState();
  state.devices.patient = device("patient", 0);
  state.devices.near = device("near", 0.001);
  state.devices.far = device("far", 30);
  state.events[EVENT] = {
    id: EVENT, patientDeviceIds: ["patient"], patientUserId: "user-patient", patientPairId: "pair-patient",
    state: "ACTIVE", recruitmentState: "RECRUITING", currentRecruitmentRadiusMeters: 1000,
    recruitmentStageStartedAt: AT, coordinationRevision: 1, assignmentRevision: 0, unavailableAedIds: [], createdAt: AT,
    triggerSource: "WATCH_FALL_HELP_CONFIRMED", observationFingerprint: "fixture",
    patientPosition: { positionUpdateId: "patient-position", source: "IPHONE_PRIMARY", position: P, observedAt: AT, serverReceivedAt: AT },
    observation: { schemaVersion: "2.0", eventId: EVENT, observationKind: "FALL_CONTEXT", fallDetectedAt: AT,
      patientPositionObservedAt: AT, fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP", patientPosition: P }
  } as EventRecord;
  return state;
}
async function fixture(kind: "Memory" | "SQLite") {
  const dir = await mkdtemp(join(tmpdir(), "aed-entity-draft-"));
  const path = join(dir, "state.sqlite");
  const store: StateStore = kind === "Memory" ? new MemoryStateStore(world()) : await SQLiteStateStore.open(path, []);
  if (kind === "SQLite") await store.transact(state => Object.assign(state, world()));
  registerStateQueries(store);
  return { store, path, async close() { await store.close?.(); await rm(dir, { recursive: true, force: true }); } };
}

for (const kind of ["Memory", "SQLite"] as const) {
  test(`${kind}: entity draft overlays movement, deletion, identity, insertion order and detached return values`, async () => {
    setShadowValidationEnabled(false);
    const f = await fixture(kind);
    try {
      await transactState(f.store, state => { delete state.events[EVENT]!.patientPosition; });
      resetMetrics();
      assert.deepEqual(readState(f.store, state => draftRecruitmentContext(state).candidateDevices(state.events[EVENT]!).map(row => row.deviceInstanceId)), ["patient"]);
      assert.equal(snapshotMetrics().operation.stateFullCollectionKeyVisits, 0, "no P must still notify patients without scanning responders");
      await transactState(f.store, state => { state.events[EVENT]!.patientPosition = world().events[EVENT]!.patientPosition!; });
      resetMetrics();
      const returned = await transactState(f.store, state => {
        state.devices.far!.latestPosition!.position.latitude = 0.002;
        state.devices.far!.userId = "user-patient";
        delete state.devices.near;
        const appended = device("appended", 0.003);
        Object.defineProperty(state.devices, "appended", { value: appended, enumerable: true, configurable: true, writable: true });
        appended.availableForResponse = false; // References to new entities stay live inside the draft.
        const candidates = draftRecruitmentContext(state).candidateDevices(state.events[EVENT]!);
        assert.deepEqual(candidates.map(row => row.deviceInstanceId), ["patient", "far", "appended"]);
        assert.deepEqual(stateRows(state, "devices", "userId", "user-patient").map(row => row.deviceInstanceId), ["patient", "far"]);
        assert.equal(candidates[2]!.availableForResponse, false);
        return state.devices.far!;
      });
      assert.equal(snapshotMetrics().totalFullStateClones, 0);
      assert.equal(snapshotMetrics().operation.stateFullCollectionKeyVisits, 0);
      assert.deepEqual(f.store.devicePositions!().query(0, 0, 1000).sort(), ["appended", "far", "patient"]);
      returned.userId = "must-not-mutate-committed-state";
      assert.equal(readState(f.store, state => state.devices.far!.userId), "user-patient");
      if (kind === "SQLite") {
        const reopened = await SQLiteStateStore.open(f.path, []);
        try { assert.deepEqual(reopened.read(state => state), f.store.read(state => state)); }
        finally { await reopened.close(); }
      }
    } finally { await f.close(); }
  });

  test(`${kind}: failed draft leaves geographic, relation and outbox deadline indexes unchanged`, async () => {
    const f = await fixture(kind);
    try {
      const before = f.store.read(state => state);
      await assert.rejects(transactState(f.store, state => { state.devices = {}; }), TypeError);
      await assert.rejects(transactState(f.store, state => {
        state.devices.far!.latestPosition!.position.latitude = 0.001;
        state.devices.far!.userId = "user-patient";
        enqueueNotification(state, "far", "event:patient-activated", { schemaVersion: "2.0", messageId: "rollback",
          eventId: EVENT, occurredAt: AT, state: "ACTIVE", recruitmentState: "RECRUITING" });
        assert.ok(draftRecruitmentContext(state).candidateDevices(state.events[EVENT]!).some(row => row.deviceInstanceId === "far"));
        throw new Error("abort after all draft changes");
      }), /abort after all draft changes/);
      assert.deepEqual(f.store.read(state => state), before);
      assert.deepEqual(f.store.devicePositions!().query(0, 0, 1000).sort(), ["near", "patient"]);
      assert.deepEqual(readState(f.store, state => stateRows(state, "devices", "userId", "user-patient").map(row => row.deviceInstanceId)), ["patient"]);
      assert.deepEqual(f.store.projections!().readDue(NOTIFICATION_DEADLINES, Infinity, 100).keys, []);
    } finally { await f.close(); }
  });
}

test("SQLite: commit failure rolls back a flushed draft and every index, then the same operation can commit", async () => {
  const f = await fixture("SQLite");
  const owner = f.store as unknown as { database: Database.Database };
  const database = owner.database;
  const before = f.store.read(state => state);
  const service = new AEDResponseService(f.store, { ...loadConfig({}), positionMaxAgeSeconds: 600 },
    { emitToDevices() { return []; } }, () => new Date(Date.parse(AT) + 601000));
  const move = () => transactState(f.store, state => { state.devices.far!.latestPosition!.position.latitude = 0.001; });
  owner.database = new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("VALUES ('revision', '1')")) return statement;
      return new Proxy(statement, { get(row, member) {
        if (member === "run") return () => { throw new Error("injected final SQL write failure"); };
        const value = Reflect.get(row, member, row);
        return typeof value === "function" ? value.bind(row) : value;
      } });
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    await assert.rejects(move(), /injected final SQL/);
    assert.deepEqual(f.store.read(state => state), before);
    assert.deepEqual(f.store.devicePositions!().query(0, 0, 1000).sort(), ["near", "patient"]);
    await assert.rejects(service.tick(), /injected final SQL/);
    assert.deepEqual(f.store.read(state => state), before);
    owner.database = database;
    await service.tick();
    assert.equal(f.store.read(state => state.devices.far!.latestPosition), undefined,
      "failed position reclamation must retry instead of losing its popped expiry entry");
    await transactState(f.store, state => { state.devices.far!.latestPosition = device("far", 0.001).latestPosition!; });
    const reopened = await SQLiteStateStore.open(f.path, []);
    try { assert.equal(reopened.read(state => state.devices.far!.latestPosition!.position.latitude), 0.001); }
    finally { await reopened.close(); }
  } finally { owner.database = database; await f.close(); }
});

test("deadline heap ignores future history, preserves due insertion order and stays bounded on retries", () => {
  const index = new DeadlineIndex();
  for (let i = 0; i < 1000; i++) index.upsert(`future-${i}`, 10000 + i);
  index.upsert("second-deadline", 2);
  index.upsert("first-deadline", 1);
  const due = index.due(2, 100);
  assert.deepEqual(due.keys, ["second-deadline", "first-deadline"]);
  assert.ok(due.visited < 12, "future notifications must not be scanned");
  for (let i = 0; i < 10000; i++) index.upsert("first-deadline", 3 + i % 2);
  assert.equal(index.size, 1002, "rescheduling retains exactly one heap node per message");
  index.remove("second-deadline");
  assert.deepEqual(index.due(2, 100).keys, []);
  assert.deepEqual(index.due(4, 100).keys, ["first-deadline"]);
});

test("production logs an explicit warning when a store cannot provide recruitment indexes", async () => {
  const f = await fixture("Memory");
  const messages: unknown[][] = [];
  const prior = console.error;
  const store = new Proxy(f.store, { get(target, key) {
    if (key === "devicePositions") return undefined;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    console.error = (...args: unknown[]) => { messages.push(args); };
    new AEDResponseService(store, { ...loadConfig({}), production: true });
    assert.equal(messages.filter(args => String(args[0]).includes("G13 recruitment index capability unavailable")).length, 1);
  } finally { console.error = prior; await f.close(); }
});
