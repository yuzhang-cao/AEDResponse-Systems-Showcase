/**
 * The transaction-backed recruitment context (Phase 1 → step 5's target adapter).
 *
 * It is the third mode in the frozen vocabulary: `transaction` = the committed index
 * UNION this transaction's staged delta, with every value resolved through the
 * transaction's own view.  Two rules make it correct, and both are the whole reason
 * the earlier draft/mode split exists:
 *
 *   1. **Indexes supply candidate KEYS, never entities.**  A committed geographic hit
 *      is looked up with `tx.get`, so a device whose position this transaction just
 *      moved yields the transaction's version, not the committed one.  Returning the
 *      object an index handed us would be the same class of error as handing a
 *      committed event to a transaction predicate.
 *
 *   2. **The union is taken in both directions.**  Committed indexes are advanced only
 *      after a commit, so on their own they miss what this transaction wrote
 *      (`tx.stagedKeys`) and they still contain what this transaction deleted or
 *      invalidated (the exact predicate then rejects those).  Over-selection is
 *      always safe; omission never is.
 *
 * The adapter de-duplicates and restores collection enumeration order after the
 * union. Patient notification audiences retain that order. Business selection
 * order remains with `eligibleResponderDevices` and the offer loop, which apply
 * their own sorts to this candidate set.
 */
import type { EntityTransaction } from "./entity-transaction.js";
import { timelineEntryFor } from "./event-audit.js";
import { notificationRowFor } from "./notification-outbox.js";
import { fingerprint } from "./domain.js";
import { assignmentExitsParticipation, deviceIdentityKey } from "./domain.js";
import { candidateDeviceKeys, compareByOrdinal, survivingAssignmentForDevice } from "./recruitment-context.js";
import { operationMetrics } from "./runtime-metrics.js";
import type { RecruitmentContext, TxRecruitmentContext } from "./recruitment-context.js";
import type {
  AssignmentRecord,
  DeliveryRecord,
  DeviceRecord,
  EventRecord,
  NotificationName
} from "./models.js";

/** Committed-index accessors, all optional: absent means "scan instead". */
export interface TxRecruitmentIndexes {
  /** Committed geographic index over device positions. */
  devicePositions?: {
    query(latitude: number, longitude: number, radiusMeters: number): string[];
  } | undefined;
  /** Committed "which deliveries belong to this event" index. */
  deliveryIdsForEvent?: ((eventId: string) => readonly string[]) | undefined;
  /** Committed assignment index: assignments naming this device. */
  assignmentIdsForDevice?: ((deviceInstanceId: string) => readonly string[]) | undefined;
  /** Committed assignment index: devices sharing an identity key. */
  deviceIdsForIdentity?: ((identityKey: string) => readonly string[]) | undefined;
  /** Committed device collection order, needed by the patient notification audience. */
  deviceOrdinal?: ((deviceInstanceId: string) => number | undefined) | undefined;
  activeEventIds?: (() => readonly string[]) | undefined;
  /**
   * Upper bound handed to `keysWhere`.  A bounded request keeps a missing index a
   * cost problem rather than a correctness problem.
   */
  scanLimit?: number | undefined;
}

const DEFAULT_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;

export function txRecruitmentContext(
  tx: EntityTransaction,
  indexes: TxRecruitmentIndexes = {}
): TxRecruitmentContext {
  const limit = indexes.scanLimit ?? DEFAULT_SCAN_LIMIT;

  /** Resolve keys through the transaction view and drop anything absent from it. */
  const devicesFor = (keys: Iterable<string>): DeviceRecord[] => {
    const seen = new Set<string>();
    const devices: DeviceRecord[] = [];
    for (const key of keys) {
      // Dedup is the adapter's contract: the union of a committed index and staged
      // keys names the same device twice, and the caller's sort/dedup must not be
      // what makes that harmless.
      if (seen.has(key)) continue;
      seen.add(key);
      operationMetrics.deviceCandidatesVisited += 1;
      const device = tx.get("devices", key) as DeviceRecord | undefined;
      if (device) devices.push(device);
    }
    return devices;
  };

  const deliveryIdsForEvent = (eventId: string): string[] => {
    const committed = indexes.deliveryIdsForEvent?.(eventId);
    const keys = committed
      ? [...committed]
      : tx.keysWhere("deliveries", delivery => delivery.eventId === eventId, limit);
    // Staged deliveries are not in the committed index yet.
    for (const key of tx.stagedKeys("deliveries")) {
      const delivery = tx.get("deliveries", key) as DeliveryRecord | undefined;
      if (delivery && delivery.eventId === eventId) keys.push(key);
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(key);
    }
    return ids;
  };

  /** Deliveries of one event, in the transaction's view and in collection order. */
  const deliveriesOfEvent = (eventId: string): DeliveryRecord[] =>
    deliveryIdsForEvent(eventId)
      .map((id) => {
        operationMetrics.deliveryCandidatesVisited += 1;
        return tx.get("deliveries", id) as DeliveryRecord | undefined;
      })
      .filter((delivery): delivery is DeliveryRecord => delivery !== undefined
        && delivery.eventId === eventId);

  /**
   * Candidate assignments for a device, from the structural index rather than a scan.
   *
   * Four sources, and each closes a hole the others leave:
   *
   *   - assignments naming this device (committed index);
   *   - assignments naming any device that shares this identity (committed index) -
   *     the eligibility rule matches on identity, not only on the device;
   *   - this transaction's staged assignments, which the committed index cannot know;
   *   - assignments of devices this transaction STAGED whose identity now matches.
   *     Binding a device rewrites its identity from `device:<id>` to `user:<uid>`, so
   *     the committed identity map is stale for exactly that case, and a sibling's
   *     assignments would otherwise be invisible.
   *
   * Still only candidates: every hit is re-read through `tx.get` and judged by the
   * exact predicate, so over-selection is free and omission is what would be a bug.
   */
  const assignmentIdsForDevice = (device: DeviceRecord): string[] => {
    const identity = deviceIdentityKey(device);
    const keys: string[] = [];
    const indexed = indexes.assignmentIdsForDevice;
    const siblings = indexes.deviceIdsForIdentity;
    if (indexed) keys.push(...indexed(device.deviceInstanceId));
    if (indexed) {
      const siblingIds = siblings?.(identity)
        ?? tx.keysWhere("devices", candidate => deviceIdentityKey(candidate) === identity, limit);
      for (const siblingId of siblingIds) keys.push(...indexed(siblingId));
    }
    if (!indexed) {
      // No index configured: the exact predicate still decides, so a bounded scan
      // is the honest fallback rather than a wrong answer.
      keys.push(...tx.keysWhere("assignments", () => true, limit));
    }
    keys.push(...tx.stagedKeys("assignments"));
    if (indexed) {
      for (const stagedDeviceKey of tx.stagedKeys("devices")) {
        const stagedDevice = tx.get("devices", stagedDeviceKey) as DeviceRecord | undefined;
        if (!stagedDevice || stagedDevice.deviceInstanceId === device.deviceInstanceId) continue;
        if (deviceIdentityKey(stagedDevice) !== identity) continue;
        keys.push(...indexed(stagedDevice.deviceInstanceId));
      }
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(key);
    }
    return ids;
  };

  return {
    mode: "transaction",

    getEvent: eventId => tx.get("events", eventId) as EventRecord | undefined,
    getDevice: deviceInstanceId =>
      tx.get("devices", deviceInstanceId) as DeviceRecord | undefined,

    candidateDevices: (event) => {
      // One candidate rule, shared with the draft adapter: committed geographic
      // candidates for this ring, plus the patient's devices, plus everything this
      // transaction staged.  Ordering and the patient-sibling lookup are both
      // LAZY: with the indexes present this path enumerates nothing, and without
      // them it degrades to the scans the legacy adapter always performed.
      let orderedKeysMemo: readonly string[] | undefined;
      const orderedKeys = (): readonly string[] => {
        orderedKeysMemo ??= tx.keys("devices");
        return orderedKeysMemo;
      };
      const stagedKeys = tx.stagedKeys("devices");
      const keys = candidateDeviceKeys({
        event,
        unlocatedCandidates: indexes.devicePositions ? [] : undefined,
        queryNearby: (latitude, longitude, radiusMeters) =>
          indexes.devicePositions?.query(latitude, longitude, radiusMeters),
        deviceIdsForIdentity: indexes.deviceIdsForIdentity,
        resolveOrderedKeys: orderedKeys,
        resolvePatientSiblingDeviceKeys: () =>
          tx.keysWhere("devices", device => device.userId === event.patientUserId, limit),
        extraDeviceKeys: stagedKeys,
        ...(indexes.deviceOrdinal
          ? { compareDeviceKeys: compareByOrdinal(indexes.deviceOrdinal, orderedKeys, stagedKeys) }
          : {})
      });
      return devicesFor(keys);
    },

    deliveriesOfEvent,
    getDelivery: deliveryId =>
      tx.get("deliveries", deliveryId) as DeliveryRecord | undefined,
    deliveryForDevice: (eventId, deviceInstanceId) =>
      deliveriesOfEvent(eventId).find(delivery =>
        delivery.deviceInstanceId === deviceInstanceId),
    deliveryForUser: (eventId, userId) =>
      deliveriesOfEvent(eventId).find(delivery =>
        (tx.get("devices", delivery.deviceInstanceId) as DeviceRecord | undefined)?.userId
          === userId),

    hasAcceptedDeliveryFromIdentity: (eventId, device) => {
      const identity = deviceIdentityKey(device);
      return deliveriesOfEvent(eventId).some((delivery) => {
        if (delivery.decision !== "ACCEPT" || delivery.status !== "ACCEPTED") return false;
        const acceptedDevice =
          tx.get("devices", delivery.deviceInstanceId) as DeviceRecord | undefined;
        return acceptedDevice !== undefined
          && deviceIdentityKey(acceptedDevice) === identity;
      });
    },

    hasActiveAssignmentForDevice: (device) => {
      const identity = deviceIdentityKey(device);
      return assignmentIdsForDevice(device).some((assignmentId) => {
        operationMetrics.assignmentCandidatesVisited += 1;
        const assignment = tx.get("assignments", assignmentId) as AssignmentRecord | undefined;
        if (!assignment) return false;
        const event = tx.get("events", assignment.eventId) as EventRecord | undefined;
        if (event?.state !== "ACTIVE") return false;
        if (assignmentExitsParticipation(assignment.status)) return false;
        const assignedDevice =
          tx.get("devices", assignment.deviceInstanceId) as DeviceRecord | undefined;
        return assignment.deviceInstanceId === device.deviceInstanceId
          || (assignedDevice !== undefined && deviceIdentityKey(assignedDevice) === identity);
      });
    },

    currentAssignmentForDevice: (eventId, deviceInstanceId) => {
      // Same surviving-record rule as the legacy adapter, over the transaction view.
      const keys = indexes.assignmentIdsForDevice
        ? [...new Set([...indexes.assignmentIdsForDevice(deviceInstanceId), ...tx.stagedKeys("assignments")])]
        : tx.keysWhere("assignments", assignment => assignment.eventId === eventId
          && assignment.deviceInstanceId === deviceInstanceId, limit);
      const candidates = keys
        .map(key => tx.get("assignments", key) as AssignmentRecord | undefined)
        .filter((assignment): assignment is AssignmentRecord => assignment !== undefined
          && assignment.eventId === eventId && assignment.deviceInstanceId === deviceInstanceId);
      return candidates.sort((left, right) => right.revision - left.revision
        || right.updatedAt.localeCompare(left.updatedAt))[0];
    },

    isActivePatient: (deviceInstanceId) => {
      const userId = (tx.get("devices", deviceInstanceId) as DeviceRecord | undefined)?.userId;
      if (indexes.activeEventIds) {
        return [...new Set([...indexes.activeEventIds(), ...tx.stagedKeys("events")])].some(key => {
          const event = tx.get("events", key);
          return event?.state === "ACTIVE" && (event.patientDeviceIds.includes(deviceInstanceId)
            || (userId !== undefined && event.patientUserId === userId));
        });
      }
      return tx.keysWhere("events", event => event.state === "ACTIVE"
        && (event.patientDeviceIds.includes(deviceInstanceId)
          || (userId !== undefined && event.patientUserId === userId)), 1).length > 0;
    },

    updateEvent: (eventId, mutate) => {
      if (!tx.has("events", eventId)) return undefined;
      tx.update("events", eventId, mutate as (draft: EventRecord) => void);
      return tx.get("events", eventId) as EventRecord | undefined;
    },

    createDelivery: (delivery) => {
      // Append-only, exactly like `enqueueNotification`: a fresh id is expected, and
      // re-using one with different content is rejected rather than overwriting.
      tx.append("deliveries", delivery.id, delivery);
    },

    updateDelivery: (deliveryId, mutate) => {
      if (!tx.has("deliveries", deliveryId)) {
        throw new Error(
          `Recruitment could not update delivery ${deliveryId}: the transaction has no `
          + "such delivery in its current view."
        );
      }
      tx.update("deliveries", deliveryId, mutate as (draft: DeliveryRecord) => void);
      return tx.get("deliveries", deliveryId) as DeliveryRecord;
    },

    insertNotification: (deviceInstanceId, name, payload) => {
      const device = tx.get("devices", deviceInstanceId) as DeviceRecord | undefined;
      if (!device) return;
      const row = notificationRowFor(device, deviceInstanceId, name, payload);
      if (!row) return;
      const prior = tx.get("notificationOutboxById", row.id);
      if (prior) {
        // Same rule as the whole-state path: identical replay is a no-op, different
        // content under one identity is refused.
        if (fingerprint({ recipient: prior.recipient, payload: prior.payload })
          !== fingerprint({ recipient: row.recipient, payload: row.payload })) {
          throw new Error("Notification identity was reused with different content");
        }
        return;
      }
      tx.append("notificationOutboxById", row.id, row);
    },

    appendTimeline: (eventId, occurredAt, kind, message) => {
      const entry = timelineEntryFor(eventId, occurredAt, kind, message);
      if (tx.has("timelineByEventId", eventId)) {
        tx.update("timelineByEventId", eventId, draft => {
          (draft as unknown as { push(entry: unknown): void }).push(entry);
        });
      } else {
        tx.append("timelineByEventId", eventId, [entry] as never);
      }
    }
  };
}

/** Re-exported so callers do not need to reach into two modules for the same thing. */
export { survivingAssignmentForDevice };
export type { RecruitmentContext, NotificationName };
