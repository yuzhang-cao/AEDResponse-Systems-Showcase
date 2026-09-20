/**
 * G12 — who read what, and under which authority.
 *
 * The business timeline records what happened to an EVENT.  It is not an access
 * log: it cannot answer "which operator opened this patient's precise position,
 * when, and why", which is exactly the question a privacy review asks.  This
 * module is that separate record.
 *
 * Two properties are deliberate:
 *
 *   1. **Minimisation.** An entry names the actor, the class of data, the subject
 *      and the reason.  It never contains the data itself — no coordinates, no
 *      tokens, no phone numbers.  An audit log that leaks what it audits is a new
 *      breach, not a control.
 *   2. **Append-only.** Entries are never updated or deleted by business code.
 *      The store guard enforces that, so "the log says nobody looked" cannot be
 *      produced by editing the log.
 *
 * Alongside it sits the distinction the requirement demands: a business OPERATOR
 * credential is not a data-reading privilege.  Reading a person's precise data
 * needs a break-glass grant that is single-event, read-only, time-boxed and
 * reason-carrying — and every use of it is itself an audit entry.
 */
import type { PersistentState } from "./models.js";
import { forbidden, badRequest, notFound } from "./errors.js";

/** Coarse data classes, so the log stays a control and not a copy. */
export type AuditedDataClass =
  | "EVENT_SUMMARY"
  | "PRECISE_PATIENT_POSITION"
  | "PARTICIPANT_POSITION"
  | "PARTICIPANT_IDENTITY"
  | "EVIDENCE"
  | "RETENTION"
  | "LEGAL_HOLD"
  | "ACCOUNT_ADMIN";

export interface AccessAuditEntry {
  entryId: string;
  /** Who acted: operator credential id, or an account/device id for self-service. */
  actor: string;
  actorKind: "OPERATOR" | "ACCOUNT" | "DEVICE" | "SYSTEM";
  dataClass: AuditedDataClass;
  /** Opaque subject: an event id, a user id.  Never a name or a coordinate. */
  subjectId: string;
  /** Why.  Required for operator access; free text but bounded. */
  reason: string;
  /** Which grant authorised it, when a break-glass was involved. */
  grantId?: string;
  recordedAt: string;
  outcome: "ALLOWED" | "DENIED";
}

export interface BreakGlassGrant {
  grantId: string;
  /** A grant is scoped to ONE event, never to a person or the deployment. */
  eventId: string;
  issuedBy: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  /** Read-only by construction: there is no write path behind this grant. */
  readonly scope: "READ_ONLY";
  usedAt?: string;
}

/** The requirement's ceiling on a single emergency read grant. */
export const BREAK_GLASS_MAX_MINUTES = 30;

/** A reason is mandatory and must say something; an empty string is not a reason. */
export function requireAuditReason(reason: unknown): string {
  if (typeof reason !== "string") throw badRequest("A reason is required for this access");
  const trimmed = reason.trim();
  if (trimmed.length < 4) throw badRequest("A reason is required for this access");
  if (trimmed.length > 500) throw badRequest("The reason is too long");
  return trimmed;
}

export type BreakGlassCheck =
  | { allowed: true; grant: BreakGlassGrant }
  | { allowed: false; code: "NO_GRANT" | "GRANT_EXPIRED" | "WRONG_EVENT" | "REVOKED" };

/**
 * Whether a grant authorises reading this event's precise data right now.
 *
 * Time is passed in rather than read, so the 30-minute ceiling can be tested
 * exactly and cannot be extended by a clock the caller controls.
 */
export function breakGlassAllows(
  grant: BreakGlassGrant | undefined,
  eventId: string,
  now: Date
): BreakGlassCheck {
  if (!grant) return { allowed: false, code: "NO_GRANT" };
  if (grant.eventId !== eventId) return { allowed: false, code: "WRONG_EVENT" };
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) {
    return { allowed: false, code: "GRANT_EXPIRED" };
  }
  return { allowed: true, grant };
}

export function auditEntry(input: {
  entryId: string;
  actor: string;
  actorKind: AccessAuditEntry["actorKind"];
  dataClass: AuditedDataClass;
  subjectId: string;
  reason: string;
  recordedAt: string;
  outcome: AccessAuditEntry["outcome"];
  grantId?: string;
}): AccessAuditEntry {
  return {
    entryId: input.entryId,
    actor: input.actor,
    actorKind: input.actorKind,
    dataClass: input.dataClass,
    subjectId: input.subjectId,
    reason: input.reason,
    ...(input.grantId ? { grantId: input.grantId } : {}),
    recordedAt: input.recordedAt,
    outcome: input.outcome
  };
}

/**
 * A business operator may not read precise data with the plain operator token.
 *
 * Kept as an explicit function so the rule is stated once and any future read
 * path has to call it: the operator credential is for administrative facts such
 * as retention and legal holds, not for looking at people.
 */
export function requirePreciseDataAuthority(
  actorKind: AccessAuditEntry["actorKind"],
  grant: BreakGlassGrant | undefined,
  eventId: string,
  now: Date
): BreakGlassGrant {
  if (actorKind !== "OPERATOR") {
    // Self-service and system access never take this path; they are authorised by
    // their own session scoping.
    throw forbidden("Precise-data reads require a break-glass grant");
  }
  const check = breakGlassAllows(grant, eventId, now);
  if (!check.allowed) {
    throw forbidden(`Break-glass grant does not authorise this read (${check.code})`);
  }
  return check.grant;
}

/** The grant an event currently has, if it has not expired. */
export function activeBreakGlassGrant(
  state: PersistentState,
  eventId: string,
  now: Date
): BreakGlassGrant | undefined {
  const grants = state.breakGlassGrantsById ?? {};
  return Object.values(grants).find(grant =>
    grant.eventId === eventId
    && Number.isFinite(Date.parse(grant.expiresAt))
    && now.getTime() < Date.parse(grant.expiresAt));
}

/** Issues a grant.  The 30-minute ceiling is enforced here, not by the caller. */
export function issueBreakGlassGrant(input: {
  grantId: string;
  eventId: string;
  issuedBy: string;
  reason: string;
  issuedAt: Date;
  minutes?: number;
}): BreakGlassGrant {
  const minutes = input.minutes ?? BREAK_GLASS_MAX_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > BREAK_GLASS_MAX_MINUTES) {
    throw badRequest(`A break-glass grant may last at most ${BREAK_GLASS_MAX_MINUTES} minutes`);
  }
  return {
    grantId: input.grantId,
    eventId: input.eventId,
    issuedBy: input.issuedBy,
    reason: input.reason,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: new Date(input.issuedAt.getTime() + minutes * 60_000).toISOString(),
    scope: "READ_ONLY"
  };
}

/** Records a denial too: a refused read is evidence about the control. */
export function deniedAuditEntry(input: {
  entryId: string;
  actor: string;
  dataClass: AuditedDataClass;
  subjectId: string;
  reason: string;
  recordedAt: string;
}): AccessAuditEntry {
  return auditEntry({ ...input, actorKind: "OPERATOR", outcome: "DENIED" });
}

/** Looks one event up or refuses: used by the audited read paths. */
export function requireEventForAudit(
  state: PersistentState,
  eventId: string
): void {
  if (!state.events[eventId]) throw notFound("Event does not exist");
}
