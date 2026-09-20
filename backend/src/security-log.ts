/**
 * G12 — the security log: what was refused, kept for six months, carrying nothing
 * worth stealing.
 *
 * Two requirements meet here, and they pull in opposite directions: a security
 * log has to be useful (which route, which class of caller, which refusal), and
 * it must not become a second copy of the data it protects.  The published rule
 * is "security logs are kept six months and contain no sensitive body".
 *
 * The design follows from that sentence:
 *
 *   - **Minimal by construction.**  An entry has a fixed, small vocabulary: a
 *     refusal class, an outcome, an optional opaque subject, a reason CODE, a
 *     route TEMPLATE and a coarse source class.  There is no field for a token, a
 *     request body, a coordinate or a message, so a caller cannot hand one in —
 *     and the store validator rejects unknown keys, which is what makes that a
 *     property of the stored record instead of a convention.
 *   - **Route templates, never URLs.**  A path like
 *     `/api/v2/events/<uuid>` is recorded as `/api/v2/events/{id}`: enough to
 *     count failures per endpoint, not enough to record which person was asked
 *     about.
 *   - **Six months, then gone.**  A deadline projection finds the due entries, so
 *     the sweep costs one query instead of a scan of the log, and expired entries
 *     are deleted rather than archived — an archive would defeat the retention.
 */
import type { PersistentState, SecurityLogRecord } from "./models.js";
import { operationMetrics } from "./runtime-metrics.js";
import type { StateStore } from "./store.js";
import { readState } from "./incremental-state.js";

/** Published retention for security logs. */
export const SECURITY_LOG_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Refusal classes.  A closed set, so the log stays countable. */
export const SECURITY_LOG_EVENTS = [
  "AUTH_REJECTED",
  "SESSION_REPLAY_REJECTED",
  "SCOPE_REJECTED",
  "OPERATOR_REJECTED",
  "RATE_LIMIT_EXCEEDED",
  "PROXY_HEADER_REJECTED",
  "REQUEST_REJECTED",
  "SELF_ACCESS_CHALLENGE_REJECTED",
  "MEDIA_STORE_UNAVAILABLE",
  "SECURITY_LOG_RETENTION"
] as const;

/** The exact key set an entry may carry.  Unknown keys are refused on write. */
export const SECURITY_LOG_FIELDS = [
  "entryId", "occurredAt", "event", "outcome", "subjectId", "reasonCode", "route", "sourceClass"
] as const;

/** Route template: identifiers are replaced, so the log never names a subject. */
export function routeTemplate(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "{id}")
    .replace(/\/\d{4,}/g, "/{id}")
    .slice(0, 200);
}

/** Refusals the request layer maps to a class, with no per-route plumbing. */
export function securityEventForStatus(status: number, path: string): SecurityLogRecord["event"] {
  if (status === 429) return "RATE_LIMIT_EXCEEDED";
  if (status === 401) return path.includes("/challenge") ? "SELF_ACCESS_CHALLENGE_REJECTED" : "AUTH_REJECTED";
  if (status === 403) return path.startsWith("/api/v2/ops/") ? "OPERATOR_REJECTED" : "SCOPE_REJECTED";
  return "REQUEST_REJECTED";
}

export interface SecurityLogSweepResult {
  /** Entries deleted because they passed the six-month boundary. */
  deleted: number;
  /** Entries still within retention. */
  retained: number;
}

export function securityLogDeadline(entry: SecurityLogRecord): number {
  return Date.parse(entry.occurredAt) + SECURITY_LOG_RETENTION_DAYS * DAY_MS;
}

export const SECURITY_LOG_DEADLINES = "securityLogDeadlines";

/**
 * Deletes security log entries past six months.
 *
 * Reads the due keys from the deadline projection.  Without one it reports zero
 * rather than scanning every entry: the sweep runs on the scheduler tick, and a
 * whole-collection pass there is exactly the cost G13-A removed.  The metric
 * `securityLogSweepsWithoutIndex` makes that fallback visible instead of silent.
 */
export async function runSecurityLogRetention(input: {
  store: StateStore;
  now: Date;
  limit?: number;
}): Promise<SecurityLogSweepResult> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5_000);
  const due = input.store.projections?.()?.readDue(
    SECURITY_LOG_DEADLINES, input.now.getTime(), limit);
  if (!due) {
    operationMetrics.securityLogSweepsWithoutIndex += 1;
    return { deleted: 0, retained: 0 };
  }
  if (due.keys.length === 0) return { deleted: 0, retained: 0 };
  const expired = due.keys.filter(key => {
    const entry = readState(input.store, state => state.securityLogById[key]);
    return entry !== undefined && securityLogDeadline(entry) <= input.now.getTime();
  });
  if (expired.length === 0) return { deleted: 0, retained: 0 };
  const transact = input.store.transactEntities;
  if (!transact) {
    // A store without entity transactions cannot delete one row without rewriting
    // the whole state; report it instead of paying that cost on a tick.
    operationMetrics.securityLogSweepsWithoutIndex += 1;
    return { deleted: 0, retained: 0 };
  }
  await transact.call(input.store, async tx => {
    for (const key of expired) {
      // Re-checked inside the transaction: a clock change or a concurrent sweep
      // must not delete an entry that is still within its retention window.
      const entry = tx.get("securityLogById", key);
      if (!entry || securityLogDeadline(entry as SecurityLogRecord) > input.now.getTime()) continue;
      tx.remove("securityLogById", key);
    }
  });
  operationMetrics.securityLogEntriesDeleted += expired.length;
  return { deleted: expired.length, retained: 0 };
}

/**
 * Builds one entry, refusing anything that is not part of the vocabulary.
 *
 * The caller passes a reason CODE, not a message; this function is the last place
 * where a helpful error string could leak into a six-month record, so it rejects
 * strings that look like credentials or precise locations.
 */
export function securityLogEntry(input: {
  entryId: string;
  occurredAt: string;
  event: SecurityLogRecord["event"];
  outcome: SecurityLogRecord["outcome"];
  subjectId?: string;
  reasonCode?: string;
  route?: string;
  sourceClass?: SecurityLogRecord["sourceClass"];
}): SecurityLogRecord {
  if (!SECURITY_LOG_EVENTS.includes(input.event)) throw new Error("Unsupported security log event");
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error("Security log time must be ISO");
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    if (value.length > 200) throw new Error(`Security log ${field} is too long to be a code`);
    if (/bearer\s|eyJ[A-Za-z0-9_-]{10,}|apns-|-----BEGIN/i.test(value)) {
      throw new Error(`Security log ${field} looks like credential material and is refused`);
    }
    if (/\d{1,3}\.\d{4,}/.test(value)) {
      throw new Error(`Security log ${field} looks like a precise coordinate and is refused`);
    }
  }
  return {
    entryId: input.entryId,
    occurredAt: input.occurredAt,
    event: input.event,
    outcome: input.outcome,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.route ? { route: routeTemplate(input.route) } : {}),
    ...(input.sourceClass ? { sourceClass: input.sourceClass } : {})
  };
}

/** The count a diagnostic may report, without exposing any entry. */
export function securityLogSize(state: Readonly<PersistentState>): number {
  return Object.keys(state.securityLogById).length;
}
