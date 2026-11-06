"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { CognitiveMemory } = require("../src/cognitive-memory");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = tmpFixture("pi-memory-stores-");
const storeRoot = path.join(root, ".pi", "cognitive-automation");
const memoryFile = path.join(storeRoot, "cognitive-memory.json");
const reasoningFile = path.join(storeRoot, "reasoning-runtime.json");
const receiptFile = path.join(root, ".pi", "memory-maintenance", "latest.json");
const script = path.join(__dirname, "..", "scripts", "maintain-memory-stores.js");
const run = (args = [], env = {}) => JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, PI_REASONING_AUTO_PRUNE_ACTIONS_KEEP: "2", PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP: "1", ...env }, encoding: "utf8", timeout: 30000 }));

try {
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  const seed = new CognitiveMemory();
  const duplicate = seed.remember({ type: "episodic", title: "Duplicate attempt", content: "Retried the failing migration with the same fixture.", verification: "inferred" }).entry;
  seed.remember({ type: "episodic", title: "Second attempt", content: "Second attempt used a different fixture.", verification: "inferred" });
  seed.remember({ type: "semantic", title: "Architecture", content: "Project memory lives in the canonical vault.", verification: "verified" });
  const entries = Array.from(seed.entries.values()).map((entry) => entry.toJSON());
  entries.push({ ...duplicate.toJSON(), id: "mem_0000000000000001", title: "Duplicate attempt copy" });
  fs.writeFileSync(memoryFile, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), lastConsolidatedAt: 0, entries, audit: [] }), { mode: 0o600 });
  const artifacts = Array.from({ length: 6 }, (_, index) => ({ id: `art_exec_${index}`, type: "executor_action", createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), claim: `Executor action ${index}` }));
  artifacts.push({ id: "art_plan_0", type: "plan", createdAt: new Date(1_700_000_000_000).toISOString(), claim: "Plan" });
  fs.writeFileSync(reasoningFile, JSON.stringify({ version: 1, artifacts, links: [] }), { mode: 0o600 });

  const memoryBefore = fs.readFileSync(memoryFile, "utf8");
  const reasoningBefore = fs.readFileSync(reasoningFile, "utf8");
  const preview = run();
  assert.equal(preview.apply, false);
  assert.equal(preview.cognitiveMemory.beforeEntries, 4);
  assert.equal(preview.cognitiveMemory.deduplicated, 1);
  assert.equal(preview.cognitiveMemory.countPruned, 0, "caps sit above this fixture's volume");
  assert.equal(preview.cognitiveMemory.afterEntries, 3);
  assert.equal(preview.reasoningRuntime.artifactsBefore, 7);
  assert.equal(preview.reasoningRuntime.automatedExecutorActions, 6);
  assert.equal(preview.reasoningRuntime.removeCandidates, 4, "four executor actions over the keep=2 bound are removal candidates");
  assert.equal(preview.reasoningRuntime.artifactsAfter, 3);
  assert.equal(preview.canonicalMemoryTouched, false);
  assert.equal(fs.readFileSync(memoryFile, "utf8"), memoryBefore, "dry run does not rewrite the store");
  assert.equal(fs.readFileSync(reasoningFile, "utf8"), reasoningBefore, "dry run does not rewrite the store");
  assert.equal(fs.existsSync(receiptFile), false, "dry run writes no receipt");

  const applied = run(["--apply"]);
  assert.equal(applied.apply, true);
  assert.equal(applied.cognitiveMemory.written, true);
  assert.equal(applied.cognitiveMemory.backup.bytes > 0, true);
  assert.equal(fs.statSync(path.join(root, applied.cognitiveMemory.backup.file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, applied.reasoningRuntime.backup.file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
  const written = JSON.parse(fs.readFileSync(reasoningFile, "utf8"));
  assert.equal(written.artifacts.filter((row) => row.type === "executor_action").length, 2);
  assert.equal(written.artifacts.filter((row) => row.type === "plan").length, 1, "non-automated artifacts survive the bound");
  assert.equal(applied.reasoningRuntime.artifactsAfter, 3);
  // A malformed bound is reported as the documented default, never as a bound
  // that would remove every automated artifact.
  const malformed = run([], { PI_REASONING_AUTO_PRUNE_ACTIONS_KEEP: "not-a-number", PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP: "-3" });
  assert.equal(malformed.reasoningRuntime.keep.executorActions, 2000);
  assert.equal(malformed.reasoningRuntime.keep.evidence, 120);
  assert.equal(malformed.reasoningRuntime.removeCandidates, 0, "a malformed bound never authorizes deletion");
  const memory = CognitiveMemory.load(memoryFile);
  assert.equal(memory.entries.size, 3);
  assert.equal([...memory.entries.values()].filter((entry) => entry.verification === "verified").length, 1, "verified entries are preserved");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(receipt.canonicalMemoryTouched, false);
  assert.equal(receipt.sessionFilesTouched, false);
  assert.deepEqual(receipt.cognitiveMemory.byTypeAfter, { episodic: 2, semantic: 1, procedural: 0, strategic: 0 });

  const second = run(["--apply"]);
  assert.equal(second.cognitiveMemory.deduplicated, 0, "apply is idempotent");
  assert.equal(second.reasoningRuntime.removeCandidates, 0);

  const invalid = spawnSync(process.execPath, [script, "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.notEqual(invalid.status, 0, "unknown arguments are rejected");
  assert.match(invalid.stderr, /usage: node scripts\/maintain-memory-stores\.js/);
  console.log("memory store maintenance script tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
