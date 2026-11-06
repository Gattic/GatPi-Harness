#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { DEFAULT_POLICY, normalizeMode, evaluateRefinementEvidence, refinementPolicy } = require("../src/prompt-suggestion-policy.js");

function event(action, outcome = "succeeded") { return { kind: "prompt-suggestion", extension: "prompt-suggestions", source: "model", action, outcome }; }

assert.equal(normalizeMode(undefined), "auto");
const defaultPolicy = refinementPolicy([], {});
assert.equal(defaultPolicy.automatic, false, "model prompt refinement retains non-timeout quality gates");
assert.equal(defaultPolicy.bootstrap, true, "a fresh cohort permits an attempt for each new idle state");
assert.equal(defaultPolicy.manual, true);
assert.equal(normalizeMode("false"), "off");
assert.equal(normalizeMode("1"), "on");
assert.equal("maxTimeoutRate" in DEFAULT_POLICY, false);
assert.equal("bootstrapIntervalMs" in DEFAULT_POLICY, false);

const baseline = [event("shown"), event("shown"), event("timed-out", "timed-out"), event("timed-out", "timed-out"), event("accepted")];
const baselineEvidence = evaluateRefinementEvidence(baseline);
assert.equal(baselineEvidence.attempts, 4);
assert.equal(baselineEvidence.scoredAttempts, 2);
assert.equal(baselineEvidence.acceptanceRate, 0.5);
assert.equal(baselineEvidence.timeoutRate, 0.5, "timeout telemetry remains observable, not an admission lock");
assert.equal(baselineEvidence.failureRate, 0);
assert.equal(baselineEvidence.sampleRemaining, 18);
assert.equal(refinementPolicy(baseline).automatic, false);
assert.equal(refinementPolicy(baseline).bootstrap, true);
assert.equal(refinementPolicy(baseline).manual, true);

const measured = [
  ...Array.from({ length: 19 }, () => event("refined")),
  event("timed-out", "timed-out"),
  event("failed", "infrastructure-failed"),
  ...Array.from({ length: 19 }, () => event("shown")),
  ...Array.from({ length: 4 }, () => event("accepted")),
];
const eligible = refinementPolicy(measured, { mode: "auto" });
assert.equal(eligible.automatic, true);
assert.equal(eligible.bootstrap, false);
assert.equal(eligible.reasonCode, "evidence-bar-met");
assert.equal(eligible.evidence.attempts, 21);
assert.equal(eligible.evidence.scoredAttempts, 20);
assert.equal(eligible.evidence.timeoutRate, 0.0476);
assert.equal(eligible.evidence.failureRate, 0.05);
assert.equal(eligible.evidence.acceptanceRate, 0.2105);

const now = Date.parse("2026-09-06T18:00:00.000Z");
const timeoutHistory = Array.from({ length: 100 }, () => ({ ...event("timed-out", "timed-out"), timestamp: new Date(now).toISOString() }));
timeoutHistory.push({ ...event("failed", "infrastructure-failed"), reasonCode: "timeout", timestamp: new Date(now).toISOString() });
const manyTimeouts = refinementPolicy(measured.concat(timeoutHistory));
assert.equal(manyTimeouts.automatic, true, "even repeated recent timeouts must not veto a passing quality cohort");
assert.equal(manyTimeouts.evidence.failureRate, eligible.evidence.failureRate, "timeouts cannot indirectly block via the failure-rate gate");
assert.equal(manyTimeouts.evidence.scoredAttempts, 20);
const timeoutOnly = refinementPolicy(timeoutHistory);
assert.equal(timeoutOnly.bootstrap, true, "timeout-only history cannot complete and lock a cohort");
assert.equal(timeoutOnly.evidence.sampleRemaining, 20);
for (const action of [event("refined"), event("failed", "infrastructure-failed"), event("skipped", "cancelled")]) {
  const policy = refinementPolicy([{ ...action, timestamp: new Date(now + 86400000).toISOString() }]);
  assert.equal(policy.bootstrap, true, "recent and future observations never impose a bootstrap cooldown");
  assert.equal(policy.reasonCode, "bootstrap-sample-due");
}

const poorReliability = refinementPolicy(measured.concat(Array.from({ length: 20 }, () => event("failed", "infrastructure-failed"))));
assert.equal(poorReliability.automatic, false);
assert.equal(poorReliability.bootstrap, false);
assert.equal(poorReliability.reasonCode, "failure-rate-too-high", "genuine non-timeout failures still gate quality");
assert.equal(refinementPolicy(measured.filter((row) => row.action !== "accepted")).reasonCode, "acceptance-value-too-low");
assert.equal(refinementPolicy([], { mode: "on" }).automatic, true);
const off = refinementPolicy(measured, { mode: "off" });
assert.deepEqual({ automatic: off.automatic, bootstrap: off.bootstrap, manual: off.manual }, { automatic: false, bootstrap: false, manual: false });

const legacyAndCurrent = [
  { ...event("shown"), source: "hermes", schemaVersion: 1, timestamp: "2026-07-28T00:00:00.000Z" },
  { ...event("refined"), schemaVersion: 4, timestamp: "2026-07-29T00:00:00.000Z" },
];
assert.equal(evaluateRefinementEvidence(legacyAndCurrent).successes, 2, "historical Hermes refinement evidence remains compatible with the model cohort");
const unrelated = [{ kind: "prompt-suggestion", extension: "other", source: "model", action: "refined", outcome: "succeeded" }, { kind: "command", extension: "prompt-suggestions", source: "model", action: "refined", outcome: "succeeded" }];
assert.equal(evaluateRefinementEvidence(unrelated).attempts, 0);

console.log("prompt suggestion policy checks passed");
