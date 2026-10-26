/**
 * G07 — the 15-second reroute: a proposal, never a silent reassignment.
 *
 * The requirement is that a responder already walking to an AED may be offered a
 * closer device, and keeps the original task unless they explicitly confirm
 * inside 15 seconds.  The failure this prevents is a backend that moves someone's
 * destination while they are looking at the road.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AedRoute, AssignmentRecord, RerouteProposalRecord } from "../src/models.js";
import { emptyState } from "../src/models.js";
import { transactState } from "../src/incremental-state.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import {
  REROUTE_MAX_DRIFT_METERS,
  REROUTE_WINDOW_SECONDS,
  decideReroute,
  expireRerouteProposals,
  proposeReroute,
  rerouteStillApplies,
  rerouteViewOver,
  rerouteWorthProposing
} from "../src/reroute.js";

const AT = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T00:00:07.000Z";
const TOO_LATE = "2026-09-05T00:00:16.000Z";

function route(aedId: string, distanceMeters: number): AedRoute {
  return {
    aedId,
    path: [
      { kind: "R", latitude: 22.199, longitude: 113.5439, accuracyMeters: 10 },
      { kind: "A", latitude: 22.1995, longitude: 113.5439, accuracyMeters: 5 },
      { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10 }
    ],
    distanceMeters,
    distanceSource: "GEODESIC_ESTIMATE"
  };
}

function assignment(overrides: Partial<AssignmentRecord> = {}): AssignmentRecord {
  return {
    id: "assignment-1",
    eventId: "event-1",
    deviceInstanceId: "device-1",
    role: "FETCH_AED",
    status: "EN_ROUTE",
    revision: 3,
    createdAt: AT,
    updatedAt: AT,
    route: route("aed-original", 300)
  } as AssignmentRecord;
}

function world(proposalOverrides: Partial<RerouteProposalRecord> = {}) {
  const state = {
    rerouteProposalsById: {} as Record<string, RerouteProposalRecord>,
    assignments: { "assignment-1": assignment() } as Record<string, AssignmentRecord>
  };
  const view = rerouteViewOver(state);
  const proposal = proposeReroute(view, {
    proposalId: "proposal-1",
    eventId: "event-1",
    assignmentId: "assignment-1",
    deviceInstanceId: "device-1",
    userId: "user-1",
    fromAedId: "aed-original",
    toAedId: "aed-closer",
    proposedRoute: route("aed-closer", 120),
    proposedFrom: { latitude: 22.199, longitude: 113.5439 },
    distanceSavingMeters: 180,
    proposedAt: AT,
    expiresAt: new Date(Date.parse(AT) + REROUTE_WINDOW_SECONDS * 1_000).toISOString(),
    ...proposalOverrides
  });
  return { state, view, proposal };
}

test("a proposal does not touch the original task", () => {
  const { state, proposal } = world();
  assert.equal(proposal.status, "PENDING");
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original",
    "提出改道不得改变原任务");
  assert.equal(state.assignments["assignment-1"]!.revision, 3);
  assert.equal(REROUTE_WINDOW_SECONDS, 15);
});

test("an explicit acceptance inside the window moves the task exactly once", () => {
  const { state, view } = world();
  const outcome = decideReroute(view, {
    proposalId: "proposal-1",
    deviceInstanceId: "device-1",
    accept: true,
    decidedAt: LATER
  });
  assert.deepEqual(outcome, { status: "ACCEPTED", route: route("aed-closer", 120) });
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-closer");
  assert.equal(state.assignments["assignment-1"]!.revision, 4, "接受后 revision 必须递增");
  assert.equal(state.assignments["assignment-1"]!.updatedAt, LATER);
  assert.equal(state.rerouteProposalsById["proposal-1"]!.status, "ACCEPTED");
  assert.equal(state.rerouteProposalsById["proposal-1"]!.decidedAt, LATER);

  // Answering twice must not move it again.
  const again = decideReroute(view, {
    proposalId: "proposal-1", deviceInstanceId: "device-1", accept: true, decidedAt: LATER
  });
  assert.deepEqual(again, { status: "REFUSED", reason: "PROPOSAL_ALREADY_DECIDED" });
  assert.equal(state.assignments["assignment-1"]!.revision, 4);
});

test("an explicit refusal keeps the original task", () => {
  const { state, view } = world();
  assert.deepEqual(
    decideReroute(view, {
      proposalId: "proposal-1", deviceInstanceId: "device-1", accept: false, decidedAt: LATER
    }),
    { status: "REJECTED" }
  );
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original");
  assert.equal(state.assignments["assignment-1"]!.revision, 3, "拒绝不得改动任务");
  assert.equal(state.rerouteProposalsById["proposal-1"]!.status, "REJECTED");
});

test("an answer after the window is expired, not accepted or rejected", () => {
  const { state, view } = world();
  const outcome = decideReroute(view, {
    proposalId: "proposal-1", deviceInstanceId: "device-1", accept: true, decidedAt: TOO_LATE
  });
  assert.deepEqual(outcome, { status: "REFUSED", reason: "PROPOSAL_EXPIRED" });
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original",
    "超时必须保持原任务");
  assert.equal(state.rerouteProposalsById["proposal-1"]!.status, "EXPIRED",
    "超时与拒绝必须是两种可区分的记录");
});

test("the sweeper retires only proposals whose window closed", () => {
  const { state, view } = world();
  assert.deepEqual(expireRerouteProposals(view, new Date(LATER)), [],
    "窗口内的提议不得被清扫");
  assert.equal(state.rerouteProposalsById["proposal-1"]!.status, "PENDING");
  assert.deepEqual(expireRerouteProposals(view, new Date(TOO_LATE)), ["proposal-1"]);
  assert.equal(state.rerouteProposalsById["proposal-1"]!.status, "EXPIRED");
  assert.deepEqual(expireRerouteProposals(view, new Date(TOO_LATE)), [],
    "清扫必须幂等");
});

test("acceptance revalidates: a taken target device is refused", () => {
  const { state, view } = world();
  const outcome = decideReroute(view, {
    proposalId: "proposal-1",
    deviceInstanceId: "device-1",
    accept: true,
    decidedAt: LATER,
    targetAedTakenBy: (aedId, except) => aedId === "aed-closer" && except === "assignment-1"
  });
  assert.deepEqual(outcome, { status: "REFUSED", reason: "TARGET_AED_NO_LONGER_AVAILABLE" });
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original");
  assert.equal(state.rerouteProposalsById["proposal-1"]!.refusalReason,
    "TARGET_AED_NO_LONGER_AVAILABLE");
});

test("acceptance revalidates: a responder who moved away is refused", () => {
  const { state, view } = world();
  const movedFar = {
    latitude: 22.199 + (REROUTE_MAX_DRIFT_METERS + 50) / 111_320,
    longitude: 113.5439
  };
  const outcome = decideReroute(view, {
    proposalId: "proposal-1",
    deviceInstanceId: "device-1",
    accept: true,
    decidedAt: LATER,
    currentPosition: movedFar
  });
  assert.deepEqual(outcome, { status: "REFUSED", reason: "RESPONDER_MOVED" });
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original");

  // A small drift is still the same situation.
  assert.equal(rerouteStillApplies(
    state.rerouteProposalsById["proposal-1"]!,
    { latitude: 22.1991, longitude: 113.5439 }
  ), true);
});

test("acceptance revalidates: a task that progressed is refused", () => {
  const { state, view } = world();
  state.assignments["assignment-1"] = {
    ...state.assignments["assignment-1"]!,
    status: "ARRIVED_AT_PATIENT"
  };
  const outcome = decideReroute(view, {
    proposalId: "proposal-1", deviceInstanceId: "device-1", accept: true, decidedAt: LATER
  });
  assert.deepEqual(outcome, { status: "REFUSED", reason: "ASSIGNMENT_NO_LONGER_REROUTABLE" });
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original");

  // The same guard covers the acquired case, which is the one that matters most:
  // the device is physically in hand.
  state.assignments["assignment-1"] = {
    ...state.assignments["assignment-1"]!, status: "AED_ACQUIRED"
  };
  assert.equal(
    decideReroute(view, {
      proposalId: "proposal-1", deviceInstanceId: "device-1", accept: true, decidedAt: LATER
    }).status,
    "REFUSED"
  );
});

test("another device cannot answer for this responder", () => {
  const { state, view } = world();
  assert.deepEqual(
    decideReroute(view, {
      proposalId: "proposal-1", deviceInstanceId: "device-2", accept: true, decidedAt: LATER
    }),
    { status: "REFUSED", reason: "NOT_YOUR_ASSIGNMENT" }
  );
  assert.equal(state.assignments["assignment-1"]!.route!.aedId, "aed-original");
  const unknown = decideReroute(view, {
    proposalId: "nope", deviceInstanceId: "device-1", accept: true, decidedAt: LATER
  });
  assert.deepEqual(unknown, { status: "REFUSED", reason: "PROPOSAL_NOT_FOUND" });
});

test("only a materially better detour is worth proposing", () => {
  assert.equal(rerouteWorthProposing({ currentDistanceMeters: 300, candidateDistanceMeters: 120 }), true);
  assert.equal(rerouteWorthProposing({ currentDistanceMeters: 300, candidateDistanceMeters: 250 }), true,
    "按距离比较，不按秒数阈值比较");
  assert.equal(rerouteWorthProposing({
    currentDistanceMeters: 300, candidateDistanceMeters: 250, minimumSavingMeters: 30
  }), true);
  assert.equal(rerouteWorthProposing({ currentDistanceMeters: 300, candidateDistanceMeters: 320 }), false);
  assert.equal(rerouteWorthProposing({ currentDistanceMeters: Number.NaN, candidateDistanceMeters: 1 }), false);
});

/* ------------------------------------------------------------------ *
 * Service level: the proposal must be DISCOVERABLE, device-scoped, and
 * answered from REST truth.
 *
 * The unit tests above prove the decision logic.  What they cannot show is
 * whether a phone could ever learn that a question is waiting: a proposal with no
 * read path and no notification is a server-side fact nobody can act on.  These
 * cases drive the real service over a real event.
 * ------------------------------------------------------------------ */

const BASE_MS = Date.parse("2026-09-13T08:00:00.000Z");
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const atMs = (milliseconds: number): string => new Date(milliseconds).toISOString();

const rerouteInventory = [
  { id: "aed-patient", name: "Patient-side AED",
    aedPosition: { kind: "A" as const, latitude: 22.1988, longitude: 113.5439, accuracyMeters: 5 } },
  { id: "aed-mid", name: "Midway AED",
    aedPosition: { kind: "A" as const, latitude: 22.2095, longitude: 113.5439, accuracyMeters: 5 } }
].map(({ id, name, aedPosition }) => ({
  id, name, aedPosition, openFrom: "00:00", openUntil: "00:00", floor: "1F",
  floorTransferSeconds: 0, accessNote: "lobby", accessDelaySeconds: 0,
  verificationSeconds: 0, available: true
}));

interface RerouteServiceHarness {
  service: AEDResponseService;
  store: MemoryStateStore;
  eventId: string;
  patient: DevicePrincipal;
  aedResponder: DevicePrincipal;
  otherResponder: DevicePrincipal;
  assignmentId: string;
  setNow(milliseconds: number): void;
}

async function rerouteServiceHarness(): Promise<RerouteServiceHarness> {
  let now = BASE_MS;
  const store = new MemoryStateStore(emptyState(rerouteInventory));
  const service = new AEDResponseService(store, {
    host: "127.0.0.1", port: 0, dataFile: "unused-reroute.json",
    fixtureFile: "unused-in-memory-fixture.json", sessionTtlSeconds: 3_600,
    nearbyRadiusMeters: 5_000, positionMaxAgeSeconds: 600, maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50, bootstrapLimitPerMinute: 100,
    operatorToken: "reroute-operator-token", production: false
  } as never, { emitToDevices() { return []; } } as never, () => new Date(now));
  const boot = async (id: string, deviceKind: "IPHONE" | "WATCH", pair: string) => {
    const session = await service.bootstrap({
      deviceInstanceId: id, deviceKind, companionPairId: pair,
      ...(deviceKind === "IPHONE" ? {
        agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
          "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({ kind, version: "2.0", acceptedAt: atMs(BASE_MS) })),
        capabilities: { notificationAuthorized: true, locationAuthorized: true },
        availableForResponse: true
      } : {})
    } as never, `synthetic:${id}`);
    const principal = service.authenticateToken(session.sessionToken);
    if (principal.kind !== "DEVICE") throw new Error("device principal required");
    return principal;
  };
  const patient = await boot(uuid(2), "IPHONE", uuid(1));
  const watch = await boot(uuid(3), "WATCH", uuid(1));
  const aedResponder = await boot(uuid(4), "IPHONE", uuid(5));
  const otherResponder = await boot(uuid(8), "IPHONE", uuid(9));
  // The AED responder stands midway (they will be offered the patient-side AED and
  // then walk); the other responder stands next to the patient.
  for (const [device, id, latitude] of [
    [aedResponder, uuid(6), 22.2090], [otherResponder, uuid(10), 22.1990]
  ] as const) {
    await service.updateResponderPosition(device, {
      positionUpdateId: id, observedAt: atMs(BASE_MS),
      responderPosition: { kind: "R", latitude, longitude: 113.5439, accuracyMeters: 10 }
    });
  }
  const eventId = uuid(500);
  now = BASE_MS + 1_000;
  await service.reportWatchObservation(watch, eventId, {
    schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT",
    fallDetectedAt: atMs(now), patientPositionObservedAt: atMs(now),
    fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
    patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10 }
  } as never);
  const offered = (device: DevicePrincipal) => store.read(state => Object.values(state.deliveries)
    .find(row => row.eventId === eventId && row.deviceInstanceId === device.deviceInstanceId
      && (row.status === "SENT" || row.status === "DELIVERED")));
  const acceptIfOffered = async (device: DevicePrincipal): Promise<boolean> => {
    const delivery = offered(device);
    if (!delivery) return false;
    now += 100;
    await service.respond(device, eventId, delivery.id, { decision: "ACCEPT", decidedAt: atMs(now) });
    return true;
  };
  await acceptIfOffered(otherResponder);
  // The recruitment circle expands on a schedule, and an offer lives 30 seconds, so
  // the farther responder is accepted the moment they are offered.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await acceptIfOffered(aedResponder)) break;
    now += 31_000;
    await service.tick();
  }
  const assignment = store.read(state => Object.values(state.assignments)
    .find(row => row.eventId === eventId && row.role === "FETCH_AED"));
  assert.ok(assignment, "the event must produce an AED task");
  return {
    service, store, eventId, patient, aedResponder, otherResponder,
    assignmentId: assignment.id,
    setNow(milliseconds: number) { now = milliseconds; }
  };
}

test("service: a pending proposal is readable by its own device, notified once, and expires", async () => {
  const harness = await rerouteServiceHarness();
  const { store, eventId } = harness;
  const responder = store.read(state => state.assignments[harness.assignmentId]!.deviceInstanceId)
    === harness.aedResponder.deviceInstanceId ? harness.aedResponder : harness.otherResponder;
  const other = responder === harness.aedResponder ? harness.otherResponder : harness.aedResponder;

  // Compare routes from the current fix even if the saved distance is stale.
  await store.transact(state => {
    const row = state.assignments[harness.assignmentId]!;
    row.status = "EN_ROUTE";
    state.aeds = state.aeds.map(aed => aed.id === row.route!.aedId
      ? { ...aed, aedPosition: { ...aed.aedPosition, longitude: 113.55 } } : aed);
    row.route = { ...row.route!, distanceMeters: 1 }; // stale snapshot must not drive selection
  });
  harness.setNow(BASE_MS + 2_000);
  await harness.service.updateResponderPosition(responder, {
    positionUpdateId: uuid(12), observedAt: atMs(BASE_MS + 2_000),
    responderPosition: { kind: "R", latitude: 22.2095, longitude: 113.5439, accuracyMeters: 10 }
  });

  const proposed = await harness.service.proposeAedReroute(responder, eventId, harness.assignmentId);
  assert.equal(proposed.toAedId, "aed-mid");
  assert.equal(proposed.distanceSavingMeters > 0, true);

  // Discoverable by the addressed device, invisible to everyone else.
  const mine = harness.service.pendingAedReroute(responder, eventId);
  assert.ok(mine.proposal, "the responder must be able to read the question");
  assert.equal(mine.proposal!.proposalId, proposed.proposalId);
  assert.equal(mine.proposal!.toAedId, "aed-mid");
  assert.equal(harness.service.pendingAedReroute(other, eventId).proposal, null,
    "a proposal is addressed to one device, not broadcast to the team");

  // The prompt is durable and opaque: an id and a deadline, never a route.
  const prompts = Object.values(store.read(state => state.notificationOutboxById))
    .filter(row => row.name === "assignment:reroute-proposed");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.recipient.deviceInstanceId, responder.deviceInstanceId);
  assert.deepEqual(Object.keys(prompts[0]!.payload).sort(),
    ["assignmentId", "eventId", "expiresAt", "messageId", "occurredAt", "proposalId", "schemaVersion"]);
  assert.equal(JSON.stringify(prompts[0]!.payload).includes("22.19"), false,
    "a push prompt carries no coordinate");

  // Answering inside the window moves the task, and then there is nothing pending.
  harness.setNow(BASE_MS + 4_000);
  const decision = await harness.service.decideAedReroute(responder, eventId, proposed.proposalId, {
    accept: true, decidedAt: atMs(BASE_MS + 4_000),
    responderPosition: { kind: "R", latitude: 22.2095, longitude: 113.5439, accuracyMeters: 10 }
  });
  assert.equal(decision.status, "ACCEPTED");
  assert.equal(store.read(state => state.assignments[harness.assignmentId]!.route!.aedId), "aed-mid");
  assert.equal(harness.service.pendingAedReroute(responder, eventId).proposal, null,
    "an answered proposal is no longer pending");

  // The read path hides a proposal whose 15 seconds have passed, without needing a
  // sweep to have run: a client asking late must keep its original task.  Both rows
  // are seeded directly, because the point here is the FILTER, not the proposal.
  // A fresh snapshot rather than the accepted row: a decided proposal carries a
  // `decidedAt`, and the store validator correctly refuses a PENDING row with one.
  const base = { ...store.read(state => state.rerouteProposalsById[proposed.proposalId]!),
    status: "PENDING" as const };
  delete (base as { decidedAt?: string }).decidedAt;
  await transactState(store, state => {
    state.rerouteProposalsById["expired-proposal"] = {
      ...base, proposalId: "expired-proposal", status: "PENDING",
      proposedAt: atMs(BASE_MS + 5_000), expiresAt: atMs(BASE_MS + 6_000)
    };
    state.rerouteProposalsById["live-proposal"] = {
      ...base, proposalId: "live-proposal", status: "PENDING",
      proposedAt: atMs(BASE_MS + 20_000), expiresAt: atMs(BASE_MS + 35_000)
    };
  });
  harness.setNow(BASE_MS + 21_000);
  const filtered = harness.service.pendingAedReroute(responder, eventId);
  assert.equal(filtered.proposal?.proposalId, "live-proposal",
    "the newest unexpired proposal is the pending one");
  assert.equal(harness.service.pendingAedReroute(other, eventId).proposal, null,
    "and it is still invisible to another device");
  harness.setNow(BASE_MS + 36_000);
  assert.equal(harness.service.pendingAedReroute(responder, eventId).proposal, null,
    "once the window closes the question is gone and the task stands");
  assert.equal(store.read(state => state.assignments[harness.assignmentId]!.route!.aedId), "aed-mid",
    "an unanswered proposal never moves the task");
});


test("legacy ETA-only proposals cannot replace the current task", () => {
  const { view, proposal } = world();
  delete (proposal as Partial<RerouteProposalRecord>).distanceSavingMeters;
  assert.deepEqual(decideReroute(view, { proposalId: proposal.proposalId, deviceInstanceId: "device-1",
    accept: true, decidedAt: LATER }), { status: "REFUSED", reason: "PROPOSAL_EXPIRED" });
  assert.equal(view.assignment("assignment-1")!.route!.aedId, "aed-original");
});
