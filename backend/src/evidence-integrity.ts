import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { EntityChange, EntityTransaction } from "./entity-transaction.js";
import type { PersistentState } from "./models.js";
import type { EntityCollection } from "./state-read.js";

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export const evidenceDigest = (value: unknown): string => createHash("sha256").update(canonicalJSON(value)).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const evidenceChangeSchema = z.object({ collection: z.string(), entityKeyHash: hex, contentHash: hex, deleted: z.boolean() }).strict();
export const evidenceLogSchema = z.object({ id: z.string(), eventId: z.string(), sequence: z.number().int().positive(),
  recordedAt: z.string().datetime(), previousHash: hex, hash: hex, changes: z.array(evidenceChangeSchema).min(1),
  kind: z.enum(["BASELINE", "TRANSACTION"]), terminal: z.boolean(), keyId: hex, signature: z.string().min(1) }).strict();
export type EvidenceLogRecord = z.infer<typeof evidenceLogSchema>;
export const evidenceHeadSchema = evidenceLogSchema.omit({ changes: true });
export type EvidenceHeadRecord = z.infer<typeof evidenceHeadSchema>;
export const evidenceProofSchema = z.object({ hash: hex, keyId: hex, signature: z.string().min(1) }).strict();
export type EvidenceProof = z.infer<typeof evidenceProofSchema>;
const GENESIS = "0".repeat(64);

export class EvidenceSigner {
  readonly publicKey: string;
  readonly keyId: string;
  constructor(private readonly privateKey: KeyObject, readonly newlyCreated = false) {
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Evidence signing requires an Ed25519 private key");
    this.publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    this.keyId = evidenceDigest(this.publicKey);
  }
  static ephemeral(): EvidenceSigner { return new EvidenceSigner(generateKeyPairSync("ed25519").privateKey, true); }
  static async open(path: string, allowCreate = true): Promise<EvidenceSigner> {
    let pem: string;
    let created = false;
    try { pem = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!allowCreate) throw new Error("Evidence signing key is missing; restore the key before opening signed data");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const generated = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      try {
        const file = await open(path, "wx", 0o600);
        created = true;
        try { await file.writeFile(generated); await file.sync(); } finally { await file.close(); }
      } catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError; }
      pem = await readFile(path, "utf8");
    }
    return new EvidenceSigner(createPrivateKey(pem), created);
  }
  signature(hash: string): string { return sign(null, Buffer.from(hash, "hex"), this.privateKey).toString("base64"); }
  proof(value: unknown): EvidenceProof { const hash = evidenceDigest(value); return { hash, keyId: this.keyId, signature: this.signature(hash) }; }
}

export function verifyProof(value: unknown, proof: EvidenceProof, trustedKeys: ReadonlyMap<string, string>): boolean {
  if (!evidenceProofSchema.safeParse(proof).success) return false;
  const key = trustedKeys.get(proof.keyId);
  try { return !!key && evidenceDigest(key) === proof.keyId && proof.hash === evidenceDigest(value)
    && verify(null, Buffer.from(proof.hash, "hex"), key, Buffer.from(proof.signature, "base64")); }
  catch { return false; }
}

export const EVIDENCE_COLLECTIONS = new Set<string>([
  "events", "deliveries", "assignments", "timelineByEventId", "aedReceiptsById", "aedUnavailableByReportId",
  "resolutionsById", "participantExitsById", "participantIntervalsById", "eventPositionBatchesById",
  "positionUpdateReceiptsById", "retentionPurgesById", "aedAssetActionsById"
]);
export function evidenceEventOf(collection: string, key: string, row: unknown): string | undefined {
  if (collection === "events" || collection === "timelineByEventId") return key;
  const value = row as { eventId?: string; canonical?: { eventId?: string } } | undefined;
  return value?.eventId ?? value?.canonical?.eventId;
}
interface EvidencePort {
  eventExists(id: string): boolean;
  terminal(id: string): boolean;
  head(id: string): EvidenceHeadRecord | undefined;
  append(row: EvidenceLogRecord): void;
}
function capture(changes: readonly EntityChange[], port: EvidencePort, signer: EvidenceSigner, now: Date,
  kind: "BASELINE" | "TRANSACTION" = "TRANSACTION"): void {
  const byEvent = new Map<string, EvidenceLogRecord["changes"]>();
  for (const change of changes) {
    if (!EVIDENCE_COLLECTIONS.has(change.collection) || isDeepStrictEqual(change.before, change.after)) continue;
    const eventId = evidenceEventOf(change.collection, change.key, change.after ?? change.before);
    if (!eventId || !port.eventExists(eventId)) continue; // A committed retention purge erases its own chain.
    const bucket = byEvent.get(eventId) ?? [];
    bucket.push({ collection: change.collection, entityKeyHash: evidenceDigest([change.collection, change.key]),
      contentHash: evidenceDigest(change.after ?? null), deleted: change.after === undefined });
    byEvent.set(eventId, bucket);
  }
  for (const [eventId, entries] of byEvent) {
    entries.sort((a, b) => a.collection.localeCompare(b.collection) || a.entityKeyHash.localeCompare(b.entityKeyHash));
    const previous = port.head(eventId);
    const body = { id: `${eventId}:${(previous?.sequence ?? 0) + 1}`, eventId, sequence: (previous?.sequence ?? 0) + 1,
      recordedAt: now.toISOString(), previousHash: previous?.hash ?? GENESIS, changes: entries,
      kind, terminal: port.terminal(eventId), keyId: signer.keyId };
    const hash = evidenceDigest(body);
    port.append({ ...body, hash, signature: signer.signature(hash) });
  }
}
export function captureTransactionEvidence(tx: EntityTransaction, signer: EvidenceSigner, now: Date): void {
  rejectUserEvidenceWrites(tx.pendingChanges());
  for (const change of tx.pendingChanges()) {
    if (change.collection !== "retentionPurgesById" || change.before !== undefined || change.after === undefined) continue;
    const record = tx.get("retentionPurgesById", change.key)!;
    const head = tx.get("eventEvidenceHeadsById", record.eventId);
    const { integrity: _integrity, ...body } = { ...record, ...(head ? { evidenceHead: head } : {}) };
    tx.set("retentionPurgesById", change.key, { ...body, integrity: signer.proof(body) });
  }
  capture(tx.pendingChanges(), {
    eventExists: id => tx.has("events", id), terminal: id => tx.get("events", id)?.state !== "ACTIVE",
    head: id => tx.get("eventEvidenceHeadsById", id),
    append: row => {
      tx.append("eventEvidenceLogById", row.id, row);
      const { changes: _changes, ...head } = row;
      tx.set("eventEvidenceHeadsById", row.eventId, head);
    }
  }, signer, now);
}
export function captureDraftEvidence(previous: Readonly<PersistentState>, next: PersistentState, signer: EvidenceSigner, now: Date,
  kind: "BASELINE" | "TRANSACTION" = "TRANSACTION"): void {
  if (kind !== "BASELINE") {
    for (const collection of ["eventEvidenceLogById", "eventEvidenceHeadsById"] as const) {
      for (const [key, after] of Object.entries(next[collection])) {
        if (!isDeepStrictEqual(after, previous[collection][key])) throw new Error("Evidence records are server-owned");
      }
    }
  }
  for (const [key, record] of Object.entries(next.retentionPurgesById)) {
    if (kind === "BASELINE" || previous.retentionPurgesById[key]) continue;
    const head = previous.eventEvidenceHeadsById[record.eventId];
    const { integrity: _integrity, ...body } = { ...record, ...(head ? { evidenceHead: head } : {}) };
    next.retentionPurgesById[key] = { ...body, integrity: signer.proof(body) };
  }
  const changes: EntityChange[] = [];
  for (const collection of EVIDENCE_COLLECTIONS) {
    const before = (previous as unknown as Record<string, Record<string, unknown>>)[collection] ?? {};
    const after = (next as unknown as Record<string, Record<string, unknown>>)[collection] ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!isDeepStrictEqual(before[key], after[key])) changes.push({ collection: collection as EntityCollection,
        key, before: before[key], after: after[key], mutationOrdinal: changes.length });
    }
  }
  capture(changes, { eventExists: id => next.events[id] !== undefined, terminal: id => next.events[id]?.state !== "ACTIVE",
    head: id => next.eventEvidenceHeadsById[id], append: row => {
      if (next.eventEvidenceLogById[row.id]) throw new Error("Evidence sequence collision");
      next.eventEvidenceLogById[row.id] = row;
      const { changes: _changes, ...head } = row;
      next.eventEvidenceHeadsById[row.eventId] = head;
    } }, signer, now, kind);
}

function rejectUserEvidenceWrites(changes: readonly EntityChange[]): void {
  if (changes.some(row => (row.collection === "eventEvidenceLogById" || row.collection === "eventEvidenceHeadsById")
    && row.after !== undefined && !isDeepStrictEqual(row.before, row.after))) throw new Error("Evidence records are server-owned");
}

/** Verification trusts an independently held public-key set, never keys embedded in database rows. */
export function verifyEvidence(rows: readonly EvidenceLogRecord[], trustedKeys: ReadonlyMap<string, string>): {
  valid: boolean; signedEntries: number; lastHash: string; reason?: string;
} {
  let previousHash = GENESIS;
  let eventId: string | undefined;
  let sequence = 0;
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    if (!evidenceLogSchema.safeParse(row).success) return { valid: false, signedEntries: sequence, lastHash: previousHash, reason: "INVALID_RECORD" };
    if ((eventId !== undefined && row.eventId !== eventId) || row.sequence !== sequence + 1 || row.previousHash !== previousHash
      || row.id !== `${row.eventId}:${row.sequence}` || (row.kind === "BASELINE" && row.sequence !== 1)) {
      return { valid: false, signedEntries: sequence, lastHash: previousHash, reason: "BROKEN_SEQUENCE" };
    }
    const { hash, signature, ...body } = row;
    const key = trustedKeys.get(row.keyId);
    let signatureValid = false;
    try { signatureValid = !!key && evidenceDigest(key) === row.keyId && verify(null, Buffer.from(hash, "hex"), key, Buffer.from(signature, "base64")); }
    catch { /* Invalid trust material is a verification failure, never an accepted record. */ }
    if (!key || evidenceDigest(body) !== hash || !signatureValid) {
      return { valid: false, signedEntries: sequence, lastHash: previousHash, reason: key ? "INVALID_SIGNATURE_OR_CONTENT" : "UNTRUSTED_KEY" };
    }
    eventId = row.eventId; previousHash = hash; sequence = row.sequence;
  }
  return { valid: true, signedEntries: sequence, lastHash: previousHash };
}

export interface EventEvidenceView {
  eventId: string;
  rows: EvidenceLogRecord[];
  head?: EvidenceHeadRecord;
  entries: { collection: string; key: string; value: unknown }[];
  invalidKeys: boolean;
}

/** One pass for startup/restore verification, instead of scanning every retained
 * collection again for every historical event. Values are read-only references. */
export function indexEvidence(state: Readonly<PersistentState>): Map<string, EventEvidenceView> {
  const views = new Map<string, EventEvidenceView>();
  const view = (eventId: string): EventEvidenceView => {
    let current = views.get(eventId);
    if (!current) { current = { eventId, rows: [], entries: [], invalidKeys: false }; views.set(eventId, current); }
    return current;
  };
  for (const [key, head] of Object.entries(state.eventEvidenceHeadsById)) {
    const group = view(key); group.head = head;
    if (head.eventId !== key) group.invalidKeys = true;
  }
  for (const [key, row] of Object.entries(state.eventEvidenceLogById)) {
    const group = view(row.eventId); group.rows.push(row);
    if (key !== row.id) group.invalidKeys = true;
  }
  for (const collection of EVIDENCE_COLLECTIONS) {
    for (const [key, value] of Object.entries((state as unknown as Record<string, Record<string, unknown>>)[collection] ?? {})) {
      const eventId = evidenceEventOf(collection, key, value);
      if (eventId) view(eventId).entries.push({ collection, key, value });
    }
  }
  return views;
}

export function verifyEvidenceView(view: EventEvidenceView, trustedKeys: ReadonlyMap<string, string>,
  expectedHead?: EvidenceHeadRecord): ReturnType<typeof verifyEvidence> {
  const rows = [...view.rows].sort((a, b) => a.sequence - b.sequence);
  const result = verifyEvidence(rows, trustedKeys);
  if (!result.valid) return result;
  if (view.invalidKeys) return { ...result, valid: false, reason: "INVALID_STORAGE_KEY" };
  const latest = rows.at(-1);
  if (!latest) return { ...result, valid: false, reason: "UNSIGNED_EVENT" };
  const { changes: _changes, ...head } = latest;
  if (!isDeepStrictEqual(head, view.head) || (expectedHead && !isDeepStrictEqual(expectedHead, head))) {
    return { ...result, valid: false, reason: "HEAD_MISMATCH" };
  }
  const expected = new Map<string, EvidenceLogRecord["changes"][number]>();
  for (const row of rows) for (const change of row.changes) expected.set(change.entityKeyHash, change);
  for (const { collection, key, value } of view.entries) {
    const keyHash = evidenceDigest([collection, key]);
    const change = expected.get(keyHash);
    if (!change || change.deleted || change.contentHash !== evidenceDigest(value)) return { ...result, valid: false, reason: "DATA_MISMATCH" };
    expected.delete(keyHash);
  }
  if ([...expected.values()].some(change => !change.deleted)) return { ...result, valid: false, reason: "MISSING_DATA" };
  return result;
}

/** An independently retained expected head detects rollback of a valid suffix.
 * Kept outside the hot request path; callers verifying many events use the index. */
export function verifyEvidenceSnapshot(state: Readonly<PersistentState>, eventId: string,
  trustedKeys: ReadonlyMap<string, string>, expectedHead?: EvidenceHeadRecord): ReturnType<typeof verifyEvidence> {
  const view = indexEvidence(state).get(eventId) ?? { eventId, rows: [], entries: [], invalidKeys: false };
  return verifyEvidenceView(view, trustedKeys, expectedHead);
}
