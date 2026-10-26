/**
 * Isolated storage growth and serialized-transaction probe.
 *
 * This intentionally uses synthetic timeline, event-position and notification
 * records in a temporary SQLite database. It measures restart/read/write costs
 * and queue growth; it is not a production capacity, concurrency SLA or rescue
 * scenario.
 */
import { performance } from "node:perf_hooks";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureStorageCost, SQLiteStateStore } from "../../src/store.js";

const BASE_TIME = Date.parse("2026-09-09T00:00:00.000Z");
const directory = await mkdtemp(join(tmpdir(), "aedresponse-storage-load-"));

function iso(offsetSeconds: number): string {
  return new Date(BASE_TIME + offsetSeconds * 1_000).toISOString();
}

function summary(values: number[]): { medianMs: number; maxMs: number } {
  const ordered = [...values].sort((left, right) => left - right);
  return {
    medianMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
    maxMs: ordered.at(-1) ?? 0
  };
}

async function seed(
  store: SQLiteStateStore,
  historyEntries: number,
  notificationRows: number,
  positionBatches: number
): Promise<void> {
  await store.transact(state => {
    state.timelineByEventId.synthetic = Array.from({ length: historyEntries }, (_, index) => ({
      id: `audit-${index}`,
      eventId: "synthetic",
      occurredAt: iso(index),
      kind: "EVENT_ACTIVATED",
      message: "Synthetic retained history; never a real user or rescue event."
    }));

    for (let index = 0; index < notificationRows; index += 1) {
      const eventId = `synthetic-event-${index}`;
      const id = `notification-${index}`;
      state.notificationOutboxById[id] = {
        id,
        eventId,
        name: "event:resolved",
        recipient: {
          deviceInstanceId: `device-${index}`,
          companionPairId: `pair-${index}`,
          userId: `user-${index}`,
          accountId: `account-${index}`
        },
        payload: {
          schemaVersion: "2.0",
          messageId: `message-${index}`,
          eventId,
          occurredAt: iso(index),
          state: "RESOLVED",
          recruitmentState: "COMPLETED"
        },
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: iso(index)
      };
    }

    for (let index = 0; index < positionBatches; index += 1) {
      const batchId = `batch-${index}`;
      const eventId = `position-event-${index}`;
      const userId = `position-user-${index}`;
      const deviceInstanceId = `position-device-${index}`;
      const slotAt = iso(index);
      state.eventPositionBatchesById[batchId] = {
        batchId,
        eventId,
        userId,
        deviceInstanceId,
        kind: "P",
        fingerprint: `fingerprint-${index}`,
        receivedAt: iso(index + 1),
        records: [{
          recordId: `record-${index}`,
          batchId,
          eventId,
          userId,
          deviceInstanceId,
          kind: "P",
          slotAt,
          serverReceivedAt: iso(index + 1),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX",
          appliedToLatest: false,
          ignoredAsStale: false
        }]
      };
    }
  });
}

const cases = [
  { historyEntries: 0, notificationRows: 0, positionBatches: 0 },
  { historyEntries: 1_000, notificationRows: 25, positionBatches: 25 },
  { historyEntries: 10_000, notificationRows: 100, positionBatches: 100 },
  { historyEntries: 50_000, notificationRows: 500, positionBatches: 500 }
];

const rows: Array<Record<string, unknown>> = [];
for (const input of cases) {
  const file = join(directory, `${input.historyEntries}.sqlite`);
  const openedAt = performance.now();
  const store = await SQLiteStateStore.open(file, []);
  const coldOpenMs = performance.now() - openedAt;
  await seed(store, input.historyEntries, input.notificationRows, input.positionBatches);

  const fullReadStarted = performance.now();
  const fullReadBytes = store.read(state => Buffer.byteLength(JSON.stringify(state)));
  const fullReadMs = performance.now() - fullReadStarted;
  const storageCost = store.read(state => measureStorageCost(state));

  const entityReadStarted = performance.now();
  const entity = store.readEntities(view => view.get("timelineByEventId", "synthetic"));
  const entityReadMs = performance.now() - entityReadStarted;
  if ((entity?.length ?? 0) !== input.historyEntries) {
    throw new Error("Entity read did not preserve synthetic history count");
  }

  const oldScanStarted = performance.now();
  const oldDue = store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.status === "PENDING").slice(0, 100).map(row => row.id));
  const fullStateOutboxScanMs = performance.now() - oldScanStarted;
  const selectedScanStarted = performance.now();
  const selectedDue = store.readEntities(view => view.select("notificationOutboxById",
    row => row.status === "PENDING", 100).map(row => row.id));
  const entityOutboxScanMs = performance.now() - selectedScanStarted;
  if (JSON.stringify(oldDue) !== JSON.stringify(selectedDue)) throw new Error("Outbox selection changed");

  const noOpStarted = performance.now();
  await store.transact(() => undefined);
  const noOpTransactionMs = performance.now() - noOpStarted;

  const appendStarted = performance.now();
  await store.transact(state => {
    state.timelineByEventId.appended = [{
      id: "append-after-seed",
      eventId: "synthetic",
      occurredAt: iso(input.historyEntries + 1),
      kind: "EVENT_ACTIVATED",
      message: "Synthetic append used only to measure a changed transaction."
    }];
  });
  const appendTransactionMs = performance.now() - appendStarted;

  const concurrentStarted = performance.now();
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.transact(state => {
    const current = state.timelineByEventId.concurrent ?? [];
    state.timelineByEventId.concurrent = [...current, {
      id: `concurrent-${index}`,
      eventId: "synthetic",
      occurredAt: iso(input.historyEntries + index + 2),
      kind: "EVENT_ACTIVATED",
      message: "Synthetic serialized transaction."
    }];
  })));
  const concurrentEightMs = performance.now() - concurrentStarted;

  await store.close();
  const fileBytes = (await stat(file)).size;
  const reopenedAt = performance.now();
  const reopened = await SQLiteStateStore.open(file, []);
  const reopenMs = performance.now() - reopenedAt;
  const counts = reopened.read(state => ({
    history: state.timelineByEventId.synthetic?.length ?? 0,
    notifications: Object.keys(state.notificationOutboxById).length,
    positionBatches: Object.keys(state.eventPositionBatchesById).length,
    concurrent: state.timelineByEventId.concurrent?.length ?? 0
  }));
  if (counts.history !== input.historyEntries
    || counts.notifications !== input.notificationRows
    || counts.positionBatches !== input.positionBatches
    || counts.concurrent !== 8) {
    throw new Error(`Durable counts changed after reopen: ${JSON.stringify(counts)}`);
  }
  await reopened.close();

  rows.push({
    ...input,
    fullReadBytes,
    storageCost,
    fileBytes,
    coldOpenMs,
    reopenMs,
    fullReadMs,
    entityReadMs,
    fullStateOutboxScanMs,
    entityOutboxScanMs,
    noOpTransactionMs,
    appendTransactionMs,
    concurrentEightMs,
    countsAfterReopen: counts
  });
}

const result = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  directory,
  scope: "Synthetic isolated SQLite history/queue growth, restart and serialized transaction probe; not target capacity, production concurrency or rescue acceptance.",
  rows
};
await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
