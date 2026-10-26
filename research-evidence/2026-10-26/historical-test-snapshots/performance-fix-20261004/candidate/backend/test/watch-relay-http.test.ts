import assert from "node:assert/strict";
import test from "node:test";
import { createBackend } from "../src/server.js";
import { emptyState } from "../src/models.js";
import { MemoryStateStore } from "../src/store.js";

test("HTTP phone relay binds, preserves strict facts, replays and isolates Watch credentials", async () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const store = new MemoryStateStore(emptyState());
  const backend = await createBackend({ store, config: {
    host: "127.0.0.1", port: 0, dataFile: "/tmp/unused-watch-relay.sqlite",
    fixtureFile: "/tmp/unused-watch-relay-fixture.json", sessionTtlSeconds: 3600,
    nearbyRadiusMeters: 1000, positionMaxAgeSeconds: 600, maxClientClockSkewSeconds: 120,
    maxPositionAccuracyMeters: 50, bootstrapLimitPerMinute: 100, production: false,
    authSubjectPepper: "local-relay-test-only"
  }, appleIdentityTokenVerifier: { async verifyIdentityToken() { return { subject: "local-relay-test" }; } } });
  await backend.start();
  try {
    const base = `${backend.baseURL()}/api/v2`;
    const json = { "content-type": "application/json" };
    const login = await fetch(`${base}/auth/apple`, { method: "POST", headers: json,
      body: JSON.stringify({ challengeId: uuid(1), identityToken: "local-test", nonce: "nonce" }) });
    assert.equal(login.status, 200);
    const account = await login.json() as { sessionToken: string };
    const now = new Date().toISOString();
    const boot = await fetch(`${base}/session/bootstrap`, { method: "POST",
      headers: { ...json, authorization: `Bearer ${account.sessionToken}` },
      body: JSON.stringify({ deviceInstanceId: uuid(2), deviceKind: "IPHONE", companionPairId: uuid(3),
        agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
          .map(kind => ({ kind, version: "2.0", acceptedAt: now })),
        capabilities: { notificationAuthorized: true, locationAuthorized: true }, availableForResponse: true }) });
    assert.equal(boot.status, 201);
    const phone = await boot.json() as { sessionToken: string };
    const headers = { ...json, authorization: `Bearer ${phone.sessionToken}` };
    const bindingResponse = await fetch(`${base}/me/watch-relay/bindings`, { method: "POST", headers,
      body: JSON.stringify({ deviceInstanceId: uuid(4), companionPairId: uuid(3) }) });
    assert.equal(bindingResponse.status, 200);
    const binding = await bindingResponse.json() as { bindingId: string };
    assert.ok(binding.bindingId);
    assert.equal(store.read(s => Object.values(s.sessionsByTokenHash).filter(x => x.deviceKind === "WATCH").length), 0);
    const observation = { schemaVersion: "2.0", eventId: uuid(5), observationKind: "FALL_CONTEXT",
      fallDetectedAt: now, fallResolution: "CONFIRMED", appHelpResponse: "NEEDS_HELP", locationUnavailableReason: "local-test" };
    const prefix = `${base}/me/watch-relay/${uuid(4)}/${binding.bindingId}`;
    const report = () => fetch(`${prefix}/emergency-observations/${uuid(5)}`, { method: "PUT", headers, body: JSON.stringify(observation) });
    assert.equal((await report()).status, 201);
    assert.equal((await report()).status, 200);
    assert.equal((await fetch(`${prefix}/events/${uuid(5)}/state`, { headers })).status, 200);
    assert.equal((await fetch(`${prefix}/emergency-observations/${uuid(5)}`, { method: "PUT", headers,
      body: JSON.stringify({ ...observation, secretExtra: "must-not-be-ignored" }) })).status, 400);
    assert.equal((await fetch(`${base}/watch/emergency-observations/${uuid(5)}`, { method: "PUT", headers,
      body: JSON.stringify(observation) })).status, 403);
    assert.equal((await fetch(`${prefix}/events/${uuid(5)}/state`)).status, 401);
    assert.equal(store.read(s => Object.keys(s.events).length), 1);
  } finally { await backend.stop(); }
});
