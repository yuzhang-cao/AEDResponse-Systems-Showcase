/**
 * G11 — encrypted cold sealing.
 *
 * "SEALED" used to be a label on the event row: the raw evidence stayed in the
 * online SQLite file, so the 30-day promise was a marker rather than a boundary.
 * This module makes it real.  When an event is sealed its evidence is serialised,
 * encrypted and written to a separate container file, and the online rows are
 * removed; the container can only be read with the deployment's seal key.
 *
 * The format is deliberately boring and self-describing, because a container that
 * cannot be read in three years is the same as data loss:
 *
 *   header  | magic, version, chunk size, chunk count, total plaintext length
 *   chunks  | 12-byte nonce | ciphertext | 16-byte GCM tag, per chunk
 *   trailer | SHA-256 of every chunk ciphertext, in order
 *
 * Why chunked: a single GCM message would have to be held in memory whole, and a
 * single flipped bit would make the entire event unrecoverable.  With fixed-size
 * chunks, corruption is detected per chunk — and, because the trailer hashes the
 * ciphertexts in order, a swapped or truncated chunk is detected too, not just a
 * modified one.
 *
 * Key handling: the key is a separate 0600 file, never part of the database
 * backup by accident and never logged.  `readSealKey` refuses a world-readable
 * file, because a seal key that anyone on the host can read is not a boundary.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SEAL_CONTAINER_MAGIC = "AEDSEAL1";
export const SEAL_CHUNK_SIZE = 64 * 1024;
const NONCE_BYTES = 12;
/** GCM authentication tag per chunk. */
const TAG_BYTES = 16;
/** SHA-256 trailer over every chunk ciphertext. */
const TRAILER_BYTES = 32;
const KEY_BYTES = 32;

export interface SealContainerHeader {
  magic: string;
  version: 1;
  chunkSize: number;
  chunkCount: number;
  plaintextBytes: number;
  /** Event this container belongs to, so a swapped file is detectable. */
  eventId: string;
  sealedAt: string;
  /**
   * Fingerprint of the key this container was sealed with.
   *
   * Present so a key rotation can be operated: without it, reading with the wrong
   * key is indistinguishable from a damaged container, and an operator cannot tell
   * "fetch the old key" from "restore from backup".  Optional on read because
   * containers written before this field existed must stay readable.
   */
  keyFingerprint?: string;
}

/** Short, stable fingerprint of a seal key.  Not a secret: 8 bytes of SHA-256. */
export function sealKeyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export interface SealResult {
  path: string;
  header: SealContainerHeader;
  bytes: number;
}

export type SealReadFailure =
  | "MISSING"
  | "UNREADABLE_KEY"
  | "TRUNCATED"
  | "BAD_MAGIC"
  | "UNSUPPORTED_VERSION"
  | "CORRUPT_CHUNK"
  | "CHUNK_ORDER_MISMATCH"
  | "EVENT_MISMATCH"
  /** The container names a different seal key: fetch it, do not restore. */
  | "WRONG_KEY";

export type SealReadResult =
  | { ok: true; plaintext: Buffer; header: SealContainerHeader }
  | { ok: false; reason: SealReadFailure; detail?: string };

/** Deterministic serialisation: the same evidence always yields the same bytes. */
export function serialiseSealedEvidence(input: {
  eventId: string;
  /** Already-purgeable entity records, keyed by collection. */
  collections: Record<string, Record<string, unknown>>;
  sealedAt: string;
}): Buffer {
  const canonical: Record<string, unknown> = {
    schemaVersion: "sealed-1",
    eventId: input.eventId,
    sealedAt: input.sealedAt,
    collections: Object.fromEntries(
      Object.entries(input.collections)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([collection, records]) => [
          collection,
          Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)))
        ])
    )
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

function chunkTag(key: Buffer, chunks: readonly Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest();
}

/**
 * Encrypts evidence into a container.
 *
 * The caller supplies the destination path; the key is passed in rather than read
 * here, so a caller cannot accidentally seal under a different key than the one
 * it recorded.
 */
export async function writeSealedContainer(input: {
  path: string;
  key: Buffer;
  eventId: string;
  plaintext: Buffer;
  sealedAt: string;
  chunkSize?: number;
}): Promise<SealResult> {
  if (input.key.length !== KEY_BYTES) throw new Error("Seal key must be 32 bytes");
  const chunkSize = input.chunkSize ?? SEAL_CHUNK_SIZE;
  if (chunkSize < 1024 || chunkSize > 4 * 1024 * 1024) {
    throw new Error("Seal chunk size must be between 1 KiB and 4 MiB");
  }
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < Math.max(input.plaintext.length, 1); offset += chunkSize) {
    const slice = input.plaintext.subarray(offset, Math.min(offset + chunkSize, input.plaintext.length));
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(slice), cipher.final()]);
    chunks.push(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
  }
  const header: SealContainerHeader = {
    magic: SEAL_CONTAINER_MAGIC,
    version: 1,
    chunkSize,
    chunkCount: chunks.length,
    plaintextBytes: input.plaintext.length,
    eventId: input.eventId,
    sealedAt: input.sealedAt,
    keyFingerprint: sealKeyFingerprint(input.key)
  };
  // No separate magic prefix: the magic is a field of the header, so the frame
  // length covers the header exactly and the reader's prefix check inspects the
  // same bytes the header occupies.
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(headerBytes.length, 0);
  const body = Buffer.concat([
    frame,
    headerBytes,
    ...chunks,
    chunkTag(input.key, chunks)
  ]);
  await mkdir(dirname(input.path), { recursive: true });
  // 0600: the container is evidence, not a public artefact.
  await writeFile(input.path, body, { mode: 0o600 });
  return { path: input.path, header, bytes: body.length };
}

/** Reads and verifies a container.  Every failure is explicit. */
export async function readSealedContainer(input: {
  path: string;
  key: Buffer;
  expectedEventId?: string;
}): Promise<SealReadResult> {
  if (input.key.length !== KEY_BYTES) {
    return { ok: false, reason: "UNREADABLE_KEY", detail: "key must be 32 bytes" };
  }
  let body: Buffer;
  try {
    body = await readFile(input.path);
  } catch {
    return { ok: false, reason: "MISSING" };
  }
  if (body.length < 4 + NONCE_BYTES + TAG_BYTES + TRAILER_BYTES) {
    return { ok: false, reason: "TRUNCATED" };
  }

  const headerLength = body.readUInt32BE(0);
  if (headerLength === 0 || 4 + headerLength + NONCE_BYTES + TAG_BYTES + TRAILER_BYTES > body.length) {
    // An implausible frame length means a damaged header, and that is a different
    // fact from a truncated file: report which one by looking for our header at
    // whatever offset the frame length actually claims.
    // No magic field at all means this is not one of our files (BAD_MAGIC); our
    // magic with an impossible length means our file is damaged (TRUNCATED).
    const probe = body.subarray(4, Math.min(body.length, 4096)).toString("utf8");
    const magic = /"magic"\s*:\s*"([^"]*)"/.exec(probe)?.[1];
    return {
      ok: false,
      reason: magic === SEAL_CONTAINER_MAGIC ? "TRUNCATED" : "BAD_MAGIC"
    };
  }
  // The header is JSON, so "is this one of our files?" is answered by parsing it
  // and reading the magic field.  A file that is not ours therefore reports
  // BAD_MAGIC rather than a generic parse failure.
  let header: SealContainerHeader;
  try {
    header = JSON.parse(body.subarray(4, 4 + headerLength).toString("utf8")) as SealContainerHeader;
  } catch {
    // Unparseable header: either truncation or a foreign file.  Distinguish by
    // whether the readable prefix looks like JSON at all.
    // Distinguishing "ours but damaged" from "not ours at all" needs the magic
    // FIELD, not a substring search: a corrupted magic still contains a magic-
    // shaped string, which is exactly the case that must report BAD_MAGIC.
    const head = body.subarray(4, 4 + Math.min(headerLength, 4096)).toString("utf8");
    const magicMatch = /"magic"\s*:\s*"([^"]*)"/.exec(head);
    if (!magicMatch) return { ok: false, reason: "BAD_MAGIC" };
    return {
      ok: false,
      reason: magicMatch[1] === SEAL_CONTAINER_MAGIC ? "TRUNCATED" : "BAD_MAGIC"
    };
  }
  if (header.magic !== SEAL_CONTAINER_MAGIC) return { ok: false, reason: "BAD_MAGIC" };
  if (header.version !== 1) return { ok: false, reason: "UNSUPPORTED_VERSION" };
  if (input.expectedEventId !== undefined && header.eventId !== input.expectedEventId) {
    return { ok: false, reason: "EVENT_MISMATCH", detail: `container holds ${header.eventId}` };
  }
  // Checked BEFORE any decryption: a wrong key would otherwise surface as
  // CORRUPT_CHUNK, which reads like damaged evidence and sends an operator to a
  // backup restore they do not need.
  if (header.keyFingerprint !== undefined && header.keyFingerprint !== sealKeyFingerprint(input.key)) {
    return {
      ok: false,
      reason: "WRONG_KEY",
      detail: `container was sealed with key ${header.keyFingerprint}`
    };
  }

  const chunksStart = 4 + headerLength;
  const trailerStart = body.length - TRAILER_BYTES;
  const chunksRegion = body.subarray(chunksStart, trailerStart);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < header.chunkCount; index += 1) {
    const remaining = chunksRegion.length - offset;
    if (remaining < NONCE_BYTES + TAG_BYTES) return { ok: false, reason: "TRUNCATED" };
    // Every chunk except the last is full; the last holds the remainder.  Getting
    // this wrong mis-frames the whole region and every read fails as truncated.
    const expectedPlaintext = index === header.chunkCount - 1
      ? header.plaintextBytes - (header.chunkCount - 1) * header.chunkSize
      : header.chunkSize;
    const length = NONCE_BYTES + expectedPlaintext + TAG_BYTES;
    if (length < 0 || offset + length > chunksRegion.length) {
      return { ok: false, reason: "TRUNCATED" };
    }
    // `Buffer.from` copies: `subarray` would keep a view into the WHOLE body, so
    // the trailer hash below (and any consumer) would silently see the file's
    // remaining bytes as part of this chunk.
    chunks.push(Buffer.from(chunksRegion.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset !== chunksRegion.length) {
    // Extra bytes mean the file was appended to or the header was rewritten.
    return { ok: false, reason: "TRUNCATED", detail: "unexpected trailing bytes" };
  }

  // Per-chunk authentication runs FIRST, so a damaged chunk is reported as a
  // damaged chunk.  The whole-file hash below then covers what per-chunk GCM
  // structurally cannot: reordering, because every chunk is individually valid.
  const pieces: Buffer[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const nonce = chunk.subarray(0, NONCE_BYTES);
    const tag = chunk.subarray(chunk.length - TAG_BYTES);
    const ciphertext = chunk.subarray(NONCE_BYTES, chunk.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", input.key, nonce);
      decipher.setAuthTag(tag);
      pieces.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch {
      return { ok: false, reason: "CORRUPT_CHUNK", detail: `chunk ${index}` };
    }
  }

  const expectedTag = chunkTag(input.key, chunks);
  const actualTag = body.subarray(trailerStart);
  if (!timingSafeEqual(expectedTag, actualTag)) {
    return { ok: false, reason: "CHUNK_ORDER_MISMATCH" };
  }

  return { ok: true, plaintext: Buffer.concat(pieces), header };
}

/** Creates a seal key.  Separate from the database so backups must name it. */
export function createSealKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Reads the seal key from disk, refusing a key anyone else can read.
 *
 * The permission check is the point: a 0644 key file would let any process on the
 * host decrypt the sealed layer, which makes the encryption decorative.
 */
export async function readSealKey(path: string): Promise<Buffer> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Seal key ${path} must not be readable by group or others`);
  }
  const raw = await readFile(path, "utf8");
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) throw new Error(`Seal key ${path} must decode to 32 bytes`);
  return key;
}

/** Writes a new seal key with 0600, refusing to overwrite an existing one. */
export async function writeSealKey(path: string, key: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
}

/** Default container path for one event, next to the database. */
export function sealedContainerPath(dataFile: string, eventId: string): string {
  return `${dataFile}.sealed/${eventId}.seal`;
}

/** Default key path: a sibling of the database, and part of every backup. */
export function sealKeyPath(dataFile: string): string {
  return `${dataFile}.seal-key`;
}
