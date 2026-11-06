#!/usr/bin/env node
"use strict";

const { renderInjectedReasoningContext, dedupeInjectedContext } = require("../src/reasoning-injection.js");

const BASELINE = Object.freeze({ events: 5, chars: 30735, averageChars: 6147, source: "metadata-only pre-Phase-5 extension telemetry" });
const version = { version: "reasoning-runtime-phase5", source: { sha256: "abcdef1234567890", path: "reasoning-runtime" }, templateHash: "phase5-template" };
const objectives = [
  "Implement the parser change while preserving API compatibility and run focused tests.",
  "Continue the parser change; keep API compatibility and inspect the first test result.",
  "Continue the parser change; keep API compatibility and inspect the first test result.",
  "Fix the identified edge case without weakening validation, then rerun focused tests.",
  "Record the verified decision and run the broader regression gate.",
  "Summarize completion evidence while preserving explicit safety boundaries.",
];

function scaffold(objective, index) {
  return {
    kind: "reasoning.scaffold",
    plan: { id: `plan_${index}`, createdAt: `2026-07-26T00:00:0${index}.000Z`, objective, steps: [{ id: "understand", description: "Inspect constraints", status: "pending" }, { id: "execute", description: "Implement", status: "pending" }, { id: "verify", description: "Verify", status: "pending" }], risks: ["stale context", "unverified result", "private reasoning leakage"], successCriteria: ["objective preserved", "tests pass", "safety boundary retained"] },
    decomposition: { id: `decomp_${index}`, task: objective, subtasks: [{ id: "inspect", title: "Inspect" }, { id: "change", title: "Change" }, { id: "validate", title: "Validate" }] },
    checkpoint: { id: `checkpoint_${index}`, createdAt: `2026-07-26T00:00:0${index}.001Z`, publicSummary: objective },
  };
}
function memory() {
  return [
    { type: "strategic", title: "User objective", content: "an older unrelated objective" },
    { type: "procedural", title: "Automatic verification completed", content: "A previous unrelated full check passed.", tags: ["verification"], verification: "verified" },
    { type: "semantic", title: "Integration boundary", content: "Extensions consume shared libraries through explicit adapters." },
    { type: "semantic", title: "Integration boundary", content: "Extensions consume shared libraries through explicit adapters." },
  ];
}
function runBenchmark() {
  let previous;
  let total = 0;
  let fullCount = 0;
  let deltaCount = 0;
  let suppressed = 0;
  let routerGuidance = 0;
  const rows = [];
  for (let index = 0; index < objectives.length; index++) {
    const objective = objectives[index];
    const advisoryText = index === 0 ? "[L2:auto-router] Role topology suggestion\nSuggested topology: planning-advisory\nThis is advisory only." : "";
    if (advisoryText) routerGuidance++;
    const rendered = renderInjectedReasoningContext({
      version,
      scaffold: scaffold(objective, index),
      objective,
      memoryEntries: memory(),
      layeredText: `[L0:memory] Integration boundary contract\nUse explicit adapters.\n\n[L1:memory] Safety boundary\nNever expose private reasoning or weaken verification.\n\n[L2:objective] Active user objective\n${objective}`,
      advisoryText,
      scaffoldMode: index === 0 ? "full" : "delta",
      maxChars: 7000,
    });
    const result = dedupeInjectedContext(previous, rendered, { maxChars: 7000 });
    previous = rendered;
    const chars = result.inject?.length || 0;
    total += chars;
    if (result.reason === "first") fullCount++;
    else if (result.reason === "delta") deltaCount++;
    else suppressed++;
    rows.push({ turn: index + 1, reason: result.reason, chars, hasCurrentObjective: result.inject ? result.inject.includes(objective) : objective === objectives[index - 1] });
  }
  const averageChars = total / objectives.length;
  const reductionPct = (1 - averageChars / BASELINE.averageChars) * 100;
  const checks = {
    reduction: reductionPct >= 60,
    objectiveRetention: rows.every((row) => row.hasCurrentObjective),
    runtimeRetention: rows[0].chars > 0 && renderInjectedReasoningContext({ version, scaffold: scaffold(objectives[0], 0), objective: objectives[0] }).includes("reasoning-runtime-phase5"),
    constraintRetention: renderInjectedReasoningContext({ version, scaffold: scaffold(objectives[0], 0), objective: objectives[0], layeredText: "[L1:memory] Safety boundary\nNever weaken verification." }).includes("Never weaken verification."),
    stableRouterGuidance: routerGuidance === 1,
    duplicateTurnSuppressed: rows[2].reason === "identical",
  };
  return { schemaVersion: 1, baseline: BASELINE, post: { turns: objectives.length, chars: total, averageChars: Number(averageChars.toFixed(2)), reductionPct: Number(reductionPct.toFixed(2)), fullCount, deltaCount, suppressed, routerGuidance, rows }, checks, ok: Object.values(checks).every(Boolean) };
}

if (require.main === module) {
  const result = runBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = { BASELINE, runBenchmark };
