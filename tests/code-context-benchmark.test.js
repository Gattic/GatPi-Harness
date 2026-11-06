#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { METRICS, BARS, isNumeric, parseArgs, fixtureCheck, aggregateRuns, pairedStats, selectionEvidence, requiredPairedSample, buildReport } = require("../scripts/benchmark-code-context.js");

const fixtureRoot = path.join(__dirname, "fixtures", "code-context");
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
const checked = fixtureCheck(manifest);
assert.equal(checked.ok, true, checked.errors.join("\n"));
assert.ok(METRICS.includes("localization_recall"));
assert.deepEqual(parseArgs(["--fixture-only", "--report=out.json"]), { fixtureOnly: true, report: "out.json", input: null });
const aggregate = aggregateRuns([{ metrics: { localization_recall: 1 } }, { metrics: { localization_recall: 0.5 } }]);
assert.equal(aggregate.localization_recall, 0.75);
assert.equal(aggregate.wall_clock_ms, null);
assert.equal(isNumeric(null), false);
assert.equal(isNumeric(undefined), false);
assert.equal(isNumeric(0), true);
assert.equal(aggregateRuns([{ metrics: { trace_overhead_ratio: null } }]).trace_overhead_ratio, null, "missing metrics must not become synthetic zeroes");
const report = buildReport(manifest, checked, { runs: [{ mode: "broad-read-control", metrics: { localization_recall: 1 } }] });
assert.equal(report.schemaVersion, 4);
assert.equal(report.evidenceStatus, "measured");
assert.equal(report.tracks.testSelection.runCount, 0);
assert.equal(report.modes["broad-read-control"].localization_recall, 1);
assert.equal(report.modes.candidate.localization_recall, null);
assert.equal(report.promotion.selectTestsEligible, false);
assert.equal(report.gates.checks.goldNormalization, false, "measured runs must report gold normalization explicitly");
assert.equal(report.promotion.onEligible, false);
assert.equal(BARS.pilotPairs, 30);
const paired = pairedStats([{ pairId: "p1", mode: "broad-read-control", success: true }, { pairId: "p1", mode: "candidate", success: true }]);
assert.equal(paired.pairs, 1);
assert.equal(paired.validPairs, 0, "promotion evidence requires task, revision, and verifier evidence IDs");
assert.equal(paired.operationalEvidenceComplete, false);
const repeatedTaskRuns = Array.from({ length: 30 }, (_, index) => [
  { pairId: `pair-${index}`, taskId: "same-task", revision: "rev-1", mode: "broad-read-control", success: true, evidenceId: `control-${index}` },
  { pairId: `pair-${index}`, taskId: "same-task", revision: "rev-1", mode: "candidate", success: true, evidenceId: `candidate-${index}` },
]).flat();
const repeated = pairedStats(repeatedTaskRuns);
assert.equal(repeated.validPairs, 30);
assert.equal(repeated.distinctTasks, 1, "repeated fixtures must not inflate the representative task count");
assert.equal(buildReport(manifest, checked, { runs: repeatedTaskRuns, goldNormalization: 1 }).gates.checks.pilotSuccess, false);
const distinctTaskRuns = Array.from({ length: 30 }, (_, index) => [
  { pairId: `distinct-pair-${index}`, taskId: `task-${index}`, revision: "rev-1", mode: "broad-read-control", success: true, evidenceId: `distinct-control-${index}` },
  { pairId: `distinct-pair-${index}`, taskId: `task-${index}`, revision: "rev-1", mode: "candidate", success: true, evidenceId: `distinct-candidate-${index}` },
]).flat();
const distinct = pairedStats(distinctTaskRuns);
assert.equal(distinct.validPairs, 30);
assert.equal(distinct.distinctTasks, 30);
assert.equal(distinct.operationalEvidenceComplete, true);
const selectionRows = Array.from({ length: 30 }, (_, index) => ({ taskId: `task-${index}`, revision: "rev-1", evidenceId: `selection-${index}`, metrics: { high_risk_affected_test_recall: 1, affected_test_recall: 1, affected_test_precision: 0.8, stale_degraded_gating_count: 0 } }));
assert.equal(selectionEvidence(selectionRows).complete, true);
assert.equal(selectionEvidence(selectionRows).distinctTasks, 30);
const cohort = require("../src/code-context-cohort").currentCodeContextCohort(path.join(__dirname, ".."), { strategyId: "repository-map-v1", providerConfigHash: "provider-config-1" });
const identity = { cohortKey: cohort.cohortKey, goldManifestHash: "a".repeat(64), goldReviewStatus: "approved" };
selectionRows.forEach(row => Object.assign(row, identity));
const retrievalRows = distinctTaskRuns.map((row) => row.mode === "candidate" ? { ...row, ...identity, strategyId: "repository-map-v1", providerConfigHash: "provider-config-1", metrics: { repository_map_budget_overruns: 0, definition_mrr: 0.95, file_recall_at_5: 0.98, stale_degraded_gating_count: 0 } } : { ...row, ...identity });
const splitReport = buildReport(manifest, checked, { runs: retrievalRows, testSelectionRuns: selectionRows, goldNormalization: 1, privacyPolicyFindings: 0 });
assert.equal(splitReport.cohort.complete, true);
assert.equal(splitReport.gates.checks.exactCohort, true);
assert.equal(splitReport.gates.checks.definitionMrr, true);
assert.equal(splitReport.gates.checks.fileRecallAt5, true);
assert.equal(splitReport.gates.checks.retrievalZeroDegradation, true);
assert.equal(splitReport.gates.checks.selectionEvidence, true);
assert.equal(splitReport.gates.checks.affectedRecall, true);
assert.equal(splitReport.gates.checks.pilotSuccess, true);
assert.equal(splitReport.promotion.selectTestsEligible, true, "select-tests uses genuine separate impact evidence plus paired task outcomes");
assert.equal(splitReport.promotion.onEligible, false, "default-on still requires retrieval quality, token, latency, and powered confidence bars");
assert.equal(splitReport.gates.checks.shadowP95, false);
assert.equal(splitReport.gates.checks.traceOverhead, false);
const staleSourceRows = retrievalRows.map(row => ({ ...row, cohortKey: "old-source" }));
assert.equal(buildReport(manifest, checked, { runs: staleSourceRows, testSelectionRuns: selectionRows, goldNormalization: 1, privacyPolicyFindings: 0 }).promotion.selectTestsEligible, false, "report regeneration cannot requalify old-source outcomes");
assert.equal(buildReport(manifest, checked, { runs: retrievalRows, testSelectionRuns: selectionRows, goldNormalization: 1 }).gates.checks.noPrivacyPolicyFindings, false, "missing privacy review is not zero findings");
const noSelectionReport = buildReport(manifest, checked, { runs: retrievalRows, goldNormalization: 1, privacyPolicyFindings: 0 });
assert.equal(noSelectionReport.gates.checks.selectionEvidence, false);
assert.equal(noSelectionReport.promotion.selectTestsEligible, false, "retrieval runs cannot impersonate test-selection evidence");
const degradedRows = retrievalRows.map((row, index) => row.mode === "candidate" && index === 1 ? { ...row, metrics: { ...row.metrics, stale_degraded_gating_count: 1 } } : row);
assert.equal(buildReport(manifest, checked, { runs: degradedRows, testSelectionRuns: selectionRows, goldNormalization: 1 }).promotion.selectTestsEligible, false, "transport success cannot override degraded retrieval evidence");
const mixedRows = retrievalRows.map((row, index) => row.mode === "candidate" && index === 1 ? { ...row, strategyId: "repository-map-v2" } : row);
const mixedReport = buildReport(manifest, checked, { runs: mixedRows, testSelectionRuns: selectionRows, goldNormalization: 1 });
assert.equal(mixedReport.cohort.complete, false);
assert.equal(mixedReport.promotion.selectTestsEligible, false, "mixed strategy cohorts fail closed");
assert.ok(requiredPairedSample(0.8, 0.01, 0.05, 0.8) > 50, "a one-point-style margin cannot be proved by an arbitrary 50-task pilot");

console.log("code-context benchmark tests passed");
