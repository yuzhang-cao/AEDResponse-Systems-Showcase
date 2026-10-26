import type { StateReadView } from "../src/state-read.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import {
  DeterministicPhoneChallengeProvider,
  normalizePhoneNumber,
  type AppleIdentityTokenVerificationRequest,
  type AppleIdentityTokenVerifier
} from "../src/auth.js";
import { HttpProblem } from "../src/errors.js";
import { emptyState } from "../src/models.js";
import { tokenHash } from "../src/domain.js";
import { AEDResponseService } from "../src/service.js";
import { createBackend } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";
import { SessionConnections } from "../src/realtime-access.js";
import type { PersistentState } from "../src/models.js";

class FailingCommitStore extends MemoryStateStore {
  failCommit = false;
  failRead = false;
  failLegacyReadOnly = false;

  override read<T>(reader: (state: Readonly<PersistentState>) => T): T {
    if (this.failRead) throw new Error("injected read failure");
    if (this.failLegacyReadOnly) throw new Error("legacy full-state read was used");
    return super.read(reader);
  }

  override readEntities<T>(reader: (view: StateReadView) => T): T {
    if (this.failRead) throw new Error("injected read failure");
    return super.readEntities(reader);
  }

  override transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    return super.transact(async draft => {
      const result = await mutation(draft);
      if (this.failCommit) throw new Error("injected commit failure");
      return result;
    });
  }
}

async function authenticatedConnectionHarness() {
  let now = new Date("2026-09-09T00:00:00Z");
  const store = new FailingCommitStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, () => now,
    { apple: new TestAppleVerifier() });
  const account = await service.signInWithApple({ identityToken: "valid:connection-test", nonce: "nonce" });
  const session = await service.bootstrap(service.authenticateToken(account.sessionToken), {
    deviceInstanceId: "REDACTED-ID-b46fc842c7b615e0",
    companionPairId: "REDACTED-ID-6afb4555166e4b21",
    deviceKind: "IPHONE",
    agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"] as const).map(kind => ({
        kind, version: "2.0", acceptedAt: now.toISOString()
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, "connection-test");
  const principal = service.authenticateToken(session.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Expected device session");
  return { store, service, session, principal, account, expire: () => { now = new Date(principal.expiresAt); } };
}

test("publication revalidates committed access even without a logout notification", async t => {
  for (const invalidation of ["revocation", "expiry", "scope", "rebinding"] as const) {
    await t.test(invalidation, async () => {
      const h = await authenticatedConnectionHarness();
      const connections = new SessionConnections(h.service.identityAccess);
      let disconnected = 0;
      const sent: string[] = [];
      connections.register("old-connection", h.principal, () => { disconnected++; });
      connections.sendToDevices([h.principal.deviceInstanceId], id => { sent.push(id); return true; });
      assert.deepEqual(sent, ["old-connection"]);
      sent.length = 0;
      if (invalidation === "expiry") h.expire();
      else await h.store.transact(state => {
        if (invalidation === "revocation") {
          state.sessionsByTokenHash[h.principal.tokenHash]!.revokedAt = "2026-09-09T00:00:01Z";
        } else if (invalidation === "scope") {
          state.sessionsByTokenHash[h.principal.tokenHash]!.scopes = [];
        } else {
          state.devices[h.principal.deviceInstanceId]!.companionPairId =
            "REDACTED-ID-7d5dcbec130f7092";
        }
      });
      assert.equal(disconnected, 0);
      connections.sendToDevices([h.principal.deviceInstanceId], id => { sent.push(id); return true; });
      assert.deepEqual(sent, []);
      assert.equal(disconnected, 1);
      connections.close();
    });
  }
});

test("failed revocation commit leaves session and its connection authorized", async () => {
  const h = await authenticatedConnectionHarness();
  const connections = new SessionConnections(h.service.identityAccess);
  let disconnected = false;
  connections.register("connection", h.principal, () => { disconnected = true; });
  h.store.failCommit = true;
  await assert.rejects(h.service.logout(h.principal), /injected commit failure/);
  assert.equal(disconnected, false);
  assert.equal(h.service.authenticateToken(h.session.sessionToken).kind, "DEVICE");
  assert.equal(connections.isAuthorized("connection"), true);
  assert.equal(h.store.read(state => state.sessionsByTokenHash[h.principal.tokenHash]?.revokedAt), undefined);
  connections.close();
});

test("a fresh connection sharing a token cannot authorize the old binding's connection", async () => {
  const h = await authenticatedConnectionHarness();
  const connections = new SessionConnections(h.service.identityAccess);
  const disconnected: string[] = [];
  connections.register("old", h.principal, () => disconnected.push("old"));
  await h.store.transact(state => {
    state.devices[h.principal.deviceInstanceId]!.companionPairId =
      "REDACTED-ID-7d5dcbec130f7092";
  });
  const fresh = h.service.authenticateToken(h.session.sessionToken);
  if (fresh.kind !== "DEVICE") throw new Error("Expected device");
  connections.register("fresh", fresh, () => disconnected.push("fresh"));
  const sent: string[] = [];
  connections.sendToDevices([h.principal.deviceInstanceId], id => { sent.push(id); return true; });
  assert.deepEqual(sent, ["fresh"]);
  assert.deepEqual(disconnected, ["old"]);
  connections.close();
});

test("post-commit observer failure cannot undo logout or prevent other revocation listeners", async t => {
  const h = await authenticatedConnectionHarness();
  const log = t.mock.method(console, "error", () => {});
  h.service.identityAccess.onRevocation(() => { throw new Error("injected listener failure"); });
  const connections = new SessionConnections(h.service.identityAccess);
  let disconnected = false;
  connections.register("connection", h.principal, () => { disconnected = true; });
  await h.service.logout(h.principal);
  assert.throws(() => h.service.authenticateToken(h.session.sessionToken), /authenticated/);
  assert.equal(disconnected, true);
  assert.equal(log.mock.callCount(), 1);
  connections.close();
});

test("authorization snapshot failure disconnects connections and sends no data", async t => {
  const h = await authenticatedConnectionHarness();
  t.mock.method(console, "error", () => {});
  const connections = new SessionConnections(h.service.identityAccess);
  let disconnected = false;
  connections.register("connection", h.principal, () => { disconnected = true; });
  h.store.failRead = true;
  const sent: string[] = [];
  assert.doesNotThrow(() => connections.sendToDevices([h.principal.deviceInstanceId], id => { sent.push(id); return true; }));
  assert.equal(disconnected, true);
  assert.deepEqual(sent, []);
  connections.close();
});

function config(): BackendConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataFile: "/tmp/aedresponse-auth-test.sqlite",
    fixtureFile: "/tmp/aedresponse-auth-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    authSubjectPepper: "auth-test-pepper",
    watchAppAttestAppId: "TEAMID.com.aedresponse",
    production: false
  };
}

class TestAppleVerifier implements AppleIdentityTokenVerifier {
  async verifyIdentityToken(input: AppleIdentityTokenVerificationRequest): Promise<{ subject: string }> {
    if (!input.identityToken.startsWith("valid:")) throw new Error("invalid token");
    return { subject: input.identityToken.slice("valid:".length) };
  }
}

test("phone normalization is canonical and does not guess arbitrary countries", () => {
  assert.equal(normalizePhoneNumber("+86 138-0013-8000"), "+8613800138000");
  assert.equal(normalizePhoneNumber("0013800138000"), "+13800138000");
  assert.equal(normalizePhoneNumber("13800138000"), "+8613800138000");
  assert.throws(() => normalizePhoneNumber("1380013"), /international|invalid/);
  assert.throws(() => normalizePhoneNumber("+8613800138000000"), /invalid/);
});

test("unconfigured authentication providers fail closed", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config());
  await assert.rejects(
    service.requestPhoneChallenge("+8613800138000"),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 503
      && /PHONE/.test(error.detail)
  );
  await assert.rejects(
    service.signInWithApple({ identityToken: "token", nonce: "nonce" }),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 503
      && /APPLE/.test(error.detail)
  );
  assert.deepEqual(store.read((state) => ({
    users: state.users,
    accounts: state.accounts,
    challenges: state.authChallengesById
  })), { users: {}, accounts: {}, challenges: {} });
});

test("phone login reuses one account, stores no raw number/code, and issues an account session", async () => {
  let now = new Date("2026-09-05T00:00:00.000Z");
  const provider = new DeterministicPhoneChallengeProvider("591204", () => now);
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, () => now, { phone: provider });

  const firstChallenge = await service.requestPhoneChallenge("138 0013 8000", "client-a");
  assert.deepEqual(Object.keys(firstChallenge).sort(), ["challengeId", "expiresAt", "provider"]);
  await assert.rejects(
    service.verifyPhoneChallenge({
      challengeId: firstChallenge.challengeId,
      phoneNumber: "[REDACTED_PHONE]",
      code: "wrong"
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );

  const firstLogin = await service.verifyPhoneChallenge({
    challengeId: firstChallenge.challengeId,
    phoneNumber: "[REDACTED_PHONE]",
    code: "591204"
  });
  assert.equal(service.authenticateToken(firstLogin.sessionToken).kind, "ACCOUNT");

  now = new Date("2026-09-05T00:00:05.000Z");
  const secondChallenge = await service.requestPhoneChallenge("+86 (138) 0013 8000", "client-a");
  const secondLogin = await service.verifyPhoneChallenge({
    challengeId: secondChallenge.challengeId,
    phoneNumber: "008613800138000",
    code: "591204"
  });
  assert.equal(secondLogin.userId, firstLogin.userId);
  assert.equal(secondLogin.accountId, firstLogin.accountId);
  assert.notEqual(secondLogin.sessionId, firstLogin.sessionId);

  const serialized = JSON.stringify(store.read((state) => state));
  assert.doesNotMatch(serialized, /13800138000/);
  assert.doesNotMatch(serialized, /591204/);
  const account = store.read((state) => state.accounts[firstLogin.accountId]);
  assert.equal(account?.provider, "PHONE");
  assert.equal(account?.phoneLastFour, "8000");

  await assert.rejects(
    service.verifyPhoneChallenge({
      challengeId: firstChallenge.challengeId,
      phoneNumber: "[REDACTED_PHONE]",
      code: "591204"
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
});

test("phone challenges lock after five failed verification attempts", async () => {
  const provider = new DeterministicPhoneChallengeProvider("correct-code");
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, undefined, { phone: provider });
  const challenge = await service.requestPhoneChallenge("+8613800138000");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      service.verifyPhoneChallenge({
        challengeId: challenge.challengeId,
        phoneNumber: "[REDACTED_PHONE]",
        code: "wrong-code"
      }),
      (error: unknown) => error instanceof HttpProblem && error.status === 401
    );
  }
  const persisted = store.read((state) => state.authChallengesById[challenge.challengeId]);
  assert.equal(persisted?.failedAttempts, 5);
  assert.ok(persisted?.lockedAt);
  await assert.rejects(
    service.verifyPhoneChallenge({
      challengeId: challenge.challengeId,
      phoneNumber: "[REDACTED_PHONE]",
      code: "correct-code"
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
});

test("phone verification fails closed when a provider omits verified=true", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(
    store,
    config(),
    undefined,
    undefined,
    {
      phone: {
        issueChallenge: async () => undefined,
        verifyChallenge: async () => ({})
      }
    }
  );
  const challenge = await service.requestPhoneChallenge("+8613800138000");
  await assert.rejects(
    service.verifyPhoneChallenge({
      challengeId: challenge.challengeId,
      phoneNumber: "[REDACTED_PHONE]",
      code: "anything"
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
  assert.equal(
    store.read((state) => Object.keys(state.accounts).length),
    0
  );
});

test("Apple sign-in reuses the verified subject but never merges PHONE and APPLE accounts", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(
    store,
    config(),
    undefined,
    undefined,
    { phone: new DeterministicPhoneChallengeProvider("000001"), apple: new TestAppleVerifier() }
  );
  const appleA = await service.signInWithApple({
    identityToken: "valid:apple-subject",
    nonce: "nonce-a"
  });
  const appleB = await service.signInWithApple({
    identityToken: "valid:apple-subject",
    nonce: "nonce-b"
  });
  assert.equal(appleA.userId, appleB.userId);
  assert.equal(appleA.accountId, appleB.accountId);

  const challenge = await service.requestPhoneChallenge("+8613900000000");
  const phone = await service.verifyPhoneChallenge({
    challengeId: challenge.challengeId,
    phoneNumber: "[REDACTED_PHONE]",
    code: "000001"
  });
  assert.notEqual(phone.userId, appleA.userId);
  assert.equal(store.read((state) => Object.keys(state.users).length), 2);
});

test("account refresh tokens rotate once and reuse revokes the token family", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(
    store,
    config(),
    undefined,
    undefined,
    { apple: new TestAppleVerifier() }
  );
  const first = await service.signInWithApple({
    identityToken: "valid:refresh-subject",
    nonce: "nonce-refresh"
  });
  const rotated = await service.refreshAccountSession(first.refreshToken);
  assert.equal(rotated.userId, first.userId);
  assert.notEqual(rotated.sessionToken, first.sessionToken);
  assert.notEqual(rotated.refreshToken, first.refreshToken);
  assert.throws(() => service.authenticateToken(first.sessionToken), /authenticated/);
  await assert.rejects(
    service.refreshAccountSession(first.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
  await assert.rejects(
    service.refreshAccountSession(rotated.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
});

test("refresh survives access expiry and unrelated authentication cleanup", async () => {
  let now = new Date("2026-09-05T00:00:00.000Z");
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(
    store,
    { ...config(), sessionTtlSeconds: 1 },
    undefined,
    () => now,
    { apple: new TestAppleVerifier() }
  );
  const first = await service.signInWithApple({
    identityToken: "valid:cleanup-subject",
    nonce: "nonce-cleanup"
  });
  now = new Date("2026-09-05T00:00:02.000Z");
  await service.signInWithApple({
    identityToken: "valid:another-subject",
    nonce: "nonce-another"
  });
  const refreshed = await service.refreshAccountSession(first.refreshToken);
  assert.equal(refreshed.userId, first.userId);
  await assert.rejects(
    service.refreshAccountSession(first.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
  await assert.rejects(
    service.refreshAccountSession(refreshed.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
});

test("HTTP bootstrap and business paths require authenticated account/device sessions", async () => {
  const phone = new DeterministicPhoneChallengeProvider("246810");
  const backend = await createBackend({
    config: config(),
    store: new MemoryStateStore(emptyState()),
    phoneChallengeProvider: phone,
    appleIdentityTokenVerifier: new TestAppleVerifier()
  });
  await backend.start();
  try {
    const base = backend.baseURL();
    const unauthenticated = await fetch(`${base}/api/v2/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(unauthenticated.status, 401);

    const challengeResponse = await fetch(`${base}/api/v2/auth/phone/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "[REDACTED_PHONE]" })
    });
    assert.equal(challengeResponse.status, 201);
    const challenge = await challengeResponse.json() as { challengeId: string };
    const loginResponse = await fetch(`${base}/api/v2/auth/phone/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        phoneNumber: "[REDACTED_PHONE]",
        code: "246810"
      })
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json() as {
      userId: string;
      accountId: string;
      sessionToken: string;
    };

    const businessWithAccount = await fetch(`${base}/api/v2/events`, {
      headers: { authorization: `Bearer ${login.sessionToken}` }
    });
    assert.equal(businessWithAccount.status, 403);

    const bootstrapResponse = await fetch(`${base}/api/v2/session/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${login.sessionToken}`
      },
      body: JSON.stringify({
        deviceInstanceId: "REDACTED-ID-7e0f59fc2812bca4",
        deviceKind: "IPHONE",
        companionPairId: "REDACTED-ID-234c75800b00ec7a",
        agreementAcceptances: [
          { kind: "PATIENT", version: "2.0", acceptedAt: "2026-09-05T00:00:00.000Z" },
          { kind: "VOLUNTEER_RESPONDER", version: "2.0", acceptedAt: "2026-09-05T00:00:00.000Z" },
          { kind: "PRIVACY_POLICY", version: "2.0", acceptedAt: "2026-09-05T00:00:00.000Z" },
          {
            kind: "SENSITIVE_PERSONAL_INFORMATION",
            version: "2.0",
            acceptedAt: "2026-09-05T00:00:00.000Z"
          }
        ],
        capabilities: { notificationAuthorized: true, locationAuthorized: true },
        availableForResponse: true
      })
    });
    assert.equal(bootstrapResponse.status, 201);
    const deviceSession = await bootstrapResponse.json() as {
      userId: string;
      accountId: string;
      sessionToken: string;
    };
    assert.equal(deviceSession.userId, login.userId);
    assert.equal(deviceSession.accountId, login.accountId);
    const devicePrincipal = backend.service.authenticateToken(deviceSession.sessionToken);
    assert.equal(devicePrincipal.kind, "DEVICE");

    const unauthenticatedBusiness = await fetch(`${base}/api/v2/events`);
    assert.equal(unauthenticatedBusiness.status, 401);
  } finally {
    await backend.stop();
  }
});

test("legacy anonymous device sessions are retained as migration data but cannot authenticate", async () => {
  const rawToken = "legacy-anonymous-device-token";
  const deviceInstanceId = "REDACTED-ID-9f64b482f33c6d63";
  const now = "2026-09-05T00:00:00.000Z";
  const store = new MemoryStateStore(emptyState());
  await store.transact((state) => {
    state.devices[deviceInstanceId] = {
      deviceInstanceId,
      deviceKind: "IPHONE",
      companionPairId: "REDACTED-ID-e716871974f6ae00",
      agreements: {},
      capabilities: { notificationAuthorized: false, locationAuthorized: false },
      availableForResponse: false,
      presenceObservedAt: now,
      lastSeenAt: now,
      lastBootstrapAt: now
    };
    state.sessionsByTokenHash[tokenHash(rawToken)] = {
      sessionId: "REDACTED-ID-3893613845a6ccdd",
      tokenHash: tokenHash(rawToken),
      sessionKind: "DEVICE",
      deviceInstanceId,
      deviceKind: "IPHONE",
      scopes: ["events:read"],
      issuedAt: now,
      expiresAt: "2026-09-05T01:00:00.000Z"
    };
  });
  const backend = await createBackend({ config: config(), store });
  await backend.start();
  try {
    const response = await fetch(`${backend.baseURL()}/api/v2/events`, {
      headers: { authorization: `Bearer ${rawToken}` }
    });
    assert.equal(response.status, 401);
  } finally {
    await backend.stop();
  }
});


test("authentication and existing Socket revalidation use entity snapshots without the legacy full read", async () => {
  const h = await authenticatedConnectionHarness();
  h.store.failLegacyReadOnly = true;
  assert.deepEqual(h.service.authenticateToken(h.session.sessionToken), h.principal);
  const connections = new SessionConnections(h.service.identityAccess);
  let disconnected = false;
  connections.register("entity-connection", h.principal, () => { disconnected = true; });
  assert.equal(connections.isAuthorized("entity-connection"), true);
  await h.service.logout(h.principal);
  assert.equal(disconnected, true);
  assert.throws(() => h.service.authenticateToken(h.session.sessionToken), error => error instanceof HttpProblem && error.status === 401);
  connections.close();
});

test("recovery/query entry points reject a principal captured before session revocation", async () => {
  const h = await authenticatedConnectionHarness();
  await h.service.logout(h.principal);
  assert.throws(
    () => h.service.replayPendingResponses(h.principal),
    error => error instanceof HttpProblem && error.status === 401
  );
});


test("account switch rejects legacy identity without mutation and preserves both identities on return", async () => {
  const h = await authenticatedConnectionHarness();
  const before = h.store.read(state => structuredClone(state.devices[h.principal.deviceInstanceId]!));
  const other = await h.service.signInWithApple({ identityToken: "valid:second-account", nonce: "nonce" });
  const otherPrincipal = h.service.authenticateToken(other.sessionToken);
  const request = {
    deviceInstanceId: before.deviceInstanceId, companionPairId: before.companionPairId,
    deviceKind: "IPHONE" as const,
    agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"] as const).map(kind => ({
        kind, version: "2.0", acceptedAt: "2026-09-09T00:00:00.000Z"
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  };
  await assert.rejects(h.service.bootstrap(otherPrincipal, request, "switch"),
    (error: unknown) => error instanceof HttpProblem && error.status === 403
      && error.type === "https://aedresponse.invalid/problems/device-account-binding-conflict");
  assert.deepEqual(h.store.read(state => state.devices[before.deviceInstanceId]), before);
  const separate = { ...request, deviceInstanceId: "REDACTED-ID-b25d52c577bd7a87",
    companionPairId: "REDACTED-ID-0e1367a4cc00a2ee" };
  const secondDevice = await h.service.bootstrap(otherPrincipal, separate, "switch");
  await h.service.revokeSession(h.service.authenticateToken(secondDevice.sessionToken));
  await h.service.revokeSession(otherPrincipal);
  assert.throws(() => h.service.authenticateToken(secondDevice.sessionToken));
  const returning = await h.service.signInWithApple({ identityToken: "valid:connection-test", nonce: "nonce" });
  await h.service.bootstrap(h.service.authenticateToken(returning.sessionToken), request, "return");
  assert.equal(h.store.read(state => Object.keys(state.devices).length), 2);
  assert.equal(h.store.read(state => state.devices[before.deviceInstanceId]!.userId), before.userId);
  assert.equal(h.store.read(state => state.devices[separate.deviceInstanceId]!.userId), other.userId);
});


test("explicit logout can be acknowledged again without restoring business access", async () => {
  const h = await authenticatedConnectionHarness();
  await h.service.logoutToken(h.session.sessionToken);
  const before = h.store.read(state => structuredClone(state));
  await h.service.logoutToken(h.session.sessionToken);
  assert.deepEqual(h.store.read(state => state), before);
  assert.throws(() => h.service.authenticateToken(h.session.sessionToken));
  await assert.rejects(h.service.logoutToken("unknown-token"));
});

test("failed logout transaction never leaves a success receipt", async () => {
  const h = await authenticatedConnectionHarness();
  h.store.failCommit = true;
  await assert.rejects(h.service.logoutToken(h.session.sessionToken));
  assert.equal(h.store.read(state => state.sessionsByTokenHash[h.principal.tokenHash]!.logoutCompletedAt), undefined);
  assert.doesNotThrow(() => h.service.authenticateToken(h.session.sessionToken));
  h.store.failCommit = false;
  await h.service.logoutToken(h.session.sessionToken);
});

test("expiry alone is not confirmation of explicit logout", async () => {
  const h = await authenticatedConnectionHarness();
  h.expire();
  await assert.rejects(h.service.logoutToken(h.session.sessionToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401);
});

test("HTTP logout repeats 204 only for a committed explicit logout", async () => {
  const backend = await createBackend({ config: config(), store: new MemoryStateStore(emptyState()),
    appleIdentityTokenVerifier: new TestAppleVerifier() });
  await backend.start();
  try {
    const login = await fetch(`${backend.baseURL()}/api/v2/auth/apple`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: "REDACTED-ID-ef267fe5629bbca9", identityToken: "valid:logout-replay", nonce: "nonce" })
    });
    assert.equal(login.status, 200);
    const account = await login.json() as { sessionToken: string };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${backend.baseURL()}/api/v2/auth/logout`, {
        method: "POST", headers: { authorization: `Bearer ${account.sessionToken}` }
      });
      assert.equal(response.status, 204);
    }
    const invalid = await fetch(`${backend.baseURL()}/api/v2/auth/logout`, {
      method: "POST", headers: { authorization: "Bearer unknown" }
    });
    assert.equal(invalid.status, 401);
  } finally { await backend.stop(); }
});


test("reauthenticated recovery of a cleaned device token preserves the new session", async () => {
  const h = await authenticatedConnectionHarness();
  const device = h.store.read(state => structuredClone(state.devices[h.principal.deviceInstanceId]!));
  h.expire();
  const fresh = await h.service.signInWithApple({ identityToken: "valid:connection-test", nonce: "nonce" });
  const current = h.service.authenticateToken(fresh.sessionToken);
  const newer = await h.service.bootstrap(current, {
    deviceInstanceId: device.deviceInstanceId, companionPairId: device.companionPairId, deviceKind: "IPHONE",
    agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"] as const)
      .map(kind => ({ kind, version: "2.0", acceptedAt: "2026-09-09T00:00:00.000Z" })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true }, availableForResponse: true
  }, "recovery");
  assert.equal(h.store.read(state => state.sessionsByTokenHash[h.principal.tokenHash]), undefined);
  const oldWatchToken = "old-watch-recovery";
  const newWatchToken = "new-watch-recovery";
  await h.store.transact(state => {
    for (const [id, raw, issuedAt] of [
      ["old-watch", oldWatchToken, "2026-09-09T00:00:00.000Z"],
      ["new-watch", newWatchToken, "2026-09-09T00:15:00.000Z"]
    ] as const) {
      state.devices[id] = { ...device, deviceInstanceId: id, deviceKind: "WATCH", lastBootstrapAt: issuedAt };
      state.sessionsByTokenHash[tokenHash(raw)] = {
        sessionId: id, tokenHash: tokenHash(raw), sessionKind: "DEVICE", deviceKind: "WATCH",
        deviceInstanceId: id, userId: fresh.userId, accountId: fresh.accountId,
        scopes: ["watch:report", "watch:fallback"], issuedAt, expiresAt: "2026-09-10T00:00:00.000Z"
      };
    }
  });
  const input = { priorToken: h.session.sessionToken, isAccount: false,
    requestedAt: "2026-09-09T00:00:00.000Z", deviceInstanceId: device.deviceInstanceId };
  await h.service.recoverLogout(current, input);
  await h.service.recoverLogout(current, input);
  assert.doesNotThrow(() => h.service.authenticateToken(newer.sessionToken));
  assert.doesNotThrow(() => h.service.authenticateToken(fresh.sessionToken));
  assert.throws(() => h.service.authenticateToken(oldWatchToken));
  assert.doesNotThrow(() => h.service.authenticateToken(newWatchToken));
  const wrong = await h.service.signInWithApple({ identityToken: "valid:foreign-account", nonce: "nonce" });
  await assert.rejects(h.service.recoverLogout(h.service.authenticateToken(wrong.sessionToken), input),
    (error: unknown) => error instanceof HttpProblem && error.status === 403);
});

test("reauthenticated recovery revokes an expired old family but not the fresh login", async () => {
  const h = await authenticatedConnectionHarness();
  h.expire();
  const fresh = await h.service.signInWithApple({ identityToken: "valid:connection-test", nonce: "nonce" });
  const current = h.service.authenticateToken(fresh.sessionToken);
  await h.service.recoverLogout(current, { priorToken: h.account.sessionToken, isAccount: true,
    requestedAt: "2026-09-09T00:00:00.000Z" });
  await assert.rejects(h.service.refreshAccountSession(h.account.refreshToken));
  assert.doesNotThrow(() => h.service.authenticateToken(fresh.sessionToken));
  await assert.rejects(h.service.recoverLogout(current, { priorToken: fresh.sessionToken, isAccount: true,
    requestedAt: "2026-09-09T00:15:00.000Z" }));
});

test("in-app account deletion erases the identity, its devices and every session", async () => {
  let now = new Date("2026-09-11T00:00:00.000Z");
  const provider = new DeterministicPhoneChallengeProvider("591204", () => now);
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, () => now, { phone: provider });

  const challenge = await service.requestPhoneChallenge("+8613800138000");
  const login = await service.verifyPhoneChallenge({
    challengeId: challenge.challengeId,
    phoneNumber: "[REDACTED_PHONE]",
    code: "591204"
  });
  const accountPrincipal = service.authenticateToken(login.sessionToken);
  const bootstrapped = await service.bootstrap(accountPrincipal, {
    deviceInstanceId: "REDACTED-ID-b25d52c577bd7a87",
    companionPairId: "REDACTED-ID-0e1367a4cc00a2ee",
    deviceKind: "IPHONE",
    agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"] as const).map(kind => ({
        kind, version: "2.0", acceptedAt: now.toISOString()
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, "deletion-test");
  const devicePrincipal = service.authenticateToken(bootstrapped.sessionToken);
  assert.equal(devicePrincipal.kind, "DEVICE");

  // The device holds standby presence, which is what erasure must also remove.
  await service.updatePresence(devicePrincipal, {
    presenceUpdateId: "REDACTED-ID-741fcaf6bf79f014",
    occurredAt: now.toISOString(),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  });
  const before = store.read(state => ({
    users: Object.keys(state.users).length,
    accounts: Object.keys(state.accounts).length,
    devices: Object.keys(state.devices).length,
    sessions: Object.keys(state.sessionsByTokenHash).length,
    providerKeys: Object.keys(state.accountIdByProviderKey).length
  }));
  assert.equal(before.users, 1);
  assert.equal(before.accounts, 1);
  assert.equal(before.providerKeys, 1);
  assert.ok(before.devices >= 1);
  assert.ok(before.sessions >= 2);

  const result = await service.deleteAccount(accountPrincipal);
  assert.equal(result.status, "REQUESTED");
  assert.equal(result.requestId, `deletion:${login.userId}`);
  assert.equal(result.requestedAt, now.toISOString());

  // Every identifying collection is empty, including the provider-key index that
  // would otherwise let the erased phone number sign in again.
  const after = store.read(state => ({
    users: Object.keys(state.users).length,
    accounts: Object.keys(state.accounts).length,
    providerKeys: Object.keys(state.accountIdByProviderKey).length,
    devices: Object.keys(state.devices).length,
    sessions: Object.keys(state.sessionsByTokenHash).length,
    tickets: Object.keys(state.companionLinkTicketsByHash).length,
    presenceReceipts: Object.keys(state.presenceUpdateReceiptsById).length,
    deletionRequests: Object.values(state.deletionRequestsById)
  }));
  assert.deepEqual(
    { ...after, deletionRequests: after.deletionRequests.length },
    { users: 0, accounts: 0, providerKeys: 0, devices: 0, sessions: 0, tickets: 0,
      presenceReceipts: 0, deletionRequests: 1 }
  );

  // The minimal audit record names the identity but copies no profile data.
  const record = after.deletionRequests[0]!;
  assert.equal(record.userId, login.userId);
  assert.equal(record.status, "REQUESTED");
  assert.deepEqual(record.purged.includes(`users.${login.userId}`), true);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /13800138000/, "删除审计不得保留手机号");
  assert.doesNotMatch(serialized, /PHONE|APPLE/, "删除审计不得保留提供方");
  assert.doesNotMatch(serialized, /phoneLastFour|providerSubjectHash/, "删除审计不得保留号码后四位或提供方摘要");
  // Only opaque ids may appear: the purged list is a count of what went, and the
  // identity fields are the user id plus the deterministic request id.
  assert.deepEqual(
    Object.keys(record).sort(),
    ["erasureStartedAt", "purged", "requestId", "requestedAt", "status", "userId"]
  );

  // Both bearers are gone, and the phone number cannot re-authenticate into the
  // erased account.
  assert.throws(() => service.authenticateToken(login.sessionToken));
  assert.throws(() => service.authenticateToken(bootstrapped.sessionToken));
  await assert.rejects(service.refreshAccountSession(login.refreshToken));
  const reloginChallenge = await service.requestPhoneChallenge("+8613800138000");
  const relogin = await service.verifyPhoneChallenge({
    challengeId: reloginChallenge.challengeId,
    phoneNumber: "[REDACTED_PHONE]",
    code: "591204"
  });
  assert.notEqual(relogin.userId, login.userId, "删除后重新登录必须得到新的稳定身份");
});

test("account deletion is idempotent and requires an account-scoped bearer", async () => {
  const provider = new DeterministicPhoneChallengeProvider("591204");
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, undefined, { phone: provider });
  const challenge = await service.requestPhoneChallenge("+8613800138000");
  const login = await service.verifyPhoneChallenge({
    challengeId: challenge.challengeId,
    phoneNumber: "[REDACTED_PHONE]",
    code: "591204"
  });
  const principal = service.authenticateToken(login.sessionToken);

  const bootstrapped = await service.bootstrap(principal, {
    deviceInstanceId: "REDACTED-ID-08a3be40e427eb2f",
    companionPairId: "REDACTED-ID-4fbcd05bf6a44b70",
    deviceKind: "IPHONE",
    agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"] as const).map(kind => ({
        kind, version: "2.0", acceptedAt: new Date().toISOString()
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, "deletion-scope-test");
  const devicePrincipal = service.authenticateToken(bootstrapped.sessionToken);

  // A device session must not be able to delete the account it belongs to.
  await assert.rejects(
    service.deleteAccount(devicePrincipal),
    (error: unknown) => error instanceof HttpProblem && error.status === 403
  );
  assert.equal(store.read(state => Object.keys(state.users).length), 1);

  const first = await service.deleteAccount(principal);
  // A replay cannot create a second request or change the original decision.
  const replay = await service.deleteAccount(principal);
  assert.deepEqual(replay, first);
  assert.equal(store.read(state => Object.keys(state.deletionRequestsById).length), 1);
});

test("HTTP account deletion returns 202 with a durable request and invalidates the bearer", async () => {
  const store = new MemoryStateStore(emptyState());
  const backend = await createBackend({ config: config(), store,
    appleIdentityTokenVerifier: new TestAppleVerifier() });
  await backend.start();
  try {
    const login = await fetch(`${backend.baseURL()}/api/v2/auth/apple`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: "REDACTED-ID-3898beb54e15ab6d",
        identityToken: "valid:http-account-deletion", nonce: "nonce" })
    });
    assert.equal(login.status, 200);
    const account = await login.json() as { sessionToken: string; userId: string };

    // An unauthenticated caller must not be able to delete anything.
    const anonymous = await fetch(`${backend.baseURL()}/api/v2/auth/account`, { method: "DELETE" });
    assert.equal(anonymous.status, 401);

    const deleted = await fetch(`${backend.baseURL()}/api/v2/auth/account`, {
      method: "DELETE", headers: { authorization: `Bearer ${account.sessionToken}` }
    });
    assert.equal(deleted.status, 202);
    const receipt = await deleted.json() as { requestId: string; status: string; requestedAt: string };
    assert.equal(receipt.status, "REQUESTED");
    assert.equal(receipt.requestId, `deletion:${account.userId}`);

    // The bearer is gone: neither the same token nor refresh can be used again.
    const replayWithBearer = await fetch(`${backend.baseURL()}/api/v2/auth/account`, {
      method: "DELETE", headers: { authorization: `Bearer ${account.sessionToken}` }
    });
    assert.equal(replayWithBearer.status, 401);
    assert.equal(store.read(state => Object.keys(state.users).length), 0);
    assert.equal(store.read(state => Object.keys(state.deletionRequestsById).length), 1);
  } finally { await backend.stop(); }
});
