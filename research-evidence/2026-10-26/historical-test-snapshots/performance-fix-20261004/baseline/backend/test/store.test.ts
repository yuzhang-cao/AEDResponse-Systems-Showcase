import { readEntities, createStateReadView } from "../src/state-read.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { BackendConfig } from "../src/config.js";
import type { Aed, WatchEmergencyObservation } from "../src/contracts.js";
import { fingerprint } from "../src/domain.js";
import { emptyState, type EventPositionBatchRecord, type EventRecord, type NotificationRecord } from "../src/models.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import {
  JsonFileStateStore,
  MemoryStateStore,
  SQLiteStateStore,
  type StateStore
} from "../src/store.js";

const seedAed: Aed = {
  id: "store-test-aed",
  name: "Store Test AED",
  aedPosition: { kind: "A", latitude: 22.2, longitude: 113.5, accuracyMeters: 10 },
  openFrom: "00:00",
  openUntil: "00:00",
  floor: "1F",
  floorTransferSeconds: 0,
  accessNote: "test",
  accessDelaySeconds: 0,
  verificationSeconds: 0,
  available: true
};

function entry(id: string) {
  return {
    id,
    eventId: "REDACTED-SUPPLEMENT-ID-7ac1b8d7010b",
    occurredAt: "2026-08-31T01:00:00.000Z",
    kind: "EVENT_ACTIVATED" as const,
    message: id
  };
}

function appendOnlyBatch(batchId: string): EventPositionBatchRecord {
  const eventId = `append-only-event-${batchId}`;
  const deviceInstanceId = `append-only-device-${batchId}`;
  const userId = `append-only-user-${batchId}`;
  return {
    batchId,
    eventId,
    userId,
    deviceInstanceId,
    kind: "P",
    fingerprint: `fingerprint-${batchId}`,
    receivedAt: "2026-08-31T01:00:01.000Z",
    records: [{
      recordId: `record-${batchId}`,
      batchId,
      eventId,
      userId,
      deviceInstanceId,
      kind: "P",
      slotAt: "2026-08-31T01:00:00.000Z",
      serverReceivedAt: "2026-08-31T01:00:01.000Z",
      status: "FIX",
      fixObservedAt: "2026-08-31T01:00:00.500Z",
      position: {
        kind: "P",
        latitude: 22.2,
        longitude: 113.5,
        accuracyMeters: 10
      },
      appliedToLatest: false,
      ignoredAsStale: false
    }]
  };
}

async function assertHistoryIsAppendOnly(store: StateStore, suffix: string): Promise<void> {
  const batchId = `append-only-batch-${suffix}`;
  const quarantineId = `append-only-quarantine-${suffix}`;
  const intervalId = `append-only-interval-${suffix}`;
  const batch = appendOnlyBatch(batchId);
  const quarantined = { legacy: true, observedAt: "2026-08-31T01:00:00.000Z" };
  await store.transact((state) => {
    state.eventPositionBatchesById[batchId] = batch;
    state.quarantinedLegacyEventPositionBatchesById[quarantineId] = quarantined;
    state.participantIntervalsById[intervalId] = {
      eventId: batch.eventId,
      userId: batch.userId,
      deviceInstanceId: batch.deviceInstanceId,
      acceptedAt: "2026-08-31T00:59:00.000Z"
    };
  });
  await assert.rejects(
    store.transact((state) => {
      delete state.eventPositionBatchesById[batchId];
    }),
    /append-only and cannot be deleted/
  );
  await assert.rejects(
    store.transact((state) => {
      state.eventPositionBatchesById[batchId]!.fingerprint = "changed";
    }),
    /append-only and cannot be modified/
  );
  await assert.rejects(
    store.transact((state) => {
      (state.quarantinedLegacyEventPositionBatchesById[quarantineId] as Record<string, unknown>)
        .legacy = false;
    }),
    /append-only and cannot be modified/
  );
  await store.transact((state) => {
    const interval = state.participantIntervalsById[intervalId]!;
    interval.endedAt = "2026-08-31T01:01:00.000Z";
    interval.endReason = "CANCELLED";
  });
  await assert.rejects(
    store.transact((state) => {
      state.participantIntervalsById[intervalId]!.endedAt = "2026-08-31T01:02:00.000Z";
    }),
    /immutable after it ends/
  );
  await assert.rejects(
    store.transact((state) => {
      state.participantIntervalsById[`invalid-time-${suffix}`] = {
        eventId: batch.eventId,
        userId: batch.userId,
        deviceInstanceId: `invalid-time-device-${suffix}`,
        acceptedAt: "2026-08-31T01:02:00.000Z",
        endedAt: "2026-08-31T01:01:59.999Z",
        endReason: "CANCELLED"
      };
    }),
    /endedAt cannot be earlier than acceptedAt/
  );
  assert.deepEqual(store.read((state) => state.eventPositionBatchesById[batchId]), batch);
  assert.deepEqual(
    store.read((state) => state.quarantinedLegacyEventPositionBatchesById[quarantineId]),
    quarantined
  );
}

test("notification storage rejects corruption and preserves immutable queued and completed facts", async () => {
  const row: NotificationRecord = {
    id: "outbox-test", eventId: "event-test", name: "event:resolved",
    recipient: { deviceInstanceId: "test-device", companionPairId: "test-pair" },
    payload: { schemaVersion: "2.0", messageId: "event-resolved:resolution-test", eventId: "event-test",
      occurredAt: "2026-08-31T01:00:00.000Z", state: "RESOLVED", recruitmentState: "COMPLETED" },
    status: "PENDING", attempts: 0, nextAttemptAt: "2026-08-31T01:00:00.000Z"
  };
  const seed = emptyState();
  seed.notificationOutboxById[row.id] = row;
  for (const corrupt of [null, [], "broken"]) {
    assert.throws(() => new MemoryStateStore({ ...seed, notificationOutboxById: corrupt } as never), /refusing to discard evidence/);
  }
  assert.throws(() => new MemoryStateStore({ ...seed, notificationOutboxById: {
    [row.id]: { ...row, payload: { ...row.payload, internalUserId: "private-marker" } }
  } }), /Notification payload/);
  const store = new MemoryStateStore(seed);
  await assert.rejects(store.transact(state => { delete state.notificationOutboxById[row.id]; }), /cannot be deleted/);
  await assert.rejects(store.transact(state => { state.notificationOutboxById[row.id]!.recipient.userId = "someone-else"; }), /immutable/);
  await assert.rejects(store.transact(state => { state.notificationOutboxById[row.id]!.payload.messageId = "changed"; }), /immutable/);
  assert.deepEqual(store.read(state => state.notificationOutboxById[row.id]), row);
  await store.transact(state => {
    const current = state.notificationOutboxById[row.id]!;
    current.attempts = 1;
    current.status = "DISPATCHED";
    current.completedAt = "2026-08-31T01:00:01.000Z";
  });
  await assert.rejects(store.transact(state => {
    const current = state.notificationOutboxById[row.id]!;
    current.status = "PENDING";
    delete current.completedAt;
  }), /immutable after completion/);
});

test("durable store recovers the last valid backup instead of resetting truth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-store-"));
  const file = join(directory, "state.json");
  try {
    const store = await JsonFileStateStore.open(file, [seedAed]);
    const legacyBatch = {
      batchId: "legacy-backup-batch",
      eventId: "legacy-backup-event",
      deviceInstanceId: "legacy-backup-device",
      kind: "P",
      fingerprint: "legacy-backup-fingerprint",
      receivedAt: "2026-08-31T01:00:01.000Z",
      records: [{
        recordId: "legacy-backup-record",
        batchId: "legacy-backup-batch",
        eventId: "legacy-backup-event",
        deviceInstanceId: "legacy-backup-device",
        kind: "P",
        observedAt: "2026-08-31T01:00:00.000Z",
        serverReceivedAt: "2026-08-31T01:00:01.000Z",
        status: "FIX",
        position: {
          kind: "P",
          latitude: 22.2,
          longitude: 113.5,
          accuracyMeters: 10
        },
        appliedToLatest: true,
        ignoredAsStale: false
      }]
    };
    await store.transact((state) => {
      state.timelineByEventId[entry("first").eventId] = [entry("first")];
      (state as unknown as { eventPositionBatchesById: Record<string, unknown> })
        .eventPositionBatchesById[legacyBatch.batchId] = legacyBatch;
    });
    await store.transact((state) => {
      state.timelineByEventId[entry("second").eventId]!.push(entry("second"));
    });
    await writeFile(file, "{broken-json", "utf8");

    const recovered = await JsonFileStateStore.open(file, [seedAed]);
    const timeline = recovered.read((state) => state.timelineByEventId[entry("first").eventId]);
    assert.deepEqual(timeline?.map((item) => item.id), ["first"]);
    assert.deepEqual(recovered.read((state) => state.eventPositionBatchesById), {});
    assert.deepEqual(
      recovered.read((state) =>
        state.quarantinedLegacyEventPositionBatchesById[legacyBatch.batchId]),
      legacyBatch
    );
    const restoredPayload = await readFile(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(assertString(restoredPayload)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable store refuses to erase state when both main and backup are corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-store-corrupt-"));
  const file = join(directory, "state.json");
  try {
    await writeFile(file, "{}", "utf8");
    await writeFile(`${file}.bak`, "not-json", "utf8");
    await assert.rejects(
      JsonFileStateStore.open(file, [seedAed]),
      /refusing to reset durable truth/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed transaction does not publish or persist its draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-store-rollback-"));
  const file = join(directory, "state.json");
  try {
    const store = await JsonFileStateStore.open(file, [seedAed]);
    await assert.rejects(
      store.transact((state) => {
        state.aeds = [];
        throw new Error("rollback");
      }),
      /rollback/
    );
    assert.equal(store.read((state) => state.aeds.length), 1);
    const persisted = JSON.parse(await readFile(file, "utf8")) as { aeds: unknown[] };
    assert.equal(persisted.aeds.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Memory, JSON, and SQLite stores protect append-only evidence and one-time intervals", async () => {
  const memory = new MemoryStateStore(emptyState([seedAed]));
  await assertHistoryIsAppendOnly(memory, "memory");

  const directory = await mkdtemp(join(tmpdir(), "aedresponse-store-append-only-history-"));
  const jsonFile = join(directory, "state.json");
  const sqliteFile = join(directory, "state.sqlite");
  let json: JsonFileStateStore | undefined;
  let sqlite: SQLiteStateStore | undefined;
  try {
    json = await JsonFileStateStore.open(jsonFile, [seedAed]);
    await assertHistoryIsAppendOnly(json, "json");
    sqlite = await SQLiteStateStore.open(sqliteFile, [seedAed]);
    await assertHistoryIsAppendOnly(sqlite, "sqlite");
  } finally {
    await sqlite?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite store persists only the latest device position across close and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-sqlite-store-"));
  const file = join(directory, "state.sqlite");
  try {
    const deviceId = "REDACTED-SUPPLEMENT-ID-46de918f5446";
    const store = await SQLiteStateStore.open(file, [seedAed]);
    await store.transact((state) => {
      state.devices[deviceId] = {
        deviceInstanceId: deviceId,
        deviceKind: "IPHONE",
        companionPairId: "REDACTED-SUPPLEMENT-ID-7f1a10d9cd75",
        agreements: {},
        capabilities: { notificationAuthorized: true, locationAuthorized: true },
        availableForResponse: true,
        presenceObservedAt: "2026-08-31T01:00:00.000Z",
        lastSeenAt: "2026-08-31T01:00:00.000Z",
        lastBootstrapAt: "2026-08-31T01:00:00.000Z",
        latestPosition: {
          positionUpdateId: "REDACTED-SUPPLEMENT-ID-97fdd5e0b0f0",
          position: {
            kind: "R",
            latitude: 22.1,
            longitude: 113.5,
            accuracyMeters: 10
          },
          observedAt: "2026-08-31T01:00:00.000Z",
          serverReceivedAt: "2026-08-31T01:00:01.000Z"
        }
      };
    });
    await store.transact((state) => {
      state.devices[deviceId]!.latestPosition = {
        positionUpdateId: "REDACTED-SUPPLEMENT-ID-0fb7014b526d",
        position: {
          kind: "R",
          latitude: 22.2,
          longitude: 113.6,
          accuracyMeters: 8
        },
        observedAt: "2026-08-31T01:00:02.000Z",
        serverReceivedAt: "2026-08-31T01:00:03.000Z"
      };
    });
    await assert.rejects(
      store.transact((state) => {
        const latest = state.devices[deviceId]!.latestPosition as unknown as Record<string, unknown>;
        latest.eventId = "REDACTED-SUPPLEMENT-ID-bdc6dbbc0f91";
      }),
      /eventId is forbidden for R/
    );
    await assert.rejects(
      store.transact((state) => {
        state.devices[deviceId]!.latestPosition = {
          positionUpdateId: "REDACTED-SUPPLEMENT-ID-dffb1b03ea02",
          position: {
            kind: "P",
            latitude: 22.2,
            longitude: 113.6,
            accuracyMeters: 8
          },
          observedAt: "2026-08-31T01:00:04.000Z",
          serverReceivedAt: "2026-08-31T01:00:05.000Z"
        } as unknown as NonNullable<(typeof state.devices)[string]["latestPosition"]>;
      }),
      /eventId is required for P/
    );
    await store.close();

    const reopened = await SQLiteStateStore.open(file, [seedAed]);
    const latest = reopened.read((state) => state.devices[deviceId]?.latestPosition);
    assert.equal(latest?.positionUpdateId, "REDACTED-SUPPLEMENT-ID-0fb7014b526d");
    assert.equal(latest?.position.latitude, 22.2);
    await reopened.close();

    const database = new Database(file, { readonly: true });
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), ["state_items", "state_metadata"]);
    const deviceRows = database.prepare(
      "SELECT COUNT(*) AS count FROM state_items WHERE collection = 'devices' AND item_key = ?"
    ).get(deviceId) as { count: number };
    assert.equal(deviceRows.count, 1);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite transaction rollback and legacy JSON import preserve durable truth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-sqlite-migration-"));
  const legacyFile = join(directory, "state.json");
  const sqliteFile = join(directory, "state.sqlite");
  try {
    const legacy = await JsonFileStateStore.open(legacyFile, [seedAed]);
    await legacy.transact((state) => {
      state.timelineByEventId[entry("legacy").eventId] = [entry("legacy")];
    });

    const store = await SQLiteStateStore.open(sqliteFile, [], legacyFile);
    assert.equal(store.read((state) => state.aeds[0]?.id), seedAed.id);
    assert.equal(
      store.read((state) => state.timelineByEventId[entry("legacy").eventId]?.[0]?.id),
      "legacy"
    );
    await assert.rejects(
      store.transact((state) => {
        state.aeds = [];
        throw new Error("sqlite rollback");
      }),
      /sqlite rollback/
    );
    assert.equal(store.read((state) => state.aeds.length), 1);
    await store.close();

    const reopened = await SQLiteStateStore.open(sqliteFile, []);
    assert.equal(reopened.read((state) => state.aeds.length), 1);
    await reopened.close();
    await assert.doesNotReject(readFile(legacyFile, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no-op transactions do not advance durable SQLite revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-sqlite-noop-"));
  const file = join(directory, "state.sqlite");
  try {
    const store = await SQLiteStateStore.open(file, [seedAed]);
    const revision = () => {
      const database = new Database(file, { readonly: true });
      const row = database.prepare(
        "SELECT value FROM state_metadata WHERE key = 'revision'"
      ).get() as { value: string };
      database.close();
      return row.value;
    };

    assert.equal(revision(), "1");
    await store.transact(() => undefined);
    assert.equal(revision(), "1");

    await store.transact((state) => {
      state.timelineByEventId.noopRegression = [entry("noop-regression")];
    });
    assert.equal(revision(), "2");

    await store.transact(() => undefined);
    assert.equal(revision(), "2");
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit null recruitment stage survives a durable store reopen until the first valid P", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-recruitment-clock-"));
  const file = join(directory, "state.json");
  const eventId = "REDACTED-SUPPLEMENT-ID-7f97dfcb0c9d";
  const observation: WatchEmergencyObservation = {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: "2026-08-31T01:00:00.000Z",
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: null,
    locationUnavailableReason: "watch location unavailable"
  };
  const event: EventRecord = {
    id: eventId,
    observation,
    observationFingerprint: fingerprint(observation),
    patientPairId: "REDACTED-SUPPLEMENT-ID-e4fbe7974490",
    patientUserId: "user-recruitment-clock",
    patientDeviceIds: [],
    state: "ACTIVE",
    recruitmentState: "RECRUITING",
    triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentStageStartedAt: null,
    createdAt: "2026-08-31T01:00:00.000Z",
    coordinationRevision: 1,
    assignmentRevision: 0,
    unavailableAedIds: []
  };
  try {
    const store = await JsonFileStateStore.open(file, [seedAed]);
    await store.transact((state) => {
      state.events[eventId] = event;
    });
    assert.equal(store.read((state) => state.events[eventId]?.recruitmentStageStartedAt), null);

    const reopened = await JsonFileStateStore.open(file, [seedAed]);
    assert.equal(reopened.read((state) => state.events[eventId]?.recruitmentStageStartedAt), null);
    await reopened.transact((state) => {
      state.events[eventId]!.statusConfirmationCycleStartedAt = event.createdAt;
      state.events[eventId]!.statusConfirmationHistory = [{
        confirmationId: "REDACTED-SUPPLEMENT-ID-bd16cc5603ec",
        cycleStartedAt: event.createdAt,
        sentAt: "2026-08-31T01:30:00.000Z",
        responseDeadlineAt: "2026-08-31T01:35:00.000Z",
        state: "PENDING"
      }];
      state.events[eventId]!.statusConfirmation =
        state.events[eventId]!.statusConfirmationHistory[0]!;
      state.events[eventId]!.exitedResponderUserIds = ["user-exited"];
      state.participantExitsById["REDACTED-SUPPLEMENT-ID-a09c482aba55"] = {
        exitId: "REDACTED-SUPPLEMENT-ID-a09c482aba55",
        eventId,
        deviceInstanceId: "REDACTED-SUPPLEMENT-ID-5f91b6da66ce",
        userId: "user-exited",
        exitedAt: "2026-08-31T01:20:00.000Z",
        fingerprint: "exit-fingerprint"
      };
    });
    const recovered = await JsonFileStateStore.open(file, [seedAed]);
    assert.equal(
      recovered.read((state) => state.events[eventId]?.statusConfirmation?.state),
      "PENDING"
    );
    assert.deepEqual(
      recovered.read((state) => state.events[eventId]?.exitedResponderUserIds),
      ["user-exited"]
    );
    assert.equal(
      recovered.read((state) => Object.keys(state.participantExitsById).length),
      1
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy devices migrate fail-safe and SQLite close waits for queued persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-sqlite-safe-migration-"));
  const legacyFile = join(directory, "state.json");
  const sqliteFile = join(directory, "state.sqlite");
  const deviceId = "REDACTED-SUPPLEMENT-ID-2a54f5be0aef";
  try {
    const legacy = {
      schemaVersion: "2.0",
      devices: {
        [deviceId]: {
          deviceInstanceId: deviceId,
          deviceKind: "IPHONE",
          companionPairId: "REDACTED-SUPPLEMENT-ID-59e7cf96e160",
          agreements: {
            VOLUNTEER_RESPONDER: {
              version: "2.0",
              acceptedAt: "2026-08-31T01:00:00.000Z"
            }
          },
          responderPosition: {
            position: {
              kind: "R",
              latitude: 22.2,
              longitude: 113.5,
              accuracyMeters: 10
            },
            observedAt: "2026-08-31T01:00:00.000Z"
          },
          lastBootstrapAt: "2026-08-31T01:00:01.000Z"
        }
      },
      sessionsByTokenHash: {},
      events: {},
      deliveries: {},
      assignments: {},
      timelineByEventId: {},
      aedReceiptsById: {},
      aedReceiptIdByBusinessKey: {},
      aedReceiptIdByEventAed: {},
      aedUnavailableByReportId: {},
      resolutionsById: {},
      eventPositionBatchesById: {
        "legacy-position-batch": {
          batchId: "legacy-position-batch",
          eventId: "legacy-event",
          deviceInstanceId: deviceId,
          kind: "P",
          fingerprint: "legacy-fingerprint",
          receivedAt: "2026-08-31T01:00:01.000Z",
          records: [{
            recordId: "legacy-position-record",
            batchId: "legacy-position-batch",
            eventId: "legacy-event",
            deviceInstanceId: deviceId,
            kind: "P",
            observedAt: "2026-08-31T01:00:00.000Z",
            serverReceivedAt: "2026-08-31T01:00:01.000Z",
            status: "FIX",
            position: {
              kind: "P",
              latitude: 22.2,
              longitude: 113.5,
              accuracyMeters: 10
            },
            appliedToLatest: true,
            ignoredAsStale: false
          }]
        }
      },
      aeds: [seedAed]
    };
    await writeFile(legacyFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const store = await SQLiteStateStore.open(sqliteFile, [], legacyFile);
    const migrated = store.read((state) => state.devices[deviceId]);
    assert.equal(migrated?.availableForResponse, false);
    assert.deepEqual(migrated?.capabilities, {
      notificationAuthorized: false,
      locationAuthorized: false
    });
    assert.equal(migrated?.latestPosition?.position.kind, "R");
    assert.deepEqual(store.read((state) => state.eventPositionBatchesById), {});
    assert.deepEqual(
      store.read((state) => state.quarantinedLegacyEventPositionBatchesById["legacy-position-batch"]),
      legacy.eventPositionBatchesById["legacy-position-batch"]
    );

    let releaseMutation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const transaction = store.transact(async (state) => {
      await gate;
      state.timelineByEventId[entry("queued").eventId] = [entry("queued")];
    });
    const closing = store.close();
    releaseMutation();
    await Promise.all([transaction, closing]);

    const reopened = await SQLiteStateStore.open(sqliteFile, []);
    assert.equal(
      reopened.read((state) => state.timelineByEventId[entry("queued").eventId]?.[0]?.id),
      "queued"
    );
    assert.deepEqual(reopened.read((state) => state.eventPositionBatchesById), {});
    assert.deepEqual(
      reopened.read((state) =>
        state.quarantinedLegacyEventPositionBatchesById["legacy-position-batch"]),
      legacy.eventPositionBatchesById["legacy-position-batch"]
    );
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy patient sources migrate without inferring a triggering Watch and bind only on replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-source-migration-"));
  const legacyFile = join(directory, "state.json");
  const sqliteFile = join(directory, "state.sqlite");
  const pairId = "REDACTED-SUPPLEMENT-ID-1ffea1f87efe";
  const iPhoneId = "REDACTED-SUPPLEMENT-ID-5f501e0154a4";
  const watchId = "REDACTED-SUPPLEMENT-ID-ccc090b51a68";
  const triggerEventId = "REDACTED-SUPPLEMENT-ID-c4a5a0189716";
  const iPhoneEventId = "REDACTED-SUPPLEMENT-ID-4ad619075224";
  const at = (seconds: number): string =>
    new Date(Date.parse("2026-08-31T01:00:00.000Z") + seconds * 1_000).toISOString();
  const watchObservation = (eventId: string): WatchEmergencyObservation => ({
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NO_RESPONSE",
    callFirstObservedAt: at(2),
    callObservationSemantics: "FIRST_OBSERVED_OUTGOING_STATE",
    patientPosition: {
      kind: "P",
      latitude: 22.1987,
      longitude: 113.5439,
      accuracyMeters: 10
    }
  });
  const event = (
    eventId: string,
    source: "WATCH_TRIGGER" | "IPHONE_CONTINUOUS"
  ) => {
    const observation = watchObservation(eventId);
    return {
      id: eventId,
      observation,
      observationFingerprint: fingerprint(observation),
      patientPairId: pairId,
      patientDeviceIds: [iPhoneId],
      patientPosition: {
        positionUpdateId: eventId,
        source,
        position: observation.patientPosition,
        observedAt: at(source === "WATCH_TRIGGER" ? 2 : 3),
        serverReceivedAt: at(source === "WATCH_TRIGGER" ? 2 : 4)
      },
      state: "ACTIVE",
      recruitmentState: "RECRUITING",
      triggerSource: "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED",
      watchFallbackPermit: {
        reachabilityReportId: "legacy-report",
        issuedAt: at(2),
        authorityRevision: 1
      },
      previousWatchReachability: {
        reportId: "legacy-report-previous",
        observedAt: at(1),
        serverReceivedAt: at(1),
        activationState: "ACTIVATED",
        iphoneReachable: false,
        consecutiveUnreachableReportCount: 1
      },
      createdAt: at(2),
      coordinationRevision: 1,
      assignmentRevision: 0,
      unavailableAedIds: []
    };
  };

  try {
    const legacy = {
      schemaVersion: "2.0",
      devices: {
        [iPhoneId]: {
          deviceInstanceId: iPhoneId,
          deviceKind: "IPHONE",
          companionPairId: pairId,
          agreements: {
            PATIENT: { version: "2.0", acceptedAt: at(0) },
            VOLUNTEER_RESPONDER: { version: "2.0", acceptedAt: at(0) }
          },
          capabilities: { notificationAuthorized: true, locationAuthorized: true },
          availableForResponse: true,
          presenceObservedAt: at(0),
          lastSeenAt: at(0),
          lastBootstrapAt: at(0)
        },
        [watchId]: {
          deviceInstanceId: watchId,
          deviceKind: "WATCH",
          companionPairId: pairId,
          agreements: {},
          capabilities: { notificationAuthorized: false, locationAuthorized: false },
          availableForResponse: false,
          presenceObservedAt: at(0),
          lastSeenAt: at(0),
          lastBootstrapAt: at(0)
        }
      },
      sessionsByTokenHash: {},
      events: {
        [triggerEventId]: event(triggerEventId, "WATCH_TRIGGER"),
        [iPhoneEventId]: event(iPhoneEventId, "IPHONE_CONTINUOUS")
      },
      deliveries: {},
      assignments: {},
      timelineByEventId: { [triggerEventId]: [], [iPhoneEventId]: [] },
      aedReceiptsById: {},
      aedReceiptIdByBusinessKey: {},
      aedReceiptIdByEventAed: {},
      aedUnavailableByReportId: {},
      resolutionsById: {},
      watchReachabilityReceiptsById: {
        "legacy-report": {
          eventId: triggerEventId,
          deviceInstanceId: watchId,
          fingerprint: "legacy",
          recordedAt: at(2)
        }
      },
      aeds: [seedAed]
    };
    await writeFile(legacyFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const store = await SQLiteStateStore.open(sqliteFile, [], legacyFile);
    const migrated = store.read((state) => ({
      trigger: state.events[triggerEventId],
      iphone: state.events[iPhoneEventId]
    }));
    assert.equal(migrated.trigger?.patientPosition?.source, "WATCH_TRIGGER_SNAPSHOT");
    assert.equal(migrated.iphone?.patientPosition?.source, "IPHONE_PRIMARY");
    assert.equal(migrated.iphone?.iphonePatientPosition?.source, "IPHONE_PRIMARY");
    assert.equal(migrated.trigger?.triggeringWatchDeviceId, undefined);
    assert.equal(migrated.iphone?.triggeringWatchDeviceId, undefined);

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
    const service = new AEDResponseService(store, config, undefined, () => new Date(at(10)));
    const watchPrincipal: DevicePrincipal = {
      kind: "DEVICE",
      tokenHash: "legacy-watch-token-hash",
      sessionId: "REDACTED-SUPPLEMENT-ID-3f47986ae878",
      deviceInstanceId: watchId,
      deviceKind: "WATCH",
      companionPairId: pairId,
      scopes: ["watch:report", "watch:fallback"],
      expiresAt: at(3_600)
    };
    const fallbackPositionUpdateId = "REDACTED-SUPPLEMENT-ID-219d268f7ba7";
    await assert.rejects(
      service.updateWatchFallbackPatientPosition(
        watchPrincipal,
        triggerEventId,
        fallbackPositionUpdateId,
        {
          schemaVersion: "2.0",
          eventId: triggerEventId,
          positionUpdateId: fallbackPositionUpdateId,
          observedAt: at(10),
          patientPosition: {
            kind: "P",
            latitude: 22.1987,
            longitude: 113.5439,
            accuracyMeters: 10
          },
          activationState: "ACTIVATED",
          iphoneReachable: false,
          networkAvailable: true
        }
      ),
      /Only the Watch that triggered/
    );
    const replay = await service.reportWatchObservation(
      watchPrincipal,
      triggerEventId,
      watchObservation(triggerEventId)
    );
    assert.equal(replay.created, false);
    assert.equal(
      store.read((state) => state.events[triggerEventId]?.triggeringWatchDeviceId),
      watchId
    );
    assert.equal(
      store.read((state) => "watchFallbackPermit" in (state.events[triggerEventId] ?? {})),
      false
    );
    assert.equal(
      store.read((state) => "watchReachabilityReceiptsById" in state),
      false
    );
    await store.close();

    const reopened = await SQLiteStateStore.open(sqliteFile, []);
    assert.equal(
      reopened.read((state) => state.events[triggerEventId]?.triggeringWatchDeviceId),
      watchId
    );
    assert.equal(
      reopened.read((state) => state.events[iPhoneEventId]?.iphonePatientPosition?.source),
      "IPHONE_PRIMARY"
    );
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite reopens append-only event position batches without reducing them to latest position state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-sqlite-event-position-batch-"));
  const sqliteFile = join(directory, "state.sqlite");
  const eventId = "REDACTED-SUPPLEMENT-ID-2b53430afaad";
  const batchId = "REDACTED-SUPPLEMENT-ID-5f3dee5f482f";
  const recordId = "REDACTED-SUPPLEMENT-ID-80c7ffc573e7";
  try {
    const store = await SQLiteStateStore.open(sqliteFile, [seedAed]);
    await store.transact((state) => {
      state.eventPositionBatchesById[batchId] = {
        batchId,
        eventId,
        userId: "store-test-user",
        deviceInstanceId: "REDACTED-SUPPLEMENT-ID-e3515c5cd78c",
        kind: "P",
        fingerprint: "batch-fingerprint",
        receivedAt: "2026-08-31T01:00:01.000Z",
        records: [{
          recordId,
          batchId,
          eventId,
          userId: "store-test-user",
          deviceInstanceId: "REDACTED-SUPPLEMENT-ID-e3515c5cd78c",
          kind: "P",
          slotAt: "2026-08-31T01:00:00.000Z",
          serverReceivedAt: "2026-08-31T01:00:01.000Z",
          status: "FIX",
          fixObservedAt: "2026-08-31T01:00:00.500Z",
          position: {
            kind: "P",
            latitude: 22.1987,
            longitude: 113.5439,
            accuracyMeters: 12
          },
          appliedToLatest: true,
          ignoredAsStale: false
        }]
      };
    });
    await store.close();

    const reopened = await SQLiteStateStore.open(sqliteFile, []);
    const recovered = reopened.read((state) => state.eventPositionBatchesById[batchId]);
    assert.equal(recovered?.records.length, 1);
    assert.equal(recovered?.records[0]?.recordId, recordId);
    assert.equal(recovered?.records[0]?.status, "FIX");
    assert.equal(recovered?.records[0]?.position.kind, "P");
    await reopened.close();

    const database = new Database(sqliteFile, { readonly: true });
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM state_items WHERE collection = 'eventPositionBatchesById' AND item_key = ?"
    ).get(batchId) as { count: number };
    assert.equal(row.count, 1);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite quarantines legacy event position batches without losing raw evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-sqlite-legacy-position-quarantine-"));
  const sqliteFile = join(directory, "state.sqlite");
  const batchId = "legacy-quarantine-batch";
  const legacyBatch = {
    batchId,
    eventId: "legacy-quarantine-event",
    deviceInstanceId: "legacy-quarantine-device",
    kind: "P",
    fingerprint: "legacy-quarantine-fingerprint",
    receivedAt: "2026-08-31T01:00:01.000Z",
    records: [{
      recordId: "legacy-quarantine-record",
      batchId,
      eventId: "legacy-quarantine-event",
      deviceInstanceId: "legacy-quarantine-device",
      kind: "P",
      observedAt: "2026-08-31T01:00:00.000Z",
      serverReceivedAt: "2026-08-31T01:00:01.000Z",
      status: "FIX",
      position: {
        kind: "P",
        latitude: 22.2,
        longitude: 113.5,
        accuracyMeters: 10
      },
      appliedToLatest: true,
      ignoredAsStale: false
    }]
  };
  const legacyProtoBatch = {
    ...legacyBatch,
    batchId: "__proto__",
    eventId: "legacy-proto-event",
    deviceInstanceId: "legacy-proto-device",
    fingerprint: "legacy-proto-fingerprint",
    records: [{
      ...legacyBatch.records[0],
      recordId: "legacy-proto-record",
      batchId: "__proto__",
      eventId: "legacy-proto-event",
      deviceInstanceId: "legacy-proto-device"
    }]
  };
  try {
    const initial = await SQLiteStateStore.open(sqliteFile, [seedAed]);
    await initial.close();
    const database = new Database(sqliteFile);
    database.prepare(
      "INSERT INTO state_items(collection, item_key, payload) VALUES (?, ?, ?)"
    ).run("eventPositionBatchesById", batchId, JSON.stringify(legacyBatch));
    database.prepare(
      "INSERT INTO state_items(collection, item_key, payload) VALUES (?, ?, ?)"
    ).run("eventPositionBatchesById", "__proto__", JSON.stringify(legacyProtoBatch));
    database.close();

    const reopened = await SQLiteStateStore.open(sqliteFile, []);
    assert.deepEqual(reopened.read((state) => state.eventPositionBatchesById), {});
    assert.deepEqual(
      reopened.read((state) =>
        state.quarantinedLegacyEventPositionBatchesById[batchId]),
      legacyBatch
    );
    assert.deepEqual(
      reopened.read((state) =>
        state.quarantinedLegacyEventPositionBatchesById["legacy:__proto__"]),
      legacyProtoBatch
    );
    await reopened.close();

    const reopenedAgain = await SQLiteStateStore.open(sqliteFile, []);
    assert.deepEqual(reopenedAgain.read((state) => state.eventPositionBatchesById), {});
    assert.deepEqual(
      reopenedAgain.read((state) =>
        state.quarantinedLegacyEventPositionBatchesById[batchId]),
      legacyBatch
    );
    assert.deepEqual(
      reopenedAgain.read((state) =>
        state.quarantinedLegacyEventPositionBatchesById["legacy:__proto__"]),
      legacyProtoBatch
    );
    await reopenedAgain.close();

    const persisted = new Database(sqliteFile, { readonly: true });
    const activeRows = persisted.prepare(
      "SELECT COUNT(*) AS count FROM state_items WHERE collection = 'eventPositionBatchesById' AND item_key = ?"
    ).get(batchId) as { count: number };
    const quarantineRows = persisted.prepare(
      "SELECT COUNT(*) AS count FROM state_items WHERE collection = 'quarantinedLegacyEventPositionBatchesById' AND item_key = ?"
    ).get(batchId) as { count: number };
    assert.equal(activeRows.count, 0);
    assert.equal(quarantineRows.count, 1);
    const activeProtoRows = persisted.prepare(
      "SELECT COUNT(*) AS count FROM state_items WHERE collection = 'eventPositionBatchesById' AND item_key = ?"
    ).get("__proto__") as { count: number };
    const quarantineProtoRows = persisted.prepare(
      "SELECT COUNT(*) AS count FROM state_items WHERE collection = 'quarantinedLegacyEventPositionBatchesById' AND item_key = ?"
    ).get("legacy:__proto__") as { count: number };
    assert.equal(activeProtoRows.count, 0);
    assert.equal(quarantineProtoRows.count, 1);
    persisted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function assertString(value: string): string {
  assert.equal(typeof value, "string");
  return value;
}


test("entity views are detached committed snapshots for each built-in store", async t => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-entity-read-"));
  const stores: [string, StateStore][] = [
    ["memory", new MemoryStateStore(emptyState())],
    ["json", await JsonFileStateStore.open(join(directory, "state.json"), [])],
    ["sqlite", await SQLiteStateStore.open(join(directory, "state.sqlite"), [])]
  ];
  try {
    for (const [name, store] of stores) await t.test(name, async () => {
      assert.equal(typeof store.readEntities, "function");
      await store.transact(state => {
        state.timelineByEventId["test-event"] = [{id: "entry-one", eventId: "test-event",
          occurredAt: "2026-09-09T00:00:00.000Z", kind: "EVENT_ACTIVATED", message: "original"}];
      });
      const before = readEntities(store, view => view);
      const detached = before.get("timelineByEventId", "test-event")!;
      detached[0]!.message = "consumer mutation";
      assert.equal(before.get("timelineByEventId", "test-event")![0]!.message, "original");
      assert.equal(before.get("timelineByEventId", "missing"), undefined);
      assert.equal(before.get("timelineByEventId", "__proto__"), undefined);
      await store.transact(state => {
        state.timelineByEventId["test-event"]!.push({id: "entry-two", eventId: "test-event",
          occurredAt: "2026-09-09T00:00:01.000Z", kind: "EVENT_ACTIVATED", message: "next"});
      });
      assert.equal(before.get("timelineByEventId", "test-event")!.length, 1);
      assert.equal(readEntities(store, view => view.get("timelineByEventId", "test-event")!.length), 2);
      assert.equal(store.read(state => state.timelineByEventId["test-event"]![0]!.message), "original");
    });
    const sqlite = stores[2]![1];
    await sqlite.close?.();
    assert.throws(() => readEntities(sqlite, view => view.get("events", "unknown")), /closed/);
  } finally {
    for (const [, store] of stores) await store.close?.();
    await rm(directory, {recursive: true, force: true});
  }
});

test("legacy custom StateStore entity compatibility takes one detached read and propagates read failures", async () => {
  const inner = new MemoryStateStore(emptyState());
  let reads = 0;
  let fail = false;
  const legacy: StateStore = {
    read: reader => { reads++; if (fail) throw new Error("read unavailable"); return inner.read(reader); },
    transact: mutation => inner.transact(mutation)
  };
  assert.equal(readEntities(legacy, view => view.get("devices", "missing")), undefined);
  assert.equal(reads, 1);
  fail = true;
  assert.throws(() => readEntities(legacy, view => view.get("devices", "missing")), /read unavailable/);
});


test("bounded entity selection never exposes live state and obeys limit", () => {
  const state = emptyState();
  for (const id of ["a", "b", "c"]) state.users[id] = {
    userId: id, createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z"
  };
  const view = createStateReadView(state);
  const result = view.select("users", value => value.userId !== "a", 1);
  assert.deepEqual(result.map(value => value.userId), ["b"]);
  result[0]!.userId = "changed";
  assert.equal(state.users.b!.userId, "b");
  assert.deepEqual(view.select("users", () => true, 0), []);
  assert.throws(() => view.select("users", () => true, -1));
});
