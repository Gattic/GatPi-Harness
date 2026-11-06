"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { semanticDiff } = require("./semantic-editor.js");
const { statusPath } = require("./tree-fingerprint-worker.js");

const CHANGE_SET_SCHEMA_VERSION = 2;
const CHANGE_SET_PREFIX = "change-set-v2:sha256:";
const DEFAULT_MAX_ANALYSIS_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_IMPACT_DETAILS = 100;
const UNSAFE_PATTERN = /(\beval\s*\(|\bnew\s+Function\s*\(|process\.env\.[A-Z0-9_]*(SECRET|TOKEN|KEY).*console\.log)/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function updateFrame(hash, label, value) {
  const name = Buffer.from(String(label));
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(String(name.length)); hash.update(":"); hash.update(name);
  hash.update(String(data.length)); hash.update(":"); hash.update(data);
}

function normalizePath(root, file) {
  const absolute = path.resolve(root, String(file || ""));
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new TypeError(`path must stay inside repository: ${file}`);
  return relative;
}

function contentState(content, kind = "file") {
  if (content == null) return { kind: "missing", bytes: 0, digest: null, content: null };
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return { kind, bytes: buffer.length, digest: sha256(buffer), content: buffer };
}

function normalizedState(value) {
  if (!value || value.kind === "missing") return { kind: "missing", bytes: 0, digest: null, content: null };
  if (value.content != null) {
    const state = contentState(value.content, value.kind || "file");
    return { ...state, bytes: Number.isFinite(value.bytes) ? value.bytes : state.bytes, digest: value.digest || state.digest };
  }
  return {
    kind: String(value.kind || "file"),
    bytes: Number.isFinite(value.bytes) ? Number(value.bytes) : 0,
    digest: value.digest == null ? null : String(value.digest),
    content: null,
  };
}

function updateEntryFingerprint(hash, entry) {
  updateFrame(hash, "path", entry.path);
  for (const side of ["before", "after"]) {
    const state = normalizedState(entry[side]);
    updateFrame(hash, `${side}.kind`, state.kind);
    updateFrame(hash, `${side}.bytes`, state.bytes);
    updateFrame(hash, `${side}.digest`, state.digest || "");
  }
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function publicApis(source) {
  const out = [];
  let match;
  const objectExports = new RegExp("module\\.exports\\s*=\\s*\\{([^}]+)\\}", "g");
  const namedExports = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  const esExports = /export\s+(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((match = objectExports.exec(source))) for (const part of match[1].split(",")) out.push(part.trim().split(/\s+as\s+|:/).pop().trim());
  while ((match = namedExports.exec(source))) out.push(match[1]);
  while ((match = esExports.exec(source))) out.push(match[1]);
  return unique(out).sort();
}

function textContent(state) {
  if (!state?.content) return state?.kind === "missing" ? "" : null;
  const buffer = Buffer.isBuffer(state.content) ? state.content : Buffer.from(state.content);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

class ImpactAccumulator {
  constructor({ maxDetails = DEFAULT_MAX_IMPACT_DETAILS } = {}) {
    this.maxDetails = maxDetails;
    this.changedFiles = [];
    this.categories = new Set();
    this.semantic = [];
    this.semanticCount = 0;
    this.publicApiChanges = [];
    this.publicApiChangeCount = 0;
    this.publicApiAdditionCount = 0;
    this.publicApiRemovalCount = 0;
    this.dependencyGraphImpact = [];
    this.analysisIncomplete = [];
    this.analysisIncompleteCount = 0;
    this.unsafePatterns = [];
    this.unsafePatternCount = 0;
    this.risk = 0;
  }

  add(entry) {
    const file = entry.path;
    const before = normalizedState(entry.before);
    const after = normalizedState(entry.after);
    this.changedFiles.push(file);
    const contentChanged = before.kind !== after.kind || before.bytes !== after.bytes || before.digest !== after.digest;
    if (contentChanged) this.categories.add("semantic");

    const beforeText = textContent(before);
    const afterText = textContent(after);
    const sourceFile = /\.(js|cjs|mjs|ts|tsx|jsx)$/.test(file);
    if (sourceFile && (beforeText == null || afterText == null)) {
      this.analysisIncompleteCount++;
      if (this.analysisIncomplete.length < this.maxDetails) this.analysisIncomplete.push({ file, reason: "content-too-large-or-binary" });
    } else if (sourceFile) {
      const diff = semanticDiff(beforeText, afterText, file);
      if (contentChanged) {
        this.semanticCount++;
        if (this.semantic.length < this.maxDetails) this.semantic.push({ file, ...diff });
        if (this.dependencyGraphImpact.length < this.maxDetails) this.dependencyGraphImpact.push({ file, dependencyImpact: diff.dependencyImpact });
        if (diff.dependencyImpact.added.length || diff.dependencyImpact.removed.length) this.categories.add("dependency");
        if (diff.changes.some((change) => change.type === "remove")) this.risk += 0.2;
        this.risk += Math.min(0.3, diff.changes.length * 0.04);
      }
      const beforeApis = publicApis(beforeText);
      const afterApis = publicApis(afterText);
      for (const symbol of beforeApis.filter((item) => !afterApis.includes(item))) this.addPublicApi({ file, type: "removed", symbol });
      for (const symbol of afterApis.filter((item) => !beforeApis.includes(item))) this.addPublicApi({ file, type: "added", symbol });
    }

    if (/package(-lock)?\.json$|\.github\/|Dockerfile/.test(file)) this.categories.add("architecture");
    const searchable = `${beforeText || ""}\n${afterText || ""}\n${file}`;
    if (/auth|crypto|token|secret|permission|security/i.test(searchable)) this.categories.add("security");
    if (/benchmark|perf|performance/i.test(searchable)) this.categories.add("performance");
    if (afterText != null && UNSAFE_PATTERN.test(afterText)) {
      this.unsafePatternCount++;
      if (this.unsafePatterns.length < this.maxDetails) this.unsafePatterns.push({ file });
    }
  }

  addPublicApi(change) {
    this.publicApiChangeCount++;
    if (change.type === "removed") this.publicApiRemovalCount++;
    if (change.type === "added") this.publicApiAdditionCount++;
    if (this.publicApiChanges.length < this.maxDetails) this.publicApiChanges.push(change);
  }

  result() {
    if (this.publicApiChangeCount) this.categories.add("public-api");
    if (!this.categories.size) this.categories.add("format");
    return {
      changedFiles: this.changedFiles,
      categories: Array.from(this.categories).sort(),
      semantic: this.semantic,
      semanticCount: this.semanticCount,
      omittedSemantic: Math.max(0, this.semanticCount - this.semantic.length),
      publicApiChanges: this.publicApiChanges,
      publicApiChangeCount: this.publicApiChangeCount,
      publicApiAdditionCount: this.publicApiAdditionCount,
      publicApiRemovalCount: this.publicApiRemovalCount,
      omittedPublicApiChanges: Math.max(0, this.publicApiChangeCount - this.publicApiChanges.length),
      dependencyGraphImpact: this.dependencyGraphImpact,
      analysisIncomplete: this.analysisIncomplete,
      analysisIncompleteCount: this.analysisIncompleteCount,
      unsafePatterns: this.unsafePatterns,
      unsafePatternCount: this.unsafePatternCount,
      behavioralRisk: Math.max(0, Math.min(1, this.risk + this.publicApiChangeCount * 0.12)),
    };
  }
}

async function buildChangeSetFromEntries(entries, options = {}) {
  const hash = crypto.createHash("sha256");
  updateFrame(hash, "schemaVersion", CHANGE_SET_SCHEMA_VERSION);
  const impact = new ImpactAccumulator(options);
  const changedFiles = [];
  let beforeBytes = 0;
  let afterBytes = 0;
  for await (const raw of entries) {
    const entry = { path: String(raw.path), before: normalizedState(raw.before), after: normalizedState(raw.after) };
    changedFiles.push(entry.path);
    beforeBytes += entry.before.bytes;
    afterBytes += entry.after.bytes;
    updateEntryFingerprint(hash, entry);
    impact.add(entry);
  }
  return {
    schemaVersion: CHANGE_SET_SCHEMA_VERSION,
    changedFiles,
    fileCount: changedFiles.length,
    fingerprint: `${CHANGE_SET_PREFIX}${hash.digest("hex")}`,
    totals: { beforeBytes, afterBytes },
    impact: impact.result(),
  };
}

function fingerprintChangeSet(changeSet) {
  if (String(changeSet?.fingerprint || "").startsWith(CHANGE_SET_PREFIX)) return changeSet.fingerprint;
  const hash = crypto.createHash("sha256");
  updateFrame(hash, "schemaVersion", CHANGE_SET_SCHEMA_VERSION);
  const files = unique(changeSet?.changedFiles || [...Object.keys(changeSet?.before || {}), ...Object.keys(changeSet?.after || {})]).sort();
  for (const file of files) updateEntryFingerprint(hash, {
    path: file,
    before: contentState(Object.prototype.hasOwnProperty.call(changeSet?.before || {}, file) ? changeSet.before[file] : null),
    after: contentState(Object.prototype.hasOwnProperty.call(changeSet?.after || {}, file) ? changeSet.after[file] : null),
  });
  return `${CHANGE_SET_PREFIX}${hash.digest("hex")}`;
}

class AsyncByteReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.done = false; }
  async fill() {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) { this.done = true; return false; }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    return true;
  }
  async readUntilNull(maxBytes = 1024 * 1024) {
    while (true) {
      const index = this.buffer.indexOf(0);
      if (index >= 0) {
        const value = this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + 1);
        return value;
      }
      if (this.buffer.length > maxBytes) throw new Error("git cat-file header exceeded bounded parser limit");
      if (!await this.fill()) throw new Error("unexpected end of git cat-file output");
    }
  }
  async consume(length, onChunk) {
    let remaining = length;
    while (remaining > 0) {
      if (!this.buffer.length && !await this.fill()) throw new Error("unexpected end of git cat-file content");
      const take = Math.min(remaining, this.buffer.length);
      const chunk = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      onChunk(chunk);
      remaining -= take;
    }
  }
  async expectNull() {
    if (!this.buffer.length && !await this.fill()) throw new Error("missing git cat-file record terminator");
    if (this.buffer[0] !== 0) throw new Error("invalid git cat-file record terminator");
    this.buffer = this.buffer.subarray(1);
  }
}

async function writeBatchRequests(stream, files) {
  for (const file of files) if (!stream.write(`HEAD:${file}\0`)) await once(stream, "drain");
  stream.end();
}

async function workingState(root, file, maxAnalysisFileBytes) {
  const full = path.join(root, file);
  let stat;
  try { stat = await fs.promises.lstat(full); } catch { return contentState(null); }
  if (stat.isSymbolicLink()) return contentState(await fs.promises.readlink(full), "symlink");
  if (!stat.isFile()) return { kind: stat.isDirectory() ? "directory" : "special", bytes: 0, digest: null, content: null };
  const hash = crypto.createHash("sha256");
  const chunks = stat.size <= maxAnalysisFileBytes ? [] : null;
  let bytes = 0;
  for await (const chunk of fs.createReadStream(full)) { hash.update(chunk); bytes += chunk.length; if (chunks) chunks.push(chunk); }
  return { kind: "file", bytes, digest: hash.digest("hex"), content: chunks ? Buffer.concat(chunks, bytes) : null };
}

async function* workingTreeEntries({ cwd, files, maxAnalysisFileBytes }) {
  const child = spawn("git", ["cat-file", "--batch", "-Z"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => { /* parser/exit handling reports the causal git failure */ });
  let stderr = "";
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length); });
  const exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const writer = writeBatchRequests(child.stdin, files);
  const reader = new AsyncByteReader(child.stdout);
  try {
    for (const file of files) {
      const header = (await reader.readUntilNull()).toString("utf8");
      let before;
      if (/ (?:missing|ambiguous)$/.test(header)) before = contentState(null);
      else {
        const match = /^([a-f0-9]+) ([^ ]+) (\d+)$/.exec(header);
        if (!match) throw new Error(`invalid git cat-file header: ${header.slice(0, 200)}`);
        const size = Number(match[3]);
        const hash = crypto.createHash("sha256");
        const chunks = size <= maxAnalysisFileBytes ? [] : null;
        await reader.consume(size, (chunk) => { hash.update(chunk); if (chunks) chunks.push(Buffer.from(chunk)); });
        await reader.expectNull();
        before = { kind: match[2] === "blob" ? "file" : match[2], bytes: size, digest: hash.digest("hex"), content: chunks ? Buffer.concat(chunks, size) : null };
      }
      const after = await workingState(cwd, file, maxAnalysisFileBytes);
      yield { path: file, before, after };
    }
    await writer;
    const status = await exit;
    if (status.code !== 0) throw new Error(`git cat-file failed (${status.code ?? status.signal}): ${stderr.trim() || "unknown error"}`);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
}

async function discoverWorkingTreeFiles(cwd) {
  const child = spawn("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length); });
  const exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: -1, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const files = [];
  let pending = Buffer.alloc(0);
  let awaitingRenameSource = false;
  for await (const chunk of child.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let delimiter;
    while ((delimiter = pending.indexOf(0)) >= 0) {
      const record = pending.subarray(0, delimiter).toString("utf8");
      pending = pending.subarray(delimiter + 1);
      if (!record) continue;
      if (awaitingRenameSource) { awaitingRenameSource = false; continue; }
      const file = statusPath(record);
      if (file) files.push(file);
      if (record[0] === "2") awaitingRenameSource = true;
    }
    if (pending.length > 1024 * 1024) throw new Error("git status record exceeded bounded parser limit");
  }
  const status = await exit;
  if (status.code !== 0) throw new Error(`git status failed (${status.code ?? status.signal}): ${status.error || stderr.trim() || "unknown error"}`);
  if (pending.length || awaitingRenameSource) throw new Error("git status returned an incomplete record");
  return unique(files).sort();
}

async function captureWorkingTreeChangeSet({ cwd = process.cwd(), files = [], maxAnalysisFileBytes = DEFAULT_MAX_ANALYSIS_FILE_BYTES, maxDetails = DEFAULT_MAX_IMPACT_DETAILS } = {}) {
  const root = path.resolve(cwd);
  const requestedFiles = files.length ? files : await discoverWorkingTreeFiles(root);
  const changedFiles = unique(requestedFiles.map((file) => normalizePath(root, file))).sort();
  return buildChangeSetFromEntries(workingTreeEntries({ cwd: root, files: changedFiles, maxAnalysisFileBytes }), { maxDetails });
}

module.exports = {
  CHANGE_SET_SCHEMA_VERSION,
  CHANGE_SET_PREFIX,
  DEFAULT_MAX_ANALYSIS_FILE_BYTES,
  DEFAULT_MAX_IMPACT_DETAILS,
  UNSAFE_PATTERN,
  ImpactAccumulator,
  buildChangeSetFromEntries,
  captureWorkingTreeChangeSet,
  contentState,
  discoverWorkingTreeFiles,
  fingerprintChangeSet,
};
