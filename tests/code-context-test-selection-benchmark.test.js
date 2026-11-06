#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { parseArgs, normalize, scoreSelection } = require("../scripts/run-code-context-test-selection-benchmark.js");
assert.equal(parseArgs(["--count=30", "--no-resume"]).count, 30);
assert.throws(() => parseArgs(["--count=0"]), /positive/);
assert.deepEqual(normalize(["tests\\a.test.js", "tests/a.test.js"]), ["tests/a.test.js"]);
const pin = { version: "0.9.3", fingerprint: "pin", status: { initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }, adapterFreshness: { stale: false, gatingSafe: true } };
const task = { taskId: "task-1", goldRevision: "rev-1", critical: true, gold: { testFiles: ["tests/a.test.js", "tests/b.test.js"] } };
const impact = { selectedTests: ["tests/a.test.js", "tests/unrelated.test.js"], selectedRuntimeMs: 20, allEdges: [{ test: "tests/a.test.js", gatingSafe: true, freshness: "fresh", degradation: null }], mustRun: [], highConfidence: [{}], graphOnly: [], uncoveredRisk: [], baselinePolicy: { additiveOnly: true }, providers: { codegraph: { ok: true, freshness: { stale: false } } } };
const row = scoreSelection(task, impact, pin);
assert.equal(row.environmentValid, true);
assert.equal(row.goldReviewStatus, "unreviewed");
assert.equal(row.metrics.affected_test_recall, 0.5);
assert.equal(row.metrics.affected_test_precision, 0.5);
assert.equal(row.metrics.high_risk_affected_test_recall, 0.5);
assert.equal(row.metrics.stale_degraded_gating_count, 0);
assert.ok(row.evidenceId.startsWith("selection_evidence_"));
const stale = scoreSelection(task, { ...impact, providers: { codegraph: { ok: true, freshness: { stale: true } } } }, pin);
assert.equal(stale.environmentValid, false);
// Exercise the actual CLI: a copied contract hash must not validate foreign
// identifiers merely because the saved header and rows agree with each other.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildManifest } = require("../scripts/prepare-code-context-gold-review");
const { manifestHash } = require("../src/code-context-gold-review");
const { reviewedRunPlan } = require("../scripts/run-code-context-paired-benchmark");
const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(root, ".pi", "test-fixtures");
fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(fixtureRoot, "selection-resume-"));
try {
  const corpus = { tasks: Array.from({ length: 30 }, (_, i) => ({ taskId: `fixture-${i}`, prompt: `Fixture ${i}`, reviewStatus: "candidate", parentRevision: "a".repeat(40), goldRevision: "b".repeat(40), critical: i === 0, taskClasses: ["interface-change", "multi-file", "regression-fix", "performance-lifecycle", "privacy-security"], gold: { sourceFiles: ["src/a.js"], testFiles: ["tests/a.test.js"] } })) };
  const gold = buildManifest(corpus, 30, () => "require('../src/a.js')", () => ["tests/a.test.js"]);
  for (const item of gold.tasks) {
    item.review = { status: "approved", reviewer: { kind: "human", id: "fixture-only-not-a-field-review" }, reviewedAt: new Date().toISOString(), rationale: "Synthetic fixture, not a human field judgment." };
    for (const judgment of [...item.sourceJudgments, ...item.judgments]) { judgment.label = "relevant"; judgment.rationale = "Fixture relationship."; }
    item.verifierEvidenceIds = ["fixture-proof"];
  }
  gold.manifestHash = manifestHash(gold);
  const corpusPath = path.join(directory, "corpus.json"), goldPath = path.join(directory, "gold.json"), outputPath = path.join(directory, "output.json");
  for (const [file, data] of [[corpusPath, corpus], [goldPath, gold]]) fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const args = ["--corpus", corpusPath, "--gold-manifest", goldPath, "--output", outputPath];
  const plan = reviewedRunPlan(corpus, gold, parseArgs(args));
  const base = { contractHash: plan.contractHash, cohortKey: plan.contract.cohort.cohortKey, goldManifestHash: plan.contract.goldManifestHash, testSelectionRuns: plan.tasks.map(item => ({ ...scoreSelection(item, impact, pin), cohortKey: plan.contract.cohort.cohortKey, goldManifestHash: plan.contract.goldManifestHash })) };
  const scenarios = [
    { name: "cohort header and rows", mutate: state => { state.cohortKey = "foreign-cohort"; for (const item of state.testSelectionRuns) item.cohortKey = state.cohortKey; }, error: /identity changed/ },
    { name: "gold header and rows", mutate: state => { state.goldManifestHash = "foreign-gold"; for (const item of state.testSelectionRuns) item.goldManifestHash = state.goldManifestHash; }, error: /identity changed/ },
    { name: "both headers and rows", mutate: state => { state.cohortKey = "foreign-cohort"; state.goldManifestHash = "foreign-gold"; for (const item of state.testSelectionRuns) { item.cohortKey = state.cohortKey; item.goldManifestHash = state.goldManifestHash; } }, error: /identity changed/ },
    { name: "changed source/configuration contract", mutate: state => { state.contractHash = "old-contract"; }, error: /identity changed/ },
    { name: "mixed row", mutate: state => { state.testSelectionRuns[0].cohortKey = "foreign-cohort"; }, error: /invalid or mixed/ },
    { name: "duplicate row", mutate: state => { state.testSelectionRuns.push(structuredClone(state.testSelectionRuns[0])); }, error: /invalid or mixed/ },
    { name: "invalid environment", mutate: state => { state.testSelectionRuns[0].environmentValid = false; }, error: /invalid or mixed/ },
    { name: "no-resume preserves existing output", mutate: () => {}, args: ["--no-resume"], error: /historical evidence is preserved/ },
  ];
  for (const scenario of scenarios) {
    const state = structuredClone(base); scenario.mutate(state);
    fs.writeFileSync(outputPath, JSON.stringify(state), { mode: 0o600 });
    const before = [corpusPath, goldPath, outputPath].map(file => fs.readFileSync(file));
    const result = spawnSync(process.execPath, ["scripts/run-code-context-test-selection-benchmark.js", ...args, ...(scenario.args || [])], { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined, scenario.name);
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}`);
    assert.match(result.stderr, scenario.error, scenario.name);
    for (const [i, file] of [corpusPath, goldPath, outputPath].entries()) assert.deepEqual(fs.readFileSync(file), before[i], `${scenario.name}: file bytes changed`);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["corpus.json", "gold.json", "output.json"], "rejection must not leave extra artifacts");
  }
  fs.writeFileSync(outputPath, JSON.stringify(base), { mode: 0o600 });
  const valid = spawnSync(process.execPath, ["scripts/run-code-context-test-selection-benchmark.js", ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")).testSelectionRuns, base.testSelectionRuns);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("code-context test-selection benchmark tests passed");
