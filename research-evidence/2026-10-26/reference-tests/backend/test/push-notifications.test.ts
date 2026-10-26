/**
 * G04 — system push: token lifecycle, provider handoff, and the honest gap
 * between "APNs accepted" and "the user knows".
 *
 * Three facts exist along a push path and this file keeps them apart:
 *
 *   1. the provider accepted the request (observable here);
 *   2. the system presented it (device-side);
 *   3. the user opened it and the app reached REST truth (device + REST).
 *
 * What the backend owes is (1) plus a durable record of the attempt, and the
 * refusal to claim more.  These tests therefore assert the attempt records and
 * the payload discipline, and they assert that a tap resolves through REST
 * instead of acting on the push body.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHTTP2Server } from "node:http2";
import { apnsHTTP2Post } from "../src/apns-http2.js";
import { pushPresentationFor } from "../src/push-presentation.js";
import type { BackendConfig } from "../src/config.js";
import type { Aed, PatientPosition, WatchEmergencyObservation } from "../src/contracts.js";
import { emptyState } from "../src/models.js";
import { readEntities } from "../src/state-read.js";
import {
  ApnsPushProvider,
  apnsCredentialsFromEnvironment,
  apnsHostFor,
  pushIsAudible,
  pushOutcomeForStatus,
  pushPayloadFor,
  type PushDeliveryOutcome,
  type PushDeliveryRequest,
  type PushProvider
} from "../src/push-provider.js";
import { AEDResponseService, type DevicePrincipal } from "../src/service.js";
import { MemoryStateStore } from "../src/store.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";
const PATIENT_POSITION: PatientPosition = {
  kind: "P", latitude: 22.1987, longitude: 113.5439, accuracyMeters: 10
};
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const BUNDLE = "dev.codex.aedresponse";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (seconds: number): string =>
  new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();

const inventory: Aed[] = [{
  id: "push-aed",
  name: "Push AED",
  aedPosition: { kind: "A", latitude: 22.1991, longitude: 113.5439, accuracyMeters: 5 },
  openFrom: "00:00",
  openUntil: "00:00",
  floor: "1F",
  floorTransferSeconds: 0,
  accessNote: "lobby",
  accessDelaySeconds: 0,
  verificationSeconds: 0,
  available: true
}];

const config: BackendConfig = {
  host: "127.0.0.1",
  port: 0,
  dataFile: "unused-memory-store.json",
  fixtureFile: "unused-in-memory-fixture.json",
  sessionTtlSeconds: 3_600,
  nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600,
  maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50,
  bootstrapLimitPerMinute: 100,
  production: false
};

/** Records every handoff and can be told to reject a token like APNs would. */
class RecordingPushProvider implements PushProvider {
  readonly name = "recording";
  readonly sent: PushDeliveryRequest[] = [];
  readonly payloads: Record<string, unknown>[] = [];
  invalidTokens = new Set<string>();
  configured = true;

  isConfigured(): boolean {
    return this.configured;
  }

  async send(request: PushDeliveryRequest): Promise<PushDeliveryOutcome> {
    this.sent.push(request);
    this.payloads.push(pushPayloadFor(request));
    if (this.invalidTokens.has(request.token)) {
      return { status: "INVALID_TOKEN", reason: "UNREGISTERED" };
    }
    return { status: "DELIVERED" };
  }
}

async function bootstrap(
  service: AEDResponseService,
  deviceInstanceId: string,
  deviceKind: "IPHONE" | "WATCH",
  companionPairId: string
): Promise<DevicePrincipal> {
  const result = await service.bootstrap({
    deviceInstanceId,
    deviceKind,
    companionPairId,
    ...(deviceKind === "IPHONE" ? {
      agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
        "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
          kind, version: "2.0", acceptedAt: BASE_TIME
        })),
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    } : {})
  } as never, `synthetic:${deviceInstanceId}`);
  const principal = service.authenticateToken(result.sessionToken);
  assert.equal(principal.kind, "DEVICE");
  if (principal.kind !== "DEVICE") throw new Error("Synthetic device principal required");
  return principal;
}

function makeHarness(socketDelivered = false) {
  let now = new Date(BASE_TIME);
  const store = new MemoryStateStore(emptyState(inventory));
  const push = new RecordingPushProvider();
  const service = new AEDResponseService(store, config, {
    emitToDevices(devices) { return socketDelivered ? [...devices] : []; }
  }, () => now, {}, undefined, push);
  return {
    service,
    store,
    push,
    setNow(seconds: number) { now = new Date(at(seconds)); },
    registrationOf(deviceInstanceId: string) {
      return store.read(state => state.devices[deviceInstanceId]?.pushRegistration);
    }
  };
}

type Harness = ReturnType<typeof makeHarness>;

async function register(harness: Harness, principal: DevicePrincipal, token = TOKEN_A) {
  return harness.service.registerPushToken(principal, {
    pushToken: token,
    pushEnvironment: "SANDBOX",
    bundleId: BUNDLE
  });
}

test("push registration replaces the token of the calling device only", async () => {
  const harness = makeHarness();
  const first = await bootstrap(harness.service, uuid(1), "IPHONE", uuid(2));
  const second = await bootstrap(harness.service, uuid(3), "IPHONE", uuid(4));

  const registered = await register(harness, first);
  assert.equal(registered.environment, "SANDBOX");
  assert.equal(harness.registrationOf(uuid(1))?.token, TOKEN_A);

  // A newer token for the same installation replaces the old one.
  await register(harness, first, TOKEN_B);
  assert.equal(harness.registrationOf(uuid(1))?.token, TOKEN_B);
  assert.equal(harness.registrationOf(uuid(1))?.bundleId, BUNDLE);
  assert.equal(harness.registrationOf(uuid(3)), undefined,
    "registering for one device must not touch another");

  // One token addresses one installation: the second device claiming it takes
  // it over, and the first stops being a push target.
  await register(harness, second, TOKEN_B);
  assert.equal(harness.registrationOf(uuid(3))?.token, TOKEN_B);
  assert.equal(harness.registrationOf(uuid(1)), undefined,
    "a token may only be bound to one installation at a time");

  // The token is a routing credential and is never returned.
  const serialized = JSON.stringify(await first);
  assert.equal(serialized.includes(TOKEN_B), false);
});

test("push registration rejects malformed tokens and unbound devices", async () => {
  const harness = makeHarness();
  const principal = await bootstrap(harness.service, uuid(10), "IPHONE", uuid(11));
  await assert.rejects(
    harness.service.registerPushToken(principal, {
      pushToken: "not-hex!", pushEnvironment: "SANDBOX", bundleId: BUNDLE
    }),
    /APNs hex token/
  );
  await assert.rejects(
    harness.service.registerPushToken(principal, {
      pushToken: TOKEN_A, pushEnvironment: "DEVELOPMENT", bundleId: BUNDLE
    }),
    /SANDBOX or PRODUCTION/
  );
  await assert.rejects(
    harness.service.registerPushToken(principal, {
      pushToken: TOKEN_A, pushEnvironment: "SANDBOX", bundleId: "  "
    }),
    /bundleId is invalid/
  );
});

test("sign-out clears the push registration so the phone stops receiving that account", async () => {
  const harness = makeHarness();
  const principal = await bootstrap(harness.service, uuid(20), "IPHONE", uuid(21));
  await register(harness, principal);
  assert.ok(harness.registrationOf(uuid(20)));

  await harness.service.logout(principal);
  assert.equal(harness.registrationOf(uuid(20)), undefined,
    "退出登录后同一台手机不得继续收到该账号的推送");
});

test("unregistering is idempotent and leaves other devices alone", async () => {
  const harness = makeHarness();
  const first = await bootstrap(harness.service, uuid(30), "IPHONE", uuid(31));
  const second = await bootstrap(harness.service, uuid(32), "IPHONE", uuid(33));
  await register(harness, first, TOKEN_A);
  await register(harness, second, TOKEN_B);

  assert.deepEqual(await harness.service.unregisterPushToken(first), { removed: true });
  assert.deepEqual(await harness.service.unregisterPushToken(first), { removed: false });
  assert.equal(harness.registrationOf(uuid(32))?.token, TOKEN_B);
});

/** Runs one event up to a response offer so the outbox has real work. */
async function eventWithOffer(harness: Harness) {
  const pairId = uuid(100);
  const patient = await bootstrap(harness.service, uuid(101), "IPHONE", pairId);
  const watch = await bootstrap(harness.service, uuid(102), "WATCH", pairId);
  const responder = await bootstrap(harness.service, uuid(103), "IPHONE", uuid(104));
  await harness.service.updateResponderPosition(responder, {
    positionUpdateId: uuid(105),
    observedAt: BASE_TIME,
    responderPosition: {
      kind: "R",
      latitude: PATIENT_POSITION.latitude + 0.001,
      longitude: PATIENT_POSITION.longitude,
      accuracyMeters: 10
    }
  });
  await register(harness, patient, TOKEN_A);
  await register(harness, responder, TOKEN_B);
  harness.setNow(1);
  const eventId = uuid(200);
  const observation: WatchEmergencyObservation = {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: at(1),
    patientPositionObservedAt: at(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition: PATIENT_POSITION
  };
  await harness.service.reportWatchObservation(watch, eventId, observation);
  await harness.service.flushNotificationPushes();
  return { patient, responder, eventId };
}

test("an outbox drain hands notifications to APNs and records the attempt", async () => {
  const harness = makeHarness();
  const { eventId } = await eventWithOffer(harness);
  const sent = harness.push.sent;
  assert.ok(sent.length > 0, "the offer must reach the push provider");
  assert.equal(sent.every(request => request.bundleId === BUNDLE), true);
  assert.equal(sent.every(request => request.environment === "SANDBOX"), true);
  assert.equal(sent.every(request => request.eventId === eventId), true);

  // The push body is opaque: identifiers and a generic sentence only.
  for (const payload of harness.push.payloads) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("22.19"), false, "坐标不得出现在推送正文里");
    assert.equal(serialized.includes("安全测试地点"), false, "地址不得出现在推送正文里");
    assert.match(serialized, /"eventId"/);
    assert.match(serialized, /"messageId"/);
  }

  // And the attempt is durably recorded, separately from the socket outcome.
  const rows = harness.store.read(state => Object.values(state.notificationOutboxById));
  const pushed = rows.filter(row => row.push !== undefined);
  assert.ok(pushed.length > 0, "every push attempt must leave a durable record");
  assert.equal(pushed.every(row => ["DELIVERED", "SUPPRESSED"].includes(row.push!.status)), true);
  assert.equal(pushed.filter(row => ["response:requested", "event:patient-activated"].includes(row.name))
    .every(row => row.push!.status === "DELIVERED"), true);
  assert.equal(pushed.every(row => row.push!.attempts >= 1), true);
});

test("a token APNs rejects is forgotten instead of retried forever", async () => {
  const harness = makeHarness();
  harness.push.invalidTokens.add(TOKEN_B);
  await eventWithOffer(harness);

  assert.equal(harness.registrationOf(uuid(103)), undefined,
    "被 APNs 判定失效的 token 必须立即解绑");
  assert.equal(harness.registrationOf(uuid(101))?.token, TOKEN_A,
    "另一台设备的注册不受影响");
  const rejected = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => row.push?.status === "INVALID_TOKEN"));
  assert.ok(rejected.length > 0);
  assert.equal(rejected.every(row => row.push!.reason === "UNREGISTERED"), true);
});

test("without provider credentials the attempt is recorded as not delivered", async () => {
  const harness = makeHarness();
  harness.push.configured = false;
  await eventWithOffer(harness);

  assert.equal(harness.push.sent.length, 0, "未配置凭据时不得声称已投递");
  const rows = harness.store.read(state => Object.values(state.notificationOutboxById));
  const attempted = rows.filter(row => row.push !== undefined);
  assert.ok(attempted.length > 0, "仍必须留下可诊断的尝试记录");
  assert.equal(attempted.every(row => row.push!.status === "PENDING"), true);
  assert.equal(attempted.every(row => row.push!.reason === "PROVIDER_UNAVAILABLE"), true);
});

test("a device without a push registration is socket-only, not an error", async () => {
  const harness = makeHarness();
  const { responder, patient, eventId } = await eventWithOffer(harness);
  await harness.service.unregisterPushToken(responder);
  const before = new Set(harness.store.read(state =>
    Object.keys(state.notificationOutboxById)));

  // The offer is accepted, which fans out new coordination notifications.  The
  // unregistered device must be skipped (recorded as NOT_REGISTERED) rather than
  // reported as a delivery failure, and the drain must still succeed.
  const delivery = harness.store.read(state => Object.values(state.deliveries)
    .find(row => row.eventId === eventId
      && row.deviceInstanceId === responder.deviceInstanceId));
  assert.ok(delivery);
  await harness.service.respond(responder, eventId, delivery.id, {
    decision: "ACCEPT", decidedAt: at(5)
  });
  await harness.service.flushNotificationPushes();

  const created = harness.store.read(state => Object.values(state.notificationOutboxById)
    .filter(row => !before.has(row.id)));
  assert.ok(created.length > 0, "接受响应后必须产生新的通知");
  const forResponder = created.filter(row =>
    row.recipient.deviceInstanceId === responder.deviceInstanceId);
  assert.equal(forResponder.length > 0, true);
  assert.equal(forResponder.every(row => ["NOT_REGISTERED", "SUPPRESSED"].includes(row.push?.status ?? "")), true,
    "没有推送注册的设备按 socket-only 处理，并留下可诊断记录");
  const forPatient = created.filter(row =>
    row.recipient.deviceInstanceId === patient.deviceInstanceId);
  assert.equal(forPatient.every(row => ["DELIVERED", "SUPPRESSED"].includes(row.push?.status ?? "")), true,
    "同一批次里其他设备的推送不受影响");
});

test("APNs retry survives successful socket handoff and does not alert again on socket retries", async () => {
  const h = makeHarness(true);
  h.push.configured = false;
  await eventWithOffer(h);
  const initial = h.store.read(state => Object.values(state.notificationOutboxById)
    .find(row => row.name === "event:patient-activated")!);
  assert.equal(initial.status, "DISPATCHED");
  assert.equal(initial.push?.status, "PENDING");
  h.push.configured = true;
  h.setNow(3);
  await h.service.tick();
  await h.service.flushNotificationPushes();
  const after = h.store.read(state => state.notificationOutboxById[initial.id]!);
  assert.equal(after.push?.status, "DELIVERED");
  const count = h.push.sent.filter(row => row.name === "event:patient-activated").length;
  h.setNow(10);
  await h.service.tick();
  await h.service.flushNotificationPushes();
  assert.equal(h.push.sent.filter(row => row.name === "event:patient-activated").length, count);
});

test("the default APNs adapter actually speaks HTTP/2", async t => {
  const server = createHTTP2Server();
  let requestHeaders: Record<string, unknown> | undefined, body = "";
  server.on("stream", (stream, headers) => {
    requestHeaders = headers;
    stream.setEncoding("utf8");
    stream.on("data", chunk => { body += chunk; });
    stream.on("end", () => { stream.respond({ ":status": 200 }); stream.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await apnsHTTP2Post(`http://127.0.0.1:${address.port}/3/device/synthetic`, {
    method: "POST", headers: { "apns-topic": BUNDLE }, body: '{"aps":{"alert":"synthetic"}}'
  });
  assert.equal(result.status, 200);
  assert.equal(requestHeaders?.[":method"], "POST");
  assert.equal(requestHeaders?.[":path"], "/3/device/synthetic");
  assert.equal(body, '{"aps":{"alert":"synthetic"}}');
});

test("lock-screen content is phase-aware, private and not a position-tick alert", () => {
  assert.equal(pushPresentationFor({ name: "event:patient-position-updated", payload: {} }, true), undefined);
  const accepted = pushPresentationFor({ name: "event:coordination-updated",
    payload: { coordination: { acceptedResponderCount: 1 } } }, true)!;
  assert.equal(accepted.title, "已有响应者接单");
  assert.equal(accepted.timeSensitive, false);
  const empty = { name: "event:coordination-updated" as const, payload: { coordination: { acceptedResponderCount: 0 } } };
  assert.equal(pushPresentationFor(empty, true, false, "accepted")?.phase, "searching-again");
  assert.equal(pushPresentationFor(empty, true, false, "confirmation")?.phase, "searching");
  assert.equal(pushPresentationFor(empty, false), undefined);
  const payload = pushPayloadFor({ token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
    messageId: "m", eventId: "e", name: "response:requested", audible: true });
  assert.equal((payload.aps as Record<string, unknown>)["interruption-level"], "time-sensitive");
});

test("every push presentation works across lock screens, banners and notification center", () => {
  type PresentationCase = {
    name: Parameters<typeof pushPresentationFor>[0]["name"];
    coordination?: Record<string, number>;
    aedArrived?: boolean;
    previousPhase?: string;
    expected: NonNullable<ReturnType<typeof pushPresentationFor>>;
  };
  const cases: PresentationCase[] = [
    { name: "event:patient-activated", expected: {
      phase: "searching", title: "救助已发起", body: "正在寻找附近响应者", timeSensitive: true } },
    { name: "response:requested", expected: {
      phase: "offer", title: "附近有人需要帮助", body: "轻点查看并决定是否响应", timeSensitive: true } },
    { name: "event:status-confirmation-requested", expected: {
      phase: "confirmation", title: "请确认救助进展", body: "轻点查看并确认救助是否仍在进行", timeSensitive: true } },
    { name: "assignment:created", expected: {
      phase: "assigned", title: "救助任务已分配", body: "轻点查看任务与导航", timeSensitive: true } },
    { name: "assignment:reroute-proposed", expected: {
      phase: "reroute", title: "有新的 AED 路线建议", body: "轻点查看并确认路线", timeSensitive: true } },
    { name: "event:resolved", expected: {
      phase: "resolved", title: "救助已结束", body: "轻点查看处理结果", timeSensitive: false } },
    { name: "event:false-alarm-confirmed", expected: {
      phase: "false-alarm", title: "已确认误报", body: "本次救助已取消", timeSensitive: false } },
    { name: "event:assistance-withdrawn", expected: {
      phase: "withdrawn", title: "求助已撤回", body: "本次救助已停止", timeSensitive: false } },
    { name: "event:closed-unconfirmed-no-response", expected: {
      phase: "closed-unconfirmed", title: "救助已关闭", body: "未收到状态确认，轻点查看详情", timeSensitive: true } },
    { name: "aed:unavailable", expected: {
      phase: "aed-unavailable", title: "AED 暂不可用", body: "正在重新安排救助任务", timeSensitive: true } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 1 }, aedArrived: true,
      expected: { phase: "aed-arrived", title: "AED 已送达", body: "响应者已确认到达患者处", timeSensitive: false } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 1, arrivedAtPatientCount: 1 },
      expected: { phase: "arrived", title: "响应者已到达", body: "轻点查看最新救助进展", timeSensitive: false } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 1, completedAssignmentCount: 1 },
      expected: { phase: "arrived", title: "响应者已到达", body: "轻点查看最新救助进展", timeSensitive: false } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 1, aedAcquiredCount: 1 },
      expected: { phase: "aed-acquired", title: "响应者已取得 AED", body: "正在继续救助任务", timeSensitive: false } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 1, fetchAedCount: 1 },
      expected: { phase: "fetching-aed", title: "响应者正在获取 AED", body: "轻点查看最新进展", timeSensitive: false } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 1 },
      expected: { phase: "accepted", title: "已有响应者接单", body: "轻点查看最新进展", timeSensitive: false } },
    { name: "event:coordination-updated", coordination: { acceptedResponderCount: 0 },
      expected: { phase: "searching", title: "救助已发起", body: "正在寻找附近响应者", timeSensitive: true } }
  ];
  for (const previousPhase of ["accepted", "fetching-aed", "aed-acquired", "arrived", "aed-arrived", "searching-again"]) {
    cases.push({ name: "event:coordination-updated", coordination: { acceptedResponderCount: 0 }, previousPhase,
      expected: { phase: "searching-again", title: "正在重新寻找响应者", body: "原响应者已无法继续参与", timeSensitive: true } });
  }
  for (const scenario of cases) {
    const row = { name: scenario.name, payload: {
      coordination: scenario.coordination,
      title: "private-client-title", body: "private-client-body",
      patientName: "private-patient-name", location: "private-location", route: "private-route"
    } };
    const presentation = pushPresentationFor(row, true, scenario.aedArrived, scenario.previousPhase);
    const label = `${scenario.name}/${scenario.expected.phase}/${scenario.previousPhase ?? "initial"}`;
    assert.deepEqual(presentation, scenario.expected, label);
    assert.doesNotMatch(presentation!.title + presentation!.body, /解锁|private-/, label);
    for (const simulation of [false, true]) {
      const payload = pushPayloadFor({ token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
        messageId: "m", eventId: "e", name: scenario.name, audible: presentation!.timeSensitive,
        presentation: presentation!, simulation });
      const aps = payload.aps as Record<string, unknown>;
      assert.deepEqual(aps.alert, { title: scenario.expected.title,
        ...(simulation ? { subtitle: "模拟测试" } : {}), body: scenario.expected.body }, label);
      assert.equal(aps["interruption-level"], scenario.expected.timeSensitive ? "time-sensitive" : "active", label);
      assert.equal(payload.name, scenario.name, label);
      assert.doesNotMatch(JSON.stringify(payload), /private-/, label);
      assert.equal(JSON.stringify(payload).includes(TOKEN_A), false, label);
    }
  }
});

test("only emergency-class notifications are allowed to make a sound", () => {
  assert.equal(pushIsAudible("response:requested"), true);
  assert.equal(pushIsAudible("event:patient-activated"), true);
  assert.equal(pushIsAudible("event:status-confirmation-requested"), true);
  assert.equal(pushIsAudible("event:resolved"), true);
  assert.equal(pushIsAudible("event:coordination-updated"), false);
  assert.equal(pushIsAudible("event:patient-position-updated"), false);
  assert.equal(pushIsAudible("assignment:updated"), false);

  const audible = pushPayloadFor({
    token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
    messageId: "m", eventId: "e", name: "response:requested", audible: true
  });
  assert.deepEqual((audible.aps as Record<string, unknown>).sound, "default");
  const silent = pushPayloadFor({
    token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
    messageId: "m", eventId: "e", name: "event:coordination-updated", audible: false
  });
  assert.equal("sound" in (silent.aps as Record<string, unknown>), false);
});

test("a notification tap resolves through REST truth, not the push body", async () => {
  const harness = makeHarness();
  const { patient, responder, eventId } = await eventWithOffer(harness);
  const messageId = harness.store.read(state =>
    Object.values(state.notificationOutboxById)
      .find(row => row.eventId === eventId
        && row.name === "response:requested"
        && row.recipient.deviceInstanceId === responder.deviceInstanceId)!.id);

  const route = harness.service.notificationRoute(responder, messageId);
  assert.equal(route.eventId, eventId);
  assert.equal(route.name, "response:requested");
  assert.equal(route.eventState, "ACTIVE");
  assert.equal(route.actionable, true,
    "活跃事件才可操作；客户端必须先取 REST 真值再打开");

  // An unknown identifier is not an error: there is simply nothing to open.
  assert.deepEqual(harness.service.notificationRoute(patient, "does-not-exist"), {
    messageId: "does-not-exist", eventId: null, name: null, eventState: null, actionable: false
  });

  // Another device may not resolve this notification, even the patient's own.
  assert.throws(() => harness.service.notificationRoute(patient, messageId),
    /does not belong to this device session/);

  // After the event ends the same notification must stop being actionable, so a
  // late tap cannot accept an expired offer.
  await harness.service.endEvent(patient, eventId, {
    resolutionId: uuid(400), reason: "PROBLEM_RESOLVED", endedAt: at(30)
  });
  const afterwards = harness.service.notificationRoute(responder, messageId);
  assert.equal(afterwards.eventState, "RESOLVED");
  assert.equal(afterwards.actionable, false);
});

test("the stored push credential never reaches a client-visible projection", async () => {
  const harness = makeHarness();
  const principal = await bootstrap(harness.service, uuid(500), "IPHONE", uuid(501));
  await register(harness, principal);

  const presence = await harness.service.getPresence(principal);
  assert.equal(JSON.stringify(presence).includes(TOKEN_A), false);
  const events = harness.service.listEvents(principal);
  assert.equal(JSON.stringify(events).includes(TOKEN_A), false);
  const stored = readEntities(harness.store, view => view.get("devices", uuid(500)));
  assert.equal((stored as { pushRegistration?: { token: string } }).pushRegistration?.token,
    TOKEN_A, "但服务端必须保存它才能推送");
});

test("APNs credentials are accepted only as a complete, well-formed set", () => {
  const complete = {
    AED_APNS_KEY_ID: "ABCDE12345",
    AED_APNS_TEAM_ID: "TEAM123456",
    AED_APNS_KEY_PATH: "/etc/aedresponse/AuthKey.p8",
    AED_APNS_BUNDLE_ID: "dev.codex.aedresponse",
    AED_APNS_ENVIRONMENT: "PRODUCTION"
  };
  const configured = apnsCredentialsFromEnvironment(complete);
  assert.deepEqual(configured.problems, []);
  assert.equal(configured.credentials?.defaultEnvironment, "PRODUCTION");
  assert.equal(apnsHostFor("PRODUCTION"), "https://api.push.apple.com");
  assert.equal(apnsHostFor("SANDBOX"), "https://api.sandbox.push.apple.com");

  // Nothing configured is not an error: push is simply off.
  assert.deepEqual(apnsCredentialsFromEnvironment({}), { problems: [] });

  // A half-configured provider would look enabled and fail every send.
  const partial = apnsCredentialsFromEnvironment({ AED_APNS_KEY_ID: "ABCDE12345" });
  assert.match(partial.problems.join(" "), /凭据不完整/);
  assert.equal(partial.credentials, undefined);

  const malformed = apnsCredentialsFromEnvironment({
    ...complete, AED_APNS_KEY_ID: "short", AED_APNS_ENVIRONMENT: "DEV"
  });
  assert.equal(malformed.problems.length, 2);
  assert.equal(malformed.credentials, undefined);
});

test("APNs responses map onto delivery, retry and forget-this-token", () => {
  assert.deepEqual(pushOutcomeForStatus(200, ""), { status: "DELIVERED" });
  assert.deepEqual(pushOutcomeForStatus(410, '{"reason":"Unregistered"}'),
    { status: "INVALID_TOKEN", reason: "UNREGISTERED" });
  assert.deepEqual(pushOutcomeForStatus(400, '{"reason":"BadDeviceToken"}'),
    { status: "INVALID_TOKEN", reason: "BAD_DEVICE_TOKEN" });
  assert.deepEqual(pushOutcomeForStatus(413, '{"reason":"PayloadTooLarge"}'),
    { status: "PERMANENT", reason: "PAYLOAD_TOO_LARGE" });
  assert.deepEqual(pushOutcomeForStatus(429, ""), { status: "RETRY", reason: "RATE_LIMITED" });
  assert.deepEqual(pushOutcomeForStatus(503, ""), { status: "RETRY", reason: "TRANSPORT" });
  // An unknown 4xx is permanent: retrying it forever would hide a real defect.
  assert.deepEqual(pushOutcomeForStatus(400, ""), { status: "PERMANENT", reason: "UNKNOWN" });
});

test("the APNs client signs a provider token and posts the opaque payload", async () => {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const provider = new ApnsPushProvider(
    {
      keyId: "ABCDE12345", teamId: "[TEAM]", keyPath: "/unused.p8",
      bundleId: BUNDLE, defaultEnvironment: "SANDBOX"
    },
    async () => "[REDACTED PRIVATE KEY]",
    (async (url: string | URL, init: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body)
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
    async input => `jwt-for-${input.keyId}-${input.teamId}`,
    () => new Date(BASE_TIME)
  );

  const outcome = await provider.send({
    token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
    messageId: "message-1", eventId: "event-1",
    name: "response:requested", audible: true
  });
  assert.deepEqual(outcome, { status: "DELIVERED" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, `https://api.sandbox.push.apple.com/3/device/${TOKEN_A}`);
  assert.equal(requests[0]!.headers.authorization, "Bearer [REDACTED]");
  assert.equal(requests[0]!.headers["apns-topic"], BUNDLE);
  assert.equal(requests[0]!.headers["apns-priority"], "10");
  assert.equal(requests[0]!.headers["apns-collapse-id"], "event-1");
  assert.equal(requests[0]!.body.includes(TOKEN_A), false, "token 不得出现在正文里");

  // A silent coordination update must not be sent at emergency priority.
  await provider.send({
    token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
    messageId: "message-2", eventId: "event-1",
    name: "event:coordination-updated", audible: false
  });
  assert.equal(requests[1]!.headers["apns-priority"], "5");
  assert.equal(requests[1]!.body.includes("\"sound\""), false);
});

test("an unreadable APNs key is an operator problem, not a lost notification", async () => {
  const provider = new ApnsPushProvider(
    {
      keyId: "ABCDE12345", teamId: "[TEAM]", keyPath: "/missing.p8",
      bundleId: BUNDLE, defaultEnvironment: "SANDBOX"
    },
    async () => { throw new Error("ENOENT"); },
    (async () => new Response("", { status: 200 })) as unknown as typeof fetch
  );
  assert.deepEqual(
    await provider.send({
      token: TOKEN_A, environment: "SANDBOX", bundleId: BUNDLE,
      messageId: "m", eventId: "e", name: "response:requested", audible: true
    }),
    { status: "RETRY", reason: "PROVIDER_UNAVAILABLE" },
    "密钥不可读时必须保留重试，而不是把通知标记为已投递"
  );
});
