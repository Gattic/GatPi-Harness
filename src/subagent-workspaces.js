"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_MAX_UNTRACKED_FILES = 200;
const DEFAULT_MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CHANGED_PATHS = 1000;
const FORBIDDEN_PATH_PARTS = new Set([".git", ".pi"]);
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|.*(?:credential|credentials|secret|secrets|token|tokens|password|passwd|private[-_.]?key).*)$/i;

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
function sameIdentity(left, right) { return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino); }
function assertWorkspaceStatePath(file, stat, type) { if (stat.isSymbolicLink() || (type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) throw new Error(`workspace state ${type} is unsafe: ${file}`); }
function assertWorkspaceStateIdentity(file, opened, type) { const current = fs.lstatSync(file); assertWorkspaceStatePath(file, current, type); if (!sameIdentity(opened, current)) throw new Error(`workspace state ${type} changed while open: ${file}`); }
function openWorkspaceState(file, type, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(file); assertWorkspaceStatePath(file, before, type);
  const fd = fs.openSync(file, flags | NO_FOLLOW | (type === "directory" ? DIRECTORY_ONLY : 0));
  try { const opened = fs.fstatSync(fd); assertWorkspaceStatePath(file, opened, type); if (!sameIdentity(before, opened)) throw new Error(`workspace state ${type} changed while opening: ${file}`); assertWorkspaceStateIdentity(file, opened, type); return { fd, opened }; }
  catch (error) { fs.closeSync(fd); throw error; }
}
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const opened = openWorkspaceState(dir, "directory");
  try { fs.fchmodSync(opened.fd, 0o700); assertWorkspaceStateIdentity(dir, opened.opened, "directory"); }
  finally { fs.closeSync(opened.fd); }
  return dir;
}
function writePrivateBuffer(file, content) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600); created = true;
    const opened = fs.fstatSync(fd); assertWorkspaceStatePath(temporary, opened, "file"); assertWorkspaceStateIdentity(temporary, opened, "file"); fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, content); assertWorkspaceStateIdentity(temporary, opened, "file"); fs.closeSync(fd); fd = undefined;
    try { const existing = fs.lstatSync(file); assertWorkspaceStatePath(file, existing, "file"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    fs.renameSync(temporary, file); assertWorkspaceStateIdentity(file, opened, "file");
  } catch (error) { if (created) try { fs.rmSync(temporary, { force: true }); } catch {} throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writePrivateJson(file, value) { writePrivateBuffer(file, `${JSON.stringify(value, null, 2)}\n`); }
function readPrivateFile(file) { const opened = openWorkspaceState(file, "file"); try { const value = fs.readFileSync(opened.fd); assertWorkspaceStateIdentity(file, opened.opened, "file"); return value; } finally { fs.closeSync(opened.fd); } }
function readPrivateJson(file) { return JSON.parse(readPrivateFile(file).toString("utf8")); }
function gitEnv(extra = {}) { return { ...process.env, GIT_AUTHOR_NAME: "Pi Role Runtime", GIT_AUTHOR_EMAIL: "role-runtime@localhost.invalid", GIT_COMMITTER_NAME: "Pi Role Runtime", GIT_COMMITTER_EMAIL: "role-runtime@localhost.invalid", ...extra }; }
function git(root, args, { input, encoding = "utf8", env = {} } = {}) {
  try { return execFileSync("git", args, { cwd: root, input, encoding, maxBuffer: 64 * 1024 * 1024, env: gitEnv(env), stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) {
    const wrapped = new Error(`git ${args.join(" ")} failed: ${String(error?.stderr || error?.message || error).trim()}`);
    wrapped.code = "SUBAGENT_WORKSPACE_GIT_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}
function gitMaybe(root, args, options = {}) { try { return git(root, args, options); } catch { return null; } }
function splitNul(value) { return Buffer.isBuffer(value) ? value.toString("utf8").split("\0").filter(Boolean) : String(value || "").split("\0").filter(Boolean); }
function repositoryRoot(cwd) { const result = gitMaybe(cwd, ["rev-parse", "--show-toplevel"]); return result ? path.resolve(String(result).trim()) : null; }
function safeRelative(relative) {
  const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) return null;
  return normalized;
}
function assertSafeRelative(relative, code = "SUBAGENT_WORKSPACE_PATH_ESCAPE") { const safe = safeRelative(relative); if (!safe) { const error = new Error(`workspace path escapes repository: ${relative}`); error.code = code; throw error; } return safe; }
function pathForbidden(relative) {
  const safe = safeRelative(relative);
  if (!safe) return true;
  const parts = safe.split("/");
  if (parts.some((part) => FORBIDDEN_PATH_PARTS.has(part))) return true;
  return SENSITIVE_BASENAME.test(parts.at(-1));
}
function fileHash(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { type: "missing", hash: null, bytes: 0 }; }
  if (stat.isSymbolicLink()) return { type: "symlink", hash: sha256(`symlink:${fs.readlinkSync(file)}`), bytes: stat.size };
  if (stat.isDirectory()) return { type: "directory", hash: sha256("directory"), bytes: 0 };
  if (!stat.isFile()) return { type: "special", hash: null, bytes: stat.size };
  const content = fs.readFileSync(file);
  return { type: "file", hash: sha256(content), bytes: stat.size };
}
function ensurePiIgnored(root) {
  const infoExclude = path.join(String(git(root, ["rev-parse", "--git-path", "info/exclude"])).trim());
  const file = path.isAbsolute(infoExclude) ? infoExclude : path.join(root, infoExclude);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!/(^|\n)\.pi\/(?:\n|$)/.test(current)) fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# Pi role runtime private state\n.pi/\n`);
}
function repositoryFingerprint(cwd, { maxFiles = 20000 } = {}) {
  const root = repositoryRoot(cwd);
  if (!root) { const error = new Error(`isolated-worktree requires a Git repository: ${cwd}`); error.code = "SUBAGENT_WORKSPACE_GIT_REQUIRED"; throw error; }
  const head = String(git(root, ["rev-parse", "HEAD"])).trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer", env: { GIT_OPTIONAL_LOCKS: "0" } });
  const listed = splitNul(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "buffer" })).sort().slice(0, maxFiles);
  const tracked = new Set(splitNul(git(root, ["ls-files", "-z", "--cached"], { encoding: "buffer" })));
  const digest = crypto.createHash("sha256"), treeDigest = crypto.createHash("sha256");
  for (const relative of listed) {
    const safe = assertSafeRelative(relative);
    const descriptor = fileHash(path.join(root, safe));
    const entry = `${safe}\0${descriptor.type}\0${descriptor.hash || ""}\0${descriptor.bytes}\0`;
    digest.update(entry);
    // The transferable tree excludes absent paths and the untracked entries
    // intentionally omitted by copyAllowedUntracked; it is independent of HEAD/index.
    // Git records owner-executable only; other permission bits vary with umask.
    if (descriptor.type !== "missing" && !pathForbidden(safe) && (tracked.has(safe) || descriptor.type === "file")) treeDigest.update(`${entry}${Boolean(fs.lstatSync(path.join(root, safe)).mode & 0o100)}\0`);
  }
  return { root, head, statusHash: sha256(status), fileHash: digest.digest("hex"), treeHash: treeDigest.digest("hex"), files: listed.length, truncated: listed.length >= maxFiles };
}

function sameFingerprint(left, right) { return ["root", "head", "statusHash", "fileHash", "treeHash"].every(key => left?.[key] === right?.[key]); }

function repositoryStorageEstimate(root) {
  root = fs.realpathSync(root);
  const files = splitNul(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "buffer" }));
  if (files.length > 20000) throw new Error("repository storage inventory exceeds its bound");
  let bytes = 0;
  const directories = new Set(), blockBytes = fs.statfsSync(root).bsize;
  for (const relative of new Set(files)) {
    const file = path.join(root, assertSafeRelative(relative));
    try {
      const stat = fs.lstatSync(file); bytes += Math.max(stat.size, Number(stat.blocks || 0) * 512) + 256;
      for (let directory = path.dirname(file); directory !== root; directory = path.dirname(directory)) directories.add(directory);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const directory of directories) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("repository storage inventory contains an unsafe directory");
    bytes += Math.max(stat.size, Number(stat.blocks || 0) * 512, blockBytes) + 256;
  }
  return { bytes, files: files.length, directories: directories.size };
}

function selectSeedPatches(patches = []) {
  const byHash = new Map();
  for (const patch of patches) {
    if (!patch?.patchHash) throw new Error("upstream workspace patch has no identity");
    const previous = byHash.get(patch.patchHash);
    if (previous && JSON.stringify(previous.changedPaths) !== JSON.stringify(patch.changedPaths)) throw new Error("duplicate patch has inconsistent manifest");
    byHash.set(patch.patchHash, patch);
  }
  const covered = new Set([...byHash.values()].flatMap(patch => patch.includedPatchHashes || []));
  const selected = [...byHash.values()].filter(patch => !covered.has(patch.patchHash));
  if (patches.length && !selected.length) throw new Error("cyclic patch ancestry");
  return selected.sort((a, b) => a.patchHash.localeCompare(b.patchHash));
}

class SubagentWorkspaceManager {
  constructor({ cwd = process.cwd(), rootDir, maxUntrackedFiles = DEFAULT_MAX_UNTRACKED_FILES, maxUntrackedBytes = DEFAULT_MAX_UNTRACKED_BYTES, maxPatchBytes = DEFAULT_MAX_PATCH_BYTES, maxChangedPaths = DEFAULT_MAX_CHANGED_PATHS } = {}) {
    this.cwd = path.resolve(cwd);
    const detectedRoot = repositoryRoot(this.cwd);
    this.rootDir = rootDir ? path.resolve(rootDir) : path.join(detectedRoot || this.cwd, ".pi", "subagents", "workspaces");
    this.maxUntrackedFiles = maxUntrackedFiles;
    this.maxUntrackedBytes = maxUntrackedBytes;
    this.maxPatchBytes = maxPatchBytes;
    this.maxChangedPaths = maxChangedPaths;
  }
  leaseFile(workspaceDir) { return path.join(workspaceDir, "lease.json"); }
  readLease(workspaceDir) { try { return readPrivateJson(this.leaseFile(workspaceDir)); } catch { return null; } }
  readCapture(workspaceDir) {
    if (!workspaceDir || path.dirname(path.resolve(workspaceDir)) !== this.rootDir) throw new Error("capture is outside the owned workspace root");
    return readPrivateJson(path.join(workspaceDir, "capture.json"));
  }
  activeLeases() {
    let names = [];
    try { names = fs.readdirSync(this.rootDir); } catch {}
    return names.map((name) => this.readLease(path.join(this.rootDir, name))).filter((lease) => lease?.state === "active");
  }
  acquire({ subagentId, parentSessionId, task, seedPatches = [], allowParallelWorkspace = false, mergeOrder = null, writeZones = null } = {}) {
    if (!subagentId) throw new Error("workspace lease requires subagentId");
    const root = repositoryRoot(this.cwd);
    if (!root) { const error = new Error("mutating subagents require an isolated Git worktree; non-Git shared-cwd fallback is forbidden"); error.code = "SUBAGENT_WORKSPACE_GIT_REQUIRED"; throw error; }
    ensurePiIgnored(root);
    const parentFingerprint = repositoryFingerprint(root);
    const taskHash = sha256(String(task || ""));
    const conflict = this.activeLeases().find((lease) => lease.parentRoot === root && lease.parentSessionId === parentSessionId && lease.taskHash === taskHash);
    if (conflict && !(allowParallelWorkspace && Number.isInteger(mergeOrder))) { const error = new Error(`mutable workspace lease already active for this parent task: ${conflict.subagentId}`); error.code = "SUBAGENT_WORKSPACE_LEASE_CONFLICT"; throw error; }
    const workspaceDir = path.join(this.rootDir, String(subagentId).replace(/[^A-Za-z0-9_.-]/g, "_"));
    const treeDir = path.join(workspaceDir, "tree");
    if (fs.existsSync(workspaceDir)) { const error = new Error(`workspace already exists: ${workspaceDir}`); error.code = "SUBAGENT_WORKSPACE_EXISTS"; throw error; }
    ensurePrivateDir(workspaceDir);
    git(root, ["worktree", "add", "--detach", "--force", treeDir, parentFingerprint.head]);
    try {
      const parentPatch = git(root, ["diff", "--binary", "--full-index", "HEAD", "--"], { encoding: "buffer" });
      if (parentPatch.length > this.maxPatchBytes) { const error = new Error(`parent workspace seed patch exceeds ${this.maxPatchBytes} bytes`); error.code = "SUBAGENT_WORKSPACE_SEED_LIMIT"; throw error; }
      if (parentPatch.length) git(treeDir, ["apply", "--index", "--binary", "-"], { input: parentPatch, encoding: "buffer" });
      const copiedUntracked = this.copyAllowedUntracked(root, treeDir);
      git(treeDir, ["add", "-A", "--"]);
      const inheritedChangedPaths = splitNul(git(treeDir, ["diff", "--cached", "--no-renames", "--name-only", "-z", parentFingerprint.head, "--"], { encoding: "buffer" }))
        .map((relative) => assertSafeRelative(relative))
        .filter((relative) => !pathForbidden(relative));
      const tree = String(git(treeDir, ["write-tree"])).trim();
      const baselineCommit = String(git(treeDir, ["commit-tree", tree, "-p", parentFingerprint.head, "-m", `Pi role workspace baseline ${subagentId}`])).trim();
      git(treeDir, ["reset", "--hard", "-q", baselineCommit]);
      const canonicalSeeds = seedPatches.map(seed => {
        if (!seed?.patchFile || !fs.existsSync(seed.patchFile)) throw Object.assign(new Error("upstream workspace patch is missing"), { code: "SUBAGENT_WORKSPACE_SEED_PATCH_MISSING" });
        const captured = this.readCapture(path.dirname(seed.patchFile));
        if (captured.patchHash !== seed.patchHash || captured.patchFile !== seed.patchFile) throw Object.assign(new Error("upstream workspace patch identity does not match its runtime capture"), { code: "SUBAGENT_WORKSPACE_SEED_PATCH_HASH" });
        if (captured.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(captured.candidateFileHash || "")) throw Object.assign(new Error("upstream workspace capture requires fresh tree-bound evidence"), { code: "SUBAGENT_WORKSPACE_SEED_PATCH_STALE" });
        return captured;
      });
      const seededPatchHashes = [];
      for (const seed of selectSeedPatches(canonicalSeeds)) {
        if (seed.parentRoot !== root || seed.parentRevision !== parentFingerprint.head || !sameFingerprint(seed.parentStatusFingerprint, parentFingerprint)) { const error = new Error("upstream workspace patch parent fingerprint is stale"); error.code = "SUBAGENT_WORKSPACE_SEED_PATCH_STALE"; throw error; }
        const entries = Array.isArray(seed?.changedPaths) ? seed.changedPaths : [];
        for (const entry of entries) {
          const safe = assertSafeRelative(typeof entry === "string" ? entry : entry?.path);
          if (pathForbidden(safe)) { const error = new Error(`upstream workspace patch contains forbidden path: ${safe}`); error.code = "SUBAGENT_WORKSPACE_FORBIDDEN_PATH"; throw error; }
        }
        if (!seed?.patchFile || !fs.existsSync(seed.patchFile)) { const error = new Error("upstream workspace patch is missing"); error.code = "SUBAGENT_WORKSPACE_SEED_PATCH_MISSING"; throw error; }
        const patch = readPrivateFile(seed.patchFile);
        if (patch.length > this.maxPatchBytes || sha256(patch) !== seed.patchHash) { const error = new Error("upstream workspace patch hash/size is invalid"); error.code = "SUBAGENT_WORKSPACE_SEED_PATCH_INVALID"; throw error; }
        if (patch.length) {
          git(treeDir, ["apply", "--check", "--binary", "-"], { input: patch, encoding: "buffer" });
          git(treeDir, ["apply", "--binary", "-"], { input: patch, encoding: "buffer" });
        }
        seededPatchHashes.push(seed.patchHash);
      }
      const initialPaths = splitNul(git(treeDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "buffer" }));
      const initialHashes = writeZones ? Object.fromEntries(initialPaths.map(relative => [relative, fileHash(path.join(treeDir, relative)).hash])) : null;
      const lease = {
        schemaVersion: 1,
        writeZones,
        initialHashes,
        initialModes: writeZones ? Object.fromEntries(initialPaths.map(relative => {
          // Seed deletions/renames remain in the index, but not in the worktree.
          const stat = fs.lstatSync(path.join(treeDir, relative), { throwIfNoEntry: false });
          return [relative, stat ? stat.mode & 0o111 : null];
        })) : null,
        includedPatchHashes: [...new Set(canonicalSeeds.flatMap(seed => [seed.patchHash, ...(seed.includedPatchHashes || [])]))],
        policy: "isolated-worktree",
        subagentId,
        parentSessionId: parentSessionId || null,
        taskHash,
        parentRoot: root,
        parentRevision: parentFingerprint.head,
        parentStatusFingerprint: parentFingerprint,
        workspaceDir,
        cwd: treeDir,
        baselineCommit,
        copiedUntracked,
        inheritedChangedPaths,
        seededPatchHashes,
        mergeOrder,
        acquiredAt: nowIso(),
        state: "active",
      };
      writePrivateJson(this.leaseFile(workspaceDir), lease);
      return lease;
    } catch (error) {
      try { git(root, ["worktree", "remove", "--force", treeDir]); } catch {}
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      throw error;
    }
  }
  copyAllowedUntracked(parentRoot, treeDir) {
    const paths = splitNul(git(parentRoot, ["ls-files", "-z", "--others", "--exclude-standard"], { encoding: "buffer" })).sort();
    const copied = [];
    let bytes = 0;
    for (const relative of paths) {
      const safe = assertSafeRelative(relative);
      if (pathForbidden(safe)) continue;
      const source = path.join(parentRoot, safe);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (copied.length >= this.maxUntrackedFiles || bytes + stat.size > this.maxUntrackedBytes) { const error = new Error("untracked workspace seed exceeds bounded file/byte limits"); error.code = "SUBAGENT_WORKSPACE_SEED_LIMIT"; throw error; }
      const target = path.join(treeDir, safe);
      ensurePrivateDir(path.dirname(target));
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode & 0o777);
      copied.push({ path: safe, bytes: stat.size, hash: sha256(fs.readFileSync(source)) });
      bytes += stat.size;
    }
    return { files: copied, bytes };
  }
  assessBaselineSatisfaction(leaseInput, claim) {
    const lease = typeof leaseInput === "string" ? this.readLease(leaseInput) : leaseInput;
    if (claim?.disposition !== "baseline-satisfied") return { claimed: false, accepted: false, reasonCode: "not-claimed", changedPaths: [] };
    const reason = String(claim.reason || "").trim();
    const requested = Array.isArray(claim.changedPaths) ? [...new Set(claim.changedPaths)] : [];
    if (reason.length < 32) return { claimed: true, accepted: false, reasonCode: "reason-too-short", changedPaths: [] };
    if (!requested.length || requested.length > this.maxChangedPaths || requested.some((relative) => typeof relative !== "string" || !safeRelative(relative) || pathForbidden(relative))) return { claimed: true, accepted: false, reasonCode: "invalid-changed-paths", changedPaths: [] };
    const inherited = new Set(Array.isArray(lease?.inheritedChangedPaths) ? lease.inheritedChangedPaths : []);
    if (requested.some((relative) => !inherited.has(relative))) return { claimed: true, accepted: false, reasonCode: "path-not-in-inherited-baseline", changedPaths: [] };
    return { claimed: true, accepted: true, reasonCode: "baseline-satisfied", reason, changedPaths: requested };
  }
  capture(leaseInput, { status = "failed", verification = { status: "unchecked", evidence: [] } } = {}) {
    const lease = typeof leaseInput === "string" ? this.readLease(leaseInput) : leaseInput;
    if (!lease?.cwd || !lease?.baselineCommit) throw new Error("invalid workspace lease");
    const indexPath = String(git(lease.cwd, ["rev-parse", "--git-path", "index"])).trim();
    const realIndex = path.isAbsolute(indexPath) ? indexPath : path.join(lease.cwd, indexPath);
    const captureIndex = path.join(lease.workspaceDir, `capture-${Date.now()}.index`);
    writePrivateBuffer(captureIndex, fs.readFileSync(realIndex));
    const env = { GIT_INDEX_FILE: captureIndex };
    git(lease.cwd, ["add", "-A", "--"], { env });
    const patch = git(lease.cwd, ["diff", "--cached", "--binary", "--full-index", lease.baselineCommit, "--"], { encoding: "buffer", env });
    if (patch.length > this.maxPatchBytes) { const error = new Error(`workspace patch exceeds ${this.maxPatchBytes} bytes`); error.code = "SUBAGENT_WORKSPACE_PATCH_LIMIT"; throw error; }
    // Ownership and rollback cover both ends of a rename, not just its destination.
    const names = splitNul(git(lease.cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z", lease.baselineCommit, "--"], { encoding: "buffer", env }));
    if (names.length > this.maxChangedPaths) { const error = new Error(`workspace patch exceeds ${this.maxChangedPaths} changed paths`); error.code = "SUBAGENT_WORKSPACE_PATH_LIMIT"; throw error; }
    const changedPaths = names.map((relative) => {
      const safe = assertSafeRelative(relative);
      if (pathForbidden(safe)) { const error = new Error(`workspace patch contains forbidden path: ${safe}`); error.code = "SUBAGENT_WORKSPACE_FORBIDDEN_PATH"; throw error; }
      const before = gitMaybe(lease.cwd, ["show", `${lease.baselineCommit}:${safe}`], { encoding: "buffer" });
      const target = path.join(lease.cwd, safe);
      const after = fileHash(target);
      if (lease.writeZones && (after.hash !== (lease.initialHashes?.[safe] ?? null) || (after.type !== "missing" && (fs.lstatSync(target).mode & 0o111) !== (lease.initialModes?.[safe] ?? null))) && !lease.writeZones.some(zone => safe === zone || (zone.endsWith("/") && safe.startsWith(zone)))) {
        const error = new Error(`workspace changed a path outside its task ownership: ${safe}`);
        error.code = "SUBAGENT_WORKSPACE_WRITE_ZONE";
        throw error;
      }
      if (after.type === "symlink") {
        const resolvedTarget = path.resolve(path.dirname(target), fs.readlinkSync(target));
        const rel = path.relative(lease.cwd, resolvedTarget);
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) { const error = new Error(`workspace patch symlink escapes repository: ${safe}`); error.code = "SUBAGENT_WORKSPACE_SYMLINK_ESCAPE"; throw error; }
      }
      return { path: safe, beforeHash: before == null ? null : sha256(before), afterHash: after.hash, bytes: after.bytes, type: after.type };
    });
    const patchFile = path.join(lease.workspaceDir, "changes.patch");
    writePrivateBuffer(patchFile, patch);
    try { fs.rmSync(captureIndex, { force: true }); } catch {}
    const candidateFingerprint = repositoryFingerprint(lease.cwd);
    if (candidateFingerprint.truncated) throw Object.assign(new Error("candidate fingerprint is incomplete"), { code: "SUBAGENT_WORKSPACE_FINGERPRINT_INCOMPLETE" });
    const capture = {
      schemaVersion: 2,
      candidateFileHash: candidateFingerprint.treeHash,
      subagentId: lease.subagentId,
      parentRoot: lease.parentRoot,
      parentRevision: lease.parentRevision,
      parentStatusFingerprint: lease.parentStatusFingerprint,
      workspacePath: lease.workspaceDir,
      workspaceCwd: lease.cwd,
      baselineCommit: lease.baselineCommit,
      includedPatchHashes: lease.includedPatchHashes || [],
      status,
      retained: changedPaths.length > 0 || status !== "succeeded",
      patchFile,
      patchHash: sha256(patch),
      patchBytes: patch.length,
      changedPaths,
      untrackedManifest: changedPaths.filter((entry) => entry.beforeHash == null),
      verification,
      capturedAt: nowIso(),
    };
    const updated = { ...lease, state: capture.retained ? "retained" : "captured-clean", capturedAt: capture.capturedAt, patchHash: capture.patchHash, patchBytes: capture.patchBytes, changedPathCount: changedPaths.length };
    writePrivateJson(this.leaseFile(lease.workspaceDir), updated);
    writePrivateJson(path.join(lease.workspaceDir, "capture.json"), capture);
    return capture;
  }
  diagnostics(capture, { retained = capture?.retained } = {}) {
    if (!capture) return { policy: "isolated-worktree", retained: false, path: null, patchHash: null, patchBytes: 0, changedPaths: [] };
    return { policy: "isolated-worktree", retained: Boolean(retained), path: retained ? capture.workspacePath : null, cwd: retained ? capture.workspaceCwd : null, patchFile: retained ? capture.patchFile : null, patchHash: capture.patchHash, patchBytes: capture.patchBytes, changedPaths: capture.changedPaths.map((entry) => entry.path), parentRevision: capture.parentRevision, parentStatusFingerprint: capture.parentStatusFingerprint?.statusHash || null, includedPatchHashes: capture.includedPatchHashes || [], verification: capture.verification };
  }
  release(leaseInput, { remove = false } = {}) {
    const lease = typeof leaseInput === "string" ? this.readLease(leaseInput) : leaseInput;
    if (!lease) return { removed: false };
    if (!remove) { writePrivateJson(this.leaseFile(lease.workspaceDir), { ...lease, state: "retained", retainedAt: nowIso() }); return { removed: false, workspaceDir: lease.workspaceDir }; }
    try { git(lease.parentRoot, ["worktree", "remove", "--force", lease.cwd]); } catch { fs.rmSync(lease.cwd, { recursive: true, force: true }); }
    fs.rmSync(lease.workspaceDir, { recursive: true, force: true });
    try { git(lease.parentRoot, ["worktree", "prune"]); } catch {}
    return { removed: true, workspaceDir: lease.workspaceDir };
  }
}

module.exports = {
  DEFAULT_MAX_UNTRACKED_FILES,
  DEFAULT_MAX_UNTRACKED_BYTES,
  DEFAULT_MAX_PATCH_BYTES,
  DEFAULT_MAX_CHANGED_PATHS,
  sha256,
  safeRelative,
  assertSafeRelative,
  pathForbidden,
  repositoryRoot,
  repositoryFingerprint,
  repositoryStorageEstimate,
  sameFingerprint,
  SubagentWorkspaceManager,
  selectSeedPatches,
};
