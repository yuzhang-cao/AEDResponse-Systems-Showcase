/**
 * The gate before 4b: is `relevantEventIds` limit-1 probe equivalent to the legacy
 * `Object.values(state.events)` refresh loop?
 *
 * It is not, and this test is what proves it rather than leaving it to inspection.
 * `relevantRecruitingEventIds` answers "is there at least ONE event this position
 * change could affect" - both its scan fallback and its projection path stop at the
 * first match - and the legacy branch uses it only to CHOOSE a route.  The refresh
 * loop itself walks every event, and `refreshRecruitmentForEvent` narrows that to
 * ACTIVE + RECRUITING by its own early return.
 *
 * So when 4b moves the branch onto `transactEntities`, the event list must be
 * enumerated from the transaction view.  Narrowing it to the probe's single id would
 * silently stop refreshing the second and later affected events: an offer that
 * should have been expired or a ring that should have widened would simply not be.
 *
 * This also pins the real invariant the routing decision quietly relies on: the probe
 * returning ONE id only ever means "at least one", never "exactly one".
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { AEDResponseService, RECRUITMENT_RADIUS_STAGES_METERS } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };
const WIDEST = RECRUITMENT_RADIUS_STAGES_METERS[RECRUITMENT_RADIUS_STAGES_METERS.length - 1];

const config: BackendConfig = {
  host: "127.0.0.1", port: 0,
  dataFile: "/tmp/aedresponse-4bgate.json", fixtureFile: "/tmp/aedresponse-4bgate-fixture.json",
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
    availableForResponse: true, presenceObservedAt: AT, lastSeenAt: AT, lastBootstrapAt: AT
  } as never;
}

/** Two events whose rings both contain the position under test, plus an ended one. */
function world(): { state: PersistentState; eventIds: string[] } {
  const state = emptyState();
  const eventIds = [uuid(400), uuid(401)];
  state.devices[uuid(100)] = device(uuid(100), uuid(200));
  for (const [index, eventId] of eventIds.entries()) {
    const patientDevice = uuid(300 + index);
    state.devices[patientDevice] = device(patientDevice, uuid(310 + index));
    state.events[eventId] = {
      id: eventId, state: "ACTIVE", recruitmentState: "RECRUITING",
      patientUserId: uuid(310 + index), patientDeviceIds: [patientDevice],
      patientPairId: uuid(702 + index),
      observation: {
        schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT",
        fallDetectedAt: AT, patientPositionObservedAt: AT,
        fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
        patientPosition: { kind: "P", ...PATIENT, accuracyMeters: 12 }
      },
      observationFingerprint: "f", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
      patientPosition: {
        positionUpdateId: uuid(9_600 + index), source: "IPHONE_PRIMARY", observedAt: AT,
        serverReceivedAt: AT, position: { kind: "P", ...PATIENT, accuracyMeters: 12 }
      },
      currentRecruitmentRadiusMeters: WIDEST, recruitmentStageStartedAt: AT,
      coordinationRevision: 1, assignmentRevision: 1, unavailableAedIds: [], createdAt: AT
    } as never;
  }
  // An ended event in the same place: it must contribute to neither set.
  state.events[uuid(402)] = structuredClone(state.events[eventIds[0]!]!) as EventRecord;
  (state.events[uuid(402)] as { id: string; state: string }).id = uuid(402);
  (state.events[uuid(402)] as { state: string }).state = "RESOLVED";
  return { state, eventIds };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

test("the relevance probe reports at least one, not exactly one", () => {
  const { state } = world();
  const normalized = structuredClone(new MemoryStateStore(state).read(s => s));
  // The service must own the store that holds the events: the projection path reads
  // through `this.store`, so a service over an empty store sees no events at all.
  const instance = new AEDResponseService(new MemoryStateStore(normalized), config,
    undefined, () => NOW);
  const ids = (instance as unknown as {
    relevantRecruitingEventIds: (d: string, p: unknown) => string[];
  }).relevantRecruitingEventIds(uuid(100), { kind: "R", ...PATIENT, accuracyMeters: 12 });

  assert.equal(ids.length, 1,
    "both scan and projection stop at the first match, so the probe can only ever "
    + "report one id no matter how many events are actually affected");
});

test("the legacy refresh set is every ACTIVE+RECRUITING event, not the probe's one", () => {
  const { state, eventIds } = world();
  const normalized = structuredClone(new MemoryStateStore(state).read(s => s));

  // Exactly what the legacy branch enumerates, plus the narrowing
  // `refreshRecruitmentForEvent` applies by its own early return.
  const refreshed: string[] = [];
  const instance = service() as unknown as {
    refreshRecruitmentForEvent: (c: unknown, e: EventRecord, n: Date) =>
      { changed: boolean; event: EventRecord };
  };
  for (const event of Object.values(normalized.events)) {
    if (event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") continue;
    refreshed.push(event.id);
    instance.refreshRecruitmentForEvent(draftRecruitmentContext(normalized), event, NOW);
  }

  assert.deepEqual(refreshed.sort(), [...eventIds].sort(),
    "both live events are refreshed; the ended one is skipped. A 4b implementation "
    + "that used the probe's single id would refresh only one of these two, silently "
    + "dropping the other event's offer expiry and ring advance.");
  assert.equal(refreshed.length, 2);
});
