/**
 * Truth table for `isEligibleResponderDeviceBase`.
 *
 * It is a boolean eligibility gate, so the useful lock is not "a few happy cases"
 * but one row per rejection reason, each row changing exactly one condition from a
 * known-good baseline.  The conditions below are read off the implementation, not
 * off what we assume a responder gate ought to check.
 *
 * The predicate is private; it is reached by bracket access on purpose.  Testing it
 * through `getNearbyVolunteerSummary` would not exercise the assignment branch at
 * all: that path passes `precomputedBusyIdentities`, which skips the whole
 * `if (!precomputedBusyIdentities)` block — the very block this migration touched.
 * A test that cannot reach the changed code proves nothing about it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type DeviceRecord, type PersistentState } from "../src/models.js";
import { operationMetrics, resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "/tmp/aedresponse-eligibility-test.json",
  fixtureFile: "/tmp/aedresponse-eligibility-fixture.json",
  sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100,
  operatorToken: "operator-test-token",
  production: false
};

const AGREEMENTS = {
  PATIENT: { version: "2.0", acceptedAt: AT },
  VOLUNTEER_RESPONDER: { version: "2.0", acceptedAt: AT },
  PRIVACY_POLICY: { version: "2.0", acceptedAt: AT },
  SENSITIVE_PERSONAL_INFORMATION: { version: "2.0", acceptedAt: AT }
};

/** A device that satisfies every condition, so each row can break exactly one. */
function eligibleDevice(deviceInstanceId: string, userId?: string): DeviceRecord {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000),
    // Deep-copied per device.  The truth table mutates agreements to break one
    // condition at a time, and a shared literal would leak that into every later
    // test — which is exactly what happened on the first run of this file.
    agreements: structuredClone(AGREEMENTS),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: AT,
    lastSeenAt: AT,
    lastBootstrapAt: AT,
    latestPosition: {
      observedAt: AT,
      position: {
        kind: "R",
        latitude: 22.1987,
        longitude: 113.5439,
        accuracyMeters: 12
      }
    }
  } as never;
}

function activeEvent(id: string, patientUserId: string, patientDeviceId: string) {
  return {
    id,
    state: "ACTIVE",
    patientUserId,
    patientDeviceIds: [patientDeviceId],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT" },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: null,
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentState: "RECRUITING",
    coordinationRevision: 1,
    createdAt: AT
  } as never;
}

function assignment(id: string, deviceInstanceId: string, eventId: string, status: string) {
  return { id, deviceInstanceId, eventId, role: "GO_TO_PATIENT", status,
    revision: 1, updatedAt: AT } as never;
}

/** Baseline world: event far away in identity terms, one eligible candidate. */
function world() {
  const state = emptyState();
  const candidate = uuid(100);
  state.devices[candidate] = eligibleDevice(candidate, uuid(200));
  state.events[EVENT_ID] = activeEvent(EVENT_ID, uuid(300), uuid(301));
  return { state, candidate };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

/** Bracket access is the documented escape hatch for a private member. */
function eligible(
  instance: AEDResponseService,
  state: PersistentState,
  device: DeviceRecord,
  now: Date = NOW
): boolean {
  return (instance as unknown as {
    isEligibleResponderDeviceBase: (
      ctx: unknown, d: DeviceRecord, n: Date, stable?: boolean, busy?: ReadonlySet<string>
    ) => boolean;
  }).isEligibleResponderDeviceBase(draftRecruitmentContext(state), device, now);
}

test("baseline: a fully eligible responder device passes", () => {
  const { state, candidate } = world();
  assert.equal(eligible(service(), state, state.devices[candidate]!), true,
    "every row below is a single mutation of this device or its world");
});

test("truth table: each rejection reason refuses on its own", () => {
  const rows: Array<[string, (state: PersistentState, device: DeviceRecord) => void]> = [
    ["deviceKind is not IPHONE", (_s, d) => { (d as { deviceKind: string }).deviceKind = "WATCH"; }],
    ["a bootstrap agreement is missing", (_s, d) => {
      delete (d.agreements as Record<string, unknown>).PRIVACY_POLICY; }],
    ["an agreement version is not 2.0", (_s, d) => {
      (d.agreements as Record<string, { version: string }>).PATIENT!.version = "1.0"; }],
    ["an agreement acceptedAt is unparseable", (_s, d) => {
      (d.agreements as Record<string, { acceptedAt: string }>).PATIENT!.acceptedAt = "not-a-date"; }],
    ["availableForResponse is false", (_s, d) => { (d as { availableForResponse: boolean }).availableForResponse = false; }],
    ["location is not authorized", (_s, d) => { (d.capabilities as { locationAuthorized: boolean }).locationAuthorized = false; }],
    ["notifications are not authorized", (_s, d) => { (d.capabilities as { notificationAuthorized: boolean }).notificationAuthorized = false; }],
    ["the device is the patient device of an ACTIVE event", (s, d) => {
      (s.events[EVENT_ID] as { patientDeviceIds: string[] }).patientDeviceIds = [d.deviceInstanceId]; }],
    ["the device's user is the patient of an ACTIVE event", (s, d) => {
      (s.events[EVENT_ID] as { patientUserId: string }).patientUserId = d.userId!; }],
    ["there is no responder position", (_s, d) => { delete (d as { latestPosition?: unknown }).latestPosition; }],
    ["the stored sample is not an R position", (_s, d) => {
      ((d.latestPosition as { position: { kind: string } }).position).kind = "P"; }],
    ["accuracy is not finite", (_s, d) => {
      (d.latestPosition!.position as { accuracyMeters: number }).accuracyMeters = Number.NaN; }],
    ["accuracy is zero or negative", (_s, d) => {
      (d.latestPosition!.position as { accuracyMeters: number }).accuracyMeters = 0; }],
    ["accuracy exceeds the configured maximum", (_s, d) => {
      (d.latestPosition!.position as { accuracyMeters: number }).accuracyMeters =
        config.maxPositionAccuracyMeters + 1; }]
  ];

  for (const [label, mutate] of rows) {
    const { state, candidate } = world();
    const device = state.devices[candidate]!;
    mutate(state, device);
    assert.equal(eligible(service(), state, device), false,
      `expected rejection when ${label}`);
  }
});

test("assignment: only a live assignment on an ACTIVE event refuses", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["no assignment at all", "", "", true],
    ["an ACTIVE assignment on this device", "ACTIVE", "ASSIGNED", false],
    ["an ACTIVE assignment held by the same identity on another device", "ACTIVE", "ASSIGNED", false],
    ["an assignment that has exited participation", "ACTIVE", "CANCELLED", true],
    ["an assignment whose event is not ACTIVE", "RESOLVED", "ASSIGNED", true]
  ];

  for (const [label, eventState, status, expected] of cases) {
    const { state, candidate } = world();
    const device = state.devices[candidate]!;
    if (eventState) {
      if (label.startsWith("an ACTIVE assignment held")) {
        // Same user, different device: proves the predicate matches on identity.
        const twin = uuid(101);
        state.devices[twin] = eligibleDevice(twin, device.userId);
        state.assignments[uuid(500)] = assignment(uuid(500), twin, EVENT_ID, status);
      } else {
        state.assignments[uuid(500)] = assignment(uuid(500), candidate, EVENT_ID, status);
      }
      (state.events[EVENT_ID] as { state: string }).state = eventState;
    }
    assert.equal(eligible(service(), state, device), expected, label);
  }
});

test("identity: an unbound device and its bound twin are judged separately", () => {
  const { state, candidate } = world();
  const unbound = uuid(102);
  state.devices[unbound] = eligibleDevice(unbound);
  assert.equal(eligible(service(), state, state.devices[unbound]!), true,
    "an unbound device is still eligible while no assignment names it");

  // A live assignment on the bound device must not reach the unbound one: their
  // identities differ, and the predicate compares deviceInstanceId OR identity.
  state.assignments[uuid(500)] = assignment(uuid(500), candidate, EVENT_ID, "ASSIGNED");
  assert.equal(eligible(service(), state, state.devices[unbound]!), true);
  assert.equal(eligible(service(), state, state.devices[candidate]!), false);
});

test("time: the freshness boundary is unchanged by the context migration", () => {
  const { state, candidate } = world();
  const device = state.devices[candidate]!;
  const observedAt = Date.parse(AT);
  const instance = service();

  const atAge = (milliseconds: number): boolean => eligible(instance, state, device,
    new Date(observedAt + milliseconds));

  // Frozen boundary: the sample is fresh while age <= positionMaxAgeSeconds * 1000.
  assert.equal(atAge(config.positionMaxAgeSeconds * 1_000 - 1), true, "one ms inside");
  assert.equal(atAge(config.positionMaxAgeSeconds * 1_000), true,
    "exactly at the limit is still fresh");
  assert.equal(atAge(config.positionMaxAgeSeconds * 1_000 + 1), false, "one ms past");

  // Clock skew: a sample from the future is tolerated up to the skew allowance.
  assert.equal(atAge(-(config.maxClientClockSkewSeconds * 1_000)), true,
    "exactly at the skew allowance");
  assert.equal(atAge(-(config.maxClientClockSkewSeconds * 1_000 + 1)), false,
    "beyond the skew allowance");
});

test("commit 1 diagnostic: the legacy context still scans every assignment row", () => {
  const { state, candidate } = world();
  const device = state.devices[candidate]!;
  for (let index = 0; index < 1_000; index += 1) {
    state.assignments[`filler-${index}`] = assignment(`filler-${index}`, `other-${index}`,
      `other-event-${index}`, "ASSIGNED");
  }

  // No assignment names this device, so `.some(...)` cannot exit early and the
  // visit count is an honest measure of the scan.
  resetMetrics();
  assert.equal(eligible(service(), state, device), true);
  assert.equal(snapshotMetrics().operation.assignmentCandidatesVisited, 1_000,
    "commit 1 is an extraction, not an optimisation: the legacy adapter must still "
    + "visit every assignment row. Phase 2 should drop this to the relevant "
    + "candidate count, and that change belongs to that commit.");

  // A match present still short-circuits, exactly as `.some(...)` did.  Asserted as
  // a bound rather than an exact number so this stays about behaviour, not about
  // which slot the filler happens to occupy.
  resetMetrics();
  state.assignments.hit = assignment("hit", candidate, EVENT_ID, "ASSIGNED");
  assert.equal(eligible(service(), state, device), false);
  const withMatch = snapshotMetrics().operation.assignmentCandidatesVisited;
  assert.ok(withMatch >= 1 && withMatch <= 1_001,
    `expected a bounded short-circuit, visited ${withMatch}`);
});
