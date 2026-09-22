/**
 * Phase 1 core mechanism: the controlled entity transaction.
 *
 * These tests pin the contract agreed in review — only changed entities are
 * validated/serialized/persisted, an empty change set performs no SQLite write at
 * all, reads see staged writes without exposing store-owned references, appends
 * never overwrite evidence, and a failing callback leaves committed state and the
 * database untouched.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { EntityTransaction } from "../src/entity-transaction.js";
import { emptyState, type PersistentState } from "../src/models.js";
import { createStateReadView } from "../src/state-read.js";
import { MemoryStateStore, SQLiteStateStore, setShadowValidationEnabled } from "../src/store.js";
import {
  resetMetrics,
  setInstrumentationEnabled,
  snapshotMetrics
} from "../src/runtime-metrics.js";

const BASE_TIME = "2026-08-31T01:02:00.000Z";
const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

function seedState(deviceCount: number, batchCount: number): PersistentState {
  const state = emptyState();
  for (let index = 0; index < deviceCount; index += 1) {
    const deviceInstanceId = uuid(1_000 + index);
    const userId = uuid(2_000 + index);
    state.devices[deviceInstanceId] = {
      deviceInstanceId,
      deviceKind: "IPHONE",
      userId,
      accountId: uuid(3_000 + index),
      companionPairId: uuid(4_000 + index),
      agreements: {},
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true,
      presenceObservedAt: BASE_TIME,
      lastSeenAt: BASE_TIME,
      lastBootstrapAt: BASE_TIME
    } as never;
  }
  // Unrelated retained history: append-only position batches.
  for (let index = 0; index < batchCount; index += 1) {
    const batchId = uuid(5_000 + index);
    state.eventPositionBatchesById[batchId] = {
      batchId,
      eventId: uuid(6_000 + index),
      deviceInstanceId: uuid(1_000),
      userId: uuid(2_000),
      kind: "R",
      fingerprint: `fp-${index}`,
      receivedAt: BASE_TIME,
      records: [{
        recordId: uuid(7_000 + index),
        batchId,
        eventId: uuid(6_000 + index),
        deviceInstanceId: uuid(1_000),
        userId: uuid(2_000),
        kind: "R",
        slotAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        serverReceivedAt: BASE_TIME,
        status: "NO_NEW_FIX",
        gapReason: "NO_FIX",
        appliedToLatest: false,
        ignoredAsStale: false
      }]
    } as never;
  }
  return state;
}

const config = { ...loadConfig({}, "/tmp"), authSubjectPepper: "entity-tx-test-pepper" };

test("incremental transaction touches only the changed entity, never the whole state", async () => {
  const store = new MemoryStateStore(seedState(200, 300));
  setInstrumentationEnabled(true);
  setShadowValidationEnabled(false);
  resetMetrics();   // exclude the constructor's whole-state load validation
  let insideTransaction = -1;
  await store.transactEntities(tx => {
    tx.update("devices", uuid(1_000), draft => {
      (draft as { lastSeenAt: string }).lastSeenAt = "2026-09-01T00:00:00.000Z";
    });
    insideTransaction = snapshotMetrics().storage.validatedEntities;
  });
  assert.equal(insideTransaction, 0, "validation happens at commit, not while staging");
  const committed = snapshotMetrics();
  assert.equal(committed.storage.validatedEntities, 1);
  assert.equal(committed.storage.serializedEntities, 0, "memory store does not serialize");
  assert.equal(committed.storage.fullStateClones.transactionDraft, 0);
  assert.equal(committed.storage.fullStateFlattens, 0);
  assert.equal(committed.storage.historyCompareCalls, 0);
  assert.equal(committed.storage.historyComparedEntities, 0);
});

test("empty change set performs no commit and no whole-state work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-entity-tx-empty-"));
  const path = join(directory, "state.sqlite");
  let store: SQLiteStateStore | undefined;
  try {
    store = await SQLiteStateStore.open(path, []);
    await store.transact(state => {
      for (const [key, value] of Object.entries(seedState(50, 50).devices)) state.devices[key] = value;
    });
    setInstrumentationEnabled(true);
    setShadowValidationEnabled(false);
    resetMetrics();
    const result = await store.transactEntities(async tx => {
      // Read-only transaction: reads must not create a change set.
      tx.get("devices", uuid(1_000));
      tx.keys("devices");
      return "read-only";
    });
    assert.equal(result, "read-only");
    const after = snapshotMetrics();
    assert.equal(after.storage.commitCalls, 0, "no SQLite write for an empty change set");
    assert.equal(after.storage.emptyChangeSetReturns, 1);
    assert.equal(after.storage.fullStateFlattens, 0);
    assert.equal(after.storage.fullStateClones.transactionDraft, 0);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads see staged writes and never expose store-owned references", async () => {
  const store = new MemoryStateStore(seedState(3, 0));
  await store.transactEntities(tx => {
    tx.update("devices", uuid(1_000), draft => {
      (draft as { availableForResponse: boolean }).availableForResponse = false;
    });
    // read-your-writes
    const staged = tx.get("devices", uuid(1_000));
    assert.equal((staged as { availableForResponse: boolean }).availableForResponse, false);
    // mutating what get() returned must not affect the staged value
    (staged as { availableForResponse: boolean }).availableForResponse = true;
    const again = tx.get("devices", uuid(1_000));
    assert.equal((again as { availableForResponse: boolean }).availableForResponse, false);
  });
  const committed = store.read(state => state.devices[uuid(1_000)]);
  assert.equal(committed?.availableForResponse, false);
});

test("appends are idempotent for identical content and rejected for different content", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  const batchId = uuid(9_000);
  const record = {
    batchId,
    eventId: uuid(9_100),
    deviceInstanceId: uuid(1_000),
    userId: uuid(2_000),
    kind: "R",
    fingerprint: "fp-append",
    receivedAt: BASE_TIME,
    records: [{
      recordId: uuid(9_200), batchId, eventId: uuid(9_100),
      deviceInstanceId: uuid(1_000), userId: uuid(2_000), kind: "R",
      slotAt: new Date(Date.UTC(2026, 0, 2)).toISOString(), serverReceivedAt: BASE_TIME,
      status: "NO_NEW_FIX", gapReason: "NO_FIX", appliedToLatest: false, ignoredAsStale: false
    }]
  } as never;

  await store.transactEntities(tx => {
    assert.equal(tx.append("eventPositionBatchesById", batchId, record), "added");
  });
  await store.transactEntities(tx => {
    // Identical re-append: no-op, and the change set stays empty.
    assert.equal(tx.append("eventPositionBatchesById", batchId, record), "unchanged");
    assert.equal(tx.size, 0);
  });
  await assert.rejects(
    store.transactEntities(tx => {
      tx.append("eventPositionBatchesById", batchId, { ...(record as object), fingerprint: "tampered" } as never);
    }),
    /already exists with different content/
  );
  // The rejected attempt must not have altered the stored evidence.
  assert.equal(
    store.read(state => (state.eventPositionBatchesById[batchId] as { fingerprint: string }).fingerprint),
    "fp-append"
  );
});

test("a failing transaction discards staged changes and leaves committed state intact", async () => {
  const store = new MemoryStateStore(seedState(2, 0));
  await assert.rejects(
    store.transactEntities(tx => {
      tx.update("devices", uuid(1_000), draft => {
        (draft as { availableForResponse: boolean }).availableForResponse = false;
      });
      tx.append("positionUpdateReceiptsById", uuid(8_000), {
        positionUpdateId: uuid(8_000), deviceInstanceId: uuid(1_000), kind: "R",
        fingerprint: "fp", recordedAt: BASE_TIME, receivedAt: BASE_TIME
      } as never);
      throw new Error("business failure");
    }),
    /business failure/
  );
  assert.equal(store.read(state => state.devices[uuid(1_000)]?.availableForResponse), true);
  assert.equal(store.read(state => state.positionUpdateReceiptsById[uuid(8_000)]), undefined);
});

test("sealed transactions reject further mutation", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  let captured: unknown;
  await store.transactEntities(tx => {
    captured = tx;
    tx.update("devices", uuid(1_000), draft => {
      (draft as { availableForResponse: boolean }).availableForResponse = false;
    });
  });
  assert.throws(
    () => (captured as { update: (...args: never[]) => void }).update(
      "devices" as never, uuid(1_000) as never, (() => {}) as never
    ),
    /sealed/
  );
});

test("limited transactional selection fills matches after staged removals and updates", () => {
  const tx = new EntityTransaction(createStateReadView(seedState(5, 0)));
  tx.remove("devices", uuid(1_000));
  tx.update("devices", uuid(1_001), draft => { draft.availableForResponse = false; });
  const available = (device: Readonly<PersistentState["devices"][string]>) => device.availableForResponse;
  assert.deepEqual(tx.keysWhere("devices", available, 2), [uuid(1_002), uuid(1_003)]);
  assert.equal(tx.keysWhere("devices", available, Number.MAX_SAFE_INTEGER).length, 3);
  for (const limit of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => tx.keysWhere("devices", available, limit), /positive, bounded limit/);
  }
});

test("a caught update failure leaves the earlier staged value intact", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  await store.transactEntities(tx => {
    tx.update("devices", uuid(1_000), draft => { draft.availableForResponse = false; });
    assert.throws(() => tx.update("devices", uuid(1_000), draft => {
      draft.availableForResponse = true;
      throw new Error("update failed");
    }), /update failed/);
    assert.equal(tx.get("devices", uuid(1_000))?.availableForResponse, false);
  });
  assert.equal(store.read(state => state.devices[uuid(1_000)]?.availableForResponse), false);
});

test("retained update drafts and change snapshots cannot alter committed state", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  const capturedDrafts: PersistentState["devices"][string][] = [];
  await store.transactEntities(tx => {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      tx.update("devices", uuid(1_000), draft => {
        draft.availableForResponse = false;
        capturedDrafts.push(draft);
      });
    }
    for (const draft of capturedDrafts) draft.availableForResponse = true;
    const pending = tx.pendingChanges()[0]!.after as PersistentState["devices"][string];
    pending.availableForResponse = true;
    assert.equal(tx.get("devices", uuid(1_000))?.availableForResponse, false);
    const sealed = tx.seal()[0]!.after as PersistentState["devices"][string];
    sealed.availableForResponse = true;
  });
  for (const draft of capturedDrafts) draft.availableForResponse = true;
  assert.equal(store.read(state => state.devices[uuid(1_000)]?.availableForResponse), false);
});

test("change-set rules still protect evidence and reject illegal writes", async () => {
  const store = new MemoryStateStore(seedState(1, 1));
  const batchId = uuid(5_000);
  // Append-only batch: modification and deletion must both be refused.
  await assert.rejects(
    store.transactEntities(tx => {
      tx.update("eventPositionBatchesById", batchId, draft => {
        (draft as { fingerprint: string }).fingerprint = "rewritten";
      });
    }),
    /append-only and cannot be modified/
  );
  await assert.rejects(
    store.transactEntities(tx => {
      tx.remove("eventPositionBatchesById", batchId);
    }),
    /append-only and cannot be deleted/
  );
  assert.ok(store.read(state => state.eventPositionBatchesById[batchId]));
});

test("incremental writes persist across a SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aedresponse-entity-tx-reopen-"));
  const path = join(directory, "state.sqlite");
  let store: SQLiteStateStore | undefined;
  try {
    store = await SQLiteStateStore.open(path, []);
    await store.transact(state => {
      for (const [key, value] of Object.entries(seedState(5, 5).devices)) state.devices[key] = value;
    });
    await store.transactEntities(tx => {
      tx.update("devices", uuid(1_000), draft => {
        (draft as { lastSeenAt: string }).lastSeenAt = "2026-09-02T00:00:00.000Z";
      });
    });
    await store.close();
    store = await SQLiteStateStore.open(path, []);
    assert.equal(store.read(s => s.devices[uuid(1_000)]?.lastSeenAt), "2026-09-02T00:00:00.000Z");
    assert.equal(store.read(s => Object.keys(s.devices).length), 5);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow validation is opt-in and attributed separately when enabled", async () => {
  const store = new MemoryStateStore(seedState(10, 10));
  setInstrumentationEnabled(true);
  setShadowValidationEnabled(true);
  resetMetrics();
  await store.transactEntities(tx => {
    tx.update("devices", uuid(1_000), draft => {
      (draft as { availableForResponse: boolean }).availableForResponse = false;
    });
  });
  const on = snapshotMetrics();
  // The temporary net re-introduces whole-state work and says so, rather than
  // hiding it inside the normal path's counters.
  assert.equal(on.storage.shadowValidationRuns, 1);
  assert.equal(on.storage.fullStateClones.other, 1);
  assert.ok(on.storage.validatedEntities > 1, "shadow run validates the whole state");

  setShadowValidationEnabled(false);
  resetMetrics();
  await store.transactEntities(tx => {
    tx.update("devices", uuid(1_001), draft => {
      (draft as { availableForResponse: boolean }).availableForResponse = false;
    });
  });
  const off = snapshotMetrics();
  assert.equal(off.storage.shadowValidationRuns, 0);
  assert.equal(off.storage.fullStateClones.other, 0);
  assert.equal(off.storage.validatedEntities, 1, "normal path validates exactly one entity");
});

/**
 * Publication order.
 *
 * `seal()` returns the change set in canonical (collection, key) order so that
 * persistence, snapshots and diagnostics stay deterministic.  That order is not the
 * order entities were created in, and for a string-keyed collection the difference is
 * observable: publishing in canonical order would append new keys sorted by id, so
 * `Object.values(collection)` after a commit would not match the order the entities
 * were actually created.  `deliveryForUser` reads that order, so it is business
 * semantics, not formatting.
 *
 * The separation is deliberate: canonical order stays the change-set contract,
 * `mutationOrdinal` carries creation order, and publication restores it for new keys.
 */
/** A delivery request satisfying the least-privilege offer schema. */
function offerRequest(id: string, deviceInstanceId: string, eventId: string) {
  return {
    schemaVersion: "2.0",
    messageId: `response-requested:${eventId}:${deviceInstanceId}`,
    eventId,
    deliveryId: id,
    deliveryStatus: "SENT",
    occurredAt: BASE_TIME,
    eventType: "FALL_ASSISTANCE",
    positioningTier: "SEARCH_RING",
    distanceRange: "DISTANCE_500_1000M",
    etaRange: "ETA_5_10_MIN",
    currentRecruitmentRadiusMeters: 1_000,
    expiresAt: BASE_TIME
  };
}

function deliveryRow(id: string) {
  return {
    id, eventId: uuid(400), deviceInstanceId: uuid(100),
    request: offerRequest(id, uuid(100), uuid(400)),
    status: "SENT", statusOccurredAt: BASE_TIME
  };
}

test("publication: new deliveries keep creation order, not canonical order", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  // Deliberately created in an order that id-sorting would reverse.
  const created = [uuid(101), uuid(102), uuid(104)];

  const sealed = await store.transactEntities!((tx) => {
    for (const id of created) {
      tx.append("deliveries", id, deliveryRow(id) as never);
    }
    return tx.seal().filter(change => change.collection === "deliveries").map(c => c.key);
  });

  assert.deepEqual(sealed, [...created].sort((l, r) => l.localeCompare(r)),
    "the canonical change set is still ordered by (collection, key)");
  assert.deepEqual(Object.keys(store.read(s => s.deliveries)), created,
    "but the published state is ordered by creation, which is what business code reads");
});

test("publication: canonical change-set order is unchanged by the ordinal", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  const order = await store.transactEntities!((tx) => {
    tx.append("deliveries", uuid(104), deliveryRow(uuid(104)) as never);
    tx.append("deliveries", uuid(101), deliveryRow(uuid(101)) as never);
    return tx.seal().map(change => `${change.collection}:${change.key}`);
  });

  assert.deepEqual(order, [...order].sort(),
    "seal() order is a contract; restoring publication order must not disturb it");
});

test("publication: an entity's ordinal is assigned on first staging and never moves", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  const a = uuid(200);
  const b = uuid(201);

  await store.transactEntities!((tx) => {
    tx.append("deliveries", a, deliveryRow(a) as never);
    tx.update("deliveries", a, (draft) => { (draft as { status: string }).status = "DELIVERED"; });
    tx.update("deliveries", a, (draft) => { (draft as { status: string }).status = "VIEWED"; });
    tx.append("deliveries", b, deliveryRow(b) as never);
  });

  const keys = Object.keys(store.read(s => s.deliveries));
  assert.deepEqual(keys, [a, b],
    "updates after the create must not move the entity behind a later creation");
  assert.equal(store.read(s => s.deliveries[a]!.status), "VIEWED",
    "and the updates themselves still applied");
});

test("publication: a rolled-back transaction leaves no ordinal trace", async () => {
  const store = new MemoryStateStore(seedState(1, 0));
  const before = Object.keys(store.read(s => s.deliveries));

  await assert.rejects(store.transactEntities!((tx) => {
    tx.append("deliveries", uuid(300), deliveryRow(uuid(300)) as never);
    throw new Error("abandoned");
  }), /abandoned/);

  assert.deepEqual(Object.keys(store.read(s => s.deliveries)), before,
    "nothing was published, so there is no ordering trace to leak");

  // And a later, successful transaction still orders its own creations correctly.
  const later = [uuid(401), uuid(400)];
  await store.transactEntities!((tx) => {
    for (const id of later) {
      tx.append("deliveries", id, deliveryRow(id) as never);
    }
  });
  assert.deepEqual(Object.keys(store.read(s => s.deliveries)).slice(-2), later,
    "the abandoned transaction's counter did not bleed into this one");
});
