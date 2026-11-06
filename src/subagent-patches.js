"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { repositoryRoot, repositoryFingerprint, sameFingerprint, assertSafeRelative, pathForbidden } = require("./subagent-workspaces");
const { acquireManagedWorker } = require("./resource-guard");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
function sameIdentity(left, right) { return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino); }
function assertPatchStatePath(file, stat, type) { if (stat.isSymbolicLink() || (type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) throw new Error(`subagent patch state ${type} is unsafe: ${file}`); }
function assertPatchStateIdentity(file, opened, type) { const current = fs.lstatSync(file); assertPatchStatePath(file, current, type); if (!sameIdentity(opened, current)) throw new Error(`subagent patch state ${type} changed while open: ${file}`); }
function openPatchState(file, type, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(file); assertPatchStatePath(file, before, type);
  const fd = fs.openSync(file, flags | NO_FOLLOW | (type === "directory" ? DIRECTORY_ONLY : 0));
  try { const opened = fs.fstatSync(fd); assertPatchStatePath(file, opened, type); if (!sameIdentity(before, opened)) throw new Error(`subagent patch state ${type} changed while opening: ${file}`); assertPatchStateIdentity(file, opened, type); return { fd, opened }; }
  catch (error) { fs.closeSync(fd); throw error; }
}
function ensurePrivateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const opened = openPatchState(dir, "directory"); try { fs.fchmodSync(opened.fd, 0o700); assertPatchStateIdentity(dir, opened.opened, "directory"); } finally { fs.closeSync(opened.fd); } }
function writePrivateJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd; let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600); created = true;
    const opened = fs.fstatSync(fd); assertPatchStatePath(temporary, opened, "file"); assertPatchStateIdentity(temporary, opened, "file"); fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); assertPatchStateIdentity(temporary, opened, "file"); fs.closeSync(fd); fd = undefined;
    try { const existing = fs.lstatSync(file); assertPatchStatePath(file, existing, "file"); } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
    fs.renameSync(temporary, file); assertPatchStateIdentity(file, opened, "file");
  } catch (cause) { if (created) try { fs.rmSync(temporary, { force: true }); } catch {} throw cause; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readPrivateFile(file) { const opened = openPatchState(file, "file"); try { const value = fs.readFileSync(opened.fd); assertPatchStateIdentity(file, opened.opened, "file"); return { value, stat: opened.opened }; } finally { fs.closeSync(opened.fd); } }
function error(code, message, details) { const value = new Error(message); value.code = code; if (details) value.details = details; return value; }
function git(root, args, { input } = {}) {
  try { return execFileSync("git", args, { cwd: root, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch (cause) { throw error("SUBAGENT_PATCH_CONFLICT", `git ${args.join(" ")} failed: ${String(cause?.stderr || cause?.message || cause).trim()}`); }
}
function backupPath(root, relative, maxBytes) {
  const file = path.join(root, relative), parents = [];
  let directory = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    directory = path.join(directory, part);
    let stat;
    try { stat = fs.lstatSync(directory); } catch (cause) { if (cause.code === "ENOENT") return { relative, exists: false, parents }; throw cause; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("SUBAGENT_PATCH_UNSAFE_PARENT", "patch parent path is no longer a real directory");
    parents.push({ relative: path.relative(root, directory), dev: stat.dev, ino: stat.ino });
  }
  let stat;
  try { stat = fs.lstatSync(file); } catch (cause) { if (cause.code === "ENOENT") return { relative, exists: false, parents }; throw cause; }
  const entry = { relative, exists: true, parents, identity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }, mode: stat.mode & 0o777 };
  if (stat.isSymbolicLink()) return { ...entry, type: "symlink", target: fs.readlinkSync(file) };
  if (!stat.isFile()) throw error("SUBAGENT_PATCH_UNSUPPORTED_PATH", "patch target is not a regular file or symlink");
  if (stat.size > maxBytes) throw error("SUBAGENT_PATCH_RECOVERY_BUDGET", "patch backup exceeds the approved recovery budget");
  const opened = readPrivateFile(file), after = fs.lstatSync(file);
  if (!sameIdentity(stat, opened.stat) || !sameIdentity(stat, after) || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw error("SUBAGENT_PATCH_SNAPSHOT_CHANGED", "patch target changed during backup");
  return { ...entry, type: "file", content: opened.value };
}
function snapshotDigest(entry) { return sha256(JSON.stringify({ ...entry, content: entry.content ? sha256(entry.content) : null })); }
function indexDigest(root) { const file = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"])); return sha256(readPrivateFile(file).value); }
function restoreBackups(root, backups) {
  const cleanupDirs = new Set();
  for (const backup of backups.slice().reverse()) {
    const target = path.join(root, backup.relative);
    fs.rmSync(target, { recursive: true, force: true });
    if (!backup.exists) { cleanupDirs.add(path.dirname(target)); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (backup.type === "file") { fs.writeFileSync(target, backup.content); fs.chmodSync(target, backup.mode); }
    else if (backup.type === "symlink") fs.symlinkSync(backup.target, target);
    else if (backup.type === "directory") fs.mkdirSync(target, { recursive: true, mode: backup.mode });
  }
  for (const start of [...cleanupDirs].sort((a, b) => b.length - a.length)) {
    let dir = start;
    while (dir !== root && dir.startsWith(`${root}${path.sep}`)) {
      try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }
}

class SubagentPatchService {
  constructor({ cwd = process.cwd(), dir, maxPatchBytes = 16 * 1024 * 1024 } = {}) {
    this.cwd = path.resolve(cwd);
    this.root = repositoryRoot(this.cwd);
    if (!this.root) throw error("SUBAGENT_PATCH_GIT_REQUIRED", "subagent patch transfer requires a Git repository");
    this.dir = dir ? path.resolve(dir) : path.join(this.root, ".pi", "subagents", "patches");
    this.maxPatchBytes = maxPatchBytes;
  }
  validateCapture(capture = {}) {
    const changedPaths = Array.isArray(capture.changedPaths) ? capture.changedPaths : [];
    for (const entry of changedPaths) {
      const safe = assertSafeRelative(typeof entry === "string" ? entry : entry?.path, "SUBAGENT_PATCH_PATH_ESCAPE");
      if (pathForbidden(safe)) throw error("SUBAGENT_PATCH_FORBIDDEN_PATH", `subagent patch contains forbidden path: ${safe}`);
    }
    if (path.resolve(capture.parentRoot || "") !== this.root) throw error("SUBAGENT_PATCH_WRONG_PARENT", "subagent patch belongs to a different parent repository");
    if (!capture.patchFile) throw error("SUBAGENT_PATCH_MISSING", "subagent patch file is missing");
    let openedPatch;
    try { openedPatch = readPrivateFile(capture.patchFile); }
    catch (cause) { throw error("SUBAGENT_PATCH_MISSING", `subagent patch file is missing or unsafe: ${cause?.message || cause}`); }
    const stat = openedPatch.stat;
    if (stat.size > this.maxPatchBytes) throw error("SUBAGENT_PATCH_SIZE_MISMATCH", "subagent patch size is invalid or exceeds the configured limit");
    const patch = openedPatch.value;
    if (sha256(patch) !== capture.patchHash) throw error("SUBAGENT_PATCH_HASH_MISMATCH", "subagent patch hash does not match captured metadata");
    if (stat.size !== Number(capture.patchBytes)) throw error("SUBAGENT_PATCH_SIZE_MISMATCH", "subagent patch size does not match captured metadata");
    const current = repositoryFingerprint(this.root);
    if (current.head !== capture.parentRevision || !sameFingerprint(current, capture.parentStatusFingerprint)) throw error("SUBAGENT_PATCH_STALE_PARENT", "parent repository changed since the role workspace was acquired", { expected: capture.parentStatusFingerprint, actual: current });
    if (capture.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(capture.candidateFileHash || "")) throw error("SUBAGENT_PATCH_CANDIDATE_UNBOUND", "capture lacks an exact transferable-tree fingerprint; create a fresh proposal");
    if (current.truncated) throw error("SUBAGENT_PATCH_FINGERPRINT_INCOMPLETE", "parent fingerprint is incomplete");
    return { patch, current, changedPaths: changedPaths.map((entry) => typeof entry === "string" ? entry : entry.path) };
  }
  preview(capture) {
    const validated = this.validateCapture(capture);
    if (validated.patch.length) git(this.root, ["apply", "--check", "--binary", "-"], { input: validated.patch });
    const id = `subpatch_${sha256(`${capture.subagentId}:${capture.patchHash}:${JSON.stringify(capture.parentStatusFingerprint)}`).slice(0, 16)}`;
    const preview = {
      schemaVersion: 2,
      candidateFileHash: capture.candidateFileHash,
      id,
      status: "ready",
      explicitApplyRequired: true,
      subagentId: capture.subagentId,
      parentRoot: this.root,
      parentRevision: capture.parentRevision,
      parentStatusFingerprint: capture.parentStatusFingerprint,
      patchFile: capture.patchFile,
      patchHash: capture.patchHash,
      patchBytes: capture.patchBytes,
      changedPaths: validated.changedPaths,
      changedPathHashes: capture.changedPaths,
      workspacePath: capture.workspacePath,
      verification: capture.verification || { status: "unchecked", evidence: [] },
      createdAt: nowIso(),
    };
    writePrivateJson(path.join(this.dir, `${id}.json`), preview);
    return preview;
  }
  validatePreview(preview) {
    if (!preview || preview.status !== "ready" || !preview.explicitApplyRequired) throw error("SUBAGENT_PATCH_PREVIEW_REQUIRED", "a ready hash-checked patch preview is required");
    const capture = {
      schemaVersion: preview.schemaVersion,
      candidateFileHash: preview.candidateFileHash,
      subagentId: preview.subagentId,
      parentRoot: preview.parentRoot,
      parentRevision: preview.parentRevision,
      parentStatusFingerprint: preview.parentStatusFingerprint,
      patchFile: preview.patchFile,
      patchHash: preview.patchHash,
      patchBytes: preview.patchBytes,
      changedPaths: preview.changedPathHashes || preview.changedPaths.map((relative) => ({ path: relative })),
    };
    return this.validateCapture(capture);
  }
  async apply(preview, { explicit = false, verify, maxRecoveryBytes = this.maxPatchBytes * 2 } = {}) {
    if (!explicit) throw error("SUBAGENT_PATCH_EXPLICIT_APPLY_REQUIRED", "applying a role patch requires an explicit parent action");
    if (!Number.isSafeInteger(maxRecoveryBytes) || maxRecoveryBytes < 1) throw error("SUBAGENT_PATCH_RECOVERY_BUDGET", "a positive recovery byte budget is required");
    const lease = await acquireManagedWorker({ root: path.join(this.root, ".pi", "subagents", "apply-lock"), limit: 1 });
    try {
      const validated = this.validatePreview(preview), indexBefore = indexDigest(this.root);
      // The recovery budget bounds durable recovery data: backups of paths that
      // already exist plus the journal. It must not bound the post-apply
      // snapshot, which only re-reads what this patch just wrote. An add-only
      // patch has nothing to back up, so its budget can be far below the size
      // of the file it creates; sizing the snapshot from the captured path
      // bytes keeps a large asset patch applicable without inflating the
      // reserved recovery storage.
      const appliedBytes = (Array.isArray(preview.changedPathHashes) ? preview.changedPathHashes : [])
        .reduce((max, entry) => Math.max(max, Number(entry?.bytes) || 0), 0) || Number(preview.patchBytes) || 0;
      const snapshotLimit = Math.max(maxRecoveryBytes, appliedBytes) + 131072;
      let backupBytes = 0;
      const backups = validated.changedPaths.map(relative => { const entry = backupPath(this.root, relative, maxRecoveryBytes - backupBytes); backupBytes += entry.content?.length || 0; return entry; });
      const journal = { schemaVersion: 1, previewId: preview.id, patchHash: preview.patchHash, status: "prepared", conflicts: [], error: null, backups: backups.map(({ content, ...entry }) => ({ ...entry, ...(content ? { contentBase64: content.toString("base64") } : {}) })) };
      const journalBytes = Buffer.byteLength(JSON.stringify({ ...journal, status: "reconciliation-required", conflicts: validated.changedPaths, error: "x".repeat(120) }, null, 2)) + 1;
      if (journalBytes > maxRecoveryBytes) throw error("SUBAGENT_PATCH_RECOVERY_BUDGET", "durable recovery data exceeds the approved budget");
      ensurePrivateDir(this.dir);
      const retained = fs.readdirSync(this.dir).filter(name => /^subpatch_[a-f0-9]{16}\.transaction-[a-f0-9]{16}\.json$/.test(name));
      const retainedBytes = retained.reduce((bytes, name) => { const stat = fs.lstatSync(path.join(this.dir, name)); assertPatchStatePath(name, stat, "file"); return bytes + stat.size; }, 0);
      if (retained.length >= 20 || retainedBytes + journalBytes > 64 * 1024 * 1024) throw error("SUBAGENT_PATCH_RECOVERY_RETENTION", "recovery retention limit reached; an explicit retention decision is required");
      const journalFile = path.join(this.dir, `${preview.id}.transaction-${crypto.randomBytes(8).toString("hex")}.json`), recoveryFile = path.relative(this.root, journalFile);
      writePrivateJson(journalFile, journal);
      let appliedSnapshots;
      try {
        if (!sameFingerprint(repositoryFingerprint(this.root), validated.current) || indexDigest(this.root) !== indexBefore) throw error("SUBAGENT_PATCH_STALE_PARENT", "parent changed while preparing application");
        if (validated.patch.length) git(this.root, ["apply", "--binary", "-"], { input: validated.patch });
        appliedSnapshots = validated.changedPaths.map(relative => snapshotDigest(backupPath(this.root, relative, snapshotLimit)));
        const candidate = repositoryFingerprint(this.root);
        if (candidate.truncated || candidate.treeHash !== preview.candidateFileHash || candidate.head !== validated.current.head || indexDigest(this.root) !== indexBefore) throw error("SUBAGENT_PATCH_CANDIDATE_CHANGED", "applied tree does not match the captured candidate");
        const verification = typeof verify === "function" ? await verify({ cwd: this.root, changedPaths: validated.changedPaths, preview }) : { status: "unchecked", evidence: [] };
        if (!verification || verification.status !== "passed") throw error("SUBAGENT_PATCH_VERIFICATION_FAILED", "applied subagent patch did not pass required verification", verification);
        if (!sameFingerprint(repositoryFingerprint(this.root), candidate) || indexDigest(this.root) !== indexBefore) throw error("SUBAGENT_PATCH_CANDIDATE_CHANGED", "parent changed during application verification");
        const result = { applied: true, appliedAt: nowIso(), previewId: preview.id, patchHash: preview.patchHash, changedPaths: validated.changedPaths, verification, recoveryFile };
        writePrivateJson(journalFile, { ...journal, status: "applied" });
        writePrivateJson(path.join(this.dir, `${preview.id}.applied.json`), result);
        return result;
      } catch (failure) {
        const conflicts = [], globalDrift = repositoryFingerprint(this.root).head !== validated.current.head || indexDigest(this.root) !== indexBefore;
        for (let index = 0; index < backups.length; index++) {
          const backup = backups[index];
          try {
            const current = snapshotDigest(backupPath(this.root, backup.relative, snapshotLimit));
            if (!globalDrift && appliedSnapshots && current === appliedSnapshots[index]) restoreBackups(this.root, [backup]);
            else if (globalDrift || current !== snapshotDigest(backup)) conflicts.push(backup.relative);
          } catch { conflicts.push(backup.relative); }
        }
        writePrivateJson(journalFile, { ...journal, status: conflicts.length ? "reconciliation-required" : "rolled-back", conflicts, error: /^[A-Z][A-Z0-9_]{0,79}$/.test(failure.code || "") ? failure.code : "APPLICATION_FAILED" });
        if (conflicts.length) throw error("SUBAGENT_PATCH_ROLLBACK_CONFLICT", "concurrent or ambiguous parent changes were preserved; reconcile using the retained recovery record", { conflicts, recoveryFile, cause: failure.code || "APPLICATION_FAILED" });
        failure.details = { ...(failure.details || {}), recoveryFile };
        throw failure;
      }
    } finally { await lease.release(); }
  }
}

module.exports = { SubagentPatchService, sameFingerprint, restoreBackups };
