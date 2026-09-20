import type { EventRecord } from "./models.js";

export const ONLINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export function purgeDeadline(clockStartedAt: string): number {
  const anniversary = new Date(clockStartedAt);
  if (!Number.isFinite(anniversary.getTime())) return Number.NaN;
  // Calendar years include leap days. Feb 29 advances to Mar 1 when necessary,
  // never to an earlier instant than the complete retention anniversary.
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 3);
  return anniversary.getTime();
}

export function nextRetentionDeadline(event: Pick<EventRecord, "state" | "resolvedAt" | "retention">): number | undefined {
  if (event.state === "ACTIVE") return undefined;
  const hold = event.retention?.legalHold;
  if (hold && hold.releasedAt === undefined) return undefined;
  const clock = event.retention?.clockStartedAt ?? event.resolvedAt;
  if (!clock || !Number.isFinite(Date.parse(clock))) return undefined;
  return (event.retention?.tier ?? "ONLINE") === "ONLINE"
    ? Date.parse(clock) + ONLINE_RETENTION_MS : purgeDeadline(clock);
}
