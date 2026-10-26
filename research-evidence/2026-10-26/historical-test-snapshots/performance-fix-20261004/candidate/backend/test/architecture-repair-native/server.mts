import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const directory = process.argv[3];
const { createBackend } = await import(pathToFileURL(join(root, 'backend/src/server.ts')).href);
const { SQLiteStateStore } = await import(pathToFileURL(join(root, 'backend/src/store.ts')).href);
const { loadConfig } = await import(pathToFileURL(join(root, 'backend/src/config.ts')).href);
await mkdir(directory, { recursive: true, mode: 0o700 });
const resuming = process.argv[4] === 'resume';
const previous = resuming ? JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) : undefined;
const clockPath = join(directory, 'clock.txt');
if (!resuming) await writeFile(clockPath, String(Math.floor(Date.now()/1000)), { mode: 0o600 });
const now = () => new Date(Number(readFileSync(clockPath, 'utf8'))*1000);
const store = await SQLiteStateStore.open(join(directory, 'chain.sqlite'), []);
const backend = await createBackend({config: { ...loadConfig({}), host: '127.0.0.1', port: previous ? Number(new URL(previous.baseURL).port) : 0,
 enableControlledTestAccounts: true, authSubjectPepper: 'local-c5-fixture-only', production: false,
 watchAppAttestAppId: 'LOCAL.TEST.WATCH' }, store, now,
 watchAttestationVerifier: { verifyAttestation: async input => ({verified: input.attestationObject === Buffer.from('C5_TEST_ATTESTATION').toString('base64'), deviceInstanceId: input.deviceInstanceId}) }});
await backend.start();
const account = previous ? {sessionToken:previous.accessToken, refreshToken:previous.refreshToken,
 expiresAt:previous.expiresAt, userId:previous.userId} : await backend.service.provisionControlledTestAccount('iphone16');
await writeFile(join(directory, 'ready.json'), JSON.stringify({kind:'LOCAL_C5_INTEGRATION', baseURL:backend.baseURL(), clockPath,
 epoch:now().getTime()/1000, accessToken:account.sessionToken, refreshToken:account.refreshToken,
 expiresAt:account.expiresAt, userId:account.userId, directory}), {mode:0o600});
console.log('Local fixture ready; credentials are confined to its private ready.json');
let stopping = false;
async function stop() {
 if (stopping) return; stopping = true;
 await backend.stop();
 const durable = await SQLiteStateStore.open(join(directory, 'chain.sqlite'), []);
 const state = durable.read(s=>s);
 const summary = {events:Object.values(state.events).map(e=>({id:e.id,state:e.state,createdAt:e.createdAt,resolvedAt:e.resolvedAt})),
 taskCount:Object.keys(state.assignments).length, notificationRecords:Object.values(state.notificationOutboxById).map(n=>({id:n.id,status:n.status})),
 watchFacts:Object.values(state.positionUpdateReceiptsById).filter(r=>r.watchFallbackFact).map(r=>({id:r.positionUpdateId,eventId:r.eventId,fact:r.watchFallbackFact}))};
 await writeFile(join(directory,'backend-result.json'), JSON.stringify(summary,null,2));
 await durable.close();
 const reopened = await SQLiteStateStore.open(join(directory,'chain.sqlite'), []);
 const check = reopened.read(s=>({eventCount:Object.keys(s.events).length,states:Object.values(s.events).map(e=>e.state),
 watchFactCount:Object.values(s.positionUpdateReceiptsById).filter(r=>r.watchFallbackFact).length,
 outboxCount:Object.keys(s.notificationOutboxById).length}));
 await writeFile(join(directory,'reopened-result.json'), JSON.stringify(check,null,2));
 await reopened.close();
 console.log('Local fixture stopped and SQLite reopened for durable-state verification');
}
process.on('SIGTERM',()=>{void stop().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});});
process.on('SIGINT',()=>{void stop().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});});
