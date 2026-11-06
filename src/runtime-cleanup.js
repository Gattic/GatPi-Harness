"use strict";

/**
 * Runtime cleanup planner/executor for local Pi state.
 *
 * The module is intentionally file/stat oriented and manifest-first. It stores
 * metadata about cleanup decisions, not transcript payloads or trace contents.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

function nowIso() { return new Date().toISOString(); }
function mb(n) { return Math.max(0, Number(n) || 0) * 1024 * 1024; }
function boolEnv(name, fallback) { const v = process.env[name]; if (v == null || v === "") return fallback; return !/^(0|false|no)$/i.test(v); }
function numEnv(name, fallback) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function stat(p) { try { return fs.statSync(p); } catch { return null; } }
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function fileSize(p) { return stat(p)?.size || 0; }
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = fs.lstatSync(dir);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`runtime state directory is not a real directory: ${dir}`);
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_DIRECTORY || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || Number(before.dev) !== Number(opened.dev) || Number(before.ino) !== Number(opened.ino)) throw new Error(`runtime state directory changed while opening: ${dir}`);
    fs.fchmodSync(fd, 0o700);
    const after = fs.lstatSync(dir);
    if (after.isSymbolicLink() || !after.isDirectory() || Number(after.dev) !== Number(opened.dev) || Number(after.ino) !== Number(opened.ino)) throw new Error(`runtime state directory changed while hardening: ${dir}`);
  } finally { fs.closeSync(fd); }
  return dir;
}
function readDir(dir) { try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; } }
function isFile(p) { const s = lstat(p); return Boolean(s?.isFile() && !s.isSymbolicLink()); }
function identity(p) {
  const s = lstat(p);
  if (!s) return null;
  return { dev: Number(s.dev), ino: Number(s.ino), type: s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "special" };
}
function sameIdentity(a, b) { return Boolean(a && b && Number(a.dev) === Number(b.dev) && Number(a.ino) === Number(b.ino) && a.type === b.type); }
function readSmallJson(file, maxBytes = 1024 * 1024) { try { const s = lstat(file); if (!s?.isFile() || s.isSymbolicLink() || s.size > maxBytes) return null; return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function modeOf(p) { return lstat(p)?.mode & 0o777; }
function dirSize(dir, limit = 10000) {
  let total = 0; let seen = 0;
  function walk(d) {
    for (const p of readDir(d)) {
      if (seen++ > limit) return;
      const s = lstat(p); if (!s) continue;
      if (s.isSymbolicLink()) total += s.size;
      else if (s.isDirectory()) walk(p); else total += s.size;
    }
  }
  if (exists(dir)) walk(dir);
  return total;
}
function lineCount(file) { try { const text = fs.readFileSync(file, "utf8"); return text ? text.split(/\r?\n/).filter((_, i, a) => i < a.length - 1 || a[i] !== "").length : 0; } catch { return 0; } }
const TRACE_PRIVACY_CACHE = new Map();
function inspectTracePrivacy(file, options = {}) {
  const s = stat(file);
  if (!s?.isFile()) return null;
  const cached = TRACE_PRIVACY_CACHE.get(file);
  if (cached?.bytes === s.size && cached?.mtimeMs === s.mtimeMs && cached.ino === s.ino && cached.dev === s.dev && Boolean(cached.fullScan) === (options.fullScan === true)) return { ...cached.value, active: options.active === true };
  if (options.fullScan === true) {
    // Retention must prove the whole file is metadata-only; sampling cannot
    // authorize deletion of an unseen payload in the middle.
    const limit = 64 * 1024 * 1024;
    let sampledBytes = 0; let sampledRows = 0; let malformedRows = 0; let payloadFields = 0; let payloadRefs = 0;
    let classification = s.size > limit ? "unknown-size-limit" : "metadata-only";
    if (s.size <= limit) {
      let fd; let pending = "";
      const inspect = (line) => {
        if (!line.trim()) return;
        try { const row = JSON.parse(line); sampledRows++; if (row.payload != null) payloadFields++; if (row.payload_ref != null) payloadRefs++; }
        catch { malformedRows++; }
      };
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
        const buffer = Buffer.alloc(64 * 1024);
        while (sampledBytes < s.size) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, s.size - sampledBytes), sampledBytes);
          if (!count) break;
          sampledBytes += count;
          const lines = (pending + decoder.write(buffer.subarray(0, count))).split("\n"); pending = lines.pop();
          for (const line of lines) inspect(line);
          if (pending.length > 2 * 1024 * 1024) { classification = "unknown-row-limit"; break; }
          if (payloadFields || payloadRefs || malformedRows) break;
        }
        if (sampledBytes === s.size) inspect(pending + decoder.end());
        const after = fs.fstatSync(fd);
        if (after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ino !== s.ino || after.dev !== s.dev) classification = "unknown-changed";
        else if (payloadFields || payloadRefs) classification = "payload-bearing";
        else if (malformedRows) classification = "unknown-malformed";
        else if (sampledBytes !== s.size) classification = "unknown-incomplete";
      } catch { classification = "inspection-error"; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    const value = { path: file, bytes: s.size, mtimeMs: s.mtimeMs, classification, sampledBytes, sampleTruncated: sampledBytes !== s.size, sampledRows, malformedRows, payloadFields, payloadRefs };
    TRACE_PRIVACY_CACHE.set(file, { bytes: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev, fullScan: true, value });
    return { ...value, active: options.active === true };
  }
  const maxBytes = Math.max(1024, Math.min(2 * 1024 * 1024, Number(options.maxBytes) || 256 * 1024));
  const sampledBytes = Math.min(s.size, maxBytes);
  let text = "";
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    if (s.size <= maxBytes) {
      const buffer = Buffer.alloc(s.size);
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, read).toString("utf8");
    } else {
      const half = Math.floor(maxBytes / 2);
      const head = Buffer.alloc(half); const tail = Buffer.alloc(maxBytes - half);
      const headRead = fs.readSync(descriptor, head, 0, head.length, 0);
      const tailRead = fs.readSync(descriptor, tail, 0, tail.length, Math.max(0, s.size - tail.length));
      const tailText = tail.subarray(0, tailRead).toString("utf8").replace(/^[^\n]*(?:\n|$)/, "");
      text = `${head.subarray(0, headRead).toString("utf8").replace(/[^\n]*$/, "")}\n${tailText}`;
    }
  } catch {
    const value = { path: file, bytes: s.size, mtimeMs: s.mtimeMs, classification: "inspection-error", sampledBytes: 0, sampleTruncated: true, sampledRows: 0, malformedRows: 0, payloadFields: 0, payloadRefs: 0 };
    TRACE_PRIVACY_CACHE.set(file, { bytes: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev, value });
    return { ...value, active: options.active === true };
  }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  let sampledRows = 0; let malformedRows = 0; let payloadFields = 0; let payloadRefs = 0;
  for (const line of text.split(/\n+/).filter(Boolean)) {
    try {
      const row = JSON.parse(line); sampledRows++;
      if (Object.prototype.hasOwnProperty.call(row, "payload") && row.payload != null) payloadFields++;
      if (Object.prototype.hasOwnProperty.call(row, "payload_ref") && row.payload_ref != null) payloadRefs++;
    } catch { malformedRows++; }
  }
  const sampleTruncated = s.size > maxBytes;
  const payloadBearing = payloadFields + payloadRefs > 0;
  const value = { path: file, bytes: s.size, mtimeMs: s.mtimeMs, classification: payloadBearing ? "payload-bearing" : sampleTruncated ? "unknown-bounded-sample" : malformedRows ? "unknown-malformed" : "metadata-only", sampledBytes, sampleTruncated, sampledRows, malformedRows, payloadFields, payloadRefs };
  TRACE_PRIVACY_CACHE.set(file, { bytes: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev, value });
  return { ...value, active: options.active === true };
}
function safeRel(cwd, p) { const r = path.relative(cwd, p); return r && !r.startsWith("..") ? r : p; }
function gitRoot(cwd) { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd; } catch { return cwd; } }

function openDebugReferences(cwd, maxFiles = 200, maxBytes = 8 * 1024 * 1024) {
  let text = "";
  const files = readDir(path.join(cwd, ".pi", "debug-ledger")).filter(isFile).slice(-maxFiles);
  for (const file of files) {
    if (text.length >= maxBytes) break;
    const value = readSmallJson(file, Math.min(2 * 1024 * 1024, maxBytes - text.length));
    if (!value || (value.status !== "open" && value.resolution)) continue;
    text += `${JSON.stringify({ threadId: value.threadId, status: value.status, attempts: value.attempts, evidence: value.evidence })}\n`;
  }
  return text.slice(0, maxBytes);
}

function inventoryTree(root, { maxEntries = 10000, skip = () => false } = {}) {
  const files = [];
  const directories = [];
  const unsafe = [];
  let entriesScanned = 0;
  let truncated = false;
  const walk = (target) => {
    if (truncated || skip(target)) return;
    const s = lstat(target);
    if (!s) return;
    if (s.isSymbolicLink()) { unsafe.push({ path: target, type: "symlink", bytes: s.size, mtimeMs: s.mtimeMs, mode: s.mode & 0o777, identity: identity(target) }); return; }
    if (s.isFile()) { files.push({ path: target, bytes: s.size, mtimeMs: s.mtimeMs, mode: s.mode & 0o777, identity: identity(target) }); return; }
    if (!s.isDirectory()) { unsafe.push({ path: target, type: "special", bytes: s.size, mtimeMs: s.mtimeMs, mode: s.mode & 0o777, identity: identity(target) }); return; }
    directories.push({ path: target, bytes: 0, mtimeMs: s.mtimeMs, mode: s.mode & 0o777, identity: identity(target) });
    for (const child of readDir(target).sort()) {
      if (entriesScanned >= maxEntries) { truncated = true; break; }
      entriesScanned += 1;
      walk(child);
    }
  };
  if (exists(root)) walk(root);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const permissionChanges = [
    ...directories.filter((entry) => entry.mode !== 0o700).map((entry) => ({ ...entry, type: "directory", toMode: 0o700 })),
    ...files.filter((entry) => entry.mode !== 0o600).map((entry) => ({ ...entry, type: "file", toMode: 0o600 })),
  ];
  return { root, files, directories, unsafe, entriesScanned, truncated, bytes, oldestMs: files.length ? Math.min(...files.map((file) => file.mtimeMs)) : null, newestMs: files.length ? Math.max(...files.map((file) => file.mtimeMs)) : null, permissionChanges };
}

function roleStateInventories(cwd, workspaceRoot, maxEntries = 10000) {
  const subagents = path.join(cwd, ".pi", "subagents");
  const perInventory = Math.max(1, Math.floor(maxEntries / 6));
  const inventories = {
    roleRecords: inventoryTree(path.join(subagents, "records"), { maxEntries: perInventory }),
    roleResults: inventoryTree(path.join(subagents, "results"), { maxEntries: perInventory }),
    rpcChildSessions: inventoryTree(path.join(subagents, "rpc-sessions"), { maxEntries: perInventory }),
    retainedWorkspaces: inventoryTree(workspaceRoot, { maxEntries: perInventory, skip: (target) => path.basename(target) === "tree" }),
    patches: inventoryTree(path.join(subagents, "patches"), { maxEntries: perInventory }),
    topologyRuns: inventoryTree(path.join(cwd, ".pi", "cognitive-automation", "topologies", "runs"), { maxEntries: perInventory }),
  };
  const values = Object.values(inventories);
  return { inventories, summary: { files: values.reduce((sum, inventory) => sum + inventory.files.length, 0), directories: values.reduce((sum, inventory) => sum + inventory.directories.length, 0), bytes: values.reduce((sum, inventory) => sum + inventory.bytes, 0), permissionChanges: values.reduce((sum, inventory) => sum + inventory.permissionChanges.length, 0), unsafeEntries: values.reduce((sum, inventory) => sum + inventory.unsafe.length, 0), truncated: values.some((inventory) => inventory.truncated) } };
}

function defaultCleanupPolicy(overrides = {}) {
  return merge({
    enabled: boolEnv("PI_CLEANUP_AUTOMATION", true),
    dryRunByDefault: boolEnv("PI_CLEANUP_DRY_RUN", true),
    manifestDir: path.join(".pi", "runtime-cleanup", "manifests"),
    archiveDir: path.join(".pi", "runtime-cleanup", "archive"),
    trace: {
      projectEnabled: true,
      globalEnabled: boolEnv("PI_CLEANUP_GLOBAL_TRACE", true),
      maxProjectTraceBytes: mb(numEnv("PI_CLEANUP_MAX_PROJECT_TRACE_MB", 25)),
      maxGlobalTraceBytes: mb(numEnv("PI_CLEANUP_MAX_GLOBAL_TRACE_MB", 250)),
      keepProjectEvents: numEnv("PI_CLEANUP_KEEP_TRACE_EVENTS", 2000),
      keepGlobalTraceFiles: numEnv("PI_CLEANUP_KEEP_GLOBAL_TRACE_FILES", 10),
      minNewestGlobalTraceFiles: 3,
    },
    entropy: {
      enabled: true,
      maxEventsBytes: mb(numEnv("PI_CLEANUP_ENTROPY_MAX_MB", 10)),
      maxSnapshotsBytes: mb(numEnv("PI_CLEANUP_ENTROPY_MAX_MB", 10)),
      keepEventsLines: numEnv("PI_CLEANUP_KEEP_ENTROPY_EVENTS", 2000),
      keepSnapshotsLines: numEnv("PI_CLEANUP_KEEP_ENTROPY_SNAPSHOTS", 2000),
      compressBeforePrune: true,
    },
    branches: { enabled: true, maxSnapshotBytes: mb(25), keepNewestSnapshots: 20, previewOnly: true },
    reasoning: { enabled: true, maxSnapshotBytes: mb(10), keepReasoningSnapshots: 20, previewOnly: true },
    codeContext: { enabled: true, maxBytes: mb(numEnv("PI_CODE_CONTEXT_CACHE_MAX_MB", 64)), maxAgeDays: numEnv("PI_CODE_CONTEXT_CACHE_MAX_AGE_DAYS", 14) },
    subagentWorkspaces: { enabled: true, maxBytes: mb(numEnv("PI_SUBAGENT_WORKSPACE_MAX_MB", 512)), maxAgeDays: numEnv("PI_SUBAGENT_WORKSPACE_MAX_AGE_DAYS", 7) },
    roleState: { enabled: true, maxBytes: mb(numEnv("PI_ROLE_STATE_MAX_MB", 512)), maxAgeDays: numEnv("PI_ROLE_STATE_MAX_AGE_DAYS", 30), keepRecent: numEnv("PI_ROLE_STATE_KEEP_RECENT", 100), maxEntries: numEnv("PI_ROLE_STATE_MAX_ENTRIES", 10000), hardenPermissions: true },
    safety: { requireApplyFlag: true, neverDeleteCurrentSessionTrace: true, minAgeHours: numEnv("PI_CLEANUP_MIN_TRACE_AGE_HOURS", 6), writeManifest: true },
  }, overrides || {});
}
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(out[k] || {}, v) : v;
  return out;
}

function inspectRuntimeState({ cwd = process.cwd(), traceRoot = path.join(os.homedir(), ".pi", "agent", "traces"), policy = {} } = {}) {
  const p = defaultCleanupPolicy(policy);
  const projectTrace = path.join(cwd, ".pi", "cognitive-automation", "trace", "events.jsonl");
  const entropyEvents = path.join(cwd, ".pi", "cognitive-automation", "entropy", "events.jsonl");
  const entropySnapshots = path.join(cwd, ".pi", "cognitive-automation", "entropy", "snapshots.jsonl");
  const globalTraceFiles = readDir(traceRoot).filter(isFile).map((file) => ({ path: file, bytes: fileSize(file), mtimeMs: stat(file)?.mtimeMs || 0 })).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const tracePrivacy = [
    ...(exists(projectTrace) ? [inspectTracePrivacy(projectTrace, { active: true })] : []),
    ...globalTraceFiles.map((entry) => inspectTracePrivacy(entry.path, { active: /\.jsonl$/.test(path.basename(entry.path)) })),
  ].filter(Boolean);
  const branchSnapshots = readDir(path.join(cwd, ".pi", "cognitive-automation", "branches", "snapshots")).filter(isFile).map((file) => ({ path: file, bytes: fileSize(file), mtimeMs: stat(file)?.mtimeMs || 0 })).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const reasoningSnapshots = readDir(path.join(cwd, ".pi", "cognitive-automation", "reasoning", "snapshots")).filter(isFile).map((file) => ({ path: file, bytes: fileSize(file), mtimeMs: stat(file)?.mtimeMs || 0 })).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const codeContextRoot = path.join(cwd, ".pi", "code-context");
  const workspaceRoot = path.join(gitRoot(cwd), ".pi", "subagents", "workspaces");
  const debugRefs = openDebugReferences(cwd);
  const failureStatuses = new Set(["failed", "timed_out", "cancelled"]);
  const subagentWorkspaces = readDir(workspaceRoot).map((dir) => {
    const lease = readSmallJson(path.join(dir, "lease.json"));
    const capture = readSmallJson(path.join(dir, "capture.json"));
    const s = lstat(dir);
    const referenced = Boolean((lease?.subagentId && debugRefs.includes(String(lease.subagentId))) || debugRefs.includes(dir));
    const failureEvidence = failureStatuses.has(String(capture?.status || ""));
    return { path: dir, bytes: dirSize(dir), mtimeMs: s?.mtimeMs || 0, identity: identity(dir), state: lease?.state || "unknown", status: capture?.status || null, subagentId: lease?.subagentId || null, protected: lease?.state === "active" || failureEvidence || referenced, protectedReason: lease?.state === "active" ? "active workspace lease" : failureEvidence ? "failed role recovery evidence" : referenced ? "referenced by open debug ledger" : null };
  }).filter((workspace) => workspace.identity?.type === "directory").sort((a, b) => b.mtimeMs - a.mtimeMs);
  const roleState = roleStateInventories(cwd, workspaceRoot, p.roleState.maxEntries);
  const protectedContextRefs = new Set();
  for (const ledger of readDir(path.join(codeContextRoot, "ledgers")).filter(isFile)) {
    try { for (const entry of JSON.parse(fs.readFileSync(ledger, "utf8")).entries || []) if (!entry.stale && entry.contentRef) protectedContextRefs.add(entry.contentRef); } catch {}
  }
  const codeContextObjects = readDir(path.join(codeContextRoot, "objects")).filter(isFile).map((file) => { let contentRef = null; try { contentRef = JSON.parse(fs.readFileSync(file, "utf8")).contentRef; } catch {} return { path: file, contentRef, protected: protectedContextRefs.has(contentRef), bytes: fileSize(file), mtimeMs: stat(file)?.mtimeMs || 0 }; }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    cwd,
    traceRoot,
    policy: p,
    generatedAt: nowIso(),
    sizes: {
      cognitiveBytes: dirSize(path.join(cwd, ".pi", "cognitive-automation")),
      projectTraceBytes: fileSize(projectTrace),
      globalTraceBytes: globalTraceFiles.reduce((n, f) => n + f.bytes, 0),
      entropyEventsBytes: fileSize(entropyEvents),
      entropySnapshotsBytes: fileSize(entropySnapshots),
      branchSnapshotBytes: branchSnapshots.reduce((n, f) => n + f.bytes, 0),
      reasoningSnapshotBytes: reasoningSnapshots.reduce((n, f) => n + f.bytes, 0),
      codeContextBytes: dirSize(codeContextRoot),
      codeContextObjectBytes: codeContextObjects.reduce((n, f) => n + f.bytes, 0),
      subagentWorkspaceBytes: subagentWorkspaces.reduce((n, workspace) => n + workspace.bytes, 0),
      roleStateBytes: roleState.summary.bytes,
    },
    files: {
      projectTrace: exists(projectTrace) ? { path: projectTrace, bytes: fileSize(projectTrace), lines: lineCount(projectTrace) } : null,
      entropyEvents: exists(entropyEvents) ? { path: entropyEvents, bytes: fileSize(entropyEvents), lines: lineCount(entropyEvents) } : null,
      entropySnapshots: exists(entropySnapshots) ? { path: entropySnapshots, bytes: fileSize(entropySnapshots), lines: lineCount(entropySnapshots) } : null,
      globalTraceFiles,
      tracePrivacy,
      branchSnapshots,
      reasoningSnapshots,
      codeContextObjects,
      subagentWorkspaces,
    },
    roleState,
    protection: { openDebugReferenceBytes: Buffer.byteLength(debugRefs) },
  };
}

function planCleanup(opts = {}) {
  const state = inspectRuntimeState(opts);
  const { cwd, traceRoot, policy } = state;
  const items = [];
  const minAgeMs = Math.max(0, Number(policy.safety.minAgeHours) || 0) * 60 * 60 * 1000;
  const oldEnough = (f) => Date.now() - (f.mtimeMs || 0) >= minAgeMs;
  const add = (item) => items.push({ id: `cleanup_${items.length + 1}`, safe: true, requiresApply: true, snapshot: item.path ? identity(item.path) : null, ...item });

  const tracePrivacyByPath = new Map((state.files.tracePrivacy || []).map((entry) => [entry.path, entry]));
  for (const entry of state.files.tracePrivacy || []) {
    if (entry.classification !== "metadata-only") add({ category: entry.classification === "payload-bearing" ? "legacy-payload-trace" : "trace-privacy-unknown", action: "review-retention", path: entry.path, bytes: entry.bytes, safe: false, requiresApply: false, reason: `${entry.classification} trace requires explicit review; payload fields=${entry.payloadFields}, payload refs=${entry.payloadRefs}, active=${entry.active}` });
  }
  if (policy.trace.projectEnabled && state.files.projectTrace && state.files.projectTrace.bytes > policy.trace.maxProjectTraceBytes) {
    const privacy = tracePrivacyByPath.get(state.files.projectTrace.path);
    if (privacy?.classification === "metadata-only") add({ category: "project-trace", action: "truncate-jsonl", path: state.files.projectTrace.path, bytes: state.files.projectTrace.bytes, keepLines: policy.trace.keepProjectEvents, reason: `project trace exceeds ${policy.trace.maxProjectTraceBytes} bytes` });
  }
  if (policy.entropy.enabled && state.files.entropyEvents && state.files.entropyEvents.bytes > policy.entropy.maxEventsBytes) {
    add({ category: "entropy", action: "truncate-jsonl-gzip-archive", path: state.files.entropyEvents.path, bytes: state.files.entropyEvents.bytes, keepLines: policy.entropy.keepEventsLines, reason: `entropy events exceed ${policy.entropy.maxEventsBytes} bytes` });
  }
  if (policy.entropy.enabled && state.files.entropySnapshots && state.files.entropySnapshots.bytes > policy.entropy.maxSnapshotsBytes) {
    add({ category: "entropy", action: "truncate-jsonl-gzip-archive", path: state.files.entropySnapshots.path, bytes: state.files.entropySnapshots.bytes, keepLines: policy.entropy.keepSnapshotsLines, reason: `entropy snapshots exceed ${policy.entropy.maxSnapshotsBytes} bytes` });
  }
  if (policy.trace.globalEnabled && state.sizes.globalTraceBytes > policy.trace.maxGlobalTraceBytes) {
    const keepCount = Math.max(policy.trace.minNewestGlobalTraceFiles || 0, policy.trace.keepGlobalTraceFiles || 0);
    for (const f of state.files.globalTraceFiles.slice(keepCount)) {
      if (tracePrivacyByPath.get(f.path)?.classification !== "metadata-only") continue;
      if (!oldEnough(f)) { add({ category: "global-trace", action: "skip", path: f.path, bytes: f.bytes, reason: "protected by minimum age", safe: true, requiresApply: false }); continue; }
      add({ category: "global-trace", action: "delete", path: f.path, bytes: f.bytes, reason: `global trace store exceeds ${policy.trace.maxGlobalTraceBytes} bytes; keeping newest ${keepCount} files` });
    }
  }
  if (policy.branches.enabled) {
    for (const f of state.files.branchSnapshots.slice(policy.branches.keepNewestSnapshots || 20)) {
      if (f.bytes > policy.branches.maxSnapshotBytes) add({ category: "branch-snapshot", action: "preview-delete", path: f.path, bytes: f.bytes, safe: false, requiresApply: true, reason: "large old branch snapshot; preview only" });
    }
  }
  if (policy.reasoning.enabled) {
    for (const f of state.files.reasoningSnapshots.slice(policy.reasoning.keepReasoningSnapshots || 20)) {
      if (f.bytes > policy.reasoning.maxSnapshotBytes) add({ category: "reasoning-snapshot", action: "preview-delete", path: f.path, bytes: f.bytes, safe: false, requiresApply: true, reason: "large old reasoning snapshot; preview only" });
    }
  }
  if (policy.subagentWorkspaces.enabled) {
    let remaining = state.sizes.subagentWorkspaceBytes;
    const maxAgeMs = Math.max(0, Number(policy.subagentWorkspaces.maxAgeDays || 7)) * 86400000;
    for (const workspace of state.files.subagentWorkspaces.slice().sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (workspace.protected) { add({ category: "subagent-workspace", action: "skip", path: workspace.path, bytes: workspace.bytes, reason: workspace.protectedReason, safe: true, requiresApply: false }); continue; }
      const old = Date.now() - workspace.mtimeMs > maxAgeMs;
      if (!old && remaining <= policy.subagentWorkspaces.maxBytes) continue;
      add({ category: "subagent-workspace", action: "delete-directory", path: workspace.path, bytes: workspace.bytes, reason: old ? "retained subagent workspace exceeds recovery age" : `subagent workspaces exceed ${policy.subagentWorkspaces.maxBytes} bytes` });
      remaining -= workspace.bytes;
    }
  }
  if (policy.roleState.enabled) {
    const debugRefs = openDebugReferences(cwd);
    const failureStatuses = new Set(["failed", "timed_out", "cancelled"]);
    const activeStatuses = new Set(["created", "queued", "running"]);
    const inventories = state.roleState.inventories;
    for (const inventory of Object.values(inventories)) for (const change of inventory.permissionChanges) {
      add({ category: "role-state-permission", action: "chmod", path: change.path, bytes: change.bytes || 0, toMode: change.toMode, expectedType: change.type, snapshot: change.identity, reason: `private role-state ${change.type} mode` });
    }
    const recordStatus = new Map(inventories.roleRecords.files.map((file) => { const value = readSmallJson(file.path); return [value?.id || path.basename(file.path, path.extname(file.path)), value?.status || "unknown"]; }));
    const candidates = [
      { inventory: inventories.roleRecords, category: "role-record", status: (file) => readSmallJson(file.path)?.status || "unknown", token: (file) => readSmallJson(file.path)?.id },
      { inventory: inventories.roleResults, category: "role-result", status: (file) => readSmallJson(file.path)?.status || "unknown", token: (file) => readSmallJson(file.path)?.subagent_id || readSmallJson(file.path)?.subagentId },
      { inventory: inventories.rpcChildSessions, category: "role-rpc-session", status: (file) => recordStatus.get(path.relative(inventories.rpcChildSessions.root, file.path).split(path.sep)[0]) || "unknown", token: (file) => path.relative(inventories.rpcChildSessions.root, file.path).split(path.sep)[0] },
      { inventory: inventories.patches, category: "role-patch", status: (file) => readSmallJson(file.path)?.status || (/\.applied\.json$/.test(file.path) ? "applied" : "ready"), token: (file) => readSmallJson(file.path)?.subagentId || readSmallJson(file.path)?.id },
      { inventory: inventories.topologyRuns, category: "topology-run", status: (file) => readSmallJson(file.path)?.status || "unknown", token: (file) => readSmallJson(file.path)?.runId },
    ];
    const maxAgeMs = Math.max(0, Number(policy.roleState.maxAgeDays ?? 30)) * 86400000;
    const keepRecent = Math.max(0, Number(policy.roleState.keepRecent ?? 100));
    for (const group of candidates) {
      let remaining = group.inventory.bytes;
      const sorted = group.inventory.files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (let index = 0; index < sorted.length; index++) {
        const file = sorted[index];
        const status = String(group.status(file) || "unknown");
        const token = group.token(file);
        const referenced = Boolean(debugRefs.includes(file.path) || (token && debugRefs.includes(String(token))));
        const eligibleFinal = group.category === "role-patch" ? ["applied", "rejected", "expired"].includes(status) : status === "succeeded";
        const protectedReason = failureStatuses.has(status) ? "failed role recovery evidence" : activeStatuses.has(status) ? "active role state" : referenced ? "referenced by open debug ledger" : group.category === "role-patch" && !eligibleFinal ? "unapplied patch recovery evidence" : !eligibleFinal ? "non-final or unclassified role evidence" : null;
        if (protectedReason) { add({ category: group.category, action: "skip", path: file.path, bytes: file.bytes, reason: protectedReason, safe: true, requiresApply: false, snapshot: file.identity }); continue; }
        const old = Date.now() - file.mtimeMs > maxAgeMs;
        const overBudget = remaining > policy.roleState.maxBytes;
        if (index < keepRecent || (!old && !overBudget)) continue;
        add({ category: group.category, action: "delete", path: file.path, bytes: file.bytes, reason: old ? "final role state exceeds retention age" : `role state exceeds ${policy.roleState.maxBytes} bytes`, snapshot: file.identity });
        remaining -= file.bytes;
      }
    }
  }
  if (policy.codeContext.enabled) {
    let remaining = state.sizes.codeContextObjectBytes;
    const maxAgeMs = Math.max(0, Number(policy.codeContext.maxAgeDays || 14)) * 86400000;
    for (const f of state.files.codeContextObjects.slice().sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (f.protected) continue;
      const old = Date.now() - f.mtimeMs > maxAgeMs;
      if (!old && remaining <= policy.codeContext.maxBytes) continue;
      add({ category: "code-context-cache", action: "delete", path: f.path, bytes: f.bytes, reason: old ? "code context object exceeds retention age" : `code context cache exceeds ${policy.codeContext.maxBytes} bytes` });
      remaining -= f.bytes;
    }
  }
  const removableBytes = items.filter((i) => i.safe && ["delete", "delete-directory", "truncate-jsonl", "truncate-jsonl-gzip-archive"].includes(i.action)).reduce((n, i) => n + (["delete", "delete-directory"].includes(i.action) ? i.bytes : Math.max(0, i.bytes - 250_000)), 0);
  return { id: `cleanup_plan_${Date.now()}`, createdAt: nowIso(), cwd, traceRoot, state: { sizes: state.sizes }, policy, items, summary: { items: items.length, actionable: items.filter((i) => i.safe && i.requiresApply && i.action !== "skip").length, previewOnly: items.filter((i) => !i.safe).length, estimatedBytesRecoverable: removableBytes } };
}

function validateCleanupTarget(item) {
  const current = identity(item.path);
  if (!current || current.type === "symlink" || current.type === "special") throw new Error("cleanup target type changed since preview");
  if (item.snapshot && !sameIdentity(item.snapshot, current)) throw new Error("cleanup target changed since preview");
  return current;
}
function writePrivateManifest(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`runtime manifest temporary path is not a regular file: ${temporary}`);
    const currentTemporary = fs.lstatSync(temporary);
    if (currentTemporary.isSymbolicLink() || !sameIdentity({ dev: Number(opened.dev), ino: Number(opened.ino), type: "file" }, { dev: Number(currentTemporary.dev), ino: Number(currentTemporary.ino), type: currentTemporary.isFile() ? "file" : "special" })) throw new Error("runtime manifest temporary path changed while open");
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.closeSync(fd); fd = undefined;
    const existing = lstat(file);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`runtime manifest path is unsafe: ${file}`);
    fs.renameSync(temporary, file);
    const installed = fs.lstatSync(file);
    if (installed.isSymbolicLink() || Number(installed.dev) !== Number(opened.dev) || Number(installed.ino) !== Number(opened.ino)) throw new Error("runtime manifest path changed while installing");
  } catch (error) {
    if (created) try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function applyCleanup(plan, { dryRun = true, cwd = plan.cwd, writeManifest = true } = {}) {
  const manifest = { id: `cleanup_manifest_${Date.now()}`, createdAt: nowIso(), dryRun, cwd, planId: plan.id, actions: [] };
  const manifestDir = path.resolve(cwd, plan.policy?.manifestDir || path.join(".pi", "runtime-cleanup", "manifests"));
  const archiveDir = path.resolve(cwd, plan.policy?.archiveDir || path.join(".pi", "runtime-cleanup", "archive"));
  ensureDir(manifestDir); ensureDir(archiveDir);
  const manifestPath = path.join(manifestDir, `${manifest.id}.json`);
  if (writeManifest) writePrivateManifest(manifestPath, { ...manifest, note: "pre-apply manifest; action results are appended after execution" });

  for (const item of plan.items || []) {
    const action = { id: item.id, category: item.category, action: item.action, path: safeRel(cwd, item.path), beforeBytes: fileSize(item.path), reason: item.reason, skipped: false };
    try {
      if (!item.safe || item.action === "skip" || item.action === "preview-delete") action.skipped = true;
      else if (dryRun) action.skipped = true;
      else {
        const current = validateCleanupTarget(item);
        if (item.action === "chmod") {
          if (item.expectedType && current.type !== item.expectedType) throw new Error("cleanup target type changed since preview");
          const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (current.type === "directory" ? (fs.constants.O_DIRECTORY || 0) : 0);
          const fd = fs.openSync(item.path, flags);
          try { const opened = fs.fstatSync(fd); const openedIdentity = { dev: Number(opened.dev), ino: Number(opened.ino), type: opened.isDirectory() ? "directory" : opened.isFile() ? "file" : "special" }; if (!sameIdentity(current, openedIdentity)) throw new Error("cleanup target changed since preview"); fs.fchmodSync(fd, item.toMode); const after = identity(item.path); if (!sameIdentity(openedIdentity, after)) throw new Error("cleanup target changed while hardening"); }
          finally { fs.closeSync(fd); }
        }
        else if (item.action === "delete") { if (current.type !== "file") throw new Error("cleanup target type changed since preview"); fs.unlinkSync(item.path); action.afterBytes = 0; }
        else if (item.action === "delete-directory") {
          if (current.type !== "directory") throw new Error("cleanup target type changed since preview");
          const tree = path.join(item.path, "tree");
          const repo = gitRoot(cwd);
          try { if (exists(tree)) execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: repo, stdio: "ignore" }); } catch {}
          fs.rmSync(item.path, { recursive: true, force: true });
          try { execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "ignore" }); } catch {}
          action.afterBytes = 0;
        }
        else if (item.action === "truncate-jsonl" || item.action === "truncate-jsonl-gzip-archive") {
          if (current.type !== "file") throw new Error("cleanup target type changed since preview");
          const result = truncateJsonl(item.path, item.keepLines || 2000, archiveDir, item.action.includes("gzip"), current);
          Object.assign(action, result);
        } else action.skipped = true;
      }
    } catch (error) { action.skipped = true; action.error = error?.message || String(error); }
    if (action.afterBytes == null) action.afterBytes = fileSize(item.path);
    manifest.actions.push(action);
  }
  manifest.summary = { attempted: manifest.actions.length, applied: manifest.actions.filter((a) => !a.skipped && !a.error).length, skipped: manifest.actions.filter((a) => a.skipped).length, errors: manifest.actions.filter((a) => a.error).length, recoveredBytes: manifest.actions.reduce((n, a) => n + Math.max(0, (a.beforeBytes || 0) - (a.afterBytes || 0)), 0) };
  if (writeManifest) writePrivateManifest(manifestPath, manifest);
  return { ...manifest, manifestPath };
}
function truncateJsonl(file, keepLines, archiveDir, gzip, expectedIdentity) {
  const before = identity(file);
  if (!before || before.type !== "file" || (expectedIdentity && !sameIdentity(before, expectedIdentity))) throw new Error("cleanup target changed since preview");
  const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    const openedIdentity = { dev: Number(opened.dev), ino: Number(opened.ino), type: opened.isFile() ? "file" : "special" };
    if (!sameIdentity(before, openedIdentity)) throw new Error("cleanup target changed since preview");
    const text = fs.readFileSync(fd, "utf8");
    if (!sameIdentity(openedIdentity, identity(file))) throw new Error("cleanup target changed while reading");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const keep = lines.slice(-Math.max(0, Number(keepLines) || 0));
    const archiveLines = lines.slice(0, Math.max(0, lines.length - keep.length));
    let archivePath = null;
    if (archiveLines.length) {
      archivePath = path.join(archiveDir, `${path.basename(file).replace(/[^A-Za-z0-9_.-]/g, "_")}-${Date.now()}.jsonl${gzip ? ".gz" : ""}`);
      const archiveContent = gzip ? zlib.gzipSync(Buffer.from(`${archiveLines.join("\n")}\n`)) : Buffer.from(`${archiveLines.join("\n")}\n`);
      const archiveFd = fs.openSync(archivePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { const archiveStat = fs.fstatSync(archiveFd); if (!archiveStat.isFile()) throw new Error("cleanup archive path is not a regular file"); fs.fchmodSync(archiveFd, 0o600); fs.writeFileSync(archiveFd, archiveContent); const installed = fs.lstatSync(archivePath); if (installed.isSymbolicLink() || Number(installed.dev) !== Number(archiveStat.dev) || Number(installed.ino) !== Number(archiveStat.ino)) throw new Error("cleanup archive path changed while writing"); }
      finally { fs.closeSync(archiveFd); }
    }
    const replacement = Buffer.from(keep.length ? `${keep.join("\n")}\n` : "");
    if (!sameIdentity(openedIdentity, identity(file))) throw new Error("cleanup target changed before truncation");
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < replacement.length) offset += fs.writeSync(fd, replacement, offset, replacement.length - offset, offset);
    fs.fchmodSync(fd, 0o600);
    if (!sameIdentity(openedIdentity, identity(file))) throw new Error("cleanup target changed while truncating");
    return { beforeLines: lines.length, afterLines: keep.length, archivedLines: archiveLines.length, archivePath, afterBytes: replacement.length };
  } finally { fs.closeSync(fd); }
}
function formatCleanupPlan(plan) {
  const lines = [`Runtime cleanup plan ${plan.id}`, `actionable=${plan.summary.actionable} previewOnly=${plan.summary.previewOnly} estimatedRecoverable=${plan.summary.estimatedBytesRecoverable}B`];
  for (const item of plan.items.slice(0, 80)) lines.push(`- ${item.category} ${item.action} ${item.bytes || 0}B ${item.path} :: ${item.reason}`);
  if (plan.items.length > 80) lines.push(`... ${plan.items.length - 80} more items`);
  return lines.join("\n");
}

module.exports = { defaultCleanupPolicy, inspectTracePrivacy, inspectRuntimeState, planCleanup, applyCleanup, formatCleanupPlan };
