import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("status confirmation response has one transaction-owning use-case entry", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const runner = await readFile(
    fileURLToPath(new URL("../../src/status-confirmation.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async respondToStatusConfirmation(");
  const end = service.indexOf("\n  timeline(", start);
  assert.ok(start >= 0 && end > start);
  const adapter = service.slice(start, end);
  assert.match(adapter, /runStatusConfirmationResponse\(/);
  assert.doesNotMatch(adapter, /return this\.store\.transact\(/);
  assert.match(runner, /export async function runStatusConfirmationResponse\(/);
  assert.match(runner, /return dependencies\.store\.transact\(/);
  assert.match(runner, /confirmationId was already answered with different content/);
  assert.match(runner, /Status confirmation response window has closed/);
  assert.match(runner, /export function advanceStatusConfirmation\(/);
  const tickStart = service.indexOf("async tick(): Promise<void>");
  const tickEnd = service.indexOf("\n  replayPendingResponses(", tickStart);
  assert.ok(tickStart >= 0 && tickEnd > tickStart);
  assert.match(service.slice(tickStart, tickEnd), /advanceStatusConfirmation\(/);
  assert.doesNotMatch(service.slice(tickStart, tickEnd), /private advanceStatusConfirmation\(/);
});
