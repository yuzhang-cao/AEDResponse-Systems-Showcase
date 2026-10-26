/**
 * `createDeliveryIfEligible` — the only place an offer is ever created.
 *
 * Beyond the mechanical access swap, this function is where three transaction
 * semantics of `ctx.createDelivery` become load-bearing:
 *
 *   1. insert-only: the caller mints a fresh `randomUUID`, so creation is never a
 *      replacement, and a collision is counted rather than absorbed;
 *   2. immediately visible to the SAME context: the third guard asks whether this
 *      user already holds an offer, and inside the caller's device loop the answer
 *      must include the offer this transaction just created — that is what stops a
 *      second device of one identity from being offered the same event;
 *   3. no committed-state pollution: under a transaction adapter the delivery goes
 *      to the staged delta, and a rollback discards it.
 *
 * Semantics 2 and 3 cannot be tested against the legacy adapter, because it mutates
 * the committed state directly and therefore satisfies them for the wrong reason.
 * They are tested against the shared staged double, which is specified from the
 * Phase 2 contract.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { draftRecruitmentContext } from "../src/recruitment-context.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type DeviceRecord, type PersistentState } from "../src/models.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";
import { stagedRecruitmentContext } from "./helpers/staged-recruitment-context.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EVENT_ID = uuid(400);
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "/tmp/aedresponse-delivery-test.json",
  fixtureFile: "/tmp/aedresponse-delivery-fixture.json",
  sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100,
  operatorToken: "operator-test-token",
  production: false
};

const AGREEMENTS = {
  PATIENT: { version: "2.0", acceptedAt: AT },
  VOLUNTEER_RESPONDER: { version: "2.0", acceptedAt: AT },
  PRIVACY_POLICY: { version: "2.0", acceptedAt: AT },
  SENSITIVE_PERSONAL_INFORMATION: { version: "2.0", acceptedAt: AT }
};

function device(deviceInstanceId: string, userId: string | undefined): DeviceRecord {
  return {
    deviceInstanceId,
    deviceKind: "IPHONE",
    ...(userId ? { userId } : {}),
    companionPairId: uuid(9_000),
    agreements: structuredClone(AGREEMENTS),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: AT,
    lastSeenAt: AT,
    lastBootstrapAt: AT,
    latestPosition: {
      observedAt: AT,
      position: { kind: "R", latitude: PATIENT.latitude + 0.005,
        longitude: PATIENT.longitude, accuracyMeters: 12 }
    }
  } as never;
}

function world() {
  const state = emptyState();
  const patientDevice = uuid(300);
  state.devices[patientDevice] = device(patientDevice, uuid(301));
  state.devices[patientDevice]!.latestPosition!.position =
    { kind: "R", ...PATIENT, accuracyMeters: 12 } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID,
    state: "ACTIVE",
    patientUserId: uuid(301),
    patientDeviceIds: [patientDevice],
    patientPairId: uuid(702),
    observation: { observationKind: "FALL_CONTEXT", fallDetectedAt: AT },
    observationFingerprint: "f",
    triggerSource: "WATCH_FALL",
    patientPosition: { source: "PATIENT_APP", observedAt: AT,
      position: { kind: "P", ...PATIENT, accuracyMeters: 12 } },
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentState: "RECRUITING",
    recruitmentStageStartedAt: AT,
    coordinationRevision: 1,
    createdAt: AT
  } as never;
  return { state };
}

function service(): AEDResponseService {
  return new AEDResponseService(new MemoryStateStore(emptyState()), config,
    undefined, () => NOW);
}

function create(
  ctx: unknown,
  state: PersistentState,
  deviceInstanceId: string
): ReturnType<never> | unknown {
  return (service() as unknown as {
    createDeliveryIfEligible: (c: unknown, e: unknown, d: DeviceRecord, n: Date) => unknown;
  }).createDeliveryIfEligible(ctx, state.events[EVENT_ID], state.devices[deviceInstanceId]!, NOW);
}

function legacyRun(state: PersistentState, deviceInstanceId: string): unknown {
  return create(draftRecruitmentContext(state), state, deviceInstanceId);
}

test("eligible device gets exactly one offer, with the documented shape", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));

  const request = legacyRun(state, candidate) as {
    messageId: string; eventId: string; deliveryId: string; deliveryStatus: string;
    occurredAt: string; expiresAt: string;
  };
  assert.ok(request, "an eligible device must receive an offer");
  assert.equal(request.messageId, `response-requested:${EVENT_ID}:${candidate}`,
    "the message id is the stable dedup key and must not drift");
  assert.equal(request.eventId, EVENT_ID);
  assert.equal(request.deliveryStatus, "SENT");
  assert.equal(request.occurredAt, AT);

  const created = Object.values(state.deliveries);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.id, request.deliveryId);
  assert.equal(created[0]!.deviceInstanceId, candidate);
  assert.equal(created[0]!.status, "SENT");
  assert.equal(created[0]!.statusOccurredAt, AT);
  assert.equal(created[0]!.request.messageId, request.messageId);

  // Write order is delivery, timeline, notification.
  const timeline = state.timelineByEventId[EVENT_ID] ?? [];
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]!.kind, "RESPONSE_REQUESTED");
  assert.match(timeline[0]!.message, new RegExp(request.deliveryId));
});

test("guard 1: an ineligible device gets nothing", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  (state.devices[candidate] as { availableForResponse: boolean }).availableForResponse = false;

  assert.equal(legacyRun(state, candidate), undefined);
  assert.equal(Object.keys(state.deliveries).length, 0);
  assert.equal(state.timelineByEventId[EVENT_ID], undefined);
});

test("guard 2: an existing offer to this device blocks a second one", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  assert.ok(legacyRun(state, candidate));

  assert.equal(legacyRun(state, candidate), undefined,
    "any existing delivery blocks, regardless of its status");
  assert.equal(Object.keys(state.deliveries).length, 1, "and none was added");
});

test("guard 3: an existing offer to this user blocks another device of that user", () => {
  const { state } = world();
  const user = uuid(200);
  const first = uuid(100);
  const second = uuid(101);
  state.devices[first] = device(first, user);
  state.devices[second] = device(second, user);

  assert.ok(legacyRun(state, first));
  assert.equal(legacyRun(state, second), undefined,
    "the user-level guard covers this person's other devices");
  assert.equal(Object.keys(state.deliveries).length, 1);
  assert.equal(Object.values(state.deliveries)[0]!.deviceInstanceId, first);
});

test("guard 3 uses the user query, so an unbound device is judged on its own", () => {
  const { state } = world();
  const bound = uuid(100);
  const unboundA = uuid(102);
  const unboundB = uuid(103);
  state.devices[bound] = device(bound, uuid(200));
  state.devices[unboundA] = device(unboundA, undefined);
  state.devices[unboundB] = device(unboundB, undefined);

  assert.ok(legacyRun(state, bound));
  assert.ok(legacyRun(state, unboundA),
    "an unbound device has no user query, so the bound user's offer does not block it");
  assert.ok(legacyRun(state, unboundB), "and neither does another unbound device's");
  assert.equal(Object.keys(state.deliveries).length, 3);
});

test("read-your-writes: the same context sees the offer it just created", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const ctx = draftRecruitmentContext(state);

  const deviceBefore = ctx.deliveryForDevice(EVENT_ID, candidate);
  assert.equal(deviceBefore, undefined);

  const request = create(ctx, state, candidate) as { deliveryId: string };
  assert.ok(request);

  assert.equal(ctx.deliveryForDevice(EVENT_ID, candidate)?.id, request.deliveryId,
    "the device query must find it without waiting for a commit");
  assert.equal(ctx.deliveryForUser(EVENT_ID, uuid(200))?.id, request.deliveryId,
    "and so must the user query, which is what blocks the second device");
});

test("staged: creation does not touch committed state and is visible at once", () => {
  const { state } = world();
  const user = uuid(200);
  const first = uuid(100);
  const second = uuid(101);
  state.devices[first] = device(first, user);
  state.devices[second] = device(second, user);
  const committedBefore = Object.keys(state.deliveries).length;
  const ctx = stagedRecruitmentContext(state);

  const request = create(ctx, state, first) as { deliveryId: string };
  assert.ok(request, "the staged context must produce an offer");

  // 1. insert-only
  assert.deepEqual(ctx.deliveryCreateCalls(), [request.deliveryId]);
  assert.deepEqual(ctx.deliveryCreateCollisions(), [],
    "a freshly minted id must never collide");

  // 2. immediately visible to this same context
  assert.equal(ctx.deliveryForDevice(EVENT_ID, first)?.id, request.deliveryId);
  assert.equal(ctx.deliveryForUser(EVENT_ID, user)?.id, request.deliveryId);

  // 3. committed state untouched
  assert.equal(Object.keys(state.deliveries).length, committedBefore,
    "the staged delivery must not be written into the committed collection");

  // And the consequence that actually matters: the second device of this identity
  // is now blocked, inside the same transaction.
  assert.equal(create(ctx, state, second), undefined,
    "the first device's staged offer must block the second device of the same user");
  assert.deepEqual(ctx.deliveryCreateCalls(), [request.deliveryId],
    "so no second offer was ever registered");
});

test("staged: the write order is delivery, timeline, notification", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  const ctx = stagedRecruitmentContext(state);

  const request = create(ctx, state, candidate) as { deliveryId: string };
  assert.ok(request);

  assert.deepEqual(ctx.writeLog(), ["delivery", "timeline", "notification"],
    "the order is delivery, timeline, then notification. They commit atomically, but "
    + "in-transaction helpers may read what earlier steps wrote, so reordering them "
    + "is not free.");
  assert.deepEqual(ctx.deliveryCreateCalls(), [request.deliveryId], "delivery first");
  const timeline = ctx.stagedTimeline();
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]!.kind, "RESPONSE_REQUESTED");
  const notifications = ctx.stagedNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.deviceInstanceId, candidate);
  assert.equal(notifications[0]!.name, "response:requested");

  // The committed state saw none of the three, because all three went through the
  // staged view.
  assert.equal(Object.keys(state.deliveries).length, 0);
  assert.equal(state.timelineByEventId[EVENT_ID], undefined);
});

test("rollback: discarding the staged context leaves committed state clean", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));

  {
    const ctx = stagedRecruitmentContext(state);
    assert.ok(create(ctx, state, candidate));
  } // the transaction is abandoned; nothing is applied

  assert.equal(Object.keys(state.deliveries).length, 0,
    "an abandoned transaction must leave no delivery behind");
  assert.equal(state.timelineByEventId[EVENT_ID], undefined);
  // A fresh context over the same committed state therefore sees no offer, so the
  // device is offerable again - which is the observable meaning of a rollback.
  assert.equal(draftRecruitmentContext(state).deliveryForDevice(EVENT_ID, candidate), undefined);
});

test("insert-only is measured, not assumed: the counter stays at zero normally", () => {
  const { state } = world();
  const candidate = uuid(100);
  state.devices[candidate] = device(candidate, uuid(200));
  resetMetrics();
  assert.ok(legacyRun(state, candidate));
  assert.equal(snapshotMetrics().operation.deliveryCreateCollisions, 0);

  // A caller that reuses an id is counted rather than silently overwriting.
  const existing = Object.values(state.deliveries)[0]!;
  draftRecruitmentContext(state).createDelivery({ ...existing });
  assert.equal(snapshotMetrics().operation.deliveryCreateCollisions, 1,
    "reuse of an existing delivery id must be visible, not absorbed");
});
