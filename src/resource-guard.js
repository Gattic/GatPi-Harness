"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const WORKER_ROOT = path.join(os.tmpdir(), `pi-managed-workers-${process.getuid?.() ?? "user"}`);
let inheritedWorkerBusy = false;

const DEFAULT_RSS_LIMIT_MB = 6 * 1024;
const DEFAULT_RSS_POLL_MS = 2_000;
const DEFAULT_TERM_GRACE_MS = 5_000;
const OWNED_GROUP = Symbol("pi-harness-owned-process-group");

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function resourceGuardConfig(overrides = {}, env = process.env) {
  const rssLimitMb = positiveInteger(overrides.rssLimitMb ?? env.PI_MANAGED_PROCESS_MAX_RSS_MB, DEFAULT_RSS_LIMIT_MB);
  return {
    rssLimitMb,
    rssLimitBytes: rssLimitMb * 1024 * 1024,
    rssPollMs: positiveInteger(overrides.rssPollMs ?? env.PI_MANAGED_PROCESS_RSS_POLL_MS, DEFAULT_RSS_POLL_MS, 10),
    termGraceMs: positiveInteger(overrides.termGraceMs ?? env.PI_MANAGED_PROCESS_TERM_GRACE_MS, DEFAULT_TERM_GRACE_MS, 10),
  };
}

function parseProcStat(text) {
  const end = String(text || "").lastIndexOf(")");
  if (end < 0) return null;
  const fields = String(text).slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20) return null;
  return {
    state: fields[0],
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    startTime: String(fields[19]),
  };
}

function processIdentity(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    const parsed = parseProcStat(fs.readFileSync(`/proc/${numericPid}/stat`, "utf8"));
    return parsed ? { pid: numericPid, startTime: parsed.startTime, state: parsed.state, processGroupId: parsed.processGroupId } : null;
  } catch {
    return null;
  }
}

function waitDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupRss(processGroupId, { includeDescendants = false } = {}) {
  const pgid = Number(processGroupId);
  if (!Number.isInteger(pgid) || pgid <= 0) return { processGroupId: pgid, rssBytes: 0, members: 0 };
  let names = [];
  try { names = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)); } catch {}
  let rssBytes = 0;
  let members = 0;
  const descendants = new Set([pgid]);
  if (includeDescendants) {
    const identities = names.map(name => { try { return { pid: Number(name), ...parseProcStat(fs.readFileSync(`/proc/${name}/stat`, "utf8")) }; } catch { return null; } }).filter(Boolean);
    let changed = true;
    while (changed) { changed = false; for (const item of identities) if (!descendants.has(item.pid) && descendants.has(item.parentPid)) { descendants.add(item.pid); changed = true; } }
  }
  for (const name of names) {
    try {
      const parsed = parseProcStat(fs.readFileSync(`/proc/${name}/stat`, "utf8"));
      if (!parsed || parsed.state === "Z" || (parsed.processGroupId !== pgid && !(includeDescendants && descendants.has(Number(name))))) continue;
      const status = fs.readFileSync(`/proc/${name}/status`, "utf8");
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      rssBytes += Number(match?.[1] || 0) * 1024;
      members += 1;
    } catch {}
  }
  return { processGroupId: pgid, rssBytes, members };
}

function processGroupAlive(processGroupId) {
  return processGroupRss(processGroupId).members > 0;
}

function ownProcessGroup(child) {
  const pgid = Number(child?.pid);
  if (!Number.isInteger(pgid) || pgid <= 0) throw new Error("owned process group requires a spawned child pid");
  const identity = processIdentity(pgid);
  if (!identity || identity.processGroupId !== pgid) throw new Error("owned process group requires a detached group-leader child");
  return Object.freeze({ [OWNED_GROUP]: true, processGroupId: pgid, startTime: identity.startTime });
}

function requireOwnedGroup(ownership) {
  if (!ownership || ownership[OWNED_GROUP] !== true) throw new Error("process-group operation requires harness ownership");
  return ownership.processGroupId;
}

async function terminateOwnedProcessGroup(ownership, options = {}) {
  const pgid = requireOwnedGroup(ownership);
  const graceMs = positiveInteger(options.graceMs, DEFAULT_TERM_GRACE_MS, 0);
  const pollMs = positiveInteger(options.pollMs, Math.min(100, Math.max(10, graceMs)), 5);
  const signals = [];
  let termSent = false;
  let killSent = false;
  try { process.kill(-pgid, "SIGTERM"); termSent = true; signals.push("SIGTERM"); } catch {}
  const deadline = Date.now() + graceMs;
  while (processGroupAlive(pgid) && Date.now() < deadline) await waitDelay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  if (processGroupAlive(pgid)) {
    try { process.kill(-pgid, "SIGKILL"); killSent = true; signals.push("SIGKILL"); } catch {}
  }
  const killDeadline = Date.now() + Math.max(100, pollMs * 4);
  while (processGroupAlive(pgid) && Date.now() < killDeadline) await waitDelay(pollMs);
  return { processGroupId: pgid, termSent, killSent, signals, exited: !processGroupAlive(pgid), graceMs };
}

function watchOwnedProcessGroupRss(ownership, options = {}) {
  const pgid = requireOwnedGroup(ownership);
  const limitBytes = positiveInteger(options.limitBytes, DEFAULT_RSS_LIMIT_MB * 1024 * 1024);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_RSS_POLL_MS, 10);
  let stopped = false;
  let exceeded = false;
  let peakRssBytes = 0;
  const sample = () => {
    if (stopped) return { ...processGroupRss(pgid), peakRssBytes, exceeded };
    const usage = processGroupRss(pgid, { includeDescendants: options.includeDescendants === true });
    peakRssBytes = Math.max(peakRssBytes, usage.rssBytes);
    options.onSample?.({ ...usage, peakRssBytes, limitBytes });
    if (!exceeded && usage.rssBytes > limitBytes) {
      exceeded = true;
      options.onExceeded?.({ ...usage, peakRssBytes, limitBytes });
    }
    return { ...usage, peakRssBytes, exceeded };
  };
  const timer = setInterval(sample, pollMs);
  timer.unref?.();
  setImmediate(sample).unref?.();
  return {
    sample,
    stop() { stopped = true; clearInterval(timer); return { peakRssBytes, exceeded }; },
  };
}

async function acquireManagedWorker({ root = WORKER_ROOT, limit = 2 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2) throw new Error("managed worker limit must be 1 or 2");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error("unsafe managed worker directory");
  if (root === WORKER_ROOT && process.env.PI_ROLE_SIDECAR === "1" && process.env.PI_MANAGED_WORKER_TOKEN) {
    const slot = process.env.PI_MANAGED_WORKER_SLOT;
    if (!/^[01]$/.test(slot || "")) throw new Error("invalid inherited managed worker slot");
    const file = path.join(root, `worker-${slot}.lock`), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== directory.uid || (stat.mode & 0o077)) throw new Error("unsafe inherited managed worker lease");
    const lease = JSON.parse(fs.readFileSync(file, "utf8"));
    const held = spawnSync("/usr/bin/flock", ["-n", file, "/usr/bin/true"], { timeout: 2000, env: { PATH: "/usr/bin:/bin" } });
    if (held.status !== 1 || lease.token !== process.env.PI_MANAGED_WORKER_TOKEN) throw new Error("inherited managed worker lease is no longer owned");
    if (inheritedWorkerBusy) throw Object.assign(new Error("inherited managed worker is busy"), { code: "MANAGED_WORKER_CAPACITY" });
    inheritedWorkerBusy = true;
    let released = false;
    return { release() { if (released) return; released = true; inheritedWorkerBusy = false; } };
  }
  for (let index = 0; index < limit; index++) {
    const file = path.join(root, `worker-${index}.lock`);
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    let handedOff = false, holder, closed;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== directory.uid || (stat.mode & 0o077)) throw new Error("unsafe managed worker lock");
      // The inherited descriptor avoids pathname replacement races. Closing the
      // parent pipe also releases the kernel lock after an ungraceful parent exit.
      holder = spawn("/usr/bin/flock", ["-n", "-F", "/proc/self/fd/3", "/bin/sh", "-c", "printf ready; cat >/dev/null"], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore", fd] });
      closed = new Promise(resolve => holder.once("close", resolve));
      const ready = await new Promise((resolve, reject) => { holder.once("error", reject); holder.stdout.once("data", chunk => resolve(String(chunk) === "ready")); holder.once("close", () => resolve(false)); });
      if (ready) {
        const token = crypto.randomBytes(24).toString("hex");
        fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, JSON.stringify({ token }));
        handedOff = true;
        let released = false;
        return { environment: { PI_MANAGED_WORKER_SLOT: String(index), PI_MANAGED_WORKER_TOKEN: token }, async release() {
          if (released) return; released = true;
          try { fs.ftruncateSync(fd, 0); holder.stdin.end(); await closed; } finally { fs.closeSync(fd); }
        } };
      }
      holder.stdin.end(); await closed;
    } finally { if (!handedOff) { holder?.stdin.end(); if (closed) await closed; fs.closeSync(fd); } }
  }
  throw Object.assign(new Error("user-wide managed worker capacity exhausted"), { code: "MANAGED_WORKER_CAPACITY" });
}

module.exports = {
  acquireManagedWorker,
  DEFAULT_RSS_LIMIT_MB,
  DEFAULT_RSS_POLL_MS,
  DEFAULT_TERM_GRACE_MS,
  ownProcessGroup,
  processGroupAlive,
  processGroupRss,
  processIdentity,
  resourceGuardConfig,
  terminateOwnedProcessGroup,
  watchOwnedProcessGroupRss,
};
