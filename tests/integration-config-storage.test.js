"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeIntegrationConfig } = require("../src/integration-config");
const { FileIntegrationStorage, JsonSizeLimitError, safeKey } = require("../src/file-integration-storage");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cfg = normalizeIntegrationConfig({}, { PI_COGNITIVE_AUTOMATION: "1", PI_COGNITIVE_AUTO_VERIFY: "1", PI_COGNITIVE_ORCHESTRATION_ENABLED: "0" });
assert.equal(cfg.enabled, true);
assert.equal(cfg.verification.enabled, true);
assert.equal(cfg.orchestration.enabled, false);
assert.equal(cfg.reasoning.enabled, true);
assert.equal(cfg.topologies.enabled, false, "topologies are globally disabled unless explicitly enabled");
assert.equal(normalizeIntegrationConfig({}, { PI_MULTI_AGENT_TOPOLOGIES_ENABLED: "1" }).topologies.enabled, true);
assert.equal(normalizeIntegrationConfig({}, { PI_MULTI_AGENT_TOPOLOGIES_ENABLED: "0" }).topologies.enabled, false);
assert.equal(normalizeIntegrationConfig({}, { PI_REASONING_RUNTIME_ENABLED: "0" }).reasoning.enabled, false);
assert.equal(normalizeIntegrationConfig({}, { PI_SKILL_INTAKE_ENABLED: "0" }).skillIntake.enabled, false);
assert.equal(normalizeIntegrationConfig({}, { PI_MEMORY_MAINTENANCE_ENABLED: "0" }).memoryMaintenance.enabled, false);
assert.equal(normalizeIntegrationConfig({}, { PI_PROVENANCE_GRAPH_ENABLED: "0" }).provenance.enabled, false);
assert.equal(normalizeIntegrationConfig({}, { PI_COMPOUNDING_EFFECTIVENESS_ENABLED: "0" }).compounding.enabled, false);
assert.equal(normalizeIntegrationConfig({ branching: { enabled: true } }, {}).branching.enabled, true);

const tmp = tmpFixture("pi-file-storage-");
const storage = new FileIntegrationStorage(tmp);
storage.writeJson("a/b", { ok: true });
storage.appendJsonl("events", { n: 1 });
storage.appendJsonl("events", { n: 2 });
assert.deepEqual(storage.readJson("a/b"), { ok: true });
assert.equal(storage.readJsonl("events").length, 2);
assert(!safeKey("../secret").includes(".."));

const boundedRoot = tmpFixture("pi-file-storage-bounded-");
const bounded = new FileIntegrationStorage(boundedRoot, { maxJsonBytes: 2048 });
const legacyFile = bounded.jsonPath("reasoning-runtime");
fs.writeFileSync(legacyFile, JSON.stringify({ artifacts: [{ output: "x".repeat(4096) }] }));
assert.deepEqual(bounded.readJson("reasoning-runtime", { recovered: true }), { recovered: true }, "oversized legacy JSON is not parsed into the JS heap");
assert.equal(bounded.oversizedState()[0].size, fs.statSync(legacyFile).size);
bounded.writeJson("reasoning-runtime", { version: 1, artifacts: [] });
assert.deepEqual(bounded.readJson("reasoning-runtime"), { version: 1, artifacts: [] });
assert(bounded.lastOversizedBackup && fs.existsSync(bounded.lastOversizedBackup), "oversized legacy state is preserved before replacement");
assert(fs.statSync(bounded.lastOversizedBackup).size > 4096);
const firstBackup = bounded.lastOversizedBackup;
const directLegacyFile = bounded.jsonPath("direct-legacy");
fs.writeFileSync(directLegacyFile, JSON.stringify({ output: "d".repeat(4096) }));
bounded.writeJson("direct-legacy", { recovered: true });
assert.notEqual(bounded.lastOversizedBackup, firstBackup, "write-time size checks preserve legacy state even without a prior read");
assert(fs.existsSync(bounded.lastOversizedBackup) && fs.statSync(bounded.lastOversizedBackup).size > 4096);
const snapshot = bounded.copyJson("reasoning-runtime", "reasoning/snapshots/test");
assert(snapshot && fs.existsSync(snapshot), "snapshots use filesystem copies without JSON serialization");
assert.throws(() => bounded.writeJson("too-large", { output: "z".repeat(4096) }), (error) => error instanceof JsonSizeLimitError && error.code === "PI_JSON_SIZE_LIMIT");
assert.equal(fs.existsSync(bounded.jsonPath("too-large")), false, "rejected oversized writes do not leave partial files");
const originalNow = Date.now;
const collisionStamp = 1_700_000_000_000;
const collisionTemporary = `${bounded.jsonPath("collision")}.${process.pid}.${collisionStamp}.tmp`;
fs.writeFileSync(collisionTemporary, "pre-existing temporary file");
Date.now = () => collisionStamp;
try {
  assert.throws(() => bounded.writeJson("collision", { ok: true }), (error) => error?.code === "EEXIST", "atomic writes refuse pre-existing temporary paths");
} finally {
  Date.now = originalNow;
}
assert.equal(fs.readFileSync(collisionTemporary, "utf8"), "pre-existing temporary file", "failed exclusive creation never deletes another file");
fs.rmSync(collisionTemporary);
assert.equal(fs.readdirSync(boundedRoot).some((name) => name.endsWith(".tmp")), false, "atomic JSON writes clean task-owned temporary files");

if (process.platform !== "win32") {
  for (const mask of [0o022, 0o077]) {
    const originalUmask = process.umask(mask);
    try {
      const outside = path.join(boundedRoot, `outside-${mask}.txt`);
      fs.writeFileSync(outside, "unchanged", { mode: 0o644 });
      // Creation mode is filtered by umask. Keep the target deliberately non-private
      // so an unsafe chmod to the storage's 0600 mode cannot go undetected.
      fs.chmodSync(outside, 0o644);
      assert.equal(fs.statSync(outside).mode & 0o777, 0o644, "symlink target starts with the exact fixture permissions");
      const jsonKey = `linked-${mask}`;
      fs.symlinkSync(outside, bounded.jsonPath(jsonKey));
      assert.throws(() => bounded.writeJson(jsonKey, { unsafe: true }), /not a real file|symbolic/i, "JSON writes refuse symlink destinations");
      assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
      assert.equal(fs.statSync(outside).mode & 0o777, 0o644, "JSON symlink refusal never chmods its target");

      const jsonlKey = `linked-events-${mask}`;
      fs.symlinkSync(outside, bounded.jsonlPath(jsonlKey));
      assert.throws(() => bounded.appendJsonl(jsonlKey, { unsafe: true }), /not a real file|symbolic/i, "JSONL appends refuse symlink destinations");
      assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
      assert.equal(fs.statSync(outside).mode & 0o777, 0o644, "JSONL symlink refusal never chmods its target");
    } finally {
      process.umask(originalUmask);
    }
  }
}

console.log("integration-config-storage tests passed");
