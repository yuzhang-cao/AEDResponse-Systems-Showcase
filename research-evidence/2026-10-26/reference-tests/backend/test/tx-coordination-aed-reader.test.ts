/**
 * `txCoordinationAedReader`: the acquired-AED count answered inside a transaction.
 *
 * Same contract as every other indexed read here - the committed projection
 * contributes candidate keys, the transaction's own view decides - and the same
 * failure modes are possible, so each is locked separately: a staged receipt the
 * index cannot know about, a receipt the predicate must reject despite being a
 * candidate, duplicate reports of one AED collapsing to one, another event's receipt
 * staying out, and a rollback leaving the committed projection untouched.
 *
 * The structural claim is asserted with a counter, not with a write-set size: the
 * reader increments `aedReceiptCandidatesVisited` on every row it actually inspects,
 * so "unrelated receipts are not visited" is measurable.  A counter the path never
 * touches would make this test pass while proving nothing - which is exactly how an
 * earlier structural test went green while measuring zero.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyCoordinationAedReader,
  receiptIdsForEventFrom,
  registerAedReceiptProjection,
  txCoordinationAedReader
} from "../src/coordination-aed-reader.js";
import { MemoryStateStore } from "../src/store.js";
import { emptyState, type PersistentState } from "../src/models.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const AT = "2026-08-31T01:02:00.000Z";
const EVENT_ID = uuid(400);
const OTHER_EVENT_ID = uuid(401);

function receipt(eventId: string, aedId: string, deviceInstanceId: string, tag: string) {
  return {
    canonical: {
      schemaVersion: "2.0", receiptId: tag, eventId, aedId, deviceInstanceId,
      acquiredAt: AT
    },
    fingerprint: tag
  } as never;
}

function world(): PersistentState {
  const state = emptyState();
  state.aedReceiptsById[uuid(800)] = receipt(EVENT_ID, uuid(900), uuid(100), "r1");
  // Same AED reported a second time: the answer counts AEDs, not reports.
  state.aedReceiptsById[uuid(801)] = receipt(EVENT_ID, uuid(900), uuid(103), "r2");
  state.aedReceiptsById[uuid(802)] = receipt(EVENT_ID, uuid(901), uuid(100), "r3");
  // A different event's receipt: a candidate the predicate must reject.
  state.aedReceiptsById[uuid(803)] = receipt(OTHER_EVENT_ID, uuid(902), uuid(100), "r4");
  return state;
}

/**
 * A store with the projection registered - the real one, from the module that owns
 * it, not a re-declaration here that could drift from what production registers.
 */
function storeWithProjection(state: PersistentState): MemoryStateStore {
  const store = new MemoryStateStore(state);
  registerAedReceiptProjection(store);
  return store;
}

const receiptIdsForEvent = receiptIdsForEventFrom;

test("legacy and tx readers agree on a committed-only world", async () => {
  const store = storeWithProjection(world());
  const legacy = legacyCoordinationAedReader(store.read(s => s));

  const viaTx = await store.transactEntities!((tx) =>
    txCoordinationAedReader(tx, { receiptIdsForEvent: receiptIdsForEvent(store) })
      .acquiredAedCount(EVENT_ID));

  assert.equal(legacy.acquiredAedCount(EVENT_ID), 2,
    "two distinct AEDs; the duplicate report does not inflate the count");
  assert.equal(legacy.acquiredAedCount(OTHER_EVENT_ID), 1);
  assert.equal(viaTx, legacy.acquiredAedCount(EVENT_ID));
});

test("a receipt appended in this transaction is counted at once", async () => {
  const store = storeWithProjection(world());

  const count = await store.transactEntities!((tx) => {
    const reader = txCoordinationAedReader(tx, {
      receiptIdsForEvent: receiptIdsForEvent(store)
    });
    assert.equal(reader.acquiredAedCount(EVENT_ID), 2, "before the staged append");
    tx.append("aedReceiptsById", uuid(804),
      receipt(EVENT_ID, uuid(903), uuid(100), "staged"));
    // The committed projection cannot know about this yet; the staged-keys union is
    // what makes it visible.
    return reader.acquiredAedCount(EVENT_ID);
  });

  assert.equal(count, 3, "the reader must see the receipt this transaction just wrote");
});

test("a staged receipt for another event is not counted", async () => {
  const store = storeWithProjection(world());

  const count = await store.transactEntities!((tx) => {
    const reader = txCoordinationAedReader(tx, {
      receiptIdsForEvent: receiptIdsForEvent(store)
    });
    tx.append("aedReceiptsById", uuid(805),
      receipt(OTHER_EVENT_ID, uuid(904), uuid(100), "foreign"));
    return reader.acquiredAedCount(EVENT_ID);
  });

  assert.equal(count, 2,
    "staged keys are candidates only; the exact eventId predicate still decides");
});

test("with no projection the reader still answers correctly by scanning", async () => {
  const store = storeWithProjection(world());
  const viaScan = await store.transactEntities!((tx) =>
    txCoordinationAedReader(tx).acquiredAedCount(EVENT_ID));
  assert.equal(viaScan, 2, "an absent index is a cost problem, never a wrong answer");
});

test("rollback leaves the committed projection and state untouched", async () => {
  const store = storeWithProjection(world());
  const before = store.read(s => Object.keys(s.aedReceiptsById).sort());

  await assert.rejects(store.transactEntities!((tx) => {
    tx.append("aedReceiptsById", uuid(806), receipt(EVENT_ID, uuid(905), uuid(100), "gone"));
    throw new Error("abandoned");
  }), /abandoned/);

  assert.deepEqual(store.read(s => Object.keys(s.aedReceiptsById).sort()), before);
  // And the projection still agrees with the committed state it indexes.
  const after = await store.transactEntities!((tx) =>
    txCoordinationAedReader(tx, { receiptIdsForEvent: receiptIdsForEvent(store) })
      .acquiredAedCount(EVENT_ID));
  assert.equal(after, 2, "no phantom receipt survived the abandoned transaction");
});

test("structure: unrelated receipts are not visited", async () => {
  async function measure(unrelated: number): Promise<number> {
    const state = world();
    for (let index = 0; index < unrelated; index += 1) {
      state.aedReceiptsById[uuid(100_000 + index)] =
        receipt(uuid(200_000 + index), uuid(300_000 + index), uuid(100),
          `hist-${index}`);
    }
    const store = storeWithProjection(state);
    resetMetrics();
    await store.transactEntities!((tx) =>
      txCoordinationAedReader(tx, { receiptIdsForEvent: receiptIdsForEvent(store) })
        .acquiredAedCount(EVENT_ID));
    return snapshotMetrics().operation.aedReceiptCandidatesVisited as number;
  }

  const small = await measure(0);
  const large = await measure(500);

  assert.equal(small, 3,
    "three candidate rows for this event: two distinct AEDs plus the duplicate, and "
    + "NOT the foreign-event receipt, which the projection groups elsewhere");
  assert.equal(large, small,
    `the count must not grow with unrelated receipts (${small} -> ${large}) - without `
    + "the projection this reader would scan every receipt ever recorded");
});
