import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { AppleJWTVerifier } from "../src/apple-auth.js";
import type { AppleLoginChallenge } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { HttpProblem } from "../src/errors.js";
import { emptyState } from "../src/models.js";
import { createBackend } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "apple-test-key", use: "sig", alg: "RS256" };
const rejected = (error: unknown) => error instanceof HttpProblem && error.status === 401;
const unavailable = (error: unknown) => error instanceof HttpProblem && error.status === 503;

function fixture() {
  let timestamp = Date.parse("2026-09-08T00:00:00Z");
  let fail = false;
  let calls = 0;
  const fetcher = (async (url: unknown, options?: RequestInit) => {
    calls += 1;
    assert.equal(url, "https://appleid.apple.com/auth/keys");
    assert.equal(options?.redirect, "error");
    if (fail) throw new Error("private-provider-detail");
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  const verifier = new AppleJWTVerifier(["dev.example.aedresponse"], fetcher, () => new Date(timestamp));
  return { verifier, calls: () => calls, setFailure: (value: boolean) => { fail = value; },
    advance: (ms: number) => { timestamp += ms; }, now: () => timestamp };
}

function token(challenge: AppleLoginChallenge, overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const issued = Date.parse(challenge.expiresAt) / 1_000 - 300;
  const parts = [
    { alg: "RS256", kid: jwk.kid, ...header },
    { iss: "https://appleid.apple.com", aud: "dev.example.aedresponse", sub: "verified-apple-subject",
      iat: issued, exp: issued + 600, nonce: createHash("sha256").update(challenge.nonce).digest("hex"), ...overrides }
  ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url"));
  return `${parts.join(".")}.${sign("RSA-SHA256", Buffer.from(parts.join(".")), pair.privateKey).toString("base64url")}`;
}

test("Apple verifier binds a signed identity to a single server-issued challenge", async () => {
  const { verifier, calls } = fixture();
  const challenge = await verifier.createChallenge();
  const request = { challengeId: challenge.challengeId, nonce: challenge.nonce, identityToken: token(challenge) };
  assert.deepEqual(await verifier.verifyIdentityToken(request), { subject: "verified-apple-subject" });
  await assert.rejects(verifier.verifyIdentityToken(request), rejected);
  const second = await verifier.createChallenge();
  await verifier.verifyIdentityToken({ challengeId: second.challengeId, nonce: second.nonce, identityToken: token(second) });
  assert.equal(calls(), 1, "Apple public keys should be cached");
});

test("Apple verifier rejects untrusted algorithms, claims, key URLs and invalid signatures", async () => {
  for (const claims of [
    { iss: "https://attacker.invalid" }, { aud: "other.application" }, { exp: 0 },
    { exp: "9999999999" }, { iat: 9_999_999_999 }, { nonce: "different" }, { sub: "" }
  ]) {
    const { verifier } = fixture();
    const c = await verifier.createChallenge();
    await assert.rejects(verifier.verifyIdentityToken({ challengeId: c.challengeId, nonce: c.nonce, identityToken: token(c, claims) }), rejected);
  }
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { jku: "https://attacker.invalid/keys" }, { crit: ["custom"] }, { kid: "unknown" }]) {
    const { verifier } = fixture();
    const c = await verifier.createChallenge();
    await assert.rejects(verifier.verifyIdentityToken({ challengeId: c.challengeId, nonce: c.nonce, identityToken: token(c, {}, header) }), rejected);
  }
  const { verifier } = fixture();
  const c = await verifier.createChallenge();
  const parts = token(c).split(".");
  const bytes = Buffer.from(parts[2]!, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  parts[2] = bytes.toString("base64url");
  await assert.rejects(verifier.verifyIdentityToken({ challengeId: c.challengeId, nonce: c.nonce, identityToken: parts.join(".") }), rejected);
});

test("Apple challenges expire, cannot cross server instances, and cannot be consumed concurrently", async () => {
  const f = fixture();
  const c = await f.verifier.createChallenge();
  const request = { challengeId: c.challengeId, nonce: c.nonce, identityToken: token(c) };
  await assert.rejects(fixture().verifier.verifyIdentityToken(request), rejected);
  await assert.rejects(f.verifier.verifyIdentityToken({ ...request, nonce: "wrong" }), rejected);
  const results = await Promise.allSettled([f.verifier.verifyIdentityToken(request), f.verifier.verifyIdentityToken(request)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const expired = await f.verifier.createChallenge();
  f.advance(300_000);
  await assert.rejects(f.verifier.verifyIdentityToken({ challengeId: expired.challengeId, nonce: expired.nonce, identityToken: token(expired) }), rejected);
});

test("Apple key-source outage returns 503 without consuming the login challenge", async () => {
  const f = fixture();
  const c = await f.verifier.createChallenge();
  const request = { challengeId: c.challengeId, nonce: c.nonce, identityToken: token(c) };
  f.setFailure(true);
  await assert.rejects(f.verifier.verifyIdentityToken(request), unavailable);
  f.setFailure(false);
  f.advance(1_000);
  assert.equal((await f.verifier.verifyIdentityToken(request)).subject, "verified-apple-subject");
});

test("Apple REST challenge and signed login use the original account/session service", async () => {
  const f = fixture();
  const config = { ...loadConfig({}, "/tmp/aedresponse-apple-verifier-test"), port: 0, authSubjectPepper: "apple-test-pepper" };
  const store = new MemoryStateStore(emptyState());
  const backend = await createBackend({ config, store, now: () => new Date(f.now()), authentication: { apple: f.verifier } });
  await backend.start();
  try {
    const challengeResponse = await fetch(`${backend.baseURL()}/api/v2/auth/apple/challenges`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(challengeResponse.status, 201);
    const c = await challengeResponse.json() as AppleLoginChallenge;
    const request = { challengeId: c.challengeId, nonce: c.nonce, identityToken: token(c) };
    const login = () => fetch(`${backend.baseURL()}/api/v2/auth/apple`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
    });
    f.setFailure(true);
    assert.equal((await login()).status, 503);
    f.setFailure(false);
    f.advance(1_000);
    assert.equal((await login()).status, 200);
    assert.equal((await login()).status, 401);
    const originalAccounts = store.read(state => Object.keys(state.accounts));
    const nextResponse = await fetch(`${backend.baseURL()}/api/v2/auth/apple/challenges`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(nextResponse.status, 201);
    const next = await nextResponse.json() as AppleLoginChallenge;
    const repeated = await fetch(`${backend.baseURL()}/api/v2/auth/apple`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: next.challengeId, nonce: next.nonce, identityToken: token(next) })
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(store.read(state => Object.keys(state.accounts)), originalAccounts);
    assert.equal(store.read(state => Object.keys(state.accounts).length), 1);
    const serialized = JSON.stringify(store.read(state => state));
    assert.doesNotMatch(serialized, /verified-apple-subject/);
    assert.ok(!serialized.includes(c.nonce));
    assert.ok(!serialized.includes(request.identityToken));
  } finally { await backend.stop(); }
});

test("Apple audiences are explicit and malformed configuration fails closed", () => {
  assert.throws(() => new AppleJWTVerifier([]), /allowlist/);
  assert.throws(() => loadConfig({ AED_APPLE_CLIENT_IDS: "" }), /client IDs/);
  assert.throws(() => loadConfig({ AED_APPLE_CLIENT_IDS: "valid.app,https://attacker.invalid" }), /client IDs/);
  assert.deepEqual(loadConfig({ AED_APPLE_CLIENT_IDS: "dev.example.app,dev.example.web" }).appleClientIds, ["dev.example.app", "dev.example.web"]);
});
