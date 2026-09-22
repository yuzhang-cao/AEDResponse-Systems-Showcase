/**
 * Expiry index for standby positions (Phase 1, item #10).
 *
 * Why this exists
 * ---------------
 * `pruneExpiredCurrentPositions()` answered "which standby positions are older
 * than the TTL?" by walking every device, and for each device it re-derived
 * whether that device is an active event participant.  That made one sweep
 * O(devices x events x deliveries) — at P20 scale roughly 4e9 delivery visits —
 * and the sweep ran on every `tick()`, i.e. on every event-list and presence read.
 *
 * The fix follows the rule this whole refactor is built on: never walk the system
 * to handle one entity.
 *
 *   - Validity is a timestamp question and stays one.  Every decision path already
 *     gates on `responderPositionSampleIsFresh()`, so deletion was never what made
 *     a position invalid — it is purely reclamation.
 *   - Expiry is therefore tracked as `expiresAt = observedAt + TTL`, and a sweep
 *     only visits devices that have actually come due.
 *
 * Structure: a binary min-heap ordered by `expiresAt`, plus a map from device to
 * the expiry currently recorded for it.  One heap entry is pushed per position
 * write; when an entry surfaces, it is compared against the map and discarded if a
 * newer write has superseded it. Identical deadlines are not reinserted, and
 * compaction bounds superseded entries even when uploads outpace expiry sweeps.
 */

export interface ExpiryEntry {
  deviceInstanceId: string;
  expiresAtMs: number;
}

/** Minimal shape this index needs from a device record. */
interface DeviceWithPosition {
  deviceInstanceId?: unknown;
  latestPosition?: { observedAt?: unknown } | undefined;
}

function expiryOf(device: DeviceWithPosition, ttlMs: number): number | undefined {
  const observedAt = device.latestPosition?.observedAt;
  if (typeof observedAt !== "string") return undefined;
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed + ttlMs;
}

export class PositionExpiryIndex {
  private heap: ExpiryEntry[] = [];
  /** Device -> expiry currently believed to be authoritative. */
  private readonly current = new Map<string, number>();

  constructor(private ttlMs: number) {}

  setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.current.size;
  }

  /** Number of heap entries, including superseded ones awaiting discard. */
  get heapSize(): number {
    return this.heap.length;
  }

  upsert(deviceInstanceId: string, expiresAtMs: number): void {
    if (!Number.isFinite(expiresAtMs)) throw new RangeError("Invalid position expiry");
    if (this.current.get(deviceInstanceId) === expiresAtMs) return;
    this.current.set(deviceInstanceId, expiresAtMs);
    this.push({ deviceInstanceId, expiresAtMs });
    this.compactIfNeeded();
  }

  remove(deviceInstanceId: string): void {
    this.current.delete(deviceInstanceId);
    this.compactIfNeeded();
  }

  clear(): void {
    this.heap = [];
    this.current.clear();
  }

  /** Full rebuild; O(devices), used once after load or a whole-state commit. */
  rebuild(devices: Record<string, DeviceWithPosition>): void {
    this.clear();
    for (const [deviceInstanceId, device] of Object.entries(devices)) {
      const expiresAtMs = expiryOf(device, this.ttlMs);
      if (expiresAtMs === undefined) continue;
      this.current.set(deviceInstanceId, expiresAtMs);
      this.heap.push({ deviceInstanceId, expiresAtMs });
    }
    this.heapify();
  }

  /**
   * Re-derives only the changed devices.  Called from the incremental commit
   * path, so maintenance cost tracks the change set rather than the device count.
   */
  applyDeviceChanges(
    changes: readonly { key: string; after: unknown }[]
  ): void {
    for (const change of changes) {
      const device = change.after as DeviceWithPosition | undefined;
      if (device === undefined) {
        this.remove(change.key);
        continue;
      }
      const expiresAtMs = expiryOf(device, this.ttlMs);
      if (expiresAtMs === undefined) this.remove(change.key);
      else this.upsert(change.key, expiresAtMs);
    }
  }

  /**
   * Removes and returns up to `limit` devices whose expiry has passed and whose
   * recorded expiry is still the authoritative one.  Superseded entries are
   * discarded in the same pass. Compaction also bounds entries not yet due.
   */
  popDue(nowMs: number, limit: number): ExpiryEntry[] {
    const due: ExpiryEntry[] = [];
    while (this.heap.length > 0 && due.length < limit) {
      const top = this.heap[0]!;
      if (top.expiresAtMs > nowMs) break;
      this.pop();
      const authoritative = this.current.get(top.deviceInstanceId);
      if (authoritative === undefined) continue;       // device no longer tracked
      if (authoritative !== top.expiresAtMs) continue; // superseded by a newer write
      if (authoritative > nowMs) continue;             // newer write not due yet
      this.current.delete(top.deviceInstanceId);
      due.push(top);
    }
    this.compactIfNeeded();
    return due;
  }

  // ---- binary min-heap ----

  private compactIfNeeded(): void {
    if (this.heap.length <= Math.max(64, this.current.size * 2)) return;
    this.heap = [...this.current].map(([deviceInstanceId, expiresAtMs]) => ({ deviceInstanceId, expiresAtMs }));
    this.heapify();
  }

  private push(entry: ExpiryEntry): void {
    const heap = this.heap;
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.expiresAtMs <= heap[index]!.expiresAtMs) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  }

  private pop(): ExpiryEntry | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left]!.expiresAtMs < heap[smallest]!.expiresAtMs) smallest = left;
        if (right < heap.length && heap[right]!.expiresAtMs < heap[smallest]!.expiresAtMs) smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index]!, heap[smallest]!];
        index = smallest;
      }
    }
    return top;
  }

  private heapify(): void {
    for (let index = (this.heap.length >> 1) - 1; index >= 0; index -= 1) {
      let current = index;
      for (;;) {
        const left = current * 2 + 1;
        const right = left + 1;
        let smallest = current;
        if (left < this.heap.length && this.heap[left]!.expiresAtMs < this.heap[smallest]!.expiresAtMs) smallest = left;
        if (right < this.heap.length && this.heap[right]!.expiresAtMs < this.heap[smallest]!.expiresAtMs) smallest = right;
        if (smallest === current) break;
        [this.heap[smallest], this.heap[current]] = [this.heap[current]!, this.heap[smallest]!];
        current = smallest;
      }
    }
  }
}
