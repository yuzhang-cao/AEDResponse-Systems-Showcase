import type { StateReadView } from "../src/state-read.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import {
  type AppleLoginChallenge,
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

  /**
   * The HTTP route issues a real nonce challenge, so the double has to provide
   * one.  It is deterministic on purpose: a random nonce would make the request
   * body in the test unrunnable.
   */
  async createChallenge(): Promise<AppleLoginChallenge> {
    return {
      provider: "APPLE",
      challengeId: "REDACTED-ID-8e5fd040aa2fccc7",
      nonce: "test-nonce",
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    };
  }
}

test("unconfigured authentication providers fail closed", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config());
  await assert.rejects(
    service.requestAppleChallenge(),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 503
      && /APPLE/.test(error.detail)
  );
  await assert.rejects(
    service.signInWithApple({ identityToken: "valid:subject", nonce: "nonce" }),
    (error: unknown) => error instanceof HttpProblem && error.status === 503
  );
});
/**
 * Account identity is per provider subject, and a different provider subject must
 * never be merged into an existing account.  The second subject used to be a phone
 * account; with PHONE removed it is a second Apple subject, which tests the same
 * property: the account key is (provider, providerSubjectHash).
 */
test("Apple sign-in reuses one verified subject and never merges a different one", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(
    store,
    config(),
    undefined,
    undefined,
    { apple: new TestAppleVerifier() }
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

  const other = await service.signInWithApple({
    identityToken: "valid:another-apple-subject",
    nonce: "nonce-c"
  });
  assert.notEqual(other.userId, appleA.userId);
  assert.notEqual(other.accountId, appleA.accountId);
  assert.equal(store.read((state) => Object.keys(state.users).length), 2,
    "two distinct provider subjects are two accounts, never one merged account");
  assert.equal(store.read((state) => Object.values(state.accounts)
    .every((account) => account.provider === "APPLE")), true,
  "and every account is an Apple account, because that is the only sign-in method");
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

test("account login survives two-hour idle and keeps the original fixed 30-day deadline", async () => {
  const signedInAt = new Date("2026-09-01T00:00:00.000Z");
  let now = signedInAt;
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, { ...config(), sessionTtlSeconds: 900 },
    undefined, () => now, { apple: new TestAppleVerifier() });
  const first = await service.signInWithApple({ identityToken: "valid:long-login", nonce: "nonce-long-login" });
  const deadline = "2026-10-01T00:00:00.000Z";
  const refreshDeadline = (token: string) => store.read(state => state.sessionsByTokenHash[tokenHash(token)]?.refreshExpiresAt);
  assert.equal(refreshDeadline(first.sessionToken), deadline);

  now = new Date(signedInAt.getTime() + 2 * 60 * 60 * 1_000);
  assert.throws(() => service.authenticateToken(first.sessionToken), /authenticated/);
  const afterIdle = await service.refreshAccountSession(first.refreshToken);
  assert.equal(afterIdle.userId, first.userId);
  assert.equal(refreshDeadline(afterIdle.sessionToken), deadline);

  now = new Date("2026-09-30T23:00:00.000Z");
  const nearDeadline = await service.refreshAccountSession(afterIdle.refreshToken);
  assert.equal(nearDeadline.userId, first.userId);
  assert.equal(refreshDeadline(nearDeadline.sessionToken), deadline, "automatic rotation must not extend the fixed login window");

  now = new Date(deadline);
  await assert.rejects(service.refreshAccountSession(nearDeadline.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401);
  const newLogin = await service.signInWithApple({ identityToken: "valid:long-login", nonce: "nonce-new-login" });
  assert.equal(newLogin.userId, first.userId);
  assert.equal(refreshDeadline(newLogin.sessionToken), "2026-10-31T00:00:00.000Z");
});

test("HTTP bootstrap and business paths require authenticated account/device sessions", async () => {
  const backend = await createBackend({
    config: config(),
    store: new MemoryStateStore(emptyState()),
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

    // The removed PHONE entry points must be gone, not merely unused: an old
    // client hitting them has to fail loudly instead of half-working.  The route
    // no longer exists, so the request falls through to the authenticated
    // router and is refused before its body is even read.
    const removedPhoneChallenge = await fetch(`${base}/api/v2/auth/phone/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "[REDACTED_PHONE]" })
    });
    assert.equal(removedPhoneChallenge.status, 401);
    assert.match(removedPhoneChallenge.headers.get("content-type") ?? "", /problem\+json/);

    const challengeResponse = await fetch(`${base}/api/v2/auth/apple/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(challengeResponse.status, 201);
    const challenge = await challengeResponse.json() as { challengeId: string };
    const loginResponse = await fetch(`${base}/api/v2/auth/apple`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        identityToken: "valid:http-apple-subject",
        nonce: "nonce"
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

test("in-app closure retains account information, marks CLOSED and revokes every session", async () => {
  const now = new Date("2026-09-11T00:00:00.000Z");
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, () => now,
    { apple: new TestAppleVerifier() });

  const login = await service.signInWithApple({
    identityToken: "valid:deletion-subject",
    nonce: "nonce"
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
  assert.equal(result.status, "CLOSED");
  assert.equal(result.requestId, `deletion:${login.userId}`);
  assert.equal(result.requestedAt, now.toISOString());

  // Closure changes lifecycle state and retains existing account/device facts.
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
    { users: before.users, accounts: before.accounts, providerKeys: before.providerKeys, devices: before.devices, sessions: before.sessions, tickets: 0,
      presenceReceipts: 1, deletionRequests: 1 }
  );

  // The minimal audit record names the identity but copies no profile data.
  const record = after.deletionRequests[0]!;
  assert.equal(record.userId, login.userId);
  assert.equal(record.status, "CLOSED");
  assert.equal(record.accountClosed, true);
  assert.deepEqual(record.purged, []);
  assert.equal(store.read(state => state.users[login.userId]!.lifecycleState), "CLOSED");
  assert.ok(store.read(state => Object.values(state.sessionsByTokenHash).every(row => row.revokedAt)));
  assert.ok(store.read(state => Object.values(state.devices).every(row => row.loginState === "SIGNED_OUT" && !row.availableForResponse)));
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /13800138000/, "删除审计不得保留手机号");
  assert.doesNotMatch(serialized, /PHONE|APPLE/, "删除审计不得保留提供方");
  assert.doesNotMatch(serialized, /phoneLastFour|providerSubjectHash/, "删除审计不得保留号码后四位或提供方摘要");
  // Only opaque ids may appear: the purged list is a count of what went, and the
  // identity fields are the user id plus the deterministic request id.
  assert.deepEqual(
    Object.keys(record).sort(),
    ["accountClosed", "accountClosedAt", "erasureStartedAt", "purged", "requestId", "requestedAt", "status", "userId"]
  );

  // Neither old credentials nor a fresh Apple proof silently reopen a closed account.
  assert.throws(() => service.authenticateToken(login.sessionToken));
  assert.throws(() => service.authenticateToken(bootstrapped.sessionToken));
  await assert.rejects(service.refreshAccountSession(login.refreshToken));
  await assert.rejects(service.signInWithApple({ identityToken: "valid:deletion-subject", nonce: "nonce-2" }), /账号已注销/);
});

test("account deletion is idempotent and requires an account-scoped bearer", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config(), undefined, undefined,
    { apple: new TestAppleVerifier() });
  const login = await service.signInWithApple({
    identityToken: "valid:idempotent-subject",
    nonce: "nonce"
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
    assert.equal(receipt.status, "CLOSED");
    assert.equal(receipt.requestId, `deletion:${account.userId}`);

    // The bearer is gone: neither the same token nor refresh can be used again.
    const replayWithBearer = await fetch(`${backend.baseURL()}/api/v2/auth/account`, {
      method: "DELETE", headers: { authorization: `Bearer ${account.sessionToken}` }
    });
    assert.equal(replayWithBearer.status, 202);
    assert.deepEqual(await replayWithBearer.json(), receipt);
    const forbiddenBusiness = await fetch(`${backend.baseURL()}/api/v2/events`, { headers: { authorization: `Bearer ${account.sessionToken}` } });
    assert.equal(forbiddenBusiness.status, 401);
    assert.equal(store.read(state => state.users[account.userId]!.lifecycleState), "CLOSED");
    assert.equal(store.read(state => Object.keys(state.deletionRequestsById).length), 1);
  } finally { await backend.stop(); }
});
