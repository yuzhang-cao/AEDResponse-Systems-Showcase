/**
 * Expiry index for standby positions (Phase 1 item #10).
 *
 * The point of the index is that a sweep must be proportional to the number of
 * devices that actually expired, not to fleet size.  These tests cover the heap
 * mechanics, the stale-entry discard that keeps the heap bounded, and the
 * end-to-end reclamation path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PositionExpiryIndex } from "../src/position-expiry-index.js";

const TTL = 600_000;
const T0 = Date.UTC(2026, 0, 1);

function device(observedAtMs: number): { latestPosition: { observedAt: string } } {
  return { latestPosition: { observedAt: new Date(observedAtMs).toISOString() } };
}

test("popDue returns only devices whose expiry has passed, in expiry order", () => {
  const index = new PositionExpiryIndex(TTL);
  index.upsert("late", T0 + 300_000 + TTL);
  index.upsert("early", T0 + TTL);
  index.upsert("middle", T0 + 120_000 + TTL);

  assert.deepEqual(index.popDue(T0 + TTL - 1, 10).map(e => e.deviceInstanceId), []);
  assert.deepEqual(index.popDue(T0 + TTL, 10).map(e => e.deviceInstanceId), ["early"]);
  assert.deepEqual(index.popDue(T0 + 200_000 + TTL, 10).map(e => e.deviceInstanceId), ["middle"]);
  assert.deepEqual(index.popDue(T0 + 10_000_000, 10).map(e => e.deviceInstanceId), ["late"]);
});

test("a superseded entry is discarded rather than reported as due", () => {
  const index = new PositionExpiryIndex(TTL);
  // First write expires at T0+TTL; a refresh pushes it TTL later.
  index.upsert("device", T0 + TTL);
  index.upsert("device", T0 + 60_000 + TTL);

  // At the first expiry the device is still fresh, so nothing may be reclaimed.
  assert.deepEqual(index.popDue(T0 + TTL, 10), []);
  // The refreshed deadline is the one that matters.
  assert.deepEqual(index.popDue(T0 + 60_000 + TTL, 10).map(e => e.deviceInstanceId), ["device"]);
});

test("the heap stays bounded while a device keeps uploading", () => {
  const index = new PositionExpiryIndex(TTL);
  // 500 refreshes at the standby cadence (120 s apart) — the case that would grow
  // an index without stale-entry discard.
  for (let step = 0; step < 500; step += 1) {
    index.upsert("device", T0 + step * 120_000 + TTL);
  }
  assert.equal(index.size, 1, "one tracked device");
  // Each sweep discards superseded entries as they surface, so the heap tracks the
  // number of devices holding a position, not the number of uploads.
  let swept = 0;
  for (let step = 1; step <= 500; step += 1) {
    swept += index.popDue(T0 + step * 120_000, 100).length;
  }
  assert.equal(swept, 0, "no false reclamation while the device keeps reporting");
  // Bound: an entry survives only until its own deadline surfaces, so a device
  // holds at most ceil(TTL / uploadInterval) + 1 entries at once — 6 at the
  // standby cadence (600 s / 120 s) — no matter how long it keeps uploading.
  const expectedBound = Math.ceil(TTL / 120_000) + 1;
  assert.ok(index.heapSize <= expectedBound,
    `heap must be bounded by TTL/interval, got ${index.heapSize} > ${expectedBound}`);
  assert.ok(index.heapSize < 500, "and far below the number of uploads");
});

test("removal and rebuild keep the index consistent with committed devices", () => {
  const index = new PositionExpiryIndex(TTL);
  index.upsert("a", T0 + TTL);
  index.remove("a");
  assert.deepEqual(index.popDue(T0 + TTL, 10), [], "a removed device is never reported");

  index.rebuild({
    fresh: device(T0),
    stale: device(T0 - 2 * TTL),
    none: {} as never
  });
  assert.equal(index.size, 2, "only devices holding a position are tracked");
  assert.deepEqual(
    index.popDue(T0 - TTL, 10).map(e => e.deviceInstanceId),
    ["stale"]
  );
});

test("applyDeviceChanges maintains only the changed devices", () => {
  const index = new PositionExpiryIndex(TTL);
  index.rebuild({ a: device(T0), b: device(T0) });

  // Position removed from a device: it must leave the index.
  index.applyDeviceChanges([{ key: "a", after: { deviceInstanceId: "a" } }]);
  assert.equal(index.size, 1);

  // Position refreshed on b: the deadline moves.
  index.applyDeviceChanges([{ key: "b", after: device(T0 + 300_000) }]);
  assert.deepEqual(index.popDue(T0 + TTL, 10), [], "b is no longer due");
  assert.deepEqual(
    index.popDue(T0 + 300_000 + TTL, 10).map(e => e.deviceInstanceId),
    ["b"]
  );

  // Deleted device.
  index.applyDeviceChanges([{ key: "b", after: undefined }]);
  assert.equal(index.size, 0);
});
