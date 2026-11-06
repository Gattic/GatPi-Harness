"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { codegraphAffectedTests } = require("./codegraph-adapter.js");
const { normalizeDiagnostics } = require("./diagnostic-normalizer.js");
const { semgrepScanEnvelope, semgrepCodegraphEnvelope, renderSemgrep, renderSemgrepCodegraph, severityScore, recordResultRendering } = require("./provider-result-rendering.js");

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_FINDINGS = 200;
const DEFAULT_CONFIG_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_CONFIG_READY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIG_FAILURE_TTL_MS = 15 * 60 * 1000;
const configProbeCache = new Map();

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function configFromEnv(env = process.env, overrides = {}) {
  return {
    enabled: env.PI_SEMGREP !== "0",
    bin: overrides.bin || env.PI_SEMGREP_BIN || "semgrep",
    defaultConfig: overrides.config || overrides.defaultConfig || env.PI_SEMGREP_CONFIG || "p/default",
    timeoutMs: clampNumber(Number(overrides.timeoutMs || env.PI_SEMGREP_TIMEOUT_MS || 120000), 1000, 15 * 60 * 1000),
    maxBuffer: clampNumber(Number(overrides.maxBuffer || env.PI_SEMGREP_MAX_BUFFER || 20 * 1024 * 1024), 1024 * 1024, 250 * 1024 * 1024),
    allowOutsideCwd: overrides.allowOutsideCwd != null ? Boolean(overrides.allowOutsideCwd) : env.PI_SEMGREP_ALLOW_OUTSIDE === "1",
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_SEMGREP_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_SEMGREP_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    advisory: overrides.advisory != null ? Boolean(overrides.advisory) : env.PI_SEMGREP_ADVISORY !== "0",
    advisoryTimeoutMs: clampNumber(Number(overrides.advisoryTimeoutMs || env.PI_SEMGREP_ADVISORY_TIMEOUT_MS || 8000), 100, 60_000),
    metrics: overrides.metrics || env.PI_SEMGREP_METRICS || "off",
    configProbeTimeoutMs: clampNumber(Number(overrides.configProbeTimeoutMs || env.PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS || DEFAULT_CONFIG_PROBE_TIMEOUT_MS), 1000, 2 * 60 * 1000),
    configReadyTtlMs: clampNumber(Number(overrides.configReadyTtlMs || env.PI_SEMGREP_CONFIG_READY_TTL_MS || DEFAULT_CONFIG_READY_TTL_MS), 1000, 7 * 24 * 60 * 60 * 1000),
    configFailureTtlMs: clampNumber(Number(overrides.configFailureTtlMs || env.PI_SEMGREP_CONFIG_FAILURE_TTL_MS || DEFAULT_CONFIG_FAILURE_TTL_MS), 1000, 24 * 60 * 60 * 1000),
    maxFindings: clampNumber(Number(overrides.maxFindings || env.PI_SEMGREP_MAX_FINDINGS || DEFAULT_MAX_FINDINGS), 1, 5000),
  };
}
function stripAt(value) {
  const text = String(value || "").trim();
  return text.startsWith("@") ? text.slice(1) : text;
}
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function resolveProjectPath(ctx, inputPath, config = configFromEnv()) {
  const raw = stripAt(inputPath) || ".";
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const absolute = path.resolve(cwd, raw);
  if (!config.allowOutsideCwd && !isInside(cwd, absolute)) {
    throw new Error(`Semgrep project path must stay inside cwd (${cwd}). Set PI_SEMGREP_ALLOW_OUTSIDE=1 to allow ${absolute}.`);
  }
  return absolute;
}
function normalizeProjectFile(projectPath, file) {
  const raw = stripAt(file);
  if (!raw) throw new Error("Semgrep target file path must not be empty");
  if (raw === ".") return ".";
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  if (!isInside(projectPath, absolute)) throw new Error(`Semgrep target must stay inside project path: ${file}`);
  return path.relative(projectPath, absolute).replace(/\\/g, "/") || ".";
}
function positiveInt(value, fallback, max) {
  const n = Number(value);
  return clampNumber(Number.isFinite(n) && n > 0 ? n : fallback, 1, max);
}
function timeout(value, config = configFromEnv()) {
  return clampNumber(Number(value || config.timeoutMs), 1000, 15 * 60 * 1000);
}
function shellQuote(arg) {
  const text = String(arg);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
function commandText(bin, args) { return [bin, ...args].map(shellQuote).join(" "); }
function stripAnsi(text) { return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ""); }
function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}
function truncateHead(text, options = {}) {
  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const value = String(text || "");
  const lines = value.split(/\r?\n/);
  const totalBytes = Buffer.byteLength(value, "utf8");
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength((out.length ? "\n" : "") + line, "utf8");
    if (out.length >= maxLines || (out.length && bytes + lineBytes > maxBytes)) break;
    if (!out.length && lineBytes > maxBytes) {
      let acc = "";
      for (const ch of line) {
        if (Buffer.byteLength(acc + ch, "utf8") > maxBytes) break;
        acc += ch;
      }
      out.push(acc);
      bytes = Buffer.byteLength(acc, "utf8");
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  return { content: out.join("\n"), truncated: out.length < lines.length || bytes < totalBytes, outputLines: out.length, totalLines: lines.length, outputBytes: bytes, totalBytes };
}
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function executableInfo(bin = "semgrep", env = process.env) {
  const hasSep = bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin);
  const candidates = hasSep ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin, found: true, path: candidate }; } catch {}
  }
  return { bin, found: false, path: hasSep ? path.resolve(bin) : null };
}
function friendlyMissingBinaryMessage(config = configFromEnv()) {
  return `Semgrep is not installed or is not on PATH (tried '${config.bin}'). Install Semgrep, set PI_SEMGREP_BIN to the executable path, or disable this extension with PI_SEMGREP=0.`;
}
function semgrepError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}
function envReport(env = process.env) {
  return {
    PI_SEMGREP: env.PI_SEMGREP ?? null,
    PI_SEMGREP_BIN: env.PI_SEMGREP_BIN ?? null,
    PI_SEMGREP_CONFIG: env.PI_SEMGREP_CONFIG ?? null,
    PI_SEMGREP_TIMEOUT_MS: env.PI_SEMGREP_TIMEOUT_MS ?? null,
    PI_SEMGREP_MAX_BUFFER: env.PI_SEMGREP_MAX_BUFFER ?? null,
    PI_SEMGREP_MAX_LINES: env.PI_SEMGREP_MAX_LINES ?? null,
    PI_SEMGREP_MAX_BYTES: env.PI_SEMGREP_MAX_BYTES ?? null,
    PI_SEMGREP_ALLOW_OUTSIDE: env.PI_SEMGREP_ALLOW_OUTSIDE ?? null,
    PI_SEMGREP_ADVISORY: env.PI_SEMGREP_ADVISORY ?? null,
    PI_SEMGREP_ADVISORY_TIMEOUT_MS: env.PI_SEMGREP_ADVISORY_TIMEOUT_MS ?? null,
    PI_SEMGREP_VERIFY_TIMEOUT_MS: env.PI_SEMGREP_VERIFY_TIMEOUT_MS ?? null,
    PI_SEMGREP_PATCH_TIMEOUT_MS: env.PI_SEMGREP_PATCH_TIMEOUT_MS ?? null,
    PI_SEMGREP_METRICS: env.PI_SEMGREP_METRICS ?? null,
    PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS: env.PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS ?? null,
    PI_SEMGREP_CONFIG_READY_TTL_MS: env.PI_SEMGREP_CONFIG_READY_TTL_MS ?? null,
    PI_SEMGREP_CONFIG_FAILURE_TTL_MS: env.PI_SEMGREP_CONFIG_FAILURE_TTL_MS ?? null,
    PI_SEMGREP_MAX_FINDINGS: env.PI_SEMGREP_MAX_FINDINGS ?? null,
  };
}
function gitChangedFiles(cwd) {
  const names = [];
  for (const args of [["diff", "--name-only", "HEAD", "--"], ["diff", "--cached", "--name-only", "HEAD", "--"]]) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
    if (r.status === 0) names.push(...r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }
  return Array.from(new Set(names));
}
function normalizeArray(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeArray);
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
function scanConfigs(params = {}, config = configFromEnv()) {
  const values = [...normalizeArray(params.configs), ...normalizeArray(params.config)];
  if (!values.length && config.defaultConfig) values.push(config.defaultConfig);
  return Array.from(new Set(values));
}
function buildScanArgs(projectPath, params = {}, config = configFromEnv()) {
  const wantsJson = params.json !== false;
  const args = ["scan"];
  for (const cfg of scanConfigs(params, config)) args.push("--config", String(cfg));
  if (wantsJson) args.push("--json");
  if (config.metrics || params.metrics) args.push(`--metrics=${String(params.metrics || config.metrics)}`);
  for (const severity of normalizeArray(params.severity || params.severities)) args.push("--severity", severity);
  for (const include of normalizeArray(params.include || params.includes)) args.push("--include", include);
  for (const exclude of normalizeArray(params.exclude || params.excludes)) args.push("--exclude", exclude);
  if (params.errorOnFindings) args.push("--error");
  if (params.scanTimeoutSec) args.push("--timeout", String(positiveInt(params.scanTimeoutSec, 30, 3600)));
  if (params.useGitIgnore === false) args.push("--no-git-ignore");
  const files = normalizeArray(params.files || params.paths).map((f) => normalizeProjectFile(projectPath, f));
  if (files.length) args.push(...files);
  else args.push(".");
  return { args, wantsJson, files };
}
function runSemgrepSync(cwd, args, options = {}) {
  const config = configFromEnv(process.env, options);
  try {
    const stdout = execFileSync(config.bin, args, { cwd, encoding: "utf8", timeout: options.timeoutMs || config.advisoryTimeoutMs, maxBuffer: config.maxBuffer, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", SEMGREP_SEND_METRICS: config.metrics === "off" ? "off" : process.env.SEMGREP_SEND_METRICS }, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, code: 0, stdout: stripAnsi(stdout || ""), stderr: "", args, command: commandText(config.bin, args), cwd };
  } catch (error) {
    const stdout = stripAnsi(String(error?.stdout || ""));
    const stderr = stripAnsi(String(error?.stderr || error?.message || ""));
    const code = error?.code === "ENOENT" ? "ENOENT" : (error?.code || error?.status || "ERR");
    return { ok: false, code, stdout, stderr, args, command: commandText(config.bin, args), cwd, error };
  }
}
function configProbeStateFile(projectPath) { return path.join(projectPath, ".pi", "semgrep", "config-readiness.json"); }
function readConfigProbeState(projectPath) { try { return JSON.parse(fs.readFileSync(configProbeStateFile(projectPath), "utf8")); } catch { return { schemaVersion: 1, entries: {} }; } }
function writeConfigProbeState(projectPath, state) {
  try {
    const file = configProbeStateFile(projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch {}
}
function configPolicy(configs, metrics = "off", projectPath = process.cwd()) {
  for (const value of configs) {
    const config = String(value || "").trim();
    if (!config) return { ok: false, errorCode: "SEMGREP_CONFIG_EMPTY", category: "invalid-config", message: "Semgrep config must not be empty." };
    if (config === "auto" && String(metrics) === "off") return { ok: false, errorCode: "SEMGREP_AUTO_METRICS_CONFLICT", category: "policy", message: "Semgrep config 'auto' cannot be used while metrics are off. Use p/default (recommended), a tested registry pack, or a local YAML config; alternatively explicitly enable metrics." };
    const looksLocal = path.isAbsolute(config) || config.startsWith(".") || /\.ya?ml$/i.test(config);
    if (looksLocal) {
      const local = path.isAbsolute(config) ? config : path.resolve(projectPath, config);
      if (!fs.existsSync(local)) return { ok: false, errorCode: "SEMGREP_LOCAL_CONFIG_MISSING", category: "missing-config", message: `Semgrep local config does not exist: ${config}` };
    }
  }
  return { ok: true };
}
function configIdentity(projectPath, configs) {
  return configs.map((value) => {
    const local = path.isAbsolute(value) || value.startsWith(".") || /\.ya?ml$/i.test(value);
    if (!local) return { config: value };
    try { return { config: value, contentHash: sha256(fs.readFileSync(path.resolve(projectPath, value))) }; }
    catch { return { config: value, contentHash: null }; }
  });
}
function configProbeError(run) {
  const text = `${run?.stderr || ""}\n${run?.stdout || ""}`.toLowerCase();
  if (/timed out|timeout|sigterm|sigkill/.test(text) || run?.code === "ETIMEDOUT") return { errorCode: "SEMGREP_CONFIG_PROBE_TIMEOUT", category: "timeout" };
  if (/404|not found|no config|missing configuration|invalid registry|could not.*config|failed to download/.test(text) || Number(run?.code) === 7) return { errorCode: "SEMGREP_CONFIG_UNAVAILABLE", category: "unavailable-config" };
  if (/invalid rule|invalid yaml|parse error|schema/.test(text) || Number(run?.code) === 4 || Number(run?.code) === 5) return { errorCode: "SEMGREP_CONFIG_INVALID", category: "invalid-config" };
  return { errorCode: "SEMGREP_CONFIG_PROBE_FAILED", category: "config-probe" };
}
function semgrepConfigReadiness(cwd = process.cwd(), options = {}) {
  const projectPath = path.resolve(options.path || cwd);
  const config = configFromEnv(process.env, options);
  const configs = scanConfigs(options, config);
  const metrics = String(options.metrics || config.metrics || "off");
  const policy = configPolicy(configs, metrics, projectPath);
  const base = { checkedAt: new Date().toISOString(), configs, metrics, ready: false, status: "not-ready", errorCode: null, category: null, cached: false, command: null, guidance: [] };
  if (!policy.ok) return { ...base, status: "blocked", errorCode: policy.errorCode, category: policy.category, guidance: [policy.message] };
  const binary = executableInfo(config.bin);
  if (!binary.found) return { ...base, status: "unavailable", errorCode: "SEMGREP_NOT_INSTALLED", category: "missing-binary", guidance: [friendlyMissingBinaryMessage(config)] };
  const key = sha256({ bin: binary.path || config.bin, binaryHash: sha256(fs.readFileSync(binary.path)), configs: configIdentity(projectPath, configs), metrics }).slice(0, 24);
  const now = Date.now();
  if (!options.forceConfigProbe) {
    const memory = configProbeCache.get(`${projectPath}:${key}`);
    if (memory && Date.parse(memory.expiresAt) > now) return { ...memory, configs, metrics, cached: true };
    const persisted = readConfigProbeState(projectPath)?.entries?.[key];
    if (persisted && Date.parse(persisted.expiresAt) > now) {
      const cached = { ...base, ...persisted, configs, metrics, cached: true, guidance: persisted.ready ? [] : [`Cached Semgrep config preflight failure (${persisted.errorCode || "SEMGREP_CONFIG_NOT_READY"}). Choose p/default or a valid local config; retry after ${persisted.expiresAt} or force an explicit doctor probe.`] };
      configProbeCache.set(`${projectPath}:${key}`, cached);
      return cached;
    }
  }
  const args = ["scan"];
  for (const value of configs) args.push("--config", value);
  args.push("--validate", `--metrics=${metrics}`);
  const requestedProbeTimeout = Number(options.configProbeTimeoutMs || options.timeoutMs || config.configProbeTimeoutMs);
  const probeTimeoutMs = Math.min(config.configProbeTimeoutMs, Number.isFinite(requestedProbeTimeout) ? requestedProbeTimeout : config.configProbeTimeoutMs);
  const run = runSemgrepSync(projectPath, args, { ...options, timeoutMs: probeTimeoutMs });
  const failure = run.ok ? null : configProbeError(run);
  const ttl = run.ok ? config.configReadyTtlMs : config.configFailureTtlMs;
  const result = {
    ...base,
    ready: run.ok,
    status: run.ok ? "ready" : failure.category === "timeout" ? "timed-out" : "unavailable",
    errorCode: failure?.errorCode || null,
    category: failure?.category || null,
    command: run.command,
    expiresAt: new Date(now + ttl).toISOString(),
    guidance: run.ok ? [] : [`Semgrep config preflight failed (${failure.errorCode}). Verify ${configs.join(", ")} or choose p/default/local YAML before retrying.`],
  };
  configProbeCache.set(`${projectPath}:${key}`, result);
  const state = readConfigProbeState(projectPath);
  state.schemaVersion = 1;
  state.entries = { ...(state.entries || {}), [key]: { checkedAt: result.checkedAt, expiresAt: result.expiresAt, ready: result.ready, status: result.status, errorCode: result.errorCode, category: result.category } };
  writeConfigProbeState(projectPath, state);
  return result;
}
function normalizeFindingPath(projectPath, value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw) return raw;
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  return isInside(projectPath, abs) ? path.relative(projectPath, abs).replace(/\\/g, "/") : raw;
}
function normalizeFinding(result, projectPath) {
  const extra = result?.extra || {};
  const metadata = extra.metadata || {};
  const severity = String(extra.severity || result?.severity || metadata.severity || "INFO").toUpperCase();
  const item = {
    checkId: result?.check_id || result?.checkId || null,
    path: normalizeFindingPath(projectPath, result?.path || result?.file || ""),
    start: result?.start ? { line: result.start.line, col: result.start.col } : undefined,
    end: result?.end ? { line: result.end.line, col: result.end.col } : undefined,
    severity,
    message: extra.message || result?.message || "",
    confidence: metadata.confidence || undefined,
    category: metadata.category || undefined,
    cwe: metadata.cwe || undefined,
    owasp: metadata.owasp || undefined,
    references: Array.isArray(metadata.references) ? metadata.references.slice(0, 5) : undefined,
  };
  for (const key of Object.keys(item)) if (item[key] == null || item[key] === "" || (Array.isArray(item[key]) && !item[key].length)) delete item[key];
  return item;
}
function summarizeFindings(findings = [], parsed = null) {
  const severityCounts = {};
  const checkCounts = {};
  const files = new Set();
  for (const finding of findings) {
    const severity = finding.severity || "INFO";
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    if (finding.checkId) checkCounts[finding.checkId] = (checkCounts[finding.checkId] || 0) + 1;
    if (finding.path) files.add(finding.path);
  }
  return {
    findings: findings.length,
    files: files.size,
    filesWithFindings: Array.from(files).sort(),
    severityCounts,
    topChecks: Object.entries(checkCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([checkId, count]) => ({ checkId, count })),
    errors: Array.isArray(parsed?.errors) ? parsed.errors.length : 0,
  };
}
function parseSemgrepOutput(output, projectPath, options = {}) {
  const text = stripAnsi(output || "").trim();
  if (!text) return { parsed: null, findings: [], summary: summarizeFindings([], null), parseError: null };
  try {
    const parsed = JSON.parse(text);
    const all = Array.isArray(parsed?.results) ? parsed.results.map((r) => normalizeFinding(r, projectPath)).filter((f) => f.path || f.checkId || f.message) : [];
    const max = positiveInt(options.maxFindings, DEFAULT_MAX_FINDINGS, 5000);
    const findings = all.slice().sort((a, b) => severityScore(b.severity) - severityScore(a.severity)).slice(0, max);
    const summary = summarizeFindings(all, parsed);
    const diagnostics = normalizeDiagnostics(findings, { provider: "semgrep", operation: "scan", freshness: "fresh", gatingSafe: true }).diagnostics;
    if (all.length > findings.length) summary.truncatedFindings = { returned: findings.length, total: all.length };
    return { parsed, findings, diagnostics, summary, parseError: null };
  } catch (e) {
    return { parsed: null, findings: [], summary: summarizeFindings([], null), parseError: String(e?.message || e) };
  }
}
function classifySemgrepScan(run, parsed, options = {}) {
  const code = run?.ok ? 0 : Number.isFinite(Number(run?.code)) ? Number(run.code) : run?.code || "ERR";
  const findingExit = !run?.ok && Number(code) === 1 && options.errorOnFindings === true && !parsed?.parseError && Number(parsed?.summary?.findings || 0) > 0;
  const completed = Boolean(run?.ok || findingExit);
  const engineErrors = Number(parsed?.summary?.errors || 0);
  const parseFailure = options.json !== false && Boolean(parsed?.parseError);
  const infrastructureFailure = !completed || engineErrors > 0 || parseFailure;
  const findingsPresent = Number(parsed?.summary?.findings || 0) > 0;
  const status = infrastructureFailure ? "infrastructure-failed" : findingsPresent ? "findings" : "clean";
  return { status, completed, findingsPresent, infrastructureFailure, findingExit, processExitCode: code, engineErrors, parseFailure, gatingSafe: completed && !infrastructureFailure };
}
function readinessSummary(binary, configReadiness, scan = null) {
  return { binary: Boolean(binary?.found), config: Boolean(configReadiness?.ready), scan: Boolean(scan?.completed), binaryStatus: binary?.found ? "ready" : "unavailable", configStatus: configReadiness?.status || "not-checked", scanStatus: scan?.status || "not-run" };
}
const SEMGREP_RELIABILITY_SCHEMA_VERSION = 1;
const SEMGREP_RELIABILITY_POLICY_VERSION = "semgrep-infrastructure-v1";
function reliabilityStateFile(projectPath) { return path.join(projectPath, ".pi", "semgrep", "reliability.json"); }
function readReliabilityState(projectPath) { try { return JSON.parse(fs.readFileSync(reliabilityStateFile(projectPath), "utf8")); } catch { return { schemaVersion: SEMGREP_RELIABILITY_SCHEMA_VERSION, policyVersion: SEMGREP_RELIABILITY_POLICY_VERSION, cohorts: {} }; } }
function writeReliabilityState(projectPath, state) {
  const file = reliabilityStateFile(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if (fs.lstatSync(file).isSymbolicLink()) return false; } catch {}
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  return true;
}
function semgrepReliabilityIdentity(projectPath, config, params = {}) {
  const binary = executableInfo(config.bin);
  let binaryHash = null;
  try { binaryHash = sha256(fs.readFileSync(binary.path)); } catch {}
  let adapterSourceHash = null;
  try { adapterSourceHash = sha256(fs.readFileSync(__filename)); } catch {}
  const configHash = sha256({ configs: configIdentity(projectPath, scanConfigs(params, config)), metrics: String(params.metrics || config.metrics || "off"), maxFindings: config.maxFindings });
  const fields = { schemaVersion: SEMGREP_RELIABILITY_SCHEMA_VERSION, policyVersion: SEMGREP_RELIABILITY_POLICY_VERSION, adapterSourceHash, binaryHash, configHash };
  const eligible = Boolean(adapterSourceHash && binaryHash && configHash);
  return { ...fields, eligible, cohortKey: eligible ? sha256(fields).slice(0, 32) : null };
}
function semgrepReliabilityReport(projectPath, options = {}) {
  const config = options.configObject || configFromEnv(process.env, options);
  const identity = options.identity || semgrepReliabilityIdentity(projectPath, config, options);
  const state = readReliabilityState(projectPath);
  const cohort = identity.cohortKey ? state.cohorts?.[identity.cohortKey] : null;
  const days = Object.entries(cohort?.days || {}).sort(([a], [b]) => a.localeCompare(b));
  const totals = days.reduce((out, [, row]) => { for (const key of ["attempts", "clean", "findings", "infrastructureFailed"]) out[key] += Number(row[key] || 0); return out; }, { attempts: 0, clean: 0, findings: 0, infrastructureFailed: 0 });
  const infrastructureErrorRate = totals.attempts ? totals.infrastructureFailed / totals.attempts : null;
  const enoughDays = days.length >= 14;
  return { schemaVersion: SEMGREP_RELIABILITY_SCHEMA_VERSION, policyVersion: SEMGREP_RELIABILITY_POLICY_VERSION, cohortKey: identity.cohortKey, exactCohort: Boolean(identity.eligible && cohort), observedDays: days.length, firstObservedDay: days[0]?.[0] || null, lastObservedDay: days.at(-1)?.[0] || null, ...totals, infrastructureErrorRate, bar: { minimumObservedDays: 14, maximumInfrastructureErrorRateExclusive: 0.05 }, verdict: !enoughDays ? "insufficient-data" : infrastructureErrorRate < 0.05 ? "pass" : "fail" };
}
function recordSemgrepReliability(projectPath, config, params, scan, options = {}) {
  if (!scan || scan.status === "not-run") return semgrepReliabilityReport(projectPath, { ...params, configObject: config });
  const identity = semgrepReliabilityIdentity(projectPath, config, params);
  if (!identity.eligible) return semgrepReliabilityReport(projectPath, { ...params, configObject: config, identity });
  const at = options.at instanceof Date ? options.at : options.at ? new Date(options.at) : new Date();
  if (!Number.isFinite(at.getTime())) return semgrepReliabilityReport(projectPath, { ...params, configObject: config, identity });
  const day = at.toISOString().slice(0, 10);
  const state = readReliabilityState(projectPath);
  const cohort = state.cohorts?.[identity.cohortKey] || { identity, days: {} };
  const row = cohort.days[day] || { attempts: 0, clean: 0, findings: 0, infrastructureFailed: 0 };
  row.attempts++;
  if (scan.infrastructureFailure) row.infrastructureFailed++;
  else if (scan.findingsPresent) row.findings++;
  else row.clean++;
  cohort.days[day] = row;
  cohort.days = Object.fromEntries(Object.entries(cohort.days).sort(([a], [b]) => a.localeCompare(b)).slice(-90));
  state.schemaVersion = SEMGREP_RELIABILITY_SCHEMA_VERSION;
  state.policyVersion = SEMGREP_RELIABILITY_POLICY_VERSION;
  state.cohorts = { ...(state.cohorts || {}), [identity.cohortKey]: cohort };
  const cohortKeys = Object.keys(state.cohorts);
  for (const key of cohortKeys.slice(0, Math.max(0, cohortKeys.length - 8))) delete state.cohorts[key];
  writeReliabilityState(projectPath, state);
  return semgrepReliabilityReport(projectPath, { ...params, configObject: config, identity });
}
function semgrepScan(cwd = process.cwd(), files = [], options = {}) {
  const config = configFromEnv(process.env, options);
  const projectPath = path.resolve(options.path || cwd);
  const params = { ...options, files };
  const bin = executableInfo(config.bin);
  if (!config.enabled || !config.advisory) return { ok: false, skipped: true, reason: "disabled", scanStatus: "not-run", infrastructureFailure: false, findings: [], summary: summarizeFindings([]), readiness: readinessSummary(bin, null) };
  const policy = configPolicy(scanConfigs(options, config), options.metrics || config.metrics, projectPath);
  if (!policy.ok) { const configReadiness = { ready: false, status: "blocked", errorCode: policy.errorCode, category: policy.category, guidance: [policy.message] }; return { ok: false, skipped: false, reason: "config-not-ready", errorCode: policy.errorCode, scanStatus: "not-run", infrastructureFailure: false, configReadiness, findings: [], summary: summarizeFindings([]), readiness: readinessSummary(bin, configReadiness) }; }
  if (!bin.found) return { ok: false, skipped: true, reason: "missing-binary", scanStatus: "not-run", infrastructureFailure: false, findings: [], summary: summarizeFindings([]), binary: bin, readiness: readinessSummary(bin, null) };
  const configReadiness = semgrepConfigReadiness(projectPath, { ...options, path: projectPath });
  if (!configReadiness.ready) return { ok: false, skipped: false, reason: "config-not-ready", errorCode: configReadiness.errorCode, scanStatus: "not-run", infrastructureFailure: false, configReadiness, findings: [], summary: summarizeFindings([]), readiness: readinessSummary(bin, configReadiness) };
  const { args, wantsJson } = buildScanArgs(projectPath, params, config);
  const run = runSemgrepSync(projectPath, args, { ...options, timeoutMs: options.timeoutMs || config.advisoryTimeoutMs });
  const parsed = parseSemgrepOutput(run.stdout || run.stderr || "", projectPath, { maxFindings: config.maxFindings });
  const scan = classifySemgrepScan(run, parsed, { ...params, json: wantsJson });
  const reliability = recordSemgrepReliability(projectPath, config, params, scan, { at: options.reliabilityAt });
  return { ok: scan.completed && !scan.infrastructureFailure, skipped: false, reason: scan.infrastructureFailure ? run.code === "ENOENT" ? "missing-binary" : "infrastructure-failed" : null, errorCode: scan.infrastructureFailure ? "SEMGREP_SCAN_INFRASTRUCTURE_FAILED" : null, scanStatus: scan.status, scan, infrastructureFailure: scan.infrastructureFailure, gatingSafe: scan.gatingSafe, degradation: scan.infrastructureFailure ? { code: "semgrep_scan_infrastructure_failed", message: "Semgrep did not complete a reliable scan; inspect bounded run diagnostics.", retryable: true } : null, configReadiness, readiness: readinessSummary(bin, configReadiness, scan), reliability, findings: parsed.findings, diagnostics: parsed.diagnostics || [], summary: parsed.summary, parseError: parsed.parseError, run };
}
function semgrepProjectSnapshot(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  const binary = executableInfo(config.bin);
  const snapshot = { enabled: config.enabled, advisory: config.advisory, binary, binaryReady: false, configReadiness: null, configReady: false, scanReady: false, projectPath: path.resolve(options.path || cwd), ready: false, version: null, errorCode: null, statusText: "", guidance: [] };
  snapshot.reliability = semgrepReliabilityReport(snapshot.projectPath, { ...options, configObject: config });
  if (!config.enabled) { snapshot.guidance.push("Semgrep extension disabled with PI_SEMGREP=0."); return snapshot; }
  if (!binary.found) { snapshot.errorCode = "SEMGREP_NOT_INSTALLED"; snapshot.guidance.push(friendlyMissingBinaryMessage(config)); return snapshot; }
  const run = runSemgrepSync(snapshot.projectPath, ["--version"], { ...options, timeoutMs: options.timeoutMs || config.advisoryTimeoutMs });
  snapshot.statusText = `${run.stdout}\n${run.stderr}`.trim();
  if (!run.ok) { snapshot.errorCode = "SEMGREP_COMMAND_FAILED"; snapshot.guidance.push(`Semgrep version check failed: ${run.stderr || run.stdout || run.code}`); return snapshot; }
  snapshot.binaryReady = true;
  snapshot.version = snapshot.statusText || null;
  snapshot.configReadiness = semgrepConfigReadiness(snapshot.projectPath, { ...options, path: snapshot.projectPath });
  snapshot.configReady = Boolean(snapshot.configReadiness.ready);
  snapshot.scanReady = Boolean(snapshot.binaryReady && snapshot.configReady);
  snapshot.ready = snapshot.scanReady;
  snapshot.reliability = semgrepReliabilityReport(snapshot.projectPath, { ...options, configObject: config });
  if (!snapshot.configReady) {
    snapshot.errorCode = snapshot.configReadiness.errorCode || "SEMGREP_CONFIG_NOT_READY";
    snapshot.guidance.push(...(snapshot.configReadiness.guidance || []));
  }
  return snapshot;
}
function semgrepDoctor(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  let projectPath = path.resolve(cwd);
  const risks = [];
  const recommendations = [];
  try { projectPath = resolveProjectPath({ cwd }, options.path, config); } catch (e) { risks.push(String(e?.message || e)); }
  const binary = executableInfo(config.bin);
  const doctor = { generatedAt: new Date().toISOString(), enabled: config.enabled, projectPath, cwd, binary, binaryReady: false, configReadiness: null, configReady: false, scanReady: false, version: null, ready: false, status: null, env: envReport(), advisoryBoundary: { localFirst: true, nonBlockingByDefault: true, modelReasoning: "advisory static-analysis findings only; no private reasoning storage" }, risks, recommendations };
  doctor.reliability = semgrepReliabilityReport(projectPath, { ...options, configObject: config });
  if (!config.enabled) { recommendations.push("Set PI_SEMGREP=1 or unset PI_SEMGREP to enable the adapter."); return doctor; }
  if (!binary.found) { risks.push(friendlyMissingBinaryMessage(config)); recommendations.push("Install Semgrep or set PI_SEMGREP_BIN to its executable path. A Docker wrapper in ~/.local/bin/semgrep is supported."); return doctor; }
  const version = runSemgrepSync(projectPath, ["--version"], { ...options, timeoutMs: Math.min(config.advisoryTimeoutMs, options.timeoutMs || config.advisoryTimeoutMs || 3000) });
  doctor.status = { ok: version.ok, command: version.command, stdout: version.stdout, stderr: version.stderr, code: version.code };
  if (version.ok) {
    doctor.binaryReady = true;
    doctor.version = (version.stdout || version.stderr || "").trim() || null;
    doctor.configReadiness = semgrepConfigReadiness(projectPath, { ...options, path: projectPath });
    doctor.configReady = Boolean(doctor.configReadiness.ready);
    doctor.scanReady = Boolean(doctor.binaryReady && doctor.configReady);
    doctor.ready = doctor.scanReady;
    doctor.reliability = semgrepReliabilityReport(projectPath, { ...options, configObject: config });
    if (!doctor.configReady) risks.push(...(doctor.configReadiness.guidance || [`Semgrep config is not ready (${doctor.configReadiness.errorCode || "unknown"}).`]));
  } else risks.push(`Semgrep version check failed: ${version.stderr || version.stdout || version.code}`);
  if (!config.allowOutsideCwd) recommendations.push("Explicit Semgrep project paths are confined to cwd; set PI_SEMGREP_ALLOW_OUTSIDE=1 only when needed.");
  if (config.metrics === "off") recommendations.push("Semgrep metrics are disabled by default via PI_SEMGREP_METRICS=off for local-first scans.");
  if (config.defaultConfig === "auto") recommendations.push(config.metrics === "off" ? "Config 'auto' is blocked while metrics are off; set PI_SEMGREP_CONFIG=p/default or choose a tested local/registry config." : "Config 'auto' is network-dependent; prefer PI_SEMGREP_CONFIG=p/default or another tested reproducible config.");
  recommendations.push("Use /semgrep-codegraph after edits to combine static findings with CodeGraph affected-test hints when both adapters are available.");
  return doctor;
}
function formatDoctor(doctor) {
  const lines = [
    `Semgrep doctor ${doctor.generatedAt}`,
    `enabled: ${doctor.enabled}`,
    `binary: ${doctor.binary?.found ? doctor.binary.path : `missing (${doctor.binary?.bin})`}`,
    `project: ${doctor.projectPath}`,
    `binary ready: ${Boolean(doctor.binaryReady ?? doctor.binary?.found)}`,
    `config ready: ${Boolean(doctor.configReady)}`,
    `scan ready: ${Boolean(doctor.scanReady ?? doctor.ready)}`,
    `ready: ${doctor.ready}`,
  ];
  if (doctor.version) lines.push(`version: ${doctor.version}`);
  if (doctor.reliability) lines.push(`infrastructure reliability: ${doctor.reliability.verdict} (${doctor.reliability.infrastructureFailed}/${doctor.reliability.attempts} over ${doctor.reliability.observedDays}/14 observed days)`);
  if (doctor.risks?.length) lines.push("", "Risks:", ...doctor.risks.map((r) => `- ${r}`));
  if (doctor.recommendations?.length) lines.push("", "Recommendations:", ...doctor.recommendations.map((r) => `- ${r}`));
  return lines.join("\n");
}
function splitArgs(input) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input || ""))) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"));
  return tokens;
}
function parseCliArgs(input) {
  const tokens = splitArgs(input);
  const opts = {};
  const positional = [];
  const pushOpt = (key, value) => { opts[key] = [...normalizeArray(opts[key]), value]; };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];
    if (token === "--path" || token === "-p") opts.path = next();
    else if (token.startsWith("--path=")) opts.path = token.slice("--path=".length);
    else if (token === "--config" || token === "-c") pushOpt("configs", next());
    else if (token.startsWith("--config=")) pushOpt("configs", token.slice("--config=".length));
    else if (token === "--severity") pushOpt("severity", next());
    else if (token.startsWith("--severity=")) pushOpt("severity", token.slice("--severity=".length));
    else if (token === "--include") pushOpt("include", next());
    else if (token.startsWith("--include=")) pushOpt("include", token.slice("--include=".length));
    else if (token === "--exclude") pushOpt("exclude", next());
    else if (token.startsWith("--exclude=")) pushOpt("exclude", token.slice("--exclude=".length));
    else if (token === "--timeout-ms") opts.timeoutMs = next();
    else if (token.startsWith("--timeout-ms=")) opts.timeoutMs = token.slice("--timeout-ms=".length);
    else if (token === "--scan-timeout") opts.scanTimeoutSec = next();
    else if (token.startsWith("--scan-timeout=")) opts.scanTimeoutSec = token.slice("--scan-timeout=".length);
    else if (token === "--codegraph-timeout-ms") opts.codegraphTimeoutMs = next();
    else if (token.startsWith("--codegraph-timeout-ms=")) opts.codegraphTimeoutMs = token.slice("--codegraph-timeout-ms=".length);
    else if (token === "--depth" || token === "-d") opts.depth = next();
    else if (token.startsWith("--depth=")) opts.depth = token.slice("--depth=".length);
    else if (token === "--metrics") opts.metrics = next();
    else if (token.startsWith("--metrics=")) opts.metrics = token.slice("--metrics=".length);
    else if (token === "--no-metrics") opts.metrics = "off";
    else if (token === "--verbose") opts.verbose = true;
    else if (token === "--budget-tokens") opts.budgetTokens = Number(next());
    else if (token.startsWith("--budget-tokens=")) opts.budgetTokens = Number(token.slice("--budget-tokens=".length));
    else if (token === "--error") opts.errorOnFindings = true;
    else if (token === "--no-git-ignore") opts.useGitIgnore = false;
    else if (token === "--scan-all") opts.scanAll = true;
    else if (token.startsWith("-")) throw new Error(`Unknown Semgrep option: ${token}; use --verbose to expand provider output.`);
    else positional.push(token);
  }
  return { opts, positional };
}
function semgrepCodegraphAdvisory(cwd = process.cwd(), files = [], options = {}) {
  const projectPath = path.resolve(options.path || cwd);
  const targetFiles = normalizeArray(files).length ? normalizeArray(files) : (options.scanAll ? [] : gitChangedFiles(projectPath));
  const shouldScan = options.scanAll || targetFiles.length > 0;
  const semgrep = shouldScan ? semgrepScan(projectPath, targetFiles, { ...options, path: projectPath }) : { ok: false, skipped: true, reason: "no-files", findings: [], summary: summarizeFindings([]) };
  const findingFiles = Array.from(new Set((semgrep.findings || []).map((f) => f.path).filter(Boolean)));
  const graphFiles = Array.from(new Set([...targetFiles, ...findingFiles]));
  let codegraph = { ok: false, skipped: true, reason: graphFiles.length ? "disabled" : "no-files", tests: [] };
  if (options.codegraph !== false && graphFiles.length) {
    const codegraphOptions = { ...(options.codegraphOptions || {}), timeoutMs: options.codegraphTimeoutMs || options.timeoutMs || 3000, depth: options.depth };
    if (options.codegraphBin) codegraphOptions.bin = options.codegraphBin;
    codegraph = codegraphAffectedTests(projectPath, graphFiles, codegraphOptions);
  }
  const affectedTests = Array.from(new Set(codegraph.tests || []));
  const supplementStatus = codegraph.ok ? "completed-advisory" : codegraph.skipped ? "skipped" : "supplement-failed";
  const recommendations = [];
  if (semgrep.summary?.findings) recommendations.push(`Review ${semgrep.summary.findings} Semgrep finding(s) across ${semgrep.summary.files} file(s).`);
  if (semgrep.infrastructureFailure) recommendations.push(`Semgrep infrastructure failed (${semgrep.errorCode || semgrep.reason || "unavailable"}); CodeGraph guidance remains a separate advisory supplement.`);
  else if (!semgrep.ok && !semgrep.skipped) recommendations.push(`Semgrep was not run (${semgrep.errorCode || semgrep.reason || "not-ready"}); resolve binary/config readiness independently.`);
  if (supplementStatus === "supplement-failed") recommendations.push("CodeGraph affected-test supplementation failed separately; the Semgrep scan result is unchanged.");
  if (affectedTests.length) recommendations.push(`Run affected tests suggested by CodeGraph: ${affectedTests.slice(0, 5).join(", ")}${affectedTests.length > 5 ? "…" : ""}`);
  if (semgrep.ok && !semgrep.summary?.findings && !affectedTests.length) recommendations.push("No Semgrep findings or CodeGraph affected-test hints were available for the selected files.");
  return { generatedAt: new Date().toISOString(), files: targetFiles, semgrep, codegraph: { ok: codegraph.ok, skipped: codegraph.skipped, status: supplementStatus, reason: codegraph.reason, tests: affectedTests, errorCode: codegraph.run?.code, freshness: codegraph.freshness, revision: codegraph.revision, pendingChanges: codegraph.pendingChanges, degradation: codegraph.degradation, gatingSafe: false, advisory: true }, supplementFailure: supplementStatus === "supplement-failed", findingFiles, affectedTests, recommendations };
}

function createSemgrepAdapter(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  const affectedTests = overrides.codegraphAffectedTests || codegraphAffectedTests;
  async function runSemgrep(ctx, projectPath, args, signal, timeoutMs = config.timeoutMs) {
    return new Promise((resolvePromise, reject) => {
      execFile(config.bin, args, {
        cwd: projectPath,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: config.maxBuffer,
        signal,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", SEMGREP_SEND_METRICS: config.metrics === "off" ? "off" : process.env.SEMGREP_SEND_METRICS },
      }, (error, stdout = "", stderr = "") => {
        const result = { ok: !error, code: error ? (error.code || error.signal || error.status || 1) : 0, stdout: stripAnsi(String(stdout || "")), stderr: stripAnsi(String(stderr || "")), args, command: commandText(config.bin, args), cwd: projectPath || ctx.cwd };
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (error?.code === "ENOENT") return reject(semgrepError(friendlyMissingBinaryMessage(config), "SEMGREP_NOT_INSTALLED", result));
        if (!error) return resolvePromise(result);
        const message = [`Semgrep command failed: ${result.command}`, error.code || error.signal ? `exit=${error.code || "?"} signal=${error.signal || "-"}` : "", output || error.message || String(error)].filter(Boolean).join("\n");
        reject(semgrepError(message, "SEMGREP_COMMAND_FAILED", result));
      });
    });
  }
  function readinessFooter(result) {
    const readiness = result.readiness || {};
    const lines = [`readiness: binary=${readiness.binaryStatus || "unknown"} config=${readiness.configStatus || "unknown"} scan=${result.scanStatus || "unknown"}`];
    if (result.infrastructureFailure) lines.push(`infrastructure failure: ${result.errorCode || result.reason || "scan did not complete"}`);
    else if (!result.ok && !result.skipped) lines.push(`not run: ${result.reason || result.errorCode || "not ready"}`);
    return lines;
  }
  async function status(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const details = semgrepProjectSnapshot(projectPath, { ...params, ...config, path: projectPath });
    return { content: [{ type: "text", text: formatDoctor({ ...details, generatedAt: new Date().toISOString(), cwd: ctx.cwd, risks: details.errorCode ? details.guidance : [], recommendations: details.guidance || [] }) }], details };
  }
  async function executeStructuredScan(ctx, projectPath, params, signal) {
    const binary = executableInfo(config.bin);
    const configReadiness = semgrepConfigReadiness(projectPath, { ...config, ...params, path: projectPath });
    if (!configReadiness.ready) return { ok: false, skipped: false, reason: "config-not-ready", errorCode: configReadiness.errorCode || "SEMGREP_CONFIG_NOT_READY", scanStatus: "not-run", scan: null, infrastructureFailure: false, gatingSafe: false, configReadiness, readiness: readinessSummary(binary, configReadiness), findings: [], diagnostics: [], summary: summarizeFindings([]), parseError: null, run: null };
    // Native retrieval needs structured findings regardless of display mode.
    // Provider formatting must never turn unparsed text into a clean scan.
    const { args, wantsJson } = buildScanArgs(projectPath, { ...params, json: true }, config);
    let run;
    try { run = await runSemgrep(ctx, projectPath, args, signal, timeout(params.timeoutMs, config)); }
    catch (error) { run = { ok: false, code: error?.details?.code || error?.code || "ERR", stdout: error?.details?.stdout || "", stderr: error?.details?.stderr || "", args, command: error?.details?.command || commandText(config.bin, args), cwd: projectPath }; }
    const parsed = parseSemgrepOutput(run.stdout || run.stderr || "", projectPath, { maxFindings: config.maxFindings });
    const scan = classifySemgrepScan(run, parsed, { ...params, json: wantsJson });
    const reliability = recordSemgrepReliability(projectPath, config, params, scan, { at: params.reliabilityAt });
    return { ok: scan.completed && !scan.infrastructureFailure, skipped: false, reason: scan.infrastructureFailure ? "infrastructure-failed" : null, errorCode: scan.infrastructureFailure ? "SEMGREP_SCAN_INFRASTRUCTURE_FAILED" : null, scanStatus: scan.status, scan, infrastructureFailure: scan.infrastructureFailure, gatingSafe: scan.gatingSafe, degradation: scan.infrastructureFailure ? { code: "semgrep_scan_infrastructure_failed", message: "Semgrep did not complete a reliable scan; inspect bounded run diagnostics.", retryable: true } : null, configReadiness, readiness: readinessSummary(binary, configReadiness, scan), reliability, findings: parsed.findings, diagnostics: parsed.diagnostics || [], summary: parsed.summary, parseError: parsed.parseError, run, wantsJson };
  }
  async function scan(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const started = Date.now();
    const result = await executeStructuredScan(ctx, projectPath, params, signal);
    const envelope = semgrepScanEnvelope({ findings: result.findings, summary: result.summary, scanStatus: result.scanStatus, metadata: { operation: "scan", freshness: "fresh", gatingSafe: result.gatingSafe === true, degradation: result.degradation }, elapsedMs: Date.now() - started });
    const raw = stripAnsi(result.run?.stdout || result.run?.stderr || JSON.stringify(result, null, 2));
    const details = {
      generatedAt: new Date().toISOString(),
      operation: "scan",
      projectPath,
      command: result.run?.command,
      args: result.run?.args,
      stdoutBytes: Buffer.byteLength(raw),
      stderr: stripAnsi(result.run?.stderr || ""),
      reason: result.reason,
      skipped: result.skipped,
      errorCode: result.errorCode,
      ...envelope,
      ok: result.ok,
      scanStatus: result.scanStatus,
      scan: result.scan,
      infrastructureFailure: result.infrastructureFailure,
      gatingSafe: result.gatingSafe,
      degradation: result.degradation,
      readiness: result.readiness,
      reliability: result.reliability,
      configReadiness: result.configReadiness,
      summary: result.summary,
      findings: result.findings,
      diagnostics: result.diagnostics,
      parseError: result.parseError,
      // The complete provider output stays in details so a truncated model-facing
      // view never destroys the evidence it was derived from.
      raw,
    };
    // The raw scan payload stays in details; the model-facing view is the bounded
    // finding list plus readiness unless the caller explicitly asks for raw text.
    const text = params.verbose === true ? raw : renderSemgrep(envelope, { operation: "semgrep_scan", budgetTokens: params.budgetTokens, footer: readinessFooter(result) });
    Object.assign(details, envelope);
    recordResultRendering(details, text, raw, { ...params, operation: "semgrep_scan" });
    return { content: [{ type: "text", text }], details };
  }
  async function codegraph(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const files = normalizeArray(params.files);
    const targetFiles = files.length || params.scanAll ? files : gitChangedFiles(projectPath);
    const shouldScan = params.scanAll || targetFiles.length > 0;
    const semgrep = shouldScan ? await executeStructuredScan(ctx, projectPath, { ...params, files: targetFiles }, signal) : { ok: false, skipped: true, reason: "no-files", scanStatus: "not-run", scan: null, infrastructureFailure: false, gatingSafe: false, readiness: readinessSummary(executableInfo(config.bin), null), findings: [], summary: summarizeFindings([]) };
    const findingFiles = Array.from(new Set((semgrep.findings || []).map((f) => f.path).filter(Boolean)));
    const graphFiles = Array.from(new Set([...targetFiles, ...findingFiles]));
    let graph = { ok: false, skipped: true, reason: graphFiles.length ? "disabled" : "no-files", tests: [] };
    if (params.codegraph !== false && graphFiles.length) graph = affectedTests(projectPath, graphFiles, { timeoutMs: params.codegraphTimeoutMs || 3000, depth: params.depth });
    const supplementStatus = graph.ok ? "completed-advisory" : graph.skipped ? "skipped" : "supplement-failed";
    const envelope = semgrepCodegraphEnvelope({ findings: semgrep.findings, summary: semgrep.summary, scanStatus: semgrep.scanStatus, graph: { ...graph, status: supplementStatus }, files: targetFiles, metadata: { operation: "codegraph", freshness: "fresh", gatingSafe: false, degradation: semgrep.degradation } });
    const details = { generatedAt: new Date().toISOString(), projectPath, files: targetFiles, ...envelope, semgrep: { ok: semgrep.ok, skipped: semgrep.skipped, reason: semgrep.reason, errorCode: semgrep.errorCode, scanStatus: semgrep.scanStatus, scan: semgrep.scan, infrastructureFailure: semgrep.infrastructureFailure, gatingSafe: semgrep.gatingSafe, degradation: semgrep.degradation, readiness: semgrep.readiness, reliability: semgrep.reliability, configReadiness: semgrep.configReadiness, summary: semgrep.summary, findings: semgrep.findings, diagnostics: semgrep.diagnostics, parseError: semgrep.parseError }, codegraph: { ok: graph.ok, skipped: graph.skipped, status: supplementStatus, reason: graph.reason, tests: graph.tests || [], errorCode: graph.run?.code, freshness: graph.freshness, revision: graph.revision, pendingChanges: graph.pendingChanges, degradation: graph.degradation, gatingSafe: false, advisory: true }, supplementFailure: supplementStatus === "supplement-failed", findingFiles, affectedTests: graph.tests || [] };
    details.recommendations = [];
    if (details.semgrep.summary?.findings) details.recommendations.push(`Review ${details.semgrep.summary.findings} Semgrep finding(s) across ${details.semgrep.summary.files} file(s).`);
    if (details.semgrep.infrastructureFailure) details.recommendations.push(`Semgrep infrastructure failed (${details.semgrep.errorCode || details.semgrep.reason || "unavailable"}); CodeGraph guidance remains a separate advisory supplement.`);
    else if (!details.semgrep.ok && !details.semgrep.skipped) details.recommendations.push(`Semgrep was not run (${details.semgrep.errorCode || details.semgrep.reason || "not-ready"}); resolve binary/config readiness independently.`);
    if (details.supplementFailure) details.recommendations.push("CodeGraph affected-test supplementation failed separately; the Semgrep scan result is unchanged.");
    if (details.affectedTests.length) details.recommendations.push(`Run affected tests suggested by CodeGraph: ${details.affectedTests.slice(0, 5).join(", ")}${details.affectedTests.length > 5 ? "…" : ""}`);
    if (!details.recommendations.length) details.recommendations.push("No Semgrep findings or CodeGraph affected-test hints were available for the selected files.");
    details.semgrep.raw = stripAnsi(semgrep.run?.stdout || semgrep.run?.stderr || "");
    details.semgrep.stderr = stripAnsi(semgrep.run?.stderr || "");
    details.semgrep.command = semgrep.run?.command;
    details.semgrep.args = semgrep.run?.args;
    Object.assign(details.codegraph, graph, { status: supplementStatus, gatingSafe: false, advisory: true });
    const raw = JSON.stringify({ semgrep: details.semgrep, codegraph: details.codegraph }, null, 2);
    const text = params.verbose === true ? raw : renderSemgrepCodegraph(envelope, { operation: "semgrep_codegraph", budgetTokens: params.budgetTokens, footer: [...readinessFooter(semgrep), ...details.recommendations.slice(0, 3)] });
    Object.assign(details, envelope);
    recordResultRendering(details, text, raw, { ...params, operation: "semgrep_codegraph" });
    return { content: [{ type: "text", text }], details };
  }
  async function doctor(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const details = semgrepDoctor(projectPath, { ...params, ...config, path: projectPath });
    return { content: [{ type: "text", text: formatDoctor(details) }], details };
  }
  return { config, runSemgrep, status, scan, codegraph, doctor, resolveProjectPath: (ctx, p) => resolveProjectPath(ctx, p, config), normalizeProjectFile, gitChangedFiles };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FINDINGS,
  SEMGREP_RELIABILITY_SCHEMA_VERSION,
  SEMGREP_RELIABILITY_POLICY_VERSION,
  clampNumber,
  configFromEnv,
  createSemgrepAdapter,
  semgrepScan,
  semgrepCodegraphAdvisory,
  semgrepConfigReadiness,
  configPolicy,
  semgrepProjectSnapshot,
  semgrepDoctor,
  formatDoctor,
  parseSemgrepOutput,
  classifySemgrepScan,
  readinessSummary,
  semgrepReliabilityIdentity,
  semgrepReliabilityReport,
  recordSemgrepReliability,
  summarizeFindings,
  buildScanArgs,
  normalizeProjectFile,
  resolveProjectPath,
  parseCliArgs,
  splitArgs,
  stripAnsi,
  truncateHead,
  formatSize,
  friendlyMissingBinaryMessage,
  executableInfo,
  gitChangedFiles,
};
