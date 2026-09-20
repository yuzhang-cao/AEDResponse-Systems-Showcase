/**
 * Apple authorization-code exchange and token revocation.
 *
 * Two obligations Apple places on an app that offers Sign in with Apple, and
 * neither is satisfied by verifying an identity token alone:
 *
 *   1. **Code exchange** — the authorization code the app receives proves the
 *      user actually completed the Apple flow for THIS client.  Exchanging it
 *      server-side yields the refresh token that must later be revoked, and
 *      confirms the token audience without trusting the client.
 *   2. **Token revocation** — Apple requires that deleting an account also
 *      revokes the Apple tokens issued to the app.  Without it the app keeps a
 *      live grant for an identity the user believes is gone.
 *
 * Both are PORTS.  The concrete implementation talks to Apple over HTTPS and can
 * only run with a real client secret; with no credentials the ports are absent
 * and the caller must record the gap instead of silently skipping it.  A failed
 * revocation is retried from durable state, because the user's request has
 * already been accepted by then.
 */
import { createSign } from "node:crypto";

export interface AppleTokenExchangeRequest {
  authorizationCode: string;
  /** Where Apple should redirect; must match the app's registered value. */
  redirectUri?: string;
}

export interface AppleTokenExchangeResult {
  /** Opaque refresh token Apple issues; the only handle for later revocation. */
  refreshToken: string;
  accessToken?: string;
  /** Seconds of validity Apple reported for the access token. */
  expiresInSeconds?: number;
}

export type AppleTokenRevocationResult =
  | { status: "REVOKED" }
  | { status: "ALREADY_INVALID" }
  | { status: "RETRY"; reason: string };

export interface AppleAccountPort {
  readonly name: string;
  isConfigured(): boolean;
  exchangeAuthorizationCode(
    request: AppleTokenExchangeRequest
  ): Promise<AppleTokenExchangeResult>;
  revokeToken(refreshToken: string): Promise<AppleTokenRevocationResult>;
}

/**
 * The honest default: no credentials, so no exchange and no revocation.
 *
 * It refuses rather than pretending, because a silent success here would mean an
 * account deletion that leaves Apple's grant intact — exactly the failure Apple's
 * requirement exists to prevent.
 */
export class UnavailableAppleAccountPort implements AppleAccountPort {
  readonly name = "unavailable";

  isConfigured(): boolean {
    return false;
  }

  async exchangeAuthorizationCode(): Promise<AppleTokenExchangeResult> {
    throw new Error("Apple authorization-code exchange is not configured");
  }

  async revokeToken(): Promise<AppleTokenRevocationResult> {
    return { status: "RETRY", reason: "PROVIDER_UNAVAILABLE" };
  }
}

/** The client secret Apple expects: an ES256 JWT signed with the .p8 key. */
export function appleClientSecret(input: {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKey: string;
  issuedAtSeconds: number;
  lifetimeSeconds?: number;
}): string {
  const lifetime = input.lifetimeSeconds ?? 15_552_000; // Apple's maximum is ~6 months.
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: input.keyId }))
    .toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: input.teamId,
    iat: input.issuedAtSeconds,
    exp: input.issuedAtSeconds + lifetime,
    aud: "https://appleid.apple.com",
    sub: input.clientId
  })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ key: input.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export interface AppleAccountCredentials {
  teamId: string;
  keyId: string;
  /** The Services ID / app bundle id Apple issued the code for. */
  clientId: string;
  keyPath: string;
  redirectUri?: string;
}

const TEN_CHARACTER_ID = /^[A-Z0-9]{10}$/;

export function appleAccountCredentialsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): { credentials?: AppleAccountCredentials; problems: string[] } {
  const teamId = env.AED_APPLE_TEAM_ID?.trim();
  const keyId = env.AED_APPLE_KEY_ID?.trim();
  const clientId = env.AED_APPLE_CLIENT_ID?.trim();
  const keyPath = env.AED_APPLE_KEY_PATH?.trim();
  const redirectUri = env.AED_APPLE_REDIRECT_URI?.trim();
  const configured = [teamId, keyId, clientId, keyPath].filter(Boolean);
  if (configured.length === 0) return { problems: [] };
  const problems: string[] = [];
  if (configured.length !== 4) {
    problems.push(
      "Apple 账号凭据不完整：需要同时配置 AED_APPLE_TEAM_ID、AED_APPLE_KEY_ID、"
      + "AED_APPLE_CLIENT_ID、AED_APPLE_KEY_PATH"
    );
    return { problems };
  }
  if (!TEN_CHARACTER_ID.test(teamId!)) problems.push("AED_APPLE_TEAM_ID must be a 10-character team id");
  if (!TEN_CHARACTER_ID.test(keyId!)) problems.push("AED_APPLE_KEY_ID must be a 10-character key id");
  if (problems.length > 0) return { problems };
  return {
    credentials: {
      teamId: teamId!, keyId: keyId!, clientId: clientId!, keyPath: keyPath!,
      ...(redirectUri ? { redirectUri } : {})
    },
    problems: []
  };
}

/**
 * The real Apple account client.
 *
 * `fetchImpl` and `readKey` are injected so the request shape, the error mapping
 * and the retry classification can be tested without Apple or a real key.
 */
export class AppleAccountClient implements AppleAccountPort {
  readonly name = "apple";

  constructor(
    private readonly credentials: AppleAccountCredentials,
    private readonly readKey: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date()
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async exchangeAuthorizationCode(
    request: AppleTokenExchangeRequest
  ): Promise<AppleTokenExchangeResult> {
    const key = await this.readKey();
    const secret = appleClientSecret({
      teamId: this.credentials.teamId,
      keyId: this.credentials.keyId,
      clientId: this.credentials.clientId,
      privateKey: key,
      issuedAtSeconds: Math.floor(this.now().getTime() / 1_000)
    });
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: secret,
      code: request.authorizationCode,
      grant_type: "authorization_code",
      ...(request.redirectUri ?? this.credentials.redirectUri
        ? { redirect_uri: (request.redirectUri ?? this.credentials.redirectUri)! }
        : {})
    });
    const response = await this.fetchImpl("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Apple code exchange failed with status ${response.status}`);
    }
    let parsed: { refresh_token?: unknown; access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error("Apple code exchange returned an unreadable body");
    }
    if (typeof parsed.refresh_token !== "string" || !parsed.refresh_token) {
      throw new Error("Apple code exchange returned no refresh token");
    }
    return {
      refreshToken: parsed.refresh_token,
      ...(typeof parsed.access_token === "string" ? { accessToken: parsed.access_token } : {}),
      ...(typeof parsed.expires_in === "number" ? { expiresInSeconds: parsed.expires_in } : {})
    };
  }

  async revokeToken(refreshToken: string): Promise<AppleTokenRevocationResult> {
    let key: string;
    try {
      key = await this.readKey();
    } catch {
      return { status: "RETRY", reason: "KEY_UNREADABLE" };
    }
    const secret = appleClientSecret({
      teamId: this.credentials.teamId,
      keyId: this.credentials.keyId,
      clientId: this.credentials.clientId,
      privateKey: key,
      issuedAtSeconds: Math.floor(this.now().getTime() / 1_000)
    });
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: secret,
      token: refreshToken,
      token_type_hint: "refresh_token"
    });
    try {
      const response = await this.fetchImpl("https://appleid.apple.com/auth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
      if (response.ok) return { status: "REVOKED" };
      // Apple answers 400 invalid_grant when the grant is already gone; that is
      // the desired end state, not a failure to retry.
      const text = await response.text().catch(() => "");
      if (response.status === 400 && /invalid_grant|invalid_token/.test(text)) {
        return { status: "ALREADY_INVALID" };
      }
      if (response.status === 429 || response.status >= 500) {
        return { status: "RETRY", reason: `HTTP_${response.status}` };
      }
      return { status: "ALREADY_INVALID" };
    } catch {
      return { status: "RETRY", reason: "TRANSPORT" };
    }
  }
}
