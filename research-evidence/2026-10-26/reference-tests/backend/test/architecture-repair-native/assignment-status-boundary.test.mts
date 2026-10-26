import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("ordinary assignment status updates have one transaction-owning use-case boundary", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/assignment-status.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async updateAssignmentStatus(");
  const end = service.indexOf("async acquireAed(", start);
  assert.ok(start >= 0 && end > start, "canonical assignment entry must remain present");
  const entry = service.slice(start, end);

  assert.match(entry, /runAssignmentStatusUpdate\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.match(useCase, /transactState\(dependencies\.store,/);
  assert.match(useCase, /assignmentTransitionAllowed/);
  assert.match(useCase, /dedicated server action/);
  assert.match(useCase, /allCurrentAssignmentsCompleted/);
  assert.match(useCase, /enqueueAssignmentNotification/);
  assert.doesNotMatch(entry, /emitToDevices\([^\n]*assignment:updated/);
});
