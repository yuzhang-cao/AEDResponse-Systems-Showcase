/**
 * Runtime cost counters for the storage refactor (Phase 1).
 *
 * Design constraints agreed in review:
 *
 *  - Counters are incremented *inside loops that already exist* (validate,
 *    flatten, history compare, reconcile).  Instrumentation must never add a
 *    second `Object.values()` walk over the state, because that would perturb
 *    the very cost being measured.
 *  - There is deliberately no `clonedEntities` counter for whole-state clones:
 *    `cloneState` is a single `structuredClone` call with no loop to piggyback
 *    on, so counting entities would require its own full walk.
 *  - Whole-state clones ARE counted completely, classified by call site, so that
 *    "fullStateClones = 0" cannot be satisfied merely by renaming `cloneState`
 *    while a raw `structuredClone(wholeState)` still runs.
 *  - Timing segments never overlap.  `transactionServiceMs` covers only work done
 *    while holding the write queue; post-transaction response construction is
 *    reported separately as `postTransactionMs`, and the whole method as
 *    `operationElapsedMs`.  `normalizeState` runs inside `validateState`, so its
 *    cost is a sub-phase of `validateMs` and is never added to a total again.
 *  - SQLite counters separate business entity rows from metadata churn:
 *    `businessEntityUpserts` / `businessEntityDeletes` are business rows,
 *    `revisionMetadataUpdates` is the `state_metadata` revision bump, and
 *    `commitCalls` is the number of write transactions executed.  These are
 *    three different things and must not be collapsed into one number.
 */

export type FullStateCloneReason =
  | "transactionDraft"
  | "normalization"
  | "storeRead"
  | "storeOpen"
  | "storeSeed"
  | "other";

export type FullStateCloneCalls = Record<FullStateCloneReason, number>;

export interface StorageMetrics {
  /** Non-overlapping timing. */
  transactions: number;
  /** Time waiting for the single-writer queue (excluded from transaction service time). */
  queueWaitMs: number;
  /**
   * Duration of the most recent transaction only.  Lets a caller that owns one
   * operation subtract the store's contribution when computing its residual,
   * instead of mislabelling transaction time as "unattributed".
   */
  lastTransactionQueueWaitMs: number;
  lastTransactionServiceMs: number;
  /** Acquired execution -> transaction fully applied. Equals the sum of the phases below. */
  transactionServiceMs: number;
  cloneMs: number;
  mutationMs: number;
  validateMs: number;
  historyMs: number;
  persistMs: number;
  /** Whole-state clones, classified by call site. Acceptance requires all zero. */
  fullStateClones: FullStateCloneCalls;
  /** Per-batch clones inside normalizeState (not whole-state; tracked separately). */
  batchLevelClones: number;
  /** Whole-state flatten passes (serialize every entity into a Map). */
  fullStateFlattens: number;
  historyCompareCalls: number;
  emptyChangeSetReturns: number;
  /** Times the temporary pre-commit whole-state shadow check ran. */
  shadowValidationRuns: number;
  /** SQLite: three distinct numbers. */
  commitCalls: number;
  businessEntityUpserts: number;
  businessEntityDeletes: number;
  revisionMetadataUpdates: number;
  /** Entity counts, incremented only inside pre-existing loops. */
  validatedEntities: number;
  serializedEntities: number;
  historyComparedEntities: number;
}

/** Service-level scope, owned by the business method rather than the store. */
export interface OperationMetrics {
  calls: number;
  /** Whole method, entry -> return, including queue wait. */
  operationElapsedMs: number;
  /** Method entry -> just before the transaction is enqueued (auth, validation, fingerprint). */
  preTransactionMs: number;
  /** Notification outbox drain, which runs after the transaction releases the queue. */
  notificationDrainMs: number;
  /** Recruitment publication, also after the transaction. */
  recruitmentPublishMs: number;
  /** The response-stage narrow read + presenceView computation. */
  responseMs: number;
  /**
   * Residual: operationElapsedMs minus every segment above.  Kept explicit so an
   * unexplained interval can never be silently folded into a neighbouring phase.
   * Should be ~0 for a fully attributed path.
   */
  unattributedMs: number;
  /** Sub-phase of responseMs: entity loading/cloning inside the narrow accessor. */
  presenceAccessLoadMs: number;
  /** Sub-phase of responseMs: device records fetched on demand. */
  presenceDeviceLoads: number;
  /** Collection materialisations per call must stay <= 1. */
  presenceCollectionLoads: { events: number; deliveries: number; assignments: number };
  /** Standby path ran fully incrementally (no whole-state transaction). */
  incrementalPathRuns: number;
  /** Standby path had to use the whole-state path for a genuinely affected event. */
  /**
   * Business operations that actually ran recruitment through `transactEntities`
   * with a `TxRecruitmentContext`.
   *
   * Counted once per external operation, NOT per event refreshed: an operation that
   * touches three events is one run.  Per-event counting would make the number move
   * with data volume and stop describing how the work was done.
   */
  indexedRecruitmentRuns: number;

  /**
   * Operations that still use the whole-state path BY DESIGN.
   *
   * `tick()` is the standing example: it is scheduled maintenance over every event,
   * not a high-frequency single-device write, and it stays on the legacy context in
   * this batch.  These are not failures and must never be counted as fallbacks, or
   * the fallback number stops being an alert.
   */
  legacyRecruitmentRuns: number;

  /**
   * Operations that SHOULD have run indexed but fell back because a capability was
   * missing - no `transactEntities`, no projection support.
   *
   * This is the alerting number.  It deliberately excludes "an event was relevant
   * but the route is not migrated yet": that is `legacyRecruitmentRuns` during the
   * transition, and it becomes `indexedRecruitmentRuns` when the route is switched.
   */
  recruitmentFallbackRuns: number;
  /**
   * Assignment records actually inspected by the eligibility check.  With a
   * structural index this must track the device's own assignments, not the total
   * number retained — the whole point of step #3.
   */
  assignmentCandidatesVisited: number;

  /**
   * Delivery records actually inspected by the "has this identity already accepted
   * this event" scan.  Commit 1 must leave this at the full collection size; after
   * the Phase 2 transaction adapter it must drop to the event's own deliveries.
   */
  deliveryCandidatesVisited: number;

  /**
   * Devices handed out by `RecruitmentContext.candidateDevices`.
   *
   * A canary for accidental optimisation: the legacy adapter must keep returning
   * every device, so this stays at the full collection size until the Phase 2
   * transaction adapter replaces it.  A drop here during the abstraction commits
   * means an index was wired in early.
   */
  deviceCandidatesVisited: number;
  stateEntityLoads: number;
  stateFullCollectionKeyVisits: number;
  stateRelationKeyVisits: number;
  outboxScheduleVisits: number;

  /**
   * AED receipt rows inspected by the coordination summary's acquired-AED count.
   *
   * Instrumented from the start rather than added later: a counter the path never
   * increments makes every structural assertion built on it vacuous, which is exactly
   * how an earlier "access counts do not grow" test passed while measuring nothing.
   */
  aedReceiptCandidatesVisited: number;
  /** Retention sweeps that threw; the policy is only kept if this stays zero. */
  retentionSweepFailures: number;
  /** Events moved to the sealed layer / purged, cumulative since process start. */
  retentionSealedEvents: number;
  retentionPurgedEvents: number;
  /** Purges authorised but not yet deleted; must drain to zero. */
  retentionDeferredPurges: number;
  /** Reads of terminal events when the store has no relation index to use. */
  retentionCandidateReads: number;
  /** Participation-window verdicts recomputed, and the gaps they recorded. */
  positionWindowReconciliations: number;
  positionWindowGapsRecorded: number;
  /** Recomputations where a late-but-legal fact replaced a provisional gap. */
  positionWindowLateCorrections: number;
  /** Apple authorization-code exchanges that produced a revocable grant. */
  appleGrantExchanges: number;
  /** Logins that carried a code but had no Apple account port configured. */
  appleGrantExchangesSkipped: number;
  appleGrantExchangeFailures: number;
  /** Encrypted cold containers written, and seals that could not write one. */
  sealedContainersWritten: number;
  sealedContainerFailures: number;
  /** Purges withheld because no cold copy existed for the event. */
  purgesWithheldNoColdCopy: number;
  /** Purges withheld because the private media store could not delete the bytes. */
  purgesWithheldMediaDeletion: number;
  /** Private media bytes deleted by retention, and the failures that withheld a purge. */
  mediaObjectsDeleted: number;
  mediaDeletionFailures: number;
  mediaDeletionsSkippedNoStore: number;
  /** Events started by a person reporting the patient they found. */
  userReportedEvents: number;
  /** Apple consent revocations applied from a signed server notification. */
  appleConsentRevocations: number;
  /** G07 reroute proposals issued to responders. */
  rerouteProposals: number;
  /** G08 preset team signals sent, and retries that returned the original. */
  teamSignalsSent: number;
  teamSignalsDeduplicated: number;
  /** Security log (G12): entries written, expired, and sweeps without an index. */
  securityLogEntriesWritten: number;
  securityLogEntriesDeleted: number;
  securityLogSweepsWithoutIndex: number;
  /** Identity ledger reconciliation failures (a rollback that cannot be replayed). */
  identityLedgerFailures: number;
  identityLedgerAccountsClosed: number;
  identityLedgerSessionsRevoked: number;
  /** Self-service access (G11): requests, verified challenges, grants and reads. */
  selfAccessRequests: number;
  selfAccessChallengeFailures: number;
  selfAccessDecisions: number;
  selfAccessGrantsIssued: number;
  selfAccessViewsGranted: number;
  /** Apple token revocations confirmed by Apple, and those still retrying. */
  appleRevocations: number;
  appleRevocationsRetried: number;

  /**
   * `createDelivery` calls whose id already existed in this view.
   *
   * `createDelivery` is insert-only by contract: callers mint a fresh `randomUUID`,
   * so a collision means a caller is reusing an id.  Counted rather than silently
   * resolved, so the assumption can be checked instead of trusted.
   */
  deliveryCreateCollisions: number;
}

export interface RealtimeMetrics {
  reconcileCalls: number;
  reconcileConnectionVisits: number;
  reconcileMapBuilds: number;
  reconnectMapEntries: number;
  isAuthorizedCalls: number;
  sendToDevicesCalls: number;
  sendTargetDevices: number;
  sendMessagesHandedOff: number;
  reconcileTotalMs: number;
  reconcileMaxMs: number;
}

function emptyCloneCalls(): FullStateCloneCalls {
  return { transactionDraft: 0, normalization: 0, storeRead: 0, storeOpen: 0, storeSeed: 0, other: 0 };
}

export const storageMetrics: StorageMetrics = {
  transactions: 0, queueWaitMs: 0, lastTransactionQueueWaitMs: 0, lastTransactionServiceMs: 0,
  transactionServiceMs: 0, cloneMs: 0, mutationMs: 0,
  validateMs: 0, historyMs: 0, persistMs: 0,
  fullStateClones: emptyCloneCalls(), batchLevelClones: 0, fullStateFlattens: 0,
  historyCompareCalls: 0, emptyChangeSetReturns: 0, shadowValidationRuns: 0,
  commitCalls: 0, businessEntityUpserts: 0, businessEntityDeletes: 0, revisionMetadataUpdates: 0,
  validatedEntities: 0, serializedEntities: 0, historyComparedEntities: 0
};

export const operationMetrics: OperationMetrics = {
  calls: 0, operationElapsedMs: 0, preTransactionMs: 0, notificationDrainMs: 0,
  recruitmentPublishMs: 0, responseMs: 0, unattributedMs: 0,
  presenceAccessLoadMs: 0, presenceDeviceLoads: 0,
  presenceCollectionLoads: { events: 0, deliveries: 0, assignments: 0 },
  incrementalPathRuns: 0, indexedRecruitmentRuns: 0, legacyRecruitmentRuns: 0,
  recruitmentFallbackRuns: 0, assignmentCandidatesVisited: 0,
  deliveryCandidatesVisited: 0, deviceCandidatesVisited: 0, deliveryCreateCollisions: 0,
  stateEntityLoads: 0, stateFullCollectionKeyVisits: 0, stateRelationKeyVisits: 0,
  outboxScheduleVisits: 0,
  aedReceiptCandidatesVisited: 0,
  retentionSweepFailures: 0, retentionSealedEvents: 0, retentionPurgedEvents: 0,
  retentionDeferredPurges: 0, retentionCandidateReads: 0,
  positionWindowReconciliations: 0, positionWindowGapsRecorded: 0,
  positionWindowLateCorrections: 0,
  sealedContainersWritten: 0, sealedContainerFailures: 0, purgesWithheldNoColdCopy: 0,
  purgesWithheldMediaDeletion: 0, mediaObjectsDeleted: 0, mediaDeletionFailures: 0,
  mediaDeletionsSkippedNoStore: 0,
  userReportedEvents: 0,
  appleConsentRevocations: 0,
  rerouteProposals: 0,
  teamSignalsSent: 0, teamSignalsDeduplicated: 0,
  securityLogEntriesWritten: 0, securityLogEntriesDeleted: 0, securityLogSweepsWithoutIndex: 0,
  identityLedgerFailures: 0, identityLedgerAccountsClosed: 0, identityLedgerSessionsRevoked: 0,
  selfAccessRequests: 0, selfAccessChallengeFailures: 0, selfAccessDecisions: 0,
  selfAccessGrantsIssued: 0, selfAccessViewsGranted: 0,
  appleGrantExchanges: 0, appleGrantExchangesSkipped: 0, appleGrantExchangeFailures: 0,
  appleRevocations: 0, appleRevocationsRetried: 0
};

export const realtimeMetrics: RealtimeMetrics = {
  reconcileCalls: 0, reconcileConnectionVisits: 0, reconcileMapBuilds: 0,
  reconnectMapEntries: 0, isAuthorizedCalls: 0, sendToDevicesCalls: 0,
  sendTargetDevices: 0, sendMessagesHandedOff: 0, reconcileTotalMs: 0, reconcileMaxMs: 0
};

/**
 * Instrumentation switch.  Exists so the instrumentation's own cost can be
 * measured by A/B, and so every report can state whether instrumentation was on.
 * When disabled, timing syscalls are skipped entirely; guarded integer counters
 * remain accurate only while enabled, so a disabled run reports zero counts.
 */
let instrumentationEnabled = true;

export function setInstrumentationEnabled(enabled: boolean): void {
  instrumentationEnabled = enabled;
}

export function isInstrumentationEnabled(): boolean {
  return instrumentationEnabled;
}

export function resetMetrics(): void {
  const zero = <T extends object>(target: T): void => {
    for (const key of Object.keys(target)) {
      (target as Record<string, number>)[key] = 0;
    }
  };
  zero(storageMetrics);
  storageMetrics.fullStateClones = emptyCloneCalls();
  zero(operationMetrics);
  operationMetrics.presenceCollectionLoads = { events: 0, deliveries: 0, assignments: 0 };
  zero(realtimeMetrics);
}

/** Total whole-state clones across every call site. */
export function totalFullStateClones(): number {
  return Object.values(storageMetrics.fullStateClones).reduce((sum, n) => sum + n, 0);
}

export function snapshotMetrics(): {
  storage: StorageMetrics;
  operation: OperationMetrics;
  realtime: RealtimeMetrics;
  instrumentationEnabled: boolean;
  totalFullStateClones: number;
} {
  return {
    storage: { ...storageMetrics, fullStateClones: { ...storageMetrics.fullStateClones } },
    operation: {
      ...operationMetrics,
      presenceCollectionLoads: { ...operationMetrics.presenceCollectionLoads }
    },
    realtime: { ...realtimeMetrics },
    instrumentationEnabled,
    totalFullStateClones: totalFullStateClones()
  };
}
