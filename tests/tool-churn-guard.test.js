"use strict";

const assert = require("node:assert/strict");
const { createToolChurnGuard, fingerprint } = require("../src/tool-churn-guard.js");

function call(guard, id, toolName, input) {
  const recommendation = guard.observeCall({ toolCallId: id, toolName, input });
  return { recommendation, result: (event = {}) => guard.observeResult({ toolCallId: id, toolName, ...event }) };
}

assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }), "ephemeral fingerprints are deterministic without preserving bodies");
const guard = createToolChurnGuard({ thresholds: { processPoll: 3, gitCheck: 3, roadmapMutation: 3, policyApproval: 2, identicalFailure: 2 } });

let warning = null;
for (let index = 1; index <= 3; index++) {
  const observed = call(guard, `poll-${index}`, "bg_run", { operation: "status", jobId: "job-private" });
  warning = observed.result();
}
assert.equal(warning.reason, "repeated-process-poll");
assert.equal(warning.count, 3);
assert(!JSON.stringify(warning).includes("job-private"), "recommendations contain no target identifiers");
const fourth = call(guard, "poll-4", "bg_run", { operation: "status", jobId: "job-private" });
assert.equal(fourth.result(), null, "one recommendation is emitted per repeated call pattern");

for (let index = 1; index <= 2; index++) {
  const checked = call(guard, `git-${index}`, "gitevidence", {});
  assert.equal(checked.result(), null);
}
const thirdGit = call(guard, "git-3", "gitevidence", {});
assert.equal(thirdGit.result().reason, "repeated-git-check");
const edit = call(guard, "edit-1", "edit", { path: "private.js", edits: [] });
assert.equal(edit.result(), null);
for (let index = 1; index <= 2; index++) assert.equal(call(guard, `git-new-${index}`, "gitevidence", {}).result(), null, "successful mutation starts a new Git-check epoch");
for (let index = 1; index <= 2; index++) assert.equal(call(guard, `bash-git-${index}`, "bash", { command: "git status --short" }).result(), null);
assert.equal(call(guard, "bash-git-3", "bash", { command: "git status --short" }).result().reason, "repeated-git-check", "read-only Git shell calls do not masquerade as mutations");

let failedRetry = call(guard, "failure-1", "test_runner", { operation: "run", commandId: "stale-private-id" });
assert.equal(failedRetry.result({ isError: true }), null);
failedRetry = call(guard, "failure-2", "test_runner", { operation: "run", commandId: "stale-private-id" });
const failureWarning = failedRetry.result({ isError: true });
assert.equal(failureWarning.reason, "identical-failed-retry");
assert(!JSON.stringify(failureWarning).includes("stale-private-id"));

for (let index = 1; index <= 3; index++) warning = call(guard, `roadmap-${index}`, "roadmap_update", { action: "set_status", itemId: String(index) }).result();
assert.equal(warning.reason, "roadmap-status-churn");
for (let index = 1; index <= 2; index++) warning = call(guard, `policy-${index}`, "policy_enforcer", { operation: "request", input: { key: index } }).result();
assert.equal(warning.reason, "repeated-policy-approval");

const status = guard.status();
assert.equal(status.privacy.argumentsPersisted, false);
assert.equal(status.privacy.resultBodiesPersisted, false);
assert(status.recommendations >= 5);
guard.reset();
assert.equal(guard.status().recommendations, 0);
console.log("tool churn guard tests passed");
