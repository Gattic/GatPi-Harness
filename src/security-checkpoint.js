"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readChangeSet, normalizeRepositoryPath } = require("./code-context-revision.js");
const { sourceKindForPath } = require("./code-context-contracts.js");
const { semgrepCodegraphAdvisory } = require("./semgrep-adapter.js");

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|[ch](?:pp)?|java|rb|php|sh)$/i;
const SENSITIVE_PATH = /auth|login|credential|secret|token|permission|security|privacy|sandbox|policy|crypto/i;
const SENSITIVE_CODE = /\b(?:execFile(?:Sync)?|execSync|spawn(?:Sync)?|child_process|subprocess|eval|realpath(?:Sync)?|chmod(?:Sync)?|createHmac|createSign|verifyToken)\b|shell\s*:\s*true|rejectUnauthorized\s*:\s*false|process\.env\.[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)/;
const MAX_INSPECT_BYTES = 1024 * 1024;
const BROAD_SOURCE_COUNT = 10;

function securityCheckpointPlan(cwd, files, options = {}) {
  const root = fs.realpathSync(cwd);
  const changes = files == null ? readChangeSet(root) : null;
  if (changes && !changes.available) return { applicable: false, status: "unavailable", reason: "change-set-unavailable", files: [], reasons: {} };
  const selected = [], reasons = {}, sources = [];
  for (const value of new Set(files || changes.changedPaths)) {
    const file = normalizeRepositoryPath(root, value);
    if (!SOURCE.test(file) || sourceKindForPath(file) !== "first_party" || /(^|\/)\.pi\/(?!extensions\/)/.test(file)) continue;
    const full = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(full); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    // Never follow an authored symlink outside the repository into a scanner.
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    normalizeRepositoryPath(root, fs.realpathSync(full));
    sources.push(file);
    if (SENSITIVE_PATH.test(file)) reasons[file] = "security-sensitive-path";
    else if (stat.size > MAX_INSPECT_BYTES) reasons[file] = "content-inspection-limit";
    else if (SENSITIVE_CODE.test(fs.readFileSync(full, "utf8"))) reasons[file] = "security-sensitive-operation";
    if (reasons[file]) selected.push(file);
  }
  if (options.required || sources.length >= BROAD_SOURCE_COUNT) {
    for (const file of sources) reasons[file] ||= options.required ? "explicitly-required" : "broad-source-change";
    selected.splice(0, selected.length, ...sources);
  }
  return { applicable: selected.length > 0, status: selected.length ? "planned" : "not-applicable", reason: selected.length ? "risk-checkpoint" : "no-security-sensitive-source-changes", files: selected.sort(), reasons };
}

function runSecurityCheckpoint(cwd, files, options = {}) {
  const plan = securityCheckpointPlan(cwd, files, options);
  if (!plan.applicable) return { ...plan, advisory: true, gatingSafe: false, semgrep: { ok: false, skipped: true, scanStatus: "not-run", reason: plan.reason, findings: [] }, affectedTests: [] };
  const localRules = path.join(cwd, ".semgrep.yml");
  const config = options.config || process.env.PI_SEMGREP_CONFIG || (fs.existsSync(localRules) ? ".semgrep.yml" : "p/default");
  const started = Date.now();
  // A verification checkpoint is explicit work, independent of background enrichment.
  const result = (options.scan || semgrepCodegraphAdvisory)(cwd, plan.files, {
    ...options, config, advisory: true, metrics: "off", timeoutMs: options.timeoutMs || 30000,
    codegraphTimeoutMs: 3000, scanTimeoutSec: 5,
  });
  return { ...result, ...plan, status: result.semgrep?.ok ? result.semgrep.findings?.length ? "findings" : "clean" : "unavailable", config, durationMs: Date.now() - started, advisory: true, gatingSafe: false };
}

function securityCheckpointSummary(result) {
  const count = result.semgrep?.summary?.findings ?? result.semgrep?.findings?.length ?? 0;
  return `Semgrep security checkpoint: ${result.status}; ${result.files.length} file(s), ${count} finding(s), ${result.affectedTests?.length || 0} affected-test hint(s). Advisory only; baseline tests remain required.${result.status === "unavailable" ? ` Reason: ${result.semgrep?.errorCode || result.semgrep?.reason || result.reason}.` : ""}`;
}

module.exports = { securityCheckpointPlan, runSecurityCheckpoint, securityCheckpointSummary };
