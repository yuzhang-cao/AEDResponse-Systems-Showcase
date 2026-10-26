/**
 * Offline, synthetic SQLite probe; not a device test, load SLA or rescue acceptance.
 * Run this same file against both roots:
 * node --import tsx test/performance-regression-probe.mts /absolute/path/to/backend [rounds=2]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { DeviceRecord, EventRecord, PersistentState } from "../src/models.js";
import type { PushProvider } from "../src/push-provider.js";

const suppliedRoot = process.argv[2];
if (!suppliedRoot) throw new Error("Supply the explicit baseline/backend or candidate/backend directory");
const backendRoot = await realpath(resolve(suppliedRoot));
const packageInfo = JSON.parse(await readFile(join(backendRoot, "package.json"), "utf8"));
assert.equal(packageInfo.name, "aedresponse-backend", "The target must be the intended backend checkout");
const rounds = Number(process.argv[3] ?? 2);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 5, "rounds must be 1..5");
const moduleURL = (path: string) => pathToFileURL(join(backendRoot, path)).href;
// Block sockets/fetch before loading application modules; no external credentials are read.
await import(moduleURL("test/helpers/no-network.mjs"));
const { loadConfig } = await import(moduleURL("src/config.ts")) as typeof import("../src/config.js");
const { emptyState } = await import(moduleURL("src/models.ts")) as typeof import("../src/models.js");
const { AEDResponseService } = await import(moduleURL("src/service.ts")) as typeof import("../src/service.js");
const { SQLiteStateStore, measureStorageCost, setShadowValidationEnabled } =
  await import(moduleURL("src/store.ts")) as typeof import("../src/store.js");
const { enqueueNotification } = await import(moduleURL("src/notification-outbox.ts")) as typeof import("../src/notification-outbox.js");
const { resetMetrics, setInstrumentationEnabled, snapshotMetrics } =
  await import(moduleURL("src/runtime-metrics.ts")) as typeof import("../src/runtime-metrics.js");

const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const NOW = new Date(BASE + 7_230_000);
const at = (seconds: number) => new Date(BASE + seconds * 1_000).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const config = loadConfig({});
setInstrumentationEnabled(true);
setShadowValidationEnabled(false);

function device(index: number, active = false): DeviceRecord {
  return {
    deviceInstanceId: uuid(1_000 + index), deviceKind: "IPHONE", userId: uuid(2_000 + index),
    companionPairId: uuid(3_000 + index),
    agreements: Object.fromEntries(["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => [kind, { version: "2.0", acceptedAt: at(0) }])),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: active, presenceObservedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(), lastBootstrapAt: at(0),
    ...(active ? {
      latestPosition: { positionUpdateId: uuid(4_000 + index), observedAt: NOW.toISOString(),
        serverReceivedAt: NOW.toISOString(),
        position: { kind: "R" as const, latitude: 22 + index / 100_000, longitude: 113, accuracyMeters: 10 } },
      pushRegistration: { token: "a".repeat(64), environment: "SANDBOX" as const,
        bundleId: "dev.example.offline-probe", registeredAt: at(0), updatedAt: at(0) }
    } : {})
  };
}

function event(index: number, active = false): EventRecord {
  const patient = device(index, active);
  const eventId = uuid(100 + index);
  const createdAt = active ? at(7_220) : at(0);
  return {
    id: eventId, state: active ? "ACTIVE" : "RESOLVED",
    recruitmentState: active ? "RECRUITING" : "COMPLETED", patientUserId: patient.userId!,
    patientDeviceIds: [patient.deviceInstanceId], patientPairId: patient.companionPairId,
    observation: {
      schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT", fallDetectedAt: createdAt,
      patientPositionObservedAt: createdAt, fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22, longitude: 113, accuracyMeters: 10 }
    },
    observationFingerprint: digest(`synthetic-observation-${index}`), triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    currentRecruitmentRadiusMeters: 1_000, recruitmentStageStartedAt: createdAt,
    coordinationRevision: 10_000, assignmentRevision: 1, unavailableAedIds: [],
    exitedResponderUserIds: [], createdAt,
    ...(active ? { patientPosition: {
      positionUpdateId: uuid(5_000 + index), source: "IPHONE_PRIMARY" as const,
      observedAt: NOW.toISOString(), serverReceivedAt: NOW.toISOString(),
      position: { kind: "P" as const, latitude: 22, longitude: 113, accuracyMeters: 10 }
    } } : { resolvedAt: at(7_200), terminalReason: "PROBLEM_RESOLVED" as const })
  };
}

function seed(active: boolean): PersistentState {
  const state = emptyState();
  for (let index = 0; index < 8; index += 1) {
    const patient = device(index);
    state.devices[patient.deviceInstanceId] = patient;
    const historical = event(index);
    state.events[historical.id] = historical;
    state.timelineByEventId[historical.id] = [];
  }
  // Same legal record shapes as architecture-repair-native/storage-load.mts,
  // now tied to the eight explicit synthetic events and their patient identities.
  for (let index = 0; index < 6_500; index += 1) {
    const eventId = uuid(100 + index % 8);
    state.timelineByEventId[eventId]!.push({ id: uuid(10_000 + index), eventId,
      occurredAt: at(index), kind: "PATIENT_POSITION_UPDATED",
      message: "Synthetic retained audit entry for an offline performance regression probe; no real account, position, notification or emergency is represented." });
  }
  for (let index = 0; index < 1_295; index += 1) {
    const owner = index % 8;
    const batchId = uuid(20_000 + index), eventId = uuid(100 + owner);
    const userId = uuid(2_000 + owner), deviceInstanceId = uuid(1_000 + owner);
    const receivedAt = at(index * 5 + 5);
    state.eventPositionBatchesById[batchId] = {
      batchId, eventId, userId, deviceInstanceId, kind: "P", fingerprint: digest(batchId), receivedAt,
      records: Array.from({ length: 5 }, (_, slot) => ({
        recordId: uuid(30_000 + index * 5 + slot), batchId, eventId, userId, deviceInstanceId,
        kind: "P", slotAt: at(index * 5 + slot), serverReceivedAt: receivedAt,
        status: "NO_NEW_FIX", gapReason: "NO_FIX", appliedToLatest: false, ignoredAsStale: false
      }))
    };
  }
  for (let index = 0; index < 1_850; index += 1) {
    const owner = index % 8;
    enqueueNotification(state, uuid(1_000 + owner), "event:patient-position-updated", {
      schemaVersion: "2.0", messageId: `synthetic-history-${index}`, eventId: uuid(100 + owner),
      occurredAt: at(index), coordinationRevision: index + 1
    });
  }
  for (const row of Object.values(state.notificationOutboxById)) {
    row.status = "DISPATCHED";
    row.attempts = 1;
    row.completedAt = String(row.payload.occurredAt);
    row.push = { status: "SUPPRESSED", attempts: 0, lastAttemptAt: row.completedAt,
      reason: "NOT_AN_ACTIVE_ALERT" };
  }
  if (active) {
    const current = event(8, true);
    state.events[current.id] = current;
    for (const index of [8, 9, 10]) {
      const responder = device(index, true);
      state.devices[responder.deviceInstanceId] = responder;
    }
    state.devices[uuid(1_008)]!.currentEventId = current.id;
    // Position updates exercise the outbox's suppression path; activation and
    // newly recruited responders exercise the fake push provider itself.
    for (let index = 0; index < 40; index += 1) {
      enqueueNotification(state, uuid(1_008), "event:patient-position-updated", {
        schemaVersion: "2.0", messageId: `synthetic-due-${index}`, eventId: current.id,
        occurredAt: at(7_220 + index / 10), coordinationRevision: index + 1
      });
    }
    enqueueNotification(state, uuid(1_008), "event:patient-activated", {
      schemaVersion: "2.0", messageId: "synthetic-activation", eventId: current.id,
      occurredAt: current.createdAt, state: "ACTIVE", recruitmentState: "RECRUITING"
    });
  }
  return state;
}

const scratch = await mkdtemp(join(tmpdir(), "aed-offline-performance-"));
const rows: Record<string, unknown>[] = [];
try {
  for (const active of [false, true]) {
    const initial = seed(active);
    const seedHash = digest(JSON.stringify(initial));
    for (let round = 1; round <= rounds; round += 1) {
      const store = await SQLiteStateStore.open(join(scratch, `${active ? "active" : "idle"}-${round}.sqlite`), []);
      try {
        await store.transact(state => Object.assign(state, structuredClone(initial)));
        const storage = store.read(state => measureStorageCost(state));
        assert.equal(storage.collectionCounts.events, active ? 9 : 8);
        assert.equal(storage.collectionCounts.eventPositionBatchesById, 1_295);
        assert.equal(storage.collectionCounts.notificationOutboxById, active ? 1_891 : 1_850);
        assert.equal(storage.eventPositionRecordCount, 6_475);
        let fakePushCalls = 0, socketMessages = 0;
        const push: PushProvider = { name: "offline-probe", isConfigured: () => true,
          async send() { fakePushCalls += 1; return { status: "DELIVERED" }; } };
        const service = new AEDResponseService(store, config, {
          emitToDevices(ids) { socketMessages += ids.length; return [...ids]; }
        }, () => NOW, {}, undefined, push);
        resetMetrics();
        const started = performance.now();
        const timerLag = new Promise<number>(resolve => {
          setTimeout(() => resolve(Math.max(0, performance.now() - started - 1)), 1);
        });
        await service.tick();
        const tickMs = performance.now() - started;
        await service.flushNotificationPushes();
        const tickAndPushFlushMs = performance.now() - started;
        const timerDelayMs = await timerLag;
        const metrics = snapshotMetrics();
        if (active) assert.ok(fakePushCalls > 0, "the synthetic active case must exercise push delivery");
        rows.push({ scenario: active ? "ACTIVE_WITH_DUE_NOTIFICATIONS" : "IDLE_TERMINAL_HISTORY", round,
          seedHash, storage, tickMs, tickAndPushFlushMs, timerDelayMs, fakePushCalls, socketMessages,
          metrics });
      } finally { await store.close(); }
    }
  }
} finally {
  // Only the exact temporary directory created above; all contents are synthetic.
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({
  scope: "Offline synthetic SQLite comparison; no real devices, production data or network; not business acceptance or a capacity SLA.",
  backendRoot, node: process.version, platform: process.platform, arch: process.arch,
  instrumentationEnabled: true, shadowValidationEnabled: false, rounds,
  temporarySyntheticDatabasesRemoved: true, rows
}, null, 2));
