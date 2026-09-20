import { readState, transactState, stateRows } from "./incremental-state.js";
import { badRequest, conflict, forbidden } from "./errors.js";
import { requireWatchBinding, matchesWatchPatientIdentity } from "./watch-event-access.js";
import { appendTimeline } from "./event-audit.js";
import { enqueueNotification } from "./notification-outbox.js";
import type { DevicePrincipal } from "./identity-access.js";
import type { WatchEmergencyObservation } from "./contracts.js";
import type { PersistentState, EventRecord, EmergencyEventView } from "./models.js";
import type { StateStore } from "./store.js";

interface CreationHooks {
  project(state: PersistentState, event: EventRecord): EmergencyEventView | undefined;
  patientViewers(state: PersistentState, event: EventRecord): string[];
  enforcePatientPriority(state: PersistentState, userId: string, devices: string[], eventId: string, at: Date): void;
  /**
   * Runs recruitment for the new event and returns the event as it now stands.
   *
   * Returning it is not cosmetic: recruitment writes the stage clock and the
   * revision, and a transaction-backed implementation produces a new current-view
   * object, so the callers below would otherwise go on using a stale one.
   */
  recruit(state: PersistentState, event: EventRecord, at: Date): EventRecord;
  enqueueCoordination(state: PersistentState, event: EventRecord, at: string): void;
}

/** Owns the atomic Watch observation/event/patient binding/activation outbox write. */
export async function createWatchEvent(store: StateStore, input: {
  watch: DevicePrincipal; pathEventId: string; observation: WatchEmergencyObservation;
  observationFingerprint: string; occurredAt: string; nowMilliseconds: number;
  eventCutoffMilliseconds: number; fixObservedAt: string | undefined; initialRadiusMeters: number;
}, hooks: CreationHooks): Promise<{ created: boolean; event: EmergencyEventView }> {
  const { watch, pathEventId, observation, observationFingerprint, occurredAt,
    nowMilliseconds, eventCutoffMilliseconds, fixObservedAt, initialRadiusMeters } = input;
  return transactState(store, state => {
      requireWatchBinding(state, watch);
      const reportingDevice = state.devices[watch.deviceInstanceId];
      if (reportingDevice) reportingDevice.lastSeenAt = occurredAt;
      const existing = state.events[pathEventId];
      if (existing) {
        if (existing.patientPairId !== watch.companionPairId
          || !matchesWatchPatientIdentity(state, existing, watch)
          || (existing.triggeringWatchDeviceId
            && existing.triggeringWatchDeviceId !== watch.deviceInstanceId)
          || (watch.userId !== undefined
            && state.devices[watch.deviceInstanceId]?.userId !== watch.userId)
          || (watch.accountId !== undefined
            && state.devices[watch.deviceInstanceId]?.accountId !== watch.accountId)) {
          throw forbidden("Only the Watch that triggered this event may replay its observation");
        }
        if (existing.observationFingerprint !== observationFingerprint) {
          throw conflict("eventId was already used with a different Watch observation");
        }
        existing.triggeringWatchDeviceId ??= watch.deviceInstanceId;
        const view = hooks.project(state, existing);
        if (!view) throw forbidden("Watch session cannot read this event");
        return { created: false, event: view };
      }

      if (nowMilliseconds > eventCutoffMilliseconds) {
        throw badRequest("Fall event observation is outside the 35-minute window");
      }

      const pairedPatientDeviceIds = stateRows(state, "devices", "companionPairId", watch.companionPairId)
        .filter((device) => device.deviceKind === "IPHONE"
          && device.companionPairId === watch.companionPairId
          && (watch.userId === undefined || device.userId === watch.userId)
          && (watch.accountId === undefined || device.accountId === watch.accountId))
        .map((device) => device.deviceInstanceId);
      const patientDeviceIds = pairedPatientDeviceIds;
      const patientUserId = watch.userId
        ?? patientDeviceIds
          .map((deviceId) => state.devices[deviceId]?.userId)
          .find((userId): userId is string => userId !== undefined)
        ?? `legacy-device:${patientDeviceIds[0] ?? watch.deviceInstanceId}`;
      const triggerSource = observation.appHelpResponse === "NEEDS_HELP"
        ? "WATCH_FALL_HELP_CONFIRMED" as const
        : "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED" as const;
      const triggerObservedAt = observation.callFirstObservedAt ?? observation.fallDetectedAt;
      let event: EventRecord = {
        id: pathEventId,
        observation,
        observationFingerprint,
        patientPairId: watch.companionPairId,
        patientUserId,
        patientDeviceIds,
        triggeringWatchDeviceId: watch.deviceInstanceId,
        ...(observation.patientPosition && fixObservedAt !== undefined ? {
          patientPosition: {
            positionUpdateId: pathEventId,
            source: "WATCH_TRIGGER_SNAPSHOT" as const,
            position: observation.patientPosition,
            observedAt: fixObservedAt,
            serverReceivedAt: occurredAt
          }
        } : {}),
        state: "ACTIVE",
        recruitmentState: "RECRUITING",
        triggerSource,
        currentRecruitmentRadiusMeters: initialRadiusMeters,
        recruitmentStageStartedAt: null,
        statusConfirmationCycleStartedAt: occurredAt,
        statusConfirmationHistory: [],
        exitedResponderUserIds: [],
        createdAt: occurredAt,
        coordinationRevision: 1,
        assignmentRevision: 0,
        unavailableAedIds: []
      };
      state.events[pathEventId] = event;
      for (const patientDeviceId of patientDeviceIds) {
        const patientDevice = state.devices[patientDeviceId];
        if (!patientDevice) continue;
        patientDevice.currentEventId = event.id;
        delete patientDevice.currentAssignmentId;
        if (patientDevice.latestPosition?.position.kind === "R") {
          delete patientDevice.latestPosition;
        }
        patientDevice.lastSeenAt = occurredAt;
      }
      hooks.enforcePatientPriority(state, patientUserId, patientDeviceIds, event.id, new Date(occurredAt));
      appendTimeline(
        state,
        event.id,
        triggerObservedAt,
        triggerSource === "WATCH_FALL_HELP_CONFIRMED"
          ? "WATCH_FALL_HELP_CONFIRMED"
          : "WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED",
        triggerSource === "WATCH_FALL_HELP_CONFIRMED"
          ? "Watch Fall context was confirmed by the app's one-time help question."
          : "Watch observed an outgoing-call state after no response; connection or number is unknown."
      );
      appendTimeline(
        state,
        event.id,
        occurredAt,
        "EVENT_ACTIVATED",
        "Event created as ACTIVE/RECRUITING."
      );

      event = hooks.recruit(state, event, new Date(occurredAt));
      for (const patientDeviceId of hooks.patientViewers(state, event)) {
        enqueueNotification(state, patientDeviceId, "event:patient-activated", {
          schemaVersion: "2.0", messageId: `patient-activated:${pathEventId}`, eventId: pathEventId, occurredAt,
          state: "ACTIVE",
          recruitmentState: "RECRUITING"
        });
      }
      hooks.enqueueCoordination(state, event, occurredAt);
      const view = hooks.project(state, event);
      if (!view) throw forbidden("Watch session cannot read the event it created");
      return { created: true, event: view };
  });
}
