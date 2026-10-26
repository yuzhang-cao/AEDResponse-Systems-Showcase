import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("response decisions have one transaction-owning use-case boundary", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/response-decision.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async respond(");
  const end = service.indexOf("async updateAssignmentStatus(", start);
  assert.ok(start >= 0 && end > start, "canonical respond entry must remain present");
  const entry = service.slice(start, end);

  assert.match(entry, /runResponseDecision\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.match(useCase, /store\.transact\(/);
  assert.match(useCase, /decisionFingerprint/);
  assert.match(useCase, /ensureParticipantInterval/);
  assert.match(useCase, /replanAssignments/);
  assert.match(useCase, /enqueueDecisionNotification/);
  assert.match(useCase, /enqueueAssignmentEmissions/);
  assert.doesNotMatch(entry, /emitToDevices\([^\n]*response:decision-recorded/);
  assert.doesNotMatch(entry, /publishAssignmentEmissions\(/);
});
