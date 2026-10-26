/**
 * G15 — the minimum controlled operating capability: answer a question about an
 * event, and freeze one under a lawful hold, without reading personal data.
 *
 * Two failures are being prevented at once:
 *
 *   - an operator who cannot answer "what happened in this event?" without opening
 *     the patient's precise positions will eventually do exactly that;
 *   - a legal hold that exists only as a function in the code is not a legal hold,
 *     because nobody can place one when it is needed.
 *
 * The tests therefore assert both the capability and its limits: the status is
 * anonymous by construction (and says which classes it withheld), and the hold is
 * operator-only, reason-carrying, per event, and actually stops retention.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createBackend } from "../src/server.js";
import { SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";

const BASE = Date.parse("2026-09-13T00:00:00.000Z");
const at = (seconds: number): string => new Date(BASE + seconds * 1_000).toISOString();
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const OPERATOR_TOKEN = "ops-event-status-token";

test("ops event status: an operator sees the facts and none of the people", async () => {
  setShadowValidationEnabled(false);
  const directory = await mkdtemp(join(tmpdir(), "aed-ops-event-"));
  const dataFile = join(directory, "state.sqlite");
  const store = await SQLiteStateStore.open(dataFile, []);
  const config = {
    ...loadConfig({}), host: "127.0.0.1", port: 0, production: false, dataFile,
    operatorToken: OPERATOR_TOKEN, bootstrapLimitPerMinute: 1_000,
    sessionTtlSeconds: 3_600, nearbyRadiusMeters: 5_000
  };
  const backend = await createBackend({ config, store, now: () => new Date(BASE) });
  try {
    const address = await backend.start();
    const origin = `http://redacted-host.invalid`;
    const operator = { authorization: `Bearer ${OPERATOR_TOKEN}` };
    // Build a real event with an accepted responder.
    const bootstrap = async (deviceId: number, kind: "IPHONE" | "WATCH", pairId: number) => {
      const session = await backend.service.bootstrap({
        deviceInstanceId: uuid(deviceId), deviceKind: kind, companionPairId: uuid(pairId),
        ...(kind === "IPHONE" ? {
          agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
            "SENSITIVE_PERSONAL_INFORMATION"].map(agreement => ({
              kind: agreement, version: "2.0", acceptedAt: at(0)
            })),
          capabilities: { notificationAuthorized: true, locationAuthorized: true },
          availableForResponse: true
        } : {})
      } as never, `synthetic:${deviceId}`);
      const principal = backend.service.authenticateToken(session.sessionToken);
      assert.equal(principal.kind, "DEVICE");
      return principal;
    };
    const patient = await bootstrap(2, "IPHONE", 1);
    const watch = await bootstrap(3, "WATCH", 1);
    const responder = await bootstrap(4, "IPHONE", 5);
    await backend.service.updateResponderPosition(responder, {
      positionUpdateId: uuid(6), observedAt: at(0),
      responderPosition: { kind: "R", latitude: 22.2009, longitude: 113.5439, accuracyMeters: 10 }
    });
    const eventId = uuid(500);
    await backend.service.reportWatchObservation(watch, eventId, {
      schemaVersion: "2.0", eventId, observationKind: "FALL_CONTEXT",
      fallDetectedAt: at(1), patientPositionObservedAt: at(0),
      fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22.1987654, longitude: 113.5439123, accuracyMeters: 10 }
    } as never);
    const delivery = store.read(state => Object.values(state.deliveries)
      .find(row => row.eventId === eventId && row.deviceInstanceId === responder.deviceInstanceId));
    assert.ok(delivery);
    await backend.service.respond(responder, eventId, delivery.id, {
      decision: "ACCEPT", decidedAt: at(2)
    });

    // A business session cannot read the operator status.
    const phoneSession = await backend.service.bootstrap({
      deviceInstanceId: uuid(7), deviceKind: "IPHONE", companionPairId: uuid(8),
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(agreement => ({
          kind: agreement, version: "2.0", acceptedAt: at(0)
        })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: false
    } as never, "synthetic:7");
    const refused = await fetch(`${origin}/api/v2/ops/events/${eventId}/status`, {
      headers: { authorization: `Bearer ${phoneSession.sessionToken}` }
    });
    assert.equal(refused.status, 403);

    const response = await fetch(`${origin}/api/v2/ops/events/${eventId}/status`, { headers: operator });
    assert.equal(response.status, 200);
    const status = await response.json() as {
      state: string; retention: { tier: string; legalHold: unknown; hasColdCopy: boolean };
      counts: Record<string, number | undefined>; redactions: string[];
    };
    assert.equal(status.state, "ACTIVE");
    assert.equal(status.retention.tier, "ONLINE");
    assert.equal(status.retention.legalHold, null);
    assert.equal(status.counts.acceptedResponders, 1);
    assert.equal((status.counts.positionBatches ?? 0) >= 0, true);
    assert.deepEqual(status.redactions.length > 0, true,
      "the response states which classes it withheld instead of leaving it implicit");
    // The anonymity is asserted against the raw body, with values unique to this test.
    const raw = JSON.stringify(status);
    for (const secret of [
      uuid(4), uuid(2), "22.1987654", "113.5439123", "22.2009", "signal-aed", "aed-demo"
    ]) {
      assert.equal(raw.includes(secret), false, `the status leaked ${secret}`);
    }

    // End the event first: retention only ever acts on terminal events, so a hold
    // that is never tested against a due purge would prove nothing.
    await backend.service.endEvent(patient, eventId, {
      resolutionId: uuid(700), reason: "PROBLEM_RESOLVED", endedAt: at(10)
    });
    const terminal = await fetch(`${origin}/api/v2/ops/events/${eventId}/status`, { headers: operator });
    const terminalStatus = await terminal.json() as { state: string; counts: Record<string, number | undefined> };
    assert.equal(terminalStatus.state, "RESOLVED");
    assert.equal(terminalStatus.counts.acceptedResponders, 1);
    assert.equal((terminalStatus.counts.timelineEntries ?? 0) > 0, true);

    // A legal hold is placed through HTTP, with its basis, and stops retention.
    const placed = await fetch(`${origin}/api/v2/ops/events/${eventId}/legal-hold`, {
      method: "POST", headers: { ...operator, "content-type": "application/json" },
      body: JSON.stringify({ authority: "court-order-2026-0042", reason: "litigation hold requested" })
    });
    assert.equal(placed.status, 201);
    const held = await fetch(`${origin}/api/v2/ops/events/${eventId}/status`, { headers: operator });
    const heldStatus = await held.json() as {
      retention: { legalHold: { authority: string; releasedAt?: string } | null };
    };
    assert.equal(heldStatus.retention.legalHold?.authority, "court-order-2026-0042");
    // The hold freezes both boundaries, which is what "lawful freeze" has to mean.
    const overdue = new Date(BASE + 400 * 24 * 60 * 60 * 1_000);
    const frozen = await backend.service.runRetention(overdue);
    assert.deepEqual(frozen.sealed, []);
    assert.deepEqual(frozen.purged, []);
    assert.equal(store.read(state => state.events[eventId]!.retention!.legalHold!.authority),
      "court-order-2026-0042");

    // A reason is required: a hold without a stated basis is not auditable.
    const noReason = await fetch(`${origin}/api/v2/ops/events/${eventId}/legal-hold/release`, {
      method: "POST", headers: { ...operator, "content-type": "application/json" },
      body: JSON.stringify({ authority: "court-order-2026-0042", reason: "x" })
    });
    assert.equal(noReason.status, 400);
    // Releasing keeps the clock running: the next sweep catches up rather than restarting.
    const released = await fetch(`${origin}/api/v2/ops/events/${eventId}/legal-hold/release`, {
      method: "POST", headers: { ...operator, "content-type": "application/json" },
      body: JSON.stringify({ authority: "court-order-2026-0042", reason: "hold lifted by counsel" })
    });
    assert.equal(released.status, 200);
    const afterRelease = await backend.service.runRetention(overdue);
    assert.deepEqual(afterRelease.sealed, [eventId],
      "an overdue event catches up after the hold is released");
  } finally {
    await backend.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
