/**
 * G15 — the backup verifier is a gate, not a report.
 *
 * `verify-backup.mjs` is what stands between "a file was copied" and "this copy
 * can be restored".  Two of its checks only matter because retention now deletes
 * decrypted evidence on the strength of an encrypted cold copy: the copy set must
 * carry the containers, and the operator must hold the key that opens them.  A
 * verifier that passed a copy set missing either one would certify a restore that
 * silently loses the three-year-old evidence.
 *
 * These tests build a real SQLite state file with a real sealed container written
 * by the production writer, then run the script the way the deployment does.
 * Every failure case below is a copy set that looks complete until it is read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { transactState, registerStateQueries } from "../src/incremental-state.js";
import type { EventRecord } from "../src/models.js";
import { purgeableEvidenceForEvent } from "../src/retention.js";
import {
  createSealKey,
  sealedContainerPath,
  serialiseSealedEvidence,
  writeSealedContainer
} from "../src/sealed-store.js";
import { SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifier = `${repositoryRoot}backend/deploy/azure/verify-backup.mjs`;

void (null as unknown as EventRecord);
void (null as unknown as BackupFixture);


const EVENT = "REDACTED-ID-0108";
const AT = "2026-09-13T00:00:00.000Z";

/** The same shape the evidence tests use: a real event record, not a stub. */
function event(): EventRecord {
  return {
    id: EVENT, patientDeviceIds: ["patient"], patientUserId: "user-patient",
    patientPairId: "pair-patient", state: "ACTIVE", recruitmentState: "RECRUITING",
    currentRecruitmentRadiusMeters: 1000, recruitmentStageStartedAt: AT,
    coordinationRevision: 1, assignmentRevision: 0, unavailableAedIds: [],
    exitedResponderUserIds: [], createdAt: AT,
    triggerSource: "WATCH_FALL_HELP_CONFIRMED", observationFingerprint: "fixture",
    observation: {
      schemaVersion: "2.0", eventId: EVENT, observationKind: "FALL_CONTEXT",
      fallDetectedAt: AT, patientPositionObservedAt: AT, fallResolution: "UNRESPONSIVE",
      appHelpResponse: "NEEDS_HELP",
      patientPosition: { kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10 }
    }
  } as EventRecord;
}

interface BackupFixture {
  directory: string;
  databasePath: string;
  sealedDir: string;
  sealKeyPath: string;
  eventId: string;
  cleanup(): Promise<void>;
}

/**
 * A copy set exactly as the backup job produces it: the database, the sealed
 * container directory (ciphertext) and the 0600 seal key beside them.
 */
async function createBackupFixture(
  options: { sealKeyMode?: number } = {}
): Promise<BackupFixture> {
  setShadowValidationEnabled(false);
  const directory = await mkdtemp(join(tmpdir(), "aed-backup-verify-"));
  const databasePath = join(directory, "state-20260913T000000Z.sqlite");
  const sealedDir = `${databasePath}.sealed`;
  const sealKeyPath = `${databasePath}.seal-key`;
  const store = await SQLiteStateStore.open(databasePath, []);
  try {
    registerStateQueries(store);
    await transactState(store, state => { state.events[EVENT] = event(); });
    await transactState(store, state => {
      state.timelineByEventId[EVENT] = [{
        id: "entry-1", eventId: EVENT, occurredAt: AT, kind: "EVENT_UPDATED",
        message: "synthetic evidence"
      } as never];
    });
    // Sealed with the production writer, key and container path, so the verifier
    // reads a container the purge would actually have relied on.
    const key = createSealKey();
    const written = await writeSealedContainer({
      path: sealedContainerPath(databasePath, EVENT),
      key,
      eventId: EVENT,
      plaintext: serialiseSealedEvidence({
        eventId: EVENT,
        sealedAt: AT,
        collections: purgeableEvidenceForEvent(store, EVENT)
      }),
      sealedAt: AT
    });
    await writeFile(sealKeyPath, `${key.toString("hex")}\n`, { mode: options.sealKeyMode ?? 0o600 });
    if (options.sealKeyMode !== undefined) await chmod(sealKeyPath, options.sealKeyMode);
    await transactState(store, state => {
      const row = state.events[EVENT]!;
      row.state = "RESOLVED";
      row.resolvedAt = AT;
      row.retention = {
        tier: "SEALED", clockStartedAt: AT, sealedAt: AT,
        sealedContainer: { path: written.path, bytes: written.bytes, sealedAt: AT }
      };
    });
  } finally {
    await store.close();
  }
  return {
    directory, databasePath, sealedDir, sealKeyPath, eventId: EVENT,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("backup verification: a copy set with its sealed container and key passes", async () => {
  const fixture = await createBackupFixture();
  try {
    const before = await readFile(fixture.databasePath);
    const { stdout } = await run(process.execPath, [
      verifier,
      "--backup", fixture.databasePath,
      "--sealed-dir", fixture.sealedDir,
      "--seal-key", fixture.sealKeyPath
    ], { cwd: `${repositoryRoot}backend` });
    assert.match(stdout, /1 event\(s\) record an encrypted cold copy/);
    assert.match(stdout, /seal key is present, mode 600/);
    assert.match(stdout, /sealed container decrypts and matches its trailer/);
    assert.match(stdout, /backup verification passed/);
    assert.deepEqual(await readFile(fixture.databasePath), before,
      "verification must open the copy readonly and change nothing");
  } finally {
    await fixture.cleanup();
  }
});

test("backup verification: a copy set without the seal key fails", async () => {
  const fixture = await createBackupFixture();
  try {
    // The realistic drill failure: the containers were copied, the key was not.
    await rename(fixture.sealKeyPath, join(fixture.directory, "seal-key-left-behind"));
    await assert.rejects(
      run(process.execPath, [
        verifier, "--backup", fixture.databasePath, "--sealed-dir", fixture.sealedDir
      ], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /no seal key was supplied/);
        return true;
      },
      "containers without their key are ciphertext, so the check must refuse them"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("backup verification: a group-readable seal key fails", async () => {
  const fixture = await createBackupFixture({ sealKeyMode: 0o644 });
  try {
    await assert.rejects(
      run(process.execPath, [
        verifier, "--backup", fixture.databasePath, "--seal-key", fixture.sealKeyPath
      ], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /must not be readable by group or others/);
        return true;
      },
      "a key anyone on the host can read is not a boundary"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("backup verification: a wrong seal key fails instead of reporting the copy as good", async () => {
  const fixture = await createBackupFixture();
  try {
    const wrongKeyPath = join(fixture.directory, "wrong.seal-key");
    // A different, valid-looking 32-byte key: the honest wrong-key case.
    await writeFile(wrongKeyPath, `${"ab".repeat(32)}\n`, { mode: 0o600 });
    await assert.rejects(
      run(process.execPath, [
        verifier,
        "--backup", fixture.databasePath,
        "--sealed-dir", fixture.sealedDir,
        "--seal-key", wrongKeyPath
      ], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /sealed container unreadable/);
        return true;
      },
      "the container must actually be decrypted, not merely present"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("backup verification: a truncated sealed container fails on the recorded size", async () => {
  const fixture = await createBackupFixture();
  try {
    const container = join(fixture.sealedDir, `${fixture.eventId}.seal`);
    const whole = await readFile(container);
    await writeFile(container, whole.subarray(0, whole.length - 8));
    await assert.rejects(
      run(process.execPath, [
        verifier,
        "--backup", fixture.databasePath,
        "--sealed-dir", fixture.sealedDir,
        "--seal-key", fixture.sealKeyPath
      ], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /does not match the recorded/);
        return true;
      },
      "a container that shrank is not the copy the purge relied on"
    );
  } finally {
    await fixture.cleanup();
  }
});

test("backup verification: a copy set missing the container fails", async () => {
  const fixture = await createBackupFixture();
  try {
    const container = join(fixture.sealedDir, `${fixture.eventId}.seal`);
    // Move it aside rather than deleting: the recorded absolute path must not be
    // used to paper over a copy set that does not carry the container itself.
    const hidden = join(fixture.directory, "hidden.seal");
    await rename(container, hidden);
    await mkdir(join(fixture.directory, "empty-sealed"), { recursive: true });
    await assert.rejects(
      run(process.execPath, [
        verifier,
        "--backup", fixture.databasePath,
        "--sealed-dir", join(fixture.directory, "empty-sealed"),
        "--seal-key", fixture.sealKeyPath
      ], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /sealed container missing from this copy set/);
        return true;
      },
      "the copy set must carry the containers, not just reference them"
    );
    assert.equal((await stat(hidden)).size > 0, true);
  } finally {
    await fixture.cleanup();
  }
});

test("backup verification: an empty or unreadable backup is refused before any of that", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aed-backup-empty-"));
  try {
    const empty = join(directory, "state-empty.sqlite");
    await writeFile(empty, "");
    await assert.rejects(
      run(process.execPath, [verifier, "--backup", empty], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /backup is empty/);
        return true;
      }
    );
    const notSqlite = join(directory, "state-not-sqlite.sqlite");
    await writeFile(notSqlite, "this is not a database");
    await chmod(notSqlite, 0o600);
    await assert.rejects(
      run(process.execPath, [verifier, "--backup", notSqlite], { cwd: `${repositoryRoot}backend` }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /not a readable SQLite database/);
        assert.doesNotMatch(failure.stderr ?? "", /at Database\.pragma/,
          "a corrupt copy must be a reported failure, not a stack trace");
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
