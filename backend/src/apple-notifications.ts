/**
 * G02 — Apple's server-to-server notification: the only channel that tells us the
 * user revoked their Sign in with Apple consent.
 *
 * When a person revokes the app's access in iOS Settings, the app itself is gone
 * from their device: it cannot call us, and it will never log out.  The server
 * learns about it from a signed notification Apple posts to a public endpoint, and
 * until that is handled the person's sessions stay alive after they withdrew
 * consent — the exact failure this module exists to prevent.
 *
 * The rules follow from "a public endpoint that revokes access":
 *
 *   - **Verify before parsing.**  The body is a compact JWS with an `x5c` chain
 *     rooted at Apple's Root CA G3.  The chain, the validity windows and the
 *     signature are all checked against an EMBEDDED root — never a root supplied in
 *     the request — and `iss`/`aud` must match this deployment.  An unverified body
 *     is refused, not partially trusted.
 *   - **The body carries no credential.**  It carries an Apple subject, which this
 *     deployment can only match through its own peppered hash.  There is no token to
 *     steal here, and the response never echoes anything back.
 *   - **Every effect is idempotent.**  Apple retries notifications, so revocation is
 *     written as "revoked at the earliest known time", and a repeated delivery
 *     changes nothing.
 */
import { X509Certificate, verify as verifySignature } from "node:crypto";
import { APPLE_RECEIPT_ROOT_PEM } from "./apple-app-attest-roots.js";

/** The event types Apple sends for Sign in with Apple. */
export const APPLE_NOTIFICATION_TYPES = [
  "consent-revoked",
  "account-deleted",
  "email-disabled",
  "email-enabled"
] as const;
export type AppleNotificationType = typeof APPLE_NOTIFICATION_TYPES[number];

export interface AppleServerNotificationEvent {
  type: AppleNotificationType;
  /** Apple's stable user identifier (`sub`), matched by hash, never stored raw. */
  subject: string;
  eventTime?: number;
}

export interface AppleServerNotification {
  issuer: string;
  audience?: string;
  notificationId?: string;
  events: AppleServerNotificationEvent[];
}

export type AppleNotificationFailure =
  | "MALFORMED"
  | "UNTRUSTED_CHAIN"
  | "BAD_SIGNATURE"
  | "WRONG_ISSUER"
  | "WRONG_AUDIENCE"
  | "NO_EVENTS";

export type AppleNotificationVerification =
  | { verified: true; notification: AppleServerNotification }
  | { verified: false; reason: AppleNotificationFailure };

interface JwsHeader {
  alg?: string;
  x5c?: string[];
}

function decodeBase64URL(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies Apple's signed notification.
 *
 * The trusted root is an option only so a test can supply its own chain; production
 * always uses the embedded Apple Root CA G3, because a caller-supplied root would
 * make the whole check decorative.
 */
export class AppleServerNotificationVerifier {
  private readonly root: X509Certificate;
  constructor(private readonly options: {
    /** The app id Apple was told about; `aud` must match it when set. */
    appId?: string;
    trustedRoot?: string | Buffer;
    now?: () => Date;
  } = {}) {
    // APPLE_RECEIPT_ROOT_PEM is Apple Root CA - G3, the root that signs both the
    // receipt chain and the Sign in with Apple notification chain.
    this.root = new X509Certificate(options.trustedRoot ?? APPLE_RECEIPT_ROOT_PEM);
  }

  verify(signedPayload: string): AppleNotificationVerification {
    const parts = signedPayload.split(".");
    if (parts.length !== 3 || parts.some(part => part.length === 0)) {
      return { verified: false, reason: "MALFORMED" };
    }
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    let header: JwsHeader;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(decodeBase64URL(headerPart).toString("utf8")) as JwsHeader;
      payload = JSON.parse(decodeBase64URL(payloadPart).toString("utf8")) as Record<string, unknown>;
    } catch {
      return { verified: false, reason: "MALFORMED" };
    }
    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 2) {
      // Apple signs these with ES256 and always includes a chain; anything else is
      // either a different product or an attempt to change the algorithm.
      return { verified: false, reason: "MALFORMED" };
    }
    const now = (this.options.now ?? (() => new Date()))();
    let chain: X509Certificate[];
    try {
      chain = header.x5c.map(entry => new X509Certificate(Buffer.from(entry, "base64")));
    } catch {
      return { verified: false, reason: "UNTRUSTED_CHAIN" };
    }
    // Leaf first: every certificate must be valid now and be signed by the next one,
    // and the last must be signed by the embedded root.
    for (const [index, certificate] of chain.entries()) {
      const validity = { from: Date.parse(certificate.validFrom), to: Date.parse(certificate.validTo) };
      if (!Number.isFinite(validity.from) || !Number.isFinite(validity.to)
        || now.getTime() < validity.from || now.getTime() > validity.to) {
        return { verified: false, reason: "UNTRUSTED_CHAIN" };
      }
      const issuer = chain[index + 1] ?? this.root;
      // A CA flag is required on every issuer, including the root.
      if (!issuer.ca) return { verified: false, reason: "UNTRUSTED_CHAIN" };
      if (!certificate.verify(issuer.publicKey)) {
        return { verified: false, reason: "UNTRUSTED_CHAIN" };
      }
    }
    const leaf = chain[0]!;
    if (leaf.ca) return { verified: false, reason: "UNTRUSTED_CHAIN" };
    const signature = decodeBase64URL(signaturePart);
    if (signature.length === 0) return { verified: false, reason: "MALFORMED" };
    let signed = false;
    try {
      signed = verifySignature(
        "sha256",
        Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
        // ES256 signatures in a JWS are raw r||s, not DER.  The certificate already
        // exposes a public KeyObject, so it is used directly: wrapping it in
        // `createPublicKey` throws for an already-public key, which would turn every
        // valid notification into BAD_SIGNATURE.
        { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
        signature
      );
    } catch {
      signed = false;
    }
    if (!signed) return { verified: false, reason: "BAD_SIGNATURE" };

    if (payload["iss"] !== "apple") return { verified: false, reason: "WRONG_ISSUER" };
    const audience = typeof payload["aud"] === "string" ? payload["aud"] : undefined;
    if (this.options.appId && audience !== this.options.appId) {
      // A notification addressed to another app must not revoke sessions here.
      return { verified: false, reason: "WRONG_AUDIENCE" };
    }
    const events = this.eventsOf(payload);
    if (events.length === 0) return { verified: false, reason: "NO_EVENTS" };
    return {
      verified: true,
      notification: {
        issuer: "apple",
        ...(audience ? { audience } : {}),
        ...(typeof payload["jti"] === "string" ? { notificationId: payload["jti"] } : {}),
        events
      }
    };
  }

  /**
   * Reads the events from either envelope Apple uses.
   *
   * The current format is an `events` array; a single top-level `{type, sub}` is
   * still accepted, because refusing a valid older shape would silently drop a
   * consent revocation.
   */
  private eventsOf(payload: Record<string, unknown>): AppleServerNotificationEvent[] {
    const events: AppleServerNotificationEvent[] = [];
    const push = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      const type = record["type"];
      const subject = record["sub"];
      if (typeof type !== "string" || !(APPLE_NOTIFICATION_TYPES as readonly string[]).includes(type)) return;
      if (typeof subject !== "string" || subject.length === 0) return;
      const eventTime = record["eventTime"];
      events.push({
        type: type as AppleNotificationType,
        subject,
        ...(typeof eventTime === "number" && Number.isFinite(eventTime) ? { eventTime } : {})
      });
    };
    if (Array.isArray(payload["events"])) {
      for (const entry of payload["events"]) push(entry);
    } else {
      push(payload);
    }
    return events;
  }
}
