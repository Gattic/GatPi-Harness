"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectIdentity } = require("./project-identity");
const { redactMemoryText } = require("./memory-content-scanner");

const DEFAULT_LIMITS = Object.freeze({
  maxSessions: 120,
  maxFiles: 600,
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxElapsedMs: 750,
  maxResults: 20,
  maxExcerptChars: 600,
});

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function bounded(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback; }
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, " ").trim(); }
function terms(value) { return [...new Set(normalize(value).split(/\s+/).filter((term) => term.length >= 2))].slice(0, 24); }
function isInside(parent, child) { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function safeStat(file) { try { const stat = fs.lstatSync(file); return stat.isSymbolicLink() ? null : stat; } catch { return null; } }
function readSafeText(file, maxBytes) {
  let fd;
  try {
    const before = fs.lstatSync(file); if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.size > maxBytes || Number(opened.dev) !== Number(before.dev) || Number(opened.ino) !== Number(before.ino)) return null;
    const text = fs.readFileSync(fd, "utf8");
    const after = fs.lstatSync(file); if (after.isSymbolicLink() || Number(after.dev) !== Number(opened.dev) || Number(after.ino) !== Number(opened.ino)) return null;
    return text;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sessionRoots(env = process.env) {
  const configured = String(env.PI_SESSION_SEARCH_ROOTS || "").split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  const roots = configured.length ? configured : [path.join(os.homedir(), ".pi", "agent", "sessions")];
  return [...new Set(roots.map((root) => path.resolve(root.replace(/^~(?=$|\/)/, os.homedir()))))];
}
function listSessionFiles(roots, limits, projectRoot) {
  const rows = [];
  const projectPartition = `--${projectRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const descendantPrefix = `${projectPartition.slice(0, -2)}-`;
  const partitionPriority = (name) => name === projectPartition ? 0 : name.startsWith(descendantPrefix) && name.endsWith("--") ? 1 : 2;
  let visited = 0;
  const walk = (target, priority = 2) => {
    if (visited >= limits.maxFiles) return;
    const stat = safeStat(target);
    if (!stat) return;
    if (stat.isFile()) {
      visited += 1;
      if (target.endsWith(".jsonl") && stat.size <= limits.maxFileBytes) rows.push({ file: target, size: stat.size, mtimeMs: stat.mtimeMs, priority });
      return;
    }
    if (!stat.isDirectory()) return;
    let names = [];
    // Pi partitions sessions by encoded cwd and names files by timestamp. Apply
    // project priority before either discovery cap; headers still enforce identity.
    priority = Math.min(priority, partitionPriority(path.basename(target)));
    try { names = fs.readdirSync(target).sort((a, b) => partitionPriority(a) - partitionPriority(b) || b.localeCompare(a)); } catch { return; }
    for (const name of names) { if (visited >= limits.maxFiles) break; walk(path.join(target, name), priority); }
  };
  for (const root of [...roots].sort((a, b) => partitionPriority(path.basename(a)) - partitionPriority(path.basename(b)))) walk(root);
  return { files: rows.sort((a, b) => a.priority - b.priority || b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file)).slice(0, limits.maxSessions), visited, truncated: visited >= limits.maxFiles || rows.length > limits.maxSessions };
}
function parseLine(line) { try { const row = JSON.parse(line); return row && typeof row === "object" && !Array.isArray(row) ? row : null; } catch { return null; } }
function headerProjectMatches(header, projectRoot) {
  if (header?.type !== "session" || !header.cwd) return false;
  let sessionCwd;
  try { sessionCwd = path.resolve(String(header.cwd)); } catch { return false; }
  return isInside(projectRoot, sessionCwd);
}
function allowedMessage(row) {
  if (row?.type !== "message" || !row.message) return null;
  const role = String(row.message.role || "").toLowerCase();
  if (!new Set(["user", "assistant"]).has(role)) return null;
  const content = row.message.content;
  if (typeof content === "string") return { role, text: content };
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const part of content) {
    const type = String(part?.type || "").toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning") || type.includes("tool") || type.includes("image")) continue;
    const text = typeof part === "string" ? part : part?.text;
    if (typeof text === "string") texts.push(text);
  }
  return texts.length ? { role, text: texts.join("\n") } : null;
}
function publicTimestamp(row) { const value = row?.timestamp || row?.message?.timestamp; const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
function sessionId(projectKey, file) { return `session_${sha256(`${projectKey}\0${path.resolve(file)}`).slice(0, 20)}`; }
function anchorId(session, row, lineNumber) { return `anchor_${sha256(`${session}\0${row?.id || row?.message?.id || "message"}\0${lineNumber}`).slice(0, 24)}`; }
function scoreMessage(text, query, queryTerms) {
  const normalized = normalize(text);
  if (!normalized) return null;
  const phrase = normalize(query);
  const matched = queryTerms.filter((term) => normalized.includes(term));
  if (phrase && !normalized.includes(phrase) && matched.length === 0) return null;
  const coverage = queryTerms.length ? matched.length / queryTerms.length : 0;
  const score = (phrase && normalized.includes(phrase) ? 4 : 0) + coverage * 3 + Math.min(1, matched.length / 5);
  return { score, phrase: Boolean(phrase && normalized.includes(phrase)), coverage, matchedTerms: matched.length };
}
function resultLimits(input = {}) {
  return {
    maxSessions: bounded(input.maxSessions, DEFAULT_LIMITS.maxSessions, 1, 500),
    maxFiles: bounded(input.maxFiles, DEFAULT_LIMITS.maxFiles, 1, 5000),
    maxBytes: bounded(input.maxBytes, DEFAULT_LIMITS.maxBytes, 1024, 256 * 1024 * 1024),
    maxFileBytes: bounded(input.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 1024, 32 * 1024 * 1024),
    maxElapsedMs: bounded(input.maxElapsedMs, DEFAULT_LIMITS.maxElapsedMs, 10, 10_000),
    maxResults: bounded(input.maxResults || input.limit, DEFAULT_LIMITS.maxResults, 1, 100),
    maxExcerptChars: bounded(input.maxExcerptChars, DEFAULT_LIMITS.maxExcerptChars, 80, 2000),
  };
}

class SessionSearchAdapter {
  constructor({ enabled = true, cwd = process.cwd(), roots, env = process.env, clock = () => Date.now() } = {}) {
    this.enabled = enabled !== false;
    this.cwd = path.resolve(cwd);
    this.identity = projectIdentity(this.cwd);
    this.roots = roots ? roots.map((root) => path.resolve(root)) : sessionRoots(env);
    this.activeSessionFile = env.PI_SESSION_FILE ? path.resolve(env.PI_SESSION_FILE) : null;
    this.clock = clock;
  }
  search(query, input = {}) { return this.scan({ query, input }); }
  get(anchor, input = {}) { return this.scan({ anchor, input }); }
  scan({ query = null, anchor = null, input = {} } = {}) {
    if (!this.enabled) return { schemaVersion: 1, outcome: "disabled", results: [], truncated: false };
    const queryText = String(query || "").trim();
    if (!anchor && queryText.length < 2) throw new Error("session search query must contain at least two characters");
    if (anchor && !/^anchor_[a-f0-9]{24}$/.test(String(anchor))) throw new Error("invalid session search anchor");
    const limits = resultLimits(input);
    const started = this.clock();
    const queryTerms = terms(queryText);
    const listing = listSessionFiles(this.roots, limits, this.identity.root);
    const results = [];
    const reasons = new Set(listing.truncated ? ["file-limit"] : []);
    let scannedSessions = 0;
    let projectSessions = 0;
    let scannedBytes = 0;
    let parseErrors = 0;
    let excludedActive = 0;
    outer: for (const item of listing.files) {
      if (this.clock() - started >= limits.maxElapsedMs) { reasons.add("time-limit"); break; }
      if (this.activeSessionFile && path.resolve(item.file) === this.activeSessionFile && input.includeActive !== true) { excludedActive += 1; continue; }
      if (scannedBytes + item.size > limits.maxBytes) { reasons.add("byte-limit"); break; }
      const text = readSafeText(item.file, Math.min(limits.maxFileBytes, limits.maxBytes - scannedBytes));
      if (text == null) { parseErrors += 1; continue; }
      scannedBytes += Buffer.byteLength(text);
      scannedSessions += 1;
      const lines = text.split(/\r?\n/);
      const header = parseLine(lines[0]);
      if (!headerProjectMatches(header, this.identity.root)) continue;
      projectSessions += 1;
      const sid = sessionId(this.identity.projectKey, item.file);
      for (let index = 1; index < lines.length; index += 1) {
        if ((index & 31) === 0 && this.clock() - started >= limits.maxElapsedMs) { reasons.add("time-limit"); break outer; }
        if (input.signal?.aborted) { reasons.add("cancelled"); break outer; }
        const row = parseLine(lines[index]);
        if (!row) { if (lines[index]?.trim()) parseErrors += 1; continue; }
        const message = allowedMessage(row);
        if (!message) continue;
        const aid = anchorId(sid, row, index + 1);
        if (anchor && aid !== anchor) continue;
        const ranking = anchor ? { score: 1, phrase: false, coverage: 1, matchedTerms: 0 } : scoreMessage(message.text, queryText, queryTerms);
        if (!ranking) continue;
        const excerpt = redactMemoryText(message.text, { maxChars: limits.maxExcerptChars });
        if (!excerpt) continue;
        results.push({ sessionId: sid, anchorId: aid, role: message.role, timestamp: publicTimestamp(row), excerpt, score: Number(ranking.score.toFixed(4)), phrase: ranking.phrase, coverage: Number(ranking.coverage.toFixed(4)), matchedTerms: ranking.matchedTerms });
        if (anchor) break outer;
      }
    }
    results.sort((a, b) => b.score - a.score || String(b.timestamp || "").localeCompare(String(a.timestamp || "")) || a.anchorId.localeCompare(b.anchorId));
    const truncatedResults = results.length > limits.maxResults;
    if (truncatedResults) reasons.add("result-limit");
    const selected = results.slice(0, limits.maxResults);
    return {
      schemaVersion: 1,
      outcome: anchor && selected.length === 0 ? "not-found" : reasons.has("cancelled") ? "cancelled" : reasons.size ? "partial" : "succeeded",
      queryHash: anchor ? null : `sha256:${sha256(normalize(queryText))}`,
      anchor: anchor || null,
      projectKey: this.identity.projectKey,
      results: selected,
      scannedSessions,
      projectSessions,
      scannedBytes,
      parseErrors,
      excludedActive,
      durationMs: Math.max(0, this.clock() - started),
      truncated: reasons.size > 0,
      truncationReasons: [...reasons].sort(),
      limits: { ...limits },
    };
  }
}

module.exports = {
  DEFAULT_LIMITS,
  sessionRoots,
  resultLimits,
  allowedMessage,
  SessionSearchAdapter,
};
