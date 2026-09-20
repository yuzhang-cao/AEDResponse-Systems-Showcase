import { routingAeds, reconcileEventAssets, applyAssetAction, type AedAssetAction } from "./aed-assets.js";
import {
  NullObjectStorage,
  confirmHandover,
  handoverViewOver,
  openHandover,
  reportTemporaryPointFollowUp,
  searchableDepositForEvent,
  settleHandover,
  haltHandoverForExitedHolder,
  type AedHandoverConfirmationRequest,
  type AedHandoverRequest,
  type AedHandoverSettlementRequest,
  type AedTemporaryPointFollowUpRequest,
  type HandoverStoreView,
  type ObjectStoragePort
} from "./aed-handover.js";

import { RETENTION_DEADLINES, readState, transactState, registerStateQueries, stateAccess, stateRows, receiptKeysForDevice, transactionKeys } from "./incremental-state.js";
import { createWatchEvent } from "./watch-event-creation.js";
import { createUserReportedEvent } from "./user-report-creation.js";
import { watchFallbackAllowedByServer, readWatchEventState, requireWatchBinding, requireTriggeringWatch, matchesWatchPatientIdentity } from "./watch-event-access.js";
import { enqueueNotification, NotificationOutbox } from "./notification-outbox.js";
import { appendTimeline } from "./event-audit.js";
import { assignmentExitsParticipation, deviceIdentityKey } from "./domain.js";
import { transitionEventToTerminal } from "./event-lifecycle.js";
import { IdentityAccess, type DevicePrincipal, type AccountPrincipal, type Principal } from "./identity-access.js";
import { recoveryTimeline } from "./event-recovery.js";
import { runResponseDecision } from "./response-decision.js";
import { runResponderExit } from "./responder-exit.js";
import { runAssignmentStatusUpdate } from "./assignment-status.js";
import { runAcquireAed, runReportAedUnavailable } from "./aed-actions.js";
import { ReferenceAedRouteProvider, type AedRouteProvider } from "./route-provider.js";
import {
  runStatusConfirmationResponse,
  STATUS_CONFIRMATION_INTERVAL_SECONDS,
  STATUS_CONFIRMATION_RESPONSE_WINDOW_SECONDS,
  type StatusConfirmationResult,
  advanceStatusConfirmation,
  type StatusConfirmationEmission
} from "./status-confirmation.js";
import { runEventResolution, runFalseAlarmConfirmation } from "./event-resolution.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { BackendConfig } from "./config.js";
import {
  type AccountProvider,
  type AppleIdentityTokenVerificationRequest,
  type AppleIdentityTokenVerifier,
  type WatchAttestationVerifier,
  type WatchAttestationVerificationRequest,
  companionLinkClientDataHash,
  providerSubjectHash
} from "./auth.js";
import { simulationObservationSchema, permitsSimulationDevice, simulationMarker } from "./simulation.js";
import type {
  Aed,
  AedAcquiredReceipt,
  AedUnavailableReport,
  AssignmentStatus,
  CompanionLinkTicketRequest,
  EventEndRequest,
  EventEndReason,
  PatientPosition,
  DeliveryStatus,
  DevicePresenceUpdate,
  EventPositionBatch,
  EventPositionRecord,
  PatientPositionUpdate,
  ResponderDecision,
  ResponderPositionUpdate,
  ResponderPosition,
  ResolutionRequest,
  ParticipantExitRequest,
  SessionBootstrapRequest,
  StatusConfirmationResponse as StatusConfirmationResponseRequest,
  WatchCompanionLinkRequest,
  WatchEmergencyObservation,
  WatchFallbackPositionUpdate
} from "./contracts.js";
import {
  MAX_EVENT_POSITION_RECORDS_PER_BATCH,
  utcSecondSchema
} from "./contracts.js";
import {
  assignmentTransitionAllowed,
  distanceMeters,
  fingerprint,
  isTerminalAssignmentStatus,
  planAssignments,
  tokenHash
} from "./domain.js";
import {
  HttpProblem,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooEarly,
  tooManyRequests,
  unprocessableEntity,
  authenticationUnavailable,
  unauthorized
} from "./errors.js";
import type {
  AedRoute,
  AedHandoverRecord,
  AedTemporaryPointFollowUpRecord,
  AccountRecord,
  AuthChallengeRecord,
  CompanionLinkTicketRecord,
  AssignmentRecord,
  AssignmentView,
  CoordinationSummary,
  CurrentPatientPosition,
  DeliveryRecord,
  DistanceRange,
  DevicePresenceView,
  DeviceRecord,
  EventPositionBatchAck,
  EventPositionBatchRecord,
  EventPositionEvidenceRecord,
  EmergencyEventView,
  EventStatusConfirmationRecord,
  EventRecord,
  NearbyVolunteerSummary,
  NotificationRecord,
  PushAttemptRecord,
  AppleRevocationRecord,
  BreakGlassGrantRecord,
  NeutralEmergencyEventView,
  PatientEmergencyEventView,
  PendingResponseEventView,
  PersistentState,
  PositionUpdateResult,
  ResponseRequestPayload,
  ResponderEmergencyEventView,
  SessionRecord,
  TimelineEntry,
  EtaRange,
  PositioningTier,
  ParticipantIntervalEndReason,
  ParticipantIntervalRecord,
  StatusConfirmationView,
  WatchFallbackCadenceRecord,
  WatchFallbackCandidateRecord,
  PositionFreshness,
  PositionGapReason,
  PositionWindowReconciliationRecord,
  PositionWindowReconciliationClosedBy
} from "./models.js";
import type { StateStore } from "./store.js";
import { operationMetrics, storageMetrics } from "./runtime-metrics.js";
import {
  livePresenceAccess,
  type PresenceState
} from "./presence-access.js";
import { readEntities, type StateReadView } from "./state-read.js";
import {
  legacyCoordinationAedReader,
  txCoordinationAedReader,
  receiptIdsForEventFrom,
  registerAedReceiptProjection,
  type CoordinationAedReader
} from "./coordination-aed-reader.js";
import {
  assertDraftContext,
  committedRecruitmentContext,
  draftRecruitmentContext,
  survivingAssignmentForDevice,
  type CommittedRecruitmentContext,
  type DraftRecruitmentContext,
  type RecruitmentContext
} from "./recruitment-context.js";
import { txRecruitmentContext } from "./tx-recruitment-context.js";
import { isShadowValidationEnabled } from "./store.js";
import { purgeableEvidenceForEvent } from "./retention.js";
import { securityLogEntry, runSecurityLogRetention } from "./security-log.js";
import { buildOperatorStatus, type OperatorStatus } from "./ops-status.js";
import { AppleServerNotificationVerifier } from "./apple-notifications.js";
import {
  planTeamSignal,
  teamSignalFeed,
  type TeamSignalView
} from "./coordination-team.js";
import type { SecurityLogRecord } from "./models.js";
import {
  identityLedgerPath,
  reconcileIdentityLedger,
  restoreWatermarkPath,
  type IdentityLedgerReport
} from "./restore-guard.js";
import {
  SELF_ACCESS_APPROVAL_WORKING_DAYS,
  SELF_ACCESS_CHALLENGE_MS,
  SELF_ACCESS_GRANT_MAX_MS,
  SELF_ACCESS_MAX_CHALLENGE_ATTEMPTS,
  addWorkingDays,
  expireSelfAccessGrants,
  ownDeviceInstanceIds,
  projectSelfAccessView,
  selfAccessChallengePayload,
  selfAccessScope,
  verifySelfAccessChallenge,
  type LocalAuthMethod,
  type SelfAccessView
} from "./self-access.js";
import {
  createSealKey,
  readSealKey,
  sealKeyPath,
  sealedContainerPath,
  serialiseSealedEvidence,
  writeSealedContainer,
  writeSealKey
} from "./sealed-store.js";
import {
  coordinationTeamView,
  type CoordinationTeamView
} from "./coordination-team.js";
import {
  activeBreakGlassGrant,
  auditEntry,
  breakGlassAllows,
  issueBreakGlassGrant,
  requireAuditReason,
  requireEventForAudit,
  type AccessAuditEntry
} from "./access-audit.js";
import {
  POSITION_WINDOW_GRACE_SECONDS,
  expectedSlotInstants,
  gapListsMatch,
  gapSlotsChanged,
  participationWindowFor,
  reconcileWindow,
  reconciliationIdFor,
  windowEvidenceFrom,
  type ParticipationWindow,
  type WindowIdentity
} from "./position-window.js";
import {
  REROUTE_WINDOW_SECONDS,
  assignmentAcceptsReroute,
  decideReroute,
  eventAcceptsReroute,
  proposeReroute,
  rerouteViewOver,
  rerouteWorthProposing
} from "./reroute.js";
import {
  clearAccountPushRegistrations,
  forgetInvalidPushToken,
  normalizePushEnvironment,
  normalizePushToken,
  pushRegistrationFor,
  registerPushToken,
  unregisterPushToken
} from "./push-registration.js";
import {
  UnavailableAppleAccountPort,
  type AppleAccountPort
} from "./apple-account.js";
import {
  NullPushProvider,
  pushPayloadFor,
  pushRequestFor,
  type PushProvider
} from "./push-provider.js";
import {
  placeLegalHold,
  releaseLegalHold,
  runRetentionSweep,
  type RetentionCandidate,
  type RetentionSweepResult
} from "./retention.js";
import type { EntityTransaction } from "./entity-transaction.js";

/**
 * Kept private for deterministic in-process migration tests only. The public
 * HTTP/session bootstrap schema is iPhone-only; Watch sessions use redeem.
 */
type DirectWatchBootstrapRequest = {
  deviceInstanceId: string;
  deviceKind: "WATCH";
  companionPairId: string;
};
type ServiceBootstrapRequest = SessionBootstrapRequest | DirectWatchBootstrapRequest;

/**
 * What a participant is told about a temporary placement point.
 *
 * The photo is deliberately NOT inlined: the object is private and a read grant
 * is issued separately by the storage port, so this view carries only the facts
 * needed to walk to the device.
 */
export interface AedTemporaryPointView {
  depositId: string;
  eventId: string;
  aedId: string;
  status: "SEARCHING" | "FOUND" | "NOT_FOUND";
  position: ResponderPosition;
  positionObservedAt: string;
  depositedAt: string;
  photoReceived: true;
}

export type RealtimeEventName =
  | "event:patient-activated"
  | "event:patient-position-updated"
  | "event:coordination-updated"
  | "response:requested"
  | "response:offer-expired"
  | "response:decision-recorded"
  | "event:false-alarm-confirmed"
  | "event:resolved"
  | "event:assistance-withdrawn"
  | "event:closed-unconfirmed-no-response"
  | "event:status-confirmation-requested"
  | "event:participant-exited"
  | "event:team-signal"
  | "assignment:reroute-proposed"
  | "assignment:created"
  | "assignment:updated"
  | "aed:acquired"
  | "aed:unavailable"
  | "assignment:timed-out";

export interface RealtimePublisher {
  /** Returns only devices handed to a currently usable transport connection. */
  emitToDevices(deviceInstanceIds: readonly string[], name: RealtimeEventName, payload: unknown): readonly string[];
}

export type { DevicePrincipal, AccountPrincipal, OperatorPrincipal, Principal } from "./identity-access.js";
export interface AuthenticationProviders {
  apple?: AppleIdentityTokenVerifier;
  appleIdentityTokenVerifier?: AppleIdentityTokenVerifier;
  watchAttestation?: WatchAttestationVerifier;
  watchAttestationVerifier?: WatchAttestationVerifier;
}

/** Alias retained for callers that prefer an explicit port-oriented name. */
export type AuthProviders = AuthenticationProviders;

export interface AuthSessionResult {
  provider: AccountProvider;
  userId: string;
  accountId: string;
  sessionId: string;
  sessionToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
}

export interface CompanionLinkTicketResult {
  companionLinkTicket: string;
  companionPairId: string;
  expiresAt: string;
}

export type { StatusConfirmationResult } from "./status-confirmation.js";

export interface ParticipantExitResult {
  exitId: string;
  eventId: string;
  exitedAt: string;
  idempotent: boolean;
}

export interface SessionBootstrapResult {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  scopes: string[];
  userId?: string;
  accountId?: string;
  refreshToken?: string;
  sessionKind?: "DEVICE";
}

interface AssignmentEmission {
  deviceInstanceId: string;
  name: "assignment:created" | "assignment:updated";
  assignment: AssignmentView;
  occurredAt: string;
}

interface RealtimeEmission {
  deviceInstanceIds: string[];
  name: RealtimeEventName;
  payload: unknown;
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

interface PatientPriorityResult {
  assignments: AssignmentEmission[];
  updates: RecruitmentUpdate[];
}

interface BootstrapWindow {
  startedAt: number;
  count: number;
}

interface PositionWriteCircuit {
  second: number;
  requestCount: number;
  exceeded: boolean;
  consecutiveExceededSeconds: number;
  degradedUntilAt?: number;
  acceptedDegradedSecond?: number;
}

const noopPublisher: RealtimePublisher = {
  emitToDevices: () => []
};

const ACCOUNT_SESSION_SCOPE = "session:bootstrap";
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const COMPANION_LINK_TICKET_TTL_SECONDS = 5 * 60;
const POSITION_PRUNE_BATCH_LIMIT = 512;
const RESPONSE_OFFER_TTL_SECONDS = 30;
const RECRUITMENT_TARGET_ACCEPTED = 3;
const RECRUITMENT_STAGE_TIMEOUT_SECONDS = 30;
export { STATUS_CONFIRMATION_INTERVAL_SECONDS, STATUS_CONFIRMATION_RESPONSE_WINDOW_SECONDS } from "./status-confirmation.js";
export const RECRUITMENT_RADIUS_STAGES_METERS = [1_000, 1_500, 2_000] as const;

export const POSITION_WRITE_BURST_LIMIT_PER_SECOND = 5;
export const POSITION_WRITE_DEGRADED_AFTER_SECONDS = 10;
export const POSITION_WRITE_DEGRADED_DURATION_SECONDS = 30;

export const WATCH_FALLBACK_PROMOTION_DELAY_SECONDS = 10;
export const WATCH_FALLBACK_MIN_UPLOAD_INTERVAL_SECONDS = 5;
export const WATCH_FALLBACK_MOVEMENT_EARLY_DISTANCE_METERS = 10;

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

function requireDevice(principal: Principal): DevicePrincipal {
  if (principal.kind !== "DEVICE") {
    throw forbidden("This operation requires an authenticated device session");
  }
  return principal;
}

function requireIPhone(principal: Principal): DevicePrincipal {
  const device = requireDevice(principal);
  if (device.deviceKind !== "IPHONE") {
    throw forbidden("This operation is limited to iPhone sessions");
  }
  return device;
}

function requireIPhoneScope(principal: Principal, scope: string): DevicePrincipal {
  const device = requireIPhone(principal);
  if (!device.scopes.includes(scope)) {
    throw forbidden(`Authenticated iPhone session is missing required scope ${scope}`);
  }
  return device;
}

function requireAccountScope(principal: Principal, scope: string): AccountPrincipal {
  if (principal.kind !== "ACCOUNT") {
    throw unauthorized("An authenticated account session is required");
  }
  if (!principal.scopes.includes(scope)) {
    throw forbidden(`Account session is missing required scope ${scope}`);
  }
  return principal;
}

function requireWatchScope(principal: Principal, scope: "watch:report" | "watch:fallback"): DevicePrincipal {
  const device = requireDevice(principal);
  if (device.deviceKind !== "WATCH" || !device.scopes.includes(scope)) {
    throw forbidden(`This operation requires the Watch scope ${scope}`);
  }
  return device;
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

function statusConfirmationView(
  confirmation: EventStatusConfirmationRecord
): StatusConfirmationView {
  return {
    confirmationId: confirmation.confirmationId,
    prompt: "STILL_IN_PROGRESS",
    sentAt: confirmation.sentAt,
    responseDeadlineAt: confirmation.responseDeadlineAt
  };
}

/**
 * Operator gate.
 *
 * The operator token is a deployment credential, not an account: it exists for
 * narrowly scoped administrative facts such as a legal hold.  Every such entry
 * point states what it was asked to do, so a refusal is diagnosable.
 */
function requireOperator(principal: Principal, action: string): void {
  if (principal.kind !== "OPERATOR") {
    throw forbidden(`An operator credential is required to ${action}`);
  }
}

function currentAssignmentForDevice(
  state: Readonly<PresenceState>,
  eventId: string,
  deviceInstanceId: string
): AssignmentRecord | undefined {
  return survivingAssignmentForDevice(state, eventId, deviceInstanceId);
}

function deliveryForDevice(
  state: Readonly<PersistentState>,
  eventId: string,
  deviceInstanceId: string
): DeliveryRecord | undefined {
  return stateRows(state, "deliveries", "eventId", eventId).find((delivery) => delivery.eventId === eventId
    && delivery.deviceInstanceId === deviceInstanceId);
}

function deliveryForUser(
  state: Readonly<PersistentState>,
  eventId: string,
  userId: string
): DeliveryRecord | undefined {
  return stateRows(state, "deliveries", "eventId", eventId).find((delivery) => {
    if (delivery.eventId !== eventId) return false;
    return state.devices[delivery.deviceInstanceId]?.userId === userId;
  });
}

/**
 * AED assignment statuses that still hold the physical device.
 *
 * `AED_UNAVAILABLE` and the two participation-exiting statuses mean the attempt
 * was abandoned, so the device stays in the pool.  Every other status means
 * somebody is walking to, standing at, or carrying this device — and the device
 * does not return to its cabinet by itself, so the claim survives its event
 * ending.  Releasing an AED therefore needs either the responder's event to be
 * replanned away or an explicit return fact; it is never implied by time alone.
 */
const AED_HOLDING_ASSIGNMENT_STATUSES: ReadonlySet<AssignmentStatus> = new Set([
  "ASSIGNED",
  "EN_ROUTE",
  "ARRIVED_AT_AED",
  "AED_ACQUIRED",
  "EN_ROUTE_TO_PATIENT",
  "ARRIVED_AT_PATIENT",
  "COMPLETED"
]);

/**
 * AEDs this state already claims for some other event.
 *
 * Cross-event exclusivity is a physical fact, not a per-event accounting rule:
 * one cabinet holds one device, so the second event that plans a route to an AED
 * the first event already handed to a responder sends that responder to an empty
 * cabinet.  `event.unavailableAedIds` covers only the planning event's own
 * history, which is exactly the gap this closes.
 */
function claimedAedIdsForOtherEvents(
  state: Readonly<PersistentState>,
  eventId: string
): Set<string> {
  const claimed = new Set<string>();
  for (const other of stateRows(state, "events", "$hasUnavailableAeds", "yes")) {
    if (other.id === eventId) continue;
    for (const aedId of other.unavailableAedIds) if (!state.aedAssetsById[aedId]) claimed.add(aedId);
  }
  for (const assignment of stateRows(state, "assignments", "role", "FETCH_AED")) {
    if (assignment.eventId === eventId) continue;
    if (assignment.role !== "FETCH_AED" || !assignment.route || state.aedAssetsById[assignment.route.aedId]) continue;
    if (!AED_HOLDING_ASSIGNMENT_STATUSES.has(assignment.status)) continue;
    const event = state.events[assignment.eventId];
    const userId = state.devices[assignment.deviceInstanceId]?.userId;
    // A responder who has left the event no longer holds its AED for that event;
    // leaving it claimed forever would strand the device for every future event.
    if (userId !== undefined && event?.exitedResponderUserIds?.includes(userId)) continue;
    claimed.add(assignment.route.aedId);
  }
  return claimed;
}

function acceptedDeviceIds(ctx: RecruitmentContext, eventId: string): string[] {
  const event = ctx.getEvent(eventId);
  // With an index this walks only this event's deliveries; without one the legacy
  // adapter falls back to the original whole-collection filter.
  const candidates = ctx.deliveriesOfEvent(eventId);
  const accepted = candidates
    .filter((delivery) => delivery.decision === "ACCEPT"
      && delivery.status === "ACCEPTED")
    .map((delivery) => delivery.deviceInstanceId)
    .filter((deviceId) => {
      const device = ctx.getDevice(deviceId);
      if (device?.userId && event?.exitedResponderUserIds?.includes(device.userId)) {
        return false;
      }
      const assignment = ctx.currentAssignmentForDevice(eventId, deviceId);
      return !assignment || !assignmentExitsParticipation(assignment.status);
    })
    .sort((left, right) => left.localeCompare(right));
  const identities = new Set<string>();
  return accepted.filter((deviceId) => {
    const device = ctx.getDevice(deviceId);
    const identity = device ? deviceIdentityKey(device) : `device:${deviceId}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

/**
 * Legacy context for module-level callers, which have no `this` and therefore no
 * access to the delivery-index seam.  Class methods use `this.recruitmentContext`
 * instead so that whichever call sites already consulted the index still do.
 */
function recruitmentContextFor(state: Readonly<PresenceState>): DraftRecruitmentContext {
  return draftRecruitmentContext(state);
}

function participantIntervalKey(eventId: string, userId: string, deviceInstanceId: string): string {
  return `${eventId}\u0000${userId}\u0000${deviceInstanceId}`;
}

function participantIntervalForDevice(
  state: Readonly<PersistentState>,
  eventId: string,
  userId: string,
  deviceInstanceId: string
): ParticipantIntervalRecord | undefined {
  const key = participantIntervalKey(eventId, userId, deviceInstanceId);
  if (Object.prototype.hasOwnProperty.call(state.participantIntervalsById, key)) {
    return state.participantIntervalsById[key];
  }
  // The field identity is authoritative; the fallback also reads safely when
  // an imported state used a different map key convention.
  return stateRows(state, "participantIntervalsById", "eventId", eventId).find((interval) =>
    interval.eventId === eventId
    && interval.userId === userId
    && interval.deviceInstanceId === deviceInstanceId
  );
}

function eventPositionRecordExclusiveEndLowerBound(
  record: EventPositionEvidenceRecord
): string {
  const includedAt = record.status === "FIX" ? record.fixObservedAt : record.slotAt;
  return new Date(Date.parse(includedAt) + 1).toISOString();
}

/**
 * Exported for the recruitment contract tests, which lock the audience the
 * coordination notifications are addressed to.  Not part of the service's public
 * API: nothing outside this module should call it directly.
 */
export function patientViewerDeviceIds(
  ctx: RecruitmentContext,
  event: EventRecord
): string[] {
  return ctx.candidateDevices(event)
    .filter((device) => device.deviceKind === "IPHONE"
      && permitsSimulationDevice(event.observation, device.deviceInstanceId, device.userId)
      && (event.patientDeviceIds.includes(device.deviceInstanceId)
        || device.userId === event.patientUserId))
    .map((device) => device.deviceInstanceId);
}

function isPatientDevice(
  state: Readonly<PersistentState>,
  event: EventRecord,
  deviceInstanceId: string
): boolean {
  const device = state.devices[deviceInstanceId];
  if (!permitsSimulationDevice(event.observation, deviceInstanceId, device?.userId)) return false;
  return event.patientDeviceIds.includes(deviceInstanceId)
    || (device?.userId !== undefined && device.userId === event.patientUserId);
}

function affectedDeviceIds(state: Readonly<PersistentState>, event: EventRecord): string[] {
  return [
    ...patientViewerDeviceIds(recruitmentContextFor(state), event),
    ...stateRows(state, "deliveries", "eventId", event.id)
      .filter((delivery) => delivery.eventId === event.id)
      .map((delivery) => delivery.deviceInstanceId)
  ].filter((deviceId, index, values) => values.indexOf(deviceId) === index);
}

function participantDeviceIds(state: Readonly<PersistentState>, event: EventRecord): string[] {
  const ctx = recruitmentContextFor(state);
  return [...patientViewerDeviceIds(ctx, event), ...acceptedDeviceIds(ctx, event.id)]
    .filter((deviceId, index, values) => values.indexOf(deviceId) === index);
}

const pendingDeliveryStatuses: DeliveryStatus[] = ["SENT", "DELIVERED", "VIEWED"];

/**
 * Patient-side viewers plus accepted responders, de-duplicated, first occurrence
 * wins.  Exported alongside `patientViewerDeviceIds` for the contract tests.
 *
 * Deliberately a pure function of the context: it is the composition the
 * recruitment refactor must keep identical between the draft, committed and
 * (Phase 2) transaction adapters, so it is the natural place to pin behaviour.
 */
export function coordinationAudienceDeviceIds(
  ctx: RecruitmentContext,
  event: EventRecord
): string[] {
  return [
    ...patientViewerDeviceIds(ctx, event),
    ...acceptedDeviceIds(ctx, event.id)
  ].filter((deviceId, index, values) => values.indexOf(deviceId) === index);
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


const REQUIRED_BOOTSTRAP_AGREEMENTS = [
  "PATIENT",
  "VOLUNTEER_RESPONDER",
  "PRIVACY_POLICY",
  "SENSITIVE_PERSONAL_INFORMATION"
] as const;

function hasAllBootstrapAgreements(device: DeviceRecord): boolean {
  return REQUIRED_BOOTSTRAP_AGREEMENTS.every((kind) => {
    const agreement = device.agreements[kind];
    return agreement?.version === "2.0"
      && typeof agreement.acceptedAt === "string"
      && Number.isFinite(Date.parse(agreement.acceptedAt));
  });
}

function visibleEventCandidates(state: Readonly<PersistentState>, device: DevicePrincipal): EventRecord[] {
  const ids = new Set([
    ...stateRows(state, "events", "patientUserId", device.userId ?? "").map(event => event.id),
    ...stateRows(state, "events", "patientDeviceIds", device.deviceInstanceId).map(event => event.id),
    ...stateRows(state, "deliveries", "deviceInstanceId", device.deviceInstanceId).map(delivery => delivery.eventId)
  ]);
  return [...ids].flatMap(id => state.events[id] ? [state.events[id]!] : []);
}

function eventProjection(
  state: Readonly<PersistentState>,
  event: EventRecord,
  principal: DevicePrincipal,
  coordination: CoordinationSummary,
  pendingOfferEligible = false,
  now = new Date()
): EmergencyEventView | undefined {
  if (!permitsSimulationDevice(event.observation, principal.deviceInstanceId, principal.userId)) return undefined;
  const isWatchPair = principal.deviceKind === "WATCH"
    && principal.companionPairId === event.patientPairId;
  const isPatient = isPatientDevice(state, event, principal.deviceInstanceId);
  const delivery = deliveryForDevice(state, event.id, principal.deviceInstanceId);
  const assignment = currentAssignmentForDevice(state, event.id, principal.deviceInstanceId);
  const isResponder = acceptedDeviceIds(recruitmentContextFor(state), event.id).includes(principal.deviceInstanceId);
  const ownParticipantInterval = principal.userId
    ? participantIntervalForDevice(
      state,
      event.id,
      principal.userId,
      principal.deviceInstanceId
    )
    : undefined;
  const isPrimaryPatientPositionDevice = event.patientDeviceIds.includes(
    principal.deviceInstanceId
  );
  if (!isPatient
    && principal.userId
    && event.exitedResponderUserIds?.includes(principal.userId)) return undefined;
  const livePendingDelivery = delivery !== undefined && deliveryIsLive(delivery, now);
  const deliveryGrantsVisibility = livePendingDelivery
    || (delivery?.status === "ACCEPTED" && delivery.decision === "ACCEPT");
  if (!isWatchPair && !isPatient && !deliveryGrantsVisibility) return undefined;

  const participantEndCandidates = [ownParticipantInterval?.endedAt, event.resolvedAt]
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const eventPositionParticipationStartedAt = isPrimaryPatientPositionDevice
    ? event.createdAt
    : ownParticipantInterval?.acceptedAt ?? null;
  const eventPositionParticipationEndedAt = isPrimaryPatientPositionDevice
    ? event.resolvedAt ?? null
    : participantEndCandidates[0] ?? null;

  const base = {
    ...simulationMarker(event.observation),
    id: event.id,
    state: event.state,
    recruitmentState: event.recruitmentState,
    eventType: "FALL_ASSISTANCE" as const,
    canPublishEventPosition: event.state === "ACTIVE"
      && (event.patientDeviceIds.includes(principal.deviceInstanceId) || isResponder),
    eventPositionParticipationStartedAt,
    eventPositionParticipationEndedAt,
    currentRecruitmentRadiusMeters: event.currentRecruitmentRadiusMeters,
    createdAt: event.createdAt,
    resolvedAt: event.resolvedAt ?? null,
  };

  if (event.state === "ACTIVE" && isPatient) {
    const view: PatientEmergencyEventView = {
      ...base,
      viewerRelationship: "PATIENT",
      positioningTier: "EVENT_PARTICIPANT",
      distanceRange: null,
      etaRange: null,
      expiresAt: null,
      triggerSource: event.triggerSource,
      recruitmentStageStartedAt: event.recruitmentStageStartedAt,
      fallDetectedAt: event.observation.fallDetectedAt ?? null,
      fallResolution: event.observation.fallResolution ?? null,
      appHelpResponse: event.observation.appHelpResponse ?? null,
      callFirstObservedAt: event.observation.callFirstObservedAt ?? null,
      patientPosition: currentPatientPosition(event) ?? null,
      patientPositionSource: currentPatientPositionSample(event)?.source ?? null,
      patientPositionObservedAt: currentPatientPositionSample(event)?.observedAt ?? null,
      patientPositionServerReceivedAt: currentPatientPositionSample(event)?.serverReceivedAt ?? null,
      patientLocationCard: event.patientLocationCard ?? null,
      coordination,
      pendingResponseRequest: null,
      ...(event.statusConfirmation?.state === "PENDING"
        ? { statusConfirmation: statusConfirmationView(event.statusConfirmation) }
        : {}),
      ...(assignment && !assignmentExitsParticipation(assignment.status)
        ? { currentAssignment: assignmentView(assignment) }
        : {})
    };
    return view;
  }

  if (event.state === "ACTIVE" && isResponder) {
    const view: ResponderEmergencyEventView = {
      ...base,
      viewerRelationship: "RESPONDER",
      positioningTier: "EVENT_PARTICIPANT",
      distanceRange: delivery?.request.distanceRange ?? null,
      etaRange: delivery?.request.etaRange ?? null,
      expiresAt: null,
      patientPosition: currentPatientPosition(event) ?? null,
      patientPositionSource: currentPatientPositionSample(event)?.source ?? null,
      patientPositionObservedAt: currentPatientPositionSample(event)?.observedAt ?? null,
      patientPositionServerReceivedAt: currentPatientPositionSample(event)?.serverReceivedAt ?? null,
      patientLocationCard: event.patientLocationCard ?? null,
      coordination,
      pendingResponseRequest: null,
      ...(assignment && !assignmentExitsParticipation(assignment.status)
        ? { currentAssignment: assignmentView(assignment) }
        : {})
    };
    return view;
  }

  if (event.state === "ACTIVE" && pendingOfferEligible && delivery && livePendingDelivery) {
    const view: PendingResponseEventView = {
      ...base,
      viewerRelationship: "NEUTRAL",
      positioningTier: "SEARCH_RING",
      distanceRange: delivery.request.distanceRange,
      etaRange: delivery.request.etaRange,
      expiresAt: delivery.request.expiresAt,
      pendingResponseRequest: {
        ...delivery.request,
        deliveryStatus: delivery.status as ResponseRequestPayload["deliveryStatus"],
        currentRecruitmentRadiusMeters: event.currentRecruitmentRadiusMeters
      }
    };
    return view;
  }

  const view: NeutralEmergencyEventView = {
    ...base,
    viewerRelationship: "NEUTRAL",
    positioningTier: "STANDBY",
    distanceRange: null,
    etaRange: null,
    expiresAt: null,
    pendingResponseRequest: null
  };
  return view;
}

function operatorProjection(event: EventRecord, _coordination: CoordinationSummary): EmergencyEventView {
  // No break-glass capability is modeled in this reference service. Ordinary
  // operator views therefore contain only generic lifecycle/ring metadata;
  // exact P, address cards, trigger observations and participant aggregates
  // are intentionally omitted rather than returned as redacted placeholders.
  const view: NeutralEmergencyEventView = {
    ...simulationMarker(event.observation),
    id: event.id,
    state: event.state,
    recruitmentState: event.recruitmentState,
    eventType: "FALL_ASSISTANCE",
    positioningTier: "STANDBY",
    canPublishEventPosition: false,
    eventPositionParticipationStartedAt: null,
    eventPositionParticipationEndedAt: null,
    currentRecruitmentRadiusMeters: event.currentRecruitmentRadiusMeters,
    viewerRelationship: "NEUTRAL",
    createdAt: event.createdAt,
    resolvedAt: event.resolvedAt ?? null,
    distanceRange: null,
    etaRange: null,
    expiresAt: null,
    pendingResponseRequest: null
  };
  return view;
}

/** Payload indexed for `activeRecruitingEvents`. */
interface ActiveRecruitmentEntry {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/**
 * Events that are actively recruiting, with just the patient position and current
 * radius needed to test whether a standby position could affect them.
 * Registered once per service instance; the store rebuilds it on load and keeps it
 * up to date from each change set.
 */
const ACTIVE_RECRUITING_EVENTS = "activeRecruitingEvents";

/**
 * Deliveries grouped by event.  Replaces `Object.values(state.deliveries)` scans
 * (every delivery ever retained) with "the deliveries of the event in hand".
 */
const DELIVERIES_BY_EVENT = "deliveriesByEventId";

function registerDeliveryIndexProjection(store: StateStore): void {
  const projections = store.projections?.();
  if (!projections) return;
  projections.registerGrouped<DeliveryRecord>({
    name: DELIVERIES_BY_EVENT,
    collection: "deliveries",
    groupKey(entity) {
      const delivery = entity as DeliveryRecord;
      return typeof delivery.eventId === "string" ? delivery.eventId : undefined;
    },
    derive(entity) {
      return entity as DeliveryRecord;
    }
  });
}

function registerActiveRecruitmentProjection(store: StateStore): void {
  const projections = store.projections?.();
  if (!projections) return;
  projections.register<ActiveRecruitmentEntry>({
    name: ACTIVE_RECRUITING_EVENTS,
    collection: "events",
    derive(entity) {
      const event = entity as EventRecord;
      if (event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") return undefined;
      const patientPosition = currentPatientPosition(event);
      if (!patientPosition) {
        // Cannot rule the event out without a usable patient position; index it at
        // the origin-independent fallback so the caller still considers it.
        return { latitude: Number.NaN, longitude: Number.NaN,
          radiusMeters: event.currentRecruitmentRadiusMeters };
      }
      return {
        latitude: patientPosition.latitude,
        longitude: patientPosition.longitude,
        radiusMeters: event.currentRecruitmentRadiusMeters
      };
    }
  });
}



/**
 * Age of a stored position sample in milliseconds, or `null` when the sample
 * carries no usable timestamp.
 *
 * Semantics preserved verbatim from the original prune expression:
 *   - `Math.max(0, now - observedAt)` — a future `observedAt` yields age 0;
 *   - a non-finite `observedAt` yields `null`, and callers must treat that as
 *     "not expired", exactly as the original `Number.isFinite(...) &&` guard did.
 */
export function positionAgeMs(observedAt: string | undefined, now: Date): number | null {
  if (typeof observedAt !== "string") return null;
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now.getTime() - parsed);
}

/**
 * True only when the sample is strictly older than the limit.
 *
 * The original comparison was `age > maxAge * 1000`, NOT `>=`: a sample exactly
 * 600 s old is still valid, and only 600.001 s expires it.  Unparseable or
 * missing timestamps are treated as not expired, matching the original guard.
 * Keeping this in one place is what stops a future "tidy up" from silently
 * shifting the boundary.
 */
/**
 * Freshness verdict for a stored sample.
 *
 * Boundary deliberately identical to the reclamation rule: a sample exactly
 * `maxAgeSeconds` old is still FRESH, and only strictly older is STALE.  A sample
 * with no interpretable timestamp is UNAVAILABLE, never FRESH or STALE.
 */
export function positionFreshness(
  observedAt: string | undefined,
  now: Date,
  maxAgeSeconds: number
): PositionFreshness {
  const age = positionAgeMs(observedAt, now);
  if (age === null) return "UNAVAILABLE";
  return age > maxAgeSeconds * 1_000 ? "STALE" : "FRESH";
}

/** Age in whole seconds, or `null` when it cannot be computed. */
export function positionAgeSeconds(
  observedAt: string | undefined,
  now: Date
): number | null {
  const age = positionAgeMs(observedAt, now);
  return age === null ? null : Math.floor(age / 1_000);
}

export function isPositionExpired(
  observedAt: string | undefined,
  now: Date,
  maxAgeSeconds: number
): boolean {
  const age = positionAgeMs(observedAt, now);
  if (age === null) return false;
  return age > maxAgeSeconds * 1_000;
}

export class AEDResponseService {
  readonly identityAccess: IdentityAccess;
  private publisher: RealtimePublisher;
  private publisherAvailable: boolean;
  private readonly notificationOutbox: NotificationOutbox;
  private readonly bootstrapWindows = new Map<string, BootstrapWindow>();
  private readonly authWindows = new Map<string, BootstrapWindow>();
  private readonly positionWriteCircuits = new Map<string, PositionWriteCircuit>();
  private recruitmentSchedulerTimer: NodeJS.Timeout | undefined;
  private recruitmentTickInFlight: Promise<void> | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly config: BackendConfig,
    publisher: RealtimePublisher = noopPublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly authProviders: AuthenticationProviders = {},
    private readonly routeProvider: AedRouteProvider = new ReferenceAedRouteProvider(),
    /**
     * System push.  Defaults to the honest null provider: no credentials means no
     * delivery claim, and the durable outbox keeps the row for a later attempt.
     */
    private readonly pushProvider: PushProvider = new NullPushProvider(),
    /** Authorization-code exchange and token revocation at Apple. */
    private readonly appleAccount: AppleAccountPort = new UnavailableAppleAccountPort(),
    /**
     * G09 private media storage.  Defaults to the honest null port: no store means
     * a temporary point cannot be created at all, rather than a photo reference
     * being accepted without anything to verify it against.
     */
    private readonly objectStorage: ObjectStoragePort = new NullObjectStorage(),
    /**
     * Apple's signed server notifications.  Defaults to the verifier built on the
     * EMBEDDED Apple root; a caller may inject one only to supply a test chain, and
     * production composition never does.
     */
    appleNotifications?: AppleServerNotificationVerifier
  ) {
    this.publisherAvailable = publisher !== noopPublisher;
    this.publisher = this.trackedPublisher(publisher);
    registerStateQueries(store);
    if (config.production && (!store.transactEntities || !store.projections || !store.devicePositions || !store.assignmentIndex || !store.deliveryIndex)) {
      console.error("G13 recruitment index capability unavailable: collection-scan fallback is active; verify the production store configuration");
    }
    registerActiveRecruitmentProjection(store);
    registerDeliveryIndexProjection(store);
    registerAedReceiptProjection(store);
    this.identityAccess = new IdentityAccess(store, config, now);
    // The verifier uses the embedded Apple root; only the audience is deployment
    // configuration, and it must match the app the notification was addressed to.
    this.appleNotifications = appleNotifications ?? new AppleServerNotificationVerifier({
      ...(config.appleClientIds?.[0] ? { appId: config.appleClientIds[0] } : {}),
      now
    });
    // Every closure or revocation commit extends the ledger immediately, so the
    // record a restore replays is written while the fact is fresh rather than
    // waiting for the next tick.
    this.identityAccess.onRevocation(() => {
      // Tracked, not fired and forgotten: shutdown waits for it, so a closure that
      // committed is in the ledger before the process goes away.
      this.identityLedgerSync = this.reconcileIdentityLedger(true).then(() => undefined, () => undefined);
    });
    this.notificationOutbox = new NotificationOutbox(
      store,
      now,
      (state, records) => this.dispatchNotifications(state, records),
      (records, read) => this.deliverPush(records, read)
    );
  }

  setPublisher(publisher: RealtimePublisher): void {
    this.publisherAvailable = publisher !== noopPublisher;
    this.publisher = this.trackedPublisher(publisher);
  }

  private enqueueTerminalNotifications(
    state: PersistentState,
    event: EventRecord,
    messageId: string,
    devices: readonly string[],
    update: RecruitmentUpdate
  ): void {
    const occurredAt = event.resolvedAt!;
    const name = event.state === "RESOLVED" ? "event:resolved"
      : event.state === "CANCELLED_CONFIRMED_FALSE_ALARM" ? "event:false-alarm-confirmed"
      : event.state === "CANCELLED_ASSISTANCE_WITHDRAWN" ? "event:assistance-withdrawn"
      : "event:closed-unconfirmed-no-response";
    for (const deviceId of new Set(devices)) {
      enqueueNotification(state, deviceId, name, {
        ...this.envelope(messageId, event.id, occurredAt), state: event.state, recruitmentState: event.recruitmentState
      });
    }
    for (const expired of update.expiredOffers) {
      enqueueNotification(state, expired.deviceInstanceId, "response:offer-expired", {
        ...this.envelope(`response-offer-expired:${expired.deliveryId}`, event.id, occurredAt),
        deliveryId: expired.deliveryId, expiresAt: expired.expiresAt, reason: expired.reason
      });
    }
    for (const deviceId of new Set(devices)) {
      enqueueNotification(state, deviceId, "event:coordination-updated", {
        ...this.envelope(
          `coordination-updated:${event.id}:${update.coordination.revision}`,
          event.id,
          occurredAt
        ),
        coordination: update.coordination
      });
    }
  }

  /**
   * Persists the coordination hint for the authorized audience.
   *
   * Consumes a context and writes through it: no bare `state.notificationOutboxById`
   * assignment, so the same code runs unchanged on a transaction view.
   */
  private enqueueCoordinationNotifications(
    ctx: RecruitmentContext,
    event: EventRecord,
    audience: readonly string[],
    coordination: CoordinationSummary,
    occurredAt: string
  ): void {
    const authorized = new Set([
      ...patientViewerDeviceIds(ctx, event),
      ...acceptedDeviceIds(ctx, event.id)
    ]);
    for (const deviceId of new Set(audience)) {
      if (!authorized.has(deviceId)) continue;
      ctx.insertNotification(deviceId, "event:coordination-updated", {
        ...this.envelope(
          `coordination-updated:${event.id}:${coordination.revision}`,
          event.id,
          occurredAt
        ),
        coordination
      });
    }
  }

  private enqueuePatientPositionNotification(
    state: PersistentState,
    event: EventRecord,
    audience: readonly string[],
    coordinationRevision: number,
    occurredAt: string
  ): void {
    const authorized = new Set([
      ...patientViewerDeviceIds(this.recruitmentContext(state), event),
      ...acceptedDeviceIds(this.recruitmentContext(state), event.id)
    ]);
    for (const deviceId of new Set(audience)) {
      if (!authorized.has(deviceId)) continue;
      enqueueNotification(state, deviceId, "event:patient-position-updated", {
        ...this.envelope(
          `patient-position-updated:${event.id}:${coordinationRevision}`,
          event.id,
          occurredAt
        ),
        coordinationRevision
      });
    }
  }

  /** Persists the decision fan-out before the response transaction commits. */
  private enqueueResponseDecisionNotifications(
    state: PersistentState,
    event: EventRecord,
    deliveryId: string,
    decision: ResponderDecision["decision"],
    occurredAt: string,
    audience: readonly string[],
    coordination: CoordinationSummary
  ): void {
    for (const deviceId of new Set(audience)) {
      enqueueNotification(state, deviceId, "response:decision-recorded", {
        ...this.envelope(`response-decision:${deliveryId}:${decision}`, event.id, occurredAt),
        decision,
        coordination
      });
    }
  }

  /** Persists the ordinary task-owner update before its assignment transaction commits. */
  private enqueueAssignmentUpdatedNotification(
    state: PersistentState,
    event: EventRecord,
    deviceInstanceId: string,
    assignment: AssignmentView,
    occurredAt: string
  ): void {
    enqueueNotification(state, deviceInstanceId, "assignment:updated", {
      ...this.envelope(`assignment-updated:${assignment.id}:${assignment.revision}`, event.id, occurredAt),
      assignment
    });
  }

  /** Persists assignment fan-out produced by the response replan transaction. */
  private enqueueAssignmentEmissions(
    state: PersistentState,
    event: EventRecord,
    emissions: readonly AssignmentEmission[]
  ): void {
    for (const emission of emissions) {
      enqueueNotification(state, emission.deviceInstanceId, emission.name, {
        ...this.envelope(
          `${emission.name}:${emission.assignment.id}:${emission.assignment.revision}`,
          event.id,
          emission.occurredAt
        ),
        assignment: emission.assignment
      });
    }
  }

  private enqueueAedAcquiredNotification(
    state: PersistentState,
    event: EventRecord,
    deviceInstanceIds: readonly string[],
    receipt: AedAcquiredReceipt
  ): void {
    for (const deviceId of new Set(deviceInstanceIds)) {
      enqueueNotification(state, deviceId, "aed:acquired", {
        ...this.envelope(`aed-acquired:${receipt.receiptId}`, event.id, receipt.acquiredAt),
        assignmentId: receipt.assignmentId,
        aedId: receipt.aedId,
        receiptId: receipt.receiptId,
        acquiredAt: receipt.acquiredAt
      });
    }
  }

  /**
   * A shared outbox identity is (name, messageId, deviceInstanceId), so every
   * `aed:unavailable` intent needs its own stable business key. A constant
   * messageId collides across assignments and events, and the second report
   * then aborts inside its own business transaction.
   */
  private enqueueAedUnavailableNotification(
    state: PersistentState,
    event: EventRecord,
    deviceInstanceIds: readonly string[],
    assignmentId: string,
    aedId: string,
    occurredAt: string,
    messageDiscriminator: string
  ): void {
    for (const deviceId of new Set(deviceInstanceIds)) {
      enqueueNotification(state, deviceId, "aed:unavailable", {
        ...this.envelope(
          `aed-unavailable:${messageDiscriminator}`,
          event.id,
          occurredAt
        ),
        assignmentId,
        aedId
      });
    }
  }

  private enqueueParticipantExitNotification(
    state: PersistentState,
    event: EventRecord,
    deviceInstanceIds: readonly string[],
    exitId: string,
    occurredAt: string,
    coordinationRevision: number
  ): void {
    for (const deviceId of new Set(deviceInstanceIds)) {
      enqueueNotification(state, deviceId, "event:participant-exited", {
        ...this.envelope(`participant-exited:${exitId}`, event.id, occurredAt),
        coordinationRevision
      });
    }
  }

  /**
   * Hands durable notifications to the system push provider.
   *
   * Runs after the socket pass, on rows the socket authorization did not suppress,
   * so push inherits exactly the same audience decision and cannot leak an alert
   * to someone the business layer already excluded.  Every attempt is recorded on
   * the row, and a token APNs declares invalid is forgotten for that device only.
   */
  private async deliverPush(
    records: readonly NotificationRecord[],
    read: <T>(reader: (view: StateReadView) => T) => T
  ): Promise<void> {
    if (records.length === 0) return;
    const configured = this.pushProvider.isConfigured();
    const attempts: {
      id: string;
      status: PushAttemptRecord["status"];
      reason?: string;
      invalidToken?: string;
    }[] = [];
    for (const record of records) {
      const device = read(view => view.get("devices", record.recipient.deviceInstanceId)) as
        DeviceRecord | undefined;
      const registration = pushRegistrationFor(device);
      if (!registration) {
        attempts.push({ id: record.id, status: "NOT_REGISTERED" });
        continue;
      }
      if (!configured) {
        // No credentials: record the reason instead of pretending delivery.
        attempts.push({ id: record.id, status: "PENDING", reason: "PROVIDER_UNAVAILABLE" });
        continue;
      }
      const request = pushRequestFor(record, registration);
      // The payload is built here so a test can assert what leaves the process.
      pushPayloadFor(request);
      const outcome = await this.pushProvider.send(request);
      switch (outcome.status) {
        case "DELIVERED":
          attempts.push({ id: record.id, status: "DELIVERED" });
          break;
        case "INVALID_TOKEN":
          attempts.push({
            id: record.id, status: "INVALID_TOKEN", reason: outcome.reason,
            invalidToken: registration.token
          });
          break;
        case "PERMANENT":
          attempts.push({ id: record.id, status: "RETRY", reason: outcome.reason });
          break;
        case "RETRY":
        default:
          attempts.push({ id: record.id, status: "RETRY", reason: outcome.reason });
          break;
      }
    }
    if (attempts.length === 0) return;
    const at = this.now().toISOString();
    await transactState(this.store, (draft) => {
      for (const attempt of attempts) {
        const row = draft.notificationOutboxById[attempt.id];
        if (!row) continue;
        row.push = {
          status: attempt.status,
          attempts: (row.push?.attempts ?? 0) + 1,
          lastAttemptAt: at,
          ...(attempt.reason ? { reason: attempt.reason } : {})
        };
        if (attempt.invalidToken) forgetInvalidPushToken(draft, attempt.invalidToken);
      }
    });
  }

  /**
   * Registers the APNs token of the calling iPhone.
   *
   * Idempotent per device, and a replacement rather than an addition: the newest
   * token wins, because that is the only one APNs will accept for this
   * installation.  The token is never echoed back to any client.
   */
  async registerPushToken(principal: Principal, input: {
    pushToken: string;
    pushEnvironment: string;
    bundleId: string;
  }): Promise<{ registeredAt: string; environment: string }> {
    const iPhone = requireIPhoneScope(principal, "position:write");
    const token = normalizePushToken(input.pushToken);
    const environment = normalizePushEnvironment(input.pushEnvironment);
    const bundleId = input.bundleId.trim();
    if (!bundleId || bundleId.length > 255) throw badRequest("bundleId is invalid");
    const registeredAt = this.now().toISOString();
    await transactState(this.store, (draft) => {
      const device = draft.devices[iPhone.deviceInstanceId];
      if (!device) throw forbidden("Device session is no longer registered");
      registerPushToken(draft, iPhone.deviceInstanceId, {
        token, environment, bundleId, registeredAt
      });
    });
    return { registeredAt, environment };
  }

  /** Removes this device's registration; idempotent by design. */
  async unregisterPushToken(principal: Principal): Promise<{ removed: boolean }> {
    const iPhone = requireIPhoneScope(principal, "position:write");
    const removed = await transactState(this.store, (draft) =>
      unregisterPushToken(draft, iPhone.deviceInstanceId));
    return { removed };
  }

  /**
   * Resolves one push/notification identifier into the REST truth.
   *
   * The tap path must never act on the push body itself: the body is a hint that
   * may be minutes old.  This returns the opaque identifiers and the current
   * terminal state so the client can decide to open the event or drop the alert.
   */
  notificationRoute(principal: Principal, messageId: string): {
    messageId: string;
    eventId: string | null;
    name: string | null;
    eventState: string | null;
    actionable: boolean;
  } {
    if (principal.kind !== "DEVICE" || principal.deviceKind !== "IPHONE") {
      throw forbidden("Notification routing requires an authenticated iPhone session");
    }
    const row = readState(this.store, (state) => state.notificationOutboxById[messageId]);
    if (!row) {
      // Unknown or already-collected: not an error, just nothing to open.
      return { messageId, eventId: null, name: null, eventState: null, actionable: false };
    }
    if (row.recipient.deviceInstanceId !== principal.deviceInstanceId) {
      throw forbidden("Notification does not belong to this device session");
    }
    const event = readState(this.store, (state) => state.events[row.eventId]);
    return {
      messageId,
      eventId: row.eventId,
      name: row.name,
      eventState: event?.state ?? null,
      actionable: event !== undefined && event.state === "ACTIVE"
    };
  }

  private dispatchNotifications(
    state: Readonly<PersistentState>, records: readonly NotificationRecord[]
  ): Map<string, NotificationRecord["status"]> {
    const outcomes = new Map<string, NotificationRecord["status"]>();
    const groups = new Map<string, { name: NotificationRecord["name"]; payload: Record<string, unknown>; records: NotificationRecord[] }>();
    for (const record of records) {
      const event = state.events[record.eventId];
      const deviceId = record.recipient.deviceInstanceId;
      const device = state.devices[deviceId];
      outcomes.set(record.id, "SUPPRESSED");
      if (!event || !device || !permitsSimulationDevice(event.observation, deviceId, device.userId)) continue;
      let payload = record.payload;
      const patient = isPatientDevice(state, event, deviceId);
      const delivery = deliveryForDevice(state, event.id, deviceId);
      const acceptedResponder = delivery?.status === "ACCEPTED"
        && delivery.decision === "ACCEPT"
        && !(device.userId && event.exitedResponderUserIds?.includes(device.userId));
      const activeParticipant = patient || acceptedResponder;
      if (record.name === "response:requested") {
        if (event.state !== "ACTIVE") continue;
        const currentDelivery = state.deliveries[String(record.payload.deliveryId)];
        if (!currentDelivery || currentDelivery.eventId !== event.id
          || currentDelivery.deviceInstanceId !== deviceId
          || !deliveryIsLive(currentDelivery, this.now())
          || !this.isEligibleNearbyResponder(this.recruitmentContext(state), event, device, this.now())) continue;
      } else if (record.name === "response:offer-expired") {
        const expiredDelivery = state.deliveries[String(record.payload.deliveryId)];
        if (!expiredDelivery || expiredDelivery.eventId !== event.id
          || expiredDelivery.deviceInstanceId !== deviceId
          || expiredDelivery.status !== "EXPIRED") continue;
      } else if (record.name === "event:patient-activated") {
        if (event.state !== "ACTIVE" || !patient) continue;
      } else if (record.name === "assignment:created" || record.name === "assignment:updated") {
        if (event.state !== "ACTIVE") continue;
        const assignmentPayloadValue = record.payload.assignment;
        if (!assignmentPayloadValue || typeof assignmentPayloadValue !== "object"
          || Array.isArray(assignmentPayloadValue)) continue;
        const assignmentPayload = assignmentPayloadValue as Record<string, unknown>;
        const assignmentId = assignmentPayload.id;
        const revision = assignmentPayload.revision;
        if (typeof assignmentId !== "string" || typeof revision !== "number") continue;
        const current = state.assignments[assignmentId];
        if (!current || current.eventId !== event.id || current.deviceInstanceId !== deviceId
          || current.revision !== revision || !acceptedResponder) continue;
      } else if (record.name === "response:decision-recorded") {
        if (event.state !== "ACTIVE" || !activeParticipant) continue;
      } else if (record.name === "event:coordination-updated") {
        if (!activeParticipant) continue;
        if (!patient && !acceptedDeviceIds(this.recruitmentContext(state), event.id).includes(deviceId)) {
          payload = { ...payload, coordination: { currentRecruitmentRadiusMeters: event.currentRecruitmentRadiusMeters } };
        }
      } else if (record.name === "event:patient-position-updated"
        || record.name === "event:participant-exited"
        || record.name === "aed:acquired"
        || record.name === "aed:unavailable") {
        if (event.state !== "ACTIVE" || !activeParticipant) continue;
      } else if (record.name === "event:status-confirmation-requested") {
        const confirmation = event.statusConfirmation;
        if (event.state !== "ACTIVE" || !patient || !confirmation
          || confirmation.state !== "PENDING"
          || confirmation.confirmationId !== record.payload.confirmationId
          || Date.parse(confirmation.responseDeadlineAt) < this.now().getTime()) continue;
      } else if (event.state === "ACTIVE") {
        continue;
      } else {
        if (!activeParticipant) continue;
      }
      const key = fingerprint({ name: record.name, payload });
      const group = groups.get(key) ?? { name: record.name, payload, records: [] };
      group.records.push(record);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (!this.publisherAvailable) throw new Error("Notification transport is unavailable");
      const handedOff = new Set(this.publisher.emitToDevices(
        group.records.map(record => record.recipient.deviceInstanceId), group.name, group.payload));
      for (const record of group.records) {
        // A response offer is an expiring, replayable intent. Transport handoff
        // is deliberately not treated as final delivery; keep the same durable
        // record pending so the scheduler can retry it until the offer expires.
        outcomes.set(record.id, record.name === "response:requested"
          ? "PENDING"
          : handedOff.has(record.recipient.deviceInstanceId) ? "DISPATCHED" : "PENDING");
      }
    }
    return outcomes;
  }

  private trackedPublisher(publisher: RealtimePublisher): RealtimePublisher {
    return { emitToDevices: (devices, name, payload) => publisher.emitToDevices(devices, name, payload) };
  }

  /**
   * Runs the durable recruitment/offer expiry hook while the local reference
   * server is alive. The state itself remains authoritative, so a restart
   * resumes from the persisted stage timestamp; production deployments should
   * replace this process-local driver with a persistent job/queue.
   */
  startRecruitmentScheduler(intervalMs = 1_000): void {
    if (this.recruitmentSchedulerTimer) return;
    const interval = Math.max(1, Math.floor(intervalMs));
    this.recruitmentSchedulerTimer = setInterval(() => {
      void this.runRecruitmentTick();
    }, interval);
    this.recruitmentSchedulerTimer.unref?.();
    void this.runRecruitmentTick();
  }

  /**
   * Result of the most recent retention sweep, for operator diagnostics.
   *
   * `deferred` is the interesting list: a purge whose authorisation is committed
   * but whose deletion must be retried.  Reporting it separately is what keeps
   * "the policy ran" from being claimed while evidence is still present.
   */
  private lastRetentionSweep: RetentionSweepResult | undefined;
  /** Last identity-ledger reconciliation, for operator diagnostics (G11). */
  private lastIdentityLedgerReport: IdentityLedgerReport | undefined;
  private identityLedgerReconciledAt = 0;
  /** The ledger write triggered by the most recent closure/revocation commit. */
  private identityLedgerSync: Promise<void> = Promise.resolve();
  /** Process start, so the status answer makes a restart visible. */
  private readonly startedAt = Date.now();
  /** Verifies Apple's server-to-server notifications against the embedded root. */
  private readonly appleNotifications: AppleServerNotificationVerifier;

  /**
   * Replays the identity ledger and rewrites its watermark.
   *
   * Runs at startup (before the first request is served) and whenever a closure
   * or revocation commits.  The replay is idempotent, so a repeated pass costs a
   * file read and touches nothing, while a missed pass after a crash is corrected
   * on the next start.  A failure is reported and retried — the loaded state keeps
   * whatever closures it had, which is the safe direction.
   */
  async reconcileIdentityLedger(force = false): Promise<IdentityLedgerReport | undefined> {
    const now = this.now();
    if (!force && now.getTime() - this.identityLedgerReconciledAt < 30_000) {
      return this.lastIdentityLedgerReport;
    }
    try {
      const report = await reconcileIdentityLedger({
        store: this.store,
        ledgerPath: this.identityLedgerFile(),
        watermarkPath: restoreWatermarkPath(this.config.dataFile),
        now,
        allowStaleLedger: this.config.allowStaleIdentityLedger === true
      });
      this.identityLedgerReconciledAt = now.getTime();
      this.lastIdentityLedgerReport = report;
      if (report.replay.accountsClosed > 0 || report.replay.sessionsRevoked > 0) {
        console.error(
          `Identity ledger replay corrected the loaded state: ${report.replay.accountsClosed} account(s) `
          + `closed and ${report.replay.sessionsRevoked} session(s) revoked again`
        );
      }
      return report;
    } catch (error) {
      operationMetrics.identityLedgerFailures += 1;
      console.error("Identity ledger reconciliation failed:",
        error instanceof Error ? error.message : "unknown error");
      // A rolled-back ledger must not be served as if it were current.
      throw error;
    }
  }

  identityLedgerStatus(): IdentityLedgerReport | undefined {
    return this.lastIdentityLedgerReport;
  }

  /**
   * Waits for the ledger write the last closure or revocation triggered.
   *
   * Called on shutdown: a process that exits with a committed closure and no
   * ledger entry would leave the next restore unprotected for exactly that fact.
   */
  async flushIdentityLedger(): Promise<void> {
    await this.identityLedgerSync;
  }

  private identityLedgerFile(): string {
    return this.config.identityLedgerFile ?? identityLedgerPath(this.config.dataFile);
  }

  retentionStatus(): RetentionSweepResult | undefined {
    return this.lastRetentionSweep;
  }

  /** Runs the retention sweep now; the scheduler also calls it every tick. */
  async runRetention(now: Date = this.now()): Promise<RetentionSweepResult> {
    const result = await this.sweepRetention(now);
    this.recordRetentionSweep(result);
    return result;
  }

  /**
   * The configured window grace period, in milliseconds.
   *
   * Falls back to the published default rather than to zero: treating an unset
   * value as "no grace" would make every late-but-legal retry arrive too late.
   */
  private positionWindowGraceMs(): number {
    return (this.config.positionWindowGraceSeconds ?? POSITION_WINDOW_GRACE_SECONDS) * 1_000;
  }

  /**
   * Recomputes the final outcome for every participation window of one event.
   *
   * Called when a window closes (event terminal, participant exit) and when a
   * late-but-legal batch arrives, because until the grace deadline passes the gap
   * list is a work item that real evidence is expected to replace.
   *
   * Deliberately NOT called from the normal write path: arrival order is not a
   * verdict, and the requirement forbids freezing a cross-batch hole into a final
   * audit conclusion while the client may still be replaying its queue.
   */
  async reconcilePositionWindows(input: {
    eventId: string;
    closedBy: PositionWindowReconciliationClosedBy;
  }): Promise<PositionWindowReconciliationRecord[]> {
    const now = this.now();
    const plan = readEntities(this.store, (view) => {
      const event = view.get("events", input.eventId);
      if (!event) return [];
      const windows: ParticipationWindow[] = [];
      for (const deviceInstanceId of event.patientDeviceIds) {
        const device = view.get("devices", deviceInstanceId);
        const window = participationWindowFor(event, {
          deviceInstanceId,
          userId: device?.userId ?? event.patientUserId
        });
        if (window) windows.push(window);
      }
      for (const interval of view.select("participantIntervalsById",
        row => row.eventId === input.eventId, Number.MAX_SAFE_INTEGER)) {
        const window = participationWindowFor(event, {
          deviceInstanceId: interval.deviceInstanceId,
          userId: interval.userId,
          interval
        });
        if (window) windows.push(window);
      }
      return windows;
    });
    if (plan.length === 0) return [];

    const records: PositionWindowReconciliationRecord[] = [];
    for (const window of plan) {
      const record = await this.reconcileOnePositionWindow(window, input.closedBy, now);
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * Recomputes one window's verdict and stores it.
   *
   * The verdict is derived from the committed batch store every time, so a
   * recomputation can only ever describe what is actually recorded.  The stored
   * record keeps its identity (`reconciliationId`) and only gains a revision, so
   * a late fact replaces a provisional gap instead of creating a second verdict.
   */
  private async reconcileOnePositionWindow(
    window: ParticipationWindow,
    closedBy: PositionWindowReconciliationClosedBy,
    now: Date
  ): Promise<PositionWindowReconciliationRecord | undefined> {
    const reconciliationId = reconciliationIdFor(window.identity, window.startedAt);
    const graceMs = this.positionWindowGraceMs();
    const snapshot = readEntities(this.store, (view) => {
      const event = view.get("events", window.identity.eventId);
      if (!event) return undefined;
      const device = view.get("devices", window.identity.deviceInstanceId);
      const batches = view.select("eventPositionBatchesById",
        row => row.eventId === window.identity.eventId, Number.MAX_SAFE_INTEGER);
      const prior = view.get("positionWindowReconciliationsById", reconciliationId);
      // The window end the server would enforce right now.  A window that is
      // still open must not be reconciled: the seconds between the last fact and
      // "now" are pending, not missing.
      const fresh = participationWindowFor(event, {
        deviceInstanceId: window.identity.deviceInstanceId,
        userId: window.identity.userId,
        ...(window.identity.kind === "R"
          ? {
            interval: view.select("participantIntervalsById",
              row => row.eventId === window.identity.eventId
                && row.deviceInstanceId === window.identity.deviceInstanceId
                && row.userId === window.identity.userId, 1)[0]
          }
          : {})
      });
      return { event, device, batches, prior, fresh };
    });
    if (!snapshot) return undefined;
    const effective = snapshot.fresh ?? window;
    const endedAt = effective.endedAt;
    if (endedAt === null) return undefined;

    const evidence = windowEvidenceFrom(snapshot.batches, effective.identity);
    const windowEnd = Date.parse(endedAt);
    const withinGrace = Number.isFinite(windowEnd)
      ? now.getTime() < windowEnd + graceMs
      : true;
    const outcome = reconcileWindow({
      window: { ...effective, endedAt },
      evidence,
      withinGrace
    });

    const prior = snapshot.prior;
    const gaps: PositionWindowReconciliationRecord["gaps"] = outcome.gaps.map(gap => ({
      slotAt: gap.slotAt,
      reason: gap.reason,
      provisional: withinGrace
    }));
    // "Corrected by late evidence" means the set of missing SECONDS changed, not
    // merely that the grace deadline passed and flipped the provisional flags.
    const correctedByLateEvidence = prior !== undefined
      && gapSlotsChanged(prior.gaps, gaps);

    const record: PositionWindowReconciliationRecord = {
      reconciliationId,
      eventId: effective.identity.eventId,
      userId: effective.identity.userId,
      deviceInstanceId: effective.identity.deviceInstanceId,
      kind: effective.identity.kind,
      windowStartedAt: effective.startedAt,
      windowEndedAt: endedAt,
      reconciledAt: now.toISOString(),
      closedBy,
      expectedSlotCount: outcome.expectedSlotCount,
      receivedSlotCount: outcome.receivedSlotCount,
      receivedRecordCount: outcome.receivedRecordCount,
      noFixSlotCount: outcome.noFixSlotCount,
      fixSlotCount: outcome.fixSlotCount,
      gaps,
      graceDeadlineAt: Number.isFinite(windowEnd)
        ? new Date(windowEnd + graceMs).toISOString()
        : now.toISOString(),
      final: !withinGrace,
      revision: (prior?.revision ?? 0) + 1,
      correctedByLateEvidence
    };

    await transactState(this.store, (state) => {
      state.positionWindowReconciliationsById[reconciliationId] = record;
    });
    operationMetrics.positionWindowReconciliations += 1;
    operationMetrics.positionWindowGapsRecorded += gaps.length;
    if (correctedByLateEvidence) operationMetrics.positionWindowLateCorrections += 1;
    return record;
  }

  /** The stored verdicts for one event, for audit and diagnostics. */
  positionWindowReconciliations(principal: Principal, eventId: string) {
    if (principal.kind === "ACCOUNT") {
      throw forbidden("Account session cannot read event position audits");
    }
    if (principal.kind === "DEVICE") requireIPhoneScope(principal, "events:read");
    return readEntities(this.store, view => view.select("positionWindowReconciliationsById",
      row => row.eventId === eventId, Number.MAX_SAFE_INTEGER));
  }

  /**
   * The explicit client completion signal.
   *
   * The reference backend has no `stream-finalized` transport signal, so the
   * client states the last slot it has sealed and the server reconciles that
   * window now instead of waiting for the event to end.  It is a request to
   * audit, not a claim that the data is complete: the verdict is still derived
   * from what the server actually recorded.
   */
  async reportPositionWindowComplete(principal: Principal, eventId: string): Promise<{
    reconciled: number;
    records: PositionWindowReconciliationRecord[];
  }> {
    const iPhone = requireIPhoneScope(principal, "position:write");
    const event = readEntities(this.store, view => view.get("events", eventId));
    if (!event) throw notFound("Event does not exist");
    const device = readEntities(this.store, view => view.get("devices", iPhone.deviceInstanceId));
    if (!device) throw forbidden("Device session is no longer registered");
    if (event.state === "ACTIVE") {
      // An open window is not reconciled: that would freeze the pending seconds.
      throw conflict("A participation window can only be reconciled after it closes");
    }
    const records = await this.reconcilePositionWindows({
      eventId,
      closedBy: "CLIENT_COMPLETE_SIGNAL"
    });
    return { reconciled: records.length, records };
  }

  /**
   * Deletes one event's private media objects (G12).
   *
   * The references are deleted only after the store confirms the bytes are gone,
   * so a failure leaves the purge withheld and retryable rather than stranding
   * objects nobody can point at.  A deployment without a configured object store
   * never recorded a reference in the first place (`confirmObject` refuses), so
   * there is nothing to delete and the sweep proceeds.
   */
  private async deleteEventMedia(input: {
    eventId: string;
    objectKeys: string[];
  }): Promise<{ deleted: number } | undefined> {
    if (!this.objectStorage.configured) {
      operationMetrics.mediaDeletionsSkippedNoStore += input.objectKeys.length;
      return { deleted: input.objectKeys.length };
    }
    let deleted = 0;
    try {
      for (const objectKey of input.objectKeys) {
        await this.objectStorage.deleteObject({ objectKey });
        deleted += 1;
      }
      operationMetrics.mediaObjectsDeleted += deleted;
      return { deleted };
    } catch (error) {
      operationMetrics.mediaDeletionFailures += 1;
      console.error("Media deletion skipped:",
        error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  }

  /**
   * Resolves the events retention may act on: TERMINAL events only.
   *
   * Reading every event on every tick to answer "is anything due?" is exactly the
   * whole-state cost G13-A removed, so this uses the same `state` relation index
   * the scheduler already relies on, one query per terminal state.  A state
   * without that index falls back to a bounded read of the events collection,
   * counted as `retentionCandidateReads` so the fallback is visible.
   */
  private async sweepRetention(now: Date): Promise<RetentionSweepResult> {
    return runRetentionSweep(this.store, now, () => this.retentionCandidates(now), {
      sealEvidence: input => this.sealEventEvidence(input),
      deleteMediaObjects: input => this.deleteEventMedia(input)
    });
  }

  /**
   * Writes the encrypted cold copy of one event's evidence.
   *
   * Runs before the tier becomes SEALED, so the sealed label always describes a
   * container that exists.  The key is a sibling file with 0600: a key stored
   * inside the database would make the encryption decorative and would be copied
   * by every careless backup.  Any failure here returns `undefined` instead of
   * throwing — the 30 online days are up either way, so the tier still advances,
   * and the purge then refuses to delete evidence that has no copy.
   */
  private async sealEventEvidence(input: {
    eventId: string;
    sealedAt: string;
  }): Promise<{ path: string; bytes: number } | undefined> {
    try {
      const keyPath = sealKeyPath(this.config.dataFile);
      let key: Buffer;
      try {
        key = await readSealKey(keyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        key = createSealKey();
        await writeSealKey(keyPath, key);
      }
      const plaintext = serialiseSealedEvidence({
        eventId: input.eventId,
        sealedAt: input.sealedAt,
        collections: purgeableEvidenceForEvent(this.store, input.eventId)
      });
      const written = await writeSealedContainer({
        path: sealedContainerPath(this.config.dataFile, input.eventId),
        key,
        eventId: input.eventId,
        plaintext,
        sealedAt: input.sealedAt
      });
      operationMetrics.sealedContainersWritten += 1;
      return { path: written.path, bytes: written.bytes };
    } catch (error) {
      operationMetrics.sealedContainerFailures += 1;
      console.error("Cold sealing skipped:",
        error instanceof Error ? error.message : "unknown error");
      return undefined;
    }
  }

  /**
   * Terminal events of one state, through the relation index when the store has
   * one.  `stateRows` needs the request-local draft, which the scheduler tick
   * does not have outside its transaction, so this reads the committed projection
   * directly and falls back to a bounded scan only when it is absent.
   */
  private retentionCandidates(now: Date): RetentionCandidate[] {
    const deadlines = this.store.projections?.()?.readDue(RETENTION_DEADLINES, now.getTime(), 100);
    return readEntities(this.store, view => {
      if (!deadlines) {
        operationMetrics.retentionCandidateReads += 1;
        return view.select("events", event => event.state !== "ACTIVE", 100) as RetentionCandidate[];
      }
      return deadlines.keys.flatMap(id => {
        const event = view.get("events", id);
        return event ? [event as RetentionCandidate] : [];
      });
    });
  }

  private recordRetentionSweep(result: RetentionSweepResult): void {
    this.lastRetentionSweep = result;
    operationMetrics.retentionSealedEvents += result.sealed.length;
    operationMetrics.retentionPurgedEvents += result.purged.length;
    // Deferred purges are a gauge, not a counter: they must return to zero once
    // the deletion succeeds, or the policy is not actually being kept.
    operationMetrics.retentionDeferredPurges = result.deferred.length;
    operationMetrics.purgesWithheldNoColdCopy = result.withheldNoColdCopy.length;
    operationMetrics.purgesWithheldMediaDeletion = result.withheldMediaDeletion.length;
  }

  /**
   * Places a legal hold on one event.
   *
   * Operator-only and per event: the requirement is that a lawful hold freezes
   * the relevant event and records its basis, not that an operator can freeze
   * the deployment.  The basis and reason are required so the hold is auditable
   * after the fact.
   */
  async placeEventLegalHold(principal: Principal, input: {
    eventId: string;
    authority: string;
    reason: string;
    placedAt?: string;
  }): Promise<{ eventId: string; placedAt: string }> {
    requireOperator(principal, "place a legal hold");
    const placedAt = input.placedAt ?? this.now().toISOString();
    await this.store.transact((state) => {
      const applied = placeLegalHold(state, input.eventId, {
        placedAt,
        authority: input.authority,
        reason: input.reason
      });
      if (!applied) {
        throw conflict("Legal hold can only be placed on an event that still has retained evidence");
      }
      appendTimeline(
        state,
        input.eventId,
        placedAt,
        "PASSIVE_OBSERVATION",
        `Legal hold recorded (authority: ${input.authority}); retention actions are frozen for this event.`
      );
    });
    return { eventId: input.eventId, placedAt };
  }

  /** Releases a legal hold.  The retention clock is not rewound. */
  async releaseEventLegalHold(principal: Principal, input: {
    eventId: string;
    authority: string;
    reason: string;
    releasedAt?: string;
  }): Promise<{ eventId: string; releasedAt: string }> {
    requireOperator(principal, "release a legal hold");
    const releasedAt = input.releasedAt ?? this.now().toISOString();
    await this.store.transact((state) => {
      const applied = releaseLegalHold(
        state, input.eventId, releasedAt, input.authority, input.reason);
      if (!applied) throw conflict("No active legal hold exists for this event");
      appendTimeline(
        state,
        input.eventId,
        releasedAt,
        "PASSIVE_OBSERVATION",
        `Legal hold released (authority: ${input.authority}); retention resumes from the original clock.`
      );
    });
    return { eventId: input.eventId, releasedAt };
  }

  async stopRecruitmentScheduler(): Promise<void> {
    if (this.recruitmentSchedulerTimer) {
      clearInterval(this.recruitmentSchedulerTimer);
      this.recruitmentSchedulerTimer = undefined;
    }
    const inFlight = this.recruitmentTickInFlight;
    if (inFlight) await inFlight;
  }

  private runRecruitmentTick(): Promise<void> {
    if (this.recruitmentTickInFlight) return this.recruitmentTickInFlight;
    const run = (async () => {
      try {
        await this.tick();
      } catch (error) {
        // A failed tick must not terminate the HTTP server or leak request
        // data. The next tick can retry from the persisted state.
        console.error(
          "Recruitment scheduler tick failed",
          error instanceof Error ? error.message : "unknown error"
        );
      }
    })();
    this.recruitmentTickInFlight = run;
    void run.then(() => {
      if (this.recruitmentTickInFlight === run) this.recruitmentTickInFlight = undefined;
    });
    return run;
  }

  /**
   * Position writes are normally allowed at any rate. Only a sustained burst
   * from one authenticated device opens a short degraded window; the normal
   * path never returns 429 merely because a client is sending a fixed-rate
   * location stream.
   */
  private enforcePositionWriteCircuit(deviceInstanceId: string): void {
    const nowMilliseconds = this.now().getTime();
    const second = Math.floor(nowMilliseconds / 1_000);
    let circuit = this.positionWriteCircuits.get(deviceInstanceId);

    if (!circuit) {
      circuit = {
        second,
        requestCount: 0,
        exceeded: false,
        consecutiveExceededSeconds: 0
      };
      this.positionWriteCircuits.set(deviceInstanceId, circuit);
    }

    if (circuit.degradedUntilAt !== undefined) {
      if (nowMilliseconds < circuit.degradedUntilAt) {
        if (circuit.acceptedDegradedSecond === second) {
          throw tooManyRequests("Position writes are temporarily degraded");
        }
        circuit.acceptedDegradedSecond = second;
        return;
      }

      // Recovery starts with the first request at or after the exact expiry.
      circuit = {
        second,
        requestCount: 0,
        exceeded: false,
        consecutiveExceededSeconds: 0
      };
      this.positionWriteCircuits.set(deviceInstanceId, circuit);
    }

    if (circuit.second !== second) {
      const contiguous = second === circuit.second + 1;
      circuit.consecutiveExceededSeconds = contiguous && circuit.exceeded
        ? circuit.consecutiveExceededSeconds
        : 0;
      circuit.second = second;
      circuit.requestCount = 0;
      circuit.exceeded = false;
    }

    circuit.requestCount += 1;
    if (circuit.requestCount <= POSITION_WRITE_BURST_LIMIT_PER_SECOND || circuit.exceeded) {
      return;
    }

    circuit.exceeded = true;
    circuit.consecutiveExceededSeconds += 1;
    if (circuit.consecutiveExceededSeconds >= POSITION_WRITE_DEGRADED_AFTER_SECONDS) {
      circuit.degradedUntilAt = nowMilliseconds
        + POSITION_WRITE_DEGRADED_DURATION_SECONDS * 1_000;
      // The request that proves the tenth sustained burst is accepted. A
      // later request in this same second is the first degraded rejection.
      circuit.acceptedDegradedSecond = second;
    }
  }

  async provisionControlledTestAccount(accountKey: string): Promise<AuthSessionResult> {
    if (!this.config.enableControlledTestAccounts) {
      throw forbidden("Controlled test accounts are disabled");
    }
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(accountKey)) {
      throw badRequest("Controlled test account key is invalid");
    }
    const at = this.now().toISOString();
    return transactState(this.store, (state) => {
      const account = this.upsertAccount(state, "CONTROLLED_TEST", accountKey, at);
      // Re-provisioning replaces credentials for this one test account only.
      for (const session of Object.values(state.sessionsByTokenHash)) {
        if (session.accountId !== account.accountId) continue;
        session.revokedAt ??= at;
        session.refreshRevokedAt ??= at;
      }
      return this.createAccountSession(state, account, at);
    });
  }

  async requestAppleChallenge(rateLimitKey = "unknown") {
    const provider = this.authProviders.apple ?? this.authProviders.appleIdentityTokenVerifier;
    if (!provider?.createChallenge) throw authenticationUnavailable("APPLE");
    this.enforceAuthRateLimit(`apple-challenge:${rateLimitKey}`);
    return provider.createChallenge();
  }

  async signInWithApple(input: AppleIdentityTokenVerificationRequest): Promise<AuthSessionResult> {
    const provider = this.authProviders.apple ?? this.authProviders.appleIdentityTokenVerifier;
    const verifyIdentityToken = provider?.verifyIdentityToken;
    if (!verifyIdentityToken) throw authenticationUnavailable("APPLE");
    const verificationInput = input;
    const identityToken = verificationInput.identityToken;
    if (typeof identityToken !== "string" || !identityToken.trim()
      || identityToken.length > 32 * 1024) {
      throw badRequest("identityToken is invalid");
    }
    const nonce = verificationInput.nonce;
    if (typeof nonce !== "string" || !nonce.trim() || nonce.length > 512) {
      throw badRequest("nonce is invalid");
    }
    const providerInput: AppleIdentityTokenVerificationRequest = {
      identityToken,
      nonce,
      ...(verificationInput.challengeId !== undefined ? { challengeId: verificationInput.challengeId } : {}),
      ...(verificationInput.authorizationCode !== undefined
        ? { authorizationCode: verificationInput.authorizationCode }
        : {})
    };

    let identity: Awaited<ReturnType<NonNullable<typeof verifyIdentityToken>>>;
    try {
      identity = await verifyIdentityToken.call(provider, providerInput);
    } catch (error) {
      if (error instanceof HttpProblem && error.status === 503) {
        throw new HttpProblem(503, "Authentication unavailable", "Apple authentication is temporarily unavailable");
      }
      // Invalid/expired/replayed tokens are intentionally indistinguishable.
      throw unauthorized("Apple identity token was rejected");
    }
    const subject = identity?.subject;
    if (typeof subject !== "string" || !subject.trim() || subject.length > 256
      || /[\u0000-\u001F\u007F]/.test(subject)) {
      throw unauthorized("Apple identity token was rejected");
    }
    const normalizedSubject = subject.trim();
    const now = this.now().toISOString();
    const session = await transactState(this.store, (state) => {
      this.removeExpiredAuthState(state, Date.parse(now));
      const account = this.upsertAccount(state, "APPLE", normalizedSubject, now);
      return this.createAccountSession(state, account, now);
    });
    // The code exchange happens AFTER the identity is verified and the session
    // exists, so a transient Apple failure cannot look like a bad credential.  A
    // failure here does fail the login: an account whose grant cannot be revoked
    // later is worse than a retryable sign-in error.
    const authorizationCode = verificationInput.authorizationCode;
    if (authorizationCode !== undefined && authorizationCode.trim()) {
      await this.attachAppleGrant(session.accountId, authorizationCode.trim(), undefined);
    }
    return session;
  }

  /** Alias mirroring Apple's platform naming. */
  async loginWithApple(
    input: AppleIdentityTokenVerificationRequest
  ): Promise<AuthSessionResult> {
    return this.signInWithApple(input);
  }

  /**
   * Rotates an opaque refresh token exactly once. Reuse of an already-rotated
   * token revokes the complete family, which fails closed if a token leaked.
   */
  async refreshAccountSession(refreshToken: string): Promise<AuthSessionResult> {
    if (typeof refreshToken !== "string" || !refreshToken.trim()
      || refreshToken.length > 512) {
      throw unauthorized("Refresh token was rejected");
    }
    const refreshHash = tokenHash(refreshToken);
    const outcome = await transactState(this.store, (state): AuthSessionResult | undefined => {
      const matching = Object.values(state.sessionsByTokenHash).find((session) =>
        session.sessionKind === "ACCOUNT" && session.refreshTokenHash === refreshHash
      );
      if (!matching || !matching.userId || !matching.accountId
        || !matching.refreshExpiresAt || !matching.refreshFamilyId) {
        throw unauthorized("Refresh token was rejected");
      }
      const now = this.now();
      const nowMilliseconds = now.getTime();
      if (Date.parse(matching.refreshExpiresAt) <= nowMilliseconds
        || matching.refreshRevokedAt) {
        throw unauthorized("Refresh token was rejected");
      }
      if (matching.refreshRotatedAt) {
        for (const session of Object.values(state.sessionsByTokenHash)) {
          if (session.refreshFamilyId === matching.refreshFamilyId) {
            session.refreshRevokedAt ??= now.toISOString();
            session.revokedAt ??= now.toISOString();
          }
        }
        // Return an outcome so the transaction commits family revocation before
        // the caller receives the rejection.
        return undefined;
      }
      const account = state.accounts[matching.accountId];
      const user = state.users[matching.userId];
      if (user?.lifecycleState === "CLOSED") throw unauthorized("Account is closed");
      if (!account || !user || account.userId !== user.userId) {
        throw new HttpProblem(500, "Authentication state invalid", "Account identity state is inconsistent");
      }
      if (account.provider === "CONTROLLED_TEST" && !this.config.enableControlledTestAccounts) {
        throw unauthorized("Controlled test accounts are disabled");
      }
      matching.refreshRotatedAt = now.toISOString();
      matching.revokedAt = now.toISOString();
      const rotated = this.createAccountSession(
        state,
        account,
        now.toISOString(),
        matching.refreshFamilyId!,
        matching.refreshExpiresAt!
      );
      return rotated;
    });
    if (!outcome) throw unauthorized("Refresh token reuse was detected");
    return outcome;
  }

  async refreshSession(refreshToken: string): Promise<AuthSessionResult> {
    return this.refreshAccountSession(refreshToken);
  }

  async refreshWatchSession(refreshToken: string): Promise<SessionBootstrapResult> {
    if (typeof refreshToken !== "string" || !refreshToken.trim()
      || refreshToken.length > 512) {
      throw unauthorized("Refresh token was rejected");
    }
    const refreshHash = tokenHash(refreshToken);
    const outcome = await transactState(this.store, (state): SessionBootstrapResult | undefined => {
      const matching = Object.values(state.sessionsByTokenHash).find((session) =>
        session.sessionKind === "DEVICE"
          && session.deviceKind === "WATCH"
          && session.refreshTokenHash === refreshHash
      );
      if (!matching || !matching.userId || !matching.accountId
        || !matching.deviceInstanceId || !matching.deviceKind
        || !matching.refreshExpiresAt || !matching.refreshFamilyId) {
        throw unauthorized("Refresh token was rejected");
      }
      const now = this.now();
      if (Date.parse(matching.refreshExpiresAt) <= now.getTime()
        || matching.refreshRevokedAt) {
        throw unauthorized("Refresh token was rejected");
      }
      if (matching.refreshRotatedAt) {
        for (const session of Object.values(state.sessionsByTokenHash)) {
          if (session.refreshFamilyId === matching.refreshFamilyId) {
            session.refreshRevokedAt ??= now.toISOString();
            session.revokedAt ??= now.toISOString();
          }
        }
        return undefined;
      }
      const device = state.devices[matching.deviceInstanceId];
      const account = state.accounts[matching.accountId];
      if (!account || account.userId !== matching.userId
        || (account.provider === "CONTROLLED_TEST" && !this.config.enableControlledTestAccounts)) {
        throw unauthorized("Refresh token was rejected");
      }
      if (!device
        || device.deviceKind !== "WATCH"
        || device.userId !== matching.userId
        || device.accountId !== matching.accountId
        || device.companionPairId === undefined
        || device.companionLinkRevokedAt) {
        throw unauthorized("Refresh token was rejected");
      }
      matching.refreshRotatedAt = now.toISOString();
      matching.revokedAt = now.toISOString();
      return this.createDeviceSession(
        state,
        matching.userId,
        matching.accountId,
        device.deviceInstanceId,
        "WATCH",
        device.companionPairId,
        now.toISOString(),
        true,
        matching.refreshFamilyId,
        matching.refreshExpiresAt
      );
    });
    if (!outcome) throw unauthorized("Refresh token reuse was detected");
    return outcome;
  }

  async refreshWatchDeviceSession(refreshToken: string): Promise<SessionBootstrapResult> {
    return this.refreshWatchSession(refreshToken);
  }

  /**
   * Issues a short-lived, single-use Watch-link credential from an authenticated
   * iPhone device session. The raw ticket exists only in this return value.
   */
  async createCompanionLinkTicket(
    principal: Principal,
    request: CompanionLinkTicketRequest | undefined = undefined
  ): Promise<CompanionLinkTicketResult> {
    const iPhone = requireIPhoneScope(principal, "events:read");
    const authenticatedUserId = iPhone.userId;
    const authenticatedAccountId = iPhone.accountId;
    if (!authenticatedUserId || !authenticatedAccountId) {
      throw forbidden("An authenticated user-bound iPhone session is required");
    }
    const requestedPairId = request?.companionPairId;
    const now = this.now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + COMPANION_LINK_TICKET_TTL_SECONDS * 1_000
    ).toISOString();
    const ticket = randomBytes(32).toString("base64url");
    const ticketHash = tokenHash(ticket);
    return transactState(this.store, (state) => {
      const device = state.devices[iPhone.deviceInstanceId];
      if (!device || device.deviceKind !== "IPHONE"
        || device.userId !== authenticatedUserId
        || device.accountId !== authenticatedAccountId) {
        throw forbidden("iPhone device session is no longer bound to its account");
      }
      if (!hasAllBootstrapAgreements(device)) {
        throw forbidden("Four current agreements are required before linking a Watch");
      }
      if (requestedPairId !== undefined && requestedPairId !== device.companionPairId) {
        throw conflict("companionPairId does not match the authenticated iPhone device");
      }
      this.removeExpiredAuthState(state, now.getTime());
      const record: CompanionLinkTicketRecord = {
        ticketHash,
        userId: authenticatedUserId,
        accountId: authenticatedAccountId,
        iPhoneDeviceId: device.deviceInstanceId,
        companionPairId: device.companionPairId,
        issuedAt,
        expiresAt
      };
      // One live ticket per iPhone.  A ticket is a credential that links a Watch to
      // this patient; leaving an older one valid would let a superseded or captured
      // ticket link a second Watch after the user thought they had replaced it.
      for (const prior of Object.values(state.companionLinkTicketsByHash)) {
        if (prior.iPhoneDeviceId !== device.deviceInstanceId) continue;
        if (prior.consumedAt || prior.revokedAt) continue;
        prior.revokedAt = issuedAt;
      }
      state.companionLinkTicketsByHash[ticketHash] = record;
      return {
        companionLinkTicket: ticket,
        companionPairId: device.companionPairId,
        expiresAt
      };
    });
  }

  async issueCompanionLinkTicket(
    principal: Principal,
    request: CompanionLinkTicketRequest | undefined = undefined
  ): Promise<CompanionLinkTicketResult> {
    return this.createCompanionLinkTicket(principal, request);
  }

  /**
   * Disconnects the Watch paired with this iPhone (G02 "解绑/换表").
   *
   * This is the explicit control the flow needs: a phone that was paired with a
   * Watch that is now lost, replaced or handed on must be able to cut it off.  It
   * revokes the companion link, every session of that Watch and any ticket still
   * outstanding, and it is scoped to the caller's own pair — one household cannot
   * disconnect another's hardware.
   */
  async unbindCompanionWatch(principal: Principal): Promise<{
    companionPairId: string;
    unbindId: string;
    revokedWatches: number;
    revokedSessions: number;
    revokedTickets: number;
  }> {
    const iPhone = requireIPhoneScope(principal, "events:read");
    const now = this.now();
    const unbindId = now.toISOString();
    return transactState(this.store, state => {
      const device = state.devices[iPhone.deviceInstanceId];
      if (!device || device.deviceKind !== "IPHONE"
        || device.userId !== iPhone.userId || device.accountId !== iPhone.accountId) {
        throw forbidden("iPhone device session is no longer bound to its account");
      }
      const pairId = device.companionPairId;
      let revokedWatches = 0;
      let revokedSessions = 0;
      let revokedTickets = 0;
      for (const watch of Object.values(state.devices)) {
        if (watch.deviceKind !== "WATCH" || watch.companionPairId !== pairId) continue;
        if (iPhone.userId && watch.userId && watch.userId !== iPhone.userId) continue;
        if (watch.companionLinkRevokedAt === undefined) revokedWatches += 1;
        watch.companionLinkRevokedAt ??= unbindId;
      }
      for (const session of Object.values(state.sessionsByTokenHash)) {
        if (session.deviceKind !== "WATCH") continue;
        const watch = session.deviceInstanceId
          ? state.devices[session.deviceInstanceId]
          : undefined;
        if (watch?.companionPairId !== pairId) continue;
        if (iPhone.userId && session.userId && session.userId !== iPhone.userId) continue;
        if (session.revokedAt === undefined) revokedSessions += 1;
        session.revokedAt ??= unbindId;
        if (session.refreshTokenHash) session.refreshRevokedAt ??= unbindId;
      }
      for (const ticket of Object.values(state.companionLinkTicketsByHash)) {
        if (ticket.companionPairId !== pairId) continue;
        if (iPhone.userId && ticket.userId && ticket.userId !== iPhone.userId) continue;
        if (ticket.consumedAt || ticket.revokedAt) continue;
        ticket.revokedAt = unbindId;
        revokedTickets += 1;
      }
      return { companionPairId: pairId, unbindId, revokedWatches, revokedSessions, revokedTickets };
    });
  }

  /**
   * Exchanges a ticket plus an injected Watch attestation for a Watch-scoped
   * device session. The ticket is consumed in the same transaction that binds
   * the Watch and creates its refresh family.
   */
  async redeemCompanionLinkTicket(
    request: WatchCompanionLinkRequest
  ): Promise<SessionBootstrapResult> {
    const verifier = this.authProviders.watchAttestation
      ?? this.authProviders.watchAttestationVerifier;
    const verifyAttestation = verifier?.verifyAttestation;
    if (!verifyAttestation) throw authenticationUnavailable("WATCH");
    const appId = this.config.watchAppAttestAppId;
    if (this.config.production && !appId) throw authenticationUnavailable("WATCH");

    const ticket = request.companionLinkTicket;
    const attestation = request.attestationObject;
    if (!ticket || !attestation) throw badRequest("Watch link ticket and attestation are required");
    const ticketHash = tokenHash(ticket);
    const now = this.now();
    const ticketRecord = readState(this.store, (state) => state.companionLinkTicketsByHash[ticketHash]);
    if (!ticketRecord
      || ticketRecord.consumedAt
      || ticketRecord.revokedAt
      || Date.parse(ticketRecord.expiresAt) <= now.getTime()
      || ticketRecord.companionPairId !== request.companionPairId) {
      throw unauthorized("Watch companion link credential was rejected");
    }
    const iPhone = readState(this.store, (state) => state.devices[ticketRecord.iPhoneDeviceId]);
    if (!iPhone
      || iPhone.deviceKind !== "IPHONE"
      || iPhone.userId !== ticketRecord.userId
      || iPhone.accountId !== ticketRecord.accountId
      || iPhone.companionPairId !== ticketRecord.companionPairId
      || !hasAllBootstrapAgreements(iPhone)) {
      throw unauthorized("Watch companion link credential was rejected");
    }

    const verifierInput: WatchAttestationVerificationRequest = {
      appAttestKeyId: request.appAttestKeyId,
      attestationObject: attestation,
      deviceInstanceId: request.deviceInstanceId,
      companionPairId: request.companionPairId,
      userId: ticketRecord.userId,
      accountId: ticketRecord.accountId,
      expectedChallenge: ticketHash,
      expectedClientDataHash: companionLinkClientDataHash({
        companionLinkTicketHash: ticketHash,
        deviceInstanceId: request.deviceInstanceId,
        companionPairId: request.companionPairId,
        userId: ticketRecord.userId,
        accountId: ticketRecord.accountId
      }),
      appId: appId ?? ""
    };
    let verification: Awaited<ReturnType<NonNullable<typeof verifyAttestation>>>;
    try {
      verification = await verifyAttestation.call(verifier, verifierInput);
    } catch {
      throw new HttpProblem(
        503,
        "Authentication provider unavailable",
        "Watch attestation could not be verified"
      );
    }
    if (!verification || verification.verified !== true
      || verification.deviceInstanceId !== request.deviceInstanceId) {
      throw unauthorized("Watch companion link credential was rejected");
    }

    return transactState(this.store, (state) => {
      const currentTicket = state.companionLinkTicketsByHash[ticketHash];
      const currentIPhone = state.devices[ticketRecord.iPhoneDeviceId];
      if (!currentTicket
        || currentTicket.consumedAt
        || currentTicket.revokedAt
        || Date.parse(currentTicket.expiresAt) <= this.now().getTime()
        || currentTicket.userId !== ticketRecord.userId
        || currentTicket.accountId !== ticketRecord.accountId
        || currentTicket.iPhoneDeviceId !== ticketRecord.iPhoneDeviceId
        || currentTicket.companionPairId !== request.companionPairId
        || !currentIPhone
        || currentIPhone.deviceKind !== "IPHONE"
        || currentIPhone.userId !== ticketRecord.userId
        || currentIPhone.accountId !== ticketRecord.accountId
        || currentIPhone.companionPairId !== ticketRecord.companionPairId
        || !hasAllBootstrapAgreements(currentIPhone)) {
        throw unauthorized("Watch companion link credential was rejected");
      }
      const existing = state.devices[request.deviceInstanceId];
      if (existing && (existing.deviceKind !== "WATCH"
        || existing.userId !== ticketRecord.userId
        || existing.accountId !== ticketRecord.accountId
        || existing.companionPairId !== ticketRecord.companionPairId)) {
        throw forbidden("Watch device is already bound to a different account or pair");
      }
      const issuedAt = this.now().toISOString();
      currentTicket.consumedAt = issuedAt;
      // Linking a Watch does NOT evict another Watch of the same pair: a household
      // may legitimately have two, and revoking hardware on an implicit rule would
      // break that.  Replacement is an EXPLICIT act — `unbindCompanionWatch` — so
      // the old Watch is only disconnected when someone says so.  What is revoked
      // here is the ticket, exactly once.
      state.devices[request.deviceInstanceId] = {
        deviceInstanceId: request.deviceInstanceId,
        deviceKind: "WATCH",
        userId: ticketRecord.userId,
        accountId: ticketRecord.accountId,
        companionPairId: ticketRecord.companionPairId,
        agreements: existing?.agreements ?? {},
        capabilities: existing?.capabilities
          ?? { notificationAuthorized: false, locationAuthorized: false },
        availableForResponse: false,
        presenceObservedAt: existing?.presenceObservedAt ?? issuedAt,
        ...(existing?.latestPosition ? { latestPosition: existing.latestPosition } : {}),
        ...(existing?.currentEventId ? { currentEventId: existing.currentEventId } : {}),
        ...(existing?.currentAssignmentId
          ? { currentAssignmentId: existing.currentAssignmentId }
          : {}),
        ...(existing?.lastPresenceUpdateId
          ? { lastPresenceUpdateId: existing.lastPresenceUpdateId }
          : {}),
        lastSeenAt: issuedAt,
        lastBootstrapAt: issuedAt
      };
      return this.createDeviceSession(
        state,
        ticketRecord.userId,
        ticketRecord.accountId,
        request.deviceInstanceId,
        "WATCH",
        ticketRecord.companionPairId,
        issuedAt,
        true
      );
    });
  }

  async exchangeCompanionLinkTicket(
    request: WatchCompanionLinkRequest
  ): Promise<SessionBootstrapResult> {
    return this.redeemCompanionLinkTicket(request);
  }

  async recoverLogout(principal: Principal, input: {
    priorToken: string; isAccount: boolean; requestedAt: string; deviceInstanceId?: string | undefined;
  }): Promise<void> {
    requireAccountScope(principal, ACCOUNT_SESSION_SCOPE);
    await this.identityAccess.recoverLogout(principal, input);
  }

  async logoutToken(rawToken: string): Promise<void> {
    await this.identityAccess.logoutToken(rawToken);
  }

  async logout(principal: Principal): Promise<void> {
    await this.identityAccess.logout(principal);
  }

  async revokeSession(principal: Principal): Promise<void> {
    await this.identityAccess.logout(principal, false);
  }

  /**
   * In-app account closure (the route name is kept for wire compatibility).
   *
   * Per the product decision of 2026-09-13 this is a LOGICAL closure, not a
   * physical erasure: `users.lifecycleState` becomes CLOSED with `closedAt`, every
   * session is revoked, and the existing information is kept under the retention
   * policy.  Already-formed event evidence is retained, and the returned record is
   * the audit basis for the closure.
   */
  async deleteAccountToken(rawToken: string) {
    return this.identityAccess.requestAccountDeletionToken(rawToken);
  }

  async deleteAccount(principal: Principal): Promise<{
    requestId: string;
    status: "REQUESTED" | "CLOSED";
    requestedAt: string;
    erasureStartedAt: string;
  }> {
    return this.identityAccess.requestAccountDeletion(principal);
  }

  async bootstrap(
    principal: Principal,
    request: SessionBootstrapRequest,
    rateLimitKey: string
  ): Promise<SessionBootstrapResult>;
  /**
   * Compatibility overload for existing in-process domain tests. HTTP callers
   * always use the authenticated overload; this path never exists at the
   * server boundary and does not create an account identity.
   */
  async bootstrap(
    request: ServiceBootstrapRequest,
    rateLimitKey: string
  ): Promise<SessionBootstrapResult>;
  async bootstrap(
    principalOrRequest: Principal | ServiceBootstrapRequest,
    requestOrRateLimitKey: ServiceBootstrapRequest | string,
    maybeRateLimitKey?: string
  ): Promise<SessionBootstrapResult> {
    const legacyDirectCall = "deviceKind" in principalOrRequest;
    const principal = legacyDirectCall ? undefined : principalOrRequest as Principal;
    const request = (legacyDirectCall ? principalOrRequest : requestOrRateLimitKey) as ServiceBootstrapRequest;
    const rateLimitKey = legacyDirectCall
      ? requestOrRateLimitKey as string
      : maybeRateLimitKey ?? "unknown";
    if (principal) requireAccountScope(principal, ACCOUNT_SESSION_SCOPE);
    if (principal && request.deviceKind === "WATCH") {
      throw forbidden("Watch bootstrap requires a companionLinkTicket and attestation");
    }
    this.enforceBootstrapRateLimit(rateLimitKey);
    const now = this.now();
    const occurredAt = now.toISOString();
    const pairId = request.companionPairId;

    if (request.deviceKind === "IPHONE") {
      const agreements = request.agreementAcceptances;
      const byKind = new Map(agreements.map((agreement) => [agreement.kind, agreement]));
      const requiredAgreementKinds = [
        "PATIENT",
        "VOLUNTEER_RESPONDER",
        "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"
      ] as const;
      if (byKind.size !== requiredAgreementKinds.length
        || requiredAgreementKinds.some((kind) => byKind.get(kind)?.version !== "2.0")
      ) {
        throw badRequest(
          "iPhone bootstrap requires separate PATIENT and VOLUNTEER_RESPONDER, "
          + "PRIVACY_POLICY, and SENSITIVE_PERSONAL_INFORMATION v2 agreements"
        );
      }
    }

    const rawToken = randomBytes(32).toString("base64url");
    const hashedToken = tokenHash(rawToken);
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlSeconds * 1_000).toISOString();
    const sessionId = randomUUID();
    const scopes = request.deviceKind === "WATCH"
      ? ["watch:report", "watch:fallback"]
      : [
        "events:read",
        "events:write",
        "responses:write",
        "position:write",
        "assignments:write"
      ];
    const accountIdentity = principal?.kind === "ACCOUNT"
      ? { userId: principal.userId, accountId: principal.accountId }
      : legacyDirectCall
        ? {
          // Direct overloads are test/migration-only; give their sessions a
          // deterministic synthetic identity so anonymous persisted tokens
          // cannot pass the public authenticateToken boundary.
          userId: `direct-test-user:${pairId}`,
          accountId: `direct-test-account:${pairId}`
        }
        : undefined;

    await transactState(this.store, (state) => {
      if (request.deviceKind === "WATCH") {
        const pairOwners = stateRows(state, "devices", "companionPairId", pairId).filter((device) =>
          device.deviceKind === "IPHONE" && device.companionPairId === pairId
        );
        if (accountIdentity && pairOwners.some((device) =>
          (device.userId !== undefined && device.userId !== accountIdentity.userId)
            || (device.accountId !== undefined && device.accountId !== accountIdentity.accountId)
        )) {
          throw forbidden("Watch companionPairId belongs to a different authenticated account");
        }
        const pairExists = pairOwners.length > 0;
        if (!pairExists) {
          throw forbidden("Watch companionPairId is not associated with an initialized iPhone");
        }
      } else {
        const pairOwner = stateRows(state, "devices", "companionPairId", pairId).find((device) => device.deviceKind === "IPHONE"
          && device.companionPairId === pairId
          && device.deviceInstanceId !== request.deviceInstanceId);
        if (pairOwner) {
          throw conflict("companionPairId is already bound to another iPhone device");
        }
      }

      const existing = state.devices[request.deviceInstanceId];
      if (existing && (existing.deviceKind !== request.deviceKind
        || existing.companionPairId !== pairId)) {
        throw conflict("deviceInstanceId is already bound to a different device kind or pair");
      }
      if (existing && accountIdentity
        && ((existing.userId !== undefined && existing.userId !== accountIdentity.userId)
          || (existing.accountId !== undefined && existing.accountId !== accountIdentity.accountId))) {
        throw new HttpProblem(403, "Forbidden",
          "deviceInstanceId is already bound to a different authenticated account",
          "https://aedresponse.invalid/problems/device-account-binding-conflict");
      }

      const agreements: DeviceRecord["agreements"] = existing?.agreements ?? {};
      for (const agreement of request.deviceKind === "IPHONE"
        ? request.agreementAcceptances
        : []) {
        agreements[agreement.kind] = {
          version: agreement.version,
          acceptedAt: agreement.acceptedAt
        };
      }
      state.devices[request.deviceInstanceId] = {
        deviceInstanceId: request.deviceInstanceId,
        deviceKind: request.deviceKind,
        ...(accountIdentity
          ? accountIdentity
          : existing?.userId
            ? { userId: existing.userId, ...(existing.accountId ? { accountId: existing.accountId } : {}) }
            : {}),
        companionPairId: pairId,
        agreements,
        capabilities: request.deviceKind === "IPHONE"
          ? existing?.capabilities ?? request.capabilities
          : { notificationAuthorized: false, locationAuthorized: false },
        availableForResponse: request.deviceKind === "IPHONE"
          ? existing?.availableForResponse ?? request.availableForResponse
          : false,
        presenceObservedAt: existing?.presenceObservedAt ?? occurredAt,
        ...(existing?.latestPosition ? { latestPosition: existing.latestPosition } : {}),
        ...(existing?.currentEventId ? { currentEventId: existing.currentEventId } : {}),
        ...(existing?.currentAssignmentId
          ? { currentAssignmentId: existing.currentAssignmentId }
          : {}),
        ...(existing?.lastPresenceUpdateId
          ? { lastPresenceUpdateId: existing.lastPresenceUpdateId }
          : {}),
        lastSeenAt: occurredAt,
        lastBootstrapAt: occurredAt
      };

      if (request.deviceKind === "IPHONE") {
        for (const event of stateRows(state, "events", "state", "ACTIVE")) {
          const samePatientUser = accountIdentity !== undefined
            && event.patientUserId === accountIdentity.userId;
          if (event.patientPairId !== pairId && !samePatientUser) continue;
          // Only the triggering pair's iPhone devices are authorized P sources.
          // Other devices for the same stable user receive the patient view but
          // must not compete to write this event's primary position.
          if (event.patientPairId === pairId
            && !event.patientDeviceIds.includes(request.deviceInstanceId)) {
            event.patientDeviceIds.push(request.deviceInstanceId);
          }
          if (event.state !== "ACTIVE") continue;
          const device = state.devices[request.deviceInstanceId]!;
          device.currentEventId = event.id;
          delete device.currentAssignmentId;
          if (device.latestPosition?.position.kind === "R") delete device.latestPosition;
        }
      }

      const record: SessionRecord = {
        sessionId,
        tokenHash: hashedToken,
        sessionKind: "DEVICE",
        ...(accountIdentity ?? {}),
        deviceInstanceId: request.deviceInstanceId,
        deviceKind: request.deviceKind,
        scopes,
        issuedAt: occurredAt,
        expiresAt
      };
      state.sessionsByTokenHash[hashedToken] = record;
      this.removeExpiredAuthState(state, now.getTime());
    });

    return {
      sessionId,
      sessionToken: rawToken,
      expiresAt,
      scopes,
      ...(accountIdentity ?? {})
    };
  }

  authenticateToken(rawToken: string): Principal {
    return this.identityAccess.authenticateToken(rawToken);
  }

  /** Management-only method; intentionally has no HTTP route or production caller. */
  async createSimulatedEvent(input: unknown) {
    if (!this.config.enableSimulatedEvents) {
      throw forbidden("Simulation is disabled");
    }
    const simulation = simulationObservationSchema.parse(input);
    const now = this.now();
    const result = await transactState(this.store, state => {
      const eventId = simulation.runId;
      const existing = state.events[eventId];
      if (existing) {
        if (fingerprint(existing.observation) !== fingerprint(simulation)) {
          throw badRequest("Simulation run ID is already used");
        }
        return { eventId, simulated: true, replayed: true };
      }
      if (Math.abs(Date.parse(simulation.requestedAt) - now.getTime()) > 30_000) {
        throw badRequest("Simulation request must be fresh");
      }
      if (stateRows(state, "events", "state", "ACTIVE").some(event => event.state === "ACTIVE")) {
        throw badRequest("Finish existing events before starting a simulation");
      }
      const patient = state.devices[simulation.patientDeviceId];
      const responder = state.devices[simulation.responderDeviceId];
      for (const [device, userId] of [
        [patient, simulation.patientUserId], [responder, simulation.responderUserId]
      ] as const) {
        if (!device || device.deviceKind !== "IPHONE" || device.userId !== userId
          || !device.accountId || !(
            (this.config.enableControlledTestAccounts && state.accounts[device.accountId]?.provider === "CONTROLLED_TEST")
            || (state.accounts[device.accountId]?.provider === "APPLE"
              && this.config.simulationAppleDeviceIds?.length === 2
              && this.config.simulationAppleDeviceIds.includes(device.deviceInstanceId)))
          || !this.isEligibleResponderDeviceBase(this.recruitmentContext(state), device, now)) {
          throw forbidden("Both devices must be ready, independent explicitly enrolled test users");
        }
      }
      const location = patient!.latestPosition!;
      const createdAt = now.toISOString();
      const event: EventRecord = {
        id: eventId, observation: simulation, observationFingerprint: fingerprint(simulation),
        patientPairId: patient!.companionPairId, patientUserId: simulation.patientUserId,
        patientDeviceIds: [simulation.patientDeviceId], triggerSource: "SIMULATED_TEST",
        patientPosition: {
          positionUpdateId: location.positionUpdateId, source: "IPHONE_PRIMARY",
          position: { ...location.position, kind: "P" }, observedAt: location.observedAt,
          serverReceivedAt: location.serverReceivedAt
        },
        state: "ACTIVE", recruitmentState: "RECRUITING", currentRecruitmentRadiusMeters: 1000,
        recruitmentStageStartedAt: null, statusConfirmationCycleStartedAt: createdAt,
        statusConfirmationHistory: [], exitedResponderUserIds: [], createdAt,
        coordinationRevision: 1, assignmentRevision: 0, unavailableAedIds: []
      };
      state.events[eventId] = event;
      patient!.currentEventId = eventId;
      delete patient!.currentAssignmentId;
      delete patient!.latestPosition;
      appendTimeline(state, eventId, createdAt, "EVENT_ACTIVATED",
        "SIMULATED_TEST: administrative test input; no Fall, SOS, or App Attest observation.");
      this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, now);
      enqueueNotification(state, simulation.patientDeviceId, "event:patient-activated", {
        ...this.envelope(`patient-activated:${eventId}`, eventId, createdAt),
        state: "ACTIVE",
        recruitmentState: "RECRUITING"
      });
      return { eventId, simulated: true, replayed: false };
    });
    if (!result.replayed) {
      await this.notificationOutbox.drain();
    }
    return result;
  }

  async reportWatchObservation(
    principal: Principal,
    pathEventId: string,
    observation: WatchEmergencyObservation
  ): Promise<{ created: boolean; event: EmergencyEventView }> {
    const watch = requireWatchScope(principal, "watch:report");
    if (pathEventId !== observation.eventId) {
      throw badRequest("path eventId must match observation.eventId");
    }
    if (observation.appHelpResponse !== "NEEDS_HELP"
      && observation.appHelpResponse !== "NO_RESPONSE") {
      throw badRequest("A valid appHelpResponse is required");
    }
    const rawObservation = observation as unknown as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rawObservation, "emergencyCallObserved")) {
      throw badRequest("emergencyCallObserved is no longer accepted");
    }
    if (observation.appHelpResponse === "NEEDS_HELP"
      && (observation.callFirstObservedAt !== undefined
        || observation.callObservationSemantics !== undefined)) {
      throw badRequest("Outgoing-call fields are only valid for NO_RESPONSE");
    }
    if (observation.appHelpResponse === "NO_RESPONSE"
      && (!observation.callFirstObservedAt || !observation.callObservationSemantics)) {
      throw badRequest("NO_RESPONSE requires an outgoing-call observation");
    }
    const now = this.now();
    const nowMilliseconds = now.getTime();
    const fallDetectedAtMilliseconds = Date.parse(observation.fallDetectedAt);
    if (!Number.isFinite(fallDetectedAtMilliseconds)
      || fallDetectedAtMilliseconds > nowMilliseconds
        + this.config.maxClientClockSkewSeconds * 1_000) {
      throw badRequest("fallDetectedAt is outside the allowed clock boundary");
    }
    if (observation.callFirstObservedAt !== undefined) {
      const callFirstObservedAtMilliseconds = Date.parse(observation.callFirstObservedAt);
      if (!Number.isFinite(callFirstObservedAtMilliseconds)
        || callFirstObservedAtMilliseconds > nowMilliseconds
          + this.config.maxClientClockSkewSeconds * 1_000) {
        throw badRequest("callFirstObservedAt is outside the allowed clock boundary");
      }
      if (callFirstObservedAtMilliseconds - fallDetectedAtMilliseconds < 0
        || callFirstObservedAtMilliseconds - fallDetectedAtMilliseconds > 120 * 1_000) {
        throw badRequest("callFirstObservedAt must be within 120 seconds of fallDetectedAt");
      }
    }
    const eventCutoffMilliseconds = fallDetectedAtMilliseconds + 35 * 60_000;
    if (observation.patientPositionObservedAt !== undefined && !observation.patientPosition) {
      throw badRequest("A fix timestamp requires patientPosition");
    }
    const fixObservedAt = observation.patientPositionObservedAt === undefined ? undefined
      : this.validateClientTime(observation.patientPositionObservedAt, "patientPositionObservedAt");
    const observationFingerprint = fingerprint(observation);
    const occurredAt = now.toISOString();

    const result = await createWatchEvent(this.store, {
      watch, pathEventId, observation, observationFingerprint, occurredAt,
      nowMilliseconds, eventCutoffMilliseconds, fixObservedAt,
      initialRadiusMeters: RECRUITMENT_RADIUS_STAGES_METERS[0]
    }, {
      project: (state, event) => eventProjection(state, event, watch,
        this.coordinationSummary(this.eventCreationRecruitmentContext(state), legacyCoordinationAedReader(state), event, this.now()), false, this.now()),
      patientViewers: (state, event) =>
        patientViewerDeviceIds(this.eventCreationRecruitmentContext(state), event),
      enforcePatientPriority: (state, user, devices, eventId, at) => {
        this.enforcePatientPriority(state, user, devices, eventId, at);
      },
      recruit: (state, event, at) =>
        this.refreshRecruitmentForEvent(this.eventCreationRecruitmentContext(state), event, at).event,
      enqueueCoordination: (state, event, at) => this.enqueueCoordinationNotifications(
        this.eventCreationRecruitmentContext(state), event,
        coordinationAudienceDeviceIds(this.eventCreationRecruitmentContext(state), event),
        this.coordinationSummary(this.eventCreationRecruitmentContext(state), legacyCoordinationAedReader(state), event, this.now()), at)
    });
    if (result.created) await this.notificationOutbox.drain();
    return result;
  }

  /**
   * A person reports the patient they just found (an additional event trigger).
   *
   * The report creates the same kind of case a Watch trigger creates, so every
   * downstream path — recruitment, assignment, AED tasks, notifications, retention —
   * is the existing one.  What differs is only where the case came from: a human
   * observation instead of a fall signal, which is why the stored observation
   * carries a position and a time and no fall verdict at all.
   */
  async reportFoundPatient(principal: Principal, input: {
    eventId: string;
    patientPosition: PatientPosition;
    observedAt: string;
  }): Promise<{ created: boolean; event: EmergencyEventView }> {
    const iPhone = requireIPhoneScope(principal, "events:write");
    const observedAt = this.validateClientTime(input.observedAt, "observedAt");
    const result = await createUserReportedEvent(this.store, {
      reporter: iPhone,
      pathEventId: input.eventId,
      patientPosition: input.patientPosition,
      reportedAt: observedAt,
      initialRadiusMeters: RECRUITMENT_RADIUS_STAGES_METERS[0]
    }, {
      hasCurrentAgreements: hasAllBootstrapAgreements,
      project: (state, event) => eventProjection(state, event, iPhone,
        this.coordinationSummary(this.eventCreationRecruitmentContext(state),
          legacyCoordinationAedReader(state), event, this.now()), false, this.now()),
      patientViewers: (state, event) =>
        patientViewerDeviceIds(this.eventCreationRecruitmentContext(state), event),
      enforcePatientPriority: (state, user, devices, eventId, at) => {
        this.enforcePatientPriority(state, user, devices, eventId, at);
      },
      recruit: (state, event, at) =>
        this.refreshRecruitmentForEvent(this.eventCreationRecruitmentContext(state), event, at).event,
      enqueueCoordination: (state, event, at) => this.enqueueCoordinationNotifications(
        this.eventCreationRecruitmentContext(state), event,
        coordinationAudienceDeviceIds(this.eventCreationRecruitmentContext(state), event),
        this.coordinationSummary(this.eventCreationRecruitmentContext(state),
          legacyCoordinationAedReader(state), event, this.now()), at)
    });
    if (result.created) {
      operationMetrics.userReportedEvents += 1;
      await this.notificationOutbox.drain();
    }
    return result;
  }

  getWatchEventState(principal: Principal, eventId: string) {
    return readWatchEventState(this.store, principal, eventId, this.now());
  }

  async updateWatchFallbackPatientPosition(
    principal: Principal,
    pathEventId: string,
    pathPositionUpdateId: string,
    update: WatchFallbackPositionUpdate
  ): Promise<PositionUpdateResult> {
    const watch = requireWatchScope(principal, "watch:fallback");
    this.enforcePositionWriteCircuit(watch.deviceInstanceId);
    if (pathEventId !== update.eventId
      || pathPositionUpdateId !== update.positionUpdateId) {
      throw badRequest("path eventId/positionUpdateId must match the fallback position body");
    }
    if (!update.networkAvailable) {
      throw forbidden("Watch network is required for fallback position");
    }
    const observedAt = this.validateClientTime(update.observedAt, "observedAt");
    const normalized = { ...update, observedAt };
    const updateFingerprint = fingerprint({
      deviceInstanceId: watch.deviceInstanceId,
      source: "WATCH_FALLBACK",
      ...normalized
    });
    const receivedAt = this.now().toISOString();
    const result = await transactState(this.store, (state) => {
      let event = state.events[pathEventId];
      if (!event) throw notFound("Event does not exist");
      requireTriggeringWatch(state, event, watch);
      this.markDeviceSeen(state, watch.deviceInstanceId, receivedAt);

      const replay = this.positionReplay(
        state,
        pathPositionUpdateId,
        watch.deviceInstanceId,
        pathEventId,
        "P",
        updateFingerprint
      );
      if (replay) {
        // The verified fingerprint binds a previously accepted legacy receipt to this exact received body.
        state.positionUpdateReceiptsById[pathPositionUpdateId]!.watchFallbackFact ??= structuredClone(normalized);
        const candidate = event.watchFallbackCandidate;
        if (event.state === "ACTIVE" && candidate?.positionUpdateId === pathPositionUpdateId
          && this.patientPositionSampleIsFresh(candidate.position, candidate.observedAt, this.now())
          && (!event.iphonePatientPosition || candidate.observedAt > event.iphonePatientPosition.observedAt)
          && this.watchFallbackSilenceElapsed(event, this.now())) {
          const promotion = this.promoteWatchFallbackCandidate(
            state,
            event,
            candidate,
            receivedAt
          );
          const promoted = this.positionResult(
            pathPositionUpdateId,
            true,
            false,
            false,
            promotion.observedAt,
            promotion.serverReceivedAt
          );
          const receipt = state.positionUpdateReceiptsById[pathPositionUpdateId];
          if (receipt) receipt.result = promoted;
          const assignmentEmissions = this.refreshPatientRoutes(state, event, this.now());
          const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, this.now(), true);
          event = refreshed.event;
          const update = this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
            refreshed.requests,
            refreshed.previousAudience,
            refreshed.expiredOffers
          );
          this.enqueuePatientPositionNotification(
            state,
            event,
            update.audience,
            update.coordination.revision,
            receivedAt
          );
          return {
            position: promoted,
            update,
            assignmentEmissions
          };
        }
        return {
          position: replay,
          update: undefined as RecruitmentUpdate | undefined,
          assignmentEmissions: [] as AssignmentEmission[]
        };
      }
      if (event.state !== "ACTIVE") {
        const windowStart = Date.parse(event.createdAt);
        const windowEnd = Date.parse(event.resolvedAt ?? "");
        if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd < windowStart
          || Date.parse(observedAt) < windowStart || Date.parse(observedAt) >= windowEnd) {
          throw conflict("Watch fallback history must be inside the event active time window");
        }
        const position = this.positionResult(pathPositionUpdateId, false, false, true, observedAt, receivedAt);
        this.recordPositionReceipt(state, pathPositionUpdateId, watch.deviceInstanceId, pathEventId,
          "P", updateFingerprint, receivedAt, position, normalized);
        return { position, update: undefined as RecruitmentUpdate | undefined,
          assignmentEmissions: [] as AssignmentEmission[] };
      }

      if (normalized.activationState === "ACTIVATED" && normalized.iphoneReachable
        && !watchFallbackAllowedByServer(event, this.now())) {
        throw new HttpProblem(403, "Fallback admission changed",
          "Fallback position requires the iPhone to be unreachable or server-confirmed position silence",
          "https://aedresponse.invalid/problems/fallback-admission-changed");
      }
      const current = event.watchFallbackPosition;
      const candidate = event.watchFallbackCandidate;
      let position: PositionUpdateResult;
      let applied = false;
      if (!this.patientPositionSampleIsFresh(normalized.patientPosition, observedAt, this.now())) {
        position = this.positionResult(
          pathPositionUpdateId,
          false,
          false,
          true,
          observedAt,
          receivedAt
        );
      } else if (event.iphonePatientPosition
        && observedAt <= event.iphonePatientPosition.observedAt) {
        // Even after the 10-second server-side silence window, a queued Watch
        // sample captured no later than the last iPhone fix cannot displace it.
        position = this.positionResult(
          pathPositionUpdateId,
          false,
          false,
          true,
          observedAt,
          receivedAt
        );
      } else if (candidate && observedAt < candidate.observedAt) {
        position = this.positionResult(
          pathPositionUpdateId,
          false,
          false,
          true,
          observedAt,
          receivedAt
        );
      } else if (candidate && observedAt === candidate.observedAt) {
        if (fingerprint(candidate.position) !== fingerprint(normalized.patientPosition)) {
          throw conflict("Watch fallback conflicts at the same observedAt timestamp");
        }
        position = this.positionResult(
          pathPositionUpdateId,
          false,
          true,
          false,
          observedAt,
          candidate.serverReceivedAt
        );
      } else if (current && observedAt < current.observedAt) {
        position = this.positionResult(
          pathPositionUpdateId,
          false,
          false,
          true,
          observedAt,
          receivedAt
        );
      } else if (current && observedAt === current.observedAt) {
        if (fingerprint(current.position) !== fingerprint(normalized.patientPosition)) {
          throw conflict("Watch fallback position conflicts at the same observedAt timestamp");
        }
        position = this.positionResult(
          pathPositionUpdateId,
          false,
          true,
          false,
          observedAt,
          current.serverReceivedAt
        );
      } else {
        const sample = {
          positionUpdateId: pathPositionUpdateId,
          source: "WATCH_FALLBACK" as const,
          position: normalized.patientPosition,
          observedAt,
          serverReceivedAt: receivedAt
        };
        if (this.watchFallbackSilenceElapsed(event, this.now())) {
          event.watchFallbackPosition = sample;
          event.patientPosition = sample;
          delete event.watchFallbackCandidate;
          appendTimeline(
            state,
            pathEventId,
            receivedAt,
            "PATIENT_POSITION_UPDATED",
            `Watch fallback position ${pathPositionUpdateId} became the effective P sample.`
          );
          position = this.positionResult(
            pathPositionUpdateId,
            true,
            false,
            false,
            observedAt,
            receivedAt
          );
          applied = true;
        } else {
          event.watchFallbackCandidate = {
            positionUpdateId: pathPositionUpdateId,
            position: normalized.patientPosition,
            observedAt,
            serverReceivedAt: receivedAt
          };
          position = this.positionResult(
            pathPositionUpdateId,
            false,
            false,
            false,
            observedAt,
            receivedAt
          );
        }
      }
      if (!position.ignoredAsStale && !position.idempotent) {
        this.recordWatchFallbackCadence(
          event,
          normalized.patientPosition,
          pathPositionUpdateId,
          observedAt,
          receivedAt
        );
      }
      this.recordPositionReceipt(
        state,
        pathPositionUpdateId,
        watch.deviceInstanceId,
        pathEventId,
        "P",
        updateFingerprint,
        receivedAt,
        position,
        normalized
      );
      if (!applied) {
        return {
          position,
          update: undefined as RecruitmentUpdate | undefined,
          assignmentEmissions: [] as AssignmentEmission[]
        };
      }
      const assignmentEmissions = this.refreshPatientRoutes(state, event, this.now());
      const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, this.now(), true);
      event = refreshed.event;
      const update = this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
        refreshed.requests,
        refreshed.previousAudience,
        refreshed.expiredOffers
      );
      this.enqueuePatientPositionNotification(
        state,
        event,
        update.audience,
        update.coordination.revision,
        receivedAt
      );
      return {
        position,
        update,
        assignmentEmissions
      };
    });
    await this.publishPatientPositionChange(
      pathEventId,
      receivedAt,
      result.update
    );
    return result.position;
  }

  /**
   * Durable scheduler hook for offer expiry and ring expansion. Deployments may
   * call this from a persistent job; the reference service does not rely on a
   * process-local timer for recruitment correctness.
   */
  private eventRoutesPrepared(state: PersistentState, event: EventRecord, at: Date): boolean {
    const sample = currentPatientPositionSample(event);
    const patient = sample?.position;
    if (!patient || !sample || !this.patientPositionSampleIsFresh(patient, sample.observedAt, at)
      || !this.routeProvider.isPrepared) return false;
    return acceptedDeviceIds(this.recruitmentContext(state), event.id).every(id => {
      const device = state.devices[id];
      const responder = currentResponderPosition(device);
      if (!responder || !device?.latestPosition
        || !this.responderPositionSampleIsFresh(responder, device.latestPosition.observedAt, at)) return false;
      return this.routeProvider.isPrepared!({ responder, patient, aeds: routingAeds(state, this.now(), event.id),
        unavailableAedIds: new Set(event.unavailableAedIds), at });
    });
  }

  private async prepareEventRoutes(eventId?: string, extraDeviceId?: string): Promise<void> {
    if (!this.routeProvider.prepare) return;
    const inputs = readState(this.store, state => stateRows(state, "events", "state", "ACTIVE")
      .filter(event => event.state === "ACTIVE" && (!eventId || event.id === eventId))
      .flatMap(event => {
        const sample = currentPatientPositionSample(event);
        const patient = sample?.position;
        if (!patient || !sample || !this.patientPositionSampleIsFresh(patient, sample.observedAt, this.now())) return [];
        const ids = new Set([...acceptedDeviceIds(this.recruitmentContext(state), event.id), ...(extraDeviceId ? [extraDeviceId] : [])]);
        return [...ids].flatMap(id => {
          const device = state.devices[id];
          const responder = currentResponderPosition(device);
          return responder && device?.latestPosition
            && this.responderPositionSampleIsFresh(responder, device.latestPosition.observedAt, this.now()) ? [{ responder, patient, aeds: routingAeds(state, this.now(), event.id),
            unavailableAedIds: new Set(event.unavailableAedIds), at: this.now() }] : [];
        });
      }));
    await Promise.all(inputs.map(input => this.routeProvider.prepare!(input)));
  }

  async tick(): Promise<void> {
    // Reclaim due standby positions before the scheduler work: the index makes
    // this proportional to the number of expired devices, not to fleet size.
    await this.pruneExpiredPositions(this.now());
    // Retention is a scheduled promise, not an on-demand one: the 30-day seal and
    // the 3-year purge have to happen whether or not anyone asks.  It runs before
    // the recruitment draft because it only touches terminal events, so it can
    // never delay an active response.  A failure is reported and retried on the
    // next tick rather than silently skipped.
    try {
      this.recordRetentionSweep(await this.sweepRetention(this.now()));
    } catch (error) {
      operationMetrics.retentionSweepFailures += 1;
      console.error("Retention sweep failed",
        error instanceof Error ? error.message : "unknown error");
    }
    // The identity ledger is deliberately NOT reconciled here.  Every closure and
    // revocation path fires the revocation listener, which writes the ledger in
    // the background, and shutdown waits for it; re-deriving the ledger on every
    // tick would put a whole-collection pass back on the hot path that G13-A
    // removed, which is exactly the cost this design exists to avoid.
    // Security logs expire at six months.  Indexed by deadline, so the tick pays
    // one query rather than a scan of the log.
    try {
      await this.sweepSecurityLog();
    } catch (error) {
      console.error("Security log sweep failed",
        error instanceof Error ? error.message : "unknown error");
    }
    // Self-service access grants are time-boxed to 24 hours, so their expiry is
    // also scheduled: a grant must lapse on time even if nobody reads it.
    try {
      await this.sweepSelfAccessGrants();
    } catch (error) {
      console.error("Self-access grant sweep failed",
        error instanceof Error ? error.message : "unknown error");
    }
    // Retire reroute proposals whose 15-second window has closed, so a proposal
    // can never be accepted minutes later against a stale snapshot.
    try {
      await this.expireAedReroutes(this.now());
    } catch (error) {
      console.error("Reroute expiry sweep failed",
        error instanceof Error ? error.message : "unknown error");
    }
    // Apple token revocation is also a scheduled promise: the deletion request is
    // already accepted, so a failed revocation must be retried rather than lost.
    if (this.appleAccount.isConfigured()) {
      try {
        await this.revokePendingAppleTokens();
      } catch (error) {
        console.error("Apple token revocation sweep failed",
          error instanceof Error ? error.message : "unknown error");
      }
    }
    // Warm derived quotes outside the transaction without delaying expiry/scheduler work.
    void this.prepareEventRoutes().catch(() => {});
    const now = this.now();
    const result = await transactState(this.store, (state) => {
      if (!this.store.positionExpiry?.()) this.pruneExpiredCurrentPositions(state, now);
      const updates: RecruitmentUpdate[] = [];
      const statusConfirmations: StatusConfirmationEmission[] = [];
      // Advance active events in one atomic draft. Each event queries its own grid;
      // terminal history is absent from this scheduling relation.
      if (stateAccess(state) && this.store.devicePositions?.()) operationMetrics.indexedRecruitmentRuns += 1;
      else operationMetrics.legacyRecruitmentRuns += 1;
      for (const event of stateRows(state, "events", "state", "ACTIVE")) {
        const status = advanceStatusConfirmation(
          {
            coordinationAudienceDeviceIds: (state, event) =>
              coordinationAudienceDeviceIds(recruitmentContextFor(state), event),
            affectedDeviceIds,
            patientViewerDeviceIds: (state, event) =>
              patientViewerDeviceIds(recruitmentContextFor(state), event),
            recruitmentUpdate: (nextState, nextEvent, requests, extraAudience, expiredOffers) =>
              this.recruitmentUpdate(recruitmentContextFor(nextState),
                legacyCoordinationAedReader(nextState), nextEvent, requests, extraAudience,
                expiredOffers),
            enqueueTerminalNotifications: (nextState, nextEvent, messageId, devices, update) =>
              this.enqueueTerminalNotifications(nextState, nextEvent, messageId, devices, update),
            enqueueRequestedNotification: (nextState, nextEvent, confirmation, occurredAt) => {
              for (const deviceId of patientViewerDeviceIds(recruitmentContextFor(nextState), nextEvent)) {
                enqueueNotification(nextState, deviceId, "event:status-confirmation-requested", {
                  ...this.envelope(
                    `status-confirmation-requested:${confirmation.confirmationId}`,
                    nextEvent.id,
                    occurredAt
                  ),
                  confirmationId: confirmation.confirmationId,
                  prompt: "STILL_IN_PROGRESS",
                  responseDeadlineAt: confirmation.responseDeadlineAt
                });
              }
            }
          },
          state,
          event,
          now
        );
        if (status.emission) statusConfirmations.push(status.emission);
        if (status.update) updates.push(status.update);

        if (this.routeProvider.prepare && event.state === "ACTIVE" && currentPatientPosition(event)
          && acceptedDeviceIds(this.recruitmentContext(state), event.id).length > 0 && this.eventRoutesPrepared(state, event, now)) {
          const assignments = this.replanAssignments(state, event, now);
          if (assignments.length) {
            this.enqueueAssignmentEmissions(state, event, assignments);
            event.coordinationRevision += 1;
            updates.push(this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, []));
          }
        }
        const recruitment = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, now);
        if (!recruitment.changed) continue;
        updates.push(this.recruitmentUpdate(
          this.recruitmentContext(state), legacyCoordinationAedReader(state), recruitment.event,
          recruitment.requests,
          recruitment.previousAudience,
          recruitment.expiredOffers
        ));
      }
      return { updates, statusConfirmations };
    });
    await this.notificationOutbox.drain();
    this.publishRecruitmentUpdates(result.updates, now.toISOString());
  }

  private publishStatusConfirmationEmissions(
    emissions: readonly StatusConfirmationEmission[]
  ): void {
    void emissions;
  }

  replayPendingResponses(principal: Principal): void {
    if (principal.kind !== "DEVICE" || principal.deviceKind !== "IPHONE") return;
    this.identityAccess.assertCurrent(principal);
    // Derive messages from the current privacy/eligibility projection, not stale receipts.
    for (const event of this.listEvents(principal)) {
      if (event.pendingResponseRequest) {
        this.publisher.emitToDevices([principal.deviceInstanceId], "response:requested", event.pendingResponseRequest);
      }
    }
  }

  listEvents(principal: Principal): EmergencyEventView[] {
    const device = requireIPhoneScope(principal, "events:read");
    const now = this.now();
    return readState(this.store, (state) => {
      return visibleEventCandidates(state, device)
      .map((event) => eventProjection(
        state,
        event,
        device,
        this.coordinationSummary(this.recruitmentContext(state), legacyCoordinationAedReader(state), event, now),
        this.isEligibleNearbyResponder(
          this.recruitmentContext(state),
          event,
          state.devices[device.deviceInstanceId]!,
          now
        ),
        now
      ))
      .filter((event): event is EmergencyEventView => event !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    });
  }

  /**
   * Offers a closer AED to an in-flight responder.
   *
   * This creates a PROPOSAL only.  The responder's task, route and status are
   * untouched until they answer, so a proposal that is ignored costs nothing and
   * cannot send anyone to the wrong cabinet.  Only a materially better ETA is
   * worth proposing (see `rerouteWorthProposing`).
   */
  async proposeAedReroute(
    principal: Principal,
    eventId: string,
    assignmentId: string,
    input: {
      positionUpdateId?: string | undefined;
      minimumSavingSeconds?: number | undefined;
    } = {}
  ): Promise<{ proposalId: string; toAedId: string; etaSavingSeconds: number; expiresAt: string }> {
    requireIPhoneScope(principal, "events:write");
    const now = this.now();
    const prepared = await transactState(this.store, (state) => {
      const event = state.events[eventId];
      if (!event || event.state !== "ACTIVE") throw conflict("Reroute requires an active event");
      const assignment = state.assignments[assignmentId];
      if (!assignment || assignment.eventId !== eventId) throw notFound("Assignment does not exist");
      if (!assignmentAcceptsReroute(assignment)) {
        throw conflict("Only an in-flight AED task can be rerouted");
      }
      if (!assignment.route) throw conflict("The current task has no route to replace");
      const device = state.devices[assignment.deviceInstanceId];
      const responderPosition = device ? currentResponderPosition(device) : undefined;
      if (!responderPosition) throw unprocessableEntity("Reroute requires the responder's current position");
      const patientPosition = currentPatientPosition(event);
      if (!patientPosition) throw conflict("Reroute requires a patient position");

      // Candidate devices: available, not already claimed by anyone (including
      // this assignment's own target), and materially faster.
      const unavailable = new Set<string>([
        ...event.unavailableAedIds,
        ...claimedAedIdsForOtherEvents(state, eventId),
        assignment.route.aedId
      ]);
      for (const other of Object.values(state.assignments)) {
        if (other.eventId !== eventId || other.id === assignmentId) continue;
        if (other.role !== "FETCH_AED" || !other.route) continue;
        if (!AED_HOLDING_ASSIGNMENT_STATUSES.has(other.status)) continue;
        unavailable.add(other.route.aedId);
      }
      for (const receipt of Object.values(state.aedReceiptsById)) {
        if (receipt.canonical?.eventId === eventId) unavailable.add(receipt.canonical.aedId);
      }
      const result = this.routeProvider.eligibleRoutes({
        responder: responderPosition,
        patient: patientPosition,
        aeds: state.aeds,
        unavailableAedIds: unavailable,
        at: now
      });
      const candidates = result.kind === "AVAILABLE" ? [...result.value] : [];
      const better = candidates
        .filter(route => rerouteWorthProposing({
          currentEtaSeconds: assignment.route!.etaSeconds,
          candidateEtaSeconds: route.etaSeconds,
          ...(input.minimumSavingSeconds !== undefined
            ? { minimumSavingSeconds: input.minimumSavingSeconds }
            : {})
        }))
        .sort((left, right) => left.etaSeconds - right.etaSeconds
          || left.aedId.localeCompare(right.aedId))[0];
      if (!better) return undefined;
      const proposalId = randomUUID();
      const expiresAt = new Date(now.getTime() + REROUTE_WINDOW_SECONDS * 1_000).toISOString();
      const record = proposeReroute(rerouteViewOver(state), {
        proposalId,
        eventId,
        assignmentId,
        deviceInstanceId: assignment.deviceInstanceId,
        ...(device?.userId ? { userId: device.userId } : {}),
        fromAedId: assignment.route.aedId,
        toAedId: better.aedId,
        proposedRoute: better,
        proposedFrom: {
          latitude: responderPosition.latitude,
          longitude: responderPosition.longitude
        },
        etaSavingSeconds: assignment.route.etaSeconds - better.etaSeconds,
        proposedAt: now.toISOString(),
        expiresAt
      });
      state.rerouteProposalsById[proposalId] = record;
      // The phone learns that a question is waiting over the durable outbox, then
      // reads REST truth: a push cannot carry the decision, only the prompt.
      enqueueNotification(state, assignment.deviceInstanceId, "assignment:reroute-proposed", {
        ...this.envelope(`reroute-proposed:${proposalId}`, eventId, now.toISOString()),
        assignmentId,
        proposalId,
        expiresAt
      });
      appendTimeline(
        state,
        eventId,
        now.toISOString(),
        "PASSIVE_OBSERVATION",
        `Aed reroute proposed: assignment ${assignmentId} may switch to ${better.aedId} `
        + `(saves ${record.etaSavingSeconds}s); the responder has ${REROUTE_WINDOW_SECONDS}s to confirm.`
      );
      return { proposalId, toAedId: better.aedId, etaSavingSeconds: record.etaSavingSeconds, expiresAt };
    });
    if (!prepared) throw conflict("No materially closer AED is available for this task");
    await this.notificationOutbox.drain();
    operationMetrics.rerouteProposals += 1;
    return prepared;
  }

  /**
   * Handles an Apple server-to-server notification (G02).
   *
   * `consent-revoked` and `account-deleted` mean the person withdrew access: every
   * session of every account carrying that Apple subject is revoked, so a phone that
   * still holds a valid-looking token cannot keep acting.  The endpoint is public, so
   * the body is verified against Apple's embedded root before anything is read, and
   * an unverified body changes nothing.
   *
   * The operation is idempotent: Apple retries, and revoking an already-revoked
   * session keeps the earliest known time.
   */
  async handleAppleServerNotification(input: { signedPayload: string }): Promise<{
    accepted: boolean;
    reason?: string;
    revokedSessions: number;
    affectedAccounts: number;
  }> {
    const verified = this.appleNotifications.verify(input.signedPayload);
    if (!verified.verified) {
      await this.recordSecurityEvent({
        event: "REQUEST_REJECTED",
        reasonCode: `APPLE_NOTIFICATION_${verified.reason}`
      });
      return { accepted: false, reason: verified.reason, revokedSessions: 0, affectedAccounts: 0 };
    }
    const revoking = verified.notification.events.filter(event =>
      event.type === "consent-revoked" || event.type === "account-deleted");
    if (revoking.length === 0) {
      // email-enabled / email-disabled are informational for this product: no
      // session depends on the relay address, so nothing is revoked and the delivery
      // is still acknowledged.
      return { accepted: true, revokedSessions: 0, affectedAccounts: 0 };
    }
    const pepper = this.config.authSubjectPepper;
    if (!pepper) throw authenticationUnavailable("APPLE");
    const now = this.now().toISOString();
    const subjects = new Set(revoking.map(event => event.subject));
    const hashes = new Set([...subjects].map(subject => providerSubjectHash("APPLE", subject, pepper)));
    const outcome = await transactState(this.store, state => {
      let affectedAccounts = 0;
      let revokedSessions = 0;
      const userIds = new Set<string>();
      for (const account of Object.values(state.accounts)) {
        if (account.provider !== "APPLE" || !hashes.has(account.providerSubjectHash)) continue;
        affectedAccounts += 1;
        userIds.add(account.userId);
        // The grant is gone at Apple, so the stored refresh token must not be reused.
        account.appleTokenRevokedAt ??= now;
        delete account.appleRefreshToken;
      }
      for (const session of Object.values(state.sessionsByTokenHash)) {
        if (!session.userId || !userIds.has(session.userId)) continue;
        if (session.revokedAt === undefined) revokedSessions += 1;
        session.revokedAt ??= now;
        if (session.refreshTokenHash) session.refreshRevokedAt ??= now;
      }
      return { affectedAccounts, revokedSessions, userIds: [...userIds] };
    });
    if (outcome.affectedAccounts === 0) {
      // No account of this deployment carries that subject.  Acknowledged without
      // detail: the caller is Apple, and an unknown subject is not an error.
      return { accepted: true, revokedSessions: 0, affectedAccounts: 0 };
    }
    await this.recordAccess({
      actor: "apple", actorKind: "SYSTEM", dataClass: "ACCOUNT_ADMIN",
      subjectId: outcome.userIds.length === 1 ? outcome.userIds[0]! : "multiple",
      reason: `apple notification revoked consent (${revoking.map(event => event.type).join(", ")})`,
      outcome: "ALLOWED"
    });
    await this.recordSecurityEvent({
      event: "SESSION_REPLAY_REJECTED",
      reasonCode: "APPLE_CONSENT_REVOKED",
      ...(outcome.userIds.length === 1 ? { subjectId: outcome.userIds[0]! } : {})
    });
    operationMetrics.appleConsentRevocations += 1;
    return {
      accepted: true,
      revokedSessions: outcome.revokedSessions,
      affectedAccounts: outcome.affectedAccounts
    };
  }

  /**
   * The caller's own pending reroute proposal (G07).
   *
   * A proposal is a question addressed to ONE device, so this returns only that
   * device's newest pending, unexpired proposal for the event — never another
   * responder's.  The window is 15 seconds, so a client that asks late gets
   * `proposal: null` and keeps its original task, which is the same outcome the
   * server's own expiry produces.
   */
  pendingAedReroute(principal: Principal, eventId: string): {
    proposal: {
      proposalId: string;
      assignmentId: string;
      fromAedId: string;
      toAedId: string;
      etaSeconds: number;
      etaSavingSeconds: number;
      proposedAt: string;
      expiresAt: string;
    } | null;
  } {
    const iPhone = requireIPhoneScope(principal, "position:write");
    const now = this.now();
    return readState(this.store, state => {
      const event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      const mine = stateRows(state, "rerouteProposalsById", "deviceInstanceId", iPhone.deviceInstanceId)
        .filter(row => row.eventId === eventId && row.status === "PENDING"
          && Date.parse(row.expiresAt) > now.getTime())
        .sort((left, right) => right.proposedAt.localeCompare(left.proposedAt))[0];
      if (!mine) return { proposal: null };
      return {
        proposal: {
          proposalId: mine.proposalId,
          assignmentId: mine.assignmentId,
          fromAedId: mine.fromAedId,
          toAedId: mine.toAedId,
          // The route geometry is deliberately not returned: the responder already
          // holds their own task, and the proposal only needs the decision inputs.
          etaSeconds: mine.proposedRoute.etaSeconds,
          etaSavingSeconds: mine.etaSavingSeconds,
          proposedAt: mine.proposedAt,
          expiresAt: mine.expiresAt
        }
      };
    });
  }

  /**
   * The responder's answer to a proposal.
   *
   * Accepting revalidates the assignment state, the responder's movement and the
   * target device's availability; refusing or timing out leaves the original task
   * exactly as it was.  The decision is idempotent per proposal: a second answer
   * is refused rather than applied twice.
   */
  async decideAedReroute(
    principal: Principal,
    eventId: string,
    proposalId: string,
    input: {
      accept: boolean;
      decidedAt: string;
      responderPosition?: ResponderPosition | undefined;
    }
  ): Promise<{ status: string; route?: AedRoute; reason?: string }> {
    const iPhone = requireIPhoneScope(principal, "position:write");
    const decidedAt = this.validateActionTime(input.decidedAt, "decidedAt", this.now());
    this.enforcePositionWriteCircuit(iPhone.deviceInstanceId);
    const outcome = await transactState(this.store, (state) => {
      const event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      if (!eventAcceptsReroute(event)) throw conflict("Reroute decisions require an active event");
      // Revalidate the target's availability against the CURRENT view: between
      // proposal and answer another responder may have taken that device.
      const targetTaken = (aedId: string, exceptAssignmentId: string): boolean => {
        if (event.unavailableAedIds.includes(aedId)) return true;
        for (const receipt of Object.values(state.aedReceiptsById)) {
          if (receipt.canonical?.eventId === eventId && receipt.canonical.aedId === aedId) return true;
        }
        return Object.values(state.assignments).some(other =>
          other.eventId === eventId
          && other.id !== exceptAssignmentId
          && other.role === "FETCH_AED"
          && other.route?.aedId === aedId
          && AED_HOLDING_ASSIGNMENT_STATUSES.has(other.status));
      };
      const decision = decideReroute(rerouteViewOver(state), {
        proposalId,
        deviceInstanceId: iPhone.deviceInstanceId,
        accept: input.accept,
        decidedAt,
        ...(input.responderPosition ? { currentPosition: input.responderPosition } : {}),
        targetAedTakenBy: targetTaken
      });
      const proposal = state.rerouteProposalsById[proposalId];
      if (proposal) {
        appendTimeline(
          state,
          eventId,
          decidedAt,
          "PASSIVE_OBSERVATION",
          `Aed reroute ${proposal.status}: assignment ${proposal.assignmentId}, `
          + `from ${proposal.fromAedId} to ${proposal.toAedId}`
          + (proposal.refusalReason ? ` (${proposal.refusalReason})` : "") + "."
        );
      }
      return decision;
    });
    return outcome.status === "ACCEPTED"
      ? { status: outcome.status, route: outcome.route }
      : outcome.status === "REJECTED"
        ? { status: outcome.status }
        : { status: outcome.status, reason: outcome.reason };
  }

  /** Retires proposals whose 15-second window has closed. */
  async expireAedReroutes(now: Date = this.now()): Promise<string[]> {
    return transactState(this.store, (state) => {
      const expired: string[] = [];
      for (const [proposalId, proposal] of Object.entries(state.rerouteProposalsById)) {
        if (proposal.status !== "PENDING") continue;
        if (Date.parse(proposal.expiresAt) > now.getTime()) continue;
        proposal.status = "EXPIRED";
        proposal.decidedAt = now.toISOString();
        expired.push(proposalId);
      }
      return expired;
    });
  }

  /**
   * Records an access.  Every audited read calls this, including denials.
   *
   * Auditing is deliberately part of the same operation as the read: an audit
   * trail written "best effort" after the response is a trail that can be missing
   * exactly when something went wrong.
   */
  private async recordAccess(entry: {
    actor: string;
    actorKind: AccessAuditEntry["actorKind"];
    dataClass: AccessAuditEntry["dataClass"];
    subjectId: string;
    reason: string;
    outcome: AccessAuditEntry["outcome"];
    grantId?: string;
  }): Promise<AccessAuditEntry> {
    const record = auditEntry({
      entryId: randomUUID(),
      ...entry,
      recordedAt: this.now().toISOString()
    });
    // Awaited, not fire-and-forget: an audit trail with a window where the entry
    // is not yet durable is not a control.
    await transactState(this.store, (state) => {
      state.accessAuditById[record.entryId] = record as never;
    });
    return record;
  }

  /**
   * Issues a single-event, read-only break-glass grant.
   *
   * Operator-only, requires a stated reason, and capped at 30 minutes by the
   * grant itself and by the state validator — a grant that outlives the
   * emergency is the failure mode this control exists to prevent.
   */
  async issueBreakGlassGrant(principal: Principal, input: {
    eventId: string;
    reason: string;
    minutes?: number | undefined;
  }): Promise<BreakGlassGrantRecord> {
    requireOperator(principal, "issue a break-glass grant");
    const reason = requireAuditReason(input.reason);
    const grant = issueBreakGlassGrant({
      grantId: randomUUID(),
      eventId: input.eventId,
      issuedBy: "operator",
      reason,
      issuedAt: this.now(),
      ...(input.minutes !== undefined ? { minutes: input.minutes } : {})
    });
    await transactState(this.store, (state) => {
      requireEventForAudit(state, input.eventId);
      state.breakGlassGrantsById[grant.grantId] = grant as never;
    });
    await this.recordAccess({
      actor: "operator", actorKind: "OPERATOR", dataClass: "ACCOUNT_ADMIN",
      subjectId: input.eventId, reason, outcome: "ALLOWED", grantId: grant.grantId
    });
    return grant;
  }

  /**
   * Reads an event's precise patient position.
   *
   * This is the data class the requirement singles out: a business operator
   * credential alone is NOT enough, the caller must hold an unexpired grant for
   * THIS event and state a reason.  The read is audited either way.
   */
  async readEventPrecisePosition(principal: Principal, input: {
    eventId: string;
    grantId?: string;
    reason: string;
  }): Promise<{
    eventId: string;
    observedAt: string;
    source: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  }> {
    requireOperator(principal, "read precise event data");
    const reason = requireAuditReason(input.reason);
    const grant = readEntities(this.store, view => input.grantId
      ? view.get("breakGlassGrantsById", input.grantId) as BreakGlassGrantRecord | undefined
      : activeBreakGlassGrant(
        { breakGlassGrantsById: Object.fromEntries(
          view.select("breakGlassGrantsById", () => true, 100)
            .map(row => [(row as BreakGlassGrantRecord).grantId, row as BreakGlassGrantRecord])
        ) } as unknown as PersistentState,
        input.eventId,
        this.now()
      ));
    const check = breakGlassAllows(grant, input.eventId, this.now());
    if (!check.allowed) {
      await this.recordAccess({
        actor: "operator", actorKind: "OPERATOR", dataClass: "PRECISE_PATIENT_POSITION",
        subjectId: input.eventId, reason, outcome: "DENIED"
      });
      throw forbidden(`Break-glass grant does not authorise this read (${check.code})`);
    }
    // Entity read, not a whole-state clone: an audited single-event read must not
    // copy the fleet (the G13 range rule applies to every business path).
    const snapshot = readEntities(this.store, (view) => {
      const event = view.get("events", input.eventId) as EventRecord | undefined;
      if (!event) throw notFound("Event does not exist");
      const sample = event.patientPosition;
      if (!sample) return undefined;
      return {
        eventId: event.id,
        observedAt: sample.observedAt,
        source: sample.source,
        latitude: sample.position.latitude,
        longitude: sample.position.longitude,
        accuracyMeters: sample.position.accuracyMeters
      };
    });
    if (!snapshot) throw notFound("This event has no patient position to read");
    await transactState(this.store, (state) => {
      const current = state.breakGlassGrantsById[check.grant.grantId];
      if (current) current.usedAt = this.now().toISOString();
    });
    await this.recordAccess({
      actor: "operator", actorKind: "OPERATOR", dataClass: "PRECISE_PATIENT_POSITION",
      subjectId: input.eventId, reason, outcome: "ALLOWED", grantId: check.grant.grantId
    });
    return snapshot;
  }

  /** Operator view of the audit trail itself; reading it is also audited. */
  async readAccessAudit(principal: Principal, input: { subjectId?: string; limit?: number } = {}) {
    requireOperator(principal, "read the access audit");
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const entries = readEntities(this.store, view =>
      view.select("accessAuditById",
        row => input.subjectId === undefined || row.subjectId === input.subjectId, limit));
    await this.recordAccess({
      actor: "operator", actorKind: "OPERATOR", dataClass: "ACCOUNT_ADMIN",
      subjectId: input.subjectId ?? "audit", reason: "operator audit review", outcome: "ALLOWED"
    });
    return { entries };
  }

  /**
   * Sends one preset in-app contact signal to the current team (G08).
   *
   * The channel exists only between accepted, still-participating members: the
   * membership check, the closed vocabulary, the rate limit and the per-event cap
   * all live in `planTeamSignal`, and this method only commits the decision and
   * notifies the team.  Delivery uses the durable outbox with an opaque message id
   * and a generic name, so a push never carries the alias, the kind or anything
   * about a person.
   */
  async sendTeamSignal(principal: Principal, eventId: string, input: {
    signalId: string;
    kind: string;
  }): Promise<{ signalId: string; kind: string; createdAt: string; expiresAt: string; duplicate: boolean }> {
    const iPhone = requireIPhoneScope(principal, "events:read");
    const salt = this.config.authSubjectPepper;
    if (!salt) throw authenticationUnavailable("APPLE");
    const now = this.now();
    const planned = await transactState(this.store, state => {
      const event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      const result = planTeamSignal({
        state, event, senderDeviceInstanceId: iPhone.deviceInstanceId,
        signalId: input.signalId, kind: input.kind, now, salt
      });
      if (!result.ok) return result;
      if (!result.duplicate) {
        state.teamSignalsById[result.signal.signalId] = result.signal;
        for (const deviceInstanceId of result.recipients) {
          enqueueNotification(state, deviceInstanceId, "event:team-signal", {
            ...this.envelope(`team-signal:${result.signal.signalId}`, eventId, result.signal.createdAt),
            // Deliberately nothing else: the alias and the kind are read from the
            // team view over REST, so a notification that leaks is not a leak of
            // who said what.
            signalId: result.signal.signalId
          });
        }
      }
      return result;
    });
    if (!planned.ok) {
      if (planned.reason === "NOT_A_MEMBER") {
        throw forbidden("Only a current participant of an active event may contact the team");
      }
      if (planned.reason === "EVENT_NOT_ACTIVE") throw forbidden("The event is no longer active");
      if (planned.reason === "UNKNOWN_KIND") {
        throw badRequest("Signal kind is not one of the preset contact messages");
      }
      if (planned.reason === "TOO_SOON") {
        throw tooManyRequests("A team signal was sent moments ago; wait before sending another");
      }
      throw forbidden("This event has reached its signal limit");
    }
    if (!planned.duplicate) {
      // Socket first for latency, then the durable outbox; a failure here leaves the
      // signal committed and the notification pending for retry.
      this.publisher.emitToDevices(planned.recipients, "event:team-signal", {
        ...this.envelope(`team-signal:${planned.signal.signalId}`, eventId, planned.signal.createdAt),
        signalId: planned.signal.signalId
      });
      await this.notificationOutbox.drain();
      operationMetrics.teamSignalsSent += 1;
    } else {
      operationMetrics.teamSignalsDeduplicated += 1;
    }
    return {
      signalId: planned.signal.signalId,
      kind: planned.signal.kind,
      createdAt: planned.signal.createdAt,
      expiresAt: planned.signal.expiresAt,
      duplicate: planned.duplicate
    };
  }

  /**
   * The team's recent signals, attributed only by anonymous alias.
   *
   * A non-member (never accepted, exited, patient, Watch, or after the event ends)
   * gets nothing: the channel is revoked by the same membership rule as the team
   * view, not by a separate flag that could drift from it.
   */
  readTeamSignals(principal: Principal, eventId: string): { eventId: string; signals: TeamSignalView[] } {
    const iPhone = requireIPhoneScope(principal, "events:read");
    const salt = this.config.authSubjectPepper;
    if (!salt) throw authenticationUnavailable("APPLE");
    return readState(this.store, state => {
      const event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      const feed = teamSignalFeed({
        state, event, viewerDeviceInstanceId: iPhone.deviceInstanceId, now: this.now(), salt
      });
      if (!feed) {
        throw forbidden("Only a current participant of an active event may read the team channel");
      }
      return { eventId, signals: feed };
    });
  }

  /**
   * Appends one minimal security log entry (G12).
   *
   * Called by the request layer for refusals.  It stores a class, an outcome, an
   * optional opaque subject, a reason code and a ROUTE TEMPLATE — never the URL's
   * query string, never a token and never a body — and the store validator refuses
   * any key outside that vocabulary.
   */
  async recordSecurityEvent(input: {
    event: SecurityLogRecord["event"];
    outcome?: SecurityLogRecord["outcome"];
    subjectId?: string;
    reasonCode?: string;
    route?: string;
    sourceClass?: SecurityLogRecord["sourceClass"];
  }): Promise<void> {
    const entry = securityLogEntry({
      entryId: randomUUID(),
      occurredAt: this.now().toISOString(),
      outcome: input.outcome ?? "DENIED",
      event: input.event,
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(input.route ? { route: input.route } : {}),
      ...(input.sourceClass ? { sourceClass: input.sourceClass } : {})
    });
    await transactState(this.store, state => {
      state.securityLogById[entry.entryId] = entry;
    });
    operationMetrics.securityLogEntriesWritten += 1;
  }

  /**
   * The six-month security log sweep.
   *
   * Reports what it deleted; a store without entity transactions or without the
   * deadline projection reports zero and increments a metric instead of scanning,
   * because this runs on the scheduler tick.
   */
  async sweepSecurityLog(): Promise<{ deleted: number }> {
    const result = await runSecurityLogRetention({ store: this.store, now: this.now() });
    return { deleted: result.deleted };
  }

  /**
   * The operator status surface (G15).
   *
   * Operator-only: it reports counts, configured paths and a verdict per concern.
   * It never returns user ids, coordinates, tokens or message bodies, and reading it
   * does not touch business state beyond reading the counters and the outbox keys.
   */
  operatorStatus(principal: Principal): OperatorStatus {
    requireOperator(principal, "read the operator status");
    const state = readState(this.store, current => current);
    return buildOperatorStatus({
      state,
      now: this.now(),
      startedAt: this.startedAt,
      paths: {
        identityLedger: this.identityLedgerFile(),
        sealKey: sealKeyPath(this.config.dataFile)
      }
    });
  }

  /**
   * One event's ANONYMOUS operational status (G15).
   *
   * This exists so an operator can answer "what happened in this event?" or check
   * whether a legal hold is in force WITHOUT reading personal data: it returns the
   * event's state, its retention tier, the hold's basis, and counts.  There is no
   * user id, no device id, no coordinate, no AED id and no timeline text, and the
   * response says which classes it left out.
   */
  opsEventStatus(principal: Principal, eventId: string): {
    eventId: string;
    state: string;
    triggerSource: string;
    createdAt: string;
    resolvedAt?: string;
    terminalReason?: string;
    retention: {
      tier: string;
      sealedAt?: string;
      hasColdCopy: boolean;
      legalHold: { placedAt: string; authority: string; releasedAt?: string } | null;
    };
    counts: {
      acceptedResponders: number;
      completedAssignments: number;
      aedAcquired: number;
      aedUnavailableReports: number;
      positionBatches: number;
      positionRecords: number;
      timelineEntries: number;
      notificationsPending: number;
    };
    redactions: string[];
  } {
    requireOperator(principal, "read an event's anonymous operational status");
    return readState(this.store, state => {
      const event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      const deliveries = stateRows(state, "deliveries", "eventId", eventId);
      const assignments = stateRows(state, "assignments", "eventId", eventId);
      const batches = stateRows(state, "eventPositionBatchesById", "eventId", eventId);
      const receipts = stateRows(state, "aedReceiptsById", "canonical.eventId", eventId);
      const unavailable = stateRows(state, "aedUnavailableByReportId", "canonical.eventId", eventId);
      const notifications = stateRows(state, "notificationOutboxById", "eventId", eventId);
      const hold = event.retention?.legalHold;
      return {
        eventId: event.id,
        state: event.state,
        triggerSource: event.triggerSource,
        createdAt: event.createdAt,
        ...(event.resolvedAt ? { resolvedAt: event.resolvedAt } : {}),
        ...(event.terminalReason ? { terminalReason: event.terminalReason } : {}),
        retention: {
          tier: event.retention?.tier ?? "ONLINE",
          ...(event.retention?.sealedAt ? { sealedAt: event.retention.sealedAt } : {}),
          hasColdCopy: event.retention?.sealedContainer !== undefined,
          legalHold: hold
            ? {
              placedAt: hold.placedAt,
              authority: hold.authority,
              ...(hold.releasedAt ? { releasedAt: hold.releasedAt } : {})
            }
            : null
        },
        counts: {
          acceptedResponders: deliveries.filter(row =>
            row.decision === "ACCEPT" && row.status === "ACCEPTED").length,
          completedAssignments: assignments.filter(row => row.status === "COMPLETED").length,
          aedAcquired: receipts.length,
          aedUnavailableReports: unavailable.length,
          positionBatches: batches.length,
          positionRecords: batches.reduce((total, row) => total + row.records.length, 0),
          timelineEntries: (state.timelineByEventId[eventId] ?? []).length,
          notificationsPending: notifications.filter(row => row.status === "PENDING").length
        },
        redactions: [
          "participant identities, device ids and account ids",
          "precise patient and responder positions",
          "AED ids and cabinet locations",
          "timeline text and message bodies"
        ]
      };
    });
  }

  /** How many security log entries exist, for diagnostics. Never their content. */
  securityLogSize(): number {
    return readState(this.store, state => Object.keys(state.securityLogById).length);
  }

  /**
   * Opens a self-service access request (G11).
   *
   * The scope is computed here from participation records: a caller cannot name
   * the events it wants, because "give me my data" must not become "give me any
   * event I can name".  The response carries the single-use nonce the device has
   * to sign; nothing is readable until an operator approves it afterwards.
   */
  async requestSelfAccess(principal: Principal, input: { method: LocalAuthMethod }):
  Promise<{ requestId: string; status: string; approvalDeadlineAt: string; challengeExpiresAt: string;
    payloadBase64: string; events: string[] }> {
    const device = requireIPhoneScope(principal, "events:read");
    if (!device.userId || !device.accountId) {
      throw forbidden("A self-service access request requires an account-linked iPhone session");
    }
    if (input.method !== "BIOMETRIC" && input.method !== "PASSCODE") {
      throw badRequest("Local authentication method must be BIOMETRIC or PASSCODE");
    }
    const now = this.now();
    const scope = readState(this.store, state => selfAccessScope(
      state, device.userId!, ownDeviceInstanceIds(state, device.userId!, device.deviceInstanceId)));
    if (scope.length === 0) {
      // No participation means nothing to show.  Saying so is not a leak: the
      // requester's own absence from every event is their own fact.
      throw notFound("This account has no event data to review");
    }
    const requestId = randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    const challengeExpiresAt = new Date(now.getTime() + SELF_ACCESS_CHALLENGE_MS).toISOString();
    const approvalDeadlineAt = addWorkingDays(now, SELF_ACCESS_APPROVAL_WORKING_DAYS).toISOString();
    await transactState(this.store, state => {
      state.selfAccessRequestsById[requestId] = {
        requestId,
        userId: device.userId!,
        accountId: device.accountId!,
        deviceInstanceId: device.deviceInstanceId,
        requestedAt: now.toISOString(),
        eventIds: scope,
        challengeNonce: nonce,
        challengeExpiresAt,
        challengeAttempts: 0,
        status: "PENDING_CHALLENGE",
        approvalDeadlineAt
      };
    });
    await this.recordAccess({
      actor: device.userId, actorKind: "DEVICE", dataClass: "EVIDENCE",
      subjectId: requestId, reason: "self-service access request opened", outcome: "ALLOWED"
    });
    operationMetrics.selfAccessRequests += 1;
    return {
      requestId,
      status: "PENDING_CHALLENGE",
      approvalDeadlineAt,
      challengeExpiresAt,
      payloadBase64: selfAccessChallengePayload({
        requestId, nonce, deviceInstanceId: device.deviceInstanceId, method: input.method
      }).toString("base64"),
      events: scope
    };
  }

  /**
   * Answers the signature challenge.
   *
   * The signature must cover the exact payload issued for THIS request, and the
   * method is inside the signed bytes, so a device cannot claim a biometric
   * confirmation it did not sign.  Wrong signatures are counted and the request
   * is abandoned after the cap, which is what stops an attacker with a stolen
   * session from grinding keys against a live nonce.
   */
  async completeSelfAccessChallenge(principal: Principal, input: {
    requestId: string;
    method: LocalAuthMethod;
    publicKeyPem: string;
    signatureBase64: string;
  }): Promise<{ requestId: string; status: string; approvalDeadlineAt: string }> {
    const device = requireIPhoneScope(principal, "events:read");
    if (input.method !== "BIOMETRIC" && input.method !== "PASSCODE") {
      throw badRequest("Local authentication method must be BIOMETRIC or PASSCODE");
    }
    const now = this.now();
    const current = readState(this.store, state => state.selfAccessRequestsById[input.requestId]);
    if (!current || current.userId !== device.userId || current.deviceInstanceId !== device.deviceInstanceId) {
      throw notFound("Self-access request does not exist for this device");
    }
    if (current.status !== "PENDING_CHALLENGE") {
      throw forbidden("This self-access request is not awaiting a challenge");
    }
    if (Date.parse(current.challengeExpiresAt) <= now.getTime()) {
      await transactState(this.store, state => {
        const row = state.selfAccessRequestsById[input.requestId];
        if (row && row.status === "PENDING_CHALLENGE") {
          // The nonce goes with the expiry: an unanswerable nonce must not stay in
          // the record where a later code path could find it usable again.
          const { challengeNonce: _dropped, ...rest } = row;
          state.selfAccessRequestsById[input.requestId] = {
            ...rest, status: "EXPIRED", revokedAt: row.challengeExpiresAt,
            revocationReason: "CHALLENGE_EXPIRED"
          };
        }
      });
      throw forbidden("The self-access challenge expired; open a new request");
    }
    if (current.challengeAttempts >= SELF_ACCESS_MAX_CHALLENGE_ATTEMPTS) {
      throw forbidden("Too many failed challenge attempts; open a new request");
    }
    const nonce = current.challengeNonce;
    if (!nonce) throw forbidden("This self-access request has no pending challenge nonce");
    const verification = verifySelfAccessChallenge({
      payload: selfAccessChallengePayload({
        requestId: current.requestId,
        nonce,
        deviceInstanceId: current.deviceInstanceId,
        method: input.method
      }),
      publicKeyPem: input.publicKeyPem,
      signatureBase64: input.signatureBase64
    });
    await transactState(this.store, state => {
      const row = state.selfAccessRequestsById[input.requestId];
      if (!row || row.status !== "PENDING_CHALLENGE") return;
      if (!verification.verified) {
        state.selfAccessRequestsById[input.requestId] = { ...row, challengeAttempts: row.challengeAttempts + 1 };
        return;
      }
      // The nonce is consumed in the same transaction that records the
      // verification, so a replay finds no nonce left to sign.
      const { challengeNonce: _consumed, ...rest } = row;
      state.selfAccessRequestsById[input.requestId] = {
        ...rest,
        status: "PENDING_APPROVAL",
        challengeVerifiedAt: now.toISOString(),
        ...(verification.keyFingerprint ? { challengeKeyFingerprint: verification.keyFingerprint } : {}),
        localAuthMethod: input.method
      };
    });
    await this.recordAccess({
      actor: device.userId ?? device.deviceInstanceId, actorKind: "DEVICE", dataClass: "EVIDENCE",
      subjectId: input.requestId,
      reason: verification.verified ? `self-access challenge verified (${input.method})` : "self-access challenge rejected",
      outcome: verification.verified ? "ALLOWED" : "DENIED"
    });
    if (!verification.verified) {
      operationMetrics.selfAccessChallengeFailures += 1;
      throw unauthorized("The self-access challenge signature was rejected");
    }
    return {
      requestId: input.requestId,
      status: "PENDING_APPROVAL",
      approvalDeadlineAt: current.approvalDeadlineAt
    };
  }

  /** The operator queue: what is waiting for a decision, oldest first. */
  async listSelfAccessRequests(principal: Principal, input: { limit?: number } = {}): Promise<{
    pending: { requestId: string; status: string; requestedAt: string; approvalDeadlineAt: string;
      overdue: boolean; verifiedLocalAuth?: string }[];
  }> {
    requireOperator(principal, "list self-access requests");
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const now = this.now();
    const rows = readState(this.store, state => stateRows(state, "selfAccessRequestsById", "status", "PENDING_APPROVAL")
      .slice(0, limit));
    return {
      pending: rows.map(row => ({
        requestId: row.requestId,
        status: row.status,
        requestedAt: row.requestedAt,
        approvalDeadlineAt: row.approvalDeadlineAt,
        overdue: Date.parse(row.approvalDeadlineAt) < now.getTime(),
        ...(row.localAuthMethod ? { verifiedLocalAuth: row.localAuthMethod } : {})
      }))
    };
  }

  /**
   * The operator decision.
   *
   * Approval is only possible for a request whose challenge was verified, and only
   * inside the 15-working-day promise; the grant it issues is read-only and capped
   * at 24 hours.  A decision is never rewritten: an approved request that is later
   * revoked keeps the original decision recorded.
   */
  async decideSelfAccess(principal: Principal, input: {
    requestId: string;
    approve: boolean;
    reason: string;
  }): Promise<{ requestId: string; status: string; grant?: { expiresAt: string; readOnly: true; exportAllowed: false } }> {
    requireOperator(principal, "decide a self-access request");
    const reason = input.reason.trim();
    if (reason.length < 4) throw badRequest("A decision reason is required");
    const now = this.now();
    const decided = await transactState(this.store, state => {
      const row = state.selfAccessRequestsById[input.requestId];
      if (!row) throw notFound("Self-access request does not exist");
      if (row.status !== "PENDING_APPROVAL") {
        throw forbidden("Only a request whose challenge was verified can be decided");
      }
      if (!row.challengeVerifiedAt) {
        throw forbidden("Only a request whose challenge was verified can be decided");
      }
      if (Date.parse(row.approvalDeadlineAt) < now.getTime()) {
        // Past the published promise: the decision is refused, and the record says
        // why, instead of silently approving late.
        state.selfAccessRequestsById[input.requestId] = {
          ...row, status: "REJECTED", decidedAt: now.toISOString(), decidedBy: "operator",
          decisionReason: "APPROVAL_DEADLINE_MISSED"
        };
        operationMetrics.selfAccessDecisions += 1;
        return { requestId: row.requestId, status: "REJECTED" as const };
      }
      if (!input.approve) {
        state.selfAccessRequestsById[input.requestId] = {
          ...row, status: "REJECTED", decidedAt: now.toISOString(), decidedBy: "operator",
          decisionReason: reason
        };
        operationMetrics.selfAccessDecisions += 1;
        return { requestId: row.requestId, status: "REJECTED" as const };
      }
      const grantedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + SELF_ACCESS_GRANT_MAX_MS).toISOString();
      const grant = {
        grantId: randomUUID(), grantedAt, expiresAt, mode: "READ_ONLY" as const
      };
      state.selfAccessRequestsById[input.requestId] = {
        ...row, status: "APPROVED", decidedAt: grantedAt, decidedBy: "operator",
        decisionReason: reason, grant
      };
      operationMetrics.selfAccessDecisions += 1;
      operationMetrics.selfAccessGrantsIssued += 1;
      return {
        requestId: row.requestId, status: "APPROVED" as const,
        grant: { expiresAt, readOnly: true as const, exportAllowed: false as const }
      };
    });
    await this.recordAccess({
      actor: "operator", actorKind: "OPERATOR", dataClass: "EVIDENCE",
      subjectId: input.requestId,
      reason: `self-access decision: ${decided.status}`, outcome: "ALLOWED"
    });
    return decided;
  }

  /**
   * Reads the approved view.
   *
   * Ownership, status, expiry and the 24-hour ceiling are all re-checked here: the
   * grant is a permission to look, not a token that can be replayed later, and the
   * read itself is audited as an access to evidence.
   */
  async readSelfAccessView(principal: Principal, requestId: string): Promise<SelfAccessView> {
    const device = requireIPhoneScope(principal, "events:read");
    const now = this.now();
    // Sweep first: an expired grant is expired for everyone, whether or not
    // anyone remembered to run the scheduled pass.
    const expired = await transactState(this.store, state => expireSelfAccessGrants(state, now));
    const request = readState(this.store, state => state.selfAccessRequestsById[requestId]);
    if (!request || request.userId !== device.userId || request.deviceInstanceId !== device.deviceInstanceId) {
      throw notFound("Self-access request does not exist for this device");
    }
    if (request.status !== "APPROVED" || !request.grant) {
      await this.recordAccess({
        actor: device.userId ?? device.deviceInstanceId, actorKind: "DEVICE", dataClass: "EVIDENCE",
        subjectId: requestId, reason: `self-access read refused (${request.status})`, outcome: "DENIED"
      });
      throw forbidden(`Self-access view is not available in status ${request.status}`);
    }
    if (Date.parse(request.grant.expiresAt) <= now.getTime()) {
      throw forbidden("The self-access grant has expired");
    }
    operationMetrics.selfAccessViewsGranted += 1;
    if (expired.includes(requestId)) throw forbidden("The self-access grant has expired");
    const view = readState(this.store, state => projectSelfAccessView(state, request, now));
    await this.recordAccess({
      actor: device.userId ?? device.deviceInstanceId, actorKind: "DEVICE", dataClass: "EVIDENCE",
      subjectId: requestId, reason: "self-access read-only view", outcome: "ALLOWED",
      grantId: request.grant.grantId
    });
    return view;
  }

  /**
   * Revokes a grant early.
   *
   * The owner can close their own view, and an operator can close any view; both
   * leave the request readable as REVOKED, because a grant that disappears without
   * a trace is worse than one that was never issued.
   */
  async revokeSelfAccess(principal: Principal, input: { requestId: string; reason: string }):
  Promise<{ requestId: string; status: string }> {
    const reason = input.reason.trim();
    if (reason.length < 4) throw badRequest("A revocation reason is required");
    const actor = principal.kind === "OPERATOR"
      ? { actor: "operator", actorKind: "OPERATOR" as const }
      : (() => {
        const device = requireIPhoneScope(principal, "events:read");
        return { actor: device.userId ?? device.deviceInstanceId, actorKind: "DEVICE" as const, device };
      })();
    const now = this.now();
    const result = await transactState(this.store, state => {
      const row = state.selfAccessRequestsById[input.requestId];
      if (!row) throw notFound("Self-access request does not exist");
      if ("device" in actor && actor.device.userId !== row.userId) {
        throw forbidden("A self-access request can only be revoked by its owner or an operator");
      }
      if (row.status !== "APPROVED" && row.status !== "PENDING_APPROVAL") {
        throw forbidden(`Self-access request is not revocable in status ${row.status}`);
      }
      state.selfAccessRequestsById[input.requestId] = {
        ...row, status: "REVOKED", revokedAt: now.toISOString(), revocationReason: reason
      };
      return { requestId: row.requestId, status: "REVOKED" as const };
    });
    await this.recordAccess({
      actor: actor.actor, actorKind: actor.actorKind, dataClass: "EVIDENCE",
      subjectId: input.requestId, reason: `self-access revoked: ${reason}`, outcome: "ALLOWED"
    });
    return result;
  }

  /**
   * The scheduled pass: grant expiry happens on time even if nobody reads.
   *
   * Returns the ids that expired, which the caller reports; a silent sweep would
   * make "the grant lapsed" unverifiable after the fact.
   */
  async sweepSelfAccessGrants(): Promise<string[]> {
    return transactState(this.store, state => expireSelfAccessGrants(state, this.now()));
  }

  /**
   * The anonymous team view for one event (G08).
   *
   * Only a current member sees it: an offer that was never accepted, an exited
   * responder and the patient are all refused, so nobody can use this endpoint to
   * enumerate who is responding.  The alias salt is the deployment's subject
   * pepper, so aliases cannot be recomputed from a leaked user id.
   */
  getCoordinationTeam(principal: Principal, eventId: string): CoordinationTeamView {
    const iPhone = requireIPhoneScope(principal, "events:read");
    const salt = this.config.authSubjectPepper;
    if (!salt) throw authenticationUnavailable("APPLE");
    return readState(this.store, (state) => {
      const event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      const team = coordinationTeamView({
        state,
        event,
        viewerDeviceInstanceId: iPhone.deviceInstanceId,
        salt,
        now: this.now(),
        positionMaxAgeSeconds: this.config.positionMaxAgeSeconds
      });
      if (!team) {
        throw forbidden("Only a current participant of an active event may see the coordination team");
      }
      return team;
    });
  }

  getEvent(principal: Principal, eventId: string): EmergencyEventView {
    const device = requireIPhoneScope(principal, "events:read");
    return readState(this.store, (state) => {
      let event = state.events[eventId];
      if (!event) throw notFound("Event does not exist");
      const view = eventProjection(
        state,
        event,
        device,
        this.coordinationSummary(this.recruitmentContext(state), legacyCoordinationAedReader(state), event, this.now()),
        this.isEligibleNearbyResponder(
          this.recruitmentContext(state),
          event,
          state.devices[device.deviceInstanceId]!,
          this.now()
        ),
        this.now()
      );
      if (!view) throw notFound("Event is not visible to this authenticated device session");
      return view;
    });
  }

  async respondToStatusConfirmation(
    principal: Principal,
    eventId: string,
    request: StatusConfirmationResponseRequest
  ): Promise<StatusConfirmationResult> {
    const iPhone = requireIPhoneScope(principal, "events:write");
    // Apply an overdue persisted check before accepting an answer. This keeps
    // the five-minute deadline authoritative even when no scheduler tick ran.
    await this.tick();
    return runStatusConfirmationResponse(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        isPatientDevice
      },
      iPhone,
      eventId,
      request
    );
  }

  timeline(principal: Principal, eventId: string): TimelineEntry[] {
    return recoveryTimeline(this.getEvent(principal, eventId));
  }

  async getPresence(principal: Principal): Promise<DevicePresenceView> {
    // Same reclamation entry point as before the index existed, so deletion
    // timing is unchanged; only the cost of finding the due devices changed.
    await this.pruneExpiredPositions(this.now());
    const iPhone = requireIPhoneScope(principal, "events:read");
    const now = this.now().toISOString();
    return transactState(this.store, (state) => {
      if (!this.store.positionExpiry?.()) this.pruneExpiredCurrentPositions(state, new Date(now));
      const device = state.devices[iPhone.deviceInstanceId];
      if (!device) throw forbidden("Device session is no longer registered");
      device.lastSeenAt = now;
      return this.presenceView(livePresenceAccess(state), device, this.now());
    });
  }

  /**
   * Returns the privacy-minimal standby view used by the neutral dashboard.
   * The authenticated iPhone's latest valid R sample is the only centre that
   * may be used; callers cannot supply an arbitrary coordinate. This is a
   * read-only snapshot and deliberately does not touch lastSeen or presence.
   */
  getNearbyVolunteerSummary(principal: Principal): NearbyVolunteerSummary {
    const iPhone = requireIPhoneScope(principal, "events:read");
    const now = this.now();
    const generatedAt = now.toISOString();
    return readState(this.store, (state) => {
      const viewer = state.devices[iPhone.deviceInstanceId];
      const viewerUserId = viewer?.userId;
      if (!viewer
        || viewer.deviceKind !== "IPHONE"
        || !viewerUserId
        || viewerUserId !== iPhone.userId
        || viewer.accountId !== iPhone.accountId
        || !hasAllBootstrapAgreements(viewer)
        || !viewer.availableForResponse
        || !viewer.capabilities.notificationAuthorized
        || !viewer.capabilities.locationAuthorized) {
        throw forbidden(
          "Nearby volunteer counts require a neutral, available iPhone with current agreements and permissions"
        );
      }

      const busyIdentities = this.activeStandbyExcludedIdentities(state);
      if (busyIdentities.has(deviceIdentityKey(viewer))) {
        throw forbidden("Nearby volunteer counts are available only in neutral standby");
      }

      const viewerPosition = currentResponderPosition(viewer);
      const latestPosition = viewer.latestPosition;
      if (!viewerPosition
        || !latestPosition
        || !Number.isFinite(viewerPosition.accuracyMeters)
        || viewerPosition.accuracyMeters <= 0
        || viewerPosition.accuracyMeters > this.config.maxPositionAccuracyMeters
        || !Number.isFinite(viewerPosition.latitude)
        || !Number.isFinite(viewerPosition.longitude)
        || !this.responderPositionSampleIsFresh(
          viewerPosition,
          latestPosition.observedAt,
          now
        )) {
        throw unprocessableEntity(
          "A fresh responder position is required before nearby volunteer counts can be shown"
        );
      }

      // A user may have more than one iPhone. Keep the closest valid sample
      // for each stable identity before assigning cumulative ring counts.
      const nearestDistanceByUser = new Map<string, number>();
      const considerDevice = (device: DeviceRecord | undefined): void => {
        if (!device) return;
        if (!this.isEligibleStandbyVolunteer(
          state,
          device,
          now,
          viewerUserId,
          busyIdentities
        )) return;
        const responderPosition = currentResponderPosition(device);
        if (!responderPosition || !device.userId) return;
        const distance = distanceMeters(viewerPosition, responderPosition);
        if (!Number.isFinite(distance)) return;
        const previous = nearestDistanceByUser.get(device.userId);
        if (previous === undefined || distance < previous) {
          nearestDistanceByUser.set(device.userId, distance);
        }
      };

      // Only devices within the widest reported ring can contribute, so the
      // geographic index pre-filters the scan.  The index over-selects, never
      // omits, and every eligibility/distance check below is unchanged.
      const positionIndex = this.store.devicePositions?.();
      const candidateIds = positionIndex
        ? positionIndex.query(
          viewerPosition.latitude,
          viewerPosition.longitude,
          Math.max(...RECRUITMENT_RADIUS_STAGES_METERS)
        )
        : Object.keys(state.devices);
      for (const deviceInstanceId of candidateIds) {
        considerDevice(state.devices[deviceInstanceId]);
      }

      // Temporary equivalence net: the pre-filter must never change the answer.
      // Development and test runs recompute the summary from every device and
      // fail loudly on any disagreement.
      //
      // The comparison must be like-for-like.  The index deliberately returns
      // only devices inside the widest reported ring, while the full scan also
      // sees users whose every sample lies beyond it.  Those far-away users
      // contribute to no reported ring, so the scan side is reduced to the same
      // per-ring counts instead of being compared by raw map size; the previous
      // size comparison reported a false disagreement and failed the default
      // smoke run whenever any volunteer stood outside the widest ring.
      if (isShadowValidationEnabled() && positionIndex) {
        const viaIndex = new Map(nearestDistanceByUser);
        nearestDistanceByUser.clear();
        for (const device of Object.values(state.devices)) considerDevice(device);
        const viaScan = new Map(nearestDistanceByUser);
        const ringCounts = (distances: Map<string, number>): number[] =>
          RECRUITMENT_RADIUS_STAGES_METERS.map((radiusMeters) =>
            [...distances.values()].filter((distance) => distance <= radiusMeters).length);
        const indexedCounts = ringCounts(viaIndex);
        const scannedCounts = ringCounts(viaScan);
        if (!scannedCounts.every((count, index) => count === indexedCounts[index])) {
          throw new Error(
            "nearby volunteer pre-filter disagrees with a full scan "
            + `(indexed=${indexedCounts.join("/")} scanned=${scannedCounts.join("/")})`
          );
        }
      }

      return {
        generatedAt,
        ranges: RECRUITMENT_RADIUS_STAGES_METERS.map((radiusMeters) => ({
          radiusMeters,
          count: [...nearestDistanceByUser.values()]
            .filter((distance) => distance <= radiusMeters)
            .length
        }))
      };
    });
  }

  async touchDevice(principal: Principal): Promise<void> {
    if (principal.kind !== "DEVICE") return;
    const now = this.now().toISOString();
    await transactState(this.store, (state) => {
      const device = state.devices[principal.deviceInstanceId];
      if (device) device.lastSeenAt = now;
    });
  }

  async updatePresence(
    principal: Principal,
    update: DevicePresenceUpdate
  ): Promise<DevicePresenceView> {
    // Restored entry point (see getPresence): reclamation timing must not drift
    // as a side effect of making reclamation cheaper.
    await this.pruneExpiredPositions(this.now());
    const iPhone = requireIPhoneScope(principal, "events:read");
    const occurredAt = this.validateClientTime(update.occurredAt, "occurredAt");
    const normalized = { ...update, occurredAt };
    const updateFingerprint = fingerprint(normalized);
    const receivedAt = this.now().toISOString();
    const result = await transactState(this.store, (state) => {
      if (!this.store.positionExpiry?.()) this.pruneExpiredCurrentPositions(state, new Date(receivedAt));
      const device = state.devices[iPhone.deviceInstanceId];
      if (!device) throw forbidden("Device session is no longer registered");
      const prior = state.presenceUpdateReceiptsById[normalized.presenceUpdateId];
      if (prior) {
        if (prior.deviceInstanceId !== device.deviceInstanceId
          || prior.fingerprint !== updateFingerprint) {
          throw conflict("presenceUpdateId was already used with different content");
        }
        device.lastSeenAt = receivedAt;
        return { view: this.presenceView(livePresenceAccess(state), device, this.now()), updates: [] as RecruitmentUpdate[] };
      }

      const currentFingerprint = fingerprint({
        occurredAt: device.presenceObservedAt,
        availableForResponse: device.availableForResponse,
        capabilities: device.capabilities
      });
      const normalizedContentFingerprint = fingerprint({
        occurredAt,
        availableForResponse: normalized.availableForResponse,
        capabilities: normalized.capabilities
      });
      if (occurredAt === device.presenceObservedAt
        && currentFingerprint !== normalizedContentFingerprint) {
        throw conflict("Presence content conflicts at the same occurredAt timestamp");
      }
      let applied = false;
      if (occurredAt >= device.presenceObservedAt) {
        device.availableForResponse = normalized.availableForResponse;
        device.capabilities = structuredClone(normalized.capabilities);
        device.presenceObservedAt = occurredAt;
        device.lastPresenceUpdateId = normalized.presenceUpdateId;
        applied = true;
      }
      device.lastSeenAt = receivedAt;
      state.presenceUpdateReceiptsById[normalized.presenceUpdateId] = {
        deviceInstanceId: device.deviceInstanceId,
        fingerprint: updateFingerprint,
        recordedAt: receivedAt
      };
      this.pruneReceipts(state.presenceUpdateReceiptsById, device.deviceInstanceId);

      const updates: RecruitmentUpdate[] = [];
      if (applied) {
        for (const event of stateRows(state, "events", "state", "ACTIVE")) {
          const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, this.now());
          if (!refreshed.changed) continue;
          appendTimeline(
            state,
            refreshed.event.id,
            occurredAt,
            "DEVICE_PRESENCE_UPDATED",
            `Presence update ${normalized.presenceUpdateId} changed recruitment eligibility.`
          );
          updates.push(this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), refreshed.event,
            refreshed.requests,
            refreshed.previousAudience,
            refreshed.expiredOffers
          ));
        }
      }
      return { view: this.presenceView(livePresenceAccess(state), device, this.now()), updates };
    });
    await this.notificationOutbox.drain();
    this.publishRecruitmentUpdates(result.updates, receivedAt);
    return result.view;
  }

  private ensureParticipantInterval(
    state: PersistentState,
    eventId: string,
    userId: string,
    deviceInstanceId: string,
    acceptedAt: string
  ): ParticipantIntervalRecord {
    const existing = participantIntervalForDevice(state, eventId, userId, deviceInstanceId);
    if (existing) {
      if (existing.acceptedAt !== acceptedAt || existing.endedAt !== undefined) {
        throw conflict("The event participant interval is already fixed");
      }
      return existing;
    }
    const interval: ParticipantIntervalRecord = {
      eventId,
      userId,
      deviceInstanceId,
      acceptedAt
    };
    const key = participantIntervalKey(eventId, userId, deviceInstanceId);
    Object.defineProperty(state.participantIntervalsById, key, {
      configurable: true,
      enumerable: true,
      value: interval,
      writable: true
    });
    return interval;
  }

  private endParticipantInterval(
    state: PersistentState,
    eventId: string,
    userId: string,
    deviceInstanceId: string,
    endedAt: string,
    endReason: ParticipantIntervalEndReason
  ): void {
    const interval = participantIntervalForDevice(state, eventId, userId, deviceInstanceId);
    if (!interval || interval.endedAt !== undefined) return;
    interval.endedAt = endedAt;
    interval.endReason = endReason;
  }

  async recordEventPositionBatch(
    principal: Principal,
    pathEventId: string,
    pathBatchId: string,
    batch: EventPositionBatch
  ): Promise<EventPositionBatchAck> {
    const iPhone = requireIPhoneScope(principal, "position:write");
    const serverReceivedAt = this.now();
    this.enforcePositionWriteCircuit(iPhone.deviceInstanceId);
    if (pathEventId !== batch.eventId || pathBatchId !== batch.batchId) {
      throw badRequest("path eventId/batchId must match the position batch body");
    }
    if (batch.records.length > MAX_EVENT_POSITION_RECORDS_PER_BATCH) {
      throw unprocessableEntity(
        `An event position batch may contain at most ${MAX_EVENT_POSITION_RECORDS_PER_BATCH} records`
      );
    }
    if (batch.records.length === 0) {
      throw badRequest("An event position batch must contain at least one record");
    }
    const recordIds = new Set<string>();
    for (const record of batch.records) {
      if (record.status !== "FIX" && record.status !== "NO_NEW_FIX") {
        throw badRequest("position record status is unsupported");
      }
      if (recordIds.has(record.recordId)) {
        throw badRequest("recordId must be unique within a batch");
      }
      recordIds.add(record.recordId);
      if (record.status === "FIX" && "gapReason" in record) {
        throw badRequest("gapReason is forbidden for FIX records");
      }
      if (record.status === "NO_NEW_FIX"
        && ("position" in record || "fixObservedAt" in record)) {
        throw badRequest("position and fixObservedAt are forbidden for NO_NEW_FIX records");
      }
      if (record.status === "NO_NEW_FIX"
        && record.gapReason !== "NO_FIX"
        && record.gapReason !== "APP_NOT_RUNNING") {
        throw badRequest("gapReason must be NO_FIX or APP_NOT_RUNNING");
      }
    }
    const normalizedRecords: EventPositionRecord[] = batch.records.map((record, index) => {
      if (!utcSecondSchema.safeParse(record.slotAt).success) {
        throw badRequest(`records[${index}].slotAt must be a UTC whole-second timestamp`);
      }
      const slotAt = this.validateClientTime(
        record.slotAt,
        `records[${index}].slotAt`,
        serverReceivedAt
      );
      if (record.status === "NO_NEW_FIX") {
        return { ...record, slotAt };
      }
      const fixObservedAt = this.validateClientTime(
        record.fixObservedAt,
        `records[${index}].fixObservedAt`,
        serverReceivedAt
      );
      const slotMilliseconds = Date.parse(slotAt);
      const fixMilliseconds = Date.parse(fixObservedAt);
      if (!Number.isFinite(slotMilliseconds)
        || !Number.isFinite(fixMilliseconds)
        || fixMilliseconds < slotMilliseconds
        || fixMilliseconds >= slotMilliseconds + 1_000) {
        throw badRequest(
          `records[${index}].fixObservedAt must fall within [slotAt, slotAt + 1 second)`
        );
      }
      return { ...record, slotAt, fixObservedAt };
    });
    const normalizedSlotValues = new Set<string>();
    for (const record of normalizedRecords) {
      if (normalizedSlotValues.has(record.slotAt)) {
        throw badRequest("slotAt must be unique within a batch");
      }
      normalizedSlotValues.add(record.slotAt);
    }
    const slotsInOrder = [...normalizedRecords].sort((left, right) =>
      Date.parse(left.slotAt) - Date.parse(right.slotAt));
    for (let index = 1; index < slotsInOrder.length; index += 1) {
      const previousSlot = Date.parse(slotsInOrder[index - 1]!.slotAt);
      const currentSlot = Date.parse(slotsInOrder[index]!.slotAt);
      if (currentSlot - previousSlot !== 1_000) {
        throw badRequest("slotAt values must be contiguous one-second slots within a batch");
      }
    }
    const latestSlotEndAt = new Date(
      Date.parse(slotsInOrder[slotsInOrder.length - 1]!.slotAt) + 1_000
    ).toISOString();
    const batchFingerprint = fingerprint({
      deviceInstanceId: iPhone.deviceInstanceId,
      userId: iPhone.userId ?? "",
      eventId: pathEventId,
      batchId: pathBatchId,
      records: [...normalizedRecords].sort((left, right) =>
        left.recordId.localeCompare(right.recordId))
    });
    const receivedAt = serverReceivedAt.toISOString();
    const result = await transactState(this.store, (state) => {
      let event = state.events[pathEventId];
      const device = state.devices[iPhone.deviceInstanceId];
      if (!event) throw notFound("Event does not exist");
      if (!device) throw forbidden("Device session is no longer registered");
      const userId = device.userId ?? iPhone.userId;
      if (!userId) throw forbidden("An authenticated user identity is required for event position evidence");

      const prior = state.eventPositionBatchesById[pathBatchId];
      if (prior) {
        if (prior.deviceInstanceId !== device.deviceInstanceId
          || prior.eventId !== pathEventId
          || prior.userId !== userId
          || prior.fingerprint !== batchFingerprint) {
          throw conflict("batchId was already used with different content");
        }
        device.lastSeenAt = receivedAt;
        // An exact replay of an already-persisted batch changes no fact, so it
        // also changes no verdict; recomputing here would only bump revisions.
        return {
          ack: this.eventPositionBatchAck(prior, true),
          update: undefined as RecruitmentUpdate | undefined,
          assignmentEmissions: [] as AssignmentEmission[],
          priorExisted: true
        };
      }

      if (!hasAllBootstrapAgreements(device) || !device.capabilities.locationAuthorized) {
        throw forbidden("Agreement and location capability are required before publishing event positions");
      }
      const isPatient = event.patientDeviceIds.includes(device.deviceInstanceId);
      const participantInterval = !isPatient
        ? participantIntervalForDevice(state, pathEventId, userId, device.deviceInstanceId)
        : undefined;
      const isAcceptedResponder = !isPatient && participantInterval !== undefined;
      const acceptedDeviceIsCurrent = isAcceptedResponder
        && acceptedDeviceIds(this.recruitmentContext(state), pathEventId).includes(device.deviceInstanceId);
      const acceptedDeviceAssignment = isAcceptedResponder
        ? currentAssignmentForDevice(state, pathEventId, device.deviceInstanceId)
        : undefined;
      if (!isPatient && !isAcceptedResponder) {
        throw event.state === "ACTIVE"
          ? forbidden("Only the event patient or an accepted responder can publish event positions")
          : forbidden("Only a historical event participant can upload late event position evidence");
      }
      const expectedKind: "P" | "R" = isPatient ? "P" : "R";
      const eventCreatedAt = Date.parse(event.createdAt);
      const eventTerminalAt = Date.parse(event.resolvedAt ?? "");
      const participationStartedAt = isAcceptedResponder && participantInterval
        ? Date.parse(participantInterval.acceptedAt)
        : eventCreatedAt;
      const participantEndedAt = isAcceptedResponder && participantInterval?.endedAt
        ? Date.parse(participantInterval.endedAt)
        : Number.POSITIVE_INFINITY;
      const eventEndedAt = event.state === "ACTIVE"
        ? Number.POSITIVE_INFINITY
        : eventTerminalAt;
      const participationEndedAt = Math.min(eventEndedAt, participantEndedAt);
      const canApplyToLatest = isPatient
        ? event.state === "ACTIVE"
        : event.state === "ACTIVE"
          && isAcceptedResponder
          && participantInterval?.endedAt === undefined
          && acceptedDeviceIsCurrent
          && !(acceptedDeviceAssignment && assignmentExitsParticipation(acceptedDeviceAssignment.status));
      for (const record of normalizedRecords) {
        const slotAt = Date.parse(record.slotAt);
        const outsideActiveWindow = !Number.isFinite(eventCreatedAt)
          || !Number.isFinite(slotAt)
          || !Number.isFinite(participationStartedAt)
          || slotAt < participationStartedAt
          || (event.state !== "ACTIVE" && !Number.isFinite(participationEndedAt))
          || (Number.isFinite(participationEndedAt) && slotAt >= participationEndedAt);
        if (outsideActiveWindow) {
          throw conflict("Event position record is outside the event active time window");
        }
        if (record.status === "FIX") {
          const fixObservedAt = Date.parse(record.fixObservedAt);
          if (!Number.isFinite(fixObservedAt)
            || fixObservedAt < participationStartedAt
            || (Number.isFinite(participationEndedAt) && fixObservedAt >= participationEndedAt)) {
            throw conflict("Event position fix is outside the event participation time window");
          }
        }
      }
      for (const record of normalizedRecords) {
        if (record.status === "FIX" && record.position.kind !== expectedKind) {
          throw badRequest(`FIX position kind must be ${expectedKind} for this event participant`);
        }
      }
      if (Date.parse(latestSlotEndAt) > serverReceivedAt.getTime()) {
        throw tooEarly(
          `Event position slots must have ended before persistence; retry at or after ${latestSlotEndAt}`
        );
      }

      for (const record of normalizedRecords) {
        const recordSlotMilliseconds = Date.parse(record.slotAt);
        if (stateRows(state, "eventPositionBatchesById", "$recordIds", record.recordId).length > 0) {
          throw conflict("recordId was already used in an event position batch");
        }
        const sameSlot = stateRows(state, "eventPositionBatchesById", "eventId", pathEventId)
          .flatMap((storedBatch) => storedBatch.records)
          .find((storedRecord) => storedRecord.eventId === pathEventId
            && state.eventPositionBatchesById[storedRecord.batchId]?.userId === userId
            && storedRecord.deviceInstanceId === device.deviceInstanceId
            && Date.parse(storedRecord.slotAt) === recordSlotMilliseconds);
        if (sameSlot) {
          throw conflict("An event participant already has a position record for this slotAt");
        }
      }

      const orderedRecords = [...normalizedRecords].sort((left, right) =>
        left.slotAt.localeCompare(right.slotAt)
        || left.recordId.localeCompare(right.recordId));
      const evidence: EventPositionEvidenceRecord[] = [];
      let patientPositionChanged = false;
      for (const record of orderedRecords) {
        let appliedToLatest = false;
        let ignoredAsStale = false;
        if (record.status === "FIX" && canApplyToLatest) {
          if (expectedKind === "P") {
            const patientPosition = record.position as PatientPosition;
            const incomingSampleIsFresh = this.patientPositionSampleIsFresh(
              patientPosition,
              record.fixObservedAt,
              new Date(receivedAt)
            );
            const current = state.events[pathEventId]!.iphonePatientPosition;
            if (!incomingSampleIsFresh) {
              ignoredAsStale = true;
            } else if (current && record.fixObservedAt < current.observedAt) {
              ignoredAsStale = true;
            } else if (current && record.fixObservedAt === current.observedAt) {
              if (fingerprint(current.position) !== fingerprint(patientPosition)) {
                throw conflict("Patient position conflicts at the same fixObservedAt timestamp");
              }
            } else {
              const sample: CurrentPatientPosition = {
                positionUpdateId: record.recordId,
                source: "IPHONE_PRIMARY",
                position: patientPosition,
                observedAt: record.fixObservedAt,
                serverReceivedAt: receivedAt
              };
              event.iphonePatientPosition = sample;
              event.patientPosition = sample;
              delete event.watchFallbackCandidate;
              device.latestPosition = {
                positionUpdateId: record.recordId,
                position: patientPosition,
                eventId: pathEventId,
                observedAt: record.fixObservedAt,
                serverReceivedAt: receivedAt
              };
              device.currentEventId = pathEventId;
              delete device.currentAssignmentId;
              appliedToLatest = true;
              patientPositionChanged = true;
            }
          } else {
            const responderPosition = record.position as ResponderPosition;
            const current = device.latestPosition?.position.kind === "R"
              ? device.latestPosition
              : undefined;
            const incomingSampleIsFresh = this.responderPositionSampleIsFresh(
              responderPosition,
              record.fixObservedAt,
              new Date(receivedAt)
            );
            if (!incomingSampleIsFresh) {
              ignoredAsStale = true;
            } else if (current && record.fixObservedAt < current.observedAt) {
              ignoredAsStale = true;
            } else if (current && record.fixObservedAt === current.observedAt) {
              if (fingerprint(current.position) !== fingerprint(responderPosition)) {
                throw conflict("Responder position conflicts at the same fixObservedAt timestamp");
              }
            } else {
              device.latestPosition = {
                positionUpdateId: record.recordId,
                position: responderPosition,
                observedAt: record.fixObservedAt,
                serverReceivedAt: receivedAt
              };
              appliedToLatest = true;
            }
          }
        }
        const base = {
          recordId: record.recordId,
          batchId: pathBatchId,
          eventId: pathEventId,
          userId,
          deviceInstanceId: device.deviceInstanceId,
          kind: expectedKind,
          slotAt: record.slotAt,
          serverReceivedAt: receivedAt,
          appliedToLatest,
          ignoredAsStale
        } as const;
        evidence.push(record.status === "FIX"
          ? { ...base, status: "FIX", position: record.position, fixObservedAt: record.fixObservedAt }
          : { ...base, status: "NO_NEW_FIX", gapReason: record.gapReason });
      }

      device.lastSeenAt = receivedAt;
      const storedBatch: EventPositionBatchRecord = {
        batchId: pathBatchId,
        eventId: pathEventId,
        userId,
        deviceInstanceId: device.deviceInstanceId,
        kind: expectedKind,
        fingerprint: batchFingerprint,
        receivedAt,
        records: evidence
      };
      state.eventPositionBatchesById[pathBatchId] = storedBatch;

      if (!patientPositionChanged) {
        return {
          ack: this.eventPositionBatchAck(storedBatch, false),
          update: undefined as RecruitmentUpdate | undefined,
          assignmentEmissions: [] as AssignmentEmission[],
          priorExisted: false
        };
      }
      const assignmentEmissions = this.refreshPatientRoutes(state, event, new Date(receivedAt));
      const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, new Date(receivedAt), true);
      event = refreshed.event;
      const update = this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
        refreshed.requests,
        refreshed.previousAudience,
        refreshed.expiredOffers
      );
      this.enqueuePatientPositionNotification(
        state,
        event,
        update.audience,
        update.coordination.revision,
        receivedAt
      );
      return {
        ack: this.eventPositionBatchAck(storedBatch, false),
        update,
        assignmentEmissions,
        priorExisted: false
      };
    });
    await this.publishPatientPositionChange(
      pathEventId,
      receivedAt,
      result.update
    );
    // A batch that arrived after its window closed is exactly the case the grace
    // period exists for: the verdict recorded a provisional gap, and this real
    // fact must replace it.  Recomputing here is what makes "late but legal wins"
    // true in practice instead of only in principle.  Outside the grace period
    // the record stays final, and the fact is still preserved either way.
    if (!result.priorExisted) {
      const arrivingSlots = new Set(batch.records.map(record => record.slotAt));
      const verdicts = readEntities(this.store, view =>
        view.select("positionWindowReconciliationsById",
          row => row.eventId === pathEventId, Number.MAX_SAFE_INTEGER));
      // Recompute whenever this batch carries a second the verdict does not yet
      // count as received.  That covers both cases honestly: a batch inside the
      // grace period replaces its provisional gaps, and a later straggler is
      // accounted for instead of leaving the verdict claiming a second is missing
      // when the server now holds it.  Nothing is ever un-received — the stored
      // verdict may only gain facts.
      const affected = verdicts.filter(verdict =>
        verdict.deviceInstanceId === iPhone.deviceInstanceId
        && [...arrivingSlots].some(slotAt =>
          !verdict.gaps.every(gap => gap.slotAt !== slotAt)));
      if (affected.length > 0) {
        await this.reconcilePositionWindows({
          eventId: pathEventId,
          closedBy: affected[0]!.closedBy
        });
      }
    }
    return result.ack;
  }

  async updateResponderPosition(
    principal: Principal,
    update: ResponderPositionUpdate
  ): Promise<PositionUpdateResult> {
    // Operation-scope timing.  The store only reports queue wait and transaction
    // service time; the post-transaction response construction below (which does
    // its own state read) must be attributed separately, otherwise the counted
    // work and the timed work cover different scopes.
    const operationStart = performance.now();
    operationMetrics.calls += 1;
    const iPhone = requireIPhoneScope(principal, "position:write");
    this.enforcePositionWriteCircuit(iPhone.deviceInstanceId);
    const observedAt = this.validateClientTime(update.observedAt, "observedAt");
    const normalized = { ...update, observedAt };
    const updateFingerprint = fingerprint({
      deviceInstanceId: iPhone.deviceInstanceId,
      kind: "R",
      ...normalized
    });
    const receivedAt = this.now().toISOString();
    operationMetrics.preTransactionMs += performance.now() - operationStart;

    // Relevance pre-filter.  A standby position change can only affect
    // recruitment for an event whose search ring could contain the new position.
    // The predicate runs against raw committed records and clones nothing, so
    // ended events and unrelated deliveries cost no copies at all.
    const relevantEventIds = this.relevantRecruitingEventIds(
      iPhone.deviceInstanceId,
      normalized.responderPosition
    );
    const transactEntities = this.store.transactEntities?.bind(this.store);
    if (!transactEntities) {
      operationMetrics.recruitmentFallbackRuns += 1;
      const legacy = await transactState(this.store, (state) => {
      const device = state.devices[iPhone.deviceInstanceId];
      if (!device || !hasAllBootstrapAgreements(device)) {
        throw forbidden("Volunteer responder agreement is required before publishing R position");
      }
      if (!device.capabilities.locationAuthorized) {
        throw forbidden("Location capability is required before publishing R position");
      }
      if (this.deviceIsActivePatient(state, iPhone.deviceInstanceId)) {
        throw conflict("An active patient cannot publish an R position");
      }
      const replay = this.positionReplay(
        state,
        normalized.positionUpdateId,
        device.deviceInstanceId,
        undefined,
        "R",
        updateFingerprint
      );
      if (replay) {
        device.lastSeenAt = receivedAt;
        return { position: replay, updates: [] as RecruitmentUpdate[] };
      }

      const current = device.latestPosition;
      let position: PositionUpdateResult;
      if (current && observedAt < current.observedAt) {
        position = this.positionResult(normalized.positionUpdateId, false, false, true, observedAt, receivedAt);
      } else if (current && observedAt === current.observedAt) {
        if (fingerprint(current.position) !== fingerprint(normalized.responderPosition)) {
          throw conflict("Responder position conflicts at the same observedAt timestamp");
        }
        position = this.positionResult(
          normalized.positionUpdateId,
          false,
          true,
          false,
          observedAt,
          current.serverReceivedAt
        );
      } else {
        device.latestPosition = {
          positionUpdateId: normalized.positionUpdateId,
          position: normalized.responderPosition,
          observedAt,
          serverReceivedAt: receivedAt
        };
        position = this.positionResult(normalized.positionUpdateId, true, false, false, observedAt, receivedAt);
      }
      device.lastSeenAt = receivedAt;
      this.recordPositionReceipt(
        state,
        normalized.positionUpdateId,
        device.deviceInstanceId,
        undefined,
        "R",
        updateFingerprint,
        receivedAt,
        position
      );

      const updates: RecruitmentUpdate[] = [];
      if (position.applied) {
        for (const event of stateRows(state, "events", "state", "ACTIVE")) {
          const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, this.now());
          if (refreshed.changed) {
            updates.push(this.recruitmentUpdate(
              this.recruitmentContext(state), legacyCoordinationAedReader(state), refreshed.event,
              refreshed.requests,
              refreshed.previousAudience,
              refreshed.expiredOffers
            ));
          }
        }
      }
        return { position, updates };
      });
      return this.finishResponderPosition(legacy, iPhone.deviceInstanceId, receivedAt, operationStart);
    }

    operationMetrics.incrementalPathRuns += 1;
    let recruitmentRan = false;
    const incremental = await transactEntities(tx => {
      const device = tx.get("devices", iPhone.deviceInstanceId);
      if (!device || !hasAllBootstrapAgreements(device)) {
        throw forbidden("Volunteer responder agreement is required before publishing R position");
      }
      if (!device.capabilities.locationAuthorized) {
        throw forbidden("Location capability is required before publishing R position");
      }
      if (this.deviceIsActivePatientInTransaction(tx, iPhone.deviceInstanceId)) {
        throw conflict("An active patient cannot publish an R position");
      }
      const replay = this.positionReplayInTransaction(
        tx,
        normalized.positionUpdateId,
        iPhone.deviceInstanceId,
        undefined,
        "R",
        updateFingerprint
      );
      if (replay) {
        tx.update("devices", iPhone.deviceInstanceId, draft => { draft.lastSeenAt = receivedAt; });
        return { position: replay, updates: [] as RecruitmentUpdate[] };
      }
      const current = device.latestPosition;
      let position: PositionUpdateResult;
      if (current && observedAt < current.observedAt) {
        position = this.positionResult(normalized.positionUpdateId, false, false, true, observedAt, receivedAt);
      } else if (current && observedAt === current.observedAt) {
        if (fingerprint(current.position) !== fingerprint(normalized.responderPosition)) {
          throw conflict("Responder position conflicts at the same observedAt timestamp");
        }
        position = this.positionResult(
          normalized.positionUpdateId, false, true, false, observedAt, current.serverReceivedAt);
      } else {
        tx.update("devices", iPhone.deviceInstanceId, draft => {
          draft.latestPosition = {
            positionUpdateId: normalized.positionUpdateId,
            position: normalized.responderPosition,
            observedAt,
            serverReceivedAt: receivedAt
          };
        });
        position = this.positionResult(normalized.positionUpdateId, true, false, false, observedAt, receivedAt);
      }
      tx.update("devices", iPhone.deviceInstanceId, draft => { draft.lastSeenAt = receivedAt; });
      this.recordPositionReceiptInTransaction(
        tx, normalized.positionUpdateId, iPhone.deviceInstanceId, undefined, "R",
        updateFingerprint, receivedAt, position);
      const updates: RecruitmentUpdate[] = [];
      // The probe chooses whether to refresh, not which events to refresh. Preserve
      // the old relevant branch's all-ACTIVE+RECRUITING scope with one Tx context.
      if (position.applied && relevantEventIds.length > 0) {
        recruitmentRan = true;
        const positions = this.store.devicePositions?.();
        const deliveries = this.store.deliveryIndex?.();
        const assignments = this.store.assignmentIndex?.();
        const projections = this.store.projections?.();
        const ctx = txRecruitmentContext(tx, {
          devicePositions: positions,
          deliveryIdsForEvent: deliveries
            ? id => [...deliveries.deliveryIdsForEvent(id)] : undefined,
          assignmentIdsForDevice: assignments
            ? id => [...assignments.assignmentIdsForDevice(id)] : undefined,
          deviceIdsForIdentity: assignments
            ? key => [...assignments.deviceIdsForIdentity(key)] : undefined,
          deviceOrdinal: assignments ? key => assignments.deviceOrdinal(key) : undefined,
          activeEventIds: projections ? () => [...(projections.readGrouped("entity:events:state").get("ACTIVE")?.keys() ?? [])] : undefined
        });
        const aed = txCoordinationAedReader(tx, {
          receiptIdsForEvent: projections ? receiptIdsForEventFrom(this.store) : undefined
        });
        const candidateEventIds = new Set(projections
          ? projections.read(ACTIVE_RECRUITING_EVENTS).keys()
          : tx.keysWhere("events", event => event.state === "ACTIVE"
            && event.recruitmentState === "RECRUITING", Number.MAX_SAFE_INTEGER));
        for (const key of tx.stagedKeys("events")) candidateEventIds.add(key);
        for (const eventId of candidateEventIds) {
          const event = tx.get("events", eventId);
          if (!event || event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") continue;
          const refreshed = this.refreshRecruitmentForEvent(ctx, event, this.now());
          if (refreshed.changed) {
            updates.push(this.recruitmentUpdate(ctx, aed, refreshed.event,
              refreshed.requests, refreshed.previousAudience, refreshed.expiredOffers));
          }
        }
      }
      return { position, updates };
    });
    if (recruitmentRan) operationMetrics.indexedRecruitmentRuns += 1;
    return this.finishResponderPosition(incremental, iPhone.deviceInstanceId, receivedAt, operationStart);
  }

  /** Shared post-transaction tail for both responder-position appliers. */
  private async finishResponderPosition(
    result: { position: PositionUpdateResult; updates: RecruitmentUpdate[] },
    deviceInstanceId: string,
    receivedAt: string,
    operationStart: number
  ): Promise<PositionUpdateResult> {
    const drainStart = performance.now();
    await this.notificationOutbox.drain();
    const drainEnd = performance.now();
    operationMetrics.notificationDrainMs += drainEnd - drainStart;
    this.publishRecruitmentUpdates(result.updates, receivedAt);
    operationMetrics.recruitmentPublishMs += performance.now() - drainEnd;
    // Post-transaction scope: everything from here until the result is built.
    const responseStart = performance.now();
    const response = {
      ...result.position,
      positioningTier: readState(this.store, state => {
        const device = state.devices[deviceInstanceId];
        return device ? this.presenceView(state, device, this.now()).positioningTier : "STANDBY";
      })
    };
    operationMetrics.responseMs += performance.now() - responseStart;
    const elapsed = performance.now() - operationStart;
    operationMetrics.operationElapsedMs += elapsed;
    // Residual after every measured segment.  Reported, never absorbed elsewhere.
    // Subtract the store's own contribution too: the transaction's queue wait and
    // service time sit between the pre-transaction segment and the drain.  Without
    // this the residual would simply report transaction time under a wrong name.
    operationMetrics.unattributedMs += Math.max(0, elapsed
      - operationMetrics.preTransactionMs
      - storageMetrics.lastTransactionQueueWaitMs - storageMetrics.lastTransactionServiceMs
      - operationMetrics.notificationDrainMs
      - operationMetrics.recruitmentPublishMs - operationMetrics.responseMs);
    return response;
  }

  async updatePatientPosition(
    principal: Principal,
    eventId: string,
    update: PatientPositionUpdate
  ): Promise<PositionUpdateResult> {
    const iPhone = requireIPhoneScope(principal, "position:write");
    this.enforcePositionWriteCircuit(iPhone.deviceInstanceId);
    const observedAt = this.validateClientTime(update.observedAt, "observedAt");
    const normalized = { ...update, observedAt };
    const updateFingerprint = fingerprint({
      deviceInstanceId: iPhone.deviceInstanceId,
      eventId,
      kind: "P",
      ...normalized
    });
    const receivedAt = this.now().toISOString();
    const result = await transactState(this.store, (state) => {
      let event = state.events[eventId];
      const device = state.devices[iPhone.deviceInstanceId];
      if (!event) throw notFound("Event does not exist");
      if (!device || !event.patientDeviceIds.includes(device.deviceInstanceId)) {
        throw forbidden("Only the associated patient iPhone can publish P position");
      }
      const incomingSampleIsFresh = this.patientPositionSampleIsFresh(
        normalized.patientPosition,
        observedAt,
        this.now()
      );
      const replay = this.positionReplay(
        state,
        normalized.positionUpdateId,
        device.deviceInstanceId,
        eventId,
        "P",
        updateFingerprint
      );
      if (replay) {
        device.lastSeenAt = receivedAt;
        const restoration = this.restoreStoredIPhonePrimaryIfEligible(
          state,
          event,
          device,
          incomingSampleIsFresh,
          receivedAt
        );
        return {
          position: replay,
          update: restoration.update,
          assignmentEmissions: restoration.assignmentEmissions
        };
      }
      if (event.state !== "ACTIVE") throw conflict("Patient position requires an active event");
      if (!hasAllBootstrapAgreements(device) || !device.capabilities.locationAuthorized) {
        throw forbidden("Patient agreement and location capability are required");
      }

      const current = event.iphonePatientPosition;
      let position: PositionUpdateResult;
      let applied = false;
      if (!incomingSampleIsFresh) {
        position = this.positionResult(normalized.positionUpdateId, false, false, true, observedAt, receivedAt);
      } else if (current && observedAt < current.observedAt) {
        position = this.positionResult(normalized.positionUpdateId, false, false, true, observedAt, receivedAt);
      } else if (current && observedAt === current.observedAt) {
        if (fingerprint(current.position) !== fingerprint(normalized.patientPosition)) {
          throw conflict("Patient position conflicts at the same observedAt timestamp");
        }
        position = this.positionResult(
          normalized.positionUpdateId,
          false,
          true,
          false,
          observedAt,
          current.serverReceivedAt
        );
      } else {
        const sample = {
          positionUpdateId: normalized.positionUpdateId,
          source: "IPHONE_PRIMARY" as const,
          position: normalized.patientPosition,
          observedAt,
          serverReceivedAt: receivedAt
        };
        event.iphonePatientPosition = sample;
        event.patientPosition = sample;
        delete event.watchFallbackCandidate;
        device.latestPosition = {
          positionUpdateId: normalized.positionUpdateId,
          position: normalized.patientPosition,
          eventId,
          observedAt,
          serverReceivedAt: receivedAt
        };
        device.currentEventId = eventId;
        delete device.currentAssignmentId;
        appendTimeline(
          state,
          eventId,
          receivedAt,
          "PATIENT_POSITION_UPDATED",
          `iPhone primary position ${normalized.positionUpdateId} became the effective P sample.`
        );
        position = this.positionResult(normalized.positionUpdateId, true, false, false, observedAt, receivedAt);
        applied = true;
      }
      device.lastSeenAt = receivedAt;
      this.recordPositionReceipt(
        state,
        normalized.positionUpdateId,
        device.deviceInstanceId,
        eventId,
        "P",
        updateFingerprint,
        receivedAt,
        position
      );
      if (!applied) {
        const restoration = this.restoreStoredIPhonePrimaryIfEligible(
          state,
          event,
          device,
          incomingSampleIsFresh,
          receivedAt
        );
        return {
          position,
          update: restoration.update,
          assignmentEmissions: restoration.assignmentEmissions
        };
      }

      const assignmentEmissions = this.refreshPatientRoutes(state, event, this.now());
      const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, this.now(), true);
      event = refreshed.event;
      const update = this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
        refreshed.requests,
        refreshed.previousAudience,
        refreshed.expiredOffers
      );
      this.enqueuePatientPositionNotification(
        state,
        event,
        update.audience,
        update.coordination.revision,
        receivedAt
      );
      return {
        position,
        update,
        assignmentEmissions
      };
    });
    await this.publishPatientPositionChange(
      eventId,
      receivedAt,
      result.update
    );
    return result.position;
  }

  async recordDeliveryReceipt(
    principal: Principal,
    eventId: string,
    deliveryId: string,
    status: DeliveryStatus,
    occurredAt: string
  ): Promise<void> {
    const iPhone = requireIPhoneScope(principal, "responses:write");
    const serverReceivedAt = this.now();
    const claimedOccurredAt = this.validateActionTime(
      occurredAt,
      "occurredAt",
      serverReceivedAt
    );
    const result = await transactState(this.store, (state) => {
      const delivery = state.deliveries[deliveryId];
      if (!delivery || delivery.eventId !== eventId
        || delivery.deviceInstanceId !== iPhone.deviceInstanceId) {
        throw notFound("Response-request delivery is not visible to this device");
      }
      this.markDeviceSeen(state, iPhone.deviceInstanceId, serverReceivedAt.toISOString());
      let event = state.events[eventId];
      if (event && iPhone.userId && event.exitedResponderUserIds?.includes(iPhone.userId)) {
        throw forbidden("An exited responder has no event communication permission");
      }
      const now = serverReceivedAt;
      if (event && pendingDeliveryStatuses.includes(delivery.status)
        && !deliveryIsLive(delivery, now)) {
        delivery.status = "EXPIRED";
        delivery.statusOccurredAt = now.toISOString();
        appendTimeline(
          state,
          eventId,
          now.toISOString(),
          "PASSIVE_OBSERVATION",
          `Response delivery ${delivery.id} expired after its 30-second offer window.`
        );
        const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, now);
        event = refreshed.event;
        event.coordinationRevision += 1;
        return {
          occurredAt: now.toISOString(),
          update: this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
            refreshed.requests,
            refreshed.previousAudience,
            refreshed.expiredOffers
          )
        };
      }
      if (delivery.status === status) return {
        occurredAt: delivery.statusOccurredAt,
        update: undefined as RecruitmentUpdate | undefined
      };
      if (["ACCEPTED", "REFUSED", "EXPIRED"].includes(delivery.status)
        && ["SENT", "DELIVERED", "VIEWED"].includes(status)) {
        return {
          occurredAt: delivery.statusOccurredAt,
          update: undefined as RecruitmentUpdate | undefined
        };
      }
      const allowed = (delivery.status === "SENT" && status === "DELIVERED")
        || (delivery.status === "DELIVERED" && status === "VIEWED");
      if (!allowed) {
        throw conflict(`Delivery receipt cannot advance from ${delivery.status} to ${status}`);
      }
      const deliveryCausalLowerBoundAt = Date.parse(delivery.statusOccurredAt)
        > Date.parse(delivery.request.occurredAt)
        ? delivery.statusOccurredAt
        : delivery.request.occurredAt;
      const effectiveOccurredAt = this.effectiveActionTime(
        claimedOccurredAt,
        "occurredAt",
        deliveryCausalLowerBoundAt,
        "response request/current delivery time",
        serverReceivedAt
      );
      delivery.status = status;
      delivery.statusOccurredAt = effectiveOccurredAt;
      appendTimeline(
        state,
        eventId,
        effectiveOccurredAt,
        "RECEIPT_ADVANCED",
        `Delivery ${deliveryId} advanced to ${status}.`
      );
      if (!event) return {
        occurredAt: effectiveOccurredAt,
        update: undefined as RecruitmentUpdate | undefined
      };
      event.coordinationRevision += 1;
      const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, this.now());
      event = refreshed.event;
      return {
        occurredAt: effectiveOccurredAt,
        update: this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
          refreshed.requests,
          refreshed.previousAudience,
          refreshed.expiredOffers
        )
      };
    });
    if (result.update) {
      await this.notificationOutbox.drain();
      this.publishRecruitmentUpdates([result.update], result.occurredAt);
    }
  }

  async respond(
    principal: Principal,
    eventId: string,
    deliveryId: string,
    decision: ResponderDecision
  ): Promise<{ decision: "ACCEPT" | "REFUSE"; assignment: AssignmentView | null }> {
    const iPhone = requireIPhoneScope(principal, "responses:write");
    if (this.routeProvider.prepare && decision.decision === "ACCEPT") {
      const eligible = readState(this.store, state => {
        const delivery = state.deliveries[deliveryId];
        return delivery?.deviceInstanceId === iPhone.deviceInstanceId && delivery.eventId === eventId;
      });
      if (eligible) await this.prepareEventRoutes(eventId, iPhone.deviceInstanceId);
      this.identityAccess.assertCurrent(iPhone);
    }
    const result = await runResponseDecision(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        markDeviceSeen: (state, deviceInstanceId, at) =>
          this.markDeviceSeen(state, deviceInstanceId, at),
        ensureParticipantInterval: (state, acceptedEventID, userID, deviceInstanceID, acceptedAt) =>
          this.ensureParticipantInterval(
            state,
            acceptedEventID,
            userID,
            deviceInstanceID,
            acceptedAt
          ),
        isEligibleNearbyResponder: (state, event, device, now) =>
          this.isEligibleNearbyResponder(this.recruitmentContext(state), event, device, now),
        participantDeviceIds,
        replanAssignments: (state, event, at) => this.replanAssignments(state, event, at),
        refreshRecruitmentForEvent: (state, event, now) =>
          this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, now),
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueDecisionNotification: (state, event, deliveryId, decision, occurredAt, audience, coordination) =>
          this.enqueueResponseDecisionNotifications(
            state, event, deliveryId, decision, occurredAt, audience, coordination
          ),
        enqueueAssignmentEmissions: (state, event, emissions) =>
          this.enqueueAssignmentEmissions(state, event, emissions)
      },
      iPhone,
      eventId,
      deliveryId,
      decision
    );

    if (result.update) {
      await this.notificationOutbox.drain();
      this.publishRecruitmentUpdates([result.update], result.decidedAt);
    }
    if (result.rejectedReason) throw conflict(result.rejectedReason);
    return { decision: result.decision, assignment: result.assignment };
  }

  async updateAssignmentStatus(
    principal: Principal,
    eventId: string,
    assignmentId: string,
    status: AssignmentStatus,
    occurredAt: string
  ): Promise<AssignmentView> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const result = await runAssignmentStatusUpdate(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        markDeviceSeen: (state, deviceInstanceId, at) =>
          this.markDeviceSeen(state, deviceInstanceId, at),
        allCurrentAssignmentsCompleted: (state, pathEventID) =>
          this.allCurrentAssignmentsCompleted(state, pathEventID),
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueAssignmentNotification: (state, event, deviceInstanceId, assignment, occurredAt) =>
          this.enqueueAssignmentUpdatedNotification(
            state, event, deviceInstanceId, assignment, occurredAt
          )
      },
      iPhone,
      eventId,
      assignmentId,
      status,
      occurredAt
    );
    if (result.changed) {
      await this.notificationOutbox.drain();
      if (result.update) this.publishRecruitmentUpdates([result.update], result.occurredAt);
    }
    return result.view;
  }

  async acquireAed(
    principal: Principal,
    eventId: string,
    assignmentId: string,
    receipt: AedAcquiredReceipt
  ): Promise<{ created: boolean; receipt: AedAcquiredReceipt }> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const result = await runAcquireAed(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        markDeviceSeen: (state, deviceInstanceId, at) =>
          this.markDeviceSeen(state, deviceInstanceId, at),
        participantDeviceIds,
        currentResponderPosition,
        currentPatientPosition,
        routeProvider: this.routeProvider,
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueAssignmentEmissions: (state, event, emissions) =>
          this.enqueueAssignmentEmissions(state, event, emissions),
        enqueueAedAcquiredNotification: (state, event, deviceIds, acquiredReceipt) =>
          this.enqueueAedAcquiredNotification(state, event, deviceIds, acquiredReceipt),
        enqueueAedUnavailableNotification: (
          state, event, deviceIds, unavailableAssignmentId, aedId, occurredAt,
          messageDiscriminator
        ) => this.enqueueAedUnavailableNotification(
          state,
          event,
          deviceIds,
          unavailableAssignmentId,
          aedId,
          occurredAt,
          messageDiscriminator
        )
      },
      iPhone,
      eventId,
      assignmentId,
      receipt
    );
    if (result.created) {
      await this.notificationOutbox.drain();
      if (result.update) {
        this.publishRecruitmentUpdates([result.update], result.receipt.acquiredAt);
      }
    }
    return { created: result.created, receipt: result.receipt };
  }

  async reportAedUnavailable(
    principal: Principal,
    eventId: string,
    assignmentId: string,
    report: AedUnavailableReport
  ): Promise<{ created: boolean; report: AedUnavailableReport }> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const result = await runReportAedUnavailable(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        markDeviceSeen: (state, deviceInstanceId, at) =>
          this.markDeviceSeen(state, deviceInstanceId, at),
        participantDeviceIds,
        currentResponderPosition,
        currentPatientPosition,
        routeProvider: this.routeProvider,
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueAssignmentEmissions: (state, event, emissions) =>
          this.enqueueAssignmentEmissions(state, event, emissions),
        enqueueAedAcquiredNotification: (state, event, deviceIds, acquiredReceipt) =>
          this.enqueueAedAcquiredNotification(state, event, deviceIds, acquiredReceipt),
        enqueueAedUnavailableNotification: (
          state, event, deviceIds, unavailableAssignmentId, aedId, occurredAt,
          messageDiscriminator
        ) => this.enqueueAedUnavailableNotification(
          state,
          event,
          deviceIds,
          unavailableAssignmentId,
          aedId,
          occurredAt,
          messageDiscriminator
        )
      },
      iPhone,
      eventId,
      assignmentId,
      report
    );
    if (result.created) {
      await this.notificationOutbox.drain();
      if (result.update) {
        this.publishRecruitmentUpdates([result.update], result.report.reportedAt);
      }
    }
    return { created: result.created, report: result.report };
  }

  /** Canonical patient end action: one confirmation maps to one terminal state. */
  async endEvent(
    principal: Principal,
    eventId: string,
    request: EventEndRequest
  ): Promise<EmergencyEventView> {
    return this.resolveEvent(principal, eventId, {
      resolutionId: request.resolutionId,
      actor: "PATIENT",
      reason: request.reason,
      ...(request.withdrawalConfirmed ? { withdrawalConfirmed: true as const } : {}),
      resolvedAt: request.endedAt,
      ...(request.note === undefined ? {} : { note: request.note })
    });
  }

  /**
   * Removes an accepted responder from this event immediately. The stable
   * user identity is retained on the event so another device cannot re-enter.
   */
  async exitEvent(
    principal: Principal,
    eventId: string,
    request: ParticipantExitRequest
  ): Promise<ParticipantExitResult> {
    const iPhone = requireIPhoneScope(principal, "responses:write");
    const result = await runResponderExit(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        acceptedDeviceIds: (state, eventID) =>
          acceptedDeviceIds(recruitmentContextFor(state), eventID),
        participantIntervalForDevice,
        endParticipantInterval: (state, pathEventID, userID, deviceInstanceID, endedAt, reason) =>
          this.endParticipantInterval(
            state,
            pathEventID,
            userID,
            deviceInstanceID,
            endedAt,
            reason
          ),
        hasCurrentPatientPosition: currentPatientPosition,
        coordinationAudienceDeviceIds: (state, event) =>
          coordinationAudienceDeviceIds(recruitmentContextFor(state), event),
        replanAssignments: (state, event, at) => this.replanAssignments(state, event, at),
        refreshRecruitmentForEvent: (state, event, now, forceRevision) =>
          this.refreshRecruitmentForEvent(
            this.recruitmentContext(state), event, now, forceRevision),
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueAssignmentEmissions: (state, event, emissions) =>
          this.enqueueAssignmentEmissions(state, event, emissions),
        enqueueParticipantExitNotification: (
          state, event, deviceIds, exitId, occurredAt, coordinationRevision
        ) => this.enqueueParticipantExitNotification(
          state,
          event,
          deviceIds,
          exitId,
          occurredAt,
          coordinationRevision
        ),
        recruitmentTargetAccepted: RECRUITMENT_TARGET_ACCEPTED
      },
      iPhone,
      eventId,
      request
    );
    if (result.changed) {
      // G09: a responder who leaves while holding an acquired AED cannot complete
      // a handover, so the open handover is halted — but the DEVICE IS NOT
      // RELEASED.  The frozen rule is that an exited responder still has the
      // physical device, so the asset moves to AWAITING_RETURN and stays occupied
      // until an explicit verified return.  Releasing it here would send the next
      // responder to an empty cabinet.
      await transactState(this.store, (state) => {
        const view = this.handoverStoreView(state);
        const exitedUserId = iPhone.userId;
        for (const handover of view.allHandovers()) {
          if (handover.eventId !== eventId) continue;
          if (handover.status !== "PENDING" && handover.status !== "CONFIRMED") continue;
          if (exitedUserId === undefined || handover.holderUserId !== exitedUserId) continue;
          haltHandoverForExitedHolder(
            view,
            handover.handoverId,
            "RESPONDER_EXIT",
            typeof result.ack.exitedAt === "string" ? result.ack.exitedAt : this.now().toISOString()
          );
          appendTimeline(
            state,
            eventId,
            typeof result.ack.exitedAt === "string" ? result.ack.exitedAt : this.now().toISOString(),
            "PASSIVE_OBSERVATION",
            `AED ${handover.aedId} handover halted because its holder exited; the device stays occupied as event evidence.`
          );
        }
      });
      await this.notificationOutbox.drain();
      if (result.update) this.publishRecruitmentUpdates([result.update], result.ack.exitedAt);
      // The exit ACK carries the exclusive end of this participant's window, so
      // their missing seconds become a verdict now.  The event itself may still be
      // running, so only this participant's window closes here.
      await this.reconcilePositionWindows({ eventId, closedBy: "PARTICIPANT_EXIT" });
    }
    return result.ack;
  }

  async confirmFalseAlarm(principal: Principal, eventId: string): Promise<EmergencyEventView> {
    const iPhone = requireIPhoneScope(principal, "events:write");
    const result = await runFalseAlarmConfirmation(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        requireIPhone,
        authorizeResolution: (state, event, actionPrincipal, actor) =>
          this.authorizeResolution(state, event, actionPrincipal, actor),
        isPatientDevice,
        markDeviceSeen: (state, deviceInstanceId, at) =>
          this.markDeviceSeen(state, deviceInstanceId, at),
        coordinationAudienceDeviceIds: (state, event) =>
          coordinationAudienceDeviceIds(recruitmentContextFor(state), event),
        affectedDeviceIds,
        eventProjection: (state, event, actionPrincipal, coordination, includeSensitive, now) =>
          actionPrincipal.kind === "DEVICE"
            ? eventProjection(state, event, actionPrincipal, coordination, includeSensitive, now)
            : undefined,
        operatorProjection,
        coordinationSummary: (state, event, now) =>
          this.coordinationSummary(this.recruitmentContext(state), legacyCoordinationAedReader(state), event, now),
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueTerminalNotifications: (state, event, messageId, devices, update) =>
          this.enqueueTerminalNotifications(state, event, messageId, devices, update)
      },
      iPhone,
      eventId,
      this.now().toISOString()
    );
    await this.notificationOutbox.drain();
    return result;
  }

  async resolveEvent(
    principal: Principal,
    eventId: string,
    request: ResolutionRequest
  ): Promise<EmergencyEventView> {
    if (principal.kind === "ACCOUNT") {
      throw forbidden("Account session cannot perform device business actions");
    }
    if (principal.kind === "DEVICE") {
      requireIPhoneScope(principal, "events:write");
    }
    const result = await runEventResolution(
      {
        store: this.store,
        now: this.now,
        validateActionTime: (value, field, serverReceivedAt) =>
          this.validateActionTime(value, field, serverReceivedAt),
        effectiveActionTime: (
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ) => this.effectiveActionTime(
          claimedAt,
          field,
          causalLowerBoundAt,
          causalLowerBoundField,
          serverReceivedAt,
          causalPolicy
        ),
        requireIPhone,
        authorizeResolution: (state, event, actionPrincipal, actor) =>
          this.authorizeResolution(state, event, actionPrincipal, actor),
        isPatientDevice,
        markDeviceSeen: (state, deviceInstanceId, at) =>
          this.markDeviceSeen(state, deviceInstanceId, at),
        coordinationAudienceDeviceIds: (state, event) =>
          coordinationAudienceDeviceIds(recruitmentContextFor(state), event),
        affectedDeviceIds,
        eventProjection: (state, event, actionPrincipal, coordination, includeSensitive, now) =>
          actionPrincipal.kind === "DEVICE"
            ? eventProjection(state, event, actionPrincipal, coordination, includeSensitive, now)
            : undefined,
        operatorProjection,
        coordinationSummary: (state, event, now) =>
          this.coordinationSummary(this.recruitmentContext(state), legacyCoordinationAedReader(state), event, now),
        recruitmentUpdate: (state, event, requests, extraAudience, expiredOffers) =>
          this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, requests, extraAudience, expiredOffers),
        enqueueTerminalNotifications: (state, event, messageId, devices, update) =>
          this.enqueueTerminalNotifications(state, event, messageId, devices, update)
      },
      principal,
      eventId,
      request
    );
    if (!result.view) throw forbidden("Event is not visible to this session");
    // The event terminal time closes every open participation window, so this is
    // the moment a missing second becomes a verdict instead of a pending upload.
    // It runs after the terminal transaction commits, so it audits what is
    // actually durable rather than what happened to be in the draft.
    // Deliver already-committed terminal notifications before historical audit work.
    await this.notificationOutbox.drain();
    if (result.view.state !== "ACTIVE") {
      await this.reconcilePositionWindows({ eventId, closedBy: "EVENT_TERMINAL" });
    }
    return result.view;
  }

  // ------------------------------------------------------------------
  // G09 — AED handover, temporary placement point and its media
  //
  // Every entry point below is scoped to one event and refuses anyone who is not
  // a participant of that event's coordination, because a handover is between two
  // people who are both responding to the same emergency.
  // ------------------------------------------------------------------

  /** Whether this device may see the coordination of this event at all. */
  private requireEventParticipant(
    state: Readonly<PersistentState>,
    device: DevicePrincipal,
    eventId: string
  ): EventRecord {
    const event = state.events[eventId];
    if (!event) throw notFound("Event does not exist");
    const visible = visibleEventCandidates(state, device).some(candidate => candidate.id === eventId);
    if (!visible) throw forbidden("Event is not visible to this session");
    return event;
  }

  private handoverStoreView(state: PersistentState): HandoverStoreView {
    return handoverViewOver(state as unknown as Parameters<typeof handoverViewOver>[0]);
  }

  /**
   * Opens a handover for an AED this device currently holds.
   *
   * The holder is derived from the asset's own custody fact, never from the
   * request body: a client cannot claim to hold a device the server does not
   * believe it holds.
   */
  async openAedHandover(
    principal: Principal,
    eventId: string,
    request: AedHandoverRequest
  ): Promise<AedHandoverRecord> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const at = this.now();
    const result = await transactState(this.store, (state) => {
      const event = this.requireEventParticipant(state, iPhone, eventId);
      const assignment = state.assignments[request.assignmentId];
      if (!assignment || assignment.eventId !== eventId) {
        throw notFound("Assignment does not exist in this event");
      }
      const asset = state.aedAssetsById[request.aedId];
      if (!asset) throw notFound("AED asset is not registered");
      // Only the device that took the device may open its handover.  A holder who
      // left the event cannot hand anything over, by design.
      if (asset.custody?.deviceInstanceId !== iPhone.deviceInstanceId
        && !(iPhone.userId !== undefined && asset.custody?.userId === iPhone.userId)) {
        throw conflict("Only the current holder may open a handover for this AED");
      }
      // G09 + the frozen rule: a responder who left the event can no longer hand
      // anything over, because they are no longer a participant. The DEVICE is
      // untouched by the exit — it stays occupied and moves to AWAITING_RETURN via
      // the exit path, so an exited holder is refused here rather than silently
      // releasing the AED.
      if (iPhone.userId !== undefined
        && event.exitedResponderUserIds?.includes(iPhone.userId)) {
        throw conflict("An exited responder cannot hand over an AED");
      }
      const handover = openHandover(this.handoverStoreView(state), {
        handoverId: randomUUID(),
        request,
        holderDeviceInstanceId: asset.custody.deviceInstanceId ?? iPhone.deviceInstanceId,
        ...(asset.custody.userId ? { holderUserId: asset.custody.userId } : {}),
        acquiredAt: asset.custody.acquiredAt!,
        initiatedAt: at.toISOString()
      });
      appendTimeline(
        state,
        eventId,
        handover.initiatedAt,
        "PASSIVE_OBSERVATION",
        `AED ${handover.aedId} handover opened (${handover.mode}); the device stays occupied until both sides confirm.`
      );
      return handover;
    });
    return result;
  }

  /** One side confirms once.  Completion needs both. */
  async confirmAedHandover(
    principal: Principal,
    eventId: string,
    handoverId: string,
    request: AedHandoverConfirmationRequest
  ): Promise<AedHandoverRecord> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const at = this.now();
    return transactState(this.store, (state) => {
      this.requireEventParticipant(state, iPhone, eventId);
      const outcome = confirmHandover(this.handoverStoreView(state), handoverId, request, {
        eventId,
        actorDeviceInstanceId: iPhone.deviceInstanceId,
        ...(iPhone.userId ? { actorUserId: iPhone.userId } : {}),
        now: at
      });
      const handover = outcome.handover;
      if (outcome.applied) {
        appendTimeline(
          state,
          eventId,
          at.toISOString(),
          "PASSIVE_OBSERVATION",
          `AED ${handover.aedId} handover ${request.side} confirmed; status ${handover.status}.`
        );
      }
      return handover;
    });
  }

  /**
   * Completes a face-to-face handover, or places the device at a temporary point.
   *
   * The temporary point requires both a fresh position and a valid photo
   * reference; with no private object store configured the whole request fails and
   * no placement, and therefore no dispatchable device, is created.
   */
  async settleAedHandover(
    principal: Principal,
    eventId: string,
    handoverId: string,
    request: AedHandoverSettlementRequest
  ): Promise<AedHandoverRecord> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const at = this.now();
    return transactState(this.store, async (state) => {
      this.requireEventParticipant(state, iPhone, eventId);
      const outcome = await settleHandover(
        this.handoverStoreView(state),
        this.objectStorage,
        handoverId,
        request,
        {
          eventId,
          actorDeviceInstanceId: iPhone.deviceInstanceId,
          ...(iPhone.userId ? { actorUserId: iPhone.userId } : {}),
          now: at
        },
        { depositId: randomUUID() }
      );
      appendTimeline(
        state,
        eventId,
        outcome.handover.settledAt ?? at.toISOString(),
        "PASSIVE_OBSERVATION",
        outcome.deposit
          ? `AED ${outcome.handover.aedId} placed at a temporary point ${outcome.deposit.depositId}; the device stays occupied at that point.`
          : `AED ${outcome.handover.aedId} handed over in person; custody moved to the receiving participant.`
      );
      return outcome.handover;
    });
  }

  /** The placement point a participant of this event may search for. */
  getAedTemporaryPoint(principal: Principal, eventId: string): AedTemporaryPointView {
    const iPhone = requireIPhoneScope(principal, "events:read");
    return readState(this.store, (state) => {
      this.requireEventParticipant(state, iPhone, eventId);
      const deposit = searchableDepositForEvent(this.handoverStoreView(state), eventId);
      if (!deposit) throw notFound("This event has no outstanding temporary AED point");
      return {
        depositId: deposit.depositId,
        eventId: deposit.eventId,
        aedId: deposit.aedId,
        status: deposit.status,
        position: deposit.position,
        positionObservedAt: deposit.positionObservedAt,
        depositedAt: deposit.depositedAt,
        photoReceived: true
      };
    });
  }

  /** The later responder reports what they found at the temporary point. */
  async reportAedTemporaryPointFollowUp(
    principal: Principal,
    eventId: string,
    depositId: string,
    request: AedTemporaryPointFollowUpRequest
  ): Promise<AedTemporaryPointFollowUpRecord> {
    const iPhone = requireIPhoneScope(principal, "assignments:write");
    const at = this.now();
    return transactState(this.store, (state) => {
      this.requireEventParticipant(state, iPhone, eventId);
      const outcome = reportTemporaryPointFollowUp(
        this.handoverStoreView(state),
        depositId,
        request,
        {
          eventId,
          actorDeviceInstanceId: iPhone.deviceInstanceId,
          ...(iPhone.userId ? { actorUserId: iPhone.userId } : {}),
          now: at
        }
      );
      if (outcome.replayed) return outcome.followUp;
      appendTimeline(
        state,
        eventId,
        at.toISOString(),
        "PASSIVE_OBSERVATION",
        outcome.followUp.outcome === "FOUND"
          ? `Temporary AED point ${depositId} was found; custody moved to the finding responder.`
          : `Temporary AED point ${depositId} was not found; the AED asset is marked unavailable.`
      );
      return outcome.followUp;
    });
  }

  async updateAedAsset(principal: Principal, aedId: string, action: AedAssetAction) {
    if (principal.kind !== "OPERATOR") throw forbidden("Asset operations require the out-of-band operator credential");
    const at = this.now();
    return transactState(this.store, state => applyAssetAction(state, aedId, action, at));
  }

  listAeds(principal: Principal): Aed[] {
    const device = requireIPhoneScope(principal, "events:read");
    return readState(this.store, (state) => {
      const visible = visibleEventCandidates(state, device).some((event) => eventProjection(
        state,
        event,
        device,
        this.coordinationSummary(this.recruitmentContext(state), legacyCoordinationAedReader(state), event, this.now()),
        false,
        this.now()
      ));
      if (!visible) throw forbidden("AED inventory is limited to visible event participants");
      return routingAeds(state, this.now());
    });
  }

  async estimateAedRoute(
    principal: Principal,
    responderPosition: ResponderPosition,
    patientPosition: PatientPosition,
    at: string | undefined
  ) {
    this.listAeds(principal);
    if (this.routeProvider.prepare) {
      const aeds = readState(this.store, state => routingAeds(state, this.now()));
      await this.routeProvider.prepare({ responder: responderPosition, patient: patientPosition,
        aeds, unavailableAedIds: new Set(), at: at ? new Date(at) : this.now() });
      this.identityAccess.assertCurrent(principal);
    }
    return readState(this.store, (state) => {
      const result = this.routeProvider.bestRoute({
        responder: responderPosition,
        patient: patientPosition,
        aeds: routingAeds(state, this.now()),
        unavailableAedIds: new Set(),
        at: at ? new Date(at) : this.now()
      });
      if (result.kind === "UNAVAILABLE") {
        throw notFound("No open and available AED route exists");
      }
      return result.value;
    });
  }

  private enforceAuthRateLimit(key: string): void {
    const now = this.now().getTime();
    const current = this.authWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.authWindows.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.config.bootstrapLimitPerMinute) {
      throw tooManyRequests("Authentication rate limit exceeded");
    }
  }

  private subjectHash(provider: AccountProvider, subject: string): string {
    const pepper = this.config.authSubjectPepper;
    if (!pepper) throw authenticationUnavailable(provider);
    try {
      return providerSubjectHash(provider, subject, pepper);
    } catch {
      throw authenticationUnavailable(provider);
    }
  }

  private removeExpiredAuthState(state: PersistentState, nowMilliseconds: number): void {
    for (const [challengeId, challenge] of Object.entries(state.authChallengesById)) {
      if (Date.parse(challenge.expiresAt) <= nowMilliseconds) delete state.authChallengesById[challengeId];
    }
    for (const [hash, session] of Object.entries(state.sessionsByTokenHash)) {
      const retentionExpiry = session.refreshTokenHash && session.refreshExpiresAt
        ? session.refreshExpiresAt
        : session.expiresAt;
      if (Date.parse(retentionExpiry) <= nowMilliseconds) delete state.sessionsByTokenHash[hash];
    }
    for (const [ticketHash, ticket] of Object.entries(state.companionLinkTicketsByHash)) {
      if (Date.parse(ticket.expiresAt) <= nowMilliseconds) {
        delete state.companionLinkTicketsByHash[ticketHash];
      }
    }
  }

  /**
   * Exchanges the authorization code the app received and remembers the Apple
   * grant on the account.
   *
   * Called only when the client supplied a code AND a real Apple account port is
   * configured.  A failure here fails the login: continuing would create an
   * account whose Apple grant can never be revoked, which is precisely the state
   * Apple's deletion requirement exists to prevent.  With no port configured the
   * gap is recorded on the account instead of being silently accepted.
   */
  private async attachAppleGrant(
    accountId: string,
    authorizationCode: string,
    redirectUri: string | undefined
  ): Promise<void> {
    if (!this.appleAccount.isConfigured()) {
      operationMetrics.appleGrantExchangesSkipped += 1;
      return;
    }
    let exchange;
    try {
      exchange = await this.appleAccount.exchangeAuthorizationCode({
        authorizationCode,
        ...(redirectUri ? { redirectUri } : {})
      });
    } catch {
      operationMetrics.appleGrantExchangeFailures += 1;
      throw new HttpProblem(503, "Authentication unavailable",
        "Apple 授权码兑换失败；未创建可撤销凭据的会话，请重试。");
    }
    await transactState(this.store, (draft) => {
      const account = draft.accounts[accountId];
      if (!account) return;
      account.appleRefreshToken = exchange.refreshToken;
      delete account.appleTokenRevokedAt;
    });
    operationMetrics.appleGrantExchanges += 1;
  }

  /**
   * Revokes pending Apple grants.
   *
   * Runs from durable state, so a failed revocation is retried rather than lost:
   * the user's deletion request has already been accepted by the time this runs.
   * Apple answering "already invalid" is the desired end state and clears the
   * entry; only transport/5xx/429 failures keep it queued.
   */
  async revokePendingAppleTokens(): Promise<{ revoked: number; retried: number }> {
    if (!this.appleAccount.isConfigured()) return { revoked: 0, retried: 0 };
    const pending = readEntities(this.store, view =>
      view.select("appleRevocationsById", () => true, 50)) as unknown as AppleRevocationRecord[];
    let revoked = 0;
    let retried = 0;
    for (const entry of pending) {
      const outcome = await this.appleAccount.revokeToken(entry.refreshToken);
      const at = this.now().toISOString();
      if (outcome.status === "RETRY") {
        retried += 1;
        await transactState(this.store, (draft) => {
          const row = draft.appleRevocationsById[entry.accountId];
          if (!row) return;
          row.attempts += 1;
          row.lastAttemptAt = at;
          row.lastReason = outcome.reason;
        });
        operationMetrics.appleRevocationsRetried += 1;
        continue;
      }
      await transactState(this.store, (draft) => {
        delete draft.appleRevocationsById[entry.accountId];
        const account = draft.accounts[entry.accountId];
        if (account) account.appleTokenRevokedAt = at;
      });
      revoked += 1;
      operationMetrics.appleRevocations += 1;
    }
    return { revoked, retried };
  }

  private upsertAccount(
    state: PersistentState,
    provider: AccountProvider,
    subject: string,
    at: string
  ): AccountRecord {
    const subjectHash = this.subjectHash(provider, subject);
    const providerKey = `${provider}:${subjectHash}`;
    let accountId = state.accountIdByProviderKey[providerKey];
    if (!accountId) {
      accountId = Object.values(state.accounts).find((account) =>
        account.provider === provider && account.providerSubjectHash === subjectHash
      )?.accountId;
    }
    if (accountId) {
      const account = state.accounts[accountId];
      const user = account ? state.users[account.userId] : undefined;
      if (!account || !user || account.provider !== provider
        || account.providerSubjectHash !== subjectHash) {
        throw new HttpProblem(500, "Authentication state invalid", "Account identity state is inconsistent");
      }
      if (user.lifecycleState === "CLOSED") throw forbidden("账号已注销，不能继续使用原账号。");
      state.accountIdByProviderKey[providerKey] = account.accountId;
      account.lastLoginAt = at;
      user.updatedAt = at;
      return account;
    }

    const userId = randomUUID();
    const newAccountId = randomUUID();
    state.users[userId] = {
      lifecycleState: "ACTIVE",
      userId,
      createdAt: at,
      updatedAt: at
    };
    const account: AccountRecord = {
      accountId: newAccountId,
      userId,
      provider,
      providerSubjectHash: subjectHash,
      createdAt: at,
      lastLoginAt: at
    };
    state.accounts[newAccountId] = account;
    state.accountIdByProviderKey[providerKey] = newAccountId;
    return account;
  }

  private createDeviceSession(
    state: PersistentState,
    userId: string,
    accountId: string,
    deviceInstanceId: string,
    deviceKind: "IPHONE" | "WATCH",
    companionPairId: string,
    at: string,
    includeRefresh: boolean,
    refreshFamilyId: string = randomUUID(),
    refreshExpiresAtOverride?: string
  ): SessionBootstrapResult {
    if (state.users[userId]?.lifecycleState === "CLOSED") throw forbidden("Account is closed");
    if (state.devices[deviceInstanceId]) state.devices[deviceInstanceId]!.loginState = "SIGNED_IN";
    const rawToken = randomBytes(32).toString("base64url");
    const hashedToken = tokenHash(rawToken);
    const sessionId = randomUUID();
    const scopes = deviceKind === "WATCH"
      ? ["watch:report", "watch:fallback"]
      : [
        "events:read",
        "events:write",
        "responses:write",
        "position:write",
        "assignments:write"
      ];
    const expiresAt = new Date(
      Date.parse(at) + this.config.sessionTtlSeconds * 1_000
    ).toISOString();
    const rawRefreshToken = includeRefresh
      ? randomBytes(32).toString("base64url")
      : undefined;
    const refreshExpiresAt = includeRefresh
      ? refreshExpiresAtOverride ?? new Date(
        Date.parse(at) + REFRESH_TOKEN_TTL_SECONDS * 1_000
      ).toISOString()
      : undefined;
    const record: SessionRecord = {
      sessionId,
      tokenHash: hashedToken,
      sessionKind: "DEVICE",
      userId,
      accountId,
      deviceInstanceId,
      deviceKind,
      scopes,
      issuedAt: at,
      expiresAt,
      ...(includeRefresh && rawRefreshToken && refreshExpiresAt
        ? {
          refreshTokenHash: tokenHash(rawRefreshToken),
          refreshExpiresAt,
          refreshFamilyId
        }
        : {})
    };
    state.sessionsByTokenHash[hashedToken] = record;
    this.removeExpiredAuthState(state, Date.parse(at));
    return {
      sessionId,
      sessionToken: rawToken,
      expiresAt,
      scopes,
      userId,
      accountId,
      sessionKind: "DEVICE",
      ...(includeRefresh && rawRefreshToken
        ? { refreshToken: rawRefreshToken }
        : {})
    };
  }

  private createAccountSession(
    state: PersistentState,
    account: AccountRecord,
    at: string,
    refreshFamilyId: string = randomUUID(),
    refreshExpiresAtOverride?: string
  ): AuthSessionResult {
    const rawToken = randomBytes(32).toString("base64url");
    const hashedToken = tokenHash(rawToken);
    const rawRefreshToken = randomBytes(32).toString("base64url");
    const refreshTokenHash = tokenHash(rawRefreshToken);
    const sessionId = randomUUID();
    const refreshExpiresAt = refreshExpiresAtOverride ?? new Date(
      Date.parse(at) + REFRESH_TOKEN_TTL_SECONDS * 1_000
    ).toISOString();
    const expiresAt = new Date(
      Date.parse(at) + this.config.sessionTtlSeconds * 1_000
    ).toISOString();
    const scopes = [ACCOUNT_SESSION_SCOPE];
    const record: SessionRecord = {
      sessionId,
      tokenHash: hashedToken,
      sessionKind: "ACCOUNT",
      userId: account.userId,
      accountId: account.accountId,
      scopes,
      issuedAt: at,
      expiresAt,
      refreshTokenHash,
      refreshExpiresAt,
      refreshFamilyId
    };
    state.sessionsByTokenHash[hashedToken] = record;
    this.removeExpiredAuthState(state, Date.parse(at));
    return {
      provider: account.provider,
      userId: account.userId,
      accountId: account.accountId,
      sessionId,
      sessionToken: rawToken,
      refreshToken: rawRefreshToken,
      expiresAt,
      scopes
    };
  }

  private enforceBootstrapRateLimit(key: string): void {
    const now = this.now().getTime();
    const current = this.bootstrapWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.bootstrapWindows.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.config.bootstrapLimitPerMinute) {
      throw tooManyRequests("Session bootstrap rate limit exceeded");
    }
  }

  private watchFallbackSilenceElapsed(event: EventRecord, now: Date): boolean {
    return watchFallbackAllowedByServer(event, now);
  }

  private promoteWatchFallbackCandidate(
    state: PersistentState,
    event: EventRecord,
    candidate: WatchFallbackCandidateRecord,
    receivedAt: string
  ): CurrentPatientPosition {
    const sample: CurrentPatientPosition = {
      positionUpdateId: candidate.positionUpdateId,
      source: "WATCH_FALLBACK",
      position: candidate.position,
      observedAt: candidate.observedAt,
      serverReceivedAt: candidate.serverReceivedAt
    };
    event.watchFallbackPosition = sample;
    event.patientPosition = structuredClone(sample);
    delete event.watchFallbackCandidate;
    appendTimeline(
      state,
      event.id,
      receivedAt,
      "PATIENT_POSITION_UPDATED",
      `Watch fallback position ${candidate.positionUpdateId} became the effective P sample.`
    );
    return sample;
  }

  private recordWatchFallbackCadence(
    event: EventRecord,
    position: PatientPosition,
    positionUpdateId: string,
    observedAt: string,
    serverReceivedAt: string
  ): void {
    const previous = event.watchFallbackCadence;
    const previousObservedAt = previous ? Date.parse(previous.observedAt) : Number.NaN;
    const currentObservedAt = Date.parse(observedAt);
    const intervalSeconds = Number.isFinite(previousObservedAt) && Number.isFinite(currentObservedAt)
      ? Math.max(0, (currentObservedAt - previousObservedAt) / 1_000)
      : undefined;
    const distance = previous
      ? distanceMeters(previous.position, position)
      : undefined;
    event.watchFallbackCadence = {
      positionUpdateId,
      position: structuredClone(position),
      observedAt,
      serverReceivedAt,
      ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
      ...(distance === undefined ? {} : { distanceMeters: distance })
    };
  }

  private restoreStoredIPhonePrimaryIfEligible(
    state: PersistentState,
    event: EventRecord,
    device: DeviceRecord,
    incomingSampleIsFresh: boolean,
    receivedAt: string
  ): {
    update: RecruitmentUpdate | undefined;
    assignmentEmissions: AssignmentEmission[];
  } {
    const storedIPhonePosition = event.iphonePatientPosition;
    const now = new Date(receivedAt);
    if (!incomingSampleIsFresh
      || event.state !== "ACTIVE"
      || event.patientPosition?.source !== "WATCH_FALLBACK"
      || !hasAllBootstrapAgreements(device)
      || !device.capabilities.locationAuthorized
      || !storedIPhonePosition
      || !this.patientPositionSampleIsFresh(
        storedIPhonePosition.position,
        storedIPhonePosition.observedAt,
        now
      )) {
      return { update: undefined, assignmentEmissions: [] };
    }

    const reaffirmedIPhonePosition = {
      ...structuredClone(storedIPhonePosition),
      serverReceivedAt: receivedAt
    };
    event.iphonePatientPosition = reaffirmedIPhonePosition;
    event.patientPosition = structuredClone(reaffirmedIPhonePosition);
    delete event.watchFallbackCandidate;
    device.latestPosition = {
      positionUpdateId: storedIPhonePosition.positionUpdateId,
      position: structuredClone(storedIPhonePosition.position),
      eventId: event.id,
      observedAt: storedIPhonePosition.observedAt,
      serverReceivedAt: receivedAt
    };
    device.currentEventId = event.id;
    delete device.currentAssignmentId;
    appendTimeline(
      state,
      event.id,
      receivedAt,
      "PATIENT_POSITION_UPDATED",
      `Stored iPhone primary position ${storedIPhonePosition.positionUpdateId} was reaffirmed as effective P.`
    );
    const assignmentEmissions = this.refreshPatientRoutes(state, event, now);
    const refreshed = this.refreshRecruitmentForEvent(this.recruitmentContext(state), event, now, true);
    event = refreshed.event;
    const update = this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event,
      refreshed.requests,
      refreshed.previousAudience,
      refreshed.expiredOffers
    );
    this.enqueuePatientPositionNotification(
      state,
      event,
      update.audience,
      update.coordination.revision,
      receivedAt
    );
    return {
      update,
      assignmentEmissions
    };
  }

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

  /**
   * Is this standby position change capable of affecting any active recruitment?
   *
   * The predicate is evaluated against raw committed event records, so ended
   * events and their deliveries are never copied.  The scan still visits every
   * retained event; replacing that visit with an index over active recruiting
   * events is the remaining index work for this path.
   */
  private relevantRecruitingEventIds(
    deviceInstanceId: string,
    position: ResponderPosition
  ): string[] {
    void deviceInstanceId;
    const scanned = (): string[] => readEntities(this.store, view => view.keysWhere(
      "events",
      (event) => {
        if (event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") return false;
        const patientPosition = currentPatientPosition(event);
        if (!patientPosition) return true;
        return distanceMeters(position, patientPosition) <= event.currentRecruitmentRadiusMeters;
      },
      1
    ));
    const projections = this.store.projections?.();
    if (!projections) return scanned();

    // Index-backed: covers actively recruiting events only, so it does not grow
    // with ended events, and entries carry the patient position so irrelevant
    // events are rejected by arithmetic instead of being read.
    const indexed: string[] = [];
    for (const [eventId, entry] of projections.read<ActiveRecruitmentEntry>(
      ACTIVE_RECRUITING_EVENTS
    )) {
      if (!Number.isFinite(entry.latitude)
        || distanceMeters(position, { latitude: entry.latitude, longitude: entry.longitude })
          <= entry.radiusMeters) {
        indexed.push(eventId);
        break;
      }
    }

    // Temporary equivalence net.  The projection decides whether recruitment is
    // refreshed at all, so a stale entry would silently skip a real update.
    // Development and test runs compare it against a direct scan and fail loudly.
    if (isShadowValidationEnabled()) {
      const reference = scanned();
      if ((reference.length > 0) !== (indexed.length > 0)) {
        throw new Error(
          "active recruitment projection disagrees with a direct scan "
          + `(indexed=${indexed.length} scanned=${reference.length})`
        );
      }
    }
    return indexed;
  }

  /**
   * Deliveries of one event, via the index when the store maintains one.  Falls
   * back to a whole-collection scan for stores without projection support.
   */
  private deliveriesOfEvent(eventId: string): readonly DeliveryRecord[] {
    const projections = this.store.projections?.();
    if (!projections) {
      // No index available: callers then fall back to the whole-collection filter.
      throw new Error("delivery index unavailable");
    }
    const group = projections.readGrouped<DeliveryRecord>(DELIVERIES_BY_EVENT).get(eventId);
    return group ? [...group.values()] : [];
  }

  /** Reads the request's own draft; structural indexes are overlaid by that draft. */
  private recruitmentContext(state: Readonly<PresenceState>): DraftRecruitmentContext {
    return draftRecruitmentContext(state);
  }

  /** Creation and refresh share the same transaction-aware candidate source. */
  private eventCreationRecruitmentContext(state: Readonly<PresenceState>): DraftRecruitmentContext {
    return this.recruitmentContext(state);
  }

  /**
   * Committed-state variant, for read-only callers only (presence view, position
   * reclamation).  Never call this inside a transaction whose own writes it must
   * observe — use `recruitmentContext` and let it read the draft instead.
   */
  private committedRecruitmentContext(
    state: Readonly<PresenceState>
  ): CommittedRecruitmentContext {
    if (stateAccess(state)) {
      return { ...draftRecruitmentContext(state), mode: "committed" };
    }
    const indexed = this.acceptedDeviceLookup();
    return committedRecruitmentContext(state, {
      // Without projection support this scans the committed state object instead.
      // The semantics are unchanged — `state` here is the committed view and never
      // a transaction draft, which is the only thing "committed" asserts; only the
      // access path differs.  (Falling through to `this.deliveriesOfEvent` would
      // throw: it reports a missing index rather than degrading.)
      deliveriesOfEvent: indexed ?? (eventId => Object.values(state.deliveries)
        .filter(delivery => delivery.eventId === eventId))
    });
  }

  /** Undefined when the store has no projection support, so the scan is used. */
  private acceptedDeviceLookup(): ((eventId: string) => readonly DeliveryRecord[]) | undefined {
    if (!this.store.projections?.()) return undefined;
    return eventId => {
      const indexed = this.deliveriesOfEvent(eventId);
      // Temporary equivalence net: this index feeds positioningTier, so a stale
      // group would change what the client is shown.  Development and test runs
      // compare against a direct scan and fail loudly.
      if (isShadowValidationEnabled()) {
        const scanned = readEntities(this.store, view =>
          view.select("deliveries", candidate => candidate.eventId === eventId,
            Number.MAX_SAFE_INTEGER));
        const sameSet = indexed.length === scanned.length
          && indexed.every(delivery => scanned.some(other => other.id === delivery.id));
        if (!sameSet) {
          throw new Error(
            "delivery index disagrees with a direct scan "
            + `(indexed=${indexed.length} scanned=${scanned.length})`
          );
        }
      }
      return indexed;
    };
  }

  /** Patient-only check: an active patient may not also publish an R position. */
  /**
   * The eligibility predicate, evaluated against the transaction's own view.
   *
   * The index only supplies *candidates* ("which assignments could relate to this
   * device?"); whether an assignment is on an ACTIVE event and has not exited is
   * read from `tx`, so a transaction that flips an event's state sees its own
   * change immediately.  Indexing that business state instead would silently miss
   * exactly that case.
   *
   * Candidate sources, unioned:
   *   - the device itself;
   *   - every device sharing its identity, per the structural index;
   *   - devices this transaction changed, because identity is one-way mutable
   *     (unbound -> bound), so the committed index may still file a device under
   *     its old `device:` key;
   *   - assignments this transaction changed.
   */
  private hasActiveAssignmentInTransaction(
    tx: EntityTransaction,
    deviceInstanceId: string,
    identity: string
  ): boolean {
    const index = this.store.assignmentIndex?.();
    const candidateDeviceIds = new Set<string>([deviceInstanceId]);
    if (index) {
      for (const id of index.deviceIdsForIdentity(identity)) candidateDeviceIds.add(id);
    }
    for (const key of tx.stagedKeys("devices")) {
      candidateDeviceIds.add(key);
    }

    const candidateAssignmentIds = new Set<string>();
    if (index) {
      for (const id of candidateDeviceIds) {
        for (const assignmentId of index.assignmentIdsForDevice(id)) {
          candidateAssignmentIds.add(assignmentId);
        }
      }
    }
    for (const key of tx.stagedKeys("assignments")) candidateAssignmentIds.add(key);

    for (const assignmentId of candidateAssignmentIds) {
      const assignment = tx.get("assignments", assignmentId);
      if (!assignment) continue;
      operationMetrics.assignmentCandidatesVisited += 1;
      if (assignmentExitsParticipation(assignment.status)) continue;
      const event = tx.get("events", assignment.eventId);
      if (event?.state !== "ACTIVE") continue;
      const assignedDevice = tx.get("devices", assignment.deviceInstanceId);
      if (assignment.deviceInstanceId === deviceInstanceId
        || (assignedDevice !== undefined && deviceIdentityKey(assignedDevice) === identity)) {
        return true;
      }
    }
    return false;
  }


  private deviceIsActivePatientInTransaction(tx: EntityTransaction, deviceInstanceId: string): boolean {
    const userId = tx.get("devices", deviceInstanceId)?.userId;
    const keys = new Set([
      ...transactionKeys(this.store, tx, "events", "patientDeviceIds", deviceInstanceId),
      ...(userId ? transactionKeys(this.store, tx, "events", "patientUserId", userId) : [])
    ]);
    return [...keys].some(key => tx.get("events", key)?.state === "ACTIVE");
  }

  /**
   * Mirrors the legacy reclamation exemption exactly: a device is skipped when it
   * is the patient device of an ACTIVE event, or the device of an ACCEPTED
   * responder for an ACTIVE event that has not recorded its user as exited and
   * whose current assignment has not left participation.
   *
   * The accepted-responder half is not optional: an earlier version of the
   * indexed path only checked the patient side, which silently reclaimed active
   * responders' positions.  The characterisation baseline caught it.
   *
   * The check must consider every ACCEPTED delivery of the device, not an
   * arbitrary first one, and must apply the same assignment-status filter as
   * `acceptedDeviceIds`.  Deliveries from finished events are retained with
   * ACCEPTED status, so stopping at the first record lets a completed earlier
   * event mask an active participation in a later one and wrongly strips the
   * current R projection; ignoring the assignment filter would instead exempt a
   * device whose participation already ended through TIMED_OUT/CANCELLED.
   */
  private deviceIsExemptFromPositionPrune(
    tx: EntityTransaction,
    deviceInstanceId: string
  ): boolean {
    const userId = tx.get("devices", deviceInstanceId)?.userId;
    if (this.deviceIsActivePatientInTransaction(tx, deviceInstanceId)) return true;
    const acceptedDeliveryIds = transactionKeys(this.store, tx, "deliveries", "deviceInstanceId", deviceInstanceId)
      .filter(id => { const delivery = tx.get("deliveries", id); return delivery?.decision === "ACCEPT" && delivery.status === "ACCEPTED"; });
    for (const deliveryId of acceptedDeliveryIds) {
      const delivery = tx.get("deliveries", deliveryId);
      if (!delivery) continue;
      const event = tx.get("events", delivery.eventId);
      if (event?.state !== "ACTIVE") continue;
      if (userId !== undefined && event.exitedResponderUserIds?.includes(userId)) continue;
      const assignment = this.survivingAssignmentForDeviceInTransaction(
        tx,
        delivery.eventId,
        deviceInstanceId
      );
      if (assignment && assignmentExitsParticipation(assignment.status)) continue;
      return true;
    }
    return false;
  }

  /**
   * Same surviving-record rule as `survivingAssignmentForDevice`, evaluated
   * against the transaction's own view so a transaction that changes an
   * assignment observes its own write.
   */
  private survivingAssignmentForDeviceInTransaction(
    tx: EntityTransaction,
    eventId: string,
    deviceInstanceId: string
  ): AssignmentRecord | undefined {
    const ids = transactionKeys(this.store, tx, "assignments", "eventId", eventId)
      .filter(id => tx.get("assignments", id)?.deviceInstanceId === deviceInstanceId);
    const candidates = ids
      .map(id => tx.get("assignments", id))
      .filter((assignment): assignment is AssignmentRecord => assignment !== undefined);
    return candidates.sort((left, right) => right.revision - left.revision
      || right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  private positionReplayInTransaction(
    tx: EntityTransaction,
    positionUpdateId: string,
    deviceInstanceId: string,
    eventId: string | undefined,
    kind: "P" | "R",
    updateFingerprint: string
  ): PositionUpdateResult | undefined {
    const prior = tx.get("positionUpdateReceiptsById", positionUpdateId);
    if (!prior) return undefined;
    if (prior.deviceInstanceId !== deviceInstanceId
      || prior.eventId !== eventId
      || prior.kind !== kind
      || prior.fingerprint !== updateFingerprint) {
      throw conflict("positionUpdateId was already used with different content");
    }
    return { ...prior.result, applied: false, idempotent: true };
  }

  private recordPositionReceiptInTransaction(
    tx: EntityTransaction,
    positionUpdateId: string,
    deviceInstanceId: string,
    eventId: string | undefined,
    kind: "P" | "R",
    updateFingerprint: string,
    recordedAt: string,
    result: PositionUpdateResult,
    watchFallbackFact?: WatchFallbackPositionUpdate
  ): void {
    tx.append("positionUpdateReceiptsById", positionUpdateId, {
      deviceInstanceId,
      ...(eventId ? { eventId } : {}),
      kind,
      fingerprint: updateFingerprint,
      recordedAt,
      result,
      ...(watchFallbackFact ? { watchFallbackFact: structuredClone(watchFallbackFact) } : {})
    } as never);
    this.pruneReceiptsInTransaction(tx, deviceInstanceId);
  }

  /**
   * Cache retention for one device.  Identities come from a no-clone predicate
   * scan; only the device's own cache entries are then read to sort them.
   */
  private pruneReceiptsInTransaction(tx: EntityTransaction, deviceInstanceId: string): void {
    const maximumPerDevice = 64;
    const cacheIds = transactionKeys(this.store, tx, "positionUpdateReceiptsById", "deviceInstanceId", deviceInstanceId)
      .filter(id => tx.get("positionUpdateReceiptsById", id)?.watchFallbackFact === undefined);
    if (cacheIds.length <= maximumPerDevice) return;
    const entries = cacheIds.map(id => {
      const receipt = tx.get("positionUpdateReceiptsById", id);
      return { id, recordedAt: receipt?.recordedAt ?? "" };
    }).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)
      || right.id.localeCompare(left.id));
    for (const entry of entries.slice(maximumPerDevice)) {
      tx.remove("positionUpdateReceiptsById", entry.id);
    }
  }

  private presenceView(
    state: Readonly<PresenceState>,
    device: DeviceRecord,
    now: Date
  ): DevicePresenceView {
    const userId = device.userId;
    const sameUser = (deviceId: string): boolean => {
      const candidate = state.devices[deviceId];
      return candidate?.deviceInstanceId === device.deviceInstanceId
        || (userId !== undefined && candidate?.userId === userId);
    };
    const isActivePatient = stateRows(state, "events", "state", "ACTIVE").some((event) => event.state === "ACTIVE"
      && (event.patientUserId === userId || event.patientDeviceIds.some(sameUser)));
    const isAcceptedParticipant = stateRows(state, "events", "state", "ACTIVE").some((event) => event.state === "ACTIVE"
      && acceptedDeviceIds(this.committedRecruitmentContext(state), event.id).some(sameUser));
    // Sampling remains warm inside an active search circle after an offer expires.
    // This does not make a declined/expired user eligible for another offer.
    const insideSearchRing = stateRows(state, "events", "state", "ACTIVE").some((event) =>
      this.isEligibleNearbyResponder(this.recruitmentContext(state), event, device, now, false)
    );
    const positioningTier: PositioningTier = isActivePatient || isAcceptedParticipant
      ? "EVENT_PARTICIPANT"
      : insideSearchRing
        ? "SEARCH_RING"
        : "STANDBY";
    return {
      deviceInstanceId: device.deviceInstanceId,
      deviceKind: device.deviceKind,
      lastSeenAt: device.lastSeenAt,
      availableForResponse: device.availableForResponse,
      capabilities: structuredClone(device.capabilities),
      positioningTier,
      // The stored sample is retained past its validity window; freshness is what
      // tells the client whether it may be treated as the current location.
      position: device.latestPosition
        ? {
          coordinate: structuredClone(device.latestPosition.position),
          observedAt: device.latestPosition.observedAt
        }
        : null,
      freshness: positionFreshness(device.latestPosition?.observedAt, now,
        this.config.positionMaxAgeSeconds),
      ageSeconds: positionAgeSeconds(device.latestPosition?.observedAt, now),
      currentEventId: device.currentEventId ?? null,
      currentAssignmentId: device.currentAssignmentId ?? null,
      lastPresenceUpdateId: device.lastPresenceUpdateId ?? null,
      lastPresenceOccurredAt: device.presenceObservedAt ?? null
    };
  }

  /**
   * Reclaims expired standby positions.
   *
   * Validity is decided by timestamp comparison at read time (every decision path
   * already gates on `responderPositionSampleIsFresh`), so this function only
   * frees memory and honours the 10-minute retention promise.  It therefore never
   * needs to look at devices that have not come due: the expiry index yields only
   * those, and the active-participant exemption is evaluated for that small set
   * rather than for every device.
   */
  private async pruneExpiredPositions(now: Date): Promise<number> {
    const index = this.store.positionExpiry?.();
    if (!index) return 0;
    const transactEntities = this.store.transactEntities?.bind(this.store);
    if (!transactEntities) return 0;
    const due = index.popDue(now.getTime(), POSITION_PRUNE_BATCH_LIMIT);
    if (due.length === 0) return 0;
    const restoreRetained = (retryDelayMs: number) => readEntities(this.store, view => {
      for (const entry of due) {
        const latest = view.get("devices", entry.deviceInstanceId)?.latestPosition;
        if (!latest) continue;
        const expiry = Date.parse(latest.observedAt) + this.config.positionMaxAgeSeconds * 1000;
        if (Number.isFinite(expiry)) index.upsert(entry.deviceInstanceId, Math.max(expiry, now.getTime() + retryDelayMs));
      }
    });

    let removed = 0;
    try {
      await transactEntities(tx => {
        for (const entry of due) {
          const device = tx.get("devices", entry.deviceInstanceId);
          const latest = device?.latestPosition;
          if (!latest) continue;
          // Re-check under the transaction: the device may have uploaded again
          // between the sweep and this commit, which would make it fresh.
          if (!isPositionExpired(latest.observedAt, now, this.config.positionMaxAgeSeconds)) continue;
          if (this.deviceIsExemptFromPositionPrune(tx, entry.deviceInstanceId)) continue;
          tx.update("devices", entry.deviceInstanceId, draft => { delete draft.latestPosition; });
          removed += 1;
        }
      });
    } catch (error) {
      restoreRetained(0); // A failed SQL commit must not consume the reclamation work.
      throw error;
    }
    // Retained active participants must become reclaimable after they leave, even
    // when no later position write happens to reschedule their expiry.
    restoreRetained(1000);
    return removed;
  }

  /** Whole-state fallback for stores without an expiry index. */
  private pruneExpiredCurrentPositions(state: PersistentState, now: Date): void {
    for (const device of Object.values(state.devices)) {
      if (!device.latestPosition) continue;
      const isActiveEventParticipant = stateRows(state, "events", "state", "ACTIVE").some((event) =>
        event.state === "ACTIVE"
        && (event.patientDeviceIds.includes(device.deviceInstanceId)
          || acceptedDeviceIds(this.committedRecruitmentContext(state), event.id)
            .includes(device.deviceInstanceId))
      );
      if (isActiveEventParticipant) continue;
      if (isPositionExpired(device.latestPosition.observedAt, now, this.config.positionMaxAgeSeconds)) {
        delete device.latestPosition;
      }
    }
  }


  private markDeviceSeen(
    state: PersistentState,
    deviceInstanceId: string,
    at: string = this.now().toISOString()
  ): void {
    const device = state.devices[deviceInstanceId];
    if (device) device.lastSeenAt = at;
  }

  private positionResult(
    positionUpdateId: string,
    applied: boolean,
    idempotent: boolean,
    ignoredAsStale: boolean,
    positionObservedAt: string,
    serverReceivedAt: string
  ): PositionUpdateResult {
    return {
      positionUpdateId,
      applied,
      idempotent,
      ignoredAsStale,
      positionObservedAt,
      serverReceivedAt
    };
  }

  private eventPositionBatchAck(
    batch: EventPositionBatchRecord,
    idempotent: boolean
  ): EventPositionBatchAck {
    return {
      schemaVersion: "2.0",
      eventId: batch.eventId,
      batchId: batch.batchId,
      acceptedRecordCount: batch.records.length,
      idempotent,
      acknowledgedAt: batch.receivedAt,
      records: batch.records.map((record) => ({
        recordId: record.recordId,
        persisted: true,
        appliedToLatest: record.appliedToLatest,
        ignoredAsStale: record.ignoredAsStale,
        serverReceivedAt: record.serverReceivedAt
      }))
    };
  }

  private positionReplay(
    state: Readonly<PersistentState>,
    positionUpdateId: string,
    deviceInstanceId: string,
    eventId: string | undefined,
    kind: "P" | "R",
    updateFingerprint: string
  ): PositionUpdateResult | undefined {
    const prior = state.positionUpdateReceiptsById[positionUpdateId];
    if (!prior) return undefined;
    if (prior.deviceInstanceId !== deviceInstanceId
      || prior.eventId !== eventId
      || prior.kind !== kind
      || prior.fingerprint !== updateFingerprint) {
      throw conflict("positionUpdateId was already used with different content");
    }
    return { ...prior.result, applied: false, idempotent: true };
  }

  private recordPositionReceipt(
    state: PersistentState,
    positionUpdateId: string,
    deviceInstanceId: string,
    eventId: string | undefined,
    kind: "P" | "R",
    updateFingerprint: string,
    recordedAt: string,
    result: PositionUpdateResult,
    watchFallbackFact?: WatchFallbackPositionUpdate
  ): void {
    state.positionUpdateReceiptsById[positionUpdateId] = {
      deviceInstanceId,
      ...(eventId ? { eventId } : {}),
      kind,
      fingerprint: updateFingerprint,
      recordedAt,
      result,
      ...(watchFallbackFact ? { watchFallbackFact: structuredClone(watchFallbackFact) } : {})
    };
    // Durable evidence is not a bounded receipt cache. Keep existing iPhone cache retention unchanged.
    this.pruneReceipts(state.positionUpdateReceiptsById, deviceInstanceId, receipt => receipt.watchFallbackFact === undefined);
  }

  private pruneReceipts<T extends { deviceInstanceId: string; recordedAt: string }>(
    receipts: Record<string, T>,
    deviceInstanceId: string,
    isCacheEntry: (receipt: T) => boolean = () => true
  ): void {
    const maximumPerDevice = 64;
    const entries = receiptKeysForDevice(receipts, deviceInstanceId).map(key => [key, receipts[key]!] as const)
      .filter(([, receipt]) => receipt.deviceInstanceId === deviceInstanceId && isCacheEntry(receipt))
      .sort((left, right) => right[1].recordedAt.localeCompare(left[1].recordedAt)
        || right[0].localeCompare(left[0]));
    for (const [receiptId] of entries.slice(maximumPerDevice)) delete receipts[receiptId];
  }

  /**
   * Re-runs recruitment for one event: expire dead offers, advance the ring, then
   * offer to everyone still eligible.
   *
   * Consumes a context; it never builds one.  Read-your-writes is a property of a
   * single context, and this operation performs three kinds of write in sequence
   * (delivery expiries, the event's own stage/revision, new deliveries), so all of
   * them must land in the same view.
   *
   * Returns the possibly-new event object.  Every `updateDelivery`/`updateEvent`
   * above produces a new current view under a transaction adapter, so the caller
   * must rebind rather than keep the object it passed in.
   */
  private refreshRecruitmentForEvent(
    ctx: RecruitmentContext,
    event: EventRecord,
    now: Date,
    forceRevision = false
  ): {
    changed: boolean;
    requests: ResponseRequestPayload[];
    previousAudience: string[];
    expiredOffers: RecruitmentUpdate["expiredOffers"];
    event: EventRecord;
  } {
    let current = event;
    const previousAudience = coordinationAudienceDeviceIds(ctx, current);
    if (current.state !== "ACTIVE") {
      return { changed: false, requests: [], previousAudience, expiredOffers: [],
        event: current };
    }
    if (current.recruitmentState !== "RECRUITING") {
      if (forceRevision) {
        current = this.updateEventOrThrow(ctx, current.id, (draft) => {
          draft.coordinationRevision += 1;
        });
      }
      return { changed: forceRevision, requests: [], previousAudience, expiredOffers: [],
        event: current };
    }
    let changed = false;
    const nowIso = now.toISOString();
    const expiredOffers: RecruitmentUpdate["expiredOffers"] = [];

    // Only this event's offers can expire here, so the sweep asks for them by
    // event rather than walking every delivery in the system.
    for (const delivery of ctx.deliveriesOfEvent(current.id)) {
      if (!pendingDeliveryStatuses.includes(delivery.status)) continue;
      const expire = (reason: "OFFER_EXPIRED" | "OFFER_NO_LONGER_ELIGIBLE",
        message: string): void => {
        // The returned current view is what everything below reads.  Under a
        // transaction adapter `delivery` is the pre-update object and the write went
        // to a staged copy, so reusing the loop's binding would read stale fields.
        const expired = ctx.updateDelivery(delivery.id, (draft) => {
          draft.status = "EXPIRED";
          draft.statusOccurredAt = nowIso;
        });
        changed = true;
        expiredOffers.push({
          deviceInstanceId: expired.deviceInstanceId,
          deliveryId: expired.id,
          expiresAt: expired.request.expiresAt,
          reason
        });
        ctx.insertNotification(expired.deviceInstanceId, "response:offer-expired", {
          ...this.envelope(`response-offer-expired:${expired.id}`, current.id, nowIso),
          deliveryId: expired.id,
          expiresAt: expired.request.expiresAt,
          reason
        });
        ctx.appendTimeline(current.id, nowIso, "PASSIVE_OBSERVATION", message);
      };

      if (!deliveryIsLive(delivery, now)) {
        expire("OFFER_EXPIRED",
          `Response delivery ${delivery.id} expired after its 30-second offer window.`);
        continue;
      }
      const device = ctx.getDevice(delivery.deviceInstanceId);
      if (device && this.isEligibleNearbyResponder(ctx, current, device, now)) continue;
      expire("OFFER_NO_LONGER_ELIGIBLE",
        `Response delivery ${delivery.id} expired after server-side eligibility changed.`);
    }

    const advanced = this.advanceRecruitmentStage(ctx, current, now);
    if (advanced.changed) changed = true;
    current = advanced.event;

    // This sort is business selection order, not presentation order: each iteration
    // creates an offer, so which device of an identity is reached first decides which
    // one gets the delivery and which is then blocked by the user-level guard.  The
    // candidate source supplies an unordered set, so the algorithm sorts it here.
    const candidates = [...ctx.candidateDevices(current)].sort((left, right) =>
      left.deviceInstanceId.localeCompare(right.deviceInstanceId));
    const requests: ResponseRequestPayload[] = [];
    for (const device of candidates) {
      const request = this.createDeliveryIfEligible(ctx, current, device, now);
      if (request) {
        requests.push(request);
        changed = true;
      }
    }
    if (changed || forceRevision) {
      current = this.updateEventOrThrow(ctx, current.id, (draft) => {
        draft.coordinationRevision += 1;
      });
    }
    return { changed: changed || forceRevision, requests, previousAudience, expiredOffers,
      event: current };
  }

  /**
   * Advances only toward wider rings. The check is intentionally invoked from
   * transactions that already touch event state and from the public tick entry;
   * the persisted stage timestamp makes restarts safe even when a local timer
   * is unavailable. Production should invoke the same hook from a durable job.
   */
  /**
   * Registers an event change and insists on getting the current view back.
   *
   * `RecruitmentContext.updateEvent` returns `undefined` only when the context has
   * no such event in its view.  Quietly continuing with the object we already hold
   * would then mutate a detached copy the transaction never hears about — the exact
   * silent-loss failure this whole refactor exists to remove.  So it throws instead.
   */
  private updateEventOrThrow(
    ctx: RecruitmentContext,
    eventId: string,
    mutate: (event: EventRecord) => void
  ): EventRecord {
    const updated = ctx.updateEvent(eventId, mutate);
    if (!updated) {
      throw new Error(
        `Recruitment could not register a change to event ${eventId}: the context `
        + "has no such event in its current view. Continuing would mutate a "
        + "detached object that the transaction never learns about."
      );
    }
    return updated;
  }

  /**
   * Widens the recruitment ring when the current stage cannot reach the target.
   *
   * Every field write goes through `ctx.updateEvent`, and the returned current view
   * replaces the local binding for all later reads.  Writing through the context is
   * not ceremony: a transaction adapter hands out its own current-view object, so an
   * in-place `event.currentRecruitmentRadiusMeters = ...` would leave the in-memory
   * object looking changed while the transaction never registered a change.
   *
   * Returns the possibly-new event object as well as the changed flag, because the
   * caller must not keep using the one it passed in.
   */
  private advanceRecruitmentStage(
    ctx: RecruitmentContext,
    event: EventRecord,
    now: Date
  ): { changed: boolean; event: EventRecord } {
    let current = event;
    let changed = false;
    const patientPosition = currentPatientPosition(current);
    if (!patientPosition || !this.patientPositionSampleIsFresh(
      patientPosition,
      current.patientPosition?.observedAt
        ?? current.observation.fallDetectedAt ?? current.createdAt,
      now
    )) {
      // Recruitment has no geographic ring until a valid P exists. Keep the
      // event at its initial radius and start the stage clock on first valid P.
      return { changed: false, event: current };
    }
    if (current.recruitmentStageStartedAt === null) {
      current = this.updateEventOrThrow(ctx, current.id, (draft) => {
        draft.recruitmentStageStartedAt = now.toISOString();
      });
      changed = true;
    }
    for (let attempt = 0; attempt < RECRUITMENT_RADIUS_STAGES_METERS.length; attempt += 1) {
      let stageIndex = RECRUITMENT_RADIUS_STAGES_METERS.indexOf(
        current.currentRecruitmentRadiusMeters as typeof RECRUITMENT_RADIUS_STAGES_METERS[number]
      );
      if (stageIndex < 0) {
        stageIndex = 0;
        current = this.updateEventOrThrow(ctx, current.id, (draft) => {
          draft.currentRecruitmentRadiusMeters = RECRUITMENT_RADIUS_STAGES_METERS[0];
          draft.recruitmentStageStartedAt = now.toISOString();
        });
        changed = true;
      }
      const nextRadius = RECRUITMENT_RADIUS_STAGES_METERS[stageIndex + 1];
      if (nextRadius === undefined) break;

      const candidateCount = this.recruitmentPotentialDevices(ctx, current, now).length;
      const acceptedCount = acceptedDeviceIds(ctx, current.id).length;
      const potentialCount = acceptedCount + candidateCount;
      // Narrowed through a local: the rebind above hides the property narrowing.
      // A `null` here is unreachable in practice and maps to NaN, which is what the
      // original in-place version produced too.
      const stageStartedAtText = current.recruitmentStageStartedAt;
      const stageStartedAt = Date.parse(stageStartedAtText ?? "");
      const stageTimedOut = Number.isFinite(stageStartedAt)
        && now.getTime() - stageStartedAt > RECRUITMENT_STAGE_TIMEOUT_SECONDS * 1_000;
      const shouldExpand = acceptedCount < RECRUITMENT_TARGET_ACCEPTED
        && (potentialCount < RECRUITMENT_TARGET_ACCEPTED
          || (potentialCount >= RECRUITMENT_TARGET_ACCEPTED && stageTimedOut));
      if (!shouldExpand) break;

      current = this.updateEventOrThrow(ctx, current.id, (draft) => {
        draft.currentRecruitmentRadiusMeters = nextRadius;
        draft.recruitmentStageStartedAt = now.toISOString();
      });
      changed = true;
      ctx.appendTimeline(
        current.id,
        now.toISOString(),
        "PASSIVE_OBSERVATION",
        `Recruitment radius expanded to ${nextRadius} meters.`
      );
    }
    return { changed, event: current };
  }

  /**
   * Device ids that could be inside an event's recruitment ring.
   *
   * `stagedDeviceKeys` is the current transaction's own device changes.  The
   * committed index does not yet contain them, so they must be unioned in or a
   * device whose position was just written would be invisible to recruitment.
   * The union can only ever over-select, never omit, and the caller still applies
   * `isEligibleNearbyResponder`.
   */
  private candidateDeviceIdsForEvent(
    event: EventRecord,
    stagedDeviceKeys: readonly string[] = []
  ): string[] | undefined {
    const patientPosition = currentPatientPosition(event);
    const index = this.store.devicePositions?.();
    if (!patientPosition || !index) return undefined;
    const candidates = new Set(index.query(
      patientPosition.latitude,
      patientPosition.longitude,
      event.currentRecruitmentRadiusMeters
    ));
    for (const key of stagedDeviceKeys) candidates.add(key);
    return [...candidates];
  }

  /**
   * The eligible responder set, in the only order the rest of the algorithm may
   * rely on.
   *
   * Frozen pipeline, and each stage is business semantics rather than style:
   *
   *   ctx.candidateDevices(event)
   *     -> isEligibleNearbyResponder filter
   *     -> ascending deviceInstanceId
   *     -> identity de-duplication, first occurrence wins
   *
   * Filtering must precede de-duplication.  Swapping them lets an ineligible
   * low-sorting device evict an eligible sibling of the same identity, which is a
   * silent loss of a responder.  Sorting must precede de-duplication for the same
   * reason: which device survives would otherwise depend on the candidate
   * enumeration order instead of the lexicographically smallest id.
   *
   * The algorithm owns this ordering.  The context supplies candidates and must
   * not be asked to sort them — sorting is not a data-access concern, and letting
   * an adapter choose the order would make the Phase 2 differential test unable to
   * attribute a difference to either the access path or the selection rule.
   *
   * The candidate source is the seam that a transaction adapter replaces; this
   * function's own stages stay identical between legacy and transaction contexts.
   */
  private eligibleResponderDevices(
    ctx: RecruitmentContext,
    event: EventRecord,
    now: Date
  ): DeviceRecord[] {
    const identities = new Set<string>();
    return ctx.candidateDevices(event)
      .filter((device) => this.isEligibleNearbyResponder(ctx, event, device, now))
      .sort((left, right) => left.deviceInstanceId.localeCompare(right.deviceInstanceId))
      .filter((device) => {
        const identity = deviceIdentityKey(device);
        if (identities.has(identity)) return false;
        identities.add(identity);
        return true;
      });
  }

  /**
   * Who may still be counted as recruitment potential.
   *
   * Consumes the already-decided `eligibleResponderDevices` result rather than
   * re-deriving it, so the delivery filter runs AFTER the sort and the identity
   * de-duplication.  That ordering is observable: if the de-duplication survivor is
   * removed here, the identity is not back-filled from its other devices.
   *
   * The lookup is a choice between two different questions, not an OR of them:
   * a device bound to a user is judged by the user's delivery on this event, which
   * covers the same person's other devices; an unbound device is judged by its own.
   * Collapsing the two into one "find the delivery" helper would change which rows
   * are consulted and therefore the answer.
   */
  private recruitmentPotentialDevices(
    ctx: RecruitmentContext,
    event: EventRecord,
    now: Date
  ): DeviceRecord[] {
    return this.eligibleResponderDevices(ctx, event, now).filter((device) => {
      const delivery = device.userId
        ? ctx.deliveryForUser(event.id, device.userId)
        : ctx.deliveryForDevice(event.id, device.deviceInstanceId);
      // A refused or expired offer is a terminal identity for this event and
      // must not keep a narrow ring open when it cannot receive a new offer.
      return delivery === undefined || deliveryIsLive(delivery, now);
    });
  }

  /**
   * The published recruitment update for one event.
   *
   * Takes the two domain readers instead of a state object.  Every read here is
   * either a recruitment relationship (audience, the request's recipient device) or
   * the coordination summary's single AED figure, so the split is along the same
   * lines as `coordinationSummary` and nothing reaches for a full state.
   */
  private recruitmentUpdate(
    ctx: RecruitmentContext,
    aed: CoordinationAedReader,
    event: EventRecord,
    requests: ResponseRequestPayload[],
    extraAudience: readonly string[] = [],
    expiredOffers: RecruitmentUpdate["expiredOffers"] = []
  ): RecruitmentUpdate {
    const update = {
      eventId: event.id,
      audience: [
        ...coordinationAudienceDeviceIds(ctx, event),
        ...extraAudience
      ].filter((deviceId, index, values) => values.indexOf(deviceId) === index),
      requests: requests.flatMap((request) => {
        const delivery = ctx.getDelivery(request.deliveryId);
        return delivery ? [{ deviceInstanceId: delivery.deviceInstanceId, request }] : [];
      }),
      expiredOffers,
      coordination: this.coordinationSummary(ctx, aed, event, this.now())
    };
    // Every call site is inside the transaction that changed the event or its
    // recruitment projection. Persist the authorized coordination hint before
    // the caller can publish any transport event.
    if (event.state === "ACTIVE") {
      this.enqueueCoordinationNotifications(
        ctx,
        event,
        update.audience,
        update.coordination,
        this.now().toISOString()
      );
    }
    return update;
  }

  private publishRecruitmentUpdates(updates: readonly RecruitmentUpdate[], occurredAt: string): void {
    for (const update of updates) {
      void occurredAt;
      void update;
    }
  }

  private async publishPatientPositionChange(
    eventId: string,
    occurredAt: string,
    update: RecruitmentUpdate | undefined
  ): Promise<void> {
    await this.notificationOutbox.drain();
    void eventId;
    void occurredAt;
    void update;
  }

  /**
   * The coordination summary.
   *
   * Takes two readers rather than a state object, so each domain keeps its own
   * boundary: recruitment data through `RecruitmentContext`, the one AED-domain
   * figure through `CoordinationAedReader`.  Handing this function a whole state
   * would reintroduce exactly the two-sources-of-truth problem the context work
   * removed - a transaction context on one side and a committed state object on the
   * other, with stale reads and no error.
   */
  private coordinationSummary(
    ctx: RecruitmentContext,
    aed: CoordinationAedReader,
    event: EventRecord,
    now: Date
  ): CoordinationSummary {
    const candidateIds = this.recruitmentPotentialDevices(ctx, event, now)
      .map((device) => device.deviceInstanceId);
    const pendingOfferCount = ctx.deliveriesOfEvent(event.id).filter((delivery) => {
      if (!deliveryIsLive(delivery, now)) return false;
      const device = ctx.getDevice(delivery.deviceInstanceId);
      return device !== undefined && this.isEligibleNearbyResponder(ctx, event, device, now);
    }).length;
    const accepted = acceptedDeviceIds(ctx, event.id);
    const currentAssignments = accepted.flatMap((deviceId) => {
      const assignment = ctx.currentAssignmentForDevice(event.id, deviceId);
      return assignment ? [assignment] : [];
    });
    const participatingAssignments = event.state === "ACTIVE"
      ? currentAssignments.filter((assignment) => !assignmentExitsParticipation(assignment.status))
      : [];
    return {
      revision: Math.max(1, event.coordinationRevision),
      currentRecruitmentRadiusMeters: event.currentRecruitmentRadiusMeters,
      nearbyCandidateCount: candidateIds.length,
      pendingOfferCount,
      acceptedResponderCount: accepted.length,
      goToPatientCount: participatingAssignments.filter(
        (assignment) => assignment.role === "GO_TO_PATIENT"
      ).length,
      fetchAedCount: participatingAssignments.filter(
        (assignment) => assignment.role === "FETCH_AED"
      ).length,
      enRouteCount: participatingAssignments.filter((assignment) =>
        ["EN_ROUTE", "EN_ROUTE_TO_PATIENT"].includes(assignment.status)
      ).length,
      arrivedAtAedCount: participatingAssignments.filter(
        (assignment) => assignment.status === "ARRIVED_AT_AED"
      ).length,
      arrivedAtPatientCount: currentAssignments.filter((assignment) =>
        ["ARRIVED_AT_PATIENT", "COMPLETED"].includes(assignment.status)
      ).length,
      aedAcquiredCount: aed.acquiredAedCount(event.id),
      completedAssignmentCount: currentAssignments.filter(
        (assignment) => assignment.status === "COMPLETED"
      ).length
    };
  }

  private refreshPatientRoutes(
    state: PersistentState,
    event: EventRecord,
    at: Date
  ): AssignmentEmission[] {
    const patientPosition = currentPatientPosition(event);
    if (!patientPosition) return [];
    const emissions: AssignmentEmission[] = [];
    for (const assignment of stateRows(state, "assignments", "eventId", event.id)) {
      if (assignment.eventId !== event.id
        || assignment.role !== "FETCH_AED"
        || isTerminalAssignmentStatus(assignment.status)
        || !assignment.route) continue;
      const aed = routingAeds(state, this.now(), event.id).find((candidate) => candidate.id === assignment.route?.aedId);
      if (!aed) continue;
      const routeResult = this.routeProvider.refreshRoute({
        responder: assignment.route.path[0],
        patient: patientPosition,
        aed,
        at
      });
      // A route provider outage must not invent a route or erase the last
      // committed route.  The next scheduler tick can retry the refresh.
      if (routeResult.kind === "UNAVAILABLE") continue;
      const route = routeResult.value;
      if (fingerprint(route) === fingerprint(assignment.route)) continue;
      event.assignmentRevision += 1;
      assignment.route = route;
      assignment.revision = event.assignmentRevision;
      assignment.updatedAt = at.toISOString();
      appendTimeline(
        state,
        event.id,
        at.toISOString(),
        "ASSIGNMENT_UPDATED",
        `Assignment ${assignment.id} route was refreshed for the latest patient position.`
      );
      emissions.push({
        deviceInstanceId: assignment.deviceInstanceId,
        name: "assignment:updated",
        assignment: assignmentView(assignment),
        occurredAt: at.toISOString()
      });
    }
    this.enqueueAssignmentEmissions(state, event, emissions);
    return emissions;
  }

  /**
   * Creates the one offer this device may hold for this event, if it qualifies.
   *
   * The three guards are independent and their order is preserved: eligibility,
   * then this device, then this user.  They are NOT the live-delivery predicate
   * `recruitmentPotentialDevices` uses — that one asks whether an existing offer is
   * still alive, while these ask whether any offer exists at all.  Sharing a helper
   * between the two would change both.
   *
   * The third guard is why `ctx.createDelivery` must be visible to its own context
   * immediately: inside the caller's device loop, the second device of one identity
   * is rejected because the first device's delivery is already findable by user.
   */
  private createDeliveryIfEligible(
    ctx: RecruitmentContext,
    event: EventRecord,
    device: DeviceRecord,
    now: Date
  ): ResponseRequestPayload | undefined {
    if (!this.isEligibleNearbyResponder(ctx, event, device, now)) return undefined;
    if (ctx.deliveryForDevice(event.id, device.deviceInstanceId)) return undefined;
    if (device.userId && ctx.deliveryForUser(event.id, device.userId)) return undefined;
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
    // Write order preserved: delivery, then timeline, then notification.  They commit
    // atomically, but in-transaction helpers may read what earlier steps wrote, so
    // reordering them "because it all commits together" would not be free.
    ctx.createDelivery({
      id: deliveryId,
      eventId: event.id,
      deviceInstanceId: device.deviceInstanceId,
      request,
      status: "SENT",
      statusOccurredAt: occurredAt
    });
    ctx.appendTimeline(
      event.id,
      occurredAt,
      "RESPONSE_REQUESTED",
      `Targeted response delivery ${deliveryId} was created.`
    );
    ctx.insertNotification(
      device.deviceInstanceId,
      "response:requested",
      request as unknown as Record<string, unknown>
    );
    return request;
  }

  /**
   * Shared responder-device checks used by event recruitment and the neutral
   * nearby summary. Event-specific checks (patient, event state, and event
   * ring) stay in isEligibleNearbyResponder below.
   */
  private isEligibleResponderDeviceBase(
    ctx: RecruitmentContext,
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
      if (ctx.isActivePatient(device.deviceInstanceId)) return false;
      if (ctx.hasActiveAssignmentForDevice(device)) return false;
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

  private activeStandbyExcludedIdentities(
    state: Readonly<PersistentState>
  ): Set<string> {
    const excluded = new Set<string>();
    for (const event of stateRows(state, "events", "state", "ACTIVE")) {
      if (event.state !== "ACTIVE") continue;
      if (event.patientUserId) excluded.add(`user:${event.patientUserId}`);
      for (const deviceId of event.patientDeviceIds) {
        const patientDevice = state.devices[deviceId];
        if (patientDevice) excluded.add(deviceIdentityKey(patientDevice));
      }
      for (const deviceId of acceptedDeviceIds(this.recruitmentContext(state), event.id)) {
        const acceptedDevice = state.devices[deviceId];
        if (acceptedDevice) excluded.add(deviceIdentityKey(acceptedDevice));
      }
      for (const assignment of stateRows(state, "assignments", "eventId", event.id)) {
        if (assignment.eventId !== event.id || assignmentExitsParticipation(assignment.status)) {
          continue;
        }
        const assignedDevice = state.devices[assignment.deviceInstanceId];
        if (assignedDevice) excluded.add(deviceIdentityKey(assignedDevice));
      }
    }
    return excluded;
  }

  private isEligibleStandbyVolunteer(
    state: Readonly<PersistentState>,
    device: DeviceRecord,
    now: Date,
    viewerUserId: string,
    busyIdentities: ReadonlySet<string>
  ): boolean {
    if (device.userId === undefined || device.userId === viewerUserId) return false;
    return this.isEligibleResponderDeviceBase(
      recruitmentContextFor(state),
      device,
      now,
      true,
      busyIdentities
    );
  }

  private isEligibleNearbyResponder(
    ctx: RecruitmentContext,
    event: EventRecord,
    device: DeviceRecord,
    now: Date,
    requireRecruiting = true
  ): boolean {
    if (event.state !== "ACTIVE" || (requireRecruiting && event.recruitmentState !== "RECRUITING")) return false;
    if (!permitsSimulationDevice(event.observation, device.deviceInstanceId, device.userId)) return false;
    if (!this.isEligibleResponderDeviceBase(ctx, device, now)) return false;
    if (event.patientDeviceIds.includes(device.deviceInstanceId)) return false;
    if (device.userId !== undefined && event.patientUserId === device.userId) return false;
    if (device.userId !== undefined && event.exitedResponderUserIds?.includes(device.userId)) {
      return false;
    }
    if (ctx.hasAcceptedDeliveryFromIdentity(event.id, device)) return false;
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

  private deviceIsActivePatient(state: Readonly<PresenceState>, deviceInstanceId: string): boolean {
    const userId = state.devices[deviceInstanceId]?.userId;
    return stateRows(state, "events", "state", "ACTIVE").some((event) => event.state === "ACTIVE"
      && (event.patientDeviceIds.includes(deviceInstanceId)
        || (userId !== undefined && event.patientUserId === userId)));
  }

  private enforcePatientPriority(
    state: PersistentState,
    patientUserId: string,
    patientDeviceIds: readonly string[],
    newPatientEventId: string,
    at: Date
  ): PatientPriorityResult {
    const patientSet = new Set([
      ...patientDeviceIds,
      ...stateRows(state, "devices", "userId", patientUserId)
        .filter((device) => device.deviceKind === "IPHONE"
          && device.userId !== undefined
          && device.userId === patientUserId)
        .map((device) => device.deviceInstanceId)
    ]);
    if (patientSet.size === 0) return { assignments: [], updates: [] };
    const occurredAt = at.toISOString();
    const emissions: AssignmentEmission[] = [];
    const updates: RecruitmentUpdate[] = [];

    for (const deviceId of patientSet) {
      const device = state.devices[deviceId];
      if (device?.latestPosition?.position.kind === "R") delete device.latestPosition;
      if (device) delete device.currentAssignmentId;
    }

    for (const event of stateRows(state, "events", "state", "ACTIVE")) {
      if (event.id === newPatientEventId || event.state !== "ACTIVE") continue;
      let acceptedParticipantRemoved = false;
      let responderFlowRemoved = false;
      const eventEmissions: AssignmentEmission[] = [];

      for (const interval of stateRows(state, "participantIntervalsById", "eventId", event.id)) {
        if (interval.eventId === event.id
          && interval.userId === patientUserId
          && patientSet.has(interval.deviceInstanceId)) {
          this.endParticipantInterval(
            state,
            interval.eventId,
            interval.userId,
            interval.deviceInstanceId,
            occurredAt,
            "PATIENT_PRIORITY"
          );
        }
      }

      for (const delivery of stateRows(state, "deliveries", "eventId", event.id)) {
        if (delivery.eventId !== event.id || !patientSet.has(delivery.deviceInstanceId)) continue;
        if (delivery.status === "ACCEPTED") acceptedParticipantRemoved = true;
        if (!["REFUSED", "EXPIRED"].includes(delivery.status)) {
          delivery.status = "EXPIRED";
          delivery.statusOccurredAt = occurredAt;
          responderFlowRemoved = true;
        }
      }
      for (const assignment of stateRows(state, "assignments", "eventId", event.id)) {
        if (assignment.eventId !== event.id
          || !patientSet.has(assignment.deviceInstanceId)
          || isTerminalAssignmentStatus(assignment.status)) continue;
        event.assignmentRevision += 1;
        assignment.status = "CANCELLED";
        assignment.revision = event.assignmentRevision;
        assignment.updatedAt = occurredAt;
        const assignmentDevice = state.devices[assignment.deviceInstanceId];
        if (assignmentDevice?.userId) {
          this.endParticipantInterval(
            state,
            event.id,
            assignmentDevice.userId,
            assignment.deviceInstanceId,
            occurredAt,
            "PATIENT_PRIORITY"
          );
        }
        responderFlowRemoved = true;
        appendTimeline(
          state,
          event.id,
          occurredAt,
          "ASSIGNMENT_UPDATED",
          `Assignment ${assignment.id} was cancelled because its device became a patient in another event.`
        );
      }

      if (!responderFlowRemoved) continue;
      reconcileEventAssets(state, event.id, occurredAt);
      event.coordinationRevision += 1;
      appendTimeline(
        state,
        event.id,
        occurredAt,
        "PASSIVE_OBSERVATION",
        "Patient priority removed an authenticated device from responder coordination."
      );

      if (acceptedParticipantRemoved) {
        try {
          eventEmissions.push(...this.replanAssignments(state, event, at));
        } catch (error) {
          if (!(error instanceof HttpProblem)
            || error.status !== 409
            || !error.detail.includes("Progressed assignments")) {
            throw error;
          }
          appendTimeline(
            state,
            event.id,
            occurredAt,
            "PASSIVE_OBSERVATION",
            "Patient-priority replan was safely deferred because another responder already progressed; progressed/AED_ACQUIRED work was preserved."
          );
        }
      }
      emissions.push(...eventEmissions);
      this.enqueueAssignmentEmissions(state, event, eventEmissions);
      updates.push(this.recruitmentUpdate(
            this.recruitmentContext(state), legacyCoordinationAedReader(state), event, []));
    }
    return { assignments: emissions, updates };
  }

  private replanAssignments(
    state: PersistentState,
    event: EventRecord,
    at: Date
  ): AssignmentEmission[] {
    const accepted = acceptedDeviceIds(this.recruitmentContext(state), event.id).sort();
    if (accepted.length === 0) { reconcileEventAssets(state, event.id, at.toISOString()); return []; }
    const plan = planAssignments(accepted.length);
    const activeByDevice = new Map<string, AssignmentRecord>();
    for (const deviceId of accepted) {
      const assignment = currentAssignmentForDevice(state, event.id, deviceId);
      // AED_UNAVAILABLE is a terminal record for the failed attempt, not
      // locked work.  Let the same participant receive a fresh patient task
      // (or a replacement AED task) while preserving that audit assignment.
      if (assignment
        && assignment.status !== "AED_UNAVAILABLE"
        && !assignmentExitsParticipation(assignment.status)) {
        activeByDevice.set(deviceId, assignment);
      }
    }

    const locked = [...activeByDevice.values()].filter((assignment) => assignment.status !== "ASSIGNED");
    const lockedAed = locked.filter((assignment) => assignment.role === "FETCH_AED").length;
    const remainingAed = Math.max(0, plan.aedCount - lockedAed);
    const flexible = accepted.filter((deviceId) => !locked.some(
      (assignment) => assignment.deviceInstanceId === deviceId
    ));
    const aedSlotsForFlexible = Math.min(remainingAed, flexible.length);
    const patientPosition = currentPatientPosition(event);
    if (!patientPosition) throw conflict("Assignments require a patient P position");
    const unavailable = new Set([
      ...event.unavailableAedIds,
      ...stateRows(state, "aedReceiptsById", "canonical.eventId", event.id)
        .filter((receipt) => receipt.canonical.eventId === event.id)
        .map((receipt) => receipt.canonical.aedId),
      ...locked
        .filter((assignment) => assignment.role === "FETCH_AED" && assignment.route)
        .map((assignment) => assignment.route!.aedId),
      // One cabinet holds one device: an AED another event already handed to a
      // responder is not available to this event, whatever this event's own
      // history says.  Without this the second event routed a responder to a
      // device that was already carried away.
      ...claimedAedIdsForOtherEvents(state, event.id)
    ]);
    const routeOptionsByDevice = new Map<string, AedRoute[]>();
    for (const deviceId of flexible) {
      const position = currentResponderPosition(state.devices[deviceId]);
      if (!position) {
        routeOptionsByDevice.set(deviceId, []);
        continue;
      }
      const routeResult = this.routeProvider.eligibleRoutes({
        responder: position,
        patient: patientPosition,
        aeds: routingAeds(state, at, event.id),
        unavailableAedIds: unavailable,
        at
      });
      routeOptionsByDevice.set(
        deviceId,
        routeResult.kind === "AVAILABLE" ? [...routeResult.value] : []
      );
    }
    const selectedRoutes = new Map<string, AedRoute>();
    const selectedAeds = new Set<string>();
    const routeCandidates = flexible.flatMap((deviceId) => (
      routeOptionsByDevice.get(deviceId) ?? []
    ).map((route) => ({ deviceId, route }))).sort((left, right) =>
      left.route.etaSeconds - right.route.etaSeconds
      || left.route.aedId.localeCompare(right.route.aedId)
      || left.deviceId.localeCompare(right.deviceId));
    for (const candidate of routeCandidates) {
      if (selectedRoutes.size >= aedSlotsForFlexible) break;
      if (selectedRoutes.has(candidate.deviceId) || selectedAeds.has(candidate.route.aedId)) continue;
      selectedRoutes.set(candidate.deviceId, candidate.route);
      selectedAeds.add(candidate.route.aedId);
    }
    const aedShortfall = aedSlotsForFlexible - selectedRoutes.size;
    if (aedShortfall > 0) {
      // AED scarcity is a recorded degradation, not a reason to roll back an
      // otherwise valid response.  The selected routes remain distinct and
      // every unassigned flexible responder is sent directly to the patient.
      appendTimeline(
        state,
        event.id,
        at.toISOString(),
        "PASSIVE_OBSERVATION",
        `AED resource shortfall: ${aedShortfall} FETCH_AED role(s) could not be filled; remaining responders proceed to the patient.`
      );
    }
    const desired = new Map<string, { role: "GO_TO_PATIENT" | "FETCH_AED"; route: AedRoute | null }>();
    for (const deviceId of flexible) {
      desired.set(deviceId, selectedRoutes.has(deviceId)
        ? { role: "FETCH_AED", route: selectedRoutes.get(deviceId) ?? null }
        : { role: "GO_TO_PATIENT", route: null });
    }

    const changes: Array<{ assignment: AssignmentRecord; created: boolean }> = [];
    const nextRevision = event.assignmentRevision + 1;
    for (const [deviceId, next] of desired) {
      const current = activeByDevice.get(deviceId);
      const routeChanged = fingerprint(current?.route ?? null) !== fingerprint(next.route);
      if (current && current.role === next.role && !routeChanged) continue;
      if (current) {
        current.role = next.role;
        current.route = next.route;
        current.revision = nextRevision;
        current.updatedAt = at.toISOString();
        changes.push({ assignment: current, created: false });
      } else {
        const assignment: AssignmentRecord = {
          id: randomUUID(),
          eventId: event.id,
          deviceInstanceId: deviceId,
          role: next.role,
          status: "ASSIGNED",
          revision: nextRevision,
          route: next.route,
          aedAcquiredReceipt: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString()
        };
        state.assignments[assignment.id] = assignment;
        activeByDevice.set(deviceId, assignment);
        changes.push({ assignment, created: true });
      }
    }
    for (const deviceId of accepted) {
      const device = state.devices[deviceId];
      const assignment = activeByDevice.get(deviceId);
      if (!device || !assignment) continue;
      device.currentEventId = event.id;
      device.currentAssignmentId = assignment.id;
    }
    reconcileEventAssets(state, event.id, at.toISOString());
    if (changes.length === 0) return [];
    event.assignmentRevision = nextRevision;
    const emissions: AssignmentEmission[] = changes.map(({ assignment, created }) => {
      appendTimeline(
        state,
        event.id,
        at.toISOString(),
        created ? "ASSIGNMENT_CREATED" : "ASSIGNMENT_UPDATED",
        `Assignment ${assignment.id} is ${assignment.role} at revision ${assignment.revision}.`
      );
      return {
        deviceInstanceId: assignment.deviceInstanceId,
        name: created ? "assignment:created" as const : "assignment:updated" as const,
        assignment: assignmentView(assignment),
        occurredAt: at.toISOString()
      };
    });
    return emissions;
  }

  private allCurrentAssignmentsCompleted(state: Readonly<PersistentState>, eventId: string): boolean {
    const devices = acceptedDeviceIds(this.recruitmentContext(state), eventId);
    return devices.length > 0 && devices.every((deviceId) => currentAssignmentForDevice(
      state,
      eventId,
      deviceId
    )?.status === "COMPLETED");
  }

  private authorizeResolution(
    state: Readonly<PersistentState>,
    event: EventRecord,
    principal: Principal,
    actor: ResolutionRequest["actor"]
  ): void {
    if (actor === "AUTHORIZED_OPERATOR") {
      if (principal.kind !== "OPERATOR") {
        throw forbidden("AUTHORIZED_OPERATOR requires the out-of-band operator credential");
      }
      return;
    }
    const device = requireIPhone(principal);
    if (actor === "PATIENT") {
      if (!isPatientDevice(state, event, device.deviceInstanceId)) {
        throw forbidden("PATIENT resolution requires the associated patient device");
      }
      return;
    }
    const assignment = currentAssignmentForDevice(state, event.id, device.deviceInstanceId);
    if (!assignment || !["ARRIVED_AT_PATIENT", "COMPLETED"].includes(assignment.status)) {
      throw forbidden("ON_SCENE_RESPONDER resolution requires arrival at the patient");
    }
  }

  private envelope(messageId: string, eventId: string, occurredAt: string) {
    return {
      schemaVersion: "2.0" as const,
      messageId,
      eventId,
      occurredAt
    };
  }

  private validateActionTime(value: string, field: string, serverReceivedAt = this.now()): string {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw badRequest(`${field} must be an ISO-8601 timestamp`);
    if (milliseconds > serverReceivedAt.getTime() + 5 * 60_000) {
      throw badRequest(`${field} is too far in the future`);
    }
    return new Date(milliseconds).toISOString();
  }

  /**
   * Client timestamps are claims, not authority. A valid claim may be behind
   * the server clock and can never place a business transition in the future.
   * Safety-sensitive prerequisites reject a backdated claim. Emergency-priority
   * end/exit actions clamp one to the latest causal fact instead.
   */
  private effectiveActionTime(
    claimedAt: string,
    field: string,
    causalLowerBoundAt: string,
    causalLowerBoundField: string,
    serverReceivedAt: Date,
    causalPolicy: "REJECT" | "CLAMP" = "REJECT"
  ): string {
    const claimedMilliseconds = Date.parse(claimedAt);
    const lowerBoundMilliseconds = Date.parse(causalLowerBoundAt);
    const receivedMilliseconds = serverReceivedAt.getTime();
    if (!Number.isFinite(lowerBoundMilliseconds)) {
      throw conflict(`${causalLowerBoundField} is not a valid causal timestamp`);
    }
    if (claimedMilliseconds < lowerBoundMilliseconds && causalPolicy === "REJECT") {
      throw badRequest(`${field} must not be earlier than ${causalLowerBoundField}`);
    }
    if (receivedMilliseconds < lowerBoundMilliseconds) {
      throw conflict(`Server receipt time precedes ${causalLowerBoundField}`);
    }
    return new Date(Math.max(
      Math.min(claimedMilliseconds, receivedMilliseconds),
      lowerBoundMilliseconds
    )).toISOString();
  }

  private validateClientTime(value: string, field: string, serverReceivedAt = this.now()): string {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) {
      throw badRequest(`${field} must be an ISO-8601 timestamp`);
    }
    if (milliseconds > serverReceivedAt.getTime() + this.config.maxClientClockSkewSeconds * 1_000) {
      throw conflict(`${field} exceeds the configured client clock-skew allowance`);
    }
    return new Date(milliseconds).toISOString();
  }
}
