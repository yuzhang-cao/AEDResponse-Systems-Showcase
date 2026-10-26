// Injects synthetic standby users DIRECTLY into a target database in ONE
// transaction (record shapes cloned from a real service-provisioned user).
// Used to measure how the live service's end-to-end write ceiling falls as the
// retained state grows.  MUST run with aedresponse.service stopped.
//
// Usage: node inject-users.mjs <targetTotalUsers> <dbPath>
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { loadConfig } from "/opt/aedresponse/current/backend/dist/src/config.js";
import { SQLiteStateStore, measureStorageCost } from "/opt/aedresponse/current/backend/dist/src/store.js";

const target = Number(process.argv[2] ?? 500);
const dbPath = process.argv[3] ?? "/var/lib/aedresponse/state.sqlite";

const config = { ...loadConfig(), dataFile: dbPath };
const store = await SQLiteStateStore.open(dbPath, []);
const before = store.read(s => ({ users: Object.keys(s.users).length, cost: measureStorageCost(s) }));

const need = target - before.users;
if (need <= 0) {
  console.log(`SKIP users=${before.users} already >= ${target}`);
} else {
  const base = store.read(s => ({
    user: Object.values(s.users)[0],
    account: Object.values(s.accounts)[0],
    device: Object.values(s.devices).find(d => d.deviceKind === "IPHONE"),
    deviceSession: Object.values(s.sessionsByTokenHash).find(x => x.sessionKind === "DEVICE" && x.deviceKind === "IPHONE")
  }));
  if (!base.device || !base.deviceSession) throw new Error("no iPhone baseline record to clone");
  const at = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const t0 = Date.now();
  await store.transact(state => {
    for (let i = 0; i < need; i++) {
      const n = before.users + i;
      const userId = randomUUID(), accountId = randomUUID(), deviceId = randomUUID();
      state.users[userId] = { ...base.user, userId, createdAt: at, updatedAt: at };
      state.accounts[accountId] = { ...base.account, accountId, userId, createdAt: at, lastLoginAt: at };
      state.accountIdByProviderKey[`CONTROLLED_TEST:bulk-${n}`] = accountId;
      state.devices[deviceId] = {
        ...base.device, deviceInstanceId: deviceId, userId, accountId, companionPairId: randomUUID()
      };
      const raw = randomBytes(32).toString("base64url");
      const h = createHash("sha256").update(raw).digest("hex");
      state.sessionsByTokenHash[h] = {
        ...base.deviceSession, sessionId: randomUUID(), tokenHash: h,
        userId, accountId, deviceInstanceId: deviceId, issuedAt: at, expiresAt
      };
    }
  });
  console.log(`injected ${need} users in one transaction: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const after = store.read(s => ({ users: Object.keys(s.users).length, cost: measureStorageCost(s) }));
console.log(`RESULT users ${before.users} -> ${after.users} entities ${before.cost.entityCount} -> ${after.cost.entityCount} `
  + `payload ${(before.cost.payloadBytes / 1048576).toFixed(2)}MB -> ${(after.cost.payloadBytes / 1048576).toFixed(2)}MB`);
console.log(`  eventPositions=${after.cost.eventPositionRecordCount} timeline=${after.cost.timelineEntryCount}`);
await store.close();
