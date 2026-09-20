/**
 * G11 — a restored backup must not resurrect a closed account or a revoked session.
 *
 * The problem is structural, not a bug: `users.lifecycleState = CLOSED` and a
 * session's `revokedAt` live INSIDE the database, so restoring yesterday's copy
 * restores yesterday's permissions.  A backup that is faithful to the wrong
 * moment is still a security incident.
 *
 * Two independent mechanisms, because either one alone has a hole:
 *
 *   1. **The identity ledger** — an append-only file of closures and session
 *      revocations, written OUTSIDE the database.  On startup every entry is
 *      replayed into whatever state was loaded: a closure closes the account
 *      again, a revocation revokes the session again.  Replay is additive and
 *      idempotent; it never reopens anything.
 *   2. **The watermark** — the ledger's own high-water mark, kept in a second
 *      file.  If the ledger itself is older than the watermark, the whole ledger
 *      was rolled back with the database, and the service refuses to start until
 *      an operator acknowledges the restore explicitly.
 *
 * The honest boundary: if the database, the ledger AND the watermark are all
 * restored together (a whole-host image), no local mechanism can tell.  The
 * deployment therefore keeps the ledger and the watermark on storage that is not
 * part of the database backup set — see docs/backup-recovery-2026-09-13.md — and
 * this module says so in its own failure message rather than implying otherwise.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersistentState } from "./models.js";
import { stopAccountCollection } from "./account-lifecycle.js";
import { transactState } from "./incremental-state.js";
import type { StateStore } from "./store.js";

/** Ledger entries, one JSON object per line. */
export type IdentityLedgerEntry =
  | { kind: "ACCOUNT_CLOSED"; subjectId: string; userId: string; occurredAt: string }
  | { kind: "SESSION_REVOKED"; subjectId: string; userId: string; occurredAt: string }
  | { kind: "STALE_LEDGER_ACKNOWLEDGED"; subjectId: string; userId: string; occurredAt: string };

export interface IdentityLedgerReplayReport {
  /** Accounts that were ACTIVE in the loaded state and are CLOSED again. */
  accountsClosed: number;
  /** Sessions that were valid in the loaded state and are revoked again. */
  sessionsRevoked: number;
  /** Apple revocations queued again for the replayed closures. */
  appleRevocationsQueued: number;
  /** Entries the ledger itself did not have yet, appended during this pass. */
  entriesAppended: number;
}

export function identityLedgerPath(dataFile: string): string {
  return `${dataFile}.identity-ledger.jsonl`;
}

export function restoreWatermarkPath(dataFile: string): string {
  return `${dataFile}.restore-watermark.json`;
}

const entryKey = (entry: IdentityLedgerEntry): string => `${entry.kind}\u0000${entry.subjectId}`;

/**
 * Parses the ledger.
 *
 * A corrupt line is a hard failure: skipping it would silently drop a closure,
 * which is exactly the entry an attacker with file access would corrupt.
 */
export function parseIdentityLedger(text: string): IdentityLedgerEntry[] {
  const entries: IdentityLedgerEntry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Identity ledger line ${index + 1} is not valid JSON`);
    }
    const record = parsed as Partial<IdentityLedgerEntry> & { kind?: unknown };
    const kinds = ["ACCOUNT_CLOSED", "SESSION_REVOKED", "STALE_LEDGER_ACKNOWLEDGED"];
    if (typeof record.kind !== "string" || !kinds.includes(record.kind)
      || typeof record.subjectId !== "string" || record.subjectId.length === 0
      || typeof record.userId !== "string"
      || typeof record.occurredAt !== "string" || !Number.isFinite(Date.parse(record.occurredAt))) {
      throw new Error(`Identity ledger line ${index + 1} is not a recognised entry`);
    }
    entries.push(record as IdentityLedgerEntry);
  }
  return entries;
}

export interface RestoreWatermark {
  /** Number of ledger entries the deployment has durably recorded. */
  ledgerEntries: number;
  /** Latest entry time, a second monotone signal. */
  latestOccurredAt?: string;
  updatedAt: string;
  /** Restores that were acknowledged, kept forever as the audit of the decision. */
  acknowledgedStaleLedgers: { at: string; detail: string }[];
}

export function parseRestoreWatermark(text: string): RestoreWatermark {
  let parsed: Partial<RestoreWatermark>;
  try {
    parsed = JSON.parse(text) as Partial<RestoreWatermark>;
  } catch {
    // A corrupt watermark is not an absent one: treating it as absent would let a
    // rollback pass unnoticed, which is the only thing it exists to catch.
    throw new Error("Restore watermark is corrupt; refusing to trust the ledger state");
  }
  if (!Number.isSafeInteger(parsed.ledgerEntries) || (parsed.ledgerEntries as number) < 0
    || typeof parsed.updatedAt !== "string") {
    throw new Error("Restore watermark is not a recognised watermark");
  }
  return {
    ledgerEntries: parsed.ledgerEntries as number,
    ...(typeof parsed.latestOccurredAt === "string" ? { latestOccurredAt: parsed.latestOccurredAt } : {}),
    updatedAt: parsed.updatedAt,
    acknowledgedStaleLedgers: Array.isArray(parsed.acknowledgedStaleLedgers)
      ? parsed.acknowledgedStaleLedgers as { at: string; detail: string }[] : []
  };
}

export interface StaleLedgerAssessment {
  stale: boolean;
  detail?: string;
}

/**
 * Compares the ledger with its watermark.
 *
 * Equal counts are fine; fewer entries than the watermark means entries that were
 * durable are gone, which only a rollback produces.
 */
export function assessLedgerRollback(
  ledger: readonly IdentityLedgerEntry[],
  watermark: RestoreWatermark | undefined
): StaleLedgerAssessment {
  if (!watermark) return { stale: false };
  if (ledger.length < watermark.ledgerEntries) {
    return {
      stale: true,
      detail: `the ledger holds ${ledger.length} entries but ${watermark.ledgerEntries} were durable`
    };
  }
  const latest = ledger.reduce<string | undefined>((newest, entry) =>
    newest === undefined || entry.occurredAt > newest ? entry.occurredAt : newest, undefined);
  if (watermark.latestOccurredAt && latest !== undefined && latest < watermark.latestOccurredAt) {
    return {
      stale: true,
      detail: `the newest ledger entry is ${latest}, older than the durable ${watermark.latestOccurredAt}`
    };
  }
  return { stale: false };
}

/** Every closure and session revocation the loaded state knows about. */
export function deriveIdentityLedgerEntries(state: Readonly<PersistentState>): IdentityLedgerEntry[] {
  const entries: IdentityLedgerEntry[] = [];
  for (const user of Object.values(state.users)) {
    if (user.lifecycleState !== "CLOSED") continue;
    entries.push({
      kind: "ACCOUNT_CLOSED",
      subjectId: user.userId,
      userId: user.userId,
      occurredAt: user.closedAt ?? user.updatedAt
    });
  }
  for (const session of Object.values(state.sessionsByTokenHash)) {
    if (!session.revokedAt) continue;
    entries.push({
      kind: "SESSION_REVOKED",
      subjectId: session.tokenHash,
      userId: session.userId ?? "unknown",
      occurredAt: session.revokedAt
    });
  }
  return entries;
}

/**
 * Replays the ledger into the loaded state, then records what the state knows
 * that the ledger did not.
 *
 * Order matters: replay first, so a restored database is corrected before any
 * request can be served, and only then extend the ledger from the state, so the
 * ledger remains the union of both sides and the next restore is covered.
 */
export async function reconcileIdentityLedger(input: {
  store: StateStore;
  ledgerPath: string;
  watermarkPath: string;
  now: Date;
  allowStaleLedger: boolean;
}): Promise<IdentityLedgerReport> {
  const ledger = await readLedgerFile(input.ledgerPath);
  const watermark = await readWatermarkFile(input.watermarkPath);
  const assessment = assessLedgerRollback(ledger, watermark);
  if (assessment.stale && !input.allowStaleLedger) {
    throw new Error(
      `Refusing to start: the identity ledger is older than its watermark (${assessment.detail}). `
      + "Restoring an older database also restored an older ledger, so the closures and session "
      + "revocations made after that copy would be lost. Keep the ledger and its watermark OUTSIDE "
      + "the database backup set; if this restore is intended, acknowledge it explicitly "
      + "(AED_ALLOW_STALE_IDENTITY_LEDGER=1) and reconcile the closures by hand."
    );
  }
  const acknowledged = assessment.stale && input.allowStaleLedger
    ? [{
      kind: "STALE_LEDGER_ACKNOWLEDGED" as const,
      subjectId: `stale-ledger:${input.now.toISOString()}`,
      userId: "operator",
      occurredAt: input.now.toISOString()
    }]
    : [];
  const known = new Set(ledger.map(entryKey));
  const replay: IdentityLedgerReplayReport = {
    accountsClosed: 0, sessionsRevoked: 0, appleRevocationsQueued: 0, entriesAppended: 0
  };
  // One transaction for the whole replay: the service must not serve a request
  // between "the account is closed again" and "its sessions are revoked again".
  const applied = await transactState(input.store, state => {
    // Revocations first, THEN closures, whatever order the file happens to be in:
    // a closure revokes the account's whole session collection, so applying it
    // first would make every explicit revocation look like it was already done —
    // the outcome would be right and the report would say nothing happened.
    const ordered = [...ledger].sort((left, right) =>
      (left.kind === "SESSION_REVOKED" ? 0 : 1) - (right.kind === "SESSION_REVOKED" ? 0 : 1));
    for (const entry of ordered) {
      if (entry.kind === "SESSION_REVOKED") {
        const session = state.sessionsByTokenHash[entry.subjectId];
        if (!session || session.revokedAt) continue;
        session.revokedAt = entry.occurredAt;
        if (session.refreshTokenHash) session.refreshRevokedAt ??= entry.occurredAt;
        replay.sessionsRevoked += 1;
      }
      if (entry.kind === "ACCOUNT_CLOSED") {
        const user = state.users[entry.userId];
        if (!user || user.lifecycleState === "CLOSED") continue;
        user.lifecycleState = "CLOSED";
        user.closedAt = entry.occurredAt;
        user.updatedAt = entry.occurredAt;
        stopAccountCollection(state, user.userId, entry.occurredAt, "CLOSED");
        for (const account of Object.values(state.accounts)) {
          if (account.userId !== user.userId) continue;
          if (account.provider !== "APPLE" || !account.appleRefreshToken) continue;
          state.appleRevocationsById[account.accountId] = {
            accountId: account.accountId,
            userId: user.userId,
            refreshToken: account.appleRefreshToken,
            requestedAt: input.now.toISOString(),
            attempts: 0
          };
          replay.appleRevocationsQueued += 1;
        }
        const requestId = `deletion:${user.userId}`;
        state.deletionRequestsById[requestId] = state.deletionRequestsById[requestId] ?? {
          requestId,
          userId: user.userId,
          requestedAt: entry.occurredAt,
          status: "CLOSED",
          accountClosed: true,
          accountClosedAt: entry.occurredAt,
          erasureStartedAt: entry.occurredAt,
          purged: []
        };
        replay.accountsClosed += 1;
        continue;
      }
    }
    // Extend the ledger with what the state knows: a database newer than the
    // ledger (the normal case) must not lose entries on the next restore.
    const extension: IdentityLedgerEntry[] = [];
    for (const entry of deriveIdentityLedgerEntries(state)) {
      if (known.has(entryKey(entry))) continue;
      known.add(entryKey(entry));
      extension.push(entry);
    }
    return { extension, totalEntries: ledger.length + extension.length + acknowledged.length };
  });
  const appended = [...applied.extension, ...acknowledged];
  if (appended.length > 0) {
    await mkdir(dirname(input.ledgerPath), { recursive: true });
    await appendFile(input.ledgerPath, `${appended.map(entry => JSON.stringify(entry)).join("\n")}\n`,
      { mode: 0o600 });
  }
  replay.entriesAppended = applied.extension.length;
  const latest = [...ledger, ...appended].reduce<string | undefined>((newest, entry) =>
    newest === undefined || entry.occurredAt > newest ? entry.occurredAt : newest, undefined);
  await writeWatermarkFile(input.watermarkPath, {
    ledgerEntries: applied.totalEntries,
    ...(latest ? { latestOccurredAt: latest } : {}),
    updatedAt: input.now.toISOString(),
    acknowledgedStaleLedgers: [
      ...(watermark?.acknowledgedStaleLedgers ?? []),
      ...acknowledged.map(entry => ({ at: entry.occurredAt, detail: "operator acknowledged a stale ledger" }))
    ]
  });
  return { ledgerPath: input.ledgerPath, watermarkPath: input.watermarkPath, stale: assessment.stale, replay };
}

export interface IdentityLedgerReport {
  ledgerPath: string;
  watermarkPath: string;
  stale: boolean;
  replay: IdentityLedgerReplayReport;
}

/**
 * Reads the ledger, treating a missing file as an empty one.
 *
 * Any other failure (permissions, corruption) is reported: an unreadable ledger
 * is a rollback that cannot be detected, not a fresh deployment.
 */
export async function readLedgerFile(path: string): Promise<IdentityLedgerEntry[]> {
  try {
    return parseIdentityLedger(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readWatermarkFile(path: string): Promise<RestoreWatermark | undefined> {
  try {
    return parseRestoreWatermark(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeWatermarkFile(path: string, watermark: RestoreWatermark): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(watermark, null, 2)}\n`, { mode: 0o600 });
}

export { entryKey as identityLedgerEntryKey };
