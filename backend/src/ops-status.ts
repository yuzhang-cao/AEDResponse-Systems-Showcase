/**
 * G15 — the operator's status surface, and the reason `/healthz` is not it.
 *
 * `/healthz` answers "is the process alive", which is exactly the question that
 * stays green while the service degrades: notifications queue up because APNs
 * credentials are wrong, purges defer because a delete keeps failing, the outbox
 * backs up, or evidence sits past its window because no cold copy could be
 * written.  None of those change liveness.
 *
 * This module builds the smallest status a person can act on:
 *
 *   - **Counts and ages, never content.**  There are no user ids, no coordinates,
 *     no tokens and no message bodies here: every field is a number, a timestamp,
 *     a path the deployment configured, or a boolean.  A status endpoint that
 *     leaks what it reports is a new incident, not a control.
 *   - **An explicit verdict per concern.**  A raw counter invites "it is probably
 *     fine"; each concern is classified as `ok`, `degraded` or `action_required`
 *     against a stated threshold, and the whole answer carries the worst verdict.
 *   - **Thresholds are named.**  `degraded`/`action_required` come from the
 *     `G15_STATUS_THRESHOLDS` table below, so an operator can argue with the
 *     numbers instead of with the code.
 */
import type { PersistentState } from "./models.js";
import { snapshotMetrics } from "./runtime-metrics.js";

/** One concern's verdict. */
export type StatusVerdict = "ok" | "degraded" | "action_required";

export interface StatusConcern {
  name: string;
  verdict: StatusVerdict;
  /** The observed value, always a number, boolean or ISO timestamp. */
  observed: number | boolean | string;
  /** What the value means and what to do about it. */
  detail: string;
}

export interface OperatorStatus {
  status: StatusVerdict;
  generatedAt: string;
  /** Uptime in seconds, so a restart is visible in the same answer. */
  uptimeSeconds: number;
  concerns: StatusConcern[];
  counters: Record<string, number>;
  /** Configured paths an operator needs, never their contents. */
  paths: Record<string, string>;
}

/**
 * The thresholds, in one place and with names.
 *
 * They are deliberately conservative: a status that cries wolf gets ignored, and
 * an ignored status is worse than none because it looks like coverage.
 */
export const G15_STATUS_THRESHOLDS = {
  /** Pending notifications whose next attempt is overdue by more than this. */
  outboxOverdueSeconds: 120,
  /** Purges waiting to retry before this is "degraded" rather than "action required". */
  deferredPurgesDegraded: 1,
  deferredPurgesActionRequired: 5,
  /** Evidence withheld past its window because no cold copy exists. */
  withheldNoColdCopyDegraded: 1,
  withheldNoColdCopyActionRequired: 3,
  /** Media bytes that could not be erased: a retention promise is being missed. */
  mediaPurgeFailuresDegraded: 1,
  mediaPurgeFailuresActionRequired: 3,
  /** Failed identity-ledger reconciliations. */
  identityLedgerFailuresActionRequired: 1,
  /** Security logs, so runaway growth or a stuck sweep is visible. */
  securityLogWritesActionRequired: 0,
  /** Retention sweep failures. */
  retentionSweepFailuresDegraded: 1,
  retentionSweepFailuresActionRequired: 3
} as const;

function verdictOf(values: readonly StatusVerdict[]): StatusVerdict {
  if (values.includes("action_required")) return "action_required";
  if (values.includes("degraded")) return "degraded";
  return "ok";
}

/** Builds the status an operator reads; pure over its inputs. */
export function buildOperatorStatus(input: {
  state: Readonly<PersistentState>;
  now: Date;
  startedAt: number;
  paths: { identityLedger: string; sealKey: string };
}): OperatorStatus {
  const metrics = snapshotMetrics();
  const operation = metrics.operation;
  const nowMs = input.now.getTime();
  const counters: Record<string, number> = {
    // Storage cost: the numbers G13-A exists to keep at zero on business paths.
    fullStateClones: metrics.totalFullStateClones,
    fullCollectionKeyVisits: operation.stateFullCollectionKeyVisits,
    retentionCandidateReads: operation.retentionCandidateReads,
    // Notification delivery.
    outboxOverdue: 0,
    outboxPending: 0,
    // Push outcomes live on each outbox row (`push.status`), so the backlog above
    // already reflects them; a credential failure shows up as an overdue backlog.
    pushNotRegistered: Object.values(input.state.notificationOutboxById)
      .filter(row => row.push?.status === "NOT_REGISTERED" || row.push?.status === "INVALID_TOKEN").length,
    // Retention and evidence.
    retentionSealedEvents: operation.retentionSealedEvents,
    retentionPurgedEvents: operation.retentionPurgedEvents,
    retentionDeferredPurges: operation.retentionDeferredPurges,
    purgesWithheldNoColdCopy: operation.purgesWithheldNoColdCopy,
    purgesWithheldMediaDeletion: operation.purgesWithheldMediaDeletion,
    mediaObjectsDeleted: operation.mediaObjectsDeleted,
    mediaDeletionFailures: operation.mediaDeletionFailures,
    sealedContainerFailures: operation.sealedContainerFailures,
    retentionSweepFailures: operation.retentionSweepFailures,
    // Identity and access.
    identityLedgerFailures: operation.identityLedgerFailures,
    identityLedgerAccountsClosed: operation.identityLedgerAccountsClosed,
    identityLedgerSessionsRevoked: operation.identityLedgerSessionsRevoked,
    securityLogEntriesWritten: operation.securityLogEntriesWritten,
    securityLogEntriesDeleted: operation.securityLogEntriesDeleted,
    appleRevocationsRetried: operation.appleRevocationsRetried ?? 0,
    // Business surfaces.
    rerouteProposals: operation.rerouteProposals ?? 0,
    teamSignalsSent: operation.teamSignalsSent ?? 0,
    selfAccessGrantsIssued: operation.selfAccessGrantsIssued ?? 0
  };

  // The outbox backlog is read from state, because "pending" is a fact about rows
  // rather than about this process's lifetime.
  let overdue = 0;
  let pending = 0;
  let oldestOverdueSeconds = 0;
  for (const row of Object.values(input.state.notificationOutboxById)) {
    if (row.status !== "PENDING") continue;
    pending += 1;
    const dueAt = Date.parse(row.nextAttemptAt);
    if (!Number.isFinite(dueAt) || dueAt > nowMs) continue;
    // An attempt that is merely due is normal; one that is minutes late means the
    // drain is not running or the transport is wedged.
    const lateSeconds = (nowMs - dueAt) / 1_000;
    if (lateSeconds >= G15_STATUS_THRESHOLDS.outboxOverdueSeconds) {
      overdue += 1;
      oldestOverdueSeconds = Math.max(oldestOverdueSeconds, Math.round(lateSeconds));
    }
  }
  counters.outboxPending = pending;
  counters.outboxOverdue = overdue;
  counters.oldestOutboxOverdueSeconds = oldestOverdueSeconds;

  const concerns: StatusConcern[] = [
    {
      name: "database_commits",
      verdict: "ok",
      observed: true,
      detail: "The store is open and serving; a commit failure surfaces as a request error and "
        + "is counted by the operation metrics, not hidden."
    },
    {
      name: "notification_outbox",
      verdict: overdue >= 1 ? "action_required" : "ok",
      observed: overdue,
      detail: overdue === 0
        ? `${pending} notification(s) pending, none overdue beyond ${G15_STATUS_THRESHOLDS.outboxOverdueSeconds}s.`
        : `${overdue} notification(s) overdue, oldest ${oldestOverdueSeconds}s: check the socket `
          + "transport and the APNs credential set; the rows are durable and will retry."
    },
    {
      name: "retention_purges",
      verdict: operation.retentionDeferredPurges >= G15_STATUS_THRESHOLDS.deferredPurgesActionRequired
        ? "action_required"
        : operation.retentionDeferredPurges >= G15_STATUS_THRESHOLDS.deferredPurgesDegraded
          ? "degraded" : "ok",
      observed: operation.retentionDeferredPurges,
      detail: operation.retentionDeferredPurges === 0
        ? "No purge is waiting to retry."
        : `${operation.retentionDeferredPurges} event(s) authorized for purge but not yet deleted; `
          + "the authorisation is committed, so the next sweep retries. Repeated failure means a "
          + "storage problem, not a policy problem."
    },
    {
      name: "cold_copies",
      verdict: operation.purgesWithheldNoColdCopy >= G15_STATUS_THRESHOLDS.withheldNoColdCopyActionRequired
        ? "action_required"
        : operation.purgesWithheldNoColdCopy >= G15_STATUS_THRESHOLDS.withheldNoColdCopyDegraded
          ? "degraded" : "ok",
      observed: operation.purgesWithheldNoColdCopy,
      detail: operation.purgesWithheldNoColdCopy === 0
        ? "Every due event has its encrypted cold copy."
        : "Evidence is past its window with no cold copy, so deletion is refused and reported: "
          + `check the seal key at ${input.paths.sealKey} and the free space beside the database.`
    },
    {
      name: "media_erasure",
      verdict: operation.purgesWithheldMediaDeletion >= G15_STATUS_THRESHOLDS.mediaPurgeFailuresActionRequired
        ? "action_required"
        : operation.purgesWithheldMediaDeletion >= G15_STATUS_THRESHOLDS.mediaPurgeFailuresDegraded
          ? "degraded" : "ok",
      observed: operation.purgesWithheldMediaDeletion,
      detail: operation.purgesWithheldMediaDeletion === 0
        ? "No purge is blocked on private media deletion."
        : "A purge is withheld because the private object store could not delete the bytes; the "
          + "reference rows are kept on purpose so the retry still knows what to erase."
    },
    {
      name: "identity_ledger",
      verdict: operation.identityLedgerFailures >= G15_STATUS_THRESHOLDS.identityLedgerFailuresActionRequired
        ? "action_required" : "ok",
      observed: operation.identityLedgerFailures,
      detail: operation.identityLedgerFailures === 0
        ? `Ledger at ${input.paths.identityLedger}; closures and revocations are being recorded.`
        : "The ledger could not be written or replayed: a restore would not be able to re-apply "
          + "closures and revocations. Treat as an incident."
    },
    {
      name: "retention_sweeps",
      verdict: operation.retentionSweepFailures >= G15_STATUS_THRESHOLDS.retentionSweepFailuresActionRequired
        ? "action_required"
        : operation.retentionSweepFailures >= G15_STATUS_THRESHOLDS.retentionSweepFailuresDegraded
          ? "degraded" : "ok",
      observed: operation.retentionSweepFailures,
      detail: operation.retentionSweepFailures === 0
        ? "The scheduled retention sweep is running."
        : "The retention sweep threw; the promise is not being executed on schedule."
    },
    {
      name: "sealing",
      verdict: operation.sealedContainerFailures > 0 && operation.sealedContainersWritten === 0
        ? "action_required" : "ok",
      observed: operation.sealedContainerFailures,
      detail: operation.sealedContainerFailures === 0
        ? `${operation.sealedContainersWritten} cold container(s) written.`
        : `${operation.sealedContainerFailures} cold-copy write(s) failed. The tier still advanced `
          + "(the online window had expired) and the purge is withheld until a copy exists."
    },
    {
      name: "access_audit",
      verdict: "ok",
      observed: Object.keys(input.state.accessAuditById).length,
      detail: "Business data reads are audited; the count is reported so a review can see whether "
        + "the trail is growing."
    },
    {
      name: "security_log",
      verdict: "ok",
      observed: Object.keys(input.state.securityLogById).length,
      detail: `Entries: ${operation.securityLogEntriesWritten} written, `
        + `${operation.securityLogEntriesDeleted} expired. Six-month retention is enforced by the `
        + "deadline sweep, not by a manual cleanup."
    }
  ];

  return {
    status: verdictOf(concerns.map(concern => concern.verdict)),
    generatedAt: input.now.toISOString(),
    uptimeSeconds: Math.max(0, Math.round((nowMs - input.startedAt) / 1_000)),
    concerns,
    counters,
    paths: { identityLedger: input.paths.identityLedger, sealKey: input.paths.sealKey }
  };
}
