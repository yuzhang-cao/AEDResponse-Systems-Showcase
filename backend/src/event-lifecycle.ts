import { reconcileEventAssets } from "./aed-assets.js";
import { stateRows } from "./incremental-state.js";
import { isTerminalAssignmentStatus } from "./domain.js";
import { appendTimeline } from "./event-audit.js";
import type { EventRecord, PersistentState, TimelineEntry } from "./models.js";

interface TerminalTransition {
  reason: NonNullable<EventRecord["terminalReason"]>;
  occurredAt: string;
  /** The caller derives this scope with the existing patient/delivery rules. */
  affectedDeviceIds: readonly string[];
  audit: Pick<TimelineEntry, "kind" | "message">;
}

export interface ExpiredEventOffer {
  deviceInstanceId: string;
  deliveryId: string;
  expiresAt: string;
  reason: "OFFER_NO_LONGER_ELIGIBLE";
}

/**
 * The sole terminal-state writer. Call inside the action's existing transaction,
 * after authorization, idempotency and causal-time checks. It neither commits
 * nor sends: the caller commits the action receipt with all of these changes.
 */
export function transitionEventToTerminal(
  state: PersistentState,
  event: EventRecord,
  transition: TerminalTransition
): ExpiredEventOffer[] {
  if (event.state !== "ACTIVE") throw new Error("Terminal transition requires an active event");
  const { reason, occurredAt } = transition;
  const confirmation = event.statusConfirmation;
  if (confirmation?.state === "PENDING") {
    confirmation.state = "ENDED_BY_EVENT";
    confirmation.closedAt = occurredAt;
    delete event.statusConfirmation;
  }
  event.state = reason === "FALSE_ALARM" ? "CANCELLED_CONFIRMED_FALSE_ALARM"
    : reason === "ASSISTANCE_WITHDRAWN" ? "CANCELLED_ASSISTANCE_WITHDRAWN"
    : reason === "CLOSED_UNCONFIRMED_NO_RESPONSE" ? reason : "RESOLVED";
  event.recruitmentState = event.state === "RESOLVED" ? "COMPLETED" : "STOPPED";
  event.terminalReason = reason;
  event.resolvedAt = occurredAt;
  delete event.watchFallbackCandidate;
  // Start the retention clock at the authoritative terminal time.  This is the
  // only place an event becomes terminal, so it is the only place the clock can
  // start — a missing clock means "leave it alone", never "purge it sooner".
  event.retention = {
    tier: "ONLINE",
    clockStartedAt: occurredAt,
    ...(event.retention?.legalHold ? { legalHold: event.retention.legalHold } : {})
  };

  // End the upload window, preserving all accepted intervals and position facts.
  for (const interval of stateRows(state, "participantIntervalsById", "eventId", event.id)) {
    if (interval.eventId !== event.id || interval.endedAt !== undefined) continue;
    interval.endedAt = occurredAt;
    interval.endReason = "EVENT_ENDED";
  }
  const expiredOffers: ExpiredEventOffer[] = [];
  for (const delivery of stateRows(state, "deliveries", "eventId", event.id)) {
    if (delivery.eventId !== event.id || ["ACCEPTED", "REFUSED", "EXPIRED"].includes(delivery.status)) continue;
    delivery.status = "EXPIRED";
    delivery.statusOccurredAt = occurredAt;
    expiredOffers.push({
      deviceInstanceId: delivery.deviceInstanceId,
      deliveryId: delivery.id,
      expiresAt: delivery.request.expiresAt,
      reason: "OFFER_NO_LONGER_ELIGIBLE"
    });
    appendTimeline(state, event.id, occurredAt, "PASSIVE_OBSERVATION",
      `Response delivery ${delivery.id} expired because the event ended.`);
  }
  for (const assignment of stateRows(state, "assignments", "eventId", event.id)) {
    if (assignment.eventId !== event.id || isTerminalAssignmentStatus(assignment.status)) continue;
    event.assignmentRevision += 1;
    assignment.status = "CANCELLED";
    assignment.revision = event.assignmentRevision;
    assignment.updatedAt = occurredAt;
  }
  for (const deviceId of transition.affectedDeviceIds) {
    const device = state.devices[deviceId];
    if (!device) continue;
    if (device.currentEventId === event.id) delete device.currentEventId;
    const assignment = device.currentAssignmentId ? state.assignments[device.currentAssignmentId] : undefined;
    if (assignment?.eventId === event.id) delete device.currentAssignmentId;
    if (device.latestPosition?.position.kind === "P" && device.latestPosition.eventId === event.id) {
      delete device.latestPosition;
    }
    device.lastSeenAt = occurredAt;
  }
  reconcileEventAssets(state, event.id, occurredAt);
  // Physical AED custody is independent of event closure; no asset is returned here.
  event.coordinationRevision += 1;
  appendTimeline(state, event.id, occurredAt, transition.audit.kind, transition.audit.message);
  return expiredOffers;
}
