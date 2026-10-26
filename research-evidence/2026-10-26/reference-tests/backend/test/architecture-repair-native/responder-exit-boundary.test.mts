import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("responder exits have one transaction-owning use-case boundary", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/responder-exit.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async exitEvent(");
  const end = service.indexOf("async confirmFalseAlarm(", start);
  assert.ok(start >= 0 && end > start, "canonical exit entry must remain present");
  const entry = service.slice(start, end);

  assert.match(entry, /runResponderExit\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.doesNotMatch(entry, /publishAssignmentEmissions\(/);
  assert.match(useCase, /transactState\(dependencies\.store,/);
  assert.match(useCase, /enqueueAssignmentEmissions/);
  assert.match(useCase, /exitFingerprint/);
  assert.match(useCase, /soleResponderConfirmationRequired/);
  assert.match(useCase, /aedAcquiredReceipt/);
});
