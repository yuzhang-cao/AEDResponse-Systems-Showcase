import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("canonical event resolution has one transaction-owning use-case boundary", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/event-resolution.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async resolveEvent(");
  const end = service.indexOf("listAeds(principal: Principal)", start);
  assert.ok(start >= 0 && end > start);
  const entry = service.slice(start, end);
  assert.match(entry, /runEventResolution\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.match(useCase, /store\.transact\(/);
  assert.match(useCase, /resolutionId was already used with different content/);
  assert.match(useCase, /transitionEventToTerminal/);
  assert.match(useCase, /enqueueTerminalNotifications/);
});

test("false-alarm confirmation uses the same terminal use-case module", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  const useCase = await readFile(
    fileURLToPath(new URL("../../src/event-resolution.ts", import.meta.url)),
    "utf8"
  );
  const start = service.indexOf("async confirmFalseAlarm(");
  const end = service.indexOf("async resolveEvent(", start);
  assert.ok(start >= 0 && end > start);
  const entry = service.slice(start, end);
  assert.match(entry, /runFalseAlarmConfirmation\(/);
  assert.doesNotMatch(entry, /this\.store\.transact\(/);
  assert.match(useCase, /runFalseAlarmConfirmation\(/);
  assert.match(useCase, /reason: "FALSE_ALARM"/);
});
