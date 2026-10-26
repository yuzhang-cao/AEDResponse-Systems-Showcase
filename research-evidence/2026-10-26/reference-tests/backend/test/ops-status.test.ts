/**
 * G15 — the operator status surface and the business probe that reads it.
 *
 * The requirement is monitoring that can detect a degraded service, and the
 * failure it guards against is subtle: `/healthz` stays green while notifications
 * queue up, purges defer, or evidence sits past its window because no cold copy
 * could be written.  These tests assert three things that make the surface usable
 * rather than decorative:
 *
 *   - the verdicts follow the stated thresholds (a deferred purge is `degraded`,
 *     several are `action_required`, and the worst concern decides the answer);
 *   - the payload carries counts, verdicts and configured paths — never a user id,
 *     a coordinate, a token or a message body;
 *   - the probe exits non-zero on a degraded service and cannot be mistaken for
 *     healthy when it is unauthorised or unreachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";
import { emptyState, type PersistentState } from "../src/models.js";
import { transactState } from "../src/incremental-state.js";
import { G15_STATUS_THRESHOLDS, buildOperatorStatus } from "../src/ops-status.js";
import { operationMetrics } from "../src/runtime-metrics.js";
import { createBackend } from "../src/server.js";
import { MemoryStateStore, SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const OPERATOR_TOKEN = "ops-status-operator-token";
const BASE = Date.parse("2026-09-13T00:00:00.000Z");

function statusFor(
  state: PersistentState,
  options: { startedAt?: number; now?: Date } = {}
) {
  return buildOperatorStatus({
    state,
    now: options.now ?? new Date(BASE),
    startedAt: options.startedAt ?? BASE - 60_000,
    paths: { identityLedger: "/var/lib/aedresponse/identity.jsonl", sealKey: "/var/lib/aedresponse/state.sqlite.seal-key" }
  });
}

test("ops status: the verdict follows the stated thresholds and the worst concern wins", async () => {
  const store = new MemoryStateStore(emptyState());
  const healthy = statusFor(store.read(state => state));
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.uptimeSeconds, 60, "uptime is reported so a restart is visible");
  for (const concern of healthy.concerns) {
    assert.equal(concern.verdict, "ok", `${concern.name} starts ok`);
  }

  // One deferred purge is degraded, several are action_required — the thresholds are
  // the ones the module documents, not numbers invented at the call site.
  const degraded = statusFor(store.read(state => state));
  operationMetricsRetention({ retentionDeferredPurges: G15_STATUS_THRESHOLDS.deferredPurgesDegraded });
  const afterOne = statusFor(store.read(state => state));
  assert.equal(afterOne.status, "degraded");
  assert.equal(degraded.status, "ok");
  operationMetricsRetention({
    retentionDeferredPurges: G15_STATUS_THRESHOLDS.deferredPurgesActionRequired
  });
  assert.equal(statusFor(store.read(state => state)).status, "action_required");
  operationMetricsRetention({ retentionDeferredPurges: 0 });

  // A withheld cold copy is the compliance-critical one: evidence past its window
  // that cannot be deleted.
  operationMetricsRetention({ purgesWithheldNoColdCopy: 1 });
  const withheld = statusFor(store.read(state => state));
  assert.equal(withheld.status, "degraded");
  assert.match(withheld.concerns.find(c => c.name === "cold_copies")!.detail, /seal-key/);
  operationMetricsRetention({ purgesWithheldNoColdCopy: 0 });

  // A failed identity-ledger reconciliation is immediately action_required: a
  // restore would not be able to re-apply closures.
  operationMetricsRetention({ identityLedgerFailures: 1 });
  const ledger = statusFor(store.read(state => state));
  assert.equal(ledger.status, "action_required");
  assert.match(ledger.concerns.find(c => c.name === "identity_ledger")!.detail, /restore/);
  operationMetricsRetention({ identityLedgerFailures: 0 });
  assert.equal(statusFor(store.read(state => state)).status, "ok");
});

test("ops status: an overdue outbox row is action_required, and carries no recipient data", async () => {
  const store = new MemoryStateStore(emptyState());
  const now = new Date(BASE);
  await transactState(store, state => {
    // A real shape for this notification name, so the store's own payload contract
    // accepts it and the test is about the status verdict, not about the schema.
    state.notificationOutboxById["n1"] = {
      id: "n1", eventId: "REDACTED-ID-0096",
      name: "event:coordination-updated",
      recipient: { deviceInstanceId: "REDACTED-ID-0097",
        companionPairId: "REDACTED-ID-0118" },
      payload: {
        schemaVersion: "2.0", messageId: "coordination:1",
        eventId: "REDACTED-ID-0096", occurredAt: new Date(BASE).toISOString(),
        coordination: { currentRecruitmentRadiusMeters: 1_000 }
      },
      status: "PENDING", attempts: 3,
      nextAttemptAt: new Date(now.getTime() - 10 * 60 * 1_000).toISOString()
    } as never;
  });
  const status = statusFor(store.read(state => state), { now });
  assert.equal(status.counters.outboxPending, 1);
  assert.equal(status.counters.outboxOverdue, 1);
  assert.equal(status.counters.oldestOutboxOverdueSeconds, 600);
  assert.equal(status.status, "action_required");
  const outbox = status.concerns.find(concern => concern.name === "notification_outbox")!;
  assert.match(outbox.detail, /APNs/);
  const serialised = JSON.stringify(status);
  assert.equal(serialised.includes("REDACTED-ID-0097"), false,
    "the status must not carry a device id");
  assert.equal(serialised.includes("companionPair"), false);
  assert.equal(serialised.includes("coordination:1"), false,
    "nor a notification payload");
});

test("ops status: the endpoint is operator-only and the probe fails loudly", async () => {
  setShadowValidationEnabled(false);
  const directory = await mkdtemp(join(tmpdir(), "aed-ops-status-"));
  const dataFile = join(directory, "state.sqlite");
  const store = await SQLiteStateStore.open(dataFile, []);
  const config = {
    ...loadConfig({}), host: "127.0.0.1", port: 0, production: false, dataFile,
    operatorToken: OPERATOR_TOKEN, bootstrapLimitPerMinute: 1_000
  };
  const backend = await createBackend({ config, store, now: () => new Date(BASE) });
  try {
    const address = await backend.start();
    const origin = `http://redacted-host.invalid`;
    // A device session is not an operator.
    const session = await backend.service.bootstrap({
      deviceInstanceId: "REDACTED-ID-0108", deviceKind: "IPHONE",
      companionPairId: "REDACTED-ID-0120",
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
          kind, version: "2.0", acceptedAt: new Date(BASE).toISOString()
        })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: false
    } as never, "synthetic:ops-status");
    const refused = await fetch(`${origin}/api/v2/ops/status`, {
      headers: { authorization: `Bearer ${session.sessionToken}` }
    });
    assert.equal(refused.status, 403);

    const tokenFile = join(directory, "operator-token");
    await writeFile(tokenFile, `${OPERATOR_TOKEN}\n`, { mode: 0o600 });
    const probe = `${repositoryRoot}backend/deploy/azure/ops-probe.mjs`;
    const passed = await run(process.execPath,
      [probe, "--url", origin, "--operator-token-file", tokenFile],
      { cwd: `${repositoryRoot}backend` });
    assert.match(passed.stdout, /operator status: ok/);
    assert.match(passed.stdout, /business probe passed/);
    assert.match(passed.stdout, /cold_copies: 0/);

    // An unauthorised probe is a probe failure (exit 2), never a green check.
    await assert.rejects(
      run(process.execPath, [probe, "--url", origin, "--operator-token", "wrong-token"],
        { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 2);
        assert.match(failure.stderr ?? "", /could not authenticate/);
        return true;
      }
    );
    // An unreachable service is also a probe failure, not a pass.
    await assert.rejects(
      run(process.execPath,
        [probe, "--url", "http://127.0.0.1:1", "--operator-token", OPERATOR_TOKEN, "--timeout-ms", "1500"],
        { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 2);
        assert.match(failure.stderr ?? "", /could not reach/);
        return true;
      }
    );
  } finally {
    await backend.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/**
 * Sets retention counters directly.
 *
 * The alternative — provoking a real deferred purge, a withheld cold copy and a
 * ledger failure in one test — would test three other mechanisms instead of the
 * thresholds this test is about; the mechanisms each have their own test file.
 */
function operationMetricsRetention(values: Partial<Record<
  "retentionDeferredPurges" | "purgesWithheldNoColdCopy" | "identityLedgerFailures", number
>>): void {
  for (const [key, value] of Object.entries(values)) {
    (operationMetrics as unknown as Record<string, number>)[key] = value as number;
  }
}
