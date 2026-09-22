/**
 * Final participation-window reconciliation.
 *
 * The strict second-slot contract (requirements §位置采集、上传与留存分级) promises that
 * every legal UTC second inside a participation window ends up with exactly one
 * fact — `FIX` or `NO_NEW_FIX` — or an explicit, recorded reason for its absence.
 * It also states the thing that makes this module necessary:
 *
 *   "到达顺序不能被当成缺秒；当前参考后端尚无 `stream-finalized`/`sync-complete`
 *    信号，不得在正常写请求中把跨批次临时缺口固化为最终审计结论".
 *
 * So there are two rules this module exists to enforce:
 *
 *   1. **A gap is a verdict, not an observation.**  Nothing is declared missing
 *      while the window is still open, because an in-flight batch and a permanent
 *      gap are indistinguishable from the write path.  The verdict is written
 *      when the window closes (event terminal, participant exit, or an explicit
 *      client completion signal).
 *   2. **Late-but-legal evidence wins.**  Until the grace deadline passes, a gap
 *      is marked `provisional` and is re-derived from the recorded facts on every
 *      recomputation.  A batch that arrives late therefore replaces the gap with
 *      the real fact instead of being rejected as "already a gap".
 *
 * What this module deliberately does NOT do:
 *   - it never deletes or rewrites a received fact.  The batch store stays
 *     append-only; reconciliation only adds a derived audit record;
 *   - it never invents a fact.  A slot with no record stays a gap with a reason;
 *   - it never guesses a window it cannot read.  A window with no authoritative
 *     end is reported as the open partial window it is.
 */
import type { EventPositionBatchRecord, EventRecord, ParticipantIntervalRecord } from "./models.js";

/** Milliseconds in one UTC second slot. */
const SLOT_MS = 1_000;

/**
 * How long after a window closes a late-but-legal upload may still replace a
 * provisional gap.
 *
 * This is not a retry delay: evidence uploaded inside it is accepted exactly as
 * before and the verdict is recomputed.  It only decides when the recorded gap
 * list stops being a work item and becomes the audit conclusion.
 */
export const POSITION_WINDOW_GRACE_SECONDS = 120;

/** Whether a batch belongs to one participation window identity. */
export interface WindowIdentity {
  eventId: string;
  userId: string;
  deviceInstanceId: string;
  kind: "P" | "R";
}

/**
 * The server-authoritative window for one participant device.
 *
 * `endedAt` is `null` while the window is still open.  An open window is never
 * reconciled into a final verdict: doing so would freeze the seconds between the
 * last received fact and "now" into a permanent gap, which is exactly the
 * mistake the requirement forbids.
 */
export interface ParticipationWindow {
  identity: WindowIdentity;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Derives the window for one device of one event from committed state.
 *
 * The rule mirrors the one the write path already enforces:
 *   - the primary patient device starts at `event.createdAt` and ends at
 *     `event.resolvedAt`;
 *   - an accepted responder starts at their interval's `acceptedAt` and ends at
 *     whichever came first, their interval end or the event's terminal time.
 */
export function participationWindowFor(
  event: EventRecord,
  input: { deviceInstanceId: string; userId: string; interval?: ParticipantIntervalRecord }
): ParticipationWindow | undefined {
  const isPrimaryPatientDevice = event.patientDeviceIds.includes(input.deviceInstanceId);
  if (isPrimaryPatientDevice) {
    return {
      identity: {
        eventId: event.id,
        userId: input.userId,
        deviceInstanceId: input.deviceInstanceId,
        kind: "P"
      },
      startedAt: event.createdAt,
      endedAt: event.resolvedAt ?? null
    };
  }
  const interval = input.interval;
  if (!interval
    || interval.eventId !== event.id
    || interval.userId !== input.userId
    || interval.deviceInstanceId !== input.deviceInstanceId) {
    return undefined;
  }
  const ends = [interval.endedAt, event.resolvedAt]
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    identity: {
      eventId: event.id,
      userId: input.userId,
      deviceInstanceId: input.deviceInstanceId,
      kind: "R"
    },
    startedAt: interval.acceptedAt,
    endedAt: ends[0] ?? null
  };
}

/**
 * The legal slot instants of a window, on the UTC second grid.
 *
 * A slot is legal when its start instant lies inside `[startedAt, endedAt)`.
 * A terminal partial second is included; any FIX in it must also have been
 * observed before the window ended, as enforced by the upload path.
 */
export function expectedSlotInstants(window: ParticipationWindow): number[] {
  if (window.endedAt === null) return [];
  const start = Date.parse(window.startedAt);
  const end = Date.parse(window.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const first = Math.ceil(start / SLOT_MS) * SLOT_MS;
  const slots: number[] = [];
  for (let instant = first; instant < end; instant += SLOT_MS) slots.push(instant);
  return slots;
}

/** One recorded fact, reduced to what a verdict needs. */
export interface RecordedSlotFact {
  slotAt: number;
  status: "FIX" | "NO_NEW_FIX";
  /** The client's own reason for a `NO_NEW_FIX` slot, when it recorded one. */
  gapReason?: "NO_FIX" | "APP_NOT_RUNNING";
}

/** Everything recorded for one window, as the verdict sees it. */
export interface WindowEvidence {
  facts: RecordedSlotFact[];
  recordCount: number;
}

/**
 * Projects the recorded batches of one window into the verdict's view.
 *
 * Batches are append-only, so this is a pure read: the same batch store always
 * yields the same `WindowEvidence`, which is what makes reconciliation
 * idempotent by construction rather than by a dedup table.
 */
export function windowEvidenceFrom(
  batches: readonly EventPositionBatchRecord[],
  window: ParticipationWindow
): WindowEvidence {
  const { identity } = window;
  const startedAt = Date.parse(window.startedAt);
  const endedAt = window.endedAt === null ? Infinity : Date.parse(window.endedAt);
  if (!Number.isFinite(startedAt) || Number.isNaN(endedAt) || endedAt <= startedAt) {
    return { facts: [], recordCount: 0 };
  }
  const bySlot = new Map<number, RecordedSlotFact>();
  let recordCount = 0;
  for (const batch of batches) {
    if (batch.eventId !== identity.eventId
      || batch.userId !== identity.userId
      || batch.deviceInstanceId !== identity.deviceInstanceId
      || batch.kind !== identity.kind) continue;
    for (const record of batch.records) {
      if (record.eventId !== identity.eventId
        || record.userId !== identity.userId
        || record.deviceInstanceId !== identity.deviceInstanceId
        || record.kind !== identity.kind) continue;
      const slotAt = Date.parse(record.slotAt);
      if (!Number.isFinite(slotAt) || slotAt < startedAt || slotAt >= endedAt) continue;
      recordCount += 1;
      // The store rejects a second record for the same slot, so a collision here
      // can only come from historically imported data.  Keep the first and count
      // it: the verdict must not silently absorb an impossible duplicate.
      if (bySlot.has(slotAt)) continue;
      bySlot.set(slotAt, record.status === "FIX"
        ? { slotAt, status: "FIX" }
        : {
          slotAt,
          status: "NO_NEW_FIX",
          ...(record.gapReason ? { gapReason: record.gapReason } : {})
        });
    }
  }
  return { facts: [...bySlot.values()].sort((left, right) => left.slotAt - right.slotAt), recordCount };
}

export interface ReconciliationOutcome {
  expectedSlotCount: number;
  receivedSlotCount: number;
  receivedRecordCount: number;
  fixSlotCount: number;
  noFixSlotCount: number;
  gaps: {
    slotAt: string;
    reason: "NEVER_UPLOADED" | "CLIENT_OFFLINE" | "PERMISSION_REVOKED" | "APP_NOT_RUNNING" | "PROCESS_RESTART";
    provisional: boolean;
  }[];
}

/**
 * Computes the explicit outcome for one window.
 *
 * Pure: same window plus same evidence always yields the same outcome, which is
 * the property the idempotency tests rely on.
 */
export function reconcileWindow(input: {
  window: ParticipationWindow;
  evidence: WindowEvidence;
  /** Whether a late-but-legal upload may still replace a gap right now. */
  withinGrace: boolean;
}): ReconciliationOutcome {
  const expected = expectedSlotInstants(input.window);
  const factsBySlot = new Map(input.evidence.facts.map(fact => [fact.slotAt, fact]));
  const gaps: ReconciliationOutcome["gaps"] = [];
  let receivedSlotCount = 0;
  let fixSlotCount = 0;
  for (const instant of expected) {
    const fact = factsBySlot.get(instant);
    if (fact) {
      receivedSlotCount += 1;
      if (fact.status === "FIX") fixSlotCount += 1;
      continue;
    }
    gaps.push({
      slotAt: new Date(instant).toISOString(),
      // Missing records and present-day permissions cannot establish a cause.
      reason: "NEVER_UPLOADED",
      provisional: input.withinGrace
    });
  }
  return {
    expectedSlotCount: expected.length,
    receivedSlotCount,
    receivedRecordCount: input.evidence.recordCount,
    fixSlotCount,
    noFixSlotCount: receivedSlotCount - fixSlotCount,
    gaps
  };
}

/** Identity of a reconciliation record: one per window, not one per run. */
export function reconciliationIdFor(identity: WindowIdentity, windowStartedAt: string): string {
  return `position-window:${identity.eventId}:${identity.deviceInstanceId}:${windowStartedAt}`;
}

/**
 * Whether two gap lists describe a different set of missing SECONDS.
 *
 * Distinct from `gapListsMatch`, which also compares `provisional`.  The grace
 * deadline passing flips every flag without a single new fact arriving, and that
 * must not be reported as "late evidence corrected this verdict".
 */
export function gapSlotsChanged(
  left: readonly { slotAt: string; reason: string }[],
  right: readonly { slotAt: string; reason: string }[]
): boolean {
  if (left.length !== right.length) return true;
  return left.some((gap, index) =>
    gap.slotAt !== right[index]?.slotAt || gap.reason !== right[index]?.reason);
}

/**
 * Whether two gap lists say the same thing.
 *
 * `provisional` is part of the comparison on purpose.  When the grace deadline
 * passes without a late upload, the gap list keeps its slots and reasons but
 * stops being a work item — and that transition has to count as a change, or the
 * stored record would keep telling a later reader that evidence may still be
 * coming.
 */
export function gapListsMatch(
  left: readonly { slotAt: string; reason: string; provisional?: boolean }[],
  right: readonly { slotAt: string; reason: string; provisional?: boolean }[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((gap, index) =>
    gap.slotAt === right[index]?.slotAt
    && gap.reason === right[index]?.reason
    && (gap.provisional ?? false) === (right[index]?.provisional ?? false));
}
