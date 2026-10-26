import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SQLiteStateStore } from "../src/store.js";
import { resetMetrics, snapshotMetrics } from "../src/runtime-metrics.js";

const deviceId = "REDACTED-SUPPLEMENT-ID-f72140aaba35";
const pairId = "REDACTED-SUPPLEMENT-ID-dea1cb63a1de";
const at = "2026-10-04T00:00:00.000Z";

for (const operation of ["update", "delete"] as const) {
  test(`failed SQLite entity ${operation} does not poison a later full-state retry`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "aed-entity-rollback-"));
    const path = join(directory, "state.sqlite");
    let store = await SQLiteStateStore.open(path, []);
    const control = new Database(path);
    t.after(async () => {
      control.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    });
    await store.transactEntities(tx => tx.append("devices", deviceId, {
      deviceInstanceId: deviceId, deviceKind: "IPHONE", companionPairId: pairId,
      agreements: {}, capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true, presenceObservedAt: at, lastSeenAt: at, lastBootstrapAt: at
    }));
    control.exec(`CREATE TRIGGER fail_revision BEFORE UPDATE OF value ON state_metadata
      WHEN NEW.key = 'revision' BEGIN SELECT RAISE(ABORT, 'forced revision failure'); END;`);
    resetMetrics();
    await assert.rejects(store.transactEntities(tx => {
      if (operation === "delete") tx.remove("devices", deviceId);
      else tx.update("devices", deviceId, device => { device.availableForResponse = false; });
    }), /forced revision failure/);
    assert.equal(store.readEntities(view => view.get("devices", deviceId))?.availableForResponse, true);
    assert.equal(snapshotMetrics().storage.commitCalls, 0);
    assert.equal(snapshotMetrics().storage.businessEntityUpserts, 0);
    assert.equal(snapshotMetrics().storage.businessEntityDeletes, 0);
    const persisted = control.prepare("SELECT payload FROM state_items WHERE collection='devices' AND item_key=?")
      .get(deviceId) as { payload: string };
    assert.equal(JSON.parse(persisted.payload).availableForResponse, true);

    control.exec("DROP TRIGGER fail_revision");
    await store.transact(state => {
      if (operation === "delete") delete state.devices[deviceId];
      else state.devices[deviceId]!.availableForResponse = false;
    });
    await store.close();
    store = await SQLiteStateStore.open(path, []);
    const device = store.readEntities(view => view.get("devices", deviceId));
    if (operation === "delete") assert.equal(device, undefined);
    else assert.equal(device?.availableForResponse, false);
  });
}
