import { operationMetrics } from "./runtime-metrics.js";
import { readState, transactState, NOTIFICATION_DEADLINES, registerStateQueries } from "./incremental-state.js";
import { readEntities, type StateReadView } from "./state-read.js";
import { z } from "zod";
import {
  assignmentRoleSchema,
  assignmentStatusSchema,
  isoDateSchema,
  responseRequestSchema
} from "./contracts.js";
import { fingerprint } from "./domain.js";
import type { DeviceRecord, NotificationName, NotificationRecord, PersistentState } from "./models.js";
import type { StateStore } from "./store.js";

const envelope = z.object({
  schemaVersion: z.literal("2.0"), messageId: z.string().min(1),
  eventId: z.string().min(1), occurredAt: isoDateSchema
});
const counts = z.object({
  revision: z.number().int().nonnegative(), currentRecruitmentRadiusMeters: z.number().nonnegative(),
  nearbyCandidateCount: z.number().int().nonnegative(), pendingOfferCount: z.number().int().nonnegative(),
  acceptedResponderCount: z.number().int().nonnegative(), goToPatientCount: z.number().int().nonnegative(),
  fetchAedCount: z.number().int().nonnegative(), enRouteCount: z.number().int().nonnegative(),
  arrivedAtAedCount: z.number().int().nonnegative(), arrivedAtPatientCount: z.number().int().nonnegative(),
  aedAcquiredCount: z.number().int().nonnegative(), completedAssignmentCount: z.number().int().nonnegative()
}).strict();
const assignment = z.object({
  id: z.string().min(1), eventId: z.string().min(1),
  role: assignmentRoleSchema, status: assignmentStatusSchema,
  revision: z.number().int().nonnegative(),
  route: z.unknown().nullable(), aedAcquiredReceipt: z.unknown().nullable()
}).strict();
const payloadSchemas = {
  "event:patient-activated": envelope.extend({
    state: z.literal("ACTIVE"), recruitmentState: z.literal("RECRUITING")
  }).strict(),
  "response:requested": responseRequestSchema,
  "event:false-alarm-confirmed": envelope.extend({ state: z.literal("CANCELLED_CONFIRMED_FALSE_ALARM"), recruitmentState: z.literal("STOPPED") }).strict(),
  "event:assistance-withdrawn": envelope.extend({ state: z.literal("CANCELLED_ASSISTANCE_WITHDRAWN"), recruitmentState: z.literal("STOPPED") }).strict(),
  "event:resolved": envelope.extend({ state: z.literal("RESOLVED"), recruitmentState: z.literal("COMPLETED") }).strict(),
  "event:closed-unconfirmed-no-response": envelope.extend({ state: z.literal("CLOSED_UNCONFIRMED_NO_RESPONSE"), recruitmentState: z.literal("STOPPED") }).strict(),
  "response:offer-expired": envelope.extend({ deliveryId: z.string().min(1), expiresAt: isoDateSchema,
    reason: z.enum(["OFFER_EXPIRED", "OFFER_NO_LONGER_ELIGIBLE"]) }).strict(),
  "event:patient-position-updated": envelope.extend({ coordinationRevision: z.number().int().nonnegative() }).strict(),
  "event:status-confirmation-requested": envelope.extend({
    confirmationId: z.string().min(1), prompt: z.literal("STILL_IN_PROGRESS"),
    responseDeadlineAt: isoDateSchema
  }).strict(),
  "event:participant-exited": envelope.extend({ coordinationRevision: z.number().int().nonnegative() }).strict(),
  "response:decision-recorded": envelope.extend({ decision: z.enum(["ACCEPT", "REFUSE"]),
    coordination: counts }).strict(),
  "assignment:created": envelope.extend({ assignment }).strict(),
  "assignment:updated": envelope.extend({ assignment }).strict(),
  "aed:acquired": envelope.extend({ assignmentId: z.string().min(1), aedId: z.string().min(1),
    receiptId: z.string().min(1), acquiredAt: isoDateSchema }).strict(),
  "aed:unavailable": envelope.extend({ assignmentId: z.string().min(1), aedId: z.string().min(1) }).strict(),
  "event:coordination-updated": envelope.extend({ coordination: z.union([counts,
    counts.pick({ currentRecruitmentRadiusMeters: true }).strict()]) }).strict(),
  // G08: the contact signal is opaque on purpose.  The alias and the preset kind
  // are read over REST from the team view, so a notification that reaches a lock
  // screen reveals only that something happened in an event the recipient is in.
  "event:team-signal": envelope.extend({ signalId: z.string().min(1) }).strict(),
  // G07: an opaque prompt to answer a 15-second question.  The id, never the route.
  "assignment:reroute-proposed": envelope.extend({ assignmentId: z.string().min(1),
    proposalId: z.string().min(1), expiresAt: isoDateSchema }).strict()
};

export const notificationRecordSchema = z.object({
  id: z.string().min(1), eventId: z.string().min(1),
  name: z.enum(["event:patient-activated", "response:requested", "event:false-alarm-confirmed",
    "event:resolved", "event:assistance-withdrawn", "event:closed-unconfirmed-no-response", "response:offer-expired",
    "event:patient-position-updated", "event:status-confirmation-requested",
    "event:participant-exited", "event:coordination-updated", "response:decision-recorded",
    "assignment:created", "assignment:updated", "aed:acquired", "aed:unavailable",
    "event:team-signal", "assignment:reroute-proposed"]),
  recipient: z.object({ deviceInstanceId: z.string().min(1), companionPairId: z.string().min(1),
    userId: z.string().min(1).optional(), accountId: z.string().min(1).optional() }).strict(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["PENDING", "DISPATCHED", "SUPPRESSED"]), attempts: z.number().int().nonnegative(),
  nextAttemptAt: isoDateSchema, completedAt: isoDateSchema.optional(),
  push: z.object({
    status: z.enum(["PENDING", "DELIVERED", "RETRY", "INVALID_TOKEN", "NOT_REGISTERED"]),
    attempts: z.number().int().nonnegative(),
    lastAttemptAt: isoDateSchema,
    reason: z.string().min(1).optional()
  }).strict().optional()
}).strict().superRefine((row, context) => {
  if (!payloadSchemas[row.name].safeParse(row.payload).success || row.payload.eventId !== row.eventId) {
    context.addIssue({ code: "custom", message: "Notification payload does not match its event and message contract" });
  }
  if ((row.status === "PENDING") !== (row.completedAt === undefined)) {
    context.addIssue({ code: "custom", message: "Notification completion metadata is inconsistent" });
  }
});

/** Enqueues in the caller's business transaction, capturing its authorized binding. */
/**
 * Builds one notification row from the recipient device and the payload.
 *
 * Extracted so the whole-state path and the entity-transaction path apply the same
 * identity, recipient-binding and payload rules.  Returns `undefined` when the
 * recipient is not a notification-capable iPhone, which is the existing skip rule.
 */
export function notificationRowFor(
  device: Pick<DeviceRecord, "deviceKind" | "companionPairId" | "userId" | "accountId">,
  deviceInstanceId: string,
  name: NotificationName,
  payload: Record<string, unknown>
): NotificationRecord | undefined {
  if (device.deviceKind !== "IPHONE") return undefined;
  const id = fingerprint({ name, messageId: payload.messageId, deviceInstanceId });
  const row: NotificationRecord = {
    id, eventId: String(payload.eventId), name,
    recipient: { deviceInstanceId, companionPairId: device.companionPairId,
      ...(device.userId ? { userId: device.userId } : {}),
      ...(device.accountId ? { accountId: device.accountId } : {}) },
    payload, status: "PENDING", attempts: 0, nextAttemptAt: String(payload.occurredAt)
  };
  notificationRecordSchema.parse(row);
  return row;
}

export function enqueueNotification(
  state: PersistentState,
  deviceInstanceId: string,
  name: NotificationName,
  payload: Record<string, unknown>
): void {
  const device = state.devices[deviceInstanceId];
  if (!device) return;
  const row = notificationRowFor(device, deviceInstanceId, name, payload);
  if (!row) return;
  const id = row.id;
  const prior = state.notificationOutboxById[id];
  if (prior) {
    if (fingerprint({ recipient: prior.recipient, payload: prior.payload })
      !== fingerprint({ recipient: row.recipient, payload: row.payload })) {
      throw new Error("Notification identity was reused with different content");
    }
    return;
  }
  state.notificationOutboxById[id] = row;
}

/** One worker per backend; transport acknowledgement is not user delivery. */
export class NotificationOutbox {
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly now: () => Date,
    private readonly dispatch: (state: Readonly<PersistentState>, records: readonly NotificationRecord[]) => Map<string, NotificationRecord["status"]>,
    /**
     * System push, attempted AFTER the socket pass so the two channels are
     * independent.  Absent means "socket only", which is the pre-existing
     * behaviour rather than a failure.
     */
    private readonly push?: (
      records: readonly NotificationRecord[],
      read: <T>(reader: (view: StateReadView) => T) => T
    ) => Promise<void>
  ) {}

  drain(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const work = this.run().catch(() => {
      console.error("Notification outbox unavailable; durable records retained for retry");
    });
    this.inFlight = work;
    void work.then(() => { if (this.inFlight === work) this.inFlight = undefined; });
    return work;
  }

  private async run(): Promise<void> {
    const dueAt = this.now().getTime();
    registerStateQueries(this.store);
    const schedule = this.store.projections?.()?.readDue(NOTIFICATION_DEADLINES, dueAt, 100);
    operationMetrics.outboxScheduleVisits += schedule?.visited ?? 0;
    const groups = readEntities(this.store, view => {
      const grouped = new Map<string, string[]>();
      const due = schedule
        ? schedule.keys.flatMap(id => {
          const row = view.get("notificationOutboxById", id);
          return row && row.status === "PENDING" && Date.parse(row.nextAttemptAt) <= dueAt ? [row] : [];
        })
        : view.select("notificationOutboxById",
          row => row.status === "PENDING" && Date.parse(row.nextAttemptAt) <= dueAt, 100);
      for (const row of due) {
        const key = fingerprint({ name: row.name, payload: row.payload });
        grouped.set(key, [...(grouped.get(key) ?? []), row.id]);
      }
      return [...grouped.values()];
    });
    for (const ids of groups) {
      try {
        // Persist attempts first: a crash at either side of dispatch retains every message ID.
        const started = await transactState(this.store, state => ids.filter(id => {
          const row = state.notificationOutboxById[id];
          if (!row || row.status !== "PENDING" || Date.parse(row.nextAttemptAt) > this.now().getTime()) return false;
          row.attempts += 1;
          const retryMs = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts - 1, 6));
          row.nextAttemptAt = new Date(this.now().getTime() + retryMs).toISOString();
          return true;
        }));
        if (started.length === 0) continue;
        const outcomes = readState(this.store, state => {
          const result = new Map<string, NotificationRecord["status"]>();
          const eligible: NotificationRecord[] = [];
          for (const id of started) {
            const row = state.notificationOutboxById[id]!;
            const device = state.devices[row.recipient.deviceInstanceId];
            if (!device || device.deviceKind !== "IPHONE"
              || device.userId !== row.recipient.userId || device.accountId !== row.recipient.accountId
              || device.companionPairId !== row.recipient.companionPairId) result.set(id, "SUPPRESSED");
            else eligible.push(row);
          }
          // Authorization and synchronous transport handoff share this committed snapshot.
          if (eligible.length) for (const [id, status] of this.dispatch(state, eligible)) result.set(id, status);
          if (started.some(id => !result.has(id))) throw new Error("Incomplete notification dispatch result");
          return result;
        });
        await transactState(this.store, state => {
          for (const id of started) {
            const row = state.notificationOutboxById[id]!;
            row.status = outcomes.get(id)!;
            if (row.status !== "PENDING") row.completedAt = this.now().toISOString();
            else if (row.name === "response:requested") {
              row.nextAttemptAt = new Date(this.now().getTime() + 5_000).toISOString();
            }
          }
        });
        // Push runs after the socket outcome is committed, and only for rows the
        // authorization pass did not suppress.  A push failure must not undo a
        // committed socket dispatch, and vice versa.
        if (this.push) {
          const pushable = readState(this.store, state => started
            .map(id => state.notificationOutboxById[id])
            .filter((row): row is NotificationRecord =>
              row !== undefined && row.status !== "SUPPRESSED"));
          if (pushable.length > 0) {
            try {
              const store = this.store;
              await this.push(pushable, <T>(reader: (view: StateReadView) => T): T =>
                readEntities(store, reader));
            } catch {
              console.error("Push dispatch incomplete; durable records retained for retry");
            }
          }
        }
      } catch {
        console.error("Notification dispatch incomplete; durable records retained for retry");
      }
    }
  }
}
