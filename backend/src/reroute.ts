/**
 * G07 — the 15-second reroute proposal.
 *
 * The requirement is narrow and absolute: when a responder is already walking to
 * an AED and the backend notices a better device on their way, the backend may
 * PROPOSE a change; it may never silently reassign.  The responder either accepts
 * within 15 seconds or keeps the original task.
 *
 * Three rules make that real, and each exists because of a concrete failure:
 *
 *   1. **A proposal is not a task.**  Until the responder accepts, the original
 *      route stays locked and dispatchable.  Nothing about the original task is
 *      mutated while a proposal is outstanding.
 *   2. **Expiry preserves the original task.**  A timeout is not a rejection and
 *      not an assignment: the sweep simply retires the proposal.
 *   3. **Everything is revalidated at the moment of acceptance.**  A proposal
 *      carries a snapshot of why it was made; between proposal and acceptance the
 *      responder may have moved, the target AED may have been taken, and the
 *      assignment may have progressed.  Accepting a stale proposal would send
 *      someone to a device that is already gone, so acceptance re-checks all
 *      three and refuses rather than guessing.
 */
import type {
  AedRoute,
  AssignmentRecord,
  EventRecord,
  RerouteProposalRecord
} from "./models.js";

/**
 * The minimal write surface the reroute helpers need.
 *
 * Deliberately NOT `EntityTransaction`: the service runs these inside its
 * request-local draft, where entities are real mutable objects, while the unit
 * tests run them over a plain state.  Both satisfy this interface, so the same
 * decision logic is exercised in both places without an adapter that could drift.
 */
export interface RerouteStoreView {
  proposal(proposalId: string): RerouteProposalRecord | undefined;
  putProposal(proposal: RerouteProposalRecord): void;
  assignment(assignmentId: string): AssignmentRecord | undefined;
  putAssignment(assignment: AssignmentRecord): void;
  /** Pending proposals whose window has closed at `now`. */
  pendingProposals(): readonly RerouteProposalRecord[];
}

/** A view over a plain state object, for tests and for whole-state callers. */
export function rerouteViewOver(state: {
  rerouteProposalsById: Record<string, RerouteProposalRecord>;
  assignments: Record<string, AssignmentRecord>;
}): RerouteStoreView {
  return {
    proposal: id => state.rerouteProposalsById[id],
    putProposal: (proposal) => { state.rerouteProposalsById[proposal.proposalId] = proposal; },
    assignment: id => state.assignments[id],
    putAssignment: (assignment) => { state.assignments[assignment.id] = assignment; },
    pendingProposals: () => Object.values(state.rerouteProposalsById)
      .filter(proposal => proposal.status === "PENDING")
  };
}
import { distanceMeters } from "./domain.js";

/** The confirmation window the requirement fixes at 15 seconds. */
export const REROUTE_WINDOW_SECONDS = 15;

/** How far the responder may have moved before the proposal no longer applies. */
export const REROUTE_MAX_DRIFT_METERS = 150;

/** Statuses in which a task may still be redirected: not yet at the patient. */
const REROUTABLE_STATUSES: ReadonlySet<AssignmentRecord["status"]> = new Set([
  "ASSIGNED",
  "EN_ROUTE",
  "ARRIVED_AT_AED"
]);

export function assignmentAcceptsReroute(assignment: AssignmentRecord): boolean {
  return assignment.role === "FETCH_AED" && REROUTABLE_STATUSES.has(assignment.status);
}

export interface RerouteProposalDraft {
  proposalId: string;
  eventId: string;
  assignmentId: string;
  deviceInstanceId: string;
  userId?: string;
  /** The AED the responder was originally sent to. */
  fromAedId: string;
  /** The closer device the backend suggests instead. */
  toAedId: string;
  proposedRoute: AedRoute;
  /** Where the responder was when the proposal was made. */
  proposedFrom: { latitude: number; longitude: number };
  etaSavingSeconds: number;
  proposedAt: string;
  expiresAt: string;
}

/**
 * Whether the responder's current position is still close enough to where the
 * proposal was made for its reasoning (a small detour) to hold.
 */
export function rerouteStillApplies(
  proposal: Pick<RerouteProposalRecord, "proposedFrom">,
  current: { latitude: number; longitude: number } | undefined
): boolean {
  if (!current) return false;
  return distanceMeters(proposal.proposedFrom, current) <= REROUTE_MAX_DRIFT_METERS;
}

export type RerouteDecisionRefusal =
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_EXPIRED"
  | "PROPOSAL_ALREADY_DECIDED"
  | "ASSIGNMENT_NOT_FOUND"
  | "ASSIGNMENT_NO_LONGER_REROUTABLE"
  | "RESPONDER_MOVED"
  | "TARGET_AED_NO_LONGER_AVAILABLE"
  | "NOT_YOUR_ASSIGNMENT";

export type RerouteDecisionOutcome =
  | { status: "ACCEPTED"; route: AedRoute }
  | { status: "REJECTED" }
  | { status: "REFUSED"; reason: RerouteDecisionRefusal };

/**
 * Records a proposal.  The original assignment is deliberately NOT touched.
 */
export function proposeReroute(
  tx: RerouteStoreView,
  draft: RerouteProposalDraft
): RerouteProposalRecord {
  const record: RerouteProposalRecord = {
    proposalId: draft.proposalId,
    eventId: draft.eventId,
    assignmentId: draft.assignmentId,
    deviceInstanceId: draft.deviceInstanceId,
    ...(draft.userId ? { userId: draft.userId } : {}),
    fromAedId: draft.fromAedId,
    toAedId: draft.toAedId,
    proposedRoute: draft.proposedRoute,
    proposedFrom: draft.proposedFrom,
    etaSavingSeconds: draft.etaSavingSeconds,
    proposedAt: draft.proposedAt,
    expiresAt: draft.expiresAt,
    status: "PENDING"
  };
  tx.putProposal(record);
  return record;
}

/**
 * Resolves one proposal against the CURRENT transaction view.
 *
 * `accept` is the responder's answer; every other condition is revalidation.
 * The caller passes the decision time so tests can drive the window exactly.
 */
export function decideReroute(
  tx: RerouteStoreView,
  input: {
    proposalId: string;
    deviceInstanceId: string;
    accept: boolean;
    decidedAt: string;
    /** The responder's position at decision time, if the client supplied one. */
    currentPosition?: { latitude: number; longitude: number } | undefined;
    /** Whether another assignment has since locked the target AED. */
    targetAedTakenBy?: ((aedId: string, exceptAssignmentId: string) => boolean) | undefined;
  }
): RerouteDecisionOutcome {
  const proposal = tx.proposal(input.proposalId);
  if (!proposal) return { status: "REFUSED", reason: "PROPOSAL_NOT_FOUND" };
  if (proposal.deviceInstanceId !== input.deviceInstanceId) {
    // Another participant may not answer for this responder, and saying so
    // explicitly keeps a stolen proposal id from being useful.
    return { status: "REFUSED", reason: "NOT_YOUR_ASSIGNMENT" };
  }
  if (proposal.status !== "PENDING") {
    return { status: "REFUSED", reason: "PROPOSAL_ALREADY_DECIDED" };
  }
  const decidedAtMs = Date.parse(input.decidedAt);
  const expiresAtMs = Date.parse(proposal.expiresAt);
  const expired = Number.isFinite(decidedAtMs) && Number.isFinite(expiresAtMs)
    && decidedAtMs >= expiresAtMs;

  const assignment = tx.assignment(proposal.assignmentId);
  if (!assignment || assignment.eventId !== proposal.eventId
    || assignment.deviceInstanceId !== proposal.deviceInstanceId) {
    tx.putProposal({ ...proposal, status: "REFUSED", decidedAt: input.decidedAt,
      refusalReason: "ASSIGNMENT_NOT_FOUND" });
    return { status: "REFUSED", reason: "ASSIGNMENT_NOT_FOUND" };
  }
  if (!assignmentAcceptsReroute(assignment)) {
    // The responder already reached the patient or acquired the original device:
    // the original task is protected and the proposal is simply retired.
    tx.putProposal({ ...proposal, status: "REFUSED", decidedAt: input.decidedAt,
      refusalReason: "ASSIGNMENT_NO_LONGER_REROUTABLE" });
    return { status: "REFUSED", reason: "ASSIGNMENT_NO_LONGER_REROUTABLE" };
  }
  if (expired) {
    // Expiry is not a rejection: the original task is untouched either way, but
    // the record must say which of the two happened.
    tx.putProposal({ ...proposal, status: "EXPIRED", decidedAt: input.decidedAt });
    return { status: "REFUSED", reason: "PROPOSAL_EXPIRED" };
  }

  if (!input.accept) {
    tx.putProposal({ ...proposal, status: "REJECTED", decidedAt: input.decidedAt });
    return { status: "REJECTED" };
  }

  // Acceptance revalidation.  A moved responder invalidates the detour reasoning;
  // an already-taken AED invalidates the destination itself.
  if (input.currentPosition !== undefined && !rerouteStillApplies(proposal, input.currentPosition)) {
    tx.putProposal({ ...proposal, status: "REFUSED", decidedAt: input.decidedAt,
      refusalReason: "RESPONDER_MOVED" });
    return { status: "REFUSED", reason: "RESPONDER_MOVED" };
  }
  if (input.targetAedTakenBy?.(proposal.toAedId, proposal.assignmentId)) {
    tx.putProposal({ ...proposal, status: "REFUSED", decidedAt: input.decidedAt,
      refusalReason: "TARGET_AED_NO_LONGER_AVAILABLE" });
    return { status: "REFUSED", reason: "TARGET_AED_NO_LONGER_AVAILABLE" };
  }

  // The ONLY place the original task changes: an explicit acceptance that
  // survived every revalidation above.
  tx.putAssignment({
    ...assignment,
    route: proposal.proposedRoute,
    revision: assignment.revision + 1,
    updatedAt: input.decidedAt
  });
  tx.putProposal({ ...proposal, status: "ACCEPTED", decidedAt: input.decidedAt });
  return { status: "ACCEPTED", route: proposal.proposedRoute };
}

/**
 * Retires proposals whose window has closed.
 *
 * Called from the scheduler so a proposal cannot stay PENDING forever and be
 * accepted minutes later.  Returns the ids it expired, for the caller's audit.
 */
export function expireRerouteProposals(tx: RerouteStoreView, now: Date): string[] {
  const nowMs = now.getTime();
  const expired: string[] = [];
  for (const proposal of tx.pendingProposals()) {
    if (Date.parse(proposal.expiresAt) > nowMs) continue;
    tx.putProposal({ ...proposal, status: "EXPIRED", decidedAt: now.toISOString() });
    expired.push(proposal.proposalId);
  }
  return expired;
}

/**
 * Decides whether a reroute is worth proposing at all.
 *
 * Only a materially better ETA is worth the responder's attention: a proposal
 * that saves a couple of seconds would cost more in distraction than it gains,
 * and the requirement's safety framing is about a device that is actually on the
 * way.  The caller supplies the candidate routes it already computed.
 */
export function rerouteWorthProposing(input: {
  currentEtaSeconds: number;
  candidateEtaSeconds: number;
  minimumSavingSeconds?: number;
}): boolean {
  const minimum = input.minimumSavingSeconds ?? 60;
  return Number.isFinite(input.currentEtaSeconds)
    && Number.isFinite(input.candidateEtaSeconds)
    && input.currentEtaSeconds - input.candidateEtaSeconds >= minimum;
}

/** Terminal-state guard: a proposal may only exist for an active event. */
export function eventAcceptsReroute(event: EventRecord | undefined): boolean {
  return event?.state === "ACTIVE";
}
