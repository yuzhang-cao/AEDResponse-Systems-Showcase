import { readState, transactState, stateRows, stateRowKeys } from "./incremental-state.js";
import { readEntities } from "./state-read.js";
import { purgeDeadline, nextRetentionDeadline } from "./retention-clock.js";
/**
 * The retention promise, made executable.
 *
 * The privacy policy bundled with the app states a concrete lifecycle: an
 * event's full raw evidence lives 30 days in the restricted online layer, moves
 * into the sealed layer from day 31, and at three years the precise trajectory,
 * messages and device associations are deleted, leaving only an irreversible
 * aggregate.  A lawful `legal hold` freezes one event and records the basis.
 *
 * Until this module existed, none of that was executable: `EventRecord` had no
 * retention tier, no job advanced one, and `DeletionRequestRecord` knew only
 * `REQUESTED`.  The policy was a promise the code could not keep.  This is the
 * smallest engine that can keep it, and it is deliberately boring:
 *
 *   - the tier lives on the event, is server-owned, and is validated on load;
 *   - a sweep is a pure decision (`planRetentionSweep`) plus two transactions —
 *     one that records the purge authorisation, one that deletes;
 *   - the append-only evidence guard is NOT weakened: a purge must first persist
 *     `retentionPurgesById`, and the guard then permits deleting exactly that
 *     event's evidence.  If the authorisation is missing, the deletion throws.
 *   - an event under legal hold is skipped, never partially processed;
 *   - a purge whose event has no encrypted cold copy is refused and reported, so
 *     "retention ran" can never be claimed while evidence sits past its window.
 *
 * Nothing here deletes on a hunch.  A terminal event whose terminal time cannot
 * be read is left alone rather than purged early, because the failure mode of a
 * late purge is a retention report, and the failure mode of an early purge is
 * destroyed evidence.
 */
import type { EntityTransaction } from "./entity-transaction.js";
import type { StateStore } from "./store.js";
import type {
  EventRecord,
  EventRetentionRecord,
  LegalHoldRecord,
  PersistentState,
  PurgedEventSummary,
  RetentionPurgeRecord
} from "./models.js";

/** Days an event's raw evidence stays in the restricted online layer. */
export const RETENTION_ONLINE_DAYS = 30;
/** Years after which the precise evidence is deleted. */
export const RETENTION_SEALED_YEARS = 3;

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RetentionThresholds {
  onlineMs: number;
  purgeMs: number;
}

export function retentionThresholds(clockStartedAt: string): RetentionThresholds {
  return {
    onlineMs: RETENTION_ONLINE_DAYS * DAY_MS,
    purgeMs: purgeDeadline(clockStartedAt) - Date.parse(clockStartedAt)
  };
}

/**
 * The time the retention clock runs from for a terminal event.
 *
 * `resolvedAt` is the server-authoritative terminal time.  A terminal event
 * without it is NOT given the benefit of the doubt: `undefined` means "leave it
 * alone", so an inconsistent record cannot be purged early by a guessed clock.
 */
export function retentionClockOf(event: RetentionCandidate): string | undefined {
  if (event.state === "ACTIVE") return undefined;
  return event.retention?.clockStartedAt ?? event.resolvedAt;
}

export function legalHoldIsActive(event: RetentionCandidate): boolean {
  const hold = event.retention?.legalHold;
  return hold !== undefined && hold.releasedAt === undefined;
}

/**
 * The minimum a retention decision needs from an event.
 *
 * Deliberately NOT `EventRecord`: the sweep runs on every scheduler tick, and
 * reading every event to decide "is anything due?" would put a whole-state read
 * back on the hot path that G13-A just removed.  Callers therefore resolve only
 * TERMINAL events, through the same relation index the rest of the service uses.
 */
export interface RetentionCandidate {
  id: string;
  state: string;
  createdAt: string;
  resolvedAt?: string;
  retention?: EventRecord["retention"];
}

/** Collects the events whose retention clock is relevant.  Bounded by history. */
export type RetentionCandidateResolver = () =>
  | readonly RetentionCandidate[]
  | Promise<readonly RetentionCandidate[]>;

export type RetentionAction =
  | { kind: "SEAL"; eventId: string }
  | { kind: "PURGE"; eventId: string };

/**
 * Which events the current time moves to another retention tier.
 *
 * Pure: no clock of its own, no writes, no store.  The caller supplies `now`, so
 * a test can advance years without waiting and production can run it every tick.
 */
export function planRetentionSweep(
  candidates: readonly RetentionCandidate[],
  now: Date
): RetentionAction[] {
  const thresholds = { onlineMs: RETENTION_ONLINE_DAYS * DAY_MS };
  const actions: RetentionAction[] = [];
  for (const event of candidates) {
    if (legalHoldIsActive(event)) continue;
    const clock = retentionClockOf(event);
    if (clock === undefined) continue;
    const startedAt = Date.parse(clock);
    if (!Number.isFinite(startedAt)) continue;
    const age = now.getTime() - startedAt;
    if (age < 0) continue;
    const tier = event.retention?.tier ?? "ONLINE";
    if (tier === "ONLINE") {
      if (age >= thresholds.onlineMs) actions.push({ kind: "SEAL", eventId: event.id });
      continue;
    }
    if (now.getTime() < purgeDeadline(clock)) continue;
    // A SEALED event with no recorded container is a sealing failure, not a
    // purgeable event: write the copy first, and only then delete.  Without this
    // the evidence would sit online forever, which is its own policy breach.
    actions.push(tier === "SEALED" && event.retention?.sealedContainer === undefined
      ? { kind: "SEAL", eventId: event.id }
      : { kind: "PURGE", eventId: event.id });
  }
  return actions;
}

/**
 * The aggregate that survives a purge.
 *
 * Counts and durations only.  No coordinates, no device instance ids, no user
 * ids, no AED ids (an AED id names a cabinet, i.e. a place), no timeline text.
 * Every field here is something that cannot be turned back into a person's
 * movements.
 */
export function eventPurgeSummary(
  state: Readonly<PersistentState>,
  event: EventRecord,
  resolvedAt: string,
  purgedCollectionCount: number
): PurgedEventSummary {
  const deliveries = stateRows(state, "deliveries", "eventId", event.id)
    .filter(delivery => delivery.eventId === event.id);
  const assignments = stateRows(state, "assignments", "eventId", event.id)
    .filter(assignment => assignment.eventId === event.id);
  const batches = stateRows(state, "eventPositionBatchesById", "eventId", event.id)
    .filter(batch => batch.eventId === event.id);
  const receipts = stateRows(state, "aedReceiptsById", "canonical.eventId", event.id)
    .filter(receipt => receipt.canonical?.eventId === event.id);
  const unavailable = stateRows(state, "aedUnavailableByReportId", "canonical.eventId", event.id)
    .filter(report => report.canonical?.eventId === event.id);
  const createdAt = event.createdAt;
  return {
    triggerSource: event.triggerSource,
    ...(event.terminalReason ? { terminalReason: event.terminalReason } : {}),
    createdAt,
    resolvedAt,
    durationSeconds: Math.max(
      0,
      Math.round((Date.parse(resolvedAt) - Date.parse(createdAt)) / 1_000)
    ),
    acceptedResponderCount: deliveries.filter(delivery =>
      delivery.decision === "ACCEPT" && delivery.status === "ACCEPTED").length,
    completedResponderCount: assignments.filter(assignment =>
      assignment.status === "COMPLETED").length,
    aedAcquiredCount: receipts.length,
    aedUnavailableReportCount: unavailable.length,
    positionBatchCount: batches.length,
    positionRecordCount: batches.reduce((total, batch) => total + batch.records.length, 0),
    statusConfirmationCount: (event.statusConfirmationHistory ?? []).length
      + (event.statusConfirmation ? 1 : 0),
    mediaReferenceCount: stateRowKeys(state, "aedPhotoReferencesByObjectKey", "eventId", event.id).length,
    purgedCollectionCount
  };
}

/** Collections a purge empties for one event. */
export const PURGED_COLLECTIONS = [
  "eventPositionBatchesById", "quarantinedLegacyEventPositionBatchesById", "participantIntervalsById",
  "positionUpdateReceiptsById", "timelineByEventId", "deliveries", "assignments", "aedReceiptsById",
  "aedUnavailableByReportId", "notificationOutboxById", "resolutionsById", "participantExitsById", "eventEvidenceLogById", "aedAssetActionsById",
  // G12 media and handover facts.  A photo reference names an object in the
  // private store and carries the participants' device ids; a handover names both
  // people and where the cabinet was left.  Keeping them past three years would
  // leave exactly the precise, person-linked records the policy deletes.
  "aedHandoversById", "aedTemporaryPointDepositsById", "aedTemporaryPointFollowUpsById",
  "aedPhotoReferencesByObjectKey",
  // G08 in-app contact: preset signals are event-scoped collaboration records, and
  // they expire with the event rather than being kept as a message history.
  "teamSignalsById"
] as const;

/**
 * The records a purge would delete for one event, keyed by collection.
 *
 * This is what the cold copy must contain: taking it from the same list the
 * purge deletes means the sealed layer cannot drift from the online layer.  The
 * read is bounded per collection — `timelineByEventId` is keyed by event, the
 * rest are selected through their event relation — so sealing one event never
 * materialises another event's evidence.
 */
export function purgeableEvidenceForEvent(
  store: StateStore,
  eventId: string
): Record<string, Record<string, unknown>> {
  const collectionLimit = 1_000_000;
  return readEntities(store, view => {
    const evidence: Record<string, Record<string, unknown>> = {};
    const timeline = view.get("timelineByEventId", eventId);
    if (timeline) evidence.timelineByEventId = { [eventId]: timeline };
    for (const collection of PURGED_COLLECTIONS) {
      if (collection === "timelineByEventId") continue;
      // One predicate for both relation shapes: AED receipts hang off the event
      // through `canonical.eventId`, everything else through `eventId`.
      const keys = view.keysWhere(
        collection,
        row => (row as { eventId?: string }).eventId === eventId
          || (row as { canonical?: { eventId?: string } }).canonical?.eventId === eventId,
        collectionLimit
      );
      const rows: Record<string, unknown> = {};
      for (const key of keys) {
        const row = view.get(collection, key);
        if (row !== undefined) rows[key] = row;
      }
      if (Object.keys(rows).length > 0) evidence[collection] = rows;
    }
    return evidence;
  });
}

export interface RetentionSweepResult {
  sealed: string[];
  /**
   * Already-SEALED events whose missing cold copy this sweep wrote.
   *
   * Kept separate from `sealed` because the tier did not change: the event was
   * sealed once, the copy write failed, and this sweep repaired it.
   */
  repaired: string[];
  purged: string[];
  /** Purges whose authorisation exists but whose evidence deletion must retry. */
  deferred: string[];
  /**
   * Events whose purge was refused because no encrypted cold copy exists.
   *
   * Separate from `deferred`: nothing failed, and retrying will not help until a
   * container is written.  It is reported so "retention ran" is never claimed
   * while evidence sits online past its window.
   */
  withheldNoColdCopy: string[];
  /**
   * Events whose purge was refused because their media objects could not be
   * deleted.  Distinct from `deferred` (a database failure) and from
   * `withheldNoColdCopy`: the rows are intact and a retry can still succeed.
   */
  withheldMediaDeletion: string[];
}

export interface RetentionSweepHooks {
  /** Clears per-event derived indexes and receipts this purge removed. */
  afterPurge?(eventId: string): void;
  /**
   * Deletes this event's private media objects from the object store.
   *
   * Called BEFORE the reference rows are deleted: the references are the only
   * index of which objects belong to the event, so deleting them first and then
   * failing would leave bytes nobody can find or erase.  Returning `undefined`
   * means the store could not confirm deletion, and the purge is withheld and
   * reported instead of orphaning the objects.
   */
  deleteMediaObjects?(input: {
    eventId: string;
    objectKeys: string[];
  }): Promise<{ deleted: number } | undefined>;
  /**
   * Writes the encrypted cold copy of one event's evidence.
   *
   * Called BEFORE the tier becomes SEALED, so the sealed label always describes a
   * copy that exists.  Returning `undefined` means "no cold copy was written" —
   * the tier still advances (the online layer's 30 days are up either way) but the
   * purge later refuses to delete what has no copy.
   */
  sealEvidence?(input: {
    eventId: string;
    sealedAt: string;
  }): Promise<{ path: string; bytes: number } | undefined>;
}

/**
 * Advance retention for every due event.
 *
 * Two phases per purge, and the order is the point:
 *
 *   1. the authorisation transaction persists `retentionPurgesById` and its summary;
 *   2. a second transaction removes all precise evidence, including the event row.
 *
 * If phase 2 fails, phase 1 is already committed, so the next sweep retries the
 * deletion instead of losing track of it — and the event can never be reported as
 * purged while its evidence is still present.
 */
export async function runRetentionSweep(
  store: StateStore, now: Date, resolveCandidates: RetentionCandidateResolver,
  hooks: RetentionSweepHooks = {}
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = {
    sealed: [], repaired: [], purged: [], deferred: [], withheldNoColdCopy: [],
    withheldMediaDeletion: []
  };
  const actions = planRetentionSweep(await resolveCandidates(), now);
  for (const action of actions) {
    try {
      if (action.kind === "SEAL") {
        const sealedAt = now.toISOString();
        // A repair is the second kind of SEAL action: the event is already past
        // its purge deadline with no cold copy, so this attempts the copy again.
        const repairing = readState(store, state =>
          (state.events[action.eventId]?.retention?.tier ?? "ONLINE") !== "ONLINE");
        // The cold copy is written FIRST: the tier label must never describe a
        // copy that does not exist, because the purge trusts that label.
        const container = hooks.sealEvidence
          ? await hooks.sealEvidence({ eventId: action.eventId, sealedAt })
          : undefined;
        const sealed = await transactState(store, state => {
          const event = state.events[action.eventId];
          if (!event || legalHoldIsActive(event)) return false;
          const tier = event.retention?.tier ?? "ONLINE";
          const needsSeal = tier === "ONLINE"
            || (tier === "SEALED" && event.retention?.sealedContainer === undefined);
          if (!needsSeal || (nextRetentionDeadline(event) ?? Infinity) > now.getTime()) return false;
          // Annotated, not inferred: the record must keep its required clock, and
          // a repair keeps the original sealing time instead of restarting it.
          const previous: EventRetentionRecord = event.retention ?? {
            tier: "ONLINE",
            clockStartedAt: retentionClockOf(event) ?? event.createdAt
          };
          event.retention = {
            ...previous,
            tier: "SEALED",
            sealedAt: previous.sealedAt ?? sealedAt,
            ...(container
              ? { sealedContainer: { path: container.path, bytes: container.bytes, sealedAt } }
              : {})
          };
          return true;
        });
        if (sealed) {
          if (repairing) {
            result.repaired.push(action.eventId);
            // A repair that still could not write the copy leaves the deletion
            // withheld, and says so: the event is past its window and cannot be
            // purged, which is the one state an operator must not have to guess.
            if (!container) result.withheldNoColdCopy.push(action.eventId);
          } else result.sealed.push(action.eventId);
        }
        continue;
      }
      // Deleting the online rows is only safe when a durable cold copy exists, and
      // the check comes BEFORE the authorisation commits: a refused purge must not
      // leave a record that reads as if the evidence had been purged.  A tier
      // label is not a copy, so a SEALED event with no recorded container is
      // withheld and REPORTED rather than silently discarded.
      const hasColdCopy = readState(store, state =>
        state.events[action.eventId]?.retention?.sealedContainer !== undefined);
      if (!hasColdCopy) {
        result.withheldNoColdCopy.push(action.eventId);
        continue;
      }
      // Commit authorization before any destructive change. Leave the event in
      // SEALED until the complete delete succeeds, so failures remain due.
      const authorized = await transactState(store, state => {
        const event = state.events[action.eventId];
        if (!event || legalHoldIsActive(event) || event.state === "ACTIVE") return false;
        const clock = retentionClockOf(event);
        if (!clock || now.getTime() < purgeDeadline(clock)) return false;
        const key = `retention-purge:${event.id}`;
        if (!state.retentionPurgesById[key]) state.retentionPurgesById[key] = {
          purgeId: key, eventId: event.id, authorizedAt: now.toISOString(), reason: "THREE_YEAR_RETENTION_EXPIRED",
          summary: eventPurgeSummary(state, event, event.resolvedAt ?? clock, countPurgeableRecords(state, event.id))
        };
        return true;
      });
      if (!authorized) continue;
      // Media bytes go first, while the reference rows still say which objects
      // belong to this event.  A store that cannot confirm the delete withholds the
      // whole purge, so the retry still knows what to erase.
      if (hooks.deleteMediaObjects) {
        const objectKeys = readEntities(store, view =>
          view.keysWhere("aedPhotoReferencesByObjectKey",
            row => row.eventId === action.eventId, 100_000));
        if (objectKeys.length > 0) {
          const deleted = await hooks.deleteMediaObjects({ eventId: action.eventId, objectKeys });
          if (!deleted || deleted.deleted !== objectKeys.length) {
            result.withheldMediaDeletion.push(action.eventId);
            continue;
          }
        }
      }
      const purged = await transactState(store, state => {
        const event = state.events[action.eventId];
        if (!event || legalHoldIsActive(event) || event.state === "ACTIVE") return false;
        preserveUnavailableAssets(state, event, now.toISOString());
        for (const collection of PURGED_COLLECTIONS) {
          if (collection === "timelineByEventId") { delete state.timelineByEventId[event.id]; continue; }
          const field = collection === "aedReceiptsById" || collection === "aedUnavailableByReportId" ? "canonical.eventId" : "eventId";
          for (const id of stateRowKeys(state, collection, field, event.id)) {
            if (collection === "aedReceiptsById") {
              for (const index of ["aedReceiptIdByBusinessKey", "aedReceiptIdByEventAed"] as const) {
                for (const key of stateRowKeys(state, index, "$value", id)) delete state[index][key];
              }
            }
            delete state[collection][id];
          }
        }
        // The event itself contains P, Watch snapshots and identity links. Keeping
        // it with tier=PURGED would retain precisely the data we promised to erase.
        delete state.eventEvidenceHeadsById[event.id];
        delete state.events[event.id];
        return true;
      });
      if (purged) { hooks.afterPurge?.(action.eventId); result.purged.push(action.eventId); }
    } catch {
      result.deferred.push(action.eventId);
    }
  }
  return result;
}

function preserveUnavailableAssets(state: PersistentState, event: EventRecord, at: string): void {
  const held = new Set(stateRows(state, "aedReceiptsById", "canonical.eventId", event.id).map(row => row.canonical.aedId));
  for (const aedId of new Set([...event.unavailableAedIds, ...held])) {
    const current = state.aedAssetsById[aedId];
    if (!current) state.aedAssetsById[aedId] = { aedId, status: held.has(aedId) ? "AWAITING_RETURN" : "UNAVAILABLE", updatedAt: at, revision: 1 };
    else if (current.custody?.eventId === event.id) {
      // Operational custody survives independently of the expired personal record.
      delete current.custody;
      if (!["AVAILABLE", "RETIRED", "MAINTENANCE", "UNAVAILABLE"].includes(current.status)) current.status = "AWAITING_RETURN";
      current.updatedAt = at; current.revision += 1;
    }
  }
}

function countPurgeableRecords(state: Readonly<PersistentState>, eventId: string): number {
  return PURGED_COLLECTIONS.reduce((count, collection) => count + (collection === "timelineByEventId"
    ? (state.timelineByEventId[eventId] ? 1 : 0)
    : stateRowKeys(state, collection, collection === "aedReceiptsById" || collection === "aedUnavailableByReportId"
      ? "canonical.eventId" : "eventId", eventId).length), 0);
}

/** Places a legal hold, freezing the event against every retention action. */
export function placeLegalHold(
  state: PersistentState,
  eventId: string,
  hold: LegalHoldRecord
): boolean {
  const event = state.events[eventId];
  if (!event) return false;
  const clock = retentionClockOf(event) ?? event.createdAt;
  const retention = event.retention ?? { tier: "ONLINE" as const, clockStartedAt: clock };
  if (retention.tier === "PURGED") return false;
  state.events[eventId] = { ...event, retention: { ...retention, legalHold: hold } };
  return true;
}

/** Releases a legal hold.  The retention clock is NOT rewound: it keeps running. */
export function releaseLegalHold(
  state: PersistentState,
  eventId: string,
  releasedAt: string,
  authority: string,
  reason: string
): boolean {
  const event = state.events[eventId];
  const hold = event?.retention?.legalHold;
  if (!event || !hold || hold.releasedAt !== undefined) return false;
  state.events[eventId] = {
    ...event,
    retention: {
      ...event.retention!,
      legalHold: { ...hold, releasedAt, authority, reason }
    }
  };
  return true;
}

/** Entity keys a purge would delete, for tests and diagnostics. */
export function purgeableEntityKeys(
  tx: EntityTransaction,
  eventId: string
): { collection: string; key: string }[] {
  const keys: { collection: string; key: string }[] = [];
  const collect = (collection: Parameters<EntityTransaction["remove"]>[0]): void => {
    for (const key of tx.keysWhere(collection as never,
      (item: { eventId?: string }) => item.eventId === eventId, Number.MAX_SAFE_INTEGER)) {
      keys.push({ collection, key });
    }
  };
  for (const collection of PURGED_COLLECTIONS) {
    if (collection === "timelineByEventId" || collection === "aedReceiptsById") continue;
    collect(collection as Parameters<EntityTransaction["remove"]>[0]);
  }
  return keys;
}
