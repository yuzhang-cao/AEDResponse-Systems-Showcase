import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { emptyState, type EventPositionBatchRecord, type EventRecord } from "../src/models.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (second: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, second)).toISOString();
const eventId = uuid(1);
const deviceInstanceId = uuid(2);
const userId = uuid(3);

function harness(intervals = [{ start: 0, end: 2 }]) {
  const state = emptyState();
  state.events[eventId] = {
    id: eventId, state: "RESOLVED", recruitmentState: "COMPLETED",
    patientUserId: uuid(4), patientDeviceIds: [], patientPairId: uuid(5),
    unavailableAedIds: [], exitedResponderUserIds: [],
    observation: {
      schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT",
      fallDetectedAt: at(0), fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPositionObservedAt: at(0),
      patientPosition: { kind: "P", latitude: 22.2, longitude: 113.5, accuracyMeters: 10 }
    },
    observationFingerprint: "synthetic", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    currentRecruitmentRadiusMeters: 1000, recruitmentStageStartedAt: at(0),
    coordinationRevision: 1, assignmentRevision: 1, createdAt: at(0), resolvedAt: at(20)
  } satisfies EventRecord;
  for (const { start, end } of intervals) {
    state.participantIntervalsById[`interval-${start}`] = {
      eventId, userId, deviceInstanceId, acceptedAt: at(start),
      endedAt: at(end), endReason: "RESPONDER_EXIT"
    };
  }
  const store = new MemoryStateStore(state);
  const config: BackendConfig = {
    host: "127.0.0.1", port: 0, dataFile: "unused.json", fixtureFile: "unused-fixture.json",
    sessionTtlSeconds: 3600, nearbyRadiusMeters: 1000, positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120, maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100, positionWindowGraceSeconds: 120, production: false
  };
  const service = new AEDResponseService(store, config, undefined, () => new Date(at(21)));
  const reconcile = () => service.reconcilePositionWindows({ eventId, closedBy: "EVENT_TERMINAL" });
  return { store, service, reconcile };
}

function evidence(): EventPositionBatchRecord {
  const batchId = uuid(6);
  return {
    batchId, eventId, userId, deviceInstanceId, kind: "R",
    fingerprint: "synthetic", receivedAt: at(21),
    records: [{
      recordId: uuid(7), batchId, eventId, userId, deviceInstanceId, kind: "R",
      slotAt: at(0), serverReceivedAt: at(21), status: "NO_NEW_FIX", gapReason: "NO_FIX",
      appliedToLatest: false, ignoredAsStale: false
    }]
  };
}

test("reconciliation sees evidence committed by an earlier queued transaction", async () => {
  const { store, reconcile } = harness();
  const batch = evidence();
  const write = store.transactEntities(tx => tx.append("eventPositionBatchesById", batch.batchId, batch));
  const audit = reconcile();
  await write;
  const [record] = await audit;
  assert.equal(record?.receivedSlotCount, 1,
    "the audit must derive its verdict from the same transaction snapshot in which it is saved");
  assert.deepEqual(record?.gaps.map(gap => gap.slotAt), [at(1)]);
});

test("concurrent reconciliations advance the stored revision without lost updates", async () => {
  const { store, reconcile } = harness();
  const outcomes = await Promise.all([reconcile(), reconcile()]);
  assert.deepEqual(outcomes.map(records => records[0]?.revision).sort(), [1, 2]);
  const stored = store.read(state => Object.values(state.positionWindowReconciliationsById));
  assert.equal(stored[0]?.revision, 2);
});

test("each participation interval is reconciled against its own start and end", async () => {
  const { reconcile } = harness([{ start: 0, end: 2 }, { start: 5, end: 8 }]);
  const records = await reconcile();
  assert.deepEqual(records.map(record => ({
    start: record.windowStartedAt, end: record.windowEndedAt, slots: record.expectedSlotCount
  })), [
    { start: at(0), end: at(2), slots: 2 },
    { start: at(5), end: at(8), slots: 3 }
  ]);
});

async function auditHarness() {
  const { store, service, reconcile } = harness();
  const principal = (id: string, uid: string): DevicePrincipal => ({
    kind: "DEVICE", tokenHash: "synthetic", sessionId: `session-${id}`, userId: uid,
    deviceInstanceId: id, deviceKind: "IPHONE", companionPairId: uuid(20),
    scopes: ["events:read", "position:write"], expiresAt: at(3600)
  });
  const member = principal(deviceInstanceId, userId);
  const outsider = principal(uuid(10), uuid(11));
  const pending = principal(uuid(12), uuid(13));
  const secondMember = principal(uuid(14), uuid(15));
  const sibling = principal(uuid(16), userId);
  await store.transactEntities(tx => {
    for (const principal of [member, outsider, pending, secondMember, sibling]) {
      tx.append("devices", principal.deviceInstanceId, {
        deviceInstanceId: principal.deviceInstanceId, deviceKind: "IPHONE",
        userId: principal.userId!, companionPairId: principal.companionPairId,
        agreements: {}, capabilities: { notificationAuthorized: true, locationAuthorized: true },
        availableForResponse: true, presenceObservedAt: at(0), lastSeenAt: at(0), lastBootstrapAt: at(0)
      });
    }
    tx.append("participantIntervalsById", "second-member", {
      eventId, deviceInstanceId: secondMember.deviceInstanceId, userId: secondMember.userId!,
      acceptedAt: at(1), endedAt: at(3), endReason: "RESPONDER_EXIT"
    });
    tx.append("participantIntervalsById", "same-user-second-device", {
      eventId, deviceInstanceId: sibling.deviceInstanceId, userId: sibling.userId!,
      acceptedAt: at(2), endedAt: at(4), endReason: "RESPONDER_EXIT"
    });
    const deliveryId = uuid(30);
    tx.append("deliveries", deliveryId, {
      id: deliveryId, eventId, deviceInstanceId: pending.deviceInstanceId,
      status: "SENT", statusOccurredAt: at(0),
      request: {
        schemaVersion: "2.0", messageId: "synthetic-pending", eventId, deliveryId,
        deliveryStatus: "SENT", occurredAt: at(0), eventType: "FALL_ASSISTANCE",
        positioningTier: "SEARCH_RING", distanceRange: "DISTANCE_0_500M",
        etaRange: "ETA_0_5_MIN", currentRecruitmentRadiusMeters: 1000, expiresAt: at(40)
      }
    });
  });
  await reconcile();
  return { store, service, reconcile, member, outsider, pending, secondMember, sibling };
}

test("position audits reject unrelated devices and unaccepted offer recipients", async () => {
  const h = await auditHarness();
  for (const principal of [h.outsider, h.pending]) {
    assert.throws(() => h.service.positionWindowReconciliations(principal, eventId),
      { status: 403 });
    await assert.rejects(h.service.reportPositionWindowComplete(principal, eventId),
      { status: 403 });
  }
});

test("position audit responses contain only the caller's device and identity", async () => {
  const h = await auditHarness();
  const completed = await h.service.reportPositionWindowComplete(h.member, eventId);
  assert.equal(completed.reconciled, 1);
  assert.equal(completed.records.length, 1);
  const own = h.service.positionWindowReconciliations(h.member, eventId);
  assert.equal(own.length, 1);
  assert.equal(own[0]?.deviceInstanceId, h.member.deviceInstanceId);
  assert.equal(own[0]?.userId, h.member.userId);
  assert.equal(h.service.positionWindowReconciliations(h.secondMember, eventId).length, 1);
  assert.equal(h.service.positionWindowReconciliations(h.sibling, eventId).length, 1);

  const operator = h.service.positionWindowReconciliations({ kind: "OPERATOR" }, eventId);
  assert.equal(operator.length, 3, "the operator retains the full event audit");
  await assert.rejects(h.service.reportPositionWindowComplete({ kind: "OPERATOR" }, eventId),
    { status: 403 });
  assert.throws(() => h.service.positionWindowReconciliations({
    kind: "ACCOUNT", tokenHash: "synthetic", sessionId: "synthetic", accountId: uuid(40),
    userId, scopes: ["events:read"], expiresAt: at(3600)
  }, eventId), { status: 403 });
});
