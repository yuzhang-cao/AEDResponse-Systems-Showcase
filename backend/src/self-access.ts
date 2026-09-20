/**
 * G11 — the only way a person reads their own event data.
 *
 * The requirement has four parts, and each one is a refusal to trust the caller:
 *
 *   1. A user may only read data about THEMSELVES.  The scope is computed on the
 *      server from participation records (the events this account took part in),
 *      never from a client-supplied event list.
 *   2. The request must be re-verified: an authenticated session is not enough.
 *      The device answers a single-use server nonce with a signature from its
 *      registered key and states how it authenticated the human locally
 *      (`BIOMETRIC` or `PASSCODE`); a request that claims neither is refused.
 *   3. Approval is a human operator decision within 15 working days, and the
 *      resulting read-only grant lasts at most 24 hours.  Expiry is enforced on
 *      every read and swept durably, so an approved-but-unused grant dies on time.
 *   4. There is no export.  The projection returns a bounded JSON view with the
 *      other participants redacted — not a file, not a URL, not a stream — and a
 *      test asserts the service exposes no export/download/share operation at all.
 *
 * What this module deliberately does NOT claim: the server cannot independently
 * prove that a fingerprint was presented.  It can prove possession of the device
 * key and that the app asserted a local authentication method, and it records
 * which method was asserted next to the signature it verified.  Saying more than
 * that would be inventing an attestation Apple does not provide for biometrics.
 */
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject
} from "node:crypto";
import { stateRows } from "./incremental-state.js";
import type { PersistentState, SelfAccessRequestRecord } from "./models.js";

/** Working days an operator has to decide, per the published promise. */
export const SELF_ACCESS_APPROVAL_WORKING_DAYS = 15;
/** A grant is read-only and never longer than this. */
export const SELF_ACCESS_GRANT_MAX_MS = 24 * 60 * 60 * 1_000;
/** How long the signature challenge stays answerable. */
export const SELF_ACCESS_CHALLENGE_MS = 10 * 60 * 1_000;
/** Wrong signatures are counted, and a request dies after this many. */
export const SELF_ACCESS_MAX_CHALLENGE_ATTEMPTS = 5;

/** Local authentication methods the client may assert.  `NONE` is not acceptable. */
export type LocalAuthMethod = "BIOMETRIC" | "PASSCODE";

/**
 * The deadline for a decision, in working days.
 *
 * Weekends are skipped because the promise is in working days; public holidays
 * are an operator-calendar question this backend does not invent.  The deadline
 * is computed at request time and stored, so a later config change cannot move it.
 */
export function addWorkingDays(from: Date, workingDays: number): Date {
  const result = new Date(from.getTime());
  let remaining = workingDays;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

/**
 * The exact bytes the device signs.
 *
 * Canonical and purpose-bound: a signature harvested for another flow cannot be
 * replayed here, because the purpose string and the method are inside the signed
 * payload, and the nonce is single-use.
 */
export function selfAccessChallengePayload(input: {
  requestId: string;
  nonce: string;
  deviceInstanceId: string;
  method: LocalAuthMethod;
}): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: "AEDResponse.self-access-view",
    requestId: input.requestId,
    nonce: input.nonce,
    deviceInstanceId: input.deviceInstanceId,
    method: input.method
  }), "utf8");
}

/** Stable identifier for a device key, so a request records which key answered. */
export function deviceKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** Signature algorithm Node verifies for the key types the app uses. */
function algorithmFor(key: KeyObject): string | null | undefined {
  switch (key.asymmetricKeyType) {
    case "ec": return "sha256";
    case "rsa": return "sha256";
    // Ed25519 signs the message itself; Node requires a null digest.
    case "ed25519": return null;
    default: return undefined;
  }
}

export interface DeviceChallengeVerification {
  verified: boolean;
  keyFingerprint?: string;
  reason?: "UNSUPPORTED_KEY" | "BAD_SIGNATURE" | "MALFORMED_KEY" | "MALFORMED_SIGNATURE";
}

/**
 * Verifies the signed challenge with real cryptography.
 *
 * No signature, an unparsable key, an unsupported key type, or a signature over
 * different bytes are all refusals.  The reason is coarse, so a refusal cannot be
 * used to probe which part of the input was wrong.
 */
export function verifySelfAccessChallenge(input: {
  payload: Buffer;
  publicKeyPem: string;
  signatureBase64: string;
}): DeviceChallengeVerification {
  let key: KeyObject;
  try {
    key = createPublicKey(input.publicKeyPem);
  } catch {
    return { verified: false, reason: "MALFORMED_KEY" };
  }
  const algorithm = algorithmFor(key);
  if (algorithm === undefined) return { verified: false, reason: "UNSUPPORTED_KEY" };
  const signature = Buffer.from(input.signatureBase64, "base64");
  // A base64 string that decodes to nothing is a malformed signature, and an
  // empty signature would otherwise be handed to Node as "verify nothing".
  if (signature.length === 0) return { verified: false, reason: "MALFORMED_SIGNATURE" };
  const ok = algorithm === null
    ? verifySignature(null, input.payload, key, signature)
    : verifySignature(algorithm, input.payload, key, signature);
  return ok
    ? { verified: true, keyFingerprint: deviceKeyFingerprint(input.publicKeyPem) }
    : { verified: false, reason: "BAD_SIGNATURE" };
}

/** The requester's role in one event, as the projection reports it. */
export type SelfAccessRole = "PATIENT" | "RESPONDER";

export interface SelfAccessEventView {
  eventId: string;
  role: SelfAccessRole;
  state: string;
  createdAt: string;
  resolvedAt?: string;
  terminalReason?: string;
  /** The requester's OWN position records only, with where each one came from. */
  ownPositions: {
    kind: "P" | "R";
    at: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    source: "OWN_REPORTED" | "WATCH_TRIGGER_SNAPSHOT";
  }[];
  /** Own reporting gaps (no fix / app not running), counted, not located. */
  ownPositionGapCount: number;
  /** The requester's own offers and tasks, with other participants' data removed. */
  ownDeliveries: { deliveryId: string; status: string; decidedAt?: string }[];
  ownAssignments: { assignmentId: string; role: string; status: string; aedId?: string; etaSeconds?: number }[];
  /** Own fall observation, when the requester is the patient. */
  ownObservation?: { fallDetectedAt: string; fallResolution: string };
}

export interface SelfAccessView {
  requestId: string;
  readOnly: true;
  exportAllowed: false;
  grantedAt: string;
  expiresAt: string;
  /** Exactly which subjects were removed, so the redaction is checkable. */
  redactions: string[];
  events: SelfAccessEventView[];
}

/**
 * The events one user actually took part in, resolved from committed state.
 *
 * The client never supplies this list: a request that could name its own scope
 * would be a request to read anyone's event.  Both directions are indexed, so the
 * scope costs one lookup per relation rather than a scan of the event history.
 */
export function selfAccessScope(
  state: Readonly<PersistentState>,
  userId: string,
  deviceInstanceIds: readonly string[]
): string[] {
  const eventIds = new Set(stateRows(state, "events", "patientUserId", userId).map(event => event.id));
  for (const deviceInstanceId of deviceInstanceIds) {
    for (const delivery of stateRows(state, "deliveries", "deviceInstanceId", deviceInstanceId)) {
      eventIds.add(delivery.eventId);
    }
    for (const assignment of stateRows(state, "assignments", "deviceInstanceId", deviceInstanceId)) {
      eventIds.add(assignment.eventId);
    }
    for (const interval of stateRows(state, "participantIntervalsById", "deviceInstanceId", deviceInstanceId)) {
      eventIds.add(interval.eventId);
    }
  }
  return [...eventIds].sort();
}

/** Device instance ids that belong to one user, from the committed device rows. */
export function ownDeviceInstanceIds(
  state: Readonly<PersistentState>,
  userId: string,
  requestingDeviceInstanceId: string
): string[] {
  const ids = new Set(
    stateRows(state, "devices", "userId", userId).map(device => device.deviceInstanceId)
  );
  ids.add(requestingDeviceInstanceId);
  return [...ids];
}

/**
 * Builds the requester's own view from committed state.
 *
 * Every collection is narrowed by identity before anything is materialised, and
 * only fields the requester owns are copied.  The route geometry of their own AED
 * task is deliberately reduced to its ETA: the full route contains the OTHER
 * participant's positions, which is exactly what this view must not leak.
 */
export function projectSelfAccessView(
  state: Readonly<PersistentState>,
  request: SelfAccessRequestRecord,
  now: Date
): SelfAccessView {
  const grant = request.grant;
  if (!grant) throw new Error("Self-access view requires an issued grant");
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new Error("Self-access grant has expired");
  }
  const ownDeviceIds = new Set(ownDeviceInstanceIds(state, request.userId, request.deviceInstanceId));
  const events: SelfAccessEventView[] = [];
  for (const eventId of request.eventIds) {
    const event = state.events[eventId];
    if (!event) continue;
    const isPatient = event.patientUserId === request.userId
      || event.patientDeviceIds.some(id => ownDeviceIds.has(id));
    const ownDeliveries = stateRows(state, "deliveries", "eventId", eventId)
      .filter(row => ownDeviceIds.has(row.deviceInstanceId))
      .map(row => ({
        deliveryId: row.id,
        status: row.status,
        ...(row.decidedAt ? { decidedAt: row.decidedAt } : {})
      }));
    const ownAssignments = stateRows(state, "assignments", "eventId", eventId)
      .filter(row => ownDeviceIds.has(row.deviceInstanceId))
      .map(row => ({
        assignmentId: row.id,
        role: row.role,
        status: row.status,
        // The AED this requester was sent to is part of their own task; the route
        // geometry is not, because it contains the other person's positions.
        ...(row.aedAcquiredReceipt?.aedId ? { aedId: row.aedAcquiredReceipt.aedId } : {}),
        ...(row.route ? { etaSeconds: row.route.etaSeconds } : {})
      }));
    const ownPositions: SelfAccessEventView["ownPositions"] = [];
    let ownPositionGapCount = 0;
    // The patient's own trigger snapshot: for a Watch-triggered event this is the
    // first position of the event and it belongs to the patient, even though it
    // was never sent as a batch.
    if (isPatient && event.observation?.patientPosition) {
      const snapshot = event.observation.patientPosition;
      ownPositions.push({
        kind: "P",
        at: event.observation.patientPositionObservedAt ?? event.createdAt,
        latitude: snapshot.latitude,
        longitude: snapshot.longitude,
        accuracyMeters: snapshot.accuracyMeters,
        source: "WATCH_TRIGGER_SNAPSHOT"
      });
    }
    for (const batch of stateRows(state, "eventPositionBatchesById", "eventId", eventId)) {
      // A batch belongs to exactly one participant.  The requester's own batches
      // are the ones their own devices sent, in the role the event gave them.
      const mine = batch.userId === request.userId
        || (ownDeviceIds.has(batch.deviceInstanceId) && batch.kind === "R");
      if (!mine) continue;
      if (isPatient && batch.kind !== "P" && batch.userId !== request.userId) continue;
      for (const record of batch.records) {
        if (record.status !== "FIX") {
          if (record.userId === request.userId || ownDeviceIds.has(record.deviceInstanceId)) {
            ownPositionGapCount += 1;
          }
          continue;
        }
        ownPositions.push({
          kind: record.kind,
          at: record.fixObservedAt,
          latitude: record.position.latitude,
          longitude: record.position.longitude,
          accuracyMeters: record.position.accuracyMeters,
          source: "OWN_REPORTED"
        });
      }
    }
    events.push({
      eventId,
      role: isPatient ? "PATIENT" : "RESPONDER",
      state: event.state,
      createdAt: event.createdAt,
      ...(event.resolvedAt ? { resolvedAt: event.resolvedAt } : {}),
      ...(event.terminalReason ? { terminalReason: event.terminalReason } : {}),
      ownPositions,
      ownPositionGapCount,
      ownDeliveries,
      ownAssignments,
      ...(isPatient && event.observation?.fallDetectedAt && event.observation.fallResolution ? {
        ownObservation: {
          fallDetectedAt: event.observation.fallDetectedAt,
          fallResolution: event.observation.fallResolution
        }
      } : {})
    });
  }
  return {
    requestId: request.requestId,
    readOnly: true,
    exportAllowed: false,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    redactions: [
      "other participants' identities and device ids",
      "other participants' positions and route geometry",
      "event timeline and internal audit entries",
      "push tokens, session material and account identifiers"
    ],
    events
  };
}

/**
 * Marks grants that have run out, durably.
 *
 * Called on every read and from the scheduler tick: a read-only view that nobody
 * happened to open must still stop being valid at the promised instant, and the
 * record has to say so afterwards.
 */
export function expireSelfAccessGrants(state: PersistentState, now: Date): string[] {
  const expired: string[] = [];
  // Read through the status relation, not `Object.values`: enumerating the whole
  // collection on every read path is exactly the whole-state cost G13-A removed,
  // and a deployment with years of requests would pay it on every view.
  for (const request of stateRows(state, "selfAccessRequestsById", "status", "APPROVED")) {
    if (!request.grant) continue;
    if (Date.parse(request.grant.expiresAt) > now.getTime()) continue;
    state.selfAccessRequestsById[request.requestId] = {
      ...request,
      status: "EXPIRED",
      revokedAt: request.grant.expiresAt,
      revocationReason: "GRANT_EXPIRED"
    };
    expired.push(request.requestId);
  }
  return expired;
}

/** Turns a stored grant into the bounded response the client may see. */
export function grantedSelfAccessSummary(request: SelfAccessRequestRecord): {
  requestId: string;
  status: string;
  approvalDeadlineAt: string;
  grant?: { grantedAt: string; expiresAt: string; readOnly: true; exportAllowed: false };
} {
  return {
    requestId: request.requestId,
    status: request.status,
    approvalDeadlineAt: request.approvalDeadlineAt,
    ...(request.grant ? {
      grant: {
        grantedAt: request.grant.grantedAt,
        expiresAt: request.grant.expiresAt,
        readOnly: true as const,
        exportAllowed: false as const
      }
    } : {})
  };
}
