"use strict";

/**
 * Session project scope.
 *
 * Pi runs in one working directory, so every harness module resolves its `.pi`
 * state from `ctx.cwd`. When a session also works on a second directory, that
 * directory's `.pi` state, memories and logs must stay reachable without
 * pretending it replaced the working directory. This module is the single
 * source of truth for "which project directories are in scope":
 *
 * - the working directory itself,
 * - directories declared with PI_HARNESS_PROJECT_DIRS,
 * - directories explicitly granted with /policy-approve-directory.
 *
 * A grant is an existing, user-created authorization for this project, so it is
 * reused rather than duplicated in a second configuration file. Nothing is
 * discovered implicitly: a directory is in scope only because the operator
 * named it.
 */

const fs = require("node:fs");
const path = require("node:path");

const SCOPE_ENV = "PI_HARNESS_PROJECT_DIRS";
const STATE_DIR = ".pi";
const APPROVALS_FILE = path.join(STATE_DIR, "policy-enforcer", "approvals.json");
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_DEPTH = 4;
// State directories whose files are diagnostic logs rather than durable
// records. Only these are scanned for `logs`, so the reader cannot wander into
// unrelated state (candidate prompts, decisions, credentials).
const LOG_DIRS = Object.freeze([
  "traces",
  "audit",
  "session-audit",
  "verification-evidence",
  "verification-center",
  "extension-telemetry",
  "test-runner",
  "debug-ledger",
  "run-deck",
  "runtime-doctor",
  "cognitive-automation",
]);
const LOG_EXTENSIONS = new Set([".jsonl", ".log", ".json", ".txt", ".md"]);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  // A dot-prefixed name such as "..safe" is a child, not parent traversal.
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Resolve through the nearest existing ancestor so a target that does not exist
// yet (or a root replaced by a symlink) cannot borrow another tree's identity.
function canonicalPath(value) {
  let existing = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    return path.join(fs.realpathSync(existing), ...suffix);
  } catch {
    return path.resolve(value);
  }
}

function realDirectory(value) {
  try {
    const real = fs.realpathSync(value);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function configuredRoots(cwd, env = process.env) {
  const entries = String(env[SCOPE_ENV] || "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  const roots = [];
  const invalid = [];
  for (const entry of entries) {
    const absolute = path.resolve(cwd, entry);
    const real = realDirectory(absolute);
    if (!real) {
      let reason = "missing";
      try {
        if (!fs.statSync(absolute).isDirectory()) reason = "not-a-directory";
      } catch {}
      invalid.push({ source: "configured", entry, reason });
      continue;
    }
    roots.push({ path: real, source: "configured", declared: entry });
  }
  return { roots, invalid };
}

// Directory grants live in the source project's approval store, exactly like the
// policy enforcer's own check: same source root, canonical destination, and no
// redirection through a replaced symlink.
function directoryGrants(cwd) {
  const file = path.join(cwd, APPROVALS_FILE);
  let packet;
  try {
    packet = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { roots: [], invalid: [] };
  }
  const sourceRoot = realDirectory(cwd);
  if (!sourceRoot) return { roots: [], invalid: [] };
  const now = Date.now();
  const roots = [];
  const invalid = [];
  for (const item of Array.isArray(packet?.approvals) ? packet.approvals : []) {
    const request = item?.request;
    if (request?.kind !== "directory-write") continue;
    if (item.expiresAt && Date.parse(item.expiresAt) <= now) continue;
    if (request.sourceRoot !== sourceRoot) continue;
    const real = realDirectory(request.path);
    if (!real || real !== request.path) {
      invalid.push({ source: "policy-grant", entry: request.path || null, reason: real ? "redirected-symlink" : "missing", approvalKey: item.key || null });
      continue;
    }
    roots.push({ path: real, source: "policy-grant", approvalKey: item.key || null });
  }
  return { roots, invalid };
}

function projectScope(cwd = process.cwd(), options = {}) {
  const primary = canonicalPath(cwd);
  const configured = configuredRoots(cwd, options.env || process.env);
  const grants = options.includeGrants === false ? { roots: [], invalid: [] } : directoryGrants(cwd);
  const roots = [{ path: primary, source: "working-directory" }];
  const seen = new Set([primary]);
  for (const root of [...configured.roots, ...grants.roots]) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    roots.push(root);
  }
  return {
    schemaVersion: 1,
    primary,
    roots,
    paths: roots.map((root) => root.path),
    invalid: [...configured.invalid, ...grants.invalid],
  };
}

function owningRoot(scope, target) {
  const canonical = canonicalPath(target);
  let best = null;
  for (const root of scope.roots) {
    if (!isInside(root.path, canonical)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

function scopeDenied(message, target) {
  const error = new Error(message);
  error.code = "PROJECT_SCOPE_DENIED";
  error.target = target;
  return error;
}

function assertProjectScope(cwd, target, options = {}) {
  const label = options.label || "project";
  const absolute = path.resolve(cwd, target);
  const envVar = options.envVar;
  if (options.allowOutside) return { root: { path: canonicalPath(cwd), source: "allow-outside" }, scope: null, absolute, canonical: canonicalPath(absolute) };
  const scope = projectScope(cwd, { env: options.env });
  const root = owningRoot(scope, absolute);
  if (root) return { root, scope, absolute, canonical: canonicalPath(absolute) };
  const guidance = envVar ? ` Set ${envVar}=1 to allow ${absolute}.` : "";
  throw scopeDenied(`${label} path must stay inside the session project scope (${scope.primary}) or a declared second directory. Add it to ${SCOPE_ENV} or grant it with /policy-approve-directory.${guidance}`, absolute);
}

function stateDir(root) {
  return path.join(root, STATE_DIR);
}

function scanTree(directory, options = {}) {
  const maxFiles = options.maxFiles || MAX_SCAN_FILES;
  const maxDepth = options.maxDepth || MAX_SCAN_DEPTH;
  const result = { files: 0, bytes: 0, newestMtimeMs: 0, truncated: false };
  const walk = (current, depth) => {
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (result.files >= maxFiles) {
        result.truncated = true;
        return;
      }
      const file = path.join(current, name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        continue;
      }
      // Symlinks are counted but never followed: state must not escape the root.
      if (stat.isSymbolicLink()) {
        result.files += 1;
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < maxDepth) walk(file, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      result.files += 1;
      result.bytes += stat.size;
      if (stat.mtimeMs > result.newestMtimeMs) result.newestMtimeMs = stat.mtimeMs;
    }
  };
  walk(directory, 0);
  return result;
}

function stateInventory(root, options = {}) {
  const directory = stateDir(root);
  const maxEntries = options.maxEntries || 50;
  if (!fs.existsSync(directory)) return { root, stateDir: STATE_DIR, exists: false, entries: [], totalBytes: 0, truncated: false };
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    return { root, stateDir: STATE_DIR, exists: false, error: String(error?.message || error), entries: [], totalBytes: 0, truncated: false };
  }
  const entries = [];
  let totalBytes = 0;
  for (const name of names.sort()) {
    const file = path.join(directory, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ name, kind: "symlink", bytes: 0, newestMtimeMs: 0 });
      continue;
    }
    if (stat.isDirectory()) {
      const scan = scanTree(file, options);
      totalBytes += scan.bytes;
      entries.push({ name, kind: "directory", files: scan.files, bytes: scan.bytes, newestMtimeMs: scan.newestMtimeMs, truncated: scan.truncated });
      continue;
    }
    totalBytes += stat.size;
    entries.push({ name, kind: "file", files: 1, bytes: stat.size, newestMtimeMs: stat.mtimeMs });
  }
  entries.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  const truncated = entries.length > maxEntries;
  return {
    root,
    stateDir: STATE_DIR,
    exists: true,
    entries: entries.slice(0, maxEntries).map((entry) => ({ ...entry, newestAt: entry.newestMtimeMs ? new Date(entry.newestMtimeMs).toISOString() : null })),
    entryCount: entries.length,
    totalBytes,
    truncated,
  };
}

function resolveStateFile(root, file) {
  const directory = stateDir(root);
  if (typeof file !== "string" || !file.trim()) throw new Error("A state file path is required");
  const raw = file.trim().startsWith("@") ? file.trim().slice(1) : file.trim();
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(directory, raw);
  if (!isInside(canonicalPath(directory), canonicalPath(absolute))) {
    throw scopeDenied(`State file must stay inside ${path.join(root, STATE_DIR)}: ${file}`, absolute);
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    throw new Error(`State file not found: ${file} (${error?.code || "error"})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`State file must be a regular file, not a symlink or directory: ${file}`);
  return { absolute, stat, relative: path.relative(directory, absolute).replace(/\\/g, "/") };
}

function readStateFile(root, file, options = {}) {
  const maxBytes = Math.max(1, Math.min(Number(options.maxBytes || 64 * 1024), 1024 * 1024));
  const { absolute, stat, relative } = resolveStateFile(root, file);
  const fd = fs.openSync(absolute, "r");
  let buffer;
  try {
    buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return {
    root,
    path: path.join(STATE_DIR, relative),
    bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    truncated: stat.size > maxBytes,
    text: buffer.toString("utf8"),
  };
}

function logCandidates(root, options = {}) {
  const directory = stateDir(root);
  const sinceMs = options.sinceMs || 0;
  const maxFiles = options.maxFiles || 200;
  const files = [];
  for (const name of LOG_DIRS) {
    const base = path.join(directory, name);
    if (!fs.existsSync(base)) continue;
    const scan = (current, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(current);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        const file = path.join(current, entry);
        let stat;
        try {
          stat = fs.lstatSync(file);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (depth < 2) scan(file, depth + 1);
          continue;
        }
        if (!stat.isFile() || !LOG_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
        if (stat.mtimeMs < sinceMs) continue;
        files.push({ absolute: file, relative: path.relative(directory, file).replace(/\\/g, "/"), bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    };
    scan(base, 0);
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.relative.localeCompare(right.relative));
  return { files, truncated: files.length >= maxFiles };
}

function tailFile(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return { text: buffer.toString("utf8"), truncated: stat.size > length, bytes: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function readLogs(root, options = {}) {
  const maxFiles = Math.max(1, Math.min(Number(options.maxFiles || 5), 50));
  const maxLines = Math.max(1, Math.min(Number(options.maxLines || 80), 2000));
  const maxBytes = Math.max(1024, Math.min(Number(options.maxBytes || 16 * 1024), 512 * 1024));
  const candidates = logCandidates(root, { sinceMs: options.sinceMs, maxFiles: options.scanMaxFiles || 200 });
  const selected = candidates.files.slice(0, maxFiles);
  const entries = selected.map((candidate) => {
    const tail = tailFile(candidate.absolute, maxBytes);
    // A log file normally ends with a newline; keeping that trailing empty line
    // would make a one-line tail look empty.
    const text = tail.text.endsWith("\n") ? tail.text.slice(0, -1) : tail.text;
    const lines = text.split(/\r?\n/);
    const kept = lines.slice(Math.max(0, lines.length - maxLines));
    return {
      path: path.join(STATE_DIR, candidate.relative),
      bytes: candidate.bytes,
      mtime: new Date(candidate.mtimeMs).toISOString(),
      lines: kept,
      truncated: tail.truncated || kept.length < lines.length,
    };
  });
  return {
    root,
    stateDir: STATE_DIR,
    exists: fs.existsSync(stateDir(root)),
    sources: LOG_DIRS.filter((name) => fs.existsSync(path.join(stateDir(root), name))),
    entries,
    candidateCount: candidates.files.length,
    truncated: candidates.truncated || candidates.files.length > maxFiles,
  };
}

function scopeSummary(root, options = {}) {
  const inventory = stateInventory(root, { maxEntries: options.maxEntries || 0 });
  const gitRoot = (() => {
    let current = root;
    for (;;) {
      if (fs.existsSync(path.join(current, ".git"))) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  })();
  return {
    path: root,
    state: inventory.exists ? { exists: true, entries: inventory.entryCount, bytes: inventory.totalBytes } : { exists: false, entries: 0, bytes: 0 },
    gitRoot,
  };
}

function describeScope(scope, options = {}) {
  return {
    schemaVersion: 1,
    primary: scope.primary,
    roots: scope.roots.map((root) => ({ ...root, ...scopeSummary(root.path, options) })),
    invalid: scope.invalid,
    env: SCOPE_ENV,
  };
}

module.exports = {
  SCOPE_ENV,
  STATE_DIR,
  LOG_DIRS,
  canonicalPath,
  configuredRoots,
  directoryGrants,
  projectScope,
  owningRoot,
  assertProjectScope,
  stateDir,
  stateInventory,
  resolveStateFile,
  readStateFile,
  logCandidates,
  readLogs,
  scopeSummary,
  describeScope,
};
