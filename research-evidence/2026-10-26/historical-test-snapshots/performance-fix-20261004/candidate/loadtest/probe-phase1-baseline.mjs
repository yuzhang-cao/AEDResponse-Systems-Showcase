// Phase 1 baseline probe: how many entities does ONE standby position upload
// touch, and does that count grow with unrelated history?
//
// This is the "before" measurement for the agreed structural gate
// (docs/storage-refactor-plan-final.md §4.2): scanned / copied / validated /
// serialized entity counts must not grow with unrelated history, and
// full-state clone / flatten / history-compare calls must reach 0.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { rmSync } from "node:fs";
const DIST = process.env.AED_BACKEND_DIST ?? "/opt/aedresponse/current/backend/dist/src";
const { loadConfig } = await import(`${DIST}/config.js`);
const { AEDResponseService } = await import(`${DIST}/service.js`);
const { SQLiteStateStore, measureStorageCost } = await import(`${DIST}/store.js`);
const { resetMetrics, snapshotMetrics } = await import(`${DIST}/runtime-metrics.js`);

const HISTORY_SIZES = (process.argv[2] ?? "1,10,100").split(",").map(Number); // thousands of entities
const DB = "/tmp/aed-loadtest/phase1-baseline.sqlite";

for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(DB + suffix); } catch {} }
const config = { ...loadConfig(), dataFile: DB };
const store = await SQLiteStateStore.open(DB, []);
const service = new AEDResponseService(store, config);

// --- one real standby device that will do the uploading ---
const acct = await service.provisionControlledTestAccount("baseline-uploader");
const principal = service.authenticateToken(acct.sessionToken);
const device = await service.bootstrap(principal, {
  deviceInstanceId: randomUUID(), deviceKind: "IPHONE", companionPairId: randomUUID(),
  agreementAcceptances: ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
    .map(kind => ({ kind, version: "2.0", acceptedAt: new Date().toISOString() })),
  capabilities: { notificationAuthorized: true, locationAuthorized: true }, availableForResponse: true
}, "baseline-uploader");
const uploader = service.authenticateToken(device.sessionToken);

// --- synthetic unrelated history (closed events + their position batches) ---
const base = store.read(s => ({
  user: Object.values(s.users)[0],
  account: Object.values(s.accounts)[0],
  dev: Object.values(s.devices)[0],
  session: Object.values(s.sessionsByTokenHash).find(x => x.sessionKind === "DEVICE")
}));

async function growHistoryTo(targetEntities) {
  const current = store.read(s => measureStorageCost(s).entityCount);
  const need = targetEntities - current;
  if (need <= 0) return 0;
  const at = new Date().toISOString();
  let added = 0;
  await store.transact(state => {
    // Unrelated standby devices plus closed-event position batches.
    let i = 0;
    while (added < need) {
      if (i % 3 === 0) {
        const u = randomUUID(), a = randomUUID(), d = randomUUID();
        state.users[u] = { ...base.user, userId: u, createdAt: at, updatedAt: at };
        state.accounts[a] = { ...base.account, accountId: a, userId: u, createdAt: at, lastLoginAt: at };
        state.accountIdByProviderKey[`CONTROLLED_TEST:hist-${u}`] = a;
        state.devices[d] = { ...base.dev, deviceInstanceId: d, userId: u, accountId: a, companionPairId: randomUUID() };
        const h = createHash("sha256").update(randomBytes(32)).digest("hex");
        state.sessionsByTokenHash[h] = { ...base.session, sessionId: randomUUID(), tokenHash: h,
          userId: u, accountId: a, deviceInstanceId: d, issuedAt: at, expiresAt: new Date(Date.now() + 3.6e6).toISOString() };
        added += 4;
      } else {
        const batchId = randomUUID();
        const eventId = randomUUID();
        const recordIds = [];
        const slots = [];
        // Globally unique, consecutive whole seconds; slotAt uniqueness is per batch.
        const slotBase = 1_600_000_000_000 + (historyCounter++) * 5_000;
        for (let k = 0; k < 5; k++) {
          recordIds.push(randomUUID());
          slots.push(new Date(slotBase + k * 1000).toISOString());
        }
        state.eventPositionBatchesById[batchId] = {
          batchId, eventId,
          userId: base.user.userId,
          deviceInstanceId: base.dev.deviceInstanceId,
          kind: "R",
          fingerprint: `hist-${batchId}`,
          receivedAt: at,
          records: slots.map((slotAt, k) => ({
            recordId: recordIds[k], batchId, eventId,
            userId: base.user.userId,
            deviceInstanceId: base.dev.deviceInstanceId,
            kind: "R",
            slotAt,
            serverReceivedAt: at,
            status: "NO_NEW_FIX",
            gapReason: "NO_FIX",
            appliedToLatest: false,
            ignoredAsStale: false
          }))
        };
        added += 1;
      }
      i += 1;
    }
  });
  return added;
}

let historyCounter = 0;
let clock = Date.now();
function nextPosition() {
  clock += 1000;
  return {
    positionUpdateId: randomUUID(),
    responderPosition: { kind: "R", latitude: 35.6812 + Math.random() * 0.01, longitude: 139.7671 + Math.random() * 0.01, accuracyMeters: 12 },
    observedAt: new Date(clock).toISOString()
  };
}

const H = [
  "entities", "validated", "serialized", "historyCmp",
  "clones_tx", "clones_norm", "clones_storeRead", "clones_TOTAL",
  "batchClones", "flattens",
  "collLoad_events", "collLoad_deliv", "collLoad_assign", "deviceLoads", "accessLoadMs",
  "pathRuns", "fallbackRuns", "sqlBizRows", "sqlRevBumps", "sqlCommits",
  "opMs", "preTxMs", "queueMs", "txServiceMs", "drainMs", "publishMs", "responseMs", "unattribMs"
];
console.log(H.join("\t"));
for (const thousands of HISTORY_SIZES) {
  await growHistoryTo(thousands * 1000);
  const cost = store.read(s => measureStorageCost(s));
  await service.updateResponderPosition(uploader, nextPosition());   // warm
  await new Promise(r => setTimeout(r, 20));
  resetMetrics();
  await service.updateResponderPosition(uploader, nextPosition());
  const { storage: m, operation: o, totalFullStateClones: totalClones } = snapshotMetrics();
  console.log([
    cost.entityCount, m.validatedEntities, m.serializedEntities, m.historyComparedEntities,
    m.fullStateClones.transactionDraft, m.fullStateClones.normalization, m.fullStateClones.storeRead, totalClones,
    m.batchLevelClones, m.fullStateFlattens,
    o.presenceCollectionLoads.events, o.presenceCollectionLoads.deliveries, o.presenceCollectionLoads.assignments,
    o.presenceDeviceLoads, o.presenceAccessLoadMs.toFixed(2),
    o.incrementalPathRuns, o.recruitmentFallbackRuns,
    m.businessEntityUpserts, m.revisionMetadataUpdates, m.commitCalls,
    o.operationElapsedMs.toFixed(2), o.preTransactionMs.toFixed(2), m.queueWaitMs.toFixed(2),
    m.transactionServiceMs.toFixed(2), o.notificationDrainMs.toFixed(2),
    o.recruitmentPublishMs.toFixed(2), o.responseMs.toFixed(2), o.unattributedMs.toFixed(2)
  ].join("\t"));
}
await store.close();
