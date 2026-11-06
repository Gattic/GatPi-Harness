"use strict";

// Session mining (2026-07): 35 builds/month were killed by the 2-minute
// default timeout and immediately re-run by hand. Long commands (builds,
// full suites, dev servers) belong in detached background jobs with a job
// table, streamed logs, and explicit stop - in any repo.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { emptyUsage, writePrivateJson, recordManagedProcessEvent } = require("./managed-process-metrics.js");
const { processIdentity } = require("./resource-guard.js");

const STATE_DIR = ".pi/jobs";
const SUPERVISOR = path.join(__dirname, "managed-job-supervisor.js");
const MAX_LOG_TAIL = 8000;

function jobsDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

function jobFile(cwd, jobId) {
  return path.join(jobsDir(cwd), `${jobId}.json`);
}

function readJob(cwd, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(cwd, jobId), "utf8"));
  } catch {
    return null;
  }
}

function writeJob(cwd, job) {
  writePrivateJson(jobFile(cwd, job.jobId), job);
  return job;
}

function startJob(cwd, command, options = {}) {
  if (!String(command || "").trim()) throw new Error("startJob requires a command");
  const jobId = `job-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  fs.mkdirSync(jobsDir(cwd), { recursive: true, mode: 0o700 });
  const logFile = path.join(jobsDir(cwd), `${jobId}.log`);
  const exitFile = path.join(jobsDir(cwd), `${jobId}.exit`);
  const guardFile = path.join(jobsDir(cwd), `${jobId}.guard.json`);
  const launchFile = path.join(jobsDir(cwd), `${jobId}.launch.json`);
  // The small detached supervisor owns the command process group for its full
  // lifetime, monitors descendant RSS, and writes terminal evidence after
  // TERM/KILL escalation even after this Pi turn exits.
  writePrivateJson(launchFile, {
    schemaVersion: 1,
    jobId,
    cwd,
    command,
    logFile,
    exitFile,
    guardFile,
    resourceGuard: options.resourceGuard || {},
  });
  const child = spawn(process.execPath, [SUPERVISOR, launchFile], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const supervisorIdentity = processIdentity(child.pid);
  const job = writeJob(cwd, {
    jobId,
    name: options.name || command.slice(0, 60),
    command,
    pid: child.pid,
    supervisorPid: child.pid,
    ownership: { kind: "managed-job-supervisor", pid: child.pid, startTime: supervisorIdentity?.startTime || null },
    startedAt: new Date().toISOString(),
    managedUsage: { ...emptyUsage({ eligible: options.metricsEligible !== false }), starts: 1 },
  });
  // A failed spawn (e.g. EAGAIN under fork pressure) otherwise surfaces as an
  // unhandled 'error' event and an indistinguishable "orphaned" job.
  child.on("error", (error) => {
    try { writeJob(cwd, { ...(readJob(cwd, jobId) || job), spawnError: String(error?.message || error) }); } catch { /* best effort */ }
  });
  return job;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requireJob(cwd, jobId) {
  const job = readJob(cwd, String(jobId || "").trim());
  if (!job) throw new Error(`job not found: ${jobId}. Use listJobs/bg-status to see ids.`);
  return job;
}

function jobStatus(cwd, jobId, options = {}) {
  let job = requireJob(cwd, jobId);
  if (options.recordInteraction === true) job = recordManagedProcessEvent(cwd, "bg_run", job.jobId, "status");
  const exitFile = path.join(jobsDir(cwd), `${job.jobId}.exit`);
  const guardFile = path.join(jobsDir(cwd), `${job.jobId}.guard.json`);
  let resourceGuard = null;
  try { resourceGuard = JSON.parse(fs.readFileSync(guardFile, "utf8")); } catch {}
  let status = resourceGuard?.phase === "queued" || resourceGuard?.phase === "starting" ? "queued" : "running";
  let exitCode = null;
  if (fs.existsSync(exitFile)) {
    exitCode = Number(String(fs.readFileSync(exitFile, "utf8")).trim());
    status = resourceGuard?.terminationReason === "rss-limit" ? "resource-killed" : job.killedAt ? "killed" : "exited";
  } else if (job.spawnError) {
    status = "spawn-failed";
  } else if (!pidAlive(job.pid) || (job.ownership?.startTime && processIdentity(job.pid)?.startTime !== job.ownership.startTime)) {
    status = job.killedAt ? "killed" : "orphaned";
  }
  const orphanStable = status === "orphaned" && Date.now() - Date.parse(job.startedAt || 0) >= 5_000;
  if (["exited", "killed", "resource-killed", "spawn-failed"].includes(status) || orphanStable) {
    const category = status === "killed" ? "cancelled" : status === "exited" ? (exitCode === 0 ? "succeeded" : "domain-negative") : "infrastructure-failed";
    job = recordManagedProcessEvent(cwd, "bg_run", job.jobId, "final-evidence", { category });
  }
  return { ...job, resourceGuard, status, exitCode };
}

function jobLogs(cwd, jobId, options = {}) {
  let job = requireJob(cwd, jobId);
  if (options.recordInteraction === true) job = recordManagedProcessEvent(cwd, "bg_run", job.jobId, "logs");
  const logFile = path.join(jobsDir(cwd), `${job.jobId}.log`);
  let text = "";
  try {
    text = fs.readFileSync(logFile, "utf8");
  } catch {}
  const max = Number(options.maxChars) > 0 ? Number(options.maxChars) : MAX_LOG_TAIL;
  if (text.length > max) text = `[...earlier output truncated...]\n${text.slice(-max)}`;
  return { jobId: job.jobId, logFile, text };
}

function stopJob(cwd, jobId) {
  const job = requireJob(cwd, jobId);
  if (job.ownership?.kind !== "managed-job-supervisor" || Number(job.ownership.pid) !== Number(job.supervisorPid) || !job.ownership.startTime) {
    throw new Error(`job ${job.jobId} has no harness-owned supervisor`);
  }
  let stopped = false;
  const currentIdentity = processIdentity(job.supervisorPid);
  if (currentIdentity?.startTime === job.ownership.startTime) {
    try {
      // Signal only the recorded harness-owned supervisor. It forwards SIGTERM
      // to its owned command group and escalates to SIGKILL after the configured
      // grace period; unrelated system processes are never targeted.
      process.kill(job.supervisorPid, "SIGTERM");
      stopped = true;
    } catch {}
  }
  writeJob(cwd, { ...job, ...(stopped ? { killedAt: new Date().toISOString() } : {}) });
  return { jobId: job.jobId, stopped };
}

function listJobs(cwd) {
  let names = [];
  try {
    names = fs.readdirSync(jobsDir(cwd)).filter((name) => name.endsWith(".json") && !name.endsWith(".guard.json") && !name.endsWith(".launch.json"));
  } catch {
    return [];
  }
  return names
    .map((name) => jobStatus(cwd, name.replace(/\.json$/, "")))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function formatJobs(jobs) {
  if (!jobs.length) return "No background jobs";
  return jobs
    .map((job) => `${job.jobId} [${job.status}${job.exitCode != null ? ` exit=${job.exitCode}` : ""}] ${job.name} (started ${job.startedAt})`)
    .join("\n");
}

module.exports = { startJob, jobStatus, jobLogs, stopJob, listJobs, formatJobs, STATE_DIR };
