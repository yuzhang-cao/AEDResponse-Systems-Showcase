/**
 * Shared harness for the AEDResponse v2 smoke suites.
 *
 * A smoke run is deliberately narrow: it starts one throwaway backend on
 * loopback port 0 with an in-memory store, then drives the real HTTP REST and
 * Socket.IO surface through the single critical path (login gate -> Watch fall
 * trigger -> recruitment -> response -> AED -> end). It is not a substitute for
 * the full suites in `backend/test/*.test.ts`; it answers "is this build
 * fundamentally broken" in one short, readable report.
 */
import { readFile } from "node:fs/promises";
import { io, type Socket } from "socket.io-client";
import { DeterministicPhoneChallengeProvider } from "../../src/auth.js";
import type { BackendConfig } from "../../src/config.js";
import type { Aed } from "../../src/contracts.js";
import { emptyState } from "../../src/models.js";
import { createBackend, type BackendInstance } from "../../src/server.js";
import { MemoryStateStore } from "../../src/store.js";

export const ENGINEERING_ROOT = new URL("../../../", import.meta.url);
export const DEMO_FIXTURE = new URL("contracts/fixtures/demo-scenario.json", ENGINEERING_ROOT);
export const OPENAPI_FILE = new URL("contracts/openapi.yaml", ENGINEERING_ROOT);

/** Deterministic UUIDs keep smoke output greppable and diffable. */
export function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

export function engineeringPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

export class SmokeFailure extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "SmokeFailure";
  }
}

export function violate(message: string, detail?: string): never {
  throw new SmokeFailure(message, detail);
}

export function check(condition: unknown, message: string, detail?: string): void {
  if (!condition) violate(message, detail);
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    violate(message, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

export function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) violate(message, `expected ${right}, received ${left}`);
}

export interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  contentType: string;
}

export interface SessionBody {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  scopes: string[];
  userId?: string;
  accountId?: string;
}

/** Shape of the REST event projection fields the smoke path depends on. */
export interface EventProjection {
  eventId: string;
  state: string;
  recruitmentState?: string;
  viewerRelationship?: string;
  canPublishEventPosition?: boolean;
  patientPosition?: { latitude: number; longitude: number; kind: string } | null;
  patientPositionSource?: string;
  pendingResponseRequest?: { deliveryId: string; expiresAt: string } | null;
  currentAssignment?: {
    id: string;
    role: "GO_TO_PATIENT" | "FETCH_AED";
    status: string;
    route?: { aedId: string; path: Array<{ kind: string }> } | null;
    aedAcquiredReceipt?: { receiptId: string } | null;
  } | null;
  eventPositionParticipationStartedAt?: string | null;
  [key: string]: unknown;
}

export interface SmokeHarnessOptions {
  config?: Partial<BackendConfig>;
  aeds?: Aed[];
}

export interface SmokeHarness {
  backend: BackendInstance;
  baseURL: string;
  now: () => Date;
  iso(offsetSeconds: number): string;
  setServerOffset(offsetSeconds: number): void;
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<JsonResponse<T>>;
  login(phoneNumber: string): Promise<string>;
  bootstrapIPhone(deviceInstanceId: string, companionPairId: string): Promise<SessionBody>;
  /** The Watch has no login form; it redeems a ticket from the paired iPhone session. */
  bootstrapWatch(
    deviceInstanceId: string,
    companionPairId: string,
    iPhoneSessionToken: string
  ): Promise<SessionBody>;
  publishResponderPosition(token: string, latitude: number, longitude: number): Promise<string>;
  events(token: string): Promise<EventProjection[]>;
  event(eventId: string, token: string): Promise<EventProjection>;
  pendingDeliveryId(eventId: string, token: string): Promise<string>;
  connectIPhone(token: string): Promise<Socket>;
  nextSocketEvent(socket: Socket, name: string, label: string): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

const SMOKE_PHONE_CODE = "246810";
const BOOTSTRAP_AGREEMENTS = [
  "PATIENT",
  "VOLUNTEER_RESPONDER",
  "PRIVACY_POLICY",
  "SENSITIVE_PERSONAL_INFORMATION"
] as const;

let positionSequence = 90_000;

/** Derives a stable, collision-resistant E.164 test number from a device UUID. */
export function smokePhoneNumber(deviceInstanceId: string): string {
  let hash = 0;
  for (const character of deviceInstanceId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000_000;
  }
  return `+86138${hash.toString().padStart(8, "0")}`;
}

export function smokeConfig(
  dataFile: string,
  overrides: Partial<BackendConfig> = {}
): BackendConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataFile,
    fixtureFile: engineeringPath(DEMO_FIXTURE),
    sessionTtlSeconds: 3_600,
    // A tight ring keeps three loopback responders inside the first search ring.
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    authSubjectPepper: "smoke-test-pepper",
    watchAppAttestAppId: "TEAMID.com.aedresponse",
    operatorToken: "operator-smoke-token",
    production: false,
    ...overrides
  };
}

export async function startSmokeHarness(
  options: SmokeHarnessOptions = {}
): Promise<SmokeHarness> {
  const epoch = Math.floor(Date.now() / 1_000) * 1_000;
  let serverOffsetSeconds = 0;
  const now = (): Date => new Date(epoch + serverOffsetSeconds * 1_000);
  const store = options.aeds
    ? new MemoryStateStore(emptyState(options.aeds))
    : new MemoryStateStore(emptyState());
  const backend = await createBackend({
    config: smokeConfig("/tmp/aedresponse-smoke-unused.json", options.config),
    store,
    phoneChallengeProvider: new DeterministicPhoneChallengeProvider(SMOKE_PHONE_CODE, now),
    watchAttestationVerifier: {
      verifyAttestation: async input => ({
        verified: input.attestationObject === "d2F0Y2gtYXR0ZXN0YXRpb24=",
        deviceInstanceId: input.deviceInstanceId
      })
    },
    now
  });
  await backend.start();
  const baseURL = backend.baseURL();

  const harness: SmokeHarness = {
    backend,
    baseURL,
    now,
    iso: offsetSeconds => new Date(epoch + offsetSeconds * 1_000).toISOString(),
    setServerOffset: offsetSeconds => { serverOffsetSeconds = offsetSeconds; },
    request: async <T = Record<string, unknown>>(
      method: string,
      path: string,
      body?: unknown,
      token?: string
    ): Promise<JsonResponse<T>> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${baseURL}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text.trim().length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          violate(`${method} ${path} returned a non-JSON body`, text.slice(0, 200));
        }
      }
      return {
        status: response.status,
        body: parsed as T,
        contentType: response.headers.get("content-type") ?? ""
      };
    },
    async login(phoneNumber) {
      const challenge = await harness.request<{ challengeId: string }>(
        "POST",
        "/api/v2/auth/phone/challenges",
        { phoneNumber }
      );
      if (challenge.status !== 201) {
        violate(`phone challenge for ${phoneNumber} failed`, JSON.stringify(challenge.body));
      }
      const verified = await harness.request<SessionBody>("POST", "/api/v2/auth/phone/verify", {
        challengeId: challenge.body.challengeId,
        phoneNumber,
        code: SMOKE_PHONE_CODE
      });
      if (verified.status !== 200) {
        violate(`phone verification for ${phoneNumber} failed`, JSON.stringify(verified.body));
      }
      return verified.body.sessionToken;
    },
    async bootstrapIPhone(deviceInstanceId, companionPairId) {
      const accountToken = await harness.login(smokePhoneNumber(deviceInstanceId));
      const response = await harness.request<SessionBody>(
        "POST",
        "/api/v2/session/bootstrap",
        {
          deviceInstanceId,
          deviceKind: "IPHONE",
          companionPairId,
          agreementAcceptances: BOOTSTRAP_AGREEMENTS.map(kind => ({
            kind,
            version: "2.0",
            acceptedAt: harness.iso(0)
          })),
          capabilities: { notificationAuthorized: true, locationAuthorized: true },
          availableForResponse: true
        },
        accountToken
      );
      if (response.status !== 201) {
        violate(`iPhone bootstrap ${deviceInstanceId} failed`, JSON.stringify(response.body));
      }
      return response.body;
    },
    async bootstrapWatch(deviceInstanceId, companionPairId, iPhoneSessionToken) {
      // The Watch has no login form: it redeems a one-time ticket issued by the
      // paired iPhone session and must pass the App Attest verification port.
      const ticket = await harness.request<{ companionLinkTicket: string }>(
        "POST",
        "/api/v2/me/companion-link-tickets",
        { companionPairId },
        iPhoneSessionToken
      );
      if (ticket.status !== 201) {
        violate("companion link ticket was not issued", JSON.stringify(ticket.body));
      }
      const response = await harness.request<SessionBody>(
        "POST",
        "/api/v2/watch/session/redeem",
        {
          deviceInstanceId,
          companionPairId,
          companionLinkTicket: ticket.body.companionLinkTicket,
          appAttestKeyId: "smoke-watch-key",
          attestationObject: "d2F0Y2gtYXR0ZXN0YXRpb24="
        }
      );
      if (response.status !== 201) {
        violate(`Watch session redeem failed`, JSON.stringify(response.body));
      }
      return response.body;
    },
    async publishResponderPosition(token, latitude, longitude) {
      positionSequence += 1;
      const positionUpdateId = uuid(positionSequence);
      const response = await harness.request(
        "PUT",
        "/api/v2/me/responder-position",
        {
          positionUpdateId,
          responderPosition: { kind: "R", latitude, longitude, accuracyMeters: 10 },
          observedAt: harness.iso(0)
        },
        token
      );
      if (response.status !== 200) {
        violate("responder position upload failed", JSON.stringify(response.body));
      }
      return positionUpdateId;
    },
    async events(token) {
      const response = await harness.request<{ events: EventProjection[] }>(
        "GET",
        "/api/v2/events",
        undefined,
        token
      );
      equal(response.status, 200, "GET /api/v2/events must succeed for a bootstrapped iPhone");
      return response.body.events;
    },
    async event(eventId, token) {
      const response = await harness.request<EventProjection>(
        "GET",
        `/api/v2/events/${eventId}`,
        undefined,
        token
      );
      equal(response.status, 200, `GET /api/v2/events/${eventId} must succeed for a participant`);
      return response.body;
    },
    async pendingDeliveryId(eventId, token) {
      const view = await harness.event(eventId, token);
      const deliveryId: unknown = view.pendingResponseRequest?.deliveryId;
      check(typeof deliveryId === "string" && deliveryId.length > 0,
        `no pending response request for event ${eventId}`, JSON.stringify(view).slice(0, 300));
      return deliveryId as string;
    },
    async connectIPhone(token) {
      const socket = io(baseURL, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Authorization: `Bearer ${token}` }
      });
      const ready = await new Promise<{ ok: boolean; detail: string }>(resolve => {
        const timer = setTimeout(() => {
          socket.disconnect();
          resolve({ ok: false, detail: "system:ready timeout after 5000 ms" });
        }, 5_000);
        socket.once("system:ready", () => {
          clearTimeout(timer);
          resolve({ ok: true, detail: "system:ready" });
        });
        socket.once("connect_error", (error: Error) => {
          clearTimeout(timer);
          socket.disconnect();
          resolve({ ok: false, detail: `connect_error: ${error.message}` });
        });
      });
      if (!ready.ok) violate("Socket.IO iPhone session did not become ready", ready.detail);
      return socket;
    },
    nextSocketEvent(socket, name, label) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off(name, handler);
          reject(new SmokeFailure(`${label}: socket event "${name}" never arrived`, "timeout after 5000 ms"));
        }, 5_000);
        const handler = (payload: Record<string, unknown>): void => {
          clearTimeout(timer);
          resolve(payload ?? {});
        };
        socket.once(name, handler);
      });
    },
    stop: () => backend.stop()
  };

  return harness;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function readFixtureAeds(): Promise<Aed[]> {
  const parsed: unknown = JSON.parse(await readFile(engineeringPath(DEMO_FIXTURE), "utf8"));
  const aeds = (parsed as { aeds?: Aed[] }).aeds;
  check(Array.isArray(aeds) && aeds.length > 0, "demo fixture must seed at least one AED");
  return aeds!;
}
