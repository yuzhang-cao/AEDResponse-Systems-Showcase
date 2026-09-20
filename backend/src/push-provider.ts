/**
 * APNs delivery, behind a port.
 *
 * The backend's job is to *hand a notification to the provider*, not to claim the
 * user saw it.  Three distinct facts exist along this path and they must never be
 * conflated:
 *
 *   1. the provider accepted the request (or refused it, with a reason);
 *   2. the operating system presented something to the user;
 *   3. the user opened it and the app reached a business fact over REST.
 *
 * Only (1) is observable here, plus a durable record of the attempt.  (2) and (3)
 * belong to the device.  `providers` are therefore allowed to be unavailable:
 * with no credentials configured, `NullPushProvider` reports the reason and the
 * durable outbox keeps the row, so a later real provider can still deliver it.
 *
 * Payload discipline: a push body leaves the device and passes through Apple, so
 * it carries an opaque identifier and a generic sentence only.  No coordinates,
 * no names, no addresses, no AED details.  Everything else is fetched over
 * authenticated REST after the tap.
 */
import type { NotificationName, NotificationRecord } from "./models.js";

export type PushEnvironment = "SANDBOX" | "PRODUCTION";

export interface PushDeliveryRequest {
  /** Routing credential for one installation. */
  token: string;
  environment: PushEnvironment;
  bundleId: string;
  /** Opaque identifiers only. */
  messageId: string;
  eventId: string;
  /** Notification name, so the app can pick an icon/category without a payload. */
  name: NotificationName;
  /**
   * Whether the system may play a sound.  Patient-facing emergencies are audible;
   * coordination chatter is not.
   */
  audible: boolean;
}

export type PushDeliveryOutcome =
  | { status: "DELIVERED" }
  | { status: "RETRY"; reason: PushFailureReason }
  | { status: "PERMANENT"; reason: PushFailureReason }
  /** The token no longer addresses an installation; the caller must forget it. */
  | { status: "INVALID_TOKEN"; reason: PushFailureReason };

export type PushFailureReason =
  | "PROVIDER_UNAVAILABLE"
  | "BAD_DEVICE_TOKEN"
  | "UNREGISTERED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "TRANSPORT"
  | "UNKNOWN";

export interface PushProvider {
  readonly name: string;
  /** Whether this provider can actually reach APNs right now. */
  isConfigured(): boolean;
  send(request: PushDeliveryRequest): Promise<PushDeliveryOutcome>;
}

/**
 * The honest default: no credentials, no delivery, no false success.
 *
 * It reports `PROVIDER_UNAVAILABLE` as RETRY so the durable outbox keeps the row
 * and a configured provider can deliver it later, instead of marking a
 * notification delivered that never left the process.
 */
export class NullPushProvider implements PushProvider {
  readonly name = "null";

  isConfigured(): boolean {
    return false;
  }

  async send(): Promise<PushDeliveryOutcome> {
    return { status: "RETRY", reason: "PROVIDER_UNAVAILABLE" };
  }
}

/**
 * Which notification names are allowed to make a sound.
 *
 * The requirement separates an emergency that wakes the patient from routine
 * coordination updates that must not.  Keeping the decision here means the
 * outbox does not have to know the business vocabulary, and a new notification
 * name has to be classified deliberately rather than inheriting "audible".
 */
const AUDIBLE_NOTIFICATIONS: ReadonlySet<NotificationName> = new Set([
  "event:patient-activated",
  "response:requested",
  "event:status-confirmation-requested",
  "event:resolved",
  "event:false-alarm-confirmed",
  "event:assistance-withdrawn",
  "event:closed-unconfirmed-no-response"
]);

export function pushIsAudible(name: NotificationName): boolean {
  return AUDIBLE_NOTIFICATIONS.has(name);
}

/**
 * Builds the APNs-visible body for one durable outbox row.
 *
 * Returns `undefined` when the row is not pushable at all (no token), which the
 * caller treats as "socket-only", not as a failure.
 */
export function pushRequestFor(
  row: Pick<NotificationRecord, "name" | "payload" | "id">,
  registration: { token: string; environment: PushEnvironment; bundleId: string }
): PushDeliveryRequest {
  return {
    token: registration.token,
    environment: registration.environment,
    bundleId: registration.bundleId,
    messageId: row.id,
    eventId: String(row.payload.eventId ?? ""),
    name: row.name,
    audible: pushIsAudible(row.name)
  };
}

/**
 * The payload actually sent to APNs.  Exported so a test can assert that nothing
 * identifying ever appears in it.
 */
export function pushPayloadFor(request: PushDeliveryRequest): Record<string, unknown> {
  return {
    aps: {
      alert: {
        title: "AEDResponse",
        body: request.audible
          ? "有一项需要你处理的救助协同事项。"
          : "协同状态已更新。"
      },
      ...(request.audible ? { sound: "default" } : {}),
      "thread-id": request.eventId
    },
    // Opaque identifiers only; the app resolves everything else over REST.
    messageId: request.messageId,
    eventId: request.eventId,
    name: request.name
  };
}

/**
 * APNs configuration, read from the environment once and validated up front.
 *
 * A half-configured provider is worse than none: it would look enabled and fail
 * every send.  `fromEnvironment` therefore returns `undefined` unless the whole
 * credential set is present and well formed, and the caller falls back to the
 * null provider with a recorded reason.
 *
 * The .p8 key is a SECRET: it is read from a path, never logged, and never
 * returned by any endpoint.  Token-based (JWT) authentication is used because it
 * needs no per-connection certificate and the same key serves every APNs host.
 */
export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  /** Path to the .p8 signing key, readable only by the service account. */
  keyPath: string;
  /** Topic = the app's bundle id; a token is only valid for its own topic. */
  bundleId: string;
  /** Which APNs host family to send to when the registration does not say. */
  defaultEnvironment: PushEnvironment;
}

const KEY_ID = /^[A-Z0-9]{10}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export function apnsCredentialsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): { credentials?: ApnsCredentials; problems: string[] } {
  const problems: string[] = [];
  const keyId = env.AED_APNS_KEY_ID?.trim();
  const teamId = env.AED_APNS_TEAM_ID?.trim();
  const keyPath = env.AED_APNS_KEY_PATH?.trim();
  const bundleId = env.AED_APNS_BUNDLE_ID?.trim();
  const defaultEnvironment = env.AED_APNS_ENVIRONMENT?.trim();
  const names = ["AED_APNS_KEY_ID", "AED_APNS_TEAM_ID", "AED_APNS_KEY_PATH", "AED_APNS_BUNDLE_ID"];
  const present = [keyId, teamId, keyPath, bundleId].filter(Boolean).length;
  if (present === 0) return { problems: [] };
  if (present !== names.length) {
    problems.push(`APNs 凭据不完整：需要同时配置 ${names.join("、")}`);
    return { problems };
  }
  if (!KEY_ID.test(keyId!)) problems.push("AED_APNS_KEY_ID must be a 10-character Apple key id");
  if (!TEAM_ID.test(teamId!)) problems.push("AED_APNS_TEAM_ID must be a 10-character Apple team id");
  if (!bundleId!.includes(".")) problems.push("AED_APNS_BUNDLE_ID must be a bundle identifier");
  if (defaultEnvironment !== undefined
    && defaultEnvironment !== "SANDBOX"
    && defaultEnvironment !== "PRODUCTION") {
    problems.push("AED_APNS_ENVIRONMENT must be SANDBOX or PRODUCTION");
  }
  if (problems.length > 0) return { problems };
  return {
    credentials: {
      keyId: keyId!,
      teamId: teamId!,
      keyPath: keyPath!,
      bundleId: bundleId!,
      defaultEnvironment: defaultEnvironment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX"
    },
    problems: []
  };
}

/** APNs host per environment.  A token is only accepted by its own host. */
export function apnsHostFor(environment: PushEnvironment): string {
  return environment === "PRODUCTION"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

/**
 * Maps an APNs HTTP/2 response onto a delivery outcome.
 *
 * The `reason` string is Apple's own vocabulary, so "unregistered"/"BadDeviceToken"
 * are the two facts that mean "forget this token" and everything else is either
 * retryable or permanent.  Being explicit here is what stops a permanent failure
 * from being retried forever or an invalid token from being kept.
 */
export function pushOutcomeForStatus(
  status: number,
  body: string
): PushDeliveryOutcome {
  const reason = /"reason"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  if (status === 200) return { status: "DELIVERED" };
  if (reason === "Unregistered" || reason === "BadDeviceToken" || status === 410) {
    return { status: "INVALID_TOKEN", reason: reason === "BadDeviceToken" ? "BAD_DEVICE_TOKEN" : "UNREGISTERED" };
  }
  if (reason === "PayloadTooLarge") return { status: "PERMANENT", reason: "PAYLOAD_TOO_LARGE" };
  if (status === 429) return { status: "RETRY", reason: "RATE_LIMITED" };
  if (status >= 500) return { status: "RETRY", reason: "TRANSPORT" };
  return { status: "PERMANENT", reason: "UNKNOWN" };
}

/**
 * The real APNs client.
 *
 * Deliberately thin: it builds the request, sends it over HTTP/2 with a JWT
 * bearer, and maps the response.  Retry policy stays with the durable outbox, so
 * a transient failure here just reports `RETRY` and the row keeps its place.
 *
 * Requirements this cannot satisfy locally and that are therefore recorded as
 * external conditions rather than silently assumed:
 *   - a real Apple developer key (.p8) with the APNs capability enabled;
 *   - network reachability to api.push.apple.com;
 *   - a physical device token from a signed build (a simulator has none).
 */
export class ApnsPushProvider implements PushProvider {
  readonly name = "apns";
  private cachedToken: { value: string; issuedAt: number } | undefined;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly readKey: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly signJwt: (input: {
      keyId: string; teamId: string; privateKey: string; issuedAtSeconds: number;
    }) => Promise<string> = defaultApnsJwt,
    private readonly now: () => Date = () => new Date()
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async send(request: PushDeliveryRequest): Promise<PushDeliveryOutcome> {
    let authorization: string;
    try {
      authorization = await this.bearer();
    } catch {
      // A key that cannot be read is an operator problem, not a token problem.
      return { status: "RETRY", reason: "PROVIDER_UNAVAILABLE" };
    }
    const payload = JSON.stringify(pushPayloadFor(request));
    if (Buffer.byteLength(payload) > 4 * 1024) {
      return { status: "PERMANENT", reason: "PAYLOAD_TOO_LARGE" };
    }
    try {
      const response = await this.fetchImpl(
        `${apnsHostFor(request.environment ?? this.credentials.defaultEnvironment)}/3/device/${request.token}`,
        {
          method: "POST",
          headers: {
            authorization,
            "apns-topic": request.bundleId || this.credentials.bundleId,
            "apns-push-type": "alert",
            // Collapse duplicates per event: a stale alert for an event the user
            // already handled must not pile up on the lock screen.
            "apns-collapse-id": request.eventId.slice(0, 64),
            ...(request.audible ? { "apns-priority": "10" } : { "apns-priority": "5" })
          },
          body: payload
        }
      );
      const text = await response.text().catch(() => "");
      return pushOutcomeForStatus(response.status, text);
    } catch {
      return { status: "RETRY", reason: "TRANSPORT" };
    }
  }

  /** APNs accepts a provider token for up to an hour; refresh well before that. */
  private async bearer(): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    if (this.cachedToken && nowSeconds - this.cachedToken.issuedAt < 2_400) {
      return `bearer ${this.cachedToken.value}`;
    }
    const key = await this.readKey();
    const value = await this.signJwt({
      keyId: this.credentials.keyId,
      teamId: this.credentials.teamId,
      privateKey: key,
      issuedAtSeconds: nowSeconds
    });
    this.cachedToken = { value, issuedAt: nowSeconds };
    return `bearer ${value}`;
  }
}

/** ES256 JWT as APNs specifies it.  Kept separate so it can be unit-tested. */
export async function defaultApnsJwt(input: {
  keyId: string; teamId: string; privateKey: string; issuedAtSeconds: number;
}): Promise<string> {
  const { createSign } = await import("node:crypto");
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const claims = base64Url(JSON.stringify({ iss: input.teamId, iat: input.issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;
  // APNs mandates the raw (IEEE-P1363) ECDSA form, which Node calls "ieee-p1363".
  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ key: input.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
