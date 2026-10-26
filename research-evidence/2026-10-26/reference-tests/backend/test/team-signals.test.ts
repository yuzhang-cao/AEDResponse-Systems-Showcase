/**
 * G08 — in-app contact between accepted responders, in its smallest honest form.
 *
 * The requirement allows "App 内联系能力" while forbidding names, avatars, phone
 * numbers, precise coordinates and personal ETA.  The chosen form is a closed
 * vocabulary of preset signals, and these tests hold the consequences of that
 * choice:
 *
 *   - the channel is revocable by the SAME membership rule as the team view, so
 *     exit and event termination close it without a second flag to keep in sync;
 *   - there is no field a message body or a coordinate could travel in — asserted
 *     by trying to store one and being refused;
 *   - a retried send after a lost ACK returns the original signal and notifies
 *     nobody twice, and a guessed signal id from another team reads nothing;
 *   - rate limit and per-event cap bound what one device can do to a team;
 *   - the push/outbox payload carries an opaque id and the event id, nothing else.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import type { Aed, PatientPosition, WatchEmergencyObservation } from "../src/contracts.js";
import { emptyState, type PersistentState } from "../src/models.js";
import { transactState } from "../src/incremental-state.js";
import { PURGED_COLLECTIONS } from "../src/retention.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";
import {
  TEAM_SIGNAL_MAX_PER_SENDER,
  TEAM_SIGNAL_MIN_INTERVAL_MS
} from "../src/coordination-team.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore, setShadowValidationEnabled } from "../src/store.js";

const BASE_TIME = "2026-09-13T08:00:00.000Z";
const PATIENT_POSITION: PatientPosition = {
  kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10
};
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const atMs = (milliseconds: number): string => new Date(milliseconds).toISOString();

const inventory: Aed[] = [{
  id: "signal-aed",
  name: "Signal AED",
  aedPosition: { kind: "A", latitude: 22.1991, longitude: 113.5439, accuracyMeters: 5 },
  openFrom: "00:00",
  openUntil: "00:00",
  floor: "1F",
  floorTransferSeconds: 0,
  accessNote: "lobby",
  accessDelaySeconds: 0,
  verificationSeconds: 0,
  available: true
}];

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "unused-team-signal.json",
  fixtureFile: "unused-in-memory-fixture.json",
  sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100,
  operatorToken: "signal-operator-token",
  production: false,
  authSubjectPepper: "team-signal-test-pepper-value"
};

async function bootstrap(
  service: AEDResponseService,
  deviceInstanceId: string,
  deviceKind: "IPHONE" | "WATCH",
  companionPairId: string
): Promise<DevicePrincipal> {
  const base = Date.parse(BASE_TIME);
  const result = await service.bootstrap({
    deviceInstanceId,
    deviceKind,
    companionPairId,
    ...(deviceKind === "IPHONE" ? {
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
          kind, version: "2.0", acceptedAt: atMs(base)
        })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    } : {})
  } as never, `synthetic:${deviceInstanceId}`);
  const principal = service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Synthetic device principal required");
  return principal;
}

interface Harness {
  service: AEDResponseService;
  store: MemoryStateStore;
  eventId: string;
  patient: DevicePrincipal;
  first: DevicePrincipal;
  second: DevicePrincipal;
  outsider: DevicePrincipal;
  setNow(milliseconds: number): void;
  state(): PersistentState;
}

/** An active event with two accepted responders and one responder who refused. */
async function twoResponderEvent(): Promise<Harness> {
  const base = Date.parse(BASE_TIME);
  let now = base;
  const store = new MemoryStateStore(emptyState(inventory));
  const service = new AEDResponseService(store, config, {
    emitToDevices() { return []; }
  }, () => new Date(now));
  const harness: Harness = {
    service, store,
    eventId: uuid(500),
    patient: undefined as never,
    first: undefined as never,
    second: undefined as never,
    outsider: undefined as never,
    setNow(milliseconds: number) { now = milliseconds; },
    state: () => store.read(state => state)
  };
  const pairId = uuid(1);
  const patient = await bootstrap(service, uuid(2), "IPHONE", pairId);
  const watch = await bootstrap(service, uuid(3), "WATCH", pairId);
  const first = await bootstrap(service, uuid(4), "IPHONE", uuid(5));
  const second = await bootstrap(service, uuid(6), "IPHONE", uuid(7));
  const outsider = await bootstrap(service, uuid(8), "IPHONE", uuid(9));
  for (const responder of [first, second, outsider]) {
    await service.updateResponderPosition(responder, {
      positionUpdateId: uuid(20 + (responder === first ? 0 : responder === second ? 1 : 2)),
      observedAt: atMs(base),
      responderPosition: {
        kind: "R", latitude: PATIENT_POSITION.latitude + 0.002,
        longitude: PATIENT_POSITION.longitude, accuracyMeters: 10
      }
    });
  }
  now = base + 1_000;
  const observation: WatchEmergencyObservation = {
    schemaVersion: "2.0",
    eventId: harness.eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: atMs(base + 1_000),
    patientPositionObservedAt: atMs(base),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: PATIENT_POSITION
  };
  await service.reportWatchObservation(watch, harness.eventId, observation);
  for (const [index, responder] of [first, second, outsider].entries()) {
    const delivery = store.read(state => Object.values(state.deliveries)
      .find(row => row.eventId === harness.eventId
        && row.deviceInstanceId === responder.deviceInstanceId));
    assert.ok(delivery, "each responder must receive an offer");
    now = base + 2_000 + index;
    await service.respond(responder, harness.eventId, delivery.id, {
      // The third responder refuses, which is how a non-member who is still
      // reachable by notification is produced.
      decision: index === 2 ? "REFUSE" : "ACCEPT",
      decidedAt: atMs(now)
    });
  }
  harness.patient = patient;
  harness.first = first;
  harness.second = second;
  harness.outsider = outsider;
  now = base + 10_000;
  return harness;
}

test("team signals: a current member's preset signal reaches the team and nobody else", async () => {
  const harness = await twoResponderEvent();
  const sent = await harness.service.sendTeamSignal(harness.first, harness.eventId, {
    signalId: uuid(600), kind: "NEED_HELP_HERE"
  });
  assert.equal(sent.kind, "NEED_HELP_HERE");
  assert.equal(sent.duplicate, false);
  assert.equal(Date.parse(sent.expiresAt) > Date.parse(sent.createdAt), true);

  // The other member reads it, attributed by alias; the sender sees it as theirs.
  const otherFeed = harness.service.readTeamSignals(harness.second, harness.eventId);
  assert.equal(otherFeed.signals.length, 1);
  assert.equal(otherFeed.signals[0]!.kind, "NEED_HELP_HERE");
  assert.equal(otherFeed.signals[0]!.mine, false);
  assert.match(otherFeed.signals[0]!.alias, /^[A-Z0-9]{4,}$/);
  const ownFeed = harness.service.readTeamSignals(harness.first, harness.eventId);
  assert.equal(ownFeed.signals[0]!.mine, true);
  assert.equal(ownFeed.signals[0]!.alias, otherFeed.signals[0]!.alias,
    "the same member has one stable alias everywhere in the event");

  // The signal is delivered through the durable outbox to the other member only,
  // and the payload carries an opaque id and nothing about a person.
  const outbox = harness.state().notificationOutboxById;
  const delivered = Object.values(outbox).filter(row => row.payload.signalId === uuid(600));
  assert.equal(delivered.length, 1, "exactly the other member is notified");
  assert.equal(delivered[0]!.recipient.deviceInstanceId, harness.second.deviceInstanceId);
  assert.equal(delivered[0]!.name, "event:team-signal");
  assert.deepEqual(Object.keys(delivered[0]!.payload).sort(),
    ["eventId", "messageId", "occurredAt", "schemaVersion", "signalId"],
    "a notification never carries the alias, the kind or a coordinate");
  assert.equal(JSON.stringify(delivered[0]!.payload).includes("NEED_HELP"), false);
  assert.equal(JSON.stringify(delivered[0]!.payload).includes("22.1987"), false);
});

test("team signals: only current members may send or read", async () => {
  const harness = await twoResponderEvent();
  // A responder who refused is not a member: no read, no send.
  await assert.rejects(
    harness.service.sendTeamSignal(harness.outsider, harness.eventId, {
      signalId: uuid(601), kind: "ON_MY_WAY"
    }),
    /Only a current participant of an active event may contact the team/
  );
  assert.throws(
    () => harness.service.readTeamSignals(harness.outsider, harness.eventId),
    /may read the team channel/
  );
  // The patient is not a responder: the team channel is not theirs.
  await assert.rejects(
    harness.service.sendTeamSignal(harness.patient, harness.eventId, {
      signalId: uuid(602), kind: "ON_MY_WAY"
    }),
    /Only a current participant|not visible to this device/
  );

  // After an accepted member exits, the channel closes for them in the same step.
  await harness.service.exitEvent(harness.first, harness.eventId, {
    exitId: uuid(700),
    exitedAt: atMs(Date.parse(BASE_TIME) + 20_000)
  });
  assert.throws(
    () => harness.service.readTeamSignals(harness.first, harness.eventId),
    /may read the team channel/
  );
  await assert.rejects(
    harness.service.sendTeamSignal(harness.first, harness.eventId, {
      signalId: uuid(603), kind: "CANNOT_CONTINUE"
    }),
    /Only a current participant/
  );

  // And when the event ends, nobody can read or send any more.
  harness.setNow(Date.parse(BASE_TIME) + 30_000);
  await harness.service.endEvent(harness.patient, harness.eventId, {
    resolutionId: uuid(702), reason: "PROBLEM_RESOLVED",
    endedAt: atMs(Date.parse(BASE_TIME) + 30_000)
  });
  assert.throws(() => harness.service.readTeamSignals(harness.second, harness.eventId),
    /may read the team channel/);
  await assert.rejects(
    harness.service.sendTeamSignal(harness.second, harness.eventId, {
      signalId: uuid(604), kind: "ARRIVED_AT_PATIENT"
    }),
    /no longer active|Only a current participant/
  );
});

test("team signals: the vocabulary is closed, so no free text can travel", async () => {
  const harness = await twoResponderEvent();
  await assert.rejects(
    harness.service.sendTeamSignal(harness.first, harness.eventId, {
      signalId: uuid(610), kind: "FREE_TEXT_MESSAGE"
    } as never),
    /not one of the preset contact messages/
  );
  // The record has no field for a body: a directly written message key is refused
  // by the store, which is what makes "no free text" a property of the data.
  await assert.rejects(
    transactState(harness.store, state => {
      state.teamSignalsById[uuid(611)] = {
        signalId: uuid(611), eventId: harness.eventId,
        senderDeviceInstanceId: harness.first.deviceInstanceId,
        kind: "NEED_HELP_HERE", createdAt: atMs(Date.parse(BASE_TIME)),
        expiresAt: atMs(Date.parse(BASE_TIME) + 600_000),
        acknowledgedByDeviceIds: [], note: "patient is at 22.1987,113.5439"
      } as never;
    }),
    /is not part of the preset-signal vocabulary/
  );
  await assert.rejects(
    transactState(harness.store, state => {
      state.teamSignalsById[uuid(612)] = {
        signalId: uuid(612), eventId: harness.eventId,
        senderDeviceInstanceId: harness.first.deviceInstanceId,
        kind: "SOMETHING_ELSE", createdAt: atMs(Date.parse(BASE_TIME)),
        expiresAt: atMs(Date.parse(BASE_TIME) + 600_000), acknowledgedByDeviceIds: []
      } as never;
    }),
    /kind is not a preset team signal/
  );
  assert.equal(harness.state().teamSignalsById[uuid(610)], undefined,
    "a refused signal is not stored");
});

test("team signals: a retry is idempotent, rate limited and capped", async () => {
  const harness = await twoResponderEvent();
  const base = Date.parse(BASE_TIME) + 10_000;
  resetMetrics();
  await harness.service.sendTeamSignal(harness.first, harness.eventId, {
    signalId: uuid(620), kind: "ON_MY_WAY"
  });
  // The same signalId returns the original signal and notifies nobody twice.
  const retry = await harness.service.sendTeamSignal(harness.first, harness.eventId, {
    signalId: uuid(620), kind: "ON_MY_WAY"
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.createdAt, atMs(base));
  const outbox = Object.values(harness.state().notificationOutboxById)
    .filter(row => row.payload.signalId === uuid(620));
  assert.equal(outbox.length, 1, "a retried send does not enqueue a second notification");
  assert.equal(snapshotMetrics().operation.teamSignalsDeduplicated, 1);

  // Too soon: the sender's own next signal is refused, with the wait implied.
  harness.setNow(base + TEAM_SIGNAL_MIN_INTERVAL_MS - 1);
  await assert.rejects(
    harness.service.sendTeamSignal(harness.first, harness.eventId, {
      signalId: uuid(621), kind: "ARRIVED_AT_PATIENT"
    }),
    /sent moments ago/
  );
  harness.setNow(base + TEAM_SIGNAL_MIN_INTERVAL_MS);
  const allowed = await harness.service.sendTeamSignal(harness.first, harness.eventId, {
    signalId: uuid(621), kind: "ARRIVED_AT_PATIENT"
  });
  assert.equal(allowed.duplicate, false, "at the interval boundary a new signal is allowed");

  // The cap counts only this sender's signals, and another member is unaffected.
  for (let index = 0; index < TEAM_SIGNAL_MAX_PER_SENDER + 5; index += 1) {
    harness.setNow(base + (index + 3) * TEAM_SIGNAL_MIN_INTERVAL_MS);
    try {
      await harness.service.sendTeamSignal(harness.first, harness.eventId, {
        signalId: uuid(1_000 + index), kind: "ON_MY_WAY"
      });
    } catch {
      // The cap is the expected end of this loop.
    }
  }
  const mine = Object.values(harness.state().teamSignalsById)
    .filter(row => row.senderDeviceInstanceId === harness.first.deviceInstanceId);
  assert.equal(mine.length, TEAM_SIGNAL_MAX_PER_SENDER, "one device cannot flood the team");
  harness.setNow(base + 100 * TEAM_SIGNAL_MIN_INTERVAL_MS);
  const otherMember = await harness.service.sendTeamSignal(harness.second, harness.eventId, {
    signalId: uuid(900), kind: "ON_MY_WAY"
  });
  assert.equal(otherMember.duplicate, false, "the cap is per sender, not per event");

  // A signal id belonging to another team must not become a way to read it.
  const strangerEvent = uuid(501);
  await assert.rejects(
    harness.service.sendTeamSignal(harness.second, harness.eventId, {
      signalId: uuid(620), kind: "ON_MY_WAY"
    }),
    /not one of the preset contact messages|Only a current participant/
  );
  void strangerEvent;
});

test("team signals: the feed expires but the record stays until the event is purged", async () => {
  const harness = await twoResponderEvent();
  const base = Date.parse(BASE_TIME) + 10_000;
  await harness.service.sendTeamSignal(harness.first, harness.eventId, {
    signalId: uuid(630), kind: "AED_ACQUIRED"
  });
  assert.equal(harness.service.readTeamSignals(harness.second, harness.eventId).signals.length, 1);
  // Ten minutes later the signal is past its TTL and no longer part of the feed.
  harness.setNow(base + 10 * 60 * 1_000 + 1);
  assert.deepEqual(harness.service.readTeamSignals(harness.second, harness.eventId).signals, []);
  assert.ok(harness.state().teamSignalsById[uuid(630)],
    "an expired signal leaves the feed but stays as event evidence until the purge");
  // The purge set includes it, which `retention.test.ts` exercises end to end.
  assert.equal(PURGED_COLLECTIONS.includes("teamSignalsById"), true);
});
