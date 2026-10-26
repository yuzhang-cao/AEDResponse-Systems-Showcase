/**
 * FROZEN PRE-REFACTOR BASELINE — do not edit.
 *
 * Provenance: every block below was copied byte-for-byte from
 * `git show 64c4759:backend/src/service.ts` (the commit preceding the recruitment
 * context refactor), by a brace-matching extractor that located each symbol by name
 * and copied its exact source lines.  Nothing here was retyped, so the text cannot
 * have drifted from the original through transcription.
 *
 * Extracted source lines: {"RESPONSE_OFFER_TTL_SECONDS": 270, "RECRUITMENT_TARGET_ACCEPTED": 271, "RECRUITMENT_STAGE_TIMEOUT_SECONDS": 272, "RECRUITMENT_RADIUS_STAGES_METERS": 274, "REQUIRED_BOOTSTRAP_AGREEMENTS": 556, "pendingDeliveryStatuses": 499, "hasAllBootstrapAgreements": 563, "currentAssignmentForDevice": 370, "deliveryForDevice": 382, "deliveryForUser": 391, "deviceIdentityKey": 302, "assignmentExitsParticipation": 402, "currentPatientPositionSample": 511, "currentPatientPosition": 519, "currentResponderPosition": 523, "deliveryIsLive": 528, "patientViewerDeviceIds": 462, "coordinationAudienceDeviceIds": 501, "acceptedDeviceIds": 406, "distanceRange": 284, "etaRange": 292, "offerMetadata": 534, "patientPositionSampleIsFresh": 4411, "responderPositionSampleIsFresh": 4424, "refreshRecruitmentForEvent": 4598, "advanceRecruitmentStage": 4696, "eligibleResponderDevices": 4754, "recruitmentPotentialDevices": 4771, "createDeliveryIfEligible": 4940, "isEligibleResponderDeviceBase": 5000, "isEligibleNearbyResponder": 5087, "deviceIsActivePatient": 5126, "envelope": 5436, "RecruitmentUpdate": 230}
 *
 * Why a frozen copy rather than the live implementation: a differential test is only
 * meaningful if the two sides are independent.  Comparing the refactored function
 * against itself would prove nothing, and comparing it against a hand-written
 * "expected" would just encode the same misunderstanding twice.
 *
 * Scope: only the recruitment chain and its helpers.  The baseline is instantiated
 * directly with a config; it performs no I/O and has no store.
 */
import { randomUUID } from "node:crypto";
import type {
  AssignmentRecord,
  CoordinationSummary,
  CurrentPatientPosition,
  DeliveryRecord,
  DeviceRecord,
  DistanceRange,
  EtaRange,
  EventRecord,
  PersistentState,
  ResponseRequestPayload
} from "../../src/models.js";
import type {
  AssignmentStatus,
  DeliveryStatus,
  PatientPosition,
  ResponderPosition
} from "../../src/contracts.js";
import { enqueueNotification } from "../../src/notification-outbox.js";
import { appendTimeline } from "../../src/event-audit.js";
import { permitsSimulationDevice, simulationMarker } from "../../src/simulation.js";
import { distanceMeters } from "../../src/domain.js";

export const BASELINE_PROVENANCE = {
  commit: "64c4759",
  path: "backend/src/service.ts",
  extractedLines: {"RESPONSE_OFFER_TTL_SECONDS": 270, "RECRUITMENT_TARGET_ACCEPTED": 271, "RECRUITMENT_STAGE_TIMEOUT_SECONDS": 272, "RECRUITMENT_RADIUS_STAGES_METERS": 274, "REQUIRED_BOOTSTRAP_AGREEMENTS": 556, "pendingDeliveryStatuses": 499, "hasAllBootstrapAgreements": 563, "currentAssignmentForDevice": 370, "deliveryForDevice": 382, "deliveryForUser": 391, "deviceIdentityKey": 302, "assignmentExitsParticipation": 402, "currentPatientPositionSample": 511, "currentPatientPosition": 519, "currentResponderPosition": 523, "deliveryIsLive": 528, "patientViewerDeviceIds": 462, "coordinationAudienceDeviceIds": 501, "acceptedDeviceIds": 406, "distanceRange": 284, "etaRange": 292, "offerMetadata": 534, "patientPositionSampleIsFresh": 4411, "responderPositionSampleIsFresh": 4424, "refreshRecruitmentForEvent": 4598, "advanceRecruitmentStage": 4696, "eligibleResponderDevices": 4754, "recruitmentPotentialDevices": 4771, "createDeliveryIfEligible": 4940, "isEligibleResponderDeviceBase": 5000, "isEligibleNearbyResponder": 5087, "deviceIsActivePatient": 5126, "envelope": 5436, "RecruitmentUpdate": 230}
};

export interface BaselineConfig {
  positionMaxAgeSeconds: number;
  maxClientClockSkewSeconds: number;
  maxPositionAccuracyMeters: number;
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

const RESPONSE_OFFER_TTL_SECONDS = 30;

const RECRUITMENT_TARGET_ACCEPTED = 3;

const RECRUITMENT_STAGE_TIMEOUT_SECONDS = 30;

export const RECRUITMENT_RADIUS_STAGES_METERS = [1_000, 1_500, 2_000] as const;

const REQUIRED_BOOTSTRAP_AGREEMENTS = [
  "PATIENT",
  "VOLUNTEER_RESPONDER",
  "PRIVACY_POLICY",
  "SENSITIVE_PERSONAL_INFORMATION"
] as const;

const pendingDeliveryStatuses: DeliveryStatus[] = ["SENT", "DELIVERED", "VIEWED"];

function hasAllBootstrapAgreements(device: DeviceRecord): boolean {
  return REQUIRED_BOOTSTRAP_AGREEMENTS.every((kind) => {
    const agreement = device.agreements[kind];
    return agreement?.version === "2.0"
      && typeof agreement.acceptedAt === "string"
      && Number.isFinite(Date.parse(agreement.acceptedAt));
  });
}

function currentAssignmentForDevice(
  state: Readonly<PersistentState>,
  eventId: string,
  deviceInstanceId: string
): AssignmentRecord | undefined {
  return Object.values(state.assignments)
    .filter((assignment) => assignment.eventId === eventId
      && assignment.deviceInstanceId === deviceInstanceId)
    .sort((left, right) => right.revision - left.revision
      || right.updatedAt.localeCompare(left.updatedAt))[0];
}

function deliveryForDevice(
  state: Readonly<PersistentState>,
  eventId: string,
  deviceInstanceId: string
): DeliveryRecord | undefined {
  return Object.values(state.deliveries).find((delivery) => delivery.eventId === eventId
    && delivery.deviceInstanceId === deviceInstanceId);
}

function deliveryForUser(
  state: Readonly<PersistentState>,
  eventId: string,
  userId: string
): DeliveryRecord | undefined {
  return Object.values(state.deliveries).find((delivery) => {
    if (delivery.eventId !== eventId) return false;
    return state.devices[delivery.deviceInstanceId]?.userId === userId;
  });
}

function deviceIdentityKey(device: Pick<DeviceRecord, "deviceInstanceId" | "userId">): string {
  return device.userId ? `user:${device.userId}` : `device:${device.deviceInstanceId}`;
}

function assignmentExitsParticipation(status: AssignmentStatus): boolean {
  return status === "TIMED_OUT" || status === "CANCELLED";
}

function currentPatientPositionSample(event: EventRecord): CurrentPatientPosition | undefined {
  const sample = event.patientPosition;
  if (sample?.source === "WATCH_TRIGGER_SNAPSHOT"
    && (event.observation.observationKind !== "FALL_CONTEXT"
      || event.observation.patientPositionObservedAt === undefined)) return undefined;
  return sample;
}

function currentPatientPosition(event: EventRecord): PatientPosition | undefined {
  return currentPatientPositionSample(event)?.position;
}

function currentResponderPosition(device: DeviceRecord | undefined): ResponderPosition | undefined {
  const position = device?.latestPosition?.position;
  return position?.kind === "R" ? position : undefined;
}

function deliveryIsLive(delivery: DeliveryRecord, now: Date): boolean {
  if (!pendingDeliveryStatuses.includes(delivery.status)) return false;
  const expiresAt = Date.parse(delivery.request.expiresAt);
  return Number.isFinite(expiresAt) && now.getTime() <= expiresAt;
}

function patientViewerDeviceIds(
  state: Readonly<PersistentState>,
  event: EventRecord
): string[] {
  return Object.values(state.devices)
    .filter((device) => device.deviceKind === "IPHONE"
      && permitsSimulationDevice(event.observation, device.deviceInstanceId, device.userId)
      && (event.patientDeviceIds.includes(device.deviceInstanceId)
        || device.userId === event.patientUserId))
    .map((device) => device.deviceInstanceId);
}

function coordinationAudienceDeviceIds(
  state: Readonly<PersistentState>,
  event: EventRecord
): string[] {
  return [
    ...patientViewerDeviceIds(state, event),
    ...acceptedDeviceIds(state, event.id)
  ].filter((deviceId, index, values) => values.indexOf(deviceId) === index);
}

function acceptedDeviceIds(state: Readonly<PersistentState>, eventId: string): string[] {
  const event = state.events[eventId];
  const accepted = Object.values(state.deliveries)
    .filter((delivery) => delivery.eventId === eventId
      && delivery.decision === "ACCEPT"
      && delivery.status === "ACCEPTED")
    .map((delivery) => delivery.deviceInstanceId)
    .filter((deviceId) => {
      const device = state.devices[deviceId];
      if (device?.userId && event?.exitedResponderUserIds?.includes(device.userId)) {
        return false;
      }
      const assignment = currentAssignmentForDevice(state, eventId, deviceId);
      return !assignment || !assignmentExitsParticipation(assignment.status);
    })
    .sort((left, right) => left.localeCompare(right));
  const identities = new Set<string>();
  return accepted.filter((deviceId) => {
    const device = state.devices[deviceId];
    const identity = device ? deviceIdentityKey(device) : `device:${deviceId}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function distanceRange(distance: number): DistanceRange {
  if (distance < 500) return "DISTANCE_0_500M";
  if (distance < 1_000) return "DISTANCE_500_1000M";
  if (distance < 1_500) return "DISTANCE_1000_1500M";
  if (distance <= 2_000) return "DISTANCE_1500_2000M";
  return "DISTANCE_OVER_2000M";
}

function etaRange(distance: number): EtaRange {
  // A coarse walking estimate is intentionally bucketed before it crosses the
  // response boundary; exact responder/patient geometry never leaves the server.
  const etaMinutes = (1.25 * distance / 1.3) / 60;
  if (etaMinutes < 5) return "ETA_0_5_MIN";
  if (etaMinutes < 10) return "ETA_5_10_MIN";
  if (etaMinutes < 15) return "ETA_10_15_MIN";
  return "ETA_OVER_15_MIN";
}

function offerMetadata(
  responder: ResponderPosition,
  patient: PatientPosition,
  radiusMeters: number,
  expiresAt: string
): Pick<
  ResponseRequestPayload,
  "eventType" | "positioningTier" | "distanceRange" | "etaRange"
  | "currentRecruitmentRadiusMeters" | "expiresAt"
> {
  const distance = distanceMeters(responder, patient);
  return {
    eventType: "FALL_ASSISTANCE",
    positioningTier: "SEARCH_RING",
    distanceRange: distanceRange(distance),
    etaRange: etaRange(distance),
    currentRecruitmentRadiusMeters: radiusMeters,
    expiresAt
  };
}

/**
 * The pre-refactor recruitment chain, verbatim.
 *
 * `this.config` is the only dependency the extracted methods had beyond the state
 * object they were handed, so the class carries exactly that.
 */
export class BaselineRecruitment {
  constructor(private readonly config: BaselineConfig) {}

  private patientPositionSampleIsFresh(
    position: PatientPosition,
    observedAt: string,
    now: Date
  ): boolean {
    const observedMilliseconds = Date.parse(observedAt);
    if (!Number.isFinite(observedMilliseconds)
      || position.accuracyMeters > this.config.maxPositionAccuracyMeters) return false;
    const age = now.getTime() - observedMilliseconds;
    return age >= -this.config.maxClientClockSkewSeconds * 1_000
      && Math.max(0, age) <= this.config.positionMaxAgeSeconds * 1_000;
  }

  private responderPositionSampleIsFresh(
    position: ResponderPosition,
    observedAt: string,
    now: Date
  ): boolean {
    const observedMilliseconds = Date.parse(observedAt);
    if (!Number.isFinite(observedMilliseconds)
      || position.accuracyMeters > this.config.maxPositionAccuracyMeters) return false;
    const age = now.getTime() - observedMilliseconds;
    return age >= -this.config.maxClientClockSkewSeconds * 1_000
      && Math.max(0, age) <= this.config.positionMaxAgeSeconds * 1_000;
  }

  private refreshRecruitmentForEvent(
    state: PersistentState,
    event: EventRecord,
    now: Date,
    forceRevision = false
  ): {
    changed: boolean;
    requests: ResponseRequestPayload[];
    previousAudience: string[];
    expiredOffers: RecruitmentUpdate["expiredOffers"];
  } {
    const previousAudience = coordinationAudienceDeviceIds(state, event);
    if (event.state !== "ACTIVE") {
      return { changed: false, requests: [], previousAudience, expiredOffers: [] };
    }
    if (event.recruitmentState !== "RECRUITING") {
      if (forceRevision) event.coordinationRevision += 1;
      return { changed: forceRevision, requests: [], previousAudience, expiredOffers: [] };
    }
    let changed = false;
    const nowIso = now.toISOString();
    const expiredOffers: RecruitmentUpdate["expiredOffers"] = [];
    for (const delivery of Object.values(state.deliveries)) {
      if (delivery.eventId !== event.id || !pendingDeliveryStatuses.includes(delivery.status)) {
        continue;
      }
      if (!deliveryIsLive(delivery, now)) {
        delivery.status = "EXPIRED";
        delivery.statusOccurredAt = nowIso;
        changed = true;
        expiredOffers.push({
          deviceInstanceId: delivery.deviceInstanceId,
          deliveryId: delivery.id,
          expiresAt: delivery.request.expiresAt,
          reason: "OFFER_EXPIRED"
        });
        enqueueNotification(state, delivery.deviceInstanceId, "response:offer-expired", {
          ...this.envelope(`response-offer-expired:${delivery.id}`, event.id, nowIso),
          deliveryId: delivery.id,
          expiresAt: delivery.request.expiresAt,
          reason: "OFFER_EXPIRED"
        });
        appendTimeline(
          state,
          event.id,
          nowIso,
          "PASSIVE_OBSERVATION",
          `Response delivery ${delivery.id} expired after its 30-second offer window.`
        );
        continue;
      }
      const device = state.devices[delivery.deviceInstanceId];
      if (device && this.isEligibleNearbyResponder(state, event, device, now)) continue;
      delivery.status = "EXPIRED";
      delivery.statusOccurredAt = nowIso;
      changed = true;
      expiredOffers.push({
        deviceInstanceId: delivery.deviceInstanceId,
        deliveryId: delivery.id,
        expiresAt: delivery.request.expiresAt,
        reason: "OFFER_NO_LONGER_ELIGIBLE"
      });
      enqueueNotification(state, delivery.deviceInstanceId, "response:offer-expired", {
        ...this.envelope(`response-offer-expired:${delivery.id}`, event.id, nowIso),
        deliveryId: delivery.id,
        expiresAt: delivery.request.expiresAt,
        reason: "OFFER_NO_LONGER_ELIGIBLE"
      });
      appendTimeline(
        state,
        event.id,
        nowIso,
        "PASSIVE_OBSERVATION",
        `Response delivery ${delivery.id} expired after server-side eligibility changed.`
      );
    }

    if (this.advanceRecruitmentStage(state, event, now)) changed = true;

    const requests: ResponseRequestPayload[] = [];
    for (const device of Object.values(state.devices).sort((left, right) =>
      left.deviceInstanceId.localeCompare(right.deviceInstanceId))) {
      const request = this.createDeliveryIfEligible(state, event, device, now);
      if (request) {
        requests.push(request);
        changed = true;
      }
    }
    if (changed || forceRevision) event.coordinationRevision += 1;
    return { changed: changed || forceRevision, requests, previousAudience, expiredOffers };
  }

  private advanceRecruitmentStage(
    state: PersistentState,
    event: EventRecord,
    now: Date
  ): boolean {
    let changed = false;
    const patientPosition = currentPatientPosition(event);
    if (!patientPosition || !this.patientPositionSampleIsFresh(
      patientPosition,
      event.patientPosition?.observedAt ?? event.observation.fallDetectedAt ?? event.createdAt,
      now
    )) {
      // Recruitment has no geographic ring until a valid P exists. Keep the
      // event at its initial radius and start the stage clock on first valid P.
      return false;
    }
    if (event.recruitmentStageStartedAt === null) {
      event.recruitmentStageStartedAt = now.toISOString();
      changed = true;
    }
    for (let attempt = 0; attempt < RECRUITMENT_RADIUS_STAGES_METERS.length; attempt += 1) {
      let stageIndex = RECRUITMENT_RADIUS_STAGES_METERS.indexOf(
        event.currentRecruitmentRadiusMeters as typeof RECRUITMENT_RADIUS_STAGES_METERS[number]
      );
      if (stageIndex < 0) {
        stageIndex = 0;
        event.currentRecruitmentRadiusMeters = RECRUITMENT_RADIUS_STAGES_METERS[0];
        event.recruitmentStageStartedAt = now.toISOString();
        changed = true;
      }
      const nextRadius = RECRUITMENT_RADIUS_STAGES_METERS[stageIndex + 1];
      if (nextRadius === undefined) break;

      const candidateCount = this.recruitmentPotentialDevices(state, event, now).length;
      const acceptedCount = acceptedDeviceIds(state, event.id).length;
      const potentialCount = acceptedCount + candidateCount;
      const stageStartedAt = Date.parse(event.recruitmentStageStartedAt);
      const stageTimedOut = Number.isFinite(stageStartedAt)
        && now.getTime() - stageStartedAt > RECRUITMENT_STAGE_TIMEOUT_SECONDS * 1_000;
      const shouldExpand = acceptedCount < RECRUITMENT_TARGET_ACCEPTED
        && (potentialCount < RECRUITMENT_TARGET_ACCEPTED
          || (potentialCount >= RECRUITMENT_TARGET_ACCEPTED && stageTimedOut));
      if (!shouldExpand) break;

      event.currentRecruitmentRadiusMeters = nextRadius;
      event.recruitmentStageStartedAt = now.toISOString();
      changed = true;
      appendTimeline(
        state,
        event.id,
        now.toISOString(),
        "PASSIVE_OBSERVATION",
        `Recruitment radius expanded to ${nextRadius} meters.`
      );
    }
    return changed;
  }

  private eligibleResponderDevices(
    state: Readonly<PersistentState>,
    event: EventRecord,
    now: Date
  ): DeviceRecord[] {
    const identities = new Set<string>();
    return Object.values(state.devices)
      .filter((device) => this.isEligibleNearbyResponder(state, event, device, now))
      .sort((left, right) => left.deviceInstanceId.localeCompare(right.deviceInstanceId))
      .filter((device) => {
        const identity = deviceIdentityKey(device);
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
      });
  }

  private recruitmentPotentialDevices(
    state: Readonly<PersistentState>,
    event: EventRecord,
    now: Date
  ): DeviceRecord[] {
    return this.eligibleResponderDevices(state, event, now).filter((device) => {
      const delivery = device.userId
        ? deliveryForUser(state, event.id, device.userId)
        : deliveryForDevice(state, event.id, device.deviceInstanceId);
      // A refused or expired offer is a terminal identity for this event and
      // must not keep a narrow ring open when it cannot receive a new offer.
      return delivery === undefined || deliveryIsLive(delivery, now);
    });
  }

  private createDeliveryIfEligible(
    state: PersistentState,
    event: EventRecord,
    device: DeviceRecord,
    now: Date
  ): ResponseRequestPayload | undefined {
    if (!this.isEligibleNearbyResponder(state, event, device, now)) return undefined;
    if (deliveryForDevice(state, event.id, device.deviceInstanceId)) return undefined;
    if (device.userId && deliveryForUser(state, event.id, device.userId)) return undefined;
    const patientPosition = currentPatientPosition(event);
    const responderPosition = currentResponderPosition(device);
    if (!patientPosition || !responderPosition) return undefined;

    const deliveryId = randomUUID();
    const occurredAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + RESPONSE_OFFER_TTL_SECONDS * 1_000).toISOString();
    const request: ResponseRequestPayload = {
      ...simulationMarker(event.observation),
      schemaVersion: "2.0",
      messageId: `response-requested:${event.id}:${device.deviceInstanceId}`,
      eventId: event.id,
      deliveryId,
      deliveryStatus: "SENT",
      occurredAt,
      ...offerMetadata(
        responderPosition,
        patientPosition,
        event.currentRecruitmentRadiusMeters,
        expiresAt
      )
    };
    state.deliveries[deliveryId] = {
      id: deliveryId,
      eventId: event.id,
      deviceInstanceId: device.deviceInstanceId,
      request,
      status: "SENT",
      statusOccurredAt: occurredAt
    };
    appendTimeline(
      state,
      event.id,
      occurredAt,
      "RESPONSE_REQUESTED",
      `Targeted response delivery ${deliveryId} was created.`
    );
    enqueueNotification(
      state,
      device.deviceInstanceId,
      "response:requested",
      request as unknown as Record<string, unknown>
    );
    return request;
  }

  private isEligibleResponderDeviceBase(
    state: Readonly<PersistentState>,
    device: DeviceRecord,
    now: Date,
    requireStableUser = false,
    precomputedBusyIdentities?: ReadonlySet<string>
  ): boolean {
    if (device.deviceKind !== "IPHONE"
      || (requireStableUser && !device.userId)
      || !hasAllBootstrapAgreements(device)) return false;
    if (!device.availableForResponse
      || !device.capabilities.locationAuthorized
      || !device.capabilities.notificationAuthorized) return false;

    const identity = deviceIdentityKey(device);
    if (precomputedBusyIdentities?.has(identity)) return false;
    if (!precomputedBusyIdentities) {
      if (this.deviceIsActivePatient(state, device.deviceInstanceId)) return false;
      if (Object.values(state.assignments).some((assignment) => {
        if (state.events[assignment.eventId]?.state !== "ACTIVE"
          || assignmentExitsParticipation(assignment.status)) return false;
        const assignedDevice = state.devices[assignment.deviceInstanceId];
        return assignment.deviceInstanceId === device.deviceInstanceId
          || (assignedDevice !== undefined && deviceIdentityKey(assignedDevice) === identity);
      })) return false;
    }

    const responderPosition = currentResponderPosition(device);
    const latestPosition = device.latestPosition;
    if (responderPosition
      && (!Number.isFinite(responderPosition.accuracyMeters)
        || responderPosition.accuracyMeters <= 0
        || responderPosition.accuracyMeters > this.config.maxPositionAccuracyMeters)) {
      return false;
    }
    return responderPosition !== undefined
      && latestPosition !== undefined
      && this.responderPositionSampleIsFresh(
        responderPosition,
        latestPosition.observedAt,
        now
      );
  }

  private isEligibleNearbyResponder(
    state: Readonly<PersistentState>,
    event: EventRecord,
    device: DeviceRecord,
    now: Date,
    requireRecruiting = true
  ): boolean {
    if (event.state !== "ACTIVE" || (requireRecruiting && event.recruitmentState !== "RECRUITING")) return false;
    if (!permitsSimulationDevice(event.observation, device.deviceInstanceId, device.userId)) return false;
    if (!this.isEligibleResponderDeviceBase(state, device, now)) return false;
    if (event.patientDeviceIds.includes(device.deviceInstanceId)) return false;
    if (device.userId !== undefined && event.patientUserId === device.userId) return false;
    if (device.userId !== undefined && event.exitedResponderUserIds?.includes(device.userId)) {
      return false;
    }
    const identity = deviceIdentityKey(device);
    if (Object.values(state.deliveries).some((delivery) => {
      if (delivery.eventId !== event.id
        || delivery.decision !== "ACCEPT"
        || delivery.status !== "ACCEPTED") return false;
      const acceptedDevice = state.devices[delivery.deviceInstanceId];
      return acceptedDevice !== undefined && deviceIdentityKey(acceptedDevice) === identity;
    })) return false;
    const patientPosition = currentPatientPosition(event);
    const responderPosition = currentResponderPosition(device);
    if (!patientPosition || !responderPosition) return false;
    if (patientPosition.accuracyMeters === undefined
      || patientPosition.accuracyMeters > this.config.maxPositionAccuracyMeters) return false;
    const patientObservedAt = Date.parse(event.patientPosition?.observedAt
      ?? event.observation.callFirstObservedAt
      ?? event.observation.fallDetectedAt ?? event.createdAt);
    const patientAge = now.getTime() - patientObservedAt;
    if (!Number.isFinite(patientObservedAt)
      || patientAge < -this.config.maxClientClockSkewSeconds * 1_000
      || Math.max(0, patientAge) > this.config.positionMaxAgeSeconds * 1_000) return false;
    return distanceMeters(responderPosition, patientPosition)
      <= event.currentRecruitmentRadiusMeters;
  }

  private deviceIsActivePatient(state: Readonly<PersistentState>, deviceInstanceId: string): boolean {
    const userId = state.devices[deviceInstanceId]?.userId;
    return Object.values(state.events).some((event) => event.state === "ACTIVE"
      && (event.patientDeviceIds.includes(deviceInstanceId)
        || (userId !== undefined && event.patientUserId === userId)));
  }

  private envelope(messageId: string, eventId: string, occurredAt: string) {
    return {
      schemaVersion: "2.0" as const,
      messageId,
      eventId,
      occurredAt
    };
  }
}
