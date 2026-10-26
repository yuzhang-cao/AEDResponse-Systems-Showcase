// Socket.IO connection scaling: measures connect rate, per-connect latency,
// steady-state RSS and CPU as the number of authenticated iPhone connections grows.
import { readFileSync } from "node:fs";

const FLEET = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/aed-loadtest/fleet.json", "utf8"));
const BASE = process.argv[3] ?? "http://127.0.0.1:8787";
const PLAN = (process.argv[4] ?? "50,200,500,1000,2000").split(",").map(Number);
const HOLD = Number(process.argv[5] ?? 20);
const PID = Number(process.argv[6] ?? 0);

const { io } = await import("/opt/aedresponse/current/backend/node_modules/socket.io-client/build/esm/index.js");

function procSample() {
  if (!PID) return null;
  try {
    const stat = readFileSync(`/proc/${PID}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${PID}/status`, "utf8"));
    return { ticks: Number(f[11]) + Number(f[12]), rssMB: rss ? Number(rss[1]) / 1024 : 0 };
  } catch { return null; }
}

console.log("target\tconnected\tfailed\tconnectSec\tconnPerSec\tp50ms\tp95ms\trssMB\tserverCores");
for (const N of PLAN) {
  const before = procSample();
  const clients = [];
  const lat = [];
  let connected = 0, failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const cfg = FLEET.fleet[i % FLEET.fleet.length];
    const started = Date.now();
    const s = io(BASE, {
      transports: ["websocket"],
      extraHeaders: { authorization: `Bearer ${cfg.deviceToken}` },
      reconnection: false,
      timeout: 20000
    });
    clients.push(s);
    s.on("connect", () => { connected++; lat.push(Date.now() - started); });
    s.on("connect_error", () => { failed++; lat.push(Date.now() - started); });
    if ((i + 1) % 20 === 0) await new Promise(r => setTimeout(r, 20));
  }
  // Wait until all settle or give up.
  const settleDeadline = Date.now() + 90000;
  while (connected + failed < N && Date.now() < settleDeadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  const connectSec = (Date.now() - t0) / 1000;
  const sorted = lat.sort((a, b) => a - b);
  const p = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
  const holdStart = procSample();
  await new Promise(r => setTimeout(r, HOLD * 1000));
  const after = procSample();
  const cores = before && after ? (after.ticks - before.ticks) / 100 / (connectSec + HOLD) : 0;
  console.log([
    N, connected, failed, connectSec.toFixed(1), (connected / connectSec).toFixed(1),
    p(.5), p(.95), after ? after.rssMB.toFixed(0) : "?", cores.toFixed(3)
  ].join("\t"));
  if (holdStart && after && after.rssMB > 470) {
    console.log(`!! RSS ${after.rssMB.toFixed(0)}MB approaching the 512MB systemd cap — stopping ramp`);
    for (const s of clients) s.close();
    break;
  }
  for (const s of clients) s.close();
  await new Promise(r => setTimeout(r, 2000));
  const post = procSample();
  console.log(`# after close: rss=${post ? post.rssMB.toFixed(0) : "?"}MB`);
}
process.exit(0);
