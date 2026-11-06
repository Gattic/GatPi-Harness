"use strict";

const assert = require("node:assert/strict");
const {
  CANONICAL_OUTCOMES,
  normalizeOutcome,
  normalizeLoopOutcome,
  normalizeGoalOutcome,
  inferOutcome,
  isCanonicalOutcome,
  isReliabilityFailureOutcome,
  isNegativeOutcome,
} = require("../src/outcome-schema");

assert.deepEqual(CANONICAL_OUTCOMES, [
  "succeeded", "domain-negative", "blocked", "not-applicable", "cancelled", "timed-out", "infrastructure-failed", "unknown",
]);
for (const value of CANONICAL_OUTCOMES) assert.equal(isCanonicalOutcome(value), true);
assert.equal(normalizeOutcome("max_iterations"), "timed-out");
assert.equal(normalizeOutcome("max-iterations"), "timed-out");
assert.equal(normalizeOutcome("policy_blocked"), "blocked");
assert.equal(normalizeOutcome("not_applicable"), "not-applicable");

assert.equal(normalizeLoopOutcome("completed"), "succeeded");
assert.equal(normalizeLoopOutcome("max_iterations"), "timed-out");
assert.equal(normalizeLoopOutcome("paused"), "blocked");
assert.equal(normalizeLoopOutcome("cancelled"), "cancelled");
assert.equal(normalizeLoopOutcome("failed", { outcome: "failed" }), "domain-negative");
assert.equal(normalizeLoopOutcome("failed", { providerFailure: true }), "infrastructure-failed");
assert.equal(normalizeLoopOutcome("paused", { providerFailure: true }), "infrastructure-failed");

assert.equal(normalizeGoalOutcome("completed"), "succeeded");
assert.equal(normalizeGoalOutcome("blocked"), "blocked");
assert.equal(normalizeGoalOutcome("untouched"), "not-applicable");
assert.equal(normalizeGoalOutcome("failed", { outcome: "failed" }), "domain-negative");
assert.equal(normalizeGoalOutcome("failed", { errorCategory: "provider" }), "infrastructure-failed");
assert.equal(normalizeGoalOutcome("blocked", { providerFailure: true }), "infrastructure-failed");

assert.equal(inferOutcome({ ok: false, findings: 1 }, { toolName: "semgrep_scan" }), "domain-negative");
assert.equal(inferOutcome({ ok: false, reason: "adapter-crash" }, { isError: true }), "infrastructure-failed");
assert.equal(isReliabilityFailureOutcome("domain-negative"), false);
assert.equal(isReliabilityFailureOutcome("timed-out"), true);
assert.equal(isNegativeOutcome("blocked"), true);

console.log("outcome-schema tests passed");
