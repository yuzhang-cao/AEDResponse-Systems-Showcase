/**
 * Phase 1 standalone change: `presenceView` reads through a narrow,
 * computation-scoped accessor instead of `store.read()` (which cloned the whole
 * state tree to derive one enum).
 *
 * These tests cover the acceptance items agreed for this commit:
 *   - response fields are unchanged (same state/time -> same result, computed
 *     through the narrow view and through a live state must be identical);
 *   - the response stage performs zero whole-state reads and cannot silently
 *     fall back to one;
 *   - a collection is materialised at most once per computation, so an adapter
 *     mistake cannot turn one whole-tree clone into many collection clones;
 *   - devices are never enumerated (that would clone every device record);
 *   - read results never expose mutable store internals.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { emptyState } from "../src/models.js";
import type { Aed } from "../src/contracts.js";
import { createStateReadView } from "../src/state-read.js";
import {
  emptyPresenceAccessStats,
  livePresenceAccess,
  viewPresenceAccess
} from "../src/presence-access.js";
import { AEDResponseService } from "../src/service.js";
import { MemoryStateStore, SQLiteStateStore, type StateStore } from "../src/store.js";
import {
  operationMetrics,
  resetMetrics,
  setInstrumentationEnabled,
  snapshotMetrics
} from "../src/runtime-metrics.js";

const BASE_TIME = "2026-08-31T01:02:00.000Z";
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const atOffset = (seconds: number): string =>
  new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();

const patientPosition = { kind: "P" as const, latitude: 22.1987, longitude: 113.5439, accuracyMeters: 12 };
const nearbyResponderPosition = { kind: "R" as const, latitude: 22.198, longitude: 113.543, accuracyMeters: 10 };
const farResponderPosition = { kind: "R" as const, latitude: 40.0, longitude: 116.0, accuracyMeters: 10 };

const aeds: Aed[] = [];

const config = { ...loadConfig({}, "/tmp"), authSubjectPepper: "presence-access-test-pepper",
  enableControlledTestAccounts: true };

let sequence = 90_000;
async function bootstrapIPhone(service: AEDResponseService, deviceInstanceId: string, pairId: string) {
  const result = await service.bootstrap({
    deviceInstanceId,
    deviceKind: "IPHONE",
    companionPairId: pairId,
    agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY",
      "SENSITIVE_PERSONAL_INFORMATION"].map(kind => ({
        kind: kind as "PATIENT", version: "2.0", acceptedAt: BASE_TIME
      })),
    capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true
  }, `iphone:${deviceInstanceId}`);
  return service.authenticateToken(result.sessionToken);
}

/** Patient + watch + N positioned responders, then a real ACTIVE/RECRUITING event. */
async function seedScenario(service: AEDResponseService, store: StateStore, responderCount: number) {
  const patientPairId = uuid(100);
  const patient = await bootstrapIPhone(service, uuid(101), patientPairId);
  const watchBootstrap = await service.bootstrap({
    deviceInstanceId: uuid(102), deviceKind: "WATCH", companionPairId: patientPairId
  }, "watch:seed");
  const watch = service.authenticateToken(watchBootstrap.sessionToken);
  const responders = [];
  for (let index = 0; index < responderCount; index += 1) {
    const responder = await bootstrapIPhone(service, uuid(200 + index), uuid(300 + index));
    sequence += 1;
    await service.updateResponderPosition(responder, {
      positionUpdateId: uuid(sequence),
      responderPosition: index === 0
        ? nearbyResponderPosition
        : { ...nearbyResponderPosition, latitude: nearbyResponderPosition.latitude + index * 0.00005 },
      observedAt: BASE_TIME
    });
    responders.push(responder);
  }
  const eventId = uuid(500);
  await service.reportWatchObservation(watch, eventId, {
    schemaVersion: "2.0",
    eventId,
    observationKind: "FALL_CONTEXT",
    fallDetectedAt: atOffset(1),
    patientPositionObservedAt: atOffset(0),
    fallResolution: "UNRESPONSIVE",
    appHelpResponse: "NEEDS_HELP",
    patientPosition
  } as never);
  return { patient, watch, responders, eventId, store };
}

function deviceIdOf(principal: unknown): string {
  const id = (principal as { deviceInstanceId?: string }).deviceInstanceId;
  assert.ok(id, "principal must be a device principal");
  return id;
}

test("narrow accessor materialises each collection at most once per computation", () => {
  const state = emptyState();
  state.events[uuid(1)] = { id: uuid(1) } as never;
  state.events[uuid(2)] = { id: uuid(2) } as never;
  state.deliveries[uuid(3)] = { id: uuid(3), eventId: uuid(1) } as never;
  state.assignments[uuid(4)] = { id: uuid(4), eventId: uuid(1) } as never;

  let selectCalls = 0;
  const base = createStateReadView(state);
  const counting = {
    get: (collection: never, key: string) => base.get(collection, key),
    select: (collection: never, predicate: never, limit: number) => {
      selectCalls += 1;
      return base.select(collection, predicate, limit);
    }
  };

  const stats = emptyPresenceAccessStats();
  const access = viewPresenceAccess(counting as never, stats);

  // Repeated access must reuse the single materialisation.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(Object.values(access.events).length, 2);
    assert.equal(Object.values(access.deliveries).length, 1);
    assert.equal(Object.values(access.assignments).length, 1);
  }
  assert.equal(selectCalls, 3, "one select per collection, not one per access");
  assert.deepEqual(stats.collectionLoads, { events: 1, deliveries: 1, assignments: 1 });
});

test("narrow accessor never enumerates devices and never exposes live state", () => {
  const state = emptyState();
  state.devices[uuid(7)] = {
    deviceInstanceId: uuid(7), deviceKind: "IPHONE", companionPairId: uuid(8),
    agreements: {}, capabilities: { notificationAuthorized: true, locationAuthorized: true },
    availableForResponse: true, presenceObservedAt: BASE_TIME, lastSeenAt: BASE_TIME,
    lastBootstrapAt: BASE_TIME
  } as never;
  const access = viewPresenceAccess(createStateReadView(state));

  // Enumerating devices would clone every device record; it must fail loudly
  // rather than silently degrade into a full-collection clone.
  assert.throws(() => Object.values(access.devices), /must not enumerate the devices collection/);

  // Point reads return detached copies, so callers cannot write through them.
  const first = access.devices[uuid(7)];
  assert.ok(first);
  (first as { availableForResponse: boolean }).availableForResponse = false;
  assert.equal(access.devices[uuid(7)]?.availableForResponse, true);
  assert.equal(state.devices[uuid(7)]?.availableForResponse, true);
});

test("view-path and live-path presence projections agree on a seeded scenario", async () => {
  const store = new MemoryStateStore(emptyState());
  const service = new AEDResponseService(store, config, undefined, () => new Date(BASE_TIME));
  const { patient, responders } = await seedScenario(service, store, 3);

  // The update response computes positioningTier through the new narrow view
  // accessor; getPresence() computes the same field through a live in-transaction
  // state.  On the same committed state the two paths must agree exactly.
  // A patient may legitimately not publish an R position, so the comparison uses
  // responders; the patient branch is asserted separately below.
  const tiers: Array<{ device: string; viewPath: string | undefined; livePath: string | undefined }> = [];
  for (const [index, principal] of [responders[0]!, responders[1]!, responders[2]!].entries()) {
    sequence += 1;
    const updated = await service.updateResponderPosition(principal, {
      positionUpdateId: uuid(sequence),
      responderPosition: { ...nearbyResponderPosition, latitude: 22.1981 + index * 0.00001 },
      observedAt: atOffset(10 + index)
    });
    const presence = await service.getPresence(principal);
    tiers.push({
      device: deviceIdOf(principal),
      viewPath: updated.positioningTier,
      livePath: presence.positioningTier
    });
  }

  for (const row of tiers) {
    assert.equal(row.viewPath, row.livePath,
      `tier mismatch for ${row.device}: view=${row.viewPath} live=${row.livePath}`);
  }
  // The scenario must exercise more than the trivial STANDBY branch, otherwise
  // the comparison above would be vacuous.
  assert.ok(tiers.some(r => r.viewPath !== "STANDBY"),
    `scenario should place at least one device outside STANDBY, got ${JSON.stringify(tiers)}`);
  // Patient branch coverage: the same private presenceView() computes this, so
  // the accessor must carry the event/patient data it depends on.
  const patientPresence = await service.getPresence(patient as never);
  assert.equal(patientPresence.positioningTier, "EVENT_PARTICIPANT");
});

test("response stage performs no whole-state read and loads no irrelevant collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-presence-access-"));
  const path = join(directory, "state.sqlite");
  let store: SQLiteStateStore | undefined;
  try {
    store = await SQLiteStateStore.open(path, aeds);
    const service = new AEDResponseService(store, config, undefined, () => new Date(BASE_TIME));
    const { responders } = await seedScenario(service, store, 2);

    setInstrumentationEnabled(true);
    sequence += 1;
    resetMetrics();
    await service.updateResponderPosition(responders[0]!, {
      positionUpdateId: uuid(sequence),
      responderPosition: { ...nearbyResponderPosition, latitude: 22.1981 },
      observedAt: atOffset(60)
    });
    const { storage, operation } = snapshotMetrics();

    // The response stage must not clone the state tree, and must not fall back
    // to store.read() through the readEntities compatibility helper.
    assert.equal(storage.fullStateClones.storeRead, 0);
    // Position and recruitment now share an entity transaction. The remaining
    // normalization here is the explicitly enabled development shadow check.
    assert.equal(storage.fullStateClones.transactionDraft, 0);
    assert.equal(storage.fullStateClones.normalization, 1);
    // SQL behaviour for this baseline scenario is unchanged.
    assert.equal(storage.businessEntityUpserts, 2);
    assert.equal(storage.businessEntityDeletes, 0);
    assert.equal(storage.revisionMetadataUpdates, 1);
    assert.equal(storage.commitCalls, 1);
    // One computation, one materialisation per collection at most.
    assert.ok(operation.presenceCollectionLoads.events <= operationMetrics.calls,
      "events collection loaded more than once per computation");
    assert.ok(operation.presenceCollectionLoads.deliveries <= operationMetrics.calls,
      "deliveries collection loaded more than once per computation");
    assert.ok(operation.presenceCollectionLoads.assignments <= operationMetrics.calls,
      "assignments collection loaded more than once per computation");
    // Every segment plus the residual must account for the whole method, so an
    // unexplained interval can never hide.  Sub-phases (presenceAccessLoadMs)
    // are subsets of responseMs and are deliberately not added again.
    const accounted = operation.preTransactionMs + storage.queueWaitMs
      + storage.transactionServiceMs + operation.notificationDrainMs
      + operation.recruitmentPublishMs + operation.responseMs + operation.unattributedMs;
    assert.ok(Math.abs(accounted - operation.operationElapsedMs) < 1,
      `segments must cover the whole method: accounted=${accounted} elapsed=${operation.operationElapsedMs}`);
    assert.ok(operation.presenceAccessLoadMs <= operation.responseMs,
      "accessor load time is a sub-phase of the response segment");
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the readEntities compatibility helper falls back to a whole-state read when unsupported", async () => {
  // Documents the hazard behind the "no full-tree fallback" assertion above: a
  // store without readEntities() silently degrades to store.read().
  const inner = new MemoryStateStore(emptyState());
  const withoutEntityReads: StateStore = {
    read: reader => inner.read(reader),
    transact: mutation => inner.transact(mutation)
  };
  assert.equal(withoutEntityReads.readEntities, undefined);

  const { readEntities } = await import("../src/state-read.js");
  setInstrumentationEnabled(true);
  resetMetrics();
  readEntities(withoutEntityReads, view => view.get("devices", uuid(1)));
  assert.equal(snapshotMetrics().storage.fullStateClones.storeRead, 1);
});
