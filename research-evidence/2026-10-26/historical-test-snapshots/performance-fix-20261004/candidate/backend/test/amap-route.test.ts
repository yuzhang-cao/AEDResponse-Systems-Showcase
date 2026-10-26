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

test("Amap converts derived coordinates, enforces 300-second detour and preserves WGS84", async () => {
  for (const detour of [300, 301]) {
    let leg = 0;
    const planner = new AmapWalkingPlanner("synthetic-key", async (url, options) => {
      assert.equal(options?.redirect, "error");
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("convert")) {
        assert.equal(parsed.searchParams.get("coordsys"), "gps");
        return Response.json({ status: "1", locations: "116.4,39.9;116.405,39.905;116.41,39.91" });
      }
      assert.equal(parsed.searchParams.get("show_fields"), "cost");
      const duration = [200, 200, 400 - detour][leg++];
      return Response.json({ status: "1", route: { paths: [{ cost: { duration: String(duration) } }] } });
    });
    const result = await planner.route({ responder, patient, aed, at });
    if (detour === 300) {
      assert.equal(result.kind, "AVAILABLE");
      if (result.kind === "AVAILABLE") {
        assert.deepEqual(result.value.path, [responder, aed.aedPosition, patient]);
        assert.equal(result.value.etaSeconds, 460);
      }
    } else assert.deepEqual(result, { kind: "UNAVAILABLE", reason: "NO_AVAILABLE_ROUTE" });
  }
});

test("quote cache coalesces requests and rejects different inputs or expired results", async () => {
  let now = at.getTime(); let count = 0;
  const provider = new AmapAedRouteProvider({ route: async input => {
    count++;
    return { kind: "AVAILABLE", value: { aedId: input.aed.id, path: [input.responder, input.aed.aedPosition, input.patient],
      walkingSeconds: 400, overheadSeconds: 60, etaSeconds: 460 } };
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
