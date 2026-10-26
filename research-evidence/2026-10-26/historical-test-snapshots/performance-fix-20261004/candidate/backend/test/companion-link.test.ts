import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import {
  companionLinkClientDataHash,
  DeterministicPhoneChallengeProvider,
  type WatchAttestationVerificationRequest,
  type WatchAttestationVerifier
} from "../src/auth.js";
import type { SessionBootstrapRequest } from "../src/contracts.js";
import { HttpProblem } from "../src/errors.js";
import { emptyState } from "../src/models.js";
import {
  AEDResponseService,
  type AccountPrincipal,
  type DevicePrincipal
} from "../src/service.js";
import { createBackend } from "../src/server.js";
import { MemoryStateStore } from "../src/store.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";
const CODE = "135790";
const PEPPER = "companion-link-test-pepper";
const APP_ID = "TEAMID.com.aedresponse";
const ATTESTATION_OBJECT = "d2F0Y2gtYXR0ZXN0YXRpb24=";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataFile: "/tmp/aedresponse-companion-link.sqlite",
    fixtureFile: "/tmp/aedresponse-companion-link-fixture.json",
    sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 1_000,
    positionMaxAgeSeconds: 600,
    maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50,
    bootstrapLimitPerMinute: 100,
    authSubjectPepper: PEPPER,
    watchAppAttestAppId: APP_ID,
    production: false,
    ...overrides
  };
}

class TestWatchAttestationVerifier implements WatchAttestationVerifier {
  readonly calls: WatchAttestationVerificationRequest[] = [];
  readonly allowedDeviceIds = new Set<string>();

  async verifyAttestation(input: WatchAttestationVerificationRequest) {
    this.calls.push(input);
    return {
      verified: input.attestationObject === ATTESTATION_OBJECT
        && input.appAttestKeyId === "watch-key"
        && this.allowedDeviceIds.has(input.deviceInstanceId),
      deviceInstanceId: input.deviceInstanceId
    };
  }
}

function iPhoneBootstrapRequest(deviceInstanceId: string, companionPairId: string): SessionBootstrapRequest {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    companionPairId,
    agreementAcceptances: [
      { kind: "PATIENT", version: "2.0", acceptedAt: BASE_TIME },
      { kind: "VOLUNTEER_RESPONDER", version: "2.0", acceptedAt: BASE_TIME },
      { kind: "PRIVACY_POLICY", version: "2.0", acceptedAt: BASE_TIME },
      {
        kind: "SENSITIVE_PERSONAL_INFORMATION",
        version: "2.0",
        acceptedAt: BASE_TIME
      }
    ],
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  };
}

interface DirectHarness {
  service: AEDResponseService;
  store: MemoryStateStore;
  verifier: TestWatchAttestationVerifier;
  setNow(value: string): void;
}

function makeHarness(overrides: Partial<BackendConfig> = {}): DirectHarness {
  let currentTime = new Date(BASE_TIME);
  const store = new MemoryStateStore(emptyState());
  const verifier = new TestWatchAttestationVerifier();
  const phone = new DeterministicPhoneChallengeProvider(CODE, () => currentTime);
  return {
    service: new AEDResponseService(
      store,
      makeConfig(overrides),
      undefined,
      () => currentTime,
      { phone, watchAttestation: verifier }
    ),
    store,
    verifier,
    setNow(value) {
      currentTime = new Date(value);
    }
  };
}

async function accountPrincipal(
  harness: DirectHarness,
  phoneNumber: string
): Promise<AccountPrincipal> {
  const challenge = await harness.service.requestPhoneChallenge(phoneNumber);
  const login = await harness.service.verifyPhoneChallenge({
    challengeId: challenge.challengeId,
    phoneNumber,
    code: CODE
  });
  const principal = harness.service.authenticateToken(login.sessionToken);
  assert.equal(principal.kind, "ACCOUNT");
  return principal as AccountPrincipal;
}

async function iPhonePrincipal(
  harness: DirectHarness,
  account: AccountPrincipal,
  deviceInstanceId: string,
  companionPairId: string
): Promise<DevicePrincipal> {
  const session = await harness.service.bootstrap(
    account,
    iPhoneBootstrapRequest(deviceInstanceId, companionPairId),
    `bootstrap:${deviceInstanceId}`
  );
  const principal = harness.service.authenticateToken(session.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  return principal as DevicePrincipal;
}

async function linkWatch(
  harness: DirectHarness,
  iPhone: DevicePrincipal,
  watchDeviceId: string,
  pairId = iPhone.companionPairId
): Promise<{ sessionToken: string; refreshToken: string; companionLinkTicket: string }> {
  harness.verifier.allowedDeviceIds.add(watchDeviceId);
  const ticket = await harness.service.createCompanionLinkTicket(iPhone, {
    companionPairId: pairId
  });
  const session = await harness.service.redeemCompanionLinkTicket({
    deviceInstanceId: watchDeviceId,
    companionPairId: pairId,
    companionLinkTicket: ticket.companionLinkTicket,
    appAttestKeyId: "watch-key",
    attestationObject: ATTESTATION_OBJECT
  });
  assert.ok(session.refreshToken);
  return {
    sessionToken: session.sessionToken,
    refreshToken: session.refreshToken!,
    companionLinkTicket: ticket.companionLinkTicket
  };
}

test("companion link binds user/device/pair, computes verifier challenge, and issues Watch refresh", async () => {
  const harness = makeHarness();
  const account = await accountPrincipal(harness, "+8613800138000");
  const iPhone = await iPhonePrincipal(harness, account, uuid(1), uuid(2));
  const linked = await linkWatch(harness, iPhone, uuid(3));
  assert.equal(linked.sessionToken.length >= 32, true);
  assert.equal(linked.refreshToken.length >= 32, true);
  const call = harness.verifier.calls.at(-1);
  assert.ok(call);
  assert.equal(call?.appAttestKeyId, "watch-key");
  assert.equal(call?.attestationObject, ATTESTATION_OBJECT);
  assert.equal(call?.deviceInstanceId, uuid(3));
  assert.equal(call?.companionPairId, uuid(2));
  assert.equal(call?.userId, iPhone.userId);
  assert.equal(call?.accountId, iPhone.accountId);
  assert.equal(call?.expectedChallenge.length, 64);
  assert.equal(call?.appId, APP_ID);
  assert.equal(
    call?.expectedClientDataHash,
    companionLinkClientDataHash({
      companionLinkTicketHash: call?.expectedChallenge ?? "",
      deviceInstanceId: uuid(3),
      companionPairId: uuid(2),
      userId: iPhone.userId!,
      accountId: iPhone.accountId!
    })
  );
  const serialized = JSON.stringify(harness.store.read((state) => state));
  assert.doesNotMatch(serialized, new RegExp(linked.companionLinkTicket));
  assert.equal(
    harness.store.read((state) => state.devices[uuid(3)]?.userId),
    iPhone.userId
  );
});

test("companion tickets reject provider absence, expiry, wrong pair/device and replay", async () => {
  const noProvider = makeHarness();
  const account = await accountPrincipal(noProvider, "+8613800138000");
  const iPhone = await iPhonePrincipal(noProvider, account, uuid(10), uuid(11));
  const ticket = await noProvider.service.createCompanionLinkTicket(iPhone);
  const noVerifier = new AEDResponseService(
    noProvider.store,
    makeConfig(),
    undefined,
    undefined,
    {}
  );
  await assert.rejects(
    noVerifier.redeemCompanionLinkTicket({
      deviceInstanceId: uuid(12),
      companionPairId: uuid(11),
      companionLinkTicket: ticket.companionLinkTicket,
      appAttestKeyId: "watch-key",
      attestationObject: ATTESTATION_OBJECT
    }),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 503
      && /WATCH/.test(error.detail)
  );

  await assert.rejects(
    noProvider.service.redeemCompanionLinkTicket({
      deviceInstanceId: uuid(12),
      companionPairId: uuid(99),
      companionLinkTicket: ticket.companionLinkTicket,
      appAttestKeyId: "watch-key",
      attestationObject: ATTESTATION_OBJECT
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );

  await assert.rejects(
    noProvider.service.redeemCompanionLinkTicket({
      deviceInstanceId: uuid(13),
      companionPairId: uuid(11),
      companionLinkTicket: ticket.companionLinkTicket,
      appAttestKeyId: "watch-key",
      attestationObject: ATTESTATION_OBJECT
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );

  noProvider.setNow("2026-09-05T00:05:01.000Z");
  await assert.rejects(
    noProvider.service.redeemCompanionLinkTicket({
      deviceInstanceId: uuid(12),
      companionPairId: uuid(11),
      companionLinkTicket: ticket.companionLinkTicket,
      appAttestKeyId: "watch-key",
      attestationObject: ATTESTATION_OBJECT
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
});

test("companion ticket consumption is serialized and cannot be replayed concurrently", async () => {
  const harness = makeHarness();
  const account = await accountPrincipal(harness, "+8613800138000");
  const iPhone = await iPhonePrincipal(harness, account, uuid(20), uuid(21));
  harness.verifier.allowedDeviceIds.add(uuid(22));
  const ticket = await harness.service.createCompanionLinkTicket(iPhone);
  const request = {
    deviceInstanceId: uuid(22),
    companionPairId: uuid(21),
    companionLinkTicket: ticket.companionLinkTicket,
    appAttestKeyId: "watch-key",
    attestationObject: ATTESTATION_OBJECT
  } as const;
  const results = await Promise.allSettled([
    harness.service.redeemCompanionLinkTicket(request),
    harness.service.redeemCompanionLinkTicket(request)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(rejected.reason instanceof HttpProblem, true);
  assert.equal((rejected.reason as HttpProblem).status, 401);
});

test("wrong-user Watch binding and iPhone logout revoke Watch access, refresh, and tickets", async () => {
  const harness = makeHarness();
  const firstAccount = await accountPrincipal(harness, "+8613800138000");
  const firstIPhone = await iPhonePrincipal(harness, firstAccount, uuid(30), uuid(31));
  const firstWatch = await linkWatch(harness, firstIPhone, uuid(35));
  const secondAccount = await accountPrincipal(harness, "+8613900139000");
  const secondIPhone = await iPhonePrincipal(harness, secondAccount, uuid(32), uuid(33));
  const secondWatch = await linkWatch(harness, secondIPhone, uuid(34));
  const firstTicket = await harness.service.createCompanionLinkTicket(firstIPhone);
  await assert.rejects(
    harness.service.redeemCompanionLinkTicket({
      deviceInstanceId: uuid(34),
      companionPairId: uuid(31),
      companionLinkTicket: firstTicket.companionLinkTicket,
      appAttestKeyId: "watch-key",
      attestationObject: ATTESTATION_OBJECT
    }),
    (error: unknown) => error instanceof HttpProblem && error.status === 403
  );

  await harness.service.logout(firstIPhone);
  assert.throws(() => harness.service.authenticateToken(firstWatch.sessionToken), /authenticated/);
  await assert.rejects(
    harness.service.refreshWatchSession(firstWatch.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
  assert.equal(
    harness.store.read((state) => state.devices[uuid(35)]?.companionLinkRevokedAt !== undefined),
    true
  );
});

test("the same user cannot keep a responder role on another iPhone or pair", async () => {
  const harness = makeHarness();
  const userAccount = await accountPrincipal(harness, "+8613800138000");
  const patient = await iPhonePrincipal(harness, userAccount, uuid(60), uuid(61));
  const secondIPhone = await iPhonePrincipal(harness, userAccount, uuid(62), uuid(63));
  const otherAccount = await accountPrincipal(harness, "+8613900139000");
  const otherPatient = await iPhonePrincipal(harness, otherAccount, uuid(64), uuid(65));
  const otherWatch = await linkWatch(harness, otherPatient, uuid(66));
  const otherWatchPrincipal = harness.service.authenticateToken(otherWatch.sessionToken);
  assert.equal(otherWatchPrincipal.kind, "DEVICE");

  await harness.service.updateResponderPosition(secondIPhone, {
    positionUpdateId: uuid(67),
    responderPosition: {
      kind: "R",
      latitude: 22.198,
      longitude: 113.543,
      accuracyMeters: 10
    },
    observedAt: BASE_TIME
  });
  const oldEventId = uuid(68);
  await harness.service.reportWatchObservation(otherWatchPrincipal, oldEventId, {
    schemaVersion: "2.0",
    eventId: oldEventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: "2026-09-05T00:00:01.000Z",
    patientPositionObservedAt: BASE_TIME,
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: {
      kind: "P",
      latitude: 22.1987,
      longitude: 113.5439,
      accuracyMeters: 12
    }
  });
  const oldDeliveryId = harness.store.read((state) => Object.values(state.deliveries).find(
    (delivery) => delivery.eventId === oldEventId
      && delivery.deviceInstanceId === secondIPhone.deviceInstanceId
  )?.id);
  assert.ok(oldDeliveryId);
  await harness.service.respond(secondIPhone, oldEventId, oldDeliveryId, {
    decision: "ACCEPT",
    decidedAt: BASE_TIME
  });
  const oldAssignmentId = harness.store.read((state) => Object.values(state.assignments).find(
    (assignment) => assignment.eventId === oldEventId
      && assignment.deviceInstanceId === secondIPhone.deviceInstanceId
  )?.id);
  assert.ok(oldAssignmentId);

  const patientWatch = await linkWatch(harness, patient, uuid(69));
  const patientWatchPrincipal = harness.service.authenticateToken(patientWatch.sessionToken);
  assert.equal(patientWatchPrincipal.kind, "DEVICE");
  const newEventId = uuid(70);
  await harness.service.reportWatchObservation(patientWatchPrincipal, newEventId, {
    schemaVersion: "2.0",
    eventId: newEventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: "2026-09-05T00:00:02.000Z",
    patientPositionObservedAt: BASE_TIME,
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: {
      kind: "P",
      latitude: 22.1987,
      longitude: 113.5439,
      accuracyMeters: 12
    }
  });

  const finalState = harness.store.read((state) => ({
    patientDeviceIds: state.events[newEventId]?.patientDeviceIds,
    newEventDelivery: Object.values(state.deliveries).find(
      (delivery) => delivery.eventId === newEventId
        && delivery.deviceInstanceId === secondIPhone.deviceInstanceId
    ),
    oldAssignment: oldAssignmentId ? state.assignments[oldAssignmentId] : undefined
  }));
  assert.equal(finalState.patientDeviceIds?.includes(secondIPhone.deviceInstanceId), false);
  assert.equal(finalState.newEventDelivery, undefined);
  assert.equal(finalState.oldAssignment?.status, "CANCELLED");
  const secondaryPatientView = harness.service.getEvent(secondIPhone, newEventId);
  assert.equal(secondaryPatientView.viewerRelationship, "PATIENT");
  assert.equal(secondaryPatientView.patientPosition?.kind, "P");
  await assert.rejects(
    harness.service.updatePatientPosition(secondIPhone, newEventId, {
      positionUpdateId: uuid(71),
      observedAt: BASE_TIME,
      patientPosition: {
        kind: "P",
        latitude: 22.1987,
        longitude: 113.5439,
        accuracyMeters: 12
      }
    }),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 403
      && /associated patient iPhone/.test(error.detail)
  );
  assert.throws(
    () => harness.service.getEvent(otherPatient, newEventId),
    (error: unknown) => error instanceof HttpProblem && error.status === 404
  );
});

test("Watch refresh survives access expiry cleanup, then rotates once and detects reuse", async () => {
  let now = new Date(BASE_TIME);
  const harness = makeHarness({ sessionTtlSeconds: 1 });
  const account = await accountPrincipal(harness, "+8613800138000");
  const iPhone = await iPhonePrincipal(harness, account, uuid(40), uuid(41));
  const linked = await linkWatch(harness, iPhone, uuid(42));
  now = new Date("2026-09-05T00:00:02.000Z");
  harness.setNow(now.toISOString());
  await accountPrincipal(harness, "+8613900139000");
  const refreshed = await harness.service.refreshWatchSession(linked.refreshToken);
  assert.equal(refreshed.userId, iPhone.userId);
  assert.ok(refreshed.refreshToken);
  await assert.rejects(
    harness.service.refreshWatchSession(linked.refreshToken),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
  await assert.rejects(
    harness.service.refreshWatchSession(refreshed.refreshToken!),
    (error: unknown) => error instanceof HttpProblem && error.status === 401
  );
});

test("HTTP exposes the single Watch redeem/refresh contract and rejects legacy Watch bootstrap", async () => {
  const phone = new DeterministicPhoneChallengeProvider(CODE);
  const backend = await createBackend({
    config: makeConfig(),
    store: new MemoryStateStore(emptyState()),
    phoneChallengeProvider: phone,
    watchAttestationVerifier: {
      async verifyAttestation(input) {
        return {
          verified: input.appAttestKeyId === "watch-key"
            && input.attestationObject === ATTESTATION_OBJECT,
          deviceInstanceId: input.deviceInstanceId
        };
      }
    }
  });
  await backend.start();
  try {
    const base = backend.baseURL();
    const json = { "content-type": "application/json" };
    const challengeResponse = await fetch(`${base}/api/v2/auth/phone/challenges`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ phoneNumber: "+8613800138000" })
    });
    const challenge = await challengeResponse.json() as { challengeId: string };
    const loginResponse = await fetch(`${base}/api/v2/auth/phone/verify`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        phoneNumber: "+8613800138000",
        code: CODE
      })
    });
    const login = await loginResponse.json() as { sessionToken: string };
    const iPhoneBody = iPhoneBootstrapRequest(uuid(50), uuid(51));
    const iPhoneResponse = await fetch(`${base}/api/v2/session/bootstrap`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${login.sessionToken}` },
      body: JSON.stringify(iPhoneBody)
    });
    assert.equal(iPhoneResponse.status, 201);
    const iPhone = await iPhoneResponse.json() as { sessionToken: string };

    const oldWatchResponse = await fetch(`${base}/api/v2/session/bootstrap`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${login.sessionToken}` },
      body: JSON.stringify({
        deviceInstanceId: uuid(52),
        deviceKind: "WATCH",
        companionPairId: uuid(51)
      })
    });
    assert.equal(oldWatchResponse.status, 400);

    const ticketResponse = await fetch(`${base}/api/v2/me/companion-link-tickets`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${iPhone.sessionToken}` },
      body: JSON.stringify({ companionPairId: uuid(51) })
    });
    assert.equal(ticketResponse.status, 201);
    const ticket = await ticketResponse.json() as { companionLinkTicket: string };
    const redeemResponse = await fetch(`${base}/api/v2/watch/session/redeem`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        deviceInstanceId: uuid(52),
        companionPairId: uuid(51),
        companionLinkTicket: ticket.companionLinkTicket,
        appAttestKeyId: "watch-key",
        attestationObject: ATTESTATION_OBJECT
      })
    });
    assert.equal(redeemResponse.status, 201);
    const watch = await redeemResponse.json() as {
      sessionToken: string;
      refreshToken: string;
    };
    assert.equal(typeof watch.refreshToken, "string");
    const refreshResponse = await fetch(`${base}/api/v2/watch/session/refresh`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ refreshToken: watch.refreshToken })
    });
    assert.equal(refreshResponse.status, 200);
    const rotated = await refreshResponse.json() as { sessionToken: string; refreshToken: string };
    assert.notEqual(rotated.sessionToken, watch.sessionToken);
  } finally {
    await backend.stop();
  }
});
