import assert from "node:assert/strict";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import type { BackendConfig } from "../src/config.js";
import { DeterministicPhoneChallengeProvider } from "../src/auth.js";
import type { Aed } from "../src/contracts.js";
import { emptyState } from "../src/models.js";
import { createBackend, type BackendInstance } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function phoneNumberForDevice(deviceInstanceId: string): string {
  let hash = 0;
  for (const character of deviceInstanceId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000_000;
  }
  return `+86139${hash.toString().padStart(8, "0")}`;
}

const testAeds: Aed[] = [{
  id: "transport-boundary-aed",
  name: "Transport boundary AED",
  aedPosition: { kind: "A", latitude: 22.199, longitude: 113.544, accuracyMeters: 5 },
  openFrom: "00:00",
  openUntil: "00:00",
  floor: "1F",
  floorTransferSeconds: 0,
  accessNote: "lobby",
  accessDelaySeconds: 0,
  verificationSeconds: 0,
  available: true
}];

interface SessionBody {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  scopes: string[];
  userId?: string;
  accountId?: string;
  refreshToken?: string;
}

interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  contentType: string;
}

interface Harness {
  backend: BackendInstance;
  baseURL: string;
  setOffset(offsetSeconds: number): void;
  iso(offsetSeconds: number): string;
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<JsonResponse<T>>;
}

async function makeHarness(): Promise<Harness> {
  const epoch = Date.parse("2026-09-05T00:00:00.000Z");
  let offsetSeconds = 0;
  const config: BackendConfig = {
    host: "127.0.0.1",
    port: 0,
    dataFile: "/tmp/aedresponse-transport-boundary.json",
    fixtureFile: "/tmp/aedresponse-transport-boundary-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    authSubjectPepper: "transport-boundary-test-pepper",
    watchAppAttestAppId: "TEAMID.com.aedresponse",
    operatorToken: "transport-boundary-operator",
    production: false
  };
  const controlledNow = () => new Date(epoch + offsetSeconds * 1_000);
  const backend = await createBackend({
    config,
    store: new MemoryStateStore(emptyState(testAeds)),
    phoneChallengeProvider: new DeterministicPhoneChallengeProvider("246810", controlledNow),
    appleIdentityTokenVerifier: {
      verifyIdentityToken: async () => ({ subject: "transport-boundary-apple" })
    },
    watchAttestationVerifier: {
      verifyAttestation: async (input) => ({
        verified: input.attestationObject === "d2F0Y2gtYXR0ZXN0YXRpb24=",
        deviceInstanceId: input.deviceInstanceId
      })
    },
    now: controlledNow
  });
  await backend.start();
  return {
    backend,
    baseURL: backend.baseURL(),
    setOffset(offset) {
      offsetSeconds = offset;
    },
    iso(offset) {
      return new Date(epoch + offset * 1_000).toISOString();
    },
    async request<T>(method: string, path: string, body?: unknown, token?: string) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${backend.baseURL()}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return {
        status: response.status,
        body: await response.json() as T,
        contentType: response.headers.get("content-type") ?? ""
      };
    }
  };
}

async function accountSession(harness: Harness, phoneNumber: string): Promise<string> {
  const challenge = await harness.request<{ challengeId: string }>(
    "POST",
    "/api/v2/auth/phone/challenges",
    { phoneNumber }
  );
  assert.equal(challenge.status, 201);
  const login = await harness.request<SessionBody>(
    "POST",
    "/api/v2/auth/phone/verify",
    {
      challengeId: challenge.body.challengeId,
      phoneNumber,
      code: "246810"
    }
  );
  assert.equal(login.status, 200);
  return login.body.sessionToken;
}

async function bootstrapIPhone(
  harness: Harness,
  deviceInstanceId: string,
  companionPairId: string
): Promise<SessionBody> {
  const response = await harness.request<SessionBody>(
    "POST",
    "/api/v2/session/bootstrap",
    {
      deviceInstanceId,
      deviceKind: "IPHONE",
      companionPairId,
      agreementAcceptances: [
        { kind: "PATIENT", version: "2.0", acceptedAt: harness.iso(0) },
        { kind: "VOLUNTEER_RESPONDER", version: "2.0", acceptedAt: harness.iso(0) },
        { kind: "PRIVACY_POLICY", version: "2.0", acceptedAt: harness.iso(0) },
        {
          kind: "SENSITIVE_PERSONAL_INFORMATION",
          version: "2.0",
          acceptedAt: harness.iso(0)
        }
      ],
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    },
    await accountSession(harness, phoneNumberForDevice(deviceInstanceId))
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function bootstrapWatch(
  harness: Harness,
  iPhoneToken: string,
  deviceInstanceId: string,
  companionPairId: string
): Promise<SessionBody> {
  const ticket = await harness.request<{ companionLinkTicket: string }>(
    "POST",
    "/api/v2/me/companion-link-tickets",
    { companionPairId },
    iPhoneToken
  );
  assert.equal(ticket.status, 201);
  const response = await harness.request<SessionBody>(
    "POST",
    "/api/v2/watch/session/redeem",
    {
      deviceInstanceId,
      companionPairId,
      companionLinkTicket: ticket.body.companionLinkTicket,
      appAttestKeyId: "transport-watch-key",
      attestationObject: "d2F0Y2gtYXR0ZXN0YXRpb24="
    }
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

function fixedSizeAppleBody(size: number): string {
  const challengeId = "REDACTED-ID-55f943dca165c7f5";
  const overhead = Buffer.byteLength(JSON.stringify({ identityToken: "", nonce: "n", challengeId }));
  const body = JSON.stringify({
    identityToken: "a".repeat(size - overhead),
    nonce: "n", challengeId
  });
  assert.equal(Buffer.byteLength(body), size);
  return body;
}

async function sendRawJson(
  harness: Harness,
  path: string,
  body: string
): Promise<JsonResponse<{ type?: string; status?: number }>> {
  const response = await fetch(`${harness.baseURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  return {
    status: response.status,
    body: await response.json() as { type?: string; status?: number },
    contentType: response.headers.get("content-type") ?? ""
  };
}

test("REST JSON accepts 16 KiB and rejects 16 KiB plus one byte as payload-too-large", async () => {
  const harness = await makeHarness();
  try {
    const accepted = await sendRawJson(
      harness,
      "/api/v2/auth/apple",
      fixedSizeAppleBody(16 * 1024)
    );
    assert.equal(accepted.status, 200);

    const rejected = await sendRawJson(
      harness,
      "/api/v2/auth/apple",
      fixedSizeAppleBody(16 * 1024 + 1)
    );
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.status, 413);
    assert.equal(rejected.body.type, "https://aedresponse.invalid/problems/payload-too-large");
    assert.match(rejected.contentType, /^application\/problem\+json/);
  } finally {
    await harness.backend.stop();
  }
});

test("Socket.IO is notification-only while REST delivery receipts remain writable", async () => {
  const harness = await makeHarness();
  let socket: Socket | undefined;
  try {
    const pairId = uuid(20_001);
    const patient = await bootstrapIPhone(harness, uuid(20_002), pairId);
    const watch = await bootstrapWatch(harness, patient.sessionToken, uuid(20_003), pairId);
    const responder = await bootstrapIPhone(harness, uuid(20_004), uuid(20_005));
    const position = await harness.request(
      "PUT",
      "/api/v2/me/responder-position",
      {
        positionUpdateId: uuid(20_006),
        responderPosition: { kind: "R", latitude: 22.198, longitude: 113.543, accuracyMeters: 10 },
        observedAt: harness.iso(0)
      },
      responder.sessionToken
    );
    assert.equal(position.status, 200);

    const eventId = uuid(20_007);
    const observation = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      {
        schemaVersion: "2.0",
        eventId,
        observationKind: "FALL_CONTEXT",
        fallDetectedAt: harness.iso(1),
        patientPositionObservedAt: harness.iso(0),
        fallResolution: "UNRESPONSIVE",
        appHelpResponse: "NEEDS_HELP",
        patientPosition: {
          kind: "P",
          latitude: 22.1987,
          longitude: 113.5439,
          accuracyMeters: 12
        }
      },
      watch.sessionToken
    );
    assert.equal(observation.status, 201);
    const before = await harness.request<{
      pendingResponseRequest: { deliveryId: string; deliveryStatus: string } | null;
    }>("GET", `/api/v2/events/${eventId}`, undefined, responder.sessionToken);
    assert.equal(before.status, 200);
    assert.ok(before.body.pendingResponseRequest);
    const deliveryId = before.body.pendingResponseRequest.deliveryId;

    socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = io(harness.baseURL, {
        transports: ["polling"],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Authorization: `Bearer ${responder.sessionToken}` }
      });
      const timeout = setTimeout(() => {
        candidate.disconnect();
        reject(new Error("Socket.IO system:ready timeout"));
      }, 2_000);
      candidate.once("system:ready", () => {
        clearTimeout(timeout);
        resolve(candidate);
      });
      candidate.once("connect_error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    socket.emit("delivery:receipt", {
      schemaVersion: "2.0",
      messageId: `delivery-receipt:${eventId}:${deliveryId}:DELIVERED`,
      eventId,
      deliveryId,
      status: "DELIVERED",
      occurredAt: harness.iso(3)
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const untouched = await harness.request<{
      pendingResponseRequest: { deliveryStatus: string } | null;
    }>("GET", `/api/v2/events/${eventId}`, undefined, responder.sessionToken);
    assert.equal(untouched.body.pendingResponseRequest?.deliveryStatus, "SENT");

    const restReceipt = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/deliveries/${deliveryId}/receipt`,
      { status: "DELIVERED", occurredAt: harness.iso(3) },
      responder.sessionToken
    );
    assert.equal(restReceipt.status, 200);
    const delivered = await harness.request<{
      pendingResponseRequest: { deliveryStatus: string } | null;
    }>("GET", `/api/v2/events/${eventId}`, undefined, responder.sessionToken);
    assert.equal(delivered.body.pendingResponseRequest?.deliveryStatus, "DELIVERED");
  } finally {
    socket?.disconnect();
    await harness.backend.stop();
  }
});

test("position circuit trips only after ten sustained bursts, limits degraded seconds, and recovers", async () => {
  const harness = await makeHarness();
  try {
    const responder = await bootstrapIPhone(harness, uuid(21_001), uuid(21_002));
    let sequence = 21_100;
    const sendPosition = async (): Promise<JsonResponse> => {
      sequence += 1;
      return harness.request(
        "PUT",
        "/api/v2/me/responder-position",
        {
          positionUpdateId: uuid(sequence),
          responderPosition: {
            kind: "R",
            latitude: 22.198,
            longitude: 113.543,
            accuracyMeters: 10
          },
          observedAt: harness.iso(0)
        },
        responder.sessionToken
      );
    };

    // One fixed-rate sample per second never trips the abnormal-burst circuit.
    for (let second = 0; second < 20; second += 1) {
      harness.setOffset(second);
      assert.equal((await sendPosition()).status, 200);
    }

    // Six writes in each of ten contiguous seconds cross the >5/s threshold.
    for (let second = 20; second < 30; second += 1) {
      harness.setOffset(second);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assert.equal((await sendPosition()).status, 200);
      }
    }

    harness.setOffset(29);
    const sameSecond = await sendPosition();
    assert.equal(sameSecond.status, 429);
    assert.match(String((sameSecond.body as { detail?: string }).detail), /temporarily degraded/);

    harness.setOffset(30);
    assert.equal((await sendPosition()).status, 200);
    assert.equal((await sendPosition()).status, 429);
    harness.setOffset(31);
    assert.equal((await sendPosition()).status, 200);

    // The tenth-second burst was observed at t=29; expiry is exactly t=59.
    harness.setOffset(59);
    assert.equal((await sendPosition()).status, 200);
    assert.equal((await sendPosition()).status, 200);
  } finally {
    await harness.backend.stop();
  }
});
