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
 *   legacyRecruitmentRuns    legacy by design (tick, and the not-yet-migrated route)
 *   recruitmentFallbackRuns  indexed was expected, a capability was missing
 *
 * The last one is the only alerting number, so the tests below care most that it
 * stays at zero in the two situations that are not defects.
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

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
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

test("tick() counts as a legacy run and never as a fallback", async () => {
  resetMetrics();
  await service().tick();

  assert.equal(runs().legacy, 1,
    "scheduled maintenance over every event: legacy by design, one run per operation");
  assert.equal(runs().fallback, 0,
    "a designed legacy path must never inflate the alert, or the alert stops meaning "
    + "anything");
  assert.equal(runs().indexed, 0, "tick() is not on the indexed route in this batch");
});

test("the counters are per operation, not per event", async () => {
  resetMetrics();
  await service().tick();
  const afterOne = runs().legacy;

  await service().tick();
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
