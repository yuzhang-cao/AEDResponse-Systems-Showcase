import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { EvidenceSigner, evidenceDigest, verifyEvidence, verifyEvidenceSnapshot, verifyProof } from "../src/evidence-integrity.js";
import { runRetentionSweep } from "../src/retention.js";
import { initializeEvidence } from "../src/evidence-startup.js";
import { emptyState, type EventRecord, type PersistentState } from "../src/models.js";
import { MemoryStateStore, SQLiteStateStore, type StateStore, setShadowValidationEnabled } from "../src/store.js";
import { registerStateQueries, transactState } from "../src/incremental-state.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const EVENT = "REDACTED-ID-0108";
const AT = "2026-09-13T00:00:00.000Z";
const clock = () => new Date(AT);
function event(): EventRecord {
  return { id: EVENT, patientDeviceIds: ["patient"], patientUserId: "user-patient", patientPairId: "pair-patient",
    state: "ACTIVE", recruitmentState: "RECRUITING", currentRecruitmentRadiusMeters: 1000,
    recruitmentStageStartedAt: AT, coordinationRevision: 1, assignmentRevision: 0, unavailableAedIds: [], exitedResponderUserIds: [], createdAt: AT,
    triggerSource: "WATCH_FALL_HELP_CONFIRMED", observationFingerprint: "fixture",
    observation: { schemaVersion: "2.0", eventId: EVENT, observationKind: "FALL_CONTEXT", fallDetectedAt: AT,
      patientPositionObservedAt: AT, fallResolution: "UNRESPONSIVE", appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 0, longitude: 0, accuracyMeters: 10 } } } as EventRecord;
}

for (const kind of ["Memory", "SQLite"] as const) test(`${kind}: signed transactions verify data, rollback, replay and terminal manifest`, async () => {
  setShadowValidationEnabled(false);
  const dir = await mkdtemp(join(tmpdir(), "aed-evidence-"));
  const path = join(dir, "state.sqlite");
  const store: StateStore = kind === "Memory" ? new MemoryStateStore(emptyState()) : await SQLiteStateStore.open(path, []);
  const signer = EvidenceSigner.ephemeral();
  const trust = new Map([[signer.keyId, signer.publicKey]]);
  try {
    registerStateQueries(store);
    await initializeEvidence(store, signer, clock);
    await transactState(store, state => { state.events[EVENT] = event(); });
    resetMetrics();
    await transactState(store, state => { state.timelineByEventId[EVENT] = [{ id: "entry-1", eventId: EVENT,
      occurredAt: AT, kind: "EVENT_UPDATED", message: "synthetic evidence" } as never]; });
    assert.equal(snapshotMetrics().totalFullStateClones, 0);
    assert.equal(snapshotMetrics().operation.stateFullCollectionKeyVisits, 0);
    const before = store.read(s => s);
    await assert.rejects(transactState(store, state => { state.events[EVENT]!.coordinationRevision++; throw new Error("abort"); }), /abort/);
    assert.deepEqual(store.read(s => s), before);
    await transactState(store, state => { state.events[EVENT]!.coordinationRevision = 1; });
    assert.deepEqual(store.read(s => s.eventEvidenceLogById), before.eventEvidenceLogById, "idempotent replay adds no signature");
    await transactState(store, state => { const row = state.events[EVENT]!; row.state = "RESOLVED"; row.resolvedAt = AT;
      row.retention = { tier: "ONLINE", clockStartedAt: AT }; });
    const signed = store.read(s => s);
    assert.equal(signed.eventEvidenceHeadsById[EVENT]!.terminal, true);
    assert.equal(signed.eventEvidenceHeadsById[EVENT]!.sequence, 3);
    assert.equal(verifyEvidenceSnapshot(signed, EVENT, trust).valid, true);
    assert.equal(verifyEvidence(Object.values(signed.eventEvidenceLogById), new Map()).valid, false);
    for (const alter of [
      (s: PersistentState) => { s.events[EVENT]!.patientUserId = "tampered"; },
      (s: PersistentState) => { delete s.timelineByEventId[EVENT]; },
      (s: PersistentState) => { delete s.eventEvidenceLogById[`${EVENT}:2`]; },
      (s: PersistentState) => { s.eventEvidenceLogById[`${EVENT}:3`]!.recordedAt = "2026-09-14T00:00:00.000Z"; }
    ]) { const tampered = structuredClone(signed); alter(tampered); assert.equal(verifyEvidenceSnapshot(tampered, EVENT, trust).valid, false); }
    const rolledBack = structuredClone(before);
    assert.equal(verifyEvidenceSnapshot(rolledBack, EVENT, trust, signed.eventEvidenceHeadsById[EVENT]).reason, "HEAD_MISMATCH");
    await assert.rejects(transactState(store, state => { delete state.eventEvidenceHeadsById[EVENT]; }), /cannot rewind or disappear/);
    await assert.rejects(transactState(store, state => { state.eventEvidenceHeadsById[EVENT] = before.eventEvidenceHeadsById[EVENT]!; }), /server-owned/);
    await assert.rejects(transactState(store, state => { delete state.eventEvidenceLogById[`${EVENT}:1`]; }), /immutable/);
    if (kind === "SQLite") {
      const reopened = await SQLiteStateStore.open(path, []);
      try { await initializeEvidence(reopened, signer, clock); assert.equal(verifyEvidenceSnapshot(reopened.read(s => s), EVENT, trust).valid, true); }
      finally { await reopened.close(); }
    }
  } finally { await store.close?.(); await rm(dir, { recursive: true, force: true }); }
});

test("evidence: unsigned legacy data receives a dated baseline, trust rotation keeps old signatures verifiable", async () => {
  const initial = emptyState(); initial.events[EVENT] = event();
  const store = new MemoryStateStore(initial);
  const first = EvidenceSigner.ephemeral(); const next = EvidenceSigner.ephemeral();
  const trust = new Map([[first.keyId, first.publicKey], [next.keyId, next.publicKey]]);
  await initializeEvidence(store, first, clock);
  assert.equal(store.read(s => s.eventEvidenceLogById[`${EVENT}:1`]!.kind), "BASELINE");
  await assert.rejects(initializeEvidence(store, next, clock), /UNTRUSTED_KEY/);
  await initializeEvidence(store, next, clock, trust);
  await transactState(store, state => { state.events[EVENT]!.coordinationRevision++; });
  assert.equal(verifyEvidenceSnapshot(store.read(s => s), EVENT, trust).valid, true);
  assert.equal(store.read(s => s.eventEvidenceHeadsById[EVENT]!.keyId), next.keyId);
});

test("evidence: signing key persists with restricted mode and is never silently replaced for signed data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aed-evidence-key-")); const path = join(dir, "key.pem");
  try {
    await assert.rejects(EvidenceSigner.open(path, false), /restore the key/);
    const first = await EvidenceSigner.open(path); const next = await EvidenceSigner.open(path, false);
    assert.equal(first.keyId, next.keyId); assert.equal(first.signature(evidenceDigest("test")), next.signature(evidenceDigest("test")));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok((await readFile(path, "utf8")).startsWith("-----BEGIN PRIVATE KEY-----"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("evidence: SQLite commit failure does not advance the signature head or durable data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aed-evidence-rollback-")); const path = join(dir, "state.sqlite");
  const store = await SQLiteStateStore.open(path, []); const signer = EvidenceSigner.ephemeral();
  try {
    await initializeEvidence(store, signer, clock);
    await transactState(store, s => { s.events[EVENT] = event(); });
    const before = store.read(s => s);
    const internal = store as unknown as { database: Database.Database }; const db = internal.database;
    internal.database = new Proxy(db, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("VALUES ('revision', '1')")) return statement;
        return new Proxy(statement, { get(object, member) { if (member === "run") return () => { throw new Error("injected disk full"); };
          const v = Reflect.get(object, member, object); return typeof v === "function" ? v.bind(object) : v; } });
      };
      const v = Reflect.get(target, property, target); return typeof v === "function" ? v.bind(target) : v;
    } });
    try { await assert.rejects(transactState(store, s => { s.events[EVENT]!.coordinationRevision++; }), /disk full/); }
    finally { internal.database = db; }
    assert.deepEqual(store.read(s => s), before);
    const reopened = await SQLiteStateStore.open(path, []);
    try { assert.deepEqual(reopened.read(s => s), before); } finally { await reopened.close(); }
    await transactState(store, s => { s.events[EVENT]!.coordinationRevision++; });
    assert.equal(store.read(s => s.eventEvidenceHeadsById[EVENT]!.sequence), 2);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("evidence: expiry erases the chain but leaves a verifiable signed purge authorization", async () => {
  const signer = EvidenceSigner.ephemeral(); const trust = new Map([[signer.keyId, signer.publicKey]]);
  const store = new MemoryStateStore(emptyState()); registerStateQueries(store);
  await initializeEvidence(store, signer, clock);
  // A properly sealed event: the tier is only reached with a recorded encrypted
  // cold copy, and the three-year purge depends on that copy existing.
  await transactState(store, s => { s.events[EVENT] = { ...event(), state: "RESOLVED", resolvedAt: AT,
    retention: { tier: "SEALED", clockStartedAt: AT, sealedAt: AT,
      sealedContainer: { path: "/var/lib/aedresponse/state.sqlite.sealed/event.seal", bytes: 512, sealedAt: AT } } }; });
  const result = await runRetentionSweep(store, new Date("2029-09-14T00:00:00.000Z"), () => store.read(s => [s.events[EVENT]!]));
  assert.deepEqual(result.purged, [EVENT]);
  const snapshot = store.read(s => s);
  assert.equal(snapshot.events[EVENT], undefined);
  assert.equal(Object.keys(snapshot.eventEvidenceLogById).length, 0);
  assert.equal(Object.keys(snapshot.eventEvidenceHeadsById).length, 0);
  const { integrity, ...body } = snapshot.retentionPurgesById[`retention-purge:${EVENT}`]!;
  assert.ok(integrity); assert.ok(body.evidenceHead);
  assert.equal(verifyProof(body, integrity, trust), true);
  assert.equal(verifyProof({ ...body, reason: "tampered" }, integrity, trust), false);
  await initializeEvidence(store, signer, clock);
});

test("evidence: a persisted key never silently re-baselines a database with missing signatures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aed-evidence-rebaseline-"));
  try {
    const path = join(directory, "key.pem");
    const initialKey = await EvidenceSigner.open(path);
    const unsigned = emptyState(); unsigned.events[EVENT] = event();
    const first = new MemoryStateStore(unsigned); await initializeEvidence(first, initialKey, clock);
    const reopenedKey = await EvidenceSigner.open(path, false);
    const signed = first.read(s => s);
    await initializeEvidence(new MemoryStateStore(signed), reopenedKey, clock);
    await assert.rejects(initializeEvidence(new MemoryStateStore(unsigned), reopenedKey, clock), /refusing to replace missing evidence/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
