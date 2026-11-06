"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  processGroupAlive,
  processGroupRss,
  ownProcessGroup,
  terminateOwnedProcessGroup,
} = require("../src/resource-guard.js");
const { startJob, jobStatus, stopJob } = require("../src/bg-jobs.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 8_000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for resource-guard fixture");
    await delay(intervalMs);
  }
}

(async () => {
  const tmp = tmpFixture("pi-resource-guard-");

  // RSS is aggregated across the owned process group, including descendants.
  const treeScript = path.join(tmp, "rss-tree.js");
  fs.writeFileSync(treeScript, `
const { spawn } = require("node:child_process");
for (let i = 0; i < 2; i += 1) spawn(process.execPath, ["-e", "Buffer.alloc(24 * 1024 * 1024, 1); setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  const tree = spawn(process.execPath, [treeScript], { detached: true, stdio: "ignore" });
  tree.unref();
  await waitFor(() => processGroupRss(tree.pid).members >= 3);
  const aggregate = processGroupRss(tree.pid);
  assert.ok(aggregate.rssBytes >= 60 * 1024 * 1024, `expected descendant RSS aggregation, got ${JSON.stringify(aggregate)}`);
  const termination = await terminateOwnedProcessGroup(ownProcessGroup(tree), { graceMs: 60, pollMs: 10 });
  assert.equal(termination.termSent, true);
  assert.equal(termination.killSent, true, "SIGTERM-resistant owned groups escalate to SIGKILL");
  await waitFor(() => !processGroupAlive(tree.pid));

  // Independent detached jobs start concurrently; the guard only supervises
  // each owned process group's RSS and termination lifecycle.
  const jobCwd = path.join(tmp, "jobs");
  fs.mkdirSync(jobCwd);
  const ordering = path.join(tmp, "ordering.log");
  const guard = { rssLimitMb: 512, rssPollMs: 20, termGraceMs: 60 };
  const firstJob = startJob(jobCwd, `echo first-start >> "${ordering}"; sleep 0.4; echo first-end >> "${ordering}"`, { resourceGuard: guard });
  await waitFor(() => fs.existsSync(ordering) && fs.readFileSync(ordering, "utf8").includes("first-start"));
  const secondJob = startJob(jobCwd, `echo second-start >> "${ordering}"`, { resourceGuard: guard });
  await waitFor(() => fs.readFileSync(ordering, "utf8").includes("second-start"));
  assert.deepEqual(fs.readFileSync(ordering, "utf8").trim().split("\n").slice(0, 2), ["first-start", "second-start"], "a running job does not block another launch");
  await waitFor(() => jobStatus(jobCwd, secondJob.jobId).status === "exited");
  await waitFor(() => jobStatus(jobCwd, firstJob.jobId).status === "exited");
  assert.equal(jobStatus(jobCwd, firstJob.jobId).exitCode, 0);

  // RSS runaway handling and explicit stop both target only the supervisor's
  // owned command group, with TERM before bounded KILL escalation.
  const runaway = startJob(jobCwd, "trap '' TERM; while :; do sleep 1; done", {
    name: "rss runaway",
    resourceGuard: { ...guard, stateDir: path.join(tmp, "runaway-slots"), rssLimitMb: 1 },
  });
  await waitFor(() => jobStatus(jobCwd, runaway.jobId).status === "resource-killed");
  const runawayStatus = jobStatus(jobCwd, runaway.jobId);
  assert.equal(runawayStatus.resourceGuard.terminationReason, "rss-limit");
  assert.deepEqual(runawayStatus.resourceGuard.signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(runawayStatus.resourceGuard.peakRssBytes > runawayStatus.resourceGuard.rssLimitBytes);

  const stopped = startJob(jobCwd, "trap '' TERM; while :; do sleep 1; done", {
    name: "explicit stop",
    resourceGuard: { ...guard, stateDir: path.join(tmp, "stop-slots") },
  });
  await waitFor(() => jobStatus(jobCwd, stopped.jobId).resourceGuard?.phase === "running");
  assert.equal(stopJob(jobCwd, stopped.jobId).stopped, true);
  await waitFor(() => jobStatus(jobCwd, stopped.jobId).status === "killed");
  assert.deepEqual(jobStatus(jobCwd, stopped.jobId).resourceGuard.signals, ["SIGTERM", "SIGKILL"]);

  console.log("resource guard tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
