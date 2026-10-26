import { copyFileSync } from "node:fs";
const SRC = process.argv[2];
const DST = "/tmp/shapes.sqlite";
copyFileSync(SRC, DST);
const { SQLiteStateStore } = await import("/opt/aedresponse/current/backend/dist/src/store.js");
const store = await SQLiteStateStore.open(DST, []);
store.read(state => {
  console.log("schemaVersion=" + JSON.stringify(state.schemaVersion));
  const pick = (rec) => rec && Object.fromEntries(Object.entries(rec).map(([k, v]) =>
    [k, typeof v === "object" && v !== null ? (Array.isArray(v) ? `[${v.length}]` : "{obj}") : v]));
  console.log("USER=" + JSON.stringify(pick(Object.values(state.users)[0]), null, 1));
  console.log("ACCOUNT=" + JSON.stringify(pick(Object.values(state.accounts)[0]), null, 1));
  console.log("ACCOUNT_KEY_SAMPLES=" + JSON.stringify(Object.keys(state.accountIdByProviderKey).slice(0, 4)));
  console.log("DEVICE=" + JSON.stringify(pick(Object.values(state.devices)[0]), null, 1));
  console.log("SESSION=" + JSON.stringify(pick(Object.values(state.sessionsByTokenHash)[0]), null, 1));
  console.log("DEVICE_KEYS=" + JSON.stringify(Object.keys(state.devices)[0]));
  console.log("USER_KEYS=" + JSON.stringify(Object.keys(state.users)[0]));
});
await store.close();
