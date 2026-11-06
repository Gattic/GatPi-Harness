#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const {
  classifyRoleTerminal,
  determineRoleRunEligibility,
  summarizeRoleFieldEvidence,
} = require("../src/role-field-evidence.js");

const runtimeSourceHash = "a".repeat(64);
function row(index, overrides = {}) {
  return {
    schemaVersion: 4,
    roleRunSchemaVersion: 4,
    roleRuntimeVersion: 2,
    contractVersion: "role-v2",
    resultSchemaVersion: 2,
    runtimeSourceHash,
    source: "subagent-tool",
    status: "succeeded",
    terminalCategory: "succeeded",
    termination: { code: "submitted" },
    typedResultValid: true,
    accountingValid: true,
    mutationMode: "shared-readonly",
    fixture: false,
    totalDurationMs: 1000 + index,
    subagentId: `PRIVATE_RUN_ID_${index}`,
    parentSessionId: `PRIVATE_SESSION_ID_${index}`,
    ...overrides,
  };
}

assert.equal(classifyRoleTerminal({ status: "succeeded", termination: { code: "invalid_result" }, typedResultValid: false }), "infrastructure-failed");
assert.equal(classifyRoleTerminal({ status: "timed_out", termination: { code: "wall_clock" } }), "timed-out");
assert.deepEqual(determineRoleRunEligibility(row(1, { status: "cancelled", terminalCategory: "cancelled" })), { eligible: false, reason: "operator-cancelled" });
assert.deepEqual(determineRoleRunEligibility(row(1, { fixture: true })), { eligible: false, reason: "deterministic-fixture" });
assert.deepEqual(determineRoleRunEligibility(row(1, { mutationMode: "isolated" })), { eligible: false, reason: "not-read-only" });

const passing = Array.from({ length: 30 }, (_, index) => row(index));
passing[28] = row(28, { status: "failed", terminalCategory: "infrastructure-failed", termination: { code: "provider_error" } });
passing[29] = row(29, { status: "timed_out", terminalCategory: "timed-out", termination: { code: "wall_clock" } });
passing.push(row(30, { status: "cancelled", terminalCategory: "cancelled", termination: { code: "operator_cancelled" } }));
passing.push(row(31, { fixture: true, source: "deterministic-fixture" }));
const report = summarizeRoleFieldEvidence(passing, { runtimeSourceHash, generatedAt: "2026-07-26T00:00:00.000Z" });
assert.equal(report.status, "measured");
assert.equal(report.sample.totalRecords, 32);
assert.equal(report.sample.eligibleLiveReadOnly, 30);
assert.equal(report.sample.exclusions["operator-cancelled"], 1);
assert.equal(report.sample.exclusions["deterministic-fixture"], 1);
assert.equal(report.metrics.terminalCategories.succeeded, 28);
assert.equal(report.metrics.terminalCategories["infrastructure-failed"], 1, "genuine provider failure remains in the denominator");
assert.equal(report.metrics.terminalCategories["timed-out"], 1, "genuine timeout remains in the denominator");
assert.equal(report.metrics.completionRate, 0.9333);
assert.equal(report.metrics.timeoutRate, 0.0333);
assert.equal(report.metrics.typedValidityRate, 1);
assert.equal(report.metrics.accountingParityRate, 1);
assert.equal(report.gatePassed, true);
assert.equal(report.maxEligibleStage, "R4");
for (const secret of ["PRIVATE_RUN_ID", "PRIVATE_SESSION_ID"]) assert(!JSON.stringify(report).includes(secret), "aggregate field report omits run/session identifiers");

const short = summarizeRoleFieldEvidence(passing.slice(0, 29), { runtimeSourceHash });
assert.equal(short.status, "insufficient-data");
assert.equal(short.gatePassed, false);
assert.equal(short.bars.completion.passed, null);

const invalid = Array.from({ length: 30 }, (_, index) => row(index));
invalid[0] = row(0, { status: "succeeded", terminalCategory: "infrastructure-failed", typedResultValid: false, termination: { code: "invalid_result" } });
const failedValidity = summarizeRoleFieldEvidence(invalid, { runtimeSourceHash });
assert.equal(failedValidity.sample.eligibleLiveReadOnly, 30, "malformed live output is not hidden from the denominator");
assert.equal(failedValidity.bars.typedValidity.passed, false);
assert.equal(failedValidity.gatePassed, false);

console.log("role field evidence tests passed");
