/**
 * G10 — final participation-window reconciliation.
 *
 * The requirement is specific about what may NOT happen: arrival order is not a
 * verdict, and a cross-batch hole must not be frozen into a final audit
 * conclusion while the client may still be replaying its queue.  A gap only
 * becomes a conclusion when the window has closed AND the grace period for late
 * but legal uploads has passed.
 *
 * The tests below therefore check three separate things:
 *
 *   1. the verdict arithmetic — expected seconds, received facts, classified gaps;
 *   2. the ordering rule — an in-flight or out-of-order batch never creates a
 *      permanent gap, and a late legal upload inside the grace period replaces a
 *      provisional gap with the real fact;
 *   3. the safety rule — reconciliation never deletes or rewrites a received
 *      fact, and it is idempotent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import type {
  Aed,
  EventPositionBatch,
  PatientPosition,
  ResponderPosition,
  WatchEmergencyObservation
} from "../src/contracts.js";
import type { DevicePrincipal } from "../src/service.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore, type StateStore } from "../src/store.js";
import { emptyState } from "../src/models.js";
import { operationMetrics, resetMetrics } from "../src/runtime-metrics.js";
import {
  classifyGap,
  expectedSlotInstants,
  gapListsMatch,
  participationWindowFor,
  reconcileWindow,
  windowEvidenceFrom,
  type ParticipationWindow
} from "../src/position-window.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";
const PATIENT_POSITION: PatientPosition = {
  kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10
};
const RESPONDER_POSITION: ResponderPosition = {
  kind: "R", latitude: 22.199, longitude: 113.5439, accuracyMeters: 10
};

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (seconds: number): string =>
  new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();

const inventory: Aed[] = [{
  id: "window-aed",
  name: "Window AED",
  aedPosition: { kind: "A", latitude: 22.1991, longitude: 113.5439, accuracyMeters: 5 },
  openFrom: "00:00",
  openUntil: "00:00",
  floor: "1F",
  floorTransferSeconds: 0,
  accessNote: "lobby",
  accessDelaySeconds: 0,
  verificationSeconds: 0,
  available: true
}];

function config(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataFile: "unused-memory-store.json",
    fixtureFile: "unused-in-memory-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    positionWindowGraceSeconds: 120,
    production: false,
    ...overrides
  };
}

interface Harness {
  service: AEDResponseService;
  store: MemoryStateStore;
  patient: DevicePrincipal;
  responder: DevicePrincipal;
  eventId: string;
  setNow(seconds: number): void;
}

async function bootstrap(
  service: AEDResponseService,
  deviceInstanceId: string,
  deviceKind: "IPHONE" | "WATCH",
  companionPairId: string
): Promise<DevicePrincipal> {
  const result = await service.bootstrap({
    deviceInstanceId,
    deviceKind,
    companionPairId,
    ...(deviceKind === "IPHONE" ? {
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
          kind, version: "2.0", acceptedAt: BASE_TIME
        })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    } : {})
  } as never, `synthetic:${deviceInstanceId}`);
  const principal = service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Synthetic device principal required");
  return principal;
}

/** One running event with a patient iPhone/Watch pair and one accepted responder. */
async function runningEvent(overrides: Partial<BackendConfig> = {}): Promise<Harness> {
  let now = new Date(BASE_TIME);
  const store = new MemoryStateStore(emptyState(inventory));
  const service = new AEDResponseService(store, config(overrides), {
    emitToDevices() { return []; }
  }, () => now);
  const harness: Harness = {
    service,
    store,
    patient: undefined as never,
    responder: undefined as never,
    eventId: uuid(500),
    setNow(seconds: number) { now = new Date(at(seconds)); }
  };

  const pairId = uuid(1);
  const patient = await bootstrap(service, uuid(2), "IPHONE", pairId);
  const watch = await bootstrap(service, uuid(3), "WATCH", pairId);
  const responder = await bootstrap(service, uuid(4), "IPHONE", uuid(5));
  await service.updateResponderPosition(responder, {
    positionUpdateId: uuid(6),
    observedAt: at(0),
    responderPosition: { ...RESPONDER_POSITION }
  });
  now = new Date(at(1));
  const observation: WatchEmergencyObservation = {
    schemaVersion: "2.0",
    eventId: harness.eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1),
    patientPositionObservedAt: at(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: PATIENT_POSITION
  };
  await service.reportWatchObservation(watch, harness.eventId, observation);
  const delivery = store.read(state => Object.values(state.deliveries)
    .find(row => row.eventId === harness.eventId
      && row.deviceInstanceId === responder.deviceInstanceId));
  assert.ok(delivery, "the responder must receive an offer");
  now = new Date(at(2));
  await service.respond(responder, harness.eventId, delivery.id, {
    decision: "ACCEPT", decidedAt: at(2)
  });
  harness.patient = patient;
  harness.responder = responder;
  return harness;
}

/** A batch of consecutive one-second slots, FIX for even offsets. */
function batch(
  eventId: string,
  id: number,
  seconds: number[],
  kind: "P" | "R"
): EventPositionBatch {
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

function submit(harness: Harness, principal: DevicePrincipal, value: EventPositionBatch) {
  return harness.service.recordEventPositionBatch(
    principal, value.eventId, value.batchId, value);
}

function verdicts(store: StateStore, eventId: string) {
  return store.read(state => Object.values(state.positionWindowReconciliationsById)
    .filter(row => row.eventId === eventId));
}

// ---------------------------------------------------------------------------
// Pure verdict arithmetic
// ---------------------------------------------------------------------------

test("the expected seconds are the legal slots of a half-open window", () => {
  const window: ParticipationWindow = {
    identity: {
      eventId: "event-1",
      userId: "user-1",
      deviceInstanceId: "device-1",
      kind: "P"
    },
    startedAt: at(0),
    endedAt: at(5)
  };
  assert.deepEqual(
    expectedSlotInstants(window).map(instant => new Date(instant).toISOString()),
    [at(0), at(1), at(2), at(3), at(4)],
    "a window [start, end) holds exactly the seconds that begin inside it"
  );

  // A window that starts mid-second still begins at the next whole second: a
  // partial second is not a legal slot.
  const offset: ParticipationWindow = {
    ...window,
    startedAt: new Date(Date.parse(at(0)) + 400).toISOString(),
    endedAt: at(2)
  };
  assert.deepEqual(
    expectedSlotInstants(offset).map(instant => new Date(instant).toISOString()),
    [at(1)],
    "a window opening at .400 s expects one slot, not a partial one"
  );

  assert.deepEqual(expectedSlotInstants({ ...window, endedAt: null }), [],
    "an open window has no expected set yet; its pending seconds are not gaps");
});

test("a complete window yields one fact per second and no gaps", () => {
  const window: ParticipationWindow = {
    identity: {
      eventId: "event-1", userId: "user-1", deviceInstanceId: "device-1", kind: "R"
    },
    startedAt: at(0),
    endedAt: at(5)
  };
  const evidence = windowEvidenceFrom([
    {
      batchId: "b1",
      eventId: "event-1",
      userId: "user-1",
      deviceInstanceId: "device-1",
      kind: "R",
      fingerprint: "f",
      receivedAt: at(9),
      records: [0, 1, 2, 3, 4].map(second => ({
        recordId: uuid(100 + second),
        batchId: "b1",
        eventId: "event-1",
        userId: "user-1",
        deviceInstanceId: "device-1",
        kind: "R" as const,
        slotAt: at(second),
        serverReceivedAt: at(9),
        appliedToLatest: false,
        ignoredAsStale: false,
        ...(second % 2 === 0
          ? {
            status: "FIX" as const,
            position: RESPONDER_POSITION,
            fixObservedAt: at(second)
          }
          : { status: "NO_NEW_FIX" as const, gapReason: "NO_FIX" as const })
      }))
    }
  ], window.identity);

  const outcome = reconcileWindow({ window, evidence, withinGrace: true });
  assert.equal(outcome.expectedSlotCount, 5);
  assert.equal(outcome.receivedSlotCount, 5);
  assert.equal(outcome.fixSlotCount, 3);
  assert.equal(outcome.noFixSlotCount, 2,
    "a NO_NEW_FIX second is a recorded fact, not a gap");
  assert.deepEqual(outcome.gaps, [],
    "a window with one fact per second has nothing to explain");
});

test("gaps are classified, and only with reasons the server can justify", () => {
  const window: ParticipationWindow = {
    identity: {
      eventId: "event-1", userId: "user-1", deviceInstanceId: "device-1", kind: "R"
    },
    startedAt: at(0),
    endedAt: at(6)
  };
  // Facts at 0 and 5; seconds 1-4 are missing, bounded on both sides.
  const facts = [0, 5].map(second => ({
    slotAt: Date.parse(at(second)),
    status: "FIX" as const
  }));
  const outcome = reconcileWindow({
    window,
    evidence: { facts, recordCount: 2 },
    withinGrace: true
  });
  assert.equal(outcome.gaps.length, 4);
  assert.deepEqual(outcome.gaps.map(gap => gap.reason),
    ["NEVER_UPLOADED", "NEVER_UPLOADED", "NEVER_UPLOADED", "NEVER_UPLOADED"],
    "neighbouring facts do not prove the cause of a missing record");
  assert.ok(outcome.gaps.every(gap => gap.provisional),
    "inside the grace period every gap is a work item, not a conclusion");

  // A trailing hole is never dressed up as an observed cause.
  const trailing = reconcileWindow({
    window,
    evidence: { facts: [{ slotAt: Date.parse(at(0)), status: "FIX" }], recordCount: 1 },
    withinGrace: false
  });
  assert.deepEqual(trailing.gaps.map(gap => gap.reason),
    ["NEVER_UPLOADED", "NEVER_UPLOADED", "NEVER_UPLOADED", "NEVER_UPLOADED", "NEVER_UPLOADED"]);
  assert.ok(trailing.gaps.every(gap => !gap.provisional),
    "after the grace deadline the same gaps are the final conclusion");

  // Current permission loss cannot explain a historical missing second.
  assert.equal(classifyGap({
    slotAt: Date.parse(at(1)),
    previousRecordedSlotAt: Date.parse(at(0)),
    nextRecordedSlotAt: Date.parse(at(2)),
    permissionRevoked: true
  }), "NEVER_UPLOADED");

  // Bounded gaps still have no observed connectivity evidence.
  assert.equal(classifyGap({
    slotAt: Date.parse(at(1)),
    previousRecordedSlotAt: Date.parse(at(0)),
    nextRecordedSlotAt: Date.parse(at(2)),
    permissionRevoked: false
  }), "NEVER_UPLOADED");
});

// ---------------------------------------------------------------------------
// End-to-end: window close, grace period, late evidence
// ---------------------------------------------------------------------------

test("the verdict is written when the event ends, and it counts the whole window", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  // The responder's window opens at their ACCEPT and the event ends at t=20.
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 1_000, [3, 4, 5, 6, 7], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(700),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });

  const [record] = verdicts(harness.store, eventId)
    .filter(row => row.deviceInstanceId === harness.responder.deviceInstanceId);
  assert.ok(record, "closing the event must write one verdict per participation window");
  assert.equal(record.closedBy, "EVENT_TERMINAL");
  assert.equal(record.windowStartedAt, at(2), "the responder's window starts at their ACCEPT");
  assert.equal(record.windowEndedAt, at(20), "and ends at the terminal time");
  assert.equal(record.expectedSlotCount, 18, "seconds 2..19 inclusive");
  assert.equal(record.receivedSlotCount, 5);
  assert.equal(record.receivedRecordCount, 5);
  assert.equal(record.gaps.length, 13,
    "every expected second is either a fact or a recorded gap");
  assert.equal(record.receivedSlotCount + record.gaps.length, record.expectedSlotCount);
  assert.equal(record.final, false,
    "the event just ended, so the grace period is still open");
  assert.ok(record.gaps.every(gap => gap.provisional));
  assert.equal(record.revision, 1);
});

test("a late but legal upload inside the grace period replaces a provisional gap", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  // Only slots 3..7 are recorded before the event ends.
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 2_000, [3, 4, 5, 6, 7], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(701),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });

  const before = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  const gapBefore = before.gaps.find(gap => gap.slotAt === at(8));
  assert.ok(gapBefore, "slot 8 is a provisional gap right after the window closes");
  assert.equal(gapBefore.provisional, true);
  const factsBefore = harness.store.read(state =>
    Object.values(state.eventPositionBatchesById).length);

  // Inside the grace period (120 s after the window end) the still-in-flight
  // batch arrives.  It is a legal upload: its slots are inside the window.
  harness.setNow(60);
  await submit(harness, harness.responder, batch(eventId, 3_000, [8, 9, 10], "R"));

  const after = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(after.gaps.some(gap => gap.slotAt === at(8)), false,
    "the real fact must replace the provisional gap it explains");
  assert.equal(after.receivedSlotCount, before.receivedSlotCount + 3);
  assert.equal(after.receivedRecordCount, before.receivedRecordCount + 3);
  assert.equal(after.receivedSlotCount + after.gaps.length, after.expectedSlotCount,
    "the verdict still accounts for every expected second");
  assert.equal(after.correctedByLateEvidence, true,
    "the record states that late evidence corrected it");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.reconciliationId, before.reconciliationId,
    "one verdict per window: a correction is a revision, not a second record");

  // No received fact was deleted to achieve this.
  const factsAfter = harness.store.read(state =>
    Object.values(state.eventPositionBatchesById).length);
  assert.equal(factsAfter, factsBefore + 1, "the late batch was appended, nothing removed");
  const storedRecordIds = harness.store.read(state =>
    Object.values(state.eventPositionBatchesById)
      .flatMap(row => row.records.map(record => record.recordId)));
  assert.equal(new Set(storedRecordIds).size, storedRecordIds.length,
    "and no recordId was rewritten");
});

test("after the grace period the verdict is final and stays final", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 4_000, [3, 4, 5], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(702),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  const closed = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;

  // Past windowEnd + grace: re-running the same audit must produce the same
  // conclusion, now marked final.
  harness.setNow(20 + 120);
  const records = await harness.service.reconcilePositionWindows({
    eventId,
    closedBy: "EVENT_TERMINAL"
  });
  const final = records.find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(final.final, true, "the grace deadline has passed");
  assert.ok(final.gaps.every(gap => !gap.provisional));
  assert.deepEqual(final.gaps.map(gap => gap.slotAt), closed.gaps.map(gap => gap.slotAt),
    "the same facts produce the same gap list");
  assert.equal(final.correctedByLateEvidence, false,
    "recomputing an unchanged window is not a correction");
  assert.equal(final.receivedSlotCount, closed.receivedSlotCount);
});

test("reconciliation is idempotent for an unchanged window", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 5_000, [3, 4, 5, 6, 7], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(703),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  const first = verdicts(harness.store, eventId);
  assert.ok(first.length > 0);

  resetMetrics();
  const replay = await harness.service.reconcilePositionWindows({
    eventId,
    closedBy: "EVENT_TERMINAL"
  });
  const second = verdicts(harness.store, eventId);
  assert.equal(second.length, first.length,
    "recomputing must not create a second verdict for the same window");
  for (const before of first) {
    const after = second.find(row => row.reconciliationId === before.reconciliationId)!;
    assert.ok(gapListsMatch(before.gaps, after.gaps),
      "the gap list is identical when no new fact arrived");
    assert.equal(after.receivedRecordCount, before.receivedRecordCount);
    assert.equal(after.correctedByLateEvidence, false);
  }
  assert.equal(replay.length, first.length);
  // The window count is reported, so an operator can see the audit actually ran.
  assert.ok(operationMetrics.positionWindowReconciliations > 0);
});

test("a responder exit closes only that participant's window", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(10);
  await submit(harness, harness.responder, batch(eventId, 6_000, [3, 4, 5], "R"));
  harness.setNow(15);
  await harness.service.exitEvent(harness.responder, eventId, {
    exitId: uuid(710),
    exitedAt: at(15),
    reason: "left the scene",
    soleResponderConfirmed: true
  });

  const records = verdicts(harness.store, eventId);
  const responderVerdict = records.find(row =>
    row.deviceInstanceId === harness.responder.deviceInstanceId);
  assert.ok(responderVerdict, "the exit must reconcile the exiting participant's window");
  assert.equal(responderVerdict.closedBy, "PARTICIPANT_EXIT");
  assert.equal(responderVerdict.windowEndedAt, at(15),
    "the window ends at the exit ACK, not at the event end");
  assert.equal(responderVerdict.expectedSlotCount, 13, "seconds 2..14 inclusive");
  // The event is still running, so the patient's window must NOT be concluded.
  const patientVerdict = records.find(row =>
    row.deviceInstanceId === uuid(2));
  assert.equal(patientVerdict, undefined,
    "an open window is never reconciled: its pending seconds are not gaps");
});

test("an open window is never reconciled into a verdict", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 7_000, [3, 4, 5], "R"));
  resetMetrics();
  const records = await harness.service.reconcilePositionWindows({
    eventId,
    closedBy: "EVENT_TERMINAL"
  });
  assert.deepEqual(records, [],
    "with the event still ACTIVE there is no authoritative window end, so there is "
    + "nothing that may be declared missing");
  assert.equal(verdicts(harness.store, eventId).length, 0);
});

test("an unexplained straggler never erases a recorded gap", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  // Slots 6..8 first, so the verdict records slots 3..5 and 9..19 as gaps.
  await submit(harness, harness.responder, batch(eventId, 8_000, [6, 7, 8], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(704),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  const closed = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(closed.gaps.some(gap => gap.slotAt === at(3)), true,
    "slot 3 is a recorded gap");
  const factsBefore = harness.store.read(state =>
    Object.values(state.eventPositionBatchesById).length);

  // Long past the grace deadline a straggler arrives carrying slots that were
  // NOT recorded as missing.  It is still legal evidence and the server keeps it;
  // what it must not do is silently erase the recorded gaps for the seconds it
  // says nothing about, because that would make the audit claim completeness the
  // evidence does not support.
  harness.setNow(20 + 600);
  await submit(harness, harness.responder, batch(eventId, 9_000, [17, 18, 19], "R"));
  const factsAfter = harness.store.read(state =>
    Object.values(state.eventPositionBatchesById).length);
  assert.equal(factsAfter, factsBefore + 1,
    "late legal evidence is appended, never rejected-and-dropped");

  const after = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(after.gaps.some(gap => gap.slotAt === at(3)), true,
    "an unrelated straggler must not launder an unexplained second into a pass");
  assert.equal(after.gaps.some(gap =>
    [at(17), at(18), at(19)].includes(gap.slotAt)), false,
  "the straggler's own seconds are now counted as received facts");
  assert.equal(after.receivedRecordCount, closed.receivedRecordCount + 3,
    "the verdict accounts for the facts the server actually holds");
  assert.equal(after.gaps.some(gap => gap.slotAt === at(3)), true,
    "and it still reports the seconds nobody ever uploaded");

  // An explicit recomputation is the point at which the new facts are accounted
  // for, and it now sees slots 17..19 as facts rather than gaps.
  const recomputed = await harness.service.reconcilePositionWindows({
    eventId,
    closedBy: "EVENT_TERMINAL"
  });
  const refreshed = recomputed.find(row =>
    row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(refreshed.gaps.some(gap =>
    [at(17), at(18), at(19)].includes(gap.slotAt)), false,
  "recomputation reflects the facts the server actually holds");
  assert.equal(refreshed.gaps.some(gap => gap.slotAt === at(3)), true,
    "and still reports the seconds nobody ever uploaded");
  assert.equal(refreshed.gaps.length, closed.gaps.length - 3);
});

test("received facts are never deleted by reconciliation", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 10_000, [3, 4, 5, 6, 7], "R"));
  const before = harness.store.read(state => structuredClone(state.eventPositionBatchesById));

  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(705),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  // Recompute several times, including after the grace period.
  harness.setNow(20 + 200);
  await harness.service.reconcilePositionWindows({ eventId, closedBy: "EVENT_TERMINAL" });
  harness.setNow(20 + 400);
  await harness.service.reconcilePositionWindows({ eventId, closedBy: "EVENT_TERMINAL" });

  const after = harness.store.read(state => structuredClone(state.eventPositionBatchesById));
  assert.deepEqual(after, before,
    "the reconciliation is a derived audit; the append-only evidence must be byte-identical");
});

// ---------------------------------------------------------------------------
// Ordering: out-of-order arrival is not a verdict
// ---------------------------------------------------------------------------

test("out-of-order arrival never creates a permanent gap", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  // Batches arrive newest-first: 8..12, then 3..7.  The server accepts both, and
  // nothing in the write path may conclude that 3..7 are missing while 8..12 are
  // already stored.
  harness.setNow(16);
  await submit(harness, harness.responder, batch(eventId, 11_000, [8, 9, 10, 11, 12], "R"));
  assert.equal(verdicts(harness.store, eventId).length, 0,
    "the write path must not record a verdict at all");
  harness.setNow(17);
  await submit(harness, harness.responder, batch(eventId, 12_000, [3, 4, 5, 6, 7], "R"));
  assert.equal(verdicts(harness.store, eventId).length, 0);

  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(706),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  const record = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(record.receivedSlotCount, 10,
    "both batches count, whichever order they arrived in");
  for (const second of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    assert.equal(record.gaps.some(gap => gap.slotAt === at(second)), false,
      `slot ${second} was received and must not be reported as a gap`);
  }
});

test("a coalesced multi-batch window accounts for every expected second", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  // Every legal second of the responder's window [2, 20) arrives, in three
  // batches and deliberately out of order.
  harness.setNow(15);
  await submit(harness, harness.responder, batch(eventId, 13_000, [12, 13, 14], "R"));
  harness.setNow(18);
  await submit(harness, harness.responder, batch(eventId, 14_000, [15, 16, 17], "R"));
  harness.setNow(20);
  await submit(harness, harness.responder, batch(eventId, 15_000, [2, 3, 4, 5, 6], "R"));
  await submit(harness, harness.responder, batch(eventId, 15_200, [7, 8, 9, 10, 11], "R"));
  await submit(harness, harness.responder, batch(eventId, 15_500, [18, 19], "R"));
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(707),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });

  const record = verdicts(harness.store, eventId)
    .find(row => row.deviceInstanceId === harness.responder.deviceInstanceId)!;
  assert.equal(record.expectedSlotCount, 18);
  assert.equal(record.receivedSlotCount, 18,
    "all 18 legal seconds arrived, spread across five out-of-order batches");
  assert.deepEqual(record.gaps, [],
    "every legal second of this window was uploaded, so nothing is reported missing");
});

// ---------------------------------------------------------------------------
// Client completion signal
// ---------------------------------------------------------------------------

test("the explicit completion signal audits a closed window on demand", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 16_000, [3, 4, 5], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(708),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  // A second call from the client is the same audit, not a second conclusion.
  const result = await harness.service.reportPositionWindowComplete(
    harness.responder, eventId);
  assert.ok(result.reconciled > 0, "the signal reconciles the closed windows");
  assert.equal(result.records.length, result.reconciled);
  assert.ok(result.records.every(record => record.closedBy === "EVENT_TERMINAL"
    || record.closedBy === "PARTICIPANT_EXIT"
    || record.closedBy === "CLIENT_COMPLETE_SIGNAL"));
  assert.equal(verdicts(harness.store, eventId).length, result.reconciled,
    "the signal recomputes the existing verdicts instead of adding new ones");
});

test("the completion signal refuses an open window instead of freezing it", async () => {
  const harness = await runningEvent();
  await assert.rejects(
    harness.service.reportPositionWindowComplete(harness.responder, harness.eventId),
    /can only be reconciled after it closes/,
    "a still-running event has pending seconds, not missing ones"
  );
});

// ---------------------------------------------------------------------------
// Metric and guard surface
// ---------------------------------------------------------------------------

test("reconciliation counts what it recorded", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 17_000, [3, 4, 5], "R"));
  harness.setNow(20);
  resetMetrics();
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(709),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  assert.ok(operationMetrics.positionWindowReconciliations > 0,
    "each window recomputation is counted");
  assert.ok(operationMetrics.positionWindowGapsRecorded > 0,
    "and so are the gaps it recorded");
});

test("a stored verdict cannot be deleted or made to un-receive facts", async () => {
  const harness = await runningEvent();
  const eventId = harness.eventId;
  harness.setNow(12);
  await submit(harness, harness.responder, batch(eventId, 18_000, [3, 4, 5], "R"));
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, eventId, {
    resolutionId: uuid(711),
    reason: "PROBLEM_RESOLVED",
    endedAt: at(20)
  });
  const stored = harness.store.read(state =>
    Object.entries(state.positionWindowReconciliationsById)
      .filter(([, record]) => record.deviceInstanceId === harness.responder.deviceInstanceId));
  assert.equal(stored.length, 1, "the responder's window has exactly one verdict");
  const key = stored[0]![0];
  const before = stored[0]![1];
  assert.ok(before.gaps.length > 0, "the fixture must have gaps for this test to mean anything");
  // Remove any leftover probe output from earlier revisions of this file.
  assert.equal(Object.keys(before).includes("probe"), false);

  await assert.rejects(
    harness.store.transact(state => { delete state.positionWindowReconciliationsById[key]; }),
    /cannot be deleted/,
    "an audit verdict is not disposable"
  );

  await assert.rejects(
    harness.store.transact(state => {
      const record = state.positionWindowReconciliationsById[key]!;
      // Move one recorded second back into the gap list: the same story told as
      // if a fact had never been received.
      record.receivedRecordCount -= 1;
      record.receivedSlotCount -= 1;
      record.fixSlotCount -= 1;
      const moved = before.gaps[0]!;
      record.gaps = [...record.gaps, { ...moved, slotAt: at(3) }];
    }),
    /cannot un-receive recorded position facts/,
    "and it may not be edited into a better story"
  );
});

test("a long all-missing window reconciles without quadratic neighbour searches", () => {
  const started = performance.now();
  const outcome = reconcileWindow({
    window: { identity: { eventId: "synthetic", userId: "synthetic",
      deviceInstanceId: "synthetic", kind: "R" }, startedAt: at(0), endedAt: at(86_400) },
    evidence: { facts: [], recordCount: 0 }, withinGrace: false,
    permissionRevoked: true
  });
  assert.equal(outcome.gaps.length, 86_400);
  assert.ok(outcome.gaps.every(gap => gap.reason === "NEVER_UPLOADED" && !gap.provisional));
  // Broad guard against the former quadratic path, not a throughput claim.
  assert.ok(performance.now() - started < 5_000);
});

test("terminal notification dispatch precedes historical window reconciliation", async () => {
  const harness = await runningEvent();
  const original = harness.service.reconcilePositionWindows.bind(harness.service);
  let checked = false;
  harness.service.reconcilePositionWindows = async input => {
    const pending = harness.store.read(state => Object.values(state.notificationOutboxById)
      .filter(row => row.eventId === harness.eventId));
    assert.ok(pending.length > 0);
    assert.ok(pending.every(row => row.attempts > 0), "notifications must be attempted before auditing");
    checked = true;
    return original(input);
  };
  harness.setNow(20);
  await harness.service.endEvent(harness.patient, harness.eventId, {
    resolutionId: uuid(9000), reason: "PROBLEM_RESOLVED", endedAt: at(20)
  });
  assert.ok(checked);
});
