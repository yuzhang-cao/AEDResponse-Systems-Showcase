/**
 * Derived projections over retained state (Phase 1 index work).
 *
 * The standby position path needs to answer "which events are actively recruiting
 * near this position?".  Answering it by visiting every retained event makes the
 * cost grow with history, even though no records are copied.  A projection fixes
 * that: it is a pure function of a single entity, kept up to date incrementally.
 *
 * Cost model:
 *   - full rebuild is O(E) and happens once, lazily, after load or after a
 *     whole-state commit (which is already O(E), so it adds no new class of cost);
 *   - an incremental commit only re-derives the entities in its change set, so
 *     maintenance is O(Δ);
 *   - reads are O(entries) over the *working set*, not over history.
 *
 * Projections are derived data only.  They are never a source of truth: any
 * disagreement is resolved by rebuilding from committed state.
 */

import type { EntityChange } from "./entity-transaction.js";
import type { EntityCollection } from "./state-read.js";
import { DeadlineIndex } from "./deadline-index.js";

export interface StateProjection<T> {
  readonly name: string;
  readonly collection: EntityCollection;
  /** Returns the indexed payload, or `undefined` when the entity is not indexed. */
  derive(entity: unknown): T | undefined;
}

/**
 * A projection that groups entities by a derived key, e.g. "deliveries of one
 * event".  Grouping is what turns `Object.values(state.deliveries)` (every
 * delivery ever retained) into "the deliveries of the event in hand".
 */
export interface GroupedStateProjection<T> {
  readonly name: string;
  readonly collection: EntityCollection;
  groupKey(entity: unknown): string | undefined;
  groupKeys?(entity: unknown): readonly string[];
  derive(entity: unknown): T | undefined;
}

export interface ProjectionReader {
  read<T>(name: string): ReadonlyMap<string, T>;
  readGrouped<T>(name: string): ReadonlyMap<string, ReadonlyMap<string, T>>;
}

export class ProjectionRegistry implements ProjectionReader {
  private readonly definitions = new Map<string, StateProjection<unknown>>();
  private readonly groupedDefinitions = new Map<string, GroupedStateProjection<unknown>>();
  private readonly entries = new Map<string, Map<string, unknown>>();
  private readonly groups = new Map<string, Map<string, Map<string, unknown>>>();
  private readonly stale = new Set<string>();
  private readonly ordinals = new Map<string, Map<string, number>>();
  private readonly nextOrdinal = new Map<string, number>();
  private readonly deadlineDefinitions = new Map<string, StateProjection<number>>();
  private readonly deadlines = new Map<string, DeadlineIndex>();

  registerDeadline(definition: StateProjection<number>): void {
    this.deadlineDefinitions.set(definition.name, definition);
    this.stale.add(definition.name);
    this.readDue(definition.name, Number.NEGATIVE_INFINITY, 0);
  }

  readDue(name: string, at: number, limit: number): { keys: string[]; visited: number } {
    const definition = this.deadlineDefinitions.get(name);
    if (!definition) throw new Error(`Unknown deadline projection ${name}`);
    if (this.stale.has(name)) {
      const source = this.source() as Record<string, Record<string, unknown>> | undefined;
      if (!source) return { keys: [], visited: 0 };
      const index = new DeadlineIndex();
      for (const [key, value] of Object.entries(source[definition.collection] ?? {})) {
        const due = definition.derive(value);
        if (due !== undefined) index.upsert(key, due);
      }
      this.deadlines.set(name, index);
      this.stale.delete(name);
    }
    return this.deadlines.get(name)!.due(at, limit);
  }

  register<T>(definition: StateProjection<T>): void {
    this.definitions.set(definition.name, definition as StateProjection<unknown>);
    // Registration order must not matter: mark for rebuild and let the first read
    // (or the next commit) materialise it from committed state.
    this.stale.add(definition.name);
  }

  registerGrouped<T>(definition: GroupedStateProjection<T>): void {
    this.groupedDefinitions.set(definition.name, definition as GroupedStateProjection<unknown>);
    this.stale.add(definition.name);
  }

  /** Marks every projection stale; used after a whole-state commit. */
  invalidateAll(): void {
    for (const name of this.definitions.keys()) this.stale.add(name);
    for (const name of this.groupedDefinitions.keys()) this.stale.add(name);
    for (const name of this.deadlineDefinitions.keys()) this.stale.add(name);
  }

  /** Used by the explicit whole-state/import path, which already rebuilds indexes. */
  rebuildAll(): void {
    for (const name of this.definitions.keys()) this.read(name);
    for (const name of this.groupedDefinitions.keys()) this.readGrouped(name);
    for (const name of this.deadlineDefinitions.keys()) this.readDue(name, Number.NEGATIVE_INFINITY, 0);
  }

  ordinal(name: string, key: string): number | undefined {
    return this.ordinals.get(name)?.get(key);
  }

  /**
   * Re-derives only the changed entities.  A projection whose collection is not
   * in the change set is untouched, so maintenance cost tracks the change set.
   */
  applyChanges(changes: readonly EntityChange[]): void {
    if (this.definitions.size === 0 && this.groupedDefinitions.size === 0 && this.deadlineDefinitions.size === 0) return;
    const byCollection = new Map<string, EntityChange[]>();
    for (const change of changes) {
      const bucket = byCollection.get(change.collection);
      if (bucket) bucket.push(change);
      else byCollection.set(change.collection, [change]);
    }
    for (const [name, definition] of this.deadlineDefinitions) {
      if (this.stale.has(name)) continue;
      const index = this.deadlines.get(name)!;
      for (const change of [...(byCollection.get(definition.collection) ?? [])].sort((a, b) => a.mutationOrdinal - b.mutationOrdinal)) {
        const due = change.after === undefined ? undefined : definition.derive(change.after);
        if (due === undefined) index.remove(change.key);
        else index.upsert(change.key, due);
      }
    }
    for (const [name, definition] of this.definitions) {
      if (this.stale.has(name)) continue; // will be rebuilt on next read anyway
      const touched = byCollection.get(definition.collection);
      if (!touched?.length) continue;
      const index = this.entries.get(name) ?? new Map<string, unknown>();
      this.entries.set(name, index);
      for (const change of [...touched].sort((a, b) => a.mutationOrdinal - b.mutationOrdinal)) {
        const derived = change.after === undefined ? undefined : definition.derive(change.after);
        if (derived === undefined) index.delete(change.key);
        else index.set(change.key, derived);
      }
    }
    for (const [name, definition] of this.groupedDefinitions) {
      if (this.stale.has(name)) continue;
      const touched = byCollection.get(definition.collection);
      if (!touched?.length) continue;
      const byGroup = this.groups.get(name) ?? new Map<string, Map<string, unknown>>();
      this.groups.set(name, byGroup);
      for (const change of [...touched].sort((a, b) => a.mutationOrdinal - b.mutationOrdinal)) {
        // Remove from whichever group held it, then re-derive into the current one
        // so a changed group key (or a change in eligibility) cannot leave a stale
        // membership behind.
        const groupsOf = (row: unknown): readonly string[] => {
          if (row === undefined) return [];
          if (definition.groupKeys) return definition.groupKeys(row);
          const group = definition.groupKey(row);
          return group === undefined ? [] : [group];
        };
        const previousGroups = groupsOf(change.before);
        const derived = change.after === undefined ? undefined : definition.derive(change.after);
        const nextGroups = new Set(derived === undefined ? [] : groupsOf(change.after));
        for (const group of previousGroups) {
          if (nextGroups.has(group)) continue;
          const previous = byGroup.get(group);
          previous?.delete(change.key);
          if (previous?.size === 0) byGroup.delete(group);
        }
        const order = this.ordinals.get(name)!;
        if (change.after === undefined) { order.delete(change.key); continue; }
        if (!order.has(change.key)) {
          const ordinal = this.nextOrdinal.get(name) ?? 0;
          order.set(change.key, ordinal);
          this.nextOrdinal.set(name, ordinal + 1);
        }
        for (const group of nextGroups) {
          const bucket = byGroup.get(group) ?? new Map<string, unknown>();
          bucket.set(change.key, derived);
          byGroup.set(group, bucket);
        }
      }
    }
  }

  read<T>(name: string): ReadonlyMap<string, T> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown state projection ${name}`);
    if (this.stale.has(name)) this.rebuild(name, definition);
    return (this.entries.get(name) ?? new Map()) as ReadonlyMap<string, T>;
  }

  readGrouped<T>(name: string): ReadonlyMap<string, ReadonlyMap<string, T>> {
    const definition = this.groupedDefinitions.get(name);
    if (!definition) throw new Error(`Unknown grouped state projection ${name}`);
    if (this.stale.has(name)) this.rebuildGrouped(name, definition);
    return (this.groups.get(name) ?? new Map()) as ReadonlyMap<string, ReadonlyMap<string, T>>;
  }

  private rebuildGrouped(name: string, definition: GroupedStateProjection<unknown>): void {
    const source = this.source();
    if (!source) return; // no state available yet; stay stale
    const records = (source as unknown as Record<string, Record<string, unknown>>)[definition.collection];
    const byGroup = new Map<string, Map<string, unknown>>();
    const order = new Map<string, number>();
    if (records && typeof records === "object") {
      for (const [key, value] of Object.entries(records)) {
        order.set(key, order.size);
        const group = definition.groupKey(value);
        const groups = definition.groupKeys?.(value) ?? (group === undefined ? [] : [group]);
        const derived = definition.derive(value);
        if (derived === undefined) continue;
        for (const keyGroup of groups) {
          const bucket = byGroup.get(keyGroup) ?? new Map<string, unknown>();
          bucket.set(key, derived);
          byGroup.set(keyGroup, bucket);
        }
      }
    }
    this.groups.set(name, byGroup);
    this.ordinals.set(name, order);
    this.nextOrdinal.set(name, order.size);
    this.stale.delete(name);
  }

  private rebuild(name: string, definition: StateProjection<unknown>): void {
    const source = this.source();
    if (!source) return; // no state available yet; stay stale
    const records = (source as unknown as Record<string, Record<string, unknown>>)[definition.collection];
    const index = new Map<string, unknown>();
    if (records && typeof records === "object") {
      for (const [key, value] of Object.entries(records)) {
        const derived = definition.derive(value);
        if (derived !== undefined) index.set(key, derived);
      }
    }
    this.entries.set(name, index);
    this.stale.delete(name);
  }

  /** Set by the owning store so rebuilds read committed state directly. */
  private sourceProvider?: () => unknown;

  attachSource(provider: () => unknown): void {
    this.sourceProvider = provider;
  }

  private source(): unknown {
    return this.sourceProvider?.();
  }
}
