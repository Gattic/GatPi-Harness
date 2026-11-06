"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MEMORY_KINDS, VERIFICATION_STATES, safeIso } = require("./project-memory-schema");

const ACTIONS = new Set(["saved", "updated", "deduped", "review-queued", "rejected", "superseded", "shadowed", "pinned", "unpinned"]);
const REASONS = new Set(["operator-capture", "capture-policy", "capture-capacity", "speculative", "verified-durable", "explicit-save", "explicit-standing", "duplicate", "transient", "unverified", "sensitive", "full-transcript", "local-path", "oversized", "invisible-control", "bidirectional-control", "stored-prompt-injection", "exfiltration-instruction", "embedded-data-uri", "encoded-payload", "high-entropy-credential", "stale", "conflict", "integrity", "policy", "shadow-mode", "invalid"]);
function idFor(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }
function ensurePrivateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe project-memory state directory: ${dir}`); fs.chmodSync(dir, 0o700); }
function appendPrivate(file, row) {
  ensurePrivateDir(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile()) throw new Error(`unsafe project-memory ledger: ${file}`); fs.fchmodSync(fd, 0o600); fs.writeSync(fd, `${JSON.stringify(row)}\n`); }
  finally { fs.closeSync(fd); }
}
function writePrivateJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); }
  finally { fs.closeSync(fd); }
  try { const current = fs.lstatSync(file); if (current.isSymbolicLink() || !current.isFile()) throw new Error(`unsafe project-memory state file: ${file}`); } catch (error) { if (error?.code !== "ENOENT") { fs.rmSync(temporary, { force: true }); throw error; } }
  fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } }

class ProjectMemoryDecisionStore {
  constructor({ cwd = process.cwd(), dir, clock = () => new Date() } = {}) {
    this.cwd = cwd; this.dir = dir || path.join(cwd, ".pi", "project-memory"); this.clock = clock;
    this.ledgerFile = path.join(this.dir, "decisions.jsonl"); this.stateFile = path.join(this.dir, "state.json");
  }
  normalize(input = {}) {
    const at = safeIso(input.at || this.clock()) || new Date().toISOString();
    const action = ACTIONS.has(input.action) ? input.action : "rejected";
    const reason = REASONS.has(input.reason) ? input.reason : "invalid";
    const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : "history";
    const verification = VERIFICATION_STATES.includes(input.verification) ? input.verification : "unverified";
    const row = {
      schemaVersion: 1,
      projectKey: String(input.projectKey || "unknown").slice(0, 200),
      kind,
      action,
      reason,
      candidateHash: /^sha256:[a-f0-9]{64}$/.test(String(input.candidateHash || "")) ? String(input.candidateHash) : null,
      noteRevision: /^[a-f0-9]{64}$/.test(String(input.noteRevision || "")) ? String(input.noteRevision) : null,
      sourceFingerprints: [...new Set((input.sourceFingerprints || []).map(String).filter((x) => /^[A-Za-z0-9_.:+-]{1,160}$/.test(x)))].sort(),
      evidenceIds: [...new Set((input.evidenceIds || []).map(String).filter((x) => /^[A-Za-z0-9_.:+-]{1,160}$/.test(x)))].sort(),
      verification,
      at,
    };
    row.decisionId = `memdec_${idFor(row)}`;
    return row;
  }
  record(input = {}) {
    const row = this.normalize(input); appendPrivate(this.ledgerFile, row);
    const previous = this.status();
    const next = { schemaVersion: 1, projectKey: row.projectKey, lastAttempt: { decisionId: row.decisionId, action: row.action, reason: row.reason, at: row.at }, lastSuccessful: previous.lastSuccessful || null, canonicalRevision: previous.canonicalRevision || null, reviewBacklog: Number(previous.reviewBacklog || 0) };
    if (["saved", "updated", "superseded", "pinned", "unpinned"].includes(row.action)) { next.lastSuccessful = { decisionId: row.decisionId, action: row.action, at: row.at, noteRevision: row.noteRevision }; if (row.noteRevision) next.canonicalRevision = row.noteRevision; }
    if (row.action === "review-queued") next.reviewBacklog++;
    writePrivateJson(this.stateFile, next);
    return row;
  }
  status() { return readJson(this.stateFile, { schemaVersion: 1, lastAttempt: null, lastSuccessful: null, canonicalRevision: null, reviewBacklog: 0 }); }
  list({ limit = 100, action } = {}) { const rows = readJsonl(this.ledgerFile).filter((row) => !action || row.action === action); return Number.isFinite(limit) ? rows.slice(-Math.max(0, limit)) : rows; }
}

module.exports = { ACTIONS, REASONS, ProjectMemoryDecisionStore, ensurePrivateDir, appendPrivate, writePrivateJson, readJsonl };
