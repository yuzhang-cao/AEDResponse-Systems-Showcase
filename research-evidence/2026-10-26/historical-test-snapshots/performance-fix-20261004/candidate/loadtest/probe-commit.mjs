// Measures the REAL per-commit cost (including WAL fsync) so the Phase-1 write
// ceiling can be projected from measurement rather than from a no-op timing.
//
// Part A: raw SQLite commit cost at each `synchronous` level, same table shape
//         as state_items.  FULL - OFF isolates the sync cost.
// Part B: store-level no-op vs data-changing transaction at a small state size.
import { createRequire } from "node:module";
import { rmSync, statSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";

const require = createRequire("/opt/aedresponse/current/backend/package.json");
const Database = require("better-sqlite3");
const N = Number(process.argv[2] ?? 200);

function stats(label, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const p = q => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  const med = p(.5);
  console.log(`${label.padEnd(34)} median=${med.toFixed(2)}ms p95=${p(.95).toFixed(2)} max=${s[s.length - 1].toFixed(2)}ms  => ${(1000 / med).toFixed(0)} commits/s`);
  return med;
}

// ---------- Part A: raw commit cost ----------
console.log(`\n### Part A: raw SQLite commit (WAL, 1 row upsert per commit, n=${N})`);
const rawResults = {};
for (const sync of ["FULL", "NORMAL", "OFF"]) {
  const f = `/tmp/commit-probe-${sync}.sqlite`;
  for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(f + suffix); } catch {} }
  const db = new Database(f);
  db.pragma("journal_mode = WAL");
  db.pragma(`synchronous = ${sync}`);
  db.exec("CREATE TABLE IF NOT EXISTS state_items(collection TEXT, item_key TEXT, payload TEXT, PRIMARY KEY(collection,item_key))");
  const up = db.prepare(`INSERT INTO state_items(collection,item_key,payload) VALUES(?,?,?)
    ON CONFLICT(collection,item_key) DO UPDATE SET payload=excluded.payload`);
  const commit = db.transaction((i) => { up.run("devices", `k${i % 50}`, `payload-${i}-${"x".repeat(200)}`); });
  for (let i = 0; i < 20; i++) commit(i);              // warm
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    commit(i);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  rawResults[sync] = stats(`synchronous=${sync}`, samples);
  db.close();
}
console.log(`=> 同步成本（FULL − OFF）≈ ${(rawResults.FULL - rawResults.OFF).toFixed(2)} ms/commit`);
console.log(`=> 刷新成本（NORMAL − OFF）≈ ${(rawResults.NORMAL - rawResults.OFF).toFixed(2)} ms/commit`);

// ---------- Part B: store-level no-op vs real change ----------
console.log(`\n### Part B: store-level transactions at a small state (50 users)`);
const DB = "/tmp/store-commit-probe.sqlite";
for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(DB + suffix); } catch {} }
const { loadConfig } = await import("/opt/aedresponse/current/backend/dist/src/config.js");
const { AEDResponseService } = await import("/opt/aedresponse/current/backend/dist/src/service.js");
const { SQLiteStateStore, measureStorageCost } = await import("/opt/aedresponse/current/backend/dist/src/store.js");

const config = { ...loadConfig(), dataFile: DB };
const store = await SQLiteStateStore.open(DB, []);
const service = new AEDResponseService(store, config);
const acct = await service.provisionControlledTestAccount("commit-seed");
const principal = service.authenticateToken(acct.sessionToken);
const dev = await service.bootstrap(principal, {
  deviceInstanceId: randomUUID(), deviceKind: "IPHONE", companionPairId: randomUUID(),
  agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
    .map(kind => ({ kind, version: "2.0", acceptedAt: new Date().toISOString() })),
  capabilities: { notificationAuthorized: true, locationAuthorized: true }, availableForResponse: true
}, "commit-seed");
// pad to 50 users / ~250 entities
const base = store.read(s => ({ user: Object.values(s.users)[0], account: Object.values(s.accounts)[0],
  device: Object.values(s.devices)[0], session: Object.values(s.sessionsByTokenHash).find(x => x.sessionKind === "DEVICE") }));
await store.transact(state => {
  const at = new Date().toISOString();
  for (let i = 1; i < 50; i++) {
    const u = randomUUID(), a = randomUUID(), d = randomUUID();
    state.users[u] = { ...base.user, userId: u, createdAt: at, updatedAt: at };
    state.accounts[a] = { ...base.account, accountId: a, userId: u, createdAt: at, lastLoginAt: at };
    state.accountIdByProviderKey[`CONTROLLED_TEST:probe-${i}`] = a;
    state.devices[d] = { ...base.device, deviceInstanceId: d, userId: u, accountId: a, companionPairId: randomUUID() };
    const h = createHash("sha256").update(randomBytes(32)).digest("hex");
    state.sessionsByTokenHash[h] = { ...base.session, sessionId: randomUUID(), tokenHash: h, userId: u, accountId: a, deviceInstanceId: d, issuedAt: at, expiresAt: new Date(Date.now() + 3.6e6).toISOString() };
  }
});
const cost = store.read(s => measureStorageCost(s));
const devIds = store.read(s => Object.keys(s.devices));
console.log(`state: entities=${cost.entityCount} payload=${(cost.payloadBytes / 1048576).toFixed(2)}MB db=${(statSync(DB).size / 1048576).toFixed(2)}MB`);

async function bench(label, fn, n = N) {
  for (let i = 0; i < 20; i++) await fn(i);
  const s = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint(); await fn(i); s.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return stats(label, s);
}
const noop = await bench("no-op transact (no SQLite commit)", async () => { await store.transact(() => {}); });
const one = await bench("1-entity change (real commit)", async (i) => {
  await store.transact(s => { s.devices[devIds[i % devIds.length]].lastSeenAt = new Date(1700000000000 + i).toISOString(); });
});
const hundred = await bench("100-entity change (real commit)", async (i) => {
  await store.transact(s => { for (let k = 0; k < devIds.length; k++) s.devices[devIds[k]].lastSeenAt = new Date(1700000000000 + i * 1000 + k).toISOString(); });
}, 50);
console.log(`\n=> no-op 与 1 实体变更之差 ≈ ${(one - noop).toFixed(2)} ms —— 这才是每次提交的同步成本`);
await store.close();
