"use strict";

/**
 * Cognitive trajectory/session branching system.
 *
 * This is intentionally not a git wrapper.  A branch captures the cognitive
 * session trajectory: memory/context/tool/verifier state plus a filesystem
 * checkpoint.  Branches can be scored, compared, merged, quarantined, replayed
 * and assigned to isolated agents.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const BRANCH_TYPES = Object.freeze(["experimental", "verification", "rollback", "speculative", "multi-agent"]);
const TEXT_EXTENSIONS = new Set(".js .ts .json .md .txt .css .html .yml .yaml .sh .cjs .mjs".split(" "));
const PRIVATE_SNAPSHOT_PREFIXES = Object.freeze([".pi"]);
// .worktrees holds linked checkouts of the same repository on other branches;
// a snapshot of this checkout must not absorb another branch's files.
const DEFAULT_IGNORE = [".git", ".worktrees", "node_modules", ...PRIVATE_SNAPSHOT_PREFIXES, ".DS_Store"];
const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECOVERY_STRING_CHARS = 4000;
const DEFAULT_MAX_RECOVERY_ARRAY_ITEMS = 100;
const PRIVATE_RECOVERY_KEYS = /^(?:messages?|transcript|conversation|chat|prompt|raw(?:output)?|stdout|stderr)$/i;
const SECRET_TEXT_REPLACEMENTS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:sk|ghp|github_pat|glpat|xox[baprs])[-_][-_A-Za-z0-9]{12,}\b/g, "[REDACTED_TOKEN]"],
  [/\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)(\s*[:=]\s*)([^\s'\"`]+)/gi, "$1$2[REDACTED]"],
];

function nowIso() { return new Date().toISOString(); }
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function shortHash(value) { return hash(value).slice(0, 12); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {} }
function serializedJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function writeJson(file, value, { maxBytes = Infinity } = {}) {
  const text = serializedJson(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) { const error = new Error(`snapshot JSON exceeds ${maxBytes} byte limit (${bytes})`); error.code = "PI_SNAPSHOT_SIZE_LIMIT"; throw error; }
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}
function appendJsonl(file, value) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); try { fs.chmodSync(file, 0o600); } catch {} }
function exists(file) { try { fs.accessSync(file); return true; } catch { return false; } }
function rel(cwd, file) { return path.relative(cwd, file).replace(/\\/g, "/"); }
function isInside(parent, child) { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function snapshotPathError(file, reason = "must stay inside the snapshot root") {
  const error = new Error(`unsafe snapshot path '${String(file)}': ${reason}`);
  error.code = "PI_SNAPSHOT_PATH_UNSAFE";
  return error;
}
function normalizeSnapshotRelativePath(file) {
  const raw = String(file || "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw snapshotPathError(file);
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw snapshotPathError(file);
  return normalized;
}
function isPrivateSnapshotPath(relative) {
  let normalized;
  try { normalized = normalizeSnapshotRelativePath(relative); } catch { return false; }
  const base = path.posix.basename(normalized);
  return base === ".env" || base.startsWith(".env.") || PRIVATE_SNAPSHOT_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
function safeSnapshotTarget(cwd, file, { requireExisting = false } = {}) {
  const normalized = normalizeSnapshotRelativePath(file);
  if (isPrivateSnapshotPath(normalized)) return null;
  const root = fs.realpathSync(path.resolve(cwd));
  const full = path.resolve(root, normalized);
  if (!isInside(root, full)) throw snapshotPathError(file);
  let current = root;
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw snapshotPathError(file, "symbolic links are not allowed");
    if (index < parts.length - 1 && !stat.isDirectory()) throw snapshotPathError(file, "a parent component is not a directory");
  }
  if (requireExisting && exists(full)) {
    const real = fs.realpathSync(full);
    if (!isInside(root, real)) throw snapshotPathError(file);
    const realRelative = rel(root, real);
    if (isPrivateSnapshotPath(realRelative)) return null;
  }
  return { normalized, root, full };
}
function isIgnored(relative, ignore = DEFAULT_IGNORE) { return isPrivateSnapshotPath(relative) || ignore.some((p) => relative === p || relative.startsWith(`${p}/`) || (p.endsWith("/") && relative.startsWith(p))); }
function isTextFile(file) { return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()); }
function estimateTokens(value) { return Math.ceil(String(typeof value === "string" ? value : stableStringify(value)).length / 4); }
function words(value) { return String(value || "").toLowerCase().match(/[a-z0-9_./:-]+/g) || []; }
function jaccard(a, b) { const A = new Set(words(a)); const B = new Set(words(b)); const U = new Set([...A, ...B]); if (!U.size) return 1; let hit = 0; for (const x of A) if (B.has(x)) hit++; return hit / U.size; }
function deepClone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function unique(xs) { return Array.from(new Set((xs || []).filter(Boolean))); }

function listFiles(cwd, { ignore = DEFAULT_IGNORE, maxFileBytes = 2 * 1024 * 1024 } = {}) {
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name); const r = rel(cwd, full);
      if (isIgnored(r, ignore)) continue;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size <= maxFileBytes) out.push(r);
    }
  }
  if (exists(cwd)) walk(cwd);
  return out.sort();
}

function readFileState(cwd, files) {
  const out = {};
  for (const file of files) {
    const target = safeSnapshotTarget(cwd, file, { requireExisting: true });
    if (!target) continue;
    if (!exists(target.full)) { out[target.normalized] = { exists: false }; continue; }
    const buf = fs.readFileSync(target.full);
    out[target.normalized] = { exists: true, mode: fs.statSync(target.full).mode, hash: hash(buf), bytes: buf.length, text: isTextFile(target.normalized), content: isTextFile(target.normalized) ? buf.toString("utf8") : buf.toString("base64") };
  }
  return out;
}

function redactRecoveryText(value, maxChars = DEFAULT_MAX_RECOVERY_STRING_CHARS) {
  let text = String(value || "");
  for (const [pattern, replacement] of SECRET_TEXT_REPLACEMENTS) text = text.replace(pattern, replacement);
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
function sanitizeRecoveryValue(value, { depth = 0, parentHasRole = false } = {}) {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactRecoveryText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, DEFAULT_MAX_RECOVERY_ARRAY_ITEMS).map((item) => sanitizeRecoveryValue(item, { depth: depth + 1 }));
  if (typeof value !== "object") return undefined;
  const hasRole = Object.prototype.hasOwnProperty.call(value, "role");
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_RECOVERY_KEYS.test(key) || (key === "content" && (hasRole || parentHasRole))) continue;
    const safe = sanitizeRecoveryValue(item, { depth: depth + 1, parentHasRole: hasRole });
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}
function sanitizeSnapshotForStorage(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const safe = deepClone(snapshot);
  const files = safe.filesystemState?.files;
  if (files && typeof files === "object" && !Array.isArray(files)) {
    const normalizedFiles = {};
    for (const [file, state] of Object.entries(files)) {
      let normalized;
      try { normalized = normalizeSnapshotRelativePath(file); } catch { continue; }
      if (isPrivateSnapshotPath(normalized) || Object.prototype.hasOwnProperty.call(normalizedFiles, normalized)) continue;
      normalizedFiles[normalized] = state;
    }
    safe.filesystemState.files = normalizedFiles;
    safe.filesystemState.fingerprint = shortHash(normalizedFiles);
  }
  for (const key of ["metadata", "memoryState", "contextState", "toolState", "verifierState"]) if (safe[key] != null) safe[key] = sanitizeRecoveryValue(safe[key]);
  return safe;
}
function snapshotStateSummary(snapshot = {}) {
  const files = snapshot.filesystemState?.files && typeof snapshot.filesystemState.files === "object" ? Object.values(snapshot.filesystemState.files) : [];
  return {
    filesystem: { fingerprint: snapshot.filesystemState?.fingerprint || null, files: files.length, bytes: files.reduce((sum, item) => sum + Number(item?.bytes || 0), 0), textFiles: files.filter((item) => item?.text).length },
    memoryKeys: Object.keys(snapshot.memoryState || {}).length,
    contextKeys: Object.keys(snapshot.contextState || {}).length,
    toolKeys: Object.keys(snapshot.toolState || {}).length,
    verifier: { ok: snapshot.verifierState?.ok ?? null, successRate: Number.isFinite(Number(snapshot.verifierState?.successRate)) ? Number(snapshot.verifierState.successRate) : null },
  };
}
function sanitizeSnapshotForExport(snapshot) {
  if (!snapshot) return null;
  return { id: snapshot.id, at: snapshot.at, branchId: snapshot.branchId || null, parents: Array.isArray(snapshot.parents) ? snapshot.parents.slice(0, 20) : [], recoveryState: "local-only-redacted", summary: snapshotStateSummary(sanitizeSnapshotForStorage(snapshot)) };
}
function sanitizeBranchForExport(branch) {
  if (!branch) return null;
  return { id: branch.id, type: branch.type, status: branch.status, createdAt: branch.createdAt, updatedAt: branch.updatedAt, parentBranchId: branch.parentBranchId || null, parentSnapshotId: branch.parentSnapshotId || null, headSnapshotId: branch.headSnapshotId || null, lineage: (branch.lineage || []).slice(0, 100), checkpoints: (branch.checkpoints || []).slice(0, 200), score: branch.score ? { score: branch.score.score, components: branch.score.components } : null };
}

function restoreFileState(cwd, fileState, { removeExtra = false, ignore = DEFAULT_IGNORE } = {}) {
  const entries = [];
  const wanted = new Set();
  for (const [file, state] of Object.entries(fileState || {})) {
    const target = safeSnapshotTarget(cwd, file);
    if (!target) continue;
    if (wanted.has(target.normalized)) throw snapshotPathError(file, "duplicates another normalized snapshot path");
    wanted.add(target.normalized);
    entries.push({ target, state: state || {} });
  }
  if (removeExtra) for (const file of listFiles(cwd, { ignore })) if (!wanted.has(file)) fs.rmSync(path.join(cwd, file), { force: true });
  for (const { target, state } of entries) {
    safeSnapshotTarget(cwd, target.normalized);
    if (!state.exists) { fs.rmSync(target.full, { force: true }); continue; }
    fs.mkdirSync(path.dirname(target.full), { recursive: true });
    safeSnapshotTarget(cwd, target.normalized);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
    const mode = Number(state.mode || 0o600) & 0o777;
    const fd = fs.openSync(target.full, flags, mode);
    try {
      fs.writeFileSync(fd, state.text ? String(state.content || "") : Buffer.from(state.content || "", "base64"));
      if (state.mode) try { fs.fchmodSync(fd, mode); } catch {}
    } finally { fs.closeSync(fd); }
  }
}

function diffFileStates(a = {}, b = {}) {
  const files = unique([...Object.keys(a), ...Object.keys(b)]).sort();
  const added = [], removed = [], modified = [], unchanged = [];
  for (const f of files) {
    const A = a[f], B = b[f];
    if ((!A || !A.exists) && B?.exists) added.push(f);
    else if (A?.exists && (!B || !B.exists)) removed.push(f);
    else if ((A?.hash || null) !== (B?.hash || null)) modified.push(f);
    else unchanged.push(f);
  }
  return { added, removed, modified, unchanged, changed: [...added, ...removed, ...modified].sort() };
}

class SnapshotStore {
  constructor(dir = path.join(process.cwd(), ".pi", "session-branches"), options = {}) { const requestedMax = Number(options.maxSnapshotBytes || process.env.PI_BRANCH_SNAPSHOT_MAX_BYTES || DEFAULT_MAX_SNAPSHOT_BYTES); this.dir = dir; this.maxSnapshotBytes = Number.isFinite(requestedMax) && requestedMax >= 1024 ? requestedMax : DEFAULT_MAX_SNAPSHOT_BYTES; ensureDir(dir); }
  snapshotDir(id) { return path.join(this.dir, "snapshots", id); }
  branchFile(id) { return path.join(this.dir, "branches", `${id}.json`); }
  eventFile() { return path.join(this.dir, "events.jsonl"); }
  saveSnapshot(snapshot) { const safe = sanitizeSnapshotForStorage(snapshot); writeJson(path.join(this.snapshotDir(safe.id), "snapshot.json"), safe, { maxBytes: this.maxSnapshotBytes }); return safe; }
  loadSnapshot(id) { return readJson(path.join(this.snapshotDir(id), "snapshot.json"), null); }
  saveBranch(branch) { writeJson(this.branchFile(branch.id), sanitizeRecoveryValue(branch)); return branch; }
  loadBranch(id) { return readJson(this.branchFile(id), null); }
  listBranches() { const dir = path.join(this.dir, "branches"); if (!exists(dir)) return []; return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(dir, f), null)).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  event(type, payload) { appendJsonl(this.eventFile(), { id: shortHash({ type, payload, at: nowIso() }), at: nowIso(), type, ...sanitizeRecoveryValue(payload) }); }
}

class BranchScorer {
  constructor(weights = {}) { this.weights = { verifierSuccess: .30, entropy: .20, architecturalConsistency: .20, tokenEfficiency: .15, benchmarkImpact: .15, ...weights }; }
  score(branch, snapshot) {
    const metrics = branch.metrics || {}; const verifier = snapshot?.verifierState || {};
    const verifierSuccess = clamp01(metrics.verifierSuccess ?? verifier.successRate ?? (verifier.ok === false ? 0 : 1));
    const entropy = clamp01(1 - (metrics.entropyScore ?? snapshot?.contextState?.entropyScore ?? 0));
    const architecturalConsistency = clamp01(metrics.architecturalConsistency ?? invariantConsistency(snapshot));
    const tokenEfficiency = clamp01(metrics.tokenEfficiency ?? (1 / (1 + (snapshot?.contextState?.tokens || estimateTokens(snapshot?.contextState || {})) / 12000)));
    const benchmarkImpact = clamp01(metrics.benchmarkImpact ?? normalizeBenchmark(verifier.benchmarkDeltas));
    const components = { verifierSuccess, entropy, architecturalConsistency, tokenEfficiency, benchmarkImpact };
    let score = 0; for (const [k, w] of Object.entries(this.weights)) score += w * (components[k] ?? 0);
    return { score: clamp01(score), components };
  }
}
function normalizeBenchmark(deltas = {}) { const vals = Object.values(deltas || {}).map((d) => typeof d === "number" ? d : d?.delta).filter(Number.isFinite); if (!vals.length) return .75; return clamp01(.75 - vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length * 100)); }
function invariantConsistency(snapshot) { const inv = snapshot?.verifierState?.invariants || snapshot?.contextState?.invariants || []; if (!inv.length) return .8; return inv.filter((x) => x.ok !== false).length / inv.length; }

class MergeEngine {
  constructor({ invariants = [] } = {}) { this.invariants = invariants; }
  compare(base, left, right) {
    return { leftDelta: diffFileStates(base?.filesystemState?.files, left?.filesystemState?.files), rightDelta: diffFileStates(base?.filesystemState?.files, right?.filesystemState?.files), semanticDistance: 1 - jaccard(left?.contextState, right?.contextState) };
  }
  merge(base, left, right) {
    const conflicts = []; const mergedFiles = {}; const files = unique([...Object.keys(base?.filesystemState?.files || {}), ...Object.keys(left?.filesystemState?.files || {}), ...Object.keys(right?.filesystemState?.files || {})]);
    for (const file of files) {
      const B = base?.filesystemState?.files?.[file] || { exists: false };
      const L = left?.filesystemState?.files?.[file] || { exists: false };
      const R = right?.filesystemState?.files?.[file] || { exists: false };
      const m = mergeFile(file, B, L, R);
      if (m.conflict) conflicts.push(m.conflict);
      mergedFiles[file] = m.state;
    }
    const snapshot = {
      id: `merge_${shortHash({ left: left.id, right: right.id, at: nowIso() })}`,
      at: nowIso(),
      memoryState: semanticObjectMerge(base?.memoryState, left?.memoryState, right?.memoryState),
      contextState: semanticObjectMerge(base?.contextState, left?.contextState, right?.contextState),
      toolState: semanticObjectMerge(base?.toolState, left?.toolState, right?.toolState),
      verifierState: semanticObjectMerge(base?.verifierState, left?.verifierState, right?.verifierState),
      filesystemState: { fingerprint: shortHash(mergedFiles), files: mergedFiles },
      parents: [left.id, right.id],
    };
    const invariantViolations = this.invariants.map((fn) => fn(snapshot)).filter((r) => r === false || r?.ok === false).map((r) => typeof r === "object" ? r : { ok: false, reason: "invariant rejected merge" });
    return { ok: conflicts.length === 0 && invariantViolations.length === 0, snapshot, conflicts, invariantViolations, comparison: this.compare(base, left, right) };
  }
}

function mergeFile(file, B, L, R) {
  if ((L.hash || null) === (R.hash || null)) return { state: deepClone(L) };
  if ((B.hash || null) === (L.hash || null)) return { state: deepClone(R) };
  if ((B.hash || null) === (R.hash || null)) return { state: deepClone(L) };
  if (B.text && L.text && R.text) {
    const merged = threeWayText(B.content || "", L.content || "", R.content || "");
    if (!merged.conflict) return { state: { exists: true, mode: L.mode || R.mode, text: true, content: merged.content, hash: hash(merged.content), bytes: Buffer.byteLength(merged.content) } };
  }
  return { state: deepClone(L), conflict: { file, reason: "concurrent incompatible edits", leftHash: L.hash, rightHash: R.hash, baseHash: B.hash } };
}
function threeWayText(base, left, right) {
  if (left === right) return { content: left };
  if (left.includes(base)) return { content: left.replace(base, right) };
  if (right.includes(base)) return { content: right.replace(base, left) };
  const bl = base.split(/\n/), ll = left.split(/\n/), rr = right.split(/\n/);
  if (jaccard(left, right) > .92) return { content: ll.length >= rr.length ? left : right };
  return { conflict: true, content: `<<<<<<< LEFT\n${left}\n=======\n${right}\n>>>>>>> RIGHT\n` };
}
function semanticObjectMerge(base = {}, left = {}, right = {}) {
  if (stableStringify(left) === stableStringify(right)) return deepClone(left);
  if (stableStringify(base) === stableStringify(left)) return deepClone(right);
  if (stableStringify(base) === stableStringify(right)) return deepClone(left);
  if (Array.isArray(left) || Array.isArray(right)) return unique([...(Array.isArray(base) ? base : []), ...(Array.isArray(left) ? left : [left]), ...(Array.isArray(right) ? right : [right])]);
  const out = { ...(base || {}) };
  for (const k of unique([...Object.keys(left || {}), ...Object.keys(right || {})])) out[k] = semanticObjectMerge(base?.[k], left?.[k], right?.[k]);
  return out;
}

class ExplorationPolicyEngine {
  constructor({ entropyThreshold = .68, riskyOperations = [/rm\s+-rf/, /drop\s+table/i, /force/i, /secret/i], maxBranches = 24 } = {}) { this.entropyThreshold = entropyThreshold; this.riskyOperations = riskyOperations; this.maxBranches = maxBranches; }
  shouldBranch(event = {}) {
    if ((event.entropyScore || 0) >= this.entropyThreshold) return { branch: true, type: "experimental", reason: "high entropy" };
    if (event.kind === "verify") return { branch: true, type: "verification", reason: "verification isolation" };
    if (event.kind === "agent") return { branch: true, type: "multi-agent", reason: "agent isolation" };
    if (event.text && this.riskyOperations.some((r) => r.test(event.text))) return { branch: true, type: "rollback", reason: "risky operation" };
    if (event.alternatives > 1) return { branch: true, type: "speculative", reason: "parallel exploration" };
    return { branch: false };
  }
  prune(branches, scorer, loadSnapshot) {
    const scored = branches.filter((b) => b.status !== "main").map((b) => ({ b, s: scorer.score(b, loadSnapshot(b.headSnapshotId)).score }));
    scored.sort((a, b) => b.s - a.s || b.b.updatedAt.localeCompare(a.b.updatedAt));
    return scored.slice(this.maxBranches).map((x) => ({ ...x.b, status: "pruned", prunedAt: nowIso(), pruneScore: x.s }));
  }
}

class BranchVisualizer {
  static tree(branches) {
    const byParent = new Map(); for (const b of branches) { const p = b.parentBranchId || "<root>"; (byParent.get(p) || byParent.set(p, []).get(p)).push(b); }
    const lines = [];
    function walk(parent, prefix = "") { for (const b of byParent.get(parent) || []) { lines.push(`${prefix}${b.id} [${b.type}] ${b.status} score=${(b.score?.score ?? 0).toFixed(2)} ${b.name || ""}`); walk(b.id, `${prefix}  └─ `); } }
    walk("<root>"); return lines.join("\n");
  }
  static divergence(comparison) { const l = comparison.leftDelta.changed, r = comparison.rightDelta.changed; return [`left changed: ${l.join(", ") || "none"}`, `right changed: ${r.join(", ") || "none"}`, `overlap: ${l.filter((f) => r.includes(f)).join(", ") || "none"}`, `semantic distance: ${comparison.semanticDistance.toFixed(3)}`].join("\n"); }
  static mergeHistory(events = []) { return events.filter((e) => e.type?.includes("merge") || e.type?.includes("rollback")).map((e) => `${e.at} ${e.type} ${e.branchId || ""} ${e.targetBranchId || ""}`).join("\n"); }
  static rollbackNavigation(branches) { return branches.filter((b) => b.status !== "quarantined").map((b) => `${b.id} -> snapshot ${b.headSnapshotId} (${b.updatedAt})`).join("\n"); }
}

class SessionBranchManager {
  constructor({ cwd = process.cwd(), store = null, scorer = null, mergeEngine = null, policies = null, ignore = DEFAULT_IGNORE } = {}) {
    this.cwd = cwd; this.ignore = ignore; this.store = store || new SnapshotStore(path.join(cwd, ".pi", "session-branches")); this.scorer = scorer || new BranchScorer(); this.mergeEngine = mergeEngine || new MergeEngine(); this.policies = policies || new ExplorationPolicyEngine();
  }
  createSnapshot({ branchId = null, memoryState = {}, contextState = {}, toolState = {}, verifierState = {}, metadata = {}, files = null } = {}) {
    const fileList = files || listFiles(this.cwd, { ignore: this.ignore }); const fileState = readFileState(this.cwd, fileList);
    const snapshot = { id: `snap_${shortHash({ branchId, memoryState, contextState, toolState, verifierState, fileState, at: nowIso() })}`, at: nowIso(), branchId, metadata, memoryState, contextState, toolState, verifierState, filesystemState: { fingerprint: shortHash(fileState), files: fileState } };
    const saved = this.store.saveSnapshot(snapshot); this.store.event("snapshot.created", { snapshotId: saved.id, branchId }); return saved;
  }
  createBranch({ fromBranchId = null, fromSnapshotId = null, type = "experimental", name = "", metadata = {}, states = {} } = {}) {
    if (!BRANCH_TYPES.includes(type)) throw new Error(`invalid branch type: ${type}`);
    const parent = fromBranchId ? this.store.loadBranch(fromBranchId) : null;
    const baseSnapshot = fromSnapshotId ? this.store.loadSnapshot(fromSnapshotId) : parent?.headSnapshotId ? this.store.loadSnapshot(parent.headSnapshotId) : null;
    const hasExplicitState = Object.keys(states || {}).some((k) => k !== "snapshot");
    let snapshot = states.snapshot || (fromSnapshotId && baseSnapshot && !hasExplicitState
      ? { ...deepClone(baseSnapshot), id: `snap_${shortHash({ forkedFrom: baseSnapshot.id, at: nowIso() })}`, at: nowIso(), metadata: { ...baseSnapshot.metadata, ...metadata, forkedFrom: baseSnapshot.id } }
      : this.createSnapshot({ branchId: null, ...states, metadata: { ...metadata, baseSnapshotId: baseSnapshot?.id || null } }));
    const id = `br_${shortHash({ type, name, parent: fromBranchId, snap: snapshot.id, at: nowIso() })}`;
    snapshot.branchId = id; snapshot = this.store.saveSnapshot(snapshot);
    const branch = { id, type, name, status: "active", createdAt: nowIso(), updatedAt: nowIso(), parentBranchId: fromBranchId, parentSnapshotId: baseSnapshot?.id || fromSnapshotId || null, headSnapshotId: snapshot.id, lineage: [...(parent?.lineage || []), ...(fromBranchId ? [fromBranchId] : [])], metadata, metrics: {}, score: this.scorer.score({ metrics: {} }, snapshot), agents: [], checkpoints: [snapshot.id] };
    this.store.saveBranch(branch); this.store.event("branch.created", { branchId: id, type, parentBranchId: fromBranchId, snapshotId: snapshot.id }); return branch;
  }
  checkpoint(branchId, states = {}) { const branch = this.requireBranch(branchId); const snap = this.createSnapshot({ branchId, ...states }); branch.headSnapshotId = snap.id; branch.updatedAt = nowIso(); branch.checkpoints.push(snap.id); branch.score = this.scorer.score(branch, snap); this.store.saveBranch(branch); this.store.event("branch.checkpoint", { branchId, snapshotId: snap.id }); return snap; }
  rollback(branchId, snapshotId = null, options = {}) { const branch = this.requireBranch(branchId); const snap = this.store.loadSnapshot(snapshotId || branch.parentSnapshotId || branch.checkpoints[0]); if (!snap) throw new Error("rollback snapshot not found"); restoreFileState(this.cwd, snap.filesystemState.files, options); branch.headSnapshotId = snap.id; branch.status = "rolled-back"; branch.updatedAt = nowIso(); this.store.saveBranch(branch); this.store.event("branch.rollback", { branchId, snapshotId: snap.id }); return snap; }
  instantRollback(snapshotId, options = {}) { const snap = this.store.loadSnapshot(snapshotId); if (!snap) throw new Error("snapshot not found"); restoreFileState(this.cwd, snap.filesystemState.files, options); this.store.event("snapshot.restored", { snapshotId }); return snap; }
  previewMerge(leftBranchId, rightBranchId) {
    const leftB = this.requireBranch(leftBranchId), rightB = this.requireBranch(rightBranchId);
    const base = this.commonBase(leftB, rightB) || this.store.loadSnapshot(leftB.parentSnapshotId) || this.store.loadSnapshot(rightB.parentSnapshotId);
    return this.mergeEngine.merge(base, this.store.loadSnapshot(leftB.headSnapshotId), this.store.loadSnapshot(rightB.headSnapshotId));
  }
  merge(leftBranchId, rightBranchId, { targetName = "merged", type = "verification", apply = false } = {}) {
    const result = this.previewMerge(leftBranchId, rightBranchId);
    this.store.saveSnapshot(result.snapshot); this.store.event(result.ok ? "branch.merge.ok" : "branch.merge.conflict", { leftBranchId, rightBranchId, snapshotId: result.snapshot.id, conflicts: result.conflicts.length });
    if (!result.ok) return result;
    if (apply) restoreFileState(this.cwd, result.snapshot.filesystemState.files);
    result.branch = this.createBranch({ fromBranchId: leftBranchId, fromSnapshotId: result.snapshot.id, type, name: targetName, states: { snapshot: result.snapshot }, metadata: { mergedFrom: [leftBranchId, rightBranchId] } });
    return result;
  }
  compare(aBranchId, bBranchId) { const a = this.requireBranch(aBranchId), b = this.requireBranch(bBranchId); return this.mergeEngine.compare(this.commonBase(a, b), this.store.loadSnapshot(a.headSnapshotId), this.store.loadSnapshot(b.headSnapshotId)); }
  score(branchId) { const b = this.requireBranch(branchId); b.score = this.scorer.score(b, this.store.loadSnapshot(b.headSnapshotId)); this.store.saveBranch(b); return b.score; }
  autoBranch(event, states = {}) { const decision = this.policies.shouldBranch(event); return decision.branch ? this.createBranch({ type: decision.type, name: decision.reason, metadata: { policy: decision, event }, states }) : null; }
  quarantine(branchId, reason = "failed branch") { const b = this.requireBranch(branchId); b.status = "quarantined"; b.quarantineReason = reason; b.updatedAt = nowIso(); this.store.saveBranch(b); this.store.event("branch.quarantine", { branchId, reason }); return b; }
  recoverCorruption(branchId) { const b = this.requireBranch(branchId); for (const id of [...b.checkpoints].reverse()) { const s = this.store.loadSnapshot(id); if (s?.filesystemState?.files) { b.headSnapshotId = id; b.status = "recovered"; this.store.saveBranch(b); this.store.event("branch.recovered", { branchId, snapshotId: id }); return s; } } throw new Error("no valid checkpoint"); }
  replay(branchId, { to = null } = {}) { const b = this.requireBranch(branchId); const ids = to ? b.checkpoints.slice(0, b.checkpoints.indexOf(to) + 1) : b.checkpoints; return ids.map((id, index) => ({ index, snapshot: this.store.loadSnapshot(id) })).filter((x) => x.snapshot); }
  exportBranch(branchId) {
    const branch = this.requireBranch(branchId);
    const snapshotIds = unique([branch.parentSnapshotId, branch.headSnapshotId, ...(branch.checkpoints || [])]);
    return { schemaVersion: 1, exportPolicy: "metadata-only; recovery payload remains local", branch: sanitizeBranchForExport(branch), snapshots: snapshotIds.map((id) => sanitizeSnapshotForExport(this.store.loadSnapshot(id))).filter(Boolean) };
  }
  assignAgent(branchId, agentId, manifest = {}) { const b = this.requireBranch(branchId); if (b.agents.some((a) => a.agentId === agentId && a.active)) throw new Error("agent already assigned"); const lease = { agentId, active: true, assignedAt: nowIso(), manifest }; b.agents.push(lease); b.type = b.type === "multi-agent" ? b.type : b.type; this.store.saveBranch(b); this.store.event("agent.assigned", { branchId, agentId }); return lease; }
  completeAgentWork(branchId, agentId, verifierState = {}) { const b = this.requireBranch(branchId); const lease = b.agents.find((a) => a.agentId === agentId && a.active); if (!lease) throw new Error("agent lease not found"); lease.active = false; lease.completedAt = nowIso(); b.metrics.verifierSuccess = verifierState.ok === false ? 0 : (verifierState.successRate ?? 1); this.store.saveBranch(b); this.store.event("agent.completed", { branchId, agentId, verified: verifierState.ok !== false }); return verifierState.ok !== false; }
  prune() { const updated = this.policies.prune(this.store.listBranches(), this.scorer, (id) => this.store.loadSnapshot(id)); for (const b of updated) this.store.saveBranch(b); return updated; }
  visualizeTree() { return BranchVisualizer.tree(this.store.listBranches()); }
  requireBranch(id) { const b = this.store.loadBranch(id); if (!b) throw new Error(`branch not found: ${id}`); return b; }
  commonBase(a, b) { const ids = new Set([a.parentSnapshotId, ...a.checkpoints]); for (const id of [b.parentSnapshotId, ...b.checkpoints]) if (ids.has(id)) return this.store.loadSnapshot(id); return null; }
}

function walkStateFiles(root, limit = 20_000, out = []) {
  if (!exists(root) || out.length >= limit) return out;
  for (const name of fs.readdirSync(root)) {
    if (out.length >= limit) break;
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkStateFiles(file, limit, out);
    else if (stat.isFile()) out.push(file);
  }
  return out;
}
function stateIdentity(file) { const stat = fs.lstatSync(file); const bytes = fs.readFileSync(file); return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, hash: crypto.createHash("sha256").update(bytes).digest("hex") }; }
function sameStateIdentity(file, identity) {
  try { const current = stateIdentity(file); return current.dev === identity.dev && current.ino === identity.ino && current.size === identity.size && current.hash === identity.hash; } catch { return false; }
}
function snapshotMaintenancePlan(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const now = Number(options.now || Date.now());
  const requestedMaxSnapshots = Number(options.maxSnapshots || process.env.PI_BRANCH_MAX_SNAPSHOTS || 200);
  const requestedOlderThanMs = Number(options.olderThanMs ?? Number(process.env.PI_BRANCH_RETENTION_DAYS || 30) * 24 * 60 * 60 * 1000);
  const requestedMaxBytes = Number(options.maxSnapshotBytes || process.env.PI_BRANCH_SNAPSHOT_MAX_BYTES || DEFAULT_MAX_SNAPSHOT_BYTES);
  const maxSnapshots = Number.isFinite(requestedMaxSnapshots) && requestedMaxSnapshots > 0 ? Math.floor(requestedMaxSnapshots) : 200;
  const olderThanMs = Number.isFinite(requestedOlderThanMs) && requestedOlderThanMs >= 0 ? requestedOlderThanMs : 30 * 24 * 60 * 60 * 1000;
  const maxSnapshotBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes >= 1024 ? Math.floor(requestedMaxBytes) : DEFAULT_MAX_SNAPSHOT_BYTES;
  if (!exists(resolvedRoot)) return { schemaVersion: 1, root: resolvedRoot, generatedAt: new Date(now).toISOString(), policy: { maxSnapshots, olderThanMs, maxSnapshotBytes, lineageProtected: true, exportPolicy: "metadata-only" }, summary: { branches: 0, snapshots: 0, protectedSnapshots: 0, rewrites: 0, privatePathsRemoved: 0, removals: 0, oversizedProtected: 0, fileModeChanges: 0, directoryModeChanges: 0 }, rewrites: [], removals: [], oversizedProtected: [], permissionFiles: [], permissionDirs: [] };
  const branchFiles = walkStateFiles(path.join(resolvedRoot, "branches")).filter((file) => file.endsWith(".json"));
  const branches = branchFiles.map((file) => readJson(file, null)).filter(Boolean);
  const byBranch = new Map(branches.map((branch) => [branch.id, branch]));
  const protectedBranches = new Set(branches.filter((branch) => branch.status !== "pruned").map((branch) => branch.id));
  for (const branchId of [...protectedBranches]) for (const ancestor of byBranch.get(branchId)?.lineage || []) protectedBranches.add(ancestor);
  const protectedSnapshots = new Set();
  for (const branchId of protectedBranches) {
    const branch = byBranch.get(branchId);
    for (const id of [branch?.parentSnapshotId, branch?.headSnapshotId, ...(branch?.checkpoints || [])]) if (id) protectedSnapshots.add(id);
  }
  const snapshotFiles = walkStateFiles(path.join(resolvedRoot, "snapshots")).filter((file) => file.endsWith(".json"));
  const snapshots = snapshotFiles.map((file) => {
    const value = readJson(file, null);
    if (!value?.id) return null;
    const identity = stateIdentity(file);
    const safe = sanitizeSnapshotForStorage(value);
    const safeBytes = Buffer.byteLength(serializedJson(safe));
    const privateBefore = Object.keys(value.filesystemState?.files || {}).filter(isPrivateSnapshotPath).length;
    return { id: value.id, file, identity, atMs: Date.parse(value.at || "") || identity.mtimeMs, protected: protectedSnapshots.has(value.id), rewrite: stableStringify(value) !== stableStringify(safe), privateBefore, safeBytes, oversized: safeBytes > maxSnapshotBytes };
  }).filter(Boolean).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  const remove = new Map();
  for (const snapshot of snapshots) if (!snapshot.protected && (now - snapshot.atMs >= olderThanMs || snapshot.oversized)) remove.set(snapshot.id, snapshot);
  for (const snapshot of snapshots) {
    if (snapshots.length - remove.size <= maxSnapshots) break;
    if (!snapshot.protected) remove.set(snapshot.id, snapshot);
  }
  const rewrites = snapshots.filter((snapshot) => snapshot.rewrite && !snapshot.oversized && !remove.has(snapshot.id));
  const oversizedProtected = snapshots.filter((snapshot) => snapshot.oversized && snapshot.protected);
  const allFiles = walkStateFiles(resolvedRoot);
  const allDirs = [resolvedRoot];
  const collectDirs = (dir) => { if (!exists(dir)) return; for (const name of fs.readdirSync(dir)) { const target = path.join(dir, name); try { const stat = fs.lstatSync(target); if (!stat.isSymbolicLink() && stat.isDirectory()) { allDirs.push(target); collectDirs(target); } } catch {} } };
  collectDirs(resolvedRoot);
  return {
    schemaVersion: 1,
    root: resolvedRoot,
    generatedAt: new Date(now).toISOString(),
    policy: { maxSnapshots, olderThanMs, maxSnapshotBytes, lineageProtected: true, exportPolicy: "metadata-only" },
    summary: { branches: branches.length, snapshots: snapshots.length, protectedSnapshots: snapshots.filter((snapshot) => snapshot.protected).length, rewrites: rewrites.length, privatePathsRemoved: rewrites.reduce((sum, snapshot) => sum + snapshot.privateBefore, 0), removals: remove.size, oversizedProtected: oversizedProtected.length, fileModeChanges: allFiles.filter((file) => (fs.lstatSync(file).mode & 0o777) !== 0o600).length, directoryModeChanges: allDirs.filter((dir) => (fs.lstatSync(dir).mode & 0o777) !== 0o700).length },
    rewrites: rewrites.map(({ id, file, identity, privateBefore, safeBytes }) => ({ id, file, identity, privateBefore, safeBytes })),
    removals: [...remove.values()].map(({ id, file, identity }) => ({ id, file, identity })),
    oversizedProtected: oversizedProtected.map(({ id, safeBytes }) => ({ id, safeBytes })),
    permissionFiles: allFiles.filter((file) => (fs.lstatSync(file).mode & 0o777) !== 0o600).map((file) => ({ file, identity: stateIdentity(file) })),
    permissionDirs: allDirs.filter((dir) => (fs.lstatSync(dir).mode & 0o777) !== 0o700).map((dir) => { const stat = fs.lstatSync(dir); return { dir, identity: { dev: stat.dev, ino: stat.ino } }; }),
  };
}
function applySnapshotMaintenance(plan, { dryRun = true } = {}) {
  const result = { dryRun, applied: false, rewritten: [], removed: [], hardenedFiles: [], hardenedDirs: [], errors: [], summary: plan.summary };
  if (dryRun) return result;
  if (plan.oversizedProtected?.length) { result.errors.push({ code: "protected-snapshot-oversized", count: plan.oversizedProtected.length }); return result; }
  for (const item of [...(plan.permissionDirs || [])].sort((a, b) => a.dir.length - b.dir.length)) {
    try { const stat = fs.lstatSync(item.dir); if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== item.identity.dev || stat.ino !== item.identity.ino) throw new Error("directory changed since preview"); fs.chmodSync(item.dir, 0o700); result.hardenedDirs.push(path.basename(item.dir)); }
    catch (error) { result.errors.push({ code: "directory-permission-failed", error: String(error.message || error) }); }
  }
  for (const item of plan.permissionFiles || []) {
    try { if (!sameStateIdentity(item.file, item.identity)) throw new Error("file changed since preview"); fs.chmodSync(item.file, 0o600); result.hardenedFiles.push(path.basename(item.file)); }
    catch (error) { result.errors.push({ code: "file-permission-failed", error: String(error.message || error) }); }
  }
  for (const item of plan.rewrites || []) {
    if (!sameStateIdentity(item.file, item.identity)) { result.errors.push({ id: item.id, code: "changed-since-preview" }); continue; }
    try {
      const safe = sanitizeSnapshotForStorage(readJson(item.file, null));
      writeJson(item.file, safe, { maxBytes: plan.policy.maxSnapshotBytes });
      result.rewritten.push({ id: item.id, privatePathsRemoved: item.privateBefore, bytes: Buffer.byteLength(serializedJson(safe)) });
    } catch (error) { result.errors.push({ id: item.id, code: error.code || "rewrite-failed", error: String(error.message || error) }); }
  }
  for (const item of plan.removals || []) {
    if (!sameStateIdentity(item.file, item.identity)) { result.errors.push({ id: item.id, code: "changed-since-preview" }); continue; }
    try { fs.rmSync(item.file); try { fs.rmdirSync(path.dirname(item.file)); } catch {} result.removed.push({ id: item.id }); }
    catch (error) { result.errors.push({ id: item.id, code: "remove-failed", error: String(error.message || error) }); }
  }
  result.applied = result.errors.length === 0;
  try { appendJsonl(path.join(plan.root, "events.jsonl"), { at: nowIso(), type: "snapshot.maintenance", rewritten: result.rewritten.length, removed: result.removed.length, hardenedFiles: result.hardenedFiles.length, hardenedDirs: result.hardenedDirs.length, ok: result.applied }); } catch {}
  return result;
}

module.exports = { BRANCH_TYPES, PRIVATE_SNAPSHOT_PREFIXES, DEFAULT_MAX_SNAPSHOT_BYTES, SnapshotStore, BranchScorer, MergeEngine, ExplorationPolicyEngine, BranchVisualizer, SessionBranchManager, listFiles, readFileState, restoreFileState, diffFileStates, semanticObjectMerge, normalizeSnapshotRelativePath, isPrivateSnapshotPath, sanitizeRecoveryValue, sanitizeSnapshotForStorage, sanitizeSnapshotForExport, sanitizeBranchForExport, snapshotMaintenancePlan, applySnapshotMaintenance };
