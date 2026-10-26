import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("patient route refreshes persist assignment emissions before transport publication", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const publishStart = service.indexOf("private async publishPatientPositionChange(");
  const publishEnd = service.indexOf("private coordinationSummary(", publishStart);
  const refreshStart = service.indexOf("private refreshPatientRoutes(");
  const refreshEnd = service.indexOf("private createDeliveryIfEligible(", refreshStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.doesNotMatch(service.slice(publishStart, publishEnd), /publishAssignmentEmissions\(/);
  assert.match(service.slice(refreshStart, refreshEnd), /enqueueAssignmentEmissions\(/);
});
