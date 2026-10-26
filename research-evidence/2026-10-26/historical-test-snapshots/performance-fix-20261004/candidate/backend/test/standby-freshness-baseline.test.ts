/**
 * Standby-position freshness: CHARACTERISATION BASELINE (Phase 1 item #10, step ⑥).
 *
 * This test does NOT encode what we think the rules ought to be.  It records what
 * the implementation does today, across the role x time-point matrix, so that any
 * later change (notably making `presenceView` freshness-aware, step ⑤) shows up as
 * an explicit, reviewable diff instead of being folded into a "performance"
 * refactor.
 *
 * Frozen behaviours this baseline is expected to capture:
 *   - a standby device whose position passes the 10-minute limit loses
 *     `latestPosition` once reclamation has run;
 *   - an ACTIVE event participant keeps its position past 10 minutes (the
 *     `isActiveEventParticipant` exemption), so `presenceView` can still hand an
 *     old position back to the client;
 *   - exactly 600.000 s is still valid (the comparison is `>`, not `>=`).
 *
 * Regenerate deliberately with:
 *   AED_RECORD_BASELINE=1 npx tsx --test test/standby-freshness-baseline.test.ts
 * then review the diff before committing it.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";

const BASE_TIME = "2026-08-31T01:02:00.000Z";
const T0 = Date.parse(BASE_TIME);
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const patientPosition = { kind: "P" as const, latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12 };
const nearbyPosition = { kind: "R" as const, latitude: 22.198, longitude: 113.543, accuracyMeters: 10 };

const config = {
  ...loadConfig({}, "/tmp"),
  authSubjectPepper: "freshness-baseline-pepper",
  enableControlledTestAccounts: true
};

const TIMEPOINTS = [
  { label: "T0+9:59", offsetMs: 599_000 },
  { label: "T0+10:00", offsetMs: 600_000 },
  { label: "T0+10:00.001", offsetMs: 600_001 },
  { label: "T0+20:00", offsetMs: 1_200_000 }
] as const;

const ROLES = ["standby", "patient", "acceptedResponder", "exitedResponder"] as const;
type Role = typeof ROLES[number];

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "standby-freshness-baseline.json"
);

let sequence = 400_000;
const nextId = (): string => uuid(++sequence);

async function bootstrapIPhone(service: AEDResponseService, deviceId: string, pairId: string) {
  const result = await service.bootstrap({
    deviceInstanceId: deviceId,
    deviceKind: "IPHONE",
    companionPairId: pairId,
    agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
        kind: kind as "PATIENT", version: "2.0", acceptedAt: BASE_TIME
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, `iphone:${deviceId}`);
  return service.authenticateToken(result.sessionToken);
}

/**
 * Builds one world through the real service flows: bootstrap, position publish,
 * event creation, accept, exit and (optionally) resolution.
 */
async function buildWorld(outcome: "ACTIVE" | "RESOLVED") {
  const store = new MemoryStateStore(emptyState());
  let currentTime = new Date(T0);
  const service = new AEDResponseService(store, config, undefined, () => currentTime);

  const patientPairId = uuid(100);
  const patient = await bootstrapIPhone(service, uuid(101), patientPairId);
  const watchBootstrap = await service.bootstrap({
    deviceInstanceId: uuid(102), deviceKind: "WATCH", companionPairId: patientPairId
  }, "watch:baseline");
  const watch = service.authenticateToken(watchBootstrap.sessionToken);

  const standby = await bootstrapIPhone(service, uuid(201), uuid(301));
  const accepted = await bootstrapIPhone(service, uuid(202), uuid(302));
  const exited = await bootstrapIPhone(service, uuid(203), uuid(303));

  // Standby positions, all sampled at T0 — this is the observation the TTL acts on.
  for (const principal of [standby, accepted, exited]) {
    await service.updateResponderPosition(principal, {
      positionUpdateId: nextId(),
      responderPosition: nearbyPosition,
      observedAt: BASE_TIME
    });
  }

  const eventId = uuid(500);
  await service.reportWatchObservation(watch, eventId, {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1_000),
    patientPositionObservedAt: BASE_TIME,
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition
  } as never);

  // Patient publishes P so its device carries a position as well.
  await service.updatePatientPosition(patient, eventId, {
    positionUpdateId: nextId(),
    patientPosition,
    observedAt: BASE_TIME
  } as never);

  const deliveryFor = (deviceInstanceId: string): string | undefined =>
    store.read(state => Object.values(state.deliveries).find(delivery =>
      delivery.eventId === eventId && delivery.deviceInstanceId === deviceInstanceId)?.id);

  const acceptedDelivery = deliveryFor((accepted as { deviceInstanceId: string }).deviceInstanceId);
  const exitedDelivery = deliveryFor((exited as { deviceInstanceId: string }).deviceInstanceId);
  assert.ok(acceptedDelivery, "recruitment must have produced a delivery for the accepted responder");
  assert.ok(exitedDelivery, "recruitment must have produced a delivery for the exiting responder");

  for (const [principal, deliveryId] of [[accepted, acceptedDelivery], [exited, exitedDelivery]] as const) {
    await service.respond(principal as never, eventId, deliveryId, {
      decision: "ACCEPT", decidedAt: at(2_000)
    });
  }
  await service.exitEvent(exited as never, eventId, {
    exitId: nextId(), exitedAt: at(3_000), reason: "baseline: responder leaves"
  } as never);

  if (outcome === "RESOLVED") {
    await service.resolveEvent(patient as never, eventId, {
      resolutionId: nextId(), actor: "PATIENT", resolvedAt: at(4_000), reason: "PROBLEM_RESOLVED"
    } as never);
  }

  return {
    store,
    service,
    eventId,
    setNow: (ms: number) => { currentTime = new Date(ms); },
    principals: {
      standby, patient,
      acceptedResponder: accepted,
      exitedResponder: exited
    } as Record<Role, unknown>
  };
}

const deviceIdOf = (principal: unknown): string =>
  (principal as { deviceInstanceId: string }).deviceInstanceId;

type Observation = Record<string, unknown>;

async function observe(world: Awaited<ReturnType<typeof buildWorld>>): Promise<Record<Role, Observation>> {
  const result = {} as Record<Role, Observation>;
  for (const role of ROLES) {
    const principal = world.principals[role];
    const deviceInstanceId = deviceIdOf(principal);
    // getPresence is one of the original reclamation entry points, so this both
    // triggers the current prune and returns the client-facing projection.
    const presence = await world.service.getPresence(principal as never);
    // Rejections are behaviour too: record the status instead of failing.
    const nearby = (() => {
      try {
        return { outcome: "ok", ...world.service.getNearbyVolunteerSummary(principal as never) };
      } catch (error) {
        const problem = error as { status?: number; detail?: string };
        return { outcome: "rejected", status: problem.status ?? null, detail: problem.detail ?? null };
      }
    })();
    const events = world.service.listEvents(principal as never).map(event => ({
      state: event.state,
      viewerRelationship: event.viewerRelationship,
      positioningTier: event.positioningTier,
      pendingOffer: event.pendingResponseRequest != null,
      // Assignment/coordination are only present on participant views; record the
      // presence and status without asserting which shape appears.
      assignmentStatus: (event as { currentAssignment?: { status?: string } })
        .currentAssignment?.status ?? null,
      coordinationPresent: (event as { coordination?: unknown }).coordination != null
    }));
    const storedPosition = world.store.read(state =>
      state.devices[deviceInstanceId]?.latestPosition ?? null);
    result[role] = {
      // Raw storage: did reclamation remove the sample?
      stateLatestPositionPresent: storedPosition !== null,
      stateLatestPositionObservedAt: storedPosition?.observedAt ?? null,
      // Client-facing projection.
      viewPositionPresent: presence.position !== null,
      viewPositionObservedAt: presence.position?.observedAt ?? null,
      viewFreshness: presence.freshness,
      viewAgeSeconds: presence.ageSeconds,
      viewPositioningTier: presence.positioningTier,
      viewAvailableForResponse: presence.availableForResponse,
      nearby,
      events
    };
  }
  return result;
}

test("standby-position freshness behaves as recorded in the baseline", async () => {
  const recorded: Record<string, Record<Role, Observation>> = {};
  for (const outcome of ["ACTIVE", "RESOLVED"] as const) {
    for (const timepoint of TIMEPOINTS) {
      const world = await buildWorld(outcome);
      world.setNow(T0 + timepoint.offsetMs);
      recorded[`${outcome} @ ${timepoint.label}`] = await observe(world);
    }
  }

  if (process.env.AED_RECORD_BASELINE === "1") {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(recorded, null, 2)}\n`, "utf8");
    console.log(`recorded baseline -> ${BASELINE_PATH}`);
    return;
  }

  const expected = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as typeof recorded;
  for (const key of Object.keys(expected)) {
    assert.deepEqual(
      recorded[key],
      expected[key],
      `behaviour changed for "${key}" — if this is intentional (e.g. step ⑤), `
      + "update the baseline deliberately and review every field"
    );
  }

  // Anchor the three frozen behaviours explicitly, so a silent change to the
  // recorded file cannot hide them.
  const standbyAt20 = expected["ACTIVE @ T0+20:00"]!.standby!;
  assert.equal(standbyAt20.stateLatestPositionPresent, false,
    "a standby device past the limit must have been reclaimed");
  assert.equal(standbyAt20.viewFreshness, "UNAVAILABLE");
  const participantAt20 = expected["ACTIVE @ T0+20:00"]!.acceptedResponder!;
  assert.equal(participantAt20.stateLatestPositionPresent, true,
    "an ACTIVE participant is exempt from reclamation");
  assert.equal(participantAt20.viewPositionPresent, true,
    "an ACTIVE participant keeps a last-known position");
  assert.equal(participantAt20.viewFreshness, "STALE",
    "past the window it is a last-known position, not a current one");
  const atExactly10 = expected["ACTIVE @ T0+10:00"]!.acceptedResponder!;
  assert.equal(atExactly10.viewFreshness, "FRESH",
    "exactly 600.000 s is still FRESH (the comparison is >, not >=)");
  const past10 = expected["ACTIVE @ T0+10:00.001"]!.standby!;
  assert.equal(past10.stateLatestPositionPresent, false,
    "600.001 s must be reclaimed for a standby device");
});
