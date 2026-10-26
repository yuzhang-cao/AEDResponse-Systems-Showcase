import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { HttpProblem } from "../src/errors.js";
import { emptyState } from "../src/models.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore, SQLiteStateStore } from "../src/store.js";

const now = new Date("2026-09-08T05:00:00.000Z");
const config = { ...loadConfig({}, "/tmp"), authSubjectPepper: "controlled-test-only-pepper",
  enableControlledTestAccounts: true };
const rejection = (status: number) => (error: unknown) => error instanceof HttpProblem && error.status === status;

test("controlled provisioning is disabled by default and never issues operator scope", async () => {
  const store = new MemoryStateStore(emptyState());
  const disabled = new AEDResponseService(store, { ...config, enableControlledTestAccounts: false }, undefined, () => now);
  await assert.rejects(disabled.provisionControlledTestAccount("iphone17pro"), rejection(403));
  assert.equal(Object.keys(store.read(s => s.accounts)).length, 0);
  const enabled = new AEDResponseService(store, config, undefined, () => now);
  const session = await enabled.provisionControlledTestAccount("iphone17pro");
  assert.equal(session.provider, "CONTROLLED_TEST");
  assert.deepEqual(session.scopes, ["session:bootstrap"]);
  assert.equal(enabled.authenticateToken(session.sessionToken).kind, "ACCOUNT");
  assert.throws(() => disabled.authenticateToken(session.sessionToken), rejection(401));
  await assert.rejects(disabled.refreshAccountSession(session.refreshToken), rejection(401));
});

test("controlled account uses normal consent, session, R validation and persistence", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config, undefined, () => now);
  const account = await service.provisionControlledTestAccount("iphone17pro");
  const principal = service.authenticateToken(account.sessionToken);
  const request = {
    deviceInstanceId: "REDACTED-SUPPLEMENT-ID-46de918f5446",
    companionPairId: "REDACTED-SUPPLEMENT-ID-7f1a10d9cd75",
    deviceKind: "IPHONE" as const,
    agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
      kind: kind as "PATIENT" | "VOLUNTEER_RESPONDER" | "PRIVACY_POLICY" | "SENSITIVE_PERSONAL_INFORMATION",
      version: "2.0", acceptedAt: now.toISOString()
    })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  };
  await assert.rejects(service.bootstrap(principal, { ...request, agreementAcceptances: [] }, "test"));
  const bound = await service.bootstrap(principal, request, "test");
  const device = service.authenticateToken(bound.sessionToken);
  const update = {
    positionUpdateId: "REDACTED-SUPPLEMENT-ID-97fdd5e0b0f0", observedAt: now.toISOString(),
    responderPosition: { kind: "R" as const, latitude: 22, longitude: 113, accuracyMeters: 10 }
  };
  const receipt = await service.updateResponderPosition(device, update);
  assert.equal(receipt.applied, true);
  assert.equal((await service.updateResponderPosition(device, update)).idempotent, true);
  assert.deepEqual(store.read(s => s.devices[request.deviceInstanceId]?.latestPosition?.position), update.responderPosition);
  const disabled = new AEDResponseService(store, { ...config, enableControlledTestAccounts: false }, undefined, () => now);
  assert.throws(() => disabled.authenticateToken(bound.sessionToken), rejection(401));
  const replacement = await service.provisionControlledTestAccount("iphone17pro");
  assert.equal(replacement.userId, account.userId);
  assert.throws(() => service.authenticateToken(account.sessionToken), rejection(401));
  assert.throws(() => service.authenticateToken(bound.sessionToken), rejection(401));
  assert.deepEqual(store.read(s => s.devices[request.deviceInstanceId]?.latestPosition?.position), update.responderPosition);
});

test("controlled identities and refresh rotation survive normal SQLite reopen", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aed-controlled-account-"));
  let store: SQLiteStateStore | undefined;
  t.after(async () => { await store?.close(); await rm(dir, { recursive: true, force: true }); });
  store = await SQLiteStateStore.open(join(dir, "state.sqlite"), []);
  const service = new AEDResponseService(store, config, undefined, () => now);
  const session = await service.provisionControlledTestAccount("iphone17pro");
  const stored = JSON.stringify(store.read(s => s));
  assert.equal(stored.includes(session.sessionToken), false);
  assert.equal(stored.includes(session.refreshToken), false);
  await store.close();
  store = await SQLiteStateStore.open(join(dir, "state.sqlite"), []);
  const reopened = new AEDResponseService(store, config, undefined, () => now);
  const rotated = await reopened.refreshAccountSession(session.refreshToken);
  assert.equal(rotated.provider, "CONTROLLED_TEST");
  assert.equal(rotated.userId, session.userId);
  await assert.rejects(reopened.refreshAccountSession(session.refreshToken), rejection(401));
  assert.throws(() => reopened.authenticateToken(rotated.sessionToken), rejection(401));
});

test("controlled test switch requires an explicit boolean string", () => {
  assert.equal(loadConfig({}).enableControlledTestAccounts, false);
  assert.equal(loadConfig({ AED_ENABLE_CONTROLLED_TEST_ACCOUNTS: "true" }).enableControlledTestAccounts, true);
  assert.throws(() => loadConfig({ AED_ENABLE_CONTROLLED_TEST_ACCOUNTS: "yes" }));
});
