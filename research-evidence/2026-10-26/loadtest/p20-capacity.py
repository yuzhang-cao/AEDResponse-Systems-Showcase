"""Fresh-state, sequential capacity probes; leaves the live service untouched."""
import json
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

root = pathlib.Path(sys.argv[1]).resolve()
assert root.name.startswith("aed-p20-")
backend = (root / "backend-path.txt").read_text().strip()
node = "/opt/node/bin/node"
server = str(root / "p20-server.mjs")
loadgen = str(root / "p20-loadgen.mjs")
results = []
limits = ["-p", "MemoryHigh=384M", "-p", "MemoryMax=512M", "-p", "MemorySwapMax=512M",
          "-p", "TasksMax=128", "-p", "LimitNOFILE=524288", "-p", "LimitCORE=0",
          "-p", "Environment=NODE_ENV=production", "-p", "TimeoutStopSec=10", "-p", "Restart=no"]


def run(args, timeout=30):
    completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return {"code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}


def health():
    start = time.monotonic()
    try:
        with urllib.request.urlopen("http://127.0.0.1:8787/healthz", timeout=5) as response:
            return {"status": response.status, "ms": (time.monotonic() - start) * 1000}
    except Exception as error:
        return {"error": str(error)}


def save():
    (root / "summary.json").write_text(json.dumps(results, indent=2))


def state(unit):
    status = run(["systemctl", "show", unit, "-p", "ActiveState", "-p", "Result", "-p", "MainPID",
                  "-p", "ExecMainCode", "-p", "ExecMainStatus", "-p", "MemoryPeak", "-p", "MemoryCurrent",
                  "-p", "CPUUsageNSec", "-p", "ExecStart", "-p", "ControlGroup"])
    values = dict(line.split("=", 1) for line in status["stdout"].splitlines() if "=" in line)
    if not values.get("ControlGroup"):
        return values  # The exited unit has no cgroup; do not attribute host counters to it.
    cgroup = pathlib.Path("/sys/fs/cgroup") / values["ControlGroup"].lstrip("/")
    for name in ["memory.events", "memory.swap.current", "memory.peak", "cpu.stat", "memory.pressure"]:
        try:
            values[name] = (cgroup / name).read_text()
        except OSError:
            pass
    return values


def seed(population):
    directory = root / f"seed-{population}"
    if directory.exists():
        return directory
    directory.mkdir(mode=0o700)
    unit = f"aed-cap-seed-{population}"
    output = run(["sudo", "systemd-run", "--unit=" + unit, "--uid=azureuser", "--gid=azureuser",
                  "--wait", "--collect", *limits, "-p", "RuntimeMaxSec=90",
                  "-p", f"StandardOutput=append:{directory}/seed.log",
                  "-p", f"StandardError=append:{directory}/seed.log",
                  node, "--max-old-space-size=380", server, "seed", backend, str(directory), str(population)], 100)
    if output["code"]:
        raise RuntimeError(json.dumps(output))
    return directory


def probe(population, rate, seconds=60, heap=380, suffix=""):
    case = f"u{population}-r{rate}-h{heap}-{seconds}s{suffix}"
    directory = root / case
    directory.mkdir(mode=0o700)
    print(json.dumps({"phase": "preparing", "case": case, "live": health()}), flush=True)
    source = seed(population)
    for name in [f"users-{population}.sqlite", f"fleet-{population}.json", "fixture.json"]:
        shutil.copy2(source / name, directory / name)
    # Each case starts from the same shape with fresh standby samples. This is
    # offline fixture setup, before the backend becomes the sole database writer.
    database = sqlite3.connect(directory / f"users-{population}.sqlite")
    stamp = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    rows = database.execute("SELECT item_key,payload FROM state_items WHERE collection='devices'").fetchall()
    for key, payload in rows:
        device = json.loads(payload)
        device["lastSeenAt"] = stamp
        device["presenceObservedAt"] = stamp
        device["latestPosition"]["observedAt"] = stamp
        device["latestPosition"]["serverReceivedAt"] = stamp
        database.execute("UPDATE state_items SET payload=? WHERE collection='devices' AND item_key=?",
                         (json.dumps(device, separators=(",", ":")), key))
    database.commit()
    database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    database.close()
    del rows, device, payload
    unit = "aed-cap-" + case
    record = {"case": case, "population": population, "heapMiB": heap, "offeredRps": rate, "seconds": seconds}
    try:
        launch = run(["sudo", "systemd-run", "--unit=" + unit, "--uid=azureuser", "--gid=azureuser",
                      *limits, "-p", f"RuntimeMaxSec={seconds + 90}",
                      "-p", f"StandardOutput=append:{directory}/server.log",
                      "-p", f"StandardError=append:{directory}/server.log",
                      node, f"--max-old-space-size={heap}", server, "serve", backend, str(directory), str(population)])
        if launch["code"]:
            raise RuntimeError(json.dumps(launch))
        ready = directory / f"ready-{population}.json"
        for _ in range(80):
            if ready.exists():
                break
            if run(["systemctl", "is-active", unit])["stdout"].strip() != "active":
                break
            time.sleep(.5)
        if not ready.exists():
            record["startupFailure"] = state(unit)
        else:
            record["ready"] = json.loads(ready.read_text())
            print(json.dumps({"phase": "ready", "case": case, "startupMs": record["ready"]["startupMs"]}), flush=True)
            command = run([node, loadgen, str(directory), str(population), "position", str(rate), str(seconds)], seconds + 25)
            result = directory / f"result-{population}-position-{rate}.json"
            record["measurement"] = json.loads(result.read_text()) if result.exists() else command
        record["statusBeforeStop"] = state(unit)
    except Exception as error:
        record["error"] = str(error)
    finally:
        run(["sudo", "systemctl", "stop", unit], 20)
        if run(["systemctl", "is-failed", unit])["stdout"].strip() == "failed":
            run(["sudo", "systemctl", "reset-failed", unit])
        record["liveAfter"] = health()
        results.append(record)
        save()
        print(json.dumps({"phase": "result", **record}), flush=True)
    if record["liveAfter"].get("status") != 200:
        raise RuntimeError("Stopping probes: live health did not recover")
    return record


if len(sys.argv) > 2:
    results.extend(json.loads((root / "summary.json").read_text()))
    for population, rate, seconds, heap in json.loads(sys.argv[2]):
        probe(population, rate, seconds, heap)
else:
    probe(1000, 100, 60, 256)
    first = probe(1000, 100, 60)
    if first.get("measurement", {}).get("sloPass"):
        probe(1000, 167, 30)
        probe(1000, 200, 30)
    else:
        probe(1000, 50, 60)
    probe(2000, 100, 60)
    probe(5000, 100, 30)
    probe(5000, 42, 60)
    probe(10000, 84, 30)
    probe(20000, 167, 15)
    print(json.dumps({"phase": "complete", "cases": len(results)}), flush=True)
