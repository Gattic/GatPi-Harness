"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function inside(root, file) { const relative = path.relative(root, file); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }
function git(root, args) { const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 3000 }); return result.status === 0 ? String(result.stdout || "").trim() : null; }
function contentIdentity(root, file) {
  const project = path.resolve(root);
  const absolute = path.resolve(project, file);
  if (!inside(project, absolute)) throw new Error(`cache path must stay inside project: ${file}`);
  const relative = path.relative(project, absolute).replace(/\\/g, "/");
  const tracked = git(project, ["ls-files", "--error-unmatch", "--", relative]) != null;
  const dirty = tracked ? git(project, ["status", "--porcelain=v2", "--", relative]) : null;
  if (tracked && dirty === "") {
    const blob = git(project, ["hash-object", "--", relative]);
    if (blob) return { scheme: "git", hash: blob, contentHash: `git:${blob}`, path: relative, tracked: true, dirty: false };
  }
  const content = fs.readFileSync(absolute);
  const hash = sha256(content);
  return { scheme: "sha256", hash, contentHash: `sha256:${hash}`, path: relative, tracked, dirty: true };
}
class CodeContentCache {
  constructor(root, options = {}) {
    this.projectRoot = path.resolve(root);
    this.root = path.resolve(options.stateRoot || path.join(this.projectRoot, ".pi", "code-context"));
    this.objects = path.join(this.root, "objects");
    this.maxExtractBytes = Math.max(512, Number(options.maxExtractBytes || process.env.PI_CODE_CONTEXT_MAX_EXTRACT_BYTES || 16 * 1024));
    this.maxObjectBytes = Math.max(this.maxExtractBytes, Number(options.maxObjectBytes || process.env.PI_CODE_CONTEXT_MAX_OBJECT_BYTES || 64 * 1024));
  }
  objectFile(contentRef) { return path.join(this.objects, `${sha256(contentRef)}.json`); }
  put(input = {}) {
    const text = input.extract == null ? undefined : String(input.extract);
    const explicit = input.explicitBody === true;
    const max = explicit ? this.maxObjectBytes : this.maxExtractBytes;
    const bounded = text == null ? undefined : Buffer.from(text).subarray(0, max).toString("utf8");
    const truncated = text != null && Buffer.byteLength(text) > Buffer.byteLength(bounded || "");
    const scope = { projectId: input.projectId, revision: input.revision, configuration: input.configuration || "default", path: input.path, contentHash: input.contentHash, range: input.range, detail: input.detail || "card" };
    const contentRef = `ctxref:${sha256(scope).slice(0, 32)}`;
    const object = { schemaVersion: 1, contentRef, ...scope, card: input.card, extract: bounded, truncated, bytes: Buffer.byteLength(bounded || ""), explicitBody: explicit, createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString() };
    atomicJson(this.objectFile(contentRef), object);
    return object;
  }
  get(contentRef) {
    const file = this.objectFile(contentRef);
    try { const value = JSON.parse(fs.readFileSync(file, "utf8")); value.lastAccessedAt = new Date().toISOString(); atomicJson(file, value); return value; } catch { return null; }
  }
  has(contentRef) { return Boolean(this.get(contentRef)); }
  list() {
    try { return fs.readdirSync(this.objects).filter((name) => name.endsWith(".json")).map((name) => { const file = path.join(this.objects, name); try { const value = JSON.parse(fs.readFileSync(file, "utf8")); const stat = fs.statSync(file); return { file, contentRef: value.contentRef, path: value.path, bytes: stat.size, lastAccessedAt: value.lastAccessedAt, mtimeMs: stat.mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => a.contentRef.localeCompare(b.contentRef)); } catch { return []; }
  }
  garbageCollect(options = {}) {
    const maxBytes = Math.max(0, Number(options.maxBytes || process.env.PI_CODE_CONTEXT_CACHE_MAX_BYTES || 64 * 1024 * 1024));
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs || Number(process.env.PI_CODE_CONTEXT_CACHE_MAX_AGE_DAYS || 14) * 86400000));
    const protectedRefs = new Set(options.protectedRefs || []);
    const rows = this.list().sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    const candidates = [];
    for (const row of rows) {
      if (protectedRefs.has(row.contentRef)) continue;
      const old = Date.now() - row.mtimeMs > maxAgeMs;
      const oversized = total > maxBytes;
      if (!old && !oversized) continue;
      candidates.push({ ...row, reason: old ? "age" : "size" });
      total -= row.bytes;
    }
    if (options.apply) for (const row of candidates) { try { fs.unlinkSync(row.file); } catch {} }
    return { apply: Boolean(options.apply), beforeBytes: rows.reduce((sum, row) => sum + row.bytes, 0), afterBytes: options.apply ? this.list().reduce((sum, row) => sum + row.bytes, 0) : total, candidates, protected: rows.length - candidates.length };
  }
}

module.exports = { CodeContentCache, contentIdentity, atomicJson, sha256 };
