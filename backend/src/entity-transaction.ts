/**
 * Controlled entity transaction (Phase 1).
 *
 * The original `transact()` hands the callback the entire mutable state tree, so
 * the store can only discover what changed by cloning the whole tree, validating
 * the whole tree and flattening the whole tree.  `EntityTransaction` inverts
 * that: the callback must read and write through this object, so the store knows
 * exactly which entities changed and can validate, serialize and persist only
 * those.
 *
 * Contract (agreed in review):
 *   - key reads see this transaction's own uncommitted writes, and never expose a
 *     mutable reference into store-owned state;
 *   - updates copy only the entity being changed and automatically record the
 *     before/after pair;
 *   - evidence appends check for an existing identity: identical content is a
 *     no-op, different content is rejected rather than overwritten;
 *   - after sealing, further mutation throws, so nothing can be staged behind the
 *     commit's back;
 *   - a throwing callback discards every staged change and leaves committed state
 *     untouched.
 */

import { isDeepStrictEqual } from "node:util";
import type { StateEntity, EntityCollection, StateReadView } from "./state-read.js";

export interface EntityChange {
  collection: EntityCollection;
  key: string;
  /** Committed value before the change; `undefined` for an append. */
  before: unknown;
  /** Value to commit; `undefined` for a deletion. */
  after: unknown;
  /**
   * Transaction-local sequence in which this entity was FIRST staged.
   *
   * Assigned once, on first staging, and never reassigned: a later update to the
   * same entity must not move it in the publication order.  It exists because
   * `seal()` deliberately returns the change set in canonical (collection, key)
   * order for determinism, while publishing to the in-memory state has to restore
   * the order in which new entities were actually created - the object enumeration
   * order of every string-keyed collection depends on it, and at least one business
   * rule (`deliveryForUser`) is observable through it.
   *
   * Keeping the ordinal on the change is what lets the two orders differ without
   * either of them lying: canonical order stays the change-set contract, mutation
   * order is publication semantics.
   */
  mutationOrdinal: number;
}

export type AppendOutcome = "added" | "unchanged";

function changeId(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}

export class EntityTransaction {
  private readonly pending = new Map<string, EntityChange>();
  private sealed = false;
  /** Monotonic within one transaction; only ever read for entities' first staging. */
  private nextMutationOrdinal = 0;

  constructor(private readonly view: StateReadView) {}

  aeds(): import("./models.js").PersistentState["aeds"] {
    if (!this.view.aeds) throw new Error("Entity view does not expose the AED catalog");
    return this.view.aeds();
  }

  /** Replace a detached entity; the store still enforces all append-only rules. */
  set<C extends EntityCollection>(collection: C, key: string, record: StateEntity<C>): void {
    this.assertOpen();
    const id = changeId(collection, key);
    const staged = this.pending.get(id);
    this.pending.set(id, {
      collection, key,
      before: staged ? staged.before : this.view.get(collection, key),
      after: structuredClone(record),
      mutationOrdinal: staged ? staged.mutationOrdinal : this.nextMutationOrdinal++
    });
  }

  /** Reads see staged writes; the returned value is always detached. */
  get<C extends EntityCollection>(collection: C, key: string): StateEntity<C> | undefined {
    this.assertOpen();
    const staged = this.pending.get(changeId(collection, key));
    if (staged) {
      return staged.after === undefined
        ? undefined
        : structuredClone(staged.after) as StateEntity<C>;
    }
    // StateReadView.get already returns a detached entity.
    return this.view.get(collection, key) as StateEntity<C> | undefined;
  }

  /**
   * Convenience read for callers that already hold a value.
   * Never returns a store-owned reference.
   */
  has(collection: EntityCollection, key: string): boolean {
    this.assertOpen();
    const staged = this.pending.get(changeId(collection, key));
    if (staged) return staged.after !== undefined;
    return this.view.get(collection, key) !== undefined;
  }

  update<C extends EntityCollection>(
    collection: C,
    key: string,
    mutate: (draft: StateEntity<C>) => void
  ): void {
    this.assertOpen();
    const id = changeId(collection, key);
    const staged = this.pending.get(id);
    if (staged) {
      if (staged.after === undefined) {
        throw new Error(`${collection}.${key} was deleted in this transaction`);
      }
      // A failed update must leave earlier staged work intact. Detach again after
      // the callback so a retained draft cannot mutate a future committed record.
      const draft = structuredClone(staged.after) as StateEntity<C>;
      mutate(draft);
      staged.after = structuredClone(draft);
      return;
    }
    const current = this.view.get(collection, key) as StateEntity<C> | undefined;
    if (current === undefined) {
      throw new Error(`${collection}.${key} does not exist`);
    }
    // `current` becomes the immutable "before" snapshot; the draft is a second
    // copy so later mutations cannot alias the recorded prior value.
    const draft = structuredClone(current) as StateEntity<C>;
    mutate(draft);
    this.pending.set(id, { collection, key, before: current, after: structuredClone(draft),
      mutationOrdinal: this.nextMutationOrdinal++ });
  }

  /**
   * Append-only write.  Re-appending identical content is a no-op (idempotent
   * replay); re-appending different content under an existing identity is
   * rejected so evidence can never be overwritten by a later submitter.
   */
  append<C extends EntityCollection>(
    collection: C,
    key: string,
    record: StateEntity<C>
  ): AppendOutcome {
    this.assertOpen();
    const id = changeId(collection, key);
    const staged = this.pending.get(id);
    const existing = staged ? staged.after : this.view.get(collection, key);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, record)) return "unchanged";
      throw new Error(
        `${collection}.${key} already exists with different content; existing evidence is never overwritten`
      );
    }
    if (staged) {
      // Previously deleted in this transaction, then re-appended: the entity keeps
      // the ordinal it was first staged with, so an update cannot reorder it.
      this.pending.set(id, { collection, key, before: staged.before,
        after: structuredClone(record), mutationOrdinal: staged.mutationOrdinal });
      return "added";
    }
    this.pending.set(id, { collection, key, before: undefined,
      after: structuredClone(record), mutationOrdinal: this.nextMutationOrdinal++ });
    return "added";
  }

  remove<C extends EntityCollection>(collection: C, key: string): void {
    this.assertOpen();
    const id = changeId(collection, key);
    const staged = this.pending.get(id);
    const existing = staged ? staged.after : this.view.get(collection, key);
    if (existing === undefined) return; // already absent
    this.pending.set(id, {
      collection,
      key,
      before: staged ? staged.before : existing,
      after: undefined,
      mutationOrdinal: staged ? staged.mutationOrdinal : this.nextMutationOrdinal++
    });
  }

  /**
   * Identities in the collection as this transaction sees them: committed keys,
   * plus staged appends, minus staged deletions.  Costs no cloning, so callers
   * may scan identities freely and `get()` only what they need.
   */
  keys<C extends EntityCollection>(collection: C): string[] {
    this.assertOpen();
    const keys = new Set<string>(this.view.keys(collection));
    for (const change of this.pending.values()) {
      if (change.collection !== collection) continue;
      if (change.after === undefined) keys.delete(change.key);
      else keys.add(change.key);
    }
    return [...keys];
  }

  /**
   * Keys satisfying `predicate`, evaluated against staged-or-committed records
   * without cloning them.  Committed records are passed straight from the read
   * view, so narrowing a large collection costs no clones.
   */
  keysWhere<C extends EntityCollection>(
    collection: C,
    predicate: (item: Readonly<StateEntity<C>>) => boolean,
    limit: number
  ): string[] {
    this.assertOpen();
    // Ask the view for extra headroom: staged deletions/updates can invalidate
    // some of its matches, and staged appends may add new ones.
    const staged = [...this.pending.values()].filter(change => change.collection === collection);
    // Cap so a caller asking for "all" (MAX_SAFE_INTEGER) cannot overflow into
    // an unsafe integer and be rejected by the bounded view.
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("keysWhere requires a positive, bounded limit");
    }
    const requested = Math.min(limit, Number.MAX_SAFE_INTEGER - staged.length) + staged.length;
    const committed = this.view.keysWhere(collection, predicate, requested);
    const selected = new Set<string>();
    for (const key of committed) {
      const change = this.pending.get(changeId(collection, key));
      if (change === undefined) {
        selected.add(key);
        continue;
      }
      // The staged value is authoritative: it may no longer match, or match anew.
      if (change.after !== undefined && predicate(change.after as Readonly<StateEntity<C>>)) {
        selected.add(key);
      }
    }
    for (const change of staged) {
      if (change.after === undefined || selected.has(change.key)) continue;
      if (predicate(change.after as Readonly<StateEntity<C>>)) selected.add(change.key);
    }
    return [...selected].slice(0, limit);
  }

  /**
   * Identities changed by this transaction in one collection.
   *
   * This is what makes a derived index usable *inside* a transaction.  Committed
   * indexes are advanced only after a commit, so on their own they do not contain
   * entities this transaction just wrote — a device whose position was just
   * updated would be missing from a geographic candidate query and would silently
   * never receive an offer.  Callers union the index result with these keys and
   * let the exact predicate filter, which is always a correct superset:
   *
   *   - a staged entity that no longer qualifies remains in the index result and
   *     is rejected by the exact check (over-selection);
   *   - a staged entity that newly qualifies is not in the index result but is
   *     added by this union (no omission).
   *
   * Read-your-writes for indexes therefore needs no per-index logic.
   */
  stagedKeys(collection: EntityCollection): string[] {
    this.assertOpen();
    const keys: string[] = [];
    for (const change of this.pending.values()) {
      if (change.collection === collection) keys.push(change.key);
    }
    return keys;
  }

  pendingChanges(): readonly EntityChange[] {
    this.assertOpen();
    return structuredClone([...this.pending.values()]);
  }

  /** Number of staged changes; useful for assertions in tests. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Seals the transaction and returns the change set in a stable, canonical order.
   *
   * This order is a contract - persistence, snapshots and diagnostics all depend on
   * it - so it deliberately does NOT follow mutation order.  Publication to the
   * in-memory state restores mutation order for newly created entities separately;
   * see `publishChanges`.
   */
  seal(): EntityChange[] {
    this.sealed = true;
    return structuredClone([...this.pending.values()]).sort((left, right) =>
      left.collection.localeCompare(right.collection) || left.key.localeCompare(right.key));
  }

  private assertOpen(): void {
    if (this.sealed) {
      throw new Error("Entity transaction is sealed; no further changes are accepted");
    }
  }
}
