/**
 * G08 — the anonymous team projection.
 *
 * What must hold: two responders on one event can see each other's role, status
 * and a coarse position, addressed by a stable alias — and nothing else.  The
 * alias must not be reusable across events, the position must not be precise, a
 * non-member (including the patient) must see nothing at all, and leaving must
 * remove someone immediately.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TEAM_CONTACT_FORM,
  approximatePosition,
  coordinationTeamView,
  positionFreshness,
  teamAlias,
  teamMembership
} from "../src/coordination-team.js";
import { deviceIdentityKey } from "../src/domain.js";
import { emptyState, type PersistentState } from "../src/models.js";

const BASE = "2026-09-05T00:00:00.000Z";
const NOW = new Date(BASE);
const EVENT = "REDACTED-ID-0109";
const PATIENT = "REDACTED-ID-0110";
const R1 = "REDACTED-ID-0112";
const R2 = "REDACTED-ID-0113";
const OUTSIDER = "REDACTED-ID-0114";

function world(overrides: {
  r1Status?: string;
  exitedUserIds?: string[];
  eventState?: string;
  r1Position?: { latitude: number; longitude: number } | undefined;
  r1ObservedAt?: string;
} = {}): PersistentState {
  const state = emptyState();
  const device = (id: string, userId: string) => ({
    deviceInstanceId: id,
    deviceKind: "IPHONE" as const,
    userId,
    companionPairId: "REDACTED-ID-0115",
    agreements: {},
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true,
    presenceObservedAt: BASE,
    lastSeenAt: BASE,
    lastBootstrapAt: BASE,
    ...(id === R1 && overrides.r1Position !== undefined
      ? {
        latestPosition: {
          positionUpdateId: "REDACTED-ID-0116",
          observedAt: overrides.r1ObservedAt ?? BASE,
          serverReceivedAt: BASE,
          position: { kind: "R", ...overrides.r1Position, accuracyMeters: 10 }
        }
      }
      : {})
  });
  state.devices[R1] = device(R1, "user-r1") as never;
  state.devices[R2] = device(R2, "user-r2") as never;
  state.devices[OUTSIDER] = device(OUTSIDER, "user-outsider") as never;
  state.events[EVENT] = {
    id: EVENT,
    state: overrides.eventState ?? "ACTIVE",
    recruitmentState: "RECRUITING",
    patientUserId: "user-patient",
    patientDeviceIds: [PATIENT],
    patientPairId: "REDACTED-ID-0117",
    unavailableAedIds: [],
    exitedResponderUserIds: overrides.exitedUserIds ?? [],
    observationFingerprint: "team-test",
    triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    observation: {
      schemaVersion: "2.0",
      eventId: EVENT,
      observationKind: "FALL_CONTEXT",
      fallDetectedAt: BASE,
      patientPositionObservedAt: BASE,
      fallResolution: "UNRESPONSIVE",
      appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10 }
    },
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentStageStartedAt: BASE,
    coordinationRevision: 1,
    assignmentRevision: 1,
    createdAt: BASE
  } as never;
  const accepted = (id: string) => ({
    id: `delivery-${id}`,
    eventId: EVENT,
    deviceInstanceId: id,
    status: "ACCEPTED",
    decision: "ACCEPT",
    statusOccurredAt: BASE,
    request: {
      schemaVersion: "2.0",
      messageId: `m-${id}`,
      eventId: EVENT,
      deliveryId: `delivery-${id}`,
      deliveryStatus: "SENT",
      occurredAt: BASE,
      eventType: "FALL_ASSISTANCE",
      positioningTier: "SEARCH_RING",
      distanceRange: "DISTANCE_500_1000M",
      etaRange: "ETA_5_10_MIN",
      currentRecruitmentRadiusMeters: 1_000,
      expiresAt: "2026-09-05T00:01:00.000Z"
    }
  });
  state.deliveries[`delivery-${R1}`] = accepted(R1) as never;
  state.deliveries[`delivery-${R2}`] = accepted(R2) as never;
  state.assignments["assignment-r1"] = {
    id: "assignment-r1",
    eventId: EVENT,
    deviceInstanceId: R1,
    role: "FETCH_AED",
    status: (overrides.r1Status ?? "EN_ROUTE") as never,
    revision: 1,
    createdAt: BASE,
    updatedAt: BASE
  } as never;
  return state;
}

function view(state: PersistentState, viewer = R2, salt = "team-salt") {
  return coordinationTeamView({
    state,
    event: state.events[EVENT]!,
    viewerDeviceInstanceId: viewer,
    salt,
    now: NOW,
    positionMaxAgeSeconds: 600
  });
}

test("an accepted member sees the team by alias, role, status and coarse position", () => {
  const state = world({ r1Position: { latitude: 22.19873, longitude: 113.54391 } });
  const team = view(state);
  assert.ok(team);
  assert.equal(team.members.length, 2);
  const r1 = team.members.find(member => member.alias !== team.viewerAlias);
  assert.ok(r1);
  assert.equal(r1.role, "FETCH_AED");
  assert.equal(r1.status, "EN_ROUTE");
  assert.equal(r1.isViewer, false);
  assert.ok(team.members.some(member => member.isViewer));

  // The position is rounded to the team grid, not the sample that was uploaded.
  assert.notDeepEqual(r1.approximatePosition, { latitude: 22.19873, longitude: 113.54391 });
  assert.deepEqual(approximatePosition({ latitude: 22.19873, longitude: 113.54391 }),
    r1.approximatePosition);
  assert.equal(r1.positionFreshness, "CURRENT");

  // And the serialized view carries no identity, no exact coordinate, no name.
  const serialized = JSON.stringify(team);
  assert.equal(serialized.includes("user-r1"), false);
  assert.equal(serialized.includes(R1), false, "团队视图不得包含设备 id");
  assert.equal(serialized.includes("22.19873"), false, "不得包含精确坐标");
});

test("the alias is stable inside one event and meaningless in another", () => {
  const first = teamAlias(EVENT, "user-r1", "salt");
  assert.equal(first, teamAlias(EVENT, "user-r1", "salt"), "同一事件内别名必须稳定");
  assert.equal(first.length, 4);
  assert.notEqual(first, teamAlias("another-event", "user-r1", "salt"),
    "跨事件不得复用同一别名");
  assert.notEqual(first, teamAlias(EVENT, "user-r1", "other-salt"),
    "换 salt 必须换别名，防止别名表被反推");
  const state = world();
  const team = view(state)!;
  // The alias is keyed by the identity KEY (which distinguishes a bound user from
  // an unbound device), not by the raw userId.
  assert.equal(team.viewerAlias,
    teamAlias(EVENT, deviceIdentityKey(state.devices[R2]!), "team-salt"));
});

test("a non-member sees nothing: an outsider and the patient are both refused", () => {
  const state = world();
  assert.equal(view(state, OUTSIDER), undefined, "未接受邀请的设备不得看到团队");
  assert.equal(view(state, PATIENT), undefined, "患者只看聚合人数，不得看到团队成员");
  assert.deepEqual(teamMembership(state, state.events[EVENT]!, OUTSIDER),
    { member: false, viewerIdentity: undefined });
});

test("a terminal event removes the team entirely", () => {
  const state = world({ eventState: "RESOLVED" });
  assert.equal(view(state), undefined);
});

test("exiting removes a member immediately while their evidence row stays", () => {
  const state = world({ exitedUserIds: ["user-r1"] });
  const team = view(state)!;
  assert.equal(team.members.length, 1, "退出者必须立即从团队视图消失");
  assert.equal(team.members[0]!.isViewer, true);
  // The ACCEPTED delivery row is deliberately retained as evidence.
  assert.ok(state.deliveries[`delivery-${R1}`]);
});

test("a participation-ending assignment also removes the member", () => {
  const state = world({ r1Status: "CANCELLED" });
  const team = view(state)!;
  assert.equal(team.members.length, 1);
});

test("a stale or missing sample yields a bucket instead of a position", () => {
  assert.equal(positionFreshness(undefined, NOW, 600), "UNKNOWN");
  assert.equal(positionFreshness("2026-09-05T00:00:00.000Z", NOW, 600), "CURRENT");
  assert.equal(positionFreshness("2026-09-04T23:50:00.000Z", NOW, 600), "RECENT");
  assert.equal(positionFreshness("2026-09-04T23:00:00.000Z", NOW, 600), "STALE");
  assert.equal(positionFreshness("not-a-date", NOW, 600), "UNKNOWN");

  const noPosition = view(world())!;
  const member = noPosition.members.find(entry => !entry.isViewer)!;
  assert.equal(member.approximatePosition, undefined);
  assert.equal(member.positionFreshness, "UNKNOWN");
});

test("the contact form is a decision, not free text or media", () => {
  assert.equal(TEAM_CONTACT_FORM.kind, "PRESET_MESSAGES");
  assert.ok(TEAM_CONTACT_FORM.messages.length > 0);
  assert.deepEqual([...TEAM_CONTACT_FORM.revokedOn],
    ["PARTICIPANT_EXIT", "EVENT_TERMINAL"]);
  assert.equal(TEAM_CONTACT_FORM.retention, "EVENT_LIFETIME");
});
