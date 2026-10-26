/**
 * `recruitmentPotentialDevices` — which of the already-selected eligible devices
 * still count as recruitment potential once deliveries are taken into account.
 *
 * Three things are frozen here, and all three are silent when they break:
 *
 * 1. `deliveryIsLive`'s status set, enumerated from the implementation rather than
 *    guessed from the names.  `pendingDeliveryStatuses` is exactly
 *    SENT / DELIVERED / VIEWED; ACCEPTED, REFUSED and EXPIRED are all not live.
 * 2. The user/device lookup is a CHOICE, not an OR.  A device bound to a user is
 *    judged by that user's delivery on this event; an unbound device by its own.
 *    The two queries consult different rows, so they cannot be merged.
 * 3. The delivery filter runs AFTER identity de-duplication, so removing the
 *    survivor does not back-fill the identity from its other devices.
 *
 * Point 3 is the one most likely to be "improved" away, so it is locked explicitly
 * rather than left implied by the pipeline order.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
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
  dataFile: "/tmp/aedresponse-potential-test.json",
  fixtureFile: "/tmp/aedresponse-potential-fixture.json",
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

const LIVE_EXPIRY = new Date(NOW.getTime() + 60_000).toISOString();
const PAST_EXPIRY = new Date(NOW.getTime() - 60_000).toISOString();

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
      position: { kind: "R", latitude: PATIENT.latitude + 0.005,
        longitude: PATIENT.longitude, accuracyMeters: 12 }
    }
  } as never;
}

function world() {
  const state = emptyState();
  const patientDevice = uuid(300);
  state.devices[patientDevice] = device(patientDevice, uuid(301));
  state.devices[patientDevice]!.latestPosition!.position =
    { kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: uuid(301),
    patientDeviceIds: [patientDevice],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT" },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: { source: "PATIENT_APP", observedAt: AT,
      position: { kind: "P", ...PATIENT, accuracyMeters: 12 } },
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentState: "RECRUITING",
    coordinationRevision: 1,
    createdAt: AT
  } as never;
  return { state };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

function potentialIds(state: PersistentState, now: Date = NOW): string[] {
  const instance = service();
  return (instance as unknown as {
    recruitmentPotentialDevices: (c: unknown, e: unknown, n: Date) => DeviceRecord[];
  }).recruitmentPotentialDevices(draftRecruitmentContext(state), state.events[EVENT_ID], now)
    .map(entry => entry.deviceInstanceId);
}

function deliveryFor(deviceInstanceId: string, status: string,
  overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(600 + Math.floor(Math.random() * 1_000)),
    eventId: EVENT_ID,
    deviceInstanceId,
    request: { expiresAt: LIVE_EXPIRY },
    status,
    statusOccurredAt: AT,
    ...overrides
  } as never;
}

test("deliveryIsLive status table: exactly SENT/DELIVERED/VIEWED are live", () => {
  // Every status in the DeliveryStatus union, with the verdict read off the
  // implementation's `pendingDeliveryStatuses` list rather than inferred from the
  // name.  A future status added to the schema will fail to appear here only by
  // being added to the union, which is the point: this table is exhaustive.
  const statuses: Array<[string, boolean]> = [
    ["SENT", true],
    ["DELIVERED", true],
    ["VIEWED", true],
    ["ACCEPTED", false],
    ["REFUSED", false],
    ["EXPIRED", false]
  ];

  for (const [status, live] of statuses) {
    const { state } = world();
    const candidate = uuid(100);
    state.devices[candidate] = device(candidate, uuid(200));
    const live0 = status === "SENT" || status === "DELIVERED" || status === "VIEWED";
    state.deliveries[uuid(500)] = deliveryFor(candidate, status,
      live0 ? {} : { request: { expiresAt: PAST_EXPIRY } });

    assert.deepEqual(potentialIds(state), live ? [candidate] : [],
      `status ${status} must be ${live ? "live" : "not live"}`);
  }
});

test("deliveryIsLive also depends on expiry, not only on status", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));

  state.deliveries[uuid(500)] = deliveryFor(candidate, "SENT", { request: { expiresAt: LIVE_EXPIRY } });
  assert.deepEqual(potentialIds(state), [candidate], "not yet expired is live");

  (state.deliveries[uuid(500)] as { request: { expiresAt: string } }).request.expiresAt = PAST_EXPIRY;
  assert.deepEqual(potentialIds(state), [], "past expiry is not live even for a pending status");

  (state.deliveries[uuid(500)] as { request: { expiresAt: string } }).request.expiresAt = AT;
  assert.deepEqual(potentialIds(state), [candidate],
    "exactly at expiry is still live, because the comparison is now <= expiresAt");

  (state.deliveries[uuid(500)] as { request: { expiresAt: string } }).request.expiresAt = "not-a-date";
  assert.deepEqual(potentialIds(state), [],
    "an unparseable expiry is not live; this is a fallback, not a crash");
});

test("the user/device lookup is a choice, not an OR", () => {
  const { state } = world();
  const user = uuid(200);
  const bound = uuid(100);
  const other = uuid(101);
  state.devices[bound] = device(bound, user);
  state.devices[other] = device(other, user);

  // A DEAD offer on the same user's OTHER device.  `bound` is the identity's
  // de-duplication survivor and holds no delivery of its own; asking about the
  // user finds the sibling's offer and removes `bound`.  Asking about the device
  // alone would find nothing and keep it — so an empty result proves the user
  // query is the one being consulted.
  state.deliveries[uuid(500)] = deliveryFor(other, "REFUSED", { request: { expiresAt: PAST_EXPIRY } });
  assert.deepEqual(potentialIds(state), [],
    "a bound device is judged by its user's delivery, which covers that person's "
    + "other devices; the device-level query alone would have kept it");

  // An unbound device has no user query available, so its own device query decides.
  const unbound = uuid(102);
  state.devices[unbound] = device(unbound, undefined);
  state.deliveries[uuid(501)] = deliveryFor(unbound, "REFUSED", { request: { expiresAt: PAST_EXPIRY } });
  assert.deepEqual(potentialIds(state), [],
    "the unbound device is removed by its own delivery while the sibling's dead "
    + "offer still removes the bound one");

  // Removing the dead offer restores the identity, and the survivor is `bound`.
  delete state.deliveries[uuid(500)];
  delete state.deliveries[uuid(501)];
  assert.deepEqual(potentialIds(state), [bound, unbound],
    "both are potential again, sorted by device id");
});

test("when both queries can hit, the user query is the one that decides", () => {
  const { state } = world();
  const user = uuid(200);
  const bound = uuid(100);
  const other = uuid(101);
  state.devices[bound] = device(bound, user);
  state.devices[other] = device(other, user);

  // Two deliveries for the SAME user, with different liveness, inserted so that the
  // dead one is enumerated first.  `deliveryForUser` returns the first match it
  // walks into — the sibling's dead offer — while `deliveryForDevice` would have
  // returned this device's live one.  The two lookups therefore disagree, and only
  // the ternary's answer is the legacy behaviour.
  state.deliveries[uuid(500)] = deliveryFor(other, "REFUSED", { request: { expiresAt: PAST_EXPIRY } });
  state.deliveries[uuid(501)] = deliveryFor(bound, "SENT");

  assert.deepEqual(potentialIds(state), [],
    "the bound device is judged by its user's delivery, and `deliveryForUser` "
    + "returns the first matching row in enumeration order. Answering [bound] here "
    + "would mean the lookup had fallen back to the device query, which consults a "
    + "different row and reaches a different verdict.");

  // Flipping the enumeration order flips the verdict, which is the legacy behaviour
  // and not something this refactor may quietly normalise away.
  delete state.deliveries[uuid(500)];
  delete state.deliveries[uuid(501)];
  state.deliveries[uuid(502)] = deliveryFor(bound, "SENT");
  state.deliveries[uuid(503)] = deliveryFor(other, "REFUSED", { request: { expiresAt: PAST_EXPIRY } });
  assert.deepEqual(potentialIds(state), [bound],
    "with the live offer enumerated first the same identity survives; the lookup "
    + "consults one row, not a merged view");
});

test("no delivery at all leaves the eligible set untouched", () => {
  const { state } = world();
  const ids = [uuid(100), uuid(101), uuid(102)];
  ids.forEach((id, index) => { state.devices[id] = device(id, uuid(200 + index)); });
  assert.deepEqual(potentialIds(state), ids,
    "potential is not a subset requirement: with no offers outstanding every "
    + "eligible responder is potential");
});

test("the delivery filter runs after identity de-duplication and does not back-fill", () => {
  const { state } = world();
  const user = uuid(200);
  const small = uuid(100);   // lexicographically first, so this is the survivor
  const large = uuid(101);   // same identity, also eligible
  state.devices[small] = device(small, user);
  state.devices[large] = device(large, user);

  // The user's offer is dead (refused), so the potential filter removes the
  // survivor.  A live offer would NOT remove it: an outstanding offer is exactly
  // what potential means here.
  state.deliveries[uuid(500)] = deliveryFor(small, "REFUSED", { request: { expiresAt: PAST_EXPIRY } });

  assert.deepEqual(potentialIds(state), [],
    "de-duplication already chose `small`; removing it here must NOT back-fill the "
    + "identity with `large`. A 'more reasonable' implementation that re-runs "
    + "selection after filtering would return [large] and silently widen the ring.");

  // Proof that `large` really is eligible and was available to be chosen: clear
  // the offer and the survivor reappears as itself, not as `large`.
  delete state.deliveries[uuid(500)];
  assert.deepEqual(potentialIds(state), [small],
    "the survivor is the same device before and after, so the empty result above "
    + "came from filtering and not from `large` being ineligible");
});

test("transaction semantics: a delivery written in this transaction is seen at once", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const instance = service();
  const ctx = draftRecruitmentContext(state);

  const ask = (): string[] => (instance as unknown as {
    recruitmentPotentialDevices: (c: unknown, e: unknown, n: Date) => DeviceRecord[];
  }).recruitmentPotentialDevices(ctx, state.events[EVENT_ID], NOW)
    .map(entry => entry.deviceInstanceId);

  assert.deepEqual(ask(), [candidate]);

  // A live offer keeps the device potential: it is still waiting to hear back.
  state.deliveries[uuid(500)] = deliveryFor(candidate, "SENT");
  assert.deepEqual(ask(), [candidate],
    "a pending offer does not remove potential; it IS potential");

  // The status change lands on the decision immediately, from the same context and
  // without any second write.
  (state.deliveries[uuid(500)] as { status: string }).status = "REFUSED";
  assert.deepEqual(ask(), [],
    "read-your-writes: the draft sees the refusal this transaction just recorded");

  // And a status flipped back is seen just as immediately, in the other direction.
  (state.deliveries[uuid(500)] as { status: string }).status = "SENT";
  assert.deepEqual(ask(), [candidate]);
});

test("commit 1 diagnostic: the legacy context still scans deliveries per candidate", () => {
  const { state } = world();
  for (let index = 0; index < 50; index += 1) {
    state.devices[uuid(100 + index)] = device(uuid(100 + index), uuid(200 + index));
  }
  for (let index = 0; index < 500; index += 1) {
    state.deliveries[`filler-${index}`] = deliveryFor(`other-${index}`, "SENT",
      { eventId: `other-event-${index}` });
  }

  resetMetrics();
  const result = potentialIds(state);
  assert.equal(result.length, 50, "every candidate is potential: no filler matches");

  const visited = snapshotMetrics().operation.deliveryCandidatesVisited;
  assert.ok(visited >= 50 * 500,
    "each candidate's delivery lookup still walks the whole collection, so 50 "
    + `candidates must visit 25,000 rows; saw ${visited}. A collapse here `
    + "means a committed delivery index was wired in ahead of the transaction "
    + "adapter that can union it with this transaction's own changes.");
});
