// Read-only cost probe: measures full-state transaction cost at the current DB size.
// Runs against a COPY of state.sqlite with the live service untouched.
import { copyFileSync, statSync } from "node:fs";

const SRC = process.argv[2] ?? "/var/lib/aedresponse/state.sqlite";
const DST = process.argv[3] ?? "/tmp/aed-loadtest/probe.sqlite";

copyFileSync(SRC, DST);
const mod = await import("/opt/aedresponse/current/backend/dist/src/store.js");
const { SQLiteStateStore, measureStorageCost } = mod;

const sizeMB = (statSync(DST).size / 1048576).toFixed(2);
const store = await SQLiteStateStore.open(DST, []);

const cost = store.read(state => measureStorageCost(state));
console.log(`file=${sizeMB}MB entities=${cost.entityCount} payload=${(cost.payloadBytes / 1048576).toFixed(2)}MB`);
console.log("collections=" + JSON.stringify(Object.fromEntries(
  Object.entries(cost.collectionCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]))));
console.log(`timeline=${cost.timelineEntryCount} eventPositions=${cost.eventPositionRecordCount} pendingNotifications=${cost.pendingNotificationCount}`);

async function bench(label, fn, n = 10) {
  for (let i = 0; i < 3; i++) await fn(); // warm
  const samples = [];
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  samples.sort((a, b) => a - b);
  console.log(`${label}: median=${samples[Math.floor(n / 2)].toFixed(2)}ms min=${samples[0].toFixed(2)} max=${samples[n - 1].toFixed(2)}ms (n=${n})`);
  return samples[Math.floor(n / 2)];
}

const noop = await bench("noop transact (clone+validate+persist-diff)", () => store.transact(() => {}), 10);
const read = await bench("full snapshot read (clone)", () => new Promise(r => { store.read(() => {}); r(); }), 10);
const ent = await bench("entity read (devices)", () => new Promise(r => { store.readEntities(() => {}); r(); }), 10);
console.log(`rss=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB heapUsed=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB`);
console.log(`DERIVED noop_tx_per_sec=${(1000 / noop).toFixed(0)}`);
await store.close();
