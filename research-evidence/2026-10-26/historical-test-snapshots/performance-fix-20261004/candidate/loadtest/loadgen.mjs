// Load generator for the AEDResponse backend. Runs on the VM, targets the live
// service on 127.0.0.1:8787 (or any base URL).
//
// Modes:
//   probe                       one sequential request per endpoint (characterize)
//   sat <endpoint> <C> <secs>   saturate one endpoint at C concurrent workers
//   sockets <N> <secs>          open N authenticated Socket.IO connections and hold
import http from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const mode = args[0] ?? "probe";
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = opt("target", "http://127.0.0.1:8787");
const FLEET = JSON.parse(readFileSync(opt("fleet", "/home/REDACTED/aed-loadtest/fleet.json"), "utf8"));
const SERVER_PID = Number(opt("pid", "0")) || undefined;

const agent = new http.Agent({ keepAlive: true, maxSockets: 4096, maxFreeSockets: 512 });
const url = new URL(BASE);

function request(method, path, token, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port || 80, method, path, agent,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {})
      }
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const state = { sent: 0, ok: 0, err: 0, byStatus: new Map(), lat: [] };
function record(status, ms) {
  state.sent++;
  if (status >= 200 && status < 300) state.ok++; else state.err++;
  state.byStatus.set(status, (state.byStatus.get(status) ?? 0) + 1);
  state.lat.push(ms);
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function summary(label, seconds) {
  const l = state.lat;
  const line = `${label}: sent=${state.sent} ok=${state.ok} err=${state.err} `
    + `rps=${(state.sent / seconds).toFixed(1)} `
    + `p50=${pct(l, .5).toFixed(1)} p95=${pct(l, .95).toFixed(1)} p99=${pct(l, .99).toFixed(1)} max=${Math.max(...l).toFixed(1)}ms`;
  console.log(line);
  console.log(`  statuses=${JSON.stringify(Object.fromEntries([...state.byStatus].sort()))}`);
  return { sent: state.sent, ok: state.ok, err: state.err, rps: state.sent / seconds, p50: pct(l, .5), p95: pct(l, .95), p99: pct(l, .99) };
}

function cpuSample() {
  if (!SERVER_PID) return null;
  try {
    const stat = readFileSync(`/proc/${SERVER_PID}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const f = stat.slice(close + 2).split(" ");
    const status = readFileSync(`/proc/${SERVER_PID}/status`, "utf8");
    const rss = /VmRSS:\s+(\d+) kB/.exec(status);
    return { ticks: Number(f[11]) + Number(f[12]), rssKB: rss ? Number(rss[1]) : 0 };
  } catch { return null; }
}

let positionClock = Date.now();
function positionBody(deviceIndex) {
  // Monotonic per-process observedAt keeps samples fresh and non-regressing.
  positionClock += 1;
  return {
    positionUpdateId: randomUUID(),
    responderPosition: {
      kind: "R",
      latitude: 35.6812 + (deviceIndex % 100) * 0.0001,
      longitude: 139.7671 + (deviceIndex % 100) * 0.0001,
      accuracyMeters: 12
    },
    observedAt: new Date(positionClock).toISOString()
  };
}
function presenceBody(deviceIndex) {
  positionClock += 1;
  return {
    presenceUpdateId: randomUUID(),
    occurredAt: new Date(positionClock).toISOString(),
    availableForResponse: true,
    capabilities: { notificationAuthorized: true, locationAuthorized: true }
  };
}

const ENDPOINTS = {
  healthz: () => ({ method: "GET", path: "/healthz", token: null }),
  events: i => ({ method: "GET", path: "/api/v2/events", token: FLEET.fleet[i % FLEET.fleet.length].deviceToken }),
  presence: i => ({ method: "GET", path: "/api/v2/me/presence", token: FLEET.fleet[i % FLEET.fleet.length].deviceToken }),
  aeds: i => ({ method: "GET", path: "/api/v2/aeds", token: FLEET.fleet[i % FLEET.fleet.length].deviceToken }),
  nearby: i => ({ method: "GET", path: "/api/v2/me/nearby-volunteers", token: FLEET.fleet[i % FLEET.fleet.length].deviceToken }),
  putposition: i => ({ method: "PUT", path: "/api/v2/me/responder-position", token: FLEET.fleet[i % FLEET.fleet.length].deviceToken, body: positionBody(i) }),
  putpresence: i => ({ method: "PUT", path: "/api/v2/me/presence", token: FLEET.fleet[i % FLEET.fleet.length].deviceToken, body: presenceBody(i) })
};

async function runOne(name, i) {
  const spec = ENDPOINTS[name](i);
  const t = process.hrtime.bigint();
  try {
    const res = await request(spec.method, spec.path, spec.token, spec.body);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    record(res.status, ms);
    return res;
  } catch (e) {
    record(0, Number(process.hrtime.bigint() - t) / 1e6);
    return { status: 0, body: String(e) };
  }
}

async function probe() {
  console.log(`# probe against ${BASE} (fleet=${FLEET.fleet.length} devices, pid=${SERVER_PID ?? "?"})`);
  for (const name of Object.keys(ENDPOINTS)) {
    const n = 30;
    const before = state.sent;
    const t0 = process.hrtime.bigint();
    const samples = [];
    const kind = cpuSample();
    for (let i = 0; i < n; i++) {
      const t = process.hrtime.bigint();
      const res = await runOne(name, i);
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (i === 0) console.log(`  ${name}: first status=${res.status} body=${res.body.slice(0, 120)}`);
    }
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const kind2 = cpuSample();
    const cores = kind && kind2 ? (kind2.ticks - kind.ticks) / 100 / secs : 0;
    const s = [...samples].sort((a, b) => a - b);
    console.log(`${name.padEnd(12)} n=${n} seq=${(n / secs).toFixed(1)}/s `
      + `p50=${s[Math.floor(n * .5)].toFixed(2)} p95=${s[Math.floor(n * .95)].toFixed(2)}ms `
      + `serverCpu=${cores.toFixed(2)}cores rss=${kind2 ? (kind2.rssKB / 1024).toFixed(0) : "?"}MB`);
    state.lat.length = 0; state.sent = 0; state.ok = 0; state.err = 0; state.byStatus.clear();
  }
}

async function sat(name, C, secs) {
  console.log(`# saturate ${name} C=${C} for ${secs}s @ ${BASE} (pid=${SERVER_PID ?? "?"})`);
  const before = cpuSample();
  const t0 = Date.now();
  const deadline = t0 + secs * 1000;
  let counter = 0;
  const workers = Array.from({ length: C }, async (_, w) => {
    while (Date.now() < deadline) await runOne(name, counter++ + w * 1000);
  });
  await Promise.all(workers);
  const seconds = (Date.now() - t0) / 1000;
  const after = cpuSample();
  const r = summary(`${name} C=${C}`, seconds);
  if (before && after) {
    const cores = (after.ticks - before.ticks) / 100 / seconds;
    console.log(`  serverCpu=${cores.toFixed(2)} cores (${(cores * 100).toFixed(0)}%) rss=${(after.rssKB / 1024).toFixed(0)}MB`);
  }
  console.log(`RESULT ${JSON.stringify({ name, C, seconds: Number(seconds.toFixed(1)), ...r })}`);
}

async function sockets(N, secs) {
  const { io } = await import("/opt/aedresponse/current/backend/node_modules/socket.io-client/build/esm/index.js");
  console.log(`# opening ${N} Socket.IO connections for ${secs}s @ ${BASE}`);
  let connected = 0, failed = 0;
  const t0 = Date.now();
  const clients = [];
  const batch = 25;
  for (let i = 0; i < N; i++) {
    const cfg = FLEET.fleet[i % FLEET.fleet.length];
    const s = io(BASE, {
      transports: ["websocket"],
      auth: {},
      extraHeaders: { authorization: `Bearer ${cfg.deviceToken}` },
      reconnection: false,
      timeout: 15000
    });
    clients.push(s);
    s.on("connect", () => { connected++; });
    s.on("connect_error", () => { failed++; });
    if ((i + 1) % batch === 0) await new Promise(r => setTimeout(r, 50));
  }
  const connectSeconds = (Date.now() - t0) / 1000;
  console.log(`connect phase: ${connected}/${N} connected, ${failed} failed in ${connectSeconds.toFixed(1)}s `
    + `(${(N / connectSeconds).toFixed(0)} conn/s)`);
  const before = cpuSample();
  await new Promise(r => setTimeout(r, secs * 1000));
  const after = cpuSample();
  console.log(`held ${secs}s: connected=${connected} failed=${failed}`);
  if (before && after) {
    const cores = (after.ticks - before.ticks) / 100 / secs;
    console.log(`  idle-hold serverCpu=${cores.toFixed(3)} cores rss=${(after.rssKB / 1024).toFixed(0)}MB`);
  }
  for (const s of clients) s.close();
  await new Promise(r => setTimeout(r, 500));
  console.log(`RESULT ${JSON.stringify({ mode: "sockets", N, connected, failed, connectSeconds: Number(connectSeconds.toFixed(2)) })}`);
}

if (mode === "probe") await probe();
else if (mode === "sat") await sat(args[1], Number(args[2] ?? 16), Number(args[3] ?? 20));
else if (mode === "sockets") await sockets(Number(args[1] ?? 100), Number(args[2] ?? 30));
else { console.error(`unknown mode ${mode}`); process.exit(2); }
agent.destroy();
process.exit(0);
