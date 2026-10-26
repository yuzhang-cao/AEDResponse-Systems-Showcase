import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDirectory = fileURLToPath(new URL("../scripts/", import.meta.url));

async function script(name: string): Promise<string> {
  return readFile(`${scriptsDirectory}${name}`, "utf8");
}

test("Windows lifecycle scripts use explicit IPv4 host/port and SQLite without Tailscale coupling", async () => {
  const [start, run, status, firewall] = await Promise.all([
    script("start-windows.ps1"),
    script("run-windows.ps1"),
    script("status-windows.ps1"),
    script("ensure-windows-firewall.ps1")
  ]);
  for (const source of [start, run, status, firewall]) {
    assert.equal(source.includes("tailscale.exe"), false);
  }
  assert.match(start, /\[string\]\$HostAddress/);
  assert.match(start, /AddressFamily\]::InterNetwork/);
  assert.match(run, /state\.sqlite/);
  assert.match(run, /backend-port\.txt/);
  assert.match(status, /backend-port\.txt/);
  assert.match(status, /http:\/\/\$\{hostAddress\}:\$backendPort\/healthz/);
  assert.match(firewall, /-InterfaceAlias \$InterfaceAlias/);
  assert.match(firewall, /-RemoteAddress \$RemoteAddress/);
});
