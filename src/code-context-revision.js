"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { sourceKindForPath } = require("./code-context-contracts.js");

function stable(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
}
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex"); }
function normalizeRepositoryPath(cwd, value, options = {}) {
  if (value == null || value === "") return null;
  const root = path.resolve(cwd || process.cwd());
  const raw = String(value).replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (!options.allowOutside && (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))) throw new TypeError(`path must stay inside repository: ${value}`);
  return path.posix.normalize(relative || ".");
}
function splitFields(text, count) {
  const fields = [];
  let rest = String(text || "");
  for (let i = 0; i < count; i++) {
    const at = rest.indexOf(" ");
    if (at < 0) return { fields, path: "" };
    fields.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return { fields, path: rest };
}
function statusKind(recordType, xy, score) {
  if (recordType === "?") return "untracked";
  if (recordType === "u") return "unmerged";
  if (recordType === "2") return String(score || "").startsWith("C") ? "copied" : "renamed";
  const codes = `${xy || ""}`;
  if (codes.includes("D")) return "deleted";
  if (codes.includes("A")) return "added";
  if (codes.includes("T")) return "type_changed";
  if (codes.includes("U")) return "unmerged";
  return "modified";
}
function statusFlags(xy) {
  const code = String(xy || "..").padEnd(2, ".");
  return {
    indexStatus: code[0],
    worktreeStatus: code[1],
    staged: code[0] !== ".",
    unstaged: code[1] !== ".",
  };
}
function normalizeChange(cwd, input) {
  const file = normalizeRepositoryPath(cwd, input.path);
  const originalPath = input.originalPath ? normalizeRepositoryPath(cwd, input.originalPath) : null;
  return {
    kind: input.kind,
    path: file,
    originalPath,
    sourceKind: sourceKindForPath(file),
    originalSourceKind: originalPath ? sourceKindForPath(originalPath) : null,
    indexStatus: input.indexStatus || ".",
    worktreeStatus: input.worktreeStatus || ".",
    staged: Boolean(input.staged),
    unstaged: Boolean(input.unstaged),
    untracked: input.kind === "untracked",
    deleted: input.kind === "deleted",
    renamed: input.kind === "renamed",
    copied: input.kind === "copied",
    submodule: input.submodule || "N...",
    score: input.score || null,
  };
}
function parsePorcelainV2(output, cwd = process.cwd()) {
  const chunks = String(output || "").split("\0");
  const changes = [];
  for (let i = 0; i < chunks.length; i++) {
    const record = chunks[i];
    if (!record || record.startsWith("# ") || record.startsWith("! ")) continue;
    const type = record[0];
    try {
      if (type === "?") {
        changes.push(normalizeChange(cwd, { kind: "untracked", path: record.slice(2), unstaged: true, worktreeStatus: "?" }));
      } else if (type === "1") {
        const parsed = splitFields(record.slice(2), 7);
        const [xy, submodule] = parsed.fields;
        changes.push(normalizeChange(cwd, { ...statusFlags(xy), kind: statusKind(type, xy), path: parsed.path, submodule }));
      } else if (type === "2") {
        const parsed = splitFields(record.slice(2), 8);
        const [xy, submodule, _mH, _mI, _mW, _hH, _hI, score] = parsed.fields;
        const originalPath = chunks[++i] || null;
        changes.push(normalizeChange(cwd, { ...statusFlags(xy), kind: statusKind(type, xy, score), path: parsed.path, originalPath, submodule, score }));
      } else if (type === "u") {
        const parsed = splitFields(record.slice(2), 9);
        const [xy, submodule] = parsed.fields;
        changes.push(normalizeChange(cwd, { ...statusFlags(xy), kind: "unmerged", path: parsed.path, submodule }));
      }
    } catch (error) {
      changes.push({ kind: "malformed", rawHash: sha256(record).slice(0, 16), error: String(error?.message || error), path: null, originalPath: null, sourceKind: "first_party", staged: false, unstaged: false });
    }
  }
  return changes.sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")) || String(a.originalPath || "").localeCompare(String(b.originalPath || "")) || String(a.kind).localeCompare(String(b.kind)));
}
function runGit(cwd, args, options = {}) {
  const runner = options.spawnSync || spawnSync;
  const result = runner(options.gitBin || "git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: options.timeoutMs || 5000, maxBuffer: options.maxBuffer || 10 * 1024 * 1024 });
  if (result?.status !== 0) return { ok: false, stdout: String(result?.stdout || ""), stderr: String(result?.stderr || result?.error?.message || "git command failed"), status: result?.status };
  return { ok: true, stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), status: 0 };
}
async function runGitAsync(cwd, args, options = {}) {
  const runner = options.execFile || execFileAsync;
  try {
    const result = await runner(options.gitBin || "git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: options.timeoutMs || 5000, maxBuffer: options.maxBuffer || 10 * 1024 * 1024 });
    return { ok: true, stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), status: 0 };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout || ""), stderr: String(error?.stderr || error?.message || "git command failed"), status: error?.code };
  }
}
function configurationHash(configuration) {
  if (typeof configuration === "string" && /^[a-f0-9]{16,64}$/i.test(configuration)) return configuration.toLowerCase();
  return sha256(configuration == null ? "default" : stable(configuration)).slice(0, 24);
}
function readHead(cwd, options = {}) {
  const result = runGit(cwd, ["rev-parse", "--verify", "HEAD"], options);
  return result.ok ? result.stdout.trim() || null : null;
}
async function readHeadAsync(cwd, options = {}) {
  const result = await runGitAsync(cwd, ["rev-parse", "--verify", "HEAD"], options);
  return result.ok ? result.stdout.trim() || null : null;
}
function changeSetFromPorcelain(root, options) {
  return buildChangeSet(root, parsePorcelainV2(options.porcelain, root), options.head ?? null, options.configuration);
}
function changeSetFromStatus(root, status, scope, head, options) {
  if (!status.ok || !scope.ok) return { available: false, root, head, configurationHash: configurationHash(options.configuration), statusFingerprint: sha256("unavailable").slice(0, 24), dirty: false, changes: [], changedPaths: [], error: !status.ok ? status.stderr : scope.stderr };
  let changes = parsePorcelainV2(status.stdout, root);
  const prefix = scope.stdout.replace(/\r?\n$/, "").replace(/\/$/, "");
  if (prefix) {
    // Porcelain paths stay repository-relative even with a subdirectory
    // pathspec. Rebase before hashing so sibling changes and missing double-
    // prefixed paths cannot masquerade as this project's source revision.
    const localPath = file => file?.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : null;
    changes = changes.flatMap(change => {
      if (change.kind === "malformed") return [change];
      const file = localPath(change.path);
      const originalPath = localPath(change.originalPath);
      if (!file && (!originalPath || change.kind === "copied")) return [];
      const kind = !file ? "deleted" : change.originalPath && !originalPath ? "added" : change.kind;
      return [normalizeChange(root, { ...change, kind, path: file || originalPath, originalPath: file ? originalPath : null })];
    });
  }
  return buildChangeSet(root, changes, head, options.configuration);
}
function readChangeSet(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  if (options.porcelain != null) return changeSetFromPorcelain(root, options);
  const status = runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."], options);
  const scope = status.ok ? runGit(root, ["rev-parse", "--show-prefix"], options) : status;
  return changeSetFromStatus(root, status, scope, readHead(root, options), options);
}
async function readChangeSetAsync(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  if (options.porcelain != null) return changeSetFromPorcelain(root, options);
  const status = await runGitAsync(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."], options);
  const scope = status.ok ? await runGitAsync(root, ["rev-parse", "--show-prefix"], options) : status;
  return changeSetFromStatus(root, status, scope, await readHeadAsync(root, options), options);
}
function fileContentIdentity(root, file) {
  if (!file) return null;
  try {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(full)}`;
    if (!stat.isFile()) return stat.isDirectory() ? "directory" : "special";
    return `sha256:${sha256(fs.readFileSync(full))}`;
  } catch { return "missing"; }
}
function buildChangeSet(root, changes, head, configuration) {
  const enriched = changes.map((change) => ({ ...change, contentHash: fileContentIdentity(root, change.path), originalContentHash: fileContentIdentity(root, change.originalPath) }));
  const identity = enriched.map((change) => ({ kind: change.kind, path: change.path, originalPath: change.originalPath, indexStatus: change.indexStatus, worktreeStatus: change.worktreeStatus, score: change.score, contentHash: change.contentHash, originalContentHash: change.originalContentHash }));
  const changedPaths = Array.from(new Set(enriched.flatMap((change) => [change.path, change.originalPath]).filter(Boolean))).sort();
  return {
    available: true,
    root,
    head: head || null,
    configurationHash: configurationHash(configuration),
    statusFingerprint: sha256(identity).slice(0, 24),
    dirty: changes.length > 0,
    changes: enriched,
    changedPaths,
  };
}
function workingTreeRevision(cwd = process.cwd(), options = {}) {
  const changeSet = readChangeSet(cwd, options);
  return {
    available: changeSet.available,
    head: changeSet.head,
    statusFingerprint: changeSet.statusFingerprint,
    configurationHash: changeSet.configurationHash,
    dirty: changeSet.dirty,
  };
}
function revisionId(revision) {
  const value = revision || {};
  return `${value.head || "unborn"}+${value.statusFingerprint || "unknown"}+${value.configurationHash || configurationHash()}`;
}

module.exports = {
  sha256,
  normalizeRepositoryPath,
  sourceKindForPath,
  parsePorcelainV2,
  normalizeChange,
  readChangeSet,
  readChangeSetAsync,
  fileContentIdentity,
  workingTreeRevision,
  revisionId,
  configurationHash,
  runGit,
  runGitAsync,
};
