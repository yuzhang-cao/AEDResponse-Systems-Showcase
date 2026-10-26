/**
 * Delivery-index freshness across both commit routes.
 *
 * Root cause of the duplicate offer seen when the position path was switched to
 * entity transactions.
 *
 * The switch made the recruitment adapter read deliveries through the store's
 * committed `DeliveryIndex`.  The legacy adapter never did - it scanned
 * `state.deliveries` directly - so the index's freshness had never mattered for
 * `deliveryForDevice` before.
 *
 * `MemoryStateStore.transact` (the whole-state path) rebuilds the expiry, position
 * and assignment indexes but NOT the delivery index.  So a delivery committed by any
 * command that runs on the whole-state route is invisible to the index, and a
 * transaction-backed `deliveryForDevice` then reports "no offer for this device" and
 * creates a second one.  The second `response:requested` shares the first's
 * notification identity (its messageId carries only event and device) while carrying
 * a different delivery id, which is what raised
 * "Notification identity was reused with different content".
 *
 * This test asserts the GAP, not a fix: it documents that the index is stale after
 * the whole-state route, so the fix can be chosen deliberately rather than guessed
 * at.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type PersistentState } from "../src/models.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const AT = "2026-08-31T01:02:00.000Z";
const EVENT_ID = uuid(500);
const DEVICE_ID = uuid(200);
const DELIVERY_ID = uuid(900);

function world(): PersistentState {
  const state = emptyState();
  state.devices[DEVICE_ID] = {
    deviceInstanceId: DEVICE_ID, deviceKind: "IPHONE", userId: uuid(300),
    companionPairId: uuid(9_000), agreements: {},
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: AT, lastSeenAt: AT, lastBootstrapAt: AT
  } as never;
  state.events[EVENT_ID] = {
    id: EVENT_ID, state: "ACTIVE", recruitmentState: "RECRUITING",
    patientUserId: uuid(301), patientDeviceIds: [uuid(302)], patientPairId: uuid(702),
    observation: {
      schemaVersion: "2.0", eventId: EVENT_ID, observationKind: "FALL_CONTEXT",
      fallDetectedAt: AT, patientPositionObservedAt: AT,
      fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12 }
    },
    observationFingerprint: "f", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    patientPosition: null, currentRecruitmentRadiusMeters: 1_000,
    recruitmentStageStartedAt: AT, coordinationRevision: 1, assignmentRevision: 1,
    unavailableAedIds: [], createdAt: AT
  } as never;
  return state;
}

function deliveryRow() {
  return {
    id: DELIVERY_ID, eventId: EVENT_ID, deviceInstanceId: DEVICE_ID,
    request: {
      schemaVersion: "2.0", messageId: `response-requested:${EVENT_ID}:${DEVICE_ID}`,
      eventId: EVENT_ID, deliveryId: DELIVERY_ID, deliveryStatus: "SENT",
      occurredAt: AT, eventType: "FALL_ASSISTANCE", positioningTier: "SEARCH_RING",
      distanceRange: "DISTANCE_500_1000M", etaRange: "ETA_5_10_MIN",
      currentRecruitmentRadiusMeters: 1_000, expiresAt: AT
    },
    status: "SENT", statusOccurredAt: AT
  } as never;
}

test("both routes keep the delivery index current", async () => {
  const viaWholeState = new MemoryStateStore(world());
  await viaWholeState.transact((state) => {
    state.deliveries[DELIVERY_ID] = deliveryRow();
  });
  assert.ok(viaWholeState.read(s => s.deliveries[DELIVERY_ID]),
    "the whole-state transaction persisted the delivery");
  assert.deepEqual(
    [...(viaWholeState.deliveryIndex?.()?.deliveryIdsForEvent(EVENT_ID) ?? new Set<string>())],
    [DELIVERY_ID],
    "and the delivery index knows about it. This assertion previously documented the "
    + "opposite: `transact` rebuilt the expiry, position and assignment indexes but not "
    + "the delivery one, so a delivery committed here was invisible to any index-backed "
    + "lookup. Nothing noticed while every reader scanned `state.deliveries` directly; "
    + "the transaction-backed recruitment adapter was the first index-backed reader, and "
    + "a stale index made its offer guard report 'no offer for this device' and create a "
    + "second one for the same (event, device) - which surfaced as \"Notification "
    + "identity was reused with different content\".");
});

test("the entity route keeps the delivery index current", async () => {
  const store = new MemoryStateStore(world());

  await store.transactEntities!((tx) => {
    tx.append("deliveries", DELIVERY_ID, deliveryRow());
  });

  const indexed = store.deliveryIndex?.()?.deliveryIdsForEvent(EVENT_ID) ?? new Set<string>();
  assert.deepEqual([...indexed], [DELIVERY_ID],
    "transactEntities does call deliveries.applyChanges, so this route is consistent - "
    + "which is exactly why the gap only appears once a route switches");
});
