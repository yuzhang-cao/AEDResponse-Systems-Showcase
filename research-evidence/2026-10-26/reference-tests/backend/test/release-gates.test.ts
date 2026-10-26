/**
 * Release gates in the repository, not in a checklist.
 *
 * The audit found that the iOS `isReadyForSubmission` readiness property had no
 * caller at all, and that the production backend would happily run on the demo
 * AED catalogue and the geometric reference route.  A property nobody calls and
 * a fallback nobody forbids are the same defect: the release looks fine because
 * nothing was ever asked to check it.
 *
 * These assertions keep the enforcement wired to a real entry point, so removing
 * the gate breaks a test instead of silently re-enabling the fallback.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The gate is exercised against its own fixtures, never against whatever the
 * repository currently contains.  An earlier version asserted "the repository's
 * agreements file must fail", which turned the operator's own to-do into a
 * permanent test expectation: filling in the real policy URL and contact address
 * would have broken the suite, and the natural fix would have been to delete the
 * assertion.  Isolation also lets the passing case be tested at all.
 */
async function writeFixture(name: string, mutate: (value: Record<string, unknown>) => void) {
  const source = JSON.parse(
    await readFile(`${repositoryRoot}contracts/agreements.json`, "utf8")
  ) as Record<string, unknown>;
  mutate(source);
  const path = join(tmpdir(), `aed-legal-gate-${process.pid}-${name}.json`);
  await writeFile(path, JSON.stringify(source, null, 2), "utf8");
  return path;
}

test("the legal readiness gate blocks placeholder legal info and passes complete info", async () => {
  const script = `${repositoryRoot}scripts/check-legal-readiness.mjs`;

  const empty = await writeFixture("empty", (value) => {
    value.privacyPolicyURL = "";
    value.contactEmail = "";
  });
  await assert.rejects(
    run(process.execPath, [script, empty], { cwd: repositoryRoot }),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1, "a blocking gate must exit non-zero");
      assert.match(failure.stderr ?? "", /privacyPolicyURL/);
      assert.match(failure.stderr ?? "", /contactEmail/);
      return true;
    },
    "an empty hosted policy and contact address must block a release"
  );

  const placeholder = await writeFixture("placeholder", (value) => {
    value.privacyPolicyURL = "http://example.com/privacy";
    value.contactEmail = "[REDACTED_EMAIL]";
  });
  await assert.rejects(
    run(process.execPath, [script, placeholder], { cwd: repositoryRoot }),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /https/);
      assert.match(failure.stderr ?? "", /占位/);
      return true;
    },
    "an http URL and an example.com address are not a real legal surface"
  );

  const broken = await writeFixture("broken", (value) => {
    value.privacyPolicyURL = "https://aedresponse.example.org/privacy";
    value.contactEmail = "[REDACTED_EMAIL]";
    const documents = value.documents as { sections: unknown[] }[];
    documents[0]!.sections = [];
  });
  await assert.rejects(
    run(process.execPath, [script, broken], { cwd: repositoryRoot }),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, 1);
      assert.match((error as { stderr?: string }).stderr ?? "", /没有正文段落/);
      return true;
    },
    "the four agreement bodies are checked too, not only the two operator fields"
  );

  const ready = await writeFixture("ready", (value) => {
    value.privacyPolicyURL = "https://aedresponse.example.org/privacy";
    value.contactEmail = "[REDACTED_EMAIL]";
  });
  const passed = await run(process.execPath, [script, ready], { cwd: repositoryRoot });
  assert.match(passed.stdout, /法律信息已就绪/,
    "a filled-in legal surface must pass, so the gate can actually be closed");

  // The gate is a release step, so it must be recorded where release steps live.
  const handoff = await readFile(`${repositoryRoot}HANDOFF.md`, "utf8");
  assert.match(handoff, /check-legal-readiness\.mjs/,
    "the release gate must be recorded where the release steps live");
});

/**
 * The audit found `header_up` written as a sibling of `reverse_proxy`, which is
 * not valid Caddyfile: it is a sub-directive of `reverse_proxy`.  Caddy is not
 * installed in this environment, so the structural rule is checked here instead
 * of being left to a reader's eye: within the back-end block, `header_up` may
 * only appear after the `reverse_proxy` line that opens it.
 */
test("the Caddyfile keeps header_up inside the reverse_proxy block", async () => {
  const caddyfile = await readFile(
    `${repositoryRoot}backend/deploy/azure/Caddyfile`,
    "utf8"
  );
  const lines = caddyfile.split("\n");
  const proxyIndex = lines.findIndex(line => line.trim().startsWith("reverse_proxy"));
  assert.ok(proxyIndex >= 0, "the deployment must still proxy to the backend");

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("header_up") && !trimmed.startsWith("header_down")) continue;
    assert.ok(
      index > proxyIndex,
      `Caddyfile:${index + 1} 的 ${trimmed.split(/\s/)[0]} 必须写在 reverse_proxy 块内，`
      + "不能与 reverse_proxy 同级（caddy validate 会拒绝）"
    );
    const indent = line.length - line.trimStart().length;
    const proxyIndent = lines[proxyIndex]!.length - lines[proxyIndex]!.trimStart().length;
    assert.ok(indent > proxyIndent, "header_up 的缩进必须深于 reverse_proxy 行");
  }

  // The reason no override is needed must stay recorded next to the proxy, so a
  // later editor does not re-add one to "fix" spoofing that Caddy already blocks.
  assert.match(caddyfile, /IGNORES a client-supplied X-Forwarded/,
    "必须写明 Caddy 默认忽略客户端提供的 X-Forwarded-*，避免再次加入无效覆盖");
  assert.match(caddyfile, /AED_TRUSTED_PROXIES/,
    "Caddyfile 与后端信任代理设置必须相互引用");
});

test("the supply chain gate is wired to a real command and a hashed lockfile", async () => {
  const workflow = await readFile(`${repositoryRoot}.github/workflows/verify.yml`, "utf8");
  assert.match(workflow, /npm ci/, "the build installs from the lockfile, not from ranges");
  assert.match(workflow, /npm audit --registry=https:\/\/registry\.npmjs\.org --audit-level=high/,
    "a dependency audit must be a CI step, not a thing someone remembers to run");

  const lock = JSON.parse(
    await readFile(`${repositoryRoot}backend/package-lock.json`, "utf8")
  ) as { lockfileVersion: number; packages: Record<string, { integrity?: string; resolved?: string; link?: boolean }> };
  assert.equal(lock.lockfileVersion, 3);
  const entries = Object.entries(lock.packages).filter(([path]) => path.startsWith("node_modules/"));
  assert.ok(entries.length > 50, "the lockfile describes the real dependency tree");
  for (const [path, entry] of entries) {
    assert.ok(entry.integrity, `${path} has no integrity hash; npm could not verify its bytes`);
    if (entry.link) continue;
    assert.match(entry.resolved ?? "", /^https:\/\//,
      `${path} is not resolved from a registry, so its bytes are not hash-verified`);
  }
  // A `file:`/`link:` dependency would bypass registry hashing entirely.
  const linked = entries.filter(([, entry]) => entry.link === true);
  assert.deepEqual(linked, [], "no dependency may be linked from the working tree");
});

test("the pre-release entry point enforces the legal gate instead of reporting it", async () => {
  const script = `${repositoryRoot}scripts/pre-release-check.mjs`;

  // An incomplete package must stop the release: the entry point exits non-zero and
  // says which step failed, rather than printing a notice and continuing.
  const incomplete = await writeFixture("prerelease-incomplete", (value) => {
    value.privacyPolicyURL = "";
    value.contactEmail = "";
  });
  await assert.rejects(
    run(process.execPath, [script, "--check", "legal", "--agreements", incomplete],
      { cwd: repositoryRoot }),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /pre-release check FAILED/);
      assert.match(failure.stderr ?? "", /privacyPolicyURL/);
      return true;
    },
    "a release entry point that only warns is not a gate"
  );

  // The same command passes for a complete package, so the gate is exercisable and
  // is not a permanent failure.
  const complete = await writeFixture("prerelease-complete", (value) => {
    // A syntactically complete package: the gate checks shape and disclosure, not
    // whether the domain is reachable, so a documentation domain is the right fixture.
    value.privacyPolicyURL = "https://aedresponse.example.org/privacy";
    value.contactEmail = "[REDACTED_EMAIL]";
  });
  const passed = await run(process.execPath,
    [script, "--check", "legal", "--agreements", complete], { cwd: repositoryRoot });
  assert.match(passed.stdout, /pre-release check passed/);

  // The workflow keeps CI non-blocking for operator placeholders, and the release
  // entry point is the thing that refuses.  Both facts are asserted so neither can
  // drift into the other by accident.
  const workflow = await readFile(`${repositoryRoot}.github/workflows/verify.yml`, "utf8");
  assert.match(workflow, /check-legal-readiness\.mjs \|\| true/,
    "CI reports the operator placeholders rather than failing every build");
  assert.match(workflow, /pre-release-check\.mjs|pre-release entry point/,
    "and the workflow names the entry point that does enforce them");
});

test("the Azure initializer cannot create a backend with a disabled Watch verifier", async () => {
  const template = await readFile(
    `${repositoryRoot}backend/deploy/azure/backend.env.example`, "utf8"
  );
  const initializer = await readFile(
    `${repositoryRoot}backend/deploy/azure/initialize-env.mjs`, "utf8"
  );
  for (const key of [
    "AED_WATCH_APP_ATTEST_APP_ID",
    "AED_WATCH_BUNDLE_VERSIONS",
    "AED_WATCH_ATTEST_ENVIRONMENT"
  ]) {
    assert.match(template, new RegExp(`^${key}=`, "m"), `${key} must be visible to the operator`);
    assert.match(initializer, new RegExp(`replace\\(\\/\\^${key}`),
      `${key} must be written into the generated backend.env`);
  }
  assert.match(initializer, /development.*production/,
    "the App Attest environment must be an explicit initializer argument");
});
