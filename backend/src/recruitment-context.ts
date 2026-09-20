import { stateAccess, stateRows } from "./incremental-state.js";
/**
 * Recruitment access context (Phase 1 step #5, commit 1: abstraction only).
 *
 * The recruitment algorithm currently reaches into a whole `PersistentState`
 * directly, so there is no seam at which an indexed implementation could be
 * substituted.  This module introduces that seam WITHOUT changing behaviour: the
 * legacy adapter performs exactly the scans the code performs today.
 *
 * Splitting the work this way keeps the two risks apart:
 *   - commit 1 (this one) proves the abstraction itself is behaviour-preserving —
 *     every existing test must still pass, with identical output and identical
 *     cost;
 *   - commit 2 substitutes an indexed adapter, and any difference it introduces is
 *     then attributable to the adapter and the indexes, not to the extraction.
 *
 * The interface is deliberately shaped around the questions the algorithm asks,
 * not around collections.  `candidateDevices` is the load-bearing one: the legacy
 * adapter answers "all devices" (so ordering and completeness are unchanged), and
 * an indexed adapter may answer "the devices the geographic index places inside
 * the ring, plus patient viewers and whatever this transaction changed" — a
 * superset that the exact predicate then filters, in collection enumeration order.
 *
 * Indexed adapters must never let a committed index become the source of truth:
 * indexes produce candidates; every final judgement reads current state.
 */

import type {
  AssignmentRecord,
  DeliveryRecord,
  DeviceRecord,
  EventRecord,
  NotificationName,
  NotificationRecord,
  PersistentState,
  TimelineEntry
} from "./models.js";
import { enqueueNotification } from "./notification-outbox.js";
import { appendTimeline } from "./event-audit.js";
import { assignmentExitsParticipation, deviceIdentityKey } from "./domain.js";
import type { PresenceState } from "./presence-access.js";
import { operationMetrics } from "./runtime-metrics.js";

/**
 * Which state a context reads.  Frozen vocabulary, three values, no fourth:
 *
 *   draft      reads the object it was handed, which inside a transaction is the
 *              draft.  May NOT consult anything that only reflects committed state.
 *   committed  reads committed state and MAY use a committed index.
 *   transaction  (Phase 2) committed index UNION this transaction's staged delta.
 *
 * This is a mode, not a hint.  Reading committed state through a draft-typed
 * context, or the reverse, produces code that compiles, passes review, and
 * silently loses business behaviour — an ACCEPT with no assignment, in the case
 * that produced this type.  So the mode is carried on the value and asserted at
 * the points where the two are not interchangeable.
 */
export type RecruitmentMode = "draft" | "committed" | "transaction";

export interface RecruitmentContext {
  readonly mode: RecruitmentMode;

  getEvent(eventId: string): EventRecord | undefined;
  getDevice(deviceInstanceId: string): DeviceRecord | undefined;

  /**
   * Devices that could possibly be recruitment candidates for this event.
   *
   * May over-select; must never omit a device that is genuinely eligible.  The
   * caller applies the exact eligibility predicate to whatever it receives, so an
   * indexed adapter may narrow this to geographic candidates, patient viewers
   * (who need no R position), and entities the current transaction changed.
   * Preserve device collection order for the patient notification audience;
   * responder selection applies its own business sort.
   *
   * Two further contracts for the transaction adapter:
   *
   * 1. **Each `deviceInstanceId` appears at most once.**  The legacy adapter cannot
   *    violate this (object keys are unique), but a transaction adapter unions a
   *    committed geographic result with `tx.stagedKeys("devices")`, and the same
   *    device is then very likely to arrive twice.  Relying on the caller's sort
   *    and identity de-duplication to absorb that would double eligibility work,
   *    inflate the diagnostic counts, and become a real bug the moment the caller
   *    grows a side effect.  Uniqueness is the context's job, not the algorithm's.
   *
   * 2. **Every returned device is the object from this context's current view.**
   *    An index supplies candidate *keys*, never truth objects: the adapter looks
   *    each key up through itself, so a committed index hit still yields the
   *    transaction's version of that device.  Returning a committed `DeviceRecord`
   *    alongside transaction state is the same class of error as passing a
   *    committed event to a transaction predicate.
   */
  candidateDevices(event: EventRecord): DeviceRecord[];

  /** All deliveries recorded for one event. */
  deliveriesOfEvent(eventId: string): DeliveryRecord[];

  /**
   * One delivery by identity.
   *
   * Needed because `recruitmentUpdate` maps each request back to its recipient
   * device through the delivery row.  Deliveries are recruitment-domain data, so
   * this belongs here rather than in a second reader.
   */
  getDelivery(deliveryId: string): DeliveryRecord | undefined;
  deliveryForDevice(eventId: string, deviceInstanceId: string): DeliveryRecord | undefined;
  deliveryForUser(eventId: string, userId: string): DeliveryRecord | undefined;

  /**
   * Does this device — or any device sharing its identity — already hold a live
   * task on an ACTIVE event?
   *
   * Question-shaped on purpose.  An earlier draft exposed `assignments(): []`,
   * which is still "hand me the whole collection": a legacy adapter scans it, and
   * an indexed adapter would either be forced to enumerate everything or hide
   * index logic behind a method that reads like an enumeration.  The algorithm
   * only ever needed a boolean here (`Object.values(...).some(...)`), so the
   * context states the question and each adapter answers it its own way.
   */
  hasActiveAssignmentForDevice(device: DeviceRecord): boolean;

  /**
   * Is this device the patient device of an ACTIVE event, directly or through its
   * user?
   *
   * Promoted to the context only because `isEligibleResponderDeviceBase` cannot
   * drop its `state` parameter otherwise: passing both a state and a context would
   * give the predicate two sources of truth, and a transaction adapter would be
   * handed a state object it must not read.  Same class of question as
   * `hasActiveAssignmentForDevice` — "is this device already committed elsewhere" —
   * so it belongs on the seam rather than beside it.
   */
  isActivePatient(deviceInstanceId: string): boolean;

  /**
   * Does this event already hold an ACCEPTED delivery from this device or anything
   * sharing its identity?
   *
   * A third delivery question, deliberately not folded into the other two.
   * `deliveryForDevice` matches the exact device and `deliveryForUser` matches the
   * user; this one matches the identity key, so it also catches a second device of
   * the same person.  Reusing either of those here would silently narrow the
   * predicate, which is a behaviour change and not an extraction.
   */
  hasAcceptedDeliveryFromIdentity(eventId: string, device: DeviceRecord): boolean;

  /**
   * The surviving assignment record for one device on one event: highest revision,
   * ties broken by the later `updatedAt`.
   *
   * Distinct question from `hasActiveAssignmentForDevice`, and both are needed.
   * That one is identity-wide and asks "is this phone already committed anywhere
   * live?"; this one is event-scoped and returns the record so callers can inspect
   * its status.  An earlier draft tried to serve both from one method and lost the
   * status, which `acceptedDeviceIds` needs to decide participation.
   */
  currentAssignmentForDevice(
    eventId: string,
    deviceInstanceId: string
  ): AssignmentRecord | undefined;

  /**
   * Register a change to an event and return the current view of it.
   *
   * The return value is not a convenience.  A transaction context hands the
   * algorithm a detached current-view object, so mutating the `event` argument in
   * place would change a copy the transaction never hears about: the in-memory
   * object would look updated while no change-set entry existed.  Callers must
   * rebind to the returned object and use it from then on.
   *
   * Returns `undefined` when this view has no such event, which is the same silent
   * no-op the legacy in-place mutation performed.
   */
  /**
   * Registers a NEW delivery.
   *
   * Three transaction semantics, and all three matter to the caller:
   *
   * 1. **insert-only** — callers mint a fresh `randomUUID` for the id, so this is
   *    never a replacement.  A collision is counted rather than silently resolved.
   * 2. **immediately visible to this same context** — `deliveryForDevice` and
   *    `deliveryForUser` must return it before any commit.  The recruitment loop
   *    depends on this: the second device of one identity is rejected precisely
   *    because the first device's delivery is already visible.
   * 3. **no committed-state pollution** — under a transaction adapter the delivery
   *    goes to the staged delta, and a rollback discards it.
   */
  createDelivery(delivery: DeliveryRecord): void;

  updateEvent(
    eventId: string,
    mutate: (event: EventRecord) => void
  ): EventRecord | undefined;
  /**
   * Registers a change to a delivery and returns the current view of it.
   *
   * Throws when this view has no such delivery.  Absence is always a defect here,
   * unlike `updateEvent`: callers obtain the id from this same context, so a miss
   * means the context and the caller disagree about what exists.  Silently doing
   * nothing would let an expiry sweep report success while the offer stayed live.
   *
   * The return value must be used for anything read afterwards, because a
   * transaction adapter hands back a different object.
   */
  updateDelivery(
    deliveryId: string,
    mutate: (delivery: DeliveryRecord) => void
  ): DeliveryRecord;
  insertNotification(
    deviceInstanceId: string,
    name: NotificationName,
    payload: Record<string, unknown>
  ): void;
  appendTimeline(
    eventId: string,
    occurredAt: string,
    kind: TimelineEntry["kind"],
    message: string
  ): void;
}

/**
 * Draft-semantics context: valid inside a mutating transaction.
 *
 * Transactional helpers should ask for this type rather than the bare
 * `RecruitmentContext`, so that handing them a committed context is a compile
 * error instead of a silent loss of read-your-writes.
 */
export interface DraftRecruitmentContext extends RecruitmentContext {
  readonly mode: "draft";
}

/** Committed-semantics context: read-only callers, may use a committed index. */
export interface CommittedRecruitmentContext extends RecruitmentContext {
  readonly mode: "committed";
}

/** Phase 2.  Declared here so the vocabulary is complete and greppable. */
export interface TxRecruitmentContext extends RecruitmentContext {
  readonly mode: "transaction";
}

/**
 * Runtime backstop for the same rule.
 *
 * The type system only helps where a helper declares the draft type.  Where a
 * context flows through a shared helper that legitimately serves read-only
 * callers too (such as `acceptedDeviceIds`), the caller is the only place the
 * mistake can be caught — so the transactional entry points assert instead.
 */
export function assertDraftContext(
  context: RecruitmentContext,
  caller: string
): DraftRecruitmentContext {
  if (context.mode !== "draft" && context.mode !== "transaction") {
    throw new Error(
      `${caller} requires a draft-semantics recruitment context but received `
      + `mode="${context.mode}". A committed context cannot see entities written in `
      + `the current transaction, so recruitment would silently lose them.`
    );
  }
  return context as DraftRecruitmentContext;
}

/**
 * The patient position a recruitment ring may be centred on, if any.
 *
 * One rule, two adapters: a Watch trigger snapshot only counts when the
 * observation really carried a fix, which is why the observation kind and its
 * timestamp are checked rather than the presence of the sample alone.
 */
export function recruitmentPatientPositionOf(
  event: Pick<EventRecord, "patientPosition" | "observation">
): { latitude: number; longitude: number } | undefined {
  const sample = event.patientPosition;
  if (!sample) return undefined;
  if (sample.source === "WATCH_TRIGGER_SNAPSHOT"
    && (event.observation.observationKind !== "FALL_CONTEXT"
      || event.observation.patientPositionObservedAt === undefined)) return undefined;
  return sample.position;
}

/**
 * Orders candidate keys by committed collection position, falling back to
 * collection enumeration only for keys the committed index cannot place.
 *
 * The point is what it does NOT do: with a committed ordinal available, a normal
 * candidate set is ordered from that index alone — no whole-collection key
 * enumeration.  The fallback is resolved on first use and only when a key really
 * cannot be placed.
 */
export function compareByOrdinal(
  committedOrdinal: (deviceInstanceId: string) => number | undefined,
  resolveCollectionOrder: () => readonly string[],
  extraKeys: readonly string[]
): (left: string, right: string) => number {
  let fallback: Map<string, number> | undefined;
  let extraOrder: Map<string, number> | undefined;
  // Three tiers, because the three sources have genuinely different positions:
  //   0 a committed device the ordinal index can place;
  //   1 a device this transaction staged, i.e. newer than everything committed;
  //   2 a key neither source knows, ordered by the collection it came from.
  // Ranking these against each other by number would let a staged key outrank a
  // committed one, so they are compared tier-first.
  const placement = (key: string): [number, number] => {
    const committed = committedOrdinal(key);
    if (committed !== undefined) return [0, committed];
    extraOrder ??= new Map(extraKeys.map((extra, index) => [extra, index]));
    const staged = extraOrder.get(key);
    if (staged !== undefined) return [1, staged];
    fallback ??= new Map(resolveCollectionOrder().map((entry, index) => [entry, index]));
    return [2, fallback.get(key) ?? Number.MAX_SAFE_INTEGER];
  };
  return (left, right) => {
    const [leftTier, leftRank] = placement(left);
    const [rightTier, rightRank] = placement(right);
    return leftTier === rightTier ? leftRank - rightRank : leftTier - rightTier;
  };
}

/**
 * The one candidate rule shared by the draft and transaction adapters.
 *
 * The recruitment algorithm asks "which devices could possibly be candidates for
 * this event?"  Two things must stay true wherever the answer comes from:
 *
 *   1. **A device inside the ring is never omitted.**  The geographic index is a
 *      pre-filter, so it may over-select; the exact eligibility predicate applied
 *      by the caller decides.  `extraDeviceKeys` is how each adapter adds what its
 *      candidate source cannot know: the transaction adapter passes its staged
 *      keys; the entity draft passes its local overlay keys.
 *   2. **Patients are always candidates.**  This one set also feeds the patient
 *      notification audience, and a patient device needs no R position.  An
 *      earlier version of the indexed path used only the geographic result and
 *      silently dropped the patient's own devices from their own event.
 *
 * Collection order is restored before returning, because patient notification
 * order is derived from it; responder selection applies its own business sort.
 * When no identity lookup is supplied the patient's other devices are taken from
 * the ordered key list, which is the same scan the legacy adapter performed.
 */
export function candidateDeviceKeys(input: {
  event: Pick<EventRecord,
    "patientDeviceIds" | "patientUserId" | "currentRecruitmentRadiusMeters"
    | "patientPosition" | "observation">;
  /** Committed geographic candidates; `undefined` means "no index available". */
  queryNearby?: ((latitude: number, longitude: number, radiusMeters: number)
    => readonly string[] | undefined) | undefined;
  /** A caller with a grid can rule out responder recruitment until P is known. */
  unlocatedCandidates?: readonly string[] | undefined;
  /** Committed devices of one identity key, when an identity index exists. */
  deviceIdsForIdentity?: ((identityKey: string) => readonly string[]) | undefined;
  /**
   * Collection order, resolved LAZILY.  Both callers can enumerate every device
   * key, and an earlier version of this helper did exactly that on every call —
   * which put a full-device scan back on the position-update path that the
   * transaction adapter had already removed.  It is now requested only when an
   * ordering actually has to be computed.
   */
  resolveOrderedKeys?: (() => readonly string[]) | undefined;
  /** Device keys the candidate source cannot hold: staged writes. */
  extraDeviceKeys?: readonly string[] | undefined;
  /**
   * Ordering by committed collection position.  When supplied, the candidate keys
   * are ordered from the index directly and NO collection enumeration happens.
   */
  compareDeviceKeys?: ((left: string, right: string) => number) | undefined;
  /**
   * Devices of the patient's identity, resolved LAZILY and only when no identity
   * index was supplied.  Passing a computed scan here would run it on every call
   * even when the index answered the question.
   */
  resolvePatientSiblingDeviceKeys?: (() => readonly string[]) | undefined;
}): string[] {
  const { event, queryNearby, deviceIdsForIdentity } = input;
  const position = recruitmentPatientPositionOf(event);
  // Memoised so the fallback branch and the ordering fallback share one
  // enumeration instead of each asking the caller for the collection again.
  let orderedKeysMemo: readonly string[] | undefined;
  const orderedKeys = (): readonly string[] =>
    orderedKeysMemo ??= input.resolveOrderedKeys?.() ?? [];
  const keys: string[] = [];
  const indexed = position
    ? queryNearby?.(position.latitude, position.longitude, event.currentRecruitmentRadiusMeters)
    : input.unlocatedCandidates;
  if (indexed) {
    keys.push(...indexed);
    // This candidate source also serves the patient notification audience.
    keys.push(...event.patientDeviceIds);
    const patientIdentity = `user:${event.patientUserId}`;
    keys.push(...(deviceIdsForIdentity?.(patientIdentity)
      ?? input.resolvePatientSiblingDeviceKeys?.()
      ?? []));
  } else {
    keys.push(...orderedKeys());
  }
  const extra = input.extraDeviceKeys ?? [];
  keys.push(...extra);
  const unique = [...new Set(keys)];
  const compare = input.compareDeviceKeys
    ?? (() => {
      const ordinal = new Map<string, number>();
      for (const [index, key] of orderedKeys().entries()) {
        if (!ordinal.has(key)) ordinal.set(key, index);
      }
      const extraOrdinal = new Map<string, number>();
      for (const [index, key] of extra.entries()) {
        if (!extraOrdinal.has(key)) extraOrdinal.set(key, index);
      }
      return (left: string, right: string): number => {
        const leftKnown = ordinal.has(left);
        const rightKnown = ordinal.has(right);
        if (leftKnown && rightKnown) return ordinal.get(left)! - ordinal.get(right)!;
        if (leftKnown) return -1;
        if (rightKnown) return 1;
        return (extraOrdinal.get(left) ?? Number.MAX_SAFE_INTEGER)
          - (extraOrdinal.get(right) ?? Number.MAX_SAFE_INTEGER);
      };
    })();
  return unique.sort(compare);
}

/**
 * The surviving-assignment rule, in one place.
 *
 * Both the legacy adapter and `service.ts` need it, and they must not drift: the
 * adapter is the seam an indexed implementation replaces, so if the two copies
 * disagreed the differential tests would be comparing the seam against itself.
 * Highest revision wins; the later `updatedAt` breaks ties.
 */
export function survivingAssignmentForDevice(
  state: Readonly<Pick<PersistentState, "assignments">>,
  eventId: string,
  deviceInstanceId: string
): AssignmentRecord | undefined {
  return stateRows(state, "assignments", "eventId", eventId)
    .filter(assignment => assignment.eventId === eventId
      && assignment.deviceInstanceId === deviceInstanceId)
    .sort((left, right) => right.revision - left.revision
      || right.updatedAt.localeCompare(left.updatedAt))[0];
}

/**
 * Adapter over a whole state object: every method does exactly what the code did
 * before the seam existed.  No caching, no narrowing, no behaviour change.
 *
 * The parameter is the narrower `PresenceState` because read-only callers such as
 * `presenceView` legitimately hold only that view, and requiring the full state
 * would force them to widen their access for no reason.  Only the recruitment path
 * invokes the mutation methods, and it always passes a complete draft; the cast
 * below is the single place that relies on it.
 */
function legacyContextMethods(
  state: Readonly<PresenceState>,
  lookup: ((eventId: string) => readonly DeliveryRecord[]) | undefined,
  nearby?: ((event: EventRecord) => readonly string[] | undefined) | undefined,
  changedDeviceKeys: (event: EventRecord) => readonly string[] = () => [],
  ordinal?: ((deviceInstanceId: string) => number | undefined) | undefined
): Omit<RecruitmentContext, "mode"> {
  // Read-only callers (presence, nearby counts, reclamation) never invoke the
  // mutation methods; only the recruitment path does, and it always holds a
  // complete mutable draft.  The cast is confined to this builder.
  const mutable = state as PersistentState;
  return {
    getEvent: eventId => state.events[eventId],
    getDevice: deviceInstanceId => state.devices[deviceInstanceId],
    candidateDevices: (event) => {
      const access = stateAccess(state);
      const position = recruitmentPatientPositionOf(event);
      const grid = access?.store.devicePositions?.();
      const indexed = grid
        ? (position ? grid.query(position.latitude, position.longitude, event.currentRecruitmentRadiusMeters) : [])
        : nearby?.(event);
      if (indexed === undefined) {
        const devices = Object.values(state.devices);
        operationMetrics.deviceCandidatesVisited += devices.length;
        return devices;
      }
      const extras = [...new Set([
        ...changedDeviceKeys(event), ...(access?.overlayKeys("devices") ?? [])
      ])];
      const order = ordinal ?? (access?.store.assignmentIndex
        ? (key: string) => access.store.assignmentIndex!().deviceOrdinal(key) : undefined);
      const keys = candidateDeviceKeys({
        event, queryNearby: () => indexed, unlocatedCandidates: grid ? [] : undefined,
        resolveOrderedKeys: () => Object.keys(state.devices),
        resolvePatientSiblingDeviceKeys: () =>
          stateRows(state, "devices", "userId", event.patientUserId).map(device => device.deviceInstanceId),
        extraDeviceKeys: extras,
        ...(order ? { compareDeviceKeys: compareByOrdinal(order, () => Object.keys(state.devices), extras) } : {})
      });
      return keys.flatMap(key => {
        operationMetrics.deviceCandidatesVisited += 1;
        const device = state.devices[key];
        return device ? [device] : [];
      });
    },
    // With an index this walks only this event's deliveries; without one it falls
    // back to the original whole-collection filter.
    deliveriesOfEvent: eventId => (lookup
      ? [...lookup(eventId)]
      : stateRows(state, "deliveries", "eventId", eventId)),
    getDelivery: deliveryId => mutable.deliveries[deliveryId],
    deliveryForDevice: (eventId, deviceInstanceId) => stateRows(state, "deliveries", "eventId", eventId)
      .find(delivery => delivery.eventId === eventId
        && delivery.deviceInstanceId === deviceInstanceId),
    deliveryForUser: (eventId, userId) => stateRows(state, "deliveries", "eventId", eventId)
      .find(delivery => delivery.eventId === eventId
        && state.devices[delivery.deviceInstanceId]?.userId === userId),
    // Exactly the predicate the inline `.some(...)` used, over the same scan.
    hasActiveAssignmentForDevice: device => {
      const identity = deviceIdentityKey(device);
      const assignments = stateAccess(state) ? (() => {
        const siblings = device.userId ? stateRows(state, "devices", "userId", device.userId) : [device];
        const deviceIds = new Set([device.deviceInstanceId, ...siblings.map(sibling => sibling.deviceInstanceId)]);
        return [...deviceIds].flatMap(id => stateRows(state, "assignments", "deviceInstanceId", id));
      })() : Object.values(state.assignments);
      return assignments.some((assignment) => {
        operationMetrics.assignmentCandidatesVisited += 1;
        if (state.events[assignment.eventId]?.state !== "ACTIVE"
          || assignmentExitsParticipation(assignment.status)) return false;
        const assignedDevice = state.devices[assignment.deviceInstanceId];
        return assignment.deviceInstanceId === device.deviceInstanceId
          || (assignedDevice !== undefined && deviceIdentityKey(assignedDevice) === identity);
      });
    },
    // Exactly the surviving-record rule the inline code used.
    currentAssignmentForDevice: (eventId, deviceInstanceId) =>
      survivingAssignmentForDevice(state, eventId, deviceInstanceId),
    // Exactly the inline identity scan this replaced, including the device lookup
    // that resolves each delivery's holder to an identity key.
    hasAcceptedDeliveryFromIdentity: (eventId, device) => {
      const identity = deviceIdentityKey(device);
      return (stateAccess(state) ? stateRows(state, "deliveries", "eventId", eventId) : Object.values(state.deliveries)).some((delivery) => {
        operationMetrics.deliveryCandidatesVisited += 1;
        if (delivery.eventId !== eventId
          || delivery.decision !== "ACCEPT"
          || delivery.status !== "ACCEPTED") return false;
        const acceptedDevice = state.devices[delivery.deviceInstanceId];
        return acceptedDevice !== undefined
          && deviceIdentityKey(acceptedDevice) === identity;
      });
    },
    // Exactly the inline scan `deviceIsActivePatient` performed.
    isActivePatient: (deviceInstanceId) => {
      const userId = state.devices[deviceInstanceId]?.userId;
      return stateRows(state, "events", "state", "ACTIVE").some(event => event.state === "ACTIVE"
        && (event.patientDeviceIds.includes(deviceInstanceId)
          || (userId !== undefined && event.patientUserId === userId)));
    },
    updateEvent: (eventId, mutate) => {
      const event = mutable.events[eventId];
      if (!event) return undefined;
      mutate(event);
      // The legacy adapter mutates the state object itself, so the current view is
      // always the same object the caller passed in.
      return event;
    },
    createDelivery: delivery => {
      // Insert-only by contract.  The legacy adapter can only assign by key, so a
      // collision is counted instead of being silently absorbed: an id that already
      // exists means a caller is reusing ids, which the transaction adapter would
      // turn into a genuine lost update.
      if (mutable.deliveries[delivery.id] !== undefined) {
        operationMetrics.deliveryCreateCollisions += 1;
      }
      mutable.deliveries[delivery.id] = delivery;
    },
    updateDelivery: (deliveryId, mutate) => {
      const delivery = mutable.deliveries[deliveryId];
      if (!delivery) {
        throw new Error(
          `Recruitment could not update delivery ${deliveryId}: the context has no `
          + "such delivery in its current view. Ignoring this would let a caller "
          + "believe an offer was expired while it stayed live."
        );
      }
      mutate(delivery);
      return delivery;
    },
    insertNotification: (deviceInstanceId, name, payload) => {
      enqueueNotification(mutable, deviceInstanceId, name, payload);
    },
    appendTimeline: (eventId, occurredAt, kind, message) => {
      appendTimeline(mutable, eventId, occurredAt, kind, message);
    }
  };
}

/** Compatibility adapter for plain drafts whose caller declares its changed devices. */
export function indexedDraftRecruitmentContext(
  state: Readonly<PresenceState>,
  nearby: (event: EventRecord) => readonly string[] | undefined,
  changedDeviceKeys: (event: EventRecord) => readonly string[] = () => [],
  ordinal?: ((deviceInstanceId: string) => number | undefined) | undefined
): DraftRecruitmentContext {
  return {
    mode: "draft",
    ...legacyContextMethods(state, undefined, nearby, changedDeviceKeys, ordinal)
  };
}

/**
 * Entity drafts resolve indexed keys through their own local overlay. Plain drafts
 * retain the scan adapter, so an untracked mutation can never read a stale index.
 */
export function draftRecruitmentContext(
  state: Readonly<PresenceState>
): DraftRecruitmentContext {
  return { mode: "draft", ...legacyContextMethods(state, undefined) };
}

/**
 * Committed-semantics context.  The index is required rather than optional: a
 * committed context without one is just the draft adapter under a misleading name.
 */
export function committedRecruitmentContext(
  state: Readonly<PresenceState>,
  options: { deliveriesOfEvent: (eventId: string) => readonly DeliveryRecord[] }
): CommittedRecruitmentContext {
  return { mode: "committed", ...legacyContextMethods(state, options.deliveriesOfEvent) };
}

/** Exposed for adapters and tests that need the raw notification row. */
export type { NotificationRecord };
