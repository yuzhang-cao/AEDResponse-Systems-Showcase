import { transactState } from "./incremental-state.js";
import { badRequest, conflict, forbidden } from "./errors.js";
import { appendTimeline } from "./event-audit.js";
import { enqueueNotification } from "./notification-outbox.js";

import type { DevicePrincipal } from "./identity-access.js";
import type { PatientPosition, UserReportedPatientObservation } from "./contracts.js";
import type { EventRecord, EmergencyEventView, PersistentState } from "./models.js";
import type { StateStore } from "./store.js";

/**
 * A patient found by a person (G05/G01 触发方式扩展).
 *
 * The product's other trigger is a Watch fall observation, which requires the
 * patient to be wearing a Watch that detected something.  This one starts the same
 * event machinery from what a person can actually do: they see someone who needs
 * help, press one button, and the case begins at their own position.
 *
 * Deliberately minimal, because it is meant to be ONE MORE WAY TO START AN EVENT,
 * not a second product:
 *
 *   - the event is created exactly like a Watch-triggered one (ACTIVE/RECRUITING),
 *     so recruitment, assignment, AED tasks, notification and retention are the
 *     existing paths, unchanged;
 *   - the reporter's phone becomes the patient-side device, because it is the
 *     device that is with the patient and can publish the patient's position;
 *   - the observation records only what was actually observed — a position and a
 *     time.  It carries no fall fields, so nothing downstream can later read a
 *     `fallResolution` that nobody measured;
 *   - one report per event id, and a replay by the same device returns the event it
 *     already created instead of opening a second case for the same patient.
 */
interface CreationHooks {
  /** The same agreement gate the bootstrap uses, so the two cannot drift. */
  hasCurrentAgreements(device: PersistentState["devices"][string]): boolean;
  project(state: PersistentState, event: EventRecord): EmergencyEventView | undefined;
  patientViewers(state: PersistentState, event: EventRecord): string[];
  enforcePatientPriority(state: PersistentState, userId: string, devices: string[], eventId: string, at: Date): void;
  recruit(state: PersistentState, event: EventRecord, at: Date): EventRecord;
  enqueueCoordination(state: PersistentState, event: EventRecord, at: string): void;
}

export async function createUserReportedEvent(store: StateStore, input: {
  reporter: DevicePrincipal;
  pathEventId: string;
  patientPosition: PatientPosition;
  reportedAt: string;
  initialRadiusMeters: number;
}, hooks: CreationHooks): Promise<{ created: boolean; event: EmergencyEventView }> {
  const { reporter, pathEventId, patientPosition, reportedAt, initialRadiusMeters } = input;
  return transactState(store, state => {
    const device = state.devices[reporter.deviceInstanceId];
    if (!device || device.deviceKind !== "IPHONE") {
      throw forbidden("A found-patient report requires an authenticated iPhone session");
    }
    if (reporter.userId && device.userId !== reporter.userId) {
      throw forbidden("iPhone device session is no longer bound to its account");
    }
    // The reporter is about to become the patient-side position source, which is a
    // business capability: the same four agreements a patient needs are required.
    if (!hooks.hasCurrentAgreements(device)) {
      throw forbidden("A found-patient report requires the four current agreements");
    }
    const reportedMilliseconds = Date.parse(reportedAt);
    if (!Number.isFinite(reportedMilliseconds)) {
      throw badRequest("reportedAt must be an ISO-8601 timestamp");
    }

    const existing = state.events[pathEventId];
    if (existing) {
      // Idempotent by event id: a lost acknowledgement must not open a second case
      // for the same patient.  Only the reporting device may replay it.
      const observation = existing.observation as { observationKind?: string; reporterDeviceId?: string };
      if (existing.triggerSource !== "USER_REPORTED_PATIENT"
        || observation.reporterDeviceId !== reporter.deviceInstanceId) {
        throw conflict("eventId was already used by a different report");
      }
      const view = hooks.project(state, existing);
      if (!view) throw forbidden("This device cannot read the event it reported");
      return { created: false, event: view };
    }

    const observation: UserReportedPatientObservation = {
      schemaVersion: "2.0",
      eventId: pathEventId,
      observationKind: "USER_REPORTED_PATIENT",
      reportedAt,
      patientPosition,
      patientPositionObservedAt: reportedAt,
      reporterDeviceId: reporter.deviceInstanceId
    };
    const patientDeviceIds = [reporter.deviceInstanceId];
    const patientUserId = reporter.userId ?? `legacy-device:${reporter.deviceInstanceId}`;
    const reportedAtIso = new Date(reportedMilliseconds).toISOString();
    let event: EventRecord = {
      id: pathEventId,
      observation,
      observationFingerprint: `user-report:${pathEventId}:${reporter.deviceInstanceId}:${reportedAtIso}`,
      patientPairId: device.companionPairId,
      patientUserId,
      patientDeviceIds,
      // The reporter's own position is an iPhone sample from the device that is with
      // the patient, so it uses the existing source rather than inventing a new one.
      patientPosition: {
        positionUpdateId: pathEventId,
        source: "IPHONE_PRIMARY",
        position: patientPosition,
        observedAt: reportedAtIso,
        serverReceivedAt: reportedAtIso
      },
      state: "ACTIVE",
      recruitmentState: "RECRUITING",
      triggerSource: "USER_REPORTED_PATIENT",
      currentRecruitmentRadiusMeters: initialRadiusMeters,
      recruitmentStageStartedAt: null,
      statusConfirmationCycleStartedAt: reportedAtIso,
      statusConfirmationHistory: [],
      exitedResponderUserIds: [],
      createdAt: reportedAtIso,
      coordinationRevision: 1,
      assignmentRevision: 0,
      unavailableAedIds: []
    };
    state.events[pathEventId] = event;
    device.currentEventId = event.id;
    delete device.currentAssignmentId;
    device.lastSeenAt = reportedAtIso;
    hooks.enforcePatientPriority(state, patientUserId, patientDeviceIds, event.id, new Date(reportedAtIso));
    appendTimeline(
      state,
      event.id,
      reportedAtIso,
      "EVENT_ACTIVATED",
      "Event created as ACTIVE/RECRUITING after a person reported a patient they found."
    );

    event = hooks.recruit(state, event, new Date(reportedAtIso));
    for (const patientDeviceId of hooks.patientViewers(state, event)) {
      enqueueNotification(state, patientDeviceId, "event:patient-activated", {
        schemaVersion: "2.0",
        messageId: `patient-activated:${pathEventId}`,
        eventId: pathEventId,
        occurredAt: reportedAtIso,
        state: "ACTIVE",
        recruitmentState: "RECRUITING"
      });
    }
    hooks.enqueueCoordination(state, event, reportedAtIso);
    const view = hooks.project(state, event);
    if (!view) throw forbidden("This device cannot read the event it reported");
    return { created: true, event: view };
  });
}
