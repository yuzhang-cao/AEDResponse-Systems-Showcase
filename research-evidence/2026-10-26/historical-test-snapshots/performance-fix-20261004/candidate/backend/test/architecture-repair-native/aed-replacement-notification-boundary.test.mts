import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("AED replacement assignment is enqueued before transport publication", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async reportAedUnavailable(");
  const end = service.indexOf("/** Canonical patient end action", start);
  assert.ok(start >= 0 && end > start);
  const entry = service.slice(start, end);
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/aed-actions.ts", import.meta.url)),
    "utf8"
  );
  assert.match(entry, /runReportAedUnavailable\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.match(entry, /enqueueAssignmentEmissions/);
  assert.doesNotMatch(entry, /emitToDevices\(\[result\.replacement\.deviceInstanceId\]/);
  assert.match(useCase, /runReportAedUnavailable\(/);
  assert.match(useCase, /store\.transact\(/);
  assert.match(useCase, /AED_UNAVAILABLE/);
  assert.match(useCase, /enqueueAssignmentEmissions/);
});

test("AED acquisition has a separate transaction-owning use-case boundary", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/aed-actions.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async acquireAed(");
  const end = service.indexOf("async reportAedUnavailable(", start);
  assert.ok(start >= 0 && end > start);
  const entry = service.slice(start, end);
  assert.match(entry, /runAcquireAed\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.match(useCase, /runAcquireAed\(/);
  assert.match(useCase, /store\.transact\(/);
  assert.match(useCase, /receiptId was already used with different content/);
  assert.match(useCase, /This AED was already acquired for the event/);
});
