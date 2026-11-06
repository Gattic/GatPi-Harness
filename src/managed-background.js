"use strict";

// Repository-local view of Pi-managed detached work. Automation loops use a
// per-iteration baseline so unrelated long-lived jobs do not block progress;
// only work that became active during the current iteration is awaited.

const { jobStatus, listJobs } = require("./bg-jobs.js");
const { runStatus, listRuns } = require("./run-deck.js");

const DEFAULT_POLL_MS = 2000;

function activeRun(status) {
  if (!status?.run) return false;
  // Process evidence wins over a stale manually assigned deck status. For an
  // attached run with no pid/pattern, `running` remains active until finish.
  return status.alive === true || (status.run.status === "running" && status.alive !== false);
}

function snapshotManagedWork(cwd) {
  const jobs = [];
  for (const job of listJobs(cwd)) {
    if (["queued", "running"].includes(job.status)) jobs.push({ id: job.jobId });
  }

  const runs = [];
  for (const registered of listRuns(cwd)) {
    let status;
    try { status = runStatus(cwd, registered.runId, { gpu: false }); }
    catch { continue; }
    if (activeRun(status)) runs.push({ id: status.run.runId, jobId: status.run.jobId || null });
  }

  return {
    capturedAt: new Date().toISOString(),
    jobs: jobs.sort((a, b) => a.id.localeCompare(b.id)),
    runs: runs.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function managedWorkDependencies(baseline, current) {
  if (!baseline || !current) return [];
  const priorJobs = new Set((baseline.jobs || []).map((item) => item.id));
  const priorRuns = new Set((baseline.runs || []).map((item) => item.id));
  const runs = (current.runs || [])
    .filter((item) => item?.id && !priorRuns.has(item.id))
    .map((item) => ({ kind: "run_deck", id: item.id, jobId: item.jobId || null }));
  const runJobIds = new Set(runs.map((item) => item.jobId).filter(Boolean));
  const jobs = (current.jobs || [])
    .filter((item) => item?.id && !priorJobs.has(item.id) && !runJobIds.has(item.id))
    .map((item) => ({ kind: "bg_run", id: item.id }));
  return [...runs, ...jobs].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

function jobIsRunning(cwd, jobId) {
  if (!jobId) return false;
  try { return ["queued", "running"].includes(jobStatus(cwd, jobId).status); }
  catch { return false; }
}

function dependencyIsRunning(cwd, dependency) {
  if (dependency.kind === "bg_run") return jobIsRunning(cwd, dependency.id);
  if (dependency.kind !== "run_deck") return false;
  let runActive = false;
  try { runActive = activeRun(runStatus(cwd, dependency.id, { gpu: false })); }
  catch { runActive = false; }
  // run_deck launch owns a bg_run job. Continue waiting if the process is
  // alive even when the deck was prematurely marked finished.
  return runActive || jobIsRunning(cwd, dependency.jobId);
}

function pendingManagedWork(cwd, dependencies = []) {
  return dependencies.filter((dependency) => dependencyIsRunning(cwd, dependency));
}

async function waitForManagedWork(cwd, dependencies = [], options = {}) {
  const pollMs = Math.max(10, Number(options.pollMs) || DEFAULT_POLL_MS);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();
  for (;;) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { outcome: "cancelled", pending: [], waitedMs: Date.now() - startedAt };
    }
    const pending = pendingManagedWork(cwd, dependencies);
    if (!pending.length) return { outcome: "settled", pending, waitedMs: Date.now() - startedAt };
    if (options.onPoll) options.onPoll(pending);
    await sleep(pollMs);
  }
}

function formatManagedWork(dependencies = []) {
  return dependencies.map((item) => `${item.kind}:${item.id}`).join(", ");
}

module.exports = {
  DEFAULT_POLL_MS,
  snapshotManagedWork,
  managedWorkDependencies,
  pendingManagedWork,
  waitForManagedWork,
  formatManagedWork,
};
