import { z } from "zod";
import { aedAssetSchema, type AedAssetRecord } from "./aed-asset-model.js";
import { isoDateSchema, type Aed } from "./contracts.js";
import { conflict, forbidden, notFound } from "./errors.js";
import { fingerprint, isTerminalAssignmentStatus } from "./domain.js";
import { stateRows } from "./incremental-state.js";
import type { PersistentState } from "./models.js";

export const aedAssetActionSchema = z.object({
  requestId: z.uuid(), expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(1000),
  action: z.enum(["REGISTER", "VERIFY", "DISABLE", "RETIRE", "START_MAINTENANCE", "COMPLETE_MAINTENANCE", "CONFIRM_RETURN"]),
  registration: aedAssetSchema.shape.registration.unwrap().optional(),
  physicallyConfirmedAt: isoDateSchema.optional()
}).strict();
export type AedAssetAction = z.infer<typeof aedAssetActionSchema>;
export const aedAssetActionRecordSchema = z.object({ id: z.uuid(), aedId: z.string().min(1), fingerprint: z.string(),
  action: aedAssetActionSchema.shape.action, reason: z.string(), occurredAt: isoDateSchema,
  eventId: z.string().optional(), result: aedAssetSchema }).strict();
export type AedAssetActionRecord = z.infer<typeof aedAssetActionRecordSchema>;

function verificationIsCurrent(asset: AedAssetRecord, at: Date): boolean {
  const registration = asset.registration;
  return !registration || (Date.parse(registration.verifiedAt) <= at.getTime()
    && Date.parse(registration.validUntil) > at.getTime() && registration.aed.available);
}

/** Static fixtures remain a development/import source. Operational state takes
 * precedence: ending an assignment cannot return a physically acquired device. */
export function routingAeds(state: Readonly<PersistentState>, at: Date, eventId?: string): Aed[] {
  const catalogue = new Map(state.aeds.map(aed => [aed.id, aed]));
  for (const asset of stateRows(state, "aedAssetsById", "$registered", "yes")) {
    if (asset.registration) catalogue.set(asset.aedId, asset.registration.aed);
  }
  return [...catalogue.values()].map(aed => {
    const asset = state.aedAssetsById[aed.id];
    const available = !asset ? aed.available : verificationIsCurrent(asset, at)
      && (asset.status === "AVAILABLE" || (asset.status === "RESERVED" && asset.custody?.eventId === eventId));
    return { ...aed, available: aed.available && available };
  });
}

/** Reconcile only one event's reservations after its assignment transaction.
 * Acquired devices are deliberately retained after exit, timeout and closure. */
export function reconcileEventAssets(state: PersistentState, eventId: string, at: string): void {
  const event = state.events[eventId];
  if (!event) return;
  const assignments = stateRows(state, "assignments", "eventId", eventId);
  const desired = new Map<string, typeof assignments[number]>();
  for (const assignment of assignments) {
    const aedId = assignment.route?.aedId;
    if (!aedId || assignment.role !== "FETCH_AED" || assignment.aedAcquiredReceipt
      || event.state !== "ACTIVE" || isTerminalAssignmentStatus(assignment.status)) continue;
    const existing = desired.get(aedId);
    if (existing && existing.id !== assignment.id) throw conflict("An AED cannot have two current reservations");
    desired.set(aedId, assignment);
  }
  for (const asset of stateRows(state, "aedAssetsById", "custody.eventId", eventId)) {
    if (asset.status === "RESERVED" && !desired.has(asset.aedId)) {
      delete asset.custody; asset.status = verificationIsCurrent(asset, new Date(at)) ? "AVAILABLE" : "UNAVAILABLE";
      asset.updatedAt = at; asset.revision++;
    } else if (asset.custody?.acquiredAt && asset.status === "IN_USE" && (event.state !== "ACTIVE"
      || event.exitedResponderUserIds?.includes(asset.custody.userId ?? ""))) {
      asset.status = "AWAITING_RETURN"; asset.updatedAt = at; asset.revision++;
    }
  }
  for (const [aedId, assignment] of desired) {
    const asset = state.aedAssetsById[aedId];
    // An unavailable report/maintenance action invalidates a quote. It must not
    // silently be promoted back to AVAILABLE by an old assignment.
    if (asset && asset.status !== "AVAILABLE" && !(asset.status === "RESERVED" && asset.custody?.eventId === eventId)) continue;
    if (asset?.status === "RESERVED" && asset.custody?.deviceInstanceId === assignment.deviceInstanceId) continue;
    state.aedAssetsById[aedId] = { ...asset, aedId, status: "RESERVED", updatedAt: at, revision: (asset?.revision ?? 0) + 1,
      custody: { eventId, deviceInstanceId: assignment.deviceInstanceId,
        ...(state.devices[assignment.deviceInstanceId]?.userId ? { userId: state.devices[assignment.deviceInstanceId]!.userId! } : {}) } };
  }
}

export function acquireAsset(state: PersistentState, aedId: string, eventId: string, deviceId: string, at: string): void {
  const asset = state.aedAssetsById[aedId];
  if (asset && (!verificationIsCurrent(asset, new Date(at)) || (asset.status !== "AVAILABLE"
    && !(asset.status === "RESERVED" && asset.custody?.eventId === eventId && asset.custody.deviceInstanceId === deviceId)))) {
    throw conflict("AED is no longer available to this assignment");
  }
  state.aedAssetsById[aedId] = { ...asset, aedId, status: "IN_USE", updatedAt: at, revision: (asset?.revision ?? 0) + 1,
    custody: { eventId, deviceInstanceId: deviceId, acquiredAt: at,
      ...(state.devices[deviceId]?.userId ? { userId: state.devices[deviceId]!.userId! } : {}) } };
}

export function markAssetUnavailable(state: PersistentState, aedId: string, eventId: string, at: string): void {
  const asset = state.aedAssetsById[aedId];
  if (asset?.custody?.acquiredAt || (asset?.custody && asset.custody.eventId !== eventId)) throw conflict("AED is held by another custody fact");
  state.aedAssetsById[aedId] = { ...asset, aedId, status: "UNAVAILABLE", updatedAt: at, revision: (asset?.revision ?? 0) + 1 };
  delete state.aedAssetsById[aedId]!.custody;
}

/** Only a separately authorized asset operator calls this; clients cannot declare
 * a return or turn an unavailable object into a new route. */
export function applyAssetAction(state: PersistentState, aedId: string, input: AedAssetAction, now: Date): AedAssetRecord {
  const request = aedAssetActionSchema.parse(input);
  const requestFingerprint = fingerprint({ aedId, ...request });
  const prior = state.aedAssetActionsById[request.requestId];
  if (prior) { if (prior.fingerprint !== requestFingerprint) throw conflict("Asset requestId has different content"); return prior.result; }
  const current = state.aedAssetsById[aedId];
  if ((current?.revision ?? 0) !== request.expectedRevision) throw conflict("Asset revision changed; reload before applying the action");
  if (request.action !== "REGISTER" && !current) throw notFound("AED asset is not registered");
  if (request.action === "REGISTER" && current?.registration) throw conflict("AED asset is already registered");
  const updatesRegistration = ["REGISTER", "VERIFY", "COMPLETE_MAINTENANCE", "CONFIRM_RETURN"].includes(request.action);
  if (updatesRegistration) {
    const registration = request.registration;
    if (!registration || registration.aed.id !== aedId || (registration.aed.aedPosition.accuracyMeters ?? Infinity) > 50
      || Date.parse(registration.verifiedAt) > now.getTime() || Date.parse(registration.validUntil) <= now.getTime()
      || Date.parse(registration.validUntil) <= Date.parse(registration.verifiedAt)) throw conflict("Current source, permission and physical verification are required");
    if (!registration.aed.available) throw conflict("A verified AVAILABLE asset must be physically available");
  } else if (request.registration) throw conflict("This action does not change registration");
  if (["REGISTER", "VERIFY", "COMPLETE_MAINTENANCE"].includes(request.action) && current?.custody) throw conflict("Return or handoff must resolve custody first");
  if (request.action === "CONFIRM_RETURN") {
    if (!current?.custody?.acquiredAt && !["AWAITING_RETURN", "DEPOSITED"].includes(current?.status ?? "")) throw conflict("There is no acquired AED to return");
    if (!request.physicallyConfirmedAt || now.getTime() - Date.parse(request.physicallyConfirmedAt) > 30_000
      || Date.parse(request.physicallyConfirmedAt) > now.getTime()) throw conflict("Return requires a current physical confirmation");
  }
  if (request.action === "COMPLETE_MAINTENANCE" && current?.status !== "MAINTENANCE") throw conflict("AED is not in maintenance");
  const next: AedAssetRecord = { ...current, aedId, updatedAt: now.toISOString(), revision: (current?.revision ?? 0) + 1,
    status: updatesRegistration ? "AVAILABLE" : request.action === "RETIRE" ? "RETIRED"
      : request.action === "START_MAINTENANCE" ? "MAINTENANCE" : "UNAVAILABLE",
    ...(request.registration ? { registration: request.registration } : {}) };
  if (updatesRegistration) { delete next.custody; delete next.temporaryPointId; }
  state.aedAssetsById[aedId] = next;
  state.aedAssetActionsById[request.requestId] = { id: request.requestId, aedId, fingerprint: requestFingerprint,
    action: request.action, reason: request.reason, occurredAt: now.toISOString(),
    ...(current?.custody?.eventId ? { eventId: current.custody.eventId } : {}), result: structuredClone(next) };
  return next;
}
