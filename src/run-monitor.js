"use strict";

// Session-scoped, edge-triggered monitoring for Pi-managed long-running work.
// This layer polls bg_run/run_deck state while the owning Pi session is alive
// and reaches a terminal state only when a target contains requested literal
// log text, settles, times out, or errors. It never starts agent turns; the
// extension and scripts/run-monitor-check.js perform checks without model calls.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { jobStatus, STATE_DIR: JOB_STATE_DIR } = require("./bg-jobs.js");
const { runStatus } = require("./run-deck.js");
const { recordManagedProcessEvent } = require("./managed-process-metrics.js");

const STATE_DIR = ".pi/run-monitor";
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PATTERN_CHARS = 500;
const LOG_TAIL_CHARS = 32 * 1_024;
const TARGET_KINDS = new Set(["bg_run", "run_deck"]);
const MONITOR_STATUSES = new Set(["active", "matched", "settled", "timed_out", "stopped", "error"]);

function classifyMonitorIntent(text) {
  const value = String(text || "").toLowerCase();
  const observationIntent = /\b(?:monitor|watch|notify|notification|alert|periodically|keep\s+an?\s+eye)\b/.test(value);
  const managedTarget = /\b(?:bg[_ -]?run|run[_ -]?deck|job-[a-z0-9-]+|run-[a-z0-9-]+|long[- ]running|process|training|build|test|download|server|generation)\b/.test(value);
  return {
    eligible: observationIntent && managedTarget,
    reason: observationIntent ? (managedTarget ? "managed-target-observation" : "missing-managed-target") : "no-observation-intent",
  };
}

function stateDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

function validateMonitorId(monitorId) {
  const value = String(monitorId || "").trim();
  if (!/^monitor-[a-z0-9-]+$/.test(value)) throw new Error(`invalid monitor id: ${monitorId}`);
  return value;
}

function validateTarget(kind, targetId) {
  if (!TARGET_KINDS.has(kind)) throw new Error(`unsupported monitor target kind: ${kind}. Use bg_run or run_deck.`);
  const value = String(targetId || "").trim();
  const expected = kind === "bg_run" ? /^job-[a-z0-9-]+$/ : /^run-[a-z0-9-]+$/;
  if (!expected.test(value)) throw new Error(`invalid ${kind} target id: ${targetId}`);
  return value;
}

function monitorFile(cwd, monitorId) {
  return path.join(stateDir(cwd), `${validateMonitorId(monitorId)}.json`);
}

function readMonitor(cwd, monitorId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(monitorFile(cwd, monitorId), "utf8"));
    if (!MONITOR_STATUSES.has(parsed?.status)) return null;
    // Older records may still carry the removed wake claim. Strip it on read so
    // the next write migrates the record instead of preserving an inert field.
    if (parsed.wake !== undefined) delete parsed.wake;
    return parsed;
  } catch {
    return null;
  }
}

function writeMonitor(cwd, monitor) {
  validateMonitorId(monitor.monitorId);
  fs.mkdirSync(stateDir(cwd), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stateDir(cwd), 0o700); } catch {}
  const file = monitorFile(cwd, monitor.monitorId);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(2).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(monitor, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return monitor;
}

function normalizeOwnerSessionId(value) {
  return String(value || "").trim().slice(0, 200);
}

function requireMonitor(cwd, monitorId, options = {}) {
  const monitor = readMonitor(cwd, monitorId);
  if (!monitor) throw new Error(`monitor not found: ${monitorId}. Use run_monitor list or /monitors.`);
  if (options.ownerSessionId && monitor.ownerSessionId !== normalizeOwnerSessionId(options.ownerSessionId)) {
    throw new Error(`monitor ${monitor.monitorId} belongs to a different Pi session`);
  }
  return monitor;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function nowMs(options = {}) {
  const value = Number(options.now);
  return Number.isFinite(value) ? value : Date.now();
}

function readTail(file, maxChars = LOG_TAIL_CHARS) {
  if (!file) return "";
  try {
    const stat = fs.statSync(file);
    const bytes = Math.min(stat.size, maxChars);
    const buffer = Buffer.alloc(bytes);
    const descriptor = fs.openSync(file, "r");
    let bytesRead = 0;
    try { bytesRead = fs.readSync(descriptor, buffer, 0, bytes, Math.max(0, stat.size - bytes)); }
    finally { fs.closeSync(descriptor); }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  }
}

function activeRun(status) {
  if (!status?.run) return false;
  return status.alive === true || (status.run.status === "running" && status.alive !== false);
}

function targetSnapshot(cwd, monitor) {
  if (monitor.kind === "bg_run") {
    const status = jobStatus(cwd, monitor.targetId);
    const active = ["queued", "running"].includes(status.status);
    return {
      active,
      targetStatus: status.status,
      alive: active,
      exitCode: status.exitCode ?? null,
      logText: monitor.pattern ? readTail(path.join(cwd, JOB_STATE_DIR, `${monitor.targetId}.log`)) : "",
    };
  }

  const status = runStatus(cwd, monitor.targetId, { gpu: false });
  const vitals = { ...(status.vitals || {}) };
  delete vitals.lastLine;
  return {
    active: activeRun(status),
    targetStatus: status.run.status,
    alive: status.alive,
    exitCode: status.exitCode ?? null,
    vitals,
    logText: monitor.pattern ? readTail(status.logFile) : "",
  };
}

function lastCheck(snapshot, at, matched = false) {
  const result = {
    at,
    targetStatus: snapshot.targetStatus,
    alive: snapshot.alive,
    exitCode: snapshot.exitCode,
  };
  if (snapshot.vitals && Object.keys(snapshot.vitals).length) result.vitals = snapshot.vitals;
  if (matched) result.matched = true;
  return result;
}

function validatedPattern(pattern) {
  const value = String(pattern || "");
  if (!value) return null;
  if (value.length > MAX_PATTERN_CHARS) throw new Error(`monitor pattern exceeds ${MAX_PATTERN_CHARS} characters`);
  return value;
}

function checkMonitor(cwd, monitorId, options = {}) {
  const monitor = requireMonitor(cwd, monitorId, options);
  if (monitor.status !== "active") return monitor;

  const checkedAtMs = nowMs(options);
  const checkedAt = new Date(checkedAtMs).toISOString();
  monitor.checks = Number(monitor.checks || 0) + 1;
  monitor.lastCheckedAt = checkedAt;

  let snapshot;
  let pattern;
  try {
    snapshot = targetSnapshot(cwd, monitor);
    pattern = validatedPattern(monitor.pattern);
  } catch (error) {
    monitor.status = "error";
    monitor.finishedAt = checkedAt;
    monitor.reason = String(error?.message || error).slice(0, 500);
    return writeMonitor(cwd, monitor);
  }

  const matched = Boolean(pattern && String(snapshot.logText || "").includes(pattern));
  monitor.last = lastCheck(snapshot, checkedAt, matched);

  if (matched) {
    monitor.status = "matched";
    monitor.finishedAt = checkedAt;
    monitor.reason = `pattern matched: ${monitor.pattern}`;
  } else if (!snapshot.active) {
    monitor.status = "settled";
    monitor.finishedAt = checkedAt;
    monitor.reason = snapshot.exitCode == null
      ? `target is ${snapshot.targetStatus}`
      : `target is ${snapshot.targetStatus} (exit ${snapshot.exitCode})`;
  } else if (checkedAtMs - Date.parse(monitor.createdAt) >= monitor.timeoutMs) {
    monitor.status = "timed_out";
    monitor.finishedAt = checkedAt;
    monitor.reason = `observation deadline reached after ${monitor.timeoutMs}ms; target was still active`;
  }

  return writeMonitor(cwd, monitor);
}

function probeMonitor(cwd, monitorId, options = {}) {
  const monitor = requireMonitor(cwd, monitorId, options);
  // Never read the log tail here: probes report bounded status metadata only.
  const snapshot = targetSnapshot(cwd, { ...monitor, pattern: null });
  const probe = {
    active: snapshot.active,
    targetStatus: snapshot.targetStatus,
    alive: snapshot.alive,
    exitCode: snapshot.exitCode ?? null,
  };
  if (snapshot.vitals && Object.keys(snapshot.vitals).length) probe.vitals = snapshot.vitals;
  return {
    monitorId: monitor.monitorId,
    kind: monitor.kind,
    targetId: monitor.targetId,
    status: monitor.status,
    checks: Number(monitor.checks || 0),
    lastCheckedAt: monitor.lastCheckedAt,
    reason: monitor.reason,
    scriptCheck: monitor.scriptCheck || null,
    probe,
  };
}

// Persist the fresh target evidence produced by the check script so a later
// status read can distinguish the terminal sample from the script probe.
function recordMonitorProbe(cwd, monitorId, probe, options = {}) {
  const monitor = requireMonitor(cwd, monitorId, options);
  const scriptCheck = {
    at: new Date(nowMs(options)).toISOString(),
    targetStatus: probe.targetStatus,
    alive: probe.alive,
    exitCode: probe.exitCode ?? null,
  };
  if (probe.vitals && Object.keys(probe.vitals).length) scriptCheck.vitals = probe.vitals;
  monitor.scriptCheck = scriptCheck;
  return writeMonitor(cwd, monitor);
}

function createMonitor(cwd, options = {}) {
  const kind = String(options.kind || "").trim();
  const targetId = validateTarget(kind, options.targetId);
  const ownerSessionId = normalizeOwnerSessionId(options.ownerSessionId);
  if (!ownerSessionId) throw new Error("run monitor requires an owning Pi session id");
  const pattern = String(options.pattern || "").trim() || null;
  validatedPattern(pattern);
  const createdAtMs = nowMs(options);
  const monitor = {
    monitorId: `monitor-${createdAtMs.toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
    ownerSessionId: ownerSessionId.slice(0, 200),
    kind,
    targetId,
    pattern,
    intervalMs: boundedNumber(options.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    timeoutMs: boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_INTERVAL_MS, MAX_TIMEOUT_MS),
    status: "active",
    createdAt: new Date(createdAtMs).toISOString(),
    checks: 0,
    lastCheckedAt: null,
    last: null,
    reason: null,
  };
  writeMonitor(cwd, monitor);
  try { recordManagedProcessEvent(cwd, kind, targetId, "monitor-attached", { eventKey: monitor.monitorId }); } catch {}
  return checkMonitor(cwd, monitor.monitorId, { ...options, ownerSessionId });
}

function stopMonitor(cwd, monitorId, options = {}) {
  const monitor = requireMonitor(cwd, monitorId, options);
  if (monitor.status !== "active") return monitor;
  const stoppedAt = new Date(nowMs(options)).toISOString();
  monitor.status = "stopped";
  monitor.finishedAt = stoppedAt;
  monitor.reason = String(options.reason || "stopped explicitly").slice(0, 500);
  return writeMonitor(cwd, monitor);
}

function listMonitors(cwd, options = {}) {
  let files = [];
  try { files = fs.readdirSync(stateDir(cwd)).filter((name) => /^monitor-[a-z0-9-]+\.json$/.test(name)); }
  catch { return []; }
  const ownerSessionId = options.ownerSessionId ? normalizeOwnerSessionId(options.ownerSessionId) : null;
  return files
    .map((name) => readMonitor(cwd, name.replace(/\.json$/, "")))
    .filter(Boolean)
    .filter((monitor) => !ownerSessionId || monitor.ownerSessionId === ownerSessionId)
    .filter((monitor) => !options.status || monitor.status === options.status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}

function formatMonitor(monitor) {
  const parts = [
    `${monitor.monitorId} [${monitor.status}] ${monitor.kind}:${monitor.targetId}`,
    `every=${formatDuration(monitor.intervalMs)}`,
    `deadline=${formatDuration(monitor.timeoutMs)}`,
    `checks=${monitor.checks || 0}`,
  ];
  if (monitor.pattern) parts.push(`pattern=${JSON.stringify(monitor.pattern)}`);
  if (monitor.reason) parts.push(`reason=${monitor.reason}`);
  if (monitor.scriptCheck) {
    const exit = monitor.scriptCheck.exitCode == null ? "" : ` (exit ${monitor.scriptCheck.exitCode})`;
    parts.push(`script-check=${monitor.scriptCheck.targetStatus}${exit}`);
  }
  if (monitor.last?.vitals && Object.keys(monitor.last.vitals).length) {
    parts.push(`vitals=${Object.entries(monitor.last.vitals).map(([key, value]) => `${key}=${value}`).join(",")}`);
  }
  return parts.join(" ");
}

function formatMonitors(monitors) {
  if (!monitors.length) return "No run monitors for this Pi session";
  return monitors.map(formatMonitor).join("\n");
}

module.exports = {
  STATE_DIR,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  createMonitor,
  checkMonitor,
  probeMonitor,
  recordMonitorProbe,
  stopMonitor,
  readMonitor,
  requireMonitor,
  listMonitors,
  formatMonitor,
  formatMonitors,
  classifyMonitorIntent,
};
