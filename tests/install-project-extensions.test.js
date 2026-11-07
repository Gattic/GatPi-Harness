"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "install-project-extensions.sh");
const tmp = tmpFixture("pi-install-harness-");
try {
  const agentDir = path.join(tmp, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const unrelated = path.join(tmp, "other-extension.ts");
  fs.writeFileSync(unrelated, "export default function () {}\n");
  const staleHarness = path.join(tmp, "stale-harness");
  fs.mkdirSync(path.join(staleHarness, ".pi", "extensions", "stale-extension"), { recursive: true });
  fs.mkdirSync(path.join(staleHarness, "extensions", "00-harness-defaults"), { recursive: true });
  fs.writeFileSync(path.join(staleHarness, "package.json"), `${JSON.stringify({ name: "pi-harness", private: true })}\n`);
  fs.writeFileSync(path.join(staleHarness, ".pi", "extensions", "stale-extension", "index.ts"), "export default function () {}\n");
  fs.writeFileSync(path.join(staleHarness, "extensions", "00-harness-defaults", "index.ts"), "export default function () {}\n");
  const unrelatedExtensionsDir = path.join(tmp, "unrelated-project", "extensions");
  fs.mkdirSync(unrelatedExtensionsDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "fixture-provider",
    extensions: [
      path.join(staleHarness, "extensions", "00-harness-defaults", "index.ts"),
      path.join(staleHarness, ".pi", "extensions"),
      path.join(staleHarness, ".pi", "extensions", "stale-extension", "index.ts"),
      path.join(staleHarness, "extensions"),
      unrelatedExtensionsDir,
      path.join(root, "extensions"),
      unrelated,
      path.join(root, ".pi", "extensions"),
      path.join(root, ".pi", "extensions", "00-harness-defaults", "index.ts"),
    ],
    packages: [
      "npm:unrelated-package",
      { source: "git:github.com/example/other-package", skills: [] },
    ],
    retry: { enabled: false, maxRetries: 5, provider: { timeoutMs: 1234 } },
    compaction: { enabled: false, reserveTokens: 12000 },
  }, null, 2)}\n`);
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const npmLog = path.join(tmp, "npm.jsonl");
  fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.QUEUE_TEST_NPM_LOG, JSON.stringify(process.argv.slice(2))+"\\n"); process.exit(process.env.QUEUE_TEST_NPM_FAIL === "1" ? 7 : 0);\n`, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    PI_CODING_AGENT_DIR: agentDir,
    QUEUE_TEST_NPM_LOG: npmLog,
  };
  const result = spawnSync("bash", [script], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.extensions.slice(0, 3), [
    path.join(root, "extensions", "00-harness-defaults", "index.ts"),
    path.join(root, ".pi", "extensions"),
    path.join(root, "extensions"),
  ]);
  assert.equal(settings.extensions.filter((value) => value === path.join(root, ".pi", "extensions")).length, 1);
  assert.equal(settings.extensions[3], "-builtin:codemode", "built-in codemode is disabled after the managed paths");
  assert.equal(settings.extensions.filter((value) => value === "-builtin:codemode").length, 1);
  assert(!settings.extensions.includes(path.join(root, ".pi", "extensions", "00-harness-defaults", "index.ts")), "obsolete managed path is removed");
  for (const staleEntry of [
    path.join(staleHarness, "extensions", "00-harness-defaults", "index.ts"),
    path.join(staleHarness, ".pi", "extensions"),
    path.join(staleHarness, ".pi", "extensions", "stale-extension", "index.ts"),
    path.join(staleHarness, "extensions"),
  ]) {
    assert(!settings.extensions.includes(staleEntry), `extension path from another harness checkout is pruned: ${staleEntry}`);
  }
  assert.match(result.stdout, /pruned stale harness extension entry/, "pruned stale harness roots are reported");
  assert(settings.extensions.includes(unrelatedExtensionsDir), "an extensions directory outside a harness checkout is preserved");
  assert(settings.extensions.includes(unrelated), "unmanaged extensions are preserved");
  assert.deepEqual(settings.packages, [
    "npm:unrelated-package",
    { source: "git:github.com/example/other-package", skills: [] },
  ], "configured packages are preserved");
  assert.equal(settings.defaultProvider, "fixture-provider");
  assert.deepEqual(settings.compaction, { enabled: false, reserveTokens: 12000, keepRecentTokens: 20000 },
    "existing compaction preferences are preserved while a missing key gets the default");
  assert.equal(settings.retry.enabled, false, "an explicit retry.enabled preference is preserved");
  assert.equal(settings.retry.maxRetries, 5, "an explicit retry.maxRetries preference is preserved");
  assert.equal(settings.retry.baseDelayMs, 2000, "a missing retry.baseDelayMs gets the bounded default");
  assert.equal(settings.retry.provider.timeoutMs, 1234, "unrelated provider timeout remains configured");
  assert.equal(settings.retry.provider.maxRetries, 0, "a missing provider retry bound gets the default");
  assert.equal(settings.retry.provider.maxRetryDelayMs, 60000);

  const repeated = spawnSync("bash", [script], { cwd: root, env, encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  const repeatedSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(repeatedSettings, settings, "a repeated install leaves settings unchanged, including preserved preferences");
  assert.doesNotMatch(repeated.stdout, /pruned stale harness extension entry/, "stale-root pruning is idempotent");
  assert.equal(repeatedSettings.extensions.filter((value) => value === "-builtin:codemode").length, 1, "built-in codemode disable entry is not duplicated");
  const calls = fs.readFileSync(npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ["--prefix", path.join(root, "src/pi-queue"), "ci", "--ignore-scripts", "--no-audit", "--no-fund"]),
    "Extension installation installs the pinned request-queue client and nothing else");

  const freshAgentDir = path.join(tmp, "fresh-agent");
  fs.mkdirSync(freshAgentDir, { recursive: true });
  fs.writeFileSync(path.join(freshAgentDir, "settings.json"), "{}\n");
  const fresh = spawnSync("bash", [script], { cwd: root, env: { ...env, PI_CODING_AGENT_DIR: freshAgentDir }, encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  const freshSettings = JSON.parse(fs.readFileSync(path.join(freshAgentDir, "settings.json"), "utf8"));
  assert.deepEqual(freshSettings.compaction, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    "a settings file without compaction values receives the canonical defaults");
  assert.deepEqual(freshSettings.retry, { enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { maxRetries: 0, maxRetryDelayMs: 60000 } },
    "a settings file without retry values receives the bounded defaults");
  assert.deepEqual(freshSettings.extensions, [
    path.join(root, "extensions", "00-harness-defaults", "index.ts"),
    path.join(root, ".pi", "extensions"),
    path.join(root, "extensions"),
    "-builtin:codemode",
  ]);

  const beforeFailure = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
  const failed = spawnSync("bash", [script], { cwd: root, env: { ...env, QUEUE_TEST_NPM_FAIL: "1" }, encoding: "utf8" });
  assert.equal(failed.status, 7);
  assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"), beforeFailure, "A dependency failure cannot publish partially refreshed global settings");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("install project extensions tests passed");
