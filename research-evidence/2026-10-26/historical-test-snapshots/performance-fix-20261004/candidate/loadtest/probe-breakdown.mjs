// Breaks the per-write cost into in-memory (clone+validate+history+deepEqual)
// and persistence (flatten+diff+SQLite commit) phases.
import { copyFileSync } from "node:fs";

const SRC = process.argv[2] ?? "/home/REDACTED/aed-loadtest/state-copy.sqlite";
const DST = "/tmp/probe2.sqlite";
copyFileSync(SRC, DST);
const { SQLiteStateStore, MemoryStateStore } = await import(
  "/opt/aedresponse/current/backend/dist/src/store.js"
);

const store = await SQLiteStateStore.open(DST, []);
const cloned = store.read(state => state);
const memory = new MemoryStateStore(cloned);

async function bench(label, fn, n = 15) {
  for (let i = 0; i < 3; i++) await fn();
  const s = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await fn();
    s.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  s.sort((a, b) => a - b);
  const med = s[Math.floor(n / 2)];
  console.log(`${label}: median=${med.toFixed(2)}ms min=${s[0].toFixed(2)} max=${s[n - 1].toFixed(2)}ms`);
  return med;
}

const cloneOnly = await bench("A. clone only (store.read)", () => new Promise(r => { store.read(() => {}); r(); }));
const memTx = await bench("B. memory transact (clone+validate+history+deepEqual)", () => memory.transact(() => {}));
const sqlTx = await bench("C. sqlite transact (B + flatten+diff+fsync)", () => store.transact(() => {}));

console.log("");
console.log(`clone                = ${cloneOnly.toFixed(2)} ms`);
console.log(`validate+hist+deepEq = ${(memTx - cloneOnly).toFixed(2)} ms`);
console.log(`persist (flatten+io) = ${(sqlTx - memTx).toFixed(2)} ms`);
console.log(`TOTAL per write      = ${sqlTx.toFixed(2)} ms  => ${(1000 / sqlTx).toFixed(1)} writes/sec ceiling`);
await store.close();
