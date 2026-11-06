"use strict";

/**
 * Branch-backed subagent domain/service layer.
 *
 * Subagents are durable child invocations backed by SessionBranchManager branches.
 * The service owns lifecycle/result records; the branch store remains the source
 * of truth for child trajectory checkpoints and provenance metadata.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { SessionBranchManager, SnapshotStore } = require("./session-branches");
const {
  normalizeBudget,
  messageDiagnostics: diagnoseMessages,
  withLegacyDiagnosticAliases,
  validateRpcCompletion,
  createRpcBudgetTracker,
  errorFromValidation,
  terminalAssistantMessage,
} = require("./subagent-result-validator");
const { DEFAULT_ROLE_CONTRACTS, DEFAULT_DELEGATE_MODEL, validateRoleContract, resolveRequiredTools, selectRoleInferenceProfile, THINKING_LEVELS, ACTUAL_CHILD_TOOLS } = require("./role-contracts");
const { ROLE_RESULT_SCHEMA_VERSION, ROLE_CONTRACT_VERSION, RESULT_STATUSES, createRoleResultEnvelope, validateRoleResultEnvelope } = require("./role-result-schemas");
const { SubagentWorkspaceManager } = require("./subagent-workspaces");
const { SubagentPatchService } = require("./subagent-patches");
const { createDiagnosticEvidenceCollector } = require("./diagnostic-evidence");
const { resolveRoleRuntimeConfig, assertRoleRuntimeExecutionAllowed } = require("./role-runtime-rollout");
const { SKILL_AWARENESS_MARKER, skillAwarenessPrompt } = require("./skill-awareness");
const { processIdentity } = require("./resource-guard");
const { roleRevision, publicRecord, publicResult, publicEvent, resolveSubagentPreflight, createSubagentReceipt, sha256: lifecycleSha256 } = require("./subagent-lifecycle");
const {
  ownProcessGroup,
  acquireManagedWorker,
  resourceGuardConfig,
  terminateOwnedProcessGroup,
  watchOwnedProcessGroupRss,
} = require("./resource-guard");

const SUBAGENT_STATUSES = Object.freeze(["created", "queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);
const FINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const RUNNING_STATUSES = new Set(["queued", "running"]);
// A run is only live while its supervising process is alive. Persist that
// identity with the record so a later session can distinguish an orphan from a
// run owned by another live Pi process in the same checkout.
function supervisingProcess(pid = process.pid) {
  const identity = processIdentity(pid);
  return { pid, startTime: identity?.startTime ?? null };
}
function supervisorAlive(owner) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const identity = processIdentity(pid);
  if (!identity || identity.state === "Z") return false;
  return owner.startTime == null || identity.startTime === owner.startTime;
}
const MERGE_POLICIES = Object.freeze(["none", "summary_only", "full_result", "proposed_patch"]);

function nowIso() { return new Date().toISOString(); }
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
function sameIdentity(left, right) { return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino); }
function assertStatePath(file, stat, type) {
  if (stat.isSymbolicLink() || (type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) throw new Error(`subagent state ${type} is unsafe: ${file}`);
}
function assertStatePathIdentity(file, opened, type) {
  const current = fs.lstatSync(file);
  assertStatePath(file, current, type);
  if (!sameIdentity(opened, current)) throw new Error(`subagent state ${type} changed while open: ${file}`);
}
function openStatePath(file, type, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(file);
  assertStatePath(file, before, type);
  const fd = fs.openSync(file, flags | NO_FOLLOW | (type === "directory" ? DIRECTORY_ONLY : 0));
  try {
    const opened = fs.fstatSync(fd);
    assertStatePath(file, opened, type);
    if (!sameIdentity(before, opened)) throw new Error(`subagent state ${type} changed while opening: ${file}`);
    assertStatePathIdentity(file, opened, type);
    return { fd, opened };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function readJson(file, fallback) {
  let fd;
  try { const opened = openStatePath(file, "file"); fd = opened.fd; const value = JSON.parse(fs.readFileSync(fd, "utf8")); assertStatePathIdentity(file, opened.opened, "file"); return value; }
  catch { return fallback; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { fd, opened } = openStatePath(dir, "directory");
  try { fs.fchmodSync(fd, 0o700); assertStatePathIdentity(dir, opened, "directory"); }
  finally { fs.closeSync(fd); }
}
function writeJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    created = true;
    const opened = fs.fstatSync(fd);
    assertStatePath(temporary, opened, "file");
    assertStatePathIdentity(temporary, opened, "file");
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    assertStatePathIdentity(temporary, opened, "file");
    fs.closeSync(fd); fd = undefined;
    try { const existing = fs.lstatSync(file); assertStatePath(file, existing, "file"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    fs.renameSync(temporary, file);
    assertStatePathIdentity(file, opened, "file");
  } catch (error) {
    if (created) try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function appendJsonl(file, value) {
  ensurePrivateDir(path.dirname(file));
  let fd;
  try { fd = openStatePath(file, "file", fs.constants.O_WRONLY | fs.constants.O_APPEND).fd; }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  }
  try { const opened = fs.fstatSync(fd); assertStatePath(file, opened, "file"); assertStatePathIdentity(file, opened, "file"); fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); assertStatePathIdentity(file, opened, "file"); }
  finally { fs.closeSync(fd); }
}
function hardenDirectoryTree(root, maxEntries = 10000) {
  let seen = 0;
  const visit = (target) => {
    if (seen++ >= maxEntries) return;
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isSymbolicLink()) return;
    const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
    if (!type) return;
    try { const opened = openStatePath(target, type); try { fs.fchmodSync(opened.fd, type === "directory" ? 0o700 : 0o600); assertStatePathIdentity(target, opened.opened, type); } finally { fs.closeSync(opened.fd); } }
    catch { return; }
    if (type !== "directory") return;
    let names = [];
    try { names = fs.readdirSync(target); } catch { return; }
    for (const name of names) visit(path.join(target, name));
  };
  visit(root);
  return seen;
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function stableStringify(value) { return JSON.stringify(value, Object.keys(value || {}).sort()); }
function shortHash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 12); }
function estimateTokens(value) { return Math.ceil(String(typeof value === "string" ? value : JSON.stringify(value || {})).length / 4); }
function safeError(error) { return { message: error?.message || String(error), name: error?.name || "Error", code: error?.code || null }; }
function textFromMessageContent(content, maxChars = Infinity) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Infinity;
  if (typeof content === "string") return content.slice(0, cap);
  if (Array.isArray(content)) {
    const parts = [];
    let remaining = cap;
    for (const part of content) {
      if (remaining <= 0) break;
      const type = String(part?.type || "").toLowerCase();
      if (type.includes("thinking") || type.includes("reasoning")) continue;
      const text = String(part?.text || part?.content || "").slice(0, remaining);
      if (text) {
        parts.push(text);
        remaining -= text.length;
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    const type = String(content.type || "").toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning")) return "";
    return String(content.text || content.content || "").slice(0, cap);
  }
  return String(content || "").slice(0, cap);
}
function messageDiagnostics(messages = []) { return diagnoseMessages(messages); }
function sessionEntryDiagnostics(entries = [], startIndex = 0) {
  const added = entries.slice(startIndex).filter((entry) => entry?.type === "message" && entry.message).map((entry) => entry.message);
  return messageDiagnostics(added);
}
function truncateText(value, maxChars, label = "truncated") {
  const text = String(value || "");
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0 || text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - 80)).trimEnd()}\n\n[${label}; ${text.length - Math.max(0, cap - 80)} characters omitted]`;
}
function subagentFinalResponseLimit() { return Math.max(1000, envNumber("PI_SUBAGENT_FINAL_RESPONSE_CHARS", 12000)); }
function summarizeMessages(messages = [], options = {}) {
  const perMessageLimit = Number(options.perMessageLimit || 1200);
  const totalLimit = Number(options.totalLimit || subagentFinalResponseLimit());
  const includeRoles = Array.isArray(options.includeRoles) ? new Set(options.includeRoles) : null;
  const lines = [];
  for (const msg of messages) {
    if (!msg) continue;
    const role = msg.role || "message";
    if (includeRoles && !includeRoles.has(role)) continue;
    const text = textFromMessageContent(msg.content, perMessageLimit).replace(/\s+/g, " ").trim();
    if (text) lines.push(`${role}: ${text}`);
  }
  return truncateText(lines.join("\n") || "No subagent session output was recorded.", totalLimit, "subagent transcript summary truncated");
}
function finalAssistantResponse(messages = []) {
  const assistantTexts = messages
    .filter((msg) => msg?.role === "assistant")
    .map((msg) => textFromMessageContent(msg.content, subagentFinalResponseLimit()).trim())
    .filter(Boolean);
  return truncateText(assistantTexts.at(-1) || summarizeMessages(messages, { includeRoles: ["assistant"], totalLimit: subagentFinalResponseLimit() }), subagentFinalResponseLimit(), "subagent final response truncated");
}
function summarizeSessionEntries(entries = [], startIndex = 0) {
  return summarizeMessages(entries.slice(startIndex).filter((entry) => entry?.type === "message" && entry.message).map((entry) => entry.message));
}
function redactSensitiveText(text) {
  return String(text || "")
    .replace(/\b((?:sk|pk|ghp|github_pat|glpat|xox[baprs]|ya29|hf|AIza)[-_a-zA-Z0-9]{16,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)(\s*[:=]\s*)([^\s'\"`]+).*/gi, "$1$2[REDACTED]");
}
function normalizeMergePolicy(policy) { const p = policy || "none"; if (!MERGE_POLICIES.includes(p)) throw new Error(`invalid merge policy: ${p}`); return p; }
function ensureStatus(status) { if (!SUBAGENT_STATUSES.includes(status)) throw new Error(`invalid subagent status: ${status}`); return status; }
function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value));
}
function envNumber(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}
const rpcConcurrencyState = { active: 0, queue: [] };
const SUBAGENT_BRANCH_METADATA_FIELDS = Object.freeze([
  "kind", "parentSessionId", "parentTrajectoryId", "parentBranchId", "branchFrom", "subagentId", "subagentRole",
  "createdAt", "status", "roleContractVersion", "workspacePolicy", "mutationPolicy", "seedPatchHashes", "budget",
  "mergePolicy", "depth", "topologyRunId", "topologyId", "nodeId", "roleResolution", "contractVersion",
  "requestedRole", "parentSessionFileHash", "allowParallelWorkspace", "mergeOrder", "previousAttemptId", "rootAttemptId", "attempt", "continuationMode", "childKey",
]);
function compactSubagentBranchMetadata(metadata = {}, task = null) {
  const compact = Object.fromEntries(SUBAGENT_BRANCH_METADATA_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(metadata, field)).map((field) => [field, clone(metadata[field])]));
  if (task) compact.taskHash = shortHash(task);
  return compact;
}
function compactSubagentSnapshotResult(result = {}) {
  const diagnostics = result.diagnostics || {};
  const rawSummary = truncateText(result.summary || "", 1000, "subagent snapshot summary truncated");
  return {
    schemaVersion: Number(result.schemaVersion || 1),
    contractVersion: result.contractVersion || null,
    subagentId: result.subagentId || result.subagent_id || null,
    roleId: result.roleId || result.role || null,
    status: result.status || "unknown",
    summary: redactSensitiveText(rawSummary),
    verification: { status: result.verification?.status || "unchecked" },
    termination: result.termination ? { code: result.termination.code || null, stopReason: result.termination.stopReason || null } : null,
    diagnostics: {
      modelCalls: Number(diagnostics.modelCalls ?? diagnostics.model_calls ?? 0),
      toolCalls: Number(diagnostics.toolCalls ?? diagnostics.tool_calls ?? 0),
      toolResults: Number(diagnostics.toolResults ?? diagnostics.tool_results ?? 0),
      toolFailures: Number(diagnostics.toolFailures ?? diagnostics.tool_failures ?? 0),
      durationMs: Number(diagnostics.totalDurationMs ?? diagnostics.total_duration_ms ?? diagnostics.duration_ms ?? 0),
    },
    resultHash: result.final_response || result.finalResponse || result.summary ? shortHash(result.final_response || result.finalResponse || result.summary) : null,
  };
}
function subagentBranchSnapshotState(states = {}) {
  const safe = clone(states) || {};
  const context = safe.contextState;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    if (context.subagent && typeof context.subagent === "object") {
      if (context.subagent.task) context.subagent.taskHash = shortHash(context.subagent.task);
      delete context.subagent.task;
    }
    if (context.task) context.taskHash = shortHash(context.task);
    delete context.task;
    if (context.reason) context.reasonHash = shortHash(context.reason);
    delete context.reason;
    if (context.subagentResult) context.subagentResult = compactSubagentSnapshotResult(context.subagentResult);
    if (context.subagentMerge?.result) context.subagentMerge.result = compactSubagentSnapshotResult(context.subagentMerge.result);
    if (context.subagentMerge?.summary) context.subagentMerge.summary = redactSensitiveText(truncateText(context.subagentMerge.summary, 1000, "subagent merge summary truncated"));
    if (Array.isArray(context.subagentMerge?.artifacts)) {
      context.subagentMerge.artifactCount = context.subagentMerge.artifacts.length;
      context.subagentMerge.artifactHash = shortHash(context.subagentMerge.artifacts);
      delete context.subagentMerge.artifacts;
    }
    if (Array.isArray(context.subagentMerge?.proposed_parent_updates)) {
      context.subagentMerge.proposedParentUpdateCount = context.subagentMerge.proposed_parent_updates.length;
      context.subagentMerge.proposedParentUpdateHash = shortHash(context.subagentMerge.proposed_parent_updates);
      delete context.subagentMerge.proposed_parent_updates;
    }
  }
  if (Array.isArray(safe.verifierState?.errors)) safe.verifierState.errors = safe.verifierState.errors.map((error) => ({ name: error?.name || "Error", code: error?.code || null }));
  const mode = String(process.env.PI_SUBAGENT_BRANCH_SNAPSHOT_MODE || "").trim().toLowerCase();
  const full = envFlag("PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS", false) || ["full", "filesystem", "fs"].includes(mode);
  if (full || Object.prototype.hasOwnProperty.call(safe, "files")) return safe;
  return { ...safe, files: [] };
}
function rpcConcurrencyLimit(context = {}) {
  const configured = context.rpc?.concurrency ?? context.rpc?.maxConcurrency ?? process.env.PI_SUBAGENT_RPC_CONCURRENCY;
  const n = Number(configured ?? 2);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 2;
}
async function withRpcConcurrency(limit, fn, options = {}) {
  const queuedAt = Date.now();
  let acquired = false;
  let waiter = null;
  const removeWaiter = () => {
    if (!waiter) return;
    const index = rpcConcurrencyState.queue.indexOf(waiter);
    if (index >= 0) rpcConcurrencyState.queue.splice(index, 1);
  };
  if (rpcConcurrencyState.active < limit) {
    rpcConcurrencyState.active += 1;
    acquired = true;
  } else {
    options.onQueued?.();
    await new Promise((resolve, reject) => {
      let timer;
      let abortHandler;
      const settle = (error) => {
        if (!waiter?.pending) return;
        waiter.pending = false;
        removeWaiter();
        if (timer) clearTimeout(timer);
        if (abortHandler && options.signal) options.signal.removeEventListener?.("abort", abortHandler);
        if (error) {
          const queueWaitMs = Math.max(0, Date.now() - queuedAt);
          error.subagentDiagnostics = withLegacyDiagnosticAliases({ ...(error.subagentDiagnostics || {}), queueWaitMs, queue_wait_ms: queueWaitMs });
          reject(error);
        } else { acquired = true; options.onAcquired?.(); resolve(); }
      };
      waiter = { limit, pending: true, resolve: () => settle(null) };
      rpcConcurrencyState.queue.push(waiter);
      if (Number.isFinite(options.maxQueueWaitMs) && options.maxQueueWaitMs >= 0) {
        timer = setTimeout(() => { const error = new Error(`subagent RPC queue budget exceeded (${options.maxQueueWaitMs}ms)`); error.code = "SUBAGENT_QUEUE_TIMEOUT"; settle(error); }, options.maxQueueWaitMs);
      }
      if (options.signal) {
        abortHandler = () => settle(abortError("subagent RPC run aborted while queued"));
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener?.("abort", abortHandler, { once: true });
      }
    });
  }
  const queueWaitMs = Math.max(0, Date.now() - queuedAt);
  try { return await fn({ queueWaitMs, concurrencyLimit: limit }); }
  finally {
    if (!acquired) return;
    rpcConcurrencyState.active = Math.max(0, rpcConcurrencyState.active - 1);
    while (rpcConcurrencyState.queue.length) {
      const next = rpcConcurrencyState.queue[0];
      if (!next.pending) { rpcConcurrencyState.queue.shift(); continue; }
      if (rpcConcurrencyState.active >= next.limit) break;
      rpcConcurrencyState.active += 1;
      rpcConcurrencyState.queue.shift();
      next.resolve();
    }
  }
}
function modelPattern(model) {
  if (!model?.id) return null;
  return model.provider ? `${model.provider}/${model.id}` : String(model.id);
}
function modelPatternFromContext(context = {}) { return modelPattern(context.model || context.ctx?.model); }
function thinkingLevelFromContext(context = {}) {
  const level = context.thinkingLevel || context.ctx?.thinkingLevel;
  return THINKING_LEVELS.includes(level) ? level : null;
}
function toolAllowlistFromPolicy(policy) {
  const builtin = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const allowed = Array.isArray(policy?.allowedTools) ? policy.allowedTools.filter(Boolean) : null;
  if (allowed) return allowed.includes("*") ? null : allowed.join(",");
  const denied = new Set(Array.isArray(policy?.deniedTools) ? policy.deniedTools : []);
  if (denied.size) return builtin.filter((name) => !denied.has(name)).join(",");
  return null;
}
function jsonLineError(message, line) { const error = new Error(`${message}: ${String(line || "").slice(0, 500)}`); error.code = "SUBAGENT_RPC_PROTOCOL"; return error; }
function abortError(message) { const error = new Error(message); error.name = "AbortError"; return error; }

class SubagentStore {
  constructor({ cwd = process.cwd(), dir = path.join(cwd, ".pi", "subagents") } = {}) {
    this.cwd = cwd;
    this.dir = dir;
    this.recordsDir = path.join(dir, "records");
    this.resultsDir = path.join(dir, "results");
    this.eventsFile = path.join(dir, "events.jsonl");
  }
  recordFile(id) { return path.join(this.recordsDir, `${id}.json`); }
  resultFile(id) { return path.join(this.resultsDir, `${id}.json`); }
  save(record) { writeJson(this.recordFile(record.id), record); return clone(record); }
  get(id) { return readJson(this.recordFile(id), null); }
  list({ parentSessionId } = {}) {
    try {
      return fs.readdirSync(this.recordsDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(this.recordsDir, f), null)).filter(Boolean)
        .filter((r) => !parentSessionId || r.parentSessionId === parentSessionId)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    } catch { return []; }
  }
  saveResult(result) { writeJson(this.resultFile(result.subagent_id), result); return clone(result); }
  getResult(id) { return readJson(this.resultFile(id), null); }
  delete(id) { fs.rmSync(this.recordFile(id), { force: true }); fs.rmSync(this.resultFile(id), { force: true }); return true; }
  event(type, payload = {}) {
    if (!Number.isInteger(this.nextSequence)) this.nextSequence = this.events().reduce((max, event) => Math.max(max, Number(event.sequence || 0)), 0) + 1;
    const row = publicEvent({ id: `subevt_${shortHash({ type, payload, at: nowIso(), sequence: this.nextSequence })}`, at: nowIso(), sequence: this.nextSequence++, type, ...payload });
    appendJsonl(this.eventsFile, row);
    this.onEvent?.(row);
    return row;
  }
  events() {
    let fd;
    try { const opened = openStatePath(this.eventsFile, "file"); fd = opened.fd; const rows = fs.readFileSync(fd, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); assertStatePathIdentity(this.eventsFile, opened.opened, "file"); return rows; }
    catch { return []; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

function defaultResultEnvelope(record, overrides = {}) {
  const diagnostics = {
    started_at: record.startedAt || null,
    finished_at: record.finishedAt || null,
    duration_ms: record.startedAt && record.finishedAt ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : 0,
    diagnosticsSchemaVersion: 2,
    modelCalls: 0,
    toolCalls: 0,
    toolResults: 0,
    toolFailures: 0,
    unmatchedToolCallIds: [],
    unmatchedToolResultIds: [],
    tokenUsage: {},
    model_calls: 0,
    tool_calls: 0,
    tool_results: 0,
    tool_failures: 0,
    token_usage: {},
    errors: [],
    ...(overrides.diagnostics || {}),
  };
  const submitted = overrides.submitted_result || overrides.submittedResult || {};
  const summary = truncateText(submitted.summary || overrides.summary || "", envNumber("PI_SUBAGENT_SUMMARY_CHARS", 1000), "subagent summary truncated");
  const finalResponse = truncateText(overrides.final_response || overrides.finalResponse || submitted.summary || "", subagentFinalResponseLimit(), "subagent final response truncated");
  return {
    schemaVersion: record.roleContract || record.roleContractVersion ? ROLE_RESULT_SCHEMA_VERSION : 1,
    contractVersion: record.roleContract || record.roleContractVersion ? ROLE_CONTRACT_VERSION : null,
    subagentId: record.id,
    subagent_id: record.id,
    parentSessionId: record.parentSessionId,
    parent_session_id: record.parentSessionId,
    branchId: record.branchId,
    branch_id: record.branchId,
    trajectoryId: record.trajectoryId,
    trajectory_id: record.trajectoryId,
    roleId: record.role || null,
    status: record.status,
    role: record.role || null,
    taskHash: record.taskHash || null,
    summary,
    final_response: finalResponse,
    findings: submitted.findings || overrides.findings || [],
    evidence: submitted.evidence || overrides.evidence || [],
    diagnosticEvidence: overrides.diagnosticEvidence || [],
    artifacts: submitted.artifacts || overrides.artifacts || [],
    proposedPatch: submitted.proposedPatch ?? overrides.proposedPatch ?? null,
    workspaceDisposition: overrides.workspaceDisposition || null,
    proposed_parent_updates: overrides.proposed_parent_updates || overrides.proposedParentUpdates || [],
    verification: submitted.verification || overrides.verification || { status: "unchecked", evidence: [] },
    roadmapPlan: submitted.roadmapPlan || overrides.roadmapPlan || undefined,
    submitted_result: (record.roleContract || record.roleContractVersion) && Object.keys(submitted).length ? submitted : undefined,
    termination: overrides.termination || submitted.termination || record.termination || { code: record.status === "succeeded" ? "completed" : record.status, stopReason: null, message: "" },
    diagnostics: withLegacyDiagnosticAliases(diagnostics),
  };
}

class SubagentRunner {
  constructor({ execute, trace, clock = () => Date.now() } = {}) { this.execute = execute; this.trace = trace; this.clock = clock; this.controls = new Map(); }
  steer(subagentId, message) { const control = this.controls.get(subagentId); return control?.steer?.(message) === true; }
  interrupt(subagentId, reason = "interrupted") { const control = this.controls.get(subagentId); return control?.interrupt?.(reason) === true; }
  async run(record, context = {}) {
    // The system prompt already reaches the child as `--append-system-prompt` on
    // the RPC path, so embedding it again here would deliver the whole contract
    // twice. Contract children rely on the appended prompt; only prompt-only
    // children keep it inline. Skill awareness follows the same rule: it is
    // appended once through the contract, or added here when the prompt has
    // none, including records resumed with a persisted legacy contract.
    const hasSkillAwareness = String(record.systemPrompt || "").includes(SKILL_AWARENESS_MARKER);
    const prompt = [
      record.roleContract ? undefined : record.systemPrompt ? `System: ${record.systemPrompt}` : undefined,
      record.role ? `Role: ${record.role}` : undefined,
      "You are a delegated Pi role sidecar on a child trajectory branch; the parent session remains active.",
      record.workspacePolicy === "isolated-worktree"
        ? "All filesystem work occurs in a detached isolated Git workspace. Return a proposed patch; never claim the parent working tree was changed."
        : "This is a shared-readonly repository view. Do not mutate files or execute shell commands.",
      record.roleContract ? "Finish only through submit_role_result with the required bounded public schema; plain assistant text is not role-v2 success." : "Return concise findings for the parent. Do not assume parent state has been mutated.",
      "Do not spawn additional subagents, call create_subagent, or invoke slash-command skills; complete this assigned subtask directly.",
      hasSkillAwareness ? undefined : skillAwarenessPrompt({ roleId: record.role }),
      `Task: ${record.task}`,
    ].filter(Boolean).join("\n\n");
    if (this.execute) return this.execute({ record, prompt, context });
    if (process.env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT) {
      const text = process.env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT;
      const minimumSummaryChars = Number(record.roleContract?.completionPolicy?.minimumSummaryChars || 1);
      const summary = (text.length >= minimumSummaryChars ? text : `${text} — deterministic fixture completed with bounded evidence.`).slice(0, 500);
      const requiresEvidence = record.roleContract?.completionPolicy?.requireEvidence === true;
      const requiresVerdict = record.roleContract?.completionPolicy?.requireVerificationVerdict === true;
      if (record.roleContract?.mutationPolicy === "proposed-patch") {
        if (context.workspace?.policy !== "isolated-worktree" || !context.cwd || !context.parentCwd || fs.realpathSync(context.cwd) === fs.realpathSync(context.parentCwd)) {
          throw new Error("mutating execution fixtures require a leased isolated workspace");
        }
        // Exercise authoritative patch capture, not a fabricated proposal or a
        // baseline-satisfied claim. Never overwrite an inherited fixture file.
        fs.writeFileSync(path.join(context.cwd, "subagent-fixture.txt"), `${text}\n`, { flag: "wx" });
      }
      const roadmapPlan = record.roleContract?.roleId === "planner" ? {
        title: "Deterministic fixture plan",
        milestones: [{ title: "Fixture implementation", goals: ["Complete the isolated fixture task and verify its result."] }],
      } : undefined;
      const submitted = record.roleContract ? createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission: { summary, findings: [], evidence: requiresEvidence ? [{ kind: "fixture", summary: "Deterministic fixture evidence." }] : [], artifacts: [], proposedPatch: null, verification: requiresVerdict ? { status: "passed", evidence: ["deterministic fixture passed"] } : { status: "unchecked", evidence: [] }, ...(roadmapPlan ? { roadmapPlan } : {}) } }) : null;
      return { summary, final_response: text, artifacts: [], proposed_parent_updates: [], submitted_result: submitted, termination: submitted?.termination, model_calls: 0, tool_calls: 0 };
    }
    if (context?.executionMode === "tool-rpc") return this.runInRpcSubprocess(record, prompt, context);
    const error = new Error("subagent execution requires the canonical tool-rpc sidecar"); error.code = "SUBAGENT_EXECUTION_MODE_INVALID"; throw error;
  }
  rpcArgs(record, context = {}) {
    const rpc = context.rpc || {};
    const cwd = context.cwd || context.ctx?.cwd || process.cwd();
    const sessionDir = rpc.sessionDir || path.join(context.parentCwd || cwd, ".pi", "subagents", "rpc-sessions", record.id);
    const noSession = rpc.noSession === true;
    const args = [...(rpc.argsPrefix || [])];
    args.push("--mode", "rpc", noSession ? "--no-session" : "--session-dir");
    if (!noSession) args.push(sessionDir);
    const roleContract = record.roleContract ? validateRoleContract(record.roleContract) : null;
    const roleSidecar = path.resolve(__dirname, "..", "extensions", "role-sidecar", "index.ts");
    // Approved provider registration is needed even with discovery disabled.
    // Multi-login detects child execution and omits model-changing session hooks.
    args.push("--no-extensions", "-e", path.resolve(__dirname, "..", "extensions", "multi-login", "index.ts"));
    if (roleContract) args.push("-e", roleSidecar);
    // --no-extensions also disables pi's built-in MCP client, so a contract that
    // allowlists MCP tools must load that built-in explicitly or every matching
    // tool is silently absent from the child.
    if ((roleContract?.toolPolicy?.allowedTools || []).some((name) => String(name).startsWith("mcp__"))) args.push("-e", "builtin:mcp");
    args.push("--no-skills", "--no-prompt-templates");
    const inheritedModel = roleContract?.budget === null ? modelPatternFromContext(context) : rpc.model || modelPatternFromContext(context);
    const inheritedThinkingLevel = roleContract?.budget === null ? thinkingLevelFromContext(context) : rpc.thinkingLevel || thinkingLevelFromContext(context);
    const inferenceProfile = roleContract
      ? selectRoleInferenceProfile(roleContract.modelPolicy, { inheritedModel, inheritedThinkingLevel, roleId: roleContract.roleId })
      : {
          selectedModel: rpc.model || record.modelPreference || DEFAULT_DELEGATE_MODEL,
          fallbackModel: inheritedModel,
          selectedThinkingLevel: rpc.thinkingLevel || inheritedThinkingLevel,
          modelPolicySource: rpc.model || record.modelPreference ? "preferred" : "default",
          thinkingPolicySource: "inherit",
        };
    if (inferenceProfile.selectedModel) args.push("--model", inferenceProfile.selectedModel);
    if (inferenceProfile.selectedThinkingLevel) args.push("--thinking", inferenceProfile.selectedThinkingLevel);
    if (roleContract && (!inferenceProfile.selectedModel || !inferenceProfile.selectedThinkingLevel)) throw new Error(`role ${roleContract.roleId} requires a resolved model and thinking level`);
    if (record.systemPrompt) args.push("--append-system-prompt", record.systemPrompt);
    if (roleContract) resolveRequiredTools(roleContract, rpc.availableTools || ACTUAL_CHILD_TOOLS, { throwOnMissing: true });
    const tools = rpc.tools ?? toolAllowlistFromPolicy(record.toolPolicy);
    if (tools != null) args.push("--tools", tools);
    const env = roleContract ? {
      PI_ROLE_SIDECAR: "1",
      PI_ROLE_CONTRACT_B64: Buffer.from(JSON.stringify(roleContract)).toString("base64url"),
      PI_ROLE_EXPECTED_MODEL: inferenceProfile.selectedModel,
      PI_ROLE_EXPECTED_THINKING_LEVEL: inferenceProfile.selectedThinkingLevel,
    } : {};
    return {
      command: rpc.command || process.env.PI_SUBAGENT_RPC_COMMAND || "pi",
      args,
      cwd,
      sessionDir,
      noSession,
      env,
      provenance: {
        selectedModel: inferenceProfile.selectedModel || null,
        fallbackModel: inferenceProfile.fallbackModel || null,
        modelPolicySource: inferenceProfile.modelPolicySource,
        selectedThinkingLevel: inferenceProfile.selectedThinkingLevel || null,
        thinkingPolicySource: inferenceProfile.thinkingPolicySource,
        roleSidecar: roleContract ? roleSidecar : null,
      },
    };
  }
  async runInRpcSubprocess(record, prompt, context = {}) {
    const images = context.images || [];
    if (!Array.isArray(images) || images.length > 4 || images.some(image => image?.type !== "image" || !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) || typeof image.data !== "string" || !image.data.length || image.data.length > 1398104 || Buffer.from(image.data, "base64").toString("base64") !== image.data)) throw Object.assign(new Error("Invalid or oversized RPC prompt images"), { code: "SUBAGENT_IMAGES_INVALID" });
    const currentRpcDepth = Math.max(0, envNumber("PI_SUBAGENT_RPC_DEPTH", 0));
    const maxRpcDepth = 1;
    if (currentRpcDepth >= maxRpcDepth) {
      const error = new Error(`subagent RPC nesting limit exceeded (${currentRpcDepth} >= ${maxRpcDepth}); nested sidecars are disabled`);
      error.code = "SUBAGENT_RPC_DEPTH_EXCEEDED";
      throw error;
    }
    const budget = normalizeBudget(record.budget);
    const tracker = createRpcBudgetTracker(budget);
    const launch = this.rpcArgs(record, context);
    const { command, args, cwd, sessionDir, noSession } = launch;
    if (!noSession) ensurePrivateDir(sessionDir);
    const executionStartedMs = Date.now();
    let promptAcceptedMs = null;
    const queueWaitMs = Math.max(0, Number(context.rpcTiming?.queueWaitMs || 0));
    const concurrencyLimit = Number(context.rpcTiming?.concurrencyLimit || rpcConcurrencyLimit(context));
    const guardConfig = resourceGuardConfig(context.rpc?.resourceGuard || {});
    const env = { ...process.env, ...(launch.env || {}), PI_SUBAGENT_PARENT_ID: record.id, PI_SUBAGENT_RPC_DEPTH: String(currentRpcDepth + 1) };
    delete env.PI_SUBAGENT_TOOL_RUNNER;
    const timeoutMs = record.budget === null ? null : Number(context.rpc?.timeoutMs || budget.wallClockMs || 5 * 60_000);
    const promptId = `subagent_prompt_${record.id}`;
    const stateId = `subagent_state_${record.id}`;
    const messagesId = `subagent_messages_${record.id}`;
    const visionStateId = `subagent_vision_${record.id}`;
    let visionReady = images.length === 0;
    const taskContained = Boolean(record.roleContract?.settings?.taskPolicy);
    const executable = taskContained ? require("./specialist-tools").executable("bwrap") : command;
    if (!executable) throw new Error("task RPC parent-death containment is unavailable");
    // The root bind is nodev, so ignored stdio needs a usable /dev/null.
    // Bind only that device: retain other device paths for explicitly granted
    // inner --dev-bind operations without enabling host-device access here.
    const launchArgs = taskContained ? ["--die-with-parent", "--unshare-pid", "--new-session", "--bind", "/", "/", "--proc", "/proc", "--dev-bind", "/dev/null", "/dev/null", "--chdir", cwd, "--", command, ...args] : args;
    const worker = taskContained ? await acquireManagedWorker() : null;
    let child;
    try { child = spawn(executable, launchArgs, { cwd, env: { ...env, ...worker?.environment }, detached: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { await worker?.release(); throw error; }
    let ownership;
    try {
      ownership = ownProcessGroup(child);
      context.onProcessSpawn?.({ subagentId: record.id, processGroupId: ownership.processGroupId, startTime: ownership.startTime });
    } catch (cause) {
      try { if (ownership) await terminateOwnedProcessGroup(ownership, { graceMs: guardConfig.termGraceMs }); }
      finally { await worker?.release(); }
      // spawn reports ENOENT asynchronously. Attach an error consumer before
      // returning a normal service-level launch failure.
      child.once("error", () => {});
      const error = new Error(`Pi RPC subagent failed to launch: ${cause?.message || String(cause)}`);
      error.code = "SUBAGENT_RPC_LAUNCH";
      error.termination = { code: "rpc_launch", stopReason: null, message: error.message };
      throw error;
    }
    const diagnosticEvidence = createDiagnosticEvidenceCollector({ subagentId: record.id, contract: record.roleContract });
    let stdout = "";
    let stderr = "";
    let agentEnd = null;
    let agentSettled = false;
    const configurationCommands = taskContained ? ["set_auto_retry"] : [];
    let configurationIndex = 0;
    let state = null;
    let messages = null;
    let stateDone = false;
    let messagesDone = false;
    let snapshotRequested = false;
    let settled = false;
    let lengthContinuations = 0;
    let timeoutTimer;
    let abortHandler;
    let rssMonitor;
    let terminationPromise;
    const send = (payload) => { if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(payload)}\n`); };
    const closePipes = () => {
      try { child.stdin.destroy(); } catch {}
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
    };
    const scheduleTerminate = () => {
      child.unref?.();
      if (!terminationPromise) {
        terminationPromise = terminateOwnedProcessGroup(ownership, {
          graceMs: guardConfig.termGraceMs,
          pollMs: Math.min(100, guardConfig.rssPollMs),
        }).then(result => {
          if (result.exited) context.onProcessClose?.({ subagentId: record.id, processGroupId: ownership.processGroupId, startTime: ownership.startTime });
          return result;
        }).finally(async () => { closePipes(); await worker?.release(); });
      }
      return terminationPromise;
    };
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      rssMonitor?.stop();
      if (abortHandler && context.signal) context.signal.removeEventListener?.("abort", abortHandler);
    };
    const finish = (resolve, reject, error, output) => {
      if (settled) return;
      settled = true;
      this.controls.delete(record.id);
      cleanup();
      const finishedMs = Date.now();
      const executionDurationMs = Math.max(0, finishedMs - executionStartedMs);
      const startupDurationMs = Math.max(0, (promptAcceptedMs ?? finishedMs) - executionStartedMs);
      const promptDurationMs = promptAcceptedMs === null ? 0 : Math.max(0, finishedMs - promptAcceptedMs);
      const totalDurationMs = queueWaitMs + executionDurationMs;
      if (!noSession) hardenDirectoryTree(sessionDir);
      const persistedSessionDir = noSession ? null : sessionDir;
      const timing = {
        queueWaitMs,
        startupDurationMs,
        promptDurationMs,
        executionDurationMs,
        totalDurationMs,
        wallClockBudgetMs: timeoutMs,
        rpcConcurrencyLimit: concurrencyLimit,
        rpcSessionDir: persistedSessionDir,
        queue_wait_ms: queueWaitMs,
        execution_duration_ms: executionDurationMs,
        total_duration_ms: totalDurationMs,
        wall_clock_budget_ms: timeoutMs,
        rpc_concurrency_limit: concurrencyLimit,
        rpc_session_dir: persistedSessionDir,
      };
      if (error) {
        error.diagnosticEvidence = diagnosticEvidence.snapshot();
        send({ type: "abort" });
        error.subagentDiagnostics = withLegacyDiagnosticAliases({
          ...tracker.snapshot(),
          selectedModel: launch.provenance?.selectedModel || null,
          fallbackModel: launch.provenance?.fallbackModel || null,
          modelPolicySource: launch.provenance?.modelPolicySource || null,
          selectedThinkingLevel: launch.provenance?.selectedThinkingLevel || null,
          thinkingPolicySource: launch.provenance?.thinkingPolicySource || null,
          ...(error.subagentDiagnostics || {}),
          ...timing,
        });
        void scheduleTerminate().then(() => reject(error), reject);
        return;
      }
      try { child.stdin.end(); } catch {}
      void scheduleTerminate().then(() => resolve({ ...(output || {}), diagnosticEvidence: diagnosticEvidence.snapshot(), ...timing, rpc_session_dir: output?.rpc_session_dir ?? persistedSessionDir }), reject);
    };
    return new Promise((resolve, reject) => {
      const protocolFailure = (message) => errorFromValidation({ termination: { code: "rpc_protocol", stopReason: null, message }, diagnostics: tracker.snapshot() });
      const armDeadline = (phase) => {
        // Startup is a protocol-health guard, not a deadline on specialist work.
        const limit = phase === "startup" ? timeoutMs ?? 300000 : timeoutMs;
        if (limit === null) return;
        timeoutTimer = setTimeout(() => {
          const startup = phase === "startup";
          const error = new Error(`subagent RPC ${startup ? "startup/prompt acceptance" : "wall-clock"} budget exceeded (${timeoutMs}ms)`);
          error.code = startup ? "SUBAGENT_RPC_STARTUP_TIMEOUT" : "SUBAGENT_TIMEOUT";
          error.termination = { code: startup ? "rpc_startup" : "wall_clock", stopReason: null, message: error.message };
          fail(error);
        }, limit);
        timeoutTimer.unref?.();
      };
      const configureOrPrompt = () => {
        if (settled) return;
        if (configurationIndex < configurationCommands.length) send({ id: `subagent_config_${record.id}_${configurationIndex}`, type: configurationCommands[configurationIndex], enabled: false });
        else if (!visionReady) send({ id: visionStateId, type: "get_state" });
        else send({ id: promptId, type: "prompt", message: prompt, ...(images.length ? { images } : {}) });
      };
      const requestCompletionSnapshot = () => {
        if (snapshotRequested || !agentEnd || (taskContained && !agentSettled)) return;
        snapshotRequested = true;
        send({ id: stateId, type: "get_state" });
        send({ id: messagesId, type: "get_messages" });
      };
      const maybeResolve = () => {
        if (settled || promptAcceptedMs === null || !agentEnd || !stateDone || !messagesDone || (taskContained && !agentSettled)) return;
        const effectiveModel = modelPattern(state?.model);
        const effectiveThinkingLevel = state?.thinkingLevel || null;
        if (record.roleContract && (effectiveModel !== launch.provenance?.selectedModel || effectiveThinkingLevel !== launch.provenance?.selectedThinkingLevel)) {
          const error = new Error(`role inference policy mismatch: expected ${launch.provenance?.selectedModel}/${launch.provenance?.selectedThinkingLevel}, got ${effectiveModel || "unknown"}/${effectiveThinkingLevel || "unknown"}`);
          error.code = "SUBAGENT_INFERENCE_POLICY_MISMATCH";
          error.termination = { code: "inference_policy_mismatch", stopReason: null, message: error.message };
          error.subagentDiagnostics = { effectiveModel, effectiveThinkingLevel };
          finish(resolve, reject, error);
          return;
        }
        const runMessages = Array.isArray(messages) && messages.length ? messages : (agentEnd.messages || []);
        const validation = validateRpcCompletion({ agentEnd, messages: runMessages, budget, roleContract: record.roleContract || null, requireRoleResultV2: !!record.roleContract, subagentId: record.id });
        if (!validation.ok) { finish(resolve, reject, errorFromValidation(validation)); return; }
        const text = truncateText(validation.finalResponse, budget.maxResultChars, "subagent final response truncated");
        finish(resolve, reject, null, {
          summary: text.slice(0, 500),
          final_response: text,
          artifacts: validation.submittedResult?.artifacts || [],
          proposed_parent_updates: validation.submittedResult?.proposed_parent_updates || validation.submittedResult?.proposedParentUpdates || [],
          submitted_result: validation.submittedResult,
          termination: validation.termination,
          selected_model: launch.provenance?.selectedModel || null,
          effective_model: effectiveModel,
          fallback_model: launch.provenance?.fallbackModel || null,
          model_policy_source: launch.provenance?.modelPolicySource || null,
          selected_thinking_level: launch.provenance?.selectedThinkingLevel || null,
          effective_thinking_level: effectiveThinkingLevel,
          thinking_policy_source: launch.provenance?.thinkingPolicySource || null,
          pi_session_file: noSession ? null : state?.sessionFile || null,
          rpc_session_dir: noSession ? null : sessionDir,
          ...validation.diagnostics,
        });
      };
      const fail = (error) => finish(resolve, reject, error);
      this.controls.set(record.id, {
        steer: (message) => { if (settled || !String(message || "").trim()) return false; send({ id: `subagent_steer_${record.id}_${Date.now()}`, type: "follow_up", message: String(message).slice(0, 4000) }); return true; },
        interrupt: (reason) => { if (settled) return false; const error = abortError(String(reason || "subagent interrupted").slice(0, 240)); error.code = "SUBAGENT_INTERRUPTED"; error.termination = { code: "interrupted", stopReason: "interrupted", messageCode: "interrupted" }; fail(error); return true; },
      });
      rssMonitor = watchOwnedProcessGroupRss(ownership, {
        includeDescendants: taskContained,
        limitBytes: guardConfig.rssLimitBytes,
        pollMs: guardConfig.rssPollMs,
        onExceeded: (usage) => {
          const error = new Error(`subagent RPC RSS limit exceeded (${usage.rssBytes} > ${usage.limitBytes} bytes)`);
          error.code = "SUBAGENT_RSS_LIMIT";
          error.termination = { code: "rss_limit", stopReason: "resource-guard", message: error.message };
          error.subagentDiagnostics = withLegacyDiagnosticAliases({ peakRssBytes: usage.peakRssBytes, rssLimitBytes: usage.limitBytes, processGroupMembers: usage.members, peak_rss_bytes: usage.peakRssBytes, rss_limit_bytes: usage.limitBytes, process_group_members: usage.members });
          fail(error);
        },
      });
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        for (;;) {
          const idx = stdout.indexOf("\n");
          if (idx < 0) break;
          const raw = stdout.slice(0, idx).replace(/\r$/, "");
          stdout = stdout.slice(idx + 1);
          if (!raw.trim()) continue;
          let event;
          try { event = JSON.parse(raw); } catch { fail(jsonLineError("invalid Pi RPC JSON", raw)); return; }
          if (settled) return;
          try { diagnosticEvidence.observe(event); } catch (error) { fail(error); return; }
          const streamViolation = tracker.observe(event);
          if (streamViolation) {
            const validation = { termination: { code: streamViolation.terminationCode, stopReason: null, message: `subagent ${streamViolation.terminationCode} limit exceeded (${streamViolation.actual} > ${streamViolation.limit})` }, diagnostics: withLegacyDiagnosticAliases({ ...tracker.snapshot(), ...streamViolation }), violation: streamViolation };
            fail(errorFromValidation(validation));
            return;
          }
          if (event.type === "response" && configurationIndex < configurationCommands.length && event.id === `subagent_config_${record.id}_${configurationIndex}`) {
            if (event.command !== configurationCommands[configurationIndex] || event.success !== true) { fail(protocolFailure("Task RPC failure-stop configuration was rejected")); return; }
            configurationIndex++; configureOrPrompt(); continue;
          }
          if (event.type === "response" && event.id === visionStateId) {
            if (event.command !== "get_state" || event.success !== true || !Array.isArray(event.data?.model?.input) || !event.data.model.input.includes("image")) {
              const error = protocolFailure("Selected model does not declare image input support");
              error.code = "SUBAGENT_VISION_UNAVAILABLE"; fail(error); return;
            }
            if (!visionReady) { visionReady = true; configureOrPrompt(); }
            continue;
          }
          if (event.type === "agent_start") agentSettled = false;
          if (event.type === "agent_settled") { agentSettled = true; requestCompletionSnapshot(); maybeResolve(); continue; }
          if (event.type === "response" && event.id === promptId) {
            if (event.command !== "prompt" || event.success !== true) { const error = protocolFailure(event.error || "Pi RPC subagent prompt was rejected"); error.code = "SUBAGENT_RPC_PROMPT_REJECTED"; fail(error); return; }
            if (!settled && promptAcceptedMs === null) {
              // Pi acknowledges acceptance before streaming the run. Startup has
              // its own bound; duplicates and continuations must not renew execution.
              promptAcceptedMs = Date.now();
              clearTimeout(timeoutTimer);
              armDeadline("execution");
            }
            maybeResolve();
            continue;
          }
          if (event.type === "response" && event.id === stateId) {
            if (!event.success || !event.data || typeof event.data !== "object") { fail(protocolFailure(event.error || "Pi RPC get_state failed")); return; }
            state = event.data; stateDone = true; maybeResolve(); continue;
          }
          if (event.type === "response" && event.id === messagesId) {
            if (!event.success || !Array.isArray(event.data?.messages)) { fail(protocolFailure(event.error || "Pi RPC get_messages failed")); return; }
            messages = event.data.messages; messagesDone = true; maybeResolve(); continue;
          }
          if (event.type === "response" && String(event.id || "").startsWith(`subagent_continue_${record.id}`) && event.success === false) { fail(protocolFailure(event.error || "Pi RPC continuation was rejected")); return; }
          if (event.type === "agent_end") {
            if (settled || event.willRetry === true) continue;
            const eventMessages = Array.isArray(event.messages) ? event.messages : [];
            const terminal = terminalAssistantMessage(eventMessages);
            const eventDiagnostics = messageDiagnostics(eventMessages);
            const canContinue = terminal?.stopReason === "length"
              && lengthContinuations < budget.maxLengthContinuations
              && (!Number.isFinite(budget.maxModelCalls) || eventDiagnostics.modelCalls < budget.maxModelCalls);
            if (canContinue) {
              lengthContinuations += 1;
              send({ id: `subagent_continue_${record.id}_${lengthContinuations}`, type: "follow_up", message: "Continue from the previous response and finish with a concise final result within the remaining budget." });
              continue;
            }
            if (agentEnd) continue;
            agentEnd = event;
            requestCompletionSnapshot();
            maybeResolve();
            continue;
          }
          if (event.type === "extension_error") {
            const extensionFailure = { extensionPath: event.extensionPath || null, event: event.event || null };
            const extensionMessage = String(event.error?.message || event.error || "");
            const inferenceMismatch = /role inference policy mismatch/i.test(extensionMessage);
            const inferenceInvalid = /role inference policy invalid/i.test(extensionMessage);
            const effectiveProfile = inferenceMismatch ? extensionMessage.match(/got (.+)\/(off|minimal|low|medium|high|xhigh|max)(?:$|\n)/i) : null;
            const terminationCode = inferenceMismatch ? "inference_policy_mismatch" : inferenceInvalid ? "inference_policy_invalid" : "extension_load";
            const termination = { code: terminationCode, stopReason: null, message: inferenceMismatch ? "role inference policy mismatch" : inferenceInvalid ? "role inference policy invalid" : "role sidecar extension failed" };
            this.trace?.emit?.({ category: "failure_state", name: "subagent.rpc_extension_error", severity: "error", agent_id: record.id, payload: { status: "failed", termination: { code: termination.code, stopReason: termination.stopReason }, ...extensionFailure } });
            const error = errorFromValidation({ termination, diagnostics: tracker.snapshot() });
            error.code = inferenceMismatch ? "SUBAGENT_INFERENCE_POLICY_MISMATCH" : inferenceInvalid ? "SUBAGENT_INFERENCE_POLICY_INVALID" : "SUBAGENT_EXTENSION_LOAD";
            if (effectiveProfile) error.subagentDiagnostics = { effectiveModel: effectiveProfile[1], effectiveThinkingLevel: effectiveProfile[2].toLowerCase() };
            fail(error);
            return;
          }
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
      child.stdin.on("error", (error) => { if (!settled) fail(error); });
      child.on("error", (cause) => { const error = new Error(`Pi RPC subagent failed to launch: ${cause?.message || String(cause)}`); error.code = "SUBAGENT_RPC_LAUNCH"; error.termination = { code: "rpc_launch", stopReason: null, message: error.message }; fail(error); });
      child.on("exit", (code, signal) => {
        if (settled) return;
        const error = new Error(`Pi RPC subagent exited before completion (code=${code}, signal=${signal})${stderr ? `\n${stderr}` : ""}`);
        error.code = "SUBAGENT_RPC_EXIT";
        error.termination = { code: "rpc_exit", stopReason: signal ? "signal" : null, message: `Pi RPC child exited before completion (code=${code}, signal=${signal})` };
        fail(error);
      });
      armDeadline("startup");
      abortHandler = () => { const error = abortError("subagent RPC run aborted"); error.code = "SUBAGENT_ABORTED"; error.termination = { code: "cancelled", stopReason: "aborted", message: error.message }; fail(error); };
      if (context.signal?.aborted) return abortHandler();
      context.signal?.addEventListener?.("abort", abortHandler, { once: true });
      configureOrPrompt();
    });
  }
}

class SubagentMergeService {
  constructor({ store, branchManager, trace } = {}) { this.store = store; this.branchManager = branchManager; this.trace = trace; }
  merge({ subagentId, targetSessionId, mergePolicy } = {}) {
    const record = this.store.get(subagentId);
    if (!record) throw new Error(`subagent not found: ${subagentId}`);
    const result = this.store.getResult(subagentId) || defaultResultEnvelope(record);
    const policy = normalizeMergePolicy(mergePolicy || record.mergePolicy || "none");
    const at = nowIso();
    let parentUpdate = null;
    if (policy === "summary_only") parentUpdate = { type: "subagent.summary", at, targetSessionId: targetSessionId || record.parentSessionId, subagentId, summary: result.summary || String(result.final_response || "").slice(0, 800) };
    if (policy === "full_result") parentUpdate = { type: "subagent.full_result", at, targetSessionId: targetSessionId || record.parentSessionId, subagentId, result };
    if (policy === "proposed_patch") parentUpdate = { type: "subagent.proposed_patch", at, targetSessionId: targetSessionId || record.parentSessionId, subagentId, proposedPatch: result.proposedPatch || null, proposed_parent_updates: result.proposed_parent_updates || [], artifacts: result.artifacts || [], filesystemApplied: false, note: "Trajectory merge only; preview/apply the retained workspace patch explicitly." };
    if (parentUpdate) {
      const parentBranchId = record.parentBranchId;
      if (parentBranchId && this.branchManager?.getBranch?.(parentBranchId)) {
        this.branchManager.checkpoint(parentBranchId, subagentBranchSnapshotState({ contextState: { subagentMerge: parentUpdate }, metadata: { kind: "subagent.merge", subagentId, mergePolicy: policy } }));
      } else if (parentBranchId && this.branchManager?.requireBranch) {
        try { this.branchManager.checkpoint(parentBranchId, subagentBranchSnapshotState({ contextState: { subagentMerge: parentUpdate }, metadata: { kind: "subagent.merge", subagentId, mergePolicy: policy } })); } catch {}
      }
      record.parentUpdates = [...(record.parentUpdates || []), parentUpdate];
    }
    record.mergedAt = at;
    record.effectiveMergePolicy = policy;
    this.store.save(record);
    this.store.event("subagent.merged", { subagentId, parentSessionId: targetSessionId || record.parentSessionId, status: record.status, counts: { parentUpdates: parentUpdate ? 1 : 0 } });
    this.trace?.emit?.({ category: "agent_branching", name: "subagent.merged", agent_id: subagentId, payload: { mergePolicy: policy } });
    return { record: clone(record), result, parentUpdate, mergePolicy: policy };
  }
}

class SubagentService {
  constructor({ cwd = process.cwd(), store, branchManager, runner, workspaceManager, patchService, trace, config = {} } = {}) {
    this.cwd = cwd;
    this.store = store || new SubagentStore({ cwd });
    this.branchManager = branchManager || new SessionBranchManager({ cwd, store: new SnapshotStore(path.join(cwd, ".pi", "session-branches")) });
    this.runner = runner || new SubagentRunner({ trace });
    this.workspaceManager = workspaceManager || new SubagentWorkspaceManager({ cwd });
    this.patchService = patchService || null;
    this.trace = trace;
    this.config = { maxConcurrentPerParent: 8, defaultStepBudget: envNumber("PI_SUBAGENT_DEFAULT_STEP_BUDGET", 8), defaultToolCallBudget: envNumber("PI_SUBAGENT_DEFAULT_TOOL_CALL_BUDGET", 64), defaultWallClockMs: envNumber("PI_SUBAGENT_DEFAULT_WALL_CLOCK_MS", 5 * 60_000), defaultQueueWaitMs: envNumber("PI_SUBAGENT_DEFAULT_QUEUE_WAIT_MS", 5 * 60_000), defaultResultChars: subagentFinalResponseLimit(), defaultLengthContinuations: envNumber("PI_SUBAGENT_MAX_LENGTH_CONTINUATIONS", 0), ...config, maxDepth: 1 };
    this.activeRuns = new Map();
    this.runtimeInputs = new Map();
    this.subscribers = new Set();
    this.store.onEvent = (event) => { for (const subscriber of this.subscribers) { try { subscriber(event); } catch {} } };
    this.mergeService = new SubagentMergeService({ store: this.store, branchManager: this.branchManager, trace });
  }

  subscribe(listener) { if (typeof listener !== "function") throw new Error("subagent subscriber must be a function"); this.subscribers.add(listener); return () => this.subscribers.delete(listener); }
  materializeRuntimeRecord(record) {
    const runtime = this.runtimeInputs.get(record.id) || {};
    const builtin = runtime.roleContract || (record.roleContractVersion ? DEFAULT_ROLE_CONTRACTS.find((contract) => contract.roleId === record.role && (!record.roleRevision || roleRevision(contract) === record.roleRevision)) : null) || null;
    return { ...record, task: runtime.task || record.task || null, systemPrompt: runtime.systemPrompt || record.systemPrompt || builtin?.systemPrompt || null, roleContract: builtin || record.roleContract || null, seedPatches: runtime.seedPatches || record.seedPatches || [] };
  }
  preflightSubagent(args = {}, options = {}) {
    const activeStatuses = options.launch === true ? ["queued", "running"] : ["created", "queued", "running"];
    const activeCount = args.parentSessionId ? this.listSubagents({ parentSessionId: args.parentSessionId }).filter((record) => record.id !== options.excludeSubagentId && activeStatuses.includes(record.status)).length : 0;
    const result = resolveSubagentPreflight(args, {
      activeCount,
      maxConcurrentPerParent: this.config.maxConcurrentPerParent,
      actualTools: options.actualTools || args.actualTools || ACTUAL_CHILD_TOOLS,
      inheritedModel: options.inheritedModel || args.inheritedModel || null,
      inheritedThinkingLevel: options.inheritedThinkingLevel || args.inheritedThinkingLevel || null,
      defaultBudget: { maxModelCalls: this.config.defaultStepBudget, maxToolCalls: this.config.defaultToolCallBudget, wallClockMs: this.config.defaultWallClockMs, maxQueueWaitMs: this.config.defaultQueueWaitMs, maxResultChars: this.config.defaultResultChars, maxLengthContinuations: this.config.defaultLengthContinuations },
      resourceGuard: options.resourceGuard || args.resourceGuard || {},
      allowUnresolvedInference: options.allowUnresolvedInference === true,
    });
    if (result.allowed && args.roleContract) {
      const capabilities = require("./specialist-tools").capabilityStatus(args.roleContract);
      if (!capabilities.available) { result.allowed = false; result.decision = "blocked"; result.reasons.push(...capabilities.reasons); }
      if (args.roleContract.inputSchema) {
        if (!args.roleContract.settings?.taskPolicy) { result.allowed = false; result.decision = "blocked"; result.reasons.push("role-task-contract-required"); }
        const { validateJsonSchema } = require("./role-result-schemas");
        if (validateJsonSchema(args.roleContract.inputSchema, args.roleContract.settings?.domainInput).length) { result.allowed = false; result.decision = "blocked"; result.reasons.push("role-domain-input-required"); }
      }
      try { assertRoleRuntimeExecutionAllowed({ config: resolveRoleRuntimeConfig(process.env, { cwd: this.cwd }), topology: { roleRuntimeVersion: 2, contractVersion: "role-v2", nodes: [{ roleId: args.roleContract.roleId, workspacePolicy: result.effective.workspacePolicy, mutationPolicy: result.effective.mutationPolicy, executionMode: "subagent" }] }, enforceRollout: this.config.enforceRoleRollout === true }); }
      catch { result.allowed = false; result.decision = "blocked"; result.reasons = [...new Set([...result.reasons, "role-rollout-denied"])].sort(); }
    }
    return result;
  }

  createSubagent(args = {}) {
    if (!args.parentSessionId) throw new Error("parentSessionId is required");
    if (!args.task) throw new Error("task is required");
    const roleContract = args.roleContract ? validateRoleContract(args.roleContract) : null;
    const workspacePolicy = args.workspacePolicy || roleContract?.workspacePolicy || "shared-readonly";
    const mutationPolicy = args.mutationPolicy || roleContract?.mutationPolicy || "forbidden";
    if (!["handler-only", "shared-readonly", "isolated-worktree"].includes(workspacePolicy)) throw new Error(`invalid subagent workspace policy: ${workspacePolicy}`);
    if (!["forbidden", "proposed-patch", "isolated-only"].includes(mutationPolicy)) throw new Error(`invalid subagent mutation policy: ${mutationPolicy}`);
    if (workspacePolicy === "handler-only") throw new Error(`role ${args.role || roleContract?.roleId || "unknown"} is handler-only and cannot launch as a subagent`);
    if (workspacePolicy !== "isolated-worktree" && mutationPolicy !== "forbidden") throw new Error("mutating subagents require isolated-worktree");
    if (roleContract) assertRoleRuntimeExecutionAllowed({ config: resolveRoleRuntimeConfig(process.env, { cwd: this.cwd }), topology: { roleRuntimeVersion: 2, contractVersion: "role-v2", nodes: [{ roleId: roleContract.roleId, workspacePolicy, mutationPolicy, executionMode: "subagent" }] }, enforceRollout: this.config.enforceRoleRollout === true });
    const mergePolicy = normalizeMergePolicy(args.mergePolicy || "none");
    const depth = Number(args.depth ?? this.parentDepth(args.parentSubagentId) + 1 ?? 1);
    if (args.parentSubagentId || depth > this.config.maxDepth) { const error = new Error("nested subagent delegation is disabled"); error.code = "SUBAGENT_NESTED_DELEGATION_DENIED"; throw error; }
    const concurrent = this.listSubagents({ parentSessionId: args.parentSessionId }).filter((s) => ["created", "queued", "running"].includes(s.status)).length;
    if (concurrent >= this.config.maxConcurrentPerParent) throw new Error(`maximum concurrent subagents exceeded for parent session ${args.parentSessionId}`);

    const createdAt = nowIso();
    const requestedBudget = normalizeBudget(roleContract?.budget === null ? null : args.budget || roleContract?.budget || {}, { maxModelCalls: this.config.defaultStepBudget, maxToolCalls: this.config.defaultToolCallBudget, wallClockMs: this.config.defaultWallClockMs, maxQueueWaitMs: this.config.defaultQueueWaitMs, maxResultChars: this.config.defaultResultChars, maxLengthContinuations: this.config.defaultLengthContinuations });
    const budget = roleContract?.budget === null ? null : roleContract ? normalizeBudget(Object.fromEntries(["maxModelCalls", "maxToolCalls", "wallClockMs", "maxQueueWaitMs", "maxResultChars", "maxLengthContinuations"].map((name) => [name, Math.min(Number(requestedBudget[name]), Number(roleContract.budget[name]))]))) : requestedBudget;
    const preflight = this.preflightSubagent({ ...args, roleContract, workspacePolicy, mutationPolicy, budget, depth }, { allowUnresolvedInference: true });
    if (!preflight.allowed) { const error = new Error(`subagent preflight blocked: ${preflight.reasons.join(",")}`); error.code = "SUBAGENT_PREFLIGHT_BLOCKED"; error.preflight = preflight; throw error; }
    const id = args.id || `sub_${shortHash({ parentSessionId: args.parentSessionId, task: args.task, role: args.role, createdAt, random: crypto.randomBytes(8).toString("hex") })}`;
    if (this.store.get(id)) return this.store.get(id);
    const parentBranchId = args.parentBranchId || args.branchFrom?.branchId || null;
    const parentSnapshotId = args.parentSnapshotId || args.branchFrom?.snapshotId || args.branchFrom?.checkpointId || null;
    const metadata = {
      ...compactSubagentBranchMetadata(args.metadata || {}),
      kind: "subagent",
      parentSessionId: args.parentSessionId,
      parentTrajectoryId: args.parentTrajectoryId || args.branchFrom?.trajectoryId || null,
      parentBranchId,
      branchFrom: args.branchFrom || null,
      subagentId: id,
      subagentRole: args.role || roleContract?.roleId || null,
      task: args.task,
      createdAt,
      status: "created",
      roleContractVersion: roleContract?.contractVersion || null,
      workspacePolicy,
      mutationPolicy,
      seedPatchHashes: (args.seedPatches || []).map((patch) => patch.patchHash).filter(Boolean),
      budget,
      mergePolicy,
      depth,
    };
    const branchMetadata = compactSubagentBranchMetadata(metadata, args.task);
    const branch = this.branchManager.createBranch({ fromBranchId: parentBranchId, fromSnapshotId: parentSnapshotId, type: "multi-agent", name: `subagent ${args.role || "worker"}: ${id}`, metadata: branchMetadata, states: subagentBranchSnapshotState({ contextState: { subagent: branchMetadata }, toolState: { toolPolicy: args.toolPolicy || null } }) });
    this.branchManager.assignAgent(branch.id, id, { role: args.role || roleContract?.roleId || null, toolPolicy: args.toolPolicy || roleContract?.toolPolicy || null, workspacePolicy, mutationPolicy, budget, taskHash: shortHash(args.task) });
    const record = {
      id,
      parentSessionId: args.parentSessionId,
      parentTrajectoryId: metadata.parentTrajectoryId,
      parentBranchId,
      parentSnapshotId,
      branchFrom: args.branchFrom || null,
      branchId: branch.id,
      trajectoryId: branch.id,
      schemaVersion: 3,
      role: args.role || roleContract?.roleId || null,
      roleRevision: roleRevision(roleContract),
      roleContractVersion: roleContract?.contractVersion || null,
      taskHash: `sha256:${lifecycleSha256(args.task)}`,
      systemPromptHash: args.systemPrompt || roleContract?.systemPrompt ? `sha256:${lifecycleSha256(args.systemPrompt || roleContract.systemPrompt)}` : null,
      toolPolicy: args.toolPolicy || roleContract?.toolPolicy || null,
      modelPolicy: args.modelPolicy || roleContract?.modelPolicy || null,
      modelPreference: args.modelPreference || roleContract?.modelPreference || null,
      workspacePolicy,
      mutationPolicy,
      seedPatchHashes: (args.seedPatches || []).map((patch) => patch.patchHash).filter(Boolean),
      workspace: null,
      memoryPolicy: args.memoryPolicy || roleContract?.memoryPolicy || "none",
      contextProjection: args.contextProjection || roleContract?.maxContextPolicy || { kind: "summarized", maxTokens: 8000 },
      budget,
      metadata: compactSubagentBranchMetadata(args.metadata || {}),
      mergePolicy,
      status: "created",
      controlState: null,
      resumable: false,
      depth,
      rootAttemptId: args.rootAttemptId || id,
      previousAttemptId: args.previousAttemptId || null,
      attempt: Math.max(1, Number(args.attempt || 1)),
      childKey: args.childKey || (args.metadata?.topologyRunId && args.metadata?.nodeId ? `child_${shortHash({ topologyRunId: args.metadata.topologyRunId, nodeId: args.metadata.nodeId, attempt: Math.max(1, Number(args.attempt || 1)) })}` : `child_${shortHash({ parentSessionId: args.parentSessionId, role: args.role || roleContract?.roleId || "worker", taskHash: lifecycleSha256(args.task), attempt: Math.max(1, Number(args.attempt || 1)) })}`),
      launchDigest: preflight.launchDigest,
      createdAt,
      updatedAt: createdAt,
      diagnostics: withLegacyDiagnosticAliases({ diagnosticsSchemaVersion: 2, modelCalls: 0, toolCalls: 0, toolResults: 0, toolFailures: 0, unmatchedToolCallIds: [], unmatchedToolResultIds: [], tokenUsage: {}, errors: [] }),
    };
    this.runtimeInputs.set(id, { task: args.task, systemPrompt: args.systemPrompt || roleContract?.systemPrompt || null, roleContract, seedPatches: clone(args.seedPatches || []) });
    this.store.save(record);
    this.store.event("subagent.created", { subagentId: id, parentSessionId: record.parentSessionId, branchId: branch.id, topologyRunId: record.metadata?.topologyRunId, topologyId: record.metadata?.topologyId, nodeId: record.metadata?.nodeId, status: record.status, launchDigest: record.launchDigest });
    this.trace?.emit?.({ category: "agent_branching", name: "subagent.created", agent_id: id, session_id: record.parentSessionId, payload: { branchId: branch.id, role: record.role } });
    return clone(record);
  }

  parentDepth(parentSubagentId) { const p = parentSubagentId ? this.store.get(parentSubagentId) : null; return p ? Number(p.depth || 0) : 0; }
  getSubagent({ subagentId } = {}) { const r = this.store.get(subagentId); if (!r) return null; return { ...r, result: this.store.getResult(subagentId) }; }
  listSubagents({ parentSessionId } = {}) { return this.store.list({ parentSessionId }); }

  launchSubagent({ subagentId, context = {}, mergePolicy } = {}) {
    let record = this.store.get(subagentId);
    if (!record) throw new Error(`subagent not found: ${subagentId}`);
    if (context.executionMode && context.executionMode !== "tool-rpc") { const error = new Error("subagent execution requires the canonical tool-rpc sidecar"); error.code = "SUBAGENT_EXECUTION_MODE_INVALID"; throw error; }
    if (FINAL_STATUSES.has(record.status)) return { launched: false, alreadyTerminal: true, subagentId, status: record.status, result: this.store.getResult(subagentId) };
    const active = this.activeRuns.get(subagentId);
    if (active) return { launched: false, alreadyActive: true, subagentId, status: record.status, launchDigest: record.launchDigest };
    if (RUNNING_STATUSES.has(record.status)) {
      if (supervisorAlive(record.owner)) return { launched: false, alreadyActive: true, subagentId, status: record.status, launchDigest: record.launchDigest, reasonCode: "supervised-by-another-process" };
      const recovered = this.finalizeInterruptedRun(record);
      if (!recovered) return { launched: false, alreadyTerminal: true, subagentId, status: this.store.get(subagentId)?.status || record.status, result: this.store.getResult(subagentId) };
      return { launched: false, alreadyTerminal: true, recovered: true, subagentId, status: recovered.status, result: this.store.getResult(subagentId) };
    }
    const executionRecord = this.materializeRuntimeRecord(record);
    if (!executionRecord.task) { const error = new Error("subagent task text is unavailable after restart; create a new linked attempt with an explicit task"); error.code = "SUBAGENT_TASK_UNAVAILABLE"; throw error; }
    const preflight = this.preflightSubagent(executionRecord, { launch: true, excludeSubagentId: subagentId, inheritedModel: modelPatternFromContext(context), inheritedThinkingLevel: thinkingLevelFromContext(context), actualTools: context.rpc?.availableTools || ACTUAL_CHILD_TOOLS, resourceGuard: context.rpc?.resourceGuard || {} });
    if (!preflight.allowed) { this.store.event("subagent.result_rejected", { subagentId, parentSessionId: record.parentSessionId, status: "blocked", reasonCode: preflight.reasons[0] || "preflight-blocked" }); const error = new Error(`subagent launch preflight blocked: ${preflight.reasons.join(",")}`); error.code = "SUBAGENT_PREFLIGHT_BLOCKED"; error.preflight = preflight; throw error; }
    record.launchDigest = preflight.launchDigest;
    record.admittedAt = nowIso();
    record.updatedAt = record.admittedAt;
    this.store.save(record);
    this.store.event("subagent.admitted", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, launchDigest: record.launchDigest });
    const controller = new AbortController();
    const externalAbort = () => controller.abort(abortError("subagent parent run aborted"));
    if (context.signal?.aborted) externalAbort(); else context.signal?.addEventListener?.("abort", externalAbort, { once: true });
    const promise = this._executeSubagent({ subagentId, context: { ...context, signal: controller.signal }, mergePolicy })
      .finally(() => { context.signal?.removeEventListener?.("abort", externalAbort); this.activeRuns.delete(subagentId); });
    this.activeRuns.set(subagentId, { promise, controller, startedAt: Date.now(), launchDigest: record.launchDigest });
    return { launched: true, subagentId, status: this.store.get(subagentId)?.status || record.status, launchDigest: record.launchDigest, degradations: preflight.degradations };
  }
  async waitSubagent({ subagentId, timeoutMs } = {}) {
    const record = this.store.get(subagentId);
    if (!record) throw new Error(`subagent not found: ${subagentId}`);
    if (FINAL_STATUSES.has(record.status)) return this.store.getResult(subagentId) || defaultResultEnvelope(record);
    const active = this.activeRuns.get(subagentId);
    if (!active) { const latest = this.store.get(subagentId) || record; if (FINAL_STATUSES.has(latest.status)) return this.store.getResult(subagentId) || defaultResultEnvelope(latest); return { schemaVersion: 1, subagentId, status: latest.status, waiting: false, reasonCode: "not-running" }; }
    const waitMs = Math.max(0, Math.min(9 * 60_000, Number(timeoutMs ?? record.budget?.wallClockMs ?? this.config.defaultWallClockMs)));
    if (waitMs === 0) return { schemaVersion: 1, subagentId, status: this.store.get(subagentId)?.status || record.status, waiting: true, timedOut: true };
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ schemaVersion: 1, subagentId, status: this.store.get(subagentId)?.status || "running", waiting: true, timedOut: true }), waitMs); timer.unref?.(); });
    try { return await Promise.race([active.promise, timeout]); } finally { if (timer) clearTimeout(timer); }
  }
  async runSubagent({ subagentId, context = {}, mergePolicy } = {}) {
    const launch = this.launchSubagent({ subagentId, context, mergePolicy });
    if (launch.result) return launch.result;
    const record = this.store.get(subagentId);
    if (record?.budget === null) return this.activeRuns.get(subagentId)?.promise || this.store.getResult(subagentId);
    return this.waitSubagent({ subagentId, timeoutMs: Number(record?.budget?.maxQueueWaitMs || 0) + Number(record?.budget?.wallClockMs || this.config.defaultWallClockMs) + 5000 });
  }
  steerSubagent({ subagentId, message } = {}) {
    const record = this.store.get(subagentId); if (!record) throw new Error(`subagent not found: ${subagentId}`);
    const text = String(message || "").trim(); if (!text) throw new Error("subagent steer requires a message");
    if (!this.activeRuns.has(subagentId) || !["queued", "running"].includes(record.status)) return { acknowledged: false, subagentId, status: record.status, reasonCode: "not-active" };
    const acknowledged = this.runner.steer(subagentId, text.slice(0, 4000));
    this.store.event(acknowledged ? "subagent.steer_acknowledged" : "subagent.steer_rejected", { subagentId, parentSessionId: record.parentSessionId, status: record.status, control: "steer", acknowledgement: acknowledged ? "accepted" : "unsupported", counts: { characters: Math.min(4000, text.length) } });
    return { acknowledged, subagentId, status: record.status, reasonCode: acknowledged ? null : "runner-steer-unsupported", messageHash: `sha256:${lifecycleSha256(text)}` };
  }
  interruptSubagent({ subagentId, reasonCode = "user-interrupt" } = {}) {
    const record = this.store.get(subagentId); if (!record) throw new Error(`subagent not found: ${subagentId}`);
    if (!this.activeRuns.has(subagentId) || !["queued", "running"].includes(record.status)) return { acknowledged: false, subagentId, status: record.status, reasonCode: "not-active" };
    record.controlState = "interrupt-requested"; record.resumable = true; record.updatedAt = nowIso(); this.store.save(record);
    const runnerAcknowledged = this.runner.interrupt(subagentId, "subagent interrupted");
    if (!runnerAcknowledged) this.activeRuns.get(subagentId)?.controller.abort(abortError("subagent interrupted"));
    this.store.event("subagent.interrupt_acknowledged", { subagentId, parentSessionId: record.parentSessionId, status: record.status, control: "interrupt", acknowledgement: "accepted", reasonCode });
    return { acknowledged: true, subagentId, status: record.status, reasonCode: "interrupt-requested", resumable: true };
  }
  async _executeSubagent({ subagentId, context = {}, mergePolicy } = {}) {
    let record = this.store.get(subagentId);
    if (!record) throw new Error(`subagent not found: ${subagentId}`);
    if (record.status === "succeeded" && this.store.getResult(subagentId)) return this.store.getResult(subagentId);
    if (record.status === "running") return this.store.getResult(subagentId) || defaultResultEnvelope(record, { summary: "Subagent is already running." });
    if (record.status === "cancelled") return this.store.getResult(subagentId) || defaultResultEnvelope(record);
    const queuedExecution = context?.executionMode === "tool-rpc";
    record.status = queuedExecution ? "queued" : "running";
    if (queuedExecution) record.queuedAt = record.queuedAt || nowIso(); else record.startedAt = record.startedAt || nowIso();
    record.updatedAt = queuedExecution ? record.queuedAt : record.startedAt;
    record.owner = supervisingProcess();
    this.store.save(record);
    this.store.event(queuedExecution ? "subagent.queued" : "subagent.started", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status });
    this.trace?.emit?.({ category: "agent_branching", name: queuedExecution ? "subagent.queued" : "subagent.started", agent_id: subagentId, payload: { branchId: record.branchId } });
    const startedMs = Date.now();
    const errors = [];
    let workspaceLease = null;
    let workspaceCapture = null;
    let workspaceDisposition = null;
    try {
      let runtimeRecord = this.materializeRuntimeRecord(record);
      if (!runtimeRecord.task) { const error = new Error("subagent task text is unavailable"); error.code = "SUBAGENT_TASK_UNAVAILABLE"; throw error; }
      let executionContext = { ...(context || {}), cwd: context.cwd || this.cwd, parentCwd: this.cwd };
      if (record.workspacePolicy === "isolated-worktree") {
        workspaceLease = this.workspaceManager.acquire({ subagentId: record.id, parentSessionId: record.parentSessionId, task: runtimeRecord.task, seedPatches: runtimeRecord.seedPatches || [], allowParallelWorkspace: record.metadata?.allowParallelWorkspace === true, mergeOrder: record.metadata?.mergeOrder, writeZones: runtimeRecord.roleContract?.settings?.taskPolicy?.writeZones || null });
        record.workspace = { policy: "isolated-worktree", state: "active", path: workspaceLease.workspaceDir, cwd: workspaceLease.cwd, parentRevision: workspaceLease.parentRevision, parentStatusFingerprint: workspaceLease.parentStatusFingerprint.statusHash, baselineCommit: workspaceLease.baselineCommit };
        this.store.save(record);
        executionContext = { ...executionContext, cwd: workspaceLease.cwd, parentCwd: this.cwd, workspace: record.workspace };
        runtimeRecord = { ...runtimeRecord, workspace: record.workspace };
      }
      this.branchManager.checkpoint(record.branchId, subagentBranchSnapshotState({ contextState: { subagentStatus: "running", task: runtimeRecord.task, workspace: record.workspace ? { policy: record.workspace.policy, path: record.workspace.path, parentRevision: record.workspace.parentRevision } : { policy: record.workspacePolicy } }, metadata: { kind: "subagent.started", subagentId } }));
      const output = await this.runWithTimeout(runtimeRecord, executionContext);
      if (runtimeRecord.roleContract) {
        const submittedResult = output?.submitted_result || output?.submittedResult;
        const validation = validateRoleResultEnvelope(submittedResult, { contract: runtimeRecord.roleContract, subagentId: record.id });
        if (!validation.ok) { const error = new Error(`role-v2 result validation failed: ${validation.errors.join("; ")}`); error.code = "SUBAGENT_INVALID_RESULT"; error.termination = { code: "invalid_result", stopReason: null, message: error.message }; throw error; }
        if (submittedResult.status !== "succeeded") {
          const error = new Error(`role-v2 child reported ${submittedResult.status} (${submittedResult.termination?.code || "unknown"})`);
          error.code = submittedResult.status === "timed_out" ? "SUBAGENT_TIMEOUT" : submittedResult.status === "cancelled" ? "SUBAGENT_ABORTED" : "SUBAGENT_REPORTED_FAILURE";
          if (submittedResult.status === "cancelled") error.name = "AbortError";
          error.reportedStatus = submittedResult.status;
          error.submittedResult = submittedResult;
          error.termination = submittedResult.termination;
          error.subagentDiagnostics = withLegacyDiagnosticAliases({
            ...(submittedResult.diagnostics || {}),
            modelCalls: Number(output.modelCalls ?? output.model_calls ?? submittedResult.diagnostics?.modelCalls ?? 0),
            toolCalls: Number(output.toolCalls ?? output.tool_calls ?? submittedResult.diagnostics?.toolCalls ?? 0),
            toolResults: Number(output.toolResults ?? output.tool_results ?? submittedResult.diagnostics?.toolResults ?? 0),
            toolFailures: Number(output.toolFailures ?? output.tool_failures ?? submittedResult.diagnostics?.toolFailures ?? 0),
            unmatchedToolCallIds: output.unmatchedToolCallIds || output.unmatched_tool_call_ids || submittedResult.diagnostics?.unmatchedToolCallIds || [],
            unmatchedToolResultIds: output.unmatchedToolResultIds || output.unmatched_tool_result_ids || [],
            tokenUsage: output.tokenUsage || output.token_usage || {},
            queueWaitMs: Number(output.queueWaitMs ?? output.queue_wait_ms ?? 0),
            startupDurationMs: Number(output.startupDurationMs ?? 0),
            promptDurationMs: Number(output.promptDurationMs ?? 0),
            executionDurationMs: Number(output.executionDurationMs ?? output.execution_duration_ms ?? 0),
            totalDurationMs: Number(output.totalDurationMs ?? output.total_duration_ms ?? 0),
            rpcSessionDir: output.rpc_session_dir || null,
          });
          throw error;
        }
      }
      record = this.store.get(subagentId) || record;
      if (record.status === "cancelled") { const cancelled = abortError("subagent cancelled while running"); cancelled.code = "SUBAGENT_ABORTED"; throw cancelled; }
      if (workspaceLease) {
        const submittedResult = output.submitted_result || null;
        const requestedPatchDisposition = submittedResult?.proposedPatch ?? output.proposedPatch ?? null;
        workspaceCapture = this.workspaceManager.capture(workspaceLease, { status: "succeeded", verification: output.verification || submittedResult?.verification || { status: "unchecked", evidence: [] } });
        const proposedPatch = workspaceCapture.changedPaths.length ? { patchHash: workspaceCapture.patchHash, patchBytes: workspaceCapture.patchBytes, changedPaths: workspaceCapture.changedPaths.map((entry) => ({ path: entry.path, beforeHash: entry.beforeHash, afterHash: entry.afterHash })), workspaceRetained: workspaceCapture.retained } : null;
        output.proposedPatch = proposedPatch;
        if (output.submitted_result) output.submitted_result = { ...output.submitted_result, proposedPatch };
        workspaceDisposition = proposedPatch
          ? { status: "proposed-patch", changedPaths: proposedPatch.changedPaths.map((entry) => entry.path) }
          : null;
        if (runtimeRecord.mutationPolicy === "proposed-patch" && !proposedPatch) {
          const assessment = this.workspaceManager.assessBaselineSatisfaction(workspaceLease, requestedPatchDisposition);
          if (assessment.accepted) {
            workspaceDisposition = { status: "baseline-satisfied", reason: assessment.reason, changedPaths: assessment.changedPaths };
            this.store.event("subagent.baseline_satisfied", { subagentId, parentSessionId: record.parentSessionId, status: "succeeded", counts: { changedPaths: assessment.changedPaths.length } });
          } else {
            this.workspaceManager.release(workspaceLease, { remove: true });
            workspaceLease = null;
            this.store.event("subagent.cleanup_complete", { subagentId, parentSessionId: record.parentSessionId, status: "failed", reasonCode: assessment.claimed ? assessment.reasonCode : "empty-proposed-patch" });
            const error = new Error(assessment.claimed
              ? `role ${runtimeRecord.roleContract?.roleId || runtimeRecord.role || "subagent"} baseline-satisfied claim is invalid: ${assessment.reasonCode}`
              : `role ${runtimeRecord.roleContract?.roleId || runtimeRecord.role || "subagent"} completed without a proposed workspace patch`);
            error.code = assessment.claimed ? "SUBAGENT_BASELINE_SATISFACTION_INVALID" : "SUBAGENT_EMPTY_PATCH";
            error.termination = { code: assessment.claimed ? "baseline_satisfaction_invalid" : "empty_patch", stopReason: null, message: error.message };
            error.submittedResult = submittedResult;
            error.subagentDiagnostics = withLegacyDiagnosticAliases({
              modelCalls: Number(output.modelCalls ?? output.model_calls ?? 0),
              toolCalls: Number(output.toolCalls ?? output.tool_calls ?? 0),
              toolResults: Number(output.toolResults ?? output.tool_results ?? 0),
              toolFailures: Number(output.toolFailures ?? output.tool_failures ?? 0),
              unmatchedToolCallIds: output.unmatchedToolCallIds || output.unmatched_tool_call_ids || [],
              unmatchedToolResultIds: output.unmatchedToolResultIds || output.unmatched_tool_result_ids || [],
              tokenUsage: output.tokenUsage || output.token_usage || {},
              piSessionFile: output.pi_session_file || null,
              rpcSessionDir: output.rpc_session_dir || null,
              selectedModel: output.selected_model || null,
              effectiveModel: output.effective_model || null,
              fallbackModel: output.fallback_model || null,
              modelPolicySource: output.model_policy_source || null,
              selectedThinkingLevel: output.selected_thinking_level || null,
              effectiveThinkingLevel: output.effective_thinking_level || null,
              thinkingPolicySource: output.thinking_policy_source || null,
            });
            throw error;
          }
        }
        output.workspaceDisposition = workspaceDisposition;
        record.workspace = { ...record.workspace, state: workspaceCapture.retained ? "retained" : "cleaned", retained: workspaceCapture.retained, patchHash: workspaceCapture.patchHash, patchBytes: workspaceCapture.patchBytes, changedPaths: workspaceCapture.changedPaths.map((entry) => entry.path), ...(workspaceDisposition ? { disposition: workspaceDisposition.status, baselineChangedPaths: workspaceDisposition.status === "baseline-satisfied" ? workspaceDisposition.changedPaths : [] } : {}) };
      }
      const finishedAt = nowIso();
      const elapsedDurationMs = Math.max(0, Date.now() - startedMs);
      const queueWaitMs = Number(output.queueWaitMs ?? output.queue_wait_ms ?? 0);
      const executionDurationMs = Number(output.executionDurationMs ?? output.execution_duration_ms ?? Math.max(0, elapsedDurationMs - queueWaitMs));
      const totalDurationMs = queueWaitMs + executionDurationMs;
      record.status = "succeeded";
      record.processClosedAt = finishedAt;
      record.finishedAt = finishedAt;
      record.updatedAt = finishedAt;
      record.termination = output.termination || { code: "completed", stopReason: null, message: "terminal output accepted" };
      record.diagnostics = withLegacyDiagnosticAliases({
        ...(record.diagnostics || {}),
        diagnosticsSchemaVersion: 2,
        callAccounting: { modelCalls: Number.isFinite(output.modelCalls ?? output.model_calls), toolCalls: Number.isFinite(output.toolCalls ?? output.tool_calls) },
        sourceReads: output.sourceReads || null,
        modelCalls: Number(output.modelCalls ?? output.model_calls ?? 1),
        toolCalls: Number(output.toolCalls ?? output.tool_calls ?? 0),
        toolResults: Number(output.toolResults ?? output.tool_results ?? 0),
        toolFailures: Number(output.toolFailures ?? output.tool_failures ?? 0),
        unmatchedToolCallIds: output.unmatchedToolCallIds || output.unmatched_tool_call_ids || [],
        unmatchedToolResultIds: output.unmatchedToolResultIds || output.unmatched_tool_result_ids || [],
        tokenUsage: output.tokenUsage || output.token_usage || { estimated: estimateTokens(output.final_response || output.finalResponse || output.summary || "") },
        piSessionFile: output.pi_session_file || null,
        rpcSessionDir: output.rpc_session_dir || null,
        queueWaitMs,
        startupDurationMs: Number(output.startupDurationMs ?? 0),
        promptDurationMs: Number(output.promptDurationMs ?? 0),
        executionDurationMs,
        totalDurationMs,
        wallClockBudgetMs: Number(output.wallClockBudgetMs ?? output.wall_clock_budget_ms ?? record.budget?.wallClockMs ?? 0),
        rpcConcurrencyLimit: output.rpcConcurrencyLimit ?? output.rpc_concurrency_limit ?? null,
        selectedModel: output.selected_model || null,
        effectiveModel: output.effective_model || null,
        fallbackModel: output.fallback_model || null,
        modelPolicySource: output.model_policy_source || null,
        selectedThinkingLevel: output.selected_thinking_level || null,
        effectiveThinkingLevel: output.effective_thinking_level || null,
        thinkingPolicySource: output.thinking_policy_source || null,
        workspace: workspaceCapture ? { ...this.workspaceManager.diagnostics(workspaceCapture), ...(workspaceDisposition ? { disposition: workspaceDisposition.status, baselineChangedPaths: workspaceDisposition.status === "baseline-satisfied" ? workspaceDisposition.changedPaths : [] } : {}) } : { policy: record.workspacePolicy || "shared-readonly", retained: false, path: null, changedPaths: [] },
        pi_session_file: output.pi_session_file || null,
        rpc_session_dir: output.rpc_session_dir || null,
        queue_wait_ms: queueWaitMs,
        execution_duration_ms: executionDurationMs,
        total_duration_ms: totalDurationMs,
        duration_ms: totalDurationMs,
        wall_clock_budget_ms: Number(output.wallClockBudgetMs ?? output.wall_clock_budget_ms ?? record.budget?.wallClockMs ?? 0),
        rpc_concurrency_limit: output.rpcConcurrencyLimit ?? output.rpc_concurrency_limit ?? null,
        errors,
      });
      let result = defaultResultEnvelope(record, { ...output, termination: record.termination, diagnostics: { ...record.diagnostics, started_at: record.startedAt, finished_at: finishedAt, duration_ms: totalDurationMs } });
      const receipt = createSubagentReceipt(record, result); record.receiptId = receipt.receiptId; result = { ...result, receiptId: receipt.receiptId, receipt };
      this.store.save(record);
      this.store.saveResult(result);
      this.store.event("subagent.process_closed", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, durationMs: totalDurationMs, receiptId: receipt.receiptId, termination: record.termination });
      if (workspaceLease && workspaceCapture && !workspaceCapture.retained) { this.workspaceManager.release(workspaceLease, { remove: true }); this.store.event("subagent.cleanup_complete", { subagentId, parentSessionId: record.parentSessionId, status: record.status, receiptId: receipt.receiptId }); }
      this.branchManager.checkpoint(record.branchId, subagentBranchSnapshotState({ contextState: { subagentResult: result }, verifierState: { ok: true, successRate: 1 }, metadata: { kind: "subagent.completed", subagentId } }));
      this.branchManager.completeAgentWork(record.branchId, subagentId, { ok: true });
      const terminal = { status: record.status, termination: { code: record.termination?.code || "completed", stopReason: record.termination?.stopReason || null } };
      this.store.event("subagent.completed", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, receiptId: record.receiptId, ...terminal });
      this.trace?.emit?.({ category: "agent_branching", name: "subagent.completed", agent_id: subagentId, payload: { branchId: record.branchId, ...terminal } });
      const effectiveMerge = mergePolicy || record.mergePolicy;
      if (effectiveMerge && effectiveMerge !== "none") this.mergeSubagentResult({ subagentId, targetSessionId: record.parentSessionId, mergePolicy: effectiveMerge });
      return result;
    } catch (error) {
      const finishedAt = nowIso();
      record = this.store.get(subagentId) || record;
      const reportedStatus = RESULT_STATUSES.includes(error?.reportedStatus) && error.reportedStatus !== "succeeded" ? error.reportedStatus : null;
      const timedOut = reportedStatus === "timed_out" || ["SUBAGENT_TIMEOUT", "SUBAGENT_QUEUE_TIMEOUT", "SUBAGENT_RPC_STARTUP_TIMEOUT"].includes(error?.code);
      const cancelled = reportedStatus === "cancelled" || record.status === "cancelled" || error?.name === "AbortError" || ["SUBAGENT_ABORTED"].includes(error?.code);
      errors.push(safeError(error));
      record.status = reportedStatus || (cancelled ? "cancelled" : timedOut ? "timed_out" : "failed");
      record.processClosedAt = finishedAt;
      record.finishedAt = finishedAt;
      record.updatedAt = finishedAt;
      record.termination = error?.termination || { code: cancelled ? "cancelled" : timedOut ? (error?.code === "SUBAGENT_QUEUE_TIMEOUT" ? "queue_wait" : "wall_clock") : "failed", stopReason: cancelled ? "aborted" : null, message: error?.message || String(error) };
      if (workspaceLease) {
        try {
          workspaceCapture = this.workspaceManager.capture(workspaceLease, { status: record.status, verification: { status: "unchecked", evidence: [] } });
          record.workspace = { ...record.workspace, state: "retained", retained: true, patchHash: workspaceCapture.patchHash, patchBytes: workspaceCapture.patchBytes, changedPaths: workspaceCapture.changedPaths.map((entry) => entry.path) };
        } catch (captureError) { errors.push(safeError(captureError)); }
      }
      const failureDiagnostics = error?.subagentDiagnostics || {};
      const elapsedDurationMs = Math.max(0, Date.now() - startedMs);
      const queueWaitMs = Number(failureDiagnostics.queueWaitMs ?? failureDiagnostics.queue_wait_ms ?? 0);
      const executionDurationMs = Number(failureDiagnostics.executionDurationMs ?? failureDiagnostics.execution_duration_ms ?? Math.max(0, elapsedDurationMs - queueWaitMs));
      const totalDurationMs = queueWaitMs + executionDurationMs;
      record.diagnostics = withLegacyDiagnosticAliases({
        ...(record.diagnostics || {}),
        ...failureDiagnostics,
        diagnosticsSchemaVersion: 2,
        callAccounting: { modelCalls: Number.isFinite(failureDiagnostics.modelCalls ?? failureDiagnostics.model_calls), toolCalls: Number.isFinite(failureDiagnostics.toolCalls ?? failureDiagnostics.tool_calls) },
        queueWaitMs,
        executionDurationMs,
        totalDurationMs,
        wallClockBudgetMs: Number(failureDiagnostics.wallClockBudgetMs ?? failureDiagnostics.wall_clock_budget_ms ?? record.budget?.wallClockMs ?? 0),
        rpcSessionDir: failureDiagnostics.rpcSessionDir || failureDiagnostics.rpc_session_dir || null,
        workspace: workspaceCapture ? this.workspaceManager.diagnostics(workspaceCapture) : { policy: record.workspacePolicy || "shared-readonly", retained: false, path: null, changedPaths: [] },
        queue_wait_ms: queueWaitMs,
        execution_duration_ms: executionDurationMs,
        total_duration_ms: totalDurationMs,
        duration_ms: totalDurationMs,
        wall_clock_budget_ms: Number(failureDiagnostics.wallClockBudgetMs ?? failureDiagnostics.wall_clock_budget_ms ?? record.budget?.wallClockMs ?? 0),
        rpc_session_dir: failureDiagnostics.rpcSessionDir || failureDiagnostics.rpc_session_dir || null,
        errors,
      });
      const submittedResult = error?.submittedResult || null;
      const summary = submittedResult?.summary || (record.status === "timed_out" ? "Subagent timed out." : record.status === "cancelled" ? "Subagent cancelled." : "Subagent failed.");
      let result = defaultResultEnvelope(record, { diagnosticEvidence: error?.diagnosticEvidence || [], submitted_result: submittedResult, summary, final_response: submittedResult?.summary || error?.message || String(error), termination: record.termination, diagnostics: { ...record.diagnostics, started_at: record.startedAt, finished_at: finishedAt, duration_ms: totalDurationMs, errors } });
      const receipt = createSubagentReceipt(record, result); record.receiptId = receipt.receiptId; result = { ...result, receiptId: receipt.receiptId, receipt };
      this.store.save(record);
      const persistedResult = this.store.saveResult(result);
      this.store.event("subagent.process_closed", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, durationMs: totalDurationMs, receiptId: receipt.receiptId, termination: record.termination });
      try { this.branchManager.checkpoint(record.branchId, subagentBranchSnapshotState({ contextState: { subagentResult: persistedResult }, verifierState: { ok: false, errors }, metadata: { kind: `subagent.${record.status}`, subagentId } })); } catch {}
      try { this.branchManager.completeAgentWork(record.branchId, subagentId, { ok: false }); } catch {}
      const eventName = record.status === "timed_out" ? "subagent.timed_out" : record.status === "cancelled" ? "subagent.cancelled" : "subagent.failed";
      const terminal = { status: record.status, termination: { code: record.termination?.code || record.status, stopReason: record.termination?.stopReason || null } };
      this.store.event(eventName, { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, receiptId: record.receiptId, reasonCode: error?.code || null, ...terminal });
      this.trace?.emit?.({ category: record.status === "cancelled" ? "cancellation" : "failure_state", name: eventName, severity: record.status === "cancelled" ? "warn" : "error", agent_id: subagentId, payload: { branchId: record.branchId, errorCode: error?.code || null, ...terminal } });
      return persistedResult;
    }
  }

  async runWithTimeout(record, context) {
    if (context?.executionMode === "tool-rpc") {
      const limit = rpcConcurrencyLimit(context);
      const budget = normalizeBudget(record.budget);
      const setQueueStatus = (status) => {
        const latest = this.store.get(record.id);
        if (!latest || FINAL_STATUSES.has(latest.status)) return;
        if (latest.status === status) return;
        latest.status = status;
        latest.queuedAt = status === "queued" ? (latest.queuedAt || nowIso()) : latest.queuedAt;
        latest.startedAt = status === "running" ? (latest.startedAt || nowIso()) : latest.startedAt;
        latest.updatedAt = nowIso();
        this.store.save(latest);
        this.store.event(status === "queued" ? "subagent.queued" : "subagent.started", { subagentId: latest.id, parentSessionId: latest.parentSessionId, branchId: latest.branchId, status });
      };
      return withRpcConcurrency(limit, async ({ queueWaitMs: localQueueWaitMs, concurrencyLimit }) => {
        const queueWaitMs = localQueueWaitMs;
        const executionStartedMs = Date.now();
        setQueueStatus("running");
        try {
          const runnerContext = {
            ...(context || {}),
            rpcTiming: { queueWaitMs, localQueueWaitMs, concurrencyLimit },
          };
          const output = await this.runner.run(record, runnerContext);
          const executionDurationMs = output?.executionDurationMs ?? output?.execution_duration_ms ?? Math.max(0, Date.now() - executionStartedMs);
          return {
            ...(output || {}),
            queueWaitMs: output?.queueWaitMs ?? output?.queue_wait_ms ?? queueWaitMs,
            executionDurationMs,
            totalDurationMs: queueWaitMs + executionDurationMs,
            queue_wait_ms: output?.queue_wait_ms ?? queueWaitMs,
            execution_duration_ms: executionDurationMs,
            total_duration_ms: queueWaitMs + executionDurationMs,
            rpc_concurrency_limit: output?.rpc_concurrency_limit ?? concurrencyLimit,
          };
        } catch (error) {
          const executionDurationMs = error.subagentDiagnostics?.executionDurationMs ?? error.subagentDiagnostics?.execution_duration_ms ?? Math.max(0, Date.now() - executionStartedMs);
          error.subagentDiagnostics = withLegacyDiagnosticAliases({
            ...(error.subagentDiagnostics || {}),
            queueWaitMs,
            executionDurationMs,
            totalDurationMs: queueWaitMs + executionDurationMs,
            rpcConcurrencyLimit: concurrencyLimit,
            queue_wait_ms: queueWaitMs,
            execution_duration_ms: executionDurationMs,
            total_duration_ms: queueWaitMs + executionDurationMs,
            rpc_concurrency_limit: concurrencyLimit,
          });
          throw error;
        }
      }, { signal: context?.signal, maxQueueWaitMs: budget.maxQueueWaitMs, onQueued: () => setQueueStatus("queued"), onAcquired: () => setQueueStatus("running") });
    }
    const wallClockMs = record.budget === null ? Infinity : Number(record.budget?.wallClockMs || this.config.defaultWallClockMs);
    if (!Number.isFinite(wallClockMs) || wallClockMs <= 0) return this.runner.run(record, context);
    const controller = new AbortController();
    const runnerContext = { ...(context || {}), signal: controller.signal };
    let timer;
    let parentAbortHandler;
    const timeout = new Promise((_, reject) => {
      const rejectWith = (error) => { try { controller.abort(error); } catch {}; reject(error); };
      timer = setTimeout(() => { const e = new Error(`subagent wall-clock budget exceeded (${wallClockMs}ms)`); e.code = "SUBAGENT_TIMEOUT"; rejectWith(e); }, wallClockMs);
      timer.unref?.();
      if (context?.signal) {
        parentAbortHandler = () => rejectWith(abortError("subagent run aborted"));
        if (context.signal.aborted) parentAbortHandler();
        else context.signal.addEventListener?.("abort", parentAbortHandler, { once: true });
      }
    });
    try { return await Promise.race([this.runner.run(record, runnerContext), timeout]); }
    finally {
      if (timer) clearTimeout(timer);
      if (parentAbortHandler && context?.signal) context.signal.removeEventListener?.("abort", parentAbortHandler);
    }
  }

  recoverInterruptedRuns({ parentSessionId } = {}) {
    const recovered = [];
    // A record with no owner was written before ownership tracking or by a build
    // that predates it, so it cannot be live in this process. A run owned by a
    // live process (including another session) is protected by supervisorAlive().
    for (const record of this.store.list(parentSessionId ? { parentSessionId } : {})) {
      if (!RUNNING_STATUSES.has(record.status) || this.activeRuns.has(record.id)) continue;
      if (supervisorAlive(record.owner)) continue;
      try {
        const settled = this.finalizeInterruptedRun(record);
        if (settled) recovered.push(settled);
      } catch (error) {
        this.trace?.emit?.({ category: "failure_state", name: "subagent.recovery_failed", severity: "warn", agent_id: record.id, error: error?.message || String(error) });
      }
    }
    return recovered;
  }
  finalizeInterruptedRun(recordInput) {
    // Re-read so a concurrent reconciler cannot rewrite a run that already settled.
    const record = this.store.get(recordInput?.id);
    if (!record || !RUNNING_STATUSES.has(record.status)) return null;
    const observedAt = nowIso();
    const observedMs = Date.parse(observedAt);
    const startedMs = Date.parse(record.startedAt || "");
    // The true close time is unknown. A live supervisor enforces the wall-clock
    // budget, so bound the interval instead of counting idle time since it died.
    const wallClockMs = Number(record.budget?.wallClockMs);
    const closedMs = Number.isFinite(wallClockMs) && wallClockMs > 0 && Number.isFinite(startedMs) ? Math.min(observedMs, startedMs + wallClockMs) : observedMs;
    const finishedAt = Number.isFinite(closedMs) ? new Date(closedMs).toISOString() : observedAt;
    const durationMs = Number.isFinite(startedMs) && Number.isFinite(closedMs) ? Math.max(0, closedMs - startedMs) : 0;
    const previousStatus = record.status;
    record.status = "failed";
    record.controlState = "interrupted";
    record.resumable = true;
    record.processClosedAt = finishedAt;
    record.finishedAt = finishedAt;
    record.updatedAt = finishedAt;
    record.termination = { code: "supervisor_lost", stopReason: "process-closed", messageCode: "supervisor-lost" };
    const errors = [...(Array.isArray(record.diagnostics?.errors) ? record.diagnostics.errors : []), { code: "supervisor-lost", name: "SupervisorLost" }];
    // Preserve partial work and close the lease before marking the workspace
    // retained, mirroring the normal failure path.
    let workspaceCapture = null;
    if (record.workspace?.state === "active" && record.workspace.path) {
      try { workspaceCapture = this.workspaceManager.capture(record.workspace.path, { status: "failed", verification: { status: "unchecked", evidence: [] } }); }
      catch (error) { errors.push(safeError(error)); }
      try { this.workspaceManager.release(record.workspace.path); } catch {}
      record.workspace = workspaceCapture
        ? { ...record.workspace, state: "retained", retained: true, patchHash: workspaceCapture.patchHash, patchBytes: workspaceCapture.patchBytes, changedPaths: workspaceCapture.changedPaths.map((entry) => entry.path) }
        : { ...record.workspace, state: "retained", retained: true };
    }
    record.diagnostics = withLegacyDiagnosticAliases({
      ...(record.diagnostics || {}),
      diagnosticsSchemaVersion: 2,
      executionDurationMs: durationMs,
      totalDurationMs: durationMs,
      execution_duration_ms: durationMs,
      total_duration_ms: durationMs,
      duration_ms: durationMs,
      errors,
    });
    let result = defaultResultEnvelope(record, { summary: "Subagent run ended when its supervising process closed.", final_response: "The supervising process closed before the subagent submitted a terminal result.", termination: record.termination, diagnostics: { ...record.diagnostics, started_at: record.startedAt || null, finished_at: finishedAt, duration_ms: durationMs, errors } });
    const receipt = createSubagentReceipt(record, result);
    record.receiptId = receipt.receiptId;
    result = { ...result, receiptId: receipt.receiptId, receipt };
    this.store.save(record);
    this.store.saveResult(result);
    this.store.event("subagent.process_closed", { subagentId: record.id, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, durationMs, receiptId: receipt.receiptId, termination: record.termination });
    this.store.event("subagent.failed", { subagentId: record.id, parentSessionId: record.parentSessionId, branchId: record.branchId, receiptId: receipt.receiptId, reasonCode: "supervisor-lost", status: record.status, termination: { code: record.termination.code, stopReason: record.termination.stopReason } });
    try { this.branchManager.checkpoint(record.branchId, subagentBranchSnapshotState({ contextState: { subagentResult: result }, verifierState: { ok: false, errors }, metadata: { kind: `subagent.${record.status}`, subagentId: record.id } })); } catch {}
    try { this.branchManager.completeAgentWork(record.branchId, record.id, { ok: false }); } catch {}
    this.trace?.emit?.({ category: "failure_state", name: "subagent.failed", severity: "warn", agent_id: record.id, payload: { branchId: record.branchId, reasonCode: "supervisor-lost", previousStatus, status: record.status, termination: { code: record.termination.code, stopReason: record.termination.stopReason } } });
    return clone(record);
  }
  async cancelSubagent({ subagentId, reason = "cancelled" } = {}) {
    let record = this.store.get(subagentId);
    if (!record) throw new Error(`subagent not found: ${subagentId}`);
    if (FINAL_STATUSES.has(record.status)) return clone(record);
    const reasonCode = String(reason || "cancelled").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 100) || "cancelled";
    const active = this.activeRuns.get(subagentId);
    if (active) {
      record.controlState = "cancel-requested"; record.updatedAt = nowIso(); this.store.save(record);
      this.store.event("subagent.cancel_acknowledged", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, control: "cancel", acknowledgement: "accepted", reasonCode });
      active.controller.abort(abortError("subagent cancelled"));
      await active.promise;
      return clone(this.store.get(subagentId));
    }
    const at = nowIso();
    record.status = "cancelled"; record.controlState = "cancelled"; record.cancelledAt = at; record.processClosedAt = at; record.finishedAt = at; record.updatedAt = at; record.cancelReasonHash = `sha256:${lifecycleSha256(reason)}`; record.termination = { code: "cancelled", stopReason: "aborted", messageCode: reasonCode };
    let result = defaultResultEnvelope(record, { summary: "Subagent cancelled.", final_response: "Subagent cancelled before launch.", termination: record.termination, diagnostics: { ...(record.diagnostics || {}), errors: [{ code: reasonCode, name: "Cancelled" }] } });
    const receipt = createSubagentReceipt(record, result); record.receiptId = receipt.receiptId; result = { ...result, receiptId: receipt.receiptId, receipt };
    this.store.save(record); this.store.saveResult(result);
    try { this.branchManager.checkpoint(record.branchId, subagentBranchSnapshotState({ contextState: { subagentStatus: "cancelled", reasonHash: record.cancelReasonHash }, metadata: { kind: "subagent.cancelled", subagentId } })); } catch {}
    const terminal = { status: record.status, termination: { code: record.termination.code, stopReason: record.termination.stopReason } };
    this.store.event("subagent.cancel_acknowledged", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, control: "cancel", acknowledgement: "accepted", reasonCode });
    this.store.event("subagent.process_closed", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, status: record.status, receiptId: receipt.receiptId, termination: record.termination });
    this.store.event("subagent.cancelled", { subagentId, parentSessionId: record.parentSessionId, branchId: record.branchId, reasonCode, receiptId: receipt.receiptId, ...terminal });
    this.trace?.emit?.({ category: "cancellation", name: "subagent.cancelled", agent_id: subagentId, payload: { branchId: record.branchId, ...terminal } });
    return clone(record);
  }
  continueSubagent({ subagentId, task, mode = "continue" } = {}) {
    const prior = this.store.get(subagentId); if (!prior) throw new Error(`subagent not found: ${subagentId}`);
    if (!FINAL_STATUSES.has(prior.status)) throw new Error(`subagent ${subagentId} must be settled before continuation`);
    if (!String(task || "").trim()) throw new Error("subagent continuation requires a new bounded task");
    const runtimePrior = this.materializeRuntimeRecord(prior);
    if (prior.roleContractVersion && !runtimePrior.roleContract) { const error = new Error("role contract is unavailable for continuation; create a new explicitly resolved role attempt"); error.code = "SUBAGENT_ROLE_CONTRACT_UNAVAILABLE"; throw error; }
    const created = this.createSubagent({ parentSessionId: prior.parentSessionId, parentBranchId: prior.parentBranchId, parentTrajectoryId: prior.parentTrajectoryId, branchFrom: { branchId: prior.branchId, snapshotId: null }, role: prior.role, task: String(task).slice(0, 8000), systemPrompt: runtimePrior.systemPrompt, roleContract: runtimePrior.roleContract, toolPolicy: prior.toolPolicy, modelPolicy: prior.modelPolicy, modelPreference: prior.modelPreference, workspacePolicy: prior.workspacePolicy, mutationPolicy: prior.mutationPolicy, memoryPolicy: prior.memoryPolicy, contextProjection: prior.contextProjection, budget: prior.budget, mergePolicy: prior.mergePolicy, rootAttemptId: prior.rootAttemptId || prior.id, previousAttemptId: prior.id, attempt: Number(prior.attempt || 1) + 1, metadata: { ...(prior.metadata || {}), previousAttemptId: prior.id, rootAttemptId: prior.rootAttemptId || prior.id, attempt: Number(prior.attempt || 1) + 1, continuationMode: mode } });
    this.store.event("subagent.continuation_linked", { subagentId: created.id, parentSessionId: created.parentSessionId, previousAttemptId: prior.id, status: created.status, counts: { attempt: created.attempt } });
    return created;
  }
  resumeSubagent({ subagentId, task } = {}) {
    const prior = this.store.get(subagentId); if (!prior) throw new Error(`subagent not found: ${subagentId}`);
    if (!prior.resumable && prior.termination?.code !== "interrupted") throw new Error(`subagent ${subagentId} is not resumable`);
    return this.continueSubagent({ subagentId, task, mode: "resume" });
  }

  patchServiceForCwd() { if (!this.patchService) this.patchService = new SubagentPatchService({ cwd: this.cwd }); return this.patchService; }
  previewSubagentPatch({ subagentId } = {}) {
    const record = this.store.get(subagentId);
    if (!record) throw new Error(`subagent not found: ${subagentId}`);
    const captureFile = record.workspace?.path ? path.join(record.workspace.path, "capture.json") : null;
    const capture = captureFile ? readJson(captureFile, null) : null;
    if (!capture) { const error = new Error(`subagent ${subagentId} has no retained workspace patch`); error.code = "SUBAGENT_PATCH_MISSING"; throw error; }
    const preview = this.patchServiceForCwd().preview(capture);
    this.store.event("subagent.patch_previewed", { subagentId, parentSessionId: record.parentSessionId, status: record.status, counts: { changedPaths: preview.changedPaths.length } });
    return preview;
  }
  async applySubagentPatch({ subagentId, preview, explicit = false, verify, maxRecoveryBytes } = {}) {
    const checked = preview || this.previewSubagentPatch({ subagentId });
    const result = await this.patchServiceForCwd().apply(checked, { explicit, verify, maxRecoveryBytes });
    this.store.event("subagent.patch_applied", { subagentId: subagentId || checked.subagentId, patchHash: result.patchHash, changedPaths: result.changedPaths.length });
    return result;
  }
  mergeSubagentResult(args = {}) { return this.mergeService.merge(args); }
  events({ subagentId, parentSessionId, limit = 100 } = {}) {
    const rows = this.store.events().filter((e) => (!subagentId || e.subagentId === subagentId) && (!parentSessionId || e.parentSessionId === parentSessionId || e.targetSessionId === parentSessionId));
    return Number.isFinite(limit) ? rows.slice(-limit) : rows;
  }
  status({ parentSessionId } = {}) {
    const rows = this.listSubagents({ parentSessionId });
    const byStatus = {}; for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    const active = rows.filter((record) => ["created", "queued", "running"].includes(record.status));
    const final = rows.filter((record) => FINAL_STATUSES.has(record.status));
    const fleet = rows.map((record) => publicRecord(record, this.store.getResult(record.id)));
    const totals = fleet.reduce((sum, record) => {
      const usage = record.diagnostics.tokenUsage || {}; const cost = usage.cost || {};
      sum.modelCalls += record.diagnostics.modelCalls; sum.toolCalls += record.diagnostics.toolCalls; sum.toolResults += record.diagnostics.toolResults; sum.toolFailures += record.diagnostics.toolFailures; sum.totalDurationMs += record.diagnostics.totalDurationMs;
      sum.inputTokens += Number(usage.input ?? usage.inputTokens ?? 0) || 0; sum.outputTokens += Number(usage.output ?? usage.outputTokens ?? 0) || 0; sum.totalTokens += Number(usage.totalTokens ?? usage.total ?? 0) || 0; sum.cost += Number(cost.total ?? usage.totalCost ?? 0) || 0; if (Object.keys(usage).length) sum.providerAccounting = "reported";
      return sum;
    }, { modelCalls: 0, toolCalls: 0, toolResults: 0, toolFailures: 0, totalDurationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, providerAccounting: "unavailable" });
    const hierarchy = [...new Set(fleet.map((record) => record.topologyRunId || `parent:${record.parentSessionId || "unknown"}`))].sort().map((key) => ({ key, kind: key.startsWith("parent:") ? "parent" : "topology", children: fleet.filter((record) => (record.topologyRunId || `parent:${record.parentSessionId || "unknown"}`) === key).map((record) => ({ subagentId: record.id, childKey: record.childKey, nodeId: record.nodeId, role: record.role, status: record.status, attempt: record.attempt, rootAttemptId: record.rootAttemptId, receiptId: record.receiptId })) }));
    return { schemaVersion: 1, apiVersion: 1, total: rows.length, active: active.length, final: final.length, byStatus, totals, hierarchy, fleet, last: fleet.at(-1) || null };
  }
  exportSubagents({ parentSessionId, file } = {}) {
    const records = this.listSubagents({ parentSessionId });
    const packet = { schemaVersion: 1, apiVersion: 1, exportedAt: nowIso(), parentSessionId: parentSessionId || null, records: records.map((record) => publicRecord(record, this.store.getResult(record.id))), events: this.events({ parentSessionId, limit: Infinity }) };
    if (file) writeJson(file, packet);
    this.store.event("subagent.exported", { parentSessionId: parentSessionId || null, counts: { records: records.length } });
    return packet;
  }
  pruneSubagents({ parentSessionId, statuses = ["succeeded", "failed", "cancelled", "timed_out"], olderThanMs = 0, keepRecent = 20 } = {}) {
    const statusSet = new Set(statuses);
    const cutoff = olderThanMs ? Date.now() - olderThanMs : Infinity;
    const candidates = this.listSubagents({ parentSessionId })
      .filter((r) => statusSet.has(r.status))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const archived = [];
    for (const record of candidates.slice(Math.max(0, keepRecent))) {
      const updated = Date.parse(record.updatedAt || record.createdAt || 0);
      if (olderThanMs && (!Number.isFinite(updated) || updated > cutoff)) continue;
      archived.push(publicRecord(record, this.store.getResult(record.id)));
      this.store.delete(record.id);
    }
    this.store.event("subagent.pruned", { parentSessionId: parentSessionId || null, count: archived.length, statuses: [...statusSet], keepRecent, olderThanMs });
    return { pruned: archived.length, archived, remaining: this.listSubagents({ parentSessionId }).length };
  }
}

module.exports = {
  SUBAGENT_STATUSES,
  FINAL_STATUSES,
  MERGE_POLICIES,
  SubagentStore,
  SubagentRunner,
  SubagentMergeService,
  SubagentService,
  defaultResultEnvelope,
  compactSubagentBranchMetadata,
  compactSubagentSnapshotResult,
  subagentBranchSnapshotState,
  toolAllowlistFromPolicy,
  withRpcConcurrency,
};
