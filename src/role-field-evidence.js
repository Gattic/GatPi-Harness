"use strict";

const crypto = require("node:crypto");
const { CANONICAL_OUTCOMES } = require("./outcome-schema.js");

const ROLE_FIELD_EVIDENCE_VERSION = "role-field-evidence-v1";
const MIN_ELIGIBLE_LIVE_READ_ONLY_RUNS = 30;
const COMPLETION_BAR = 0.90;
const TIMEOUT_BAR = 0.05;
const P95_BAR_MS = 120_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function safeRate(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : null; }
function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1))];
}
function increment(object, key) { object[key] = (object[key] || 0) + 1; }
function cohortKey(record = {}) {
  const fields = [record.roleRuntimeVersion, record.contractVersion, record.resultSchemaVersion, record.runtimeSourceHash, record.roleRunSchemaVersion || record.schemaVersion, record.mutationMode];
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
function classifyRoleTerminal(input = {}) {
  const status = String(input.status || "unknown");
  const termination = String(input.termination?.code || "");
  if (status === "succeeded") return input.typedResultValid === false || termination && termination !== "submitted" ? "infrastructure-failed" : "succeeded";
  if (status === "timed_out") return "timed-out";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return /timeout|deadline|budget_time/i.test(termination) ? "timed-out" : "infrastructure-failed";
  return "unknown";
}
function determineRoleRunEligibility(input = {}) {
  if (input.fixture === true || /fixture|benchmark|deterministic/i.test(String(input.source || ""))) return { eligible: false, reason: "deterministic-fixture" };
  if (String(input.terminalCategory || classifyRoleTerminal(input)) === "cancelled") return { eligible: false, reason: "operator-cancelled" };
  if (!TERMINAL_STATUSES.has(String(input.status || ""))) return { eligible: false, reason: "nonterminal-or-invalid-status" };
  if (!input.runtimeSourceHash || !input.roleRuntimeVersion || !input.contractVersion || !input.resultSchemaVersion || Number(input.roleRunSchemaVersion || input.schemaVersion) !== 4) return { eligible: false, reason: "missing-cohort-metadata" };
  if (String(input.mutationMode || "") !== "shared-readonly") return { eligible: false, reason: "not-read-only" };
  return { eligible: true, reason: "eligible-live-read-only" };
}
function summarizeRoleFieldEvidence(records = [], options = {}) {
  const runtimeSourceHash = String(options.runtimeSourceHash || records.filter((row) => row?.runtimeSourceHash).at(-1)?.runtimeSourceHash || "");
  const byExclusion = {};
  const eligible = [];
  for (const record of records) {
    const eligibility = determineRoleRunEligibility(record);
    if (!eligibility.eligible) { increment(byExclusion, eligibility.reason); continue; }
    if (runtimeSourceHash && record.runtimeSourceHash !== runtimeSourceHash) { increment(byExclusion, "runtime-source-mismatch"); continue; }
    eligible.push({ ...record, terminalCategory: record.terminalCategory || classifyRoleTerminal(record) });
  }
  const keys = new Set(eligible.map(cohortKey));
  const exactCohort = keys.size === 1;
  const categories = Object.fromEntries(CANONICAL_OUTCOMES.map((category) => [category, 0]));
  for (const record of eligible) increment(categories, CANONICAL_OUTCOMES.includes(record.terminalCategory) ? record.terminalCategory : "unknown");
  const succeeded = categories.succeeded;
  const timedOut = categories["timed-out"];
  const durations = eligible.map((record) => Number(record.totalDurationMs || 0)).filter((value) => Number.isFinite(value) && value >= 0);
  const typedValid = eligible.filter((record) => record.typedResultValid === true).length;
  const accountingValid = eligible.filter((record) => record.accountingValid === true).length;
  const minRuns = Math.max(1, Number(options.minRuns || MIN_ELIGIBLE_LIVE_READ_ONLY_RUNS));
  const sampleReady = eligible.length >= minRuns;
  const completionRate = safeRate(succeeded, eligible.length);
  const timeoutRate = safeRate(timedOut, eligible.length);
  const p95Ms = percentile(durations, 0.95);
  const typedValidityRate = safeRate(typedValid, eligible.length);
  const accountingParityRate = safeRate(accountingValid, eligible.length);
  const bars = {
    completion: { passed: sampleReady ? completionRate >= COMPLETION_BAR : null, measured: completionRate, bar: `>=${COMPLETION_BAR}` },
    timeout: { passed: sampleReady ? timeoutRate <= TIMEOUT_BAR : null, measured: timeoutRate, bar: `<=${TIMEOUT_BAR}` },
    p95: { passed: sampleReady ? p95Ms != null && p95Ms <= P95_BAR_MS : null, measured: p95Ms, bar: `<=${P95_BAR_MS}ms` },
    typedValidity: { passed: sampleReady ? typedValidityRate === 1 : null, measured: typedValidityRate, bar: "100%" },
    accountingParity: { passed: sampleReady ? accountingParityRate === 1 : null, measured: accountingParityRate, bar: "100%" },
    exactCohort: { passed: exactCohort, measured: keys.size, bar: "one exact cohort" },
  };
  const gatePassed = sampleReady && Object.values(bars).every((bar) => bar.passed === true);
  return {
    schemaVersion: 1,
    benchmark: ROLE_FIELD_EVIDENCE_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    runtimeSourceHash: runtimeSourceHash || null,
    roleRunSchemaVersion: 4,
    fixtureOnly: false,
    status: sampleReady ? "measured" : "insufficient-data",
    sample: { totalRecords: records.length, eligibleLiveReadOnly: eligible.length, minimumRequired: minRuns, sampleReady, excluded: records.length - eligible.length, exclusions: byExclusion },
    cohort: { exact: exactCohort, key: keys.size === 1 ? [...keys][0] : null, distinctKeys: keys.size },
    metrics: { terminalCategories: categories, completionRate, timeoutRate, p95Ms, typedValidityRate, accountingParityRate },
    bars,
    gatePassed,
    maxEligibleStage: gatePassed ? "R4" : "R0",
    privacy: { aggregateOnly: true, containsTasks: false, containsPrompts: false, containsTranscripts: false, containsPaths: false, containsRunIds: false, containsSessionIds: false },
  };
}

module.exports = { ROLE_FIELD_EVIDENCE_VERSION, MIN_ELIGIBLE_LIVE_READ_ONLY_RUNS, COMPLETION_BAR, TIMEOUT_BAR, P95_BAR_MS, cohortKey, classifyRoleTerminal, determineRoleRunEligibility, summarizeRoleFieldEvidence };
