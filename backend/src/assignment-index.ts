/**
 * Structural indexes for the recruitment eligibility check (Phase 1 step #3).
 *
 * The predicate being answered is NOT "which assignments belong to this event".
 * It is:
 *
 *   "does this device — or any device sharing its identity — hold an assignment,
 *    on an ACTIVE event, that has not exited participation?"
 *
 * Two design rules follow from that, and both exist to avoid a *silent* wrong
 * answer rather than a slow one:
 *
 *  1. NEVER index the business state.  An index keyed by "is this device on an
 *     active assignment" bakes `event.state === "ACTIVE"` into derived data.  If a
 *     transaction flips an event from non-ACTIVE to ACTIVE, the committed index
 *     lacks those devices and the transaction did not touch the assignment, so
 *     `committed index ∪ tx.stagedKeys("assignments")` still misses it.  These
 *     indexes therefore only answer "which assignments could relate to this
 *     device?"; ACTIVE and exited-partition status are evaluated on the
 *     transaction's own view, which sees the just-changed event.
 *
 *  2. Device -> Set<assignmentId>, not device -> boolean.  A device may hold
 *     several assignments at once; ending one must not make the device look free
 *     while another is still live.  A set is also auditable in a way a count is
 *     not.
 *
 * Identity note: `deviceIdentityKey()` is `user:<userId>` once a device is bound
 * and `device:<deviceInstanceId>` before that.  Binding is one-way (a bound device
 * cannot be rebound to another account — bootstrap rejects it), so an identity can
 * change at most once, from the device form to the user form.  Callers must
 * therefore union in the transaction's staged device keys when resolving an
 * identity; see the service's `hasActiveAssignmentInTransaction`.
 */

interface AssignmentLike {
  id?: unknown;
  deviceInstanceId?: unknown;
}

interface DeviceLike {
  deviceInstanceId?: unknown;
  userId?: unknown;
}

/** Mirrors the service's `deviceIdentityKey`. */
export function identityKeyOf(device: DeviceLike | undefined): string | undefined {
  if (!device) return undefined;
  if (typeof device.userId === "string" && device.userId.length > 0) return `user:${device.userId}`;
  if (typeof device.deviceInstanceId === "string" && device.deviceInstanceId.length > 0) {
    return `device:${device.deviceInstanceId}`;
  }
  return undefined;
}

function addTo<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const bucket = map.get(key) ?? new Set<string>();
  bucket.add(value);
  map.set(key, bucket);
}

function removeFrom<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const bucket = map.get(key);
  if (!bucket) return;
  bucket.delete(value);
  if (bucket.size === 0) map.delete(key);
}

export class AssignmentIndex {
  /** assignmentId membership per device. */
  private readonly assignmentIdsByDeviceId = new Map<string, Set<string>>();
  /** device membership per identity key. */
  private readonly deviceIdsByIdentity = new Map<string, Set<string>>();
  /** The identity a device is currently filed under, so a change can be undone. */
  private readonly identityByDeviceId = new Map<string, string>();
  /** Original device-key enumeration order, independent of identity and position. */
  private readonly ordinalByDeviceId = new Map<string, number>();
  private nextDeviceOrdinal = 0;
  /** Reverse mapping, so a removal is O(1) instead of a scan over every device. */
  private readonly deviceIdByAssignmentId = new Map<string, string>();

  get assignmentCount(): number {
    let total = 0;
    for (const bucket of this.assignmentIdsByDeviceId.values()) total += bucket.size;
    return total;
  }

  get deviceCount(): number {
    return this.identityByDeviceId.size;
  }

  clear(): void {
    this.assignmentIdsByDeviceId.clear();
    this.deviceIdsByIdentity.clear();
    this.identityByDeviceId.clear();
    this.ordinalByDeviceId.clear();
    this.nextDeviceOrdinal = 0;
    this.deviceIdByAssignmentId.clear();
  }

  upsertAssignment(assignmentId: string, deviceInstanceId: string): void {
    const previous = this.deviceIdByAssignmentId.get(assignmentId);
    if (previous === deviceInstanceId) return;
    if (previous !== undefined) removeFrom(this.assignmentIdsByDeviceId, previous, assignmentId);
    addTo(this.assignmentIdsByDeviceId, deviceInstanceId, assignmentId);
    this.deviceIdByAssignmentId.set(assignmentId, deviceInstanceId);
  }

  removeAssignment(assignmentId: string): void {
    const deviceInstanceId = this.deviceIdByAssignmentId.get(assignmentId);
    if (deviceInstanceId === undefined) return;
    removeFrom(this.assignmentIdsByDeviceId, deviceInstanceId, assignmentId);
    this.deviceIdByAssignmentId.delete(assignmentId);
  }

  upsertDevice(deviceInstanceId: string, identity: string): void {
    if (!this.ordinalByDeviceId.has(deviceInstanceId)) {
      this.ordinalByDeviceId.set(deviceInstanceId, this.nextDeviceOrdinal++);
    }
    const previous = this.identityByDeviceId.get(deviceInstanceId);
    if (previous === identity) return;
    if (previous !== undefined) removeFrom(this.deviceIdsByIdentity, previous, deviceInstanceId);
    addTo(this.deviceIdsByIdentity, identity, deviceInstanceId);
    this.identityByDeviceId.set(deviceInstanceId, identity);
  }

  removeDevice(deviceInstanceId: string): void {
    const previous = this.identityByDeviceId.get(deviceInstanceId);
    if (previous !== undefined) removeFrom(this.deviceIdsByIdentity, previous, deviceInstanceId);
    this.identityByDeviceId.delete(deviceInstanceId);
    this.ordinalByDeviceId.delete(deviceInstanceId);
  }

  rebuild(state: {
    assignments?: Record<string, AssignmentLike>;
    devices?: Record<string, DeviceLike>;
  }): void {
    this.clear();
    for (const [deviceInstanceId, device] of Object.entries(state.devices ?? {})) {
      const identity = identityKeyOf(device);
      if (identity) this.upsertDevice(deviceInstanceId, identity);
    }
    for (const [assignmentId, assignment] of Object.entries(state.assignments ?? {})) {
      if (typeof assignment.deviceInstanceId === "string") {
        this.upsertAssignment(assignmentId, assignment.deviceInstanceId);
      }
    }
  }

  /**
   * Re-derives only what changed.  Both assignments and devices are accepted,
   * because identity membership depends on device fields.
   */
  applyChanges(
    assignmentChanges: readonly { key: string; after: unknown }[],
    deviceChanges: readonly { key: string; after: unknown; mutationOrdinal?: number }[]
  ): void {
    for (const change of assignmentChanges) {
      const after = change.after as AssignmentLike | undefined;
      if (after && typeof after.deviceInstanceId === "string") {
        this.upsertAssignment(change.key, after.deviceInstanceId);
      } else if (!after) {
        this.removeAssignment(change.key);
      }
    }
    // seal() sorts by key; newly created keys must retain publication order.
    const orderedDevices = [...deviceChanges].sort((left, right) =>
      (left.mutationOrdinal ?? 0) - (right.mutationOrdinal ?? 0));
    for (const change of orderedDevices) {
      const after = change.after as DeviceLike | undefined;
      const identity = identityKeyOf(after);
      if (identity) this.upsertDevice(change.key, identity);
      else this.removeDevice(change.key);
    }
  }

  assignmentIdsForDevice(deviceInstanceId: string): ReadonlySet<string> {
    return this.assignmentIdsByDeviceId.get(deviceInstanceId) ?? new Set<string>();
  }

  deviceIdsForIdentity(identity: string): ReadonlySet<string> {
    return this.deviceIdsByIdentity.get(identity) ?? new Set<string>();
  }

  /** Metadata for restoring legacy enumeration over a bounded candidate set. */
  deviceOrdinal(deviceInstanceId: string): number | undefined {
    return this.ordinalByDeviceId.get(deviceInstanceId);
  }
}
