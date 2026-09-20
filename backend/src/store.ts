import { aedAssetActionRecordSchema } from "./aed-assets.js";
import { EvidenceSigner, captureTransactionEvidence, captureDraftEvidence, evidenceLogSchema, evidenceHeadSchema, evidenceProofSchema } from "./evidence-integrity.js";
import { createStateReadView, type StateReadView } from "./state-read.js";
import { storageMetrics, isInstrumentationEnabled, type FullStateCloneReason } from "./runtime-metrics.js";
import { EntityTransaction, type EntityChange } from "./entity-transaction.js";
import { ProjectionRegistry } from "./state-projections.js";
import { PositionExpiryIndex } from "./position-expiry-index.js";
import { DevicePositionIndex } from "./device-position-index.js";
import { AssignmentIndex } from "./assignment-index.js";
import { DeliveryIndex } from "./delivery-index.js";
import { notificationRecordSchema } from "./notification-outbox.js";
import { fingerprint } from "./domain.js";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { simulationObservationSchema } from "./simulation.js";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import {
  aedSchema,
  isoDateSchema,
  patientPositionSchema,
  responseRequestSchema,
  responderPositionSchema,
  utcSecondSchema,
  watchEmergencyObservationSchema,
  userReportedPatientObservationSchema,
  watchFallbackPositionUpdateSchema,
  watchTriggerSourceSchema,
  type Aed
} from "./contracts.js";
import { emptyState, type PersistentState } from "./models.js";
import { aedAssetSchema } from "./aed-asset-model.js";

export interface StateStore {
  read<T>(reader: (state: Readonly<PersistentState>) => T): T;
  readEntities?<T>(reader: (view: StateReadView) => T): T;
  transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T>;
  /**
   * Controlled entity transaction.  Only the entities the callback actually
   * changed are validated, serialized and persisted; an empty change set
   * performs no SQLite write at all.
   */
  transactEntities?<T>(mutation: (tx: EntityTransaction) => T | Promise<T>): Promise<T>;
  /** Derived, incrementally maintained indexes over committed state. */
  projections?(): ProjectionRegistry;
  /** Expiry index for standby positions; sweeps visit only due devices. */
  positionExpiry?(): PositionExpiryIndex;
  /** Geographic pre-filter over device positions for radius queries. */
  devicePositions?(): DevicePositionIndex;
  /** Structural assignment<->device / device<->identity index. */
  assignmentIndex?(): AssignmentIndex;
  /** Composite (event, device) and (event, user) delivery lookups. */
  deliveryIndex?(): DeliveryIndex;
  configureEvidence?(signer: EvidenceSigner, now: () => Date): void;
  close?(): void | Promise<void>;
}

export interface StorageCostSnapshot {
  entityCount: number;
  payloadBytes: number;
  collectionCounts: Record<string, number>;
  timelineEntryCount: number;
  eventPositionRecordCount: number;
  pendingNotificationCount: number;
}

/**
 * Reports the retained-state cost without cloning or mutating authoritative
 * state.  It is intentionally a measurement boundary, not a claim that the
 * in-process state model has become a horizontally scalable database.
 */
export function measureStorageCost(
  state: Readonly<PersistentState>
): StorageCostSnapshot {
  const collectionCounts: Record<string, number> = {};
  let entityCount = 0;
  let payloadBytes = 0;
  for (const [collection, values] of Object.entries(state)) {
    if (collection === "schemaVersion" || collection === "aeds") continue;
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    const records = values as Record<string, unknown>;
    const count = Object.keys(records).length;
    collectionCounts[collection] = count;
    entityCount += count;
    for (const value of Object.values(records)) {
      payloadBytes += Buffer.byteLength(JSON.stringify(value));
    }
  }
  collectionCounts.aeds = state.aeds.length;
  entityCount += state.aeds.length;
  for (const aed of state.aeds) payloadBytes += Buffer.byteLength(JSON.stringify(aed));
  return {
    entityCount,
    payloadBytes,
    collectionCounts,
    timelineEntryCount: Object.values(state.timelineByEventId)
      .reduce((total, entries) => total + entries.length, 0),
    eventPositionRecordCount: Object.values(state.eventPositionBatchesById)
      .reduce((total, batch) => total + batch.records.length, 0),
    pendingNotificationCount: Object.values(state.notificationOutboxById)
      .filter((record) => record.status === "PENDING").length
  };
}

function cloneState(
  state: PersistentState,
  reason: FullStateCloneReason = "other"
): PersistentState {
  // Counted, not walked: an entity count here would need its own full pass over
  // the state and would perturb the cost this counter exists to measure.
  // Classified by call site so that "fullStateClones = 0" cannot be satisfied by
  // renaming this helper while a raw structuredClone(wholeState) still runs.
  storageMetrics.fullStateClones[reason] += 1;
  return structuredClone(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, context: string): void {
  if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
}

/**
 * Per-entity write rules: the single source of truth for evidence immutability.
 *
 * `assertAppendOnlyHistory()` (the whole-state comparison used by the original
 * `transact()` path) delegates here, and the incremental transaction path calls
 * this for exactly the entities it changed.  Keeping one implementation means the
 * two paths cannot drift apart.
 *
 * `before === undefined` is an append; `after === undefined` is a deletion.
 * Collections without a rule are simply not switch cases.
 */
export type GuardedCollection =
  | "positionUpdateReceiptsById"
  | "notificationOutboxById"
  | "deletionRequestsById"
  | "events"
  | "eventPositionBatchesById"
  | "quarantinedLegacyEventPositionBatchesById"
  | "participantIntervalsById"
  | "retentionPurgesById"
  | "timelineByEventId"
  | "eventEvidenceLogById"
  | "eventEvidenceHeadsById"
  | "aedAssetActionsById"
  | "positionWindowReconciliationsById"
  | "accessAuditById"
  | "breakGlassGrantsById"
  | "positionWindowReconciliationsById";

/**
 * Events whose evidence a retention purge is authorised to delete.
 *
 * The purge writes `retentionPurgesById` first, in its own committed transaction,
 * so by the time the deleting transaction runs the authorisation is already
 * durable.  A caller that supplies no set gets the strict append-only rules,
 * which is what keeps this from becoming a general deletion hole.
 */
export type PurgeAuthorisedEventIds = Pick<ReadonlySet<string>, "has">;

export function assertEntityWriteAllowed(
  collection: GuardedCollection,
  key: string,
  before: unknown,
  after: unknown,
  purgeAuthorisedEventIds?: PurgeAuthorisedEventIds
): void {
  const b = before as Record<string, unknown> | undefined;
  const a = after as Record<string, unknown> | undefined;
  switch (collection) {
    case "positionUpdateReceiptsById": {
      // Only receipts carrying a protected Watch fallback fact have a rule.
      if (!b?.watchFallbackFact) return;
      if (after === undefined && isPurgeAuthorised(b.eventId, purgeAuthorisedEventIds)) return;
      if (!a || !isDeepStrictEqual(b.watchFallbackFact, a.watchFallbackFact)
        || b.deviceInstanceId !== a.deviceInstanceId || b.eventId !== a.eventId
        || b.fingerprint !== a.fingerprint || b.recordedAt !== a.recordedAt) {
        throw new Error(`Watch fallback fact ${key} is immutable and cannot be deleted`);
      }
      return;
    }
    case "notificationOutboxById": {
      if (!b) return;
      if (!a && isPurgeAuthorised(b.eventId, purgeAuthorisedEventIds)) return;
      if (!a) throw new Error(`notificationOutboxById.${key} cannot be deleted`);
      const oldBody = { ...b };
      const body = { ...a };
      // Mutable progress fields.  `push` is here because a push attempt is
      // transport progress on an immutable message, exactly like `attempts`; the
      // message body itself stays frozen by the comparison below.
      for (const field of ["status", "attempts", "nextAttemptAt", "completedAt", "push"]) {
        delete oldBody[field];
        delete body[field];
      }
      if (!isDeepStrictEqual(body, oldBody)) {
        throw new Error(`notificationOutboxById.${key} message is immutable`);
      }
      if (b.status !== "PENDING" && !isDeepStrictEqual(b, a)) {
        throw new Error(`notificationOutboxById.${key} is immutable after completion`);
      }
      const oldAttempts = Number(b.attempts);
      const attempts = Number(a.attempts);
      if (!Number.isFinite(attempts) || attempts < oldAttempts || attempts > oldAttempts + 1) {
        throw new Error(`notificationOutboxById.${key} attempt count is invalid`);
      }
      return;
    }
    case "eventEvidenceHeadsById": {
      if (!b) return;
      if (!a && isPurgeAuthorised(b.eventId, purgeAuthorisedEventIds)) return;
      if (isDeepStrictEqual(a, b)) return;
      if (!a || a.sequence !== Number(b.sequence) + 1 || a.previousHash !== b.hash) {
        throw new Error(`eventEvidenceHeadsById.${key} cannot rewind or disappear`);
      }
      return;
    }
    case "aedAssetActionsById":
    case "eventEvidenceLogById": {
      if (!b) return;
      if (!a && isPurgeAuthorised(b.eventId, purgeAuthorisedEventIds)) return;
      if (!a || !isDeepStrictEqual(a, b)) throw new Error(`eventEvidenceLogById.${key} is immutable`);
      return;
    }
    case "retentionPurgesById":
    case "accessAuditById": {
      // Append-only, and immutable once written.  An audit trail that can be
      // edited answers no question a reviewer would ask.
      if (!b) return;
      if (!a || !isDeepStrictEqual(b, a)) {
        throw new Error(`accessAuditById.${key} is append-only and immutable`);
      }
      return;
    }
    case "breakGlassGrantsById": {
      if (!b) return;
      if (!a) throw new Error(`breakGlassGrantsById.${key} cannot be deleted`);
      // A grant may only be marked used; its scope, subject and window are fixed,
      // so a grant cannot be widened or silently extended after issue.
      const oldBody = { ...b };
      const body = { ...a };
      delete oldBody.usedAt;
      delete body.usedAt;
      if (!isDeepStrictEqual(body, oldBody)) {
        throw new Error(`breakGlassGrantsById.${key} is immutable after issue`);
      }
      if (b.usedAt !== undefined && !isDeepStrictEqual(b, a)) {
        throw new Error(`breakGlassGrantsById.${key} is immutable after use`);
      }
      return;
    }
    case "deletionRequestsById": {
      // Minimal audit: it may be added and read, never rewritten or removed, so a
      // later transaction cannot hide that erasure was requested for an identity.
      if (!b) return;
      if (!a || !isDeepStrictEqual(b, a)) {
        throw new Error(`deletionRequestsById.${key} is immutable`);
      }
      return;
    }
    case "timelineByEventId": {
      if (before === undefined) return;
      if (after === undefined && isPurgeAuthorised(key, purgeAuthorisedEventIds)) return;
      if (!Array.isArray(before) || !Array.isArray(after) || after.length < before.length
        || !isDeepStrictEqual(before, after.slice(0, before.length))) throw new Error(`timelineByEventId.${key} is append-only`);
      return;
    }
    case "events": {
      if (b && !a && isPurgeAuthorised(key, purgeAuthorisedEventIds)) return;
      if (b?.triggerSource !== "SIMULATED_TEST") return;
      if (!a || a.triggerSource !== "SIMULATED_TEST"
        || !isDeepStrictEqual(a.observation, b.observation)
        || !isDeepStrictEqual(a.patientDeviceIds, b.patientDeviceIds)
        || a.patientUserId !== b.patientUserId) {
        throw new Error("Simulation evidence and its scope are immutable");
      }
      return;
    }
    case "eventPositionBatchesById":
    case "quarantinedLegacyEventPositionBatchesById": {
      if (!b) return;
      // Retention purge of a specifically authorised event: the deletion itself
      // is the promise being kept, and `retentionPurgesById` records it forever.
      if (after === undefined && isPurgeAuthorised(b.eventId, purgeAuthorisedEventIds)) return;
      if (!a) throw new Error(`${collection}.${key} is append-only and cannot be deleted`);
      if (!isDeepStrictEqual(a, b)) {
        throw new Error(`${collection}.${key} is append-only and cannot be modified`);
      }
      return;
    }
    case "positionWindowReconciliationsById": {
      if (!b) return;
      if (!a) {
        throw new Error(`positionWindowReconciliationsById.${key} is an audit verdict and cannot be deleted`);
      }
      const before = b as { receivedRecordCount?: unknown; receivedSlotCount?: unknown };
      const after = a as { receivedRecordCount?: unknown; receivedSlotCount?: unknown };
      // A verdict may be recomputed and may gain facts, never lose them: a late
      // fact replacing a gap increases the received count, and nothing may make
      // it go back down without the evidence itself having been deleted.
      if (Number(after.receivedRecordCount) < Number(before.receivedRecordCount)
        || Number(after.receivedSlotCount) < Number(before.receivedSlotCount)) {
        throw new Error(
          `positionWindowReconciliationsById.${key} cannot un-receive recorded position facts`
        );
      }
      return;
    }
    case "participantIntervalsById": {
      if (!b) return;
      if (!a && isPurgeAuthorised(b.eventId, purgeAuthorisedEventIds)) return;
      if (!a) throw new Error(`participantIntervalsById.${key} cannot be deleted`);
      if (b.endedAt !== undefined) {
        if (!isDeepStrictEqual(a, b)) {
          throw new Error(`participantIntervalsById.${key} is immutable after it ends`);
        }
        return;
      }
      if (a.endedAt === undefined) {
        if (!isDeepStrictEqual(a, b)) {
          throw new Error(`participantIntervalsById.${key} is immutable while open`);
        }
        return;
      }
      const expected = { ...b, endedAt: a.endedAt, endReason: a.endReason };
      if (!isDeepStrictEqual(a, expected)) {
        throw new Error(`participantIntervalsById.${key} may only be ended once`);
      }
      return;
    }
  }
}


/** Whether one event id appears in the set a committed purge authorisation covers. */
function isPurgeAuthorised(
  eventId: unknown,
  purgeAuthorisedEventIds: PurgeAuthorisedEventIds | undefined
): boolean {
  return typeof eventId === "string"
    && purgeAuthorisedEventIds !== undefined
    && purgeAuthorisedEventIds.has(eventId);
}


/**
 * Event ids a committed retention purge authorisation covers.
 *
 * Tolerates a state file written before this collection existed: those states
 * simply have no authorisations, which is the strict-by-default answer.
 */
function authorisedPurgeEventIds(state: Readonly<PersistentState>): PurgeAuthorisedEventIds {
  return { has(eventId) {
    const purge = state.retentionPurgesById?.[`retention-purge:${eventId}`];
    const event = state.events[eventId];
    const hold = event?.retention?.legalHold;
    return purge?.eventId === eventId && event?.state !== "ACTIVE" && !(hold && hold.releasedAt === undefined);
  } };
}


function assertAppendOnlyHistory(previous: PersistentState, next: PersistentState): void {
  storageMetrics.historyCompareCalls += 1;
  // Authorisations are read from COMMITTED state, which is what forces the purge
  // to persist its authorisation before it deletes anything.
  const purgeAuthorised = authorisedPurgeEventIds(previous);
  for (const [id, before] of Object.entries(previous.retentionPurgesById ?? {})) {
    assertEntityWriteAllowed("retentionPurgesById", id, before, next.retentionPurgesById?.[id]);
  }
  for (const [id, before] of Object.entries(previous.aedAssetActionsById ?? {})) {
    assertEntityWriteAllowed("aedAssetActionsById", id, before, next.aedAssetActionsById[id], purgeAuthorised);
  }
  for (const [id, before] of Object.entries(previous.eventEvidenceHeadsById ?? {})) {
    assertEntityWriteAllowed("eventEvidenceHeadsById", id, before, next.eventEvidenceHeadsById[id], purgeAuthorised);
  }
  for (const [id, before] of Object.entries(previous.eventEvidenceLogById ?? {})) {
    assertEntityWriteAllowed("eventEvidenceLogById", id, before, next.eventEvidenceLogById[id], purgeAuthorised);
  }
  for (const [id, before] of Object.entries(previous.timelineByEventId)) {
    assertEntityWriteAllowed("timelineByEventId", id, before, next.timelineByEventId[id], purgeAuthorised);
  }
  for (const [id, before] of Object.entries(previous.positionUpdateReceiptsById)) {
    storageMetrics.historyComparedEntities += 1;
    if (!before.watchFallbackFact) continue;
    assertEntityWriteAllowed("positionUpdateReceiptsById", id, before,
      next.positionUpdateReceiptsById[id], purgeAuthorised);
  }
  for (const [id, before] of Object.entries(previous.notificationOutboxById)) {
    storageMetrics.historyComparedEntities += 1;
    assertEntityWriteAllowed("notificationOutboxById", id, before, next.notificationOutboxById[id], purgeAuthorised);
  }
  for (const [id, before] of Object.entries(previous.deletionRequestsById)) {
    storageMetrics.historyComparedEntities += 1;
    assertEntityWriteAllowed("deletionRequestsById", id, before, next.deletionRequestsById[id]);
  }
  for (const [id, before] of Object.entries(previous.positionWindowReconciliationsById ?? {})) {
    storageMetrics.historyComparedEntities += 1;
    assertEntityWriteAllowed("positionWindowReconciliationsById", id, before,
      next.positionWindowReconciliationsById?.[id]);
  }
  for (const [id, before] of Object.entries(previous.events)) {
    if (before.triggerSource !== "SIMULATED_TEST") continue;
    assertEntityWriteAllowed("events", id, before, next.events[id], purgeAuthorised);
  }
  for (const collection of [
    "eventPositionBatchesById",
    "quarantinedLegacyEventPositionBatchesById"
  ] as const) {
    const before = previous[collection] as Record<string, unknown>;
    const after = next[collection] as Record<string, unknown>;
    for (const [key, value] of Object.entries(before)) {
      storageMetrics.historyComparedEntities += 1;
      assertEntityWriteAllowed(collection, key, value, after[key], purgeAuthorised);
    }
  }
  const beforeIntervals = previous.participantIntervalsById;
  const afterIntervals = next.participantIntervalsById;
  for (const [key, before] of Object.entries(beforeIntervals)) {
    storageMetrics.historyComparedEntities += 1;
    assertEntityWriteAllowed("participantIntervalsById", key, before, afterIntervals[key], purgeAuthorised);
  }
}


function validateCurrentPatientPosition(value: unknown, context: string): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  for (const key of ["positionUpdateId", "source", "observedAt", "serverReceivedAt"]) {
    requireString(value, key, context);
  }
  if (!["WATCH_TRIGGER_SNAPSHOT", "IPHONE_PRIMARY", "WATCH_FALLBACK"].includes(
    String(value.source)
  )) {
    throw new Error(`${context}.source is unsupported`);
  }
  patientPositionSchema.parse(value.position);
}

function validateStatusConfirmationRecord(value: unknown, context: string): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  for (const key of [
    "confirmationId",
    "cycleStartedAt",
    "sentAt",
    "responseDeadlineAt",
    "state"
  ]) requireString(value, key, context);
  if (!["PENDING", "CONTINUED", "CLOSED_UNCONFIRMED_NO_RESPONSE", "ENDED_BY_EVENT"].includes(
    String(value.state)
  )) {
    throw new Error(`${context}.state is unsupported`);
  }
  for (const key of ["respondedAt", "responseFingerprint", "closedAt"]) {
    if (value[key] !== undefined) requireString(value, key, context);
  }
}

function validateRecordValues(
  value: unknown,
  context: string,
  validator: (record: Record<string, unknown>, itemContext: string) => void
): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    storageMetrics.validatedEntities += 1;
    if (!isRecord(item)) throw new Error(`${context}.${key} must be an object`);
    validator(item, `${context}.${key}`);
  }
}

function quarantineLegacyBatch(
  quarantine: Record<string, unknown>,
  batchId: string,
  rawBatch: unknown
): void {
  const unsafePrototypeKey = batchId === "__proto__"
    || batchId === "constructor"
    || batchId === "prototype";
  let key = unsafePrototypeKey ? `legacy:${batchId}` : batchId;
  let suffix = 1;
  while (Object.prototype.hasOwnProperty.call(quarantine, key)) {
    // A repeated normalization should be a no-op. If a corrupt state already
    // contains a different value under the same ID, preserve both values.
    if (JSON.stringify(quarantine[key]) === JSON.stringify(rawBatch)) return;
    key = `${batchId}#${suffix}`;
    suffix += 1;
  }
  quarantine[key] = structuredClone(rawBatch);
}

function normalizeState(value: unknown): unknown {
  if (!isRecord(value)) return value;
  storageMetrics.fullStateClones.normalization += 1;
  const normalized = structuredClone(value) as Record<string, unknown>;
  for (const key of Object.keys(emptyState())) {
    if (key !== "schemaVersion" && key !== "aeds" && normalized[key] === undefined) normalized[key] = {};
  }
  // Signed records are immutable inputs. Legacy repair must never silently
  // rewrite them on reopen; migrations of signed data need a new signed fact.
  const signedEvent = (id: unknown): boolean => typeof id === "string"
    && isRecord(normalized.eventEvidenceHeadsById) && Object.hasOwn(normalized.eventEvidenceHeadsById, id);
  delete normalized.watchReachabilityReceiptsById;
  for (const key of [
    "users",
    "accounts",
    "accountIdByProviderKey",
    "authChallengesById",
    "appleRevocationsById",
    "rerouteProposalsById",
    "companionLinkTicketsByHash",
    "participantExitsById",
    "participantIntervalsById"
  ]) {
    if (!isRecord(normalized[key])) normalized[key] = {};
  }
  for (const key of [
    "eventPositionBatchesById",
    "quarantinedLegacyEventPositionBatchesById",
    "notificationOutboxById",
    "positionUpdateReceiptsById"
  ]) {
    if (normalized[key] === undefined) normalized[key] = {};
    else if (!isRecord(normalized[key])) {
      throw new Error(`state.${key} must be an object; refusing to discard evidence`);
    }
  }
  for (const key of [
    "presenceUpdateReceiptsById",
    "deletionRequestsById"
  ]) {
    if (!isRecord(normalized[key])) normalized[key] = {};
  }
  if (isRecord(normalized.eventPositionBatchesById)) {
    const quarantine = normalized.quarantinedLegacyEventPositionBatchesById as Record<string, unknown>;
    for (const [batchId, rawBatch] of Object.entries(normalized.eventPositionBatchesById)) {
      if (isRecord(rawBatch) && signedEvent(rawBatch.eventId)) continue;
      if (!isRecord(rawBatch) || !Array.isArray(rawBatch.records) || rawBatch.records.length === 0) {
        quarantineLegacyBatch(quarantine, batchId, rawBatch);
        delete normalized.eventPositionBatchesById[batchId];
        continue;
      }
      storageMetrics.batchLevelClones += 1;
      const rawBatchForQuarantine = structuredClone(rawBatch);
      // Legacy batches used observedAt and did not carry a slot or gap
      // reason. They cannot be assigned a truthful second slot, so isolate
      // the raw batch rather than guessing or deleting its event evidence.
      const batchDevice = isRecord(normalized.devices)
        && typeof rawBatch.deviceInstanceId === "string"
        ? normalized.devices[rawBatch.deviceInstanceId]
        : undefined;
      const inferredUserId = isRecord(batchDevice) && typeof batchDevice.userId === "string"
        ? batchDevice.userId
        : undefined;
      if (rawBatch.userId === undefined && inferredUserId !== undefined) {
        rawBatch.userId = inferredUserId;
      }
      if (typeof rawBatch.userId === "string") {
        for (const rawRecord of rawBatch.records) {
          if (isRecord(rawRecord) && rawRecord.userId === undefined) {
            rawRecord.userId = rawBatch.userId;
          }
        }
      }
      const isLegacyBatch = rawBatch.records.some((rawRecord) =>
        !isRecord(rawRecord)
        || rawRecord.observedAt !== undefined
        || typeof rawRecord.slotAt !== "string"
        || typeof rawBatch.userId !== "string"
        || (rawRecord.userId !== undefined && rawRecord.userId !== rawBatch.userId)
      ) || (inferredUserId !== undefined && rawBatch.userId !== inferredUserId);
      if (isLegacyBatch) {
        quarantineLegacyBatch(quarantine, batchId, rawBatchForQuarantine);
        delete normalized.eventPositionBatchesById[batchId];
      } else {
        for (const rawRecord of rawBatch.records) {
          if (!isRecord(rawRecord)) continue;
          const parsedSlot = utcSecondSchema.safeParse(rawRecord.slotAt);
          if (parsedSlot.success) rawRecord.slotAt = parsedSlot.data;
          if (rawRecord.status === "FIX" && typeof rawRecord.fixObservedAt === "string") {
            const parsedFix = isoDateSchema.safeParse(rawRecord.fixObservedAt);
            if (parsedFix.success) rawRecord.fixObservedAt = parsedFix.data;
          }
        }
      }
    }
  }
  if (isRecord(normalized.devices)) {
    for (const [deviceId, rawDevice] of Object.entries(normalized.devices)) {
      if (!isRecord(rawDevice)) continue;
      const bootstrapAt = typeof rawDevice.lastBootstrapAt === "string"
        ? rawDevice.lastBootstrapAt
        : new Date(0).toISOString();
      if (!isRecord(rawDevice.capabilities)) {
        rawDevice.capabilities = {
          notificationAuthorized: false,
          locationAuthorized: false
        };
      }
      if (typeof rawDevice.availableForResponse !== "boolean") {
        rawDevice.availableForResponse = false;
      }
      if (typeof rawDevice.presenceObservedAt !== "string") {
        rawDevice.presenceObservedAt = bootstrapAt;
      }
      if (typeof rawDevice.lastSeenAt !== "string") rawDevice.lastSeenAt = bootstrapAt;
      if (!isRecord(rawDevice.latestPosition) && isRecord(rawDevice.responderPosition)) {
        const legacyPosition = rawDevice.responderPosition;
        if (isRecord(legacyPosition.position) && typeof legacyPosition.observedAt === "string") {
          rawDevice.latestPosition = {
            positionUpdateId: deviceId,
            position: legacyPosition.position,
            observedAt: legacyPosition.observedAt,
            serverReceivedAt: bootstrapAt
          };
        }
      }
      delete rawDevice.responderPosition;
    }
  }
  if (isRecord(normalized.events)) {
    for (const [eventId, rawEvent] of Object.entries(normalized.events)) {
      if (!isRecord(rawEvent) || signedEvent(eventId)) continue;
      if (!Number.isInteger(rawEvent.coordinationRevision)) rawEvent.coordinationRevision = 1;
      if (!Number.isFinite(rawEvent.currentRecruitmentRadiusMeters)) {
        rawEvent.currentRecruitmentRadiusMeters = 1_000;
      }
      // A newly created event intentionally stores null until its first valid
      // patient P. Only a legacy row with the field absent gets a derived
      // timestamp; do not turn that explicit null into a running stage clock
      // during every SQLite/JSON reopen.
      if (rawEvent.recruitmentStageStartedAt === undefined) {
        rawEvent.recruitmentStageStartedAt = typeof rawEvent.createdAt === "string"
          ? rawEvent.createdAt
          : new Date(0).toISOString();
      }
      if (rawEvent.statusConfirmationCycleStartedAt === undefined) {
        rawEvent.statusConfirmationCycleStartedAt = typeof rawEvent.createdAt === "string"
          ? rawEvent.createdAt
          : new Date(0).toISOString();
      }
      if (!Array.isArray(rawEvent.statusConfirmationHistory)) {
        rawEvent.statusConfirmationHistory = [];
      }
      if (!Array.isArray(rawEvent.exitedResponderUserIds)) {
        rawEvent.exitedResponderUserIds = [];
      }
      if (typeof rawEvent.patientUserId !== "string" || rawEvent.patientUserId.length === 0) {
        const patientDeviceIds = Array.isArray(rawEvent.patientDeviceIds)
          ? rawEvent.patientDeviceIds.filter((deviceId): deviceId is string => typeof deviceId === "string")
          : [];
        const patientDevice = isRecord(normalized.devices)
          ? normalized.devices[patientDeviceIds[0] ?? ""]
          : undefined;
        rawEvent.patientUserId = isRecord(patientDevice) && typeof patientDevice.userId === "string"
          ? patientDevice.userId
          : `legacy-device:${patientDeviceIds[0] ?? eventId}`;
      }
      if (Array.isArray(rawEvent.patientDeviceIds)) {
        rawEvent.patientDeviceIds = rawEvent.patientDeviceIds.filter((deviceId) => {
          if (typeof deviceId !== "string" || !isRecord(normalized.devices)) return false;
          const device = normalized.devices[deviceId];
          return isRecord(device)
            && device.deviceKind === "IPHONE"
            && device.companionPairId === rawEvent.patientPairId
            && (typeof device.userId !== "string" || device.userId === rawEvent.patientUserId);
        });
      }
      // Permit-era state is deliberately not carried into the direct-fallback
      // protocol. Keep effective historical positions but drop authority data.
      delete rawEvent.watchFallbackPermit;
      delete rawEvent.previousWatchReachability;
      delete rawEvent.currentWatchReachability;
      delete rawEvent.watchFallbackAuthorityRevision;
      if (rawEvent.triggerSource === "WATCH_FALL_EMERGENCY_CALL_OBSERVED") {
        rawEvent.triggerSource = "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED";
      }
      if (isRecord(rawEvent.observation)
        && rawEvent.observation.observationKind !== "SIMULATED_TEST"
        // A person-reported event never had a fall context to normalise: rewriting it
        // into FALL_CONTEXT would make the record claim a measured fall.
        && rawEvent.observation.observationKind !== "USER_REPORTED_PATIENT") {
        const observation = rawEvent.observation;
        if (observation.appHelpResponse === undefined) {
          observation.appHelpResponse = typeof observation.callFirstObservedAt === "string"
            ? "NO_RESPONSE"
            : "NEEDS_HELP";
        }
        observation.observationKind = "FALL_CONTEXT";
        delete observation.emergencyCallObserved;
      }
      if (!isRecord(rawEvent.patientPosition) && isRecord(rawEvent.observation)) {
        const observation = rawEvent.observation;
        if (isRecord(observation.patientPosition)
          && typeof observation.patientPositionObservedAt === "string") {
          rawEvent.patientPosition = {
            positionUpdateId: eventId,
            source: "WATCH_TRIGGER_SNAPSHOT",
            position: observation.patientPosition,
            observedAt: observation.patientPositionObservedAt,
            serverReceivedAt: typeof rawEvent.createdAt === "string"
              ? rawEvent.createdAt
              : observation.fallDetectedAt
          };
        }
      }
      if (isRecord(rawEvent.patientPosition)) {
        if (rawEvent.patientPosition.source === "WATCH_TRIGGER") {
          rawEvent.patientPosition.source = "WATCH_TRIGGER_SNAPSHOT";
        } else if (rawEvent.patientPosition.source === "IPHONE_CONTINUOUS") {
          rawEvent.patientPosition.source = "IPHONE_PRIMARY";
        }
        if (rawEvent.patientPosition.source === "IPHONE_PRIMARY"
          && !isRecord(rawEvent.iphonePatientPosition)) {
          rawEvent.iphonePatientPosition = structuredClone(rawEvent.patientPosition);
        }
        if (rawEvent.patientPosition.source === "WATCH_FALLBACK"
          && !isRecord(rawEvent.watchFallbackPosition)) {
          rawEvent.watchFallbackPosition = structuredClone(rawEvent.patientPosition);
        }
      }
    }
  }
  if (isRecord(normalized.deliveries)) {
    for (const rawDelivery of Object.values(normalized.deliveries)) {
      if (!isRecord(rawDelivery) || signedEvent(rawDelivery.eventId) || !isRecord(rawDelivery.request)) continue;
      const request = rawDelivery.request;
      if (request.eventType === undefined) request.eventType = "FALL_ASSISTANCE";
      if (request.positioningTier === undefined) request.positioningTier = "SEARCH_RING";
      if (request.distanceRange === undefined) request.distanceRange = "DISTANCE_OVER_2000M";
      if (request.etaRange === undefined) request.etaRange = "ETA_OVER_15_MIN";
      if (request.currentRecruitmentRadiusMeters === undefined) {
        const event = isRecord(normalized.events)
          ? normalized.events[String(rawDelivery.eventId)]
          : undefined;
        request.currentRecruitmentRadiusMeters = isRecord(event)
          && typeof event.currentRecruitmentRadiusMeters === "number"
          ? event.currentRecruitmentRadiusMeters
          : 1_000;
      }
      if (request.expiresAt === undefined && typeof request.occurredAt === "string") {
        const occurredAt = Date.parse(request.occurredAt);
        if (Number.isFinite(occurredAt)) {
          request.expiresAt = new Date(occurredAt + 30_000).toISOString();
        }
      }
      // Legacy offers carried exact P/card. They are intentionally discarded;
      // new pending offers contain only coarse search metadata.
      delete request.patientPosition;
      delete request.patientLocationCard;
      if (typeof rawDelivery.request.deliveryStatus !== "string"
        && typeof rawDelivery.status === "string") {
        rawDelivery.request.deliveryStatus = ["SENT", "DELIVERED", "VIEWED"].includes(
          rawDelivery.status
        ) ? rawDelivery.status : "SENT";
      }
    }
  }
  if (isRecord(normalized.sessionsByTokenHash)) {
    for (const rawSession of Object.values(normalized.sessionsByTokenHash)) {
      if (!isRecord(rawSession)) continue;
      if (rawSession.sessionKind === undefined) rawSession.sessionKind = "DEVICE";
    }
  }
  if (isRecord(normalized.authChallengesById)) {
    for (const rawChallenge of Object.values(normalized.authChallengesById)) {
      if (!isRecord(rawChallenge)) continue;
      if (!Number.isInteger(rawChallenge.failedAttempts)) rawChallenge.failedAttempts = 0;
    }
  }
  // Assignment termination is a persisted server fact. If an older writer (or
  // a recovered transaction) recorded a terminal assignment before it wrote
  // the interval close, seal the already-created interval from that transition
  // timestamp. This never creates an interval from mutable delivery status.
  if (isRecord(normalized.assignments) && isRecord(normalized.participantIntervalsById)) {
    for (const rawAssignment of Object.values(normalized.assignments)) {
      if (!isRecord(rawAssignment) || signedEvent(rawAssignment.eventId)
        || !["TIMED_OUT", "CANCELLED"].includes(String(rawAssignment.status))
        || typeof rawAssignment.eventId !== "string"
        || typeof rawAssignment.deviceInstanceId !== "string"
        || typeof rawAssignment.updatedAt !== "string") continue;
      for (const interval of Object.values(normalized.participantIntervalsById)) {
        if (!isRecord(interval)
          || interval.eventId !== rawAssignment.eventId
          || interval.deviceInstanceId !== rawAssignment.deviceInstanceId
          || interval.endedAt !== undefined) continue;
        interval.endedAt = rawAssignment.updatedAt;
        interval.endReason = rawAssignment.status === "TIMED_OUT" ? "TIMED_OUT" : "CANCELLED";
      }
    }
  }
  return normalized;
}

/**
 * Per-collection record validators, extracted from validateState so the
 * incremental transaction path can validate exactly the entities it changed
 * without re-validating the whole retained state.
 */
type RecordValidator = (record: Record<string, unknown>, context: string) => void;

const validateUserRecord: RecordValidator = (user, context) => {
    if (user.lifecycleState !== undefined && !["ACTIVE", "CLOSED"].includes(String(user.lifecycleState))) throw new Error(`${context}.lifecycleState is invalid`);
    if (user.lifecycleState === "CLOSED") isoDateSchema.parse(user.closedAt);
    for (const key of ["userId", "createdAt", "updatedAt"]) requireString(user, key, context);
  };
const validateAccountRecord: RecordValidator = (account, context) => {
    for (const key of [
      "accountId",
      "userId",
      "provider",
      "providerSubjectHash",
      "createdAt",
      "lastLoginAt"
    ]) requireString(account, key, context);
    // Legacy PHONE rows stay loadable so an older state file validates; nothing
    // creates one any more.
    if (!["PHONE", "APPLE", "CONTROLLED_TEST"].includes(String(account.provider))) {
      throw new Error(`${context}.provider is unsupported`);
    }
    if (account.phoneLastFour !== undefined
      && (String(account.provider) !== "PHONE"
        || typeof account.phoneLastFour !== "string"
        || !/^\d{4}$/.test(account.phoneLastFour))) {
      throw new Error(`${context}.phoneLastFour is invalid`);
    }
  };
const validateAuthChallengeRecord: RecordValidator = (challenge, context) => {
    for (const key of [
      "challengeId",
      "provider",
      "normalizedPhoneHash",
      "expiresAt",
      "issuedAt"
    ]) requireString(challenge, key, context);
    if (!Number.isInteger(challenge.failedAttempts)
      || Number(challenge.failedAttempts) < 0) {
      throw new Error(`${context}.failedAttempts must be a non-negative integer`);
    }
    // Only the legacy PHONE shape is known; the collection has no writers any
    // more, so an unexpected provider is a corrupt file rather than a new kind.
    if (challenge.provider !== "PHONE") {
      throw new Error(`${context}.provider is unsupported`);
    }
    if (challenge.lockedAt !== undefined) requireString(challenge, "lockedAt", context);
    if (challenge.usedAt !== undefined) requireString(challenge, "usedAt", context);
  };
const validateCompanionLinkTicketRecord: RecordValidator = (ticket, context) => {
      for (const key of [
        "ticketHash",
        "userId",
        "accountId",
        "iPhoneDeviceId",
        "companionPairId",
        "issuedAt",
        "expiresAt"
      ]) requireString(ticket, key, context);
      if (ticket.revokedAt !== undefined) requireString(ticket, "revokedAt", context);
      if (ticket.consumedAt !== undefined) requireString(ticket, "consumedAt", context);
    };
const validateParticipantExitRecord: RecordValidator = (exit, context) => {
      for (const key of [
        "exitId",
        "eventId",
        "deviceInstanceId",
        "userId",
        "exitedAt",
        "fingerprint"
      ]) requireString(exit, key, context);
      if (exit.reason !== undefined && typeof exit.reason !== "string") {
        throw new Error(`${context}.reason must be a string`);
      }
    };
const validateParticipantIntervalRecord: RecordValidator = (interval, context) => {
      for (const key of ["eventId", "userId", "deviceInstanceId", "acceptedAt"]) {
        requireString(interval, key, context);
      }
      const acceptedAt = Date.parse(String(interval.acceptedAt));
      if (!Number.isFinite(acceptedAt)) {
        throw new Error(`${context}.acceptedAt must be an ISO-8601 timestamp`);
      }
      if (interval.endedAt !== undefined) requireString(interval, "endedAt", context);
      if (interval.endReason !== undefined
        && ![
          "RESPONDER_EXIT",
          "TIMED_OUT",
          "CANCELLED",
          "PATIENT_PRIORITY",
          "EVENT_ENDED"
        ].includes(String(interval.endReason))) {
        throw new Error(`${context}.endReason is unsupported`);
      }
      if (interval.endedAt === undefined && interval.endReason !== undefined) {
        throw new Error(`${context}.endReason requires endedAt`);
      }
      if (interval.endedAt !== undefined && interval.endReason === undefined) {
        throw new Error(`${context}.endReason is required with endedAt`);
      }
      if (interval.endedAt !== undefined) {
        const endedAt = Date.parse(String(interval.endedAt));
        if (!Number.isFinite(endedAt)) {
          throw new Error(`${context}.endedAt must be an ISO-8601 timestamp`);
        }
        if (endedAt < acceptedAt) {
          throw new Error(`${context}.endedAt cannot be earlier than acceptedAt`);
        }
      }
    };
const validateEventPositionBatchRecord: RecordValidator = (batch, context) => {
      for (const key of [
        "batchId",
        "eventId",
        "userId",
        "deviceInstanceId",
        "kind",
        "fingerprint",
        "receivedAt"
      ]) requireString(batch, key, context);
      if (batch.kind !== "P" && batch.kind !== "R") {
        throw new Error(`${context}.kind must be P or R`);
      }
      if (!Array.isArray(batch.records) || batch.records.length === 0) {
        throw new Error(`${context}.records must be a non-empty array`);
      }
      if (batch.records.length > 5) {
        throw new Error(`${context}.records must contain at most five records`);
      }
      const recordIds = new Set<string>();
      const slotAtValues = new Set<string>();
      const slotMillisecondsValues: number[] = [];
      for (const [index, rawRecord] of batch.records.entries()) {
        const recordContext = `${context}.records.${index}`;
        if (!isRecord(rawRecord)) throw new Error(`${recordContext} must be an object`);
        for (const key of [
          "recordId",
          "batchId",
          "eventId",
          "userId",
          "deviceInstanceId",
          "kind",
          "slotAt",
          "serverReceivedAt",
          "status"
        ]) requireString(rawRecord, key, recordContext);
        const parsedSlot = utcSecondSchema.safeParse(rawRecord.slotAt);
        if (!parsedSlot.success) {
          throw new Error(`${recordContext}.slotAt must be a UTC whole-second timestamp`);
        }
        if (recordIds.has(String(rawRecord.recordId))) {
          throw new Error(`${recordContext}.recordId must be unique`);
        }
        recordIds.add(String(rawRecord.recordId));
        if (slotAtValues.has(parsedSlot.data)) {
          throw new Error(`${recordContext}.slotAt must be unique`);
        }
        slotAtValues.add(parsedSlot.data);
        slotMillisecondsValues.push(Date.parse(parsedSlot.data));
        if (rawRecord.batchId !== batch.batchId
          || rawRecord.eventId !== batch.eventId
          || rawRecord.userId !== batch.userId
          || rawRecord.deviceInstanceId !== batch.deviceInstanceId
          || rawRecord.kind !== batch.kind) {
          throw new Error(`${recordContext} does not match its batch identity`);
        }
        if (rawRecord.status === "FIX") {
          requireString(rawRecord, "fixObservedAt", recordContext);
          if (!isoDateSchema.safeParse(rawRecord.fixObservedAt).success) {
            throw new Error(`${recordContext}.fixObservedAt must be an ISO timestamp`);
          }
          const slotMilliseconds = Date.parse(String(rawRecord.slotAt));
          const fixMilliseconds = Date.parse(String(rawRecord.fixObservedAt));
          if (!Number.isFinite(slotMilliseconds)
            || !Number.isFinite(fixMilliseconds)
            || fixMilliseconds < slotMilliseconds
            || fixMilliseconds >= slotMilliseconds + 1_000) {
            throw new Error(`${recordContext}.fixObservedAt must fall within its slot`);
          }
          if (rawRecord.gapReason !== undefined) {
            throw new Error(`${recordContext}.gapReason is forbidden for FIX`);
          }
          const parsedPatient = patientPositionSchema.safeParse(rawRecord.position);
          const parsedResponder = responderPositionSchema.safeParse(rawRecord.position);
          if (!parsedPatient.success && !parsedResponder.success) {
            throw new Error(`${recordContext}.position must be strict P or R`);
          }
          if (rawRecord.kind === "P" && !parsedPatient.success) {
            throw new Error(`${recordContext}.position must be P for a patient batch`);
          }
          if (rawRecord.kind === "R" && !parsedResponder.success) {
            throw new Error(`${recordContext}.position must be R for a responder batch`);
          }
        } else if (rawRecord.status === "NO_NEW_FIX") {
          if (rawRecord.gapReason !== "NO_FIX" && rawRecord.gapReason !== "APP_NOT_RUNNING") {
            throw new Error(`${recordContext}.gapReason must be NO_FIX or APP_NOT_RUNNING`);
          }
          if (rawRecord.position !== undefined || rawRecord.fixObservedAt !== undefined) {
            throw new Error(`${recordContext}.position/fixObservedAt are forbidden for NO_NEW_FIX`);
          }
        } else {
          throw new Error(`${recordContext}.status is unsupported`);
        }
        for (const key of ["appliedToLatest", "ignoredAsStale"]) {
          if (typeof rawRecord[key] !== "boolean") {
            throw new Error(`${recordContext}.${key} must be a boolean`);
          }
        }
      }
      const orderedSlots = [...slotMillisecondsValues].sort((left, right) => left - right);
      for (let index = 1; index < orderedSlots.length; index += 1) {
        if (orderedSlots[index]! - orderedSlots[index - 1]! !== 1_000) {
          throw new Error(`${context}.records slotAt values must be contiguous one-second slots`);
        }
      }
    };
const validateDeviceRecord: RecordValidator = (device, context) => {
    if (device.loginState !== undefined && !["SIGNED_IN", "SIGNED_OUT"].includes(String(device.loginState))) throw new Error(`${context}.loginState is invalid`);
    for (const key of [
      "deviceInstanceId",
      "deviceKind",
      "companionPairId",
      "presenceObservedAt",
      "lastSeenAt",
      "lastBootstrapAt"
    ]) {
      requireString(device, key, context);
    }
    for (const key of ["userId", "accountId"]) {
      if (device[key] !== undefined) requireString(device, key, context);
    }
    if (device.companionLinkRevokedAt !== undefined) {
      requireString(device, "companionLinkRevokedAt", context);
    }
    if (device.pushRegistration !== undefined) {
      const registration = device.pushRegistration;
      if (!isRecord(registration)) {
        throw new Error(`${context}.pushRegistration must be an object`);
      }
      for (const key of ["token", "environment", "bundleId", "registeredAt", "updatedAt"]) {
        requireString(registration, key, `${context}.pushRegistration`);
      }
      if (!["SANDBOX", "PRODUCTION"].includes(String(registration.environment))) {
        throw new Error(`${context}.pushRegistration.environment is unsupported`);
      }
      // APNs tokens are hex; anything else is a client bug that would silently
      // make every push fail, so it is rejected at the boundary instead.
      const token = String(registration.token);
      if (token.length < 32 || token.length > 512 || !/^[0-9a-f]+$/.test(token)) {
        throw new Error(`${context}.pushRegistration.token must be hex`);
      }
      for (const key of ["registeredAt", "updatedAt"]) {
        if (!Number.isFinite(Date.parse(String(registration[key])))) {
          throw new Error(`${context}.pushRegistration.${key} must be an ISO-8601 timestamp`);
        }
      }
      if (device.deviceKind !== "IPHONE") {
        throw new Error(`${context}.pushRegistration is only valid for an iPhone`);
      }
    }
    if (!isRecord(device.agreements)) throw new Error(`${context}.agreements must be an object`);
    if (!isRecord(device.capabilities)
      || typeof device.capabilities.notificationAuthorized !== "boolean"
      || typeof device.capabilities.locationAuthorized !== "boolean") {
      throw new Error(`${context}.capabilities must contain boolean authorization flags`);
    }
    if (typeof device.availableForResponse !== "boolean") {
      throw new Error(`${context}.availableForResponse must be a boolean`);
    }
    if (device.latestPosition !== undefined) {
      if (!isRecord(device.latestPosition)) throw new Error(`${context}.latestPosition must be an object`);
      for (const key of ["positionUpdateId", "observedAt", "serverReceivedAt"]) {
        requireString(device.latestPosition, key, `${context}.latestPosition`);
      }
      const position = device.latestPosition.position;
      const parsed = patientPositionSchema.safeParse(position);
      const responderParsed = responderPositionSchema.safeParse(position);
      if (!parsed.success && !responderParsed.success) {
        throw new Error(`${context}.latestPosition.position must be strict P or R`);
      }
      if (parsed.success && typeof device.latestPosition.eventId !== "string") {
        throw new Error(`${context}.latestPosition.eventId is required for P`);
      }
      if (responderParsed.success && device.latestPosition.eventId !== undefined) {
        throw new Error(`${context}.latestPosition.eventId is forbidden for R`);
      }
    }
  };
const validateSessionRecord: RecordValidator = (session, context) => {
    for (const key of [
      "sessionId",
      "tokenHash",
      "issuedAt",
      "expiresAt"
    ]) requireString(session, key, context);
    if (session.accountClosureRequestId !== undefined) {
      requireString(session, "accountClosureRequestId", context);
      if (session.sessionKind !== "ACCOUNT" || typeof session.revokedAt !== "string") throw new Error(`${context}.accountClosureRequestId requires a revoked account session`);
    }
    if (session.logoutCompletedAt !== undefined) {
      requireString(session, "logoutCompletedAt", context);
      if (!Number.isFinite(Date.parse(String(session.logoutCompletedAt))) || typeof session.revokedAt !== "string") {
        throw new Error(`${context}.logoutCompletedAt requires a revoked session and valid timestamp`);
      }
    }
    if (session.sessionKind !== undefined
      && !["ACCOUNT", "DEVICE"].includes(String(session.sessionKind))) {
      throw new Error(`${context}.sessionKind is unsupported`);
    }
    for (const key of ["userId", "accountId", "deviceInstanceId", "deviceKind"]) {
      if (session[key] !== undefined) requireString(session, key, context);
    }
    for (const key of [
      "refreshTokenHash",
      "refreshExpiresAt",
      "refreshFamilyId",
      "refreshRotatedAt",
      "refreshRevokedAt"
    ]) {
      if (session[key] !== undefined) requireString(session, key, context);
    }
    if (session.refreshTokenHash !== undefined) {
      for (const key of ["refreshExpiresAt", "refreshFamilyId"]) {
        requireString(session, key, context);
      }
    }
    const sessionKind = session.sessionKind ?? "DEVICE";
    if (sessionKind === "ACCOUNT") {
      for (const key of ["userId", "accountId"]) requireString(session, key, context);
      if (session.deviceInstanceId !== undefined || session.deviceKind !== undefined) {
        throw new Error(`${context} account session cannot contain a device binding`);
      }
    } else {
      for (const key of ["deviceInstanceId", "deviceKind"]) requireString(session, key, context);
    }
    if (!Array.isArray(session.scopes)) throw new Error(`${context}.scopes must be an array`);
  };
const validateEventRecord: RecordValidator = (event, context) => {
    for (const key of [
      "id",
      "observationFingerprint",
      "patientPairId",
      "patientUserId",
      "state",
      "recruitmentState",
      "triggerSource",
      "createdAt"
    ]) requireString(event, key, context);
    if (![1_000, 1_500, 2_000].includes(Number(event.currentRecruitmentRadiusMeters))) {
      throw new Error(`${context}.currentRecruitmentRadiusMeters is unsupported`);
    }
    if (event.recruitmentStageStartedAt !== null) {
      requireString(event, "recruitmentStageStartedAt", context);
    }
    if (event.statusConfirmationCycleStartedAt !== undefined) {
      requireString(event, "statusConfirmationCycleStartedAt", context);
    }
    if (event.statusConfirmationHistory !== undefined) {
      if (!Array.isArray(event.statusConfirmationHistory)) {
        throw new Error(`${context}.statusConfirmationHistory must be an array`);
      }
      for (const [index, confirmation] of event.statusConfirmationHistory.entries()) {
        validateStatusConfirmationRecord(confirmation, `${context}.statusConfirmationHistory.${index}`);
      }
    }
    const statusConfirmation = event.statusConfirmation;
    if (statusConfirmation !== undefined) {
      validateStatusConfirmationRecord(statusConfirmation, `${context}.statusConfirmation`);
      if (!isRecord(statusConfirmation) || statusConfirmation.state !== "PENDING") {
        throw new Error(`${context}.statusConfirmation must be PENDING while attached to an event`);
      }
    }
    if (!Array.isArray(event.exitedResponderUserIds)
      || event.exitedResponderUserIds.some((userId: unknown) => typeof userId !== "string")) {
      throw new Error(`${context}.exitedResponderUserIds must be an array of strings`);
    }
    if (event.terminalReason !== undefined
      && ![
        "FALSE_ALARM",
        "ASSISTANCE_WITHDRAWN",
        "PROBLEM_RESOLVED",
        "PROFESSIONAL_TAKEOVER",
        "CLOSED_UNCONFIRMED_NO_RESPONSE"
      ].includes(String(event.terminalReason))) {
      throw new Error(`${context}.terminalReason is unsupported`);
    }
    if (!isRecord(event.observation)) throw new Error(`${context}.observation must be an object`);
    try {
      if (event.triggerSource === "SIMULATED_TEST") {
        const simulation = simulationObservationSchema.parse(event.observation);
        if (event.id !== simulation.runId || event.patientUserId !== simulation.patientUserId
          || !Array.isArray(event.patientDeviceIds) || event.patientDeviceIds.length !== 1
          || event.patientDeviceIds[0] !== simulation.patientDeviceId
          || event.triggeringWatchDeviceId !== undefined) throw new Error("Invalid simulated patient binding");
      } else if (event.triggerSource === "USER_REPORTED_PATIENT") {
        const reported = userReportedPatientObservationSchema.parse(event.observation);
        // The reporter's own phone is the patient-side position source, so the
        // binding is checked rather than trusted: one device, the reporter's.
        if (event.id !== reported.eventId
          || !Array.isArray(event.patientDeviceIds) || event.patientDeviceIds.length !== 1
          || event.patientDeviceIds[0] !== reported.reporterDeviceId
          || event.triggeringWatchDeviceId !== undefined) {
          throw new Error("Invalid reported-patient binding");
        }
      } else {
        watchEmergencyObservationSchema.parse(event.observation);
      }
    } catch {
      throw new Error(`${context}.observation does not match the current trigger schema`);
    }
    if (event.triggerSource !== "SIMULATED_TEST" && event.triggerSource !== "USER_REPORTED_PATIENT"
      && !watchTriggerSourceSchema.safeParse(event.triggerSource).success) {
      throw new Error(`${context}.triggerSource is unsupported`);
    }
    if (!Array.isArray(event.patientDeviceIds) || !Array.isArray(event.unavailableAedIds)) {
      throw new Error(`${context} patient/unavailable device fields must be arrays`);
    }
    if (!Number.isInteger(event.assignmentRevision)) {
      throw new Error(`${context}.assignmentRevision must be an integer`);
    }
    if (!Number.isInteger(event.coordinationRevision)) {
      throw new Error(`${context}.coordinationRevision must be an integer`);
    }
    if (event.triggeringWatchDeviceId !== undefined
      && (typeof event.triggeringWatchDeviceId !== "string"
        || event.triggeringWatchDeviceId.length === 0)) {
      throw new Error(`${context}.triggeringWatchDeviceId must be a non-empty string`);
    }
    if (event.patientPosition !== undefined) {
      validateCurrentPatientPosition(event.patientPosition, `${context}.patientPosition`);
    }
    if (event.iphonePatientPosition !== undefined) {
      validateCurrentPatientPosition(event.iphonePatientPosition, `${context}.iphonePatientPosition`);
      if ((event.iphonePatientPosition as Record<string, unknown>).source !== "IPHONE_PRIMARY") {
        throw new Error(`${context}.iphonePatientPosition.source must be IPHONE_PRIMARY`);
      }
    }
    if (event.watchFallbackPosition !== undefined) {
      validateCurrentPatientPosition(event.watchFallbackPosition, `${context}.watchFallbackPosition`);
      if ((event.watchFallbackPosition as Record<string, unknown>).source !== "WATCH_FALLBACK") {
        throw new Error(`${context}.watchFallbackPosition.source must be WATCH_FALLBACK`);
      }
    }
    if (event.retention !== undefined) {
      validateEventRetention(event.retention, `${context}.retention`);
    }
    for (const [field, requiredKeys] of [
      ["watchFallbackCandidate", ["positionUpdateId", "observedAt", "serverReceivedAt"]],
      ["watchFallbackCadence", ["positionUpdateId", "observedAt", "serverReceivedAt"]]
    ] as const) {
      const sample = event[field];
      if (sample === undefined) continue;
      if (!isRecord(sample)) throw new Error(`${context}.${field} must be an object`);
      for (const key of requiredKeys) requireString(sample, key, `${context}.${field}`);
      patientPositionSchema.parse(sample.position);
      if (sample.intervalSeconds !== undefined
        && (typeof sample.intervalSeconds !== "number" || !Number.isFinite(sample.intervalSeconds)
          || sample.intervalSeconds < 0)) {
        throw new Error(`${context}.${field}.intervalSeconds must be non-negative`);
      }
      if (sample.distanceMeters !== undefined
        && (typeof sample.distanceMeters !== "number" || !Number.isFinite(sample.distanceMeters)
          || sample.distanceMeters < 0)) {
        throw new Error(`${context}.${field}.distanceMeters must be non-negative`);
      }
    }
  };

/**
 * Retention records are server-owned.  The shape is validated here so a
 * hand-edited or migrated state file cannot silently claim an event was sealed
 * or purged, and so the summary that survives a purge stays aggregate-only.
 */
function validatePurgedEventSummary(value: unknown, context: string): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  for (const key of ["triggerSource", "createdAt", "resolvedAt"]) {
    requireString(value, key, context);
  }
  if (!Number.isFinite(Date.parse(String(value.createdAt)))
    || !Number.isFinite(Date.parse(String(value.resolvedAt)))) {
    throw new Error(`${context} timestamps must be ISO dates`);
  }
  for (const key of [
    "durationSeconds",
    "acceptedResponderCount",
    "completedResponderCount",
    "aedAcquiredCount",
    "aedUnavailableReportCount",
    "positionBatchCount",
    "positionRecordCount",
    "statusConfirmationCount",
    "mediaReferenceCount",
    "purgedCollectionCount"
  ]) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error(`${context}.${key} must be a non-negative integer`);
    }
  }
}

function validateLegalHold(value: unknown, context: string): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  for (const key of ["placedAt", "authority", "reason"]) requireString(value, key, context);
  if (!Number.isFinite(Date.parse(String(value.placedAt)))) {
    throw new Error(`${context}.placedAt must be an ISO date`);
  }
  if (value.releasedAt !== undefined) {
    requireString(value, "releasedAt", context);
    if (!Number.isFinite(Date.parse(String(value.releasedAt)))) {
      throw new Error(`${context}.releasedAt must be an ISO date`);
    }
  }
}

function validateEventRetention(value: unknown, context: string): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  if (!["ONLINE", "SEALED", "PURGED"].includes(String(value.tier))) {
    throw new Error(`${context}.tier is unsupported`);
  }
  requireString(value, "clockStartedAt", context);
  if (!Number.isFinite(Date.parse(String(value.clockStartedAt)))) {
    throw new Error(`${context}.clockStartedAt must be an ISO date`);
  }
  for (const key of ["sealedAt", "purgedAt"]) {
    if (value[key] === undefined) continue;
    requireString(value, key, context);
    if (!Number.isFinite(Date.parse(String(value[key])))) {
      throw new Error(`${context}.${key} must be an ISO date`);
    }
  }
  if (value.sealedContainer !== undefined) {
    const container = value.sealedContainer;
    if (!isRecord(container)) throw new Error(`${context}.sealedContainer must be an object`);
    for (const key of ["path", "sealedAt"]) {
      requireString(container, key, `${context}.sealedContainer`);
    }
    if (typeof container.bytes !== "number" || !Number.isInteger(container.bytes)
      || container.bytes <= 0) {
      throw new Error(`${context}.sealedContainer.bytes must be a positive integer`);
    }
    if (!Number.isFinite(Date.parse(String(container.sealedAt)))) {
      throw new Error(`${context}.sealedContainer.sealedAt must be an ISO date`);
    }
    // A container may only be recorded once the event is at least sealed.
    if (value.tier === "ONLINE") {
      throw new Error(`${context}.sealedContainer requires the sealed tier`);
    }
  }
  if (value.tier === "SEALED" && value.sealedAt === undefined) {
    throw new Error(`${context}.sealedAt is required once an event is SEALED`);
  }
  if (value.tier === "PURGED") {
    if (value.sealedAt === undefined || value.purgedAt === undefined) {
      throw new Error(`${context} must record sealedAt and purgedAt once PURGED`);
    }
    validatePurgedEventSummary(value.summary, `${context}.summary`);
  }
  if (value.tier !== "PURGED" && value.summary !== undefined) {
    throw new Error(`${context}.summary only exists after a purge`);
  }
  if (value.legalHold !== undefined) {
    validateLegalHold(value.legalHold, `${context}.legalHold`);
  }
}

/**
 * Access-audit entries are append-only and must not carry the data they audit.
 *
 * The `subjectId` is an opaque identifier and the reason is bounded text; the
 * validator rejects anything that looks like a copied payload (coordinates,
 * tokens) so the audit log cannot quietly become a second copy of the data.
 */
const validateAccessAuditRecord: RecordValidator = (record, context) => {
  for (const key of ["entryId", "actor", "actorKind", "dataClass", "subjectId",
    "reason", "recordedAt"]) {
    requireString(record, key, context);
  }
  if (!["OPERATOR", "ACCOUNT", "DEVICE", "SYSTEM"].includes(String(record.actorKind))) {
    throw new Error(`${context}.actorKind is unsupported`);
  }
  if (!["ALLOWED", "DENIED"].includes(String(record.outcome))) {
    throw new Error(`${context}.outcome is unsupported`);
  }
  if (!["EVENT_SUMMARY", "PRECISE_PATIENT_POSITION", "PARTICIPANT_POSITION",
    "PARTICIPANT_IDENTITY", "EVIDENCE", "RETENTION", "LEGAL_HOLD", "ACCOUNT_ADMIN"]
    .includes(String(record.dataClass))) {
    throw new Error(`${context}.dataClass is unsupported`);
  }
  if (String(record.reason).trim().length < 4) {
    throw new Error(`${context}.reason must be a real reason`);
  }
  const serialized = JSON.stringify(record);
  if (serialized.length > 4_000) {
    throw new Error(`${context} looks like copied data rather than an audit entry`);
  }
  if (record.grantId !== undefined) requireString(record, "grantId", context);
  if (!Number.isFinite(Date.parse(String(record.recordedAt)))) {
    throw new Error(`${context}.recordedAt must be an ISO-8601 timestamp`);
  }
};

const validateBreakGlassGrantRecord: RecordValidator = (record, context) => {
  for (const key of ["grantId", "eventId", "issuedBy", "reason", "issuedAt", "expiresAt"]) {
    requireString(record, key, context);
  }
  if (record.scope !== "READ_ONLY") {
    throw new Error(`${context}.scope must be READ_ONLY`);
  }
  const issuedAt = Date.parse(String(record.issuedAt));
  const expiresAt = Date.parse(String(record.expiresAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new Error(`${context} timestamps must be ISO-8601`);
  }
  if (expiresAt <= issuedAt) throw new Error(`${context}.expiresAt must follow issuedAt`);
  // The 30-minute ceiling is a property of the RECORD, not of the caller: a
  // hand-edited state file cannot hold a longer grant.
  if (expiresAt - issuedAt > 30 * 60_000) {
    throw new Error(`${context} exceeds the 30-minute break-glass ceiling`);
  }
  if (record.usedAt !== undefined) requireString(record, "usedAt", context);
};

/**
 * G09 validation.
 *
 * These records are the evidence that a device changed hands or was placed, so
 * the shapes are strict: a half-written handover (settled with no confirmations,
 * a temporary point with no photo reference, a follow-up with no outcome) is
 * rejected at commit time rather than discovered when someone is dispatched.
 */
const validateAedHandoverRecord: RecordValidator = (record, context) => {
  for (const key of ["handoverId", "requestId", "eventId", "aedId", "assignmentId",
    "holderDeviceInstanceId", "acquiredAt", "initiatedAt"]) {
    requireString(record, key, context);
  }
  if (!["FACE_TO_FACE", "TEMPORARY_POINT"].includes(String(record.mode))) {
    throw new Error(`${context}.mode is unsupported`);
  }
  if (!["PENDING", "CONFIRMED", "SETTLED", "HALTED"].includes(String(record.status))) {
    throw new Error(`${context}.status is unsupported`);
  }
  if (!Number.isInteger(record.revision) || Number(record.revision) < 1) {
    throw new Error(`${context}.revision must be a positive integer`);
  }
  for (const key of ["holderUserId", "receiverDeviceInstanceId", "receiverUserId",
    "holderConfirmedAt", "receiverConfirmedAt", "settledAt", "haltedAt", "haltReason",
    "temporaryPointDepositId"]) {
    if (record[key] !== undefined) requireString(record, key, context);
  }
  // A handover is complete only when BOTH sides confirmed.  A record claiming
  // otherwise is the exact defect the two-party rule exists to prevent, so it
  // must not survive a load either.
  const bothConfirmed = record.holderConfirmedAt !== undefined
    && record.receiverConfirmedAt !== undefined;
  if (record.status === "CONFIRMED" && !bothConfirmed) {
    throw new Error(`${context} cannot be CONFIRMED without both confirmations`);
  }
  if (record.status === "SETTLED") {
    if (!bothConfirmed && record.mode === "FACE_TO_FACE") {
      throw new Error(`${context} cannot be a settled face-to-face handover without both confirmations`);
    }
    if (record.settledAt === undefined) {
      throw new Error(`${context}.settledAt is required once settled`);
    }
    if (record.mode === "TEMPORARY_POINT" && record.temporaryPointDepositId === undefined) {
      throw new Error(`${context} must name its temporary placement point once settled`);
    }
  }
  if (record.status === "HALTED" && (record.haltedAt === undefined || record.haltReason === undefined)) {
    throw new Error(`${context} must record when and why it was halted`);
  }
};

const validateAedPhotoReferenceRecord: RecordValidator = (record, context) => {
  for (const key of ["objectKey", "handoverId", "eventId", "mimeType", "sha256",
    "capturedAt", "recordedAt"]) {
    requireString(record, key, context);
  }
  if (record.mimeType !== "image/jpeg") throw new Error(`${context}.mimeType must be image/jpeg`);
  if (!/^[0-9a-f]{64}$/.test(String(record.sha256))) {
    throw new Error(`${context}.sha256 must be lowercase hex`);
  }
  if (!Number.isInteger(record.byteSize) || Number(record.byteSize) <= 0) {
    throw new Error(`${context}.byteSize must be a positive integer`);
  }
  for (const key of ["widthPixels", "heightPixels"]) {
    if (!Number.isInteger(record[key]) || Number(record[key]) <= 0) {
      throw new Error(`${context}.${key} must be a positive integer`);
    }
  }
  if (Math.max(Number(record.widthPixels), Number(record.heightPixels)) > 2048) {
    throw new Error(`${context} exceeds the 2048-pixel longest edge`);
  }
  if (Number(record.byteSize) > 5 * 1024 * 1024) {
    throw new Error(`${context} exceeds the 5 MiB photo bound`);
  }
  if (record.exifStripped !== true) throw new Error(`${context}.exifStripped must be true`);
  if (typeof record.verifiedAgainstStorage !== "boolean") {
    throw new Error(`${context}.verifiedAgainstStorage must be a boolean`);
  }
};

const validateAedTemporaryPointDepositRecord: RecordValidator = (record, context) => {
  for (const key of ["depositId", "requestId", "handoverId", "eventId", "aedId",
    "positionObservedAt", "objectKey", "placedByDeviceInstanceId", "depositedAt"]) {
    requireString(record, key, context);
  }
  if (!["SEARCHING", "FOUND", "NOT_FOUND"].includes(String(record.status))) {
    throw new Error(`${context}.status is unsupported`);
  }
  if (!isRecord(record.position)) throw new Error(`${context}.position must be an object`);
  if (record.position.kind !== "R") throw new Error(`${context}.position must be a responder sample`);
  for (const key of ["latitude", "longitude", "accuracyMeters"]) {
    const value = record.position[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${context}.position.${key} must be a finite number`);
    }
  }
  if (Number(record.position.accuracyMeters) > 50) {
    throw new Error(`${context}.position must be accurate to 50 metres or better`);
  }
  if (record.status !== "SEARCHING" && record.resolvedAt === undefined) {
    throw new Error(`${context} must record when the search concluded`);
  }
  for (const key of ["placedByUserId", "resolvedAt"]) {
    if (record[key] !== undefined) requireString(record, key, context);
  }
};

const validateAedTemporaryPointFollowUpRecord: RecordValidator = (record, context) => {
  for (const key of ["followUpId", "requestId", "depositId", "handoverId", "eventId",
    "aedId", "deviceInstanceId", "reportedAt"]) {
    requireString(record, key, context);
  }
  if (!["FOUND", "NOT_FOUND"].includes(String(record.outcome))) {
    throw new Error(`${context}.outcome is unsupported`);
  }
  if (record.userId !== undefined) requireString(record, "userId", context);
};

const validateRerouteProposalRecord: RecordValidator = (record, context) => {
  for (const key of ["proposalId", "eventId", "assignmentId", "deviceInstanceId",
    "fromAedId", "toAedId", "proposedAt", "expiresAt"]) {
    requireString(record, key, context);
  }
  if (!["PENDING", "ACCEPTED", "REJECTED", "EXPIRED", "REFUSED"].includes(String(record.status))) {
    throw new Error(`${context}.status is unsupported`);
  }
  if (!isRecord(record.proposedRoute)) throw new Error(`${context}.proposedRoute must be an object`);
  requireString(record.proposedRoute, "aedId", `${context}.proposedRoute`);
  if (record.proposedRoute.aedId !== record.toAedId) {
    throw new Error(`${context}.proposedRoute must name the proposed AED`);
  }
  if (!isRecord(record.proposedFrom)) throw new Error(`${context}.proposedFrom must be an object`);
  for (const key of ["latitude", "longitude"]) {
    const value = record.proposedFrom[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${context}.proposedFrom.${key} must be a finite number`);
    }
  }
  if (typeof record.etaSavingSeconds !== "number" || !Number.isFinite(record.etaSavingSeconds)) {
    throw new Error(`${context}.etaSavingSeconds must be a number`);
  }
  for (const key of ["decidedAt", "refusalReason", "userId"]) {
    if (record[key] !== undefined) requireString(record, key, context);
  }
  // A decision must be recorded with the status that produced it, so a later
  // reader can tell "the responder said no" from "the window closed".
  const decided = record.status !== "PENDING";
  if (decided !== (record.decidedAt !== undefined)) {
    throw new Error(`${context}.decidedAt must be present exactly when decided`);
  }
  if (decided && Date.parse(String(record.decidedAt)) < Date.parse(String(record.proposedAt))) {
    throw new Error(`${context}.decidedAt cannot precede proposedAt`);
  }
};

const validateAppleRevocationRecord: RecordValidator = (record, context) => {
  for (const key of ["accountId", "userId", "refreshToken", "requestedAt"]) {
    requireString(record, key, context);
  }
  if (typeof record.attempts !== "number" || !Number.isInteger(record.attempts)
    || record.attempts < 0) {
    throw new Error(`${context}.attempts must be a non-negative integer`);
  }
  for (const key of ["lastAttemptAt", "lastReason"]) {
    if (record[key] !== undefined) requireString(record, key, context);
  }
};

const validateRetentionPurgeRecord: RecordValidator = (purge, context) => {
  for (const key of ["purgeId", "eventId", "authorizedAt"]) requireString(purge, key, context);
  if (purge.reason !== "THREE_YEAR_RETENTION_EXPIRED") {
    throw new Error(`${context}.reason is unsupported`);
  }
  if (purge.integrity !== undefined) evidenceProofSchema.parse(purge.integrity);
  if (purge.evidenceHead !== undefined) evidenceHeadSchema.parse(purge.evidenceHead);
  validatePurgedEventSummary(purge.summary, `${context}.summary`);
};

/**
 * A self-access request must be internally consistent, because every field here
 * decides whether a person may read their own data.  A row whose grant outlives
 * its 24-hour ceiling, or which claims verification without a verified-at time,
 * is refused at load rather than trusted at read time.
 */
const validateSelfAccessRequestRecord: RecordValidator = (request, context) => {
  for (const key of ["requestId", "userId", "accountId", "deviceInstanceId", "requestedAt",
    "challengeExpiresAt", "approvalDeadlineAt"]) {
    requireString(request, key, context);
  }
  if (!Array.isArray(request.eventIds) || request.eventIds.some(id => typeof id !== "string")) {
    throw new Error(`${context}.eventIds must be a string array`);
  }
  if (!Number.isSafeInteger(request.challengeAttempts) || (request.challengeAttempts as number) < 0) {
    throw new Error(`${context}.challengeAttempts must be a non-negative integer`);
  }
  if (!["PENDING_CHALLENGE", "PENDING_APPROVAL", "APPROVED", "REJECTED", "EXPIRED", "REVOKED"]
    .includes(String(request.status))) {
    throw new Error(`${context}.status is unsupported`);
  }
  const nonce = request.challengeNonce;
  if (request.status === "PENDING_CHALLENGE") {
    if (typeof nonce !== "string" || nonce.length < 16) {
      throw new Error(`${context} awaits a challenge without a usable nonce`);
    }
  } else if (nonce !== undefined) {
    throw new Error(`${context} keeps a nonce after the challenge stage; a consumed nonce must be gone`);
  }
  const verifiedAt = Date.parse(String(request.challengeVerifiedAt ?? ""));
  const verified = Number.isFinite(verifiedAt);
  if ((request.status === "PENDING_APPROVAL" || request.status === "APPROVED") && !verified) {
    throw new Error(`${context} passed the challenge stage without a verification time`);
  }
  if (!verified) {
    // Without a verified challenge there can be no grant, no recorded method and
    // no key fingerprint: an EXPIRED or REJECTED request must look like one.
    if (request.grant !== undefined || request.localAuthMethod !== undefined
      || request.challengeKeyFingerprint !== undefined) {
      throw new Error(`${context} records challenge evidence without a verified challenge`);
    }
  }
  const grant = isRecord(request.grant) ? request.grant : undefined;
  if (request.status === "APPROVED" && !grant) {
    throw new Error(`${context} is APPROVED without a grant`);
  }
  if (grant) {
    const grantedAt = Date.parse(String(grant.grantedAt));
    const expiresAt = Date.parse(String(grant.expiresAt));
    if (!Number.isFinite(grantedAt) || !Number.isFinite(expiresAt)) {
      throw new Error(`${context}.grant must carry ISO timestamps`);
    }
    if (expiresAt <= grantedAt) throw new Error(`${context}.grant expires before it starts`);
    if (expiresAt - grantedAt > 24 * 60 * 60 * 1_000) {
      throw new Error(`${context}.grant exceeds the 24-hour read-only ceiling`);
    }
    if (grant.mode !== "READ_ONLY") throw new Error(`${context}.grant must be read-only`);
  }
};

/**
 * A security log entry is validated against a CLOSED key set.
 *
 * The retention rule is "six months, no sensitive body"; the only way to keep that
 * true after the fact is to refuse to store anything outside the vocabulary.  An
 * extra `body` or `authorization` key is a hard error at write time.
 */
const SECURITY_LOG_KEYS = new Set([
  "entryId", "occurredAt", "event", "outcome", "subjectId", "reasonCode", "route", "sourceClass"
]);
const validateSecurityLogRecord: RecordValidator = (entry, context) => {
  for (const key of Object.keys(entry)) {
    if (!SECURITY_LOG_KEYS.has(key)) {
      throw new Error(`${context}.${key} is not part of the security log vocabulary`);
    }
  }
  for (const key of ["entryId", "occurredAt", "event", "outcome"]) {
    requireString(entry, key, context);
  }
  if (!Number.isFinite(Date.parse(String(entry.occurredAt)))) {
    throw new Error(`${context}.occurredAt must be an ISO date`);
  }
  if (!["AUTH_REJECTED", "SESSION_REPLAY_REJECTED", "SCOPE_REJECTED", "OPERATOR_REJECTED",
    "RATE_LIMIT_EXCEEDED", "PROXY_HEADER_REJECTED", "REQUEST_REJECTED",
    "SELF_ACCESS_CHALLENGE_REJECTED", "MEDIA_STORE_UNAVAILABLE", "SECURITY_LOG_RETENTION"]
    .includes(String(entry.event))) {
    throw new Error(`${context}.event is unsupported`);
  }
  if (!["DENIED", "ALLOWED"].includes(String(entry.outcome))) {
    throw new Error(`${context}.outcome is unsupported`);
  }
  for (const key of ["subjectId", "reasonCode", "route"]) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      throw new Error(`${context}.${key} must be a bounded non-empty string`);
    }
  }
  if (entry.sourceClass !== undefined
    && !["LOOPBACK_PROXY", "DIRECT", "UNKNOWN"].includes(String(entry.sourceClass))) {
    throw new Error(`${context}.sourceClass is unsupported`);
  }
};

/**
 * A team signal carries no free text, so the validator's job is to keep it that
 * way: a closed key set, a closed kind set, and no field for a message.  It also
 * enforces the retention boundary (a signal never outlives the event by more than
 * its TTL), so a malformed row cannot become a permanent message history.
 */
const TEAM_SIGNAL_KEYS = new Set([
  "signalId", "eventId", "senderDeviceInstanceId", "senderUserId", "kind",
  "createdAt", "expiresAt", "acknowledgedByDeviceIds"
]);
const validateTeamSignalRecord: RecordValidator = (signal, context) => {
  for (const key of Object.keys(signal)) {
    if (!TEAM_SIGNAL_KEYS.has(key)) {
      throw new Error(`${context}.${key} is not part of the preset-signal vocabulary`);
    }
  }
  for (const key of ["signalId", "eventId", "senderDeviceInstanceId", "createdAt", "expiresAt"]) {
    requireString(signal, key, context);
  }
  const createdAt = Date.parse(String(signal.createdAt));
  const expiresAt = Date.parse(String(signal.expiresAt));
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    throw new Error(`${context} timestamps must be ISO dates`);
  }
  if (expiresAt <= createdAt) throw new Error(`${context}.expiresAt must be after createdAt`);
  if (!["ACCEPTED_TASK", "ON_MY_WAY", "ARRIVED_AT_PATIENT", "AED_ACQUIRED",
    "NEED_HELP_HERE", "CANNOT_CONTINUE"].includes(String(signal.kind))) {
    throw new Error(`${context}.kind is not a preset team signal`);
  }
  if (!Array.isArray(signal.acknowledgedByDeviceIds)
    || signal.acknowledgedByDeviceIds.some(value => typeof value !== "string")) {
    throw new Error(`${context}.acknowledgedByDeviceIds must be a string array`);
  }
};

const validateDeliveryRecord: RecordValidator = (delivery, context) => {
    for (const key of ["id", "eventId", "deviceInstanceId", "status", "statusOccurredAt"]) {
      requireString(delivery, key, context);
    }
    if (!isRecord(delivery.request)) throw new Error(`${context}.request must be an object`);
    try {
      responseRequestSchema.parse(delivery.request);
    } catch {
      throw new Error(`${context}.request does not match the current least-privilege offer schema`);
    }
  };
const validateAssignmentRecord: RecordValidator = (assignment, context) => {
    for (const key of [
      "id",
      "eventId",
      "deviceInstanceId",
      "role",
      "status",
      "createdAt",
      "updatedAt"
    ]) requireString(assignment, key, context);
    if (!Number.isInteger(assignment.revision)) {
      throw new Error(`${context}.revision must be an integer`);
    }
  };


/**
 * Storage-key/identity agreement, extracted from validateState so both the
 * whole-state load path and the incremental change-set path share one rule.
 */
export function assertEntityIdentity(collection: string, key: string, record: unknown): void {
  if (!isRecord(record)) return; // shape errors belong to the record validator
  switch (collection) {
    case "eventEvidenceLogById": {
      const row = evidenceLogSchema.parse(record);
      if (row.id !== key || row.id !== `${row.eventId}:${row.sequence}`) throw new Error("Evidence storage key mismatch");
      return;
    }
    case "eventEvidenceHeadsById": {
      const row = evidenceHeadSchema.parse(record);
      if (row.eventId !== key || row.id !== `${row.eventId}:${row.sequence}`) throw new Error("Evidence head storage key mismatch");
      return;
    }
    case "aedAssetsById": {
      if (aedAssetSchema.parse(record).aedId !== key) throw new Error("AED asset storage key mismatch");
      return;
    }
    case "deletionRequestsById": {
      const row = record as { requestId?: unknown; userId?: unknown; status?: unknown };
      if (row.requestId !== key || typeof row.userId !== "string" || !row.userId
        || !["REQUESTED", "CLOSED"].includes(String(row.status))) {
        throw new Error("Deletion request storage key does not match its identity");
      }
      return;
    }
    case "notificationOutboxById": {
      const row = notificationRecordSchema.parse(record);
      if (row.id !== key) throw new Error("Notification storage key does not match its identity");
      return;
    }
    case "positionUpdateReceiptsById": {
      if (record.watchFallbackFact === undefined) return;
      const fact = watchFallbackPositionUpdateSchema.parse(record.watchFallbackFact);
      if (fact.positionUpdateId !== key || fact.eventId !== record.eventId || record.kind !== "P"
        || fingerprint({ deviceInstanceId: record.deviceInstanceId, source: "WATCH_FALLBACK", ...fact })
          !== record.fingerprint) {
        throw new Error(`Watch fallback fact ${key} does not match its original receipt`);
      }
      isoDateSchema.parse(record.recordedAt);
      return;
    }
    default:
      return;
  }
}


/**
 * A reconciliation record is a derived verdict, not evidence.
 *
 * The rules that matter are the ones that stop a verdict from being quietly
 * rewritten into a better story: it may gain a revision and may replace a
 * provisional gap with a real fact, but it may never reduce how many facts were
 * counted as received, and it may never be deleted.
 */
const validatePositionWindowReconciliation: RecordValidator = (record, context) => {
  for (const key of [
    "reconciliationId", "eventId", "userId", "deviceInstanceId", "kind",
    "windowStartedAt", "windowEndedAt", "reconciledAt", "closedBy", "graceDeadlineAt"
  ]) requireString(record, key, context);
  if (record.kind !== "P" && record.kind !== "R") {
    throw new Error(`${context}.kind is unsupported`);
  }
  if (!["EVENT_TERMINAL", "PARTICIPANT_EXIT", "CLIENT_COMPLETE_SIGNAL"].includes(String(record.closedBy))) {
    throw new Error(`${context}.closedBy is unsupported`);
  }
  const counts: Record<string, number> = {};
  for (const key of [
    "expectedSlotCount", "receivedSlotCount", "receivedRecordCount",
    "noFixSlotCount", "fixSlotCount", "revision"
  ]) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${context}.${key} must be a non-negative integer`);
    }
    counts[key] = value;
  }
  if (counts.receivedSlotCount! > counts.expectedSlotCount!) {
    throw new Error(`${context}.receivedSlotCount cannot exceed expectedSlotCount`);
  }
  if (counts.fixSlotCount! + counts.noFixSlotCount! !== counts.receivedSlotCount!) {
    throw new Error(`${context} received slots must be split between FIX and NO_NEW_FIX`);
  }
  if (typeof record.final !== "boolean" || typeof record.correctedByLateEvidence !== "boolean") {
    throw new Error(`${context}.final and .correctedByLateEvidence must be booleans`);
  }
  if (!Array.isArray(record.gaps)) throw new Error(`${context}.gaps must be an array`);
  const seenSlots = new Set<string>();
  for (const [index, gap] of record.gaps.entries()) {
    if (!isRecord(gap)) throw new Error(`${context}.gaps.${index} must be an object`);
    requireString(gap, "slotAt", `${context}.gaps.${index}`);
    if (!Number.isFinite(Date.parse(String(gap.slotAt)))) {
      throw new Error(`${context}.gaps.${index}.slotAt must be an ISO instant`);
    }
    if (typeof gap.provisional !== "boolean") {
      throw new Error(`${context}.gaps.${index}.provisional must be a boolean`);
    }
    if (!["NEVER_UPLOADED", "CLIENT_OFFLINE", "PERMISSION_REVOKED", "APP_NOT_RUNNING", "PROCESS_RESTART"]
      .includes(String(gap.reason))) {
      throw new Error(`${context}.gaps.${index}.reason is unsupported`);
    }
    if (seenSlots.has(String(gap.slotAt))) {
      throw new Error(`${context}.gaps must not repeat a slot`);
    }
    seenSlots.add(String(gap.slotAt));
  }
  if (record.gaps.length + counts.receivedSlotCount! !== counts.expectedSlotCount!) {
    throw new Error(`${context} every expected second must be a fact or a recorded gap`);
  }
};

const RECORD_VALIDATORS: Partial<Record<string, RecordValidator>> = {
  users: validateUserRecord,
  accounts: validateAccountRecord,
  authChallengesById: validateAuthChallengeRecord,
  companionLinkTicketsByHash: validateCompanionLinkTicketRecord,
  participantExitsById: validateParticipantExitRecord,
  participantIntervalsById: validateParticipantIntervalRecord,
  eventPositionBatchesById: validateEventPositionBatchRecord,
  devices: validateDeviceRecord,
  sessionsByTokenHash: validateSessionRecord,
  events: validateEventRecord,
  deliveries: validateDeliveryRecord,
  assignments: validateAssignmentRecord,
  eventEvidenceLogById: record => { evidenceLogSchema.parse(record); },
  eventEvidenceHeadsById: record => { evidenceHeadSchema.parse(record); },
  aedAssetActionsById: record => { aedAssetActionRecordSchema.parse(record); },
  aedAssetsById: (record) => { aedAssetSchema.parse(record); },
  retentionPurgesById: validateRetentionPurgeRecord,
  selfAccessRequestsById: validateSelfAccessRequestRecord,
  securityLogById: validateSecurityLogRecord,
  teamSignalsById: validateTeamSignalRecord,
  appleRevocationsById: validateAppleRevocationRecord,
  rerouteProposalsById: validateRerouteProposalRecord,
  positionWindowReconciliationsById: validatePositionWindowReconciliation
};

/**
 * Incremental counterpart of validateState(): validates only the entities a
 * transaction actually changed.  Rules are the same functions the whole-state
 * path uses, so the two cannot diverge.
 */
export function validateEntityChange(collection: string, key: string, after: unknown): void {
  if (after === undefined) return; // deletion carries no record shape
  assertEntityIdentity(collection, key, after);
  const validator = RECORD_VALIDATORS[collection];
  if (!validator) return;
  storageMetrics.validatedEntities += 1;
  validator(after as Record<string, unknown>, `state.${collection}.${key}`);
}

/**
 * Shadow validation: before committing an incremental change set, materialise the
 * candidate state and run the original whole-state checks over it.  This is a
 * TEMPORARY safety net for development and test runs only; it is deliberately
 * disabled in production and must be reported as OFF for performance runs, since
 * it re-introduces exactly the whole-state cost this refactor removes.
 */
let shadowValidationEnabled = process.env.NODE_ENV !== "production";

export function setShadowValidationEnabled(enabled: boolean): void {
  shadowValidationEnabled = enabled;
}

export function isShadowValidationEnabled(): boolean {
  return shadowValidationEnabled;
}

/** Applies a change set to a state tree, returning the mutated tree. */
/**
 * Publishes a change set into the in-memory state.
 *
 * The change set arrives in canonical (collection, key) order, which is what makes
 * persistence, snapshots and diagnostics deterministic.  That order is NOT the order
 * new entities were created in, and for a string-keyed collection the two are
 * observably different: publishing in canonical order would append new keys in
 * id-sorted order (random UUIDs), so `Object.values(deliveries)` after a transaction
 * would not match the order the offers were actually made in.
 *
 * So the two orders are separated rather than reconciled:
 *
 *   - updates and deletions are applied first, in canonical order.  Assigning to an
 *     existing key does not move it, and deleting never moves anything, so neither
 *     can disturb the enumeration order of what survives;
 *   - NEW keys are then applied in `mutationOrdinal` order, which is the order this
 *     transaction first staged them, restoring creation order exactly.
 *
 * `mutationOrdinal` is assigned once per entity and never reassigned, so
 * create-then-update keeps the position of the create.
 */
function applyChangesToState(
  state: PersistentState,
  changes: readonly EntityChange[]
): void {
  const publish = (change: EntityChange): void => {
    const records = state[change.collection] as unknown as Record<string, unknown>;
    if (change.after === undefined) delete records[change.key];
    else records[change.key] = change.after;
  };
  const insertions: EntityChange[] = [];
  for (const change of changes) {
    // A new key is one that had no committed value before and has one now.
    if (change.before === undefined && change.after !== undefined) insertions.push(change);
    else publish(change);
  }
  insertions.sort((left, right) => left.mutationOrdinal - right.mutationOrdinal);
  for (const change of insertions) publish(change);
}

/**
 * Validates a change set in isolation: per-entity rules for every changed entity,
 * plus the shared evidence-immutability rules.  Never touches the whole state.
 */
function validateChangeSet(
  changes: readonly EntityChange[],
  purgeAuthorisedEventIds?: PurgeAuthorisedEventIds
): void {
  for (const change of changes) {
    validateEntityChange(change.collection, change.key, change.after);
    if (SHADOW_GUARDED_COLLECTIONS.has(change.collection)) {
      assertEntityWriteAllowed(
        change.collection as GuardedCollection,
        change.key,
        change.before,
        change.after,
        purgeAuthorisedEventIds
      );
    }
  }
}

const SHADOW_GUARDED_COLLECTIONS = new Set<string>([
  "positionUpdateReceiptsById",
  "notificationOutboxById",
  "deletionRequestsById",
  "events",
  "eventPositionBatchesById",
  "quarantinedLegacyEventPositionBatchesById",
  "participantIntervalsById"
,
  "timelineByEventId", "retentionPurgesById", "eventEvidenceLogById", "eventEvidenceHeadsById", "aedAssetActionsById",
  "positionWindowReconciliationsById"
]);

function validateState(value: unknown): PersistentState {
  value = normalizeState(value);
  if (!isRecord(value) || value.schemaVersion !== "2.0") {
    throw new Error("unsupported state schema");
  }
  validateRecordValues(value.eventEvidenceLogById, "state.eventEvidenceLogById", record => { evidenceLogSchema.parse(record); });
  validateRecordValues(value.eventEvidenceHeadsById, "state.eventEvidenceHeadsById", record => { evidenceHeadSchema.parse(record); });
  validateRecordValues(value.aedAssetActionsById, "state.aedAssetActionsById", record => { aedAssetActionRecordSchema.parse(record); });
  validateRecordValues(value.aedAssetsById, "state.aedAssetsById", record => { aedAssetSchema.parse(record); });
  validateRecordValues(value.retentionPurgesById, "state.retentionPurgesById", validateRetentionPurgeRecord);
  validateRecordValues(value.selfAccessRequestsById, "state.selfAccessRequestsById", validateSelfAccessRequestRecord);
  validateRecordValues(value.securityLogById, "state.securityLogById", validateSecurityLogRecord);
  validateRecordValues(value.teamSignalsById, "state.teamSignalsById", validateTeamSignalRecord);
  validateRecordValues(value.appleRevocationsById, "state.appleRevocationsById", validateAppleRevocationRecord);
  validateRecordValues(value.rerouteProposalsById, "state.rerouteProposalsById", validateRerouteProposalRecord);
  validateRecordValues(value.aedHandoversById, "state.aedHandoversById", validateAedHandoverRecord);
  validateRecordValues(value.aedPhotoReferencesByObjectKey, "state.aedPhotoReferencesByObjectKey", validateAedPhotoReferenceRecord);
  validateRecordValues(value.aedTemporaryPointDepositsById, "state.aedTemporaryPointDepositsById", validateAedTemporaryPointDepositRecord);
  validateRecordValues(value.aedTemporaryPointFollowUpsById, "state.aedTemporaryPointFollowUpsById", validateAedTemporaryPointFollowUpRecord);
  validateRecordValues(value.accessAuditById, "state.accessAuditById", validateAccessAuditRecord);
  validateRecordValues(value.breakGlassGrantsById, "state.breakGlassGrantsById", validateBreakGlassGrantRecord);
  validateRecordValues(value.positionWindowReconciliationsById,
    "state.positionWindowReconciliationsById", validatePositionWindowReconciliation);
  for (const key of [
    "users",
    "accounts",
    "accountIdByProviderKey",
    "authChallengesById",
    "companionLinkTicketsByHash",
    "devices",
    "sessionsByTokenHash",
    "events",
    "deliveries",
    "assignments",
    "timelineByEventId",
    "aedReceiptsById",
    "aedReceiptIdByBusinessKey",
    "aedReceiptIdByEventAed",
    "aedUnavailableByReportId",
    "resolutionsById",
    "notificationOutboxById",
    "participantExitsById",
    "participantIntervalsById",
    "eventPositionBatchesById",
    "quarantinedLegacyEventPositionBatchesById",
    "positionUpdateReceiptsById",
    "presenceUpdateReceiptsById",
    "deletionRequestsById"
  ]) {
    if (!isRecord(value[key])) throw new Error(`state.${key} must be an object`);
  }
  for (const [id, raw] of Object.entries(value.deletionRequestsById as Record<string, unknown>)) {
    assertEntityIdentity("deletionRequestsById", id, raw);
  }
  for (const [id, raw] of Object.entries(value.notificationOutboxById as Record<string, unknown>)) {
    assertEntityIdentity("notificationOutboxById", id, raw);
  }
  for (const [id, receipt] of Object.entries(value.positionUpdateReceiptsById as Record<string, unknown>)) {
    assertEntityIdentity("positionUpdateReceiptsById", id, receipt);
  }
  validateRecordValues(value.users, "state.users", validateUserRecord);
  validateRecordValues(value.accounts, "state.accounts", validateAccountRecord);;
  validateRecordValues(value.authChallengesById, "state.authChallengesById", validateAuthChallengeRecord);;
  validateRecordValues(value.companionLinkTicketsByHash, "state.companionLinkTicketsByHash", validateCompanionLinkTicketRecord);;
  for (const timeline of Object.values(value.timelineByEventId as Record<string, unknown>)) {
    if (!Array.isArray(timeline)) throw new Error("state.timelineByEventId values must be arrays");
    for (const entry of timeline) {
      if (!isRecord(entry)) throw new Error("state.timeline entries must be objects");
      for (const key of ["id", "eventId", "occurredAt", "kind", "message"]) {
        requireString(entry, key, "state.timeline entry");
      }
    }
  }
  validateRecordValues(value.participantExitsById, "state.participantExitsById", validateParticipantExitRecord);;
  validateRecordValues(value.participantIntervalsById, "state.participantIntervalsById", validateParticipantIntervalRecord);;
  validateRecordValues(value.eventPositionBatchesById, "state.eventPositionBatchesById", validateEventPositionBatchRecord);;
  validateRecordValues(value.devices, "state.devices", validateDeviceRecord);;
  validateRecordValues(value.sessionsByTokenHash, "state.sessionsByTokenHash", validateSessionRecord);;
  validateRecordValues(value.events, "state.events", validateEventRecord);;
  validateRecordValues(value.deliveries, "state.deliveries", validateDeliveryRecord);;
  validateRecordValues(value.assignments, "state.assignments", validateAssignmentRecord);;
  aedSchema.array().parse(value.aeds);
  return value as unknown as PersistentState;
}

async function readValidatedState(path: string): Promise<PersistentState> {
  return validateState(JSON.parse(await readFile(path, "utf8")));
}

export class MemoryStateStore implements StateStore {
  private evidenceSigner: EvidenceSigner | undefined;
  private evidenceNow: () => Date = () => new Date();
  configureEvidence(signer: EvidenceSigner, now: () => Date): void { this.evidenceSigner = signer; this.evidenceNow = now; }

  private state: PersistentState;
  private readonly projectionRegistry = new ProjectionRegistry();
  private readonly expiryIndex = new PositionExpiryIndex(600_000);
  private readonly positionIndex = new DevicePositionIndex();
  private readonly assignments = new AssignmentIndex();
  private readonly deliveries = new DeliveryIndex();
  private queue: Promise<void> = Promise.resolve();

  constructor(initialState: PersistentState = emptyState()) {
    this.state = validateState(initialState);
    this.projectionRegistry.attachSource(() => this.state);
    this.expiryIndex.rebuild(this.state.devices as never);
    this.positionIndex.rebuild(this.state.devices as never);
    this.positionIndex.rebuild(this.state.devices as never);
    this.assignments.rebuild(this.state as never);
    this.deliveries.rebuild(this.state as never);
  }

  projections(): ProjectionRegistry {
    return this.projectionRegistry;
  }

  positionExpiry(): PositionExpiryIndex {
    return this.expiryIndex;
  }

  devicePositions(): DevicePositionIndex {
    return this.positionIndex;
  }

  assignmentIndex(): AssignmentIndex {
    return this.assignments;
  }

  deliveryIndex(): DeliveryIndex {
    return this.deliveries;
  }

  read<T>(reader: (state: Readonly<PersistentState>) => T): T {
    return reader(cloneState(this.state, "storeRead"));
  }

  readEntities<T>(reader: (view: StateReadView) => T): T {
    return reader(createStateReadView(this.state));
  }

  transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = cloneState(this.state, "transactionDraft");
      const result = await mutation(draft);
      if (this.evidenceSigner) captureDraftEvidence(this.state, draft, this.evidenceSigner, this.evidenceNow());
      const validated = validateState(draft);
      assertAppendOnlyHistory(this.state, validated);
      if (isDeepStrictEqual(this.state, validated)) return result;
      this.state = validated;
      this.projectionRegistry.invalidateAll();
      this.projectionRegistry.rebuildAll();
      this.expiryIndex.rebuild(this.state.devices as never);
      this.positionIndex.rebuild(this.state.devices as never);
      this.assignments.rebuild(this.state as never);
      // Deliveries too.  Omitting this left the delivery index stale after every
      // whole-state commit, which nothing noticed while the only readers scanned
      // `state.deliveries` directly.  The moment a route reads deliveries through the
      // index - as the transaction-backed recruitment adapter does - an offer created
      // on this route becomes invisible, and the recruitment guard happily creates a
      // second one for the same (event, device).
      this.deliveries.rebuild(this.state as never);
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  transactEntities<T>(mutation: (tx: EntityTransaction) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const tx = new EntityTransaction(createStateReadView(this.state));
      let result: T;
      try {
        result = await mutation(tx);
        if (this.evidenceSigner) captureTransactionEvidence(tx, this.evidenceSigner, this.evidenceNow());
      } catch (error) {
        tx.seal();          // discard: nothing was applied to committed state
        throw error;
      }
      const changes = tx.seal();
      if (changes.length === 0) return result;
      validateChangeSet(changes, authorisedPurgeEventIds(this.state));
      if (shadowValidationEnabled) {
        storageMetrics.shadowValidationRuns += 1;
        const candidate = cloneState(this.state);
        applyChangesToState(candidate, changes);
        const validated = validateState(candidate);
        assertAppendOnlyHistory(this.state, validated);
      }
      applyChangesToState(this.state, changes);
      this.projectionRegistry.applyChanges(changes);
      this.expiryIndex.applyDeviceChanges(
        changes.filter(change => change.collection === "devices"));
      this.positionIndex.applyDeviceChanges(
        changes.filter(change => change.collection === "devices"));
      this.assignments.applyChanges(
        changes.filter(change => change.collection === "assignments"),
        changes.filter(change => change.collection === "devices"));
      this.deliveries.applyChanges(
        changes.filter(change => change.collection === "deliveries"),
        changes.filter(change => change.collection === "devices"),
        {
          delivery: id => this.state.deliveries[id] as never,
          device: id => this.state.devices[id] as never
        });
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}



export class JsonFileStateStore implements StateStore {
  private evidenceSigner: EvidenceSigner | undefined;
  private evidenceNow: () => Date = () => new Date();
  configureEvidence(signer: EvidenceSigner, now: () => Date): void { this.evidenceSigner = signer; this.evidenceNow = now; }
  private state: PersistentState;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    initialState: PersistentState
  ) {
    this.state = initialState;
  }

  static async open(filePath: string, seedAeds: Aed[]): Promise<JsonFileStateStore> {
    await mkdir(dirname(filePath), { recursive: true });
    let state: PersistentState;
    let mainFailure: unknown;
    let recoveredFromBackup = false;
    try {
      state = await readValidatedState(filePath);
    } catch (error) {
      mainFailure = error;
      try {
        state = await readValidatedState(`${filePath}.bak`);
        recoveredFromBackup = true;
      } catch (backupError) {
        const mainMissing = (mainFailure as NodeJS.ErrnoException).code === "ENOENT";
        const backupMissing = (backupError as NodeJS.ErrnoException).code === "ENOENT";
        if (!mainMissing || !backupMissing) {
          throw new Error(
            `AEDResponse state and backup are unreadable; refusing to reset durable truth: ${
              mainFailure instanceof Error ? mainFailure.message : String(mainFailure)
            }; backup: ${backupError instanceof Error ? backupError.message : String(backupError)}`
          );
        }
        state = emptyState(structuredClone(seedAeds));
      }
    }
    if (state.aeds.length === 0 && seedAeds.length > 0) {
      state.aeds = structuredClone(seedAeds);
    }
    if (recoveredFromBackup) {
      await unlink(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    const store = new JsonFileStateStore(filePath, state);
    await store.persist(state);
    return store;
  }

  read<T>(reader: (state: Readonly<PersistentState>) => T): T {
    return reader(cloneState(this.state, "storeRead"));
  }

  readEntities<T>(reader: (view: StateReadView) => T): T {
    return reader(createStateReadView(this.state));
  }

  transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = cloneState(this.state, "transactionDraft");
      const result = await mutation(draft);
      if (this.evidenceSigner) captureDraftEvidence(this.state, draft, this.evidenceSigner, this.evidenceNow());
      const validated = validateState(draft);
      assertAppendOnlyHistory(this.state, validated);
      if (isDeepStrictEqual(this.state, validated)) return result;
      await this.persist(validated);
      this.state = validated;
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(state: PersistentState): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await copyFile(this.filePath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      await unlink(this.filePath).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      });
      try {
        await rename(temporaryPath, this.filePath);
      } catch (replacementError) {
        await copyFile(backupPath, this.filePath).catch(() => undefined);
        throw replacementError;
      }
    }
  }
}

const recordCollections = [
  "users",
  "accounts",
  "accountIdByProviderKey",
  "authChallengesById",
  "companionLinkTicketsByHash",
  "devices",
  "sessionsByTokenHash",
  "events",
  "deliveries",
  "assignments",
  "timelineByEventId",
  "aedReceiptsById",
  "aedReceiptIdByBusinessKey",
  "aedReceiptIdByEventAed",
  "aedUnavailableByReportId",
  "resolutionsById",
  "notificationOutboxById",
  "participantExitsById",
  "participantIntervalsById",
  "eventPositionBatchesById",
  "quarantinedLegacyEventPositionBatchesById",
  "positionUpdateReceiptsById",
  "presenceUpdateReceiptsById"
,
  "deletionRequestsById", "retentionPurgesById", "aedAssetsById", "eventEvidenceLogById", "eventEvidenceHeadsById", "aedAssetActionsById",
  "positionWindowReconciliationsById",
  // These collections are declared in PersistentState and written by their own
  // modules, but were missing from this load whitelist, so opening an existing
  // SQLite file threw "Unsupported SQLite state collection" for any state that
  // already held a row.  A load whitelist that lags the state shape turns every
  // restart into a crash, so the list is kept complete here.
  "appleRevocationsById", "rerouteProposalsById", "accessAuditById", "breakGlassGrantsById",
  "selfAccessRequestsById", "securityLogById", "teamSignalsById",
  // G09 handover and media facts.
  "aedHandoversById", "aedTemporaryPointDepositsById", "aedTemporaryPointFollowUpsById",
  "aedPhotoReferencesByObjectKey"
] as const;

type RecordCollection = typeof recordCollections[number];

interface SqliteStateItem {
  collection: string;
  item_key: string;
  payload: string;
}

function flattenState(state: PersistentState): Map<string, SqliteStateItem> {
  storageMetrics.fullStateFlattens += 1;
  const items = new Map<string, SqliteStateItem>();
  for (const collection of recordCollections) {
    const records = state[collection] as Record<string, unknown>;
    for (const [key, value] of Object.entries(records)) {
      storageMetrics.serializedEntities += 1;
      const item = { collection, item_key: key, payload: JSON.stringify(value) };
      items.set(`${collection}\u0000${key}`, item);
    }
  }
  for (const aed of state.aeds) {
    storageMetrics.serializedEntities += 1;
    const item = { collection: "aeds", item_key: aed.id, payload: JSON.stringify(aed) };
    items.set(`aeds\u0000${aed.id}`, item);
  }
  return items;
}

interface LoadedSqliteState {
  raw: PersistentState;
  state: PersistentState;
}

function stateFromItems(rows: SqliteStateItem[]): LoadedSqliteState {
  const raw = emptyState() as unknown as Record<string, unknown>;
  for (const row of rows) {
    const value: unknown = JSON.parse(row.payload);
    if (row.collection === "aeds") {
      (raw.aeds as unknown[]).push(value);
      continue;
    }
    if (!(recordCollections as readonly string[]).includes(row.collection)) {
      throw new Error(`Unsupported SQLite state collection ${row.collection}`);
    }
    const records = raw[row.collection] as Record<string, unknown>;
    Object.defineProperty(records, row.item_key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  }
  return {
    raw: raw as unknown as PersistentState,
    state: validateState(raw)
  };
}

function stateItemsEqual(left: PersistentState, right: PersistentState): boolean {
  const before = flattenState(left);
  const after = flattenState(right);
  if (before.size !== after.size) return false;
  for (const [identity, item] of before) {
    if (after.get(identity)?.payload !== item.payload) return false;
  }
  return true;
}

export class SQLiteStateStore implements StateStore {
  private evidenceSigner: EvidenceSigner | undefined;
  private evidenceNow: () => Date = () => new Date();
  configureEvidence(signer: EvidenceSigner, now: () => Date): void { this.evidenceSigner = signer; this.evidenceNow = now; }

  private state: PersistentState;
  /**
   * Cached committed rows avoid flattening the entire retained state merely to
   * discover that a transaction was a no-op.  The cache is advanced only
   * after the SQLite transaction commits successfully.
   */
  private flattenedState: Map<string, SqliteStateItem>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  private readonly projectionRegistry = new ProjectionRegistry();
  private readonly expiryIndex = new PositionExpiryIndex(600_000);
  private readonly positionIndex = new DevicePositionIndex();
  private readonly assignments = new AssignmentIndex();
  private readonly deliveries = new DeliveryIndex();

  private constructor(
    private readonly database: Database.Database,
    initialState: PersistentState
  ) {
    this.state = cloneState(initialState, "storeOpen");
    this.flattenedState = flattenState(this.state);
    this.projectionRegistry.attachSource(() => this.state);
    this.expiryIndex.rebuild(this.state.devices as never);
    this.positionIndex.rebuild(this.state.devices as never);
    this.assignments.rebuild(this.state as never);
    this.deliveries.rebuild(this.state as never);
  }

  static async open(
    filePath: string,
    seedAeds: Aed[],
    legacyJsonPath?: string
  ): Promise<SQLiteStateStore> {
    await mkdir(dirname(filePath), { recursive: true });
    const database = new Database(filePath);
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("busy_timeout = 5000");
      if (database.pragma("quick_check", { simple: true }) !== "ok") {
        throw new Error("SQLite quick_check failed; refusing to load durable truth");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS state_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state_items (
          collection TEXT NOT NULL,
          item_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (collection, item_key)
        );
      `);
      const format = database.prepare(
        "SELECT value FROM state_metadata WHERE key = 'storage_format_version'"
      ).get() as { value: string } | undefined;
      if (format && format.value !== "1") {
        throw new Error(`Unsupported SQLite storage format ${format.value}`);
      }
      const stateSchema = database.prepare(
        "SELECT value FROM state_metadata WHERE key = 'state_schema_version'"
      ).get() as { value: string } | undefined;
      if (stateSchema && stateSchema.value !== "2.0") {
        throw new Error(`Unsupported persisted state schema ${stateSchema.value}`);
      }
      const count = database.prepare("SELECT COUNT(*) AS count FROM state_items").get() as {
        count: number;
      };
      let state: PersistentState;
      if (count.count === 0) {
        state = legacyJsonPath
          ? await readValidatedState(legacyJsonPath).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return emptyState(structuredClone(seedAeds));
            }
            throw new Error(
              `Legacy JSON state is unreadable; refusing an empty SQLite replacement: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          })
          : emptyState(structuredClone(seedAeds));
        if (state.aeds.length === 0 && seedAeds.length > 0) {
          state.aeds = structuredClone(seedAeds);
        }
        const store = new SQLiteStateStore(database, state);
        store.persistInitial(state);
        return store;
      }

      const rows = database.prepare(
        "SELECT collection, item_key, payload FROM state_items"
      ).all() as SqliteStateItem[];
      const loaded = stateFromItems(rows);
      state = loaded.state;
      const store = new SQLiteStateStore(database, state);
      let nextState = state;
      if (nextState.aeds.length === 0 && seedAeds.length > 0) {
        nextState = cloneState(nextState, "storeSeed");
        nextState.aeds = structuredClone(seedAeds);
      }
      if (!stateItemsEqual(loaded.raw, nextState)) {
        store.flattenedState = flattenState(loaded.raw);
        store.persistChanges(loaded.raw, nextState);
        store.state = nextState;
      }
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  read<T>(reader: (state: Readonly<PersistentState>) => T): T {
    if (this.closed) throw new Error("SQLite state store is closed");
    return reader(cloneState(this.state, "storeRead"));
  }

  readEntities<T>(reader: (view: StateReadView) => T): T {
    if (this.closed) throw new Error("SQLite state store is closed");
    return reader(createStateReadView(this.state));
  }

  transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("SQLite state store is closing or closed"));
    }
    // Queue wait is reported separately from service time: acceptance compares
    // service time, so the two must never be conflated.
    const measuring = isInstrumentationEnabled();
    const enqueuedAt = measuring ? performance.now() : 0;
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error("SQLite state store is closed");
      // When instrumentation is off, no timing syscalls run at all.  This is the
      // A/B switch used to quantify the instrumentation's own cost; reports must
      // state which mode produced them.
      if (!measuring) {
        const draft = cloneState(this.state, "transactionDraft");
        const result = await mutation(draft);
        if (this.evidenceSigner) captureDraftEvidence(this.state, draft, this.evidenceSigner, this.evidenceNow());
        const validated = validateState(draft);
        assertAppendOnlyHistory(this.state, validated);
        this.persistChanges(this.state, validated);
        this.state = validated;
        // Instrumentation must not decide whether committed indexes stay current.
        this.projectionRegistry.invalidateAll();
      this.projectionRegistry.rebuildAll();
        this.expiryIndex.rebuild(this.state.devices as never);
        this.positionIndex.rebuild(this.state.devices as never);
        this.assignments.rebuild(this.state as never);
        this.deliveries.rebuild(this.state as never);
        return result;
      }
      const serviceStart = performance.now();
      storageMetrics.transactions += 1;
      const queueWait = serviceStart - enqueuedAt;
      storageMetrics.queueWaitMs += queueWait;
      storageMetrics.lastTransactionQueueWaitMs = queueWait;

      const cloneStart = performance.now();
      const draft = cloneState(this.state, "transactionDraft");
      storageMetrics.cloneMs += performance.now() - cloneStart;

      const mutationStart = performance.now();
      const result = await mutation(draft);
      storageMetrics.mutationMs += performance.now() - mutationStart;

      const validateStart = performance.now();
      if (this.evidenceSigner) captureDraftEvidence(this.state, draft, this.evidenceSigner, this.evidenceNow());
      const validated = validateState(draft);
      storageMetrics.validateMs += performance.now() - validateStart;

      const historyStart = performance.now();
      assertAppendOnlyHistory(this.state, validated);
      storageMetrics.historyMs += performance.now() - historyStart;

      const persistStart = performance.now();
      this.persistChanges(this.state, validated);
      storageMetrics.persistMs += performance.now() - persistStart;

      this.state = validated;
      // The whole-state path already pays O(E); marking stale defers the index
      // rebuild to the next read instead of adding a second full pass here.
      this.projectionRegistry.invalidateAll();
      this.projectionRegistry.rebuildAll();
      this.expiryIndex.rebuild(this.state.devices as never);
      this.positionIndex.rebuild(this.state.devices as never);
      this.assignments.rebuild(this.state as never);
      this.deliveries.rebuild(this.state as never);
      const serviceMs = performance.now() - serviceStart;
      storageMetrics.transactionServiceMs += serviceMs;
      storageMetrics.lastTransactionServiceMs = serviceMs;
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closing = this.queue.then(() => {
      if (!this.closed) this.database.close();
      this.closed = true;
    });
    return this.closing;
  }

  transactEntities<T>(mutation: (tx: EntityTransaction) => T | Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("SQLite state store is closing or closed"));
    }
    const enqueuedAt = isInstrumentationEnabled() ? performance.now() : 0;
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error("SQLite state store is closed");
      const serviceStart = isInstrumentationEnabled() ? performance.now() : 0;
      if (isInstrumentationEnabled()) {
        storageMetrics.transactions += 1;
        const queueWait = serviceStart - enqueuedAt;
        storageMetrics.queueWaitMs += queueWait;
        storageMetrics.lastTransactionQueueWaitMs = queueWait;
      }

      const tx = new EntityTransaction(createStateReadView(this.state));
      let result: T;
      try {
        result = await mutation(tx);
        if (this.evidenceSigner) captureTransactionEvidence(tx, this.evidenceSigner, this.evidenceNow());
      } catch (error) {
        tx.seal();          // discard: committed state and SQLite are untouched
        throw error;
      }
      const changes = tx.seal();
      // Empty change set: no validation, no serialization, no SQLite transaction.
      if (changes.length === 0) {
        if (isInstrumentationEnabled()) {
          storageMetrics.emptyChangeSetReturns += 1;
          this.finishTransaction(serviceStart);
        }
        return result;
      }

      const validateStart = isInstrumentationEnabled() ? performance.now() : 0;
      validateChangeSet(changes, authorisedPurgeEventIds(this.state));
      if (shadowValidationEnabled) {
        // Whole-state checks, clearly attributed: this is the temporary safety
        // net, not the normal path.  Kept off for performance runs.
        storageMetrics.shadowValidationRuns += 1;
        const candidate = cloneState(this.state, "other");
        applyChangesToState(candidate, changes);
        const validated = validateState(candidate);
        assertAppendOnlyHistory(this.state, validated);
      }
      if (isInstrumentationEnabled()) {
        storageMetrics.validateMs += performance.now() - validateStart;
      }

      const persistStart = isInstrumentationEnabled() ? performance.now() : 0;
      this.persistEntityChanges(changes);
      if (isInstrumentationEnabled()) {
        storageMetrics.persistMs += performance.now() - persistStart;
      }

      applyChangesToState(this.state, changes);
      this.projectionRegistry.applyChanges(changes);
      this.expiryIndex.applyDeviceChanges(
        changes.filter(change => change.collection === "devices"));
      this.positionIndex.applyDeviceChanges(
        changes.filter(change => change.collection === "devices"));
      this.assignments.applyChanges(
        changes.filter(change => change.collection === "assignments"),
        changes.filter(change => change.collection === "devices"));
      this.deliveries.applyChanges(
        changes.filter(change => change.collection === "deliveries"),
        changes.filter(change => change.collection === "devices"),
        {
          delivery: id => this.state.deliveries[id] as never,
          device: id => this.state.devices[id] as never
        });
      if (isInstrumentationEnabled()) this.finishTransaction(serviceStart);
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  projections(): ProjectionRegistry {
    return this.projectionRegistry;
  }

  positionExpiry(): PositionExpiryIndex {
    return this.expiryIndex;
  }

  devicePositions(): DevicePositionIndex {
    return this.positionIndex;
  }

  assignmentIndex(): AssignmentIndex {
    return this.assignments;
  }

  deliveryIndex(): DeliveryIndex {
    return this.deliveries;
  }

  private finishTransaction(serviceStart: number): void {
    const serviceMs = performance.now() - serviceStart;
    storageMetrics.transactionServiceMs += serviceMs;
    storageMetrics.lastTransactionServiceMs = serviceMs;
  }

  /**
   * Writes exactly the changed entities.  No whole-state flatten, no diff, and no
   * write at all when the change set is empty.  The committed flatten cache is
   * advanced by the same rows so the legacy whole-state path stays consistent.
   */
  private persistEntityChanges(changes: readonly EntityChange[]): void {
    const upsert = this.database.prepare(`
      INSERT INTO state_items(collection, item_key, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(collection, item_key) DO UPDATE SET payload = excluded.payload
    `);
    const remove = this.database.prepare(
      "DELETE FROM state_items WHERE collection = ? AND item_key = ?"
    );
    // Cache mutations and success metrics are staged here and applied only
    // after `write()` returns.  A rolled-back SQLite transaction must never
    // leave rows in the committed cache that durable storage does not hold:
    // the legacy whole-state path treats that cache as committed truth, so a
    // poisoned cache makes the next attempt skip the write entirely and the
    // change is lost on restart.
    const cacheUpserts: { identity: string; item: SqliteStateItem }[] = [];
    const cacheDeletes: string[] = [];
    let serialized = 0;
    let upserts = 0;
    let deletes = 0;
    let revisionUpdates = 0;
    const write = this.database.transaction(() => {
      for (const change of changes) {
        const identity = `${change.collection}\u0000${change.key}`;
        if (change.after === undefined) {
          remove.run(change.collection, change.key);
          cacheDeletes.push(identity);
          deletes += 1;
          continue;
        }
        const payload = JSON.stringify(change.after);
        serialized += 1;
        upsert.run(change.collection, change.key, payload);
        cacheUpserts.push({
          identity,
          item: { collection: change.collection, item_key: change.key, payload }
        });
        upserts += 1;
      }
      this.database.prepare(`
        INSERT INTO state_metadata(key, value) VALUES ('revision', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
      `).run();
      revisionUpdates += 1;
    });
    write();
    for (const identity of cacheDeletes) this.flattenedState.delete(identity);
    for (const update of cacheUpserts) this.flattenedState.set(update.identity, update.item);
    storageMetrics.serializedEntities += serialized;
    storageMetrics.businessEntityUpserts += upserts;
    storageMetrics.businessEntityDeletes += deletes;
    storageMetrics.revisionMetadataUpdates += revisionUpdates;
    storageMetrics.commitCalls += 1;
  }

  private persistInitial(state: PersistentState): void {
    const insert = this.database.prepare(
      "INSERT INTO state_items(collection, item_key, payload) VALUES (?, ?, ?)"
    );
    const write = this.database.transaction(() => {
      this.database.prepare(
        "INSERT OR REPLACE INTO state_metadata(key, value) VALUES ('storage_format_version', '1')"
      ).run();
      this.database.prepare(
        "INSERT OR REPLACE INTO state_metadata(key, value) VALUES ('state_schema_version', ?)"
      ).run(state.schemaVersion);
      this.database.prepare(
        "INSERT OR REPLACE INTO state_metadata(key, value) VALUES ('revision', '1')"
      ).run();
      for (const item of flattenState(state).values()) {
        insert.run(item.collection, item.item_key, item.payload);
      }
    });
    write();
  }

  private persistChanges(previous: PersistentState, next: PersistentState): void {
    // `previous` documents the state transition for callers; the committed
    // cache is the comparison authority and avoids a second full flatten.
    void previous;
    const before = this.flattenedState;
    const after = flattenState(next);
    if (before.size === after.size) {
      let unchanged = true;
      for (const [identity, item] of before) {
        if (after.get(identity)?.payload !== item.payload) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        storageMetrics.emptyChangeSetReturns += 1;
        return;
      }
    }
    const upsert = this.database.prepare(`
      INSERT INTO state_items(collection, item_key, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(collection, item_key) DO UPDATE SET payload = excluded.payload
    `);
    const remove = this.database.prepare(
      "DELETE FROM state_items WHERE collection = ? AND item_key = ?"
    );
    const write = this.database.transaction(() => {
      for (const [identity, item] of after) {
        if (before.get(identity)?.payload !== item.payload) {
          upsert.run(item.collection, item.item_key, item.payload);
          storageMetrics.businessEntityUpserts += 1;
        }
      }
      for (const [identity, item] of before) {
        if (!after.has(identity)) {
          remove.run(item.collection, item.item_key);
          storageMetrics.businessEntityDeletes += 1;
        }
      }
      this.database.prepare(`
        INSERT INTO state_metadata(key, value) VALUES ('revision', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
      `).run();
      storageMetrics.revisionMetadataUpdates += 1;
    });
    write();
    storageMetrics.commitCalls += 1;
    this.flattenedState = after;
  }
}
