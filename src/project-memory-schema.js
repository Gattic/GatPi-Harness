"use strict";

const crypto = require("node:crypto");
const { SECRET_PATTERNS: MEMORY_SECRET_SPECS, TRANSCRIPT_PATTERNS, LOCAL_PATH_PATTERN, scanMemoryContent } = require("./memory-content-scanner");

const MEMORY_SCHEMA_VERSION = 1;
const MEMORY_KINDS = Object.freeze(["current", "decision", "constraint", "risk", "verification", "procedure", "history"]);
const WRITABLE_KINDS = Object.freeze(MEMORY_KINDS.filter((kind) => kind !== "current"));
const VERIFICATION_STATES = Object.freeze(["verified", "corroborated", "inferred", "unverified", "contradicted"]);
const NOTE_FILES = Object.freeze({ current: "Current.md", decision: "Decisions.md", constraint: "Constraints.md", risk: "Risks-and-TODOs.md", verification: "Verification.md", procedure: "Procedures.md", history: "History/History.md" });
const VERIFICATION_RANK = Object.freeze({ contradicted: 0, unverified: 1, inferred: 2, corroborated: 3, verified: 4 });
const SECRET_PATTERNS = Object.freeze(MEMORY_SECRET_SPECS.map((item) => item.pattern));

function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function normalizeText(value) { return String(value || "").trim().replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n"); }
function normalizeKey(value) { return normalizeText(value).toLowerCase().replace(/\s+/g, " "); }
function boundedStrings(values, pattern, max = 64) { return [...new Set((Array.isArray(values) ? values : values ? [values] : []).map(String).filter((value) => pattern.test(value)).slice(0, max))].sort(); }
function safeIso(value) { const ms = Date.parse(String(value || "")); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
function yamlScalar(value) { if (value === null) return "null"; if (typeof value === "number" || typeof value === "boolean") return String(value); return JSON.stringify(String(value)); }

function forbiddenReasons(value) {
  const scan = scanMemoryContent(value, { maxChars: 20_000 });
  const reasons = scan.blockingReasons.map((reason) => {
    if (["private-key", "provider-token", "credential-assignment", "aws-access-key", "high-entropy-credential"].includes(reason)) return "sensitive";
    if (reason === "transcript-payload") return "full-transcript";
    if (reason === "absolute-local-path") return "local-path";
    return reason;
  });
  return [...new Set(reasons)];
}

function normalizeCandidate(input = {}, options = {}) {
  const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : "history";
  const title = normalizeText(input.title || "Untitled memory").slice(0, 160);
  const content = normalizeText(input.content || input.body || "").slice(0, 20_001);
  const verification = VERIFICATION_STATES.includes(input.verification) ? input.verification : "unverified";
  const now = safeIso(input.updatedAt || options.now || new Date()) || new Date().toISOString();
  const sourceFingerprints = boundedStrings(input.sourceFingerprints, /^[A-Za-z0-9_.:+-]{1,160}$/);
  const evidenceIds = boundedStrings(input.evidenceIds, /^[A-Za-z0-9_.:+-]{1,160}$/);
  const supersedes = boundedStrings(input.supersedes, /^[A-Za-z0-9_.:-]{1,160}$/);
  const contradicts = boundedStrings(input.contradicts, /^[A-Za-z0-9_.:-]{1,160}$/);
  const expiresAt = input.expiresAt == null ? null : safeIso(input.expiresAt);
  const expiryInvalid = input.expiresAt != null && expiresAt == null;
  const normalized = normalizeKey(`${kind}\n${title}\n${content}`);
  return {
    memorySchema: MEMORY_SCHEMA_VERSION,
    kind,
    title,
    content,
    verification,
    standing: input.standing === true,
    sourceFingerprints,
    evidenceIds,
    expiresAt,
    expiryInvalid,
    supersedes,
    contradicts,
    updatedAt: now,
    candidateHash: sha256(normalized),
    titleHash: sha256(normalizeKey(title)),
  };
}
function validateCandidate(candidate, { allowCurrent = false } = {}) {
  const issues = [];
  if (!MEMORY_KINDS.includes(candidate.kind)) issues.push("invalid-kind");
  if (!allowCurrent && candidate.kind === "current") issues.push("current-is-projection");
  if (!candidate.title) issues.push("missing-title");
  if (!candidate.content) issues.push("missing-content");
  if (!VERIFICATION_STATES.includes(candidate.verification)) issues.push("invalid-verification");
  if (candidate.standing && !["constraint", "procedure", "decision"].includes(candidate.kind)) issues.push("invalid-standing-kind");
  if (candidate.standing && !["verified", "corroborated"].includes(candidate.verification)) issues.push("invalid-standing-verification");
  issues.push(...forbiddenReasons(`${candidate.title}\n${candidate.content}`));
  if (candidate.expiresAt === undefined || candidate.expiryInvalid) issues.push("invalid-expiry");
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}
function projectFolderName(identity) { return `${identity.name}-${identity.rootHash}`; }
function noteFileForKind(kind) { if (!NOTE_FILES[kind]) throw new Error(`unsupported memory kind: ${kind}`); return NOTE_FILES[kind]; }
function frontmatter(fields = {}) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(yamlScalar).join(", ")}]`);
    else lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}
function noteFrontmatter({ projectKey, kind, updatedAt, contentHash, verification = "mixed", sourceFingerprints = [], evidenceIds = [], expiresAt = null, supersedes = [] }) {
  return frontmatter({ memory_schema: MEMORY_SCHEMA_VERSION, project_key: projectKey, memory_kind: kind, updated_at: updatedAt, content_hash: contentHash, verification, source_fingerprints: sourceFingerprints, evidence_ids: evidenceIds, expires_at: expiresAt, supersedes });
}
function parseFrontmatter(text) {
  const value = String(text || "");
  if (!value.startsWith("---\n")) return { fields: {}, body: value };
  const end = value.indexOf("\n---\n", 4);
  if (end < 0) return { fields: {}, body: value };
  const fields = {};
  for (const line of value.slice(4, end).split("\n")) {
    const index = line.indexOf(":"); if (index < 0) continue;
    const key = line.slice(0, index).trim(); const raw = line.slice(index + 1).trim();
    try { fields[key] = raw.startsWith("[") || raw.startsWith("\"") || raw === "null" || raw === "true" || raw === "false" || /^\d+$/.test(raw) ? JSON.parse(raw) : raw; }
    catch { fields[key] = raw; }
  }
  return { fields, body: value.slice(end + 5) };
}

module.exports = { MEMORY_SCHEMA_VERSION, MEMORY_KINDS, WRITABLE_KINDS, VERIFICATION_STATES, VERIFICATION_RANK, NOTE_FILES, SECRET_PATTERNS, TRANSCRIPT_PATTERNS, sha256, normalizeText, normalizeKey, forbiddenReasons, normalizeCandidate, validateCandidate, projectFolderName, noteFileForKind, noteFrontmatter, parseFrontmatter, safeIso };
