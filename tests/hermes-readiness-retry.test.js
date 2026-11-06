#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readiness = require("../src/hermes-readiness.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-hermes-readiness-retry-");
const bin = path.join(tmp, "hermes");
fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(0);\n");
fs.chmodSync(bin, 0o755);

const options = {
  bin,
  provider: "retry-provider",
  model: "retry-model",
  policy: { failureBackoffMs: 5000 },
};
const projectA = path.join(tmp, "project-a");
const projectB = path.join(tmp, "project-b");
const projectC = path.join(tmp, "project-c");
const startedAt = Date.now();
assert.equal(readiness.policyFromEnv({}).failureBackoffMs, 60_000, "the default repeated-failure cooldown is one minute rather than fifteen minutes");

function freshProcess(action, cwd, now) {
  const script = `
    const readiness = require(process.argv[1]);
    const cwd = process.argv[2];
    const options = {
      bin: process.argv[3],
      provider: "retry-provider",
      model: "retry-model",
      policy: { failureBackoffMs: 5000 },
    };
    const action = process.argv[4];
    const now = Number(process.argv[5]);
    if (action === "timeout") readiness.recordOutcome(cwd, { ...options, at: new Date(now) }, { operation: "prompt", outcome: "timed-out", category: "timeout", durationMs: 10000 });
    if (action === "success") readiness.recordOutcome(cwd, { ...options, at: new Date(now) }, { operation: "prompt", outcome: "succeeded", category: "ready", durationMs: 100 });
    process.stdout.write(JSON.stringify(readiness.shouldAttempt(cwd, { ...options, now })));
  `;
  return JSON.parse(execFileSync(process.execPath, ["-e", script, path.resolve(__dirname, "../src/hermes-readiness.js"), cwd, bin, action, String(now)], { encoding: "utf8" }));
}

readiness.recordOutcome(projectA, { ...options, at: new Date(startedAt) }, {
  operation: "prompt",
  outcome: "timed-out",
  category: "timeout",
  durationMs: 10000,
});
const firstRetry = readiness.shouldAttempt(projectA, { ...options, now: startedAt + 1 });
assert.equal(firstRetry.allowed, true, "one prompt timeout must allow an immediate retry");
assert.equal(firstRetry.backoffActive, false);
assert.equal(firstRetry.retryAfter, null);

const identity = readiness.identityFor(options);
const persistedAfterFirstTimeout = readiness.readState(projectA).identities[identity.identityKey];
assert.equal(persistedAfterFirstTimeout.retryAfter ?? null, null, "one prompt timeout must not persist a retry deadline");
assert.equal(readiness.shouldAttempt(projectB, { ...options, now: startedAt + 1 }).allowed, true, "one project's timeout must not gate another project");

const restartedRetry = freshProcess("status", projectA, startedAt + 1000);
assert.equal(restartedRetry.allowed, true, "a fresh Pi process must be able to retry after one timeout");
assert.equal(restartedRetry.policyVersion, "hermes-readiness-v4");
const restartedSuccess = freshProcess("success", projectA, startedAt + 1100);
assert.equal(restartedSuccess.allowed, true, "a retry after restart should clear the timeout streak when it succeeds");
assert.equal(freshProcess("status", projectB, startedAt + 1100).allowed, true, "the independent project remains eligible across the other project's restart");

readiness.recordOutcome(projectC, { ...options, at: new Date(startedAt + 2000) }, {
  operation: "prompt",
  outcome: "timed-out",
  category: "timeout",
  durationMs: 10000,
});
assert.equal(freshProcess("timeout", projectC, startedAt + 2100).allowed, false, "a second consecutive prompt timeout should activate the configured backoff");
assert.equal(freshProcess("status", projectC, startedAt + 2200).reason, "backoff-active", "the repeated-timeout backoff must persist across Pi restarts");
assert.equal(freshProcess("status", projectB, startedAt + 2200).allowed, true, "one project's repeated timeout must never gate another project");

console.log("Hermes readiness cross-project restart retry checks passed");
