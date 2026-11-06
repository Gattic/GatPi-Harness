#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BENCHMARK_ID, BENCHMARK_SCHEMA_VERSION, SEMANTIC_BARS, currentCodeContextCohort } = require("../src/code-context-cohort.js");
const { MODES, resolveRolloutMode } = require("../src/code-context-rollout.js");
const { tmpFixture } = require("./helpers/tmp-fixture");
const projectRoot = path.resolve(__dirname, "..");
const temp = tmpFixture("pi-code-context-rollout-");
const reportFile = path.join(temp, "report.json");
const cohort = currentCodeContextCohort(projectRoot, { bars: SEMANTIC_BARS });
assert.equal(cohort.complete, true);
assert.deepEqual(MODES, ["off", "shadow", "advisory", "select-tests", "on"]);
assert.equal(resolveRolloutMode(projectRoot, "advisory").effective, "advisory");
const denied = resolveRolloutMode(projectRoot, "select-tests", { reportPath: reportFile });
assert.equal(denied.effective, "advisory");
assert.equal(denied.authorized, false);

fs.writeFileSync(reportFile, JSON.stringify({ schemaVersion: 3, benchmark: BENCHMARK_ID, cohort, promotion: { selectTestsEligible: true } }));
assert.equal(resolveRolloutMode(projectRoot, "select-tests", { reportPath: reportFile }).reason, "saved benchmark schema is incompatible");

function report(overrides = {}) {
  const candidate = { definition_mrr: 0.95, file_recall_at_5: 0.98, stale_degraded_gating_count: 0 };
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmark: BENCHMARK_ID,
    cohort,
    tracks: { retrieval: { modes: { candidate } } },
    gates: { checks: { exactCohort: true, definitionMrr: true, fileRecallAt5: true, retrievalZeroDegradation: true }, selectTestsEligible: true, onEligible: false },
    promotion: { selectTestsEligible: true, onEligible: false },
    ...overrides,
  };
}
fs.writeFileSync(reportFile, JSON.stringify(report({ cohort: { ...cohort, sourceFingerprint: "different", cohortKey: "different" } })));
const mismatched = resolveRolloutMode(projectRoot, "select-tests", { reportPath: reportFile });
assert.equal(mismatched.effective, "advisory");
assert.equal(mismatched.reason, "cohort-mismatch");
assert.ok(mismatched.changedFields.includes("sourceFingerprint"));

const transportOnly = report();
transportOnly.tracks.retrieval.modes.candidate.file_recall_at_5 = 0.2;
fs.writeFileSync(reportFile, JSON.stringify(transportOnly));
assert.equal(resolveRolloutMode(projectRoot, "select-tests", { reportPath: reportFile }).reason, "saved benchmark does not satisfy semantic retrieval bars");

fs.writeFileSync(reportFile, JSON.stringify(report()));
assert.equal(resolveRolloutMode(projectRoot, "select-tests", { reportPath: reportFile }).effective, "select-tests");
assert.equal(resolveRolloutMode(projectRoot, "on", { reportPath: reportFile }).effective, "advisory");
const onReport = report();
onReport.gates.onEligible = true;
onReport.promotion.onEligible = true;
fs.writeFileSync(reportFile, JSON.stringify(onReport));
assert.equal(resolveRolloutMode(projectRoot, "on", { reportPath: reportFile }).effective, "on");
console.log("code-context rollout tests passed");
