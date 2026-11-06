"use strict";

// Session mining (2026-07, glades-ml corpus): 59% of all human turns are
// training-run lifecycle babysitting. "Give a status report on the current
// run" appeared 69x verbatim (154x as a family), answered every time by a
// hand-built grep/tail/nvidia-smi compound; the live run's logdir was
// re-derived 116x with `ls -td logs/*` plus ~150 scratch-file reads/writes;
// bespoke until-grep-alive poll loops were rebuilt ~126x and the naive
// sleep-then-check form was sandbox-blocked 8x. This deck keeps one durable
// record per long-running run (training, downloads, pretokenization) with a
// log-vitals parser, so one call answers "how is the run doing".

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { startJob, jobStatus } = require("./bg-jobs.js");
const { emptyUsage, writePrivateJson, recordManagedProcessEvent, managedEvidenceFreshness, treeFingerprintSummary } = require("./managed-process-metrics.js");

const STATE_DIR = ".pi/run-deck";
const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_WATCH_MS = 9 * 60 * 1000;
const MAX_SUMMARY_RUNS = 4;

// Defaults match the vitals the corpus greps out of run.log by hand:
// step (668x), val (550x), loss (208x), grad-norm (165x), tok/s (66x),
// grad-skips (299x), NaN/abort scans (124x).
const DEFAULT_METRICS = [
  { key: "step", regex: "\\bstep[\\s:=\\[#]*([0-9][\\d,]*)", pick: "last" },
  { key: "loss", regex: "\\bloss[\\s:=]+(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)", pick: "last" },
  { key: "val", regex: "\\bval(?:_loss|idation)?[\\s:=@]+(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)", pick: "last" },
  { key: "grad_norm", regex: "(?:grad[_ ]?norm|\\|\\|g\\|\\|)[\\s:=]+(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)", pick: "last" },
  { key: "tok_s", regex: "([\\d,.]+)\\s*tok(?:ens)?/s", pick: "last" },
  { key: "skips", regex: "\\bskip", pick: "count" },
  { key: "nan", regex: "\\bnan\\b|\\binf\\b", pick: "count" },
];

function deckDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

function runFile(cwd, runId) {
  return path.join(deckDir(cwd), `${runId}.json`);
}

function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-") || "run";
}

function readRun(cwd, runId) {
  try {
    return JSON.parse(fs.readFileSync(runFile(cwd, runId), "utf8"));
  } catch {
    return null;
  }
}

function writeRun(cwd, run) {
  run.updatedAt = new Date().toISOString();
  writePrivateJson(runFile(cwd, run.runId), run);
  return run;
}

function requireRun(cwd, runId) {
  const run = readRun(cwd, String(runId || "").trim());
  if (!run) throw new Error(`run not found: ${runId}. Use listRuns//runs to see ids.`);
  return run;
}

function loadConfig(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(deckDir(cwd), "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function metricSpecs(cwd) {
  const custom = loadConfig(cwd).metrics;
  if (!Array.isArray(custom) || !custom.length) return DEFAULT_METRICS;
  const merged = new Map(DEFAULT_METRICS.map((m) => [m.key, m]));
  for (const spec of custom) if (spec?.key && spec?.regex) merged.set(spec.key, { pick: "last", ...spec });
  return Array.from(merged.values());
}

// The corpus re-derives the live logdir with `ls -td logs/<prefix>_*/run.log`
// each poll; a one-level-wildcard pattern covers that shape without a glob
// dependency: newest existing file wins.
function resolveNewestLog(cwd, pattern) {
  const absolute = path.isAbsolute(pattern) ? pattern : path.join(cwd, pattern);
  if (!absolute.includes("*")) return fs.existsSync(absolute) ? absolute : null;
  const segments = absolute.split(path.sep).filter(Boolean);
  let candidates = [path.parse(absolute).root || path.sep];
  for (const segment of segments) {
    if (!segment.includes("*")) {
      candidates = candidates.map((base) => path.join(base, segment)).filter((p) => fs.existsSync(p));
      continue;
    }
    const matcher = new RegExp(`^${segment.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    const next = [];
    for (const base of candidates) {
      let entries = [];
      try { entries = fs.readdirSync(base); } catch { continue; }
      for (const entry of entries) if (matcher.test(entry)) next.push(path.join(base, entry));
    }
    candidates = next;
  }
  const files = candidates.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!files.length) return null;
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrepAlive(pattern) {
  try {
    return execFileSync("pgrep", ["-f", pattern], { timeout: 3000, encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

function readTail(file, maxBytes = DEFAULT_TAIL_BYTES) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function parseVitals(text, specs = DEFAULT_METRICS) {
  if (!text) return {};
  const vitals = {};
  for (const spec of specs) {
    const regex = new RegExp(spec.regex, spec.flags || "gi");
    if (spec.pick === "count") {
      const count = (text.match(regex) || []).length;
      if (count) vitals[spec.key] = count;
      continue;
    }
    let match;
    let last = null;
    while ((match = regex.exec(text))) last = match[1] ?? match[0];
    if (last != null) vitals[spec.key] = last;
  }
  const lines = text.trimEnd().split("\n");
  vitals.lastLine = (lines[lines.length - 1] || "").slice(-200);
  return vitals;
}

function gpuSnapshot() {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=index,name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader"],
      { timeout: 4000, encoding: "utf8" }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function launchRun(cwd, command, options = {}) {
  if (!String(command || "").trim()) throw new Error("launchRun requires a command");
  const job = startJob(cwd, command, { name: options.name, metricsEligible: false });
  const runId = `run-${slugify(options.name || command)}-${crypto.randomBytes(2).toString("hex")}`;
  return writeRun(cwd, {
    runId,
    name: options.name || command.slice(0, 60),
    command,
    jobId: job.jobId,
    pid: job.pid,
    logPath: options.logPath || null,
    jobLog: path.join(cwd, ".pi", "jobs", `${job.jobId}.log`),
    pidPattern: options.pidPattern || null,
    status: "running",
    startedAt: job.startedAt,
    notes: [],
    latest: null,
    managedUsage: { ...emptyUsage(), starts: 1 },
  });
}

// Most real training runs are launched outside the agent (another terminal,
// runner.sh); attach registers them so status still works.
function attachRun(cwd, options = {}) {
  const logPath = String(options.logPath || "").trim();
  if (!logPath) throw new Error("attachRun requires logPath (a file, or a pattern like logs/spectral_*/run.log)");
  const name = options.name || path.basename(logPath).replace(/\.[^.]+$/, "") || "attached run";
  const runId = `run-${slugify(name)}-${crypto.randomBytes(2).toString("hex")}`;
  return writeRun(cwd, {
    runId,
    name,
    command: options.command || null,
    jobId: null,
    pid: options.pid || null,
    logPath,
    jobLog: null,
    pidPattern: options.pidPattern || null,
    status: "running",
    startedAt: new Date().toISOString(),
    notes: [],
    latest: null,
    managedUsage: { ...emptyUsage(), starts: 1 },
  });
}

function aliveCheck(cwd, run) {
  if (run.jobId) {
    try {
      const job = jobStatus(cwd, run.jobId);
      return { alive: ["queued", "running"].includes(job.status), exitCode: job.exitCode ?? null };
    } catch {
      return { alive: false, exitCode: null };
    }
  }
  if (run.pid) return { alive: pidAlive(run.pid), exitCode: null };
  if (run.pidPattern) return { alive: pgrepAlive(run.pidPattern), exitCode: null };
  return { alive: null, exitCode: null };
}

function resolveRunLog(cwd, run) {
  if (run.logPath) {
    const resolved = resolveNewestLog(cwd, run.logPath);
    if (resolved) return resolved;
  }
  return run.jobLog && fs.existsSync(run.jobLog) ? run.jobLog : null;
}

function pickCurrentRun(cwd) {
  const runs = listRuns(cwd);
  return runs.find((run) => run.status === "running") || runs[0] || null;
}

function runStatus(cwd, runId, options = {}) {
  let run = runId ? requireRun(cwd, runId) : pickCurrentRun(cwd);
  if (!run) throw new Error("no runs registered. Launch with launchRun//run-launch or register with attachRun//run-attach.");
  if (options.recordInteraction === true) run = recordManagedProcessEvent(cwd, "run_deck", run.runId, "status");
  const { alive, exitCode } = aliveCheck(cwd, run);
  const logFile = resolveRunLog(cwd, run);
  const tail = logFile ? readTail(logFile, options.tailBytes || loadConfig(cwd).tailBytes || DEFAULT_TAIL_BYTES) : null;
  const vitals = tail ? parseVitals(tail, metricSpecs(cwd)) : {};
  if (run.status === "running" && alive === false) run.status = "exited";
  run.latest = { at: new Date().toISOString(), alive, exitCode, logFile, vitals };
  writeRun(cwd, run);
  if (run.status !== "running") {
    const category = run.status === "killed" ? "cancelled" : exitCode === 0 || ["finished", "shipped"].includes(run.status) ? "succeeded" : exitCode != null || run.status === "failed" ? "domain-negative" : "unknown";
    run = recordManagedProcessEvent(cwd, "run_deck", run.runId, "final-evidence", { category });
  }
  const evidenceFreshness = managedEvidenceFreshness(cwd, run);
  return { run, alive, exitCode, logFile, vitals, evidenceFreshness: { status: evidenceFreshness.status, currentTree: evidenceFreshness.currentTree === true, gatingSafe: evidenceFreshness.gatingSafe === true, capturedAt: run.managedUsage?.finalEvidenceAt || null, evidenceTree: treeFingerprintSummary(run.managedUsage?.finalTree) }, gpu: options.gpu === false ? null : gpuSnapshot() };
}

async function watchRun(cwd, runId, options = {}) {
  const selected = runId ? requireRun(cwd, runId) : pickCurrentRun(cwd);
  if (!selected) throw new Error("no runs registered");
  if (options.recordInteraction === true) recordManagedProcessEvent(cwd, "run_deck", selected.runId, "status");
  const pattern = String(options.pattern || "").trim();
  if (!pattern) throw new Error("watchRun requires a pattern (e.g. \\[step 1\\] or final-val)");
  const regex = new RegExp(pattern);
  const timeoutMs = Math.min(Number(options.timeoutMs) || 120000, MAX_WATCH_MS);
  const pollMs = Math.max(1000, Number(options.pollMs) || 2000);
  const startedAt = Date.now();
  let deathsObserved = 0;
  for (;;) {
    const run = runId ? requireRun(cwd, runId) : pickCurrentRun(cwd);
    if (!run) throw new Error("no runs registered");
    const logFile = resolveRunLog(cwd, run);
    const tail = logFile ? readTail(logFile) : null;
    if (tail && regex.test(tail)) return { outcome: "matched", pattern, elapsedMs: Date.now() - startedAt, runId: run.runId, tail: tail.split("\n").slice(-5).join("\n") };
    const { alive, exitCode } = aliveCheck(cwd, run);
    if (alive === false) {
      // The process can exit between the tail read and the alive check (or
      // finish while flushing its final lines); one fresh read decides
      // matched-then-exited vs genuinely died.
      const finalLog = logFile || resolveRunLog(cwd, run);
      const finalTail = finalLog ? readTail(finalLog) : null;
      if (finalTail && regex.test(finalTail)) return { outcome: "matched", pattern, elapsedMs: Date.now() - startedAt, runId: run.runId, tail: finalTail.split("\n").slice(-5).join("\n") };
      // Point-in-time fs sampling is unreliable around process startup and
      // teardown (exit-file-vs-pid ordering, reaping windows; a dogfooded
      // flake saw exit code 0 with the log not yet visible in the same
      // millisecond). Death is final only when the completed job's log was
      // actually read (the log is then provably final), or once death holds
      // across two consecutive polls.
      deathsObserved++;
      if ((exitCode != null && finalTail) || deathsObserved >= 2) {
        return { outcome: "died", pattern, elapsedMs: Date.now() - startedAt, runId: run.runId, tail: finalTail ? finalTail.split("\n").slice(-10).join("\n") : null };
      }
    } else {
      deathsObserved = 0;
    }
    if (Date.now() - startedAt + pollMs > timeoutMs) return { outcome: "timeout", pattern, elapsedMs: Date.now() - startedAt, runId: run.runId, tail: tail ? tail.split("\n").slice(-5).join("\n") : null };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function noteRun(cwd, runId, note) {
  const run = requireRun(cwd, runId);
  if (String(note || "").trim()) run.notes.push({ at: new Date().toISOString(), note: String(note).trim() });
  return writeRun(cwd, run);
}

function finishRun(cwd, runId, options = {}) {
  const run = requireRun(cwd, runId);
  const status = ["finished", "killed", "shipped", "failed"].includes(options.status) ? options.status : "finished";
  run.status = status;
  run.finishedAt = new Date().toISOString();
  if (options.verdict) run.verdict = String(options.verdict).slice(0, 500);
  if (options.metrics && typeof options.metrics === "object") run.banked = options.metrics;
  writeRun(cwd, run);
  const category = status === "killed" ? "cancelled" : status === "failed" ? "domain-negative" : "succeeded";
  return recordManagedProcessEvent(cwd, "run_deck", run.runId, "final-evidence", { category });
}

function listRuns(cwd, filter = {}) {
  let files = [];
  try {
    files = fs.readdirSync(deckDir(cwd)).filter((name) => name.startsWith("run-") && name.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((name) => readRun(cwd, name.replace(/\.json$/, "")))
    .filter(Boolean)
    .filter((run) => !filter.status || run.status === filter.status)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function listRunSummaries(cwd, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
  return listRuns(cwd, options).slice(0, limit).map((run) => {
    const { alive, exitCode } = aliveCheck(cwd, run);
    const logFile = resolveRunLog(cwd, run);
    const parsed = logFile ? parseVitals(readTail(logFile, 16 * 1024) || "", metricSpecs(cwd)) : {};
    const vitals = {};
    const publicMetricKeys = new Set(DEFAULT_METRICS.map((spec) => spec.key));
    for (const [key, value] of Object.entries(parsed)) {
      if (!publicMetricKeys.has(key)) continue;
      if (typeof value === "boolean" || value == null) vitals[key] = value;
      else if (Number.isFinite(Number(value))) vitals[key] = Number(value);
    }
    const freshness = managedEvidenceFreshness(cwd, run);
    return {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      alive,
      exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
      managed: Boolean(run.jobId || run.pid),
      verdictRecorded: Boolean(run.verdict),
      vitals,
      evidenceFreshness: freshness.status,
      terminalEvidenceAt: run.managedUsage?.finalEvidenceAt || null,
    };
  });
}

function formatVitals(vitals = {}) {
  const parts = [];
  for (const spec of DEFAULT_METRICS) if (vitals[spec.key] != null) parts.push(`${spec.key}=${vitals[spec.key]}`);
  for (const key of Object.keys(vitals)) if (key !== "lastLine" && !DEFAULT_METRICS.some((s) => s.key === key)) parts.push(`${key}=${vitals[key]}`);
  return parts.join(" ");
}

function formatRunStatus(status) {
  const { run, alive, exitCode, logFile, vitals, evidenceFreshness, gpu } = status;
  const rows = [
    `${run.runId} [${run.status}] ${run.name}`,
    `alive: ${alive === null ? "unknown (no pid/pattern)" : alive}${exitCode != null ? ` exit=${exitCode}` : ""}`,
    `log: ${logFile || "(none found)"}`,
  ];
  const vitalsLine = formatVitals(vitals);
  if (vitalsLine) rows.push(`vitals: ${vitalsLine}`);
  if (vitals.lastLine) rows.push(`last: ${vitals.lastLine}`);
  if (run.verdict) rows.push(`verdict: ${run.verdict}`);
  if (run.managedUsage?.finalEvidenceRecorded) rows.push(`terminal evidence: ${evidenceFreshness?.status || "missing-fingerprint"}${run.managedUsage.finalEvidenceAt ? ` at ${run.managedUsage.finalEvidenceAt}` : ""}`);
  if (gpu) rows.push(`gpu: ${gpu.split("\n").join(" | ")}`);
  return rows.join("\n");
}

function formatRuns(runs) {
  if (!runs.length) return "No runs registered";
  return runs
    .map((run) => `${run.runId} [${run.status}] ${run.name}${run.latest?.vitals ? ` - ${formatVitals(run.latest.vitals)}` : ""}${run.verdict ? ` - ${run.verdict}` : ""}`)
    .join("\n");
}

// Session-start injection: the corpus opens sessions with "status report on
// the current run" / "GPU is occupied" caveats; live runs and GPU state
// answer both before the first tool call.
function runsSummary(cwd) {
  const runs = listRuns(cwd);
  if (!runs.length) return "";
  const lines = ["Run deck (registered long-running runs; use run_deck status for fresh vitals - if it is not in your tool list, activate it with activate_tools or use /run-status):"];
  for (const run of runs.slice(0, MAX_SUMMARY_RUNS)) {
    const { alive } = aliveCheck(cwd, run);
    const logFile = resolveRunLog(cwd, run);
    const vitals = logFile ? parseVitals(readTail(logFile, 16 * 1024) || "", metricSpecs(cwd)) : {};
    const vitalsLine = formatVitals(vitals);
    lines.push(`- ${run.runId} [${run.status}${alive === false && run.status === "running" ? ", process gone" : ""}] ${run.name}${vitalsLine ? ` - ${vitalsLine}` : ""}${run.verdict ? ` - ${run.verdict}` : ""}`);
  }
  if (runs.length > MAX_SUMMARY_RUNS) lines.push(`(+${runs.length - MAX_SUMMARY_RUNS} more: /runs)`);
  const gpu = gpuSnapshot();
  if (gpu) lines.push(`GPU: ${gpu.split("\n").join(" | ")}`);
  return lines.join("\n");
}

module.exports = {
  launchRun,
  attachRun,
  runStatus,
  watchRun,
  noteRun,
  finishRun,
  listRuns,
  listRunSummaries,
  formatRuns,
  formatRunStatus,
  runsSummary,
  parseVitals,
  resolveNewestLog,
  DEFAULT_METRICS,
  STATE_DIR,
};
