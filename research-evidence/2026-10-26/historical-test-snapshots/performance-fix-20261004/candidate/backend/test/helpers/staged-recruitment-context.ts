/**
 * A stand-in transaction adapter for the recruitment context.
 *
 * The legacy adapter cannot test write semantics.  Under it, `ctx.createDelivery(d)`
 * and `state.deliveries[d.id] = d` touch the same object, and `updateEvent` mutates
 * the caller's event in place — so every write-abstraction test passes whether or
 * not the algorithm actually uses the seam.  That was measured, not assumed: two
 * deliberate sabotages (in-place event mutation, `updateEvent` returning nothing)
 * both stayed green against legacy-backed tests.
 *
 * This double is therefore specified from the Phase 2 contract rather than from the
 * legacy behaviour:
 *
 *   - writes stage a detached copy; the committed state is never touched;
 *   - reads merge committed entries with the staged delta, preserving committed
 *     insertion order and overriding by key — which is what applying a change set
 *     to a state object does;
 *   - the same instance must be used for a whole operation, because read-your-writes
 *     is a property of one context, not of the store.
 *
 * It is deliberately one implementation shared by every test that needs it.  A
 * second copy would be free to drift from this contract, and then the tests would be
 * checking the double instead of the algorithm.
 */
import { draftRecruitmentContext } from "../../src/recruitment-context.js";
import type { RecruitmentContext } from "../../src/recruitment-context.js";
import type {
  DeliveryRecord,
  DeviceRecord,
  EventRecord,
  NotificationName,
  PersistentState
} from "../../src/models.js";

export interface StagedRecruitmentContext extends RecruitmentContext {
  /** The staged view of an event, or undefined if it was never written. */
  stagedEvent(eventId: string): EventRecord | undefined;
  /** The staged delta for deliveries, in insertion order. */
  stagedDeliveries(): DeliveryRecord[];
  /** Event ids passed to `updateEvent`, in order, including repeats. */
  eventUpdateCalls(): readonly string[];
  /** Delivery ids passed to `createDelivery`, in order. */
  deliveryCreateCalls(): readonly string[];
  /** Delivery ids whose id already existed when `createDelivery` was called. */
  deliveryCreateCollisions(): readonly string[];
  /** Notifications enqueued through this context, in order. */
  stagedNotifications(): readonly { deviceInstanceId: string; name: NotificationName }[];
  /** Timeline entries appended through this context, in order. */
  stagedTimeline(): readonly { eventId: string; kind: string; message: string }[];
  /**
   * Every write through this context, in the order it happened.
   *
   * Per-collection assertions cannot see a reordering between collections, and the
   * write order is behaviour: in-transaction helpers may read what earlier steps
   * wrote, so "it all commits together" does not make reordering free.
   */
  writeLog(): readonly string[];
}

const copy = <T>(value: T): T => structuredClone(value);

export function stagedRecruitmentContext(
  committed: Readonly<PersistentState>
): StagedRecruitmentContext {
  const base = draftRecruitmentContext(committed);
  const events = new Map<string, EventRecord>();
  const deliveries = new Map<string, DeliveryRecord>();
  const notifications: { deviceInstanceId: string; name: NotificationName }[] = [];
  const timeline: { eventId: string; kind: string; message: string }[] = [];
  const eventUpdates: string[] = [];
  const deliveryCreates: string[] = [];
  const deliveryCollisions: string[] = [];
  const writes: string[] = [];

  /**
   * Committed entries first, staged overrides applied in place, new staged keys
   * appended.  `Map.set` on an existing key keeps its original position, which is
   * exactly how applying a change set to an ordered collection behaves.
   */
  const mergedDeliveries = (): DeliveryRecord[] => {
    const merged = new Map<string, DeliveryRecord>();
    for (const [id, delivery] of Object.entries(committed.deliveries)) {
      merged.set(id, delivery);
    }
    for (const [id, delivery] of deliveries) merged.set(id, delivery);
    return [...merged.values()];
  };

  return {
    ...base,
    mode: "transaction" as const,

    getEvent: (eventId) => events.get(eventId) ?? base.getEvent(eventId),
    updateEvent: (eventId, mutate) => {
      const current = events.get(eventId) ?? base.getEvent(eventId);
      if (!current) return undefined;
      const next = copy(current);
      mutate(next);
      events.set(eventId, next);
      eventUpdates.push(eventId);
      writes.push("event");
      // A copy, never the staged object itself: an in-place write to what we return
      // must be lost, or the double would hide exactly the bug it exists to catch.
      return copy(next);
    },

    deliveriesOfEvent: eventId =>
      mergedDeliveries().filter(delivery => delivery.eventId === eventId),
    deliveryForDevice: (eventId, deviceInstanceId) =>
      mergedDeliveries().find(delivery => delivery.eventId === eventId
        && delivery.deviceInstanceId === deviceInstanceId),
    // No devices are staged by this double, so the user lookup resolves against the
    // committed device table - the same rule the legacy adapter applies.
    deliveryForUser: (eventId, userId) =>
      mergedDeliveries().find(delivery => delivery.eventId === eventId
        && committed.devices[delivery.deviceInstanceId]?.userId === userId),
    hasAcceptedDeliveryFromIdentity: (eventId, device) => {
      const identity = device.deviceInstanceId;
      return mergedDeliveries().some(delivery => delivery.eventId === eventId
        && delivery.decision === "ACCEPT"
        && delivery.status === "ACCEPTED"
        && delivery.deviceInstanceId === identity);
    },
    hasActiveAssignmentForDevice: () => false,
    isActivePatient: (deviceInstanceId) =>
      base.isActivePatient(deviceInstanceId),

    createDelivery: (delivery) => {
      if (deliveries.has(delivery.id) || committed.deliveries[delivery.id] !== undefined) {
        deliveryCollisions.push(delivery.id);
      }
      deliveries.set(delivery.id, copy(delivery));
      deliveryCreates.push(delivery.id);
      writes.push("delivery");
    },
    updateDelivery: (deliveryId, mutate) => {
      const merged = mergedDeliveries().find(delivery => delivery.id === deliveryId);
      if (!merged) {
        throw new Error(
          `Recruitment could not update delivery ${deliveryId}: the context has no `
          + "such delivery in its current view."
        );
      }
      const next = copy(merged);
      mutate(next);
      deliveries.set(deliveryId, next);
      writes.push("delivery-update");
      // A copy, so an in-place write to what we return is lost - the same rule as
      // `updateEvent`, and for the same reason.
      return copy(next);
    },

    insertNotification: (deviceInstanceId, name) => {
      notifications.push({ deviceInstanceId, name });
      writes.push("notification");
    },
    appendTimeline: (eventId, _occurredAt, kind, message) => {
      timeline.push({ eventId, kind, message });
      writes.push("timeline");
    },

    stagedEvent: eventId => events.get(eventId),
    stagedDeliveries: () => [...deliveries.values()],
    eventUpdateCalls: () => eventUpdates,
    deliveryCreateCalls: () => deliveryCreates,
    deliveryCreateCollisions: () => deliveryCollisions,
    stagedNotifications: () => notifications,
    stagedTimeline: () => timeline,
    writeLog: () => writes
  };
}

/** A device visible in a staged view: committed devices are read straight through. */
export type StagedDevice = DeviceRecord;
