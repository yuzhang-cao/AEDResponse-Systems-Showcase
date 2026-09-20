import { createHash, createHmac } from "node:crypto";

/**
 * CONTROLLED_TEST is operator-provisioned and disabled unless explicitly enabled.
 *
 * PHONE was removed on 2026-09-13: the product offers Apple sign-in only, so
 * there is no SMS port to inject and no phone number to normalize or store.
 */
export type AccountProvider = "APPLE" | "CONTROLLED_TEST";

export interface AppleIdentity {
  /** The stable Apple `sub` claim after a real verifier has checked the token. */
  subject: string;
}

export interface AppleIdentityTokenVerificationRequest {
  identityToken: string;
  authorizationCode?: string | undefined;
  nonce: string;
  challengeId?: string | undefined;
}

export interface AppleLoginChallenge {
  provider: "APPLE";
  challengeId: string;
  nonce: string;
  expiresAt: string;
}

/**
 * Apple identity-token verification is intentionally a port. The backend never
 * decodes or trusts an unsigned JWT and never persists the supplied token.
 */
export interface AppleIdentityTokenVerifier {
  createChallenge?: () => Promise<AppleLoginChallenge>;
  verifyIdentityToken: (
    input: AppleIdentityTokenVerificationRequest
  ) => Promise<AppleIdentity>;
}

export interface WatchAttestationVerificationRequest {
  appAttestKeyId: string;
  attestationObject: string;
  deviceInstanceId: string;
  companionPairId: string;
  userId: string;
  accountId: string;
  expectedChallenge: string;
  expectedClientDataHash: string;
  appId: string;
}

export interface WatchAttestationVerification {
  /** A verifier must explicitly attest success; absence never means success. */
  verified: boolean;
  /**
   * The verified Watch identity, present ONLY on success.
   *
   * It used to be required even on failure, which let a refused attestation carry
   * the device id the caller had claimed — indistinguishable, to a caller that
   * only checks for the field, from a verified binding.  A failure now carries no
   * identity at all.
   */
  deviceInstanceId?: string;
  /** Opaque verified material (key hash, receipt, bundle version) on success. */
  evidence?: VerifiedWatchEvidence;
}

/** Extra facts a successful attestation yields; never present on failure. */
export interface VerifiedWatchEvidence {
  keyHash: string;
  publicKey: string;
  receipt: string;
  receiptCreatedAt: string;
  appId: string;
  environment: "production" | "development";
  bundleVersion: string;
}

/**
 * Watch App Attest/attestation is intentionally a port. The reference backend
 * does not decode, verify, or persist an attestation object.
 */
export interface WatchAttestationVerifier {
  verifyAttestation: (
    input: WatchAttestationVerificationRequest
  ) => Promise<WatchAttestationVerification>;
}

export interface CompanionLinkClientData {
  companionLinkTicketHash: string;
  deviceInstanceId: string;
  companionPairId: string;
  /** Optional server-side context is accepted for callers but is not client data. */
  userId?: string;
  accountId?: string;
}

/** Deterministic App Attest client-data hash; raw tickets never enter the payload. */
export function companionLinkClientDataHash(input: CompanionLinkClientData): string {
  const canonical = JSON.stringify({
    purpose: "AEDResponse.watch-companion-link",
    companionLinkTicketHash: input.companionLinkTicketHash,
    deviceInstanceId: input.deviceInstanceId,
    companionPairId: input.companionPairId
  });
  return createHash("sha256").update(canonical).digest("base64");
}

/**
 * Account lookup uses a provider-scoped HMAC digest. The canonical phone
 * number, Apple subject and identity token are never persisted in state.
 */
export function providerSubjectHash(
  provider: AccountProvider,
  subject: string,
  pepper: string
): string {
  if (!pepper) throw new Error("An authentication subject pepper is required");
  return createHmac("sha256", pepper)
    .update(`${provider}\u0000${subject}`)
    .digest("hex");
}
