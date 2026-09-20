import { reconcileEventAssets } from "./aed-assets.js";
import { readState, transactState, stateRows } from "./incremental-state.js";
import { appendTimeline } from "./event-audit.js";
import {
  fingerprint,
  isTerminalAssignmentStatus
} from "./domain.js";
import {
  conflict,
  forbidden,
  notFound,
  soleResponderConfirmationRequired
} from "./errors.js";
import type { DevicePrincipal } from "./identity-access.js";
import type { ParticipantExitRequest, PatientPosition } from "./contracts.js";
import type {
  AssignmentRecord,
  AssignmentView,
  CoordinationSummary,
  DeliveryRecord,
  DeviceRecord,
  EventPositionEvidenceRecord,
  EventRecord,
  ParticipantExitRecord,
  ParticipantIntervalRecord,
  PersistentState,
  ResponseRequestPayload
} from "./models.js";
import type { StateStore } from "./store.js";

const pendingDeliveryStatuses: Array<"SENT" | "DELIVERED" | "VIEWED"> = [
  "SENT",
  "DELIVERED",
  "VIEWED"
];

function isPendingDeliveryStatus(
  status: DeliveryRecord["status"]
): status is "SENT" | "DELIVERED" | "VIEWED" {
  return pendingDeliveryStatuses.includes(status as "SENT" | "DELIVERED" | "VIEWED");
}

interface AssignmentEmission {
  deviceInstanceId: string;
  name: "assignment:created" | "assignment:updated";
  assignment: AssignmentView;
  occurredAt: string;
}

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

interface RecruitmentRefresh {
  requests: ResponseRequestPayload[];
  previousAudience: string[];
  expiredOffers: RecruitmentUpdate["expiredOffers"];
  /** The event after the refresh; see the note in response-decision.ts. */
  event: EventRecord;
}

export interface ResponderExitUseCaseDependencies {
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
  acceptedDeviceIds: (state: Readonly<PersistentState>, eventId: string) => string[];
  participantIntervalForDevice: (
    state: Readonly<PersistentState>,
    eventId: string,
    userId: string,
    deviceInstanceId: string
  ) => ParticipantIntervalRecord | undefined;
  endParticipantInterval: (
    state: PersistentState,
    eventId: string,
    userId: string,
    deviceInstanceId: string,
    endedAt: string,
    reason: NonNullable<ParticipantIntervalRecord["endReason"]>
  ) => void;
  hasCurrentPatientPosition: (event: EventRecord) => PatientPosition | undefined;
  coordinationAudienceDeviceIds: (state: Readonly<PersistentState>, event: EventRecord) => string[];
  replanAssignments: (
    state: PersistentState,
    event: EventRecord,
    at: Date
  ) => AssignmentEmission[];
  refreshRecruitmentForEvent: (
    state: PersistentState,
    event: EventRecord,
    now: Date,
    forceRevision?: boolean
  ) => RecruitmentRefresh;
  recruitmentUpdate: (
    state: PersistentState,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience?: readonly string[],
    expiredOffers?: RecruitmentUpdate["expiredOffers"]
  ) => RecruitmentUpdate;
  /** Persists assignment fan-out produced by this exit transaction. */
  enqueueAssignmentEmissions: (
    state: PersistentState,
    event: EventRecord,
    emissions: readonly AssignmentEmission[]
  ) => void;
  enqueueParticipantExitNotification: (
    state: PersistentState,
    event: EventRecord,
    deviceInstanceIds: readonly string[],
    exitId: string,
    occurredAt: string,
    coordinationRevision: number
  ) => void;
  recruitmentTargetAccepted: number;
}

export interface ResponderExitResult {
  ack: {
    exitId: string;
    eventId: string;
    exitedAt: string;
    idempotent: boolean;
  };
  changed: boolean;
  audience: string[];
  assignmentEmissions: AssignmentEmission[];
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

function eventPositionRecordExclusiveEndLowerBound(
  record: EventPositionEvidenceRecord
): string {
  const includedAt = record.status === "FIX" ? record.fixObservedAt : record.slotAt;
  return new Date(Date.parse(includedAt) + 1).toISOString();
}

/**
 * Canonical accepted-responder exit use case. It owns all state mutation and
 * idempotency inside one transaction; service-level code only authenticates
 * the iPhone and publishes the committed outcome.
 */
export async function runResponderExit(
  dependencies: ResponderExitUseCaseDependencies,
  device: DevicePrincipal,
  eventId: string,
  request: ParticipantExitRequest
): Promise<ResponderExitResult> {
  const serverReceivedAt = dependencies.now();
  const claimedExitedAt = dependencies.validateActionTime(
    request.exitedAt,
    "exitedAt",
    serverReceivedAt
  );
  const exitFingerprint = fingerprint({ ...request, exitedAt: claimedExitedAt });
  return transactState(dependencies.store, (state) => {
    const event = state.events[eventId];
    const responderDevice = state.devices[device.deviceInstanceId];
    if (!event || !responderDevice) throw notFound("Event does not exist");
    const userId = responderDevice.userId ?? device.userId;
    if (!userId) throw forbidden("An authenticated user identity is required to exit");

    const prior = state.participantExitsById[request.exitId];
    if (prior) {
      if (prior.eventId !== eventId
        || prior.deviceInstanceId !== responderDevice.deviceInstanceId
        || prior.userId !== userId
        || prior.fingerprint !== exitFingerprint) {
        throw conflict("exitId was already used with different content");
      }
      return {
        ack: {
          exitId: prior.exitId,
          eventId: prior.eventId,
          exitedAt: prior.exitedAt,
          idempotent: true
        },
        changed: false,
        audience: [] as string[],
        assignmentEmissions: [] as AssignmentEmission[],
        update: undefined as RecruitmentUpdate | undefined
      };
    }
    if (event.state !== "ACTIVE") throw conflict("Event is already terminal");
    if (event.patientUserId === userId || event.exitedResponderUserIds?.includes(userId)) {
      throw forbidden("The patient or an exited responder cannot exit as a responder");
    }
    const acceptedDelivery = stateRows(state, "deliveries", "eventId", eventId).find((delivery) =>
      delivery.eventId === eventId
        && delivery.deviceInstanceId === responderDevice.deviceInstanceId
        && delivery.decision === "ACCEPT"
        && delivery.status === "ACCEPTED"
    );
    if (!acceptedDelivery) throw forbidden("Only an accepted responder can exit this event");
    if (dependencies.acceptedDeviceIds(state, eventId).length === 1
      && request.soleResponderConfirmed !== true) {
      throw soleResponderConfirmationRequired();
    }
    const participantInterval = dependencies.participantIntervalForDevice(
      state,
      eventId,
      userId,
      responderDevice.deviceInstanceId
    );
    if (!participantInterval) {
      throw conflict("Accepted responder participation interval is unavailable");
    }
    const responderAssignmentTimes = stateRows(state, "assignments", "eventId", eventId)
      .filter((assignment) => assignment.eventId === eventId
        && state.devices[assignment.deviceInstanceId]?.userId === userId)
      .map((assignment) => assignment.updatedAt);
    const responderEvidenceEndTimes = stateRows(state, "eventPositionBatchesById", "eventId", eventId)
      .filter((batch) => batch.eventId === eventId && batch.userId === userId)
      .flatMap((batch) => batch.records.map(eventPositionRecordExclusiveEndLowerBound));
    const exitCausalLowerBoundAt = [
      participantInterval.acceptedAt,
      ...responderAssignmentTimes,
      ...responderEvidenceEndTimes
    ].reduce((latest, candidate) => Date.parse(candidate) > Date.parse(latest) ? candidate : latest);
    const exitedAt = dependencies.effectiveActionTime(
      claimedExitedAt,
      "exitedAt",
      exitCausalLowerBoundAt,
      "participant/current assignment/evidence time",
      serverReceivedAt,
      "CLAMP"
    );
    dependencies.endParticipantInterval(
      state,
      eventId,
      userId,
      responderDevice.deviceInstanceId,
      exitedAt,
      "RESPONDER_EXIT"
    );

    const expiredOffers: RecruitmentUpdate["expiredOffers"] = [];
    for (const delivery of stateRows(state, "deliveries", "eventId", eventId)) {
      if (delivery.eventId !== eventId || !isPendingDeliveryStatus(delivery.status)) continue;
      const deliveryDevice = state.devices[delivery.deviceInstanceId];
      if (deliveryDevice?.userId !== userId) continue;
      delivery.status = "EXPIRED";
      delivery.statusOccurredAt = exitedAt;
      expiredOffers.push({
        deviceInstanceId: delivery.deviceInstanceId,
        deliveryId: delivery.id,
        expiresAt: delivery.request.expiresAt,
        reason: "OFFER_NO_LONGER_ELIGIBLE"
      });
      appendTimeline(
        state,
        eventId,
        exitedAt,
        "PASSIVE_OBSERVATION",
        `Response delivery ${delivery.id} expired because its responder exited the event.`
      );
    }

    event.exitedResponderUserIds ??= [];
    event.exitedResponderUserIds.push(userId);
    const record: ParticipantExitRecord = {
      exitId: request.exitId,
      eventId,
      deviceInstanceId: responderDevice.deviceInstanceId,
      userId,
      exitedAt,
      fingerprint: exitFingerprint,
      ...(request.reason === undefined ? {} : { reason: request.reason })
    };
    state.participantExitsById[request.exitId] = record;

    for (const assignment of stateRows(state, "assignments", "eventId", eventId)) {
      const assignmentDevice = state.devices[assignment.deviceInstanceId];
      if (assignment.eventId !== eventId
        || assignmentDevice?.userId !== userId
        || isTerminalAssignmentStatus(assignment.status)) continue;
      const acquiredReceipt = assignment.aedAcquiredReceipt;
      event.assignmentRevision += 1;
      assignment.status = "CANCELLED";
      assignment.revision = event.assignmentRevision;
      assignment.updatedAt = exitedAt;
      dependencies.endParticipantInterval(
        state,
        eventId,
        userId,
        assignment.deviceInstanceId,
        exitedAt,
        "RESPONDER_EXIT"
      );
      appendTimeline(
        state,
        eventId,
        exitedAt,
        "ASSIGNMENT_UPDATED",
        `Assignment ${assignment.id} was cancelled because its responder exited the event.`
      );
      if (acquiredReceipt) {
        appendTimeline(
          state,
          eventId,
          exitedAt,
          "PASSIVE_OBSERVATION",
          `AED ${acquiredReceipt.aedId} handoff remains pending after responder ${userId} exited; the acquired AED stays reserved as event evidence.`
        );
      }
    }

    for (const participantDevice of stateRows(state, "devices", "userId", userId)) {
      if (participantDevice.userId !== userId) continue;
      if (participantDevice.currentEventId === eventId) delete participantDevice.currentEventId;
      const assignment = participantDevice.currentAssignmentId
        ? state.assignments[participantDevice.currentAssignmentId]
        : undefined;
      if (assignment?.eventId === eventId) delete participantDevice.currentAssignmentId;
      if (participantDevice.latestPosition) delete participantDevice.latestPosition;
      participantDevice.lastSeenAt = serverReceivedAt.toISOString();
    }
    reconcileEventAssets(state, eventId, exitedAt);
    event.coordinationRevision += 1;
    const remainingAcceptedDeviceIds = dependencies.acceptedDeviceIds(state, eventId);
    if (remainingAcceptedDeviceIds.length < dependencies.recruitmentTargetAccepted) {
      event.recruitmentState = "RECRUITING";
    }
    const assignmentEmissions = remainingAcceptedDeviceIds.length > 0
      && dependencies.hasCurrentPatientPosition(event)
      ? dependencies.replanAssignments(state, event, serverReceivedAt)
      : [];
    appendTimeline(
      state,
      eventId,
      exitedAt,
      "RESPONDER_EXITED",
      "An accepted responder explicitly exited; its event position and communication access were revoked."
    );
    const audience = dependencies.coordinationAudienceDeviceIds(state, event);
    const refreshedRecruitment = dependencies.refreshRecruitmentForEvent(
      state,
      event,
      serverReceivedAt,
      true
    );
    dependencies.enqueueAssignmentEmissions(state, refreshedRecruitment.event, assignmentEmissions);
    const update = dependencies.recruitmentUpdate(
      state,
      refreshedRecruitment.event,
      refreshedRecruitment.requests,
      audience,
      [...expiredOffers, ...refreshedRecruitment.expiredOffers]
    );
    dependencies.enqueueParticipantExitNotification(
      state,
      refreshedRecruitment.event,
      audience,
      request.exitId,
      exitedAt,
      update.coordination.revision
    );
    return {
      ack: {
        exitId: request.exitId,
        eventId,
        exitedAt,
        idempotent: false
      },
      changed: true,
      audience,
      assignmentEmissions,
      update
    };
  });
}
