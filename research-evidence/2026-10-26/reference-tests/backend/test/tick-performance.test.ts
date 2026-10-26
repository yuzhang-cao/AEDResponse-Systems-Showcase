import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { EntityTransaction } from "../src/entity-transaction.js";
import { emptyState, type DeviceRecord, type EventRecord, type PersistentState } from "../src/models.js";
import { enqueueNotification } from "../src/notification-outbox.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore, type StateStore } from "../src/store.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (seconds: number): string =>
  new Date(Date.parse("2026-10-04T00:00:00.000Z") + seconds * 1_000).toISOString();
const DEVICE = uuid(1);
const USER = uuid(2);
const PAIR = uuid(3);
const config = loadConfig({});

class CountingStore extends MemoryStateStore {
  fullTransactions = 0;
  entityTransactions = 0;

  override transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    this.fullTransactions += 1;
    return super.transact(mutation);
  }

  override transactEntities<T>(mutation: (tx: EntityTransaction) => T | Promise<T>): Promise<T> {
    this.entityTransactions += 1;
    return super.transactEntities(mutation);
  }
}

function event(id: string, state: "ACTIVE" | "RESOLVED" = "RESOLVED"): EventRecord {
  return {
    id, state, recruitmentState: state === "ACTIVE" ? "RECRUITING" : "COMPLETED",
    patientUserId: USER, patientDeviceIds: [DEVICE], patientPairId: PAIR,
    observation: {
      schemaVersion: "2.0", eventId: id, observationKind: "FALL_CONTEXT",
      fallDetectedAt: at(0), patientPositionObservedAt: at(0),
      fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22, longitude: 113, accuracyMeters: 10 }
    },
    observationFingerprint: "tick-performance-fixture", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    currentRecruitmentRadiusMeters: 1_000, recruitmentStageStartedAt: at(0),
    coordinationRevision: 1, assignmentRevision: 1, unavailableAedIds: [],
    exitedResponderUserIds: [], createdAt: at(0),
    ...(state === "RESOLVED" ? { resolvedAt: at(1), terminalReason: "PROBLEM_RESOLVED" as const } : {})
  };
}

function device(withPosition = false): DeviceRecord {
  return {
    deviceInstanceId: DEVICE, deviceKind: "IPHONE", userId: USER, companionPairId: PAIR,
    agreements: {}, capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: false, presenceObservedAt: at(0), lastSeenAt: at(0), lastBootstrapAt: at(0),
    ...(withPosition ? {
      latestPosition: {
        positionUpdateId: uuid(4), observedAt: at(0), serverReceivedAt: at(0),
        position: { kind: "R" as const, latitude: 22, longitude: 113, accuracyMeters: 10 }
      }
    } : {})
  };
}

function makeService(store: StateStore, seconds = 2): AEDResponseService {
  return new AEDResponseService(store, config, undefined, () => new Date(at(seconds)));
}

for (const historyCount of [0, 200]) {
  test(`idle tick with ${historyCount} terminal events avoids whole-state transactions`, async () => {
    const state = emptyState();
    for (let index = 0; index < historyCount; index += 1) {
      const id = uuid(100 + index);
      state.events[id] = event(id);
    }
    const store = new CountingStore(state);
    const before = store.read(current => current.events);
    await makeService(store).tick();
    assert.equal(store.fullTransactions, 0, "idle maintenance must not clone and validate all retained state");
    assert.ok(store.entityTransactions > 0, "the idle decision must cross the transaction queue");
    assert.deepEqual(store.read(current => current.events), before);
  });
}

test("idle probe sees an active event written by an earlier queued transaction", async () => {
  const store = new CountingStore(emptyState());
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const id = uuid(400);
  const write = store.transactEntities(async tx => {
    entered();
    await gate;
    tx.append("events", id, event(id, "ACTIVE"));
  });
  await started;
  let completed = false;
  const tick = makeService(store, 2_100).tick().then(() => { completed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, "an uncommitted empty snapshot cannot bypass queued event maintenance");
  } finally {
    release();
    await write;
    await tick;
  }
  assert.equal(store.read(current => current.events[id]?.state), "CLOSED_UNCONFIRMED_NO_RESPONSE",
    "the newly committed event must cross its persisted confirmation deadline in this tick");
  assert.ok(store.entityTransactions > 0, "active event maintenance must still run through the entity path");
});

test("terminal-only tick still dispatches the durable terminal notification", async () => {
  const state = emptyState();
  const id = uuid(500);
  state.devices[DEVICE] = device();
  state.events[id] = event(id);
  enqueueNotification(state, DEVICE, "event:resolved", {
    schemaVersion: "2.0", messageId: "terminal-idle-tick", eventId: id, occurredAt: at(1),
    state: "RESOLVED", recruitmentState: "COMPLETED"
  });
  const store = new CountingStore(state);
  const sent: string[] = [];
  const service = new AEDResponseService(store, config, {
    emitToDevices(ids, name) { sent.push(name); return [...ids]; }
  }, () => new Date(at(2)));
  await service.tick();
  await service.flushNotificationPushes();
  const rows = store.read(current => Object.values(current.notificationOutboxById));
  assert.deepEqual(sent, ["event:resolved"]);
  assert.equal(rows[0]?.status, "DISPATCHED");
  assert.ok(rows[0]?.completedAt, "idle fast return must not strand pending terminal delivery");
});

test("idle tick still reclaims expired standby positions through the expiry index", async () => {
  const state = emptyState();
  state.devices[DEVICE] = device(true);
  const store = new CountingStore(state);
  await makeService(store, 601).tick();
  assert.equal(store.read(current => current.devices[DEVICE]?.latestPosition), undefined);
  assert.equal(store.fullTransactions, 0, "position expiry plus the idle probe needs only entity transactions");
});

for (const missing of ["entity", "expiry", "both"] as const) {
  test(`tick preserves expiry maintenance when ${missing} capabilities are absent`, async () => {
    const state = emptyState();
    if (missing !== "entity") state.devices[DEVICE] = device(true);
    const backing = new CountingStore(state);
    const store: StateStore = {
      read: backing.read.bind(backing), readEntities: backing.readEntities.bind(backing),
      transact: backing.transact.bind(backing),
      ...(missing === "expiry" ? { transactEntities: backing.transactEntities.bind(backing) } : {}),
      ...(missing === "entity" ? { positionExpiry: backing.positionExpiry.bind(backing) } : {})
    };
    await makeService(store, 601).tick();
    if (missing === "expiry") {
      assert.ok(backing.entityTransactions > 0, "the canonical entity draft still performs fallback position expiry");
    } else {
      assert.ok(backing.fullTransactions > 0, "stores without entity transactions retain the legacy path");
    }
    if (missing !== "entity") {
      assert.equal(backing.read(current => current.devices[DEVICE]?.latestPosition), undefined,
        "without an expiry index the whole-state fallback must still reclaim old positions");
    }
  });
}
