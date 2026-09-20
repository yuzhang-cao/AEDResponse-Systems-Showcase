import { transactState, stateRows } from "./incremental-state.js";
import { fingerprint, isTerminalAssignmentStatus } from "./domain.js";
import { transitionEventToTerminal } from "./event-lifecycle.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { DevicePrincipal, Principal } from "./identity-access.js";
import type { EventEndReason, ResolutionRequest } from "./contracts.js";
import type {
  CoordinationSummary,
  EmergencyEventView,
  EventPositionEvidenceRecord,
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

export interface EventResolutionUseCaseDependencies {
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
  requireIPhone: (principal: Principal) => DevicePrincipal;
  authorizeResolution: (
    state: Readonly<PersistentState>,
    event: EventRecord,
    principal: Principal,
    actor: ResolutionRequest["actor"]
  ) => void;
  isPatientDevice: (
    state: Readonly<PersistentState>,
    event: EventRecord,
    deviceInstanceId: string
  ) => boolean;
  markDeviceSeen: (state: PersistentState, deviceInstanceId: string, at: string) => void;
  coordinationAudienceDeviceIds: (state: Readonly<PersistentState>, event: EventRecord) => string[];
  affectedDeviceIds: (state: Readonly<PersistentState>, event: EventRecord) => string[];
  eventProjection: (
    state: Readonly<PersistentState>,
    event: EventRecord,
    principal: Principal,
    coordination: CoordinationSummary,
    includeSensitive: boolean,
    now: Date
  ) => EmergencyEventView | undefined;
  operatorProjection: (event: EventRecord, coordination: CoordinationSummary) => EmergencyEventView;
  coordinationSummary: (
    state: Readonly<PersistentState>,
    event: EventRecord,
    now: Date
  ) => CoordinationSummary;
  recruitmentUpdate: (
    state: PersistentState,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience?: readonly string[],
    expiredOffers?: RecruitmentUpdate["expiredOffers"]
  ) => RecruitmentUpdate;
  enqueueTerminalNotifications: (
    state: PersistentState,
    event: EventRecord,
    messageId: string,
    devices: readonly string[],
    update: RecruitmentUpdate
  ) => void;
}

export interface EventResolutionResult {
  view: EmergencyEventView | undefined;
  devices: string[];
  changed: boolean;
  resolvedAt: string;
  update: RecruitmentUpdate | undefined;
}

const pendingDeliveryStatuses = new Set(["SENT", "DELIVERED", "VIEWED"]);

function eventPositionRecordExclusiveEndLowerBound(
  record: EventPositionEvidenceRecord
): string {
  const includedAt = record.status === "FIX" ? record.fixObservedAt : record.slotAt;
  return new Date(Date.parse(includedAt) + 1).toISOString();
}

/** Owns the canonical end/resolve transaction and its idempotency record. */
export async function runEventResolution(
  dependencies: EventResolutionUseCaseDependencies,
  principal: Principal,
  eventId: string,
  request: ResolutionRequest
): Promise<EventResolutionResult> {
  const serverReceivedAt = dependencies.now();
  const resolutionReason: EventEndReason = request.reason
    ?? (request.actor === "ON_SCENE_RESPONDER" ? "PROFESSIONAL_TAKEOVER" : "PROBLEM_RESOLVED");
  const claimedRequest: ResolutionRequest = {
    ...request,
    resolvedAt: dependencies.validateActionTime(request.resolvedAt, "resolvedAt", serverReceivedAt),
    reason: resolutionReason
  };
  if (claimedRequest.actor === "ON_SCENE_RESPONDER"
    && resolutionReason !== "PROFESSIONAL_TAKEOVER") {
    throw badRequest("An on-scene responder may only confirm professional takeover");
  }
  if (resolutionReason === "ASSISTANCE_WITHDRAWN" && (claimedRequest.actor !== "PATIENT" || claimedRequest.withdrawalConfirmed !== true)) {
    throw conflict("Patient withdrawal requires the completed cancellation confirmation flow");
  }
  const resolutionFingerprint = fingerprint(claimedRequest);
  return transactState(dependencies.store, (state) => {
    const prior = state.resolutionsById[claimedRequest.resolutionId];
    if (prior) {
      if (prior.eventId !== eventId || prior.fingerprint !== resolutionFingerprint) {
        throw conflict("resolutionId was already used with different content");
      }
      const existingEvent = state.events[eventId];
      if (!existingEvent) throw notFound("Event does not exist");
      if (claimedRequest.actor === "AUTHORIZED_OPERATOR") {
        if (principal.kind !== "OPERATOR") {
          throw forbidden("AUTHORIZED_OPERATOR requires the out-of-band operator credential");
        }
      } else {
        const device = dependencies.requireIPhone(principal);
        if (prior.actor !== claimedRequest.actor
          || prior.actorDeviceInstanceId !== device.deviceInstanceId) {
          throw forbidden("Resolution idempotency is limited to its original actor device");
        }
      }
      return {
        view: principal.kind === "OPERATOR"
          ? dependencies.operatorProjection(
            existingEvent,
            dependencies.coordinationSummary(state, existingEvent, dependencies.now())
          )
          : dependencies.eventProjection(
            state,
            existingEvent,
            principal,
            dependencies.coordinationSummary(state, existingEvent, dependencies.now()),
            false,
            dependencies.now()
          ),
        devices: [] as string[],
        changed: false,
        resolvedAt: existingEvent.resolvedAt ?? existingEvent.createdAt,
        update: undefined as RecruitmentUpdate | undefined
      };
    }

    const event = state.events[eventId];
    if (!event) throw notFound("Event does not exist");
    if (event.state !== "ACTIVE") throw conflict("Event is already terminal");
    dependencies.authorizeResolution(state, event, principal, claimedRequest.actor);
    const resolutionCausalTimes = [
      event.createdAt,
      ...stateRows(state, "participantIntervalsById", "eventId", eventId)
        .filter((interval) => interval.eventId === event.id && interval.endedAt === undefined)
        .map((interval) => interval.acceptedAt),
      ...stateRows(state, "assignments", "eventId", eventId)
        .filter((assignment) => assignment.eventId === event.id
          && !isTerminalAssignmentStatus(assignment.status))
        .map((assignment) => assignment.updatedAt),
      ...stateRows(state, "deliveries", "eventId", eventId)
        .filter((delivery) => delivery.eventId === event.id
          && pendingDeliveryStatuses.has(delivery.status))
        .map((delivery) => delivery.statusOccurredAt),
      ...stateRows(state, "eventPositionBatchesById", "eventId", eventId)
        .filter((batch) => batch.eventId === event.id)
        .flatMap((batch) => batch.records.map(eventPositionRecordExclusiveEndLowerBound)),
      ...(event.statusConfirmation?.state === "PENDING"
        ? [event.statusConfirmation.sentAt]
        : [])
    ];
    const resolutionCausalLowerBoundAt = resolutionCausalTimes.reduce(
      (latest, candidate) => Date.parse(candidate) > Date.parse(latest) ? candidate : latest
    );
    const resolvedAt = dependencies.effectiveActionTime(
      claimedRequest.resolvedAt,
      "resolvedAt",
      resolutionCausalLowerBoundAt,
      "event/current coordination state time",
      serverReceivedAt,
      "CLAMP"
    );
    if (principal.kind === "DEVICE") {
      dependencies.markDeviceSeen(state, principal.deviceInstanceId, serverReceivedAt.toISOString());
    }
    const devices = dependencies.coordinationAudienceDeviceIds(state, event);
    const isFalseAlarm = resolutionReason === "FALSE_ALARM";
    const expiredOffers = transitionEventToTerminal(state, event, {
      reason: resolutionReason,
      occurredAt: resolvedAt,
      affectedDeviceIds: dependencies.affectedDeviceIds(state, event),
      audit: {
        kind: isFalseAlarm ? "FALSE_ALARM_CONFIRMED" : "EVENT_RESOLVED",
        message: isFalseAlarm
          ? `Event false alarm was confirmed by ${claimedRequest.actor}.`
          : `Event was ended as ${resolutionReason} by ${claimedRequest.actor}.`
      }
    });
    state.resolutionsById[claimedRequest.resolutionId] = {
      eventId,
      resolutionId: claimedRequest.resolutionId,
      fingerprint: resolutionFingerprint,
      actor: claimedRequest.actor,
      reason: resolutionReason,
      ...(principal.kind === "DEVICE"
        ? { actorDeviceInstanceId: principal.deviceInstanceId }
        : {})
    };
    const view = principal.kind === "OPERATOR"
      ? dependencies.operatorProjection(event, dependencies.coordinationSummary(state, event, dependencies.now()))
      : dependencies.eventProjection(
        state,
        event,
        principal,
        dependencies.coordinationSummary(state, event, dependencies.now()),
        false,
        dependencies.now()
      );
    const update = dependencies.recruitmentUpdate(state, event, []);
    update.audience = devices;
    update.expiredOffers = expiredOffers;
    dependencies.enqueueTerminalNotifications(
      state,
      event,
      `${isFalseAlarm ? "false-alarm" : "event-resolved"}:${claimedRequest.resolutionId}`,
      devices,
      update
    );
    return { view, devices, changed: true, resolvedAt, update };
  });
}

/** Owns the legacy patient false-alarm action without a second service writer. */
export async function runFalseAlarmConfirmation(
  dependencies: EventResolutionUseCaseDependencies,
  device: DevicePrincipal,
  eventId: string,
  occurredAt: string
): Promise<EmergencyEventView> {
  return transactState(dependencies.store, (state) => {
    const event = state.events[eventId];
    if (!event) throw notFound("Event does not exist");
    if (!dependencies.isPatientDevice(state, event, device.deviceInstanceId)) {
      throw forbidden("Only the associated patient can confirm a false alarm");
    }
    dependencies.markDeviceSeen(state, device.deviceInstanceId, occurredAt);
    if (event.state !== "ACTIVE") throw conflict("Event is already terminal");
    const devices = dependencies.coordinationAudienceDeviceIds(state, event);
    const expiredOffers = transitionEventToTerminal(state, event, {
      reason: "FALSE_ALARM",
      occurredAt,
      affectedDeviceIds: dependencies.affectedDeviceIds(state, event),
      audit: {
        kind: "FALSE_ALARM_CONFIRMED",
        message: "Patient explicitly confirmed a false alarm; volunteer coordination was cancelled only."
      }
    });
    const view = dependencies.eventProjection(
      state,
      event,
      device,
      dependencies.coordinationSummary(state, event, dependencies.now()),
      false,
      dependencies.now()
    );
    if (!view) throw forbidden("Patient event projection is unavailable");
    const update = dependencies.recruitmentUpdate(state, event, []);
    update.audience = devices;
    update.expiredOffers = expiredOffers;
    dependencies.enqueueTerminalNotifications(state, event, `false-alarm:${eventId}`, devices, update);
    return view;
  });
}
