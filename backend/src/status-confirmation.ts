import { transactState, stateRows } from "./incremental-state.js";
import { appendTimeline } from "./event-audit.js";
import { fingerprint } from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";
import { transitionEventToTerminal } from "./event-lifecycle.js";
import { randomUUID } from "node:crypto";
import type { DevicePrincipal } from "./identity-access.js";
import type { StatusConfirmationResponse } from "./contracts.js";
import type {
  CoordinationSummary,
  EventRecord,
  PersistentState,
  ResponseRequestPayload,
  EventStatusConfirmationRecord
} from "./models.js";
import type { StateStore } from "./store.js";

export const STATUS_CONFIRMATION_INTERVAL_SECONDS = 30 * 60;
export const STATUS_CONFIRMATION_RESPONSE_WINDOW_SECONDS = 5 * 60;

export interface StatusConfirmationResult {
  confirmationId: string;
  response: "CONTINUE";
  respondedAt: string;
  nextCheckAt: string;
  idempotent: boolean;
}

export interface StatusConfirmationResponseDependencies {
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
  isPatientDevice: (
    state: Readonly<PersistentState>,
    event: EventRecord,
    deviceInstanceId: string
  ) => boolean;
}

export interface StatusConfirmationEmission {
  eventId: string;
  deviceInstanceIds: string[];
  kind: "REQUESTED";
  confirmationId: string;
  sentAt?: string;
  responseDeadlineAt?: string;
  occurredAt: string;
  coordinationRevision?: number;
}

export interface StatusConfirmationRecruitmentUpdate {
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

export interface StatusConfirmationTickDependencies {
  coordinationAudienceDeviceIds: (
    state: Readonly<PersistentState>,
    event: EventRecord
  ) => string[];
  affectedDeviceIds: (
    state: Readonly<PersistentState>,
    event: EventRecord
  ) => string[];
  patientViewerDeviceIds: (
    state: Readonly<PersistentState>,
    event: EventRecord
  ) => string[];
  recruitmentUpdate: (
    state: PersistentState,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience?: readonly string[],
    expiredOffers?: StatusConfirmationRecruitmentUpdate["expiredOffers"]
  ) => StatusConfirmationRecruitmentUpdate;
  enqueueTerminalNotifications: (
    state: PersistentState,
    event: EventRecord,
    messageId: string,
    devices: readonly string[],
    update: StatusConfirmationRecruitmentUpdate
  ) => void;
  enqueueRequestedNotification: (
    state: PersistentState,
    event: EventRecord,
    confirmation: EventStatusConfirmationRecord,
    occurredAt: string
  ) => void;
}

/**
 * Scheduler-owned status confirmation transition. It is called inside the
 * caller's existing StateStore transaction and never publishes transport
 * messages itself.
 */
export function advanceStatusConfirmation(
  dependencies: StatusConfirmationTickDependencies,
  state: PersistentState,
  event: EventRecord,
  now: Date
): { emission?: StatusConfirmationEmission; update?: StatusConfirmationRecruitmentUpdate } {
  if (event.state !== "ACTIVE") return {};
  const nowMilliseconds = now.getTime();
  const nowIso = now.toISOString();
  const history = event.statusConfirmationHistory ??= [];
  const pending = event.statusConfirmation
    ?? history.find((confirmation) => confirmation.state === "PENDING");
  if (pending) {
    event.statusConfirmation = pending;
    const deadlineMilliseconds = Date.parse(pending.responseDeadlineAt);
    if (!Number.isFinite(deadlineMilliseconds) || nowMilliseconds < deadlineMilliseconds) {
      return {};
    }
    pending.state = "CLOSED_UNCONFIRMED_NO_RESPONSE";
    pending.closedAt = nowIso;
    delete event.statusConfirmation;
    const devices = dependencies.coordinationAudienceDeviceIds(state, event);
    const expiredOffers = transitionEventToTerminal(state, event, {
      reason: "CLOSED_UNCONFIRMED_NO_RESPONSE",
      occurredAt: nowIso,
      affectedDeviceIds: dependencies.affectedDeviceIds(state, event),
      audit: {
        kind: "STATUS_CONFIRMATION_TIMED_OUT",
        message: "The status confirmation window elapsed without a response; the event was closed as unconfirmed."
      }
    });
    const update = dependencies.recruitmentUpdate(state, event, [], devices, expiredOffers);
    dependencies.enqueueTerminalNotifications(
      state,
      event,
      `event-closed-unconfirmed:${pending.confirmationId}`,
      devices,
      update
    );
    return { update };
  }

  const cycleStartedAt = Date.parse(
    event.statusConfirmationCycleStartedAt ?? event.createdAt
  );
  if (!Number.isFinite(cycleStartedAt)) return {};
  const scheduledSentAt = cycleStartedAt + STATUS_CONFIRMATION_INTERVAL_SECONDS * 1_000;
  if (nowMilliseconds < scheduledSentAt) return {};
  const responseDeadlineAt = scheduledSentAt
    + STATUS_CONFIRMATION_RESPONSE_WINDOW_SECONDS * 1_000;
  const confirmation: EventStatusConfirmationRecord = {
    confirmationId: randomUUID(),
    cycleStartedAt: new Date(cycleStartedAt).toISOString(),
    sentAt: new Date(Math.min(nowMilliseconds, responseDeadlineAt)).toISOString(),
    responseDeadlineAt: new Date(responseDeadlineAt).toISOString(),
    state: "PENDING"
  };
  history.push(confirmation);
  if (nowMilliseconds >= responseDeadlineAt) {
    confirmation.sentAt = new Date(scheduledSentAt).toISOString();
    confirmation.state = "CLOSED_UNCONFIRMED_NO_RESPONSE";
    confirmation.closedAt = nowIso;
    const devices = dependencies.coordinationAudienceDeviceIds(state, event);
    const expiredOffers = transitionEventToTerminal(state, event, {
      reason: "CLOSED_UNCONFIRMED_NO_RESPONSE",
      occurredAt: nowIso,
      affectedDeviceIds: dependencies.affectedDeviceIds(state, event),
      audit: {
        kind: "STATUS_CONFIRMATION_TIMED_OUT",
        message: "The status confirmation window elapsed before the service could observe a response; the event was closed as unconfirmed."
      }
    });
    const update = dependencies.recruitmentUpdate(state, event, [], devices, expiredOffers);
    dependencies.enqueueTerminalNotifications(
      state,
      event,
      `event-closed-unconfirmed:${confirmation.confirmationId}`,
      devices,
      update
    );
    return { update };
  }

  event.statusConfirmation = confirmation;
  appendTimeline(
    state,
    event.id,
    nowIso,
    "STATUS_CONFIRMATION_REQUESTED",
    "The service requested confirmation that the rescue is still in progress."
  );
  dependencies.enqueueRequestedNotification(state, event, confirmation, nowIso);
  return {
    emission: {
      eventId: event.id,
      deviceInstanceIds: dependencies.patientViewerDeviceIds(state, event),
      kind: "REQUESTED",
      confirmationId: confirmation.confirmationId,
      sentAt: confirmation.sentAt,
      responseDeadlineAt: confirmation.responseDeadlineAt,
      occurredAt: nowIso
    }
  };
}

/**
 * Canonical status-confirmation response use case. Authentication and the
 * overdue scheduler remain service adapters, while this function owns the
 * single transaction that applies idempotency, deadline and audit rules.
 */
export async function runStatusConfirmationResponse(
  dependencies: StatusConfirmationResponseDependencies,
  device: DevicePrincipal,
  eventId: string,
  request: StatusConfirmationResponse
): Promise<StatusConfirmationResult> {
  const serverReceivedAt = dependencies.now();
  const claimedRespondedAt = dependencies.validateActionTime(
    request.respondedAt,
    "respondedAt",
    serverReceivedAt
  );
  const responseFingerprint = fingerprint({
    confirmationId: request.confirmationId,
    response: request.response,
    respondedAt: claimedRespondedAt
  });
  return transactState(dependencies.store, (state) => {
    const event = state.events[eventId];
    const deviceRecord = state.devices[device.deviceInstanceId];
    if (!event || !deviceRecord) throw notFound("Event does not exist");
    if (!dependencies.isPatientDevice(state, event, device.deviceInstanceId)) {
      throw forbidden("Only the associated patient can answer a status confirmation");
    }
    const history = event.statusConfirmationHistory ??= [];
    const prior = history.find((confirmation) =>
      confirmation.confirmationId === request.confirmationId
    );
    if (prior && prior.state === "CONTINUED") {
      if (prior.responseFingerprint !== undefined
        ? prior.responseFingerprint !== responseFingerprint
        : prior.respondedAt !== claimedRespondedAt) {
        throw conflict("confirmationId was already answered with different content");
      }
      return {
        confirmationId: prior.confirmationId,
        response: "CONTINUE" as const,
        respondedAt: prior.respondedAt!,
        nextCheckAt: new Date(
          Date.parse(event.statusConfirmationCycleStartedAt ?? event.createdAt)
            + STATUS_CONFIRMATION_INTERVAL_SECONDS * 1_000
        ).toISOString(),
        idempotent: true
      };
    }
    if (event.state !== "ACTIVE") throw conflict("Event is already terminal");
    const confirmation: EventStatusConfirmationRecord | undefined = event.statusConfirmation;
    if (!confirmation
      || confirmation.confirmationId !== request.confirmationId
      || confirmation.state !== "PENDING") {
      throw conflict("Status confirmation is no longer pending");
    }
    const respondedAt = dependencies.effectiveActionTime(
      claimedRespondedAt,
      "respondedAt",
      confirmation.sentAt,
      "status confirmation sentAt",
      serverReceivedAt
    );
    const sentMilliseconds = Date.parse(confirmation.sentAt);
    const deadlineMilliseconds = Date.parse(confirmation.responseDeadlineAt);
    const responseMilliseconds = Date.parse(respondedAt);
    if (!Number.isFinite(sentMilliseconds)
      || !Number.isFinite(deadlineMilliseconds)
      || !Number.isFinite(responseMilliseconds)
      || responseMilliseconds < sentMilliseconds
      || responseMilliseconds > deadlineMilliseconds
      || serverReceivedAt.getTime() > deadlineMilliseconds) {
      throw conflict("Status confirmation response window has closed");
    }
    confirmation.state = "CONTINUED";
    confirmation.respondedAt = respondedAt;
    confirmation.responseFingerprint = responseFingerprint;
    delete event.statusConfirmation;
    const cycleStartedAt = serverReceivedAt.toISOString();
    event.statusConfirmationCycleStartedAt = cycleStartedAt;
    appendTimeline(
      state,
      event.id,
      respondedAt,
      "STATUS_CONFIRMATION_CONTINUED",
      "The patient confirmed that the rescue is still in progress; the 30-minute status cycle restarted."
    );
    return {
      confirmationId: confirmation.confirmationId,
      response: "CONTINUE" as const,
      respondedAt,
      nextCheckAt: new Date(
        Date.parse(cycleStartedAt) + STATUS_CONFIRMATION_INTERVAL_SECONDS * 1_000
      ).toISOString(),
      idempotent: false
    };
  });
}
