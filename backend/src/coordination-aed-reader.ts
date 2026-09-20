import { stateRows } from "./incremental-state.js";
/**
 * The AED-domain reader used by the coordination summary.
 *
 * This is deliberately a THIRD, narrow seam rather than an extension of
 * `RecruitmentContext`.  `RecruitmentContext` is the boundary the recruitment
 * algorithm needs; widening it with AED collections because a summary happens to
 * need one number would turn it into a renamed `PersistentState`, and the boundary
 * that took several rounds to establish would quietly dissolve.
 *
 * The interface is question-shaped, not collection-shaped.  `coordinationSummary`
 * asks exactly one AED-domain question, so that is what this exposes:
 *
 *   - `aeds` is NOT here at all, because nothing in the summary reads it.  The
 *     fixture catalogue is never written at runtime (`Aed[]`, injected through
 *     `emptyState(aeds)`, with no assignment anywhere in the codebase), so it is
 *     effectively immutable and does not need to cross a transaction boundary.
 *   - `aedReceiptsById` IS reachable at runtime (`aed-actions.ts` writes it inside a
 *     transaction), so a transaction-backed implementation must resolve it the same
 *     way as every other index: committed candidates UNION the transaction's staged
 *     keys, then read the entity from the transaction's own view.
 *
 * If a future caller needs the identities rather than the count, widen this by
 * adding that question - not by exposing the collection.
 */
import type { PersistentState } from "./models.js";
import type { EntityTransaction } from "./entity-transaction.js";
import type { StateStore } from "./store.js";
import { operationMetrics } from "./runtime-metrics.js";

export interface CoordinationAedReader {
  /**
   * How many DISTINCT AEDs have a receipt recorded against this event.
   *
   * Distinct, not receipt rows: the same AED can be reported more than once, and the
   * summary counts the device, not the reports.
   */
  acquiredAedCount(eventId: string): number;
}

/** Reader over a whole state object; the pre-refactor behaviour, verbatim. */
export function legacyCoordinationAedReader(
  state: Readonly<PersistentState>
): CoordinationAedReader {
  return {
    acquiredAedCount: eventId => new Set(stateRows(state, "aedReceiptsById", "canonical.eventId", eventId)
      .map(receipt => receipt.canonical)
      .filter(receipt => receipt.eventId === eventId)
      .map(receipt => receipt.aedId)).size
  };
}

/** Committed-index accessors for the transaction-backed reader; all optional. */
export interface TxCoordinationAedIndexes {
  /**
   * Receipt ids recorded against this event, from the committed projection.  Absent
   * means "scan instead", which is correct but grows with unrelated history.
   */
  receiptIdsForEvent?: ((eventId: string) => readonly string[]) | undefined;
  scanLimit?: number | undefined;
}

/**
 * The same question, answered inside a transaction.
 *
 * Follows the frozen rule: the committed projection contributes candidate KEYS, the
 * transaction's own view decides.  A receipt written earlier in this transaction is
 * not in the committed projection yet, so its staged keys are unioned in; a receipt
 * the projection still lists but this transaction removed is dropped when `tx.get`
 * finds nothing.  Every surviving candidate is re-checked against the exact
 * `canonical.eventId` predicate, so a stale index entry can only over-select.
 */
export function txCoordinationAedReader(
  tx: EntityTransaction,
  indexes: TxCoordinationAedIndexes = {}
): CoordinationAedReader {
  const limit = indexes.scanLimit ?? Number.MAX_SAFE_INTEGER;
  return {
    acquiredAedCount: (eventId) => {
      const keys: string[] = [];
      const indexed = indexes.receiptIdsForEvent?.(eventId);
      if (indexed) keys.push(...indexed);
      else {
        keys.push(...tx.keysWhere("aedReceiptsById",
          receipt => receipt.canonical?.eventId === eventId, limit));
      }
      for (const key of tx.stagedKeys("aedReceiptsById")) keys.push(key);

      const seen = new Set<string>();
      const aedIds = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        operationMetrics.aedReceiptCandidatesVisited += 1;
        const receipt = tx.get("aedReceiptsById", key);
        const canonical = receipt?.canonical;
        // Exact predicate: the index is only a candidate source.
        if (!canonical || canonical.eventId !== eventId) continue;
        if (typeof canonical.aedId === "string") aedIds.add(canonical.aedId);
      }
      return aedIds.size;
    }
  };
}

/** Projection name; also the key used by `readGrouped`. */
export const AED_RECEIPTS_BY_EVENT = "aedReceiptsByEventId";

/**
 * Registers the event -> receipt grouped projection.
 *
 * It exists because the acquired-AED question has a real caller that would otherwise
 * scan every receipt ever recorded; it is not built for collection symmetry.  Grouped
 * by the receipt's canonical event, which is the field the reader's exact predicate
 * tests, so a stale entry can only over-select.
 *
 * Lives here rather than in `service.ts` so the definition sits with its only
 * consumer and tests can register the very same one instead of re-declaring it.
 */
export function registerAedReceiptProjection(store: StateStore): void {
  const projections = store.projections?.();
  if (!projections) return;
  projections.registerGrouped<{ canonical: { eventId: string } }>({
    name: AED_RECEIPTS_BY_EVENT,
    collection: "aedReceiptsById",
    groupKey(entity) {
      const eventId = (entity as { canonical?: { eventId?: unknown } })
        .canonical?.eventId;
      return typeof eventId === "string" ? eventId : undefined;
    },
    derive(entity) {
      return entity as { canonical: { eventId: string } };
    }
  });
}

/** Candidate receipt ids for one event, from the committed projection. */
export function receiptIdsForEventFrom(
  store: StateStore
): (eventId: string) => readonly string[] {
  return (eventId) => {
    const group = store.projections?.()
      ?.readGrouped<{ canonical: { eventId: string } }>(AED_RECEIPTS_BY_EVENT)
      ?.get(eventId);
    return group ? [...group.keys()] : [];
  };
}
