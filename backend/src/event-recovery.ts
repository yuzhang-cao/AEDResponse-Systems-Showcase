import type { EmergencyEventView, TimelineEntry } from "./models.js";

/** Compatibility projection. Internal audit records must never enter this boundary. */
export function recoveryTimeline(view: EmergencyEventView): TimelineEntry[] {
  const kind: TimelineEntry["kind"] = view.state === "ACTIVE"
    ? "EVENT_ACTIVATED"
    : view.state === "CANCELLED_CONFIRMED_FALSE_ALARM"
      ? "FALSE_ALARM_CONFIRMED"
      : view.state === "RESOLVED"
        ? "EVENT_RESOLVED"
        : "PASSIVE_OBSERVATION";
  return [{
    id: view.id,
    eventId: view.id,
    occurredAt: view.resolvedAt ?? view.createdAt,
    kind,
    message: "Event state recovered from the authorized snapshot."
  }];
}
