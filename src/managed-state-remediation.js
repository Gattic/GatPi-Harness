"use strict";

/** Preview-first, structure-preserving remediation for managed-state payloads. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { diagnosticTextMetadata, isDiagnosticTextMetadata, sanitizeManagedDiagnosticState, sanitizeManagedState } = require("./managed-state-sanitizer");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function isWithin(parent, child) { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function identity(file) {
  const stat = fs.lstatSync(file);
  return { dev: Number(stat.dev), ino: Number(stat.ino), bytes: stat.size, mtimeMs: stat.mtimeMs, type: stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other" };
}
function sameIdentity(left, right) { return Boolean(left && right && left.type === "file" && right.type === "file" && left.dev === right.dev && left.ino === right.ino); }
function addCounts(target, counts) { for (const [rule, count] of Object.entries(counts || {})) target[rule] = (target[rule] || 0) + count; }
function sortedCounts(counts) { return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right))); }
function ensurePrivateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); return dir; }
function writePrivateJson(file, value) { ensurePrivateDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(file, 0o600); return file; }
function regularFiles(dir, predicate) {
  try {
    return fs.readdirSync(dir).sort().filter(predicate).map((name) => path.join(dir, name)).filter((file) => {
      try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
    });
  } catch { return []; }
}

function discoverManagedStateFiles(cwd, explicitFiles) {
  if (explicitFiles?.length) {
    return [...new Set(explicitFiles.map((file) => path.resolve(cwd, file)))].filter((file) => isWithin(cwd, file));
  }
  const files = [
    path.join(cwd, ".pi", "cognitive-automation", "cognitive-memory.json"),
    path.join(cwd, ".pi", "cognitive-automation", "entropy", "events.jsonl"),
    path.join(cwd, ".pi", "cognitive-automation", "entropy", "snapshots.jsonl"),
    ...regularFiles(path.join(cwd, ".pi", "debug-ledger"), (name) => name.endsWith(".json")),
    ...regularFiles(path.join(cwd, ".pi", "traces"), (name) => /\.jsonl(?:\.\d+(?:\.\d+)?)?$/.test(name)),
  ];
  return [...new Set(files)].filter((file) => {
    try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
  });
}

function remediationKind(file) {
  const normalized = path.resolve(file).replace(/\\/g, "/");
  if (/\/\.pi\/traces\//.test(normalized)) return "trace";
  if (/\/\.pi\/cognitive-automation\/entropy\/(?:events|snapshots)\.jsonl$/.test(normalized)) return "entropy";
  if (/\/\.pi\/cognitive-automation\/cognitive-memory\.json$/.test(normalized)) return "cognitive-memory";
  return "generic";
}

function sanitizeCompressedPayloadRef(row, counts, errors, kind) {
  const ref = row?.payload_ref;
  if (!ref || typeof ref !== "object" || ref.data == null) return { row, changed: false };
  if (ref.encoding !== "gzip+base64" || typeof ref.data !== "string") {
    errors.push("unsupported compressed payload reference");
    return { row, changed: false };
  }
  try {
    const decoded = zlib.gunzipSync(Buffer.from(ref.data, "base64")).toString("utf8");
    const parsed = JSON.parse(decoded);
    const sanitized = kind === "trace" ? sanitizeManagedDiagnosticState(parsed) : sanitizeManagedState(parsed);
    addCounts(counts, sanitized.redactions);
    if (!sanitized.changed) return { row, changed: false };
    const text = JSON.stringify(sanitized.value, null, 2);
    const next = {
      ...row,
      payload_ref: {
        ...ref,
        sha256: sha256(text),
        original_bytes: Buffer.byteLength(text),
        data: zlib.gzipSync(Buffer.from(text)).toString("base64"),
      },
    };
    return { row: next, changed: true };
  } catch {
    errors.push("invalid compressed payload reference");
    return { row, changed: false };
  }
}

function sanitizeRecord(record, kind) {
  const counts = {};
  const errors = [];
  let direct = kind === "entropy" ? sanitizeManagedDiagnosticState(record) : sanitizeManagedState(record);
  if (kind === "trace" && direct.value?.payload != null) {
    const payload = sanitizeManagedDiagnosticState(direct.value.payload);
    addCounts(counts, payload.redactions);
    direct = { value: { ...direct.value, payload: payload.value }, changed: direct.changed || payload.changed, redactions: direct.redactions };
  }
  addCounts(counts, direct.redactions);
  const compressed = sanitizeCompressedPayloadRef(direct.value, counts, errors, kind);
  return { value: compressed.row, changed: direct.changed || compressed.changed, redactions: sortedCounts(counts), errors };
}

function sanitizeCognitiveMemory(value, counts) {
  if (!Array.isArray(value?.entries)) return { value, changed: false, changedEntries: 0 };
  let changedEntries = 0;
  const entries = value.entries.map((entry) => {
    if (entry?.title !== "Assistant turn" || entry?.provenance?.source !== "pi-message" || typeof entry.content !== "string" || isDiagnosticTextMetadata(entry.content)) return entry;
    changedEntries += 1;
    return { ...entry, content: diagnosticTextMetadata(entry.content, "Assistant response") };
  });
  if (!changedEntries) return { value, changed: false, changedEntries: 0 };
  counts["assistant-turn-payload"] = (counts["assistant-turn-payload"] || 0) + changedEntries;
  return { value: { ...value, entries }, changed: true, changedEntries };
}

function transformJson(buffer, file) {
  const errors = [];
  let parsed;
  try { parsed = JSON.parse(buffer.toString("utf8")); }
  catch { return { errors: ["malformed JSON document"], changedRecords: 0, redactions: {}, output: null }; }
  const kind = remediationKind(file);
  const result = sanitizeRecord(parsed, kind);
  const counts = { ...result.redactions };
  const cognitive = kind === "cognitive-memory" ? sanitizeCognitiveMemory(result.value, counts) : { value: result.value, changed: false, changedEntries: 0 };
  errors.push(...result.errors);
  const changed = result.changed || cognitive.changed;
  return {
    errors,
    changedRecords: cognitive.changedEntries || (changed ? 1 : 0),
    redactions: sortedCounts(counts),
    output: changed && !errors.length ? Buffer.from(`${JSON.stringify(cognitive.value, null, 2)}\n`) : buffer,
  };
}

function transformJsonl(buffer, file) {
  const text = buffer.toString("utf8");
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  const output = [];
  const counts = {};
  const errors = [];
  const kind = remediationKind(file);
  let changedRecords = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) { output.push(line); continue; }
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { errors.push(`malformed JSONL record ${index + 1}`); output.push(line); continue; }
    const result = sanitizeRecord(parsed, kind);
    addCounts(counts, result.redactions);
    errors.push(...result.errors.map((error) => `${error} at JSONL record ${index + 1}`));
    if (result.changed) { changedRecords += 1; output.push(JSON.stringify(result.value)); }
    else output.push(line);
  }
  const rendered = `${output.join("\n")}${trailingNewline ? "\n" : ""}`;
  return { errors, changedRecords, redactions: sortedCounts(counts), output: errors.length ? buffer : Buffer.from(rendered) };
}

function transformManagedStateFile(file, buffer = fs.readFileSync(file)) {
  return file.endsWith(".json") ? transformJson(buffer, file) : transformJsonl(buffer, file);
}

function planManagedStateRemediation(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const files = discoverManagedStateFiles(cwd, options.files);
  const candidates = [];
  const blocked = [];
  let inspectedBytes = 0;
  for (const file of files) {
    let before;
    let beforeIdentity;
    try {
      beforeIdentity = identity(file);
      if (beforeIdentity.type !== "file") { blocked.push({ file: path.relative(cwd, file), reason: "not a regular file" }); continue; }
      before = fs.readFileSync(file);
    } catch { blocked.push({ file: path.relative(cwd, file), reason: "unreadable file" }); continue; }
    inspectedBytes += before.length;
    const transformed = transformManagedStateFile(file, before);
    if (transformed.errors.length) {
      blocked.push({ file: path.relative(cwd, file), reason: transformed.errors[0], errors: transformed.errors.length });
      continue;
    }
    if (!transformed.changedRecords) continue;
    candidates.push({
      file: path.relative(cwd, file),
      format: file.endsWith(".json") ? "json" : "jsonl",
      appendOnly: file.endsWith(".jsonl"),
      bytes: before.length,
      sha256: sha256(before),
      identity: beforeIdentity,
      changedRecords: transformed.changedRecords,
      redactions: transformed.redactions,
      bytesAfter: transformed.output.length,
    });
  }
  const generatedAt = nowIso();
  const id = `privacy-remediation-${generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
  const plan = {
    schemaVersion: 1,
    kind: "managed-state-privacy-remediation-preview",
    id,
    generatedAt,
    cwdHash: sha256(cwd),
    preview: true,
    summary: {
      inspectedFiles: files.length,
      inspectedBytes,
      candidateFiles: candidates.length,
      changedRecords: candidates.reduce((sum, item) => sum + item.changedRecords, 0),
      blockedFiles: blocked.length,
      redactions: sortedCounts(candidates.reduce((counts, item) => (addCounts(counts, item.redactions), counts), {})),
    },
    candidates,
    blocked,
  };
  if (options.writeManifest !== false) {
    const manifest = path.join(cwd, ".pi", "privacy-guard", "remediation-previews", `${id}.json`);
    writePrivateJson(manifest, plan);
    plan.manifest = path.relative(cwd, manifest);
  }
  return plan;
}

function readRemediationPlan(cwd, manifestId) {
  if (!/^privacy-remediation-[a-z0-9-]+$/i.test(String(manifestId || ""))) throw new Error("invalid remediation manifest id");
  const file = path.join(cwd, ".pi", "privacy-guard", "remediation-previews", `${manifestId}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe remediation manifest");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validatePreviewContent(candidate, current) {
  if (!candidate.appendOnly) return current.length === candidate.bytes && sha256(current) === candidate.sha256;
  if (current.length < candidate.bytes) return false;
  return sha256(current.subarray(0, candidate.bytes)) === candidate.sha256;
}

function privateBackupFile(backupRoot, relativeFile, content) {
  const file = path.join(backupRoot, relativeFile);
  if (!isWithin(backupRoot, file)) throw new Error("unsafe backup path");
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  return file;
}

function replaceFileAtomically(file, beforeIdentity, current, output) {
  const temporary = `${file}.${process.pid}.${Date.now()}.privacy.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, output);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const latestIdentity = identity(file);
    const latest = fs.readFileSync(file);
    if (!sameIdentity(beforeIdentity, latestIdentity) || latest.length !== current.length || sha256(latest) !== sha256(current)) throw new Error("file changed after remediation preview validation");
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function applyManagedStateRemediation(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  if (options.apply !== true) throw new Error("applyManagedStateRemediation requires apply=true");
  const plan = options.plan || readRemediationPlan(cwd, options.manifestId);
  if (plan.kind !== "managed-state-privacy-remediation-preview" || plan.cwdHash !== sha256(cwd)) throw new Error("remediation preview does not belong to this project");
  if (plan.blocked?.length) throw new Error("remediation preview contains blocked files");
  const backupRoot = ensurePrivateDir(path.join(os.tmpdir(), "pi-managed-state-remediation-backups", sha256(cwd).slice(0, 16), plan.id));
  const actions = [];
  for (const candidate of plan.candidates || []) {
    const file = path.resolve(cwd, candidate.file);
    try {
      if (!isWithin(cwd, file)) throw new Error("candidate escapes project root");
      const currentIdentity = identity(file);
      if (!sameIdentity(candidate.identity, currentIdentity)) throw new Error("file identity changed since preview");
      const current = fs.readFileSync(file);
      if (!validatePreviewContent(candidate, current)) throw new Error("file content changed incompatibly since preview");
      const transformed = transformManagedStateFile(file, current);
      if (transformed.errors.length) throw new Error(transformed.errors[0]);
      if (!transformed.changedRecords) { actions.push({ file: candidate.file, status: "already-sanitized", changedRecords: 0, redactions: {} }); continue; }
      privateBackupFile(backupRoot, candidate.file, current);
      replaceFileAtomically(file, currentIdentity, current, transformed.output);
      actions.push({ file: candidate.file, status: "sanitized", changedRecords: transformed.changedRecords, redactions: transformed.redactions, bytesBefore: current.length, bytesAfter: transformed.output.length });
    } catch (error) {
      actions.push({ file: candidate.file, status: "blocked", reason: error?.message || String(error) });
    }
  }
  const appliedAt = nowIso();
  const result = {
    schemaVersion: 1,
    kind: "managed-state-privacy-remediation-result",
    planId: plan.id,
    appliedAt,
    backupRoot,
    summary: {
      sanitizedFiles: actions.filter((action) => action.status === "sanitized").length,
      changedRecords: actions.reduce((sum, action) => sum + (action.changedRecords || 0), 0),
      blockedFiles: actions.filter((action) => action.status === "blocked").length,
      redactions: sortedCounts(actions.reduce((counts, action) => (addCounts(counts, action.redactions), counts), {})),
    },
    actions,
  };
  const manifest = path.join(cwd, ".pi", "privacy-guard", "remediation-results", `${plan.id}.json`);
  writePrivateJson(manifest, result);
  result.manifest = path.relative(cwd, manifest);
  return result;
}

function formatManagedStateRemediationPlan(plan) {
  const lines = [
    `Managed-state privacy remediation preview ${plan.id}`,
    `inspected files: ${plan.summary.inspectedFiles}`,
    `candidate files: ${plan.summary.candidateFiles}`,
    `changed records: ${plan.summary.changedRecords}`,
    `blocked files: ${plan.summary.blockedFiles}`,
    `redactions: ${JSON.stringify(plan.summary.redactions)}`,
  ];
  for (const item of plan.candidates.slice(0, 40)) lines.push(`- ${item.file}: ${item.changedRecords} records, ${JSON.stringify(item.redactions)}`);
  if (plan.candidates.length > 40) lines.push(`... ${plan.candidates.length - 40} more candidates`);
  for (const item of plan.blocked.slice(0, 20)) lines.push(`BLOCKED ${item.file}: ${item.reason}`);
  return lines.join("\n");
}

module.exports = {
  discoverManagedStateFiles,
  transformManagedStateFile,
  planManagedStateRemediation,
  readRemediationPlan,
  applyManagedStateRemediation,
  formatManagedStateRemediationPlan,
};
