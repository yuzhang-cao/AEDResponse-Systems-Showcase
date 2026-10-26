// A/B measurement of the instrumentation's own cost.
//
// The switch in SQLiteStateStore.transact() removes the transaction-level timing
// syscalls.  The per-entity counters inside validate/flatten/history-compare are
// deliberately NOT guarded: a branch per visited entity would cost more than the
// integer increment it guards.  So this A/B isolates the switchable part, and the
// unguarded part is bounded analytically in the report instead.
import { rmSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
const DIST = process.env.AED_BACKEND_DIST ?? "/opt/aedresponse/current/backend/dist/src";
const { loadConfig } = await import(`${DIST}/config.js`);
const { AEDResponseService } = await import(`${DIST}/service.js`);
const { SQLiteStateStore, measureStorageCost } = await import(`${DIST}/store.js`);
const { setInstrumentationEnabled } = await import(`${DIST}/runtime-metrics.js`);

const DB = "/tmp/aed-loadtest/overhead.sqlite";
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }

const config = { ...loadConfig(), dataFile: DB };
const store = await SQLiteStateStore.open(DB, []);
const service = new AEDResponseService(store, config);
const acct = await service.provisionControlledTestAccount("overhead-seed");
const principal = service.authenticateToken(acct.sessionToken);
const dev = await service.bootstrap(principal, {
  deviceInstanceId: randomUUID(), deviceKind: "IPHONE", companionPairId: randomUUID(),
  agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
    .map(kind => ({ kind, version: "2.0", acceptedAt: new Date().toISOString() })),
  capabilities: { notificationAuthorized: true, locationAuthorized: true }, availableForResponse: true
}, "overhead-seed");
const base = store.read(s => ({ user: Object.values(s.users)[0], account: Object.values(s.accounts)[0],
  device: Object.values(s.devices)[0], session: Object.values(s.sessionsByTokenHash).find(x => x.sessionKind === "DEVICE") }));
await store.transact(state => {
  const at = new Date().toISOString();
  for (let i = 1; i < 50; i++) {
    const u = randomUUID(), a = randomUUID(), d = randomUUID();
    state.users[u] = { ...base.user, userId: u, createdAt: at, updatedAt: at };
    state.accounts[a] = { ...base.account, accountId: a, userId: u, createdAt: at, lastLoginAt: at };
    state.accountIdByProviderKey[`CONTROLLED_TEST:ovh-${i}`] = a;
    state.devices[d] = { ...base.device, deviceInstanceId: d, userId: u, accountId: a, companionPairId: randomUUID() };
    const h = createHash("sha256").update(randomBytes(32)).digest("hex");
    state.sessionsByTokenHash[h] = { ...base.session, sessionId: randomUUID(), tokenHash: h,
      userId: u, accountId: a, deviceInstanceId: d, issuedAt: at, expiresAt: new Date(Date.now() + 3.6e6).toISOString() };
  }
});
const ids = store.read(s => Object.keys(s.devices));
console.log(`state: entities=${store.read(s => measureStorageCost(s).entityCount)}`);

const N = 150;
async function bench(enabled) {
  setInstrumentationEnabled(enabled);
  const run = async (i) => store.transact(s => {
    s.devices[ids[i % ids.length]].lastSeenAt = new Date(1_700_000_000_000 + i).toISOString();
  });
  for (let i = 0; i < 20; i++) await run(i);
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    await run(i);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(N / 2)];
  console.log(`  instrumentation=${enabled ? "ON " : "OFF"} median=${med.toFixed(3)}ms p95=${samples[Math.floor(N * .95)].toFixed(3)}ms`);
  return med;
}
console.log("data-changing transaction, 251 entities:");
const on = await bench(true);
const off = await bench(false);
const on2 = await bench(true);
const off2 = await bench(false);
const onMed = (on + on2) / 2, offMed = (off + off2) / 2;
console.log(`\nON=${onMed.toFixed(3)}ms OFF=${offMed.toFixed(3)}ms => overhead=${(onMed - offMed).toFixed(3)}ms (${(((onMed - offMed) / offMed) * 100).toFixed(2)}%)`);
await store.close();
