/**
 * `eligibleResponderDevices` — the first place the algorithm turns a candidate set
 * into an ordered result with identity-selection semantics.
 *
 * The frozen pipeline is: candidates -> eligibility filter -> ascending id ->
 * identity de-duplication.  Each stage boundary is locked separately, because the
 * failure modes are different and all of them are silent:
 *
 *   - de-duplicating before filtering lets an INELIGIBLE low-sorting device evict
 *     an eligible sibling of the same identity, losing a responder outright;
 *   - de-duplicating before sorting makes the survivor depend on the candidate
 *     enumeration order rather than the lexicographically smallest id.
 *
 * Case 3 below is the one that catches the first mistake, so it is written so that
 * the two devices differ ONLY in eligibility.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { deviceIdentityKey } from "../src/domain.js";
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
  dataFile: "/tmp/aedresponse-eligible-test.json",
  fixtureFile: "/tmp/aedresponse-eligible-fixture.json",
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

function device(deviceInstanceId: string, userId: string | undefined): DeviceRecord {
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
      position: {
        kind: "R",
        latitude: PATIENT.latitude + 0.005,
        longitude: PATIENT.longitude,
        accuracyMeters: 12
      }
    }
  } as never;
}

function world() {
  const state = emptyState();
  const patientDevice = uuid(300);
  state.devices[patientDevice] = device(patientDevice, uuid(301));
  state.devices[patientDevice]!.latestPosition!.position = {
    kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: uuid(301),
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
  return { state, patientDevice };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

/** Private, reached by bracket access; see the earlier note on why. */
function eligibleIds(state: PersistentState): string[] {
  const instance = service();
  return (instance as unknown as {
    eligibleResponderDevices: (c: unknown, e: unknown, n: Date) => DeviceRecord[];
  }).eligibleResponderDevices(draftRecruitmentContext(state), state.events[EVENT_ID], NOW)
    .map(entry => entry.deviceInstanceId);
}

test("case 1: candidates arrive reversed, the result is still ascending", () => {
  const { state } = world();
  // Insert in descending id order so that returning candidate order unchanged
  // would be visible as a descending result.
  const ids = [uuid(110), uuid(109), uuid(108), uuid(107)];
  // Distinct users: with one shared user the identity de-duplication would
  // correctly collapse all four to one device, and this case would be testing
  // de-duplication rather than ordering.
  ids.forEach((id, index) => { state.devices[id] = device(id, uuid(210 + index)); });

  assert.deepEqual(eligibleIds(state), [...ids].sort((l, r) => l.localeCompare(r)),
    "the pipeline sorts by deviceInstanceId, not by candidate enumeration order");
});

test("case 2: two eligible devices of one identity keep the smaller id", () => {
  const { state } = world();
  const user = uuid(200);
  const small = uuid(100);
  const large = uuid(101);
  // Inserted large first, so insertion order cannot be what saves the smaller id.
  state.devices[large] = device(large, user);
  state.devices[small] = device(small, user);
  assert.equal(deviceIdentityKey(state.devices[small]!), deviceIdentityKey(state.devices[large]!));

  assert.deepEqual(eligibleIds(state), [small],
    "de-duplication runs after sorting, so the lexicographically smallest device "
    + "survives regardless of which one the candidate list produced first");
});

test("case 3: an ineligible small id must not evict an eligible larger one", () => {
  const { state } = world();
  const user = uuid(200);
  const ineligible = uuid(100);
  const eligible = uuid(101);
  state.devices[ineligible] = device(ineligible, user);
  state.devices[eligible] = device(eligible, user);

  // The ONLY difference between the two: availability.
  (state.devices[ineligible] as { availableForResponse: boolean }).availableForResponse = false;

  assert.deepEqual(eligibleIds(state), [eligible],
    "filtering must precede identity de-duplication. De-duplicating first would "
    + "keep the ineligible smaller id and then drop it, silently losing this "
    + "identity's responder entirely.");

  // And the converse, to prove the survivor tracks eligibility and not id order.
  (state.devices[ineligible] as { availableForResponse: boolean }).availableForResponse = true;
  (state.devices[eligible] as { availableForResponse: boolean }).availableForResponse = false;
  assert.deepEqual(eligibleIds(state), [ineligible]);
});

test("case 4: different identities are all kept and ordered by device id", () => {
  const { state } = world();
  const ids = [uuid(105), uuid(103), uuid(104)];
  ids.forEach((id, index) => { state.devices[id] = device(id, uuid(220 + index)); });

  assert.deepEqual(eligibleIds(state), [...ids].sort((l, r) => l.localeCompare(r)));
  assert.equal(new Set(eligibleIds(state)).size, 3, "three distinct identities survive");
});

test("case 5: unrelated candidates are filtered out without disturbing the result", () => {
  const { state } = world();
  const wanted = [uuid(100), uuid(102)];
  wanted.forEach((id, index) => { state.devices[id] = device(id, uuid(200 + index)); });
  const baseline = eligibleIds(state);

  // Devices that fail for five different reasons, interleaved by id.
  const byId = (id: string, mutate: (d: DeviceRecord) => void): void => {
    state.devices[id] = device(id, uuid(250));
    mutate(state.devices[id]!);
  };
  byId(uuid(99), d => { (d as { deviceKind: string }).deviceKind = "WATCH"; });
  byId(uuid(101), d => { (d.capabilities as { locationAuthorized: boolean }).locationAuthorized = false; });
  byId(uuid(103), d => { delete (d as { latestPosition?: unknown }).latestPosition; });
  byId(uuid(104), d => { (d as { availableForResponse: boolean }).availableForResponse = false; });
  byId(uuid(106), d => { (d.agreements as Record<string, unknown>).PATIENT = undefined; });

  assert.deepEqual(eligibleIds(state), baseline,
    "exact eligibility still decides membership; the candidate set only over-selects");
  assert.ok(!eligibleIds(state).includes(uuid(101)));
});

test("candidate contract: no deviceInstanceId is handed out twice", () => {
  const { state } = world();
  for (const id of [uuid(100), uuid(101), uuid(102)]) state.devices[id] = device(id, uuid(200));
  const ctx = draftRecruitmentContext(state);
  const candidates = ctx.candidateDevices(state.events[EVENT_ID]!);

  const ids = candidates.map(entry => entry.deviceInstanceId);
  assert.equal(ids.length, new Set(ids).size,
    "a transaction adapter unions a committed index result with staged keys, where "
    + "the same device appears on both sides; uniqueness is the context's contract, "
    + "not something the caller's sort and de-duplication may be relied on to fix");
  // The legacy adapter satisfies this trivially, which is the point: the contract
  // exists for the adapter that cannot.
  assert.equal(candidates.length, Object.keys(state.devices).length);
});

test("commit 1 diagnostic: the legacy candidate set is still every device", () => {
  const { state } = world();
  for (let index = 0; index < 500; index += 1) {
    state.devices[`filler-${index}`] = device(`filler-${index}`, `user-${index}`);
    (state.devices[`filler-${index}`] as { availableForResponse: boolean })
      .availableForResponse = false;
  }

  resetMetrics();
  eligibleIds(state);
  const visited = snapshotMetrics().operation.deviceCandidatesVisited;
  assert.equal(visited, 501,
    "the legacy adapter still offers every device and the predicate rejects most of "
    + "them. A drop here means a geographic index was wired in ahead of the "
    + "transaction adapter that can union it with the transaction's own changes.");

  // And the rejection really is the predicate's doing, one visit per candidate.
  assert.equal(snapshotMetrics().operation.deviceCandidatesVisited,
    Object.keys(state.devices).length);
});
