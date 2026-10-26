import test from "node:test";
import assert from "node:assert/strict";
import { AmapWalkingPlanner } from "../src/amap-walking.js";
import { AmapAedRouteProvider } from "../src/amap-route-provider.js";
import type { Aed, PatientPosition, ResponderPosition } from "../src/contracts.js";
const responder: ResponderPosition = { kind: "R", latitude: 39.9, longitude: 116.3, accuracyMeters: 5 };
const patient: PatientPosition = { kind: "P", latitude: 39.91, longitude: 116.31, accuracyMeters: 5 };
const aed: Aed = { id: "aed-quote", name: "fixture", aedPosition: { kind: "A", latitude: 39.905, longitude: 116.305, accuracyMeters: 5 },
  available: true, openFrom: "00:00", openUntil: "00:00", floor: "1", floorTransferSeconds: 10,
  accessNote: "fixture", accessDelaySeconds: 20, verificationSeconds: 30 };
const at = new Date("2026-09-11T00:00:00Z");
const converted = () => Response.json({ status: "1", locations: "116.4,39.9;116.405,39.905;116.41,39.91" });

test("Amap sums shortest returned walking legs R-A and A-P, ignoring time and preserving WGS84", async () => {
  const calls: string[][] = [];
  const planner = new AmapWalkingPlanner("synthetic-key", async (url, options) => {
    assert.equal(options?.redirect, "error");
    const parsed = new URL(String(url));
    if (parsed.pathname.includes("convert")) {
      assert.equal(parsed.searchParams.get("coordsys"), "gps");
      assert.equal(parsed.searchParams.get("locations"), "116.300000,39.900000|116.305000,39.905000|116.310000,39.910000");
      return converted();
    }
    assert.equal(parsed.pathname, "/v5/direction/walking");
    assert.equal(parsed.searchParams.get("alternative_route"), "3");
    assert.equal(parsed.searchParams.has("show_fields"), false);
    calls.push([parsed.searchParams.get("origin")!, parsed.searchParams.get("destination")!]);
    // The faster route is longer; neither speed nor the old 300-second detour matters.
    return Response.json({ status: "1", route: { paths: [
      { distance: "900", cost: { duration: "60" } },
      { distance: "350.5", cost: { duration: "900" } }
    ] } });
  });
  const result = await planner.route({ responder, patient, aed, at });
  assert.deepEqual(calls, [["116.4,39.9", "116.405,39.905"], ["116.405,39.905", "116.41,39.91"]]);
  assert.equal(result.kind, "AVAILABLE");
  if (result.kind === "AVAILABLE") {
    assert.deepEqual(result.value.path, [responder, aed.aedPosition, patient]);
    assert.equal(result.value.distanceMeters, 701);
    assert.equal(result.value.distanceSource, "AMAP_WALKING");
    assert.equal("etaSeconds" in result.value, false);
    assert.deepEqual(result.value.amapNavigation, { coordinateSystem: "GCJ02",
      aed: { latitude: 39.905, longitude: 116.405 }, patient: { latitude: 39.91, longitude: 116.41 } });
  }
});

test("invalid or missing walking distance never falls back to duration or geometry", async () => {
  for (const paths of [[], [{ cost: { duration: "30" } }], [{ distance: "-1" }], [{ distance: "NaN" }], [{ distance: "1e309" }]]) {
    const planner = new AmapWalkingPlanner("synthetic", async url => String(url).includes("convert")
      ? converted() : Response.json({ status: "1", route: { paths } }));
    assert.equal((await planner.route({ responder, patient, aed, at })).kind, "UNAVAILABLE");
  }
});

test("closed/unavailable AED and invalid coordinates are rejected before networking", async () => {
  const planner = new AmapWalkingPlanner("synthetic", async () => { throw new Error("must not call network"); });
  assert.deepEqual(await planner.route({ responder, patient, aed: { ...aed, available: false }, at }),
    { kind: "UNAVAILABLE", reason: "NO_AVAILABLE_ROUTE" });
  assert.deepEqual(await planner.route({ responder: { ...responder, latitude: NaN }, patient, aed, at }),
    { kind: "UNAVAILABLE", reason: "INVALID_INPUT" });
});

test("quote cache coalesces requests and rejects different inputs or expired results", async () => {
  let now = at.getTime(); let count = 0;
  const provider = new AmapAedRouteProvider({ route: async input => {
    count++;
    return { kind: "AVAILABLE", value: { aedId: input.aed.id, path: [input.responder, input.aed.aedPosition, input.patient],
      distanceMeters: 460, distanceSource: "AMAP_WALKING" } };
  } }, () => new Date(now));
  const input = { responder, patient, aeds: [aed], unavailableAedIds: new Set<string>(), at };
  assert.equal(provider.bestRoute(input).kind, "UNAVAILABLE");
  await Promise.all([provider.prepare(input), provider.prepare(input)]);
  assert.equal(count, 1);
  assert.equal(provider.bestRoute(input).kind, "AVAILABLE");
  assert.equal(provider.bestRoute({ ...input, responder: { ...responder, latitude: 39.901 } }).kind, "UNAVAILABLE");
  now += 15_001;
  assert.equal(provider.bestRoute(input).kind, "UNAVAILABLE");
});

test("candidate selection uses total road distance and fails closed on an incomplete provider response", async () => {
  const provider = new AmapAedRouteProvider({ route: async input => ({ kind: "AVAILABLE", value: {
    aedId: input.aed.id, path: [input.responder, input.aed.aedPosition, input.patient],
    distanceMeters: input.aed.id === "shorter" ? 200 : 800, distanceSource: "AMAP_WALKING"
  } }) }, () => at);
  const input = { responder, patient, aeds: [aed, { ...aed, id: "shorter", accessDelaySeconds: 9999 }], unavailableAedIds: new Set<string>(), at };
  await provider.prepare(input);
  const selected = provider.bestRoute(input);
  assert.equal(selected.kind, "AVAILABLE");
  if (selected.kind === "AVAILABLE") assert.equal(selected.value.aedId, "shorter");
  assert.equal(provider.eligibleRoutes({ ...input, aeds: [...input.aeds, { ...aed, id: "not-prepared" }] }).kind, "UNAVAILABLE");
});
