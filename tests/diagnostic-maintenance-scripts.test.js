"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = tmpFixture("pi-diagnostic-scripts-");
const implementation = path.resolve(__dirname, "..");
function run(script, args = [], env = {}) { return JSON.parse(execFileSync(process.execPath, [path.join(implementation, "scripts", script), ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30000 })); }
try {
  const entropy = path.join(root, ".pi", "cognitive-automation", "entropy"); fs.mkdirSync(entropy, { recursive: true });
  const eventFile = path.join(entropy, "events.jsonl");
  const original = `${JSON.stringify({ at: Date.now() - 40 * 86400000, type: "old-diagnostic" })}\n`;
  fs.writeFileSync(eventFile, original);
  const preview = run("maintain-diagnostics.js");
  assert.equal(preview.apply, false);
  assert.equal(fs.readFileSync(eventFile, "utf8"), original);
  const applied = run("maintain-diagnostics.js", ["--apply"]);
  assert.equal(applied.diagnostics["entropy-events"].records, 0);
  assert.equal(applied.sessionFilesTouched, false);
  assert.equal(applied.canonicalMemoryTouched, false);
  const receipt = path.join(root, ".pi", "diagnostic-maintenance", "latest.json");
  assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
  const diagnostic = run("collect-memory-diagnostics.js", [], { PI_PROJECT_MEMORY_DIAGNOSTICS: "1", PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0", PI_PROJECT_MEMORY_POSTURE: "env" });
  assert.equal(diagnostic.canonicalWrites, false);
  assert.equal(diagnostic.effectiveStage, "M0");
  assert(fs.existsSync(path.join(root, diagnostic.output)));
  assert.deepEqual(run("migrate-experiment-ledger.js").records, []);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("diagnostic maintenance script tests passed");
