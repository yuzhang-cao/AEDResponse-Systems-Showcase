/**
 * Candidate ordering in the recruitment chain (Phase 1 step #5 prerequisite).
 *
 * Swapping a full `Object.values(state.devices)` enumeration for an index changes
 * the order in which candidates are discovered: index results come back in bucket
 * insertion order, not sorted.  Before that swap is made, this test pins what the
 * existing code actually guarantees, so a later change cannot silently reorder
 * offer creation or change which device survives identity deduplication.
 *
 * What the code does today, and what these tests therefore require:
 *   - both candidate sites sort by `deviceInstanceId` BEFORE anything observes
 *     order, so the outcome depends on the *set* of eligible devices, not on the
 *     order they were enumerated in;
 *   - `eligibleResponderDevices` sorts and THEN deduplicates by identity, so the
 *     surviving device for one identity is the lexicographically smallest
 *     `deviceInstanceId` — not whichever happened to be enumerated first;
 *   - offer creation walks devices in ascending `deviceInstanceId` order.
 *
 * If any of these ever stops holding, the index swap would change behaviour in a
 * way nothing else would catch.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";

const BASE_TIME = "2026-08-31T01:02:00.000Z";
const T0 = Date.parse(BASE_TIME);
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const config = {
  ...loadConfig({}, "/tmp"),
  authSubjectPepper: "recruitment-order-pepper",
  enableControlledTestAccounts: true
};

const PATIENT = { kind: "P" as const, latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12 };
const NEAR = { kind: "R" as const, latitude: 22.198, longitude: 113.543, accuracyMeters: 10 };

const AGREEMENTS = ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
  "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
  kind: kind as "PATIENT", version: "2.0", acceptedAt: BASE_TIME
}));

/** A patient pair plus its Watch, shared by both scenarios. */
async function bootstrapPatient(service: AEDResponseService, suffix: string) {
  const patientPairId = uuid(100);
  await service.bootstrap({
    deviceInstanceId: uuid(101), deviceKind: "IPHONE", companionPairId: patientPairId,
    agreementAcceptances: AGREEMENTS,
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, `iphone:patient:${suffix}`);
  const watch = service.authenticateToken((await service.bootstrap({
    deviceInstanceId: uuid(102), deviceKind: "WATCH", companionPairId: patientPairId
  }, `watch:${suffix}`)).sessionToken);
  return { patientPairId, watch };
}

async function createEvent(
  service: AEDResponseService, watch: unknown, eventId: string
): Promise<void> {
  await service.reportWatchObservation(watch as never, eventId, {
    schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1_000), patientPositionObservedAt: BASE_TIME,
    fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP", patientPosition: PATIENT
  } as never);
}

/**
 * Devices in the order their offers were created.
 *
 * Deliveries live in an object keyed by UUID, and JavaScript preserves insertion
 * order for non-index string keys, so `Object.values` already yields creation
 * order — sorting by delivery id would sort by a random UUID and measure nothing.
 */
const deliveryDeviceIds = (store: MemoryStateStore, eventId: string): string[] =>
  store.read(state => Object.values(state.deliveries)
    .filter(delivery => delivery.eventId === eventId)
    .map(delivery => delivery.deviceInstanceId));

test("offers are created in ascending deviceInstanceId order, not enumeration order", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config, undefined, () => new Date(T0));
  const { watch } = await bootstrapPatient(service, "order-a");

  // Published in DESCENDING id order on purpose: an implementation that relied on
  // enumeration order would produce a different result from a sorted one.
  const responders = [uuid(403), uuid(402), uuid(401)];
  for (const [index, deviceId] of responders.entries()) {
    const result = await service.bootstrap({
      deviceInstanceId: deviceId, deviceKind: "IPHONE", companionPairId: uuid(900 + index),
      agreementAcceptances: AGREEMENTS,
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    }, `iphone:${deviceId}`);
    const principal = service.authenticateToken(result.sessionToken);
    await service.updateResponderPosition(principal, {
      positionUpdateId: uuid(500 + index), responderPosition: NEAR, observedAt: BASE_TIME
    });
  }

  const eventId = uuid(400);
  await createEvent(service, watch, eventId);

  const created = deliveryDeviceIds(store, eventId);
  assert.equal(created.length, responders.length, "every eligible responder gets exactly one offer");
  assert.deepEqual(created, [...responders].sort((left, right) => left.localeCompare(right)),
    "offer creation must follow ascending deviceInstanceId order");
});

test("identity deduplication keeps the lexicographically smallest device", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config, undefined, () => new Date(T0));
  const { watch } = await bootstrapPatient(service, "order-b");

  // One account, two devices: same stable userId, which is what identity
  // deduplication keys on.  Provisioned once and reused for both bootstraps —
  // re-provisioning the same key would revoke the earlier session.
  const account = await service.provisionControlledTestAccount("order-responder");
  const accountPrincipal = service.authenticateToken(account.sessionToken);

  const larger = uuid(410);
  const smaller = uuid(409);
  for (const [index, deviceId] of [larger, smaller].entries()) {
    const result = await service.bootstrap(accountPrincipal as never, {
      deviceInstanceId: deviceId, deviceKind: "IPHONE", companionPairId: uuid(800 + index),
      agreementAcceptances: AGREEMENTS,
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    }, `iphone:${deviceId}`);
    const principal = service.authenticateToken(result.sessionToken);
    await service.updateResponderPosition(principal, {
      positionUpdateId: uuid(600 + index), responderPosition: NEAR, observedAt: BASE_TIME
    });
  }

  const eventId = uuid(401);
  await createEvent(service, watch, eventId);

  const created = deliveryDeviceIds(store, eventId);
  assert.equal(created.length, 1, "one user with two devices must receive exactly one offer");
  assert.equal(created[0], smaller,
    "the smallest deviceInstanceId for the identity must be the one that receives the offer");
});
