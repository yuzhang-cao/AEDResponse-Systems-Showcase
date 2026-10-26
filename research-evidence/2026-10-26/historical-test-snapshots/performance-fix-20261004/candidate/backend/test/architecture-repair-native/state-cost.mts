/** Isolated synthetic storage cost comparison; not a rescue scenario or target-load acceptance. */
import { performance } from "node:perf_hooks";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStateStore } from "../../src/store.js";

const directory = await mkdtemp(join(tmpdir(), "aedresponse-entity-cost-"));
const rows = [];
const deviceId = "REDACTED-SUPPLEMENT-ID-5372a9309212";
for (const count of [0, 1_000, 10_000, 50_000]) {
  const store = await SQLiteStateStore.open(join(directory, `${count}.sqlite`), []);
  await store.transact(state => {
    state.devices[deviceId] = {deviceInstanceId: deviceId, deviceKind: "IPHONE",
      companionPairId: "REDACTED-SUPPLEMENT-ID-ca1dc6163790", agreements: {},
      capabilities: {notificationAuthorized: false, locationAuthorized: false}, availableForResponse: false,
      presenceObservedAt: "2026-09-09T00:00:00.000Z", lastSeenAt: "2026-09-09T00:00:00.000Z", lastBootstrapAt: "2026-09-09T00:00:00.000Z"};
    state.timelineByEventId.synthetic = Array.from({length: count}, (_, index) => ({
      id: `audit-${index}`, eventId: "synthetic", occurredAt: "2026-09-09T00:00:00.000Z",
      kind: "EVENT_ACTIVATED", message: "Synthetic retained history; never a real user or rescue event."}));
  });
  const legacy = [], entity = [], writes = [];
  for (let index = 0; index < 31; index++) {
    let began = performance.now();
    const old = store.read(state => state.devices[deviceId]);
    const oldTime = performance.now() - began;
    began = performance.now();
    const selected = store.readEntities(view => view.get("devices", deviceId));
    const newTime = performance.now() - began;
    if (JSON.stringify(old) !== JSON.stringify(selected)) throw new Error("Compared queries returned different entities");
    if (index) { legacy.push(oldTime); entity.push(newTime); }
  }
  for (let index = 0; index < 10; index++) {
    const began = performance.now(); await store.transact(() => undefined); writes.push(performance.now()-began);
  }
  const summary = (values: number[]) => { values.sort((a,b)=>a-b); return {medianMs:values[Math.floor(values.length/2)],maxMs:values.at(-1)}; };
  rows.push({auditEntries: count, serializedBytes: store.read(s=>Buffer.byteLength(JSON.stringify(s))),
    legacyFullRead:summary(legacy), entityRead:summary(entity), unchangedNoOpTransaction:summary(writes)});
  await store.close();
  const reopened = await SQLiteStateStore.open(join(directory, `${count}.sqlite`), []);
  if (reopened.read(s=>s.timelineByEventId.synthetic.length) !== count) throw new Error("History did not survive reopening");
  await reopened.close();
}
const result = {node:process.version,platform:process.platform,arch:process.arch, directory,
  scope:"Same-process interleaved same-entity reads against isolated synthetic history. Writes/startup remain full-state; no target capacity or concurrency claim.",rows};
await writeFile(join(directory,"result.json"), JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
