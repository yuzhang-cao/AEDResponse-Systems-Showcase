/**
 * Behaviour locks for `isEligibleNearbyResponder` — the "nearby" half of responder
 * eligibility.
 *
 * The base predicate already has its own 14-row truth table; repeating those rows
 * here would prove nothing new.  What this layer adds is the event relationship
 * (state / recruitmentState / patient identity / exited responders), the distance
 * ring, and the identity-scoped accepted-delivery rule.  Each is locked separately.
 *
 * Boundary note: the ring comparison is pinned without any floating-point search.
 * The patient is placed at a fixed spot, `distanceMeters` is asked for the exact
 * distance, and the radius is then set to that distance.  A predicate using `<`
 * would answer false there and fail this test; `<=` answers true.  Offsets by an
 * epsilon in the radius then pin the other side.
 *
 * The predicate is private and reached by bracket access, for the same reason as
 * before: the public summary path passes `precomputedBusyIdentities` and never
 * reaches the code this migration touched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { deviceIdentityKey, distanceMeters } from "../src/domain.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type DeviceRecord, type PersistentState } from "../src/models.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "/tmp/aedresponse-nearby-test.json",
  fixtureFile: "/tmp/aedresponse-nearby-fixture.json",
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

function responderDevice(deviceInstanceId: string, userId: string | undefined,
  latitude: number, longitude: number): DeviceRecord {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000),
    agreements: structuredClone(AGREEMENTS),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: AT,
    lastSeenAt: AT,
    lastBootstrapAt: AT,
    latestPosition: {
      observedAt: AT,
      position: { kind: "R", latitude, longitude, accuracyMeters: 12 }
    }
  } as never;
}

/**
 * Patient at `PATIENT`; the candidate sits a few hundred metres north, comfortably
 * inside the default 1 km ring so that every test starts from `true`.
 *
 * The offset must be non-zero: a candidate on the patient's exact coordinates has
 * distance 0, and the ring test below cannot tell `<=` from `<` at zero.
 */
function world() {
  const state = emptyState();
  const patientDevice = uuid(300);
  const patientUser = uuid(301);
  const candidate = uuid(100);
  const candidateUser = uuid(200);
  state.devices[patientDevice] = responderDevice(patientDevice, patientUser,
    PATIENT.latitude, PATIENT.longitude);
  state.devices[candidate] = responderDevice(candidate, candidateUser,
    PATIENT.latitude + 0.005, PATIENT.longitude);
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: patientUser,
    patientDeviceIds: [patientDevice],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT" },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: {
      source: "PATIENT_APP",
      observedAt: AT,
      position: { kind: "P", ...PATIENT, accuracyMeters: 12 }
    },
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentState: "RECRUITING",
    coordinationRevision: 1,
    createdAt: AT
  } as never;
  return { state, candidate, candidateUser, patientDevice, patientUser };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

function nearby(
  instance: AEDResponseService,
  state: PersistentState,
  device: DeviceRecord,
  now: Date = NOW,
  requireRecruiting = true
): boolean {
  return (instance as unknown as {
    isEligibleNearbyResponder: (
      ctx: unknown, e: unknown, d: DeviceRecord, n: Date, recruiting?: boolean
    ) => boolean;
  }).isEligibleNearbyResponder(draftRecruitmentContext(state), state.events[EVENT_ID],
    device, now, requireRecruiting);
}

/** A delivery row, defaulting to the shape that blocks an offer. */
function delivery(id: string, deviceInstanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventId: EVENT_ID,
    deviceInstanceId,
    request: {},
    status: "ACCEPTED",
    decision: "ACCEPT",
    statusOccurredAt: AT,
    ...overrides
  } as never;
}

test("baseline: a base-eligible device inside the ring qualifies", () => {
  const { state, candidate } = world();
  assert.equal(nearby(service(), state, state.devices[candidate]!), true);
});

test("ring: the comparison is `<=` on distance and the event radius", () => {
  const { state, candidate } = world();
  const instance = service();
  const event = state.events[EVENT_ID] as { currentRecruitmentRadiusMeters: number };
  const device = state.devices[candidate]!;
  const measured = distanceMeters(device.latestPosition!.position as never, PATIENT as never);
  assert.ok(measured > 100, `the fixture must place the candidate off the patient, got ${measured} m`);

  event.currentRecruitmentRadiusMeters = measured;
  assert.equal(nearby(instance, state, device), true,
    "a radius exactly equal to the distance must qualify, which is what `<=` means; "
    + "a `<` comparison would answer false here");

  event.currentRecruitmentRadiusMeters = measured - 1e-9;
  assert.equal(nearby(instance, state, device), false, "a hair inside the distance refuses");

  event.currentRecruitmentRadiusMeters = measured + 1e-9;
  assert.equal(nearby(instance, state, device), true, "a hair beyond the distance admits");

  event.currentRecruitmentRadiusMeters = measured / 2;
  assert.equal(nearby(instance, state, device), false, "well outside refuses");
});

test("event relationship: state, recruitment stage, patient and exited responders", () => {
  const rows: Array<[string, (event: Record<string, unknown>, device: DeviceRecord) => void, boolean]> = [
    ["the event is not ACTIVE", event => { event.state = "RESOLVED"; }, false],
    ["the event is not recruiting", event => { event.recruitmentState = "SATURATED"; }, false],
    ["the device is this event's patient device", event => {
      (event.patientDeviceIds as string[]).push(uuid(100)); }, false],
    ["the device's user is this event's patient", event => {
      event.patientUserId = uuid(200); }, false],
    ["the user has exited as a responder", event => {
      event.exitedResponderUserIds = [uuid(200)]; }, false]
  ];

  for (const [label, mutate, expected] of rows) {
    const { state, candidate } = world();
    mutate(state.events[EVENT_ID] as never as Record<string, unknown>, state.devices[candidate]!);
    assert.equal(nearby(service(), state, state.devices[candidate]!), expected, label);
  }
});

test("requireRecruiting=false ignores the stage, which is why presenceView passes it", () => {
  const { state, candidate } = world();
  (state.events[EVENT_ID] as { recruitmentState: string }).recruitmentState = "SATURATED";
  const device = state.devices[candidate]!;
  assert.equal(nearby(service(), state, device, NOW, true), false);
  assert.equal(nearby(service(), state, device, NOW, false), true,
    "a warm sampling ring survives an expired offer; the flag must keep working");
});

test("accepted deliveries block by identity, not by device or user", () => {
  const { state, candidate, candidateUser } = world();
  const instance = service();
  const device = state.devices[candidate]!;

  // A pending offer is not an acceptance and must not block.
  state.deliveries.pending = delivery("pending", candidate, { status: "SENT", decision: undefined });
  assert.equal(nearby(instance, state, device), true, "a merely offered device stays eligible");

  // A refusal must not block either.
  state.deliveries.refused = delivery("refused", candidate, { status: "REFUSED", decision: "DECLINE" });
  assert.equal(nearby(instance, state, device), true);

  // ACCEPT decision but a status that is not ACCEPTED must not block.
  state.deliveries.inflight = delivery("inflight", candidate, { status: "VIEWED" });
  assert.equal(nearby(instance, state, device), true);
  delete state.deliveries.inflight;

  // Another event's acceptance must not block.
  state.deliveries.elsewhere = delivery("elsewhere", candidate, { eventId: "other-event" });
  assert.equal(nearby(instance, state, device), true);
  delete state.deliveries.elsewhere;

  // A second device of the same person is the case the identity rule exists for.
  const twin = uuid(101);
  state.devices[twin] = responderDevice(twin, candidateUser,
    PATIENT.latitude + 0.005, PATIENT.longitude);
  assert.equal(deviceIdentityKey(state.devices[twin]!), deviceIdentityKey(device));
  state.deliveries.twin = delivery("twin", twin);
  assert.equal(nearby(instance, state, device), false,
    "an acceptance from the same identity on another device must block");
  assert.equal(nearby(instance, state, state.devices[twin]!), false,
    "and symmetrically, the twin sees its own acceptance");
});

test("transaction semantics: a delivery accepted in this transaction blocks at once", () => {
  const { state, candidate } = world();
  // One context, held across the write, exactly as the recruitment transaction
  // holds it: the acceptance is written and the predicate re-asked immediately.
  const instance = service();
  const device = state.devices[candidate]!;
  const ctx = draftRecruitmentContext(state);

  const ask = (): boolean => (instance as unknown as {
    isEligibleNearbyResponder: (c: unknown, e: unknown, d: DeviceRecord, n: Date) => boolean;
  }).isEligibleNearbyResponder(ctx, state.events[EVENT_ID], device, NOW);

  assert.equal(ask(), true, "eligible before the in-transaction acceptance");
  state.deliveries.fresh = delivery("fresh", candidate);
  assert.equal(ask(), false,
    "read-your-writes: the draft context must see the delivery this transaction just "
    + "created. This is the property the Phase 2 Tx adapter must preserve.");
});

test("position inputs: missing, inaccurate and stale patient samples refuse", () => {
  const { state, candidate } = world();
  const instance = service();
  const device = state.devices[candidate]!;

  (state.events[EVENT_ID] as { patientPosition: unknown }).patientPosition = null;
  assert.equal(nearby(instance, state, device), false, "no patient position");

  const { state: accurate, candidate: c2 } = world();
  (accurate.events[EVENT_ID] as { patientPosition: { position: { accuracyMeters: number } } })
    .patientPosition.position.accuracyMeters = config.maxPositionAccuracyMeters + 1;
  assert.equal(nearby(instance, accurate, accurate.devices[c2]!), false, "patient accuracy too poor");

  const { state: stale, candidate: c3 } = world();
  (stale.events[EVENT_ID] as { patientPosition: { observedAt: string } })
    .patientPosition.observedAt = new Date(NOW.getTime()
      - (config.positionMaxAgeSeconds * 1_000 + 1)).toISOString();
  assert.equal(nearby(instance, stale, stale.devices[c3]!), false, "patient sample too old");
});

test("commit 1 diagnostic: the legacy context still scans every delivery row", () => {
  const { state, candidate } = world();
  const device = state.devices[candidate]!;
  for (let index = 0; index < 1_000; index += 1) {
    state.deliveries[`filler-${index}`] = delivery(`filler-${index}`, `other-${index}`,
      { eventId: `other-event-${index}` });
  }

  // No acceptance names this identity, so `.some(...)` runs to exhaustion and the
  // visit count is an honest measure of the scan.
  resetMetrics();
  assert.equal(nearby(service(), state, device), true);
  assert.equal(snapshotMetrics().operation.deliveryCandidatesVisited, 1_000,
    "an extraction, not an optimisation: Phase 2 should drop this to the event's own "
    + "deliveries, and that change belongs to that commit");
});
