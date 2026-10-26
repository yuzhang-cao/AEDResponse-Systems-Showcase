import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import { createBackend } from "../src/server.js";
import { loadConfig, type BackendConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import { MemoryStateStore } from "../src/store.js";
import { watchSimulationRunSchema } from "../src/watch-simulation.js";
import type { PushProvider } from "../src/push-provider.js";

async function harness(pushProvider?: PushProvider) {
  const now = new Date();
  const ids = { patient: randomUUID(), watch: randomUUID(), responders: [randomUUID(), randomUUID()], outsider: randomUUID(), run: randomUUID() };
  const config: BackendConfig = { ...loadConfig({}), host: "127.0.0.1", port: 0,
    dataFile: `/tmp/aed-watch-simulation-test-${ids.run}.sqlite`,
    authSubjectPepper: "synthetic-watch-simulation-test-only", enableControlledTestAccounts: true,
    enableSimulatedEvents: true, sessionTtlSeconds: 3600, positionMaxAgeSeconds: 600,
    watchSimulationRun: { runId: ids.run, phoneDeviceId: ids.patient, watchDeviceId: ids.watch,
      responderDeviceIds: ids.responders, startsAt: new Date(now.getTime() - 1000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString() } };
  const initial = emptyState();
  initial.aeds = [{ id: "synthetic-aed", name: "SIMULATED TEST AED", available: true,
    aedPosition: { kind: "A", latitude: 0.002, longitude: 0 }, openFrom: "00:00", openUntil: "00:00",
    floor: "test", floorTransferSeconds: 0, accessNote: "fixture, do not travel", accessDelaySeconds: 0, verificationSeconds: 0 }];
  const store = new MemoryStateStore(initial);
  const backend = await createBackend({ store, config, ...(pushProvider ? { pushProvider } : {}) });
  await backend.start();
  const base = backend.baseURL() + "/api/v2";
  const people: Array<{ id: string; token: string; userId: string; pair: string }> = [];
  for (const [index, id] of [ids.patient, ...ids.responders, ids.outsider].entries()) {
    const account = await backend.service.provisionControlledTestAccount("watch-simulation-fixture-" + index);
    const pair = randomUUID();
    const session = await backend.service.bootstrap(backend.service.authenticateToken(account.sessionToken), {
      deviceInstanceId: id, companionPairId: pair, deviceKind: "IPHONE",
      agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"] as const)
        .map(kind => ({ kind, version: "2.0", acceptedAt: now.toISOString() })),
      capabilities: { locationAuthorized: true, notificationAuthorized: true }, availableForResponse: true
    }, "synthetic-watch-run");
    const principal = backend.service.authenticateToken(session.sessionToken);
    await backend.service.updateResponderPosition(principal, { positionUpdateId: randomUUID(), observedAt: now.toISOString(),
      responderPosition: { kind: "R", latitude: index * 0.0005, longitude: 0, accuracyMeters: 5 } });
    people.push({ id, token: session.sessionToken, userId: account.userId, pair });
  }
  const patient = people[0]!;
  const binding = await backend.service.bindCompanionRelay(backend.service.authenticateToken(patient.token), {
    deviceInstanceId: ids.watch, companionPairId: patient.pair
  });
  const prefix = `${base}/me/watch-relay/${ids.watch}/${binding.bindingId}`;
  const observation = { schemaVersion: "2.0", eventId: ids.run, observationKind: "FALL_CONTEXT",
    fallDetectedAt: now.toISOString(), fallResolution: "CONFIRMED", appHelpResponse: "NEEDS_HELP",
    patientPosition: { kind: "P", latitude: 0, longitude: 0, accuracyMeters: 5 }, patientPositionObservedAt: now.toISOString() };
  const headers = (index = 0) => ({ authorization: `Bearer ${people[index]!.token}`, "content-type": "application/json" });
  const put = (body = observation, path = `${prefix}/simulation/emergency-observations/${ids.run}`, index = 0) =>
    fetch(path, { method: "PUT", headers: headers(index), body: JSON.stringify(body) });
  return { now, ids, config, store, backend, base, people, prefix, observation, headers, put };
}

test("controlled Watch run config is explicit, bounded and has no duplicate devices", () => {
  const run = { runId: randomUUID(), startsAt: "2026-09-27T00:00:00.000Z", expiresAt: "2026-09-27T01:00:00.000Z",
    phoneDeviceId: randomUUID(), watchDeviceId: randomUUID(), responderDeviceIds: [randomUUID(), randomUUID()] };
  assert.equal(watchSimulationRunSchema.safeParse(run).success, true);
  assert.equal(watchSimulationRunSchema.safeParse({ ...run, watchDeviceId: run.phoneDeviceId }).success, false);
  assert.equal(watchSimulationRunSchema.safeParse({ ...run, expiresAt: "2026-09-27T02:00:00.000Z" }).success, false);
  assert.throws(() => loadConfig({ AED_WATCH_SIMULATION_RUN: JSON.stringify(run) }));
  assert.deepEqual(loadConfig({ AED_WATCH_SIMULATION_RUN: JSON.stringify(run), AED_ENABLE_CONTROLLED_TEST_ACCOUNTS: "true",
    AED_SIMULATION_ADMIN_SOCKET: "/tmp/private-test/admin.sock" }).watchSimulationRun, run);
  assert.equal(loadConfig({}).watchSimulationRun, undefined);
});

test("a slow APNs provider cannot hold the actual Watch relay HTTP acknowledgement", async t => {
  let release!: () => void, announce!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { announce = resolve; });
  let delivered = false;
  const provider: PushProvider = { name: "controlled-blocking", isConfigured: () => true,
    send: async () => { announce(); await blocked; delivered = true; return { status: "DELIVERED" }; } };
  const h = await harness(provider);
  t.after(async () => { release(); await h.backend.service.flushNotificationPushes(); await h.backend.stop(); });
  const registered = await fetch(h.base + "/me/push-token", { method: "POST", headers: h.headers(),
    body: JSON.stringify({ pushToken: "a".repeat(64), pushEnvironment: "SANDBOX", bundleId: "dev.codex.aedresponse" }) });
  assert.equal(registered.status, 201);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([h.put(), new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Watch ACK waited for APNs")), 2000);
    })]);
    assert.equal(response.status, 201);
    await started;
    assert.equal(delivered, false, "A committed event ACK is independent of push-provider delivery");
  } finally { if (timeout) clearTimeout(timeout); release(); }
});

test("Watch simulation rejects disabled, expired, foreign, unmarked and malformed inputs without creating events", async t => {
  const h = await harness(); t.after(() => h.backend.stop());
  assert.equal((await fetch(h.prefix + "/simulation")).status, 401);
  assert.equal((await fetch(h.prefix + "/simulation", { headers: h.headers(3) })).status, 403);
  assert.equal((await fetch(h.prefix + "/simulation", { headers: h.headers() })).status, 200);
  assert.equal((await h.put(h.observation, `${h.prefix}/emergency-observations/${h.ids.run}`)).status, 403);
  assert.equal((await h.put({ ...h.observation, eventId: randomUUID() })).status, 403);
  assert.equal((await h.put({ ...h.observation, extra: "must-not-be-ignored" } as typeof h.observation)).status, 400);
  const run = h.config.watchSimulationRun!;
  const context = await (await fetch(h.prefix + "/simulation", { headers: h.headers() })).json();
  assert.equal(context.startsAt, run.startsAt);
  assert.equal((await h.put({ ...h.observation, fallDetectedAt: new Date(Date.parse(run.startsAt) - 1).toISOString() })).status, 403);
  h.config.enableSimulatedEvents = false;
  assert.equal((await h.put()).status, 403);
  h.config.enableSimulatedEvents = true;
  run.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal((await h.put()).status, 403);
  assert.equal(h.store.read(state => Object.keys(state.events).length), 0);
});

test("synthetic Watch payload uses real HTTP/Socket, isolated recruitment, AED tasks and final event state", async t => {
  const h = await harness(); t.after(() => h.backend.stop());
  const sockets: Socket[] = [];
  t.after(() => { for (const socket of sockets) socket.disconnect(); });
  function listen(index: number) {
    const socket = io(h.backend.baseURL(), { autoConnect: false, transports: ["websocket"], reconnection: false,
      extraHeaders: { Authorization: `Bearer ${h.people[index]!.token}` } });
    sockets.push(socket); return socket;
  }
  function next(socket: Socket, event: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off(event, received); reject(new Error("Missing " + event)); }, 3000);
      const received = (value: unknown) => { clearTimeout(timer); resolve(value); };
      socket.once(event, received);
    });
  }
  const patient = listen(0), responder = listen(1), outsider = listen(3);
  const ready = Promise.all([next(patient, "system:ready"), next(responder, "system:ready"), next(outsider, "system:ready")]);
  patient.connect(); responder.connect(); outsider.connect(); await ready;
  let outsiderOffers = 0;
  outsider.on("response:requested", () => { outsiderOffers += 1; });
  const notifications = Promise.all([next(patient, "event:patient-activated"), next(responder, "response:requested")]);
  void notifications.catch(() => {});
  const response = await h.put();
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const projection = await response.json() as { id: string; triggerSource: string; simulation: { runId: string } };
  assert.equal(projection.id, h.ids.run);
  assert.equal(projection.triggerSource, "SIMULATED_TEST");
  assert.equal(projection.simulation.runId, h.ids.run);
  assert.equal(h.store.read(state => Object.values(state.deliveries).length), 2,
    JSON.stringify(h.store.read(state => ({ recruitment: state.events[h.ids.run]?.recruitmentState,
      responders: h.ids.responders.map(id => ({ capabilities: state.devices[id]?.capabilities,
        available: state.devices[id]?.availableForResponse, position: !!state.devices[id]?.latestPosition })) }))));
  await notifications;
  assert.equal(outsiderOffers, 0);
  assert.equal((await h.put()).status, 200);
  assert.equal((await h.put({ ...h.observation, fallResolution: "UNKNOWN" })).status, 409);
  const saved = h.store.read(state => state.events[h.ids.run]!);
  assert.equal(saved.observation.observationKind, "SIMULATED_TEST");
  assert.equal(saved.triggeringWatchDeviceId, h.ids.watch);
  assert.equal(saved.patientPosition?.source, "WATCH_TRIGGER_SNAPSHOT");
  assert.equal((await fetch(h.prefix + `/events/${h.ids.run}/state`, { headers: h.headers() })).status, 200);
  assert.equal((await fetch(h.base + `/events/${h.ids.run}`, { headers: h.headers(3) })).status, 404);
  const deliveries = h.store.read(state => Object.values(state.deliveries));
  assert.deepEqual(deliveries.map(row => row.deviceInstanceId).sort(), [...h.ids.responders].sort());
  for (const delivery of deliveries) {
    const index = h.people.findIndex(row => row.id === delivery.deviceInstanceId);
    const decision = await fetch(h.base + `/events/${h.ids.run}/responses/${delivery.id}`, {
      method: "PUT", headers: h.headers(index), body: JSON.stringify({ decision: "ACCEPT", decidedAt: new Date().toISOString() })
    });
    assert.equal(decision.status, 200, JSON.stringify(await decision.clone().json()));
  }
  const assignments = h.store.read(state => Object.values(state.assignments));
  assert.deepEqual(assignments.map(row => row.role).sort(), ["FETCH_AED", "GO_TO_PATIENT"]);
  for (const assignment of assignments) {
    const index = h.people.findIndex(row => row.id === assignment.deviceInstanceId);
    async function status(value: string) {
      const response = await fetch(h.base + `/events/${h.ids.run}/assignments/${assignment.id}/status`, {
        method: "PUT", headers: h.headers(index), body: JSON.stringify({ status: value, occurredAt: new Date().toISOString() })
      });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    }
    await status("EN_ROUTE");
    if (assignment.role === "FETCH_AED") {
      assert.equal(assignment.route?.path.length, 3);
      await status("ARRIVED_AT_AED");
      const receipt = { receiptId: randomUUID(), eventId: h.ids.run, assignmentId: assignment.id,
        aedId: assignment.route!.aedId, acquiredAt: new Date().toISOString() };
      const acknowledge = () => fetch(h.base + `/events/${h.ids.run}/assignments/${assignment.id}/aed-acquired`, {
        method: "PUT", headers: h.headers(index), body: JSON.stringify(receipt)
      });
      assert.equal((await acknowledge()).status, 201);
      assert.equal((await acknowledge()).status, 200);
      await status("EN_ROUTE_TO_PATIENT");
    }
    await status("ARRIVED_AT_PATIENT");
    await status("COMPLETED");
  }
  const end = await fetch(h.base + `/events/${h.ids.run}/end`, { method: "POST", headers: h.headers(),
    body: JSON.stringify({ resolutionId: randomUUID(), reason: "PROBLEM_RESOLVED", endedAt: new Date().toISOString() }) });
  assert.equal(end.status, 200, JSON.stringify(await end.clone().json()));
  const state = await fetch(h.prefix + `/events/${h.ids.run}/state`, { headers: h.headers() });
  assert.equal((await state.json() as { state: string }).state, "RESOLVED");
  assert.equal(h.store.read(value => Object.keys(value.events).length), 1);
  assert.equal(outsiderOffers, 0);
});

test("ordinary private simulation admin cannot inject a synthetic Watch observation", async t => {
  const h = await harness(); t.after(() => h.backend.stop());
  await assert.rejects(h.backend.service.handleSimulationAdmin({ action: "enroll-watch-simulation", runId: randomUUID() }));
  await assert.rejects(h.backend.service.createSimulatedEvent({ observationKind: "SIMULATED_TEST", runId: h.ids.run,
    requestedAt: h.now.toISOString(), patientUserId: h.people[0]!.userId, patientDeviceId: h.ids.patient,
    responderUserId: h.people[1]!.userId, responderDeviceId: h.ids.responders[0],
    syntheticWatch: { deviceId: h.ids.watch, observation: h.observation } }));
  assert.equal(h.store.read(state => Object.keys(state.events).length), 0);
});

test("the actual controlled runner completes receipt progression, acceptance, navigation and AED over real HTTP", async t => {
  const h = await harness(); t.after(() => h.backend.stop());
  assert.equal((await h.put()).status, 201);
  const deployed = new URL("../scripts/watch-simulation-runner.mjs", import.meta.url);
  const source = readFileSync(existsSync(deployed) ? deployed : new URL("../deploy/azure/watch-simulation-runner.mjs", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("async function heartbeat("), source.indexOf("\n\nassertWindow();"));
  const people = h.people.slice(1, 3).map(person => ({ deviceInstanceId: person.id, session: { sessionToken: person.token } }));
  const receipts: string[] = [], logs: string[] = [];
  async function request(path: string, token: string, method = "GET", body?: unknown) {
    const response = await fetch(h.base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(await response.clone().json())}`);
    if (path.endsWith("/receipt")) receipts.push((body as { status: string }).status);
    return response.json();
  }
  const context = createContext({ people, run: { runId: h.ids.run }, capabilities: { locationAuthorized: true, notificationAuthorized: true },
    accepted: false, stopping: false, randomUUID, ensureSession: async () => {}, checkpoint: () => {},
    request, view: async (person: typeof people[number]) => (await request("/events", person.session.sessionToken)).events.find((event: { id: string }) => event.id === h.ids.run),
    syntheticPosition: (index: number) => ({ kind: "R", latitude: (index + 1) * 0.0005, longitude: 0, accuracyMeters: 5 }),
    assertWindow: () => assert.ok(Date.now() < Date.parse(h.config.watchSimulationRun!.expiresAt)),
    assertEvent: (event: { id: string; simulation?: { runId: string; label: string } }) => {
      assert.equal(event.id, h.ids.run); assert.equal(event.simulation?.runId, h.ids.run); assert.equal(event.simulation?.label, "SIMULATED_TEST");
    }, log: (name: string) => logs.push(name)
  });
  runInContext(functions, context);
  for (const [index, person] of people.entries()) await context.heartbeat(person, index);
  assert.deepEqual(receipts, ["DELIVERED", "VIEWED", "DELIVERED", "VIEWED"]);
  assert.equal(logs.filter(name => name === "RESPONSE_ACCEPTED").length, 2);
  await context.command("navigate");
  await context.command("aed");
  await context.command("arrive");
  assert.ok(logs.includes("AED_ROUTE_R_A_P_VERIFIED"));
  assert.ok(logs.includes("AED_RECEIPT_ACK_AND_REPLAY_VERIFIED"));
  assert.deepEqual(h.store.read(state => Object.values(state.assignments).map(row => row.status)), ["COMPLETED", "COMPLETED"]);
});
