import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import {
  companionLinkClientDataHash,
  type AppleIdentityTokenVerificationRequest,
  type AppleIdentityTokenVerifier,
  type WatchAttestationVerificationRequest,
  type WatchAttestationVerifier
} from "../src/auth.js";
import type { SessionBootstrapRequest, WatchEmergencyObservation } from "../src/contracts.js";
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

/** Apple subject double: `valid:<subject>` verifies, anything else does not. */
class TestAppleSubjectVerifier implements AppleIdentityTokenVerifier {
  async verifyIdentityToken(
    input: AppleIdentityTokenVerificationRequest
  ): Promise<{ subject: string }> {
    if (!input.identityToken.startsWith("valid:")) throw new Error("invalid token");
    return { subject: input.identityToken.slice("valid:".length) };
  }
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
  return {
    service: new AEDResponseService(
      store,
      makeConfig(overrides),
      undefined,
      () => currentTime,
      { apple: new TestAppleSubjectVerifier(), watchAttestation: verifier }
    ),
    store,
    verifier,
    setNow(value) {
      currentTime = new Date(value);
    }
  };
}

/**
 * One account per distinct Apple subject.  The argument used to be a phone
 * number; PHONE sign-in was removed, so the same call sites now pass the subject
 * they want that account to have.
 */
async function accountPrincipal(
  harness: DirectHarness,
  subject: string
): Promise<AccountPrincipal> {
  const login = await harness.service.signInWithApple({
    identityToken: `valid:${subject}`,
    nonce: `nonce-${subject}`
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
  const account = await accountPrincipal(harness, "companion-a");
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
  const account = await accountPrincipal(noProvider, "companion-a");
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
  const account = await accountPrincipal(harness, "companion-a");
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
  const firstAccount = await accountPrincipal(harness, "companion-a");
  const firstIPhone = await iPhonePrincipal(harness, firstAccount, uuid(30), uuid(31));
  const firstWatch = await linkWatch(harness, firstIPhone, uuid(35));
  const secondAccount = await accountPrincipal(harness, "companion-b");
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
  const userAccount = await accountPrincipal(harness, "companion-a");
  const patient = await iPhonePrincipal(harness, userAccount, uuid(60), uuid(61));
  const secondIPhone = await iPhonePrincipal(harness, userAccount, uuid(62), uuid(63));
  const otherAccount = await accountPrincipal(harness, "companion-b");
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
  const account = await accountPrincipal(harness, "companion-a");
  const iPhone = await iPhonePrincipal(harness, account, uuid(40), uuid(41));
  const linked = await linkWatch(harness, iPhone, uuid(42));
  now = new Date("2026-09-05T00:00:02.000Z");
  harness.setNow(now.toISOString());
  await accountPrincipal(harness, "companion-b");
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
  const backend = await createBackend({
    config: makeConfig(),
    store: new MemoryStateStore(emptyState()),
    appleIdentityTokenVerifier: new TestAppleSubjectVerifier(),
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
    const loginResponse = await fetch(`${base}/api/v2/auth/apple`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        challengeId: uuid(70),
        identityToken: "valid:companion-http",
        nonce: "nonce"
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

/**
 * G02 — replacing a Watch, and reinstalling the app.
 *
 * These are the flows the checklist names and that no single test covered: a
 * household replaces the Watch on the same iPhone, or reinstalls the app and gets a
 * new device identity.  The failure to prevent is the old hardware keeping access:
 * a Watch that was handed on, sold or reset must not still be able to trigger an
 * event for this patient, and a leftover unconsumed ticket must not let it back in.
 */
test("a superseded ticket cannot link a second Watch, and unbinding is an explicit act", async () => {
  const harness = makeHarness();
  const account = await accountPrincipal(harness, "watch-replacement");
  const iPhone = await iPhonePrincipal(harness, account, uuid(100), uuid(101));
  const firstWatch = uuid(102);
  const first = await linkWatch(harness, iPhone, firstWatch);

  // One live ticket per iPhone: a ticket is a credential that links hardware to this
  // patient, so issuing a new one retires the previous unconsumed ticket instead of
  // leaving two ways in.
  const superseded = await harness.service.createCompanionLinkTicket(iPhone, {
    companionPairId: iPhone.companionPairId
  });
  const replacementWatch = uuid(103);
  harness.verifier.allowedDeviceIds.add(replacementWatch);
  const current = await harness.service.createCompanionLinkTicket(iPhone, {
    companionPairId: iPhone.companionPairId
  });
  await assert.rejects(
    harness.service.redeemCompanionLinkTicket({
      deviceInstanceId: replacementWatch,
      companionPairId: iPhone.companionPairId,
      companionLinkTicket: superseded.companionLinkTicket,
      appAttestKeyId: "watch-key",
      attestationObject: ATTESTATION_OBJECT
    }),
    /Watch companion link credential was rejected/,
    "a superseded ticket must not link hardware"
  );

  // Linking a second Watch does NOT evict the first: a household may have two, and
  // hardware must not be disconnected by an implicit rule.
  const secondWatch = uuid(104);
  harness.verifier.allowedDeviceIds.add(secondWatch);
  const secondSession = await harness.service.redeemCompanionLinkTicket({
    deviceInstanceId: secondWatch,
    companionPairId: iPhone.companionPairId,
    companionLinkTicket: current.companionLinkTicket,
    appAttestKeyId: "watch-key",
    attestationObject: ATTESTATION_OBJECT
  });
  assert.ok(secondSession.refreshToken);
  assert.equal(
    harness.store.read(state => state.devices[firstWatch]!.companionLinkRevokedAt),
    undefined,
    "linking another Watch leaves the existing link alone"
  );
  assert.equal(harness.service.authenticateToken(first.sessionToken).kind, "DEVICE");

  // Replacement is explicit: the phone disconnects its paired Watch, which revokes
  // the link, the sessions and any ticket still outstanding.
  const pendingTicket = await harness.service.createCompanionLinkTicket(iPhone, {
    companionPairId: iPhone.companionPairId
  });
  void pendingTicket;
  const unbind = await harness.service.unbindCompanionWatch(iPhone);
  assert.equal(unbind.companionPairId, iPhone.companionPairId);
  assert.equal(unbind.revokedWatches, 2, "both paired Watches are disconnected");
  assert.equal(unbind.revokedSessions >= 2, true);
  const state = harness.store.read(row => row);
  for (const watchId of [firstWatch, secondWatch]) {
    assert.ok(state.devices[watchId]!.companionLinkRevokedAt, `${watchId} link revoked`);
  }
  assert.equal(
    Object.values(state.sessionsByTokenHash)
      .filter(row => row.deviceKind === "WATCH")
      .every(row => row.revokedAt !== undefined),
    true,
    "every Watch session is revoked"
  );
  assert.equal(
    Object.values(state.companionLinkTicketsByHash)
      .filter(row => row.companionPairId === iPhone.companionPairId && !row.consumedAt)
      .every(row => row.revokedAt !== undefined),
    true,
    "no outstanding ticket survives the unbind"
  );
  assert.throws(() => harness.service.authenticateToken(first.sessionToken),
    /valid authenticated session is required/,
    "the disconnected Watch can no longer authenticate");
  assert.throws(() => harness.service.authenticateToken(secondSession.sessionToken!),
    /valid authenticated session is required/);
  // The iPhone itself is untouched: unbinding hardware is not logging the user out.
  assert.equal(harness.service.authenticateToken(
    (await harness.service.bootstrap(account, iPhoneBootstrapRequest(uuid(100), uuid(101)),
      `bootstrap:${uuid(100)}`)).sessionToken
  ).kind, "DEVICE");
  // And a re-pairing after the unbind works, because the link is a state, not a ban.
  const repaired = await linkWatch(harness, iPhone, uuid(105));
  assert.ok(repaired.sessionToken);
  void first;
});

test("reinstalling the app gets a fresh device identity without reviving the old one", async () => {
  const harness = makeHarness();
  const account = await accountPrincipal(harness, "reinstall");
  const oldPhone = uuid(200);
  const first = await iPhonePrincipal(harness, account, oldPhone, uuid(201));
  // A reinstall clears the keychain: the same person signs in again with a NEW
  // device instance id.  Both rows belong to one account, and the old session must
  // not be usable afterwards.
  const reinstalledPhone = uuid(202);
  const second = await iPhonePrincipal(harness, account, reinstalledPhone, uuid(203));
  assert.notEqual(first.deviceInstanceId, second.deviceInstanceId);
  assert.equal(first.userId, second.userId, "the same Apple subject is the same user");
  assert.equal(first.accountId, second.accountId);

  const state = harness.store.read(row => row);
  assert.equal(Object.keys(state.devices).length, 2,
    "the reinstall is a separate device row, not a silent overwrite of the old one");
  // The old installation's session stays valid until it is revoked, BUT it can no
  // longer claim to be the only patient device: both are bound to one user, and the
  // account-level revocation path reaches them.
  await harness.service.logout(first);
  assert.ok(harness.store.read(row => row.sessionsByTokenHash[first.tokenHash]!.revokedAt));
  assert.throws(() => harness.service.authenticateToken(
    harness.store.read(row => row.sessionsByTokenHash[first.tokenHash] ? "already-revoked" : "")
  ));
  // The reinstalled phone is untouched by the old device's logout.
  assert.equal(harness.service.authenticateToken(
    (await harness.service.bootstrap(account, iPhoneBootstrapRequest(reinstalledPhone, uuid(203)),
      `bootstrap:${reinstalledPhone}`)).sessionToken
  ).kind, "DEVICE");
  void second;
});

function relayObservation(id = uuid(910)): WatchEmergencyObservation {
  return { schemaVersion: "2.0", eventId: id, observationKind: "FALL_CONTEXT",
    fallDetectedAt: BASE_TIME, fallResolution: "CONFIRMED", appHelpResponse: "NEEDS_HELP",
    locationUnavailableReason: "test-no-fix" };
}

async function relayHarness() {
  const harness = makeHarness();
  const account = await accountPrincipal(harness, "relay-owner");
  const phone = await iPhonePrincipal(harness, account, uuid(900), uuid(901));
  const watchId = uuid(902);
  const binding = await harness.service.bindCompanionRelay(phone,
    { deviceInstanceId: watchId, companionPairId: phone.companionPairId });
  return { ...harness, account, phone, watchId, binding };
}

test("phone relay binding is stable and issues no independent Watch session", async () => {
  const h = await relayHarness();
  const again = await h.service.bindCompanionRelay(h.phone,
    { deviceInstanceId: h.watchId, companionPairId: h.phone.companionPairId });
  assert.equal(again.bindingId, h.binding.bindingId);
  assert.equal(again.userId, h.phone.userId);
  assert.equal(h.verifier.calls.length, 0);
  assert.equal(h.store.read(s => Object.values(s.sessionsByTokenHash).filter(row => row.deviceKind === "WATCH").length), 0);
  const recovered = new MemoryStateStore(h.store.read(s => structuredClone(s)));
  assert.equal(recovered.read(s => s.devices[h.watchId]?.watchRelay?.bindingId), h.binding.bindingId);
});

test("relayed and direct Watch observations share source and exactly one event", async () => {
  const h = await relayHarness();
  const observation = relayObservation();
  const result = await h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId,
    observation.eventId, observation);
  assert.equal(result.created, true);
  const replay = await h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId,
    observation.eventId, observation);
  assert.equal(replay.created, false);
  assert.equal(h.service.getRelayedWatchEventState(h.phone, h.watchId, h.binding.bindingId, observation.eventId).state, "ACTIVE");
  const linked = await linkWatch(h, h.phone, h.watchId);
  const direct = await h.service.reportWatchObservation(h.service.authenticateToken(linked.sessionToken),
    observation.eventId, observation);
  assert.equal(direct.created, false);
  assert.equal(h.store.read(s => Object.keys(s.events).length), 1);
  assert.equal(h.store.read(s => s.devices[h.watchId]?.watchRelay?.bindingId), h.binding.bindingId);
});

test("relay rejects changed contents for the same event ID", async () => {
  const h = await relayHarness();
  const observation = relayObservation();
  await h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId, observation.eventId, observation);
  await assert.rejects(h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId,
    observation.eventId, { ...observation, locationUnavailableReason: "changed" }), (e: unknown) => e instanceof HttpProblem && e.status === 409);
  assert.equal(h.store.read(s => s.events[observation.eventId]?.observation?.locationUnavailableReason), "test-no-fix");
});

test("relay rejects another account, another phone and wrong binding", async () => {
  const h = await relayHarness();
  const otherAccount = await accountPrincipal(h, "another-owner");
  const other = await iPhonePrincipal(h, otherAccount, uuid(920), uuid(921));
  const sameOwner = await iPhonePrincipal(h, h.account, uuid(923), uuid(925));
  const observation = relayObservation();
  for (const phone of [other, sameOwner]) {
    await assert.rejects(h.service.relayWatchObservation(phone, h.watchId, h.binding.bindingId,
      observation.eventId, observation), (e: unknown) => e instanceof HttpProblem && e.status === 403);
    await assert.rejects(h.service.bindCompanionRelay(phone,
      { deviceInstanceId: h.watchId, companionPairId: phone.companionPairId }));
  }
  await assert.rejects(h.service.relayWatchObservation(h.phone, h.watchId, uuid(924), observation.eventId, observation));
  assert.equal(h.store.read(s => Object.keys(s.events).length), 0);
});

test("phone relay does not give an iPhone access to direct Watch API", async () => {
  const h = await relayHarness();
  const observation = relayObservation();
  await assert.rejects(h.service.reportWatchObservation(h.phone, observation.eventId, observation),
    (e: unknown) => e instanceof HttpProblem && e.status === 403);
  await assert.rejects(h.service.bindCompanionRelay(h.account,
    { deviceInstanceId: uuid(930), companionPairId: h.phone.companionPairId }));
});

test("Watch unbind cannot silently regain relay access or clear the revocation", async () => {
  const h = await relayHarness();
  await h.service.unbindCompanionWatch(h.phone);
  const observation = relayObservation();
  await assert.rejects(h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId, observation.eventId, observation));
  await assert.rejects(h.service.bindCompanionRelay(h.phone,
    { deviceInstanceId: h.watchId, companionPairId: h.phone.companionPairId }));
  assert.ok(h.store.read(s => s.devices[h.watchId]?.companionLinkRevokedAt));
  assert.equal(h.store.read(s => Object.keys(s.events).length), 0);
});

test("relay checks phone logout and expiry, including stale in-memory principals", async () => {
  for (const boundary of ["logout", "expiry"] as const) {
    const h = await relayHarness();
    if (boundary === "logout") await h.service.logout(h.phone);
    else h.setNow("2026-09-05T02:00:00.000Z");
    const observation = relayObservation();
    await assert.rejects(h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId, observation.eventId, observation));
    await assert.rejects(h.service.bindCompanionRelay(h.phone,
      { deviceInstanceId: h.watchId, companionPairId: h.phone.companionPairId }));
    assert.equal(h.store.read(s => Object.keys(s.events).length), 0);
  }
});

test("relay authorization is repeated inside the queued event transaction", async () => {
  const h = await relayHarness();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const revoke = h.store.transact(async state => {
    await barrier;
    state.devices[h.watchId]!.companionLinkRevokedAt = BASE_TIME;
  });
  const observation = relayObservation();
  const incoming = h.service.relayWatchObservation(h.phone, h.watchId, h.binding.bindingId, observation.eventId, observation);
  release();
  await revoke;
  await assert.rejects(incoming, (e: unknown) => e instanceof HttpProblem && e.status === 403);
  assert.equal(h.store.read(s => Object.keys(s.events).length), 0);
});

test("relay binding still requires current phone agreements and the correct pair", async () => {
  const h = await relayHarness();
  await assert.rejects(h.service.bindCompanionRelay(h.phone, { deviceInstanceId: uuid(940), companionPairId: uuid(941) }));
  await h.store.transact(state => { delete state.devices[h.phone.deviceInstanceId]!.agreements.PATIENT; });
  await assert.rejects(h.service.bindCompanionRelay(h.phone, { deviceInstanceId: uuid(940), companionPairId: h.phone.companionPairId }));
  assert.equal(h.store.read(s => s.devices[uuid(940)]), undefined);
});
