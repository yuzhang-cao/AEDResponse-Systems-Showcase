/**
 * Freshness boundary (Phase 1 item #10, migration step ③/④/⑥).
 *
 * Replacing a whole-device scan with an expiry index must not move the boundary
 * at which a position stops being valid.  These tests pin the exact semantics of
 * the original prune expression:
 *
 *   Number.isFinite(Date.parse(observedAt))
 *     && Math.max(0, now - observedAt) > maxAgeSeconds * 1000
 *
 * Note `>` rather than `>=`, the `Math.max(0, …)` clamp, and the "unparseable
 * means not expired" guard — each of them is easy to change by accident while
 * "tidying up", and each of them is observable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isPositionExpired, positionAgeMs } from "../src/service.js";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const MAX_AGE = 600;

/** The original inline expression, kept verbatim as the reference definition. */
function legacyExpired(observedAt: string, nowMs: number, maxAgeSeconds: number): boolean {
  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed)
    && Math.max(0, nowMs - parsed) > maxAgeSeconds * 1_000;
}

test("the exact boundary is exclusive: exactly 600 s is still valid", () => {
  const observedAt = iso(T0);
  // Documented cases from the audit.
  assert.equal(isPositionExpired(observedAt, new Date(T0 + 9 * 60_000 + 59_000), MAX_AGE), false);
  assert.equal(isPositionExpired(observedAt, new Date(T0 + 600_000), MAX_AGE), false,
    "600.000 s exactly must NOT expire (the comparison is >, not >=)");
  assert.equal(isPositionExpired(observedAt, new Date(T0 + 600_001), MAX_AGE), true,
    "600.001 s must expire");
  assert.equal(isPositionExpired(observedAt, new Date(T0 + 1_200_000), MAX_AGE), true);
});

test("future and unparseable timestamps keep their original treatment", () => {
  const observedAt = iso(T0);
  // A client clock ahead of the server yields age 0 via the Math.max clamp.
  assert.equal(positionAgeMs(observedAt, new Date(T0 - 3_600_000)), 0);
  assert.equal(isPositionExpired(observedAt, new Date(T0 - 3_600_000), MAX_AGE), false,
    "a future sample never expires");
  // Unparseable / absent timestamps were skipped by the original guard.
  assert.equal(isPositionExpired("not-a-date", new Date(T0 + 1e9), MAX_AGE), false);
  assert.equal(isPositionExpired(undefined, new Date(T0 + 1e9), MAX_AGE), false);
  assert.equal(positionAgeMs(undefined, new Date(T0)), null);
});

test("the shared predicate agrees with the original expression over a wide sweep", () => {
  const offsets = [
    -86_400_000, -3_600_000, -1_000, -1, 0, 1, 599_999, 600_000, 600_001,
    601_000, 1_200_000, 86_400_000, 86_400_000_000
  ];
  const nowOffsets = [-1_000_000, -1, 0, 1, 599_999, 600_000, 600_001, 86_400_000_000];
  let compared = 0;
  for (const observedOffset of offsets) {
    for (const nowOffset of nowOffsets) {
      const observedAt = iso(T0 + observedOffset);
      const now = new Date(T0 + nowOffset);
      assert.equal(
        isPositionExpired(observedAt, now, MAX_AGE),
        legacyExpired(observedAt, now.getTime(), MAX_AGE),
        `disagreement at observed=${observedAt} now=${now.toISOString()}`
      );
      compared += 1;
    }
  }
  assert.ok(compared >= 100, `expected a meaningful sweep, compared ${compared}`);
});

test("a different maxAge moves the boundary consistently", () => {
  const observedAt = iso(T0);
  for (const maxAge of [1, 15, 120, 600, 900]) {
    assert.equal(isPositionExpired(observedAt, new Date(T0 + maxAge * 1_000), maxAge), false);
    assert.equal(isPositionExpired(observedAt, new Date(T0 + maxAge * 1_000 + 1), maxAge), true);
  }
});
