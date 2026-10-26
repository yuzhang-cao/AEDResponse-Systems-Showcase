import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ReferenceAedRouteProvider } from "../../src/route-provider.ts";

const responder = { kind: "R" as const, latitude: 22.198, longitude: 113.543, accuracyMeters: 10 };
const patient = { kind: "P" as const, latitude: 22.199, longitude: 113.544, accuracyMeters: 10 };
const aed = {
  id: "aed-1",
  name: "Lobby AED",
  aedPosition: { kind: "A" as const, latitude: 22.1985, longitude: 113.5435 },
  openFrom: "00:00",
  openUntil: "23:59",
  floor: "1",
  floorTransferSeconds: 0,
  accessNote: "",
  accessDelaySeconds: 0,
  verificationSeconds: 0,
  available: true
};

test("route provider is the deterministic authority for best and eligible routes", () => {
  const provider = new ReferenceAedRouteProvider();
  const input = {
    responder,
    patient,
    aeds: [aed],
    unavailableAedIds: new Set<string>(),
    at: new Date("2026-09-10T12:00:00.000Z")
  };
  const best = provider.bestRoute(input);
  const eligible = provider.eligibleRoutes(input);
  assert.equal(best.kind, "AVAILABLE");
  assert.equal(eligible.kind, "AVAILABLE");
  if (best.kind === "AVAILABLE" && eligible.kind === "AVAILABLE") {
    assert.deepEqual(best.value, eligible.value[0]);
  }
});

test("route provider fails closed for invalid geometry", () => {
  const provider = new ReferenceAedRouteProvider();
  const result = provider.bestRoute({
    responder: { ...responder, latitude: Number.NaN },
    patient,
    aeds: [aed],
    unavailableAedIds: new Set<string>(),
    at: new Date("2026-09-10T12:00:00.000Z")
  });
  assert.deepEqual(result, { kind: "UNAVAILABLE", reason: "INVALID_INPUT" });
});

test("service delegates route selection instead of owning a second algorithm", async () => {
  const service = await readFile(
    fileURLToPath(new URL("../../src/service.ts", import.meta.url)),
    "utf8"
  );
  assert.match(service, /private readonly routeProvider: AedRouteProvider/);
  assert.match(service, /this\.routeProvider\.bestRoute\(/);
  assert.match(service, /this\.routeProvider\.eligibleRoutes\(/);
  assert.match(service, /this\.routeProvider\.refreshRoute\(/);
  assert.doesNotMatch(service, /\bbestAedRoute\(/);
  assert.doesNotMatch(service, /\beligibleAedRoutes\(/);
  assert.doesNotMatch(service, /\bmakeAedRoute\(/);
});

