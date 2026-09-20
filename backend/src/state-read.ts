import type { PersistentState } from "./models.js";
import type { StateStore } from "./store.js";

type EntityCollections = Omit<PersistentState, "schemaVersion" | "aeds">;
export type EntityCollection = keyof EntityCollections;
export type StateEntity<C extends EntityCollection> = EntityCollections[C][string];

/** Backend-only committed snapshot. Each lookup returns a detached entity, not store-owned state. */
export interface StateReadView {
  aeds?(): PersistentState["aeds"];
  select<C extends EntityCollection>(collection: C, predicate: (item: Readonly<StateEntity<C>>) => boolean, limit: number): StateEntity<C>[];
  get<C extends EntityCollection>(collection: C, key: string): Readonly<StateEntity<C>> | undefined;
  /**
   * Keys only, with no cloning.  Lets a caller scan a collection's identities
   * cheaply and then `get()` just the entities it actually needs, instead of
   * materialising every record to filter them.
   */
  keys<C extends EntityCollection>(collection: C): string[];
  /**
   * Keys whose committed record satisfies `predicate`, evaluated against the raw
   * committed record without cloning it.  Callers must treat the argument as
   * read-only.  This is how a caller narrows a collection (e.g. "which events are
   * actively recruiting near here?") without paying a clone per record.
   */
  keysWhere<C extends EntityCollection>(
    collection: C,
    predicate: (item: Readonly<StateEntity<C>>) => boolean,
    limit: number
  ): string[];
}

/** The store replaces its entire committed root on commit, so this captured version stays stable. */
export function createStateReadView(state: Readonly<PersistentState>): StateReadView {
  return Object.freeze({
    aeds: () => structuredClone(state.aeds),
    select<C extends EntityCollection>(collection: C, predicate: (item: Readonly<StateEntity<C>>) => boolean, limit: number): StateEntity<C>[] {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid selection limit");
      const entries = state[collection];
      if (!Object.hasOwn(state, collection) || !entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error("Unsupported entity collection");
      }
      const selected: StateEntity<C>[] = [];
      if (limit === 0) return selected;
      for (const value of Object.values(entries)) {
        const detached = structuredClone(value) as StateEntity<C>;
        if (predicate(detached)) selected.push(detached);
        if (selected.length === limit) break;
      }
      return selected;
    },
    keys<C extends EntityCollection>(collection: C): string[] {
      const entries = state[collection];
      if (!Object.hasOwn(state, collection) || !entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error("Unsupported entity collection");
      }
      return Object.keys(entries);
    },
    keysWhere<C extends EntityCollection>(
      collection: C,
      predicate: (item: Readonly<StateEntity<C>>) => boolean,
      limit: number
    ): string[] {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("keysWhere requires a positive, bounded limit");
      }
      const entries = state[collection];
      if (!Object.hasOwn(state, collection) || !entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error("Unsupported entity collection");
      }
      const selected: string[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (predicate(value as Readonly<StateEntity<C>>)) selected.push(key);
        if (selected.length === limit) break;
      }
      return selected;
    },
    get<C extends EntityCollection>(collection: C, key: string): Readonly<StateEntity<C>> | undefined {
      const entries = state[collection];
      if (!Object.hasOwn(state, collection) || !entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new Error("Unsupported entity collection");
      }
      if (!Object.hasOwn(entries, key)) return undefined;
      return structuredClone(entries[key]) as Readonly<StateEntity<C>>;
    }
  });
}

/** Compatibility only for external stores not yet implementing entity reads; no performance claim for this fallback. */
export function readEntities<T>(store: StateStore, reader: (view: StateReadView) => T): T {
  if (store.readEntities) return store.readEntities(reader);
  return store.read(state => reader(createStateReadView(state)));
}
