"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MANIFEST, prepareTask, observedFiles, checkAnswer, benchmarkOptions, summarize, digest } = require("../src/codemode-benchmark");
const { tmpFixture } = require("./helpers/tmp-fixture");
assert.equal(MANIFEST.length, 30);
assert.equal(new Set(MANIFEST.map(task => task.id)).size, 30);
for (const kind of ["simple", "batch", "chain"]) assert.equal(MANIFEST.filter(task => task.kind === kind).length, 10);
const directory = tmpFixture("pi-codemode-oracles-");
try {
  for (const task of MANIFEST) {
    const prepared = prepareTask(task, path.join(directory, task.id));
    const answer = JSON.stringify({ value: prepared.expected, evidence: prepared.evidence });
    assert(checkAnswer(answer, prepared, prepared.evidence).ok);
    assert(!checkAnswer(answer, prepared, []).ok, "fabricated evidence cannot pass");
    assert(!checkAnswer(JSON.stringify({ value: prepared.expected + 1, evidence: prepared.evidence }), prepared, prepared.evidence).ok);
    assert.equal(digest(prepared.files), prepared.fixtureDigest);
  }
} finally { fs.rmSync(directory, { recursive: true }); }
const calls = [
  { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: path.join(directory, "docs/actual.json") } },
  { type: "tool_execution_end", toolCallId: "read", isError: false, result: {} },
  { type: "tool_execution_start", toolCallId: "blocked", toolName: "read", args: { path: "docs/blocked.json" } },
  { type: "tool_execution_end", toolCallId: "blocked", isError: true, result: {} },
];
assert.deepEqual(observedFiles(calls, directory), ["docs/actual.json"], "only successful observations count, with absolute paths normalized");
assert.equal(summarize([]).parity, false);
assert.equal(summarize([]).direct.reportedCost, null);
assert.throws(() => benchmarkOptions(["--live"], {}), error => error.code === "MODEL_IDENTITY_MISSING");
assert.throws(() => benchmarkOptions(["--live", "--synthetic"], {}));
assert.throws(() => benchmarkOptions(["--live", "--provider"], {}));
assert.deepEqual(benchmarkOptions(["--live", "--provider", "selected", "--model", "exact", "--thinking", "high"], {}), { mode: "live", provider: "selected", model: "exact", thinking: "high" });
const rows = MANIFEST.flatMap(task => ["direct", "codemode"].map(arm => ({ ...task, arm, oracle: { ok: true }, integrity: true, toolFailures: 0, providerError: false, contextEstimatedTokens: arm === "direct" ? 100 : 50, reportedCost: null, wallMs: 10 })));
assert.equal(summarize(rows).parity, true);
assert.equal(summarize(rows).benefitTargets.cost, null, "missing cost is unknown, never a pass");
assert.equal(summarize(rows.slice(1)).parity, false, "unrun cases remain incomplete");
assert.deepEqual(summarize(rows.slice(1)).benefitTargets, { context: null, latency: null, cost: null }, "partial samples cannot pass full-cohort targets");
assert.equal(summarize([{ ...rows[0], integrity: false }, ...rows.slice(1)]).parity, false);
assert.equal(summarize([{ ...rows[0], toolFailures: 1 }, ...rows.slice(1)]).parity, false, "a correct final answer cannot erase tool failures");
console.log("codemode benchmark manifest and oracle tests passed");
