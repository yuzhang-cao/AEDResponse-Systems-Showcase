/**
 * G12 — access audit, operator separation and break-glass.
 *
 * The event timeline records what happened to an event.  It cannot answer "who
 * looked at this patient's precise position, when, and why", which is what a
 * privacy review asks.  These tests cover that separate record, the rule that a
 * business operator credential is not a data-reading privilege, and the 30-minute
 * ceiling on an emergency read grant.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAK_GLASS_MAX_MINUTES,
  auditEntry,
  breakGlassAllows,
  issueBreakGlassGrant,
  requireAuditReason,
  requirePreciseDataAuthority
} from "../src/access-audit.js";
import type { BackendConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";
import type { PersistentState } from "../src/models.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "unused-memory-store.json",
  fixtureFile: "unused-in-memory-fixture.json",
  sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100,
  operatorToken: "audit-operator-token",
  production: false
};

/** A state with one event that carries a precise patient position. */
function stateWithEvent(): PersistentState {
  const state = emptyState();
  const eventId = uuid(100);
  state.events[eventId] = {
    id: eventId,
    state: "ACTIVE",
    recruitmentState: "RECRUITING",
    patientUserId: uuid(101),
    patientDeviceIds: [uuid(102)],
    patientPairId: uuid(103),
    unavailableAedIds: [],
    observationFingerprint: "audit-test",
    triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    observation: {
      schemaVersion: "2.0",
      eventId,
      observationKind: "FALL_CONTEXT",
      fallDetectedAt: BASE_TIME,
      patientPositionObservedAt: BASE_TIME,
      fallResolution: "UNRESPONSIVE",
      appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10 }
    },
    patientPosition: {
      positionUpdateId: uuid(104),
      source: "IPHONE_PRIMARY",
      observedAt: BASE_TIME,
      serverReceivedAt: BASE_TIME,
      position: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10 }
    },
    currentRecruitmentRadiusMeters: 1_000,
    recruitmentStageStartedAt: BASE_TIME,
    coordinationRevision: 1,
    assignmentRevision: 0,
    createdAt: BASE_TIME
  } as never;
  return state;
}

function harness() {
  let now = new Date(BASE_TIME);
  const store = new MemoryStateStore(stateWithEvent());
  const service = new AEDResponseService(store, config, {
    emitToDevices() { return []; }
  }, () => now);
  return {
    service,
    store,
    eventId: uuid(100),
    setNow: (seconds: number) => { now = new Date(Date.parse(BASE_TIME) + seconds * 1_000); }
  };
}

test("a reason is mandatory and cannot be whitespace", () => {
  assert.equal(requireAuditReason("  lawful request 42 "), "lawful request 42");
  assert.throws(() => requireAuditReason(""), /reason is required/);
  assert.throws(() => requireAuditReason("   "), /reason is required/);
  assert.throws(() => requireAuditReason("abc"), /reason is required/);
  assert.throws(() => requireAuditReason(undefined), /reason is required/);
  assert.throws(() => requireAuditReason("x".repeat(501)), /too long/);
});

test("break-glass is single-event and expires; the 30-minute ceiling is enforced at issue", () => {
  const grant = issueBreakGlassGrant({
    grantId: "grant-1", eventId: "event-1", issuedBy: "ops",
    reason: "regulator request", issuedAt: new Date(BASE_TIME)
  });
  assert.equal(grant.scope, "READ_ONLY");
  assert.equal(grant.expiresAt, "2026-09-05T00:30:00.000Z");

  assert.equal(breakGlassAllows(grant, "event-1", new Date("2026-09-05T00:29:59Z")).allowed, true);
  // The boundary itself is expired: an emergency read does not get a 30-minute
  // window plus however long the clock takes to tick.
  const atCeiling = breakGlassAllows(grant, "event-1", new Date("2026-09-05T00:30:00Z"));
  assert.deepEqual(atCeiling, { allowed: false, code: "GRANT_EXPIRED" });
  assert.deepEqual(breakGlassAllows(grant, "event-2", new Date(BASE_TIME)),
    { allowed: false, code: "WRONG_EVENT" });
  assert.deepEqual(breakGlassAllows(undefined, "event-1", new Date(BASE_TIME)),
    { allowed: false, code: "NO_GRANT" });

  assert.throws(() => issueBreakGlassGrant({
    grantId: "grant-2", eventId: "event-1", issuedBy: "ops", reason: "too long",
    issuedAt: new Date(BASE_TIME), minutes: BREAK_GLASS_MAX_MINUTES + 1
  }), /at most 30 minutes/);
  assert.throws(() => issueBreakGlassGrant({
    grantId: "grant-3", eventId: "event-1", issuedBy: "ops", reason: "zero",
    issuedAt: new Date(BASE_TIME), minutes: 0
  }), /at most 30 minutes/);
});

test("a plain operator credential is not a precise-data privilege", async () => {
  const h = harness();
  const operator = h.service.authenticateToken("audit-operator-token");
  assert.equal(operator.kind, "OPERATOR");

  // Without a grant the read is refused AND the refusal is audited.
  await assert.rejects(
    h.service.readEventPrecisePosition(operator, {
      eventId: h.eventId, reason: "regulator request"
    }),
    /Break-glass grant does not authorise this read/
  );
  const denials = h.store.read(state => Object.values(state.accessAuditById)
    .filter(entry => entry.outcome === "DENIED"));
  assert.equal(denials.length, 1, "被拒绝的读取同样必须留痕");
  assert.equal(denials[0]!.dataClass, "PRECISE_PATIENT_POSITION");
  assert.equal(denials[0]!.reason, "regulator request");

  // With a grant for THIS event it succeeds, and the success is audited too.
  const grant = await h.service.issueBreakGlassGrant(operator, {
    eventId: h.eventId, reason: "regulator request", minutes: 5
  });
  const position = await h.service.readEventPrecisePosition(operator, {
    eventId: h.eventId, reason: "regulator request", grantId: grant.grantId
  });
  assert.equal(position.latitude, 22.1987);
  const allowed = h.store.read(state => Object.values(state.accessAuditById)
    .filter(entry => entry.outcome === "ALLOWED"
      && entry.dataClass === "PRECISE_PATIENT_POSITION"));
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]!.grantId, grant.grantId);
  assert.equal(h.store.read(state =>
    state.breakGlassGrantsById[grant.grantId]?.usedAt !== undefined), true,
  "使用过的授权必须记录使用时间");
});

test("an expired grant stops working without any further action", async () => {
  const h = harness();
  const operator = h.service.authenticateToken("audit-operator-token");
  const grant = await h.service.issueBreakGlassGrant(operator, {
    eventId: h.eventId, reason: "on-call escalation", minutes: 1
  });
  h.setNow(61);
  await assert.rejects(
    h.service.readEventPrecisePosition(operator, {
      eventId: h.eventId, reason: "late read", grantId: grant.grantId
    }),
    /GRANT_EXPIRED/
  );
  const denials = h.store.read(state => Object.values(state.accessAuditById)
    .filter(entry => entry.outcome === "DENIED"));
  assert.equal(denials.length, 1);
});

test("a grant for another event does not open this one", async () => {
  const h = harness();
  const operator = h.service.authenticateToken("audit-operator-token");
  // A grant can only be issued FOR an existing event, so the "other" event is a
  // real one; the point of the test is that a valid grant for B does not open A.
  const otherEventId = uuid(300);
  await h.store.transact((state) => {
    const clone = structuredClone(state.events[h.eventId]!) as unknown as
      Record<string, unknown>;
    clone.id = otherEventId;
    state.events[otherEventId] = clone as never;
  });
  const other = await h.service.issueBreakGlassGrant(operator, {
    eventId: otherEventId, reason: "unrelated investigation", minutes: 5
  });
  await assert.rejects(
    h.service.readEventPrecisePosition(operator, {
      eventId: h.eventId, reason: "unrelated investigation", grantId: other.grantId
    }),
    /WRONG_EVENT/
  );
  // And it does open the event it was issued for.
  const allowed = await h.service.readEventPrecisePosition(operator, {
    eventId: otherEventId, reason: "unrelated investigation", grantId: other.grantId
  });
  assert.equal(allowed.eventId, otherEventId);
});

test("issuing a grant for an unknown event is refused", async () => {
  const h = harness();
  const operator = h.service.authenticateToken("audit-operator-token");
  await assert.rejects(
    h.service.issueBreakGlassGrant(operator, {
      eventId: uuid(999), reason: "not a real event", minutes: 5
    }),
    /Event does not exist/
  );
});

test("only an operator may issue a grant or read the audit", async () => {
  const h = harness();
  const device = {
    kind: "DEVICE" as const,
    deviceKind: "IPHONE" as const,
    deviceInstanceId: uuid(200),
    companionPairId: uuid(201),
    userId: uuid(202),
    tokenHash: "audit-device-token",
    sessionId: uuid(203),
    scopes: ["events:read"],
    expiresAt: "2026-09-06T00:00:00.000Z"
  };
  await assert.rejects(
    h.service.issueBreakGlassGrant(device, { eventId: h.eventId, reason: "device attempt" }),
    /operator credential/
  );
  await assert.rejects(
    h.service.readAccessAudit(device, {}),
    /operator credential/
  );
});

test("the audit trail never carries the data it audits", async () => {
  const h = harness();
  const operator = h.service.authenticateToken("audit-operator-token");
  const grant = await h.service.issueBreakGlassGrant(operator, {
    eventId: h.eventId, reason: "privacy review", minutes: 5
  });
  await h.service.readEventPrecisePosition(operator, {
    eventId: h.eventId, reason: "privacy review", grantId: grant.grantId
  });
  const serialized = JSON.stringify(h.store.read(state => state.accessAuditById));
  assert.equal(serialized.includes("22.19"), false, "审计日志不得包含坐标");
  assert.equal(serialized.includes("113.54"), false);
  assert.equal(serialized.includes(uuid(101)), false, "不得包含患者 userId");
  assert.match(serialized, /privacy review/, "但必须记录原因");
});

test("audit records are validated as records, not as free-form blobs", () => {
  // The validator lives in store.ts; this asserts the shape the module produces
  // matches what the store will accept on the next load.
  const entry = auditEntry({
    entryId: "e1", actor: "ops", actorKind: "OPERATOR",
    dataClass: "RETENTION", subjectId: "event-1", reason: "retention audit",
    recordedAt: BASE_TIME, outcome: "ALLOWED"
  });
  assert.deepEqual(Object.keys(entry).sort(),
    ["actor", "actorKind", "dataClass", "entryId", "outcome", "reason", "recordedAt", "subjectId"]);
});

test("requirePreciseDataAuthority is the single gate every read must call", () => {
  const grant = issueBreakGlassGrant({
    grantId: "g", eventId: "e", issuedBy: "ops", reason: "lawful basis",
    issuedAt: new Date(BASE_TIME)
  });
  assert.throws(
    () => requirePreciseDataAuthority("ACCOUNT", undefined, "e", new Date(BASE_TIME)),
    /break-glass grant/
  );
  assert.equal(
    requirePreciseDataAuthority("OPERATOR", grant, "e", new Date(BASE_TIME)).grantId, "g"
  );
});
