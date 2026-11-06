#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseArgs, selectTasks, reviewedRunPlan, validateResume, parseJsonLines, parseEvents, promptFor, evaluateCodegraphPin, evaluateFreshCanary } = require("../scripts/run-code-context-paired-benchmark.js");
assert.equal(parseArgs(["--count=30", "--concurrency", "2", "--model=x", "--no-resume"]).count, 30);
assert.equal(parseArgs(["--count=30", "--concurrency", "2", "--model=x", "--no-resume"]).concurrency, 2);
assert.throws(() => parseArgs(["--count=0"]), /positive/);
const tasks = Array.from({ length: 35 }, (_, index) => ({ taskId: `task-${index}`, prompt: index === 0 ? "Implement progressive codebase retrieval" : `Task ${index}`, reviewStatus: "candidate", gold: { sourceFiles: ["src/a.js"], testFiles: ["tests/a.test.js"] } }));
const selected = selectTasks({ tasks }, 30);
assert.equal(selected.length, 30);
assert.ok(selected.every((task) => task.reviewStatus === "candidate"));
assert.ok(selected.every((task) => task.selectionEligibility === "bounded-history-candidate"), "bounded criteria must not masquerade as human review");
assert.ok(!selected.some((task) => task.prompt === "Implement progressive codebase retrieval"));
assert.equal(parseJsonLines('{"type":"ok"}\nnot-json\n').length, 1);
const events = [
  { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 5, totalTokens: 17, cost: { total: 0.01 } } } },
  { type: "tool_execution_start", toolCallId: "map", toolName: "code_context", args: { operation: "repoMap" } },
  { type: "tool_execution_end", toolCallId: "map", toolName: "code_context", result: { content: [{ type: "text", text: "map" }], details: { queryId: "q1", strategyId: "s1", budgetTokens: 100, serializedTokens: 80, metrics: { elapsedMs: 12 }, items: [{ path: "src/a.js" }, { path: "src/a.js" }, { path: "src/b.js" }] } } },
  { type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "src/a.js" } },
  { type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: { content: [{ type: "text", text: "done" }] } },
];
const parsed = parseEvents(events, ["src/a.js"]);
assert.equal(parsed.localizationRecall, 1);
assert.equal(parsed.fileRecallAt5, 1);
assert.equal(parsed.firstEditToolCall, 2);
assert.equal(parsed.codeContext[0].operation, "repoMap");
assert.equal(parsed.repositoryMapBudgetOverruns, 0);
assert.equal(parsed.warmRetrievalMs, 12);
assert.ok(parsed.duplicateContextRatio > 0);
assert.match(promptFor({ prompt: "Fix task", gold: { testFiles: ["tests/a.test.js"] } }, "candidate"), /use code_context repoMap/);
assert.match(promptFor({ prompt: "Fix task", gold: { testFiles: ["tests/a.test.js"] } }, "control"), /Do not use code_context/);
const pin = { version: "0.9.3", status: { initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }, adapterFreshness: { stale: false, gatingSafe: true } };
assert.equal(evaluateCodegraphPin(pin).passed, true);
assert.equal(evaluateCodegraphPin({ ...pin, status: { ...pin.status, pendingChanges: { modified: 1 } } }).passed, false);
assert.equal(evaluateFreshCanary({ freshness: "fresh", gatingSafe: true, items: [{ path: "src/a.js" }] }, pin).passed, true);
assert.equal(evaluateFreshCanary({ freshness: "stale", gatingSafe: false, items: [] }, pin).passed, false);
const { buildManifest } = require("../scripts/prepare-code-context-gold-review");
const { manifestHash } = require("../src/code-context-gold-review");
const corpus = { tasks: Array.from({ length: 30 }, (_, i) => ({ ...tasks[i + 1], taskId: `reviewed-${i}`, parentRevision: "a".repeat(40), goldRevision: "b".repeat(40), critical: i === 0, taskClasses: ["interface-change", "multi-file", "regression-fix", "performance-lifecycle", "privacy-security"] })) };
const gold = buildManifest(corpus, 30, () => "require('../src/a.js')", () => ["tests/a.test.js"]);
assert.throws(() => reviewedRunPlan(corpus, gold, { count: 30 }), /not approved/);
for (const task of gold.tasks) {
  task.review = { status: "approved", reviewer: { kind: "human", id: "fixture-reviewer" }, reviewedAt: new Date().toISOString(), rationale: "Deterministic fixture review, not a field judgment." };
  for (const judgment of [...task.sourceJudgments, ...task.judgments]) { judgment.label = "relevant"; judgment.rationale = "Relevant fixture behavior under review."; }
  task.verifierEvidenceIds = ["fixture-proof"];
}
gold.manifestHash = manifestHash(gold);
const plan = reviewedRunPlan(corpus, gold, { count: 30, model: "pinned-model", thinking: "low", timeoutMs: 1000 });
assert.equal(plan.tasks.length, 30);
const resumed = { contractHash: plan.contractHash, runs: [{ taskId: plan.tasks[0].taskId, mode: "candidate", cohortKey: plan.contract.cohort.cohortKey, goldManifestHash: gold.manifestHash }] };
assert.doesNotThrow(() => validateResume(resumed, plan));
assert.throws(() => validateResume({ ...resumed, contractHash: "old-source" }, plan), /identity changed/);
assert.throws(() => validateResume({ ...resumed, runs: [...resumed.runs, ...resumed.runs] }, plan), /mixed resumed/);
const escape = structuredClone(gold); escape.tasks[0].judgments[0].path = "../../private.js"; escape.manifestHash = manifestHash(escape);
assert.throws(() => reviewedRunPlan(corpus, escape, { count: 30 }), /repository-relative/);
assert.equal(parseArgs(["--gold-manifest", "review.json", "--plan-only"]).planOnly, true);
// Reject failed environment canaries before resuming work or rewriting evidence.
const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(root, ".pi", "test-fixtures");
fs.mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(fixtureRoot, "paired-resume-"));
try {
  const corpusPath = path.join(directory, "corpus.json"), goldPath = path.join(directory, "gold.json"), outputPath = path.join(directory, "output.json");
  for (const [file, data] of [[corpusPath, corpus], [goldPath, gold]]) fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const args = ["--corpus", corpusPath, "--gold-manifest", goldPath, "--output", outputPath, "--model", "fixture-model-must-not-run"];
  const cliPlan = reviewedRunPlan(corpus, gold, parseArgs(args));
  const base = { schemaVersion: 2, contract: cliPlan.contract, contractHash: cliPlan.contractHash, runs: cliPlan.tasks.flatMap(task => ["broad-read-control", "candidate"].map(mode => ({
    taskId: task.taskId, mode, cohortKey: cliPlan.contract.cohort.cohortKey, goldManifestHash: gold.manifestHash, goldReviewStatus: "approved",
    success: false, canary: mode === "candidate" ? { passed: true } : null,
  }))) };
  const invalidRow = { ...base.runs.at(-1), environmentInvalid: true, canary: { passed: false } };
  const aborted = { taskId: invalidRow.taskId, reason: "fresh-codecontext-canary-failed", canary: invalidRow.canary };
  // Even a broken validator must not launch a Git worktree, provider or paid model.
  const guardPath = path.join(directory, "forbid-processes.cjs"), attemptsPath = path.join(directory, "process-attempts.jsonl");
  fs.writeFileSync(guardPath, `const cp = require("node:child_process"), fs = require("node:fs");
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[method] = () => {
  fs.appendFileSync(${JSON.stringify(attemptsPath)}, method + "\\n", { mode: 0o600 });
  throw new Error("resume regression forbids external processes");
};\n`, { mode: 0o600 });
  const runCli = () => spawnSync(process.execPath, ["--require", guardPath, "scripts/run-code-context-paired-benchmark.js", ...args], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 });
  const scenarios = [
    { name: "saved abort marker", mutate: state => { state.aborted = aborted; } },
    { name: "invalid environment without abort marker", mutate: state => { state.runs[state.runs.length - 1] = invalidRow; } },
    { name: "completed arms with failed canary", mutate: state => { state.aborted = aborted; state.runs[state.runs.length - 1] = invalidRow; } },
    { name: "failed canary with pending arms", mutate: state => { state.aborted = aborted; state.runs = [invalidRow]; } },
  ];
  for (const scenario of scenarios) {
    const state = structuredClone(base); scenario.mutate(state);
    fs.writeFileSync(outputPath, JSON.stringify(state), { mode: 0o600 });
    const before = [corpusPath, goldPath, outputPath].map(file => ({ bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs }));
    const result = runCli();
    assert.equal(result.error, undefined, scenario.name);
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /canary-aborted or invalid-environment cohort/, scenario.name);
    assert(!fs.existsSync(attemptsPath), `${scenario.name}: resumed work was attempted`);
    for (const [i, file] of [corpusPath, goldPath, outputPath].entries()) {
      assert.deepEqual(fs.readFileSync(file), before[i].bytes, `${scenario.name}: evidence bytes changed`);
      assert.equal(fs.statSync(file).mtimeMs, before[i].mtimeMs, `${scenario.name}: evidence rewritten`);
    }
    assert.deepEqual(fs.readdirSync(directory).sort(), ["corpus.json", "forbid-processes.cjs", "gold.json", "output.json"]);
  }
  fs.writeFileSync(outputPath, JSON.stringify(base), { mode: 0o600 });
  const valid = runCli();
  assert.equal(valid.error, undefined);
  assert.equal(valid.status, 0, valid.stderr);
  const completed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.deepEqual(completed.runs, base.runs, "ordinary failed tasks are valid completed evidence, not environment failures");
  assert(completed.completedAt);
  assert.equal(completed.summary.runs, 60);
  assert.equal(completed.summary.successes, 0);
  assert(!fs.existsSync(attemptsPath), "completed resume must not rerun any arm");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("code-context paired runner tests passed");
