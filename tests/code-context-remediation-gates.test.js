#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { STAGES, BARS, parseArgs, evaluateSelectionGate } = require("../scripts/run-code-context-remediation-gates.js");
assert.deepEqual(STAGES.map((stage) => stage.count), [5, 10, 30]);
assert.equal(parseArgs(["--through=e2"]).through, "E2");
assert.throws(() => parseArgs(["--through=E4"]), /E1, E2, or E3/);
function row(id, options = {}) { return { taskId: id, critical: options.critical === true, goldReviewStatus: options.goldReviewStatus || "approved", environmentValid: options.environmentValid !== false, metrics: { affected_test_recall: options.recall ?? 1, affected_test_precision: options.precision ?? 0.8, stale_degraded_gating_count: options.unsafe ?? 0 } }; }
const passingRows = [row("a"), row("b"), row("c"), row("d"), row("e", { critical: true })];
const pass = evaluateSelectionGate(passingRows, STAGES[0]);
assert.equal(pass.verdict, "pass");
assert.equal(pass.metrics.highRiskRecall, 1);
assert.ok(pass.evidenceId.startsWith("selection_gate_"));
assert.equal(evaluateSelectionGate(passingRows.map((item, index) => index === 4 ? row("e", { critical: true, recall: 0 }) : item), STAGES[0]).verdict, "fail");
assert.equal(evaluateSelectionGate(passingRows.map((item, index) => index === 0 ? row("a", { precision: BARS.affectedPrecision - 0.1 }) : item), STAGES[0]).verdict, "pass", "the preregistered precision bar applies to the stage mean");
assert.equal(evaluateSelectionGate(passingRows.map((item) => ({ ...item, critical: false })), STAGES[0]).verdict, "fail", "a stage without critical coverage cannot advance");
assert.equal(evaluateSelectionGate(passingRows.map((item, index) => index ? item : { ...item, goldReviewStatus: "candidate" }), STAGES[0]).verdict, "fail", "unreviewed commit metadata cannot authorize advancement");
console.log("code-context remediation gate tests passed");
