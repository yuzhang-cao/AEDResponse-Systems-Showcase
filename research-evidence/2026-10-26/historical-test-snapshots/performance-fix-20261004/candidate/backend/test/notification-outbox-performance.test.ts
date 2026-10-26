import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EntityTransaction } from "../src/entity-transaction.js";
import { emptyState, type NotificationRecord, type PersistentState } from "../src/models.js";
import { NotificationOutbox } from "../src/notification-outbox.js";
import type { PushProvider } from "../src/push-provider.js";
import { AEDResponseService } from "../src/service.js";
import type { StateReadView } from "../src/state-read.js";
import { MemoryStateStore, SQLiteStateStore, type StateStore } from "../src/store.js";

const base = Date.parse("2026-10-04T00:00:00.000Z");
const at = (milliseconds = 0) => new Date(base + milliseconds).toISOString();
const deviceId = "REDACTED-SUPPLEMENT-ID-11e594f48195";
const eventId = "REDACTED-SUPPLEMENT-ID-e79acd97ac88";
const pairId = "REDACTED-SUPPLEMENT-ID-993224b4fe85";
const token = "a".repeat(64);

function notification(id = "notification", offer = false): NotificationRecord {
  const envelope = { schemaVersion: "2.0", messageId: id, eventId, occurredAt: at() };
  return { id, eventId, name: offer ? "response:requested" : "event:patient-activated",
    recipient: { deviceInstanceId: deviceId, companionPairId: pairId },
    payload: offer ? { ...envelope, deliveryId: "REDACTED-SUPPLEMENT-ID-008bf60b9309",
      deliveryStatus: "SENT", eventType: "FALL_ASSISTANCE", positioningTier: "SEARCH_RING",
      distanceRange: "DISTANCE_0_500M", etaRange: "ETA_0_5_MIN",
      currentRecruitmentRadiusMeters: 1000, expiresAt: at(30_000) }
      : { ...envelope, state: "ACTIVE", recruitmentState: "RECRUITING" },
    status: "PENDING", attempts: 0, nextAttemptAt: at() };
}

function seed(rows = [notification()]): PersistentState {
  const state = emptyState();
  state.devices[deviceId] = { deviceInstanceId: deviceId, deviceKind: "IPHONE", companionPairId: pairId,
    agreements: {}, capabilities: { locationAuthorized: true, notificationAuthorized: true },
    availableForResponse: false, presenceObservedAt: at(), lastSeenAt: at(), lastBootstrapAt: at(),
    pushRegistration: { token, environment: "SANDBOX", bundleId: "dev.codex.aedresponse",
      registeredAt: at(), updatedAt: at() } };
  state.events[eventId] = { id: eventId,
    observation: { schemaVersion: "2.0", observationKind: "FALL_CONTEXT", eventId, fallDetectedAt: at(),
      fallResolution: "CONFIRMED", appHelpResponse: "NEEDS_HELP", locationUnavailableReason: "synthetic-no-fix" },
    observationFingerprint: "synthetic-fingerprint", patientPairId: pairId, patientUserId: "synthetic-patient",
    patientDeviceIds: [deviceId], state: "ACTIVE", recruitmentState: "RECRUITING",
    triggerSource: "WATCH_FALL_HELP_CONFIRMED", currentRecruitmentRadiusMeters: 1000,
    recruitmentStageStartedAt: null, createdAt: at(), coordinationRevision: 0, assignmentRevision: 0,
    unavailableAedIds: [] };
  for (const row of rows) state.notificationOutboxById[row.id] = row;
  return state;
}

class CountingStore extends MemoryStateStore {
  fullWrites = 0;
  entityWrites = 0;
  fullReads = 0;
  failEntityWrite = 0;
  override read<T>(reader: (state: Readonly<PersistentState>) => T): T {
    this.fullReads += 1;
    return super.read(reader);
  }
  override readEntities<T>(reader: (view: StateReadView) => T): T {
    return super.readEntities(view => reader({ ...view,
      select: () => { throw new Error("Notification selection must not clone every retained row"); } }));
  }
  override transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    this.fullWrites += 1;
    return super.transact(mutation);
  }
  override transactEntities<T>(mutation: (tx: EntityTransaction) => T | Promise<T>): Promise<T> {
    const attempt = ++this.entityWrites;
    return super.transactEntities(async tx => {
      const result = await mutation(tx);
      if (attempt === this.failEntityWrite) throw new Error("injected notification transaction failure");
      return result;
    });
  }
  row(id = "notification") { return this.readEntities(view => view.get("notificationOutboxById", id))!; }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function markPush(store: StateStore, id: string, status: "DELIVERED" | "RETRY", now: string) {
  await store.transactEntities!(tx => tx.update("notificationOutboxById", id, row => {
    row.push = { status, attempts: (row.push?.attempts ?? 0) + 1, lastAttemptAt: now,
      ...(status === "RETRY" ? { nextAttemptAt: new Date(Date.parse(now) + 1000).toISOString() } : {}) };
  }));
}

test("blocked APNs does not repeat state work or starve a later socket notification", async t => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...notification(`queued-${index}`),
    status: "DISPATCHED" as const, completedAt: at(),
    push: { status: "PENDING" as const, attempts: 0, lastAttemptAt: at(), nextAttemptAt: at() } }));
  const store = new CountingStore(seed(rows));
  const blocked = deferred(), started = deferred();
  t.after(() => blocked.resolve());
  const sent: string[] = [], sockets: string[] = [];
  const outbox = new NotificationOutbox(store, () => new Date(base), (_state, records, emit = true) => {
    if (emit) sockets.push(...records.map(row => row.id));
    return new Map(records.map(row => [row.id, "DISPATCHED"]));
  }, async records => {
    const row = records[0]!; sent.push(row.id); started.resolve();
    await blocked.promise;
    await markPush(store, row.id, "DELIVERED", at());
  });
  await outbox.drain();
  await started.promise;
  assert.equal(sent.length, 1);
  const writes = store.entityWrites, reads = store.fullReads;
  for (let i = 0; i < 20; i += 1) await outbox.drain();
  assert.equal(store.entityWrites, writes);
  assert.equal(store.fullReads, reads);
  await store.transactEntities(tx => tx.append("notificationOutboxById", "later", notification("later")));
  await outbox.drain();
  assert.deepEqual(sockets, ["later"], "reserved rows must not consume the due selection limit");
  blocked.resolve();
  await outbox.flushPushes();
  assert.equal(sent.length, 101);
  assert.equal(new Set(sent).size, 101);
  assert.equal(store.fullWrites, 0);
  assert.equal(store.row("later").push?.status, "DELIVERED");
});

test("socket offer retries keep their five-second cadence while APNs is blocked", async t => {
  let now = 0;
  const store = new CountingStore(seed([notification("offer", true)]));
  const blocked = deferred(), started = deferred();
  t.after(() => blocked.resolve());
  const socketTimes: number[] = [];
  let sends = 0;
  const outbox = new NotificationOutbox(store, () => new Date(base + now), (_state, records, emit = true) => {
    if (emit) socketTimes.push(now);
    return new Map(records.map(row => [row.id, "PENDING"]));
  }, async records => {
    sends += 1; started.resolve(); await blocked.promise;
    await markPush(store, records[0]!.id, "DELIVERED", at(now));
  });
  await outbox.drain(); await started.promise;
  for (now = 1000; now <= 12_000; now += 1000) await outbox.drain();
  assert.deepEqual(socketTimes, [0, 5000, 10_000]);
  assert.equal(sends, 1);
  assert.equal(store.row("offer").attempts, 3);
  blocked.resolve(); await outbox.flushPushes();
  assert.equal(store.fullWrites, 0);
});

test("push-only retries neither resend a socket offer early nor move its deadline", async () => {
  let now = 0, sockets = 0, pushes = 0;
  const store = new CountingStore(seed([notification("offer", true)]));
  const outbox = new NotificationOutbox(store, () => new Date(base + now), (_state, records, emit = true) => {
    if (emit) sockets += 1;
    return new Map(records.map(row => [row.id, "PENDING"]));
  }, async records => { pushes += 1; await markPush(store, records[0]!.id, "RETRY", at(now)); });
  await outbox.drain(); await outbox.flushPushes();
  now = 1000;
  await outbox.drain(); await outbox.flushPushes();
  assert.equal(pushes, 2);
  assert.equal(sockets, 1);
  assert.equal(store.row("offer").attempts, 1);
  assert.equal(store.row("offer").nextAttemptAt, at(5000));
});

test("concurrent drains share one pass and a thrown push releases its reservation", async t => {
  const store = new CountingStore(seed());
  let calls = 0;
  t.mock.method(console, "error", () => {});
  const outbox = new NotificationOutbox(store, () => new Date(base), (_state, rows) =>
    new Map(rows.map(row => [row.id, "DISPATCHED"])), async rows => {
    if (++calls === 1) throw new Error("synthetic transport failure");
    await markPush(store, rows[0]!.id, "DELIVERED", at());
  });
  const first = outbox.drain();
  assert.equal(outbox.drain(), first);
  await first; await outbox.flushPushes();
  const socketFact = store.row();
  await outbox.drain(); await outbox.flushPushes();
  const finished = store.row();
  assert.equal(calls, 2);
  assert.equal(finished.push?.status, "DELIVERED");
  assert.equal(finished.status, socketFact.status);
  assert.equal(finished.attempts, socketFact.attempts);
  assert.equal(finished.completedAt, socketFact.completedAt);
});

for (const failureAt of [1, 2]) test(`notification transaction ${failureAt} failure retains the original message for retry`, async t => {
  let now = 0;
  const original = notification();
  const store = new CountingStore(seed([original]));
  store.failEntityWrite = failureAt;
  t.mock.method(console, "error", () => {});
  const outbox = new NotificationOutbox(store, () => new Date(base + now), (_state, rows) =>
    new Map(rows.map(row => [row.id, "DISPATCHED"])));
  await outbox.drain();
  assert.equal(store.row().status, "PENDING");
  assert.deepEqual(store.row().payload, original.payload);
  assert.deepEqual(store.row().recipient, original.recipient);
  assert.equal(store.row().attempts, failureAt === 1 ? 0 : 1);
  now = 1000;
  await outbox.drain();
  assert.equal(store.row().status, "DISPATCHED");
  assert.equal(store.fullWrites, 0);
});

function service(store: StateStore, provider: PushProvider) {
  return new AEDResponseService(store, { host: "127.0.0.1", port: 0, dataFile: "unused-memory.json", fixtureFile: "unused-fixture.json",
    sessionTtlSeconds: 3600, nearbyRadiusMeters: 1000, positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120, maxPositionAccuracyMeters: 50, bootstrapLimitPerMinute: 100,
    production: false }, { emitToDevices: devices => [...devices] }, () => new Date(base), {}, undefined, provider);
}

test("push result entity writes match the legacy store without full-state transactions", async () => {
  const entityStore = new CountingStore(seed()), legacyStore = new CountingStore(seed());
  const legacy: StateStore = { read: reader => legacyStore.read(reader), transact: mutation => legacyStore.transact(mutation) };
  const provider: PushProvider = { name: "synthetic", isConfigured: () => true, send: async () => ({ status: "DELIVERED" }) };
  await service(entityStore, provider).flushNotificationPushes();
  await service(legacy, provider).flushNotificationPushes();
  assert.deepEqual(entityStore.read(state => state), legacyStore.read(state => state));
  assert.equal(entityStore.fullWrites, 0);
  assert.equal(entityStore.row().push?.status, "DELIVERED");
  assert.ok(legacyStore.fullWrites >= 3);
});

test("a failed push-result commit preserves the pending record and retries without losing evidence", async t => {
  const store = new CountingStore(seed());
  store.failEntityWrite = 3;
  t.mock.method(console, "error", () => {});
  let sends = 0;
  const provider: PushProvider = { name: "synthetic", isConfigured: () => true,
    send: async () => { sends += 1; return { status: "DELIVERED" }; } };
  const svc = service(store, provider);
  await svc.flushNotificationPushes();
  const pending = store.row();
  assert.equal(pending.status, "DISPATCHED");
  assert.equal(pending.push?.status, "PENDING");
  assert.equal(pending.push?.attempts, 0);
  assert.equal(store.readEntities(view => view.get("devices", deviceId))!.pushRegistration!.alerts, undefined);
  await svc.flushNotificationPushes();
  const finished = store.row();
  assert.equal(sends, 2, "provider acceptance without a durable result is retried, not claimed exactly once");
  assert.equal(finished.push?.status, "DELIVERED");
  assert.deepEqual(finished.payload, pending.payload);
  assert.deepEqual(finished.recipient, pending.recipient);
  assert.equal(finished.completedAt, pending.completedAt);
  assert.equal(store.fullWrites, 0);
});

for (const outcome of ["INVALID_TOKEN", "DELIVERED"] as const) test(`late ${outcome} does not overwrite a rotated push registration`, async t => {
  const store = new CountingStore(seed());
  const blocked = deferred(), started = deferred();
  t.after(() => blocked.resolve());
  const provider: PushProvider = { name: "synthetic-blocked", isConfigured: () => true, send: async () => {
    started.resolve(); await blocked.promise;
    return outcome === "INVALID_TOKEN" ? { status: "INVALID_TOKEN", reason: "UNREGISTERED" } : { status: "DELIVERED" };
  } };
  const svc = service(store, provider);
  const flushing = svc.flushNotificationPushes();
  await started.promise;
  await store.transactEntities(tx => tx.update("devices", deviceId, device => {
    device.pushRegistration = { ...device.pushRegistration!, token: "b".repeat(64), updatedAt: at(1) };
  }));
  blocked.resolve(); await flushing;
  const registration = store.readEntities(view => view.get("devices", deviceId))!.pushRegistration!;
  assert.equal(registration.token, "b".repeat(64));
  assert.equal(registration.alerts, undefined);
  assert.equal(store.row().push?.status, outcome);
  assert.equal(store.fullWrites, 0);
});

test("notification and push result entity commits survive SQLite reopen", async t => {
  const directory = await mkdtemp(join(tmpdir(), "aed-notification-entities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const store = await SQLiteStateStore.open(path, []);
  try {
    await store.transact(state => Object.assign(state, seed()));
    store.transact = async () => { throw new Error("Notification path attempted a full-state transaction"); };
    const provider: PushProvider = { name: "synthetic", isConfigured: () => true, send: async () => ({ status: "DELIVERED" }) };
    await service(store, provider).flushNotificationPushes();
  } finally { await store.close(); }
  const reopened = await SQLiteStateStore.open(path, []);
  try {
    const state = reopened.read(state => state);
    assert.equal(state.notificationOutboxById.notification?.status, "DISPATCHED");
    assert.equal(state.notificationOutboxById.notification?.push?.status, "DELIVERED");
    assert.equal(state.devices[deviceId]?.pushRegistration?.alerts?.[0]?.phase, "searching");
  } finally { await reopened.close(); }
});
