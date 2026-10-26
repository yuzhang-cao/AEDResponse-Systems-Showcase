import test from "node:test";
import assert from "node:assert/strict";
import { ClientMapkitRouteProvider } from "../src/client-mapkit-routes.js";
import type { Aed, PatientPosition, ResponderPosition } from "../src/contracts.js";
const r: ResponderPosition = { kind: "R", latitude: 22, longitude: 113, accuracyMeters: 5 };
const p: PatientPosition = { kind: "P", latitude: 22.001, longitude: 113.001, accuracyMeters: 5 };
const a: Aed = { id: "a", name: "synthetic", aedPosition: { kind: "A", latitude: 22.0005, longitude: 113.0005 },
  available: true, openFrom: "00:00", openUntil: "00:00", floor: "1", floorTransferSeconds: 9999,
  accessNote: "", accessDelaySeconds: 9999, verificationSeconds: 9999 };
const scope = { eventId: "event", deviceInstanceId: "device" };
const at = new Date("2026-10-08T00:00:00Z");
const input = { scope, responder: r, patient: p, aeds: [a], unavailableAedIds: new Set<string>(), at };
function setup() {
  let time = at.getTime();
  const provider = new ClientMapkitRouteProvider(() => new Date(time));
  const context = provider.issue(scope, r, p, [a]);
  const submission = { calculationId: context.calculationId, routes: [{ aedId: a.id, toAedMeters: 150, toPatientMeters: 160 }] };
  return { provider, context, submission, later: () => { time += 60_001; } };
}
test("client quotes are scoped, short-lived, and never fall back to geometric routes", () => {
  const { provider, submission, later } = setup();
  assert.equal(provider.bestRoute(input).kind, "UNAVAILABLE");
  provider.accept(scope, submission, r, p, [a]);
  const route = provider.bestRoute(input);
  assert.equal(route.kind, "AVAILABLE");
  if (route.kind === "AVAILABLE") {
    assert.equal(route.value.distanceMeters, 310);
    assert.equal(route.value.distanceSource, "CLIENT_MAPKIT");
  }
  assert.equal(provider.bestRoute({ ...input, scope: { ...scope, eventId: "other" } }).kind, "UNAVAILABLE");
  assert.equal(provider.bestRoute({ ...input, patient: { ...p, latitude: 22.002 } }).kind, "UNAVAILABLE");
  assert.equal(provider.bestRoute({ ...input, responder: { ...r, latitude: 22.1 } }).kind, "UNAVAILABLE");
  assert.equal(provider.bestRoute({ ...input, unavailableAedIds: new Set([a.id]) }).kind, "UNAVAILABLE");
  later();
  assert.equal(provider.bestRoute(input).kind, "UNAVAILABLE");
});
test("changed inventory, another client, duplicates, and invalid distances cannot become quotes", () => {
  const { provider, submission } = setup();
  assert.throws(() => provider.accept({ ...scope, deviceInstanceId: "other" }, submission, r, p, [a]));
  assert.throws(() => provider.accept(scope, submission, r, p, [{ ...a, available: false }]));
  assert.throws(() => provider.accept(scope, { ...submission, routes: [...submission.routes, ...submission.routes] }, r, p, [a]));
  assert.throws(() => provider.accept(scope, { ...submission, routes: [{ aedId: "unknown", toAedMeters: 150, toPatientMeters: 160 }] }, r, p, [a]));
  assert.throws(() => provider.accept(scope, { ...submission, routes: [{ aedId: a.id, toAedMeters: -1, toPatientMeters: 160 }] }, r, p, [a]));
  assert.throws(() => provider.accept(scope, { ...submission, routes: [{ aedId: a.id, toAedMeters: 0, toPatientMeters: 0 }] }, r, p, [a]));
  provider.issue(scope, r, p, [a]);
  assert.throws(() => provider.accept(scope, submission, r, p, [a]));
});
test("candidate work is bounded and retains an existing target for reroute comparisons", () => {
  const { provider } = setup();
  const inventory = Array.from({ length: 20 }, (_, i) => ({ ...a, id: `aed-${i}` }));
  const context = provider.issue(scope, r, p, inventory, "aed-19");
  assert.equal(context.aeds.length, 8);
  assert.equal(context.eligibleCandidateCount, 20);
  assert.equal(context.aeds[0]?.id, "aed-19");
});

test("a calculation retry is idempotent and conflicting distances are rejected", () => {
  const { provider, submission } = setup();
  assert.equal(provider.accept(scope, submission, r, p, [a]), true);
  assert.equal(provider.accept(scope, submission, r, p, [a]), false);
  assert.throws(() => provider.accept(scope, { ...submission, routes: [{ aedId: a.id, toAedMeters: 900, toPatientMeters: 900 }] }, r, p, [a]));
});
