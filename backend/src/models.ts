import type { AedAssetActionRecord } from "./aed-assets.js";
import type { EvidenceLogRecord, EvidenceHeadRecord } from "./evidence-integrity.js";
import type { SimulationObservation, SimulationMarker } from "./simulation.js";
import type {
  Aed,
  AedAcquiredReceipt,
  AedPosition,
  AedUnavailableReport,
  AssignmentRole,
  AssignmentStatus,
  DeliveryStatus,
  DeviceCapabilities,
  PatientPosition,
  ResponderPosition,
  UserReportedPatientObservation,
  WatchEmergencyObservation,
  WatchFallbackPositionUpdate,
  WatchTriggerSource,
  EventEndReason
} from "./contracts.js";
import type { AccountProvider } from "./auth.js";
import type { AedAssetRecord } from "./aed-asset-model.js";

export type DeviceKind = "IPHONE" | "WATCH";
export type EventState =
  | "ACTIVE"
  | "CANCELLED_CONFIRMED_FALSE_ALARM"
  | "CANCELLED_ASSISTANCE_WITHDRAWN"
  | "RESOLVED"
  | "CLOSED_UNCONFIRMED_NO_RESPONSE";
export type RecruitmentState = "RECRUITING" | "STOPPED" | "COMPLETED";
export type ViewerRelationship = "NEUTRAL" | "PATIENT" | "RESPONDER";
export type SessionKind = "ACCOUNT" | "DEVICE";
export type PatientPositionSource =
  | "WATCH_TRIGGER_SNAPSHOT"
  | "IPHONE_PRIMARY"
  | "WATCH_FALLBACK";
export type PositioningTier = "STANDBY" | "SEARCH_RING" | "EVENT_PARTICIPANT";
export type DistanceRange =
  | "DISTANCE_0_500M"
  | "DISTANCE_500_1000M"
  | "DISTANCE_1000_1500M"
  | "DISTANCE_1500_2000M"
  | "DISTANCE_OVER_2000M";
export type EtaRange =
  | "ETA_0_5_MIN"
  | "ETA_5_10_MIN"
  | "ETA_10_15_MIN"
  | "ETA_OVER_15_MIN";
export interface AgreementRecord {
  version: string;
  acceptedAt: string;
}

export type AgreementKind =
  | "PATIENT"
  | "VOLUNTEER_RESPONDER"
  | "PRIVACY_POLICY"
  | "SENSITIVE_PERSONAL_INFORMATION";

/** Stable product identity. A user may own one account for each provider. */
export interface UserRecord {
  lifecycleState?: "ACTIVE" | "CLOSED";
  closedAt?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Minimal durable audit for an in-app account deletion request.  It answers
 * "was deletion requested, by which identity, and is it outstanding" without
 * retaining the erased profile: no phone number, provider subject hash, device
 * identifier or position is copied here.
 */
export interface DeletionRequestRecord {
  requestId: string;
  userId: string;
  requestedAt: string;
  status: "REQUESTED" | "CLOSED";
  accountClosed?: true;
  accountClosedAt?: string;
  /** Cutoff the retained-evidence layer uses for this identity. */
  erasureStartedAt: string;
  /** Which collections were purged in the same transaction, for operator audit. */
  purged: string[];
}

/** Durable access-audit entry.  Append-only; never rewritten by business code. */
export interface AccessAuditRecord {
  entryId: string;
  actor: string;
  actorKind: "OPERATOR" | "ACCOUNT" | "DEVICE" | "SYSTEM";
  dataClass: "EVENT_SUMMARY" | "PRECISE_PATIENT_POSITION" | "PARTICIPANT_POSITION"
    | "PARTICIPANT_IDENTITY" | "EVIDENCE" | "RETENTION" | "LEGAL_HOLD" | "ACCOUNT_ADMIN";
  subjectId: string;
  reason: string;
  grantId?: string;
  recordedAt: string;
  outcome: "ALLOWED" | "DENIED";
}

/** One single-event, read-only, time-boxed break-glass grant. */
export interface BreakGlassGrantRecord {
  grantId: string;
  eventId: string;
  issuedBy: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  scope: "READ_ONLY";
  usedAt?: string;
}

/** One 15-second reroute proposal for an in-flight AED task. */
export interface RerouteProposalRecord {
  proposalId: string;
  eventId: string;
  assignmentId: string;
  deviceInstanceId: string;
  userId?: string;
  fromAedId: string;
  toAedId: string;
  proposedRoute: AedRoute;
  proposedFrom: { latitude: number; longitude: number };
  etaSavingSeconds: number;
  proposedAt: string;
  expiresAt: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "REFUSED";
  decidedAt?: string;
  refusalReason?: string;
}

/**
 * G09 — the durable handover fact between two participants of one event.
 *
 * `status` is derived from confirmations, never asserted by a client:
 *   PENDING   opened, at least one side has not confirmed;
 *   CONFIRMED both sides confirmed, waiting for the holder to settle the mode;
 *   SETTLED   the device changed hands (or was placed at a temporary point);
 *   HALTED    the holder left or the event ended before it completed.
 *
 * `custody` on the asset is only rewritten when this reaches SETTLED, which is
 * what keeps "task ended" from ever meaning "device returned".
 */
export interface AedHandoverRecord {
  handoverId: string;
  /** The holder's idempotency key for opening this handover. */
  requestId: string;
  eventId: string;
  aedId: string;
  /** The task that acquired the device; the task is not the custody. */
  assignmentId: string;
  mode: "FACE_TO_FACE" | "TEMPORARY_POINT";
  status: "PENDING" | "CONFIRMED" | "SETTLED" | "HALTED";
  holderDeviceInstanceId: string;
  holderUserId?: string;
  receiverDeviceInstanceId?: string;
  receiverUserId?: string;
  holderConfirmedAt?: string;
  receiverConfirmedAt?: string;
  /** Copied from the acquisition receipt: when the device left its cabinet. */
  acquiredAt: string;
  initiatedAt: string;
  settledAt?: string;
  haltedAt?: string;
  haltReason?: string;
  /** Set when the mode is TEMPORARY_POINT and the placement was recorded. */
  temporaryPointDepositId?: string;
  revision: number;
}

/**
 * A private photo reference.
 *
 * The metadata is what the client declares and the server checks; the bytes live
 * in private object storage and are never served by this backend.  The record is
 * kept separately from the deposit so the same object can never be re-described
 * with a different hash.
 */
export interface AedPhotoReference {
  objectKey: string;
  handoverId: string;
  eventId: string;
  mimeType: "image/jpeg";
  byteSize: number;
  widthPixels: number;
  heightPixels: number;
  exifStripped: true;
  sha256: string;
  capturedAt: string;
  recordedAt: string;
  /** True only when the configured store confirmed the bytes hash as declared. */
  verifiedAgainstStorage: boolean;
}

/**
 * The temporary placement point: where the device actually is now.
 *
 * Created only when the position and the photo reference are BOTH valid, which is
 * why it is a separate fact from the handover: a failed photo leaves no placement
 * to dispatch from.
 */
export interface AedTemporaryPointDepositRecord {
  depositId: string;
  /** The holder's idempotency key for the placement. */
  requestId: string;
  handoverId: string;
  eventId: string;
  aedId: string;
  status: "SEARCHING" | "FOUND" | "NOT_FOUND";
  position: ResponderPosition;
  positionObservedAt: string;
  objectKey: string;
  placedByDeviceInstanceId: string;
  placedByUserId?: string;
  depositedAt: string;
  resolvedAt?: string;
}

/** What the later responder found when they went to the temporary point. */
export interface AedTemporaryPointFollowUpRecord {
  followUpId: string;
  requestId: string;
  depositId: string;
  handoverId: string;
  eventId: string;
  aedId: string;
  outcome: "FOUND" | "NOT_FOUND";
  deviceInstanceId: string;
  userId?: string;
  reportedAt: string;
}

/** Durable queue entry for one pending Apple token revocation. */
export interface AppleRevocationRecord {
  accountId: string;
  userId: string;
  refreshToken: string;
  requestedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastReason?: string;
}

export interface AccountRecord {
  accountId: string;
  userId: string;
  provider: AccountProvider;
  /** Provider-scoped one-way digest; raw phone/Apple subject is never stored. */
  providerSubjectHash: string;
  /**
   * Apple refresh token for this account, when a code exchange produced one.
   *
   * Held ONLY so the account's Apple grant can be revoked when the account is
   * closed, which Apple requires.  It is never returned, never logged, and is
   * replaced by the newest exchange for the same account.
   */
  appleRefreshToken?: string;
  /** Set once Apple confirmed the grant is gone, so it is not revoked twice. */
  appleTokenRevokedAt?: string;
  /**
   * Non-identifying tail of a phone number, retained only so a state file written
   * by a build that still offered PHONE sign-in still validates.  Nothing writes
   * it any more: the product offers Apple sign-in only (2026-09-13), so no phone
   * number is collected.
   */
  phoneLastFour?: string;
  createdAt: string;
  lastLoginAt: string;
}

/**
 * Legacy PHONE challenge rows.
 *
 * Nothing writes these any more: the product offers Apple sign-in only, and the
 * Apple nonce challenge is issued by the injected verifier rather than persisted
 * here.  The collection is kept in the schema so a state file written by an
 * earlier build still loads and validates; the next milestone can drop it once
 * no supported deployment can still hold one.
 */
export interface AuthChallengeRecord {
  challengeId: string;
  provider: "PHONE";
  normalizedPhoneHash: string;
  expiresAt: string;
  issuedAt: string;
  failedAttempts: number;
  lockedAt?: string;
  usedAt?: string;
}

export interface CompanionLinkTicketRecord {
  ticketHash: string;
  userId: string;
  accountId: string;
  iPhoneDeviceId: string;
  companionPairId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  consumedAt?: string;
}

export interface DeviceRecord {
  loginState?: "SIGNED_IN" | "SIGNED_OUT";
  deviceInstanceId: string;
  deviceKind: DeviceKind;
  /** Required for new authenticated bootstrap; absent only on legacy imported rows. */
  userId?: string;
  accountId?: string;
  companionLinkRevokedAt?: string;
  companionPairId: string;
  agreements: Partial<Record<AgreementKind, AgreementRecord>>;
  capabilities: DeviceCapabilities;
  availableForResponse: boolean;
  presenceObservedAt: string;
  latestPosition?: LatestDevicePosition;
  currentEventId?: string;
  currentAssignmentId?: string;
  lastPresenceUpdateId?: string;
  lastSeenAt: string;
  lastBootstrapAt: string;
  /**
   * APNs registration for this device, when the app has one.
   *
   * The token is a routing credential, not identity: it is stored only so the
   * backend can ask APNs to wake THIS installation, it is never returned to any
   * client, and it is cleared the moment APNs reports it invalid or the user
   * signs out.  A device without one keeps working over Socket.IO; push is an
   * additional channel, never the only one.
   */
  pushRegistration?: PushRegistrationRecord;
}

export interface PushRegistrationRecord {
  /** Opaque APNs device token, lowercase hex as APNs spells it. */
  token: string;
  /** APNs host family the token belongs to; a token is only valid on its own. */
  environment: "SANDBOX" | "PRODUCTION";
  /** Which app the token was issued to, so a re-signed bundle cannot inherit it. */
  bundleId: string;
  registeredAt: string;
  updatedAt: string;
}

interface LatestDevicePositionBase {
  positionUpdateId: string;
  observedAt: string;
  serverReceivedAt: string;
}

export interface LatestPatientPosition extends LatestDevicePositionBase {
  position: PatientPosition;
  eventId: string;
}

export interface LatestResponderPosition extends LatestDevicePositionBase {
  position: ResponderPosition;
  eventId?: never;
}

export type LatestDevicePosition = LatestPatientPosition | LatestResponderPosition;

export interface SessionRecord {
  sessionId: string;
  tokenHash: string;
  /** New sessions are explicitly typed; legacy rows imply DEVICE. */
  sessionKind?: SessionKind;
  userId?: string;
  accountId?: string;
  deviceInstanceId?: string;
  deviceKind?: DeviceKind;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  /** Opaque refresh-token rotation metadata; raw refresh tokens are never stored. */
  refreshTokenHash?: string;
  refreshExpiresAt?: string;
  refreshFamilyId?: string;
  refreshRotatedAt?: string;
  refreshRevokedAt?: string;
  /** Confirmation of the explicit logout transaction, not ordinary token expiry/rotation. */
  logoutCompletedAt?: string;
  /** Narrow replay confirmation for the account token that requested closure. */
  accountClosureRequestId?: string;
  revokedAt?: string;
}

export interface PatientLocationCard {
  address: string;
  floor: string;
  accessNote: string;
}

export interface EventRecord {
  id: string;
  /**
   * How this event began.  Three honest shapes: a Watch fall observation, an
   * administrative simulation, or a person reporting a patient they found.  The
   * reported shape carries no fall fields because nobody measured a fall.
   */
  observation: WatchEmergencyObservation | SimulationObservation | UserReportedPatientObservation;
  observationFingerprint: string;
  patientPairId: string;
  /** Stable patient identity; patientDeviceIds lists only authorized P sources. */
  patientUserId: string;
  patientDeviceIds: string[];
  triggeringWatchDeviceId?: string;
  patientPosition?: CurrentPatientPosition;
  iphonePatientPosition?: CurrentPatientPosition;
  watchFallbackPosition?: CurrentPatientPosition;
  watchFallbackCandidate?: WatchFallbackCandidateRecord;
  watchFallbackCadence?: WatchFallbackCadenceRecord;
  state: EventState;
  recruitmentState: RecruitmentState;
  triggerSource: WatchTriggerSource | "SIMULATED_TEST" | "USER_REPORTED_PATIENT";
  currentRecruitmentRadiusMeters: number;
  recruitmentStageStartedAt: string | null;
  /** Server-generated patient status-confirmation cycle anchor. */
  statusConfirmationCycleStartedAt?: string;
  /** At most one unanswered status check can be active at a time. */
  statusConfirmation?: EventStatusConfirmationRecord;
  /** Append-only history retained for restart-safe audits and idempotency. */
  statusConfirmationHistory?: EventStatusConfirmationRecord[];
  /** Stable identities that explicitly exited this event and may never rejoin. */
  exitedResponderUserIds?: string[];
  terminalReason?: EventEndReason | "CLOSED_UNCONFIRMED_NO_RESPONSE";
  patientLocationCard?: PatientLocationCard;
  createdAt: string;
  /** Server-authoritative effective terminal time and exclusive P boundary. */
  resolvedAt?: string;
  coordinationRevision: number;
  assignmentRevision: number;
  unavailableAedIds: string[];
  /**
   * Retention lifecycle for a TERMINAL event's evidence.
   *
   * Absent on active events and on events whose terminal time is unknown.  The
   * policy is a promise to the user (30 days online, sealed to 3 years, then the
   * precise evidence goes and only an irreversible aggregate stays), so it is a
   * server-owned field: the retention sweeper writes it, business code only
   * reads it.  `assertEntityWriteAllowed` enforces that direction.
   */
  retention?: EventRetentionRecord;
}

/** Which layer an event's evidence currently lives in. */
export type EventRetentionTier = "ONLINE" | "SEALED" | "PURGED";

export interface EventRetentionRecord {
  tier: EventRetentionTier;
  /** Terminal time the retention clock is measured from. */
  clockStartedAt: string;
  sealedAt?: string;
  /**
   * Encrypted cold copy of this event's evidence, once it exists.
   *
   * Recorded so the purge can refuse to run without a durable copy: a tier label
   * is not a backup, and deleting the online rows on the strength of a label is
   * how evidence is lost.
   */
  sealedContainer?: {
    path: string;
    bytes: number;
    sealedAt: string;
  };
  purgedAt?: string;
  /** Legal hold freezes this event: the sweeper must skip it entirely. */
  legalHold?: LegalHoldRecord;
  /**
   * What remains after the 3-year purge: counts and durations only, no precise
   * trajectory, no message text, no device or identity association.
   */
  summary?: PurgedEventSummary;
}

/**
 * Irreversible aggregate kept after the 3-year purge.
 *
 * Deliberately counts, durations and coarse identifiers: no coordinates, no
 * device instance ids, no user ids, no AED ids (an AED id is a cabinet, i.e. a
 * location), and no free text.
 */
export interface PurgedEventSummary {
  triggerSource: string;
  terminalReason?: string;
  createdAt: string;
  resolvedAt: string;
  /** Seconds from `createdAt` to the terminal time. */
  durationSeconds: number;
  acceptedResponderCount: number;
  completedResponderCount: number;
  aedAcquiredCount: number;
  aedUnavailableReportCount: number;
  positionBatchCount: number;
  positionRecordCount: number;
  statusConfirmationCount: number;
  /**
   * Photo references whose bytes were deleted with this purge.
   *
   * Counted here so the signed authorization says media was erased; the objects
   * themselves are gone from the private store and must not be recoverable from
   * this record.
   */
  mediaReferenceCount: number;
  purgedCollectionCount: number;
}

/** Legal hold: freezes one event and records who said so and why. */
export interface LegalHoldRecord {
  placedAt: string;
  /** Business reference for the lawful basis; free text is bounded by the API. */
  authority: string;
  reason: string;
  releasedAt?: string;
}

/**
 * Durable authorisation for one retention purge.
 *
 * Event evidence is append-only, and that guard is what makes the audit
 * trustworthy — so the purge must not be a hole in it.  Instead of weakening the
 * guard, a purge writes this record FIRST, in its own committed transaction, and
 * the guard then permits deleting that one event's evidence.  The record is
 * immutable and never deleted, so it stays provable after the fact that the
 * deletion was a retention action on a specific event at a specific time.
 */
/**
 * One self-service access request (G11).
 *
 * `eventIds` is resolved on the server from participation records, never accepted
 * from the client.  `challengeNonce` is single-use: verifying it is what moves the
 * request to `PENDING_APPROVAL`, and the grant is bounded to 24 hours from the
 * operator's decision.
 */
export interface SelfAccessRequestRecord {
  requestId: string;
  userId: string;
  accountId: string;
  deviceInstanceId: string;
  requestedAt: string;
  eventIds: string[];
  /**
   * The single-use nonce.  Present ONLY while the request awaits its challenge:
   * a consumed nonce is removed rather than kept, so "single use" is a property of
   * the stored record instead of a promise about the code path.
   */
  challengeNonce?: string;
  challengeExpiresAt: string;
  /** Wrong-signature attempts, so a request cannot be brute forced forever. */
  challengeAttempts: number;
  status: "PENDING_CHALLENGE" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXPIRED" | "REVOKED";
  /** Set only after a signature over the nonce verified. */
  challengeVerifiedAt?: string;
  /** Fingerprint of the key that answered; the key itself is never stored. */
  challengeKeyFingerprint?: string;
  localAuthMethod?: "BIOMETRIC" | "PASSCODE";
  /** Working-day deadline for the operator decision, fixed at request time. */
  approvalDeadlineAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  grant?: {
    grantId: string;
    grantedAt: string;
    /** Never later than grantedAt + 24 hours. */
    expiresAt: string;
    mode: "READ_ONLY";
  };
  revokedAt?: string;
  revocationReason?: string;
}

/**
 * One security log entry (G12).
 *
 * A closed vocabulary by design: there is no field for a token, a body, a
 * coordinate or a message, and the store validator refuses unknown keys.  Route is
 * a template with identifiers replaced, so the log can be counted per endpoint
 * without recording who was asked about.
 */
export interface SecurityLogRecord {
  entryId: string;
  occurredAt: string;
  event:
    | "AUTH_REJECTED"
    | "SESSION_REPLAY_REJECTED"
    | "SCOPE_REJECTED"
    | "OPERATOR_REJECTED"
    | "RATE_LIMIT_EXCEEDED"
    | "PROXY_HEADER_REJECTED"
    | "REQUEST_REJECTED"
    | "SELF_ACCESS_CHALLENGE_REJECTED"
    | "MEDIA_STORE_UNAVAILABLE"
    | "SECURITY_LOG_RETENTION";
  outcome: "DENIED" | "ALLOWED";
  /** Opaque subject (user/device/entry id); never a token or a message. */
  subjectId?: string;
  /** A reason CODE, never free text copied from a request. */
  reasonCode?: string;
  /** Route template, e.g. `/api/v2/events/{id}`; never a query string. */
  route?: string;
  sourceClass?: "LOOPBACK_PROXY" | "DIRECT" | "UNKNOWN";
}

/**
 * One anonymous in-app contact signal (G08).
 *
 * Deliberately has NO free-text field: the contact form is a closed vocabulary of
 * preset signals (`TEAM_SIGNAL_KINDS`), which is what keeps names, coordinates and
 * message bodies out of the channel by construction rather than by moderation.
 */
export interface TeamSignalRecord {
  signalId: string;
  eventId: string;
  senderDeviceInstanceId: string;
  senderUserId?: string;
  kind: "ACCEPTED_TASK" | "ON_MY_WAY" | "ARRIVED_AT_PATIENT" | "AED_ACQUIRED"
    | "NEED_HELP_HERE" | "CANNOT_CONTINUE";
  createdAt: string;
  /** A signal is about the next minutes of a response, not a message history. */
  expiresAt: string;
  acknowledgedByDeviceIds: string[];
}

export interface RetentionPurgeRecord {
  purgeId: string;
  eventId: string;
  authorizedAt: string;
  /** Why the purge was allowed: the tier transition that triggered it. */
  reason: "THREE_YEAR_RETENTION_EXPIRED";
  summary: PurgedEventSummary;
  /** Minimal signed authorization survives deletion of the underlying chain. */
  evidenceHead?: EvidenceHeadRecord;
  integrity?: import("./evidence-integrity.js").EvidenceProof;
}

export interface CurrentPatientPosition {
  positionUpdateId: string;
  source: PatientPositionSource;
  position: PatientPosition;
  observedAt: string;
  serverReceivedAt: string;
}

export interface WatchFallbackCandidateRecord {
  positionUpdateId: string;
  position: PatientPosition;
  observedAt: string;
  serverReceivedAt: string;
}

/** Latest sample used to evidence the 5-second/10-meter Watch cadence. */
export interface WatchFallbackCadenceRecord {
  positionUpdateId: string;
  position: PatientPosition;
  observedAt: string;
  serverReceivedAt: string;
  intervalSeconds?: number;
  distanceMeters?: number;
}

export interface ResponseRequestPayload {
  simulation?: SimulationMarker;
  schemaVersion: "2.0";
  messageId: string;
  eventId: string;
  deliveryId: string;
  deliveryStatus: "SENT" | "DELIVERED" | "VIEWED";
  occurredAt: string;
  eventType: "FALL_ASSISTANCE";
  positioningTier: "SEARCH_RING";
  distanceRange: DistanceRange;
  etaRange: EtaRange;
  currentRecruitmentRadiusMeters: number;
  expiresAt: string;
}

export interface DeliveryRecord {
  id: string;
  eventId: string;
  deviceInstanceId: string;
  request: ResponseRequestPayload;
  status: DeliveryStatus;
  statusOccurredAt: string;
  decision?: "ACCEPT" | "REFUSE";
  decisionFingerprint?: string;
  /** Server-authoritative effective decision time, never later than receipt. */
  decidedAt?: string;
}

export interface AedRoute {
  aedId: string;
  path: [ResponderPosition, AedPosition, PatientPosition];
  etaSeconds: number;
  walkingSeconds: number;
  overheadSeconds: number;
}

export interface AssignmentRecord {
  id: string;
  eventId: string;
  deviceInstanceId: string;
  role: AssignmentRole;
  status: AssignmentStatus;
  revision: number;
  route?: AedRoute | null;
  aedAcquiredReceipt?: AedAcquiredReceipt | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  id: string;
  eventId: string;
  occurredAt: string;
  kind:
    | "WATCH_FALL_HELP_CONFIRMED"
    | "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED"
    | "EVENT_ACTIVATED"
    | "RESPONSE_REQUESTED"
    | "RECEIPT_ADVANCED"
    | "RESPONSE_ACCEPTED"
    | "RESPONSE_REFUSED"
    | "ASSIGNMENT_CREATED"
    | "ASSIGNMENT_UPDATED"
    | "AED_ACQUIRED"
    | "AED_UNAVAILABLE"
    | "ASSIGNMENT_TIMED_OUT"
    | "FALSE_ALARM_CONFIRMED"
    | "EVENT_RESOLVED"
    | "RESPONDER_EXITED"
    | "STATUS_CONFIRMATION_REQUESTED"
    | "STATUS_CONFIRMATION_CONTINUED"
    | "STATUS_CONFIRMATION_TIMED_OUT"
    | "PATIENT_POSITION_UPDATED"
    | "DEVICE_PRESENCE_UPDATED"
    | "PASSIVE_OBSERVATION";
  message: string;
}

export interface ReceiptRecord {
  canonical: AedAcquiredReceipt;
  fingerprint: string;
}

export interface AedUnavailableRecord {
  canonical: AedUnavailableReport;
  fingerprint: string;
}

export interface ResolutionRecord {
  eventId: string;
  resolutionId: string;
  fingerprint: string;
  actorDeviceInstanceId?: string;
  actor: "PATIENT" | "ON_SCENE_RESPONDER" | "AUTHORIZED_OPERATOR";
  reason?: EventEndReason;
}

export type EventStatusConfirmationState =
  | "PENDING"
  | "CONTINUED"
  | "CLOSED_UNCONFIRMED_NO_RESPONSE"
  | "ENDED_BY_EVENT";

export interface EventStatusConfirmationRecord {
  confirmationId: string;
  cycleStartedAt: string;
  sentAt: string;
  responseDeadlineAt: string;
  state: EventStatusConfirmationState;
  respondedAt?: string;
  /** Fingerprint of the client's claimed response timestamp for stable replay. */
  responseFingerprint?: string;
  closedAt?: string;
}

export interface StatusConfirmationView {
  confirmationId: string;
  prompt: "STILL_IN_PROGRESS";
  sentAt: string;
  responseDeadlineAt: string;
}

export interface ParticipantExitRecord {
  exitId: string;
  eventId: string;
  deviceInstanceId: string;
  userId: string;
  /** Server-authoritative effective exit time and exclusive evidence boundary. */
  exitedAt: string;
  fingerprint: string;
  reason?: string;
}

export type ParticipantIntervalEndReason =
  | "RESPONDER_EXIT"
  | "TIMED_OUT"
  | "CANCELLED"
  | "PATIENT_PRIORITY"
  | "EVENT_ENDED";

/**
 * Immutable event participation history. The accepted interval is created
 * once and may only transition from open to one terminal endedAt/reason pair.
 */
export interface ParticipantIntervalRecord {
  eventId: string;
  userId: string;
  deviceInstanceId: string;
  acceptedAt: string;
  endedAt?: string;
  endReason?: ParticipantIntervalEndReason;
}

export interface PositionUpdateResult {
  positionUpdateId: string;
  applied: boolean;
  idempotent: boolean;
  ignoredAsStale: boolean;
  positionObservedAt: string;
  serverReceivedAt: string;
  /** Live response metadata only; not part of the immutable position receipt. */
  positioningTier?: PositioningTier;
}

interface EventPositionEvidenceBase {
  recordId: string;
  batchId: string;
  eventId: string;
  userId: string;
  deviceInstanceId: string;
  kind: "P" | "R";
  slotAt: string;
  serverReceivedAt: string;
  appliedToLatest: boolean;
  ignoredAsStale: boolean;
}

export type EventPositionEvidenceRecord = EventPositionEvidenceBase & ({
  status: "FIX";
  position: PatientPosition | ResponderPosition;
  fixObservedAt: string;
} | {
  status: "NO_NEW_FIX";
  gapReason: "NO_FIX" | "APP_NOT_RUNNING";
});

export interface EventPositionBatchRecord {
  batchId: string;
  eventId: string;
  userId: string;
  deviceInstanceId: string;
  kind: "P" | "R";
  fingerprint: string;
  receivedAt: string;
  records: EventPositionEvidenceRecord[];
}

export interface EventPositionRecordAck {
  recordId: string;
  persisted: boolean;
  appliedToLatest: boolean;
  ignoredAsStale: boolean;
  serverReceivedAt: string;
}

export interface EventPositionBatchAck {
  schemaVersion: "2.0";
  eventId: string;
  batchId: string;
  acceptedRecordCount: number;
  idempotent: boolean;
  acknowledgedAt: string;
  records: EventPositionRecordAck[];
}

export interface PositionUpdateReceipt {
  deviceInstanceId: string;
  eventId?: string;
  kind: "P" | "R";
  fingerprint: string;
  recordedAt: string;
  result: PositionUpdateResult;
  /** Actual received Watch payload; absent on old summary-only receipts. */
  watchFallbackFact?: WatchFallbackPositionUpdate;
}

export interface WatchEventStateView {
  fallbackAllowed?: boolean;
  eventId: string;
  state: EventState;
  createdAt: string;
  resolvedAt: string | null;
}

export interface PresenceUpdateReceipt {
  deviceInstanceId: string;
  fingerprint: string;
  recordedAt: string;
}

/**
 * Whether a stored coordinate may be treated as the device's *current* location.
 *
 * `UNAVAILABLE` covers both "no coordinate at all" and "a coordinate whose
 * timestamp cannot be interpreted": a sample we cannot place in time must never
 * be presented as fresh or as a known-age last position.
 */
export type PositionFreshness = "FRESH" | "STALE" | "UNAVAILABLE";

/**
 * A coordinate plus the time it was sampled.
 *
 * Unlike the raw stored sample this is explicitly a *last known* position: it is
 * retained past the validity window so a responder can still be told where the
 * patient was last seen. `DevicePresenceView.freshness` — not the presence of
 * this object — is what decides whether it is current.
 */
export interface LastKnownPosition {
  coordinate: PatientPosition | ResponderPosition;
  observedAt: string;
}

export interface DevicePresenceView {
  deviceInstanceId: string;
  deviceKind: DeviceKind;
  lastSeenAt: string;
  availableForResponse: boolean;
  capabilities: DeviceCapabilities;
  positioningTier: PositioningTier;
  /** Last known coordinate; retained past the freshness window. */
  position?: LastKnownPosition | null;
  /** The only field that says whether `position` may be used as current. */
  freshness: PositionFreshness;
  /** Age of `position` in whole seconds; `null` when it cannot be computed. */
  ageSeconds?: number | null;
  currentEventId?: string | null;
  currentAssignmentId?: string | null;
  lastPresenceUpdateId?: string | null;
  lastPresenceOccurredAt?: string | null;
}

export interface NearbyVolunteerRangeCount {
  radiusMeters: 1_000 | 1_500 | 2_000;
  count: number;
}

/**
 * Privacy-minimal standby projection. The response contains only cumulative
 * counts of stable users; individual volunteer identities and coordinates do
 * not cross the service boundary.
 */
export interface NearbyVolunteerSummary {
  generatedAt: string;
  ranges: NearbyVolunteerRangeCount[];
}

export interface CoordinationSummary {
  revision: number;
  currentRecruitmentRadiusMeters: number;
  nearbyCandidateCount: number;
  pendingOfferCount: number;
  acceptedResponderCount: number;
  goToPatientCount: number;
  fetchAedCount: number;
  enRouteCount: number;
  arrivedAtAedCount: number;
  arrivedAtPatientCount: number;
  aedAcquiredCount: number;
  completedAssignmentCount: number;
}

export type NotificationName = "event:patient-activated" | "response:requested"
  | "event:team-signal"
  | "assignment:reroute-proposed"
  | "event:false-alarm-confirmed" | "event:assistance-withdrawn" | "event:resolved"
  | "event:closed-unconfirmed-no-response" | "response:offer-expired"
  | "event:patient-position-updated" | "event:status-confirmation-requested"
  | "event:participant-exited" | "event:coordination-updated"
  | "response:decision-recorded" | "assignment:created" | "assignment:updated"
  | "aed:acquired" | "aed:unavailable";

export interface NotificationRecord {
  id: string;
  eventId: string;
  name: NotificationName;
  recipient: {
    deviceInstanceId: string;
    companionPairId: string;
    userId?: string;
    accountId?: string;
  };
  payload: Record<string, unknown>;
  status: "PENDING" | "DISPATCHED" | "SUPPRESSED";
  attempts: number;
  nextAttemptAt: string;
  completedAt?: string;
  /**
   * System-push attempt record, deliberately separate from the socket `status`.
   *
   * A row can be socket-DISPATCHED and push-RETRY at the same time: the two
   * channels have different failure modes, and collapsing them would let a
   * successful socket handoff hide the fact that APNs never accepted the wake-up
   * the user needs when the app is suspended.
   */
  push?: PushAttemptRecord;
}

export interface PushAttemptRecord {
  status: "PENDING" | "DELIVERED" | "RETRY" | "INVALID_TOKEN" | "NOT_REGISTERED";
  attempts: number;
  lastAttemptAt: string;
  reason?: string;
}

export interface PersistentState {
  schemaVersion: "2.0";
  users: Record<string, UserRecord>;
  accounts: Record<string, AccountRecord>;
  accountIdByProviderKey: Record<string, string>;
  authChallengesById: Record<string, AuthChallengeRecord>;
  companionLinkTicketsByHash: Record<string, CompanionLinkTicketRecord>;
  devices: Record<string, DeviceRecord>;
  sessionsByTokenHash: Record<string, SessionRecord>;
  events: Record<string, EventRecord>;
  deliveries: Record<string, DeliveryRecord>;
  assignments: Record<string, AssignmentRecord>;
  timelineByEventId: Record<string, TimelineEntry[]>;
  aedReceiptsById: Record<string, ReceiptRecord>;
  aedReceiptIdByBusinessKey: Record<string, string>;
  aedReceiptIdByEventAed: Record<string, string>;
  aedUnavailableByReportId: Record<string, AedUnavailableRecord>;
  resolutionsById: Record<string, ResolutionRecord>;
  notificationOutboxById: Record<string, NotificationRecord>;
  participantExitsById: Record<string, ParticipantExitRecord>;
  participantIntervalsById: Record<string, ParticipantIntervalRecord>;
  eventPositionBatchesById: Record<string, EventPositionBatchRecord>;
  /**
   * Immutable quarantine for legacy event evidence whose observedAt cannot be
   * truthfully converted to the strict second-slot contract. It is never read
   * by business APIs or latest-position projection code.
   */
  quarantinedLegacyEventPositionBatchesById: Record<string, unknown>;
  positionUpdateReceiptsById: Record<string, PositionUpdateReceipt>;
  presenceUpdateReceiptsById: Record<string, PresenceUpdateReceipt>;
  /** Durable audit of in-app account deletion requests. */
  deletionRequestsById: Record<string, DeletionRequestRecord>;
  /** Apple grants still to be revoked; retried until Apple confirms. */
  appleRevocationsById: Record<string, AppleRevocationRecord>;
  /** Outstanding and decided reroute proposals for in-flight AED tasks. */
  rerouteProposalsById: Record<string, RerouteProposalRecord>;
  /** Append-only access audit; separate from the business event timeline. */
  accessAuditById: Record<string, AccessAuditRecord>;
  /** Break-glass grants, scoped to one event and expiring within 30 minutes. */
  breakGlassGrantsById: Record<string, BreakGlassGrantRecord>;
  /**
   * G11 self-service access requests.  One row per request, carrying its
   * single-use signature challenge, the operator decision and the short-lived
   * read-only grant.  Never rewritten by business code after a decision.
   */
  selfAccessRequestsById: Record<string, SelfAccessRequestRecord>;
  /** Security log, 6-month retention, minimal by construction (G12). */
  securityLogById: Record<string, SecurityLogRecord>;
  /** G08 preset team signals, scoped to one event and expiring with it. */
  teamSignalsById: Record<string, TeamSignalRecord>;
  /** Durable authorisation for each retention purge; never rewritten or removed. */
  retentionPurgesById: Record<string, RetentionPurgeRecord>;
  aedAssetsById: Record<string, AedAssetRecord>;
  aedAssetActionsById: Record<string, AedAssetActionRecord>;
  /** G09 handover facts between two participants of one event, by handoverId. */
  aedHandoversById: Record<string, AedHandoverRecord>;
  /** G09 temporary placement points, by depositId. */
  aedTemporaryPointDepositsById: Record<string, AedTemporaryPointDepositRecord>;
  /** G09 follow-up outcomes; at most one per deposit. */
  aedTemporaryPointFollowUpsById: Record<string, AedTemporaryPointFollowUpRecord>;
  /** G09 private photo references, by object key. */
  aedPhotoReferencesByObjectKey: Record<string, AedPhotoReference>;
  eventEvidenceLogById: Record<string, EvidenceLogRecord>;
  eventEvidenceHeadsById: Record<string, EvidenceHeadRecord>;
  /**
   * One final reconciliation outcome per (event, device, participation window).
   *
   * The strict second-slot contract promises that every legal UTC second inside
   * a participation window ends up with exactly one fact or an explicit, recorded
   * reason for its absence.  Arrival order cannot be the verdict: a batch that is
   * still in flight, or retried after a process restart, looks identical to a
   * permanent gap until the window is actually closed.  So the verdict is written
   * only when the window closes, and it is re-derived from the recorded facts
   * every time it is recomputed — never from what happened to have arrived first.
   */
  positionWindowReconciliationsById: Record<string, PositionWindowReconciliationRecord>;
  aeds: Aed[];
}

/** Why one expected second inside a participation window has no recorded fact. */
export type PositionGapReason =
  /** No fact ever arrived for this slot and nothing else explains it. */
  | "NEVER_UPLOADED"
  /** The slot falls inside a stretch that was never covered by any batch. */
  | "CLIENT_OFFLINE"
  /** The participant's own session lost location capability for this window. */
  | "PERMISSION_REVOKED"
  /** The client reported the app was not running for this slot. */
  | "APP_NOT_RUNNING"
  /** The client's own queue was rebuilt after a process restart. */
  | "PROCESS_RESTART";

export interface PositionGapRecord {
  /** The UTC second that has no fact, as an ISO instant. */
  slotAt: string;
  reason: PositionGapReason;
  /**
   * Whether a late-but-legal upload may still replace this gap.
   *
   * True until the reconciliation grace deadline passes.  A provisional gap is
   * a work item, not an audit conclusion: nothing may present it as permanent
   * while the client's queue may still be replaying.
   */
  provisional: boolean;
}

/** Why a participation window's reconciliation was computed. */
export type PositionWindowReconciliationClosedBy =
  | "EVENT_TERMINAL"
  | "PARTICIPANT_EXIT"
  | "CLIENT_COMPLETE_SIGNAL";

/** One explicit audit outcome for a single participation window. */
export interface PositionWindowReconciliationRecord {
  reconciliationId: string;
  eventId: string;
  userId: string;
  deviceInstanceId: string;
  kind: "P" | "R";
  /** Inclusive UTC second the window opens at. */
  windowStartedAt: string;
  /** Exclusive UTC second the window closes at. */
  windowEndedAt: string;
  /** Server time this outcome was (re)computed. */
  reconciledAt: string;
  /** Why the window closed. */
  closedBy: PositionWindowReconciliationClosedBy;
  expectedSlotCount: number;
  /** Distinct slots that carry a recorded fact right now. */
  receivedSlotCount: number;
  /** Distinct `recordId`s recorded for this window; the anti-forgery count. */
  receivedRecordCount: number;
  /** Received facts whose status was `NO_NEW_FIX` rather than a real fix. */
  noFixSlotCount: number;
  fixSlotCount: number;
  gaps: PositionGapRecord[];
  /**
   * Deadline for late-but-legal uploads to replace a provisional gap.  Until
   * this instant the gap list is provisional; after it the same list is the
   * final audit conclusion.
   */
  graceDeadlineAt: string;
  /** True once `reconciledAt` passed `graceDeadlineAt`. */
  final: boolean;
  /** How many times reconciliation has been recomputed for this window. */
  revision: number;
  /** True when recomputation changed the gap list (a late fact arrived). */
  correctedByLateEvidence: boolean;
}

export interface AssignmentView {
  id: string;
  eventId: string;
  role: AssignmentRole;
  status: AssignmentStatus;
  revision: number;
  route?: AedRoute | null;
  aedAcquiredReceipt?: AedAcquiredReceipt | null;
}

interface EmergencyEventViewBase {
  simulation?: SimulationMarker;
  id: string;
  state: EventState;
  recruitmentState: RecruitmentState;
  eventType: "FALL_ASSISTANCE";
  positioningTier: PositioningTier;
  /** Whether this authenticated device may write this event's position stream. */
  canPublishEventPosition: boolean;
  /** Inclusive start of this authenticated device's own position evidence window. */
  eventPositionParticipationStartedAt: string | null;
  /** Exclusive end of this authenticated device's own position evidence window. */
  eventPositionParticipationEndedAt: string | null;
  currentRecruitmentRadiusMeters: number;
  viewerRelationship: ViewerRelationship;
  createdAt: string;
  resolvedAt: string | null;
}

export interface PatientEmergencyEventView extends EmergencyEventViewBase {
  viewerRelationship: "PATIENT";
  positioningTier: "EVENT_PARTICIPANT";
  distanceRange: DistanceRange | null;
  etaRange: EtaRange | null;
  expiresAt: null;
  triggerSource: WatchTriggerSource | "SIMULATED_TEST" | "USER_REPORTED_PATIENT";
  recruitmentStageStartedAt: string | null;
  fallDetectedAt: string | null;
  fallResolution: WatchEmergencyObservation["fallResolution"] | null;
  appHelpResponse: WatchEmergencyObservation["appHelpResponse"] | null;
  callFirstObservedAt: string | null;
  patientPosition: PatientPosition | null;
  patientPositionSource: PatientPositionSource | null;
  patientPositionObservedAt: string | null;
  patientPositionServerReceivedAt: string | null;
  patientLocationCard: PatientLocationCard | null;
  coordination: CoordinationSummary;
  pendingResponseRequest: null;
  statusConfirmation?: StatusConfirmationView;
  currentAssignment?: AssignmentView;
}

export interface ResponderEmergencyEventView extends EmergencyEventViewBase {
  viewerRelationship: "RESPONDER";
  positioningTier: "EVENT_PARTICIPANT";
  distanceRange: DistanceRange | null;
  etaRange: EtaRange | null;
  expiresAt: null;
  patientPosition: PatientPosition | null;
  patientPositionSource: PatientPositionSource | null;
  patientPositionObservedAt: string | null;
  patientPositionServerReceivedAt: string | null;
  patientLocationCard: PatientLocationCard | null;
  coordination: CoordinationSummary;
  pendingResponseRequest: null;
  currentAssignment?: AssignmentView;
}

export interface PendingResponseEventView extends EmergencyEventViewBase {
  viewerRelationship: "NEUTRAL";
  positioningTier: "SEARCH_RING";
  distanceRange: DistanceRange;
  etaRange: EtaRange;
  expiresAt: string;
  pendingResponseRequest: ResponseRequestPayload;
  triggerSource?: never;
  recruitmentStageStartedAt?: never;
  fallDetectedAt?: never;
  fallResolution?: never;
  appHelpResponse?: never;
  callFirstObservedAt?: never;
  patientPosition?: never;
  patientPositionSource?: never;
  patientPositionObservedAt?: never;
  patientPositionServerReceivedAt?: never;
  patientLocationCard?: never;
  coordination?: never;
  currentAssignment?: never;
}

export interface NeutralEmergencyEventView extends EmergencyEventViewBase {
  viewerRelationship: "NEUTRAL";
  positioningTier: "STANDBY";
  distanceRange: null;
  etaRange: null;
  expiresAt: null;
  pendingResponseRequest: null;
  triggerSource?: never;
  recruitmentStageStartedAt?: never;
  fallDetectedAt?: never;
  fallResolution?: never;
  appHelpResponse?: never;
  callFirstObservedAt?: never;
  patientPosition?: never;
  patientPositionSource?: never;
  patientPositionObservedAt?: never;
  patientPositionServerReceivedAt?: never;
  patientLocationCard?: never;
  coordination?: never;
  currentAssignment?: never;
}

export type EmergencyEventView =
  | PatientEmergencyEventView
  | ResponderEmergencyEventView
  | PendingResponseEventView
  | NeutralEmergencyEventView;

export function emptyState(aeds: Aed[] = []): PersistentState {
  return {
    accessAuditById: {},
    breakGlassGrantsById: {},
    schemaVersion: "2.0",
    users: {},
    accounts: {},
    accountIdByProviderKey: {},
    authChallengesById: {},
    companionLinkTicketsByHash: {},
    devices: {},
    sessionsByTokenHash: {},
    events: {},
    deliveries: {},
    assignments: {},
    timelineByEventId: {},
    aedReceiptsById: {},
    aedReceiptIdByBusinessKey: {},
    aedReceiptIdByEventAed: {},
    aedUnavailableByReportId: {},
    resolutionsById: {},
    notificationOutboxById: {},
    participantExitsById: {},
    participantIntervalsById: {},
    eventPositionBatchesById: {},
    quarantinedLegacyEventPositionBatchesById: {},
    positionUpdateReceiptsById: {},
    presenceUpdateReceiptsById: {},
    deletionRequestsById: {},
    appleRevocationsById: {},
    rerouteProposalsById: {},
    selfAccessRequestsById: {},
    securityLogById: {},
    teamSignalsById: {},
    retentionPurgesById: {},
    positionWindowReconciliationsById: {},
    aedAssetsById: {},
    aedAssetActionsById: {},
    aedHandoversById: {},
    aedTemporaryPointDepositsById: {},
    aedTemporaryPointFollowUpsById: {},
    aedPhotoReferencesByObjectKey: {},
    eventEvidenceLogById: {},
    eventEvidenceHeadsById: {},
    aeds
  };
}
