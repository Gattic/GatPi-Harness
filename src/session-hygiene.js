"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SCAN_BYTES_PER_FILE = 2 * 1024 * 1024;
const SESSION_PERMISSION_MIGRATION_VERSION = 2;
const PERMISSION_PREVIEW_SCHEMA_VERSION = 1;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

function defaultAgentDir(env = process.env) { return path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")); }
function defaultSessionRoot(agentDir = defaultAgentDir()) { return path.join(path.resolve(agentDir), "sessions"); }
function defaultArchiveRoot(agentDir = defaultAgentDir()) { return path.join(path.resolve(agentDir), "session-archive"); }
function defaultMigrationMarker(agentDir = defaultAgentDir()) { return path.join(path.resolve(agentDir), `session-permissions-v${SESSION_PERMISSION_MIGRATION_VERSION}.json`); }
function defaultPermissionPreview(agentDir = defaultAgentDir()) { return path.join(path.resolve(agentDir), `session-permissions-v${SESSION_PERMISSION_MIGRATION_VERSION}-preview.json`); }
function modeOf(target) { try { return fs.lstatSync(target).mode & 0o777; } catch { return null; } }
function modeLabel(mode) { return `0${Number(mode || 0).toString(8).padStart(3, "0")}`; }
function increment(target, key) { target[key] = (target[key] || 0) + 1; }
function safeErrorCode(error) { const code = String(error?.code || "unknown"); return /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown"; }
function identityOf(stat) { return { dev: Number(stat.dev), ino: Number(stat.ino), type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "special" }; }
function sameIdentity(left, right) { return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino); }
function assertPathType(target, stat, type) {
  if (stat.isSymbolicLink() || (type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) throw new Error(`${target} is not a real ${type}`);
}
function assertPathStillOpen(target, opened, type) {
  const current = fs.lstatSync(target);
  assertPathType(target, current, type);
  if (!sameIdentity(identityOf(opened), identityOf(current))) throw new Error(`${target} changed while open`);
}
function openValidatedPath(target, type, expectedIdentity, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(target);
  assertPathType(target, before, type);
  if (expectedIdentity && !sameIdentity(expectedIdentity, identityOf(before))) throw new Error("path identity changed since preview");
  const fd = fs.openSync(target, flags | NO_FOLLOW | (type === "directory" ? DIRECTORY_ONLY : 0));
  try {
    const opened = fs.fstatSync(fd);
    assertPathType(target, opened, type);
    if (!sameIdentity(identityOf(before), identityOf(opened)) || (expectedIdentity && !sameIdentity(expectedIdentity, identityOf(opened)))) throw new Error("path identity changed since preview");
    assertPathStillOpen(target, opened, type);
    return { fd, opened };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function writePrivateFileExclusive(file, content) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    assertPathType(file, opened, "file");
    assertPathStillOpen(file, opened, "file");
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
    assertPathStillOpen(file, opened, "file");
  } finally { fs.closeSync(fd); }
}
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { fd, opened } = openValidatedPath(dir, "directory");
  try { fs.fchmodSync(fd, 0o700); assertPathStillOpen(dir, opened, "directory"); }
  finally { fs.closeSync(fd); }
}
function writePrivateFileAtomic(file, content) {
  ensurePrivateDir(path.dirname(file));
  try { const current = fs.lstatSync(file); if (current.isSymbolicLink() || !current.isFile()) throw new Error("permission preview target is unsafe"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writePrivateFileExclusive(tmp, content);
    fs.renameSync(tmp, file);
    const { fd, opened } = openValidatedPath(file, "file");
    try { fs.fchmodSync(fd, 0o600); assertPathStillOpen(file, opened, "file"); }
    finally { fs.closeSync(fd); }
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function inside(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."); }

function listSessionFiles(root, maxFiles = 10000, maxEntries = Math.max(1000, maxFiles * 4)) {
  const files = [];
  const directories = [];
  const unsafeEntries = [];
  const fileLimit = Math.max(1, Number(maxFiles || 10000));
  const entryLimit = Math.max(1, Number(maxEntries || fileLimit * 4));
  const scanErrors = [];
  let entriesScanned = 0;
  let truncated = false;
  const visit = (dir) => {
    if (truncated) return;
    let dirStat;
    try { dirStat = fs.lstatSync(dir); } catch (error) { scanErrors.push({ operation: "lstat-directory", code: safeErrorCode(error) }); return; }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) { unsafeEntries.push({ path: dir, type: identityOf(dirStat).type }); return; }
    directories.push(dir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { scanErrors.push({ operation: "read-directory", code: safeErrorCode(error) }); return; }
    for (const entry of entries) {
      if (files.length >= fileLimit || entriesScanned >= entryLimit) { truncated = true; break; }
      entriesScanned += 1;
      const target = path.join(dir, entry.name);
      let targetStat;
      try { targetStat = fs.lstatSync(target); } catch (error) { scanErrors.push({ operation: "lstat-entry", code: safeErrorCode(error) }); continue; }
      if (targetStat.isSymbolicLink()) unsafeEntries.push({ path: target, type: "symlink" });
      else if (targetStat.isDirectory()) visit(target);
      else if (targetStat.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
      else if (!targetStat.isFile()) unsafeEntries.push({ path: target, type: identityOf(targetStat).type });
      if (truncated) break;
    }
  };
  visit(path.resolve(root));
  return { files, directories, unsafeEntries, scanErrors, entriesScanned, truncated };
}

function summarizeSessionFile(file, options = {}) {
  const summary = { valid: true, header: null, entries: 0, users: 0, assistants: 0, toolResults: 0, compactions: 0, customMessages: 0, bytesRead: 0, truncated: false };
  let text;
  try {
    const { fd, opened } = openValidatedPath(file, "file");
    try {
      const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_SCAN_BYTES_PER_FILE));
      const bytesToRead = Math.min(opened.size, maxBytes);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      summary.bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
      assertPathStillOpen(file, opened, "file");
      summary.truncated = opened.size > summary.bytesRead;
      text = buffer.subarray(0, summary.bytesRead).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch (error) { return { ...summary, valid: false, error: error?.message || String(error) }; }
  const rows = text.split(/\n/);
  if (summary.truncated && !text.endsWith("\n")) rows.pop();
  for (const raw of rows) {
    if (!raw.trim()) continue;
    let row;
    try { row = JSON.parse(raw); }
    catch { summary.valid = false; continue; }
    if (row.type === "session" && !summary.header) { summary.header = row; continue; }
    summary.entries += 1;
    if (row.type === "compaction") summary.compactions += 1;
    if (row.type === "custom_message") summary.customMessages += 1;
    if (row.type !== "message" || !row.message) continue;
    if (row.message.role === "user") summary.users += 1;
    else if (row.message.role === "assistant") summary.assistants += 1;
    else if (row.message.role === "toolResult") summary.toolResults += 1;
  }
  return summary;
}

function isTemporarySession(file, summary, tempRoot = os.tmpdir()) {
  const cwd = summary?.header?.cwd;
  if (cwd && inside(tempRoot, cwd)) return true;
  return path.basename(path.dirname(file)).startsWith("--tmp-");
}

function isOneShotSession(summary, bytes, maxBytes = 10240) {
  return summary.valid && !summary.truncated && bytes <= maxBytes && summary.users === 1 && summary.assistants <= 1 && summary.toolResults === 0 && summary.compactions === 0;
}

function readMigrationMarker(file) {
  try {
    const { fd, opened } = openValidatedPath(file, "file");
    try {
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      assertPathStillOpen(file, opened, "file");
      return { applied: value?.version === SESSION_PERMISSION_MIGRATION_VERSION && value?.completed === true, value };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error?.code === "ENOENT") return { applied: false };
    return { applied: false, error: error?.message || String(error) };
  }
}
function permissionManifestFor(plan) {
  const rootHash = crypto.createHash("sha256").update(String(plan.root || "")).digest("hex").slice(0, 16);
  const entries = (plan.permissionChanges || []).map((item) => ({
    entryHash: crypto.createHash("sha256").update(path.relative(plan.root, item.path)).digest("hex").slice(0, 16),
    type: item.type,
    fromMode: item.fromMode,
    toMode: item.toMode,
    identity: item.identity,
  })).sort((a, b) => a.entryHash.localeCompare(b.entryHash));
  const descriptor = {
    schemaVersion: PERMISSION_PREVIEW_SCHEMA_VERSION,
    migrationVersion: SESSION_PERMISSION_MIGRATION_VERSION,
    rootHash,
    entries,
    modeCounts: plan.summary?.modeCounts || { files: {}, directories: {} },
    filesScanned: plan.summary?.filesScanned || 0,
    directoriesScanned: plan.summary?.directoriesScanned || 0,
    activeFilesExcluded: plan.summary?.activeFilesExcluded || 0,
    unsafeEntries: plan.summary?.unsafeEntries || 0,
    scanErrors: plan.summary?.scanErrors || 0,
    truncated: plan.summary?.truncated === true,
  };
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  return { ...descriptor, fingerprint, permissionChanges: entries.length };
}
function writePermissionPreview(plan, file = plan.migration?.previewPath) {
  if (!file) throw new Error("permission preview path is required");
  const manifest = plan.permissionManifest || permissionManifestFor(plan);
  const value = { ...manifest, generatedAt: plan.generatedAt, containsPaths: false, containsSessionIds: false, explicitApplyRequired: true };
  writePrivateFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
function readPermissionPreview(file) {
  try {
    const { fd, opened } = openValidatedPath(file, "file");
    try {
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      assertPathStillOpen(file, opened, "file");
      return value;
    } finally { fs.closeSync(fd); }
  } catch (error) { return { error: error?.code === "ENOENT" ? "missing-preview" : safeErrorCode(error) }; }
}
function sessionPermissionPosture(options = {}) {
  const root = path.resolve(options.root || defaultSessionRoot(options.agentDir));
  const listed = listSessionFiles(root, options.maxFiles || 10000, options.maxEntries);
  const modeCounts = { files: {}, directories: {} };
  let nonPrivateFiles = 0;
  let nonPrivateDirectories = 0;
  for (const dir of listed.directories) {
    const mode = modeOf(dir);
    if (mode === null) continue;
    increment(modeCounts.directories, modeLabel(mode));
    if (mode !== 0o700) nonPrivateDirectories += 1;
  }
  for (const file of listed.files) {
    const mode = modeOf(file);
    if (mode === null) continue;
    increment(modeCounts.files, modeLabel(mode));
    if (mode !== 0o600) nonPrivateFiles += 1;
  }
  return {
    schemaVersion: 1,
    scope: "raw-session-permissions",
    available: fs.existsSync(root),
    rootHash: crypto.createHash("sha256").update(root).digest("hex").slice(0, 16),
    files: listed.files.length,
    directories: listed.directories.length,
    nonPrivateFiles,
    nonPrivateDirectories,
    unsafeEntries: listed.unsafeEntries.length,
    scanErrors: listed.scanErrors.length,
    modeCounts,
    truncated: listed.truncated,
    compliant: !listed.truncated && !listed.scanErrors.length && !listed.unsafeEntries.length && nonPrivateFiles === 0 && nonPrivateDirectories === 0,
  };
}

function planSessionHygiene(options = {}) {
  const root = path.resolve(options.root || defaultSessionRoot(options.agentDir));
  const archiveRoot = path.resolve(options.archiveRoot || defaultArchiveRoot(options.agentDir));
  const migrationMarker = path.resolve(options.migrationMarker || (options.root ? path.join(path.dirname(root), `session-permissions-v${SESSION_PERMISSION_MIGRATION_VERSION}.json`) : defaultMigrationMarker(options.agentDir)));
  const previewPath = path.resolve(options.previewPath || (options.root ? path.join(path.dirname(root), `session-permissions-v${SESSION_PERMISSION_MIGRATION_VERSION}-preview.json`) : defaultPermissionPreview(options.agentDir)));
  const migrationState = readMigrationMarker(migrationMarker);
  const now = Number(options.now || Date.now());
  const olderThanMs = Math.max(0, Number(options.olderThanMs ?? 7 * DAY_MS));
  const includeTemporary = options.includeTemporary !== false;
  const projectCwd = options.projectCwd ? path.resolve(options.projectCwd) : null;
  const includeOneShot = options.includeOneShot === true;
  if (includeOneShot && !projectCwd) throw new Error("one-shot session selection requires an explicit projectCwd");
  if (inside(root, archiveRoot)) throw new Error("archiveRoot must be outside the active session root");
  const activeSessionFile = options.activeSessionFile ? path.resolve(options.activeSessionFile) : null;
  const maxFiles = Math.max(1, Number(options.maxFiles || 10000));
  const maxEntries = Math.max(1, Number(options.maxEntries || maxFiles * 4));
  const maxScanBytesPerFile = Math.max(1, Number(options.maxScanBytesPerFile || DEFAULT_MAX_SCAN_BYTES_PER_FILE));
  const listed = listSessionFiles(root, maxFiles, maxEntries);
  const permissionChanges = [];
  const archiveCandidates = [];
  const modeCounts = { files: {}, directories: {} };
  let totalBytes = 0;
  let activeFilesExcluded = 0;
  for (const dir of listed.directories) {
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    const currentMode = stat.mode & 0o777;
    increment(modeCounts.directories, modeLabel(currentMode));
    if (!migrationState.applied && currentMode !== 0o700) permissionChanges.push({ path: dir, type: "directory", fromMode: currentMode, toMode: 0o700, identity: identityOf(stat) });
  }
  for (const file of listed.files) {
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const currentMode = stat.mode & 0o777;
    increment(modeCounts.files, modeLabel(currentMode));
    totalBytes += stat.size;
    const isActive = activeSessionFile && path.resolve(file) === activeSessionFile;
    if (isActive) activeFilesExcluded += 1;
    else if (!migrationState.applied && currentMode !== 0o600) permissionChanges.push({ path: file, type: "file", fromMode: currentMode, toMode: 0o600, identity: identityOf(stat) });
    if (isActive) continue;
    if (olderThanMs && now - stat.mtimeMs < olderThanMs) continue;
    const summary = summarizeSessionFile(file, { maxBytes: maxScanBytesPerFile });
    if (!summary.valid || !summary.header) continue;
    const temporary = includeTemporary && isTemporarySession(file, summary, options.tempRoot || os.tmpdir());
    const projectMatches = projectCwd && path.resolve(summary.header.cwd || "") === projectCwd;
    const oneShot = includeOneShot && projectMatches && isOneShotSession(summary, stat.size, Number(options.maxOneShotBytes || 10240));
    if (!temporary && !oneShot) continue;
    archiveCandidates.push({ path: file, relativePath: path.relative(root, file), reason: temporary ? "temporary-cwd" : "one-shot", bytes: stat.size, modifiedAt: stat.mtime.toISOString(), modifiedMs: stat.mtimeMs, identity: identityOf(stat), sessionId: summary.header.id || null, cwdHash: crypto.createHash("sha256").update(String(summary.header.cwd || "")).digest("hex").slice(0, 16), counts: { entries: summary.entries, users: summary.users, assistants: summary.assistants, toolResults: summary.toolResults }, scanTruncated: summary.truncated });
  }
  const plan = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    root,
    archiveRoot,
    migration: { version: SESSION_PERMISSION_MIGRATION_VERSION, markerPath: migrationMarker, previewPath, alreadyApplied: migrationState.applied, markerError: migrationState.error || null, dryRunFirst: true, explicitApplyRequired: true },
    policy: { olderThanMs, includeTemporary, includeOneShot, projectCwd, maxOneShotBytes: Number(options.maxOneShotBytes || 10240), maxFiles, maxEntries, maxScanBytesPerFile },
    permissionChanges,
    archiveCandidates,
    scanErrors: listed.scanErrors,
    summary: { filesScanned: listed.files.length, directoriesScanned: listed.directories.length, entriesScanned: listed.entriesScanned, totalBytes, permissionChanges: permissionChanges.length, archiveCandidates: archiveCandidates.length, archiveBytes: archiveCandidates.reduce((sum, row) => sum + row.bytes, 0), activeFilesExcluded, unsafeEntries: listed.unsafeEntries.length, scanErrors: listed.scanErrors.length, modeCounts, truncated: listed.truncated },
  };
  plan.permissionManifest = permissionManifestFor(plan);
  return plan;
}

function hardenPlannedPath(item) {
  const { fd, opened } = openValidatedPath(item.path, item.type, item.identity);
  try { fs.fchmodSync(fd, item.toMode); assertPathStillOpen(item.path, opened, item.type); }
  finally { fs.closeSync(fd); }
}

function applySessionPermissions(plan, options = {}) {
  const dryRun = options.dryRun !== false;
  const changed = [];
  const changedByType = { file: 0, directory: 0 };
  const errors = [];
  const previewPath = options.previewPath || plan.migration?.previewPath;
  const entryId = (item) => `session-entry-${crypto.createHash("sha256").update(path.relative(plan.root, item.path)).digest("hex").slice(0, 12)}`;
  if (dryRun) {
    const writePreview = options.writePreview === true;
    let preview = null;
    if (writePreview) {
      try { preview = writePermissionPreview(plan, previewPath); }
      catch (error) { errors.push({ code: "preview-write-failed", errorCode: safeErrorCode(error) }); }
    }
    for (const item of plan.permissionChanges || []) changedByType[item.type] += 1;
    return { dryRun, changed, changedCount: (plan.permissionChanges || []).length, changedByType, errors, migrationCompleted: Boolean(plan.migration?.alreadyApplied), preview: { schemaVersion: PERMISSION_PREVIEW_SCHEMA_VERSION, fingerprint: plan.permissionManifest?.fingerprint || null, permissionChanges: plan.permissionManifest?.permissionChanges || 0, generatedAt: plan.generatedAt, persisted: Boolean(preview) } };
  }
  if (plan.summary?.truncated || plan.summary?.scanErrors || plan.summary?.unsafeEntries) {
    return { dryRun, changed, changedCount: 0, changedByType, errors: [{ code: "unsafe-or-incomplete-plan", error: "refusing apply from a truncated plan or one containing scan errors/unsafe entries" }], migrationCompleted: false, preview: null };
  }
  if (options.requirePreview !== false) {
    const preview = readPermissionPreview(previewPath);
    if (preview?.error || preview?.schemaVersion !== PERMISSION_PREVIEW_SCHEMA_VERSION || preview?.fingerprint !== plan.permissionManifest?.fingerprint) {
      return { dryRun, changed, changedCount: 0, changedByType, errors: [{ code: "preview-mismatch", error: "refusing apply without a matching previously generated permission preview" }], migrationCompleted: false, preview: null };
    }
  }
  for (const item of plan.permissionChanges || []) {
    if (!inside(plan.root, item.path)) { errors.push({ code: "outside-session-root", entryId: entryId(item) }); continue; }
    try { hardenPlannedPath(item); }
    catch (error) { errors.push({ code: "path-changed-since-preview", entryId: entryId(item), errorCode: safeErrorCode(error) }); continue; }
    changedByType[item.type] += 1;
  }
  let migrationCompleted = Boolean(plan.migration?.alreadyApplied);
  if (!migrationCompleted && errors.length === 0 && plan.migration?.markerPath) {
    try {
      ensurePrivateDir(path.dirname(plan.migration.markerPath));
      const marker = { schemaVersion: 1, version: SESSION_PERMISSION_MIGRATION_VERSION, completed: true, completedAt: new Date().toISOString(), rootHash: plan.permissionManifest?.rootHash, manifestFingerprint: plan.permissionManifest?.fingerprint, filesScanned: plan.summary?.filesScanned || 0, directoriesScanned: plan.summary?.directoriesScanned || 0, activeFilesExcluded: plan.summary?.activeFilesExcluded || 0 };
      writePrivateFileExclusive(plan.migration.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
      migrationCompleted = true;
    } catch (error) { errors.push({ code: "migration-marker-write-failed", errorCode: safeErrorCode(error) }); }
  }
  return { dryRun, changed, changedCount: changedByType.file + changedByType.directory, changedByType, errors, migrationCompleted, preview: { fingerprint: plan.permissionManifest?.fingerprint || null } };
}

function archiveSessionCandidates(plan, options = {}) {
  const dryRun = options.dryRun !== false;
  const batchId = options.batchId || new Date().toISOString().replace(/[:.]/g, "-");
  const batchRoot = path.join(plan.archiveRoot, batchId);
  const moved = [];
  const errors = [];
  if (!dryRun) ensurePrivateDir(batchRoot);
  for (const item of plan.archiveCandidates || []) {
    if (!inside(plan.root, item.path)) { errors.push({ relativePath: item.relativePath, error: "outside session root" }); continue; }
    const destination = path.join(batchRoot, item.relativePath);
    if (!inside(batchRoot, destination)) { errors.push({ relativePath: item.relativePath, error: "unsafe archive destination" }); continue; }
    let digest = null;
    if (!dryRun) {
      let fd;
      try {
        const openedPath = openValidatedPath(item.path, "file", item.identity);
        fd = openedPath.fd;
        const opened = openedPath.opened;
        if (opened.size !== item.bytes || Math.abs(opened.mtimeMs - Number(item.modifiedMs)) > 1) throw new Error("archive candidate changed since preview");
        if (fs.existsSync(destination)) throw new Error("archive destination already exists");
        const hash = crypto.createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!bytes) break;
          hash.update(buffer.subarray(0, bytes));
        }
        digest = hash.digest("hex");
        assertPathStillOpen(item.path, opened, "file");
        ensurePrivateDir(path.dirname(destination));
        assertPathStillOpen(item.path, opened, "file");
        fs.renameSync(item.path, destination);
        assertPathStillOpen(destination, opened, "file");
        fs.fchmodSync(fd, 0o600);
        assertPathStillOpen(destination, opened, "file");
      } catch (error) { errors.push({ relativePath: item.relativePath, error: error?.message || String(error) }); continue; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    moved.push({ relativePath: item.relativePath, destinationRelativePath: path.relative(plan.archiveRoot, destination), reason: item.reason, bytes: item.bytes, sha256: digest, sessionId: item.sessionId, cwdHash: item.cwdHash });
  }
  let manifestPath = null;
  if (!dryRun) {
    manifestPath = path.join(batchRoot, "manifest.json");
    writePrivateFileExclusive(manifestPath, `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), sourceRoot: plan.root, moved, errors }, null, 2)}\n`);
  }
  return { dryRun, batchRoot, manifestPath, moved, errors };
}

function hardenActiveSessionFile(file) {
  if (!file) return { changed: false, reason: "ephemeral session" };
  const target = path.resolve(file);
  const dir = path.dirname(target);
  const changes = [];
  try {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`refusing symbolic link or non-directory session path: ${dir}`);
    if ((dirStat.mode & 0o777) !== 0o700) { hardenPlannedPath({ path: dir, type: "directory", identity: identityOf(dirStat), toMode: 0o700 }); changes.push({ path: dir, mode: 0o700 }); }
    const fileStat = fs.lstatSync(target);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error(`refusing symbolic link or non-file session path: ${target}`);
    if ((fileStat.mode & 0o777) !== 0o600) { hardenPlannedPath({ path: target, type: "file", identity: identityOf(fileStat), toMode: 0o600 }); changes.push({ path: target, mode: 0o600 }); }
    return { changed: changes.length > 0, changes };
  } catch (error) { return { changed: false, error: error?.message || String(error) }; }
}

function publicSessionHygienePlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    generatedAt: plan.generatedAt,
    scope: { kind: "global-session-store", rootHash: plan.permissionManifest?.rootHash || null, containsPaths: false, containsSessionIds: false },
    migration: { version: plan.migration?.version, alreadyApplied: Boolean(plan.migration?.alreadyApplied), markerError: plan.migration?.markerError ? "marker-read-failed" : null, dryRunFirst: true, explicitApplyRequired: true },
    policy: { olderThanMs: plan.policy?.olderThanMs, includeTemporary: Boolean(plan.policy?.includeTemporary), includeOneShot: Boolean(plan.policy?.includeOneShot), projectScoped: Boolean(plan.policy?.projectCwd), maxOneShotBytes: plan.policy?.maxOneShotBytes, maxFiles: plan.policy?.maxFiles, maxEntries: plan.policy?.maxEntries, maxScanBytesPerFile: plan.policy?.maxScanBytesPerFile },
    permissionManifest: plan.permissionManifest,
    summary: plan.summary,
  };
}
function publicSessionHygieneResult(plan, permissions, archived = null) {
  return {
    plan: publicSessionHygienePlan(plan),
    permissions,
    archive: archived ? { dryRun: archived.dryRun, candidates: archived.moved?.length || 0, errors: archived.errors?.length || 0 } : null,
  };
}
function formatSessionHygienePlan(planInput) {
  const plan = planInput?.root ? publicSessionHygienePlan(planInput) : planInput;
  return [
    "Session hygiene preview",
    `scope=${plan.scope?.kind || "global-session-store"} rootHash=${plan.scope?.rootHash || plan.permissionManifest?.rootHash || "unknown"}`,
    `files=${plan.summary.filesScanned} bytes=${plan.summary.totalBytes}`,
    `permissionMigration=v${plan.migration?.version || "?"} status=${plan.migration?.alreadyApplied ? "already-applied" : "preview-required"} activeExcluded=${plan.summary.activeFilesExcluded || 0}`,
    `manifest=${plan.permissionManifest?.fingerprint || "none"} permissionChanges=${plan.summary.permissionChanges}`,
    `modes.files=${JSON.stringify(plan.summary.modeCounts?.files || {})} modes.directories=${JSON.stringify(plan.summary.modeCounts?.directories || {})}`,
    `unsafeEntries=${plan.summary.unsafeEntries || 0} scanErrors=${plan.summary.scanErrors || 0}`,
    `archiveCandidates=${plan.summary.archiveCandidates} archiveBytes=${plan.summary.archiveBytes}`,
    `policy=temp:${plan.policy.includeTemporary} oneShot:${plan.policy.includeOneShot} olderThanMs:${plan.policy.olderThanMs}`,
    plan.summary.truncated ? "warning=scan truncated by maxFiles" : "",
    "No files move unless archive is explicitly applied.",
  ].filter(Boolean).join("\n");
}

module.exports = {
  DAY_MS,
  DEFAULT_MAX_SCAN_BYTES_PER_FILE,
  SESSION_PERMISSION_MIGRATION_VERSION,
  PERMISSION_PREVIEW_SCHEMA_VERSION,
  defaultAgentDir,
  defaultMigrationMarker,
  defaultPermissionPreview,
  defaultSessionRoot,
  defaultArchiveRoot,
  listSessionFiles,
  summarizeSessionFile,
  isTemporarySession,
  isOneShotSession,
  permissionManifestFor,
  writePermissionPreview,
  readPermissionPreview,
  sessionPermissionPosture,
  planSessionHygiene,
  applySessionPermissions,
  archiveSessionCandidates,
  hardenActiveSessionFile,
  publicSessionHygienePlan,
  publicSessionHygieneResult,
  formatSessionHygienePlan,
};
