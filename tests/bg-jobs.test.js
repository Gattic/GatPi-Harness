"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { startJob, jobStatus, jobLogs, stopJob, listJobs } = require("../src/bg-jobs.js");
const { managedProcessMetrics, compareManagedProcessMetrics } = require("../src/managed-process-metrics.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-bg-jobs-");

function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - startedAt > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timeout")); }
    }, intervalMs);
  });
}

(async () => {
  // A quick job runs detached, captures output, and records its exit code.
  const ok = startJob(cwd, "echo hello-bg && echo err-line >&2", { name: "hello" });
  assert.ok(ok.jobId);
  assert.equal(ok.name, "hello");
  await waitFor(() => jobStatus(cwd, ok.jobId).status === "exited");
  const done = jobStatus(cwd, ok.jobId);
  assert.equal(done.exitCode, 0);
  assert.match(jobStatus(cwd, ok.jobId, { recordInteraction: true }).status, /exited/);
  assert.match(jobLogs(cwd, ok.jobId, { recordInteraction: true }).text, /hello-bg/);
  assert.match(jobLogs(cwd, ok.jobId, { recordInteraction: true }).text, /err-line/);

  // Failing job records its nonzero exit code.
  const bad = startJob(cwd, "exit 7");
  await waitFor(() => jobStatus(cwd, bad.jobId).status === "exited");
  assert.equal(jobStatus(cwd, bad.jobId).exitCode, 7);

  // A long-running job reports running, then stopJob kills it.
  const long = startJob(cwd, "sleep 60", { name: "sleeper" });
  await waitFor(() => jobStatus(cwd, long.jobId).status === "running");
  const stopped = stopJob(cwd, long.jobId);
  assert.equal(stopped.stopped, true);
  await waitFor(() => ["killed", "exited"].includes(jobStatus(cwd, long.jobId).status));

  // listJobs shows all three with statuses.
  const all = listJobs(cwd);
  assert.equal(all.length, 3);
  assert.ok(all.every((job) => job.jobId && job.status));
  const metrics = managedProcessMetrics(cwd).byKind.bg_run;
  assert.equal(metrics.starts, 3);
  assert.equal(metrics.statusCalls, 1);
  assert.equal(metrics.logCalls, 2);
  assert.equal(metrics.pollingTriples, 1, "three manual point-in-time calls form one privacy-safe polling triple");
  assert.equal(metrics.finalEvidence, 3, "every settled fixture has terminal evidence exactly once");
  assert.equal(metrics.eligibleForFourteenDayDecision, false);
  assert.equal(compareManagedProcessMetrics(managedProcessMetrics(cwd), managedProcessMetrics(cwd)).status, "insufficient-data", "a short fixture never fabricates the 14-day reduction gate");
  const jobState = path.join(cwd, ".pi", "jobs", `${ok.jobId}.json`);
  assert.equal(fs.statSync(path.dirname(jobState)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(jobState).mode & 0o777, 0o600);

  // Unknown job errors clearly.
  assert.throws(() => jobStatus(cwd, "nope"), /not found/i);

  console.log("bg-jobs tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
