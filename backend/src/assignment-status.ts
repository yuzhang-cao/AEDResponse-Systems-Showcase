import { reconcileEventAssets } from "./aed-assets.js";
import { transactState, stateRows } from "./incremental-state.js";
import { appendTimeline } from "./event-audit.js";
import { assignmentTransitionAllowed } from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";
import type { AssignmentStatus } from "./contracts.js";
import type { DevicePrincipal } from "./identity-access.js";
import type {
  AssignmentRecord,
  AssignmentView,
  CoordinationSummary,
  EventRecord,
  PersistentState,
  ResponseRequestPayload
} from "./models.js";
import type { StateStore } from "./store.js";

interface RecruitmentUpdate {
  eventId: string;
  audience: string[];
  requests: Array<{ deviceInstanceId: string; request: ResponseRequestPayload }>;
  expiredOffers: Array<{
    deviceInstanceId: string;
    deliveryId: string;
    expiresAt: string;
    reason: "OFFER_EXPIRED" | "OFFER_NO_LONGER_ELIGIBLE";
  }>;
  coordination: CoordinationSummary;
}

export interface AssignmentStatusUseCaseDependencies {
  store: StateStore;
  now: () => Date;
  validateActionTime: (value: string, field: string, serverReceivedAt: Date) => string;
  effectiveActionTime: (
    claimedAt: string,
    field: string,
    causalLowerBoundAt: string,
    causalLowerBoundField: string,
    serverReceivedAt: Date,
    causalPolicy?: "REJECT" | "CLAMP"
  ) => string;
  markDeviceSeen: (state: PersistentState, deviceInstanceId: string, at: string) => void;
  allCurrentAssignmentsCompleted: (state: Readonly<PersistentState>, eventId: string) => boolean;
  recruitmentUpdate: (
    state: PersistentState,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience?: readonly string[],
    expiredOffers?: RecruitmentUpdate["expiredOffers"]
  ) => RecruitmentUpdate;
  /** Persists the task-owner notification before the assignment transaction commits. */
  enqueueAssignmentNotification: (
    state: PersistentState,
    event: EventRecord,
    deviceInstanceId: string,
    assignment: AssignmentView,
    occurredAt: string
  ) => void;
}

export interface AssignmentStatusResult {
  view: AssignmentView;
  changed: boolean;
  occurredAt: string;
  update: RecruitmentUpdate | undefined;
}

function assignmentView(assignment: AssignmentRecord): AssignmentView {
  return {
    id: assignment.id,
    eventId: assignment.eventId,
    role: assignment.role,
    status: assignment.status,
    revision: assignment.revision,
    route: assignment.route ?? null,
    aedAcquiredReceipt: assignment.aedAcquiredReceipt ?? null
  };
}

/** Owns the ordinary assignment state transition and its transaction. */
export async function runAssignmentStatusUpdate(
  dependencies: AssignmentStatusUseCaseDependencies,
  device: DevicePrincipal,
  eventId: string,
  assignmentId: string,
  status: AssignmentStatus,
  occurredAt: string
): Promise<AssignmentStatusResult> {
  const serverReceivedAt = dependencies.now();
  const claimedOccurredAt = dependencies.validateActionTime(
    occurredAt,
    "occurredAt",
    serverReceivedAt
  );
  return transactState(dependencies.store, (state) => {
    const event = state.events[eventId];
    const assignment = state.assignments[assignmentId];
    if (!event || !assignment || assignment.eventId !== eventId
      || assignment.deviceInstanceId !== device.deviceInstanceId) {
      throw notFound("Assignment is not visible to this device");
    }
    if (device.userId && event.exitedResponderUserIds?.includes(device.userId)) {
      throw forbidden("An exited responder has no event assignment permission");
    }
    dependencies.markDeviceSeen(state, device.deviceInstanceId, serverReceivedAt.toISOString());
    if (event.state !== "ACTIVE") throw conflict("Event is not active");
    if (["AED_ACQUIRED", "AED_UNAVAILABLE", "TIMED_OUT", "CANCELLED"].includes(status)) {
      throw conflict(`${status} must be produced by its dedicated server action`);
    }
    if (assignment.status === status) {
      return {
        view: assignmentView(assignment),
        changed: false,
        occurredAt: assignment.updatedAt,
        update: undefined as RecruitmentUpdate | undefined
      };
    }
    if (!assignmentTransitionAllowed(assignment.role, assignment.status, status)) {
      throw conflict(`Assignment cannot advance from ${assignment.status} to ${status}`);
    }
    const effectiveOccurredAt = dependencies.effectiveActionTime(
      claimedOccurredAt,
      "occurredAt",
      assignment.updatedAt,
      "current assignment updatedAt",
      serverReceivedAt
    );
    event.assignmentRevision += 1;
    assignment.status = status;
    assignment.revision = event.assignmentRevision;
    assignment.updatedAt = effectiveOccurredAt;
    appendTimeline(
      state,
      eventId,
      effectiveOccurredAt,
      "ASSIGNMENT_UPDATED",
      `Assignment ${assignment.id} advanced to ${status}.`
    );
    if (dependencies.allCurrentAssignmentsCompleted(state, eventId)) {
      event.recruitmentState = "COMPLETED";
    }
    event.coordinationRevision += 1;
    const view = assignmentView(assignment);
    const update = dependencies.recruitmentUpdate(state, event, []);
    dependencies.enqueueAssignmentNotification(
      state,
      event,
      assignment.deviceInstanceId,
      view,
      effectiveOccurredAt
    );
    reconcileEventAssets(state, eventId, serverReceivedAt.toISOString());
    return {
      view,
      changed: true,
      occurredAt: effectiveOccurredAt,
      update
    };
  });
}
