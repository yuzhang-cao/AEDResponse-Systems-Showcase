// Seeds a synthetic standby fleet INTO THE LIVE DATABASE using the real service
// API (provisionControlledTestAccount + bootstrap), exactly as the controlled-test
// onboarding does.  MUST run with aedresponse.service stopped (single-writer store).
//
// Usage: node seed-fleet.mjs <count> <outfile.json> [startIndex]
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadConfig } from "/opt/aedresponse/current/backend/dist/src/config.js";
import { AEDResponseService } from "/opt/aedresponse/current/backend/dist/src/service.js";
import { SQLiteStateStore } from "/opt/aedresponse/current/backend/dist/src/store.js";

const count = Number(process.argv[2] ?? 20);
const outFile = process.argv[3] ?? "/tmp/fleet.json";
const startIndex = Number(process.argv[4] ?? 1);

const config = loadConfig();
if (!config.enableControlledTestAccounts) throw new Error("Controlled test accounts are disabled");

const store = await SQLiteStateStore.open(config.dataFile, []);
const service = new AEDResponseService(store, config);

const agreements = [
  "PATIENT",
  "VOLUNTEER_RESPONDER",
  "PRIVACY_POLICY",
  "SENSITIVE_PERSONAL_INFORMATION"
].map(kind => ({ kind, version: "2.0", acceptedAt: new Date().toISOString() }));

const fleet = [];
const t0 = Date.now();
let lastReport = t0;

for (let i = 0; i < count; i++) {
  const n = startIndex + i;
  const accountKey = `lt-${String(n).padStart(5, "0")}`;
  const account = await service.provisionControlledTestAccount(accountKey);
  const principal = service.authenticateToken(account.sessionToken);
  const deviceInstanceId = randomUUID();
  const companionPairId = randomUUID();
  const device = await service.bootstrap(
    principal,
    {
      deviceInstanceId,
      deviceKind: "IPHONE",
      companionPairId,
      agreementAcceptances: agreements,
      capabilities: { notificationAuthorized: true, locationAuthorized: true },
      availableForResponse: true
    },
    `seed-${n}`
  );
  fleet.push({
    accountKey,
    userId: account.userId,
    accountId: account.accountId,
    accountToken: account.sessionToken,
    accountRefreshToken: account.refreshToken,
    deviceToken: device.sessionToken,
    deviceInstanceId,
    companionPairId,
    deviceSessionExpiresAt: device.expiresAt
  });
  if (Date.now() - lastReport > 15000) {
    lastReport = Date.now();
    const per = (Date.now() - t0) / (i + 1);
    console.log(`seeded ${i + 1}/${count} avg=${per.toFixed(0)}ms/user eta=${(((count - i - 1) * per) / 1000).toFixed(0)}s`);
  }
}

writeFileSync(outFile, JSON.stringify({ createdAt: new Date().toISOString(), fleet }, null, 0), { mode: 0o644 });
const cost = store.read(s => s);
console.log(`DONE seeded=${fleet.length} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s out=${outFile}`);
await store.close();
