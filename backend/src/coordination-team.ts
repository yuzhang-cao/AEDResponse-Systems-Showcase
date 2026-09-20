/**
 * G08 — the anonymous team projection.
 *
 * When several responders are working the same event they need to know who is
 * doing what, and nothing more.  The requirement is explicit about the boundary:
 * a random per-event alias, role, status and an APPROXIMATE position icon; never
 * a name, a raw phone number, an exact coordinate or a personal ETA.
 *
 * Two decisions are load-bearing:
 *
 *   1. **The alias is derived, not stored.**  It is a keyed hash of
 *      (event, identity), so it is stable for the event — two members can refer
 *      to "成员 7K3Q" consistently — while revealing nothing across events, and a
 *      member who rejoins the same event keeps their alias.
 *   2. **The position is rounded before it leaves.**  Coarsening happens here,
 *      in the projection, so no caller can accidentally serialise a precise
 *      coordinate into a team view.  The rounding grid is coarse enough that a
 *      position cell covers several buildings.
 *
 * Access is decided by the caller from the committed participant set: only a
 * member who is currently accepted sees the team, and leaving or a terminal event
 * removes them from it immediately.
 */
import { createHmac } from "node:crypto";
import type {
  TeamSignalRecord,
  AssignmentRecord,
  DeliveryRecord,
  DeviceRecord,
  EventRecord,
  PersistentState
} from "./models.js";
import { assignmentExitsParticipation, deviceIdentityKey } from "./domain.js";

/** Alias letters/digits, minus characters that are easy to confuse when read out. */
const ALIAS_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ALIAS_LENGTH = 4;

/** Rounding grid for the team view: ~55 m in latitude, so a cell is a block. */
const POSITION_GRID_DEGREES = 0.0005;

export interface TeamMemberView {
  /** Stable within one event, meaningless outside it. */
  alias: string;
  role: AssignmentRecord["role"];
  status: AssignmentRecord["status"];
  /** Coarsened position, or absent when the member has no fresh sample. */
  approximatePosition?: { latitude: number; longitude: number };
  /** Age bucket rather than a timestamp, so it cannot be used for tracking. */
  positionFreshness: "CURRENT" | "RECENT" | "STALE" | "UNKNOWN";
  isViewer: boolean;
}

export interface CoordinationTeamView {
  eventId: string;
  members: TeamMemberView[];
  /** The viewer's own alias, so the client can mark "me" without a device id. */
  viewerAlias: string | null;
  generatedAt: string;
}

/**
 * The per-event alias of one identity.
 *
 * Keyed by the event id, so the same person has different aliases in different
 * events, and salted again by the caller's `salt` so a leaked alias table cannot
 * be brute-forced back to a user id.
 */
export function teamAlias(eventId: string, identity: string, salt: string): string {
  const digest = createHmac("sha256", salt)
    .update(`${eventId}\u0000${identity}`)
    .digest();
  let alias = "";
  for (let index = 0; index < ALIAS_LENGTH; index += 1) {
    alias += ALIAS_ALPHABET[digest[index]! % ALIAS_ALPHABET.length];
  }
  return alias;
}

/** Coarsens a coordinate to the team-view grid. */
export function approximatePosition(position: { latitude: number; longitude: number }): {
  latitude: number;
  longitude: number;
} {
  const round = (value: number): number =>
    Math.round(value / POSITION_GRID_DEGREES) * POSITION_GRID_DEGREES;
  return { latitude: round(position.latitude), longitude: round(position.longitude) };
}

/** Age bucket for a sample, so the view never carries a precise timestamp. */
export function positionFreshness(
  observedAt: string | undefined,
  now: Date,
  maxAgeSeconds: number
): TeamMemberView["positionFreshness"] {
  if (!observedAt) return "UNKNOWN";
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return "UNKNOWN";
  const ageSeconds = (now.getTime() - observed) / 1_000;
  if (ageSeconds < 0) return "UNKNOWN";
  if (ageSeconds <= maxAgeSeconds / 3) return "CURRENT";
  if (ageSeconds <= maxAgeSeconds) return "RECENT";
  return "STALE";
}

/**
 * Whether this device is currently a member of the event's team.
 *
 * Membership is the ACCEPTED delivery plus a non-exited participant interval:
 * an offer that was merely sent grants no visibility, which is what keeps the
 * patient's data away from people who never agreed to help.
 */
export function teamMembership(
  state: Readonly<PersistentState>,
  event: EventRecord,
  deviceInstanceId: string
): { member: boolean; viewerIdentity: string | undefined } {
  const device = state.devices[deviceInstanceId];
  if (!device) return { member: false, viewerIdentity: undefined };
  if (event.state !== "ACTIVE") return { member: false, viewerIdentity: undefined };
  const identity = deviceIdentityKey(device);
  if (device.userId && event.exitedResponderUserIds?.includes(device.userId)) {
    return { member: false, viewerIdentity: undefined };
  }
  const accepted = Object.values(state.deliveries).some((delivery: DeliveryRecord) =>
    delivery.eventId === event.id
    && delivery.deviceInstanceId === deviceInstanceId
    && delivery.decision === "ACCEPT"
    && delivery.status === "ACCEPTED");
  if (!accepted) return { member: false, viewerIdentity: undefined };
  const assignment = Object.values(state.assignments).find((candidate: AssignmentRecord) =>
    candidate.eventId === event.id && candidate.deviceInstanceId === deviceInstanceId);
  if (assignment && assignmentExitsParticipation(assignment.status)) {
    return { member: false, viewerIdentity: undefined };
  }
  return { member: true, viewerIdentity: identity };
}

/**
 * Builds the team view for one member.
 *
 * Returns `undefined` when the viewer is not a current member: the caller turns
 * that into a refusal, so an outsider (including the patient) cannot enumerate
 * the responders working an event.
 */
export function coordinationTeamView(input: {
  state: Readonly<PersistentState>;
  event: EventRecord;
  viewerDeviceInstanceId: string;
  salt: string;
  now: Date;
  positionMaxAgeSeconds: number;
}): CoordinationTeamView | undefined {
  const { state, event, viewerDeviceInstanceId, salt, now } = input;
  const viewer = teamMembership(state, event, viewerDeviceInstanceId);
  if (!viewer.member) return undefined;

  const members: TeamMemberView[] = [];
  const seen = new Set<string>();
  for (const delivery of Object.values(state.deliveries)) {
    if (delivery.eventId !== event.id) continue;
    if (delivery.decision !== "ACCEPT" || delivery.status !== "ACCEPTED") continue;
    const device = state.devices[delivery.deviceInstanceId] as DeviceRecord | undefined;
    if (!device) continue;
    const identity = deviceIdentityKey(device);
    if (seen.has(identity)) continue;
    // A member who has exited is not part of the team any more, even though their
    // ACCEPTED delivery row is retained as evidence.
    if (device.userId && event.exitedResponderUserIds?.includes(device.userId)) continue;
    const assignment = Object.values(state.assignments).find((candidate: AssignmentRecord) =>
      candidate.eventId === event.id && candidate.deviceInstanceId === device.deviceInstanceId);
    if (assignment && assignmentExitsParticipation(assignment.status)) continue;
    seen.add(identity);

    const latest = device.latestPosition;
    const freshness = positionFreshness(latest?.observedAt, now, input.positionMaxAgeSeconds);
    members.push({
      alias: teamAlias(event.id, identity, salt),
      role: assignment?.role ?? "GO_TO_PATIENT",
      status: assignment?.status ?? "ASSIGNED",
      ...(latest && (freshness === "CURRENT" || freshness === "RECENT")
        ? { approximatePosition: approximatePosition({
          latitude: latest.position.latitude,
          longitude: latest.position.longitude
        }) }
        : {}),
      positionFreshness: freshness,
      isViewer: delivery.deviceInstanceId === viewerDeviceInstanceId
    });
  }

  // Stable order so the client does not reshuffle on every push.
  members.sort((left, right) => left.alias.localeCompare(right.alias));
  return {
    eventId: event.id,
    members,
    viewerAlias: viewer.viewerIdentity
      ? teamAlias(event.id, viewer.viewerIdentity, salt)
      : null,
    generatedAt: now.toISOString()
  };
}

/**
 * The contact form the requirement asks to be settled before building more.
 *
 * Recorded as data rather than prose so a reviewer can see the decision, and so
 * adding voice or video later is a change to this value with a visible diff.
 */
export const TEAM_CONTACT_FORM = {
  kind: "PRESET_MESSAGES",
  /** Short, privacy-preserving messages only; no free text, no media. */
  messages: [
    "我已接受任务",
    "正在前往",
    "已到达患者",
    "已取得 AED",
    "这里需要帮助",
    "无法继续，请他人接手"
  ],
  /** A message is scoped to the event and expires with it. */
  retention: "EVENT_LIFETIME",
  /** Nothing is delivered after the sender leaves or the event ends. */
  revokedOn: ["PARTICIPANT_EXIT", "EVENT_TERMINAL"]
} as const;

/**
 * The in-app contact mechanism, in its smallest honest form.
 *
 * The requirement asks for "App 内联系能力" between accepted responders while
 * forbidding names, avatars, phone numbers, precise coordinates and free text.
 * The chosen form (`TEAM_CONTACT_FORM`) is therefore a CLOSED vocabulary of short
 * preset signals: there is no field a message body could travel in, so the privacy
 * property is structural rather than a moderation promise, and there is nothing to
 * report or filter.
 *
 * The rules that make it usable and safe are all enforced here, over committed
 * state:
 *
 *   - only a CURRENT member may send or read, so exit and terminal state revoke
 *     the channel in the same instant they revoke the team view;
 *   - a signal is scoped to one event, expires with it, and never carries the
 *     sender's identity beyond the anonymous alias the team view already shows;
 *   - sends are rate limited per sender and capped per event, and are idempotent
 *     by the client's own `signalId`, so a retry after a lost ACK cannot spam the
 *     team.
 */
export const TEAM_SIGNAL_KINDS = [
  "ACCEPTED_TASK",
  "ON_MY_WAY",
  "ARRIVED_AT_PATIENT",
  "AED_ACQUIRED",
  "NEED_HELP_HERE",
  "CANNOT_CONTINUE"
] as const;
export type TeamSignalKind = typeof TEAM_SIGNAL_KINDS[number];

/** Minimum gap between two signals from the same sender in one event. */
export const TEAM_SIGNAL_MIN_INTERVAL_MS = 5_000;
/** Hard cap per sender per event, so one device cannot flood a team. */
export const TEAM_SIGNAL_MAX_PER_SENDER = 20;
/** A signal is about the next few minutes of a response, not a message history. */
export const TEAM_SIGNAL_TTL_MS = 10 * 60 * 1_000;

export function isTeamSignalKind(value: unknown): value is TeamSignalKind {
  return typeof value === "string" && (TEAM_SIGNAL_KINDS as readonly string[]).includes(value);
}

export type TeamSignalRejection =
  | "NOT_A_MEMBER"
  | "UNKNOWN_KIND"
  | "TOO_SOON"
  | "TOO_MANY"
  | "EVENT_NOT_ACTIVE";

export type TeamSignalResult =
  | { ok: true; signal: TeamSignalRecord; recipients: string[]; duplicate: boolean }
  | { ok: false; reason: TeamSignalRejection; retryAfterMs?: number };

/**
 * Validates and builds one signal.  Pure: the caller commits the record.
 *
 * Idempotency is checked first, so a retried delivery returns the ORIGINAL signal
 * (and the caller can skip re-notifying), while every rejection reason is distinct
 * enough for the client to say something useful.
 */
export function planTeamSignal(input: {
  state: Readonly<PersistentState>;
  event: EventRecord;
  senderDeviceInstanceId: string;
  signalId: string;
  kind: unknown;
  now: Date;
  salt: string;
}): TeamSignalResult {
  const { state, event, senderDeviceInstanceId, now } = input;
  if (event.state !== "ACTIVE") return { ok: false, reason: "EVENT_NOT_ACTIVE" };
  const membership = teamMembership(state, event, senderDeviceInstanceId);
  if (!membership.member) return { ok: false, reason: "NOT_A_MEMBER" };
  if (!isTeamSignalKind(input.kind)) return { ok: false, reason: "UNKNOWN_KIND" };

  const existing = state.teamSignalsById[input.signalId];
  if (existing) {
    // A replay of the same request returns the stored signal, and only when it
    // belongs to this sender and event: an id guessed from another team must not
    // become a way to read it.
    if (existing.eventId !== event.id
      || existing.senderDeviceInstanceId !== senderDeviceInstanceId) {
      return { ok: false, reason: "UNKNOWN_KIND" };
    }
    return { ok: true, signal: existing, recipients: [], duplicate: true };
  }

  const mine = Object.values(state.teamSignalsById)
    .filter(row => row.eventId === event.id && row.senderDeviceInstanceId === senderDeviceInstanceId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (mine.length >= TEAM_SIGNAL_MAX_PER_SENDER) return { ok: false, reason: "TOO_MANY" };
  const last = mine[mine.length - 1];
  if (last) {
    const elapsed = now.getTime() - Date.parse(last.createdAt);
    if (elapsed >= 0 && elapsed < TEAM_SIGNAL_MIN_INTERVAL_MS) {
      return { ok: false, reason: "TOO_SOON", retryAfterMs: TEAM_SIGNAL_MIN_INTERVAL_MS - elapsed };
    }
  }

  const signal: TeamSignalRecord = {
    signalId: input.signalId,
    eventId: event.id,
    senderDeviceInstanceId,
    ...(state.devices[senderDeviceInstanceId]?.userId
      ? { senderUserId: state.devices[senderDeviceInstanceId]!.userId }
      : {}),
    kind: input.kind,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TEAM_SIGNAL_TTL_MS).toISOString(),
    acknowledgedByDeviceIds: []
  };
  return {
    ok: true,
    signal,
    recipients: currentTeamDeviceIds(state, event, senderDeviceInstanceId),
    duplicate: false
  };
}

/** Every other current member's iPhone, the audience a signal is delivered to. */
export function currentTeamDeviceIds(
  state: Readonly<PersistentState>,
  event: EventRecord,
  excludingDeviceInstanceId: string
): string[] {
  const recipients = new Set<string>();
  for (const delivery of Object.values(state.deliveries)) {
    if (delivery.eventId !== event.id) continue;
    if (delivery.decision !== "ACCEPT" || delivery.status !== "ACCEPTED") continue;
    if (delivery.deviceInstanceId === excludingDeviceInstanceId) continue;
    if (!teamMembership(state, event, delivery.deviceInstanceId).member) continue;
    recipients.add(delivery.deviceInstanceId);
  }
  return [...recipients].sort();
}

export interface TeamSignalView {
  alias: string;
  kind: TeamSignalKind;
  createdAt: string;
  expiresAt: string;
  /** True for the viewer's own signals, so the client can label them. */
  mine: boolean;
}

/** The signals a current member may see: anonymous, bounded and already filtered. */
export function teamSignalFeed(input: {
  state: Readonly<PersistentState>;
  event: EventRecord;
  viewerDeviceInstanceId: string;
  now: Date;
  salt: string;
}): TeamSignalView[] | undefined {
  const membership = teamMembership(input.state, input.event, input.viewerDeviceInstanceId);
  if (!membership.member) return undefined;
  return Object.values(input.state.teamSignalsById)
    .filter(row => row.eventId === input.event.id && Date.parse(row.expiresAt) > input.now.getTime())
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(row => {
      const sender = input.state.devices[row.senderDeviceInstanceId];
      const identity = sender ? deviceIdentityKey(sender) : row.senderDeviceInstanceId;
      return {
        alias: teamAlias(input.event.id, identity, input.salt),
        kind: row.kind,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        mine: row.senderDeviceInstanceId === input.viewerDeviceInstanceId
      };
    });
}
