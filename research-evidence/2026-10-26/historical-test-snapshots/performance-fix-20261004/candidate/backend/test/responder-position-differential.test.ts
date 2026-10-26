/**
 * Full-command Legacy ↔ entity-transaction differential. Both sides run the real
 * updateResponderPosition, including receipt retention, response construction and
 * outbox drain. The Legacy side hides only transactEntities, keeping the original
 * whole-state branch as an independent position applier / recruitment adapter.
 *
 * The no-relevance case is asserted separately: hiding the capability there would
 * select the old capability fallback, whose recruitment scope was always broader
 * than the old supported, irrelevant-position route.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import type { ResponderPositionUpdate } from "../src/contracts.js";
import { EntityTransaction } from "../src/entity-transaction.js";
import { HttpProblem } from "../src/errors.js";
import { emptyState, type DeviceRecord, type EventRecord, type PersistentState } from "../src/models.js";
import { AEDResponseService, type DevicePrincipal, RECRUITMENT_RADIUS_STAGES_METERS } from "../src/service.js";
import { MemoryStateStore, type StateStore } from "../src/store.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const NOW = new Date("2026-08-31T01:02:00.000Z");
const AT = NOW.toISOString();
const EARLIER = new Date(NOW.getTime() - 1_000).toISOString();
const RESPONDER = uuid(100);
const SIBLING = uuid(101);
const USER = uuid(200);
const EVENT = uuid(400);
const OTHER_EVENT = uuid(401);
const OFFER = uuid(500);
const UPDATE = uuid(600);
const WIDEST = RECRUITMENT_RADIUS_STAGES_METERS.at(-1)!;
const PATIENT = { latitude: 22.1987, longitude: 113.5439 };
const NEAR = { kind: "R" as const, latitude: PATIENT.latitude + 0.005,
  longitude: PATIENT.longitude, accuracyMeters: 12 };
const FAR = { ...NEAR, latitude: PATIENT.latitude + 0.5 };
const config: BackendConfig = {
  host: "127.0.0.1", port: 0,
  dataFile: "/tmp/aedresponse-position-differential.json",
  fixtureFile: "/tmp/aedresponse-position-differential-fixture.json",
  sessionTtlSeconds: 3_600, nearbyRadiusMeters: 1_000,
  positionMaxAgeSeconds: 600, maxClientClockSkewSeconds: 120,
  maxPositionAccuracyMeters: 50, bootstrapLimitPerMinute: 100,
  production: false
};

function device(id: string, userId: string | undefined = USER): DeviceRecord {
  return {
    deviceInstanceId: id, deviceKind: "IPHONE", companionPairId: uuid(9_000),
    ...(userId ? { userId } : {}),
    agreements: Object.fromEntries(["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => [kind, { version: "2.0", acceptedAt: AT }])),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: AT, lastSeenAt: EARLIER, lastBootstrapAt: AT,
    latestPosition: { positionUpdateId: uuid(9_500), observedAt: EARLIER,
      serverReceivedAt: EARLIER, position: { ...NEAR } }
  } as DeviceRecord;
}

function addEvent(state: PersistentState, id = EVENT, latitude = PATIENT.latitude): void {
  const patientId = id === EVENT ? uuid(300) : uuid(302);
  const patientUserId = id === EVENT ? uuid(301) : uuid(303);
  const position = { kind: "P" as const, ...PATIENT, latitude, accuracyMeters: 12 };
  state.devices[patientId] = device(patientId, patientUserId);
  state.events[id] = {
    id, state: "ACTIVE", recruitmentState: "RECRUITING", patientUserId,
    patientDeviceIds: [patientId], patientPairId: uuid(702),
    observation: { schemaVersion: "2.0", eventId: id, observationKind: "FALL_CONTEXT",
      fallDetectedAt: AT, patientPositionObservedAt: AT, fallResolution: "UNRESPONSIVE",
      appHelpResponse: "NEEDS_HELP", patientPosition: position },
    observationFingerprint: "position-differential", triggerSource: "WATCH_FALL_HELP_CONFIRMED",
    patientPosition: { positionUpdateId: uuid(9_600), source: "IPHONE_PRIMARY", observedAt: AT,
      serverReceivedAt: AT, position },
    currentRecruitmentRadiusMeters: WIDEST, recruitmentStageStartedAt: AT,
    coordinationRevision: 1, assignmentRevision: 1, unavailableAedIds: [], createdAt: AT
  } as EventRecord;
  // Observe the first append as well; appendTimeline's ??= returns the raw new
  // array and bypasses a lazy read proxy when this entry does not already exist.
  state.timelineByEventId[id] = [];
}

function world(): PersistentState {
  const state = emptyState();
  state.devices[RESPONDER] = device(RESPONDER);
  addEvent(state);
  return state;
}

function addOffer(state: PersistentState, deviceId = RESPONDER, eventId = EVENT,
  status: "SENT" | "ACCEPTED" = "SENT", expiresAt = new Date(NOW.getTime() + 30_000).toISOString()): void {
  state.deliveries[OFFER] = {
    id: OFFER, eventId, deviceInstanceId: deviceId,
    status, ...(status === "ACCEPTED" ? { decision: "ACCEPT" as const } : {}), statusOccurredAt: EARLIER,
    request: { schemaVersion: "2.0", messageId: `response-requested:${eventId}:${deviceId}`,
      eventId, deliveryId: OFFER, deliveryStatus: "SENT", occurredAt: EARLIER,
      eventType: "FALL_ASSISTANCE", positioningTier: "SEARCH_RING",
      distanceRange: "DISTANCE_500_1000M", etaRange: "ETA_5_10_MIN",
      currentRecruitmentRadiusMeters: WIDEST, expiresAt }
  };
}

function addAssignment(state: PersistentState, holder = RESPONDER): void {
  state.assignments[uuid(700)] = {
    id: uuid(700), eventId: EVENT, deviceInstanceId: holder,
    role: "GO_TO_PATIENT", status: "ASSIGNED", revision: 1, createdAt: EARLIER, updatedAt: EARLIER
  } as never;
}

function update(overrides: Partial<ResponderPositionUpdate> = {}): ResponderPositionUpdate {
  return { positionUpdateId: UPDATE, observedAt: AT, responderPosition: { ...NEAR }, ...overrides };
}

function principal(): DevicePrincipal {
  return { kind: "DEVICE", tokenHash: "position-differential", sessionId: uuid(800),
    userId: USER, deviceInstanceId: RESPONDER, deviceKind: "IPHONE", companionPairId: uuid(9_000),
    scopes: ["position:write"], expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() };
}

type Write = { collection: string; key: string; value: unknown };
type Stage = (target: PersistentState | EntityTransaction) => void;

/** Capture actual cross-collection writes; do not reconstruct order from state. */
function loggedDraft(state: PersistentState, writes: Write[]): PersistentState {
  const cache = new WeakMap<object, object>();
  const memo = <T extends object>(value: T, build: () => T): T => {
    const old = cache.get(value);
    if (old) return old as T;
    const result = build();
    cache.set(value, result);
    return result;
  };
  return new Proxy(state, {
    get(target, collection, receiver) {
      const rows = Reflect.get(target, collection, receiver);
      if (collection === "timelineByEventId") {
        return memo(rows, () => new Proxy(rows, {
          get(t, key, r) {
            const entries = Reflect.get(t, key, r);
            if (!Array.isArray(entries)) return entries;
            return memo(entries, () => new Proxy(entries, {
              get(list, property, listReceiver) {
                if (property === "push") return (...items: unknown[]) => {
                  for (const value of items) writes.push({ collection, key: String(key), value: structuredClone(value) });
                  return list.push(...items);
                };
                return Reflect.get(list, property, listReceiver);
              }
            }));
          }
        }));
      }
      if (collection !== "deliveries" && collection !== "notificationOutboxById"
        && collection !== "positionUpdateReceiptsById") return rows;
      return memo(rows, () => new Proxy(rows, {
        get(t, key, r) {
          const row = Reflect.get(t, key, r);
          if (collection !== "deliveries" || !row || typeof row !== "object") return row;
          return memo(row, () => new Proxy(row, {
            set(record, field, value) {
              if (field === "status") writes.push({ collection: "deliveryStatus", key: String(key), value });
              return Reflect.set(record, field, value);
            }
          }));
        },
        set(t, key, value) {
          if (!Reflect.has(t, key)) writes.push({ collection, key: String(key), value: structuredClone(value) });
          return Reflect.set(t, key, value);
        }
      }));
    }
  });
}

function loggedTransaction(tx: EntityTransaction, writes: Write[]): EntityTransaction {
  return new Proxy(tx, {
    get(target, key) {
      if (key === "append") return (collection: Parameters<EntityTransaction["append"]>[0], id: string, value: never) => {
        const added = target.append(collection, id, value);
        if (added === "added" && ["deliveries", "notificationOutboxById", "positionUpdateReceiptsById"].includes(collection)) {
          writes.push({ collection, key: id, value: structuredClone(value) });
        }
        if (added === "added" && collection === "timelineByEventId") {
          for (const entry of value as unknown as unknown[]) writes.push({ collection, key: id, value: structuredClone(entry) });
        }
        return added;
      };
      if (key === "update") return (collection: Parameters<EntityTransaction["update"]>[0], id: string, mutate: (draft: unknown) => void) => {
        const before = target.get(collection, id);
        target.update(collection, id, mutate);
        const after = target.get(collection, id);
        if (collection === "deliveries") {
          const status = (after as { status: string }).status;
          if (status !== (before as { status: string }).status) writes.push({ collection: "deliveryStatus", key: id, value: status });
        }
        if (collection === "timelineByEventId") {
          const start = (before as unknown as unknown[]).length;
          for (const value of (after as unknown as unknown[]).slice(start)) writes.push({ collection, key: id, value: structuredClone(value) });
        }
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

interface Outcome {
  response: unknown;
  problem: unknown;
  state: PersistentState;
  updates: Array<{ eventId: string; coordination: { revision: number; aedAcquiredCount: number } }>;
  writes: Write[];
  emissions: Array<{ devices: string[]; name: string; payload: unknown }>;
  commandRoute: string[];
}

async function run(seed: PersistentState, legacy: boolean, input = update(), stage?: Stage,
  actor = principal(), repeat = false, hiddenIndexes: readonly string[] = []): Promise<Outcome> {
  const backing = new MemoryStateStore(structuredClone(seed));
  const writes: Write[] = [];
  const commandRoute: string[] = [];
  let stagePending = true;
  let commandPending = true;
  const store: StateStore = new Proxy(backing, {
    get(target, key) {
      if (hiddenIndexes.includes(String(key))) return undefined;
      if (key === "transactEntities" && legacy) return undefined;
      if (key === "transact") return (mutate: (draft: PersistentState) => unknown) => target.transact(draft => {
        if (commandPending) { commandRoute.push("legacy"); commandPending = false; }
        if (stagePending) { stage?.(draft); stagePending = false; }
        return mutate(loggedDraft(draft, writes));
      });
      if (key === "transactEntities") return (mutate: (tx: EntityTransaction) => unknown) => target.transactEntities(tx => {
        if (commandPending) { commandRoute.push("transaction"); commandPending = false; }
        if (stagePending) { stage?.(tx); stagePending = false; }
        return mutate(loggedTransaction(tx, writes));
      });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const emissions: Outcome["emissions"] = [];
  const service = new AEDResponseService(store, config, {
    emitToDevices(devices, name, payload) {
      emissions.push({ devices: [...devices], name, payload: structuredClone(payload) });
      return [...devices];
    }
  }, () => NOW);
  const updates: Outcome["updates"] = [];
  const intercepted = service as unknown as { publishRecruitmentUpdates(value: Outcome["updates"], at: string): void };
  const publish = intercepted.publishRecruitmentUpdates.bind(service);
  intercepted.publishRecruitmentUpdates = (value, at) => {
    updates.push(...structuredClone(value));
    publish(value, at);
  };
  let response: unknown;
  let problem: unknown;
  try {
    response = await service.updateResponderPosition(actor, input);
    if (repeat) response = [response, await service.updateResponderPosition(actor, input)];
  } catch (error) {
    if (!(error instanceof HttpProblem)) throw error;
    problem = error.toJSON();
  }
  return { response, problem, state: backing.read(s => s as PersistentState), updates, writes, emissions, commandRoute };
}

/** Only generated identities are aliased; seeded IDs and array/insertion order stay literal. */
function canonical(outcome: Outcome, seed: PersistentState): unknown {
  const aliases = new Map<string, string>();
  const generated = (id: string, kind: string): void => {
    if (!aliases.has(id)) aliases.set(id, `${kind}-${aliases.size + 1}`);
  };
  for (const row of Object.values(outcome.state.deliveries)) if (!seed.deliveries[row.id]) generated(row.id, "delivery");
  for (const row of Object.values(outcome.state.notificationOutboxById)) if (!seed.notificationOutboxById[row.id]) generated(row.id, "notification");
  const seededTimelineIds = new Set(Object.values(seed.timelineByEventId).flat().map(row => row.id));
  for (const row of Object.values(outcome.state.timelineByEventId).flat()) if (!seededTimelineIds.has(row.id)) generated(row.id, "timeline");
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const [id, name] of aliases) value = (value as string).split(id).join(name);
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [replace(key), replace(child)]));
    return value;
  };
  const { commandRoute: _route, ...observable } = outcome;
  return replace({ ...observable, state: { ...outcome.state,
    // Records compare order-insensitively; these arrays additionally lock actual
    // delivery/notification/event enumeration and each event's timeline order.
    events: Object.entries(outcome.state.events),
    deliveries: Object.entries(outcome.state.deliveries),
    notificationOutboxById: Object.entries(outcome.state.notificationOutboxById),
    timelineByEventId: Object.entries(outcome.state.timelineByEventId)
  } });
}

interface Scenario {
  name: string;
  prepare?(state: PersistentState): void;
  input?: ResponderPositionUpdate;
  stage?: Stage;
  repeat?: boolean;
  verify?(outcome: Outcome): void;
}

const scenarios: Scenario[] = [
  { name: "a position and its receipt precede all recruitment writes", verify(result) {
    assert.equal(Object.keys(result.state.deliveries).length, 1);
    assert.equal(result.writes[0]?.collection, "positionUpdateReceiptsById");
    assert.equal(result.updates.length, 1);
    assert.ok(result.writes.some(write => write.collection === "timelineByEventId"));
    assert.ok(result.writes.some(write => write.collection === "notificationOutboxById"));
  } },
  { name: "same identity uses the first sorted device and sees its staged offer", prepare(state) {
    state.devices[SIBLING] = device(SIBLING);
  }, verify(result) {
    assert.deepEqual(Object.values(result.state.deliveries).map(row => row.deviceInstanceId), [RESPONDER]);
  } },
  { name: "just entered the ring reads the staged position missing from the committed index", prepare(state) {
    state.devices[RESPONDER]!.latestPosition!.position = FAR;
  }, verify(result) { assert.equal(Object.keys(result.state.deliveries).length, 1); } },
  { name: "just left one ring while another ring keeps the relevance gate open", prepare(state) {
    addOffer(state);
    addEvent(state, OTHER_EVENT, FAR.latitude);
  }, input: update({ responderPosition: FAR }), verify(result) {
    assert.equal(result.state.deliveries[OFFER]?.status, "EXPIRED");
    assert.equal(result.updates.length, 2);
    assert.ok(result.writes.some(write => write.collection === "deliveryStatus"));
  } },
  { name: "a user bound in this transaction excludes its assigned sibling", prepare(state) {
    delete state.devices[RESPONDER]!.userId;
    state.devices[SIBLING] = device(SIBLING);
    addAssignment(state, SIBLING);
  }, stage(target) {
    if (target instanceof EntityTransaction) target.update("devices", RESPONDER, draft => { draft.userId = USER; });
    else target.devices[RESPONDER]!.userId = USER;
  }, verify(result) { assert.equal(Object.keys(result.state.deliveries).length, 0); } },
  { name: "an existing active assignment prevents another offer", prepare(state) {
    addAssignment(state);
  }, verify(result) { assert.equal(Object.keys(result.state.deliveries).length, 0); } },
  { name: "accepted identity and assignment remain reflected in coordination", prepare(state) {
    addOffer(state, RESPONDER, EVENT, "ACCEPTED");
    addAssignment(state);
    state.devices[SIBLING] = device(SIBLING);
    state.devices[uuid(102)] = device(uuid(102), uuid(202));
  }, verify(result) {
    assert.equal(Object.values(result.state.deliveries).filter(row => row.deviceInstanceId === SIBLING).length, 0);
    assert.equal(result.updates.length, 1);
  } },
  { name: "staged AED receipt is visible in the returned coordination and notification", stage(target) {
    const row = { canonical: { schemaVersion: "2.0", receiptId: uuid(810), eventId: EVENT,
      aedId: uuid(811), deviceInstanceId: RESPONDER, acquiredAt: AT }, fingerprint: "staged-aed" } as never;
    if (target instanceof EntityTransaction) target.append("aedReceiptsById", uuid(810), row);
    else target.aedReceiptsById[uuid(810)] = row;
  }, verify(result) { assert.equal(result.updates[0]?.coordination.aedAcquiredCount, 1); } },
  { name: "multiple recruiting events include the distant event once the probe matches", prepare(state) {
    addEvent(state, OTHER_EVENT, PATIENT.latitude + 1);
    addOffer(state, RESPONDER, OTHER_EVENT, "SENT", EARLIER);
  }, verify(result) {
    assert.deepEqual(result.updates.map(value => value.eventId), [EVENT, OTHER_EVENT]);
    assert.equal(result.state.deliveries[OFFER]?.status, "EXPIRED");
    assert.equal(result.state.events[OTHER_EVENT]?.coordinationRevision, 2);
  } },
  { name: "offer remains live exactly at the expiresAt boundary", prepare(state) {
    addOffer(state, RESPONDER, EVENT, "SENT", AT);
  }, verify(result) { assert.equal(result.state.deliveries[OFFER]?.status, "SENT"); } },
  { name: "patient without R position and same-user different-pair iPhone receive coordination", prepare(state) {
    delete state.devices[uuid(300)]!.latestPosition;
    const sibling = device(uuid(304), uuid(301));
    delete sibling.latestPosition;
    sibling.companionPairId = uuid(9_001);
    state.devices[uuid(304)] = sibling;
  }, verify(result) {
    const notifications = Object.values(result.state.notificationOutboxById)
      .filter(row => row.name === "event:coordination-updated");
    assert.deepEqual(notifications.map(row => row.recipient.deviceInstanceId), [uuid(300), uuid(304)]);
    assert.ok(notifications.every(row => row.status === "DISPATCHED"));
    assert.deepEqual(result.emissions.filter(row => row.name === "event:coordination-updated")
      .flatMap(row => row.devices), [uuid(300), uuid(304)]);
  } },
  { name: "patient audience keeps device insertion order across geographic and identity candidates", prepare(state) {
    const sibling = device(uuid(304), uuid(301));
    delete sibling.latestPosition;
    sibling.companionPairId = uuid(9_001);
    // The unpositioned sibling precedes the main patient's geographic hit. Legacy
    // enumeration emits in this order; concatenating index sources must preserve it.
    state.devices = { [uuid(304)]: sibling, ...state.devices };
  }, verify(result) {
    assert.deepEqual(Object.values(result.state.notificationOutboxById)
      .filter(row => row.name === "event:coordination-updated")
      .map(row => row.recipient.deviceInstanceId), [uuid(304), uuid(300)]);
  } },
  { name: "unchanged timestamp is idempotent and does not run recruitment", input: update({ observedAt: EARLIER }),
    verify(result) { assert.equal(result.updates.length, 0); assert.equal(Object.keys(result.state.deliveries).length, 0); } },
  { name: "older position retains latest position and records a stale receipt",
    input: update({ observedAt: new Date(NOW.getTime() - 2_000).toISOString(), responderPosition: FAR }),
    prepare(state) { addOffer(state); }, verify(result) {
      assert.equal(result.state.devices[RESPONDER]?.latestPosition?.observedAt, EARLIER);
      assert.equal(result.updates.length, 0);
    } },
  { name: "receipt replay retains the first evidence and emits no second recruitment update", repeat: true,
    verify(result) { assert.equal(result.updates.length, 1); assert.equal(Object.keys(result.state.positionUpdateReceiptsById).length, 1); } },
  { name: "staged position receipt participates in the 64-entry retention limit", prepare(state) {
    for (let index = 0; index < 64; index += 1) {
      state.positionUpdateReceiptsById[uuid(10_000 + index)] = {
        deviceInstanceId: RESPONDER, kind: "R", fingerprint: `old-${index}`, recordedAt: EARLIER,
        result: { positionUpdateId: uuid(10_000 + index), applied: true, idempotent: false,
          ignoredAsStale: false, positionObservedAt: EARLIER, serverReceivedAt: EARLIER }
      } as never;
    }
  }, verify(result) {
    assert.equal(Object.keys(result.state.positionUpdateReceiptsById).length, 64);
    assert.ok(result.state.positionUpdateReceiptsById[UPDATE]);
    assert.equal(result.state.positionUpdateReceiptsById[uuid(10_000)], undefined);
  } }
];

for (const scenario of scenarios) {
  test(`full responder-position differential: ${scenario.name}`, async () => {
    const seed = world();
    scenario.prepare?.(seed);
    const legacy = await run(seed, true, scenario.input ?? update(), scenario.stage, principal(), scenario.repeat);
    const transaction = await run(seed, false, scenario.input ?? update(), scenario.stage, principal(), scenario.repeat);
    assert.equal(legacy.problem, undefined);
    assert.equal(transaction.problem, undefined);
    assert.deepEqual(transaction.commandRoute, ["transaction"], "must reach the real entity path, not compare Legacy with Legacy");
    assert.deepEqual(canonical(transaction, seed), canonical(legacy, seed));
    scenario.verify?.(transaction);
  });
}

test("full responder-position scope: unrelated events receive no recruitment at all", async () => {
  const seed = world();
  seed.devices[RESPONDER]!.latestPosition!.position = FAR;
  seed.devices[SIBLING] = device(SIBLING, uuid(201));
  addOffer(seed, SIBLING, EVENT, "SENT", EARLIER);
  const result = await run(seed, false, update({ responderPosition: FAR }));
  assert.deepEqual(result.commandRoute, ["transaction"]);
  assert.equal(result.problem, undefined);
  assert.equal(result.updates.length, 0);
  assert.equal(result.state.deliveries[OFFER]?.status, "SENT", "even another device's expired offer stays untouched");
  assert.equal(result.state.events[EVENT]?.coordinationRevision, 1);
  assert.deepEqual(result.writes.map(write => write.collection), ["positionUpdateReceiptsById"]);
});

test("full responder-position scope: leaving every ring preserves the former no-recruitment branch", async () => {
  const seed = world();
  addOffer(seed);
  const result = await run(seed, false, update({ responderPosition: FAR }));
  assert.deepEqual(result.commandRoute, ["transaction"]);
  assert.equal(result.problem, undefined);
  assert.equal(result.updates.length, 0);
  assert.equal(result.state.deliveries[OFFER]?.status, "SENT",
    "the legacy supported route did not refresh when the new position matched no event");
  assert.deepEqual(result.writes.map(write => write.collection), ["positionUpdateReceiptsById"]);
});

for (const hidden of [["projections"], ["devicePositions"], ["assignmentIndex"], ["deliveryIndex"],
  ["projections", "devicePositions", "assignmentIndex", "deliveryIndex"]]) {
  test(`full responder-position capability: entity route without ${hidden.join(" + ")}`, async () => {
    const seed = world();
    delete seed.devices[uuid(300)]!.latestPosition;
    seed.devices[SIBLING] = device(SIBLING, uuid(201));
    addAssignment(seed, SIBLING);
    addEvent(seed, OTHER_EVENT, PATIENT.latitude + 1);
    addOffer(seed, SIBLING, OTHER_EVENT, "SENT", EARLIER);
    const stage: Stage = target => {
      const row = { canonical: { schemaVersion: "2.0", receiptId: uuid(810), eventId: EVENT,
        aedId: uuid(811), deviceInstanceId: RESPONDER, acquiredAt: AT }, fingerprint: "staged-aed" } as never;
      if (target instanceof EntityTransaction) target.append("aedReceiptsById", uuid(810), row);
      else target.aedReceiptsById[uuid(810)] = row;
    };
    const indexed = await run(seed, false, update(), stage);
    const missing = await run(seed, false, update(), stage, principal(), false, hidden);
    assert.deepEqual(missing.commandRoute, ["transaction"], "missing derived indexes must use the same real entity transaction");
    assert.equal(missing.problem, undefined);
    assert.deepEqual(canonical(missing, seed), canonical(indexed, seed));
    assert.equal(missing.state.deliveries[OFFER]?.status, "EXPIRED");
    assert.equal(missing.updates.length, 2);
    assert.equal(missing.updates[0]?.coordination.aedAcquiredCount, 1);
  });
}

const rejections: Array<{ name: string; prepare?(state: PersistentState): void;
  input?: ResponderPositionUpdate; actor?: DevicePrincipal; status: number; detail: string }> = [
  { name: "missing device", prepare(state) { delete state.devices[RESPONDER]; }, status: 403,
    detail: "Volunteer responder agreement is required before publishing R position" },
  { name: "missing agreement", prepare(state) { state.devices[RESPONDER]!.agreements = {}; }, status: 403,
    detail: "Volunteer responder agreement is required before publishing R position" },
  { name: "location capability denied", prepare(state) { state.devices[RESPONDER]!.capabilities.locationAuthorized = false; },
    status: 403, detail: "Location capability is required before publishing R position" },
  { name: "active patient identity", prepare(state) { state.events[EVENT]!.patientUserId = USER; },
    status: 409, detail: "An active patient cannot publish an R position" },
  { name: "conflicting same timestamp", input: update({ observedAt: EARLIER, responderPosition: FAR }),
    prepare(state) { addOffer(state); }, status: 409,
    detail: "Responder position conflicts at the same observedAt timestamp" },
  { name: "receipt identity reused", prepare(state) {
    state.positionUpdateReceiptsById[UPDATE] = { deviceInstanceId: RESPONDER, kind: "R", fingerprint: "different-content",
      recordedAt: EARLIER, result: { positionUpdateId: UPDATE, applied: true, idempotent: false, ignoredAsStale: false,
        observedAt: EARLIER, serverReceivedAt: EARLIER } } as never;
  }, status: 409, detail: "positionUpdateId was already used with different content" },
  { name: "invalid timestamp", input: update({ observedAt: "invalid" }), status: 400,
    detail: "observedAt must be an ISO-8601 timestamp" },
  { name: "future timestamp", input: update({ observedAt: new Date(NOW.getTime() + 121_000).toISOString() }), status: 409,
    detail: "observedAt exceeds the configured client clock-skew allowance" },
  { name: "missing scope", actor: { ...principal(), scopes: [] }, status: 403,
    detail: "Authenticated iPhone session is missing required scope position:write" },
  { name: "Watch principal", actor: { ...principal(), deviceKind: "WATCH" }, status: 403,
    detail: "This operation is limited to iPhone sessions" }
];

for (const scenario of rejections) {
  test(`full responder-position rejection: ${scenario.name}`, async () => {
    const seed = world();
    scenario.prepare?.(seed);
    const before = new MemoryStateStore(structuredClone(seed)).read(s => s);
    const legacy = await run(seed, true, scenario.input ?? update(), undefined, scenario.actor ?? principal());
    const transaction = await run(seed, false, scenario.input ?? update(), undefined, scenario.actor ?? principal());
    assert.deepEqual(transaction.problem, { type: `https://aedresponse.invalid/problems/${scenario.status}`,
      title: scenario.status === 403 ? "Forbidden" : scenario.status === 400 ? "Invalid request" : "Conflict",
      status: scenario.status, detail: scenario.detail });
    assert.deepEqual(canonical(transaction, seed), canonical(legacy, seed));
    assert.deepEqual(transaction.state, before, "refusal must leave position, receipt and all recruitment evidence unchanged");
    assert.deepEqual(transaction.writes, []);
  });
}
