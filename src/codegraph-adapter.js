"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { readChangeSet, readChangeSetAsync, runGitAsync, workingTreeRevision, revisionId, fileContentIdentity, sourceKindForPath } = require("./code-context-revision.js");
const { assertProjectScope, projectScope, owningRoot } = require("./project-scope.js");
const {
  codegraphQueryEnvelope,
  codegraphAffectedEnvelope,
  codegraphContextEnvelope,
  renderCodegraphContext,
  renderCodegraphAffected,
  renderWithinBudget,
  renderCliText,
  recordResultRendering,
} = require("./provider-result-rendering.js");

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const STATE_DIR = path.join(".pi", "codegraph");
const MAX_STATE_EVENTS = 30;
const MODIFYING_BASH_RE = /(^|[;&|]\s*)(touch|mv|cp|rm|mkdir|rmdir|ln|chmod|chown|patch\b|tee\b|perl\s+-pi|sed\s+-i|git\s+(apply|checkout|reset|clean|merge|rebase|am|cherry-pick|commit)|npm\s+(install|update|dedupe|audit\s+fix)|pnpm\s+(add|install|update)|yarn\s+(add|install|upgrade)|python\d?\s+.*(-c|scripts?\/)|node\s+.*(-e|scripts?\/))/i;

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function configFromEnv(env = process.env, overrides = {}) {
  return {
    enabled: env.PI_CODEGRAPH !== "0",
    bin: overrides.bin || env.PI_CODEGRAPH_BIN || "codegraph",
    timeoutMs: clampNumber(Number(overrides.timeoutMs || env.PI_CODEGRAPH_TIMEOUT_MS || 120000), 1000, 15 * 60 * 1000),
    maxBuffer: clampNumber(Number(overrides.maxBuffer || env.PI_CODEGRAPH_MAX_BUFFER || 20 * 1024 * 1024), 1024 * 1024, 250 * 1024 * 1024),
    allowOutsideCwd: overrides.allowOutsideCwd != null ? Boolean(overrides.allowOutsideCwd) : env.PI_CODEGRAPH_ALLOW_OUTSIDE === "1",
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_CODEGRAPH_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_CODEGRAPH_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    autoSync: overrides.autoSync != null ? Boolean(overrides.autoSync) : env.PI_CODEGRAPH_AUTO_SYNC === "1",
    autoSyncDebounceMs: clampNumber(Number(overrides.autoSyncDebounceMs || env.PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS || 1500), 100, 60_000),
    advisory: overrides.advisory != null ? Boolean(overrides.advisory) : env.PI_CODEGRAPH_ADVISORY !== "0",
    advisoryTimeoutMs: clampNumber(Number(overrides.advisoryTimeoutMs || env.PI_CODEGRAPH_ADVISORY_TIMEOUT_MS || 1500), 100, 30_000),
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
function physicalPath(value) {
  let existing = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}
function projectRoot(directory, fallback = directory) {
  // Match the nearest initialized index, but never borrow one from a different
  // checkout. Linked worktrees have a .git file rather than a .git directory.
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".codegraph", "codegraph.db"))) return current;
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return fallback;
  }
}
function requestedProjectPath(ctx, inputPath, config = configFromEnv()) {
  const raw = stripAt(inputPath) || ".";
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const absolute = path.resolve(cwd, raw);
  const physical = physicalPath(absolute);
  assertProjectScope(cwd, physical, { label: "CodeGraph", envVar: "PI_CODEGRAPH_ALLOW_OUTSIDE", allowOutside: config.allowOutsideCwd });
  return physical;
}
function resolveProjectPath(ctx, inputPath, config = configFromEnv()) {
  return projectRoot(requestedProjectPath(ctx, inputPath, config));
}
function normalizeProjectFile(projectPath, file) {
  const raw = stripAt(file);
  if (!raw) throw new Error("Affected file path must not be empty");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  if (!isInside(projectPath, absolute)) throw new Error(`Affected file must stay inside project path: ${file}`);
  return path.relative(projectPath, absolute).replace(/\\/g, "/");
}
function projectFileFromDirectory(projectPath, directory, file) {
  const relative = normalizeProjectFile(directory, file);
  const absolute = physicalPath(path.resolve(directory, relative));
  normalizeProjectFile(directory, absolute);
  return normalizeProjectFile(projectPath, absolute);
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
function projectPathFromArgs(ctx, args) {
  const pFlag = args.findIndex((arg) => arg === "-p" || arg === "--path");
  if (pFlag >= 0 && args[pFlag + 1]) return args[pFlag + 1];
  if (["status", "sync", "index"].includes(args[0] || "") && args[1]) return args[1];
  return ctx.cwd;
}
function isNotInitializedOutput(text) {
  return /codegraph\s+not\s+initialized|not\s+initialized|run\s+["'`]?codegraph\s+init/i.test(stripAnsi(text));
}
function friendlyMissingBinaryMessage(config = configFromEnv()) {
  return `CodeGraph is not installed or is not on PATH (tried '${config.bin}'). Install CodeGraph, set PI_CODEGRAPH_BIN to the executable path, or disable this extension with PI_CODEGRAPH=0.`;
}
function friendlyNotInitializedMessage(projectPath) {
  return `CodeGraph is not initialized for ${projectPath}. Run 'codegraph init ${projectPath}' and then 'codegraph index ${projectPath}', or continue with normal read/rg tools for this repo.`;
}
function codegraphError(message, code, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}
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
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function stateRoot(cwd) { return path.join(cwd, STATE_DIR); }
function stateFile(cwd) { return path.join(stateRoot(cwd), "state.json"); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function gitStatusLines(cwd) {
  const r = spawnSync("git", ["status", "--short", "--", "."], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 3000 });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}
function gitChangedFiles(cwd) {
  return readChangeSet(cwd).changedPaths;
}
function statusFingerprint(lines) { return sha256((lines || []).join("\n")).slice(0, 16); }
function readState(cwd) { return readJson(stateFile(cwd), { version: 1, events: [] }); }
function writeState(cwd, state) { writeJson(stateFile(cwd), { version: 1, ...state, updatedAt: new Date().toISOString() }); }
function recordMutation(cwd, event = {}) {
  const state = readState(cwd);
  const now = new Date().toISOString();
  const changedFiles = Array.from(new Set([...(state.changedFiles || []), ...(event.changedFiles || [])].filter(Boolean)));
  const events = [{ at: now, source: event.source || event.toolName || "unknown", toolName: event.toolName, reason: event.reason || "working tree changed", changedFiles: event.changedFiles || [] }, ...(state.events || [])].slice(0, MAX_STATE_EVENTS);
  const observedRevision = workingTreeRevision(cwd);
  const next = { ...state, stale: true, staleSince: state.staleSince || now, staleReason: event.reason || `CodeGraph may be stale after ${event.toolName || event.source || "file change"}`, changedFiles, events, gitStatusFingerprint: observedRevision.statusFingerprint || statusFingerprint(gitStatusLines(cwd)), observedRevision };
  writeState(cwd, next);
  return next;
}
function recordSyncState(cwd, op, run, extra = {}) {
  const lines = gitStatusLines(cwd);
  const revision = workingTreeRevision(cwd);
  const state = readState(cwd);
  const now = new Date().toISOString();
  const next = {
    ...state,
    stale: false,
    staleSince: null,
    staleReason: null,
    changedFiles: [],
    lastOperation: op,
    lastCommand: run?.command,
    lastSyncAt: op === "sync" ? now : state.lastSyncAt,
    lastIndexAt: op === "index" ? now : state.lastIndexAt,
    lastSuccessfulAt: now,
    lastOutputHash: sha256(`${run?.stdout || ""}\n${run?.stderr || ""}`).slice(0, 16),
    gitStatusFingerprint: revision.statusFingerprint || statusFingerprint(lines),
    gitStatusLines: lines,
    revision,
    indexedRevision: revision,
    observedRevision: revision,
    lastError: null,
    ...extra,
  };
  writeState(cwd, next);
  return next;
}
function recordCodegraphError(cwd, source, error) {
  const state = readState(cwd);
  const next = { ...state, lastError: { at: new Date().toISOString(), source, code: error?.code, message: String(error?.message || error) } };
  writeState(cwd, next);
  return next;
}
function pendingChanges(changeSet) {
  const counts = { added: 0, modified: 0, removed: 0, renamed: 0, untracked: 0, unmerged: 0, total: 0 };
  for (const change of changeSet?.changes || []) {
    const key = change.kind === "deleted" ? "removed" : change.kind === "type_changed" || change.kind === "copied" ? "modified" : change.kind;
    if (Object.hasOwn(counts, key)) counts[key]++;
    counts.total++;
  }
  return { ...counts, paths: changeSet?.changedPaths || [], dirty: Boolean(changeSet?.dirty) };
}
function freshness(cwd) {
  cwd = projectRoot(physicalPath(cwd));
  const state = readState(cwd);
  const lines = gitStatusLines(cwd);
  const changeSet = readChangeSet(cwd);
  const revision = { available: changeSet.available, head: changeSet.head, statusFingerprint: changeSet.statusFingerprint, configurationHash: changeSet.configurationHash, dirty: changeSet.dirty };
  const fp = revision.statusFingerprint || statusFingerprint(lines);
  const indexed = state.indexedRevision || (state.lastSuccessfulAt ? state.revision : null);
  const baselineKnown = Boolean(state.lastSuccessfulAt && indexed?.available);
  const staleByRevision = Boolean(revision.available && baselineKnown && (indexed.head !== revision.head || indexed.statusFingerprint !== revision.statusFingerprint || indexed.configurationHash !== revision.configurationHash));
  const eventOnlyStaleWasReverted = Boolean(state.stale && revision.available && baselineKnown && indexed.head === revision.head && indexed.statusFingerprint === revision.statusFingerprint && indexed.configurationHash === revision.configurationHash);
  const stale = Boolean(staleByRevision || state.stale && !eventOnlyStaleWasReverted);
  const freshnessStatus = stale ? "stale" : revision.available && baselineKnown ? "fresh" : "unknown";
  const degradation = freshnessStatus === "stale" ? { code: "stale_index", message: state.staleReason || "Working-tree revision differs from the last successful CodeGraph sync/index.", retryable: true }
    : freshnessStatus === "unknown" ? { code: revision.available ? "index_revision_unproven" : "working_tree_revision_unavailable", message: revision.available ? "No successful CodeGraph sync/index revision is recorded for this working tree." : "Git working-tree revision is unavailable.", retryable: true }
      : state.lastError ? { code: "last_sync_failed", message: "The last CodeGraph sync/index attempt failed.", retryable: true } : null;
  return {
    status: degradation && freshnessStatus === "fresh" ? "degraded" : freshnessStatus,
    freshness: freshnessStatus,
    stale,
    authoritative: freshnessStatus === "fresh" && !degradation,
    gatingSafe: freshnessStatus === "fresh" && !degradation,
    degradation,
    revision,
    revisionId: revisionId(revision),
    indexedRevision: indexed || null,
    pendingChanges: pendingChanges(changeSet),
    statePath: stateFile(cwd),
    staleSince: stale ? state.staleSince || (staleByRevision ? state.lastSuccessfulAt : null) || null : null,
    staleReason: stale ? state.staleReason || (staleByRevision ? "working tree revision changed since last CodeGraph sync/index" : null) : null,
    changedFiles: stale ? Array.from(new Set([...(state.changedFiles || []), ...(changeSet.changedPaths || [])])).sort() : [],
    dirtyFiles: changeSet.changedPaths || [],
    gitStatusLines: lines,
    gitStatusFingerprint: fp,
    lastSyncAt: state.lastSyncAt || null,
    lastIndexAt: state.lastIndexAt || null,
    lastSuccessfulAt: state.lastSuccessfulAt || null,
    lastOperation: state.lastOperation || null,
    autoSync: configFromEnv().autoSync,
    events: state.events || [],
    lastError: state.lastError || null,
  };
}
function freshnessVerdict(current) {
  return { status: current.status, freshness: current.freshness, stale: current.stale, revisionId: current.revisionId, degradation: current.degradation, gatingSafe: current.gatingSafe, authoritative: current.authoritative };
}
function formatFreshnessVerdict(current) {
  const verdict = freshnessVerdict(current);
  return `CodeGraph adapter freshness: ${verdict.status}; revision=${verdict.revisionId}; gatingSafe=${verdict.gatingSafe}${verdict.degradation?.code ? `; degradation=${verdict.degradation.code}` : ""}`;
}
// A healthy index needs no verdict line: the cards already carry freshness and
// the extra line would be resent on every call. Degraded or stale state is
// still surfaced because it changes how the result may be used.
function freshnessFooter(current) {
  const verdict = freshnessVerdict(current);
  return verdict.gatingSafe && verdict.freshness === "fresh" && !verdict.degradation ? [] : [formatFreshnessVerdict(current)];
}
function resultMetadata(cwd, options = {}) {
  const current = options.currentFreshness || freshness(cwd);
  return {
    freshness: current.freshness,
    freshnessStatus: current.status,
    revision: current.revision,
    revisionId: current.revisionId,
    indexedRevision: current.indexedRevision,
    pendingChanges: current.pendingChanges,
    degradation: current.degradation,
    gatingSafe: options.affected === true ? false : current.gatingSafe,
    advisory: options.affected === true || !current.gatingSafe,
    authority: options.affected === true ? "advisory-affected-tests" : current.authoritative ? "authoritative-index" : "advisory-index",
  };
}
function attachResultMetadata(output, cwd, options = {}) {
  const metadata = resultMetadata(cwd, options);
  const details = output.details || {};
  const degradation = details.degradation || metadata.degradation;
  const gatingSafe = metadata.gatingSafe && (details.gatingSafe ?? true) && !degradation;
  output.details = { ...details, ...metadata, degradation, gatingSafe, advisory: !gatingSafe, authority: options.affected ? "advisory-affected-tests" : gatingSafe ? metadata.authority : "advisory-index" };
  return output;
}
function executableInfo(bin = "codegraph", env = process.env) {
  const hasSep = bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin);
  const candidates = hasSep ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin, found: true, path: candidate }; } catch {}
  }
  return { bin, found: false, path: hasSep ? path.resolve(bin) : null };
}
function envReport(env = process.env) {
  return {
    PI_CODEGRAPH: env.PI_CODEGRAPH ?? null,
    PI_CODEGRAPH_BIN: env.PI_CODEGRAPH_BIN ?? null,
    PI_CODEGRAPH_TIMEOUT_MS: env.PI_CODEGRAPH_TIMEOUT_MS ?? null,
    PI_CODEGRAPH_MAX_BUFFER: env.PI_CODEGRAPH_MAX_BUFFER ?? null,
    PI_CODEGRAPH_MAX_LINES: env.PI_CODEGRAPH_MAX_LINES ?? null,
    PI_CODEGRAPH_MAX_BYTES: env.PI_CODEGRAPH_MAX_BYTES ?? null,
    PI_CODEGRAPH_ALLOW_OUTSIDE: env.PI_CODEGRAPH_ALLOW_OUTSIDE ?? null,
    PI_CODEGRAPH_AUTO_SYNC: env.PI_CODEGRAPH_AUTO_SYNC ?? null,
    PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS: env.PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS ?? null,
    PI_CODEGRAPH_ADVISORY: env.PI_CODEGRAPH_ADVISORY ?? null,
    PI_CODEGRAPH_ADVISORY_TIMEOUT_MS: env.PI_CODEGRAPH_ADVISORY_TIMEOUT_MS ?? null,
  };
}
// The CLI runs `git status` itself. On a large index that holds index.lock for seconds,
// and a CLI killed by the advisory timeout can leave the lock behind.
function codegraphEnv() {
  return { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function runCodegraphSync(cwd, args, options = {}) {
  const config = configFromEnv(process.env, options);
  try {
    const stdout = execFileSync(config.bin, args, { cwd, encoding: "utf8", timeout: options.timeoutMs || config.advisoryTimeoutMs, maxBuffer: config.maxBuffer, env: codegraphEnv(), stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, code: 0, stdout: stripAnsi(stdout || ""), stderr: "", args, command: commandText(config.bin, args), cwd };
  } catch (error) {
    const stdout = stripAnsi(String(error?.stdout || ""));
    const stderr = stripAnsi(String(error?.stderr || error?.message || ""));
    return { ok: false, code: error?.code || error?.status || "ERR", stdout, stderr, args, command: commandText(config.bin, args), cwd, error };
  }
}
function extractStringPaths(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) extractStringPaths(item, out);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/file|path|test/i.test(key)) extractStringPaths(item, out);
    else if (typeof item === "object") extractStringPaths(item, out);
  }
  return out;
}
function isLikelyTestFile(file) {
  return /(^|\/)(__tests__|tests?|spec)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /test_.*\.py$/.test(path.basename(file)) || /_test\.go$/.test(file);
}
function extractAffectedTestsFromOutput(output) {
  const text = stripAnsi(output || "").trim();
  if (!text) return { tests: [], parsed: null, parseError: null };
  try {
    const parsed = JSON.parse(text);
    const tests = Array.from(new Set(extractStringPaths(parsed).map((s) => s.replace(/\\/g, "/")).filter(isLikelyTestFile)));
    return { tests, parsed, parseError: null };
  } catch (e) {
    const tests = Array.from(new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(isLikelyTestFile)));
    return { tests, parsed: null, parseError: String(e?.message || e) };
  }
}
function codegraphAffectedTests(cwd = process.cwd(), files = [], options = {}) {
  const config = configFromEnv(process.env, options);
  const directory = requestedProjectPath({ cwd }, options.path, config);
  const projectPath = projectRoot(directory);
  const metadata = () => resultMetadata(projectPath, { affected: true });
  if (!config.enabled || !config.advisory) return { ok: false, skipped: true, reason: "disabled", tests: [], ...metadata() };
  const bin = executableInfo(config.bin);
  if (!bin.found) return { ok: false, skipped: true, reason: "missing-binary", tests: [], binary: bin, ...metadata() };
  const args = ["affected", "-p", projectPath, "-d", String(positiveInt(options.depth, 5, 50)), "-j", ...(files || []).map((f) => projectFileFromDirectory(projectPath, directory, f))];
  const run = runCodegraphSync(projectPath, args, { ...options, timeoutMs: options.timeoutMs || config.advisoryTimeoutMs });
  if (!run.ok) return { ok: false, skipped: isNotInitializedOutput(`${run.stdout}\n${run.stderr}`), reason: isNotInitializedOutput(`${run.stdout}\n${run.stderr}`) ? "not-initialized" : "command-failed", tests: [], run, ...metadata() };
  const parsed = extractAffectedTestsFromOutput(run.stdout || run.stderr || "");
  return { ok: true, tests: parsed.tests, parsed: parsed.parsed, parseError: parsed.parseError, run, ...metadata() };
}
function codegraphProjectSnapshot(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  const binary = executableInfo(config.bin);
  const projectPath = resolveProjectPath({ cwd }, options.path, config);
  const fresh = freshness(projectPath);
  const snapshot = { enabled: config.enabled, advisory: config.advisory, binary, projectPath, initialized: false, statusText: "", freshness: fresh, errorCode: null, guidance: [] };
  if (!config.enabled) { snapshot.guidance.push("CodeGraph extension disabled with PI_CODEGRAPH=0."); return snapshot; }
  if (!binary.found) { snapshot.errorCode = "CODEGRAPH_NOT_INSTALLED"; snapshot.guidance.push(friendlyMissingBinaryMessage(config)); return snapshot; }
  const run = runCodegraphSync(projectPath, ["status", projectPath], { ...options, timeoutMs: options.timeoutMs || config.advisoryTimeoutMs });
  snapshot.statusText = `${run.stdout}\n${run.stderr}`.trim();
  if (!run.ok && isNotInitializedOutput(snapshot.statusText)) { snapshot.errorCode = "CODEGRAPH_NOT_INITIALIZED"; snapshot.guidance.push(friendlyNotInitializedMessage(projectPath)); return snapshot; }
  if (!run.ok) { snapshot.errorCode = "CODEGRAPH_COMMAND_FAILED"; snapshot.guidance.push(`CodeGraph status failed: ${run.stderr || run.stdout || run.code}`); return snapshot; }
  snapshot.initialized = true;
  if (!fresh.gatingSafe) snapshot.guidance.push(fresh.degradation?.message || "CodeGraph index freshness is not authoritative; run /codegraph-sync.");
  return snapshot;
}
function codegraphDoctor(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  let projectPath = path.resolve(cwd);
  const risks = [];
  const recommendations = [];
  try { projectPath = resolveProjectPath({ cwd }, options.path, config); } catch (e) { risks.push(String(e?.message || e)); }
  const binary = executableInfo(config.bin);
  const fresh = freshness(projectPath);
  const doctor = { generatedAt: new Date().toISOString(), enabled: config.enabled, projectPath, cwd, binary, version: null, initialized: false, status: null, freshness: fresh, freshnessVerdict: freshnessVerdict(fresh), env: envReport(), advisoryBoundary: { localFirst: true, nonBlockingByDefault: true, modelReasoning: "advisory code-index context only; no private reasoning storage" }, risks, recommendations };
  if (!config.enabled) { recommendations.push("Set PI_CODEGRAPH=1 or unset PI_CODEGRAPH to enable the adapter."); return doctor; }
  if (!binary.found) { risks.push(friendlyMissingBinaryMessage(config)); recommendations.push("Install CodeGraph or set PI_CODEGRAPH_BIN to its executable path."); return doctor; }
  let version = runCodegraphSync(cwd, ["--version"], { ...options, timeoutMs: Math.min(config.advisoryTimeoutMs, 3000) });
  if (!version.ok) version = runCodegraphSync(cwd, ["version"], { ...options, timeoutMs: Math.min(config.advisoryTimeoutMs, 3000) });
  doctor.version = (version.stdout || version.stderr || "").trim() || null;
  const statusRun = runCodegraphSync(cwd, ["status", projectPath], { ...options, timeoutMs: options.timeoutMs || config.advisoryTimeoutMs });
  doctor.status = { ok: statusRun.ok, command: statusRun.command, stdout: statusRun.stdout, stderr: statusRun.stderr, code: statusRun.code };
  const statusText = `${statusRun.stdout}\n${statusRun.stderr}`;
  if (!statusRun.ok && isNotInitializedOutput(statusText)) { risks.push(friendlyNotInitializedMessage(projectPath)); recommendations.push(`Run: codegraph init ${shellQuote(projectPath)} && codegraph index ${shellQuote(projectPath)}`); }
  else if (!statusRun.ok) { risks.push(`CodeGraph status failed: ${statusRun.stderr || statusRun.stdout || statusRun.code}`); }
  else doctor.initialized = true;
  if (!fresh.gatingSafe) { risks.push(fresh.degradation?.message || fresh.staleReason || "CodeGraph index freshness is not authoritative."); recommendations.push("Run /codegraph-sync after edits, or opt into PI_CODEGRAPH_AUTO_SYNC=1 for debounced background sync."); }
  if (!config.allowOutsideCwd) recommendations.push("Explicit CodeGraph project paths are confined to cwd; set PI_CODEGRAPH_ALLOW_OUTSIDE=1 only when needed.");
  if (!config.autoSync) recommendations.push("Auto-sync is off by default to keep prompt turns non-blocking; use /codegraph-sync manually after edits.");
  return doctor;
}
function formatDoctor(doctor) {
  const lines = [
    `CodeGraph doctor ${doctor.generatedAt}`,
    `enabled: ${doctor.enabled}`,
    `binary: ${doctor.binary?.found ? doctor.binary.path : `missing (${doctor.binary?.bin})`}`,
    `project: ${doctor.projectPath}`,
    `initialized: ${doctor.initialized}`,
    `freshness: ${doctor.freshness?.status || (doctor.freshness?.stale ? "stale" : "unknown")}`,
  ];
  if (doctor.version) lines.push(`version: ${doctor.version}`);
  if (doctor.freshness?.lastSuccessfulAt) lines.push(`last success: ${doctor.freshness.lastSuccessfulAt}`);
  if (doctor.freshness?.dirtyFiles?.length) lines.push(`dirty files: ${doctor.freshness.dirtyFiles.join(", ")}`);
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
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];
    if (token === "--path" || token === "-p") opts.path = next();
    else if (token.startsWith("--path=")) opts.path = token.slice("--path=".length);
    else if (token === "--limit" || token === "-l") opts.limit = next();
    else if (token.startsWith("--limit=")) opts.limit = token.slice("--limit=".length);
    else if (token === "--kind" || token === "-k") opts.kind = next();
    else if (token.startsWith("--kind=")) opts.kind = token.slice("--kind=".length);
    else if (token === "--max-files") opts.maxFiles = next();
    else if (token.startsWith("--max-files=")) opts.maxFiles = token.slice("--max-files=".length);
    else if (token === "--depth" || token === "-d") opts.depth = next();
    else if (token.startsWith("--depth=")) opts.depth = token.slice("--depth=".length);
    else if (token === "--filter" || token === "-f") opts.filter = next();
    else if (token.startsWith("--filter=")) opts.filter = token.slice("--filter=".length);
    else if (token === "--verbose") opts.verbose = true;
    else if (token === "--include-source") opts.includeSource = true;
    else if (token === "--budget-tokens") opts.budgetTokens = Number(next());
    else if (token.startsWith("--budget-tokens=")) opts.budgetTokens = Number(token.slice("--budget-tokens=".length));
    else if (token === "--max-lines") opts.maxLines = Number(next());
    else if (token.startsWith("--max-lines=")) opts.maxLines = Number(token.slice("--max-lines=".length));
    else if (token === "--full" || token === "--index") opts.fullIndex = true;
    else if (token.startsWith("-")) throw new Error(`Unknown CodeGraph option: ${token}; use --verbose to expand provider output.`);
    else positional.push(token);
  }
  return { opts, positional };
}
function inputPathCandidates(value, out = []) {
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (/^(path|file|filePath|target)$/i.test(key) && typeof item === "string") out.push(item);
    else if (/^(paths|files|edits)$/i.test(key) && Array.isArray(item)) for (const child of item) {
      if (typeof child === "string") out.push(child);
      else inputPathCandidates(child, out);
    }
    else if (item && typeof item === "object") inputPathCandidates(item, out);
  }
  return out;
}
function bashLooksModifying(command) {
  const text = String(command || "");
  return MODIFYING_BASH_RE.test(text) || /(^|[^=])>>?\s*[^&|]/.test(text);
}
function shouldMarkStaleFromTool(toolName, input = {}, details) {
  const name = String(toolName || "");
  const params = { ...(input.input || {}), ...input };
  if (name === "ast_refactor") {
    const operation = params.operation || "refactor";
    const applied = operation === "refactor" && (params.mode || "preview") === "apply" && (details == null || Number(details.summary?.files) > 0);
    const restored = operation === "rollback" && (details == null || details.restored?.some((file) => file.ok));
    return { stale: Boolean(applied || restored), reason: applied || restored ? "CodeGraph may be stale after lexical refactor mutation" : undefined };
  }
  if (["edit", "write"].includes(name)) return { stale: true, reason: `CodeGraph may be stale after ${name}` };
  if (name === "bash" && bashLooksModifying(input.command || input.cmd || input.text || "")) return { stale: true, reason: "CodeGraph may be stale after modifying shell command" };
  return { stale: false };
}
function touchedFilesFromTool(cwd, toolName, input = {}) {
  if (String(toolName || "") === "bash") return gitChangedFiles(cwd);
  return Array.from(new Set(inputPathCandidates(input).map((p) => {
    try { return normalizeProjectFile(cwd, p); } catch { return null; }
  }).filter(Boolean)));
}

function filesystemMutationObservation(projectPath, explicitFiles) {
  const files = new Map();
  const ignored = new Set([".git", ".pi", ".codegraph", ".worktrees", ".cache", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(path.join(projectPath, directory), { withFileTypes: true }); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
      // Advisory observation must not block a tool on inaccessible or removed
      // directories. Preserve the observation rather than claiming empty data.
      files.set(directory, `unavailable:${error.code}`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (ignored.has(entry.name) || sourceKindForPath(file) !== "first_party") continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() || entry.isSymbolicLink()) files.set(file, fileContentIdentity(projectPath, file));
    }
  }
  if (explicitFiles) {
    for (const file of [...new Set(explicitFiles)].sort()) files.set(file, fileContentIdentity(projectPath, file));
  } else walk("");
  return { mutationFingerprint: sha256([...files]), fileIdentities: files, changedPaths: [...files.keys()] };
}
async function toolMutationSnapshot(cwd, toolName, input = {}, config = configFromEnv(), options = {}) {
  if (toolName !== "bash" && !shouldMarkStaleFromTool(toolName, input).stale) return new Map();
  const sessionCwd = physicalPath(cwd);
  const root = resolveProjectPath({ cwd: sessionCwd }, undefined, config);
  const run = await runGitAsync(root, ["worktree", "list", "--porcelain", "-z"], { ...options, timeoutMs: 3000 });
  const projects = new Set([root]);
  const scope = projectScope(sessionCwd);
  for (const record of run.ok ? run.stdout.split("\0") : []) {
    if (!record.startsWith("worktree ")) continue;
    const project = record.slice("worktree ".length);
    if (!fs.existsSync(project)) continue;
    const resolved = fs.realpathSync(project);
    if (config.allowOutsideCwd || owningRoot(scope, resolved)) projects.add(resolved);
  }
  const targets = new Map([...projects].map((project) => [project, null]));
  if (["edit", "write"].includes(toolName)) {
    // Match the deepest checkout, not the containing session checkout. Walk to
    // an existing ancestor so new/deleted files and symlink parents resolve too.
    targets.clear();
    for (const file of inputPathCandidates(input)) {
      const resolved = physicalPath(path.resolve(sessionCwd, stripAt(file)));
      if (!config.allowOutsideCwd && !owningRoot(scope, resolved)) continue;
      const project = projectRoot(path.dirname(resolved), root);
      if (!isInside(project, resolved)) continue;
      if (!targets.has(project)) targets.set(project, []);
      targets.get(project).push(normalizeProjectFile(project, resolved));
    }
  }
  // Mutation evidence is separate from Git freshness: plain projects need
  // filesystem observations, but must not acquire a fabricated Git revision.
  const snapshot = new Map();
  for (const [project, files] of targets) {
    const revision = await readChangeSetAsync(project, options);
    const observation = revision.available ? { mutationFingerprint: revisionId(revision) } : filesystemMutationObservation(project, files);
    snapshot.set(project, { ...revision, ...observation });
  }
  return snapshot;
}
function changedMutationProjects(before, after) {
  const changed = [];
  for (const [projectPath, current] of after) {
    const previous = before.get(projectPath);
    if (previous && current.mutationFingerprint === previous.mutationFingerprint) continue;
    let changedFiles = Array.from(new Set([...(previous?.changedPaths || []), ...current.changedPaths])).sort();
    if (current.fileIdentities && previous?.fileIdentities) changedFiles = changedFiles.filter((file) => current.fileIdentities.get(file) !== previous.fileIdentities.get(file));
    changed.push({ projectPath, changedFiles });
  }
  return changed;
}

function createCodegraphAdapter(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  async function runCodegraph(ctx, args, signal, timeoutMs = config.timeoutMs, options = {}) {
    return new Promise((resolvePromise, reject) => {
      execFile(config.bin, args, {
        cwd: ctx.cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: config.maxBuffer,
        signal,
        env: codegraphEnv(),
      }, (error, stdout = "", stderr = "") => {
        const result = { stdout: stripAnsi(String(stdout || "")), stderr: stripAnsi(String(stderr || "")), args, command: commandText(config.bin, args), cwd: ctx.cwd };
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (error?.code === "ENOENT") return reject(codegraphError(friendlyMissingBinaryMessage(config), "CODEGRAPH_NOT_INSTALLED", result));
        if (error && options.allowNotInitialized && isNotInitializedOutput(output)) return resolvePromise(result);
        if (error && !options.allowNotInitialized && isNotInitializedOutput(output)) return reject(codegraphError(friendlyNotInitializedMessage(projectPathFromArgs(ctx, args)), "CODEGRAPH_NOT_INITIALIZED", result));
        if (!error) return resolvePromise(result);
        const message = [`CodeGraph command failed: ${result.command}`, error.code || error.signal ? `exit=${error.code || "?"} signal=${error.signal || "-"}` : "", output || error.message || String(error)].filter(Boolean).join("\n");
        reject(codegraphError(message, "CODEGRAPH_COMMAND_FAILED", result));
      });
    });
  }
  async function ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs = config.timeoutMs) {
    const statusRun = await runCodegraph(ctx, ["status", projectPath], signal, timeoutMs, { allowNotInitialized: true });
    if (isNotInitializedOutput(`${statusRun.stdout}\n${statusRun.stderr}`)) throw codegraphError(friendlyNotInitializedMessage(projectPath), "CODEGRAPH_NOT_INITIALIZED", statusRun);
  }
  // Model-facing output is a bounded projection; the complete provider record
  // stays in tool-result details. Retrieval operations validate into the shared
  // retrieval envelope so one renderer and one token budget apply across
  // CodeGraph, Semgrep, and AST, and operator reports are line-bounded instead.
  async function toolOutput(operation, projectPath, run, options = {}) {
    const output = stripAnsi(run.stdout || run.stderr || "");
    const outputBytes = Buffer.byteLength(output || "", "utf8");
    const details = { generatedAt: new Date().toISOString(), operation, projectPath, command: run.command, args: run.args, stdoutBytes: outputBytes, stderr: stripAnsi(run.stderr).trim() || undefined };
    details.raw = output;
    const envelope = options.buildEnvelope ? options.buildEnvelope({ text: output, outputBytes }) : null;
    let text;
    if (options.verbose === true) text = output || "(CodeGraph produced no output)";
    else if (envelope && options.render) text = options.render(envelope);
    else text = renderCliText(output || "(CodeGraph produced no output)", { operation, maxLines: options.maxLines, footer: options.footer });
    if (envelope) Object.assign(details, envelope);
    recordResultRendering(details, text, output, { operation, ...options });
    return { content: [{ type: "text", text }], details };
  }
  function queryRows(text) {
    try {
      const parsed = JSON.parse(text || "[]");
      if (!Array.isArray(parsed) && !Array.isArray(parsed?.results)) throw new Error("Expected a CodeGraph result array");
      return { rows: Array.isArray(parsed) ? parsed : parsed.results, degradation: null };
    } catch (error) {
      return { rows: [], degradation: { code: "malformed_codegraph_json", message: String(error?.message || error), retryable: true } };
    }
  }
  async function status(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const run = await runCodegraph(ctx, ["status", projectPath], signal, timeout(params.timeoutMs, config));
    const currentFreshness = freshness(projectPath);
    const output = attachResultMetadata(await toolOutput("status", projectPath, run, { verbose: params.verbose === true, maxLines: params.maxLines }), projectPath, { currentFreshness });
    if (params.verbose !== true) output.content[0].text = renderCliText(`${formatFreshnessVerdict(currentFreshness)}\n${output.details.raw}`, { operation: "status", maxLines: params.maxLines });
    recordResultRendering(output.details, output.content[0].text, output.details.raw, { ...params, operation: "codegraph_status" });
    return output;
  }
  async function sync(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const op = params.fullIndex ? "index" : "sync";
    try {
      const run = await runCodegraph(ctx, [op, projectPath], signal, timeoutMs);
      recordSyncState(projectPath, op, run);
      return attachResultMetadata(await toolOutput(op, projectPath, run, { verbose: params.verbose === true, maxLines: params.maxLines, command: "codegraph-sync" }), projectPath);
    } catch (e) { recordCodegraphError(projectPath, op, e); throw e; }
  }
  async function query(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const started = Date.now();
    const args = ["query", "-p", projectPath, "-l", String(positiveInt(params.limit, 10, 200))];
    if (params.kind) args.push("-k", String(params.kind));
    args.push("-j");
    args.push(String(params.search || ""));
    const run = await runCodegraph(ctx, args, signal, timeoutMs);
    const currentFreshness = freshness(projectPath);
    const metadata = resultMetadata(projectPath, { currentFreshness });
    const output = await toolOutput("query", projectPath, run, {
      verbose: params.verbose === true,
      budgetTokens: params.budgetTokens,
      operation: "codegraph_query",
      command: "codegraph-query",
      buildEnvelope: ({ text, outputBytes }) => {
        const parsed = queryRows(text);
        return codegraphQueryEnvelope({ rows: parsed.rows, metadata: { ...metadata, degradation: parsed.degradation || metadata.degradation }, elapsedMs: Date.now() - started, bytesRetrieved: outputBytes });
      },
      render: (envelope) => renderWithinBudget(envelope, { operation: "codegraph_query", budgetTokens: params.budgetTokens, footer: freshnessFooter(currentFreshness), refineHint: "raise limit/budgetTokens or search a narrower symbol name" }),
    });
    return attachResultMetadata(output, projectPath, { currentFreshness });
  }
  async function queryStructured(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const args = ["query", "-p", projectPath, "-l", String(positiveInt(params.limit, 50, 200)), "-j"];
    if (params.kind) args.push("-k", String(params.kind));
    args.push(String(params.search || ""));
    const run = await runCodegraph(ctx, args, signal, timeoutMs);
    let candidates = [];
    let degradation = null;
    const currentFreshness = freshness(projectPath);
    try {
      const parsed = JSON.parse(run.stdout || "[]");
      candidates = (Array.isArray(parsed) ? parsed : parsed.results || []).map((entry) => ({ ...(entry.node || entry), provider: "codegraph", graphScore: Number(entry.score || entry.node?.score || 0), path: entry.node?.filePath || entry.filePath || entry.path, symbolId: entry.node?.id || entry.id, signature: entry.node?.signature || entry.signature || entry.node?.qualifiedName || entry.qualifiedName || entry.node?.name || entry.name, name: entry.node?.name || entry.name, kind: entry.node?.kind || entry.kind, range: entry.node?.startLine ? { startLine: entry.node.startLine, startColumn: Number(entry.node.startColumn || 0) + 1, endLine: entry.node.endLine || entry.node.startLine, endColumn: Number(entry.node.endColumn || 0) + 1 } : undefined, freshness: currentFreshness.freshness, gatingSafe: currentFreshness.gatingSafe }));
    } catch (error) { degradation = { code: "malformed_codegraph_json", message: String(error?.message || error), retryable: true }; }
    if (!degradation && currentFreshness.degradation) degradation = currentFreshness.degradation;
    return { provider: "codegraph", projectPath, candidates, degradation, freshness: currentFreshness, revision: currentFreshness.revision, revisionId: currentFreshness.revisionId, pendingChanges: currentFreshness.pendingChanges, gatingSafe: currentFreshness.gatingSafe && !degradation, advisory: !currentFreshness.gatingSafe || Boolean(degradation), command: run.command };
  }
  async function relationsStructured(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const symbol = String(params.symbol || "").trim();
    const direction = params.direction || "both";
    const kinds = params.relationKinds || ["calls"];
    if (params.symbolId || !symbol || !["incoming", "outgoing", "both"].includes(direction) || Number(params.depth ?? 1) !== 1 || !Array.isArray(kinds) || kinds.some((kind) => kind !== "calls")) {
      return { items: [], freshness: freshness(projectPath), degradation: { code: "unsupported_relation_request", message: "Supply symbol as a CodeGraph name (not symbolId); only calls, direction incoming/outgoing/both and depth=1 are supported. Name-based resolution may be ambiguous.", retryable: false } };
    }
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const limit = positiveInt(params.limit || params.maximumResults, 20, 200);
    const currentFreshness = freshness(projectPath);
    const items = [];
    for (const operation of direction === "both" ? ["callers", "callees"] : [direction === "incoming" ? "callers" : "callees"]) {
      const run = await runCodegraph(ctx, [operation, "-p", projectPath, "-l", String(limit), "-j", symbol], signal, timeoutMs);
      if (/Symbol .* not found/.test(run.stdout)) return { items: [], freshness: currentFreshness, degradation: { code: "symbol_not_found", message: "CodeGraph did not resolve the requested symbol name.", retryable: false } };
      let parsed;
      try { parsed = JSON.parse(run.stdout); } catch { return { items: [], freshness: currentFreshness, degradation: { code: "malformed_codegraph_json", message: "Invalid relationship JSON from CodeGraph.", retryable: true } }; }
      if (!Array.isArray(parsed?.[operation]) || parsed[operation].some(row => !row || typeof row.filePath !== "string" || !row.filePath || typeof row.name !== "string" || !row.name || !Number.isInteger(row.startLine) || row.startLine < 1)) return { items: [], freshness: currentFreshness, degradation: { code: "malformed_codegraph_json", message: "Invalid relationship rows from CodeGraph.", retryable: true } };
      for (const row of parsed[operation]) {
        const related = row.id || `${row.filePath}:${row.startLine}:${row.name}`;
        items.push({ provider: "codegraph", path: normalizeProjectFile(projectPath, row.filePath), range: { startLine: row.startLine, endLine: row.startLine }, fromId: operation === "callers" ? related : symbol, toId: operation === "callers" ? symbol : related, relationKind: "calls", direction: operation === "callers" ? "incoming" : "outgoing", signature: operation === "callers" ? `${row.name} → ${symbol}` : `${symbol} → ${row.name}`, freshness: currentFreshness.freshness, gatingSafe: false, provenance: [{ provider: "codegraph", operation }] });
      }
    }
    return { items: items.slice(0, limit), truncated: items.length >= limit, freshness: currentFreshness, degradation: currentFreshness.degradation || null };
  }
  async function context(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const started = Date.now();
    const args = ["explore", "-p", projectPath, "--max-files", String(positiveInt(params.maxFiles, 10, 100)), String(params.task || "")];
    const run = await runCodegraph(ctx, args, signal, timeoutMs);
    const currentFreshness = freshness(projectPath);
    const metadata = resultMetadata(projectPath, { currentFreshness });
    const output = await toolOutput("explore", projectPath, run, {
      verbose: params.verbose === true,
      budgetTokens: params.budgetTokens,
      operation: "codegraph_context",
      command: "codegraph-context",
      buildEnvelope: ({ text, outputBytes }) => codegraphContextEnvelope({ text, metadata, elapsedMs: Date.now() - started, bytesRetrieved: outputBytes }),
      render: (envelope) => renderCodegraphContext(envelope, { operation: "codegraph_context", budgetTokens: params.budgetTokens, includeSource: params.includeSource === true, footer: freshnessFooter(currentFreshness) }),
    });
    return attachResultMetadata(output, projectPath, { currentFreshness });
  }
  async function affected(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const started = Date.now();
    const args = ["affected", "-p", projectPath, "-d", String(positiveInt(params.depth, 5, 50))];
    if (params.filter) args.push("-f", String(params.filter));
    args.push("-j");
    const directory = requestedProjectPath(ctx, params.path, config);
    for (const file of params.files || []) args.push(projectFileFromDirectory(projectPath, directory, String(file)));
    const run = await runCodegraph(ctx, args, signal, timeoutMs);
    const currentFreshness = freshness(projectPath);
    const metadata = resultMetadata(projectPath, { currentFreshness, affected: true });
    const output = await toolOutput("affected", projectPath, run, {
      verbose: params.verbose === true,
      budgetTokens: params.budgetTokens,
      operation: "codegraph_affected",
      command: "codegraph-affected",
      buildEnvelope: ({ text, outputBytes }) => {
        let parsed = {};
        let degradation = null;
        try { parsed = JSON.parse(text || "{}"); } catch (error) { degradation = { code: "malformed_codegraph_json", message: String(error?.message || error), retryable: true }; }
        return codegraphAffectedEnvelope({ parsed: { ...parsed, affectedTests: extractAffectedTestsFromOutput(text).tests }, metadata: { ...metadata, degradation: degradation || metadata.degradation }, elapsedMs: Date.now() - started, bytesRetrieved: outputBytes });
      },
      render: (envelope) => renderCodegraphAffected(envelope, { budgetTokens: params.budgetTokens, footer: freshnessFooter(currentFreshness) }),
    });
    return attachResultMetadata(output, projectPath, { currentFreshness, affected: true });
  }
  async function files(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const timeoutMs = timeout(params.timeoutMs, config);
    await ensureCodegraphInitialized(ctx, projectPath, signal, timeoutMs);
    const args = ["files", "-p", projectPath];
    const run = await runCodegraph(ctx, args, signal, timeoutMs);
    return attachResultMetadata(await toolOutput("files", projectPath, run, { verbose: params.verbose === true, maxLines: params.maxLines, command: "codegraph-files" }), projectPath);
  }
  async function doctor(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const details = codegraphDoctor(projectPath, { ...params, ...config, path: projectPath });
    return { content: [{ type: "text", text: formatDoctor(details) }], details };
  }
  return { config, runCodegraph, ensureCodegraphInitialized, status, sync, query, queryStructured, relationsStructured, context, affected, files, doctor, toolOutput, resolveProjectPath: (ctx, p) => resolveProjectPath(ctx, p, config), normalizeProjectFile, recordMutation, recordSyncState, recordCodegraphError, freshness, shouldMarkStaleFromTool, touchedFilesFromTool, toolMutationSnapshot: (cwd, name, input) => toolMutationSnapshot(cwd, name, input, config), changedMutationProjects };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  STATE_DIR,
  clampNumber,
  configFromEnv,
  createCodegraphAdapter,
  codegraphAffectedTests,
  codegraphProjectSnapshot,
  codegraphDoctor,
  formatDoctor,
  freshness,
  freshnessVerdict,
  formatFreshnessVerdict,
  pendingChanges,
  resultMetadata,
  attachResultMetadata,
  recordMutation,
  recordSyncState,
  recordCodegraphError,
  shouldMarkStaleFromTool,
  touchedFilesFromTool,
  toolMutationSnapshot,
  changedMutationProjects,
  normalizeProjectFile,
  resolveProjectPath,
  parseCliArgs,
  splitArgs,
  stripAnsi,
  truncateHead,
  formatSize,
  friendlyMissingBinaryMessage,
  friendlyNotInitializedMessage,
  isNotInitializedOutput,
  executableInfo,
};
