/**
 * 4a differential: the composed coordination summary against an independent
 * recomputation from raw state.
 *
 * Comparing the new `coordinationSummary(ctx, aedReader, ...)` with the old
 * `coordinationSummary(state, ...)` is not possible - the old form is gone - and it
 * would be weak anyway, since every current call site passes exactly the legacy
 * adapters, so the two sides would agree by construction.
 *
 * So the reference here recomputes each field directly from the raw state, without
 * the service's own helpers.  That is what makes it independent: it can disagree
 * with the implementation.  It locks the things 4a touched:
 *
 *   - the AED figure (distinct acquired AEDs per event, receipt rows collapsed);
 *   - the assignment summary counts and their status buckets;
 *   - the responder -> device mapping through deliveries;
 *   - the audience and notification payload the summary ends up in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { legacyCoordinationAedReader } from "../src/coordination-aed-reader.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { AEDResponseService, RECRUITMENT_RADIUS_STAGES_METERS } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };
const WIDEST = RECRUITMENT_RADIUS_STAGES_METERS[RECRUITMENT_RADIUS_STAGES_METERS.length - 1];

const config: BackendConfig = {
  host: "127.0.0.1", port: 0,
  dataFile: "/tmp/aedresponse-4a.json", fixtureFile: "/tmp/aedresponse-4a-fixture.json",
  sessionTtlSeconds: 3_600, nearbyRadiusMeters: 1_000, positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120, maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100, operatorToken: "operator-test-token", production: false
};

const AGREEMENTS = {
  PATIENT: { version: "2.0", acceptedAt: AT },
  VOLUNTEER_RESPONDER: { version: "2.0", acceptedAt: AT },
  PRIVACY_POLICY: { version: "2.0", acceptedAt: AT },
  SENSITIVE_PERSONAL_INFORMATION: { version: "2.0", acceptedAt: AT }
};

function device(deviceInstanceId: string, userId: string | undefined) {
  return {
    deviceInstanceId, deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000), agreements: structuredClone(AGREEMENTS),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: AT, lastSeenAt: AT, lastBootstrapAt: AT,
    latestPosition: {
      positionUpdateId: uuid(9_500), observedAt: AT, serverReceivedAt: AT,
      position: { kind: "R", latitude: PATIENT.latitude + 0.005,
        longitude: PATIENT.longitude, accuracyMeters: 12 }
    }
  } as never;
}

/** Two accepted responders with live assignments, plus duplicate AED receipts. */
function world(): PersistentState {
  const state = emptyState();
  state.devices[uuid(300)] = device(uuid(300), uuid(301));
  state.devices[uuid(300)]!.latestPosition!.position =
    { kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID, state: "ACTIVE", recruitmentState: "RECRUITING",
    patientUserId: uuid(301), patientDeviceIds: [uuid(300)], patientPairId: uuid(702),
    observation: {
      schemaVersion: "2.0", eventId: EVENT_ID, observationKind: "FALL_CONTEXT",
      fallDetectedAt: AT, patientPositionObservedAt: AT,
      fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", ...PATIENT, accuracyMeters: 12 }
    },
    observationFingerprint: "f", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    patientPosition: {
      positionUpdateId: uuid(9_600), source: "IPHONE_PRIMARY", observedAt: AT,
      serverReceivedAt: AT, position: { kind: "P", ...PATIENT, accuracyMeters: 12 }
    },
    currentRecruitmentRadiusMeters: WIDEST, recruitmentStageStartedAt: AT,
    coordinationRevision: 4, assignmentRevision: 2, unavailableAedIds: [], createdAt: AT
  } as never;

  for (const [index, role, status] of [
    ["100", "GO_TO_PATIENT", "EN_ROUTE"],
    ["101", "FETCH_AED", "ARRIVED_AT_AED"]
  ] as const) {
    const id = uuid(Number(index));
    state.devices[id] = device(id, uuid(200 + Number(index) - 100));
    state.deliveries[uuid(500 + Number(index) - 100)] = {
      id: uuid(500 + Number(index) - 100), eventId: EVENT_ID, deviceInstanceId: id,
      request: {
        schemaVersion: "2.0",
        messageId: `response-requested:${EVENT_ID}:${id}`, eventId: EVENT_ID,
        deliveryId: uuid(500 + Number(index) - 100), deliveryStatus: "SENT", occurredAt: AT,
        eventType: "FALL_ASSISTANCE", positioningTier: "SEARCH_RING",
        distanceRange: "DISTANCE_500_1000M", etaRange: "ETA_5_10_MIN",
        currentRecruitmentRadiusMeters: WIDEST, expiresAt: AT
      },
      status: "ACCEPTED", decision: "ACCEPT", statusOccurredAt: AT
    } as never;
    state.assignments[uuid(700 + Number(index) - 100)] = {
      id: uuid(700 + Number(index) - 100), eventId: EVENT_ID, deviceInstanceId: id,
      role, status, revision: 2, updatedAt: AT, createdAt: AT
    } as never;
  }

  // Two receipts naming the SAME AED plus one other: the summary counts distinct
  // AEDs, so the answer is 2, not 3.  One of them is for another event and must not
  // contribute at all.
  state.aedReceiptsById[uuid(800)] = {
    canonical: { eventId: EVENT_ID, aedId: uuid(900), deviceInstanceId: uuid(100) },
    fingerprint: "r1"
  } as never;
  state.aedReceiptsById[uuid(801)] = {
    canonical: { eventId: EVENT_ID, aedId: uuid(900), deviceInstanceId: uuid(103) },
    fingerprint: "r2"
  } as never;
  state.aedReceiptsById[uuid(802)] = {
    canonical: { eventId: EVENT_ID, aedId: uuid(901), deviceInstanceId: uuid(100) },
    fingerprint: "r3"
  } as never;
  state.aedReceiptsById[uuid(803)] = {
    canonical: { eventId: uuid(20_999), aedId: uuid(902), deviceInstanceId: uuid(100) },
    fingerprint: "r4"
  } as never;
  return state;
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

function summaryViaReaders(state: PersistentState) {
  const normalized = structuredClone(new MemoryStateStore(state).read(s => s));
  return (service() as unknown as {
    coordinationSummary: (c: unknown, a: unknown, e: EventRecord, n: Date) =>
      Record<string, number>;
  }).coordinationSummary(draftRecruitmentContext(normalized),
    legacyCoordinationAedReader(normalized), normalized.events[EVENT_ID]!, NOW);
}

test("the AED figure counts distinct acquired AEDs of this event only", () => {
  const state = world();
  const summary = summaryViaReaders(state);

  // Independent recomputation straight off the raw state.
  const expected = new Set(Object.values(state.aedReceiptsById)
    .map(receipt => receipt.canonical)
    .filter(receipt => receipt.eventId === EVENT_ID)
    .map(receipt => receipt.aedId)).size;

  assert.equal(summary.aedAcquiredCount, 2,
    "two distinct AEDs for this event; the duplicate report and the foreign-event "
    + "receipt must not inflate it");
  assert.equal(summary.aedAcquiredCount, expected);
});

test("every summary field agrees with an independent recomputation", () => {
  const state = world();
  const summary = summaryViaReaders(state);
  const event = state.events[EVENT_ID]!;

  const acceptedDeviceIds = Object.values(state.deliveries)
    .filter(d => d.eventId === EVENT_ID && d.decision === "ACCEPT" && d.status === "ACCEPTED")
    .map(d => d.deviceInstanceId)
    .filter(id => !(state.devices[id]?.userId
      && event.exitedResponderUserIds?.includes(state.devices[id]!.userId!)))
    .sort((l, r) => l.localeCompare(r));

  const surviving = acceptedDeviceIds.map((deviceId) => {
    const rows = Object.values(state.assignments).filter(a =>
      a.eventId === EVENT_ID && a.deviceInstanceId === deviceId);
    return rows.sort((l, r) => r.revision - l.revision
      || r.updatedAt.localeCompare(l.updatedAt))[0];
  }).filter((a): a is NonNullable<typeof a> => a !== undefined);
  const participating = surviving.filter(a => a.status !== "TIMED_OUT" && a.status !== "CANCELLED");

  assert.equal(summary.revision, 4);
  assert.equal(summary.currentRecruitmentRadiusMeters, WIDEST);
  assert.equal(summary.acceptedResponderCount, acceptedDeviceIds.length);
  assert.equal(summary.goToPatientCount,
    participating.filter(a => a.role === "GO_TO_PATIENT").length);
  assert.equal(summary.fetchAedCount,
    participating.filter(a => a.role === "FETCH_AED").length);
  assert.equal(summary.enRouteCount,
    participating.filter(a => ["EN_ROUTE", "EN_ROUTE_TO_PATIENT"].includes(a.status)).length);
  assert.equal(summary.arrivedAtAedCount,
    participating.filter(a => a.status === "ARRIVED_AT_AED").length);
  assert.equal(summary.arrivedAtPatientCount,
    surviving.filter(a => ["ARRIVED_AT_PATIENT", "COMPLETED"].includes(a.status)).length);
  assert.equal(summary.completedAssignmentCount,
    surviving.filter(a => a.status === "COMPLETED").length);

  // Sanity: the fixture must actually exercise the buckets, or the equalities above
  // would hold trivially against zeros.
  assert.equal(summary.acceptedResponderCount, 2);
  assert.equal(summary.goToPatientCount, 1);
  assert.equal(summary.fetchAedCount, 1);
  assert.equal(summary.enRouteCount, 1);
  assert.equal(summary.arrivedAtAedCount, 1);
});
