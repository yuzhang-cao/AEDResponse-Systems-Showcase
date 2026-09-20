import { readEntities } from "./state-read.js";
import { forbidden, notFound } from "./errors.js";
import type { DevicePrincipal, Principal } from "./identity-access.js";
import type { DeviceRecord, EventRecord, PersistentState, WatchEventStateView } from "./models.js";
import type { StateStore } from "./store.js";

export function requireWatchBinding(state: Readonly<Pick<PersistentState, "devices">>, watch: DevicePrincipal): DeviceRecord {
  const device = state.devices[watch.deviceInstanceId];
  if (!device || device.deviceKind !== "WATCH"
    || device.companionPairId !== watch.companionPairId
    || (watch.userId !== undefined && device.userId !== watch.userId)
    || (watch.accountId !== undefined && device.accountId !== watch.accountId)) {
    throw forbidden("Watch session is not bound to this authenticated account and pair");
  }
  return device;
}

export function requireTriggeringWatch(state: Readonly<Pick<PersistentState, "devices">>, event: EventRecord, watch: DevicePrincipal): void {
  requireWatchBinding(state, watch);
  if (event.patientPairId !== watch.companionPairId
    || event.triggeringWatchDeviceId !== watch.deviceInstanceId
    || !matchesWatchPatientIdentity(state, event, watch)) {
    throw forbidden("Only the Watch that triggered this paired event may report fallback state");
  }
}

export function matchesWatchPatientIdentity(state: Readonly<Pick<PersistentState, "devices">>, event: EventRecord, watch: DevicePrincipal): boolean {
  if (event.patientUserId !== undefined && event.patientUserId === watch.userId) return true;
  // Preserve only the pre-account import path: this placeholder is not an authenticated user.
  const device = state.devices[watch.deviceInstanceId];
  return watch.userId === undefined && watch.accountId === undefined
    && device?.userId === undefined && device?.accountId === undefined
    && event.patientUserId === `legacy-device:${event.patientDeviceIds[0] ?? event.id}`
    && event.patientDeviceIds.every(id => state.devices[id]?.userId === undefined && state.devices[id]?.accountId === undefined);
}

export function watchFallbackAllowedByServer(event: EventRecord, now: Date): boolean {
  const baseline = Date.parse(event.iphonePatientPosition?.serverReceivedAt ?? event.createdAt);
  return event.state === "ACTIVE" && Number.isFinite(baseline) && now.getTime() - baseline >= 10_000;
}

/** A Watch can recover only the outcome/window of its own trigger, never iPhone query fields. */
export function readWatchEventState(store: StateStore, principal: Principal, eventId: string, now: Date = new Date()): WatchEventStateView {
  if (principal.kind !== "DEVICE" || principal.deviceKind !== "WATCH" || !principal.scopes.includes("watch:report")) {
    throw forbidden("Watch state recovery requires the Watch scope watch:report");
  }
  return readEntities(store, view => {
    const event = view.get("events", eventId);
    if (!event) throw notFound("Event does not exist");
    const devices: Record<string, DeviceRecord> = {};
    for (const id of new Set([principal.deviceInstanceId, ...event.patientDeviceIds])) {
      const device = view.get("devices", id);
      if (device) devices[id] = device;
    }
    requireTriggeringWatch({ devices }, event, principal);
    return { eventId: event.id, state: event.state, createdAt: event.createdAt, resolvedAt: event.resolvedAt ?? null, fallbackAllowed: watchFallbackAllowedByServer(event, now) };
  });
}
