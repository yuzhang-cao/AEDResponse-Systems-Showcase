// Measures how the per-write cost grows with state size.
// Builds an ISOLATED database (never the live one) with N synthetic users whose
// record shapes come from one real service-provisioned user, then times a no-op
// transaction (= the clone+validate+history check every write pays).
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { loadConfig } from "/opt/aedresponse/current/backend/dist/src/config.js";
import { AEDResponseService } from "/opt/aedresponse/current/backend/dist/src/service.js";
import { SQLiteStateStore, measureStorageCost } from "/opt/aedresponse/current/backend/dist/src/store.js";

const SIZES = (process.argv[2] ?? "50,200,500,1000,2000,4000,8000").split(",").map(Number);
const DB = process.argv[3] ?? "/tmp/aed-loadtest/scale.sqlite";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f); } catch {} }

const config = { ...loadConfig(), dataFile: DB };
const store = await SQLiteStateStore.open(DB, []);
const service = new AEDResponseService(store, config);

// One real user gives canonical record shapes.
const acct = await service.provisionControlledTestAccount("scale-seed");
const principal = service.authenticateToken(acct.sessionToken);
const dev = await service.bootstrap(principal, {
  deviceInstanceId: randomUUID(),
  deviceKind: "IPHONE",
  companionPairId: randomUUID(),
  agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
    .map(kind => ({ kind, version: "2.0", acceptedAt: new Date().toISOString() })),
  capabilities: { notificationAuthorized: true, locationAuthorized: true },
  availableForResponse: true
}, "scale-seed");

const base = store.read(s => ({
  user: Object.values(s.users)[0],
  account: Object.values(s.accounts)[0],
  device: Object.values(s.devices)[0],
  accountSession: Object.values(s.sessionsByTokenHash).find(x => x.sessionKind === "ACCOUNT"),
  deviceSession: Object.values(s.sessionsByTokenHash).find(x => x.sessionKind === "DEVICE"),
  accountKey: Object.keys(s.accountIdByProviderKey)[0]
}));

let created = 1;
async function growTo(target) {
  const need = target - created;
  if (need <= 0) return;
  const at = new Date().toISOString();
  await store.transact(state => {
    for (let i = 0; i < need; i++) {
      const n = created + i;
      const userId = randomUUID(), accountId = randomUUID(), deviceId = randomUUID();
      state.users[userId] = { ...base.user, userId, createdAt: at, updatedAt: at };
      state.accounts[accountId] = { ...base.account, accountId, userId, createdAt: at, lastLoginAt: at };
      state.accountIdByProviderKey[`CONTROLLED_TEST:scale-${n}`] = accountId;
      state.devices[deviceId] = {
        ...base.device, deviceInstanceId: deviceId, userId, accountId, companionPairId: randomUUID()
      };
      // device session (900 s TTL, no refresh) — matches bootstrap output
      const rawDevice = randomBytes(32).toString("base64url");
      const dh = createHash("sha256").update(rawDevice).digest("hex");
      state.sessionsByTokenHash[dh] = {
        ...base.deviceSession, sessionId: randomUUID(), tokenHash: dh,
        userId, accountId, deviceInstanceId: deviceId,
        issuedAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString()
      };
    }
    created = target;
  });
}

async function timeNoop(n) {
  for (let i = 0; i < 2; i++) await store.transact(() => {});
  const s = [];
  const cpu0 = process.cpuUsage();
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await store.transact(() => {});
    s.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const cpu = process.cpuUsage(cpu0);
  s.sort((a, b) => a - b);
  return { med: s[Math.floor(n / 2)], min: s[0], cpuMs: (cpu.user + cpu.system) / 1000 / n };
}

console.log("users\tentities\tpayloadMB\tdbMB\tnoopTx_ms\tcpu_ms_per_tx\ttx_per_sec");
for (const target of SIZES) {
  await growTo(target);
  const cost = store.read(s => measureStorageCost(s));
  const r = await timeNoop(target >= 2000 ? 5 : 10);
  console.log([
    target,
    cost.entityCount,
    (cost.payloadBytes / 1048576).toFixed(2),
    (statSync(DB).size / 1048576).toFixed(2),
    r.med.toFixed(1),
    r.cpuMs.toFixed(1),
    (1000 / r.med).toFixed(2)
  ].join("\t"));
}
await store.close();
