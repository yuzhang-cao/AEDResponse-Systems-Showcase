import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { SQLiteStateStore } from "../src/store.js";
import { simulationObservationSchema } from "../src/simulation.js";
import { createConnection } from "node:net";
import { io, type Socket } from "socket.io-client";
import { createBackend } from "../src/server.js";

test("simulation is explicit, durable, scoped to two devices and uses ordinary task acceptance", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aed-simulation-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let now = new Date("2026-09-08T05:00:00.000Z");
  let store = await SQLiteStateStore.open(path, []);
  const config = { ...loadConfig({}), authSubjectPepper: "synthetic-only-pepper",
    enableControlledTestAccounts: true, enableSimulatedEvents: true };
  let service = new AEDResponseService(store, config, undefined, () => now);
  const people: DevicePrincipal[] = [];
  for (let index = 0; index < 3; index++) {
    const account = await service.provisionControlledTestAccount("synthetic-phone-" + index);
    const session = await service.bootstrap(service.authenticateToken(account.sessionToken), {
      deviceInstanceId: randomUUID(), companionPairId: randomUUID(), deviceKind: "IPHONE",
      agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"] as const)
        .map(kind => ({ kind, version: "2.0", acceptedAt: now.toISOString() })),
      capabilities: { locationAuthorized: true, notificationAuthorized: true },
      availableForResponse: true
    }, "synthetic");
    const principal = service.authenticateToken(session.sessionToken);
    assert.equal(principal.kind, "DEVICE");
    if (principal.kind !== "DEVICE") throw new Error("Expected device");
    people.push(principal);
    await service.updateResponderPosition(principal, {
      positionUpdateId: randomUUID(), observedAt: now.toISOString(),
      responderPosition: { kind: "R", latitude: 0.001 * index, longitude: 0, accuracyMeters: 5 }
    });
  }
  const [patient, responder, outsider] = people as [DevicePrincipal, DevicePrincipal, DevicePrincipal];
  const input = {
    observationKind: "SIMULATED_TEST", runId: randomUUID(), requestedAt: now.toISOString(),
    patientUserId: patient.userId!, patientDeviceId: patient.deviceInstanceId,
    responderUserId: responder.userId!, responderDeviceId: responder.deviceInstanceId
  };
  const disabled = new AEDResponseService(store, { ...config, enableSimulatedEvents: false }, undefined, () => now);
  await assert.rejects(disabled.createSimulatedEvent(input));
  assert.equal(simulationObservationSchema.safeParse({ ...input, fallDetectedAt: now.toISOString() }).success, false);
  await assert.rejects(service.createSimulatedEvent({ ...input, responderUserId: input.patientUserId }));
  const created = await service.createSimulatedEvent(input);
  assert.equal(created.simulated, true);
  assert.equal((await service.createSimulatedEvent(input)).replayed, true);
  await assert.rejects(service.createSimulatedEvent({ ...input, runId: randomUUID() }));
  const view = service.getEvent(patient, input.runId);
  assert.equal(view.viewerRelationship, "PATIENT");
  assert.ok("triggerSource" in view);
  assert.equal(view.triggerSource, "SIMULATED_TEST");
  assert.deepEqual(view.simulation, { runId: input.runId, label: "SIMULATED_TEST" });
  assert.equal(view.fallDetectedAt, null);
  assert.equal(view.callFirstObservedAt, null);
  assert.throws(() => service.getEvent(outsider, input.runId));
  const deliveries = store.read(s => Object.values(s.deliveries));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.deviceInstanceId, responder.deviceInstanceId);
  assert.deepEqual(deliveries[0]!.request.simulation, { runId: input.runId, label: "SIMULATED_TEST" });
  assert.equal(store.read(s => s.events[input.runId]!.triggeringWatchDeviceId), undefined);
  await assert.rejects(store.transact(s => { delete s.events[input.runId]; }));
  await assert.rejects(store.transact(s => {
    s.events[input.runId]!.observation = { ...simulationObservationSchema.parse(input), responderDeviceId: outsider.deviceInstanceId };
  }));
  await store.close();
  store = await SQLiteStateStore.open(path, []);
  t.after(() => store.close());
  service = new AEDResponseService(store, config, undefined, () => now);
  assert.equal(store.read(s => s.events[input.runId]!.observation.observationKind), "SIMULATED_TEST");
  now = new Date(now.getTime() + 1000);
  await service.respond(responder, input.runId, deliveries[0]!.id, { decision: "ACCEPT", decidedAt: now.toISOString() });
  const tasks = store.read(s => Object.values(s.assignments));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.role, "GO_TO_PATIENT");
  assert.equal(tasks[0]!.deviceInstanceId, responder.deviceInstanceId);
});

test("explicit Apple device pair is isolated and retains normal acceptance", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aed-simulation-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let now = new Date("2026-09-08T05:00:00.000Z");
  let store = await SQLiteStateStore.open(path, []);
  const config = { ...loadConfig({}), authSubjectPepper: "synthetic-only-pepper",
    enableControlledTestAccounts: false, enableSimulatedEvents: true, simulationAppleDeviceIds: [] as string[] };
  let service = new AEDResponseService(store, config, undefined, () => now, { apple: { verifyIdentityToken: async input => ({ subject: input.identityToken }) } });
  const people: DevicePrincipal[] = [];
  for (let index = 0; index < 3; index++) {
    const account = await service.signInWithApple({ identityToken: "synthetic-apple-" + index, nonce: "synthetic" });
    const session = await service.bootstrap(service.authenticateToken(account.sessionToken), {
      deviceInstanceId: randomUUID(), companionPairId: randomUUID(), deviceKind: "IPHONE",
      agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"] as const)
        .map(kind => ({ kind, version: "2.0", acceptedAt: now.toISOString() })),
      capabilities: { locationAuthorized: true, notificationAuthorized: true },
      availableForResponse: true
    }, "synthetic");
    const principal = service.authenticateToken(session.sessionToken);
    assert.equal(principal.kind, "DEVICE");
    if (principal.kind !== "DEVICE") throw new Error("Expected device");
    people.push(principal);
    await service.updateResponderPosition(principal, {
      positionUpdateId: randomUUID(), observedAt: now.toISOString(),
      responderPosition: { kind: "R", latitude: 0.001 * index, longitude: 0, accuracyMeters: 5 }
    });
  }
  const [patient, responder, outsider] = people as [DevicePrincipal, DevicePrincipal, DevicePrincipal];
  const input = {
    observationKind: "SIMULATED_TEST", runId: randomUUID(), requestedAt: now.toISOString(),
    patientUserId: patient.userId!, patientDeviceId: patient.deviceInstanceId,
    responderUserId: responder.userId!, responderDeviceId: responder.deviceInstanceId
  };
  const disabled = new AEDResponseService(store, { ...config, enableSimulatedEvents: false }, undefined, () => now);
  await assert.rejects(disabled.createSimulatedEvent(input));
  assert.equal(simulationObservationSchema.safeParse({ ...input, fallDetectedAt: now.toISOString() }).success, false);
  await assert.rejects(service.createSimulatedEvent({ ...input, responderUserId: input.patientUserId }));
  await assert.rejects(service.createSimulatedEvent(input), /ready/);
  config.simulationAppleDeviceIds.push(input.patientDeviceId, input.responderDeviceId);
  await assert.rejects(service.createSimulatedEvent({ ...input, responderUserId: outsider.userId!, responderDeviceId: outsider.deviceInstanceId }));
  const created = await service.createSimulatedEvent(input);
  assert.equal(created.simulated, true);
  assert.equal((await service.createSimulatedEvent(input)).replayed, true);
  await assert.rejects(service.createSimulatedEvent({ ...input, runId: randomUUID() }));
  const view = service.getEvent(patient, input.runId);
  assert.equal(view.viewerRelationship, "PATIENT");
  assert.ok("triggerSource" in view);
  assert.equal(view.triggerSource, "SIMULATED_TEST");
  assert.deepEqual(view.simulation, { runId: input.runId, label: "SIMULATED_TEST" });
  assert.equal(view.fallDetectedAt, null);
  assert.equal(view.callFirstObservedAt, null);
  assert.throws(() => service.getEvent(outsider, input.runId));
  const deliveries = store.read(s => Object.values(s.deliveries));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.deviceInstanceId, responder.deviceInstanceId);
  assert.deepEqual(deliveries[0]!.request.simulation, { runId: input.runId, label: "SIMULATED_TEST" });
  assert.equal(store.read(s => s.events[input.runId]!.triggeringWatchDeviceId), undefined);
  await assert.rejects(store.transact(s => { delete s.events[input.runId]; }));
  await assert.rejects(store.transact(s => {
    s.events[input.runId]!.observation = { ...simulationObservationSchema.parse(input), responderDeviceId: outsider.deviceInstanceId };
  }));
  await store.close();
  store = await SQLiteStateStore.open(path, []);
  t.after(() => store.close());
  service = new AEDResponseService(store, config, undefined, () => now);
  assert.equal(store.read(s => s.events[input.runId]!.observation.observationKind), "SIMULATED_TEST");
  now = new Date(now.getTime() + 1000);
  await service.respond(responder, input.runId, deliveries[0]!.id, { decision: "ACCEPT", decidedAt: now.toISOString() });
  const tasks = store.read(s => Object.values(s.assignments));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.role, "GO_TO_PATIENT");
  assert.equal(tasks[0]!.deviceInstanceId, responder.deviceInstanceId);
});

test("live private IPC delivers real Socket messages and reconnect replays only unexpired offers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "aed-live-ipc-"));
  let now = new Date();
  const socketPath = join(dir, "admin.sock");
  const store = await SQLiteStateStore.open(join(dir, "state.sqlite"), []);
  const backend = await createBackend({ store, now: () => now, config: {
    ...loadConfig({}), host: "127.0.0.1", port: 0, authSubjectPepper: "synthetic-live-pepper",
    enableControlledTestAccounts: true, enableSimulatedEvents: true, simulationAdminSocket: socketPath
  } });
  await backend.start();
  const sockets: Socket[] = [];
  t.after(async () => { sockets.forEach(s => s.disconnect()); await backend.stop(); await rm(dir, { recursive: true, force: true }); });
  const identities: { deviceId: string; userId: string; token: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const account = await backend.service.provisionControlledTestAccount("live-test-" + i);
    const deviceId = randomUUID();
    const session = await backend.service.bootstrap(backend.service.authenticateToken(account.sessionToken), {
      deviceInstanceId: deviceId, companionPairId: randomUUID(), deviceKind: "IPHONE",
      agreementAcceptances: (["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"] as const)
        .map(kind => ({ kind, version: "2.0", acceptedAt: now.toISOString() })),
      capabilities: { locationAuthorized: true, notificationAuthorized: true }, availableForResponse: true
    }, "synthetic-live");
    await backend.service.updateResponderPosition(backend.service.authenticateToken(session.sessionToken), {
      positionUpdateId: randomUUID(), observedAt: now.toISOString(),
      responderPosition: { kind: "R", latitude: i * 0.001, longitude: 0, accuracyMeters: 5 }
    });
    identities.push({ deviceId, userId: account.userId, token: session.sessionToken });
  }
  function socketFor(token: string) {
    const socket = io(backend.baseURL(), { autoConnect: false, transports: ["websocket"], reconnection: false,
      extraHeaders: { Authorization: `Bearer ${token}` } });
    sockets.push(socket);
    return socket;
  }
  function next(socket: Socket, event: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off(event, received); reject(new Error("Missing " + event)); }, 3000);
      function received(value: unknown) { clearTimeout(timer); resolve(value); }
      socket.once(event, received);
    });
  }
  const patient = identities[0]!;
  const responder = identities[1]!;
  const patientSocket = socketFor(patient.token);
  const responderSocket = socketFor(responder.token);
  const readiness = Promise.all([next(patientSocket, "system:ready"), next(responderSocket, "system:ready")]);
  patientSocket.connect(); responderSocket.connect(); await readiness;
  const activated = next(patientSocket, "event:patient-activated");
  const offered = next(responderSocket, "response:requested");
  const runId = randomUUID();
  const input = { observationKind: "SIMULATED_TEST", runId, requestedAt: now.toISOString(),
    patientUserId: patient.userId, patientDeviceId: patient.deviceId,
    responderUserId: responder.userId, responderDeviceId: responder.deviceId };
  const answer = await new Promise<string>((resolve, reject) => {
    const client = createConnection(socketPath);
    client.setTimeout(3000, () => { client.destroy(); reject(new Error("IPC timeout")); });
    client.once("error", reject);
    let response = "";
    client.once("connect", () => client.write(JSON.stringify(input) + "\n"));
    client.on("data", data => { response += data.toString(); if (response.includes("\n")) { client.destroy(); resolve(response); } });
  });
  assert.equal(JSON.parse(answer).ok, true);
  assert.equal((await activated).eventId, runId);
  const first = await offered;
  assert.equal(first.eventId, runId);
  assert.equal(first.simulation.label, "SIMULATED_TEST");
  assert.equal(store.read(s => Object.values(s.deliveries)[0]!.status), "SENT", "Emission alone is not a delivery receipt");
  let repeatCount = 0;
  responderSocket.on("response:requested", () => repeatCount++);
  now = new Date(now.getTime() + 4000);
  await backend.service.tick();
  assert.equal(repeatCount, 0);
  now = new Date(now.getTime() + 1000);
  const retry = next(responderSocket, "response:requested");
  await backend.service.tick();
  const retryOffer = await retry;
  assert.equal(retryOffer.deliveryId, first.deliveryId);
  assert.equal(retryOffer.expiresAt, first.expiresAt);
  responderSocket.disconnect();
  const reconnect = socketFor(responder.token);
  const repeated = next(reconnect, "response:requested");
  reconnect.connect();
  assert.equal((await repeated).deliveryId, first.deliveryId);
  reconnect.disconnect();
  now = new Date(now.getTime() + 31_000);
  const expired = socketFor(responder.token);
  let replayed = 0;
  expired.on("response:requested", () => replayed++);
  const ready = next(expired, "system:ready"); expired.connect(); await ready;
  assert.equal(replayed, 0, "Reconnect must not revive expired offers");
});

test("private simulation IPC cannot be enabled implicitly or with an unsafe path", () => {
  assert.equal(loadConfig({}).simulationAdminSocket, undefined);
  assert.equal(loadConfig({}).enableSimulatedEvents, undefined);
  assert.throws(() => loadConfig({ AED_SIMULATION_ADMIN_SOCKET: "/run/aedresponse/admin.sock" }));
  assert.throws(() => loadConfig({ AED_ENABLE_CONTROLLED_TEST_ACCOUNTS: "true", AED_SIMULATION_ADMIN_SOCKET: "relative.sock" }));
  assert.equal(loadConfig({ AED_ENABLE_CONTROLLED_TEST_ACCOUNTS: "true", AED_SIMULATION_ADMIN_SOCKET: "/run/aedresponse/admin.sock" }).enableSimulatedEvents, true);
});
