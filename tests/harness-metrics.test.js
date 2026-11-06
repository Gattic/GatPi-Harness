"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { collectHarnessMetrics, formatHarnessMetrics } = require("../src/harness-metrics.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-harness-metrics-");
function write(rel, content) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Empty repo: every section present, zeroed, nothing throws.
const empty = collectHarnessMetrics(cwd);
assert.equal(empty.goals.total, 0);
assert.equal(empty.verification.runs, 0);
assert.equal(empty.refactors.total, 0);
assert.equal(empty.recall.recallEvents, 0);
assert.equal(empty.learning.outcomes, 0);
assert.equal(empty.managedProcesses.total.starts, 0);
assert.equal(empty.fixRecall.status, "unknown");
assert.equal(empty.cwd, undefined);
assert.match(empty.projectHash, /^[0-9a-f]{16}$/);
assert.match(formatHarnessMetrics(empty), /no goals recorded/i);

// Goal store: single per-repo file with a goals array.
write(".pi/goal-state/repo.json", JSON.stringify({
  goals: [
    { goalId: "g1", status: "completed" },
    { goalId: "g2", status: "completed" },
    { goalId: "g3", status: "blocked" },
    { goalId: "g4", status: "cancelled" },
  ],
}));

// Verification center: latest.json plus historical run files with ok flags.
write(".pi/verification-center/latest.json", JSON.stringify({ ok: false, profile: "quick", generatedAt: "2026-07-10T10:00:00Z" }));
write(".pi/verification-center/run-1.json", JSON.stringify({ ok: true, profile: "quick" }));
write(".pi/verification-center/run-2.json", JSON.stringify({ ok: false, profile: "changed" }));

// AST refactor checkpoints retain file snapshots for reviewed broad edits.
write(".pi/ast-refactor/checkpoints/r1.json", JSON.stringify({ id: "r1", files: [{ file: "src/a.js" }, { file: "src/b.js" }] }));
write(".pi/ast-refactor/checkpoints/r2.json", JSON.stringify({ id: "r2", files: [{ file: "src/c.js" }] }));

// Traces: recall events, a failure, and a slow event.
write(".pi/traces/session.jsonl", [
  JSON.stringify({ category: "memory_retrieval", name: "project_memory.recall", subsystem: "project-memory", duration_ms: 120 }),
  JSON.stringify({ category: "memory_retrieval", name: "project_memory.index_fallback", subsystem: "project-memory" }),
  JSON.stringify({ category: "failure_state", name: "tool.failed", subsystem: "verify", severity: "error" }),
  JSON.stringify({ category: "model_request", name: "turn", subsystem: "agent", duration_ms: 6000 }),
].join("\n"));

// Learning loop: outcomes, patterns, decisions.
write(".pi/learning-loop/outcomes.jsonl", [
  JSON.stringify({ outcomeId: "o1", source: "verification", signals: { status: "succeeded" } }),
  JSON.stringify({ outcomeId: "o2", source: "goal", signals: { status: "infrastructure-failed" } }),
].join("\n"));
write(".pi/learning-loop/patterns.jsonl", JSON.stringify({ patternId: "p1" }));
write(".pi/learning-loop/decisions.jsonl", JSON.stringify({ decisionId: "d1", action: "approve" }));

// Retrieval savings are only provable per tool, so the fixture records both a
// compacted result and a large result that escaped compaction.
const { createExtensionTelemetry } = require("../src/extension-telemetry.js");
const telemetry = createExtensionTelemetry({ cwd, extension: "output-compactor", version: "test", sourceFingerprint: "source_0123456789abcdef" });
telemetry.featureSignal("output-compactor", "compacted", { tool: "codegraph_query", reason: "codegraph_query", outcome: "succeeded", sessionKind: "interactive", inputChars: 9000, outputChars: 1500, savedChars: 7500 });
telemetry.featureSignal("output-compactor", "bypassed", { tool: "semgrep_scan", reason: "outside-canary", outcome: "not-applicable", sessionKind: "interactive", inputChars: 11000, outputChars: 11000 });
telemetry.featureSignal("tool-result-rendering", "observed", { tool: "codegraph_query", reason: "final-result", outcome: "succeeded", inputChars: 9000, modelChars: 1500, outputChars: 1500, savedChars: 7500, budgetTokens: 700 });
telemetry.featureSignal("tool-result-rendering", "observed", { tool: "semgrep_scan", reason: "final-result", outcome: "succeeded", inputChars: 11000, modelChars: 11000, outputChars: 11000, budgetTokens: 700 });

const m = collectHarnessMetrics(cwd);
assert.equal(m.goals.total, 4);
assert.equal(m.goals.byStatus.completed, 2);
assert.equal(m.goals.successRate, 0.5);
assert.equal(m.verification.runs, 3);
assert.equal(m.verification.failed, 2);
assert.equal(m.verification.catchRate, 2 / 3);
assert.equal(m.refactors.total, 2);
assert.equal(m.refactors.files, 3);
assert.equal(m.recall.recallEvents, 2);
assert.equal(m.recall.cacheFallbacks, 1);
assert.equal(m.recall.failureEvents, 1);
assert.equal(m.recall.slowEvents, 1);
assert.equal(m.learning.outcomes, 2);
assert.equal(m.learning.bySource.verification, 1);
assert.equal(m.learning.patterns, 1);
assert.equal(m.learning.decisions, 1);
assert.equal(m.learning.infrastructureFailed, 1);
assert.equal(m.learning.failed, 1);

const text = formatHarnessMetrics(m);
assert.match(text, /goals: 4/i);
assert.match(text, /success rate: 50%/i);
assert.match(text, /verification runs: 3/i);
assert.match(text, /catch rate: 67%/i);
assert.match(text, /recall events: 2/i);
assert.match(text, /learning outcomes: 2/i);
assert.match(text, /managed processes:/i);
assert.match(text, /fix recall:/i);
assert.match(text, /retrieval savings: results=2, raw=20000 chars, model-visible=12500 chars, saved=7500 chars; backstop bypasses=1 \(11000 chars\)/, "native and backstop savings are counted once per final result");
assert.equal(m.retrievalSavings.results, 2);
assert.equal(m.retrievalSavings.savedChars, 7500);
assert.match(text, /codegraph_query saved=7500 bypassed=0/);
assert.match(text, /semgrep_scan saved=0 bypassed=11000/);
assert.doesNotMatch(text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "public metrics render no project path");

console.log("harness-metrics tests passed");
