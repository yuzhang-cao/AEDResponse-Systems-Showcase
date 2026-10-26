/**
 * G03 — the Watch attestation verifier is wired, and it refuses more than it
 * accepts.
 *
 * The requirement's boundary: the previous state was "configuring an app id does
 * not give you a verifier".  Now a verifier exists, so the tests that matter are
 * the negative ones — a verifier that accepts a malformed attestation is worse
 * than none, because the deployment believes it is protected.
 *
 * The trust anchors are Apple's published roots.  These tests do not have a real
 * attested Watch, so they check the trust material itself, the configuration
 * gates, and the refusal paths; a passing run here does NOT mean a physical Watch
 * was verified, and the report says so.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AppleWatchAttestationVerifier, verifyAppAttestBuildExtensions, verifyAppAttestReceipt } from "../src/apple-app-attest.js";
import { cborMap, readCBOR } from "../src/attestation-codecs.js";
import {
  APPLE_APP_ATTEST_ROOT_PEM,
  APPLE_RECEIPT_ROOT_PEM
} from "../src/apple-app-attest-roots.js";
import { companionLinkClientDataHash } from "../src/auth.js";

const APP_ID = "[TEAM].dev.codex.aedresponse.watch";
const BASE = "2026-09-05T00:00:00.000Z";

function officialSample() {
  const sample = JSON.parse(readFileSync(new URL("./fixtures/apple-app-attest-official.json", import.meta.url), "utf8"));
  const object = cborMap(readCBOR(Buffer.from(sample.attestationObject, "base64")).value);
  const statement = cborMap(object.get("attStmt")!);
  const auth = object.get("authData") as Buffer;
  const credential = new X509Certificate((statement.get("x5c") as Buffer[])[0]!);
  return { sample, auth, credential, receipt: statement.get("receipt") as Buffer };
}

test("Apple's signed example has valid build extensions with the ED flag unset", () => {
  const { auth } = officialSample();
  assert.equal(auth[32]! & 128, 0);
  const keyEnd = readCBOR(auth, 87).next;
  assert.equal(verifyAppAttestBuildExtensions(auth, keyEnd, [1], ["1"]), "1");
  assert.throws(() => verifyAppAttestBuildExtensions(auth, keyEnd, [3], ["1"]), /signing category/);
  assert.throws(() => verifyAppAttestBuildExtensions(auth, keyEnd, [1], ["2"]), /bundle version/);
  assert.throws(() => verifyAppAttestBuildExtensions(auth.subarray(0, keyEnd), keyEnd, [1], ["1"]));
});

test("Apple's real CMS receipt verifies without signed attributes and rejects tampering", () => {
  const { sample, credential, receipt } = officialSample();
  const root = new X509Certificate(APPLE_RECEIPT_ROOT_PEM);
  const check = (body: Buffer, appId = sample.appId, at = sample.at) =>
    verifyAppAttestReceipt(body, credential, appId, "production", root, new Date(at));
  assert.equal(check(receipt), "2026-04-21T18:13:12.153Z");
  assert.throws(() => check(receipt, "OTHER.app"), /context mismatch/);
  assert.throws(() => check(receipt, sample.appId, "2026-04-21T18:19:13.000Z"), /Stale/);
  const tampered = Buffer.from(receipt);
  const index = tampered.indexOf(Buffer.from(sample.appId));
  assert.ok(index > 0);
  tampered[index] = tampered[index]! ^ 1;
  assert.throws(() => check(tampered), /signature mismatch/);
});

function verifier(overrides: Partial<ConstructorParameters<typeof AppleWatchAttestationVerifier>[0]> = {}) {
  return new AppleWatchAttestationVerifier({
    appId: APP_ID,
    environment: "production",
    allowedBundleVersions: ["2.0"],
    now: () => new Date(BASE),
    ...overrides
  });
}

function request(overrides: Record<string, unknown> = {}) {
  const deviceInstanceId = "REDACTED-SUPPLEMENT-ID-bd7662a5eeb4";
  const companionPairId = "REDACTED-SUPPLEMENT-ID-b454f82c5857";
  const expectedChallenge = "a".repeat(64);
  return {
    appId: APP_ID,
    attestationObject: Buffer.from("not-a-real-attestation").toString("base64"),
    appAttestKeyId: "key-1",
    deviceInstanceId,
    companionPairId,
    userId: "user-1",
    accountId: "account-1",
    expectedChallenge,
    expectedClientDataHash: companionLinkClientDataHash({
      companionLinkTicketHash: expectedChallenge,
      deviceInstanceId,
      companionPairId
    }),
    ...overrides
  };
}

test("the embedded trust anchors are Apple's real roots", () => {
  const attestRoot = new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
  assert.equal(attestRoot.subject.replace(/\n/g, " "),
    "CN=Apple App Attestation Root CA O=Apple Inc. ST=California");
  // Fingerprint taken from Apple's published certificate; a swap of the anchor
  // must be a visible diff in the review, not a silent trust change.
  assert.equal(attestRoot.fingerprint256,
    "1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32");
  assert.equal(attestRoot.ca, true);
  const receiptRoot = new X509Certificate(APPLE_RECEIPT_ROOT_PEM);
  assert.equal(receiptRoot.ca, true);
  assert.ok(Date.parse(attestRoot.validTo) > Date.parse("2030-01-01T00:00:00Z"),
    "anchor 必须在可预见期内有效，否则发行前必须规划轮换");
});

test("a verifier cannot be constructed without an app id and bundle allowlist", () => {
  assert.throws(() => new AppleWatchAttestationVerifier({
    appId: "", environment: "production", allowedBundleVersions: ["2.0"]
  }), /App ID and allowed bundle versions/);
  assert.throws(() => new AppleWatchAttestationVerifier({
    appId: APP_ID, environment: "production", allowedBundleVersions: []
  }), /App ID and allowed bundle versions/);
  assert.throws(() => new AppleWatchAttestationVerifier({
    appId: APP_ID, environment: "production", allowedBundleVersions: ["  "]
  }), /App ID and allowed bundle versions/);
  // A non-CA "root" would make the chain check meaningless.
  assert.throws(() => verifier({ trustedAttestationRoot: "not a certificate" }));
});

test("a malformed or unbound attestation is refused, never accepted by default", async () => {
  const instance = verifier();
  const cases: Record<string, unknown>[] = [
    { attestationObject: Buffer.from("garbage").toString("base64") },
    { appId: "TEAM123456.other.app" },
    { expectedClientDataHash: "AAAA" },
    { expectedChallenge: "b".repeat(64) },
    { deviceInstanceId: "" },
    { companionPairId: "" },
    { userId: "" },
    { accountId: "" }
  ];
  for (const overrides of cases) {
    const result = await instance.verifyAttestation(request(overrides) as never);
    assert.equal(result.verified, false,
      `必须拒绝：${Object.keys(overrides).join(",")}`);
  }
});

test("a valid binding still fails without a genuine Apple attestation", async () => {
  // Everything the client controls is correct; only the Apple-signed material is
  // missing.  This is the case a real device would satisfy and a replay cannot.
  const result = await verifier().verifyAttestation(request() as never);
  assert.equal(result.verified, false);
  assert.equal(result.deviceInstanceId, undefined);
});

test("rejection diagnostics expose only a validation stage and cannot grant admission", async () => {
  const stages: string[] = [];
  const result = await verifier({ onRejection: stage => stages.push(stage) }).verifyAttestation(request());
  assert.equal(result.verified, false);
  assert.deepEqual(stages, ["envelope"]);
  assert.deepEqual(await verifier({ onRejection: () => { throw new Error("diagnostic failure"); } })
    .verifyAttestation(request()), { verified: false });
});

test("the verifier never echoes a caller-supplied device identity on failure", async () => {
  const result = await verifier().verifyAttestation(request() as never);
  assert.equal(result.verified, false);
  assert.equal("deviceInstanceId" in result && result.deviceInstanceId !== undefined, false,
    "失败时不得回显调用方声称的设备身份");
});

test("the expected client data hash is an independent derivation, not a passthrough", () => {
  // The derivation is base64 of a SHA-256 over a canonical JSON binding, which is
  // what the app and this verifier must agree on byte for byte.
  const deviceInstanceId = "REDACTED-SUPPLEMENT-ID-bd7662a5eeb4";
  const companionPairId = "REDACTED-SUPPLEMENT-ID-b454f82c5857";
  const first = companionLinkClientDataHash({
    companionLinkTicketHash: "a".repeat(64), deviceInstanceId, companionPairId
  });
  const second = companionLinkClientDataHash({
    companionLinkTicketHash: "a".repeat(64), deviceInstanceId,
    companionPairId: "REDACTED-SUPPLEMENT-ID-f6222a1106ee"
  });
  assert.notEqual(first, second, "换配对必须换 challenge 绑定");
  assert.equal(Buffer.from(first, "base64").length, 32, "必须是 32 字节摘要的 base64");
  assert.equal(Buffer.from(first, "base64").toString("base64"), first,
    "必须是规范 base64，否则客户端与服务端对不上");
});
