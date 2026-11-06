"use strict";

/** Filesystem-backed implementation of the integration storage interface. */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

function sameIdentity(left, right) { return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino); }
function assertRealPath(target, stat, type) {
  if (stat.isSymbolicLink() || (type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) throw new Error(`integration storage ${type} is not a real ${type}: ${target}`);
}
function assertPathIdentity(target, opened, type) {
  const current = fs.lstatSync(target);
  assertRealPath(target, current, type);
  if (!sameIdentity(opened, current)) throw new Error(`integration storage ${type} changed while open: ${target}`);
}
function openValidated(target, type, flags = fs.constants.O_RDONLY) {
  const before = fs.lstatSync(target);
  assertRealPath(target, before, type);
  const fd = fs.openSync(target, flags | NO_FOLLOW | (type === "directory" ? DIRECTORY_ONLY : 0));
  try {
    const opened = fs.fstatSync(fd);
    assertRealPath(target, opened, type);
    if (!sameIdentity(before, opened)) throw new Error(`integration storage ${type} changed while opening: ${target}`);
    assertPathIdentity(target, opened, type);
    return { fd, opened };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { fd, opened } = openValidated(dir, "directory");
  try { fs.fchmodSync(fd, 0o700); assertPathIdentity(dir, opened, "directory"); }
  finally { fs.closeSync(fd); }
  return dir;
}
function hardenPrivateFile(file) {
  const { fd, opened } = openValidated(file, "file");
  try { fs.fchmodSync(fd, 0o600); assertPathIdentity(file, opened, "file"); }
  finally { fs.closeSync(fd); }
  return file;
}
function writePrivateExclusive(file, content) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    assertRealPath(file, opened, "file");
    assertPathIdentity(file, opened, "file");
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
    assertPathIdentity(file, opened, "file");
    return opened;
  } finally { fs.closeSync(fd); }
}
function readPrivateFile(file) {
  const { fd, opened } = openValidated(file, "file");
  try { const value = fs.readFileSync(fd); assertPathIdentity(file, opened, "file"); return value; }
  finally { fs.closeSync(fd); }
}
function appendPrivateFile(file, content) {
  let fd;
  try { fd = openValidated(file, "file", fs.constants.O_WRONLY | fs.constants.O_APPEND).fd; }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
  }
  try {
    const opened = fs.fstatSync(fd);
    assertRealPath(file, opened, "file");
    assertPathIdentity(file, opened, "file");
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
    assertPathIdentity(file, opened, "file");
  } finally { fs.closeSync(fd); }
}

function safeKey(key) {
  return String(key || "default").replace(/(^|[\\/])\.\.($|[\\/])/g, "$1_$2").replace(/[^a-zA-Z0-9._/-]/g, "_").replace(/^\/+/, "");
}

function jsonByteLimit(value, fallback = DEFAULT_MAX_JSON_BYTES) {
  if (value === Infinity) return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1024 ? Math.floor(parsed) : fallback;
}

function estimateJsonBytes(value, limit = Infinity, seen = new Set()) {
  let bytes = 0;
  const add = (amount) => {
    bytes += amount;
    return bytes > limit;
  };
  const visit = (item) => {
    if (bytes > limit) return;
    if (item == null) { add(4); return; }
    if (typeof item === "string") { add(item.length * 3 + 2); return; }
    if (typeof item === "number") { add(32); return; }
    if (typeof item === "boolean") { add(5); return; }
    if (typeof item === "bigint") throw new TypeError("BigInt is not JSON serializable");
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") { add(4); return; }
    if (seen.has(item)) throw new TypeError("Converting circular structure to JSON");
    seen.add(item);
    if (Array.isArray(item)) {
      add(2);
      for (const value of item) { add(1); visit(value); if (bytes > limit) break; }
    } else {
      add(2);
      for (const [key, value] of Object.entries(item)) {
        if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") continue;
        add(key.length * 3 + 4);
        visit(value);
        if (bytes > limit) break;
      }
    }
    seen.delete(item);
  };
  visit(value);
  return bytes;
}

class JsonSizeLimitError extends Error {
  constructor({ key, estimatedBytes, maxBytes, operation = "write" }) {
    super(`Refusing to ${operation} oversized JSON state for ${key}: estimated ${estimatedBytes} bytes exceeds limit ${maxBytes}`);
    this.name = "JsonSizeLimitError";
    this.code = "PI_JSON_SIZE_LIMIT";
    this.key = key;
    this.estimatedBytes = estimatedBytes;
    this.maxBytes = maxBytes;
    this.operation = operation;
  }
}

// Only disposable diagnostic streams opt into these limits; evidence and session
// ledgers keep their existing append-only contract.
const DIAGNOSTIC_POLICIES = Object.freeze({
  entropy: { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, maxAgeMs: 14 * 86400000 },
  memory: { maxBytes: 2 * 1024 * 1024, maxRecords: 2000, maxAgeMs: 30 * 86400000 },
});
const diagnosticState = new Map();
function withStorageLock(file, fn) {
  const lock = `${file}.lock`;
  const claim = `${lock}.${process.pid}.${crypto.randomUUID()}`;
  const identity = writePrivateExclusive(claim, JSON.stringify({ pid: process.pid }));
  const started = Date.now(); let acquired = false;
  try {
    while (!acquired) {
      try { fs.linkSync(claim, lock); acquired = true; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let fd; let owner; let stat;
        try {
          // The owner publishes a complete record via link(). The pathname may
          // disappear after open when another writer releases its lock.
          fd = fs.openSync(lock, fs.constants.O_RDONLY | NO_FOLLOW);
          stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size > 1024) throw new Error("invalid storage lock file");
          owner = JSON.parse(fs.readFileSync(fd, "utf8"));
        } catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid storage lock owner");
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if (probe.code === "ESRCH") {
            try { if (sameIdentity(stat, fs.lstatSync(lock))) fs.unlinkSync(lock); }
            catch (releaseError) { if (releaseError.code !== "ENOENT") throw releaseError; }
            continue;
          }
          if (probe.code !== "EPERM") throw probe;
        }
        if (Date.now() - started >= 2000) throw new Error("diagnostic storage lock timeout");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return fn();
  } finally {
    try { if (acquired) { assertPathIdentity(lock, identity, "file"); fs.unlinkSync(lock); } }
    finally { fs.unlinkSync(claim); }
  }
}
function diagnosticTimestamp(row, fallback) {
  const raw = row.at ?? row.timestamp ?? row.createdAt;
  const at = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(at) ? at : fallback;
}
function diagnosticRows(text, fallbackAt) {
  const rows = []; let corrupt = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value;
    // A crash can leave non-JSON bytes (observed as NUL holes) where an append
    // was recorded but never written. The retention policy already authorizes
    // discarding rows from this disposable stream, so a corrupt row is counted
    // and dropped instead of failing every later append forever.
    try { value = JSON.parse(line); }
    catch { corrupt++; continue; }
    rows.push({ line, at: diagnosticTimestamp(value, fallbackAt) });
  }
  return { rows, corrupt };
}
function maintainDiagnosticJsonl(file, policy, now, force = false) {
  const { fd, opened } = openValidated(file, "file");
  try {
    fs.fchmodSync(fd, 0o600);
    const cached = diagnosticState.get(file);
    if (!force && cached && sameIdentity(cached, opened) && cached.bytes === opened.size && cached.count <= policy.maxRecords && opened.size <= policy.maxBytes && cached.oldestAt >= now - policy.maxAgeMs) return { bytes: opened.size, records: cached.count, compacted: false, dropped: 0 };
    // Include the preceding byte so a suffix already on a record boundary
    // discards only that newline, not the complete first retained record.
    const start = Math.max(0, opened.size - policy.maxBytes);
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(opened.size - readStart);
    fs.readSync(fd, buffer, 0, buffer.length, readStart);
    let text = buffer.toString("utf8");
    if (start) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
    const { rows, corrupt } = diagnosticRows(text, opened.mtimeMs);
    const fresh = rows.filter((row) => row.at >= now - policy.maxAgeMs);
    const exceeded = corrupt > 0 || start > 0 || fresh.length > policy.maxRecords || fresh.length !== rows.length;
    let retained = fresh;
    if (exceeded) {
      retained = fresh.slice(-Math.max(1, Math.floor(policy.maxRecords * 0.8)));
      const newestBytes = retained.length ? Buffer.byteLength(retained.at(-1).line) + 1 : 0;
      const targetBytes = Math.max(policy.maxBytes * 0.8, newestBytes);
      let bytes = 0; let index = retained.length;
      while (index > 0) { const size = Buffer.byteLength(retained[index - 1].line) + 1; if (bytes + size > targetBytes) break; bytes += size; index--; }
      retained = retained.slice(index);
      const temporary = `${file}.${process.pid}.${Date.now()}.retention-tmp`;
      const identity = writePrivateExclusive(temporary, retained.map((row) => `${row.line}\n`).join(""));
      try { assertPathIdentity(file, opened, "file"); fs.renameSync(temporary, file); assertPathIdentity(file, identity, "file"); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    const stat = fs.lstatSync(file);
    const state = { dev: stat.dev, ino: stat.ino, bytes: stat.size, count: retained.length, oldestAt: retained.length ? Math.min(...retained.map((row) => row.at)) : now };
    diagnosticState.set(file, state);
    return { bytes: state.bytes, records: state.count, compacted: exceeded, dropped: corrupt };
  } finally { fs.closeSync(fd); }
}
function pruneDiagnosticJsonl(file, policy, { now = Date.now() } = {}) {
  if (!fs.existsSync(file)) return { bytes: 0, records: 0, compacted: false, dropped: 0 };
  return withStorageLock(file, () => maintainDiagnosticJsonl(file, policy, now, true));
}
function appendBoundedJsonl(file, value, policy, now = Date.now()) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > policy.maxBytes) throw new JsonSizeLimitError({ key: path.basename(file), estimatedBytes: Buffer.byteLength(line), maxBytes: policy.maxBytes, operation: "append" });
  ensurePrivateDir(path.dirname(file));
  return withStorageLock(file, () => {
    const before = fs.existsSync(file) ? fs.lstatSync(file) : null;
    const cached = diagnosticState.get(file);
    appendPrivateFile(file, line);
    if (cached && before && sameIdentity(cached, before) && cached.bytes === before.size) {
      cached.bytes += Buffer.byteLength(line); cached.count++; cached.oldestAt = Math.min(cached.oldestAt, diagnosticTimestamp(value, now));
    }
    return maintainDiagnosticJsonl(file, policy, now);
  });
}

function splitUtf8(buffer, chunkBytes) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(buffer.length, offset + chunkBytes);
    if (end < buffer.length) {
      while (end > offset && (buffer[end] & 0xc0) === 0x80) end--;
      if (end === offset) end = Math.min(buffer.length, offset + chunkBytes);
    }
    chunks.push(buffer.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

class FileIntegrationStorage {
  constructor(root, options = {}) {
    if (!root) throw new Error("FileIntegrationStorage requires a root directory");
    this.root = root;
    this.maxJsonBytes = jsonByteLimit(options.maxJsonBytes ?? process.env.PI_INTEGRATION_STORAGE_MAX_JSON_BYTES);
    this.chunkBytes = Math.min(jsonByteLimit(options.chunkBytes ?? process.env.PI_INTEGRATION_STORAGE_CHUNK_BYTES ?? 8 * 1024 * 1024), this.maxJsonBytes);
    this.oversizedReads = new Map();
    this.lastOversizedBackup = null;
    ensurePrivateDir(root);
  }
  jsonPath(key) { return path.join(this.root, `${safeKey(key)}.json`); }
  // safeKey() replaces ! with _, so a caller key can never create this path.
  chunkRootPath() { return path.join(this.root, "!chunks"); }
  chunkManifestPath(key) { return path.join(this.chunkRootPath(), `${safeKey(key)}.json`); }
  chunkDirPath(key) { return path.join(this.chunkRootPath(), safeKey(key)); }
  jsonlPath(key) { return path.join(this.root, `${safeKey(key)}.jsonl`); }
  ensure(file) { ensurePrivateDir(path.dirname(file)); }
  readChunkedJson(key) {
    let manifest;
    try { manifest = JSON.parse(readPrivateFile(this.chunkManifestPath(key)).toString("utf8")); }
    catch { return { found: false }; }
    if (!manifest || manifest.schemaVersion !== 1 || manifest.key !== key || !Array.isArray(manifest.chunks) || !Number.isInteger(manifest.bytes) || typeof manifest.sha256 !== "string") return { found: true, error: "invalid-manifest" };
    const buffers = [];
    for (const name of manifest.chunks) {
      if (!/^[0-9]{4,}\.part$/.test(name)) return { found: true, error: "invalid-chunk-name" };
      try { buffers.push(readPrivateFile(path.join(this.chunkDirPath(key), name))); }
      catch { return { found: true, error: "missing-chunk" }; }
    }
    const buffer = Buffer.concat(buffers);
    if (buffer.length !== manifest.bytes || crypto.createHash("sha256").update(buffer).digest("hex") !== manifest.sha256) return { found: true, error: "chunk-integrity" };
    try { return { found: true, value: JSON.parse(buffer.toString("utf8")) }; }
    catch { return { found: true, error: "invalid-json" }; }
  }
  readJson(key, fallback = null) {
    if (fs.existsSync(this.chunkManifestPath(key))) {
      const chunked = this.readChunkedJson(key);
      return chunked.found && !chunked.error ? chunked.value : fallback;
    }
    const file = this.jsonPath(key);
    let fd;
    try {
      const openedPath = openValidated(file, "file");
      fd = openedPath.fd;
      const size = openedPath.opened.size;
      if (size > this.maxJsonBytes) {
        this.oversizedReads.set(file, { key, size, maxBytes: this.maxJsonBytes });
        return fallback;
      }
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      assertPathIdentity(file, openedPath.opened, "file");
      this.oversizedReads.delete(file);
      return value;
    } catch {
      return fallback;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  writeJson(key, value) {
    const file = this.jsonPath(key);
    const estimatedBytes = estimateJsonBytes(value, this.maxJsonBytes);
    if (estimatedBytes > this.maxJsonBytes) throw new JsonSizeLimitError({ key, estimatedBytes, maxBytes: this.maxJsonBytes });
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const exactBytes = Buffer.byteLength(text);
    if (exactBytes > this.maxJsonBytes) throw new JsonSizeLimitError({ key, estimatedBytes: exactBytes, maxBytes: this.maxJsonBytes });
    if (exactBytes > this.chunkBytes) return this.writeChunkedJson(key, text);
    this.ensure(file);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    let backup = null;
    let temporaryCreated = false;
    try {
      const temporaryIdentity = writePrivateExclusive(temporary, text);
      temporaryCreated = true;
      let existing = null;
      try {
        existing = fs.lstatSync(file);
        assertRealPath(file, existing, "file");
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (existing && existing.size > this.maxJsonBytes) {
        hardenPrivateFile(file);
        backup = this.uniqueOversizedBackup(file);
        fs.renameSync(file, backup);
        assertPathIdentity(backup, existing, "file");
      }
      fs.renameSync(temporary, file);
      assertPathIdentity(file, temporaryIdentity, "file");
      this.oversizedReads.delete(file);
      this.removeChunks(key);
      if (backup) this.lastOversizedBackup = backup;
      return file;
    } catch (error) {
      if (temporaryCreated) try { fs.rmSync(temporary, { force: true }); } catch {}
      if (backup && !fs.existsSync(file) && fs.existsSync(backup)) {
        try { fs.renameSync(backup, file); } catch {}
      }
      throw error;
    }
  }
  removeChunks(key) {
    const manifest = this.chunkManifestPath(key);
    const dir = this.chunkDirPath(key);
    try { fs.rmSync(manifest, { force: true }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  writeChunkedJson(key, text) {
    const buffer = Buffer.from(text, "utf8");
    const manifestPath = this.chunkManifestPath(key);
    const dir = this.chunkDirPath(key);
    this.ensure(manifestPath);
    const temporaryDir = `${dir}.${process.pid}.${Date.now()}.tmp`;
    const temporaryManifest = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    const chunks = splitUtf8(buffer, this.chunkBytes);
    let temporaryDirCreated = false;
    let temporaryManifestCreated = false;
    let backupDir = null;
    let installedDir = false;
    try {
      ensurePrivateDir(temporaryDir);
      temporaryDirCreated = true;
      const names = [];
      for (let index = 0; index < chunks.length; index++) {
        const name = `${String(index + 1).padStart(4, "0")}.part`;
        writePrivateExclusive(path.join(temporaryDir, name), chunks[index]);
        names.push(name);
      }
      const manifest = { schemaVersion: 1, key, bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), chunks: names, createdAt: new Date().toISOString() };
      writePrivateExclusive(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      temporaryManifestCreated = true;
      if (fs.existsSync(dir)) {
        backupDir = `${dir}.old-${process.pid}-${Date.now()}`;
        fs.renameSync(dir, backupDir);
      }
      fs.renameSync(temporaryDir, dir);
      temporaryDirCreated = false;
      installedDir = true;
      fs.renameSync(temporaryManifest, manifestPath);
      temporaryManifestCreated = false;
      try { fs.rmSync(this.jsonPath(key), { force: true }); } catch {}
      if (backupDir) try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
      this.oversizedReads.delete(this.jsonPath(key));
      return manifestPath;
    } catch (error) {
      if (installedDir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      if (backupDir && fs.existsSync(backupDir)) try { fs.renameSync(backupDir, dir); } catch {}
      if (temporaryDirCreated) try { fs.rmSync(temporaryDir, { recursive: true, force: true }); } catch {}
      if (temporaryManifestCreated) try { fs.rmSync(temporaryManifest, { force: true }); } catch {}
      throw error;
    }
  }
  uniqueOversizedBackup(file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let candidate = `${file}.oversized-${stamp}.bak`;
    let index = 1;
    while (fs.existsSync(candidate)) candidate = `${file}.oversized-${stamp}-${index++}.bak`;
    return candidate;
  }
  copyJson(sourceKey, targetKey) {
    if (fs.existsSync(this.chunkManifestPath(sourceKey))) {
      const chunked = this.readChunkedJson(sourceKey);
      if (!chunked.found || chunked.error) return null;
      return this.writeJson(targetKey, chunked.value);
    }
    const source = this.jsonPath(sourceKey);
    const target = this.jsonPath(targetKey);
    this.ensure(target);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    let sourceFd;
    let temporaryFd;
    let temporaryCreated = false;
    try {
      const openedSource = openValidated(source, "file");
      sourceFd = openedSource.fd;
      try { const existing = fs.lstatSync(target); assertRealPath(target, existing, "file"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      temporaryFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
      temporaryCreated = true;
      const temporaryIdentity = fs.fstatSync(temporaryFd);
      assertRealPath(temporary, temporaryIdentity, "file");
      assertPathIdentity(temporary, temporaryIdentity, "file");
      fs.fchmodSync(temporaryFd, 0o600);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const bytes = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (!bytes) break;
        let offset = 0;
        while (offset < bytes) offset += fs.writeSync(temporaryFd, buffer, offset, bytes - offset);
      }
      assertPathIdentity(source, openedSource.opened, "file");
      assertPathIdentity(temporary, temporaryIdentity, "file");
      fs.closeSync(temporaryFd); temporaryFd = undefined;
      fs.closeSync(sourceFd); sourceFd = undefined;
      fs.renameSync(temporary, target);
      assertPathIdentity(target, temporaryIdentity, "file");
      this.removeChunks(targetKey);
      return target;
    } catch (error) {
      if (temporaryCreated) try { fs.rmSync(temporary, { force: true }); } catch {}
      if (error?.code === "ENOENT" && !temporaryCreated) return null;
      throw error;
    } finally {
      if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
      if (sourceFd !== undefined) fs.closeSync(sourceFd);
    }
  }
  oversizedState() { return Array.from(this.oversizedReads.values()).map((item) => ({ ...item })); }
  deleteJson(key) { try { fs.rmSync(this.jsonPath(key), { force: true }); this.removeChunks(key); return true; } catch { return false; } }
  appendJsonl(key, value, policy) {
    const file = this.jsonlPath(key);
    this.ensure(file);
    if (policy) appendBoundedJsonl(file, value, policy);
    else appendPrivateFile(file, `${JSON.stringify(value)}\n`);
    return file;
  }
  writeJsonl(key, rows = []) {
    const file = this.jsonlPath(key);
    this.ensure(file);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    let created = false;
    try {
      const temporaryIdentity = writePrivateExclusive(temporary, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
      created = true;
      try { const existing = fs.lstatSync(file); assertRealPath(file, existing, "file"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      fs.renameSync(temporary, file);
      assertPathIdentity(file, temporaryIdentity, "file");
      return file;
    } catch (error) {
      if (created) try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  readJsonl(key) {
    try { return readPrivateFile(this.jsonlPath(key)).toString("utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  }
}

module.exports = { DEFAULT_MAX_JSON_BYTES, FileIntegrationStorage, JsonSizeLimitError, estimateJsonBytes, safeKey, DIAGNOSTIC_POLICIES, appendBoundedJsonl, pruneDiagnosticJsonl, withStorageLock, hardenPrivateFile };
