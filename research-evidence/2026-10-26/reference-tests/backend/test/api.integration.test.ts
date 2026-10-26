import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import type { BackendConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { Aed, WatchEmergencyObservation } from "../src/contracts.js";
import type { AppleIdentityTokenVerifier } from "../src/auth.js";
import { emptyState } from "../src/models.js";
import { createBackend, type BackendInstance } from "../src/server.js";
import { MemoryStateStore, SQLiteStateStore } from "../src/store.js";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

test("controlled account follows ordinary REST refresh, bootstrap, validation and position storage", async t => {
  const now = new Date();
  const store = new MemoryStateStore(emptyState());
  const backend = await createBackend({
    config: { ...loadConfig({}), host: "127.0.0.1", port: 0,
      enableControlledTestAccounts: true, authSubjectPepper: "controlled-http-test-pepper" },
    store,
    now: () => now
  });
  await backend.start();
  t.after(() => backend.stop());
  const harness = harnessForBackend(backend, now.getTime());
  assert.equal((await harness.request("POST", "/api/v2/auth/controlled-test", {})).status, 401);
  assert.equal(Object.keys(store.read(s => s.accounts)).length, 0);
  const account = await backend.service.provisionControlledTestAccount("iphone17pro");
  const rotated = await harness.request<SessionBody>("POST", "/api/v2/auth/session/refresh", {
    refreshToken: account.refreshToken
  });
  assert.equal(rotated.status, 200);
  const request = {
    deviceInstanceId: uuid(9_010), companionPairId: uuid(9_011), deviceKind: "IPHONE",
    agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
      .map(kind => ({ kind, version: "2.0", acceptedAt: now.toISOString() })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  };
  assert.equal((await harness.request("POST", "/api/v2/session/bootstrap", {
    ...request, agreementAcceptances: []
  }, rotated.body.sessionToken)).status, 400);
  const device = await harness.request<SessionBody>("POST", "/api/v2/session/bootstrap", request,
    rotated.body.sessionToken);
  assert.equal(device.status, 201);
  const update = { positionUpdateId: uuid(9_012), observedAt: now.toISOString(),
    responderPosition: { kind: "R", latitude: 22, longitude: 113, accuracyMeters: 10 } };
  assert.equal((await harness.request("PUT", "/api/v2/me/responder-position", update)).status, 401);
  assert.equal((await harness.request("PUT", "/api/v2/me/responder-position", update,
    rotated.body.sessionToken)).status, 403);
  assert.equal((await harness.request("PUT", "/api/v2/me/responder-position", {
    ...update, responderPosition: { ...update.responderPosition, latitude: 999 }
  }, device.body.sessionToken)).status, 400);
  const receipt = await harness.request("PUT", "/api/v2/me/responder-position", update,
    device.body.sessionToken);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.applied, true);
  const replay = await harness.request("PUT", "/api/v2/me/responder-position", update,
    device.body.sessionToken);
  assert.equal(replay.body.idempotent, true);
  assert.deepEqual(store.read(s => s.devices[request.deviceInstanceId]?.latestPosition?.position), update.responderPosition);
});

/**
 * Apple sign-in replaced the phone flow, so accounts are keyed by a stable Apple
 * subject derived from the device id instead of a derived phone number.
 */
function appleSubjectForDevice(deviceInstanceId: string): string {
  let hash = 0;
  for (const character of deviceInstanceId) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000_000;
  }
  return `integration-${hash.toString().padStart(8, "0")}`;
}

/** Verifies `apple:<subject>` so the real route, body and session issuance run. */
const integrationAppleVerifier: AppleIdentityTokenVerifier = {
  async verifyIdentityToken(input) {
    if (!input.identityToken.startsWith("apple:")) throw new Error("invalid token");
    return { subject: input.identityToken.slice("apple:".length) };
  }
};

const testAeds: Aed[] = [
  {
    id: "aed-api-primary",
    name: "API Test AED",
    aedPosition: {
      kind: "A",
      latitude: 22.199,
      longitude: 113.544,
      accuracyMeters: 5
    },
    openFrom: "00:00",
    openUntil: "00:00",
    floor: "2F",
    floorTransferSeconds: 45,
    accessNote: "front desk",
    accessDelaySeconds: 60,
    verificationSeconds: 30,
    available: true
  },
  {
    id: "aed-api-backup",
    name: "API Test Backup AED",
    aedPosition: {
      kind: "A",
      latitude: 22.201,
      longitude: 113.547,
      accuracyMeters: 8
    },
    openFrom: "00:00",
    openUntil: "00:00",
    floor: "1F",
    floorTransferSeconds: 0,
    accessNote: "lobby",
    accessDelaySeconds: 20,
    verificationSeconds: 10,
    available: true
  }
];

interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  contentType: string;
}

interface SessionBody {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  scopes: string[];
  userId?: string;
  accountId?: string;
}

interface IntegrationHarness {
  backend: BackendInstance;
  baseURL: string;
  iPhoneTokensByPair: Map<string, string>;
  iso(offsetSeconds: number): string;
  setServerOffset(offsetSeconds: number): void;
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<JsonResponse<T>>;
}

async function makeHarness(store = new MemoryStateStore(emptyState(testAeds)), configOverrides: Partial<BackendConfig> = {}): Promise<IntegrationHarness> {
  const epoch = Math.floor(Date.now() / 1_000) * 1_000;
  let serverOffsetSeconds = 0;
  const config: BackendConfig = {
    host: "127.0.0.1",
    port: 0,
    dataFile: "/tmp/aedresponse-api-test.json",
    fixtureFile: "/tmp/aedresponse-api-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    authSubjectPepper: "api-test-pepper",
    watchAppAttestAppId: "TEAMID.com.aedresponse",
    operatorToken: "operator-api-test-token",
    production: false,
    ...configOverrides
  };
  const backend = await createBackend({
    config,
    store,
    appleIdentityTokenVerifier: integrationAppleVerifier,
    watchAttestationVerifier: {
      verifyAttestation: async (input) => ({
        verified: input.attestationObject === "d2F0Y2gtYXR0ZXN0YXRpb24=",
        deviceInstanceId: input.deviceInstanceId
      })
    },
    now: () => new Date(epoch + serverOffsetSeconds * 1_000)
  });
  await backend.start();
  return harnessForBackend(backend, epoch, (value) => {
    serverOffsetSeconds = value;
  });
}

async function accountSession(
  harness: IntegrationHarness,
  appleSubject = "integration-account"
): Promise<string> {
  const login = await harness.request<SessionBody>("POST", "/api/v2/auth/apple", {
    challengeId: "REDACTED-ID-917c35b9217510e3",
    identityToken: `apple:${appleSubject}`,
    nonce: `integration-nonce-${appleSubject}`
  });
  assert.equal(login.status, 200);
  return login.body.sessionToken;
}

function harnessForBackend(
  backend: BackendInstance,
  epoch: number,
  setServerOffset: (offsetSeconds: number) => void = () => undefined
): IntegrationHarness {
  const baseURL = backend.baseURL();
  return {
    backend,
    baseURL,
    iPhoneTokensByPair: new Map(),
    iso(offsetSeconds) {
      return new Date(epoch + offsetSeconds * 1_000).toISOString();
    },
    setServerOffset,
    async request<T>(method: string, path: string, body?: unknown, token?: string) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${baseURL}${path}`, {
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

async function bootstrapIPhone(
  harness: IntegrationHarness,
  deviceInstanceId: string,
  companionPairId: string
): Promise<SessionBody> {
  const accountToken = await accountSession(harness, appleSubjectForDevice(deviceInstanceId));
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
    accountToken
  );
  assert.equal(response.status, 201);
  harness.iPhoneTokensByPair.set(companionPairId, response.body.sessionToken);
  return response.body;
}

async function bootstrapWatch(
  harness: IntegrationHarness,
  deviceInstanceId: string,
  companionPairId: string
): Promise<SessionBody> {
  const iPhoneToken = harness.iPhoneTokensByPair.get(companionPairId);
  assert.ok(iPhoneToken, `missing iPhone session for pair ${companionPairId}`);
  const ticketResponse = await harness.request<{
    companionLinkTicket: string;
  }>(
    "POST",
    "/api/v2/me/companion-link-tickets",
    { companionPairId },
    iPhoneToken
  );
  assert.equal(ticketResponse.status, 201);
  const response = await harness.request<SessionBody>(
    "POST",
    "/api/v2/watch/session/redeem",
    {
      deviceInstanceId,
      companionPairId,
      companionLinkTicket: ticketResponse.body.companionLinkTicket,
      appAttestKeyId: "test-watch-key",
      attestationObject: "d2F0Y2gtYXR0ZXN0YXRpb24="
    }
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

let publishPositionSequence = 20_000;
async function publishPosition(
  harness: IntegrationHarness,
  token: string,
  latitude: number,
  longitude: number,
  accuracyMeters = 10
): Promise<string> {
  publishPositionSequence += 1;
  const positionUpdateId = uuid(publishPositionSequence);
  const response = await harness.request(
    "PUT",
    "/api/v2/me/responder-position",
    {
      positionUpdateId,
      responderPosition: {
        kind: "R",
        latitude,
        longitude,
        accuracyMeters
      },
      observedAt: harness.iso(0)
    },
    token
  );
  assert.equal(response.status, 200);
  return positionUpdateId;
}

function watchObservation(
  harness: IntegrationHarness,
  eventId: string,
  appHelpResponse: "NEEDS_HELP" | "NO_RESPONSE" = "NEEDS_HELP"
): WatchEmergencyObservation {
  return {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: harness.iso(1),
    patientPositionObservedAt: harness.iso(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse,
    ...(appHelpResponse === "NO_RESPONSE" ? {
      callFirstObservedAt: harness.iso(2),
      callObservationSemantics: "FIRST_OBSERVED_OUTGOING_STATE" as const
    } : {}),
    patientPosition: {
      kind: "P",
      latitude: 22.1987,
      longitude: 113.5439,
      accuracyMeters: 12
    }
  };
}

async function connectIPhone(baseURL: string, token: string): Promise<Socket> {
  const socket = io(baseURL, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Authorization: `Bearer ${token}` }
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket.IO system:ready timeout"));
    }, 2_000);
    socket.once("system:ready", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("revoking a session disconnects its existing Socket but preserves the same device's other session", async t => {
  const harness = await makeHarness();
  t.after(() => harness.backend.stop());
  const oldSession = await bootstrapIPhone(harness, uuid(31_001), uuid(31_002));
  const oldSocket = await connectIPhone(harness.baseURL, oldSession.sessionToken);
  t.after(() => oldSocket.disconnect());
  const newSession = await bootstrapIPhone(harness, uuid(31_001), uuid(31_002));
  const newSocket = await connectIPhone(harness.baseURL, newSession.sessionToken);
  t.after(() => newSocket.disconnect());
  const disconnected = nextSocketEvent(oldSocket, "disconnect");
  await harness.backend.service.revokeSession(
    harness.backend.service.authenticateToken(oldSession.sessionToken)
  );
  await disconnected;
  assert.equal(oldSocket.connected, false);
  assert.equal(newSocket.connected, true);
  assert.equal((await harness.request("GET", "/api/v2/events", undefined,
    oldSession.sessionToken)).status, 401);
  assert.equal((await harness.request("GET", "/api/v2/events", undefined,
    newSession.sessionToken)).status, 200);
});

test("HTTP logout disconnects the original Socket without requiring another business request", async t => {
  const harness = await makeHarness();
  t.after(() => harness.backend.stop());
  const session = await bootstrapIPhone(harness, uuid(31_011), uuid(31_012));
  const other = await bootstrapIPhone(harness, uuid(31_013), uuid(31_014));
  const socket = await connectIPhone(harness.baseURL, session.sessionToken);
  const otherSocket = await connectIPhone(harness.baseURL, other.sessionToken);
  t.after(() => socket.disconnect());
  t.after(() => otherSocket.disconnect());
  const disconnected = nextSocketEvent(socket, "disconnect");
  const result = await fetch(`${harness.baseURL}/api/v2/auth/logout`, {
    method: "POST", headers: { Authorization: `Bearer ${session.sessionToken}` }
  });
  assert.equal(result.status, 204);
  await disconnected;
  assert.equal(socket.connected, false);
  assert.equal(otherSocket.connected, true);
});

test("Watch recovery returns only its triggering event state and rejects other principals", async t => {
  const store = new MemoryStateStore(emptyState(testAeds));
  const harness = await makeHarness(store);
  t.after(() => harness.backend.stop());
  const patient = await bootstrapIPhone(harness, uuid(34_001), uuid(34_002));
  const watch = await bootstrapWatch(harness, uuid(34_003), uuid(34_002));
  await bootstrapIPhone(harness, uuid(34_004), uuid(34_005));
  const outsider = await bootstrapWatch(harness, uuid(34_006), uuid(34_005));
  const eventId = uuid(34_007);
  await harness.request("PUT", `/api/v2/watch/emergency-observations/${eventId}`,
    watchObservation(harness, eventId), watch.sessionToken);
  const path = `/api/v2/watch/events/${eventId}/state`;
  const before = store.read(state => state.events[eventId]!);
  const current = await harness.request("GET", path, undefined, watch.sessionToken);
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, { eventId, state: "ACTIVE", createdAt: before.createdAt, resolvedAt: null, fallbackAllowed: false });
  assert.deepEqual(store.read(state => state.events[eventId]), before);
  assert.equal((await harness.request("GET", path)).status, 401);
  assert.equal((await harness.request("GET", path, undefined, patient.sessionToken)).status, 403);
  assert.equal((await harness.request("GET", path, undefined, outsider.sessionToken)).status, 403);
  assert.equal((await harness.request("GET", `/api/v2/events/${eventId}`, undefined, watch.sessionToken)).status, 403);
  await harness.request("POST", `/api/v2/events/${eventId}/end`, {
    resolutionId: uuid(34_008), reason: "FALSE_ALARM", endedAt: harness.iso(3)
  }, patient.sessionToken);
  const ended = await harness.request("GET", path, undefined, watch.sessionToken);
  const saved = store.read(state => state.events[eventId]!);
  assert.deepEqual(ended.body, { eventId, state: "CANCELLED_CONFIRMED_FALSE_ALARM",
    createdAt: saved.createdAt, resolvedAt: saved.resolvedAt, fallbackAllowed: false });
  await harness.backend.service.logout(harness.backend.service.authenticateToken(watch.sessionToken));
  assert.equal((await harness.request("GET", path, undefined, watch.sessionToken)).status, 401);
});

test("terminal outbox remains pending without a Socket and delivers after an authorized reconnect", async t => {
  const store = new MemoryStateStore(emptyState(testAeds));
  const harness = await makeHarness(store);
  t.after(() => harness.backend.stop());
  await harness.backend.service.stopRecruitmentScheduler();
  const patient = await bootstrapIPhone(harness, uuid(33_001), uuid(33_002));
  const watch = await bootstrapWatch(harness, uuid(33_003), uuid(33_002));
  const eventId = uuid(33_004);
  assert.equal((await harness.request("PUT", `/api/v2/watch/emergency-observations/${eventId}`,
    watchObservation(harness, eventId), watch.sessionToken)).status, 201);
  const resolutionId = uuid(33_005);
  const ended = await harness.request("POST", `/api/v2/events/${eventId}/end`, {
    resolutionId, reason: "PROBLEM_RESOLVED", endedAt: harness.iso(2)
  }, patient.sessionToken);
  assert.equal(ended.status, 200);
  assert.equal(ended.body.state, "RESOLVED");
  const rows = store.read(state => Object.values(state.notificationOutboxById));
  const terminalRevision = store.read(state => state.events[eventId]!.coordinationRevision);
  const terminalRows = rows.filter(row => row.name === "event:resolved"
    || (row.name === "event:coordination-updated"
      && row.payload.messageId === `coordination-updated:${eventId}:${terminalRevision}`));
  assert.equal(terminalRows.length, 2);
  assert.ok(terminalRows.every(row => row.status === "PENDING" && row.completedAt === undefined));
  const socket = await connectIPhone(harness.baseURL, patient.sessionToken);
  t.after(() => socket.disconnect());
  const terminal = nextSocketEvent(socket, "event:resolved");
  harness.setServerOffset(10);
  await harness.backend.service.tick();
  const payload = await terminal as { messageId: string; eventId: string };
  assert.equal(payload.messageId, `event-resolved:${resolutionId}`);
  assert.equal(payload.eventId, eventId);
  assert.ok(store.read(state => Object.values(state.notificationOutboxById))
    .every(row => row.status === "DISPATCHED" || row.status === "SUPPRESSED"));
});

test("recovery timeline never exports internal audit content to candidates or participants", async t => {
  const store = new MemoryStateStore(emptyState(testAeds));
  const harness = await makeHarness(store);
  t.after(() => harness.backend.stop());
  const patient = await bootstrapIPhone(harness, uuid(32_001), uuid(32_002));
  const watch = await bootstrapWatch(harness, uuid(32_003), uuid(32_002));
  const candidate = await bootstrapIPhone(harness, uuid(32_004), uuid(32_005));
  const outsider = await bootstrapIPhone(harness, uuid(32_006), uuid(32_007));
  await publishPosition(harness, candidate.sessionToken, 22.198, 113.543);
  const eventId = uuid(32_008);
  assert.equal((await harness.request("PUT", `/api/v2/watch/emergency-observations/${eventId}`,
    watchObservation(harness, eventId), watch.sessionToken)).status, 201);
  await store.transact(state => {
    state.timelineByEventId[eventId]!.push({
      id: uuid(32_009), eventId, occurredAt: harness.iso(2), kind: "AED_ACQUIRED",
      message: `private audit with user ${patient.userId} and caller observation`
    });
  });
  const audit = store.read(state => state.timelineByEventId[eventId]);
  const checkRecovery = async (token: string) => {
    const view = await harness.request<{ id: string; createdAt: string; resolvedAt: string | null }>(
      "GET", `/api/v2/events/${eventId}`, undefined, token);
    const result = await harness.request<Array<Record<string, unknown>>>(
      "GET", `/api/v2/events/${eventId}/timeline`, undefined, token);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, [{
      id: eventId, eventId, occurredAt: view.body.resolvedAt ?? view.body.createdAt,
      kind: "EVENT_ACTIVATED", message: "Event state recovered from the authorized snapshot."
    }]);
    assert.doesNotMatch(JSON.stringify(result.body), /private audit|caller observation|WATCH_FALL|AED_ACQUIRED/);
    assert.deepEqual(store.read(state => state.timelineByEventId[eventId]), audit);
  };
  await checkRecovery(candidate.sessionToken);
  await checkRecovery(patient.sessionToken);
  assert.equal((await harness.request("GET", `/api/v2/events/${eventId}/timeline`,
    undefined, outsider.sessionToken)).status, 404);
  assert.equal((await harness.request("GET", `/api/v2/events/${eventId}/timeline`,
    undefined, watch.sessionToken)).status, 403);
  const deliveryId = await pendingDeliveryId(harness, eventId, candidate.sessionToken);
  assert.equal((await harness.request("PUT", `/api/v2/events/${eventId}/responses/${deliveryId}`,
    { decision: "ACCEPT", decidedAt: harness.iso(3) }, candidate.sessionToken)).status, 200);
  const accepted = await harness.request<Array<Record<string, unknown>>>(
    "GET", `/api/v2/events/${eventId}/timeline`, undefined, candidate.sessionToken);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.length, 1);
  assert.equal(accepted.body[0]!.kind, "EVENT_ACTIVATED");
  assert.doesNotMatch(JSON.stringify(accepted.body), /private audit|caller observation|WATCH_FALL|AED_ACQUIRED/);
  assert.deepEqual(store.read(state => state.timelineByEventId[eventId]!.slice(0, audit!.length)), audit);
  harness.setServerOffset(36 * 60);
  const closedView = await harness.request<{ state: string }>(
    "GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
  assert.equal(closedView.body.state, "CLOSED_UNCONFIRMED_NO_RESPONSE");
  const closedHint = await harness.request<Array<{ kind: string }>>(
    "GET", `/api/v2/events/${eventId}/timeline`, undefined, patient.sessionToken);
  assert.deepEqual(closedHint.body.map(entry => entry.kind), ["PASSIVE_OBSERVATION"]);
  assert.deepEqual(store.read(state => state.timelineByEventId[eventId]!.slice(0, audit!.length)), audit);
});

function nextSocketEvent(socket: Socket, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Socket.IO ${name} timeout`));
    }, 2_000);
    const listener = (payload: unknown) => {
      clearTimeout(timeout);
      resolve(payload);
    };
    socket.once(name, listener);
  });
}

async function pendingDeliveryId(
  harness: IntegrationHarness,
  eventId: string,
  token: string
): Promise<string> {
  const view = await harness.request<{
    pendingResponseRequest: { deliveryId: string } | null;
  }>("GET", `/api/v2/events/${eventId}`, undefined, token);
  assert.equal(view.status, 200);
  if (!view.body.pendingResponseRequest) {
    throw new Error(`Expected a pending response delivery for event ${eventId}`);
  }
  return view.body.pendingResponseRequest.deliveryId;
}

test("HTTP bootstrap is account-authenticated, agreement-gated, scoped and strongly typed", async () => {
  const harness = await makeHarness();
  try {
    const health = await harness.request<{ status: string; schemaVersion: string }>("GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.schemaVersion, "2.0");

    const accountToken = await accountSession(harness);
    const invalidIPhone = await harness.request<{ status: number; detail: string }>(
      "POST",
      "/api/v2/session/bootstrap",
      {
        deviceInstanceId: uuid(1),
        deviceKind: "IPHONE",
        companionPairId: uuid(2),
        agreementAcceptances: [
          { kind: "PATIENT", version: "2.0", acceptedAt: harness.iso(0) }
        ]
      },
      accountToken
    );
    assert.equal(invalidIPhone.status, 400);
    assert.match(invalidIPhone.contentType, /^application\/problem\+json/);
    const missingCapabilities = await harness.request(
      "POST",
      "/api/v2/session/bootstrap",
      {
        deviceInstanceId: uuid(70),
        deviceKind: "IPHONE",
        companionPairId: uuid(71),
        agreementAcceptances: [
          { kind: "PATIENT", version: "2.0", acceptedAt: harness.iso(0) },
          { kind: "VOLUNTEER_RESPONDER", version: "2.0", acceptedAt: harness.iso(0) }
        ],
        availableForResponse: true
      },
      accountToken
    );
    assert.equal(missingCapabilities.status, 400);

    const pairId = uuid(3);
    const iphone = await bootstrapIPhone(harness, uuid(4), pairId);
    assert.ok(iphone.sessionToken.length >= 32);
    assert.deepEqual(iphone.scopes, [
      "events:read",
      "events:write",
      "responses:write",
      "position:write",
      "assignments:write"
    ]);
    assert.equal("email" in iphone, false);
    assert.equal("account" in iphone, false);

    const selfAssertingWatch = await harness.request<{ detail: string }>(
      "POST",
      "/api/v2/session/bootstrap",
      {
        deviceInstanceId: uuid(5),
        deviceKind: "WATCH",
        companionPairId: pairId,
        agreementAcceptances: [
          { kind: "PATIENT", version: "2.0", acceptedAt: harness.iso(0) }
        ]
      },
      accountToken
    );
    assert.equal(selfAssertingWatch.status, 400);

    const watchWithCapabilities = await harness.request(
      "POST",
      "/api/v2/session/bootstrap",
      {
        deviceInstanceId: uuid(72),
        deviceKind: "WATCH",
        companionPairId: pairId,
        capabilities: { notificationAuthorized: true, locationAuthorized: true },
        availableForResponse: true
      },
      accountToken
    );
    assert.equal(watchWithCapabilities.status, 400);

    const watch = await bootstrapWatch(harness, uuid(6), pairId);
    assert.deepEqual(watch.scopes, ["watch:report", "watch:fallback"]);
    const rejectedEventId = uuid(7);
    const noObservedCall = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${rejectedEventId}`,
      {
        ...watchObservation(harness, rejectedEventId, "NO_RESPONSE"),
        callFirstObservedAt: undefined,
        callObservationSemantics: undefined
      },
      watch.sessionToken
    );
    assert.equal(noObservedCall.status, 400);
    const iPhoneCannotReportWatchObservation = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${rejectedEventId}`,
      watchObservation(harness, rejectedEventId),
      iphone.sessionToken
    );
    assert.equal(iPhoneCannotReportWatchObservation.status, 403);
    const noEventWasCreated = await harness.request<{ events: unknown[] }>(
      "GET",
      "/api/v2/events",
      undefined,
      iphone.sessionToken
    );
    assert.deepEqual(noEventWasCreated.body.events, []);
    const unauthenticated = await harness.request("GET", "/api/v2/events");
    assert.equal(unauthenticated.status, 401);
    const watchCannotPublishR = await harness.request(
      "PUT",
      "/api/v2/me/responder-position",
      {
        positionUpdateId: uuid(90),
        responderPosition: {
          kind: "R",
          latitude: 22.198,
          longitude: 113.543,
          accuracyMeters: 10
        },
        observedAt: harness.iso(0)
      },
      watch.sessionToken
    );
    assert.equal(watchCannotPublishR.status, 403);

    const pCannotStandInForR = await harness.request<{ detail: string }>(
      "PUT",
      "/api/v2/me/responder-position",
      {
        positionUpdateId: uuid(91),
        responderPosition: {
          kind: "P",
          latitude: 22.198,
          longitude: 113.543,
          accuracyMeters: 10
        },
        observedAt: harness.iso(0)
      },
      iphone.sessionToken
    );
    assert.equal(pCannotStandInForR.status, 400);
    assert.match(pCannotStandInForR.body.detail, /responderPosition.kind/);
    const missingAccuracy = await harness.request(
      "PUT",
      "/api/v2/me/responder-position",
      {
        positionUpdateId: uuid(92),
        responderPosition: {
          kind: "R",
          latitude: 22.198,
          longitude: 113.543
        },
        observedAt: harness.iso(0)
      },
      iphone.sessionToken
    );
    assert.equal(missingAccuracy.status, 400);
  } finally {
    await harness.backend.stop();
  }
});

test("Watch PUT drives targeted Socket.IO notifications and REST projections idempotently", async () => {
  const auditStore = new MemoryStateStore(emptyState(testAeds));
  const harness = await makeHarness(auditStore);
  let patientSocket: Socket | undefined;
  let responderSocket: Socket | undefined;
  try {
    const patientPairId = uuid(20);
    const patientDeviceId = uuid(21);
    const responderDeviceId = uuid(22);
    const patient = await bootstrapIPhone(harness, patientDeviceId, patientPairId);
    const watch = await bootstrapWatch(harness, uuid(23), patientPairId);
    const responder = await bootstrapIPhone(harness, responderDeviceId, uuid(24));
    const far = await bootstrapIPhone(harness, uuid(25), uuid(26));
    await publishPosition(harness, responder.sessionToken, 22.198, 113.543);
    await publishPosition(harness, far.sessionToken, 22.30, 113.543);

    [patientSocket, responderSocket] = await Promise.all([
      connectIPhone(harness.baseURL, patient.sessionToken),
      connectIPhone(harness.baseURL, responder.sessionToken)
    ]);
    const patientNotification = nextSocketEvent(patientSocket, "event:patient-activated");
    const responseRequestNotification = nextSocketEvent(responderSocket, "response:requested");
    const eventId = uuid(27);
    const report = watchObservation(harness, eventId);
    const first = await harness.request<Record<string, unknown>>(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      report,
      watch.sessionToken
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.state, "ACTIVE");
    assert.equal(first.body.recruitmentState, "RECRUITING");

    const [patientPush, responsePush] = await Promise.all([
      patientNotification,
      responseRequestNotification
    ]) as [Record<string, unknown>, Record<string, unknown>];
    const responderSensitiveEvents: string[] = [];
    responderSocket.on("event:patient-position-updated", () => {
      responderSensitiveEvents.push("event:patient-position-updated");
    });
    responderSocket.on("event:coordination-updated", () => {
      responderSensitiveEvents.push("event:coordination-updated");
    });
    assert.equal(patientPush.messageId, `patient-activated:${eventId}`);
    assert.equal(patientPush.eventId, eventId);
    assert.equal(responsePush.messageId, `response-requested:${eventId}:${responderDeviceId}`);
    assert.equal(responsePush.eventId, eventId);
    for (const sensitiveField of [
      "patientPosition",
      "patientLocationCard",
      "coordination",
      "fallDetectedAt",
      "fallResolution",
      "appHelpResponse",
      "callFirstObservedAt"
    ]) {
      assert.equal(sensitiveField in responsePush, false, `${sensitiveField} leaked to pending responder`);
    }
    const deliveryId = responsePush.deliveryId as string;

    const retry = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      report,
      watch.sessionToken
    );
    assert.equal(retry.status, 200);
    const conflictingRetry = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      { ...report, fallResolution: "CONFIRMED" },
      watch.sessionToken
    );
    assert.equal(conflictingRetry.status, 409);

    const preferredIPhonePosition = {
      kind: "P",
      latitude: 22.1989,
      longitude: 113.5438,
      accuracyMeters: 6
    };
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      {
        positionUpdateId: uuid(28),
        observedAt: harness.iso(3),
        patientPosition: preferredIPhonePosition
      },
      patient.sessionToken
    )).status, 200);
    const triggerReplayAfterIPhoneP = await harness.request<{
      patientPosition: typeof preferredIPhonePosition;
    }>(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      report,
      watch.sessionToken
    );
    assert.equal(triggerReplayAfterIPhoneP.status, 200);
    assert.deepEqual(triggerReplayAfterIPhoneP.body.patientPosition, preferredIPhonePosition);
    assert.deepEqual(responderSensitiveEvents, [], "pending responder received participant-only Socket event");

    const patientView = await harness.request<Record<string, unknown>>(
      "GET",
      `/api/v2/events/${eventId}`,
      undefined,
      patient.sessionToken
    );
    assert.equal(patientView.status, 200);
    assert.equal(patientView.body.viewerRelationship, "PATIENT");
    const responderView = await harness.request<Record<string, unknown>>(
      "GET",
      `/api/v2/events/${eventId}`,
      undefined,
      responder.sessionToken
    );
    assert.equal(responderView.body.viewerRelationship, "NEUTRAL");
    assert.equal(
      (responderView.body.pendingResponseRequest as { deliveryId: string }).deliveryId,
      deliveryId
    );
    const farList = await harness.request<{ events: unknown[] }>(
      "GET",
      "/api/v2/events",
      undefined,
      far.sessionToken
    );
    assert.deepEqual(farList.body.events, []);
    const farDirect = await harness.request(
      "GET",
      `/api/v2/events/${eventId}`,
      undefined,
      far.sessionToken
    );
    assert.equal(farDirect.status, 404);

    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/deliveries/${deliveryId}/receipt`,
      { status: "DELIVERED", occurredAt: harness.iso(3) },
      responder.sessionToken
    )).status, 200);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/deliveries/${deliveryId}/receipt`,
      { status: "VIEWED", occurredAt: harness.iso(4) },
      responder.sessionToken
    )).status, 200);
    const accepted = await harness.request<{
      decision: string;
      assignment: { role: string; status: string };
    }>(
      "PUT",
      `/api/v2/events/${eventId}/responses/${deliveryId}`,
      {
        decision: "ACCEPT",
        decidedAt: harness.iso(5)
      },
      responder.sessionToken
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.decision, "ACCEPT");
    assert.equal(accepted.body.assignment.role, "GO_TO_PATIENT");

    const responderAfterAccept = await harness.request<Record<string, unknown>>(
      "GET",
      `/api/v2/events/${eventId}`,
      undefined,
      responder.sessionToken
    );
    assert.equal(responderAfterAccept.body.viewerRelationship, "RESPONDER");
    assert.equal(responderAfterAccept.body.pendingResponseRequest, null);
    assert.equal("patientPosition" in responderAfterAccept.body, true);
    assert.equal(responderAfterAccept.body.patientLocationCard, null);
    assert.equal("fallResolution" in responderAfterAccept.body, false);

    const unauthorizedFalseAlarm = await harness.request(
      "POST",
      `/api/v2/events/${eventId}/confirm-false-alarm`,
      {},
      responder.sessionToken
    );
    assert.equal(unauthorizedFalseAlarm.status, 403);
    const patientFalseAlarmPush = nextSocketEvent(patientSocket, "event:false-alarm-confirmed");
    const responderFalseAlarmPush = nextSocketEvent(responderSocket, "event:false-alarm-confirmed");
    const falseAlarm = await harness.request<Record<string, unknown>>(
      "POST",
      `/api/v2/events/${eventId}/confirm-false-alarm`,
      {},
      patient.sessionToken
    );
    assert.equal(falseAlarm.status, 200);
    assert.equal(falseAlarm.body.state, "CANCELLED_CONFIRMED_FALSE_ALARM");
    assert.equal(falseAlarm.body.recruitmentState, "STOPPED");
    const falseAlarmPushes = await Promise.all([patientFalseAlarmPush, responderFalseAlarmPush]);
    for (const payload of falseAlarmPushes as Record<string, unknown>[]) {
      assert.equal(payload.eventId, eventId);
      assert.equal(payload.state, "CANCELLED_CONFIRMED_FALSE_ALARM");
    }

    const timeline = await harness.request<Array<{ kind: string }>>(
      "GET",
      `/api/v2/events/${eventId}/timeline`,
      undefined,
      patient.sessionToken
    );
    assert.equal(timeline.status, 200);
    assert.deepEqual(timeline.body.map(entry => entry.kind), ["FALSE_ALARM_CONFIRMED"]);
    const audit = auditStore.read(state => state.timelineByEventId[eventId]!);
    assert.equal(audit.filter(entry => entry.kind === "WATCH_FALL_HELP_CONFIRMED").length, 1);
    assert.ok(audit.some(entry => entry.kind === "RESPONSE_ACCEPTED"));
    assert.ok(audit.some(entry => entry.kind === "FALSE_ALARM_CONFIRMED"));
  } finally {
    patientSocket?.disconnect();
    responderSocket?.disconnect();
    await harness.backend.stop();
  }
});

test("Watch fallback is direct, network-gated, candidate-first and source-ordered through HTTP", async () => {
  const harness = await makeHarness();
  try {
    const pairId = uuid(13_000);
    const patient = await bootstrapIPhone(harness, uuid(13_001), pairId);
    const watch = await bootstrapWatch(harness, uuid(13_002), pairId);
    const otherWatch = await bootstrapWatch(harness, uuid(13_003), pairId);
    const eventId = uuid(13_004);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);
    const primaryUpdate = {
      positionUpdateId: uuid(13_012),
      observedAt: harness.iso(0),
      patientPosition: {
        kind: "P",
        latitude: 22.19,
        longitude: 113.54,
        accuracyMeters: 6
      }
    };
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      primaryUpdate,
      patient.sessionToken
    )).status, 200);

    harness.setServerOffset(1);
    const noNetwork = await harness.request(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${uuid(13_005)}`,
      {
        schemaVersion: "2.0",
        eventId,
        positionUpdateId: uuid(13_005),
        observedAt: harness.iso(1),
        patientPosition: {
          kind: "P",
          latitude: 22.21,
          longitude: 113.55,
          accuracyMeters: 8
        },
        activationState: "INACTIVE",
        iphoneReachable: false,
        networkAvailable: false
      },
      watch.sessionToken
    );
    assert.equal(noNetwork.status, 403);
    const reachable = await harness.request(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${uuid(13_006)}`,
      {
        schemaVersion: "2.0",
        eventId,
        positionUpdateId: uuid(13_006),
        observedAt: harness.iso(1),
        patientPosition: {
          kind: "P",
          latitude: 22.21,
          longitude: 113.55,
          accuracyMeters: 8
        },
        activationState: "ACTIVATED",
        iphoneReachable: true,
        networkAvailable: true
      },
      watch.sessionToken
    );
    assert.equal(reachable.status, 403);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/events/${eventId}/iphone-reachability/${uuid(13_007)}`,
      {},
      watch.sessionToken
    )).status, 404);

    const fallbackPositionUpdateId = uuid(13_008);
    const fallbackUpdate = {
      schemaVersion: "2.0",
      eventId,
      positionUpdateId: fallbackPositionUpdateId,
      observedAt: harness.iso(1),
      patientPosition: {
        kind: "P",
        latitude: 22.21,
        longitude: 113.55,
        accuracyMeters: 8
      },
      activationState: "INACTIVE",
      iphoneReachable: false,
      networkAvailable: true
    };
    const candidate = await harness.request<{ applied: boolean; idempotent: boolean }>(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${fallbackPositionUpdateId}`,
      fallbackUpdate,
      watch.sessionToken
    );
    assert.equal(candidate.status, 200);
    assert.equal(candidate.body.applied, false);
    harness.setServerOffset(5);
    const newerCandidateId = uuid(13_009);
    const newerCandidate = await harness.request<{ applied: boolean }>(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${newerCandidateId}`,
      { ...fallbackUpdate, positionUpdateId: newerCandidateId, observedAt: harness.iso(5) },
      watch.sessionToken
    );
    assert.equal(newerCandidate.status, 200);
    assert.equal(newerCandidate.body.applied, false);
    harness.setServerOffset(10);
    const promoted = await harness.request<{ applied: boolean }>(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${newerCandidateId}`,
      { ...fallbackUpdate, positionUpdateId: newerCandidateId, observedAt: harness.iso(5) },
      watch.sessionToken
    );
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.applied, true);
    const fallbackView = await harness.request<{
      patientPositionSource: string;
      patientPosition: { latitude: number };
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.equal(fallbackView.body.patientPositionSource, "WATCH_FALLBACK");
    assert.equal(fallbackView.body.patientPosition.latitude, 22.21);
    const newerFallback = await harness.request(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${uuid(13_015)}`,
      {
        ...fallbackUpdate,
        positionUpdateId: uuid(13_015),
        observedAt: harness.iso(6),
        patientPosition: { ...fallbackUpdate.patientPosition, latitude: 22.4 }
      },
      watch.sessionToken
    );
    assert.equal(newerFallback.status, 200, JSON.stringify(newerFallback.body));

    harness.setServerOffset(11);
    const restored = await harness.request<{
      applied: boolean;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      {
        ...primaryUpdate,
        positionUpdateId: uuid(13_013),
        observedAt: harness.iso(11)
      },
      patient.sessionToken
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.applied, true);
    const staleWatch = await harness.request<{ ignoredAsStale: boolean }>(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${uuid(13_014)}`,
      {
        ...fallbackUpdate,
        positionUpdateId: uuid(13_014),
        observedAt: harness.iso(10)
      },
      watch.sessionToken
    );
    assert.equal(staleWatch.status, 200);
    assert.equal(staleWatch.body.ignoredAsStale, true);
    const recovered = await harness.request<{
      patientPositionSource: string;
      patientPositionServerReceivedAt: string;
    }>(
      "GET",
      `/api/v2/events/${eventId}`,
      undefined,
      patient.sessionToken
    );
    assert.equal(recovered.body.patientPositionSource, "IPHONE_PRIMARY");
    assert.equal(recovered.body.patientPositionServerReceivedAt, harness.iso(11));
  } finally {
    await harness.backend.stop();
  }
});

test("iPhone P/R and presence REST drive multi-device coordination and reconnect recovery", async () => {
  const auditStore = new MemoryStateStore(emptyState(testAeds));
  const harness = await makeHarness(auditStore);
  let patientSocket: Socket | undefined;
  let responderASocket: Socket | undefined;
  let responderBSocket: Socket | undefined;
  try {
    const pairId = uuid(200);
    const patient = await bootstrapIPhone(harness, uuid(201), pairId);
    const watch = await bootstrapWatch(harness, uuid(202), pairId);
    const responderA = await bootstrapIPhone(harness, uuid(203), uuid(204));
    const responderB = await bootstrapIPhone(harness, uuid(205), uuid(206));
    await publishPosition(harness, responderA.sessionToken, 22.1980, 113.5430);
    await publishPosition(harness, responderB.sessionToken, 22.1979, 113.5429);
    [patientSocket, responderASocket, responderBSocket] = await Promise.all([
      connectIPhone(harness.baseURL, patient.sessionToken),
      connectIPhone(harness.baseURL, responderA.sessionToken),
      connectIPhone(harness.baseURL, responderB.sessionToken)
    ]);

    const eventId = uuid(207);
    const activated = nextSocketEvent(patientSocket, "event:patient-activated");
    const report = {
      ...watchObservation(harness, eventId),
      patientPosition: null,
      patientPositionObservedAt: undefined,
      locationUnavailableReason: "watch location unavailable"
    };
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      report,
      watch.sessionToken
    )).status, 201);
    await activated;

    const offerA = nextSocketEvent(responderASocket, "response:requested");
    const offerB = nextSocketEvent(responderBSocket, "response:requested");
    const patientPositionPush = nextSocketEvent(patientSocket, "event:patient-position-updated");
    const positionUpdate = {
      positionUpdateId: uuid(208),
      observedAt: harness.iso(2),
      patientPosition: {
        kind: "P",
        latitude: 22.1987,
        longitude: 113.5439,
        accuracyMeters: 12
      }
    };
    const firstP = await harness.request<{
      applied: boolean;
      idempotent: boolean;
      serverReceivedAt: string;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      positionUpdate,
      patient.sessionToken
    );
    assert.equal(firstP.status, 200);
    assert.equal(firstP.body.applied, true);
    const [requestA, requestB] = await Promise.all([offerA, offerB]) as Array<Record<string, unknown>>;
    assert.ok(requestA);
    assert.ok(requestB);
    assert.equal(requestA.deliveryStatus, "SENT");
    assert.equal(requestB.deliveryStatus, "SENT");
    for (const request of [requestA, requestB]) {
      for (const sensitiveField of [
        "patientPosition",
        "patientLocationCard",
        "coordination",
        "fallDetectedAt",
        "fallResolution",
        "appHelpResponse",
        "callFirstObservedAt"
      ]) {
        assert.equal(sensitiveField in request, false, `${sensitiveField} leaked to pending responder`);
      }
    }
    await patientPositionPush;

    const pReplay = await harness.request<{
      applied: boolean;
      idempotent: boolean;
      serverReceivedAt: string;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      positionUpdate,
      patient.sessionToken
    );
    assert.equal(pReplay.body.idempotent, true);
    assert.equal(pReplay.body.serverReceivedAt, firstP.body.serverReceivedAt);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      {
        ...positionUpdate,
        patientPosition: { ...positionUpdate.patientPosition, longitude: 113.6 }
      },
      patient.sessionToken
    )).status, 409);

    const patientView = await harness.request<{
      coordination: {
        nearbyCandidateCount: number;
        pendingOfferCount: number;
        acceptedResponderCount: number;
      };
      patientLocationCard: unknown;
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.deepEqual(patientView.body.coordination, {
      nearbyCandidateCount: 2,
      pendingOfferCount: 2,
      acceptedResponderCount: 0,
      currentRecruitmentRadiusMeters: 2_000,
      revision: 2,
      goToPatientCount: 0,
      fetchAedCount: 0,
      enRouteCount: 0,
      arrivedAtAedCount: 0,
      arrivedAtPatientCount: 0,
      aedAcquiredCount: 0,
      completedAssignmentCount: 0
    });
    assert.equal(patientView.body.patientLocationCard, null);

    const presenceBefore = await harness.request<{
      latestPosition: { position: { kind: string }; eventId?: string };
      availableForResponse: boolean;
      position: { coordinate: { kind: string } } | null;
      freshness: string;
    }>("GET", "/api/v2/me/presence", undefined, responderB.sessionToken);
    assert.equal(presenceBefore.body.position?.coordinate.kind, "R");
    assert.equal(presenceBefore.body.freshness, "FRESH");
    assert.equal("eventId" in (presenceBefore.body.position ?? {}), false);
    assert.equal(presenceBefore.body.availableForResponse, true);
    const presenceCoordination = nextSocketEvent(patientSocket, "event:coordination-updated");
    const expiredOfferPush = nextSocketEvent(responderBSocket, "response:offer-expired");
    const presenceAfter = await harness.request<{
      availableForResponse: boolean;
      capabilities: { notificationAuthorized: boolean; locationAuthorized: boolean };
    }>(
      "PUT",
      "/api/v2/me/presence",
      {
        presenceUpdateId: uuid(209),
        occurredAt: harness.iso(3),
        availableForResponse: false,
        capabilities: { notificationAuthorized: true, locationAuthorized: true }
      },
      responderB.sessionToken
    );
    assert.equal(presenceAfter.status, 200);
    assert.equal(presenceAfter.body.availableForResponse, false);
    const presencePush = await presenceCoordination as {
      coordination: { nearbyCandidateCount: number; pendingOfferCount: number };
    };
    assert.equal(presencePush.coordination.nearbyCandidateCount, 1);
    assert.equal(presencePush.coordination.pendingOfferCount, 1);
    const expiredOffer = await expiredOfferPush as { deliveryId: string; reason: string };
    assert.equal(expiredOffer.deliveryId, requestB.deliveryId);
    assert.equal(expiredOffer.reason, "OFFER_NO_LONGER_ELIGIBLE");
    const patientPresence = await harness.request<{
      position: { coordinate: { kind: string } } | null;
      freshness: string;
    }>("GET", "/api/v2/me/presence", undefined, patient.sessionToken);
    assert.equal(patientPresence.body.position?.coordinate.kind, "P");
    assert.equal(patientPresence.body.freshness, "FRESH");

    const decisionForPatient = nextSocketEvent(patientSocket, "response:decision-recorded");
    const decisionForResponder = nextSocketEvent(
      responderASocket,
      "response:decision-recorded"
    );
    const assignmentForResponder = nextSocketEvent(responderASocket, "assignment:created");
    const accepted = await harness.request<{
      assignment: { id: string; role: string; status: string };
    }>(
      "PUT",
      `/api/v2/events/${eventId}/responses/${requestA.deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(4) },
      responderA.sessionToken
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.assignment.role, "GO_TO_PATIENT");
    const [patientDecision, responderDecision, assignmentPush] = await Promise.all([
      decisionForPatient,
      decisionForResponder,
      assignmentForResponder
    ]) as Array<Record<string, unknown>>;
    assert.ok(patientDecision);
    assert.ok(responderDecision);
    assert.ok(assignmentPush);
    assert.equal((patientDecision.coordination as { acceptedResponderCount: number }).acceptedResponderCount, 1);
    assert.equal((responderDecision.coordination as { acceptedResponderCount: number }).acceptedResponderCount, 1);
    assert.equal((assignmentPush.assignment as { id: string }).id, accepted.body.assignment.id);

    patientSocket.disconnect();
    patientSocket = undefined;
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${accepted.body.assignment.id}/status`,
      { status: "EN_ROUTE", occurredAt: harness.iso(5) },
      responderA.sessionToken
    )).status, 200);
    patientSocket = await connectIPhone(harness.baseURL, patient.sessionToken);
    const recovered = await harness.request<{
      events: Array<{ coordination: { enRouteCount: number } }>;
    }>("GET", "/api/v2/events", undefined, patient.sessionToken);
    assert.equal(recovered.body.events[0]?.coordination.enRouteCount, 1);
    const recoveredTimeline = await harness.request<Array<{ kind: string }>>(
      "GET",
      `/api/v2/events/${eventId}/timeline`,
      undefined,
      patient.sessionToken
    );
    assert.deepEqual(recoveredTimeline.body.map(entry => entry.kind), ["EVENT_ACTIVATED"]);
    assert.ok(auditStore.read(state => state.timelineByEventId[eventId]!)
      .some(entry => entry.kind === "ASSIGNMENT_UPDATED"));

    const terminalForPatient = nextSocketEvent(patientSocket, "event:false-alarm-confirmed");
    const terminalForResponder = nextSocketEvent(
      responderASocket,
      "event:false-alarm-confirmed"
    );
    assert.equal((await harness.request(
      "POST",
      `/api/v2/events/${eventId}/confirm-false-alarm`,
      {},
      patient.sessionToken
    )).status, 200);
    await Promise.all([terminalForPatient, terminalForResponder]);
    for (const session of [patient, responderA]) {
      const terminal = await harness.request<{
        viewerRelationship: string;
        pendingResponseRequest: unknown;
        currentAssignment?: unknown;
      }>("GET", `/api/v2/events/${eventId}`, undefined, session.sessionToken);
      assert.equal(terminal.body.viewerRelationship, "NEUTRAL");
      assert.equal(terminal.body.pendingResponseRequest, null);
      assert.equal("currentAssignment" in terminal.body, false);
      const presence = await harness.request<{
        currentEventId: string | null;
        currentAssignmentId: string | null;
        position: { coordinate: { kind: string } } | null;
        freshness: string;
      }>("GET", "/api/v2/me/presence", undefined, session.sessionToken);
      assert.equal(presence.body.currentEventId, null);
      assert.equal(presence.body.currentAssignmentId, null);
      if (session === patient) assert.equal(presence.body.position, null);
      else assert.equal(presence.body.position?.coordinate.kind, "R");
    }
    const terminalReplay = await harness.request<{ idempotent: boolean }>(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      positionUpdate,
      patient.sessionToken
    );
    assert.equal(terminalReplay.status, 200);
    assert.equal(terminalReplay.body.idempotent, true);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      { ...positionUpdate, positionUpdateId: uuid(210) },
      patient.sessionToken
    )).status, 409);
  } finally {
    patientSocket?.disconnect();
    responderASocket?.disconnect();
    responderBSocket?.disconnect();
    await harness.backend.stop();
  }
});

test("AED and explicit-resolution endpoints preserve state truth and idempotent receipts", async () => {
  const harness = await makeHarness();
  let participantSockets: Socket[] = [];
  try {
    const patientPairId = uuid(40);
    const patient = await bootstrapIPhone(harness, uuid(41), patientPairId);
    const watch = await bootstrapWatch(harness, uuid(42), patientPairId);
    const responderA = await bootstrapIPhone(harness, uuid(43), uuid(143));
    const responderB = await bootstrapIPhone(harness, uuid(44), uuid(144));
    await publishPosition(harness, responderA.sessionToken, 22.1980, 113.5430);
    await publishPosition(harness, responderB.sessionToken, 22.1978, 113.5428);

    const eventId = uuid(45);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);

    const responders = [responderA, responderB];
    for (let index = 0; index < responders.length; index += 1) {
      const view = await harness.request<Record<string, unknown>>(
        "GET",
        `/api/v2/events/${eventId}`,
        undefined,
        responders[index]!.sessionToken
      );
      const deliveryId = (view.body.pendingResponseRequest as { deliveryId: string }).deliveryId;
      const result = await harness.request(
        "PUT",
        `/api/v2/events/${eventId}/responses/${deliveryId}`,
        {
          decision: "ACCEPT",
          decidedAt: harness.iso(10 + index)
        },
        responders[index]!.sessionToken
      );
      assert.equal(result.status, 200);
    }

    const views = await Promise.all(responders.map((responder) => harness.request<{
      currentAssignment: {
        id: string;
        role: "GO_TO_PATIENT" | "FETCH_AED";
        status: string;
        route: { aedId: string; path: Array<{ kind: string }> } | null;
      };
    }>("GET", `/api/v2/events/${eventId}`, undefined, responder.sessionToken)));
    const roles = views.map((response) => response.body.currentAssignment.role).sort();
    assert.deepEqual(roles, ["FETCH_AED", "GO_TO_PATIENT"]);
    const fetchIndex = views.findIndex((response) =>
      response.body.currentAssignment.role === "FETCH_AED"
    );
    assert.notEqual(fetchIndex, -1);
    const fetchSession = responders[fetchIndex]!;
    const fetchAssignment = views[fetchIndex]!.body.currentAssignment;
    assert.ok(fetchAssignment.route);
    assert.deepEqual(fetchAssignment.route.path.map((position) => position.kind), ["R", "A", "P"]);

    const directDedicatedState = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${fetchAssignment.id}/status`,
      { status: "AED_ACQUIRED", occurredAt: harness.iso(20) },
      fetchSession.sessionToken
    );
    assert.equal(directDedicatedState.status, 409);
    for (const [status, offset] of [["EN_ROUTE", 21], ["ARRIVED_AT_AED", 22]] as const) {
      assert.equal((await harness.request(
        "PUT",
        `/api/v2/events/${eventId}/assignments/${fetchAssignment.id}/status`,
        { status, occurredAt: harness.iso(offset) },
        fetchSession.sessionToken
      )).status, 200);
    }

    const receipt = {
      receiptId: uuid(46),
      eventId,
      assignmentId: fetchAssignment.id,
      aedId: fetchAssignment.route.aedId,
      acquiredAt: harness.iso(23)
    };
    participantSockets = await Promise.all([
      connectIPhone(harness.baseURL, patient.sessionToken),
      connectIPhone(harness.baseURL, responderA.sessionToken),
      connectIPhone(harness.baseURL, responderB.sessionToken)
    ]);
    const acquiredPushes = participantSockets.map((socket) =>
      nextSocketEvent(socket, "aed:acquired")
    );
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${fetchAssignment.id}/aed-acquired`,
      receipt,
      fetchSession.sessionToken
    )).status, 201);
    for (const payload of await Promise.all(acquiredPushes) as Array<{
      eventId: string;
      receiptId: string;
    }>) {
      assert.equal(payload.eventId, eventId);
      assert.equal(payload.receiptId, receipt.receiptId);
    }
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${fetchAssignment.id}/aed-acquired`,
      receipt,
      fetchSession.sessionToken
    )).status, 200);

    const afterReceipt = await harness.request<{
      state: string;
      currentAssignment: { status: string; aedAcquiredReceipt: { receiptId: string } };
    }>("GET", `/api/v2/events/${eventId}`, undefined, fetchSession.sessionToken);
    assert.equal(afterReceipt.body.state, "ACTIVE");
    assert.equal(afterReceipt.body.currentAssignment.status, "AED_ACQUIRED");
    assert.equal(afterReceipt.body.currentAssignment.aedAcquiredReceipt.receiptId, receipt.receiptId);

    const prematureOnSceneResolution = await harness.request(
      "POST",
      `/api/v2/events/${eventId}/resolve`,
      {
        resolutionId: uuid(47),
        actor: "ON_SCENE_RESPONDER",
        resolvedAt: harness.iso(24)
      },
      fetchSession.sessionToken
    );
    assert.equal(prematureOnSceneResolution.status, 403);

    harness.setServerOffset(25);
    const resolution = {
      resolutionId: uuid(48),
      actor: "PATIENT",
      resolvedAt: harness.iso(25),
      note: "explicit patient action"
    };
    const resolved = await harness.request<{
      state: string;
      resolvedAt: string;
      eventPositionParticipationStartedAt: string | null;
      eventPositionParticipationEndedAt: string | null;
    }>(
      "POST",
      `/api/v2/events/${eventId}/resolve`,
      resolution,
      patient.sessionToken
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.state, "RESOLVED");
    assert.equal(resolved.body.resolvedAt, harness.iso(25));
    assert.equal(resolved.body.eventPositionParticipationStartedAt, harness.iso(0));
    assert.equal(resolved.body.eventPositionParticipationEndedAt, harness.iso(25));
    assert.equal((await harness.request(
      "POST",
      `/api/v2/events/${eventId}/resolve`,
      resolution,
      patient.sessionToken
    )).status, 200);
    assert.equal((await harness.request(
      "POST",
      `/api/v2/events/${eventId}/resolve`,
      { ...resolution, note: "changed reuse" },
      patient.sessionToken
    )).status, 409);
  } finally {
    participantSockets.forEach((socket) => socket.disconnect());
    await harness.backend.stop();
  }
});

test("REFUSE does not enter N and notifies the patient plus accepted participants", async () => {
  const harness = await makeHarness();
  const sockets: Socket[] = [];
  try {
    const patientPairId = uuid(1_000);
    const patient = await bootstrapIPhone(harness, uuid(1_001), patientPairId);
    const watch = await bootstrapWatch(harness, uuid(1_002), patientPairId);
    const acceptedResponder = await bootstrapIPhone(harness, uuid(1_003), uuid(1_004));
    const refusingResponder = await bootstrapIPhone(harness, uuid(1_005), uuid(1_006));
    await publishPosition(harness, acceptedResponder.sessionToken, 22.1980, 113.5430);
    await publishPosition(harness, refusingResponder.sessionToken, 22.1979, 113.5429);

    const eventId = uuid(1_007);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);
    const acceptedDeliveryId = await pendingDeliveryId(
      harness,
      eventId,
      acceptedResponder.sessionToken
    );
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/responses/${acceptedDeliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(3) },
      acceptedResponder.sessionToken
    )).status, 200);

    const [patientSocket, participantSocket, refusingSocket] = await Promise.all([
      connectIPhone(harness.baseURL, patient.sessionToken),
      connectIPhone(harness.baseURL, acceptedResponder.sessionToken),
      connectIPhone(harness.baseURL, refusingResponder.sessionToken)
    ]);
    sockets.push(patientSocket, participantSocket, refusingSocket);
    const patientDecision = nextSocketEvent(patientSocket, "response:decision-recorded");
    const participantDecision = nextSocketEvent(
      participantSocket,
      "response:decision-recorded"
    );
    const refusingDeliveryId = await pendingDeliveryId(
      harness,
      eventId,
      refusingResponder.sessionToken
    );
    const refused = await harness.request<{
      decision: string;
      assignment: unknown;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/responses/${refusingDeliveryId}`,
      { decision: "REFUSE", decidedAt: harness.iso(4) },
      refusingResponder.sessionToken
    );
    assert.equal(refused.status, 200);
    assert.equal(refused.body.decision, "REFUSE");
    assert.equal(refused.body.assignment, null);

    for (const payload of await Promise.all([patientDecision, participantDecision]) as Array<{
      decision: string;
      coordination: { acceptedResponderCount: number };
    }>) {
      assert.equal(payload.decision, "REFUSE");
      assert.equal(payload.coordination.acceptedResponderCount, 1);
    }
    const truth = await harness.request<{
      coordination: {
        acceptedResponderCount: number;
        goToPatientCount: number;
        fetchAedCount: number;
      };
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.equal(truth.body.coordination.acceptedResponderCount, 1);
    assert.equal(truth.body.coordination.goToPatientCount, 1);
    assert.equal(truth.body.coordination.fetchAedCount, 0);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await harness.backend.stop();
  }
});

test("arrival progress publishes coordination to every active participant and REST", async () => {
  const harness = await makeHarness();
  const sockets: Socket[] = [];
  try {
    const patientPairId = uuid(1_020);
    const patient = await bootstrapIPhone(harness, uuid(1_021), patientPairId);
    const watch = await bootstrapWatch(harness, uuid(1_022), patientPairId);
    const responders = [
      await bootstrapIPhone(harness, uuid(1_023), uuid(1_024)),
      await bootstrapIPhone(harness, uuid(1_025), uuid(1_026))
    ];
    await publishPosition(harness, responders[0]!.sessionToken, 22.1980, 113.5430);
    await publishPosition(harness, responders[1]!.sessionToken, 22.1979, 113.5429);
    const eventId = uuid(1_027);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);
    for (let index = 0; index < responders.length; index += 1) {
      const responder = responders[index]!;
      const deliveryId = await pendingDeliveryId(harness, eventId, responder.sessionToken);
      assert.equal((await harness.request(
        "PUT",
        `/api/v2/events/${eventId}/responses/${deliveryId}`,
        { decision: "ACCEPT", decidedAt: harness.iso(10 + index) },
        responder.sessionToken
      )).status, 200);
    }

    const responderViews = await Promise.all(responders.map((responder) => harness.request<{
      currentAssignment: { id: string; role: string };
    }>("GET", `/api/v2/events/${eventId}`, undefined, responder.sessionToken)));
    const patientAssignmentIndex = responderViews.findIndex(
      (view) => view.body.currentAssignment.role === "GO_TO_PATIENT"
    );
    assert.notEqual(patientAssignmentIndex, -1);
    const assignmentOwner = responders[patientAssignmentIndex]!;
    const assignmentId = responderViews[patientAssignmentIndex]!.body.currentAssignment.id;

    sockets.push(...await Promise.all([
      connectIPhone(harness.baseURL, patient.sessionToken),
      ...responders.map((responder) => connectIPhone(harness.baseURL, responder.sessionToken))
    ]));
    const firstCoordinationPushes = sockets.map((socket) =>
      nextSocketEvent(socket, "event:coordination-updated")
    );
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${assignmentId}/status`,
      { status: "EN_ROUTE", occurredAt: harness.iso(20) },
      assignmentOwner.sessionToken
    )).status, 200);
    for (const payload of await Promise.all(firstCoordinationPushes) as Array<{
      coordination: { enRouteCount: number; arrivedAtPatientCount: number };
    }>) {
      assert.equal(payload.coordination.enRouteCount, 1);
      assert.equal(payload.coordination.arrivedAtPatientCount, 0);
    }

    const coordinationPushes = sockets.map((socket) =>
      nextSocketEvent(socket, "event:coordination-updated")
    );
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${assignmentId}/status`,
      { status: "ARRIVED_AT_PATIENT", occurredAt: harness.iso(21) },
      assignmentOwner.sessionToken
    )).status, 200);
    for (const payload of await Promise.all(coordinationPushes) as Array<{
      coordination: {
        acceptedResponderCount: number;
        enRouteCount: number;
        arrivedAtPatientCount: number;
      };
    }>) {
      assert.equal(payload.coordination.acceptedResponderCount, 2);
      assert.equal(payload.coordination.enRouteCount, 0);
      assert.equal(payload.coordination.arrivedAtPatientCount, 1);
    }
    const truth = await harness.request<{
      coordination: { enRouteCount: number; arrivedAtPatientCount: number };
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.equal(truth.body.coordination.enRouteCount, 0);
    assert.equal(truth.body.coordination.arrivedAtPatientCount, 1);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await harness.backend.stop();
  }
});

test("an R update after activation creates and expires an offer as radius eligibility changes", async () => {
  const harness = await makeHarness();
  const sockets: Socket[] = [];
  try {
    const patientPairId = uuid(1_040);
    const patient = await bootstrapIPhone(harness, uuid(1_041), patientPairId);
    const watch = await bootstrapWatch(harness, uuid(1_042), patientPairId);
    const responder = await bootstrapIPhone(harness, uuid(1_043), uuid(1_044));
    await publishPosition(harness, responder.sessionToken, 22.30, 113.5430);
    const eventId = uuid(1_045);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);
    const before = await harness.request<{
      coordination: { nearbyCandidateCount: number; pendingOfferCount: number };
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.equal(before.body.coordination.nearbyCandidateCount, 0);
    assert.equal(before.body.coordination.pendingOfferCount, 0);

    const [patientSocket, responderSocket] = await Promise.all([
      connectIPhone(harness.baseURL, patient.sessionToken),
      connectIPhone(harness.baseURL, responder.sessionToken)
    ]);
    sockets.push(patientSocket, responderSocket);
    const offer = nextSocketEvent(responderSocket, "response:requested");
    const enteredRadiusPush = nextSocketEvent(patientSocket, "event:coordination-updated");
    assert.equal((await harness.request(
      "PUT",
      "/api/v2/me/responder-position",
      {
        positionUpdateId: uuid(1_046),
        observedAt: harness.iso(3),
        responderPosition: {
          kind: "R",
          latitude: 22.1980,
          longitude: 113.5430,
          accuracyMeters: 10
        }
      },
      responder.sessionToken
    )).status, 200);
    const offerPayload = await offer as { eventId: string; deliveryId: string };
    assert.equal(offerPayload.eventId, eventId);
    assert.ok(offerPayload.deliveryId);
    const enteredPayload = await enteredRadiusPush as {
      coordination: { nearbyCandidateCount: number; pendingOfferCount: number };
    };
    assert.equal(enteredPayload.coordination.nearbyCandidateCount, 1);
    assert.equal(enteredPayload.coordination.pendingOfferCount, 1);

    const expiredOfferOnExit = nextSocketEvent(responderSocket, "response:offer-expired");
    const exitedRadiusPush = nextSocketEvent(patientSocket, "event:coordination-updated");
    assert.equal((await harness.request(
      "PUT",
      "/api/v2/me/responder-position",
      {
        positionUpdateId: uuid(1_047),
        observedAt: harness.iso(4),
        responderPosition: {
          kind: "R",
          latitude: 22.30,
          longitude: 113.5430,
          accuracyMeters: 10
        }
      },
      responder.sessionToken
    )).status, 200);
    const exitedPayload = await exitedRadiusPush as {
      coordination: { nearbyCandidateCount: number; pendingOfferCount: number };
    };
    assert.equal(exitedPayload.coordination.nearbyCandidateCount, 0);
    assert.equal(exitedPayload.coordination.pendingOfferCount, 0);
    const expiredOnExit = await expiredOfferOnExit as { deliveryId: string; reason: string };
    assert.equal(expiredOnExit.deliveryId, offerPayload.deliveryId);
    assert.equal(expiredOnExit.reason, "OFFER_NO_LONGER_ELIGIBLE");
    const after = await harness.request<{
      coordination: { nearbyCandidateCount: number; pendingOfferCount: number };
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.equal(after.body.coordination.nearbyCandidateCount, 0);
    assert.equal(after.body.coordination.pendingOfferCount, 0);
    assert.equal((await harness.request(
      "GET",
      `/api/v2/events/${eventId}`,
      undefined,
      responder.sessionToken
    )).status, 404);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await harness.backend.stop();
  }
});

test("RESOLVED reaches every participant and REST clears active coordination while retaining timeline", async () => {
  const auditStore = new MemoryStateStore(emptyState(testAeds));
  const harness = await makeHarness(auditStore);
  const sockets: Socket[] = [];
  try {
    const patientPairId = uuid(1_060);
    const patient = await bootstrapIPhone(harness, uuid(1_061), patientPairId);
    const watch = await bootstrapWatch(harness, uuid(1_062), patientPairId);
    const responders = [
      await bootstrapIPhone(harness, uuid(1_063), uuid(1_064)),
      await bootstrapIPhone(harness, uuid(1_065), uuid(1_066))
    ];
    await publishPosition(harness, responders[0]!.sessionToken, 22.1980, 113.5430);
    await publishPosition(harness, responders[1]!.sessionToken, 22.1979, 113.5429);
    const eventId = uuid(1_067);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);
    for (let index = 0; index < responders.length; index += 1) {
      const responder = responders[index]!;
      const deliveryId = await pendingDeliveryId(harness, eventId, responder.sessionToken);
      assert.equal((await harness.request(
        "PUT",
        `/api/v2/events/${eventId}/responses/${deliveryId}`,
        { decision: "ACCEPT", decidedAt: harness.iso(10 + index) },
        responder.sessionToken
      )).status, 200);
    }

    const sessions = [patient, ...responders];
    sockets.push(...await Promise.all(sessions.map((session) =>
      connectIPhone(harness.baseURL, session.sessionToken)
    )));
    const terminalPushes = sockets.map((socket) => nextSocketEvent(socket, "event:resolved"));
    const resolved = await harness.request<{
      state: string;
      recruitmentState: string;
    }>(
      "POST",
      `/api/v2/events/${eventId}/resolve`,
      {
        resolutionId: uuid(1_068),
        actor: "PATIENT",
        resolvedAt: harness.iso(20),
        note: "explicit integration-test resolution"
      },
      patient.sessionToken
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.state, "RESOLVED");
    assert.equal(resolved.body.recruitmentState, "COMPLETED");
    for (const payload of await Promise.all(terminalPushes) as Array<{
      eventId: string;
      state: string;
      recruitmentState: string;
    }>) {
      assert.equal(payload.eventId, eventId);
      assert.equal(payload.state, "RESOLVED");
      assert.equal(payload.recruitmentState, "COMPLETED");
    }

    for (const [index, session] of sessions.entries()) {
      const event = await harness.request<{
        state: string;
        viewerRelationship: string;
        pendingResponseRequest: unknown;
        currentAssignment?: unknown;
      }>("GET", `/api/v2/events/${eventId}`, undefined, session.sessionToken);
      assert.equal(event.status, 200);
      assert.equal(event.body.state, "RESOLVED");
      assert.equal(event.body.viewerRelationship, "NEUTRAL");
      assert.equal(event.body.pendingResponseRequest, null);
      assert.equal("currentAssignment" in event.body, false);
      const presence = await harness.request<{
        currentEventId: string | null;
        currentAssignmentId: string | null;
        position: { coordinate: { kind: string } } | null;
        freshness: string;
      }>("GET", "/api/v2/me/presence", undefined, session.sessionToken);
      assert.equal(presence.body.currentEventId, null);
      assert.equal(presence.body.currentAssignmentId, null);
      if (index === 0) assert.equal(presence.body.position, null);
      else assert.equal(presence.body.position?.coordinate.kind, "R");
    }
    const timeline = await harness.request<Array<{ kind: string }>>(
      "GET",
      `/api/v2/events/${eventId}/timeline`,
      undefined,
      patient.sessionToken
    );
    assert.deepEqual(timeline.body.map(entry => entry.kind), ["EVENT_RESOLVED"]);
    const audit = auditStore.read(state => state.timelineByEventId[eventId]!);
    assert.ok(audit.some(entry => entry.kind === "ASSIGNMENT_CREATED"));
    assert.ok(audit.some(entry => entry.kind === "EVENT_RESOLVED"));
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await harness.backend.stop();
  }
});

test("HTTP writes survive a SQLite stop and reopen with current P/R presence task and bounded receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-http-sqlite-"));
  const dataFile = join(directory, "state.sqlite");
  const epoch = Math.floor(Date.now() / 1_000) * 1_000;
  let serverOffsetSeconds = 0;
  let runningBackend: BackendInstance | undefined;
  let inspectionStore: SQLiteStateStore | undefined;
  const config: BackendConfig = {
    host: "127.0.0.1",
    port: 0,
    dataFile,
    legacyDataFile: join(directory, "state.json"),
    fixtureFile: fileURLToPath(new URL(
      "../../contracts/fixtures/demo-scenario.json",
      import.meta.url
    )),
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    authSubjectPepper: "sqlite-api-test-pepper",
    watchAppAttestAppId: "TEAMID.com.aedresponse",
    operatorToken: "operator-sqlite-integration-token",
    production: false
  };
  const startHarness = async (): Promise<IntegrationHarness> => {
    const backend = await createBackend({
      config,
      appleIdentityTokenVerifier: integrationAppleVerifier,
      watchAttestationVerifier: {
      verifyAttestation: async (input) => ({
          verified: input.attestationObject === "d2F0Y2gtYXR0ZXN0YXRpb24=",
          deviceInstanceId: input.deviceInstanceId
        })
      },
      now: () => new Date(epoch + serverOffsetSeconds * 1_000)
    });
    await backend.start();
    runningBackend = backend;
    return harnessForBackend(backend, epoch);
  };
  const stopBackend = async (): Promise<void> => {
    const backend = runningBackend;
    runningBackend = undefined;
    if (backend) await backend.stop();
  };

  try {
    let harness = await startHarness();
    const patientPairId = uuid(1_100);
    const patientDeviceId = uuid(1_101);
    const responderDeviceId = uuid(1_102);
    const patient = await bootstrapIPhone(harness, patientDeviceId, patientPairId);
    const watch = await bootstrapWatch(harness, uuid(1_103), patientPairId);
    const responder = await bootstrapIPhone(harness, responderDeviceId, uuid(1_104));
    await publishPosition(harness, responder.sessionToken, 22.1980, 113.5430);

    const eventId = uuid(1_105);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      {
        ...watchObservation(harness, eventId),
        patientPosition: null,
        patientPositionObservedAt: undefined,
        locationUnavailableReason: "watch location unavailable"
      },
      watch.sessionToken
    )).status, 201);
    serverOffsetSeconds = 1;
    const fallbackPositionUpdateId = uuid(1_112);
    const fallbackUpdate = {
      schemaVersion: "2.0",
      eventId,
      positionUpdateId: fallbackPositionUpdateId,
      observedAt: harness.iso(1),
      patientPosition: {
        kind: "P",
        latitude: 22.1986,
        longitude: 113.5438,
        accuracyMeters: 9
      },
      activationState: "INACTIVE",
      iphoneReachable: false,
      networkAvailable: true
    };
    assert.equal((await harness.request<{ applied: boolean }>(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${fallbackPositionUpdateId}`,
      fallbackUpdate,
      watch.sessionToken
    )).body.applied, false);
    serverOffsetSeconds = 10;
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/events/${eventId}/fallback-position/${fallbackPositionUpdateId}`,
      fallbackUpdate,
      watch.sessionToken
    )).status, 200);

    serverOffsetSeconds = 31;
    const patientPositionUpdateId = uuid(1_106);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/patient-position`,
      {
        positionUpdateId: patientPositionUpdateId,
        observedAt: harness.iso(31),
        patientPosition: {
          kind: "P",
          latitude: 22.1987,
          longitude: 113.5439,
          accuracyMeters: 12
        }
      },
      patient.sessionToken
    )).status, 200);

    serverOffsetSeconds = 32;
    const deliveryId = await pendingDeliveryId(harness, eventId, responder.sessionToken);
    const acceptance = await harness.request<{
      assignment: { id: string; role: string };
    }>(
      "PUT",
      `/api/v2/events/${eventId}/responses/${deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(32) },
      responder.sessionToken
    );
    assert.equal(acceptance.status, 200);
    assert.equal(acceptance.body.assignment.role, "GO_TO_PATIENT");
    const assignmentId = acceptance.body.assignment.id;
    serverOffsetSeconds = 33;
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/assignments/${assignmentId}/status`,
      { status: "EN_ROUTE", occurredAt: harness.iso(33) },
      responder.sessionToken
    )).status, 200);
    serverOffsetSeconds = 34;
    const presenceUpdateId = uuid(1_107);
    assert.equal((await harness.request(
      "PUT",
      "/api/v2/me/presence",
      {
        presenceUpdateId,
        occurredAt: harness.iso(34),
        availableForResponse: false,
        capabilities: { notificationAuthorized: false, locationAuthorized: true }
      },
      responder.sessionToken
    )).status, 200);

    serverOffsetSeconds = 100;
    let latestResponderPositionUpdateId = "";
    for (let index = 0; index < 70; index += 1) {
      latestResponderPositionUpdateId = uuid(30_000 + index);
      const response = await harness.request(
        "PUT",
        "/api/v2/me/responder-position",
        {
          positionUpdateId: latestResponderPositionUpdateId,
          observedAt: harness.iso(31 + index),
          responderPosition: {
            kind: "R",
            latitude: 22.1980 + index * 0.000001,
            longitude: 113.5430,
            accuracyMeters: 9
          }
        },
        responder.sessionToken
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    await stopBackend();

    inspectionStore = await SQLiteStateStore.open(dataFile, []);
    const durable = inspectionStore.read((state) => ({
      patient: state.devices[patientDeviceId],
      responder: state.devices[responderDeviceId],
      event: state.events[eventId],
      assignment: state.assignments[assignmentId],
      responderReceipts: Object.entries(state.positionUpdateReceiptsById)
        .filter(([, receipt]) => receipt.deviceInstanceId === responderDeviceId),
      patientReceipt: state.positionUpdateReceiptsById[patientPositionUpdateId],
      fallbackReceipt: state.positionUpdateReceiptsById[fallbackPositionUpdateId],
      presenceReceipt: state.presenceUpdateReceiptsById[presenceUpdateId],
      timelineKinds: (state.timelineByEventId[eventId] ?? []).map((entry) => entry.kind),
      timeline: state.timelineByEventId[eventId] ?? []
    }));
    assert.deepEqual(durable.patient?.capabilities, {
      notificationAuthorized: true,
      locationAuthorized: true
    });
    assert.equal(durable.patient?.availableForResponse, true);
    assert.equal(durable.patient?.lastSeenAt, harness.iso(31));
    assert.equal(durable.patient?.currentEventId, eventId);
    assert.equal(durable.patient?.currentAssignmentId, undefined);
    assert.equal(durable.patient?.latestPosition?.position.kind, "P");
    assert.equal(durable.patient?.latestPosition?.positionUpdateId, patientPositionUpdateId);
    assert.equal(durable.patient?.latestPosition?.observedAt, harness.iso(31));
    assert.equal(durable.patient?.latestPosition?.serverReceivedAt, harness.iso(31));
    assert.equal(durable.event?.triggeringWatchDeviceId, uuid(1_103));
    assert.equal(durable.event?.patientPosition?.source, "IPHONE_PRIMARY");
    assert.equal(durable.event?.iphonePatientPosition?.positionUpdateId, patientPositionUpdateId);
    assert.equal(durable.event?.watchFallbackPosition?.positionUpdateId, fallbackPositionUpdateId);
    assert.equal(durable.event?.watchFallbackCandidate, undefined);
    assert.equal(durable.event?.watchFallbackCadence?.positionUpdateId, fallbackPositionUpdateId);
    assert.deepEqual(durable.responder?.capabilities, {
      notificationAuthorized: false,
      locationAuthorized: true
    });
    assert.equal(durable.responder?.availableForResponse, false);
    assert.equal(durable.responder?.lastSeenAt, harness.iso(100));
    assert.equal(durable.responder?.currentEventId, eventId);
    assert.equal(durable.responder?.currentAssignmentId, assignmentId);
    assert.equal(durable.responder?.latestPosition?.position.kind, "R");
    assert.equal(durable.responder?.latestPosition?.positionUpdateId, latestResponderPositionUpdateId);
    assert.equal(durable.responder?.latestPosition?.observedAt, harness.iso(100));
    assert.equal(durable.responder?.latestPosition?.serverReceivedAt, harness.iso(100));
    assert.equal(durable.assignment?.status, "EN_ROUTE");
    assert.equal(durable.responderReceipts.length, 64);
    assert.ok(durable.responderReceipts.some(([id]) => id === latestResponderPositionUpdateId));
    assert.equal(JSON.stringify(durable.responderReceipts).includes("latitude"), false);
    assert.equal(durable.patientReceipt?.kind, "P");
    assert.equal(durable.fallbackReceipt?.kind, "P");
    assert.equal(durable.presenceReceipt?.deviceInstanceId, responderDeviceId);
    assert.ok(durable.timelineKinds.includes("PATIENT_POSITION_UPDATED"));
    assert.ok(durable.timelineKinds.includes("RESPONSE_ACCEPTED"));
    assert.ok(durable.timelineKinds.includes("ASSIGNMENT_UPDATED"));
    await inspectionStore.close();
    inspectionStore = undefined;

    serverOffsetSeconds = 101;
    harness = await startHarness();
    const patientPresence = await harness.request<{
      lastSeenAt: string;
      availableForResponse: boolean;
      capabilities: { notificationAuthorized: boolean; locationAuthorized: boolean };
      position: { coordinate: { kind: string }; observedAt: string } | null;
      freshness: string;
      currentEventId: string | null;
      currentAssignmentId: string | null;
    }>("GET", "/api/v2/me/presence", undefined, patient.sessionToken);
    assert.equal(patientPresence.status, 200);
    assert.equal(patientPresence.body.lastSeenAt, harness.iso(101));
    assert.equal(patientPresence.body.availableForResponse, true);
    assert.deepEqual(patientPresence.body.capabilities, {
      notificationAuthorized: true,
      locationAuthorized: true
    });
    assert.equal(patientPresence.body.position?.coordinate.kind, "P");
    assert.equal(patientPresence.body.freshness, "FRESH");
    assert.equal(patientPresence.body.currentEventId, eventId);
    assert.equal(patientPresence.body.currentAssignmentId, null);

    const responderPresence = await harness.request<{
      lastSeenAt: string;
      availableForResponse: boolean;
      capabilities: { notificationAuthorized: boolean; locationAuthorized: boolean };
      position: { coordinate: { kind: string } } | null;
      freshness: string;
      currentEventId: string | null;
      currentAssignmentId: string | null;
    }>("GET", "/api/v2/me/presence", undefined, responder.sessionToken);
    assert.equal(responderPresence.status, 200);
    assert.equal(responderPresence.body.lastSeenAt, harness.iso(101));
    assert.equal(responderPresence.body.availableForResponse, false);
    assert.deepEqual(responderPresence.body.capabilities, {
      notificationAuthorized: false,
      locationAuthorized: true
    });
    assert.equal(responderPresence.body.position?.coordinate.kind, "R");
    assert.equal(
      responderPresence.body.freshness,
      "FRESH"
    );
    assert.equal(responderPresence.body.currentEventId, eventId);
    assert.equal(responderPresence.body.currentAssignmentId, assignmentId);

    const recoveredEvent = await harness.request<{
      viewerRelationship: string;
      currentAssignment: { id: string; status: string };
      patientPosition: { kind: string };
      patientPositionSource: string;
    }>("GET", `/api/v2/events/${eventId}`, undefined, responder.sessionToken);
    assert.equal(recoveredEvent.status, 200);
    assert.equal(recoveredEvent.body.viewerRelationship, "RESPONDER");
    assert.equal(recoveredEvent.body.currentAssignment.id, assignmentId);
    assert.equal(recoveredEvent.body.currentAssignment.status, "EN_ROUTE");
    assert.equal(recoveredEvent.body.patientPosition.kind, "P");
    assert.equal(recoveredEvent.body.patientPositionSource, "IPHONE_PRIMARY");
    const recoveredTimeline = await harness.request<Array<{ kind: string }>>(
      "GET",
      `/api/v2/events/${eventId}/timeline`,
      undefined,
      responder.sessionToken
    );
    assert.deepEqual(recoveredTimeline.body.map(entry => entry.kind), ["EVENT_ACTIVATED"]);
    await stopBackend();
    inspectionStore = await SQLiteStateStore.open(dataFile, []);
    assert.deepEqual(inspectionStore.read(state => state.timelineByEventId[eventId]), durable.timeline);
  } finally {
    await inspectionStore?.close().catch(() => undefined);
    await stopBackend().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP exposes the canonical patient end/status confirmation and responder exit boundaries", async () => {
  const harness = await makeHarness();
  try {
    const patient = await bootstrapIPhone(harness, uuid(1_200), uuid(1_201));
    const watch = await bootstrapWatch(harness, uuid(1_202), uuid(1_201));
    const eventId = uuid(1_203);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    )).status, 201);

    harness.setServerOffset(1_800);
    const statusCheck = await harness.request<{
      state: string;
      statusConfirmation: {
        confirmationId: string;
        prompt: string;
        responseDeadlineAt: string;
      };
    }>("GET", `/api/v2/events/${eventId}`, undefined, patient.sessionToken);
    assert.equal(statusCheck.status, 200, JSON.stringify(statusCheck.body));
    assert.equal(statusCheck.body.state, "ACTIVE");
    assert.equal(statusCheck.body.statusConfirmation.prompt, "STILL_IN_PROGRESS");
    assert.equal(statusCheck.body.statusConfirmation.responseDeadlineAt, harness.iso(2_100));
    const continued = await harness.request<{
      idempotent: boolean;
      nextCheckAt: string;
      respondedAt: string;
    }>(
      "POST",
      `/api/v2/events/${eventId}/status-confirmation`,
      {
        confirmationId: statusCheck.body.statusConfirmation.confirmationId,
        response: "CONTINUE",
        respondedAt: harness.iso(1_801)
      },
      patient.sessionToken
    );
    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.equal(continued.body.idempotent, false);
    assert.equal(continued.body.respondedAt, harness.iso(1_800));
    assert.equal(continued.body.nextCheckAt, harness.iso(3_600));

    const continuedReplay = await harness.request<typeof continued.body>(
      "POST",
      `/api/v2/events/${eventId}/status-confirmation`,
      {
        confirmationId: statusCheck.body.statusConfirmation.confirmationId,
        response: "CONTINUE",
        respondedAt: harness.iso(1_801)
      },
      patient.sessionToken
    );
    assert.equal(continuedReplay.status, 200);
    assert.equal(continuedReplay.body.idempotent, true);

    harness.setServerOffset(0);
    const responder = await bootstrapIPhone(harness, uuid(1_204), uuid(1_205));
    await publishPosition(harness, responder.sessionToken, 22.198, 113.543);
    const exitEventId = uuid(1_206);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${exitEventId}`,
      watchObservation(harness, exitEventId),
      watch.sessionToken
    )).status, 201);
    const deliveryId = await pendingDeliveryId(harness, exitEventId, responder.sessionToken);
    const pending = await harness.request<{
      eventPositionParticipationStartedAt: string | null;
      eventPositionParticipationEndedAt: string | null;
    }>("GET", `/api/v2/events/${exitEventId}`, undefined, responder.sessionToken);
    assert.equal(pending.body.eventPositionParticipationStartedAt, null);
    assert.equal(pending.body.eventPositionParticipationEndedAt, null);
    const tooEarlyDecision = await harness.request(
      "PUT",
      `/api/v2/events/${exitEventId}/responses/${deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(-1) },
      responder.sessionToken
    );
    assert.equal(tooEarlyDecision.status, 400);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${exitEventId}/responses/${deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(10) },
      responder.sessionToken
    )).status, 200);
    const acceptedView = await harness.request<{
      eventPositionParticipationStartedAt: string | null;
      eventPositionParticipationEndedAt: string | null;
    }>("GET", `/api/v2/events/${exitEventId}`, undefined, responder.sessionToken);
    assert.equal(acceptedView.body.eventPositionParticipationStartedAt, harness.iso(0));
    assert.equal(acceptedView.body.eventPositionParticipationEndedAt, null);
    harness.setServerOffset(20);
    const exit = await harness.request<{
      exitId: string;
      eventId: string;
      exitedAt: string;
      idempotent: boolean;
    }>(
      "POST",
      `/api/v2/events/${exitEventId}/exit`,
      { exitId: uuid(1_207), exitedAt: harness.iso(-1), soleResponderConfirmed: true },
      responder.sessionToken
    );
    assert.equal(exit.status, 200, JSON.stringify(exit.body));
    assert.equal(exit.body.idempotent, false);
    assert.equal(exit.body.exitedAt, harness.iso(0));
    assert.equal((await harness.request(
      "GET",
      `/api/v2/events/${exitEventId}`,
      undefined,
      responder.sessionToken
    )).status, 404);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${exitEventId}/responses/${deliveryId}`,
      { decision: "REFUSE", decidedAt: harness.iso(21) },
      responder.sessionToken
    )).status, 403);
  } finally {
    await harness.backend.stop();
  }
});

test("event position batches persist FIX/NO_NEW_FIX, are idempotent, and never regress current P/R", async () => {
  const harness = await makeHarness();
  try {
    const patient = await bootstrapIPhone(harness, uuid(1_300), uuid(1_301));
    const watch = await bootstrapWatch(harness, uuid(1_302), uuid(1_301));
    const responder = await bootstrapIPhone(harness, uuid(1_303), uuid(1_304));
    await publishPosition(harness, responder.sessionToken, 22.198, 113.543);

    const eventId = uuid(1_305);
    const created = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    );
    assert.equal(created.status, 201);
    const deliveryId = await pendingDeliveryId(harness, eventId, responder.sessionToken);
    const accepted = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/responses/${deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(2) },
      responder.sessionToken
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    const justOpenedSlotBatchId = uuid(1_331);
    const justOpenedSlotBatch = {
      schemaVersion: "2.0",
      eventId,
      batchId: justOpenedSlotBatchId,
      records: [{
        recordId: uuid(1_332),
        slotAt: harness.iso(0),
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX"
      }]
    };
    const tooEarly = await harness.request<{ status: number; type: string; detail: string }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${justOpenedSlotBatchId}`,
      justOpenedSlotBatch,
      patient.sessionToken
    );
    assert.equal(tooEarly.status, 425, JSON.stringify(tooEarly.body));
    assert.equal(tooEarly.body.type, "https://aedresponse.invalid/problems/too-early");
    assert.match(tooEarly.body.detail, /retry at or after/);
    harness.setServerOffset(1);
    const retryAfterSlotEnd = await harness.request<{ idempotent: boolean }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${justOpenedSlotBatchId}`,
      justOpenedSlotBatch,
      patient.sessionToken
    );
    assert.equal(retryAfterSlotEnd.status, 200);
    assert.equal(retryAfterSlotEnd.body.idempotent, false, "425 must not persist the batch");
    harness.setServerOffset(8);

    const patientBatchId = uuid(1_306);
    const patientBatch = {
      schemaVersion: "2.0",
      eventId,
      batchId: patientBatchId,
      records: [
        {
          recordId: uuid(1_307),
          slotAt: harness.iso(3),
          status: "FIX",
          fixObservedAt: new Date(Date.parse(harness.iso(3)) + 500).toISOString(),
          position: {
            kind: "P",
            latitude: 22.1988,
            longitude: 113.5438,
            accuracyMeters: 8
          }
        },
        {
          recordId: uuid(1_308),
          slotAt: harness.iso(4),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        },
        {
          recordId: uuid(1_309),
          slotAt: harness.iso(5),
          status: "FIX",
          fixObservedAt: harness.iso(5),
          position: {
            kind: "P",
            latitude: 22.1991,
            longitude: 113.5441,
            accuracyMeters: 7
          }
        }
      ]
    };
    const first = await harness.request<{
      batchId: string;
      acceptedRecordCount: number;
      idempotent: boolean;
      records: Array<{ recordId: string; appliedToLatest: boolean; ignoredAsStale: boolean }>;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${patientBatchId}`,
      patientBatch,
      patient.sessionToken
    );
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.batchId, patientBatchId);
    assert.equal(first.body.acceptedRecordCount, 3);
    assert.equal(first.body.idempotent, false);
    assert.deepEqual(first.body.records.map((record) => record.appliedToLatest), [true, false, true]);
    assert.deepEqual(first.body.records.map((record) => record.ignoredAsStale), [false, false, false]);

    const replay = await harness.request<typeof first.body>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${patientBatchId}`,
      patientBatch,
      patient.sessionToken
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);
    assert.deepEqual(replay.body.records, first.body.records);

    const conflictingBatchReplay = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${patientBatchId}`,
      {
        ...patientBatch,
        records: patientBatch.records.map((record, index) => index === 0
          ? {
            ...record,
            slotAt: harness.iso(6),
            fixObservedAt: new Date(Date.parse(harness.iso(6)) + 500).toISOString()
          }
          : record)
      },
      patient.sessionToken
    );
    assert.equal(conflictingBatchReplay.status, 409);

    const staleBatch = await harness.request<{
      records: Array<{ appliedToLatest: boolean; ignoredAsStale: boolean }>;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${uuid(1_310)}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: uuid(1_310),
        records: [{
          recordId: uuid(1_311),
          slotAt: harness.iso(2),
          status: "FIX",
          fixObservedAt: harness.iso(2),
          position: {
            kind: "P",
            latitude: 22.18,
            longitude: 113.52,
            accuracyMeters: 9
          }
        }]
      },
      patient.sessionToken
    );
    assert.equal(staleBatch.status, 200, JSON.stringify(staleBatch.body));
    assert.equal(staleBatch.body.records[0]?.appliedToLatest, false);
    assert.equal(staleBatch.body.records[0]?.ignoredAsStale, true);

    const duplicateSlotBatchId = uuid(1_317);
    const duplicateSlot = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${duplicateSlotBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: duplicateSlotBatchId,
        records: [{
          recordId: uuid(1_318),
          slotAt: harness.iso(5),
          status: "FIX",
          fixObservedAt: harness.iso(5),
          position: {
            kind: "P",
            latitude: 22.2,
            longitude: 113.545,
            accuracyMeters: 8
          }
        }]
      },
      patient.sessionToken
    );
    assert.equal(duplicateSlot.status, 409, JSON.stringify(duplicateSlot.body));

    const nonSecondSlotBatchId = uuid(1_326);
    const nonSecondSlot = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${nonSecondSlotBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: nonSecondSlotBatchId,
        records: [{
          recordId: uuid(1_327),
          slotAt: new Date(Date.parse(harness.iso(9)) + 1).toISOString(),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        }]
      },
      patient.sessionToken
    );
    assert.equal(nonSecondSlot.status, 400, JSON.stringify(nonSecondSlot.body));

    const nonContiguousBatchId = uuid(1_328);
    const nonContiguous = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${nonContiguousBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: nonContiguousBatchId,
        records: [
          {
            recordId: uuid(1_329),
            slotAt: harness.iso(9),
            status: "NO_NEW_FIX",
            gapReason: "NO_FIX"
          },
          {
            recordId: uuid(1_330),
            slotAt: harness.iso(11),
            status: "NO_NEW_FIX",
            gapReason: "APP_NOT_RUNNING"
          }
        ]
      },
      patient.sessionToken
    );
    assert.equal(nonContiguous.status, 400, JSON.stringify(nonContiguous.body));

    const patientPresence = await harness.request<{
      position: { coordinate: { latitude: number }; observedAt: string } | null;
      freshness: string;
    }>("GET", "/api/v2/me/presence", undefined, patient.sessionToken);
    assert.equal(patientPresence.status, 200);
    assert.equal(patientPresence.body.position?.observedAt, harness.iso(5));
    assert.equal(patientPresence.body.position?.coordinate.latitude, 22.1991);
    assert.equal(patientPresence.body.freshness, "FRESH");

    const responderBatchId = uuid(1_312);
    const responderBatch = {
      schemaVersion: "2.0",
      eventId,
      batchId: responderBatchId,
      records: [
        {
          recordId: uuid(1_313),
          slotAt: harness.iso(6),
          status: "FIX",
          fixObservedAt: new Date(Date.parse(harness.iso(6)) + 500).toISOString(),
          position: {
            kind: "R",
            latitude: 22.1982,
            longitude: 113.5432,
            accuracyMeters: 9
          }
        },
        {
          recordId: uuid(1_314),
          slotAt: harness.iso(7),
          status: "NO_NEW_FIX",
          gapReason: "APP_NOT_RUNNING"
        }
      ]
    };
    const responderBatchResponse = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${responderBatchId}`,
      responderBatch,
      responder.sessionToken
    );
    assert.equal(responderBatchResponse.status, 200, JSON.stringify(responderBatchResponse.body));
    const responderPresence = await harness.request<{
      position: { coordinate: { kind: string } } | null;
      freshness: string;
    }>("GET", "/api/v2/me/presence", undefined, responder.sessionToken);
    assert.equal(responderPresence.status, 200);
    assert.equal(responderPresence.body.position?.coordinate.kind, "R");
    assert.equal(responderPresence.body.freshness, "FRESH");

    harness.setServerOffset(9);
    const reusedRecordId = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${uuid(1_315)}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: uuid(1_315),
        records: [{
          recordId: uuid(1_307),
          slotAt: harness.iso(8),
          status: "FIX",
          fixObservedAt: harness.iso(8),
          position: {
            kind: "P",
            latitude: 22.1992,
            longitude: 113.5442,
            accuracyMeters: 7
          }
        }]
      },
      patient.sessionToken
    );
    assert.equal(reusedRecordId.status, 409);

    const tooManyBatchId = uuid(1_319);
    const tooMany = await harness.request<{ status: number; type: string }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${tooManyBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: tooManyBatchId,
        records: Array.from({ length: 6 }, (_, index) => ({
          recordId: uuid(1_320 + index),
          slotAt: harness.iso(20 + index),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        }))
      },
      patient.sessionToken
    );
    assert.equal(tooMany.status, 422);
    assert.equal(tooMany.body.status, 422);
    assert.equal(tooMany.body.type, "https://aedresponse.invalid/problems/unprocessable-entity");

    const timeline = await harness.request<Array<{ kind: string; message: string }>>(
      "GET",
      `/api/v2/events/${eventId}/timeline`,
      undefined,
      patient.sessionToken
    );
    assert.equal(timeline.status, 200);
    assert.equal(
      timeline.body.some((entry) => entry.kind === "PATIENT_POSITION_UPDATED"
        && entry.message.includes("position batch")),
      false
    );
  } finally {
    await harness.backend.stop();
  }
});

test("event position batches accept bounded late evidence after termination and reject post-event samples", async () => {
  const harness = await makeHarness();
  try {
    const patient = await bootstrapIPhone(harness, uuid(1_370), uuid(1_371));
    const watch = await bootstrapWatch(harness, uuid(1_372), uuid(1_371));
    const responder = await bootstrapIPhone(harness, uuid(1_373), uuid(1_374));
    // The client-facing view no longer carries the idempotency key, so take it
    // from the publish call that created it.
    const initialPositionUpdateId =
      await publishPosition(harness, responder.sessionToken, 22.198, 113.543);
    assert.ok(initialPositionUpdateId);

    const eventId = uuid(1_375);
    const created = await harness.request(
      "PUT",
      `/api/v2/watch/emergency-observations/${eventId}`,
      watchObservation(harness, eventId),
      watch.sessionToken
    );
    assert.equal(created.status, 201);
    const deliveryId = await pendingDeliveryId(harness, eventId, responder.sessionToken);
    const pendingBatchId = uuid(1_384);
    const pendingBatch = await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${pendingBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: pendingBatchId,
        records: [{
          recordId: uuid(1_385),
          slotAt: harness.iso(1),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        }]
      },
      responder.sessionToken
    );
    assert.equal(pendingBatch.status, 403, JSON.stringify(pendingBatch.body));
    harness.setServerOffset(2);
    assert.equal((await harness.request(
      "PUT",
      `/api/v2/events/${eventId}/responses/${deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(2) },
      responder.sessionToken
    )).status, 200);

    harness.setServerOffset(25);
    const resolved = await harness.request(
      "POST",
      `/api/v2/events/${eventId}/resolve`,
      {
        resolutionId: uuid(1_376),
        actor: "PATIENT",
        resolvedAt: new Date(Date.parse(harness.iso(25)) - 500).toISOString(),
        note: "bounded late evidence test"
      },
      patient.sessionToken
    );
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));

    harness.setServerOffset(30);
    const lateBatchId = uuid(1_377);
    const lateBatch = {
      schemaVersion: "2.0",
      eventId,
      batchId: lateBatchId,
      records: [
        {
          recordId: uuid(1_378),
          slotAt: harness.iso(10),
          status: "FIX",
          fixObservedAt: new Date(Date.parse(harness.iso(10)) + 500).toISOString(),
          position: {
            kind: "R",
            latitude: 22.1982,
            longitude: 113.5432,
            accuracyMeters: 9
          }
        },
        {
          recordId: uuid(1_379),
          slotAt: harness.iso(11),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        }
      ]
    };
    const late = await harness.request<{
      batchId: string;
      idempotent: boolean;
      records: Array<{
        persisted: boolean;
        appliedToLatest: boolean;
        ignoredAsStale: boolean;
      }>;
    }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${lateBatchId}`,
      lateBatch,
      responder.sessionToken
    );
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.equal(late.body.batchId, lateBatchId);
    assert.equal(late.body.idempotent, false);
    assert.deepEqual(
      late.body.records.map(({ persisted, appliedToLatest, ignoredAsStale }) => ({
        persisted,
        appliedToLatest,
        ignoredAsStale
      })),
      [
        { persisted: true, appliedToLatest: false, ignoredAsStale: false },
        { persisted: true, appliedToLatest: false, ignoredAsStale: false }
      ]
    );

    const replay = await harness.request<typeof late.body>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${lateBatchId}`,
      lateBatch,
      responder.sessionToken
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);
    assert.deepEqual(replay.body.records, late.body.records);

    const fixAtEndBatchId = uuid(1_386);
    const fixAtEnd = await harness.request<{ status: number; detail: string }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${fixAtEndBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: fixAtEndBatchId,
        records: [{
          recordId: uuid(1_387),
          slotAt: harness.iso(24),
          status: "FIX",
          fixObservedAt: new Date(Date.parse(harness.iso(25)) - 500).toISOString(),
          position: {
            kind: "R",
            latitude: 22.1982,
            longitude: 113.5432,
            accuracyMeters: 9
          }
        }]
      },
      responder.sessionToken
    );
    assert.equal(fixAtEnd.status, 409, JSON.stringify(fixAtEnd.body));
    assert.match(fixAtEnd.body.detail, /participation time window/);

    const preParticipationBatchId = uuid(1_380);
    const preParticipation = await harness.request<{ status: number; detail: string }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${preParticipationBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: preParticipationBatchId,
        records: [{
          recordId: uuid(1_381),
          slotAt: harness.iso(1),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        }]
      },
      responder.sessionToken
    );
    assert.equal(preParticipation.status, 409, JSON.stringify(preParticipation.body));

    const tooLateBatchId = uuid(1_382);
    const tooLate = await harness.request<{ status: number; detail: string }>(
      "PUT",
      `/api/v2/events/${eventId}/position-batches/${tooLateBatchId}`,
      {
        schemaVersion: "2.0",
        eventId,
        batchId: tooLateBatchId,
        records: [{
          recordId: uuid(1_383),
          slotAt: harness.iso(25),
          status: "NO_NEW_FIX",
          gapReason: "NO_FIX"
        }]
      },
      responder.sessionToken
    );
    assert.equal(tooLate.status, 409, JSON.stringify(tooLate.body));
    assert.match(tooLate.body.detail, /active time window/);

    const responderPresence = await harness.request<{
      position: { coordinate: { latitude: number } } | null;
      freshness: string;
    }>("GET", "/api/v2/me/presence", undefined, responder.sessionToken);
    assert.equal(responderPresence.status, 200);
    // The rejected post-event sample must not have moved the stored position; the
    // view reports the same coordinate the initial publish produced.
    assert.equal(responderPresence.body.position?.coordinate.latitude, 22.198);
    assert.equal(responderPresence.body.freshness, "FRESH");
    void initialPositionUpdateId;
  } finally {
    await harness.backend.stop();
  }
});

test("standby position projection carries an explicit freshness verdict at the TTL boundary", async () => {
  const harness = await makeHarness();
  try {
    const responder = await bootstrapIPhone(harness, uuid(1_350), uuid(1_351));
    await publishPosition(harness, responder.sessionToken, 22.198, 113.543);

    harness.setServerOffset(600);
    const atBoundary = await harness.request<{ position: unknown; freshness: string }>(
      "GET",
      "/api/v2/me/presence",
      undefined,
      responder.sessionToken
    );
    assert.equal(atBoundary.status, 200);
    // Exactly 600 s is still FRESH: the reclamation and freshness rules share the
    // same exclusive boundary (`>`), so they cannot disagree at the edge.
    assert.notEqual(atBoundary.body.position, null);
    assert.equal(atBoundary.body.freshness, "FRESH");

    harness.setServerOffset(601);
    const afterBoundary = await harness.request<{ position: unknown; freshness: string }>(
      "GET",
      "/api/v2/me/presence",
      undefined,
      responder.sessionToken
    );
    assert.equal(afterBoundary.status, 200);
    // A standby device past the limit has its sample reclaimed outright, so it is
    // UNAVAILABLE rather than a retained STALE last-known position.  Active
    // participants keep theirs and report STALE (see the freshness baseline).
    assert.equal(afterBoundary.body.position, null);
    assert.equal(afterBoundary.body.freshness, "UNAVAILABLE");
  } finally {
    await harness.backend.stop();
  }
});


test("HTTP MapKit calculation protects context access and confirms submitted distances", async t => {
  const harness = await makeHarness(new MemoryStateStore(emptyState(testAeds)), { navigationMode: "CLIENT_MAPKIT" });
  t.after(() => harness.backend.stop());
  const patient = await bootstrapIPhone(harness, uuid(81001), uuid(81002));
  const first = await bootstrapIPhone(harness, uuid(81003), uuid(81004));
  const second = await bootstrapIPhone(harness, uuid(81005), uuid(81006));
  await publishPosition(harness, first.sessionToken, 22.198, 113.543);
  await publishPosition(harness, second.sessionToken, 22.1981, 113.5431);
  const eventId = uuid(81007);
  await harness.backend.service.reportFoundPatient(harness.backend.service.authenticateToken(patient.sessionToken), {
    eventId, observedAt: harness.iso(0), patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 5 }
  });
  const path = `/api/v2/events/${eventId}/aed-route-calculation`;
  assert.equal((await harness.request("GET", path)).status, 401);
  assert.equal((await harness.request("GET", path, undefined, first.sessionToken)).status, 403);
  for (const device of [first, second]) {
    const deliveryId = await pendingDeliveryId(harness, eventId, device.sessionToken);
    const accepted = await harness.request("PUT", `/api/v2/events/${eventId}/responses/${deliveryId}`,
      { decision: "ACCEPT", decidedAt: harness.iso(0) }, device.sessionToken);
    assert.equal(accepted.status, 200);
  }
  const issued = await harness.request<{ context: import("../src/client-mapkit-routes.js").ClientRouteContext }>("GET", path, undefined, first.sessionToken);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.context.aeds.length > 0);
  const body = { calculationId: issued.body.context.calculationId,
    routes: issued.body.context.aeds.map(aed => ({ aedId: aed.id, toAedMeters: 1500, toPatientMeters: 1500 })) };
  assert.equal((await harness.request("PUT", path, { ...body, role: "FETCH_AED" }, first.sessionToken)).status, 400);
  assert.equal((await harness.request("PUT", path, body, second.sessionToken)).status, 409);
  const confirmed = await harness.request<{ currentAssignment: { role: string; route: { distanceSource: string } } }>("PUT", path, body, first.sessionToken);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.currentAssignment.role, "FETCH_AED");
  assert.equal(confirmed.body.currentAssignment.route.distanceSource, "CLIENT_MAPKIT");
});
