import { z } from "zod";

// OpenAPI marks these values as UUIDs, while the canonical deterministic fixture
// intentionally uses zero/version-neutral UUID strings. Validate the wire shape
// without imposing an RFC version nibble that the shared fixture does not promise.
export const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "Invalid UUID string"
);
export const isoDateSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

// Event position batches use a closed, UTC-second slot. Accept the canonical
// `.000Z` form and the equivalent second-precision form, then normalize both
// to the canonical representation used in state and fingerprints.
const UTC_WHOLE_SECOND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.000)?Z$/;
export const utcSecondSchema = z.string()
  .regex(
    UTC_WHOLE_SECOND_PATTERN,
    "timestamp must be a UTC whole-second timestamp"
  )
  .refine((value) => {
    const match = UTC_WHOLE_SECOND_PATTERN.exec(value);
    const milliseconds = Date.parse(value);
    if (!match || !Number.isFinite(milliseconds)) return false;
    const date = new Date(milliseconds);
    return date.getUTCFullYear() === Number(match[1])
      && date.getUTCMonth() + 1 === Number(match[2])
      && date.getUTCDate() === Number(match[3])
      && date.getUTCHours() === Number(match[4])
      && date.getUTCMinutes() === Number(match[5])
      && date.getUTCSeconds() === Number(match[6])
      && date.getUTCMilliseconds() === 0;
  }, {
    message: "timestamp must be a valid UTC calendar timestamp"
  })
  .transform((value) => new Date(value).toISOString());

const coordinateFields = {
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().positive().optional()
};

export const patientPositionSchema = z.object({
  kind: z.literal("P"),
  ...coordinateFields,
  accuracyMeters: z.number().finite().positive()
}).strict();

export const responderPositionSchema = z.object({
  kind: z.literal("R"),
  ...coordinateFields,
  accuracyMeters: z.number().finite().positive()
}).strict();

export const aedPositionSchema = z.object({
  kind: z.literal("A"),
  ...coordinateFields
}).strict();

export type PatientPosition = z.infer<typeof patientPositionSchema>;
export type ResponderPosition = z.infer<typeof responderPositionSchema>;
export type AedPosition = z.infer<typeof aedPositionSchema>;

export const aedSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aedPosition: aedPositionSchema,
  openFrom: z.string().regex(/^\d{2}:\d{2}$/),
  openUntil: z.string().regex(/^\d{2}:\d{2}$/),
  floor: z.string(),
  floorTransferSeconds: z.number().int().nonnegative(),
  accessNote: z.string(),
  accessDelaySeconds: z.number().int().nonnegative(),
  verificationSeconds: z.number().int().nonnegative(),
  available: z.boolean()
}).strict();

export type Aed = z.infer<typeof aedSchema>;

export const agreementAcceptanceSchema = z.object({
  kind: z.enum([
    "PATIENT",
    "VOLUNTEER_RESPONDER",
    "PRIVACY_POLICY",
    "SENSITIVE_PERSONAL_INFORMATION"
  ]),
  version: z.string().min(1),
  acceptedAt: isoDateSchema
}).strict();

export const deviceCapabilitiesSchema = z.object({
  notificationAuthorized: z.boolean(),
  locationAuthorized: z.boolean()
}).strict();

export type DeviceCapabilities = z.infer<typeof deviceCapabilitiesSchema>;


export const pushTokenRegistrationSchema = z.object({
  pushToken: z.string().trim().min(1).max(512),
  pushEnvironment: z.enum(["SANDBOX", "PRODUCTION"]),
  bundleId: z.string().trim().min(1).max(255)
}).strict();
export type PushTokenRegistrationRequest = z.infer<typeof pushTokenRegistrationSchema>;

export const appleIdentityTokenRequestSchema = z.object({
  challengeId: uuidSchema,
  identityToken: z.string().trim().min(1).max(32 * 1024),
  authorizationCode: z.string().trim().min(1).max(8 * 1024).optional(),
  nonce: z.string().trim().min(1).max(512)
}).strict();
export type AppleIdentityTokenRequest = z.infer<typeof appleIdentityTokenRequestSchema>;

export const refreshSessionRequestSchema = z.object({
  refreshToken: z.string().trim().min(1).max(512)
}).strict();
export type RefreshSessionRequest = z.infer<typeof refreshSessionRequestSchema>;

export const companionLinkTicketRequestSchema = z.object({
  companionPairId: uuidSchema.optional()
}).strict();
export type CompanionLinkTicketRequest = z.infer<typeof companionLinkTicketRequestSchema>;

export const watchCompanionLinkRequestSchema = z.object({
  deviceInstanceId: uuidSchema,
  companionPairId: uuidSchema,
  companionLinkTicket: z.string().trim().min(32).max(512),
  appAttestKeyId: z.string().trim().min(1).max(256),
  attestationObject: z.string()
    .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "attestationObject must be base64")
    .max(16 * 1024)
}).strict().superRefine((value, context) => {
  if (!value.attestationObject) {
    context.addIssue({
      code: "custom",
      path: ["attestationObject"],
      message: "attestationObject is required"
    });
  }
});
export type WatchCompanionLinkRequest = z.infer<typeof watchCompanionLinkRequestSchema>;

export const sessionBootstrapSchema = z.object({
  deviceInstanceId: uuidSchema,
  deviceKind: z.literal("IPHONE"),
  companionPairId: uuidSchema,
  agreementAcceptances: z.array(agreementAcceptanceSchema).length(4),
  capabilities: deviceCapabilitiesSchema,
  availableForResponse: z.boolean()
}).strict();

export type SessionBootstrapRequest = z.infer<typeof sessionBootstrapSchema>;

export const devicePresenceUpdateSchema = z.object({
  presenceUpdateId: uuidSchema,
  occurredAt: isoDateSchema,
  availableForResponse: z.boolean(),
  capabilities: deviceCapabilitiesSchema
}).strict();

export type DevicePresenceUpdate = z.infer<typeof devicePresenceUpdateSchema>;

export const distanceRangeSchema = z.enum([
  "DISTANCE_0_500M",
  "DISTANCE_500_1000M",
  "DISTANCE_1000_1500M",
  "DISTANCE_1500_2000M",
  "DISTANCE_OVER_2000M"
]);
export type DistanceRange = z.infer<typeof distanceRangeSchema>;

export const etaRangeSchema = z.enum([
  "ETA_0_5_MIN",
  "ETA_5_10_MIN",
  "ETA_10_15_MIN",
  "ETA_OVER_15_MIN"
]);
export type EtaRange = z.infer<typeof etaRangeSchema>;

export const recruitmentRadiusSchema = z.union([
  z.literal(1_000),
  z.literal(1_500),
  z.literal(2_000)
]);
export type RecruitmentRadiusMeters = z.infer<typeof recruitmentRadiusSchema>;

export const responseRequestSchema = z.object({
  simulation: z.object({ runId: uuidSchema, label: z.literal("SIMULATED_TEST") }).strict().optional(),
  schemaVersion: z.literal("2.0"),
  messageId: z.string().min(1),
  eventId: uuidSchema,
  deliveryId: uuidSchema,
  deliveryStatus: z.enum(["SENT", "DELIVERED", "VIEWED"]),
  occurredAt: isoDateSchema,
  eventType: z.literal("FALL_ASSISTANCE"),
  positioningTier: z.literal("SEARCH_RING"),
  distanceRange: distanceRangeSchema,
  etaRange: etaRangeSchema,
  currentRecruitmentRadiusMeters: recruitmentRadiusSchema,
  expiresAt: isoDateSchema
}).strict();
export type ResponseRequest = z.infer<typeof responseRequestSchema>;

export const fallResolutionSchema = z.enum([
  "CONFIRMED",
  "DISMISSED",
  "REJECTED",
  "UNRESPONSIVE",
  "UNKNOWN"
]);

export const watchTriggerSourceSchema = z.enum([
  "WATCH_FALL_HELP_CONFIRMED",
  "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED"
]);
export type WatchTriggerSource = z.infer<typeof watchTriggerSourceSchema>;

/**
 * A patient found by a person, reported from their own phone.
 *
 * This is a second way an event can begin, alongside the Watch fall observation.
 * It deliberately carries NO fall fields: nobody measured a fall, so claiming a
 * `fallResolution` would be inventing a medical fact.  What it carries is what the
 * reporter actually knows — where the patient is, when they saw them, and which
 * device reported it.
 */
export const userReportedPatientObservationSchema = z.object({
  schemaVersion: z.literal("2.0"),
  eventId: uuidSchema,
  observationKind: z.literal("USER_REPORTED_PATIENT"),
  reportedAt: isoDateSchema,
  patientPosition: patientPositionSchema,
  patientPositionObservedAt: isoDateSchema,
  reporterDeviceId: uuidSchema
}).strict();

/**
 * The fall-specific fields are declared as `never`, exactly as the simulation
 * observation does: it keeps the union readable by existing projections while
 * making it a type error to WRITE a fall fact onto a report that never measured one.
 */
export type UserReportedPatientObservation = z.infer<typeof userReportedPatientObservationSchema> & {
  fallDetectedAt?: never;
  fallResolution?: never;
  appHelpResponse?: never;
  callFirstObservedAt?: never;
  locationUnavailableReason?: never;
};

export const watchEmergencyObservationSchema = z.object({
  schemaVersion: z.literal("2.0"),
  eventId: uuidSchema,
  observationKind: z.literal("FALL_CONTEXT"),
  fallDetectedAt: isoDateSchema,
  fallResolution: fallResolutionSchema,
  appHelpResponse: z.enum(["NEEDS_HELP", "NO_RESPONSE"]),
  callFirstObservedAt: isoDateSchema.optional(),
  callObservationSemantics: z.literal("FIRST_OBSERVED_OUTGOING_STATE").optional(),
  patientPosition: patientPositionSchema.nullish(),
  patientPositionObservedAt: isoDateSchema.optional(),
  locationUnavailableReason: z.string().max(200).nullish()
}).strict().superRefine((value, context) => {
  if (value.patientPositionObservedAt !== undefined && !value.patientPosition) {
    context.addIssue({ code: "custom", path: ["patientPositionObservedAt"],
      message: "A fix timestamp requires patientPosition" });
  }
  if (value.appHelpResponse === "NO_RESPONSE") {
    if (!value.callFirstObservedAt) {
      context.addIssue({
        code: "custom",
        path: ["callFirstObservedAt"],
        message: "callFirstObservedAt is required for NO_RESPONSE"
      });
    } else {
      const delay = Date.parse(value.callFirstObservedAt) - Date.parse(value.fallDetectedAt);
      if (delay < 0) {
        context.addIssue({
          code: "custom",
          path: ["callFirstObservedAt"],
          message: "callFirstObservedAt cannot precede fallDetectedAt"
        });
      }
      if (delay > 120 * 1_000) {
        context.addIssue({
          code: "custom",
          path: ["callFirstObservedAt"],
          message: "callFirstObservedAt must be within 120 seconds of fallDetectedAt"
        });
      }
    }
    if (!value.callObservationSemantics) {
      context.addIssue({
        code: "custom",
        path: ["callObservationSemantics"],
        message: "callObservationSemantics is required for NO_RESPONSE"
      });
    }
  } else {
    if (value.callFirstObservedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["callFirstObservedAt"],
        message: "callFirstObservedAt is only valid for NO_RESPONSE"
      });
    }
    if (value.callObservationSemantics !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["callObservationSemantics"],
        message: "callObservationSemantics is only valid for NO_RESPONSE"
      });
    }
  }
  if (!value.patientPosition && !value.locationUnavailableReason) {
    context.addIssue({
      code: "custom",
      path: ["locationUnavailableReason"],
      message: "locationUnavailableReason is required when patientPosition is absent"
    });
  }
});

export type WatchEmergencyObservation = z.infer<typeof watchEmergencyObservationSchema>;

export const watchConnectivityActivationStateSchema = z.enum([
  "NOT_ACTIVATED",
  "INACTIVE",
  "ACTIVATED"
]);
export type WatchConnectivityActivationState = z.infer<
  typeof watchConnectivityActivationStateSchema
>;

export const watchFallbackPositionUpdateSchema = z.object({
  schemaVersion: z.literal("2.0"),
  eventId: uuidSchema,
  positionUpdateId: uuidSchema,
  observedAt: isoDateSchema,
  patientPosition: patientPositionSchema,
  activationState: watchConnectivityActivationStateSchema,
  iphoneReachable: z.boolean(),
  networkAvailable: z.boolean()
}).strict();

export type WatchFallbackPositionUpdate = z.infer<
  typeof watchFallbackPositionUpdateSchema
>;

export const responderPositionUpdateSchema = z.object({
  positionUpdateId: uuidSchema,
  responderPosition: responderPositionSchema,
  observedAt: isoDateSchema
}).strict();

export type ResponderPositionUpdate = z.infer<typeof responderPositionUpdateSchema>;

export const patientPositionUpdateSchema = z.object({
  positionUpdateId: uuidSchema,
  patientPosition: patientPositionSchema,
  observedAt: isoDateSchema
}).strict();

export type PatientPositionUpdate = z.infer<typeof patientPositionUpdateSchema>;

export const MAX_EVENT_POSITION_RECORDS_PER_BATCH = 5;

const eventPositionRecordBaseSchema = {
  recordId: uuidSchema,
  slotAt: utcSecondSchema
};

const eventPositionRecordUnionSchema = z.discriminatedUnion("status", [
  z.object({
    ...eventPositionRecordBaseSchema,
    status: z.literal("FIX"),
    position: z.union([patientPositionSchema, responderPositionSchema]),
    fixObservedAt: isoDateSchema
  }).strict(),
  z.object({
    ...eventPositionRecordBaseSchema,
    status: z.literal("NO_NEW_FIX"),
    gapReason: z.enum(["NO_FIX", "APP_NOT_RUNNING"])
  }).strict()
]);

export const eventPositionRecordSchema = eventPositionRecordUnionSchema.superRefine(
  (value, context) => {
    if (value.status !== "FIX") return;
    const slotMilliseconds = Date.parse(value.slotAt);
    const fixMilliseconds = Date.parse(value.fixObservedAt);
    if (!Number.isFinite(slotMilliseconds)
      || !Number.isFinite(fixMilliseconds)
      || fixMilliseconds < slotMilliseconds
      || fixMilliseconds >= slotMilliseconds + 1_000) {
      context.addIssue({
        code: "custom",
        path: ["fixObservedAt"],
        message: "fixObservedAt must fall within [slotAt, slotAt + 1 second)"
      });
    }
  }
);

export type EventPositionRecord = z.infer<typeof eventPositionRecordSchema>;

export const eventPositionBatchSchema = z.object({
  schemaVersion: z.literal("2.0"),
  eventId: uuidSchema,
  batchId: uuidSchema,
  records: z.array(eventPositionRecordSchema)
    .min(1)
    .max(MAX_EVENT_POSITION_RECORDS_PER_BATCH)
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  const seenSlots = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (seen.has(record.recordId)) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "recordId"],
        message: "recordId must be unique within a batch"
      });
    }
    seen.add(record.recordId);
    if (seenSlots.has(record.slotAt)) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "slotAt"],
        message: "slotAt must be unique within a batch"
      });
    }
    seenSlots.add(record.slotAt);
  }
});

export type EventPositionBatch = z.infer<typeof eventPositionBatchSchema>;

export const deliveryStatusSchema = z.enum([
  "SENT",
  "DELIVERED",
  "VIEWED",
  "ACCEPTED",
  "REFUSED",
  "EXPIRED"
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const deliveryReceiptSchema = z.object({
  status: deliveryStatusSchema,
  occurredAt: isoDateSchema
}).strict();

export const responderDecisionSchema = z.object({
  decision: z.enum(["ACCEPT", "REFUSE"]),
  decidedAt: isoDateSchema
}).strict();

export type ResponderDecision = z.infer<typeof responderDecisionSchema>;

/** Reasons exposed by the patient's single confirmed end action. */
export const eventEndReasonSchema = z.enum([
  "FALSE_ALARM",
  "ASSISTANCE_WITHDRAWN",
  "PROBLEM_RESOLVED",
  "PROFESSIONAL_TAKEOVER"
]);
export type EventEndReason = z.infer<typeof eventEndReasonSchema>;

export const eventEndRequestSchema = z.object({
  resolutionId: uuidSchema,
  reason: eventEndReasonSchema,
  withdrawalConfirmed: z.literal(true).optional(),
  endedAt: isoDateSchema,
  note: z.string().max(300).optional()
}).strict();
export type EventEndRequest = z.infer<typeof eventEndRequestSchema>;

export const statusConfirmationResponseSchema = z.object({
  confirmationId: uuidSchema,
  response: z.literal("CONTINUE"),
  respondedAt: isoDateSchema
}).strict();
export type StatusConfirmationResponse = z.infer<typeof statusConfirmationResponseSchema>;

export const participantExitRequestSchema = z.object({
  exitId: uuidSchema,
  exitedAt: isoDateSchema,
  reason: z.string().trim().min(1).max(300).optional(),
  /** Client assertion that the three-step sole-responder confirmation completed. */
  soleResponderConfirmed: z.literal(true).optional()
}).strict();
export type ParticipantExitRequest = z.infer<typeof participantExitRequestSchema>;

export const assignmentRoleSchema = z.enum(["GO_TO_PATIENT", "FETCH_AED"]);
export type AssignmentRole = z.infer<typeof assignmentRoleSchema>;

export const assignmentStatusSchema = z.enum([
  "ASSIGNED",
  "EN_ROUTE",
  "ARRIVED_AT_AED",
  "AED_ACQUIRED",
  "EN_ROUTE_TO_PATIENT",
  "ARRIVED_AT_PATIENT",
  "COMPLETED",
  "AED_UNAVAILABLE",
  "TIMED_OUT",
  "CANCELLED"
]);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

export const assignmentStatusUpdateSchema = z.object({
  status: assignmentStatusSchema,
  occurredAt: isoDateSchema
}).strict();

export const aedAcquiredReceiptSchema = z.object({
  receiptId: uuidSchema,
  eventId: uuidSchema,
  assignmentId: uuidSchema,
  aedId: z.string().min(1),
  acquiredAt: isoDateSchema
}).strict();

export type AedAcquiredReceipt = z.infer<typeof aedAcquiredReceiptSchema>;

export const aedUnavailableReportSchema = z.object({
  reportId: uuidSchema,
  eventId: uuidSchema,
  assignmentId: uuidSchema,
  aedId: z.string().min(1),
  reportedAt: isoDateSchema,
  reason: z.string().trim().min(1).max(300)
}).strict();

export type AedUnavailableReport = z.infer<typeof aedUnavailableReportSchema>;

export const resolutionSchema = z.object({
  resolutionId: uuidSchema,
  actor: z.enum(["PATIENT", "ON_SCENE_RESPONDER", "AUTHORIZED_OPERATOR"]),
  resolvedAt: isoDateSchema,
  reason: eventEndReasonSchema.optional(),
  withdrawalConfirmed: z.literal(true).optional(),
  note: z.string().max(300).optional()
}).strict();

export type ResolutionRequest = z.infer<typeof resolutionSchema>;

export const aedRouteRequestSchema = z.object({
  responderPosition: responderPositionSchema,
  patientPosition: patientPositionSchema,
  at: isoDateSchema.optional()
}).strict();
