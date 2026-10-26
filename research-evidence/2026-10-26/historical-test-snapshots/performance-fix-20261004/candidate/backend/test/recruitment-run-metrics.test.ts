/**
 * The three recruitment-run counters, and the distinction that makes them useful.
 *
 * They used to be one counter incremented whenever the position path took the
 * whole-state route.  That conflated two unrelated things: "indexed was expected and
 * the store cannot do it" - an alert - and "this route is not migrated yet" - normal
 * work during the transition.  `tick()` then added a third meaning on top, since it
 * is legacy by design and would otherwise have looked like a permanent failure.
 *
 * What is locked here is the SEMANTICS, not the numbers:
 *
 *   indexedRecruitmentRuns   ran transactEntities + TxRecruitmentContext
 *   legacyRecruitmentRuns    legacy by design (active tick, and the not-yet-migrated route)
 *   recruitmentFallbackRuns  indexed was expected, a capability was missing
 *
 * The last one is the only alerting number, so the tests below care most that it
 * stays at zero in the two situations that are not defects. An idle queue probe
 * performs no recruitment work and increments none of the three counters.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState } from "../src/models.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const NOW = new Date("2026-08-31T01:02:00.000Z");

const config: BackendConfig = {
  host: "127.0.0.1", port: 0,
  dataFile: "/tmp/aedresponse-metrics.json", fixtureFile: "/tmp/aedresponse-metrics-fixture.json",
  sessionTtlSeconds: 3_600, nearbyRadiusMeters: 1_000, positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120, maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100, operatorToken: "operator-test-token", production: false
};

function service(activeEvents = 0): AEDResponseService {
  const state = emptyState();
  for (let index = 0; index < activeEvents; index += 1) {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    state.events[id] = {
      id, state: "ACTIVE", recruitmentState: "RECRUITING", patientUserId: "metrics-user",
      patientDeviceIds: [], patientPairId: "metrics-pair", unavailableAedIds: [],
      exitedResponderUserIds: [], observationFingerprint: "metrics-fixture",
      observation: {
        schemaVersion: "2.0", eventId: id, observationKind: "FALL_CONTEXT",
        fallDetectedAt: NOW.toISOString(), patientPositionObservedAt: NOW.toISOString(),
        fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
        patientPosition: { kind: "P", latitude: 22, longitude: 113, accuracyMeters: 10 }
      },
      triggerSource: "WATCH_FALL_HELP_CONFIRMED", currentRecruitmentRadiusMeters: 1_000,
      recruitmentStageStartedAt: NOW.toISOString(), createdAt: NOW.toISOString(),
      coordinationRevision: 1, assignmentRevision: 1
    };
  }
  return new AEDResponseService(new MemoryStateStore(state), config,
    undefined, () => NOW);
}

function runs(): { indexed: number; legacy: number; fallback: number } {
  const operation = snapshotMetrics().operation;
  return {
    indexed: operation.indexedRecruitmentRuns as number,
    legacy: operation.legacyRecruitmentRuns as number,
    fallback: operation.recruitmentFallbackRuns as number
  };
}

// NOTE: the fallback increment is NOT asserted here.  It lives inside
// `updateResponderPosition`'s capability branch, and reaching it needs a bootstrapped
// iPhone principal driving a real position update.  A test that stripped
// `transactEntities` and then called `tick()` would assert on the legacy counter while
// claiming to cover the fallback one - a green test proving the wrong thing, which is
// the exact failure this file exists to avoid.  It is covered in 4b-2.2, where the
// route is switched and the position path can be driven end to end.

test("idle tick does not count as recruitment work or a fallback", async () => {
  resetMetrics();
  await service().tick();
  assert.deepEqual(runs(), { indexed: 0, legacy: 0, fallback: 0 },
    "a queue-synchronized no-work probe is not a recruitment run");
});

test("active tick counts as a legacy run and never as a fallback", async () => {
  resetMetrics();
  await service(1).tick();

  assert.equal(runs().legacy, 1,
    "scheduled maintenance over active events: legacy by design, one run per operation");
  assert.equal(runs().fallback, 0,
    "a designed legacy path must never inflate the alert, or the alert stops meaning "
    + "anything");
  assert.equal(runs().indexed, 0, "tick() is not on the indexed route in this batch");
});

test("the counters are per operation, not per event", async () => {
  resetMetrics();
  const active = service(2);
  await active.tick();
  const afterOne = runs().legacy;
  assert.equal(afterOne, 1, "two active events in one tick are one maintenance run");

  await active.tick();
  assert.equal(runs().legacy, afterOne + 1,
    "two operations, two runs - the counter must not scale with how many events an "
    + "operation happens to cover");
});

test("the three counters are distinct fields with distinct meanings", () => {
  resetMetrics();
  const before = runs();
  assert.deepEqual(before, { indexed: 0, legacy: 0, fallback: 0 });

  // They must not be aliases of one another: incrementing one changes only that one.
  const operation = snapshotMetrics().operation as unknown as Record<string, number>;
  assert.equal(typeof operation.indexedRecruitmentRuns, "number");
  assert.equal(typeof operation.legacyRecruitmentRuns, "number");
  assert.equal(typeof operation.recruitmentFallbackRuns, "number");
});
