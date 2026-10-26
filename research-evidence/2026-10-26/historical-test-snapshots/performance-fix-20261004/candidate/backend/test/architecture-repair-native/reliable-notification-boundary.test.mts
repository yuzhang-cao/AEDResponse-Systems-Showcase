import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("business notification paths persist before transport publication", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const outbox = await readFile(
    fileURLToPath(new URL("../../src/notification-outbox.ts", import.meta.url)),
    "utf8"
  );
  const sourcePaths = [
    ["async reportWatchObservation(", "getWatchEventState("],
    ["async updateWatchFallbackPatientPosition(", "/**\n   * Durable scheduler hook"],
    ["async acquireAed(", "async reportAedUnavailable("],
    ["async reportAedUnavailable(", "/** Canonical patient end action"],
    ["async exitEvent(", "async confirmFalseAlarm("],
    ["private async publishPatientPositionChange(", "private coordinationSummary("]
  ] as const;
  for (const [startMarker, endMarker] of sourcePaths) {
    const start = service.indexOf(startMarker);
    const end = service.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} boundary must remain present`);
    const entry = service.slice(start, end);
    assert.doesNotMatch(entry, /emitToDevices\(/, `${startMarker} must not publish directly`);
  }
  const recruitment = service.slice(
    service.indexOf("private refreshRecruitmentForEvent("),
    service.indexOf("private advanceRecruitmentStage(")
  );
  assert.match(recruitment, /response-offer-expired/);
  assert.match(service, /enqueuePatientPositionNotification\(/);
  assert.match(service, /enqueueCoordinationNotifications\(/);
  assert.match(outbox, /response:requested/);
  assert.match(outbox, /event:status-confirmation-requested/);
  assert.match(outbox, /aed:acquired/);
  assert.match(outbox, /aed:unavailable/);
  assert.match(outbox, /device\.companionPairId/);
});
