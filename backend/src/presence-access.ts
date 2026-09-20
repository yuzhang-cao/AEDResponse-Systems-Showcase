/**
 * Narrow, computation-scoped state access for `AEDResponseService.presenceView()`.
 *
 * Why this exists: the standby-position response path needs `positioningTier`,
 * which `presenceView()` derives from events, deliveries and assignments.  The
 * previous implementation therefore called `store.read()`, cloning the entire
 * state tree (56,423 entities at the measured baseline) to compute one enum.
 *
 * `presenceView()` does NOT read only those three collections plus devices:
 *   - state.devices      (key access only, via sameUser / acceptedDeviceIds /
 *                         isEligibleResponderDeviceBase)
 *   - state.events       (enumerated, and key access via assignment.eventId)
 *   - state.deliveries   (enumerated: acceptedDeviceIds, isEligibleNearbyResponder)
 *   - state.assignments  (enumerated: currentAssignmentForDevice,
 *                         isEligibleResponderDeviceBase)
 *
 * The scope above was derived by tracing every transitive call, not by sampling
 * call sites.  `PresenceState` below is a `Pick` of exactly those four
 * collections, so TypeScript rejects any future reach into another collection.
 *
 * Contract for the view-backed implementation:
 *   - each collection is materialised at most ONCE per computation and reused;
 *   - devices are read by key with a per-computation memo rather than by
 *     materialising all 20k device records;
 *   - nothing is cached across computations/requests;
 *   - no async awaits, so the whole computation observes one committed snapshot.
 */

import type {
  AssignmentRecord,
  DeliveryRecord,
  DeviceRecord,
  EventRecord,
  PersistentState
} from "./models.js";
import type { StateReadView } from "./state-read.js";

/** Exactly the collections `presenceView()` and its transitive callees read. */
export type PresenceState = Pick<
  PersistentState,
  "devices" | "events" | "deliveries" | "assignments"
>;

function lazyDevices(getOne: (key: string) => DeviceRecord | undefined): Record<string, DeviceRecord> {
  const memo = new Map<string, DeviceRecord | undefined>();
  return new Proxy({} as Record<string, DeviceRecord>, {
    get(_target, key) {
      // Symbols (and non-string keys) must not trigger a lookup; returning
      // undefined also keeps this object from being mistaken for a thenable.
      if (typeof key !== "string") return undefined;
      if (!memo.has(key)) memo.set(key, getOne(key));
      return memo.get(key);
    },
    has(_target, key) {
      return typeof key === "string" && getOne(key) !== undefined;
    },
    // Enumerating devices would defeat the purpose of this accessor: it would
    // clone every device record.  Fail loudly rather than silently degrade.
    ownKeys() {
      throw new Error("presence access must not enumerate the devices collection");
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
    set() {
      throw new Error("presence access is read-only");
    }
  });
}

/**
 * Wraps an already-live state (used inside a transaction, where the draft is
 * mutable and already detached).  Reads are direct; nothing is cloned.
 */
export function livePresenceAccess(state: Readonly<PresenceState>): PresenceState {
  return state as PresenceState;
}

export interface PresenceAccessStats {
  /** Number of times each enumerated collection had to be materialised. */
  collectionLoads: { events: number; deliveries: number; assignments: number };
  /** Number of device records cloned on demand (memo misses). */
  deviceLoads: number;
  /** Time spent inside the underlying read view loading/cloning entities. */
  loadMs: number;
}

/**
 * Wraps a committed-snapshot read view.  Each enumerated collection is loaded
 * lazily on first use and reused for the rest of the computation; devices are
 * fetched by key and memoised.
 */
export function viewPresenceAccess(
  view: StateReadView,
  stats?: PresenceAccessStats
): PresenceState {
  let events: Record<string, EventRecord> | undefined;
  let deliveries: Record<string, DeliveryRecord> | undefined;
  let assignments: Record<string, AssignmentRecord> | undefined;

  const loadAll = <T>(collection: "events" | "deliveries" | "assignments"): Record<string, T> => {
    const startedAt = performance.now();
    // select() clones each candidate before testing the predicate, so a limit of
    // MAX_SAFE_INTEGER yields exactly one detached copy of every entity.
    const rows = view.select(collection as never, () => true, Number.MAX_SAFE_INTEGER) as T[];
    if (stats) {
      stats.collectionLoads[collection] += 1;
      stats.loadMs += performance.now() - startedAt;
    }
    const record: Record<string, T> = {};
    for (const row of rows) {
      // EventRecord, DeliveryRecord and AssignmentRecord are all keyed by `id`
      // in PersistentState, so the record's own id is the map key.
      const key = (row as { id?: string }).id;
      if (key !== undefined) record[key] = row;
    }
    return record;
  };

  return {
    get devices() {
      return lazyDevices((key) => {
        const startedAt = performance.now();
        const device = view.get("devices", key) as DeviceRecord | undefined;
        if (stats) {
          stats.deviceLoads += 1;
          stats.loadMs += performance.now() - startedAt;
        }
        return device;
      });
    },
    get events() {
      events ??= loadAll<EventRecord>("events");
      return events;
    },
    get deliveries() {
      deliveries ??= loadAll<DeliveryRecord>("deliveries");
      return deliveries;
    },
    get assignments() {
      assignments ??= loadAll<AssignmentRecord>("assignments");
      return assignments;
    }
  };
}

export function emptyPresenceAccessStats(): PresenceAccessStats {
  return { collectionLoads: { events: 0, deliveries: 0, assignments: 0 }, deviceLoads: 0, loadMs: 0 };
}
