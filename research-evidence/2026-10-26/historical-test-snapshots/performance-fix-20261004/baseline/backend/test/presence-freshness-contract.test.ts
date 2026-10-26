/**
 * `presenceView` freshness contract (Phase 1 item #10, step ⑤ — product decision).
 *
 * Frozen product rule:
 *
 *   An ACTIVE rescue event's patient or responder whose last fix is older than
 *   10 minutes is no longer treated as a *current* position, but the coordinate is
 *   retained and reported as a *last known* position.
 *
 * The contract exposes exactly three states and no redundant booleans, so a client
 * cannot read two fields that disagree:
 *
 *   FRESH       — coordinate present, age <= 600 s; may be shown as current.
 *   STALE       — coordinate present, age >  600 s; last known only.
 *   UNAVAILABLE — no coordinate, or a timestamp that cannot be interpreted.
 *
 * `freshness` is the only field that authorises treating `position` as current.
 * The boundary is deliberately the same exclusive comparison reclamation uses, so
 * the two can never disagree at the edge.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import { AEDResponseService, positionFreshness } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";

const BASE_TIME = "2026-08-31T01:02:00.000Z";
const T0 = Date.parse(BASE_TIME);
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const config = {
  ...loadConfig({}, "/tmp"),
  authSubjectPepper: "presence-freshness-pepper",
  enableControlledTestAccounts: true
};

test("freshness verdicts follow the frozen rule and boundary", () => {
  const now = new Date(T0);
  const ago = (ms: number): string => new Date(T0 - ms).toISOString();
  assert.equal(positionFreshness(undefined, now, 600), "UNAVAILABLE");
  assert.equal(positionFreshness("not-a-date", now, 600), "UNAVAILABLE");
  assert.equal(positionFreshness(ago(599_000), now, 600), "FRESH");
  assert.equal(positionFreshness(ago(600_000), now, 600), "FRESH", "600.000 s exactly");
  assert.equal(positionFreshness(ago(600_001), now, 600), "STALE", "600.001 s");
  assert.equal(positionFreshness(at(500_000), now, 600), "FRESH", "a future sample clamps to age 0");
});

/** Builds an ACTIVE event with the accepted responder as the observed device. */
async function activeParticipantWorld() {
  const store = new MemoryStateStore(emptyState());
  let currentTime = new Date(T0);
  const service = new AEDResponseService(store, config, undefined, () => currentTime);

  const bootstrap = async (deviceId: string, pairId: string) => {
    const result = await service.bootstrap({
      deviceInstanceId: deviceId, deviceKind: "IPHONE", companionPairId: pairId,
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
          kind: kind as "PATIENT", version: "2.0", acceptedAt: BASE_TIME
        })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    }, `iphone:${deviceId}`);
    return service.authenticateToken(result.sessionToken);
  };

  const patientPairId = uuid(800);
  const patient = await bootstrap(uuid(801), patientPairId);
  const watchBootstrap = await service.bootstrap({
    deviceInstanceId: uuid(802), deviceKind: "WATCH", companionPairId: patientPairId
  }, "watch:freshness");
  const watch = service.authenticateToken(watchBootstrap.sessionToken);
  const responder = await bootstrap(uuid(803), uuid(804));

  await service.updateResponderPosition(responder, {
    positionUpdateId: uuid(810),
    responderPosition: { kind: "R", latitude: 22.198, longitude: 113.543, accuracyMeters: 10 },
    observedAt: BASE_TIME
  });

  const eventId = uuid(820);
  await service.reportWatchObservation(watch, eventId, {
    schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1_000), patientPositionObservedAt: BASE_TIME,
    fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
    patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12 }
  } as never);
  await service.updatePatientPosition(patient, eventId, {
    positionUpdateId: uuid(811),
    patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12 },
    observedAt: BASE_TIME
  } as never);

  const deliveryId = store.read(state => Object.values(state.deliveries)
    .find(delivery => delivery.eventId === eventId
      && delivery.deviceInstanceId === uuid(803))?.id);
  assert.ok(deliveryId);
  await service.respond(responder as never, eventId, deliveryId, {
    decision: "ACCEPT", decidedAt: at(2_000)
  });

  return {
    store, service, responder, eventId,
    setNow: (ms: number) => { currentTime = new Date(ms); }
  };
}

const CASES = [
  { offsetMs: 599_000, expected: "FRESH", retained: true, label: "ACTIVE participant, 9:59" },
  { offsetMs: 600_000, expected: "FRESH", retained: true, label: "ACTIVE participant, 10:00.000" },
  { offsetMs: 600_001, expected: "STALE", retained: true, label: "ACTIVE participant, 10:00.001" },
  { offsetMs: 1_200_000, expected: "STALE", retained: true, label: "ACTIVE participant, 20:00" }
] as const;

test("an ACTIVE participant retains a last-known position and is marked past its window", async () => {
  for (const testCase of CASES) {
    const world = await activeParticipantWorld();
    world.setNow(T0 + testCase.offsetMs);
    const view = await world.service.getPresence(world.responder as never);
    assert.equal(view.position !== null, testCase.retained, testCase.label);
    assert.equal(view.freshness, testCase.expected, testCase.label);
    // `ageSeconds` is a floored display value and must NOT be used to re-derive
    // the verdict: at 600.001 s it reports 600 while freshness is already STALE.
    // That is precisely why `freshness` is an explicit field.
    assert.notEqual(view.ageSeconds, null, testCase.label);
    // `positioningTier` must not be what communicates staleness, and staleness
    // must not silently change eligibility.
    assert.equal(view.positioningTier, "EVENT_PARTICIPANT", testCase.label);
    assert.equal(view.availableForResponse, true, testCase.label);
  }
});

test("no position at all is UNAVAILABLE, never FRESH or STALE", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config, undefined, () => new Date(T0));
  const result = await service.bootstrap({
    deviceInstanceId: uuid(901), deviceKind: "IPHONE", companionPairId: uuid(902),
    agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
        kind: kind as "PATIENT", version: "2.0", acceptedAt: BASE_TIME
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, "iphone:no-position");
  const principal = service.authenticateToken(result.sessionToken);
  const view = await service.getPresence(principal as never);
  assert.equal(view.position, null);
  assert.equal(view.freshness, "UNAVAILABLE");
  assert.equal(view.ageSeconds, null);
});

test("an uninterpretable timestamp is UNAVAILABLE even though the coordinate is retained", async () => {
  const world = await activeParticipantWorld();
  // Force the pathological sample directly into storage: the public API validates
  // timestamps, so this state can only arrive from legacy or corrupt data.
  await world.store.transact(state => {
    const device = state.devices[uuid(803)];
    assert.ok(device?.latestPosition);
    device.latestPosition.observedAt = "not-a-date";
  });
  world.setNow(T0 + 30_000);
  const view = await world.service.getPresence(world.responder as never);
  assert.equal(view.freshness, "UNAVAILABLE",
    "an unplaceable sample must never be presented as fresh or as a known-age last position");
  assert.equal(view.ageSeconds, null);
  assert.ok(view.position, "the raw coordinate is retained rather than discarded");
});

test("ageSeconds is a display value and freshness is the authority", async () => {
  const world = await activeParticipantWorld();
  // 600.001 s: the verdict flips on milliseconds, but the whole-second display
  // value is still 600.  A client that computed `ageSeconds > 600 ? STALE : FRESH`
  // would disagree with the server here, which is why the verdict is explicit.
  world.setNow(T0 + 600_001);
  const view = await world.service.getPresence(world.responder as never);
  assert.equal(view.freshness, "STALE");
  assert.equal(view.ageSeconds, 600);
  assert.ok(view.position !== null);
});
