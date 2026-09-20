import { readState, transactState, stateRows } from "./incremental-state.js";
import { appendTimeline } from "./event-audit.js";
import { fingerprint } from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";
import type { DevicePrincipal } from "./identity-access.js";
import type { ResponderDecision } from "./contracts.js";
import type {
  AssignmentRecord,
  AssignmentView,
  CoordinationSummary,
  DeliveryRecord,
  DeviceRecord,
  EventRecord,
  PersistentState,
  ResponseRequestPayload
} from "./models.js";
import type { StateStore } from "./store.js";

const pendingDeliveryStatuses: DeliveryRecord["status"][] = ["SENT", "DELIVERED", "VIEWED"];

export interface AssignmentEmission {
  deviceInstanceId: string;
  name: "assignment:created" | "assignment:updated";
  assignment: AssignmentView;
  occurredAt: string;
}

export interface RecruitmentUpdate {
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
  /**
   * The event as it stands after the refresh.
   *
   * The refresh writes the stage and the revision, and a transaction-backed
   * implementation hands back its own current-view object, so everything done after
   * this call must use this rather than the object passed in.  Ids are immutable and
   * therefore identical; the mutable fields are what differ.
   */
  event: EventRecord;
}

export interface ResponseDecisionUseCaseDependencies {
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
  ensureParticipantInterval: (
    state: PersistentState,
    eventId: string,
    userId: string,
    deviceInstanceId: string,
    acceptedAt: string
  ) => void;
  isEligibleNearbyResponder: (
    state: Readonly<PersistentState>,
    event: EventRecord,
    device: DeviceRecord,
    now: Date
  ) => boolean;
  participantDeviceIds: (state: Readonly<PersistentState>, event: EventRecord) => string[];
  replanAssignments: (
    state: PersistentState,
    event: EventRecord,
    at: Date
  ) => AssignmentEmission[];
  refreshRecruitmentForEvent: (
    state: PersistentState,
    event: EventRecord,
    now: Date
  ) => RecruitmentRefresh;
  recruitmentUpdate: (
    state: PersistentState,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience?: readonly string[],
    expiredOffers?: RecruitmentUpdate["expiredOffers"]
  ) => RecruitmentUpdate;
  /** Persists the response decision notification inside the same transaction. */
  enqueueDecisionNotification: (
    state: PersistentState,
    event: EventRecord,
    deliveryId: string,
    decision: ResponderDecision["decision"],
    occurredAt: string,
    audience: readonly string[],
    coordination: CoordinationSummary
  ) => void;
  /** Persists assignment fan-out produced by this response transaction. */
  enqueueAssignmentEmissions: (
    state: PersistentState,
    event: EventRecord,
    emissions: readonly AssignmentEmission[]
  ) => void;
}

export interface ResponseDecisionResult {
  decision: ResponderDecision["decision"];
  assignment: AssignmentView | null;
  emissions: AssignmentEmission[];
  update: RecruitmentUpdate | undefined;
  decidedAt: string;
  decisionAudience: string[];
  rejectedReason: string | undefined;
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

function currentAssignmentForDevice(
  state: Readonly<PersistentState>,
  eventId: string,
  deviceInstanceId: string
): AssignmentRecord | undefined {
  return stateRows(state, "assignments", "eventId", eventId)
    .filter((assignment) => assignment.eventId === eventId
      && assignment.deviceInstanceId === deviceInstanceId)
    .sort((left, right) => right.revision - left.revision
      || right.updatedAt.localeCompare(left.updatedAt))[0];
}

function deliveryIsLive(delivery: DeliveryRecord, now: Date): boolean {
  if (!pendingDeliveryStatuses.includes(delivery.status)) return false;
  const expiresAt = Date.parse(delivery.request.expiresAt);
  return Number.isFinite(expiresAt) && now.getTime() <= expiresAt;
}

/**
 * Canonical response decision use case. It owns the idempotency fingerprint
 * and the transaction that changes delivery, participation, assignment and
 * recruitment state together. Transport publication remains outside the
 * transaction and is driven by the returned committed outcome.
 */
export async function runResponseDecision(
  dependencies: ResponseDecisionUseCaseDependencies,
  device: DevicePrincipal,
  eventId: string,
  deliveryId: string,
  decision: ResponderDecision
): Promise<ResponseDecisionResult> {
  const serverReceivedAt = dependencies.now();
  const claimedDecision: ResponderDecision = {
    ...decision,
    decidedAt: dependencies.validateActionTime(
      decision.decidedAt,
      "decidedAt",
      serverReceivedAt
    )
  };
  const decisionFingerprint = fingerprint(claimedDecision);
  const result = await transactState(dependencies.store, (state) => {
    const event = state.events[eventId];
    if (!event) throw notFound("Event does not exist");
    if (device.userId && event.exitedResponderUserIds?.includes(device.userId)) {
      throw forbidden("An exited responder has no event communication permission");
    }
    if (event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") {
      throw conflict("Event is no longer recruiting");
    }
    /**
     * `currentEvent` is the event as it stands now, which is not the object this
     * transaction opened with: every caller reaches `finalize` after
     * `refreshRecruitmentForEvent`, which writes the stage and the revision and, under
     * a transaction adapter, returns its own view object.  Passing the original would
     * hand both notification sinks a stale event.
     */
    const finalize = (
      candidate: Omit<ResponseDecisionResult, "decision">,
      currentEvent: EventRecord
    ): Omit<ResponseDecisionResult, "decision"> => {
      if (candidate.update) {
        dependencies.enqueueDecisionNotification(
          state,
          currentEvent,
          deliveryId,
          claimedDecision.decision,
          candidate.decidedAt,
          candidate.decisionAudience,
          candidate.update.coordination
        );
      }
      if (candidate.emissions.length > 0) {
        dependencies.enqueueAssignmentEmissions(state, currentEvent, candidate.emissions);
      }
      return candidate;
    };
    const delivery = state.deliveries[deliveryId];
    if (!delivery || delivery.eventId !== eventId
      || delivery.deviceInstanceId !== device.deviceInstanceId) {
      throw notFound("Response-request delivery is not visible to this device");
    }
    dependencies.markDeviceSeen(state, device.deviceInstanceId, serverReceivedAt.toISOString());
    const now = serverReceivedAt;
    if (pendingDeliveryStatuses.includes(delivery.status) && !deliveryIsLive(delivery, now)) {
      delivery.status = "EXPIRED";
      delivery.statusOccurredAt = now.toISOString();
      event.coordinationRevision += 1;
      appendTimeline(
        state,
        eventId,
        now.toISOString(),
        "PASSIVE_OBSERVATION",
        `Response delivery ${delivery.id} expired after its 30-second offer window.`
      );
      const refreshed = dependencies.refreshRecruitmentForEvent(state, event, now);
      return finalize({
        assignment: null,
        emissions: [] as AssignmentEmission[],
        update: dependencies.recruitmentUpdate(
          state,
          refreshed.event,
          refreshed.requests,
          refreshed.previousAudience,
          refreshed.expiredOffers
        ),
        decidedAt: now.toISOString(),
        decisionAudience: [] as string[],
        rejectedReason: "Response offer has expired"
      }, refreshed.event);
    }
    if (delivery.status === "EXPIRED") {
      throw conflict("Expired response-request delivery cannot be revived");
    }
    if (delivery.decisionFingerprint) {
      if (delivery.decisionFingerprint !== decisionFingerprint) {
        throw conflict("A different decision was already persisted for this delivery");
      }
      const assignment = currentAssignmentForDevice(state, eventId, device.deviceInstanceId);
      return {
        assignment: assignment ? assignmentView(assignment) : null,
        emissions: [] as AssignmentEmission[],
        update: undefined as RecruitmentUpdate | undefined,
        decidedAt: delivery.decidedAt ?? delivery.statusOccurredAt,
        decisionAudience: [] as string[],
        rejectedReason: undefined as string | undefined
      };
    }

    const responder = state.devices[device.deviceInstanceId];
    if (!responder) throw forbidden("Device session is no longer registered");
    const decisionCausalLowerBoundAt = Date.parse(delivery.statusOccurredAt)
      > Date.parse(delivery.request.occurredAt)
      ? delivery.statusOccurredAt
      : delivery.request.occurredAt;
    const decidedAt = dependencies.effectiveActionTime(
      claimedDecision.decidedAt,
      "decidedAt",
      decisionCausalLowerBoundAt,
      "response request/current delivery time",
      serverReceivedAt
    );
    if (claimedDecision.decision === "ACCEPT"
      && !dependencies.isEligibleNearbyResponder(state, event, responder, serverReceivedAt)) {
      delivery.status = "EXPIRED";
      delivery.statusOccurredAt = decidedAt;
      event.coordinationRevision += 1;
      appendTimeline(
        state,
        eventId,
        decidedAt,
        "PASSIVE_OBSERVATION",
        `Response delivery ${deliveryId} expired because server-side eligibility changed.`
      );
      const refreshed = dependencies.refreshRecruitmentForEvent(state, event, now);
      return finalize({
        assignment: null,
        emissions: [] as AssignmentEmission[],
        update: dependencies.recruitmentUpdate(
          state,
          refreshed.event,
          refreshed.requests,
          refreshed.previousAudience,
          refreshed.expiredOffers
        ),
        decidedAt,
        decisionAudience: [] as string[],
        rejectedReason: "Response offer is no longer eligible at acceptance time"
      }, refreshed.event);
    }

    delivery.decision = claimedDecision.decision;
    delivery.decisionFingerprint = decisionFingerprint;
    delivery.decidedAt = decidedAt;
    delivery.status = claimedDecision.decision === "ACCEPT" ? "ACCEPTED" : "REFUSED";
    delivery.statusOccurredAt = decidedAt;
    if (claimedDecision.decision === "ACCEPT") {
      const userId = responder.userId ?? device.userId;
      if (!userId) throw forbidden("An authenticated user identity is required to accept");
      dependencies.ensureParticipantInterval(
        state,
        eventId,
        userId,
        responder.deviceInstanceId,
        decidedAt
      );
    }
    appendTimeline(
      state,
      eventId,
      decidedAt,
      claimedDecision.decision === "ACCEPT" ? "RESPONSE_ACCEPTED" : "RESPONSE_REFUSED",
      `Response delivery ${deliveryId} was ${claimedDecision.decision}.`
    );

    const emissions = claimedDecision.decision === "ACCEPT"
      ? dependencies.replanAssignments(state, event, now)
      : [];
    event.coordinationRevision += 1;
    const refreshed = dependencies.refreshRecruitmentForEvent(state, event, now);
    const assignment = currentAssignmentForDevice(state, eventId, device.deviceInstanceId);
    return finalize({
      assignment: assignment ? assignmentView(assignment) : null,
      emissions,
      update: dependencies.recruitmentUpdate(
        state,
        refreshed.event,
        refreshed.requests,
        refreshed.previousAudience,
        refreshed.expiredOffers
      ),
      decidedAt,
      // Post-refresh: the audience is derived from the refreshed view, not from the
      // object this function received.
      decisionAudience: dependencies.participantDeviceIds(state, refreshed.event),
      rejectedReason: undefined as string | undefined
    }, refreshed.event);
  });

  return {
    decision: claimedDecision.decision,
    assignment: result.assignment,
    emissions: result.emissions,
    update: result.update,
    decidedAt: result.decidedAt,
    decisionAudience: result.decisionAudience,
    rejectedReason: result.rejectedReason
  };
}
