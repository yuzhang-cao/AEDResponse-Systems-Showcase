/**
 * G02 — Apple's server-to-server notification, and the failure it prevents.
 *
 * When a person revokes the app's access in iOS Settings, the app is uninstalled
 * or disabled: it will never call us again, so this signed notification is the ONLY
 * way the server learns that the sessions it still trusts must die.  The endpoint
 * that receives it is public, which is why these tests are mostly about refusals:
 *
 *   - a body that is not signed by Apple's chain changes nothing;
 *   - a chain rooted somewhere else (even a perfectly valid certificate) is refused;
 *   - a signature over different bytes is refused;
 *   - an issuer or audience that is not this deployment is refused;
 *   - a verified `consent-revoked` revokes every session of that Apple subject, and
 *     a repeat delivery changes nothing.
 *
 * The chain is generated in the test and its root is injected through the
 * verifier's test-only option; production always uses the embedded Apple root.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  X509Certificate,
  createPrivateKey,
  generateKeyPairSync,
  sign as signWith,
  type KeyObject
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleServerNotificationVerifier } from "../src/apple-notifications.js";
import { APPLE_RECEIPT_ROOT_PEM } from "../src/apple-app-attest-roots.js";
import { loadConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import { providerSubjectHash } from "../src/auth.js";
import { createBackend } from "../src/server.js";
import { SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";

const BASE = Date.parse("2026-09-13T00:00:00.000Z");
const APP_ID = "com.example.aedresponse";
const PEPPER = "apple-notification-test-pepper-value";

/**
 * A self-signed root, an intermediate and a leaf, produced with openssl.
 *
 * A synthetic chain is the only way to test the refusals: a real Apple chain cannot
 * be made to fail on demand, and "it accepted the one real sample" would not show
 * that an untrusted chain is rejected.
 */
async function makeChain(directory: string): Promise<{
  root: string;
  leafKey: KeyObject;
  leafCertificate: string;
  leafIntermediate: string;
}> {
  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  };
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key"]);
  openssl(["req", "-x509", "-new", "-key", "root.key", "-days", "365", "-subj", "/CN=Test Root CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-out", "root.pem"]);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "inter.key"]);
  openssl(["req", "-new", "-key", "inter.key", "-subj", "/CN=Test Intermediate",
    "-out", "inter.csr"]);
  await writeFile(join(directory, "inter.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
  openssl(["x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key",
    "-days", "365", "-extfile", "inter.ext", "-out", "inter.pem"]);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
  openssl(["req", "-new", "-key", "leaf.key", "-subj", "/CN=Apple Test Signer", "-out", "leaf.csr"]);
  await writeFile(join(directory, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "inter.pem", "-CAkey", "inter.key",
    "-days", "365", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
  const { readFile } = await import("node:fs/promises");
  return {
    root: await readFile(join(directory, "root.pem"), "utf8"),
    leafKey: createPrivateKey(await readFile(join(directory, "leaf.key"))),
    leafCertificate: await readFile(join(directory, "leaf.pem"), "utf8"),
    leafIntermediate: await readFile(join(directory, "inter.pem"), "utf8")
  };
}

function pemToBase64Der(pem: string): string {
  return pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
}

function signedNotification(input: {
  chain: { leafCertificate: string; leafIntermediate: string };
  leafKey: KeyObject;
  payload: Record<string, unknown>;
  headerOverride?: Record<string, unknown>;
}): string {
  const header = {
    alg: "ES256",
    x5c: [pemToBase64Der(input.chain.leafCertificate), pemToBase64Der(input.chain.leafIntermediate)],
    ...(input.headerOverride ?? {})
  };
  const headerPart = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify(input.payload), "utf8").toString("base64url");
  const signature = signWith("sha256", Buffer.from(`${headerPart}.${payloadPart}`, "utf8"), {
    key: input.leafKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${headerPart}.${payloadPart}.${signature.toString("base64url")}`;
}

test("apple notifications: only a chain rooted at the trusted root is accepted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aed-apple-notification-"));
  try {
    const trusted = await makeChain(directory);
    // No fixed clock: the chain was minted moments ago, so the REAL clock is what
    // its validity window is relative to.  The business clock stays pinned elsewhere.
    const verifier = new AppleServerNotificationVerifier({
      appId: APP_ID, trustedRoot: trusted.root
    });
    const payload = {
      iss: "apple", aud: APP_ID, jti: "notification-1",
      events: [{ type: "consent-revoked", sub: "001234.abcdef", eventTime: BASE }]
    };
    const signed = signedNotification({ chain: trusted, leafKey: trusted.leafKey, payload });
    const verified = verifier.verify(signed);
    assert.equal(verified.verified, true);
    if (!verified.verified) return;
    assert.equal(verified.notification.events[0]!.type, "consent-revoked");
    assert.equal(verified.notification.events[0]!.subject, "001234.abcdef");

    // A DIFFERENT root: the chain is internally valid and the signature is real, and
    // it must still be refused, because trust is the root and nothing else.
    const other = await makeChain(await mkdtemp(join(tmpdir(), "aed-apple-other-")));
    const foreign = signedNotification({ chain: other, leafKey: other.leafKey, payload });
    assert.deepEqual(verifier.verify(foreign), { verified: false, reason: "UNTRUSTED_CHAIN" });

    // A tampered payload: the signature no longer covers these bytes.
    const [headerPart, , signaturePart] = signed.split(".");
    const tampered = Buffer.from(JSON.stringify({
      ...payload, events: [{ type: "account-deleted", sub: "999999.zzz" }]
    }), "utf8").toString("base64url");
    assert.deepEqual(verifier.verify(`${headerPart}.${tampered}.${signaturePart}`),
      { verified: false, reason: "BAD_SIGNATURE" });

    // Wrong issuer, wrong audience, no events, and an unsupported algorithm.
    for (const [mutate, reason] of [
      [{ iss: "not-apple" }, "WRONG_ISSUER"],
      [{ aud: "com.example.someone.else" }, "WRONG_AUDIENCE"],
      [{ events: [] }, "NO_EVENTS"],
      [{ events: [{ type: "something-else", sub: "001234.abcdef" }] }, "NO_EVENTS"]
    ] as const) {
      const variant = signedNotification({
        chain: trusted, leafKey: trusted.leafKey, payload: { ...payload, ...mutate }
      });
      assert.equal(verifier.verify(variant).verified, false, JSON.stringify(mutate));
      assert.deepEqual(verifier.verify(variant), { verified: false, reason });
    }
    const hs256 = signedNotification({
      chain: trusted, leafKey: trusted.leafKey, payload,
      headerOverride: { alg: "HS256" }
    });
    assert.deepEqual(verifier.verify(hs256), { verified: false, reason: "MALFORMED" });
    assert.deepEqual(verifier.verify("not-a-jws"), { verified: false, reason: "MALFORMED" });
    assert.deepEqual(verifier.verify("a.b.c"), { verified: false, reason: "MALFORMED" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("apple notifications: a revoked consent kills every session of that Apple subject", async () => {
  setShadowValidationEnabled(false);
  const directory = await mkdtemp(join(tmpdir(), "aed-apple-consent-"));
  const chainDirectory = await mkdtemp(join(tmpdir(), "aed-apple-chain-"));
  const dataFile = join(directory, "state.sqlite");
  try {
    const chain = await makeChain(chainDirectory);
    const config = {
      ...loadConfig({}), host: "127.0.0.1", port: 0, production: false, dataFile,
      enableControlledTestAccounts: true, authSubjectPepper: PEPPER,
      appleClientIds: [APP_ID], bootstrapLimitPerMinute: 1_000
    };
    const store = await SQLiteStateStore.open(dataFile, []);
    // The synthetic chain is trusted ONLY here, through the documented test option;
    // production composition always uses the verifier built on the embedded root.
    const backend = await createBackend({
      config, store, now: () => new Date(BASE),
      appleNotificationVerifier: new AppleServerNotificationVerifier({
        appId: APP_ID, trustedRoot: chain.root
      })
    });
    try {
      const address = await backend.start();
      const origin = `http://redacted-host.invalid`;
      const subject = "001234.abcdef.0001";
      const session = await backend.service.provisionControlledTestAccount("apple-consent-test");
      const accessToken = session.sessionToken;
      await store.transact(state => {
        const account = Object.values(state.accounts)[0]!;
        account.provider = "APPLE";
        account.providerSubjectHash = providerSubjectHash("APPLE", subject, PEPPER);
        account.appleRefreshToken = "apple-refresh-token";
      });
      assert.equal(backend.service.authenticateToken(accessToken).kind, "ACCOUNT");

      // 1. A forged body changes nothing: the endpoint is public, so this is the
      //    case that matters most.
      const forged = await fetch(`${origin}/api/v2/auth/apple/notifications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: "not-a-jws" })
      });
      assert.equal(forged.status, 400);
      assert.equal(backend.service.authenticateToken(accessToken).kind, "ACCOUNT",
        "an unverified notification must not revoke anything");
      const rejected = store.read(state => Object.values(state.securityLogById));
      assert.equal(rejected.some(entry => entry.reasonCode === "APPLE_NOTIFICATION_MALFORMED"), true,
        "the refusal is recorded as a class, without the body");

      // 2. A notification addressed to another app is refused as well.
      const wrongAudience = signedNotification({
        chain, leafKey: chain.leafKey,
        payload: { iss: "apple", aud: "com.example.someone.else",
          events: [{ type: "consent-revoked", sub: subject }] }
      });
      const wrongApp = await fetch(`${origin}/api/v2/auth/apple/notifications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: wrongAudience })
      });
      assert.equal(wrongApp.status, 400);
      assert.equal(backend.service.authenticateToken(accessToken).kind, "ACCOUNT");

      // 3. The verified notification revokes every session of that subject.
      const signed = signedNotification({
        chain, leafKey: chain.leafKey,
        payload: {
          iss: "apple", aud: APP_ID, jti: "notification-consent-1",
          events: [{ type: "consent-revoked", sub: subject, eventTime: BASE }]
        }
      });
      const accepted = await fetch(`${origin}/api/v2/auth/apple/notifications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: signed })
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { accepted: true });
      assert.throws(() => backend.service.authenticateToken(accessToken),
        /valid authenticated session is required/,
        "the phone that still holds the token can no longer act");
      const state = store.read(row => row);
      const account = Object.values(state.accounts)[0]!;
      assert.equal(account.appleRefreshToken, undefined,
        "the Apple refresh token is dropped with the revoked grant");
      assert.ok(account.appleTokenRevokedAt);
      assert.equal(Object.values(state.sessionsByTokenHash).every(row => row.revokedAt !== undefined),
        true, "every session of the subject is revoked");
      // The closure is auditable and counted, and the security log records the class.
      assert.equal(Object.values(state.accessAuditById)
        .some(entry => entry.reason.includes("apple notification revoked consent")), true);
      assert.equal(Object.values(state.securityLogById)
        .some(entry => entry.reasonCode === "APPLE_CONSENT_REVOKED"), true);

      // 4. Idempotent: a repeated delivery changes nothing and still succeeds.
      const before = store.read(row => JSON.stringify(Object.values(row.sessionsByTokenHash)));
      const repeat = await fetch(`${origin}/api/v2/auth/apple/notifications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: signed })
      });
      assert.equal(repeat.status, 200);
      assert.equal(store.read(row => JSON.stringify(Object.values(row.sessionsByTokenHash))), before,
        "Apple retries must not rewrite the revocation timestamps");

      // 5. An unknown subject is acknowledged without saying whether it is known.
      const unknown = signedNotification({
        chain, leafKey: chain.leafKey,
        payload: { iss: "apple", aud: APP_ID,
          events: [{ type: "consent-revoked", sub: "001234.nobody" }] }
      });
      const unknownResponse = await fetch(`${origin}/api/v2/auth/apple/notifications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: unknown })
      });
      assert.equal(unknownResponse.status, 200);
      assert.deepEqual(await unknownResponse.json(), { accepted: true },
        "the response never reveals whether the subject exists here");
    } finally {
      await backend.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(chainDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("apple notifications: the embedded trust anchor is Apple Root CA G3", () => {
  const root = new X509Certificate(APPLE_RECEIPT_ROOT_PEM);
  assert.equal(root.ca, true, "the trust anchor must be a CA");
  assert.match(root.subject, /Apple Root CA - G3/);
  // Pinned, so a swapped constant fails here instead of silently trusting a
  // different root in production.
  assert.equal(root.fingerprint256,
    "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79");
});
