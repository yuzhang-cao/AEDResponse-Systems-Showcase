import { randomUUID } from "node:crypto";
import type { PersistentState, TimelineEntry } from "./models.js";

/**
 * Builds one timeline entry.
 *
 * Extracted so the whole-state path and the entity-transaction path construct
 * entries by the same rule rather than by two copies that can drift.  The id is
 * generated here, so callers must not rely on it being stable across runs.
 */
export function timelineEntryFor(
  eventId: string,
  occurredAt: string,
  kind: TimelineEntry["kind"],
  message: string
): TimelineEntry {
  return { id: randomUUID(), eventId, occurredAt, kind, message };
}

export function appendTimeline(
  state: PersistentState,
  eventId: string,
  occurredAt: string,
  kind: TimelineEntry["kind"],
  message: string
): TimelineEntry {
  const entry = timelineEntryFor(eventId, occurredAt, kind, message);
  (state.timelineByEventId[eventId] ??= []).push(entry);
  return entry;
}
