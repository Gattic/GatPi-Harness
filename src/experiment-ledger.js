"use strict";

// Session mining (2026-07, glades-ml corpus): the research workflow runs
// every idea through a pre-registered gate ladder (E0 bit-parity -> E1 units
// -> E2 -> E3 cheap-gate -> E4 ship decision) with PASS/FAIL/NULL verdicts,
// GPU-hour budgets, and ship/no-go closure - and ~170 hand-written memory
// files exist only to track that by hand. The observed friction (redundant
// baselines, wrong-arm A/B runs, "are you running the multi-seed anyways
// despite what I said?") is exactly what durable pre-registration prevents.
// One durable thread per experiment: hypothesis, pre-registered bars, arms,
// gate verdicts, closure decision.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sanitizeManagedStateValue } = require("./managed-state-sanitizer");

const STATE_DIR = ".pi/experiment-ledger";
const EXPERIMENT_SCHEMA_VERSION = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GATE_VERDICTS = new Set(["pass", "fail", "null-result", "partial"]);
const DECISIONS = new Set(["ship", "no-go", "shelved"]);
const MAX_SUMMARY_EXPERIMENTS = 10;
const MAX_BARS = 20;
const MAX_BAR_LENGTH = 500;
const MAX_DEBUG_LINKS = 50;

function ledgerDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-") || "experiment";
}

function experimentFile(cwd, experimentId) {
  return path.join(ledgerDir(cwd), `${experimentId}.json`);
}

function readExperiment(cwd, experimentId) {
  try {
    if (!SAFE_ID.test(String(experimentId || ""))) return null;
    const file = experimentFile(cwd, experimentId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.schemaVersion === EXPERIMENT_SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

function writeExperiment(cwd, experiment, { preserveUpdatedAt = false } = {}) {
  const dir = ledgerDir(cwd);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const sanitized = sanitizeManagedStateValue({ ...experiment, schemaVersion: EXPERIMENT_SCHEMA_VERSION, updatedAt: preserveUpdatedAt ? experiment.updatedAt : new Date().toISOString() });
  if (!SAFE_ID.test(String(sanitized.experimentId || ""))) throw new Error("invalid experiment id");
  const target = experimentFile(cwd, sanitized.experimentId);
  try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error("experiment file must not be a symlink"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, target); fs.chmodSync(target, 0o600); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  return sanitized;
}

function requireExperiment(cwd, experimentId) {
  const experiment = readExperiment(cwd, String(experimentId || "").trim());
  if (!experiment) throw new Error(`experiment not found: ${experimentId}. Use listExperiments//exp-list to see ids.`);
  return experiment;
}

function validateList(value, name, { maxItems = 20, maxLength = 500 } = {}) {
  const raw = Array.isArray(value) ? value : value == null ? [] : String(value).split(/;|\n/);
  const items = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error(`${name} must contain only strings`);
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLength) throw new Error(`${name} entries must be ${maxLength} characters or fewer`);
    if (!items.includes(trimmed)) items.push(trimmed);
  }
  if (items.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} entries`);
  return items;
}

function openExperiment(cwd, title, options = {}) {
  const cleanTitle = String(title || "").trim() || "untitled experiment";
  const slug = slugify(cleanTitle);
  const existing = listExperiments(cwd).find((e) => e.status === "open" && slugify(e.title) === slug);
  if (existing) return { ...existing, duplicate: true };
  const experimentId = `exp-${slug}`;
  if (fs.existsSync(experimentFile(cwd, experimentId))) throw new Error(`experiment id already exists: ${experimentId}; inspect or migrate it instead of overwriting history`);
  return writeExperiment(cwd, {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId,
    title: cleanTitle,
    hypothesis: String(options.hypothesis || "").trim() || null,
    // Pre-registered bars are the point: verdicts recorded later are judged
    // against what was written down before the run, not after.
    bars: validateList(options.bars, "bars", { maxItems: MAX_BARS, maxLength: MAX_BAR_LENGTH }),
    arms: validateList(options.arms, "arms"),
    status: "open",
    gates: [],
    runIds: [],
    commits: [],
    debugThreadIds: [],
    createdAt: new Date().toISOString(),
  });
}

function recordGate(cwd, experimentId, entry = {}) {
  const experiment = requireExperiment(cwd, experimentId);
  const gate = String(entry.gate || "").trim();
  if (!gate) throw new Error("recordGate requires a gate label (e.g. E0, E3, pilot)");
  if (!GATE_VERDICTS.has(entry.verdict)) throw new Error(`recordGate requires a verdict: ${Array.from(GATE_VERDICTS).join("|")}`);
  if (!Array.isArray(experiment.bars) || experiment.bars.length === 0) throw new Error("recordGate requires pre-registered bars; reopen the experiment with bars before recording a verdict");
  if (entry.debugThreadId) {
    const thread = require("./debug-ledger").showThread(cwd, String(entry.debugThreadId));
    experiment.debugThreadIds = Array.from(new Set([...(Array.isArray(experiment.debugThreadIds) ? experiment.debugThreadIds : []), thread.threadId]));
  }
  experiment.gates.push({
    at: new Date().toISOString(),
    gate,
    verdict: entry.verdict,
    metrics: String(entry.metrics || "").slice(0, 500) || null,
    note: String(entry.note || "").slice(0, 500) || null,
    gpuHours: Number.isFinite(Number(entry.gpuHours)) && entry.gpuHours !== undefined && entry.gpuHours !== null ? Number(entry.gpuHours) : null,
  });
  if (entry.runId) experiment.runIds = Array.from(new Set([...experiment.runIds, String(entry.runId)]));
  if (entry.commit) experiment.commits = Array.from(new Set([...experiment.commits, String(entry.commit)]));
  const written = writeExperiment(cwd, experiment);
  if (entry.debugThreadId) require("./debug-ledger").linkExperiment(cwd, String(entry.debugThreadId), written.experimentId);
  return written;
}

function linkDebugThread(cwd, experimentId, threadId) {
  const experiment = requireExperiment(cwd, experimentId);
  const thread = require("./debug-ledger").showThread(cwd, String(threadId));
  const linked = Array.from(new Set([...(Array.isArray(experiment.debugThreadIds) ? experiment.debugThreadIds : []), thread.threadId]));
  if (linked.length > MAX_DEBUG_LINKS) throw new Error(`an experiment may link at most ${MAX_DEBUG_LINKS} debug threads`);
  experiment.debugThreadIds = linked;
  const written = writeExperiment(cwd, experiment);
  require("./debug-ledger").linkExperiment(cwd, thread.threadId, written.experimentId);
  return written;
}

function closeExperiment(cwd, experimentId, options = {}) {
  const experiment = requireExperiment(cwd, experimentId);
  if (!DECISIONS.has(options.decision)) throw new Error(`closeExperiment requires a decision: ${Array.from(DECISIONS).join("|")}`);
  experiment.status = "closed";
  experiment.decision = options.decision;
  experiment.resolution = { at: new Date().toISOString(), note: String(options.note || "").slice(0, 800) || null };
  return writeExperiment(cwd, experiment);
}

function listExperiments(cwd, filter = {}) {
  let files = [];
  try {
    files = fs.readdirSync(ledgerDir(cwd)).filter((name) => name.startsWith("exp-") && name.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((name) => readExperiment(cwd, name.replace(/\.json$/, "")))
    .filter(Boolean)
    .filter((experiment) => !filter.status || experiment.status === filter.status)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function experimentLedgerCoverage(cwd) {
  const result = { current: 0, legacy: 0, unreadable: 0, unsupported: 0 };
  let names;
  try { names = fs.readdirSync(ledgerDir(cwd)).filter((name) => name.startsWith("exp-") && name.endsWith(".json")); }
  catch (error) { if (error.code === "ENOENT") return result; throw error; }
  for (const name of names) {
    try {
      const file = path.join(ledgerDir(cwd), name); const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) { result.unreadable++; continue; }
      const row = JSON.parse(fs.readFileSync(file, "utf8"));
      if (row.schemaVersion === EXPERIMENT_SCHEMA_VERSION) result.current++;
      else if (row.schemaVersion == null || row.schemaVersion === 1 || row.schemaVersion === 2) result.legacy++;
      else result.unsupported++;
    } catch { result.unreadable++; }
  }
  return result;
}

// Explicit one-time migration, never a compatibility fallback during reads.
function migrateExperimentLedger(cwd, { apply = false } = {}) {
  const dir = ledgerDir(cwd); const records = [];
  if (!fs.existsSync(dir)) return { apply, records, migrated: 0 };
  for (const name of fs.readdirSync(dir).filter((name) => /^exp-[A-Za-z0-9._-]+\.json$/.test(name)).sort()) {
    const file = path.join(dir, name); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) { records.push({ experimentId: name.slice(0, -5), outcome: "blocked", reason: "unsafe-source" }); continue; }
    let row; const text = fs.readFileSync(file, "utf8");
    try { row = JSON.parse(text); } catch { records.push({ experimentId: name.slice(0, -5), outcome: "blocked", reason: "invalid-json" }); continue; }
    if (row?.schemaVersion === EXPERIMENT_SCHEMA_VERSION) continue;
    const valid = row !== null && typeof row === "object" && !Array.isArray(row)
      && (row.schemaVersion == null || row.schemaVersion === 1 || row.schemaVersion === 2) && row.experimentId === name.slice(0, -5) && SAFE_ID.test(row.experimentId) && typeof row.title === "string" && ["open", "closed"].includes(row.status)
      && [row.bars, row.arms, row.runIds, row.commits].every((values) => Array.isArray(values) && values.every((value) => typeof value === "string"))
      && (row.debugThreadIds == null || (Array.isArray(row.debugThreadIds) && row.debugThreadIds.every((value) => typeof value === "string")))
      && Array.isArray(row.gates) && row.gates.every((gate) => gate !== null && typeof gate === "object" && !Array.isArray(gate) && typeof gate.gate === "string" && GATE_VERDICTS.has(gate.verdict))
      && Number.isFinite(Date.parse(row.createdAt)) && Number.isFinite(Date.parse(row.updatedAt))
      && (row.status !== "closed" || DECISIONS.has(row.decision));
    if (!valid) { records.push({ experimentId: name.slice(0, -5), outcome: "blocked", reason: "unrecognized-legacy-contract" }); continue; }
    const sourceHash = crypto.createHash("sha256").update(text).digest("hex");
    if (apply) {
      const archiveDir = path.join(dir, "migration-originals");
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(archiveDir).isSymbolicLink()) throw new Error("unsafe experiment migration archive");
      fs.chmodSync(archiveDir, 0o700);
      const backup = path.join(archiveDir, `${row.experimentId}-${sourceHash}.json`);
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text, { flag: "wx", mode: 0o600 });
      else if (fs.lstatSync(backup).isSymbolicLink() || fs.readFileSync(backup, "utf8") !== text) throw new Error("experiment migration archive mismatch");
      fs.chmodSync(backup, 0o600);
      writeExperiment(cwd, { ...row, debugThreadIds: Array.isArray(row.debugThreadIds) ? row.debugThreadIds : [], migration: { fromSchemaVersion: row.schemaVersion ?? null, sourceHash: `sha256:${sourceHash}`, at: new Date().toISOString(), evidenceRequalified: false } }, { preserveUpdatedAt: true });
    }
    records.push({ experimentId: row.experimentId, outcome: apply ? "migrated" : "eligible", originalStatus: row.status, gateCount: row.gates.length, evidenceRequalified: false });
  }
  return { apply, records, migrated: records.filter((row) => row.outcome === "migrated").length, blocked: records.filter((row) => row.outcome === "blocked").length };
}

function showExperiment(cwd, experimentId) {
  return requireExperiment(cwd, experimentId);
}

function listExperimentSummaries(cwd, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
  return listExperiments(cwd, options).slice(0, limit).map((experiment) => {
    const lastGate = experiment.gates.at(-1) || null;
    const verdictCounts = Object.fromEntries(Array.from(GATE_VERDICTS).map((verdict) => [verdict, experiment.gates.filter((gate) => gate.verdict === verdict).length]));
    return {
      experimentId: experiment.experimentId,
      status: experiment.status,
      decision: DECISIONS.has(experiment.decision) ? experiment.decision : null,
      createdAt: experiment.createdAt || null,
      updatedAt: experiment.updatedAt || null,
      gateCount: experiment.gates.length,
      verdictCounts,
      lastGate: lastGate ? { gateId: SAFE_ID.test(String(lastGate.gate || "")) ? lastGate.gate : `gate_${crypto.createHash("sha256").update(String(lastGate.gate || "gate")).digest("hex").slice(0, 16)}`, verdict: lastGate.verdict, at: lastGate.at || null, gpuHours: Number(lastGate.gpuHours || 0) } : null,
      runCount: experiment.runIds.length,
      commitCount: experiment.commits.length,
      totalGpuHours: totalGpuHours(experiment),
    };
  });
}

function totalGpuHours(experiment) {
  return experiment.gates.reduce((sum, gate) => sum + (gate.gpuHours || 0), 0);
}

function formatExperiment(experiment) {
  const rows = [
    `${experiment.experimentId} [${experiment.status}${experiment.decision ? `: ${experiment.decision}` : ""}] ${experiment.title}`,
  ];
  if (experiment.hypothesis) rows.push(`hypothesis: ${experiment.hypothesis}`);
  if (experiment.bars.length) rows.push(`pre-registered bars: ${experiment.bars.join("; ")}`);
  if (experiment.arms.length) rows.push(`arms: ${experiment.arms.join("; ")}`);
  for (const gate of experiment.gates) {
    rows.push(`- ${gate.gate} ${gate.verdict.toUpperCase()}${gate.metrics ? ` :: ${gate.metrics}` : ""}${gate.note ? ` :: ${gate.note}` : ""}${gate.gpuHours != null ? ` (${gate.gpuHours} GPU-h)` : ""}`);
  }
  const gpuHours = totalGpuHours(experiment);
  if (gpuHours) rows.push(`GPU-hours so far: ${gpuHours}`);
  if (experiment.runIds.length) rows.push(`runs: ${experiment.runIds.join(", ")}`);
  if (experiment.commits.length) rows.push(`commits: ${experiment.commits.join(", ")}`);
  if (experiment.resolution?.note) rows.push(`resolution: ${experiment.resolution.note}`);
  return rows.join("\n");
}

// Session-start injection: open experiments with their bars and last gate,
// so a fresh session neither re-runs a settled gate nor drifts from the
// pre-registered protocol.
function openExperimentsSummary(cwd) {
  const experiments = listExperiments(cwd, { status: "open" });
  const coverage = experimentLedgerCoverage(cwd);
  const excluded = coverage.legacy + coverage.unreadable + coverage.unsupported;
  if (!experiments.length && !excluded) return "";
  const lines = ["Open experiments (pre-registered; check before launching runs, record verdicts with experiment_ledger - if it is not in your tool list, activate it with activate_tools or use /exp-gate):"];
  if (excluded) lines.push(`Ledger coverage: ${excluded} excluded records (${coverage.legacy} legacy, ${coverage.unreadable} unreadable, ${coverage.unsupported} unsupported); review explicit migration before launching overlapping work.`);
  for (const experiment of experiments.slice(0, MAX_SUMMARY_EXPERIMENTS)) {
    const lastGate = experiment.gates[experiment.gates.length - 1];
    const debugLinks = Array.isArray(experiment.debugThreadIds) && experiment.debugThreadIds.length ? ` | debug: ${experiment.debugThreadIds.join(", ")}` : "";
    lines.push(`- ${experiment.experimentId}: ${experiment.title}${experiment.bars.length ? ` | bars: ${experiment.bars.join("; ")}` : ""}${lastGate ? ` | last: ${lastGate.gate} ${lastGate.verdict.toUpperCase()}` : " | no gates recorded"}${debugLinks}`);
  }
  if (experiments.length > MAX_SUMMARY_EXPERIMENTS) lines.push(`(+${experiments.length - MAX_SUMMARY_EXPERIMENTS} more: /exp-list open)`);
  return lines.join("\n");
}

module.exports = {
  openExperiment,
  recordGate,
  closeExperiment,
  linkDebugThread,
  listExperiments,
  showExperiment,
  formatExperiment,
  openExperimentsSummary,
  listExperimentSummaries,
  EXPERIMENT_SCHEMA_VERSION,
  experimentLedgerCoverage,
  migrateExperimentLedger,
  STATE_DIR,
};
