/**
 * G12 — operator authority is not business authority, and vice versa.
 *
 * The requirement separates administration from business operation.  That is easy
 * to write in a document and easy to lose in code: the moment one credential is
 * accepted in two places, "the operator cannot read a patient" stops being true
 * and nobody notices, because every individual route still looks guarded.
 *
 * These tests drive the real HTTP surface with each credential kind and assert
 * the refusals, including the two that matter most:
 *
 *   - the operator credential is not a business session, so it cannot act as a
 *     patient or responder;
 *   - a business session is not an operator, so it cannot issue a legal hold,
 *     read the audit trail, or approve a self-access request.
 *
 * The administrative simulation surface is not HTTP at all: it is a private unix
 * socket in a directory no other user can enter (covered by `simulation.test.ts`
 * and `config.test.ts`), which is why no test here can reach it over the network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBackend } from "../src/server.js";
import { SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";

const BASE = Date.parse("2026-09-13T00:00:00.000Z");
const at = (seconds: number): string => new Date(BASE + seconds * 1_000).toISOString();
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const OPERATOR_TOKEN = "privilege-separation-operator-token";

test("privilege separation: an operator credential cannot act as a business participant", async () => {
  setShadowValidationEnabled(false);
  const directory = await mkdtemp(join(tmpdir(), "aed-privilege-"));
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
    const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` };

    // The business surface refuses the operator credential outright.
    for (const path of [
      "/api/v2/events",
      "/api/v2/me/presence",
      "/api/v2/me/nearby-volunteers",
      `/api/v2/events/${uuid(500)}`
    ]) {
      const response = await fetch(`${origin}${path}`, { headers: operatorHeaders });
      assert.equal(response.status, 403, `the operator credential reached ${path}`);
    }
    // It cannot bootstrap a device session either: that is an account act.
    const bootstrap = await fetch(`${origin}/api/v2/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operatorHeaders },
      body: JSON.stringify({ deviceInstanceId: uuid(2), deviceKind: "IPHONE", companionPairId: uuid(1) })
    });
    assert.ok(bootstrap.status === 400 || bootstrap.status === 403,
      `operator bootstrap must not succeed (got ${bootstrap.status})`);

    // And the OPS surface refuses a real business session.
    const session = await backend.service.bootstrap({
      deviceInstanceId: uuid(2),
      deviceKind: "IPHONE",
      companionPairId: uuid(1),
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({ kind, version: "2.0", acceptedAt: at(0) })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: false
    } as never, "synthetic:privilege");
    const deviceHeaders = { authorization: `Bearer ${session.sessionToken}` };
    for (const [method, path, body] of [
      ["GET", "/api/v2/ops/access-audit", undefined],
      ["GET", "/api/v2/ops/self-access-requests", undefined],
      ["GET", `/api/v2/ops/events/${uuid(500)}/precise-patient-position?reason=curiosity`, undefined],
      ["POST", "/api/v2/ops/break-glass", JSON.stringify({
        eventId: uuid(500), reason: "let me look", minutes: 30
      })],
      ["POST", "/api/v2/ops/self-access-requests/" + uuid(900) + "/decision", JSON.stringify({
        approve: true, reason: "rubber stamp"
      })]
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { ...deviceHeaders, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body } : {})
      });
      assert.equal(response.status, 403, `a device session reached ${method} ${path}`);
    }
    // An unauthenticated caller gets the same refusal, and never a hint that the
    // route exists for someone else.
    const anonymous = await fetch(`${origin}/api/v2/ops/access-audit`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.text()).includes(OPERATOR_TOKEN), false);
  } finally {
    await backend.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
