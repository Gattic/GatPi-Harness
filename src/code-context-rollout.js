"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BENCHMARK_ID, BENCHMARK_SCHEMA_VERSION, SEMANTIC_BARS, currentCodeContextCohort, compareCodeContextCohorts } = require("./code-context-cohort.js");

const MODES = Object.freeze(["off", "shadow", "advisory", "select-tests", "on"]);
const REQUIRED_SEMANTIC_CHECKS = Object.freeze(["exactCohort", "definitionMrr", "fileRecallAt5", "retrievalZeroDegradation"]);
function readReport(root, file) { try { return JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8")); } catch { return null; } }
function semanticEvidence(report) {
  const candidate = report?.tracks?.retrieval?.modes?.candidate || report?.modes?.candidate || {};
  const checks = report?.gates?.checks || {};
  const checkParity = REQUIRED_SEMANTIC_CHECKS.every((key) => checks[key] === true);
  const valuesPass = Number(candidate.definition_mrr) >= SEMANTIC_BARS.definitionMrr
    && Number(candidate.file_recall_at_5) >= SEMANTIC_BARS.fileRecallAt5
    && Number(candidate.stale_degraded_gating_count) === SEMANTIC_BARS.retrievalDegradationCount;
  return { passed: checkParity && valuesPass, checkParity, valuesPass, checks: Object.fromEntries(REQUIRED_SEMANTIC_CHECKS.map((key) => [key, checks[key] === true])) };
}
function resolveRolloutMode(root, requested = process.env.PI_CODE_CONTEXT_MODE || "advisory", options = {}) {
  const mode = MODES.includes(requested) ? requested : "advisory";
  if (!["select-tests", "on"].includes(mode)) return { requested: mode, effective: mode, authorized: true, report: null, reason: null };
  const reportPath = options.reportPath || process.env.PI_CODE_CONTEXT_BENCHMARK_REPORT || path.join(".pi", "code-context", "benchmarks", "latest.json");
  const report = readReport(root, reportPath);
  if (!report) return { requested: mode, effective: "advisory", authorized: false, report: null, reason: `saved benchmark report required for ${mode}` };
  if (report.schemaVersion !== BENCHMARK_SCHEMA_VERSION || report.benchmark !== BENCHMARK_ID) return { requested: mode, effective: "advisory", authorized: false, report: reportPath, reason: "saved benchmark schema is incompatible", reportSchemaVersion: report.schemaVersion };
  const expectedCohort = options.expectedCohort || currentCodeContextCohort(root, { strategyId: options.strategyId, providerConfigHash: options.providerConfigHash, bars: SEMANTIC_BARS });
  const comparison = compareCodeContextCohorts(expectedCohort, report.cohort);
  if (!comparison.compatible) return { requested: mode, effective: "advisory", authorized: false, report: reportPath, reason: comparison.comparisonReason, changedFields: comparison.changedFields, reportSchemaVersion: report.schemaVersion };
  const semantic = semanticEvidence(report);
  if (!semantic.passed) return { requested: mode, effective: "advisory", authorized: false, report: reportPath, reason: "saved benchmark does not satisfy semantic retrieval bars", semantic, reportSchemaVersion: report.schemaVersion };
  const eligible = mode === "on" ? report?.promotion?.onEligible === true && report?.gates?.onEligible === true : report?.promotion?.selectTestsEligible === true && report?.gates?.selectTestsEligible === true;
  if (eligible) return { requested: mode, effective: mode, authorized: true, report: reportPath, reason: null, cohortKey: report.cohort.cohortKey, semantic, reportSchemaVersion: report.schemaVersion };
  return { requested: mode, effective: "advisory", authorized: false, report: reportPath, reason: `saved benchmark report does not authorize ${mode}`, cohortKey: report.cohort.cohortKey, semantic, reportSchemaVersion: report.schemaVersion };
}
module.exports = { MODES, REQUIRED_SEMANTIC_CHECKS, readReport, semanticEvidence, resolveRolloutMode };
