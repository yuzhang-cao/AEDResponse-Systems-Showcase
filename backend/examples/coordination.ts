import assert from "node:assert/strict";
import { DevicePositionIndex } from "../src/device-position-index.js";
import { reconcileWindow } from "../src/position-window.js";
const index = new DevicePositionIndex();
index.upsert("synthetic-responder", 23, 113);
const candidates = index.query(22.99101, 113, 1_000);
assert.ok(candidates.includes("synthetic-responder"));
const start = Date.parse("2026-01-01T00:00:00.000Z");
const outcome = reconcileWindow({
  window: { identity: { eventId: "demo", userId: "demo", deviceInstanceId: "demo", kind: "R" },
    startedAt: new Date(start).toISOString(), endedAt: new Date(start + 3_000).toISOString() },
  evidence: { facts: [{ slotAt: start, status: "FIX" }, { slotAt: start + 2_000, status: "FIX" }], recordCount: 2 },
  withinGrace: false
});
assert.equal(outcome.gaps[0]?.reason, "NEVER_UPLOADED");
console.log(JSON.stringify({ synthetic: true, candidates, reconciliation: outcome }, null, 2));
