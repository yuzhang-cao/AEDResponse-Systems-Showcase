/**
 * Geographic pre-filter over device positions (Phase 1 index work).
 *
 * The recruitment path asks "which devices are near this point?" and today
 * answers it with `Object.values(state.devices)` — every device in the system,
 * on every refresh.  That is the last full-collection scan on the standby path
 * and the reason a single position upload can cost O(all devices).
 *
 * This index buckets devices into a fixed-degree grid so a radius query only
 * visits the cells that can contain the circle.
 *
 * CONTRACT — this is a *pre-filter*, not an answer:
 *   - it may return candidates that are outside the radius (cell granularity);
 *   - it must NEVER omit a device that is inside the radius.
 * Callers therefore still run the exact distance / eligibility check on what it
 * returns.  The property that matters is the absence of false negatives, and it is
 * tested directly (index result ⊇ brute-force scan) rather than assumed.
 *
 * Devices without a position are not indexed: every consumer of this index
 * requires a usable coordinate anyway.
 */

/** Cell edge in degrees. 0.005° ≈ 556 m of latitude; longitude cells shrink
 *  towards the poles, which the query compensates for. */
const CELL_DEGREES = 0.005;
const EARTH_RADIUS_METERS = 6_371_008.8;
const BOUNDARY_EPSILON_DEGREES = 1e-9;

/** Guards against a pathological radius producing an unbounded cell walk. */
const MAX_CELLS_PER_QUERY = 4_096;

interface Positioned {
  latestPosition?: { position?: { latitude?: unknown; longitude?: unknown } } | undefined;
}

function coordinateOf(device: Positioned | undefined): { latitude: number; longitude: number } | undefined {
  const position = device?.latestPosition?.position;
  if (!position) return undefined;
  const latitude = position.latitude;
  const longitude = position.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  return { latitude, longitude };
}

function cellKey(latitude: number, longitude: number): string {
  return `${Math.floor(latitude / CELL_DEGREES)}:${Math.floor(longitude / CELL_DEGREES)}`;
}

export class DevicePositionIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly cellByDevice = new Map<string, string>();

  get size(): number {
    return this.cellByDevice.size;
  }

  clear(): void {
    this.cells.clear();
    this.cellByDevice.clear();
  }

  upsert(deviceInstanceId: string, latitude: number, longitude: number): void {
    const next = cellKey(latitude, longitude);
    const previous = this.cellByDevice.get(deviceInstanceId);
    if (previous === next) return;
    if (previous !== undefined) {
      const bucket = this.cells.get(previous);
      bucket?.delete(deviceInstanceId);
      if (bucket && bucket.size === 0) this.cells.delete(previous);
    }
    const bucket = this.cells.get(next) ?? new Set<string>();
    bucket.add(deviceInstanceId);
    this.cells.set(next, bucket);
    this.cellByDevice.set(deviceInstanceId, next);
  }

  remove(deviceInstanceId: string): void {
    const previous = this.cellByDevice.get(deviceInstanceId);
    if (previous === undefined) return;
    const bucket = this.cells.get(previous);
    bucket?.delete(deviceInstanceId);
    if (bucket && bucket.size === 0) this.cells.delete(previous);
    this.cellByDevice.delete(deviceInstanceId);
  }

  /** Full rebuild; O(devices) once after load or a whole-state commit. */
  rebuild(devices: Record<string, Positioned>): void {
    this.clear();
    for (const [deviceInstanceId, device] of Object.entries(devices)) {
      const coordinate = coordinateOf(device);
      if (coordinate) this.upsert(deviceInstanceId, coordinate.latitude, coordinate.longitude);
    }
  }

  /** Re-derives only the changed devices, so maintenance tracks the change set. */
  applyDeviceChanges(changes: readonly { key: string; after: unknown }[]): void {
    for (const change of changes) {
      const coordinate = coordinateOf(change.after as Positioned | undefined);
      if (coordinate) this.upsert(change.key, coordinate.latitude, coordinate.longitude);
      else this.remove(change.key);
    }
  }

  /**
   * Candidate device ids whose cell overlaps the circle's bounding box.
   *
   * The box is expanded outward to whole cells, so it always contains the circle:
   * a device within `radiusMeters` can never be missed.  Results may include
   * devices outside the radius, which the caller filters by exact distance.
   */
  query(latitude: number, longitude: number, radiusMeters: number): string[] {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
      || !Number.isFinite(longitude) || Math.abs(longitude) > 180
      || !Number.isFinite(radiusMeters) || radiusMeters < 0) {
      throw new RangeError("Invalid geographic query");
    }
    // Use the same sphere as the exact distance predicate. A rounded metres-per-
    // degree approximation can shrink the box and omit an in-range grid cell.
    const angularRadius = radiusMeters / EARTH_RADIUS_METERS;
    const latitudeRadians = latitude * Math.PI / 180;
    if (angularRadius >= Math.PI
      || Math.abs(latitudeRadians) + angularRadius >= Math.PI / 2) {
      return [...this.cellByDevice.keys()];
    }
    const latitudeDelta = angularRadius * 180 / Math.PI + BOUNDARY_EPSILON_DEGREES;
    const longitudeDelta = Math.asin(Math.min(1,
      Math.sin(angularRadius) / Math.cos(latitudeRadians))) * 180 / Math.PI
      + BOUNDARY_EPSILON_DEGREES;
    // At the date line a single unwrapped interval is insufficient. These rare
    // queries fall back to all keys; the caller still applies exact eligibility.
    if (longitude - longitudeDelta <= -180 || longitude + longitudeDelta >= 180) {
      return [...this.cellByDevice.keys()];
    }
    const minLatitudeCell = Math.floor((latitude - latitudeDelta) / CELL_DEGREES);
    const maxLatitudeCell = Math.floor((latitude + latitudeDelta) / CELL_DEGREES);
    const minLongitudeCell = Math.floor((longitude - longitudeDelta) / CELL_DEGREES);
    const maxLongitudeCell = Math.floor((longitude + longitudeDelta) / CELL_DEGREES);
    const latitudeCells = maxLatitudeCell - minLatitudeCell + 1;
    const longitudeCells = maxLongitudeCell - minLongitudeCell + 1;
    if (latitudeCells * longitudeCells > MAX_CELLS_PER_QUERY) {
      return [...this.cellByDevice.keys()];
    }

    const found = new Set<string>();
    for (let latitudeCell = minLatitudeCell; latitudeCell <= maxLatitudeCell; latitudeCell += 1) {
      for (let longitudeCell = minLongitudeCell; longitudeCell <= maxLongitudeCell; longitudeCell += 1) {
        const bucket = this.cells.get(`${latitudeCell}:${longitudeCell}`);
        if (!bucket) continue;
        for (const deviceInstanceId of bucket) found.add(deviceInstanceId);
      }
    }
    return [...found];
  }
}
