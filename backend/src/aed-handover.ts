/**
 * G09 — the AED handover, the temporary placement point, and the media that
 * proves it.
 *
 * The requirement (requirements §104, V2-A11/A26) is narrower than "transfer the
 * device": an acquired AED in a responder's hands has to be able to change hands
 * *with evidence*, and the backend must never behave as if the device came back
 * to its cabinet.  Five rules carry that, and each exists because of a concrete
 * wrong outcome:
 *
 *   1. **Both sides confirm once, and only then is the handover complete.**  One
 *      side alone leaves it PENDING.  A handover that completes on one tap is a
 *      handover the other person never agreed to, and the receiver would be
 *      dispatched to a device nobody handed them.
 *   2. **A task ending is not a return.**  Assignment completion, responder exit
 *      and event closure all leave physical occupancy in place; only a settled
 *      handover moves custody, and only a separately authorised return releases
 *      the device.  This is the frozen user decision, and the reason `custody` is
 *      rewritten by nothing except a settled handover.
 *   3. **The temporary point needs both facts.**  A position sample fresh within
 *      30 s at ≤50 m accuracy, AND a photo reference that passes every declared
 *      bound.  Neither alone creates a dispatchable device: a position without a
 *      photo is an unverified guess, and a photo without a position cannot be
 *      walked to.
 *   4. **Media is referenced, never hosted here.**  The backend has no object
 *      store, so it owns a PORT and refuses when none is configured.  A missing
 *      store must fail the request, never quietly accept an unverifiable file.
 *   5. **Idempotency is per side.**  Each side presents its own request id; a
 *      retry over a flaky link returns the original fact instead of writing a
 *      second confirmation or a second placement.
 */
import { z } from "zod";
import { fingerprint } from "./domain.js";
import { badRequest, conflict, forbidden, notFound, unprocessableEntity } from "./errors.js";
import { isoDateSchema, responderPositionSchema, uuidSchema } from "./contracts.js";
import type { AedAssetRecord } from "./aed-asset-model.js";
import type {
  AedHandoverRecord,
  AedPhotoReference,
  AedTemporaryPointDepositRecord,
  AedTemporaryPointFollowUpRecord
} from "./models.js";

/** The requirement fixes these bounds; they are asserted, not advisory. */
export const HANDOVER_POSITION_MAX_AGE_SECONDS = 30;
export const HANDOVER_POSITION_MAX_ACCURACY_METERS = 50;
export const HANDOVER_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const HANDOVER_PHOTO_MAX_EDGE_PIXELS = 2048;
/** The requirement names JPEG; the container is enforced, not suggested. */
export const HANDOVER_PHOTO_MIME = "image/jpeg";
/** A declared hash is lowercase hex of sha256 length. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Private object storage PORT.
 *
 * The repository ships no object store on purpose: this is the boundary a real
 * deployment implements (private bucket, short-lived read grants, server-side
 * hashing).  `NullObjectStorage` refuses every operation, so "no store
 * configured" is a hard failure at the exact point where evidence would have been
 * accepted — never a silent pass.
 */
export interface ObjectStoragePort {
  /** Whether a real store is configured and reachable for this request. */
  readonly configured: boolean;
  /**
   * Prove that `objectKey` exists in the PRIVATE store, that its bytes hash to
   * `sha256`, and that it is not publicly readable.  Throws when the store cannot
   * prove that.
   */
  confirmObject(input: { objectKey: string; sha256: string; byteSize: number }): Promise<void>;
  /** A short-lived, authenticated read grant for one participant. */
  createReadGrant(input: {
    objectKey: string;
    expiresAt: string;
  }): Promise<{ url: string; expiresAt: string }>;
  /**
   * Removes the bytes from the private store.
   *
   * Required, not optional: the published retention promise deletes photos at
   * three years, and a port that cannot delete would make that promise a lie.
   * The purge calls this BEFORE deleting the reference rows, so a store that is
   * unreachable withholds the purge instead of orphaning bytes nobody can find.
   */
  deleteObject(input: { objectKey: string }): Promise<void>;
}

export class NullObjectStorage implements ObjectStoragePort {
  readonly configured = false;
  private refuse(): never {
    throw unprocessableEntity(
      "Private media storage is not configured; a photo reference cannot be verified or served"
    );
  }
  async confirmObject(): Promise<void> {
    this.refuse();
  }
  async createReadGrant(): Promise<{ url: string; expiresAt: string }> {
    this.refuse();
  }
  async deleteObject(): Promise<void> {
    // No configured store means no object was ever confirmed, so there is nothing
    // to delete.  The retention sweep skips the call entirely in that case, and
    // reaching here is a programming error rather than an operational one.
    this.refuse();
  }
}

/**
 * A photo reference as the client declares it.
 *
 * The metadata is validated here because it is the only part this backend can
 * check without the bytes: it has no image decoder and no EXIF parser.  The hash
 * is therefore confirmed against the private store through the port when one is
 * configured; with none configured the whole request fails, so a declared but
 * unverifiable hash is never recorded as verified evidence.
 */
export const aedPhotoReferenceSchema = z.object({
  objectKey: z.string().trim().min(1).max(1024),
  mimeType: z.literal(HANDOVER_PHOTO_MIME),
  byteSize: z.number().int().positive().max(HANDOVER_PHOTO_MAX_BYTES),
  widthPixels: z.number().int().positive(),
  heightPixels: z.number().int().positive(),
  /** The client attests it stripped EXIF/GPS before upload. */
  exifStripped: z.literal(true),
  sha256: z.string().trim().regex(SHA256_HEX),
  capturedAt: isoDateSchema
}).strict();
export type AedPhotoReferenceRequest = z.infer<typeof aedPhotoReferenceSchema>;

export function handoverPhotoLongestEdge(input: {
  widthPixels: number;
  heightPixels: number;
}): number {
  return Math.max(input.widthPixels, input.heightPixels);
}

/** Every bound the requirement names, reported one at a time. */
export function validateHandoverPhoto(reference: AedPhotoReferenceRequest): void {
  if (reference.mimeType !== HANDOVER_PHOTO_MIME) {
    throw badRequest("A handover photo must be a JPEG");
  }
  if (reference.byteSize > HANDOVER_PHOTO_MAX_BYTES) {
    throw unprocessableEntity("A handover photo must not exceed 5 MiB");
  }
  if (handoverPhotoLongestEdge(reference) > HANDOVER_PHOTO_MAX_EDGE_PIXELS) {
    throw unprocessableEntity("A handover photo's longest edge must not exceed 2048 pixels");
  }
  if (reference.exifStripped !== true) {
    throw unprocessableEntity("A handover photo must have EXIF stripped before upload");
  }
  if (!SHA256_HEX.test(reference.sha256)) {
    throw badRequest("A handover photo must declare a lowercase hex sha256 of its bytes");
  }
}

/** Position freshness and precision, measured against the server clock. */
export function validateHandoverPosition(
  position: { accuracyMeters: number },
  observedAt: string,
  now: Date
): void {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) throw badRequest("positionObservedAt must be an ISO timestamp");
  const ageMs = now.getTime() - observedAtMs;
  if (ageMs < 0) throw unprocessableEntity("A handover position cannot be in the future");
  if (ageMs > HANDOVER_POSITION_MAX_AGE_SECONDS * 1_000) {
    throw unprocessableEntity("A handover position must be observed within the last 30 seconds");
  }
  if (!(position.accuracyMeters <= HANDOVER_POSITION_MAX_ACCURACY_METERS)) {
    throw unprocessableEntity("A handover position must be accurate to 50 metres or better");
  }
}

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------

export const aedHandoverModeSchema = z.enum(["FACE_TO_FACE", "TEMPORARY_POINT"]);
export type AedHandoverMode = z.infer<typeof aedHandoverModeSchema>;

export const aedHandoverRequestSchema = z.object({
  /** This side's idempotency key for opening the handover. */
  requestId: uuidSchema,
  aedId: z.string().min(1),
  mode: aedHandoverModeSchema,
  /** The task that acquired the device; the holder is derived from it server-side. */
  assignmentId: uuidSchema
}).strict();
export type AedHandoverRequest = z.infer<typeof aedHandoverRequestSchema>;

export const aedHandoverConfirmationRequestSchema = z.object({
  requestId: uuidSchema,
  side: z.enum(["HOLDER", "RECEIVER"])
}).strict();
export type AedHandoverConfirmationRequest = z.infer<typeof aedHandoverConfirmationRequestSchema>;

export const aedHandoverSettlementRequestSchema = z.object({
  requestId: uuidSchema,
  /** Face-to-face only: the device the holder handed the AED to. */
  receiverDeviceInstanceId: uuidSchema.optional(),
  /** Temporary point only: both facts are required together. */
  position: responderPositionSchema.optional(),
  positionObservedAt: isoDateSchema.optional(),
  photo: aedPhotoReferenceSchema.optional()
}).strict();
export type AedHandoverSettlementRequest = z.infer<typeof aedHandoverSettlementRequestSchema>;

export const aedTemporaryPointFollowUpRequestSchema = z.object({
  requestId: uuidSchema,
  outcome: z.enum(["FOUND", "NOT_FOUND"]),
  /** The device that performed the follow-up search. */
  deviceInstanceId: uuidSchema
}).strict();
export type AedTemporaryPointFollowUpRequest =
  z.infer<typeof aedTemporaryPointFollowUpRequestSchema>;

// --------------------------------------------------------------------------
// Write surface
// --------------------------------------------------------------------------

/**
 * The minimal write surface these helpers need.
 *
 * Deliberately NOT `EntityTransaction`: the service runs them inside its
 * request-local draft, where entities are real mutable objects, while unit tests
 * run them over a plain state.  Both satisfy this interface, so one set of
 * decision logic is exercised in both places without an adapter that can drift.
 */
export interface HandoverStoreView {
  handover(handoverId: string): AedHandoverRecord | undefined;
  putHandover(handover: AedHandoverRecord): void;
  /** Every handover, for the participant-facing open-handover lookup. */
  allHandovers(): readonly AedHandoverRecord[];
  /** The open handover for one device, if any: at most one may be outstanding. */
  openHandoverForAsset(aedId: string): AedHandoverRecord | undefined;
  handoverByRequestId(requestId: string): AedHandoverRecord | undefined;
  deposit(depositId: string): AedTemporaryPointDepositRecord | undefined;
  putDeposit(deposit: AedTemporaryPointDepositRecord): void;
  depositForHandover(handoverId: string): AedTemporaryPointDepositRecord | undefined;
  followUpForDeposit(depositId: string): AedTemporaryPointFollowUpRecord | undefined;
  putFollowUp(followUp: AedTemporaryPointFollowUpRecord): void;
  photoReference(objectKey: string): AedPhotoReference | undefined;
  putPhotoReference(reference: AedPhotoReference): void;
  asset(aedId: string): AedAssetRecord | undefined;
  putAsset(asset: AedAssetRecord): void;
}

/** A view over a plain state object, for tests and whole-state callers. */
export function handoverViewOver(state: {
  aedHandoversById: Record<string, AedHandoverRecord>;
  aedTemporaryPointDepositsById: Record<string, AedTemporaryPointDepositRecord>;
  aedTemporaryPointFollowUpsById: Record<string, AedTemporaryPointFollowUpRecord>;
  aedPhotoReferencesByObjectKey: Record<string, AedPhotoReference>;
  aedAssetsById: Record<string, AedAssetRecord>;
}): HandoverStoreView {
  return {
    handover: id => state.aedHandoversById[id],
    putHandover: (handover) => { state.aedHandoversById[handover.handoverId] = handover; },
    allHandovers: () => Object.values(state.aedHandoversById),
    openHandoverForAsset: aedId => Object.values(state.aedHandoversById)
      .find(handover => handover.aedId === aedId
        && (handover.status === "PENDING" || handover.status === "CONFIRMED")),
    handoverByRequestId: requestId => Object.values(state.aedHandoversById)
      .find(handover => handover.requestId === requestId),
    deposit: id => state.aedTemporaryPointDepositsById[id],
    putDeposit: (deposit) => { state.aedTemporaryPointDepositsById[deposit.depositId] = deposit; },
    depositForHandover: handoverId => Object.values(state.aedTemporaryPointDepositsById)
      .find(deposit => deposit.handoverId === handoverId),
    followUpForDeposit: depositId => Object.values(state.aedTemporaryPointFollowUpsById)
      .find(followUp => followUp.depositId === depositId),
    putFollowUp: (followUp) => {
      state.aedTemporaryPointFollowUpsById[followUp.followUpId] = followUp;
    },
    photoReference: objectKey => state.aedPhotoReferencesByObjectKey[objectKey],
    putPhotoReference: (reference) => {
      state.aedPhotoReferencesByObjectKey[reference.objectKey] = reference;
    },
    asset: aedId => state.aedAssetsById[aedId],
    putAsset: (asset) => { state.aedAssetsById[asset.aedId] = asset; }
  };
}

// --------------------------------------------------------------------------
// Decisions
// --------------------------------------------------------------------------

export interface HandoverContext {
  eventId: string;
  /** The authenticated device acting, and its stable identity when bound. */
  actorDeviceInstanceId: string;
  actorUserId?: string;
  now: Date;
}

type HandoverParties = Pick<AedHandoverRecord,
  "holderDeviceInstanceId" | "holderUserId" | "receiverDeviceInstanceId" | "receiverUserId">;

/**
 * Which side the acting identity is, or `undefined` when it is neither.
 *
 * A side matches on device instance id OR on the stable user identity, because a
 * participant may hold the device with their second phone; the rule is about
 * people, not handsets.
 */
export function handoverSideFor(
  handover: HandoverParties,
  acting: { deviceInstanceId: string; userId?: string }
): "HOLDER" | "RECEIVER" | undefined {
  const keys = [
    `device:${acting.deviceInstanceId}`,
    ...(acting.userId ? [`user:${acting.userId}`] : [])
  ];
  const holder = [
    `device:${handover.holderDeviceInstanceId}`,
    ...(handover.holderUserId ? [`user:${handover.holderUserId}`] : [])
  ];
  if (holder.some(key => keys.includes(key))) return "HOLDER";
  const receiver = [
    ...(handover.receiverDeviceInstanceId ? [`device:${handover.receiverDeviceInstanceId}`] : []),
    ...(handover.receiverUserId ? [`user:${handover.receiverUserId}`] : [])
  ];
  if (receiver.some(key => keys.includes(key))) return "RECEIVER";
  return undefined;
}

export interface HandoverCreationInput {
  handoverId: string;
  request: AedHandoverRequest;
  holderDeviceInstanceId: string;
  holderUserId?: string;
  acquiredAt: string;
  initiatedAt: string;
}

/**
 * Step 1 — open the handover fact.
 *
 * Idempotent on `request.requestId`: a retry returns the existing fact instead of
 * opening a second handover.  Only ONE handover may be outstanding per device,
 * because two open handovers would let two receivers both believe they are
 * collecting it.
 */
export function openHandover(
  view: HandoverStoreView,
  input: HandoverCreationInput
): AedHandoverRecord {
  const { request } = input;
  const existingForRequest = view.handoverByRequestId(request.requestId);
  if (existingForRequest) {
    if (existingForRequest.aedId !== request.aedId
      || existingForRequest.mode !== request.mode
      || existingForRequest.assignmentId !== request.assignmentId) {
      throw conflict("Handover requestId was already used with different content");
    }
    return existingForRequest;
  }
  const asset = view.asset(request.aedId);
  if (!asset) throw notFound("AED asset is not registered");
  if (asset.custody?.acquiredAt === undefined) {
    throw conflict("A handover requires a physically acquired AED");
  }
  const holderMatches = asset.custody.deviceInstanceId === input.holderDeviceInstanceId
    || (input.holderUserId !== undefined && asset.custody.userId === input.holderUserId);
  if (!holderMatches) throw conflict("Only the current holder may open a handover for this AED");
  if (view.openHandoverForAsset(request.aedId)) {
    throw conflict("This AED already has an outstanding handover");
  }
  const handover: AedHandoverRecord = {
    handoverId: input.handoverId,
    requestId: request.requestId,
    eventId: asset.custody.eventId,
    aedId: request.aedId,
    assignmentId: request.assignmentId,
    mode: request.mode,
    status: "PENDING",
    holderDeviceInstanceId: input.holderDeviceInstanceId,
    ...(input.holderUserId ? { holderUserId: input.holderUserId } : {}),
    acquiredAt: input.acquiredAt,
    initiatedAt: input.initiatedAt,
    revision: 1
  };
  view.putHandover(handover);
  // The device is now visibly in transit between two people.  The asset status is
  // what routing and the operator view read, so it must stop reading "in use by a
  // responder who is on scene".
  view.putAsset({
    ...asset,
    status: "AWAITING_HANDOFF",
    updatedAt: input.initiatedAt,
    revision: asset.revision + 1
  });
  return handover;
}

export interface HandoverConfirmationOutcome {
  handover: AedHandoverRecord;
  /** True when this call wrote the confirmation; false when it replayed one. */
  applied: boolean;
}

/**
 * Step 2 — one side confirms once.
 *
 * The completion test is the conjunct of both sides: a single confirmation moves
 * PENDING → CONFIRMED and nothing else.  A side that already confirmed gets the
 * same record back, so a retry cannot double-write.
 */
export function confirmHandover(
  view: HandoverStoreView,
  handoverId: string,
  input: AedHandoverConfirmationRequest,
  context: HandoverContext
): HandoverConfirmationOutcome {
  const handover = view.handover(handoverId);
  if (!handover) throw notFound("Handover does not exist");
  if (handover.eventId !== context.eventId) throw forbidden("Handover belongs to another event");
  if (handover.status === "SETTLED" || handover.status === "HALTED") {
    throw conflict("This handover is already closed");
  }
  const acting = {
    deviceInstanceId: context.actorDeviceInstanceId,
    ...(context.actorUserId ? { userId: context.actorUserId } : {})
  };
  const side = handoverSideFor(handover, acting);
  // Three cases, and each gets the refusal that names the actual problem:
  //   1. a known party naming the other side -> the side is wrong;
  //   2. someone naming the holder side who does not hold it -> not the holder;
  //   3. someone claiming the receiver side, which is claimed exactly once by the
  //      first receiver-side confirmation.  The holder cannot name the receiver in
  //      advance without the client choosing another participant's identity, so
  //      this first claim is the only way the server learns who received the AED.
  let resolved: "HOLDER" | "RECEIVER" | undefined = side;
  switch (side) {
    case "HOLDER":
      if (input.side !== "HOLDER") {
        throw forbidden("A confirmation must come from the side it names");
      }
      break;
    case "RECEIVER":
      if (input.side !== "RECEIVER") {
        throw forbidden("A confirmation must come from the side it names");
      }
      break;
    default:
      if (input.side !== "RECEIVER") {
        throw forbidden("A confirmation must come from the side it names");
      }
      if (handover.receiverConfirmedAt !== undefined) {
        throw forbidden("Only a party to this handover may confirm it");
      }
      resolved = "RECEIVER";
  }
  const already = resolved === "HOLDER"
    ? handover.holderConfirmedAt
    : handover.receiverConfirmedAt;
  if (already !== undefined) return { handover, applied: false };
  const next: AedHandoverRecord = {
    ...handover,
    ...(resolved === "HOLDER"
      ? { holderConfirmedAt: context.now.toISOString() }
      : {
        receiverConfirmedAt: context.now.toISOString(),
        receiverDeviceInstanceId: context.actorDeviceInstanceId,
        ...(context.actorUserId ? { receiverUserId: context.actorUserId } : {})
      }),
    revision: handover.revision + 1
  };
  // Both sides confirmed: the face-to-face precondition is met, but the handover
  // is only SETTLED by the settlement step, so the temporary point cannot skip
  // its two facts by having both parties tap confirm.
  if (next.holderConfirmedAt !== undefined && next.receiverConfirmedAt !== undefined) {
    next.status = "CONFIRMED";
  }
  view.putHandover(next);
  return { handover: next, applied: true };
}

/**
 * Record the receiver and move custody.
 *
 * `acquiredAt` is preserved: it is when the device left its cabinet, and a
 * handover changes who carries it, not when it was taken.  `custodySince` is what
 * a reader uses for "since when", so the two facts never overwrite each other.
 */
function transferCustody(
  view: HandoverStoreView,
  handover: AedHandoverRecord,
  receiver: { deviceInstanceId: string; userId?: string },
  at: string,
  extra: { depositedAt?: string } = {}
): void {
  const asset = view.asset(handover.aedId);
  if (!asset) throw notFound("AED asset is not registered");
  view.putAsset({
    ...asset,
    status: "IN_USE",
    updatedAt: at,
    revision: asset.revision + 1,
    custody: {
      eventId: handover.eventId,
      deviceInstanceId: receiver.deviceInstanceId,
      ...(receiver.userId ? { userId: receiver.userId } : {}),
      ...(asset.custody?.acquiredAt ? { acquiredAt: asset.custody.acquiredAt } : {}),
      ...extra,
      custodySince: at
    }
  });
}

export interface HandoverSettlementOutcome {
  handover: AedHandoverRecord;
  deposit?: AedTemporaryPointDepositRecord;
}

/**
 * Step 3 — complete the handover.
 *
 * FACE_TO_FACE requires both confirmations.  TEMPORARY_POINT requires a valid
 * position (30 s / 50 m) AND a valid photo reference, and both are recorded before
 * the device is treated as placed — a failure in either leaves the handover
 * PENDING with the device still occupied, so no task can be built on it.
 *
 * Only the holder settles, because only the holder can hand the device over or
 * put it down.  The receiver confirms; they do not choose the mode.
 */
export async function settleHandover(
  view: HandoverStoreView,
  storage: ObjectStoragePort,
  handoverId: string,
  input: AedHandoverSettlementRequest,
  context: HandoverContext,
  dependencies: { depositId: string }
): Promise<HandoverSettlementOutcome> {
  const handover = view.handover(handoverId);
  if (!handover) throw notFound("Handover does not exist");
  if (handover.eventId !== context.eventId) throw forbidden("Handover belongs to another event");
  if (handover.status === "HALTED") throw conflict("This handover was halted");
  const side = handoverSideFor(handover, {
    deviceInstanceId: context.actorDeviceInstanceId,
    ...(context.actorUserId ? { userId: context.actorUserId } : {})
  });
  if (side !== "HOLDER") throw forbidden("Only the current holder may settle this handover");

  if (handover.mode === "FACE_TO_FACE") {
    if (handover.status === "SETTLED") return { handover };
    if (handover.holderConfirmedAt === undefined || handover.receiverConfirmedAt === undefined) {
      throw conflict("A face-to-face handover needs one confirmation from each side");
    }
    if (!input.receiverDeviceInstanceId) {
      throw badRequest("A face-to-face handover must name the receiving device");
    }
    if (handover.receiverDeviceInstanceId !== input.receiverDeviceInstanceId) {
      throw conflict("The receiving device must be the one that confirmed");
    }
    const at = context.now.toISOString();
    const next: AedHandoverRecord = {
      ...handover,
      status: "SETTLED",
      settledAt: at,
      revision: handover.revision + 1
    };
    view.putHandover(next);
    transferCustody(view, next, {
      deviceInstanceId: input.receiverDeviceInstanceId,
      ...(handover.receiverUserId ? { userId: handover.receiverUserId } : {})
    }, at);
    return { handover: next };
  }

  // TEMPORARY_POINT.  Both facts are validated before anything is written, so a
  // rejected photo cannot leave a half-built placement behind.
  if (!input.position || !input.positionObservedAt) {
    throw badRequest("A temporary point requires a current position and its observation time");
  }
  if (!input.photo) throw badRequest("A temporary point requires a photo reference");
  validateHandoverPosition(input.position, input.positionObservedAt, context.now);
  validateHandoverPhoto(input.photo);
  const existingDeposit = view.depositForHandover(handoverId);
  if (existingDeposit) {
    // Idempotent placement: the same request id replays; a different one conflicts.
    if (existingDeposit.requestId !== input.requestId) {
      throw conflict("A temporary point already exists for this handover");
    }
    if (handover.status !== "SETTLED") {
      view.putHandover({
        ...handover,
        status: "SETTLED",
        temporaryPointDepositId: existingDeposit.depositId
      });
    }
    return { handover: view.handover(handoverId)!, deposit: existingDeposit };
  }
  if (handover.status === "SETTLED") throw conflict("This handover is already settled");
  if (!storage.configured) {
    // Fail before writing anything: an unverifiable photo must not become evidence.
    throw unprocessableEntity(
      "Private media storage is not configured; a temporary point cannot be created"
    );
  }
  const existingReference = view.photoReference(input.photo.objectKey);
  if (existingReference && existingReference.sha256 !== input.photo.sha256) {
    throw conflict("This object key was already used with different bytes");
  }
  await storage.confirmObject({
    objectKey: input.photo.objectKey,
    sha256: input.photo.sha256,
    byteSize: input.photo.byteSize
  });
  const at = context.now.toISOString();
  const reference: AedPhotoReference = {
    ...input.photo,
    handoverId,
    eventId: handover.eventId,
    recordedAt: at,
    verifiedAgainstStorage: true
  };
  view.putPhotoReference(reference);
  const deposit: AedTemporaryPointDepositRecord = {
    depositId: dependencies.depositId,
    requestId: input.requestId,
    handoverId,
    eventId: handover.eventId,
    aedId: handover.aedId,
    status: "SEARCHING",
    position: input.position,
    positionObservedAt: input.positionObservedAt,
    objectKey: reference.objectKey,
    placedByDeviceInstanceId: handover.holderDeviceInstanceId,
    ...(handover.holderUserId ? { placedByUserId: handover.holderUserId } : {}),
    depositedAt: at
  };
  view.putDeposit(deposit);
  const next: AedHandoverRecord = {
    ...handover,
    status: "SETTLED",
    settledAt: at,
    temporaryPointDepositId: deposit.depositId,
    revision: handover.revision + 1
  };
  view.putHandover(next);
  // The device is NOT back in its cabinet: it stays occupied at the temporary
  // point, so it is never routable for another event.
  transferCustody(view, next, {
    deviceInstanceId: handover.holderDeviceInstanceId,
    ...(handover.holderUserId ? { userId: handover.holderUserId } : {})
  }, at, { depositedAt: at });
  const asset = view.asset(next.aedId);
  if (asset) {
    view.putAsset({
      ...asset,
      status: "DEPOSITED",
      updatedAt: at,
      revision: asset.revision + 1,
      temporaryPointId: deposit.depositId
    });
  }
  return { handover: next, deposit };
}

export interface TemporaryPointFollowUpOutcome {
  followUp: AedTemporaryPointFollowUpRecord;
  deposit: AedTemporaryPointDepositRecord;
  replayed: boolean;
}

/**
 * Step 4 — the later responder reports what they found.
 *
 * FOUND transfers custody to the finder and keeps the device in use.  NOT_FOUND
 * marks the device UNAVAILABLE, because the evidence that placed it there is no
 * longer true.  Either way the placement point stops accepting searches, so a
 * second responder is not sent to look for something already resolved.
 */
export function reportTemporaryPointFollowUp(
  view: HandoverStoreView,
  depositId: string,
  input: AedTemporaryPointFollowUpRequest,
  context: HandoverContext
): TemporaryPointFollowUpOutcome {
  const deposit = view.deposit(depositId);
  if (!deposit) throw notFound("Temporary point does not exist");
  if (deposit.eventId !== context.eventId) throw forbidden("Temporary point belongs to another event");
  const existing = view.followUpForDeposit(deposit.depositId);
  if (existing) {
    if (existing.requestId !== input.requestId) {
      throw conflict("This temporary point already has a recorded outcome");
    }
    return { followUp: existing, deposit, replayed: true };
  }
  if (deposit.status !== "SEARCHING") throw conflict("This temporary point is already resolved");
  if (input.deviceInstanceId !== context.actorDeviceInstanceId) {
    throw forbidden("A follow-up must be reported by the device that performed it");
  }
  const at = context.now.toISOString();
  const followUp: AedTemporaryPointFollowUpRecord = {
    followUpId: `temporary-point-follow-up:${deposit.depositId}`,
    requestId: input.requestId,
    depositId: deposit.depositId,
    handoverId: deposit.handoverId,
    eventId: deposit.eventId,
    aedId: deposit.aedId,
    outcome: input.outcome,
    deviceInstanceId: input.deviceInstanceId,
    ...(context.actorUserId ? { userId: context.actorUserId } : {}),
    reportedAt: at
  };
  view.putFollowUp(followUp);
  const resolved: AedTemporaryPointDepositRecord = {
    ...deposit,
    status: input.outcome === "FOUND" ? "FOUND" : "NOT_FOUND",
    resolvedAt: at
  };
  view.putDeposit(resolved);
  const asset = view.asset(deposit.aedId);
  if (asset) {
    if (input.outcome === "FOUND") {
      const handover = view.handover(deposit.handoverId);
      if (handover) {
        transferCustody(view, handover, {
          deviceInstanceId: input.deviceInstanceId,
          ...(context.actorUserId ? { userId: context.actorUserId } : {})
        }, at, { depositedAt: deposit.depositedAt });
      }
    } else {
      view.putAsset({
        ...asset,
        status: "UNAVAILABLE",
        updatedAt: at,
        revision: asset.revision + 1,
        temporaryPointId: deposit.depositId
      });
    }
  }
  return { followUp, deposit: resolved, replayed: false };
}

/** The open handover a device is a party to, if any. */
export function openHandoverForParticipant(
  view: HandoverStoreView,
  device: { deviceInstanceId: string; userId?: string }
): AedHandoverRecord | undefined {
  return view.allHandovers()
    .filter(handover => handover.status === "PENDING" || handover.status === "CONFIRMED")
    .find(handover => handoverSideFor(handover, device) !== undefined);
}

/** The placement point a participant of the event may search for, if any. */
export function searchableDepositForEvent(
  view: HandoverStoreView,
  eventId: string
): AedTemporaryPointDepositRecord | undefined {
  return view.allHandovers()
    .filter(handover => handover.eventId === eventId)
    .map(handover => view.depositForHandover(handover.handoverId))
    .find((deposit): deposit is AedTemporaryPointDepositRecord =>
      deposit !== undefined && deposit.status === "SEARCHING");
}

/**
 * Halt an open handover because its holder left the event.
 *
 * The device stays occupied (AWAITING_HANDOFF → AWAITING_RETURN): the exit is
 * recorded, and the physical device is still out there.  Releasing it here is
 * exactly the failure the frozen rule forbids.
 */
export function haltHandoverForExitedHolder(
  view: HandoverStoreView,
  handoverId: string,
  reason: string,
  at: string
): AedHandoverRecord | undefined {
  const handover = view.handover(handoverId);
  if (!handover || handover.status === "SETTLED" || handover.status === "HALTED") return handover;
  const next: AedHandoverRecord = {
    ...handover,
    status: "HALTED",
    haltedAt: at,
    haltReason: reason,
    revision: handover.revision + 1
  };
  view.putHandover(next);
  const asset = view.asset(next.aedId);
  if (asset && asset.custody?.acquiredAt) {
    view.putAsset({
      ...asset,
      status: "AWAITING_RETURN",
      updatedAt: at,
      revision: asset.revision + 1
    });
  }
  return next;
}

/** Fingerprint of the creation request, so a replayed id with new content conflicts. */
export function handoverRequestFingerprint(request: AedHandoverRequest): string {
  return fingerprint(request);
}
