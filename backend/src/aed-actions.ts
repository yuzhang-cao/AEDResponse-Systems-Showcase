import { acquireAsset, markAssetUnavailable, routingAeds, reconcileEventAssets } from "./aed-assets.js";
import { transactState, stateRows } from "./incremental-state.js";
import { appendTimeline } from "./event-audit.js";
import { fingerprint, isTerminalAssignmentStatus } from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";
import { randomUUID } from "node:crypto";
import type { DevicePrincipal } from "./identity-access.js";
import type { AedRouteProvider } from "./route-provider.js";
import type {
  AedAcquiredReceipt,
  AedUnavailableReport,
  PatientPosition,
  ResponderPosition
} from "./contracts.js";
import type {
  AssignmentRecord,
  AssignmentView,
  CoordinationSummary,
  DeviceRecord,
  EventRecord,
  PersistentState,
  ResponseRequestPayload,

} from "./models.js";
import type { StateStore } from "./store.js";

interface AssignmentEmission {
  deviceInstanceId: string;
  name: "assignment:created" | "assignment:updated";
  assignment: AssignmentView;
  occurredAt: string;
}

interface AedActionRecruitmentUpdate {
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

export interface AedActionDependencies {
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
  participantDeviceIds: (state: Readonly<PersistentState>, event: EventRecord) => string[];
  currentResponderPosition: (device: DeviceRecord | undefined) => ResponderPosition | undefined;
  currentPatientPosition: (event: EventRecord) => PatientPosition | undefined;
  routeProvider: AedRouteProvider;
  recruitmentUpdate: (
    state: PersistentState,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience?: readonly string[],
    expiredOffers?: AedActionRecruitmentUpdate["expiredOffers"]
  ) => AedActionRecruitmentUpdate;
  enqueueAssignmentEmissions: (
    state: PersistentState,
    event: EventRecord,
    emissions: readonly AssignmentEmission[]
  ) => void;
  enqueueAedAcquiredNotification: (
    state: PersistentState,
    event: EventRecord,
    deviceInstanceIds: readonly string[],
    receipt: AedAcquiredReceipt
  ) => void;
  /**
   * Required: the outbox identity is (name, messageId, deviceInstanceId), so a
   * missing discriminator would make every `aed:unavailable` intent share one
   * row and let the second report abort its business transaction.
   */
  enqueueAedUnavailableNotification: (
    state: PersistentState,
    event: EventRecord,
    deviceInstanceIds: readonly string[],
    assignmentId: string,
    aedId: string,
    occurredAt: string,
    messageDiscriminator: string
  ) => void;
}

export interface AcquireAedResult {
  created: boolean;
  receipt: AedAcquiredReceipt;
  participants: string[];
  unavailable: AssignmentRecord[];
  update: AedActionRecruitmentUpdate | undefined;
}

export interface ReportAedUnavailableResult {
  created: boolean;
  report: AedUnavailableReport;
  participants: string[];
  replacement: AssignmentRecord | undefined;
  update: AedActionRecruitmentUpdate | undefined;
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

/**
 * Owns the AED acquired fact, its idempotency keys, and the same-transaction
 * invalidation of competing FETCH_AED assignments. The service only adapts
 * the authenticated device and publishes the committed result.
 */
export async function runAcquireAed(
  dependencies: AedActionDependencies,
  device: DevicePrincipal,
  eventId: string,
  assignmentId: string,
  receipt: AedAcquiredReceipt
): Promise<AcquireAedResult> {
  if (receipt.eventId !== eventId || receipt.assignmentId !== assignmentId) {
    throw conflict("Receipt eventId/assignmentId must match the path");
  }
  const serverReceivedAt = dependencies.now();
  const claimedReceipt: AedAcquiredReceipt = {
    ...receipt,
    acquiredAt: dependencies.validateActionTime(receipt.acquiredAt, "acquiredAt", serverReceivedAt)
  };
  const receiptFingerprint = fingerprint(claimedReceipt);
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
    if (assignment.role !== "FETCH_AED" || assignment.route?.aedId !== claimedReceipt.aedId) {
      throw conflict("Receipt AED does not match a FETCH_AED assignment route");
    }
    const byId = state.aedReceiptsById[claimedReceipt.receiptId];
    if (byId) {
      if (byId.fingerprint !== receiptFingerprint) {
        throw conflict("receiptId was already used with different content");
      }
      return {
        created: false,
        receipt: byId.canonical,
        participants: [] as string[],
        unavailable: [] as AssignmentRecord[],
        update: undefined as AedActionRecruitmentUpdate | undefined
      };
    }
    const businessKey = `${eventId}|${assignmentId}|${claimedReceipt.aedId}`;
    const existingBusinessReceiptId = state.aedReceiptIdByBusinessKey[businessKey];
    if (existingBusinessReceiptId) {
      const canonical = state.aedReceiptsById[existingBusinessReceiptId]?.canonical;
      if (!canonical) throw conflict("AED receipt index is inconsistent");
      state.aedReceiptsById[claimedReceipt.receiptId] = {
        canonical,
        fingerprint: receiptFingerprint
      };
      return {
        created: false,
        receipt: canonical,
        participants: [] as string[],
        unavailable: [] as AssignmentRecord[],
        update: undefined as AedActionRecruitmentUpdate | undefined
      };
    }
    if (event.state !== "ACTIVE") throw conflict("Event is not active");
    if (assignment.role !== "FETCH_AED" || assignment.status !== "ARRIVED_AT_AED") {
      throw conflict("AED_ACQUIRED requires a FETCH_AED assignment at ARRIVED_AT_AED");
    }
    if (assignment.route?.aedId !== claimedReceipt.aedId) {
      throw conflict("Receipt AED does not match the assignment route");
    }
    const eventAedKey = `${eventId}|${claimedReceipt.aedId}`;
    const claimedReceiptId = state.aedReceiptIdByEventAed[eventAedKey];
    if (claimedReceiptId) {
      throw conflict("This AED was already acquired for the event");
    }

    const acquiredAt = dependencies.effectiveActionTime(
      claimedReceipt.acquiredAt,
      "acquiredAt",
      assignment.updatedAt,
      "current assignment updatedAt",
      serverReceivedAt
    );
    const effectiveReceipt: AedAcquiredReceipt = {
      ...claimedReceipt,
      acquiredAt
    };

    acquireAsset(state, claimedReceipt.aedId, eventId, device.deviceInstanceId, serverReceivedAt.toISOString());
    state.aedReceiptsById[claimedReceipt.receiptId] = {
      canonical: effectiveReceipt,
      fingerprint: receiptFingerprint
    };
    state.aedReceiptIdByBusinessKey[businessKey] = claimedReceipt.receiptId;
    state.aedReceiptIdByEventAed[eventAedKey] = claimedReceipt.receiptId;
    if (!event.unavailableAedIds.includes(claimedReceipt.aedId)) {
      event.unavailableAedIds.push(claimedReceipt.aedId);
    }
    event.assignmentRevision += 1;
    assignment.status = "AED_ACQUIRED";
    assignment.aedAcquiredReceipt = effectiveReceipt;
    assignment.revision = event.assignmentRevision;
    assignment.updatedAt = acquiredAt;
    appendTimeline(
      state,
      eventId,
      acquiredAt,
      "AED_ACQUIRED",
      `AED ${claimedReceipt.aedId} was acquired for assignment ${assignmentId}.`
    );

    const unavailable: AssignmentRecord[] = [];
    for (const other of stateRows(state, "assignments", "eventId", eventId)) {
      if (other.id === assignment.id || other.eventId !== eventId
        || other.role !== "FETCH_AED" || isTerminalAssignmentStatus(other.status)
        || other.route?.aedId !== claimedReceipt.aedId) continue;
      event.assignmentRevision += 1;
      other.status = "AED_UNAVAILABLE";
      other.revision = event.assignmentRevision;
      other.updatedAt = acquiredAt;
      unavailable.push(structuredClone(other));
      appendTimeline(
        state,
        eventId,
        acquiredAt,
        "AED_UNAVAILABLE",
        `Assignment ${other.id} stopped because AED ${claimedReceipt.aedId} was already acquired.`
      );
    }
    reconcileEventAssets(state, eventId, serverReceivedAt.toISOString());
    event.coordinationRevision += 1;
    const participants = dependencies.participantDeviceIds(state, event);
    dependencies.enqueueAedAcquiredNotification(state, event, participants, effectiveReceipt);
    for (const unavailableAssignment of unavailable) {
      dependencies.enqueueAedUnavailableNotification(
        state,
        event,
        participants,
        unavailableAssignment.id,
        effectiveReceipt.aedId,
        effectiveReceipt.acquiredAt,
        // One invalidated competitor is one fact, keyed by its id and revision.
        `claimed:${unavailableAssignment.id}:${unavailableAssignment.revision}`
      );
    }
    return {
      created: true,
      receipt: effectiveReceipt,
      participants,
      unavailable,
      update: dependencies.recruitmentUpdate(state, event, [])
    };
  });
}

/**
 * Owns the AED_UNAVAILABLE fact and optional replacement assignment. The
 * replacement, assignment revision and durable assignment notification are
 * committed atomically with the report; no client chooses the replacement.
 */
export async function runReportAedUnavailable(
  dependencies: AedActionDependencies,
  device: DevicePrincipal,
  eventId: string,
  assignmentId: string,
  report: AedUnavailableReport
): Promise<ReportAedUnavailableResult> {
  if (report.eventId !== eventId || report.assignmentId !== assignmentId) {
    throw conflict("Report eventId/assignmentId must match the path");
  }
  const serverReceivedAt = dependencies.now();
  const claimedReport: AedUnavailableReport = {
    ...report,
    reportedAt: dependencies.validateActionTime(report.reportedAt, "reportedAt", serverReceivedAt)
  };
  const reportFingerprint = fingerprint(claimedReport);
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
    if (assignment.role !== "FETCH_AED" || assignment.route?.aedId !== claimedReport.aedId) {
      throw conflict("AED_UNAVAILABLE must match a FETCH_AED route");
    }
    const existing = state.aedUnavailableByReportId[claimedReport.reportId];
    if (existing) {
      if (existing.fingerprint !== reportFingerprint) {
        throw conflict("reportId was already used with different content");
      }
      return {
        created: false,
        report: existing.canonical,
        participants: [] as string[],
        replacement: undefined as AssignmentRecord | undefined,
        update: undefined as AedActionRecruitmentUpdate | undefined
      };
    }
    if (event.state !== "ACTIVE") throw conflict("Event is not active");
    if (assignment.aedAcquiredReceipt) {
      throw conflict("An acquired AED cannot be marked unavailable or reassigned");
    }
    if (isTerminalAssignmentStatus(assignment.status)) {
      throw conflict("Assignment is already terminal");
    }

    const reportedAt = dependencies.effectiveActionTime(
      claimedReport.reportedAt,
      "reportedAt",
      assignment.updatedAt,
      "current assignment updatedAt",
      serverReceivedAt
    );
    const effectiveReport: AedUnavailableReport = {
      ...claimedReport,
      reportedAt
    };

    markAssetUnavailable(state, claimedReport.aedId, eventId, reportedAt);
    state.aedUnavailableByReportId[claimedReport.reportId] = {
      canonical: effectiveReport,
      fingerprint: reportFingerprint
    };
    if (!event.unavailableAedIds.includes(claimedReport.aedId)) {
      event.unavailableAedIds.push(claimedReport.aedId);
    }
    event.assignmentRevision += 1;
    assignment.status = "AED_UNAVAILABLE";
    assignment.revision = event.assignmentRevision;
    assignment.updatedAt = reportedAt;
    appendTimeline(
      state,
      eventId,
      reportedAt,
      "AED_UNAVAILABLE",
      `AED ${claimedReport.aedId} was reported unavailable for assignment ${assignmentId}.`
    );

    const deviceRecord = state.devices[device.deviceInstanceId];
    const responderPosition = dependencies.currentResponderPosition(deviceRecord);
    const patientPosition = dependencies.currentPatientPosition(event);
    let replacement: AssignmentRecord | undefined;
    if (responderPosition && patientPosition) {
      const reservedAedIds = stateRows(state, "assignments", "eventId", eventId)
        .filter((candidate) => candidate.eventId === eventId
          && candidate.id !== assignmentId
          && candidate.role === "FETCH_AED"
          && !isTerminalAssignmentStatus(candidate.status)
          && candidate.route)
        .map((candidate) => candidate.route!.aedId);
      const routeResult = dependencies.routeProvider.bestRoute({
        responder: responderPosition,
        patient: patientPosition,
        aeds: routingAeds(state, serverReceivedAt, eventId),
        unavailableAedIds: new Set([...event.unavailableAedIds, ...reservedAedIds]),
        at: serverReceivedAt
      });
      if (routeResult.kind === "AVAILABLE") {
        const route = routeResult.value;
        event.assignmentRevision += 1;
        replacement = {
          id: randomUUID(),
          eventId,
          deviceInstanceId: device.deviceInstanceId,
          role: "FETCH_AED",
          status: "ASSIGNED",
          revision: event.assignmentRevision,
          route,
          aedAcquiredReceipt: null,
          createdAt: reportedAt,
          updatedAt: reportedAt
        };
        state.assignments[replacement.id] = replacement;
        if (deviceRecord) {
          deviceRecord.currentEventId = eventId;
          deviceRecord.currentAssignmentId = replacement.id;
        }
        appendTimeline(
          state,
          eventId,
          reportedAt,
          "ASSIGNMENT_CREATED",
          `Replacement assignment ${replacement.id} created after AED_UNAVAILABLE.`
        );
        dependencies.enqueueAssignmentEmissions(state, event, [{
          deviceInstanceId: replacement.deviceInstanceId,
          name: "assignment:created",
          assignment: assignmentView(replacement),
          occurredAt: reportedAt
        }]);
      }
    }
    reconcileEventAssets(state, eventId, serverReceivedAt.toISOString());
    event.coordinationRevision += 1;
    const participants = dependencies.participantDeviceIds(state, event);
    dependencies.enqueueAedUnavailableNotification(
      state,
      event,
      participants,
      assignmentId,
      effectiveReport.aedId,
      effectiveReport.reportedAt,
      // A terminal assignment can report unavailability exactly once, so the
      // assignment id is the stable business key for this broadcast.
      assignmentId
    );
    return {
      created: true,
      report: effectiveReport,
      participants,
      replacement,
      update: dependencies.recruitmentUpdate(state, event, [])
    };
  });
}
