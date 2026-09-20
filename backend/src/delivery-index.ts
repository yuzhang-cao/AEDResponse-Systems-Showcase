/**
 * Composite delivery lookups (Phase 1 step #4).
 *
 * `deliveryForDevice()` / `deliveryForUser()` answer "is there a delivery for this
 * event and this device / this user?" by scanning every delivery ever retained,
 * and they are called per candidate device — inside the recruitment loop.  That
 * makes eligibility O(candidates x all deliveries).
 *
 * UNIQUENESS INVARIANT (verified before choosing a single-valued map):
 *   - deliveries are never deleted, and there is exactly ONE creation site
 *     (`createDeliveryIfEligible`);
 *   - that site is called from exactly one place, and returns early when
 *     `deliveryForDevice(event, device)` or `deliveryForUser(event, user)` already
 *     matches, so a second delivery for the same pair cannot be created;
 *   - `eventId` and `deviceInstanceId` are never assigned after creation, so a
 *     delivery never moves between composite keys.
 * Therefore:
 *   (eventId, deviceId) -> at most one delivery
 *   (eventId, userId)   -> at most one delivery
 *
 * A violation is recorded rather than silently resolved.  If a future change
 * breaks the invariant, picking "the first one" would quietly change which offer a
 * responder is judged against; a counter makes that visible instead.
 *
 * Selection semantics: `Object.values(...).find(...)` returns the first match in
 * insertion order.  With the invariant holding there is exactly one match, so the
 * index returns the same record.
 */

interface DeliveryLike {
  id?: unknown;
  eventId?: unknown;
  deviceInstanceId?: unknown;
}

function compositeKey(eventId: string, second: string): string {
  return `${eventId}\u0000${second}`;
}

export class DeliveryIndex {
  private readonly deliveryIdByEventDevice = new Map<string, string>();
  private readonly deliveryIdByEventUser = new Map<string, string>();
  /** Reverse mapping so a removal is O(1) and does not scan the device keys. */
  private readonly eventDeviceKeyByDeliveryId = new Map<string, string>();
  private readonly eventUserKeyByDeliveryId = new Map<string, string>();
  private readonly deviceIdByDeliveryId = new Map<string, string>();
  /** Deliveries per device, so a device identity change is O(that device's deliveries). */
  private readonly deliveryIdsByDeviceId = new Map<string, Set<string>>();
  /**
   * Which deliveries belong to each event, in creation order.
   *
   * A third question, separate from the two composite lookups: those answer
   * "the delivery for this (event, device)" and "(event, user)", while this one
   * answers "which deliveries does this event have at all".  `deliveriesOfEvent`
   * asks exactly that, so the index finally has a real caller rather than being
   * built out of collection symmetry.
   *
   * Order matters and is preserved deliberately: the sweep and the legacy
   * implementation enumerate deliveries in creation order, and a bucket rebuilt by
   * sorting ids would enumerate them by random UUID instead.  Updates therefore must
   * not move an existing member - `Set.add` on a present member keeps its position,
   * so membership is only appended for deliveries this index has not seen.
   */
  private readonly deliveryIdsByEventId = new Map<string, Set<string>>();
  private readonly eventIdByDeliveryId = new Map<string, string>();
  /** Non-zero means the uniqueness invariant was violated; surfaced, never hidden. */
  private duplicateCompositeKeys = 0;

  get size(): number {
    return this.deviceIdByDeliveryId.size;
  }

  get duplicates(): number {
    return this.duplicateCompositeKeys;
  }

  clear(): void {
    this.deliveryIdByEventDevice.clear();
    this.deliveryIdByEventUser.clear();
    this.eventDeviceKeyByDeliveryId.clear();
    this.eventUserKeyByDeliveryId.clear();
    this.deviceIdByDeliveryId.clear();
    this.deliveryIdsByDeviceId.clear();
    this.deliveryIdsByEventId.clear();
    this.eventIdByDeliveryId.clear();
    this.duplicateCompositeKeys = 0;
  }

  upsert(
    deliveryId: string,
    eventId: string,
    deviceInstanceId: string,
    userId: string | undefined
  ): void {
    // An entity already filed under this event keeps its position; only a delivery
    // this index has not seen (or one that moved events, which the contract forbids)
    // is appended to the bucket.
    const previousEventId = this.eventIdByDeliveryId.get(deliveryId);
    const keepsPosition = previousEventId !== undefined && previousEventId === eventId;
    if (keepsPosition) this.removeExceptEventBucket(deliveryId);
    else this.remove(deliveryId);

    if (!keepsPosition) {
      const bucket = this.deliveryIdsByEventId.get(eventId) ?? new Set<string>();
      bucket.add(deliveryId);
      this.deliveryIdsByEventId.set(eventId, bucket);
      this.eventIdByDeliveryId.set(deliveryId, eventId);
    }
    const eventDeviceKey = compositeKey(eventId, deviceInstanceId);
    if (this.deliveryIdByEventDevice.has(eventDeviceKey)) this.duplicateCompositeKeys += 1;
    else this.deliveryIdByEventDevice.set(eventDeviceKey, deliveryId);
    this.eventDeviceKeyByDeliveryId.set(deliveryId, eventDeviceKey);
    this.deviceIdByDeliveryId.set(deliveryId, deviceInstanceId);
    const bucket = this.deliveryIdsByDeviceId.get(deviceInstanceId) ?? new Set<string>();
    bucket.add(deliveryId);
    this.deliveryIdsByDeviceId.set(deviceInstanceId, bucket);

    if (userId !== undefined) {
      const eventUserKey = compositeKey(eventId, userId);
      if (this.deliveryIdByEventUser.has(eventUserKey)) this.duplicateCompositeKeys += 1;
      else this.deliveryIdByEventUser.set(eventUserKey, deliveryId);
      this.eventUserKeyByDeliveryId.set(deliveryId, eventUserKey);
    }
  }

  remove(deliveryId: string): void {
    this.removeExceptEventBucket(deliveryId);
    this.removeFromEventBucket(deliveryId);
  }

  /** Removes everything except the by-event membership, for a position-preserving upsert. */
  private removeExceptEventBucket(deliveryId: string): void {
    const eventDeviceKey = this.eventDeviceKeyByDeliveryId.get(deliveryId);
    if (eventDeviceKey !== undefined) {
      this.deliveryIdByEventDevice.delete(eventDeviceKey);
      this.eventDeviceKeyByDeliveryId.delete(deliveryId);
    }
    const eventUserKey = this.eventUserKeyByDeliveryId.get(deliveryId);
    if (eventUserKey !== undefined) {
      this.deliveryIdByEventUser.delete(eventUserKey);
      this.eventUserKeyByDeliveryId.delete(deliveryId);
    }
    const deviceInstanceId = this.deviceIdByDeliveryId.get(deliveryId);
    if (deviceInstanceId !== undefined) {
      const bucket = this.deliveryIdsByDeviceId.get(deviceInstanceId);
      bucket?.delete(deliveryId);
      if (bucket && bucket.size === 0) this.deliveryIdsByDeviceId.delete(deviceInstanceId);
    }
    this.deviceIdByDeliveryId.delete(deliveryId);
  }

  private removeFromEventBucket(deliveryId: string): void {
    const eventId = this.eventIdByDeliveryId.get(deliveryId);
    if (eventId === undefined) return;
    const bucket = this.deliveryIdsByEventId.get(eventId);
    bucket?.delete(deliveryId);
    if (bucket && bucket.size === 0) this.deliveryIdsByEventId.delete(eventId);
    this.eventIdByDeliveryId.delete(deliveryId);
  }

  /**
   * Deliveries of one event, in creation order.
   *
   * Callers must still treat this as a candidate superset and confirm each hit
   * against the authoritative view: an index entry can be stale after a staged
   * change, and only the exact record decides.
   */
  deliveryIdsForEvent(eventId: string): ReadonlySet<string> {
    return this.deliveryIdsByEventId.get(eventId) ?? new Set<string>();
  }

  rebuild(state: {
    deliveries?: Record<string, DeliveryLike>;
    devices?: Record<string, { userId?: unknown }>;
  }): void {
    this.clear();
    for (const [deliveryId, delivery] of Object.entries(state.deliveries ?? {})) {
      if (typeof delivery.eventId !== "string") continue;
      if (typeof delivery.deviceInstanceId !== "string") continue;
      const userId = (state.devices ?? {})[delivery.deviceInstanceId]?.userId;
      this.upsert(deliveryId, delivery.eventId, delivery.deviceInstanceId,
        typeof userId === "string" ? userId : undefined);
    }
  }

  /**
   * Re-derives only what changed.  Both deliveries and devices are accepted: the
   * user key resolves through the delivery's device, so a device gaining a
   * `userId` changes which event/user keys exist.
   */
  applyChanges(
    deliveryChanges: readonly { key: string; after: unknown }[],
    deviceChanges: readonly { key: string; after: unknown }[],
    lookups: {
      delivery: (deliveryId: string) => DeliveryLike | undefined;
      device: (deviceInstanceId: string) => { userId?: unknown } | undefined;
    }
  ): void {
    const touched = new Set<string>();
    for (const change of deliveryChanges) touched.add(change.key);
    // A device identity change can add or remove the user-side key of its
    // deliveries, so re-derive those too rather than only the changed delivery.
    for (const change of deviceChanges) {
      for (const deliveryId of this.deliveryIdsByDeviceId.get(change.key) ?? []) {
        touched.add(deliveryId);
      }
    }
    for (const deliveryId of touched) {
      const delivery = lookups.delivery(deliveryId);
      if (!delivery || typeof delivery.eventId !== "string"
        || typeof delivery.deviceInstanceId !== "string") {
        this.remove(deliveryId);
        continue;
      }
      const userId = lookups.device(delivery.deviceInstanceId)?.userId;
      this.upsert(deliveryId, delivery.eventId, delivery.deviceInstanceId,
        typeof userId === "string" ? userId : undefined);
    }
  }

  /**
   * Deliveries belonging to one device, so a caller can union in the deliveries of
   * devices the current transaction changed: binding a device adds its
   * `(event, userId)` keys, which the committed index cannot have.
   */
  deliveryIdsForDevice(deviceInstanceId: string): ReadonlySet<string> {
    return this.deliveryIdsByDeviceId.get(deviceInstanceId) ?? new Set<string>();
  }

  deliveryIdForDevice(eventId: string, deviceInstanceId: string): string | undefined {
    return this.deliveryIdByEventDevice.get(compositeKey(eventId, deviceInstanceId));
  }

  deliveryIdForUser(eventId: string, userId: string): string | undefined {
    return this.deliveryIdByEventUser.get(compositeKey(eventId, userId));
  }
}
