/**
 * Geographic pre-filter over device positions.
 *
 * The index exists to replace `Object.values(state.devices)` in radius queries.
 * What makes it safe is a single property: it may over-select, but it must never
 * omit a device that is inside the radius.  Everything else (cell size, grid
 * layout, maintenance) is an implementation detail in service of that property,
 * so the property is tested directly against a brute-force scan rather than
 * asserted through hand-picked examples.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DevicePositionIndex } from "../src/device-position-index.js";

/** Same haversine the service uses, so the reference filter is not a re-invention. */
function distanceMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(first.latitude * radians) * Math.cos(second.latitude * radians)
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

function device(latitude: number, longitude: number) {
  return { latestPosition: { position: { latitude, longitude } } };
}

test("a radius query never omits a device that is inside the radius", () => {
  // Deterministic scatter around a real deployment latitude.
  const centre = { latitude: 22.1987, longitude: 113.5439 };
  const devices: Record<string, ReturnType<typeof device>> = {};
  let seed = 1_234_567;
  const next = (): number => {
    // xorshift32 keeps the fixture reproducible without a dependency.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0xFFFF_FFFF;
  };
  for (let index = 0; index < 3_000; index += 1) {
    devices[`d${index}`] = device(
      centre.latitude + (next() - 0.5) * 0.2,
      centre.longitude + (next() - 0.5) * 0.2
    );
  }
  const index = new DevicePositionIndex();
  index.rebuild(devices);
  assert.equal(index.size, 3_000);

  for (const radius of [200, 500, 1_000, 1_500, 2_000, 3_000]) {
    const expected = Object.entries(devices)
      .filter(([, value]) => {
        const position = value.latestPosition.position;
        return distanceMeters(centre, position) <= radius;
      })
      .map(([id]) => id);
    const candidates = new Set(index.query(centre.latitude, centre.longitude, radius));
    const missing = expected.filter(id => !candidates.has(id));
    assert.deepEqual(missing, [],
      `radius ${radius}: ${missing.length} in-range device(s) were omitted`);
    // Over-selection is allowed but must stay bounded; a pre-filter that returns
    // everything would defeat the purpose.
    assert.ok(candidates.size <= Math.max(50, expected.length * 6),
      `radius ${radius}: pre-filter returned ${candidates.size} for ${expected.length} in range`);
  }
});

test("the pre-filter is a superset at other latitudes, including high ones", () => {
  for (const latitude of [0, 22.2, 45, 60, 75]) {
    const centre = { latitude, longitude: 10 };
    const devices: Record<string, ReturnType<typeof device>> = {};
    for (let index = 0; index < 400; index += 1) {
      devices[`d${index}`] = device(latitude + (index % 20 - 10) * 0.002, 10 + (Math.floor(index / 20) - 10) * 0.002);
    }
    const index = new DevicePositionIndex();
    index.rebuild(devices);
    const radius = 1_000;
    const expected = Object.entries(devices)
      .filter(([, value]) => distanceMeters(centre, value.latestPosition.position) <= radius)
      .map(([id]) => id);
    const candidates = new Set(index.query(latitude, 10, radius));
    assert.deepEqual(expected.filter(id => !candidates.has(id)), [], `latitude ${latitude}`);
  }
});

test("position changes move a device between cells without leaving a stale entry", () => {
  const index = new DevicePositionIndex();
  index.rebuild({ a: device(22.1987, 113.5439) });
  assert.equal(index.query(22.1987, 113.5439, 500).includes("a"), true);

  // Move far away: the old neighbourhood must no longer offer it.
  index.applyDeviceChanges([{ key: "a", after: device(40.0, 116.0) }]);
  assert.deepEqual(index.query(22.1987, 113.5439, 500), []);
  assert.deepEqual(index.query(40.0, 116.0, 500), ["a"]);

  // Losing the position removes it entirely.
  index.applyDeviceChanges([{ key: "a", after: { latestPosition: undefined } }]);
  assert.equal(index.size, 0);
  assert.deepEqual(index.query(40.0, 116.0, 500), []);
});

test("devices without a usable coordinate are not indexed", () => {
  const index = new DevicePositionIndex();
  index.rebuild({
    none: {},
    noPosition: { latestPosition: undefined },
    badLatitude: device(Number.NaN, 113),
    outOfRange: device(120, 113),
    good: device(22.1987, 113.5439)
  });
  assert.equal(index.size, 1);
  assert.deepEqual(index.query(22.1987, 113.5439, 500), ["good"]);
});

test("an absurd radius is refused rather than walking an unbounded number of cells", () => {
  const index = new DevicePositionIndex();
  index.rebuild({ a: device(22.1987, 113.5439) });
  assert.throws(() => index.query(22.1987, 113.5439, 5_000_000), /cells/);
});
