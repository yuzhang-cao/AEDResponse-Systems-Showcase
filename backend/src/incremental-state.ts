import { isDeepStrictEqual } from "node:util";
import type { EntityTransaction } from "./entity-transaction.js";
import { emptyState, type PersistentState, type NotificationRecord } from "./models.js";
import type { EntityCollection, StateEntity, StateReadView } from "./state-read.js";
import type { StateStore } from "./store.js";
import { operationMetrics } from "./runtime-metrics.js";
import { nextRetentionDeadline } from "./retention-clock.js";
import type { EventRecord } from "./models.js";

// These are structural lookups. Eligibility is always checked against the draft.
const fields: Partial<Record<EntityCollection, readonly string[]>> = {
  devices: ["userId", "companionPairId"],
  sessionsByTokenHash: ["userId"],
  companionLinkTicketsByHash: ["userId"],
  events: ["state", "patientUserId", "patientDeviceIds", "$hasUnavailableAeds"],
  deliveries: ["eventId", "deviceInstanceId"],
  assignments: ["eventId", "deviceInstanceId", "role"],
  participantIntervalsById: ["eventId", "deviceInstanceId"],
  eventPositionBatchesById: ["eventId", "$recordIds"],
  aedReceiptsById: ["canonical.eventId"],
  presenceUpdateReceiptsById: ["deviceInstanceId"],
  // G11 self-service access is always read per user, and the operator queue is
  // read per status, so both lookups must be indexed rather than scanned.
  selfAccessRequestsById: ["userId", "status"],
  securityLogById: ["event"],
  // G08 signals are always read for one event and one sender's rate window.
  teamSignalsById: ["eventId", "senderDeviceInstanceId"],
  // G07: the responder asks "is there a proposal for MY device in this event?",
  // which must be an indexed lookup rather than a scan of the proposal history.
  rerouteProposalsById: ["eventId", "deviceInstanceId", "status"],
  positionUpdateReceiptsById: ["deviceInstanceId", "eventId"],
  notificationOutboxById: ["status", "eventId"],
  participantExitsById: ["eventId"],
  resolutionsById: ["eventId"],
  aedUnavailableByReportId: ["canonical.eventId"],
  quarantinedLegacyEventPositionBatchesById: ["eventId"],
  aedReceiptIdByBusinessKey: ["$value"],
  aedReceiptIdByEventAed: ["$value"],
  eventEvidenceLogById: ["eventId"],
  aedAssetsById: ["custody.eventId", "$registered"],
  aedAssetActionsById: ["eventId"],
  // G09: every handover lookup a participant or an operator makes is scoped to one
  // event, so the relation index has to exist before those reads stay local.
  aedHandoversById: ["eventId", "aedId", "status"],
  aedTemporaryPointDepositsById: ["eventId", "handoverId", "status"],
  aedTemporaryPointFollowUpsById: ["depositId", "eventId"],
  // G12: the three-year purge deletes media facts by event, so the event relation
  // has to be indexed before that delete stays local.
  aedPhotoReferencesByObjectKey: ["handoverId", "eventId"]
};
const registered = new WeakSet<StateStore>();
export const SECURITY_LOG_DEADLINES = "securityLogDeadlines";
export const NOTIFICATION_DEADLINES = "notificationDeadlines";
export const RETENTION_DEADLINES = "retentionDeadlines";
const fieldValue = (row: unknown, field: string): unknown =>
  field === "$value" ? row : field === "$registered" ? ((row as { registration?: unknown })?.registration ? "yes" : "no")
    : field === "$recordIds" ? (row as { records?: { recordId: string }[] })?.records?.map(record => record.recordId) ?? []
    : field === "$hasUnavailableAeds"
    ? ((row as { unavailableAedIds?: string[] })?.unavailableAedIds?.length ? "yes" : "no")
    : field.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, row);
const matchesField = (row: unknown, field: string, value: string): boolean => {
  const actual = fieldValue(row, field);
  return Array.isArray(actual) ? actual.includes(value) : actual === value;
};
const indexName = (collection: string, field: string) => `entity:${collection}:${field}`;

export function registerStateQueries(store: StateStore): void {
  if (registered.has(store)) return;
  registered.add(store);
  const projections = store.projections?.();
  if (!projections) return;
  projections.registerDeadline({ name: RETENTION_DEADLINES, collection: "events",
    derive: entity => nextRetentionDeadline(entity as EventRecord) });
  projections.registerDeadline({ name: NOTIFICATION_DEADLINES, collection: "notificationOutboxById",
    derive: entity => {
      const row = entity as NotificationRecord;
      return row.status === "PENDING" ? Date.parse(row.nextAttemptAt) : undefined;
    } });
  // G12: the six-month security log is swept by deadline, so the sweep is one
  // indexed query rather than a scan of the whole log on every tick.
  projections.registerDeadline({ name: SECURITY_LOG_DEADLINES, collection: "securityLogById",
    derive: entity => {
      const row = entity as { occurredAt?: string };
      const occurredAt = Date.parse(row.occurredAt ?? "");
      return Number.isFinite(occurredAt) ? occurredAt + 180 * 24 * 60 * 60 * 1_000 : undefined;
    } });
  for (const [collection, names] of Object.entries(fields)) {
    for (const field of names) {
      const name = indexName(collection, field);
      projections.registerGrouped({ name, collection: collection as EntityCollection,
        groupKey: row => {
          const value = fieldValue(row, field);
          return typeof value === "string" ? value : undefined;
        }, groupKeys: row => {
          const value = fieldValue(row, field);
          return typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
        }, derive: () => true });
      // Pay the initial build during service startup, never on the first request.
      projections.readGrouped(name);
    }
  }
}

type Cached = { before: unknown; value: unknown };
type Source = Pick<StateReadView, "get" | "keys"> & { aeds?(): PersistentState["aeds"] };
export interface StateAccess {
  store: StateStore;
  overlayKeys(collection: EntityCollection): string[];
}
const accessByState = new WeakMap<object, StateAccess>();
const accessByTable = new WeakMap<object, { state: PersistentState; collection: EntityCollection }>();
export const stateAccess = (state: object): StateAccess | undefined => accessByState.get(state);

/**
 * A request-local draft over detached entities. Only accessed records are copied;
 * unchanged reads never become writes. Existing domain helpers keep their mutable
 * entity semantics, including references to a just-inserted event. All indexes
 * supply keys and are overlaid with this draft, never committed entity objects.
 */
function entityState(store: StateStore, source: Source) {
  const caches = new Map<EntityCollection, Map<string, Cached>>();
  const insertionOrder = new Map<EntityCollection, Set<string>>();
  const state = { schemaVersion: "2.0" } as PersistentState;
  let catalog: PersistentState["aeds"] | undefined;
  Object.defineProperty(state, "aeds", { enumerable: true, get: () => {
    if (!source.aeds) throw new Error("Entity state requires the AED catalog accessor");
    return catalog ??= source.aeds();
  } });
  for (const collection of Object.keys(emptyState()).filter(key => key !== "aeds" && key !== "schemaVersion") as EntityCollection[]) {
    const cache = new Map<string, Cached>();
    caches.set(collection, cache);
    const get = (key: string): Cached => {
      let entry = cache.get(key);
      if (!entry) {
        const value = source.get(collection, key);
        entry = { before: structuredClone(value), value };
        cache.set(key, entry);
        operationMetrics.stateEntityLoads += 1;
      }
      return entry;
    };
    const table = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_target, key) => typeof key === "string" ? get(key).value : undefined,
      set: (_target, key, value) => {
        if (typeof key !== "string") throw new Error("Entity keys must be strings");
        const entry = get(key);
        if (entry.value === undefined && value !== undefined) {
          const order = insertionOrder.get(collection) ?? new Set<string>();
          order.add(key);
          insertionOrder.set(collection, order);
        }
        entry.value = value;
        return true;
      },
      defineProperty: (_target, key, descriptor) => {
        if (typeof key !== "string" || !Object.hasOwn(descriptor, "value")
          || descriptor.configurable !== true || descriptor.enumerable !== true
          || descriptor.writable !== true) throw new Error("Entity properties must be mutable enumerable records");
        const entry = get(key);
        if (entry.value === undefined && descriptor.value !== undefined) {
          const order = insertionOrder.get(collection) ?? new Set<string>();
          order.add(key);
          insertionOrder.set(collection, order);
        }
        entry.value = descriptor.value;
        return true;
      },
      deleteProperty: (_target, key) => {
        if (typeof key === "string") get(key).value = undefined;
        return true;
      },
      has: (_target, key) => typeof key === "string" && get(key).value !== undefined,
      ownKeys: () => {
        const keys = source.keys(collection);
        operationMetrics.stateFullCollectionKeyVisits += keys.length;
        const seen = new Set(keys);
        for (const key of insertionOrder.get(collection) ?? []) seen.add(key);
        return [...seen].filter(key => !cache.has(key) || cache.get(key)!.value !== undefined);
      },
      getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && get(key).value !== undefined
        ? { enumerable: true, configurable: true } : undefined
    });
    (state as unknown as Record<string, unknown>)[collection] = table;
    accessByTable.set(table, { state, collection });
  }
  // This adapter commits entity changes, never replacement/deletion of a whole
  // collection or schema root. Reject those operations instead of dropping them.
  Object.freeze(state);
  accessByState.set(state, { store, overlayKeys: collection => [...(caches.get(collection)?.keys() ?? [])] });
  return { state, flush(tx: EntityTransaction) {
    for (const [collection, cache] of caches) {
      // New rows follow assignment order, not the order a missing key was read.
      const newKeys = insertionOrder.get(collection) ?? new Set<string>();
      const keys = [...cache.keys()].filter(key => !newKeys.has(key)).concat([...newKeys]);
      for (const key of keys) {
        const entry = cache.get(key)!;
        if (isDeepStrictEqual(entry.before, entry.value)) continue;
        if (entry.value === undefined) tx.remove(collection, key);
        else tx.set(collection, key, entry.value as StateEntity<typeof collection>);
      }
    }
  } };
}

export function readState<T>(store: StateStore, reader: (state: Readonly<PersistentState>) => T): T {
  registerStateQueries(store);
  if (!store.readEntities) return store.read(reader);
  return store.readEntities(view => {
    const result = reader(entityState(store, view).state);
    if (result instanceof Promise) throw new Error("Entity state reads must be synchronous");
    return result;
  });
}

export function transactState<T>(store: StateStore, mutation: (state: PersistentState) => T | Promise<T>): Promise<T> {
  registerStateQueries(store);
  if (!store.transactEntities) return store.transact(mutation);
  return store.transactEntities(async tx => {
    const draft = entityState(store, tx);
    const result = await mutation(draft.state);
    draft.flush(tx);
    return result;
  });
}

/** Indexed relation, plus every locally changed/read record, rechecked in the draft. */
export function stateRows<C extends EntityCollection>(state: object, collection: C, field: string, value: string): StateEntity<C>[] {
  const records = (state as PersistentState)[collection] as Record<string, StateEntity<C>>;
  const access = accessByState.get(state);
  const projections = access?.store.projections?.();
  if (!access || !projections) return Object.values(records).filter(row => matchesField(row, field, value));
  if (!fields[collection]?.includes(field)) throw new Error(`Unregistered relation ${collection}.${field}`);
  const name = indexName(collection, field);
  const committed = projections.readGrouped(name).get(value);
  const keys = new Set([...(committed?.keys() ?? []), ...access.overlayKeys(collection)]);
  const result = [...keys].filter(key => {
    operationMetrics.stateRelationKeyVisits += 1;
    return records[key] !== undefined && matchesField(records[key], field, value);
  });
  result.sort((a, b) => (projections.ordinal(name, a) ?? Number.MAX_SAFE_INTEGER)
    - (projections.ordinal(name, b) ?? Number.MAX_SAFE_INTEGER));
  return result.map(key => records[key]!);
}

export function receiptKeysForDevice(records: object, deviceInstanceId: string): string[] {
  const access = accessByTable.get(records);
  if (!access) return Object.keys(records);
  const rows = stateRows(access.state, access.collection, "deviceInstanceId", deviceInstanceId);
  // Receipt values intentionally do not all carry their map key.
  const selected = new Set(rows);
  return accessByState.get(access.state)!.overlayKeys(access.collection)
    .filter(key => selected.has((records as Record<string, StateEntity<EntityCollection>>)[key]!));
}

/** Map keys for relations whose records do not embed their own map identity. */
export function stateRowKeys<C extends EntityCollection>(state: object, collection: C, field: string, value: string): string[] {
  const records = (state as PersistentState)[collection] as Record<string, StateEntity<C>>;
  const selected = new Set(stateRows(state, collection, field, value));
  const keys = stateAccess(state)?.overlayKeys(collection) ?? Object.keys(records);
  return keys.filter(key => selected.has(records[key]!) && matchesField(records[key], field, value));
}

export function transactionKeys<C extends EntityCollection>(store: StateStore, tx: EntityTransaction,
  collection: C, field: string, value: string): string[] {
  const projection = store.projections?.();
  if (!projection) return tx.keysWhere(collection, row => matchesField(row, field, value), Number.MAX_SAFE_INTEGER);
  const keys = new Set([
    ...(projection.readGrouped(indexName(collection, field)).get(value)?.keys() ?? []),
    ...tx.stagedKeys(collection)
  ]);
  return [...keys].filter(key => {
    operationMetrics.stateRelationKeyVisits += 1;
    const row = tx.get(collection, key);
    return row !== undefined && matchesField(row, field, value);
  });
}
