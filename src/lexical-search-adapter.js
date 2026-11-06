"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { createCard, createRetrievalEnvelope, sourceKindForPath } = require("./code-context-contracts.js");
const { workingTreeRevision, revisionId } = require("./code-context-revision.js");

function clamp(value, fallback, max) { const number = Number(value); return Math.max(1, Math.min(max, Number.isFinite(number) ? Math.floor(number) : fallback)); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function isInside(root, file) { const relative = path.relative(root, file); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); }
function normalizeSearchPath(root, value) {
  const absolute = path.resolve(root, String(value || ".").replace(/^@/, ""));
  if (!isInside(root, absolute)) throw new Error(`search path must stay inside project root: ${value}`);
  return path.relative(root, absolute).replace(/\\/g, "/") || ".";
}
function hasIdentifier(text, identifier) {
  const isWord = (char) => /[A-Za-z0-9_$]/.test(char || "");
  let offset = 0;
  while ((offset = String(text).indexOf(identifier, offset)) >= 0) {
    const end = offset + identifier.length;
    if (!isWord(text[offset - 1]) && !isWord(text[end])) return true;
    offset = Math.max(end, offset + 1);
  }
  return false;
}
function cursorEncode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function cursorDecode(value) { try { return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")); } catch { throw new Error("invalid lexical search cursor"); } }
function parseRgJson(stdout, root) {
  const matches = [];
  const errors = [];
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch (error) { errors.push(`invalid rg json: ${error.message}`); continue; }
    if (event.type !== "match") continue;
    const data = event.data || {};
    const file = normalizeSearchPath(root, data.path?.text || "");
    const lineText = String(data.lines?.text || "").replace(/[\r\n]+$/, "");
    for (const submatch of data.submatches || []) {
      matches.push({ path: file, line: Number(data.line_number || 1), start: Number(submatch.start || 0), end: Number(submatch.end || submatch.start || 0), matchedText: String(submatch.match?.text || ""), snippet: lineText });
    }
  }
  return { matches, errors };
}
function classifyScore(match, query, mode) {
  const text = String(match.matchedText || "");
  const snippet = String(match.snippet || "");
  const exact = text === query;
  const identifier = /^[A-Za-z_$][\w$]*$/.test(query);
  let score = exact ? 0.96 : text.toLowerCase() === query.toLowerCase() ? 0.88 : snippet.toLowerCase().includes(query.toLowerCase()) ? 0.72 : 0.55;
  const reasons = [exact ? "exact_match" : "lexical_match"];
  if (identifier && hasIdentifier(snippet, query)) { score += 0.03; reasons.push("exact_identifier"); }
  if (/error|exception|failed|config|setting|env/i.test(query)) { score += 0.01; reasons.push("error_or_config_term"); }
  if (/comment|todo|fixme/.test(snippet.toLowerCase())) { score -= 0.12; reasons.push("comment_penalty"); }
  const sourceKind = sourceKindForPath(match.path);
  if (sourceKind !== "first_party") { score -= 0.25; reasons.push(`${sourceKind}_penalty`); }
  if (mode === "regex") reasons.push("regex_query");
  return { score: Math.max(0, Math.min(1, score)), reasons, sourceKind };
}
function dedupeAndRank(matches, query, mode, revision) {
  const seen = new Set();
  const cards = [];
  for (const match of matches) {
    const key = `${match.path}:${match.line}:${match.start}:${match.end}:${match.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ranked = classifyScore(match, query, mode);
    cards.push(createCard({ provider: "ripgrep", strategyId: `lexical:${mode}`, revision, path: match.path, sourceKind: ranked.sourceKind, kind: "text", range: { startLine: match.line, startColumn: match.start + 1, endLine: match.line, endColumn: match.end + 1 }, snippet: match.snippet, signature: match.matchedText, score: ranked.score, scoreReasons: ranked.reasons, contentHash: sha256(match.snippet), freshness: "fresh", gatingSafe: true, provenance: [{ provider: "ripgrep", operation: "search" }] }));
  }
  return cards.sort((a, b) => Number(b.score) - Number(a.score) || a.path.localeCompare(b.path) || a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn || a.id.localeCompare(b.id));
}
function buildArgs(root, params, internalLimit) {
  const query = String(params.query || "");
  if (!query) throw new Error("query is required");
  const mode = params.mode || "fixed";
  const paths = params.paths?.length ? params.paths : ["."];
  const extensionSourceOnly = paths.every((searchPath) => { const normalized = normalizeSearchPath(root, searchPath); return normalized === ".pi/extensions" || normalized.startsWith(".pi/extensions/"); });
  const args = ["--json", "--line-number", "--column", "--color", "never", "--max-count", String(internalLimit), "--glob", "!.git/**", "--glob", "!node_modules/**"];
  if (extensionSourceOnly) args.push("--hidden"); else args.push("--glob", "!.pi/**");
  if (mode === "fixed" || mode === "identifier" || mode === "fuzzy") args.push("--fixed-strings");
  if (mode === "identifier") args.push("--word-regexp");
  if (params.caseSensitive === false) args.push("--ignore-case");
  for (const language of params.languages || []) {
    const globs = { javascript: "*.{js,jsx,mjs,cjs}", typescript: "*.{ts,tsx,mts,cts}", python: "*.py", cpp: "*.{c,cc,cpp,cxx,h,hh,hpp}", c: "*.{c,h}", cuda: "*.{cu,cuh}", go: "*.go", rust: "*.rs" }[language];
    if (globs) args.push("--glob", globs);
  }
  args.push(query);
  for (const searchPath of paths) args.push(normalizeSearchPath(root, searchPath));
  return { args, mode };
}
function runRg(root, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(options.bin || "rg", args, { cwd: root, encoding: "utf8", timeout: options.timeoutMs || 30000, maxBuffer: options.maxBuffer || 20 * 1024 * 1024, signal: options.signal, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }, (error, stdout = "", stderr = "") => {
      if (!error || error.code === 1) return resolve({ ok: true, stdout, stderr, code: error?.code || 0 });
      if (error.name === "AbortError" || error.code === "ABORT_ERR") return reject(error);
      const failure = new Error(`ripgrep failed: ${String(stderr || error.message).trim()}`);
      failure.code = error.code || "RG_FAILED";
      reject(failure);
    });
  });
}
function createLexicalSearchAdapter(overrides = {}) {
  const config = { bin: overrides.bin || process.env.PI_CODE_CONTEXT_RG_BIN || "rg", timeoutMs: Number(overrides.timeoutMs || process.env.PI_CODE_CONTEXT_RG_TIMEOUT_MS || 30000), maxBuffer: Number(overrides.maxBuffer || 20 * 1024 * 1024), internalLimit: clamp(overrides.internalLimit || process.env.PI_CODE_CONTEXT_RG_INTERNAL_LIMIT, 2000, 20000), defaultLimit: clamp(overrides.defaultLimit || process.env.PI_CODE_CONTEXT_SEARCH_LIMIT, 15, 100) };
  async function search(root, params = {}, signal) {
    const projectPath = path.resolve(root);
    const started = Date.now();
    const limit = clamp(params.limit, config.defaultLimit, 100);
    const { args, mode } = buildArgs(projectPath, params, config.internalLimit);
    const run = await runRg(projectPath, args, { ...config, signal });
    const parsed = parseRgJson(run.stdout, projectPath);
    const revision = revisionId(workingTreeRevision(projectPath, { configuration: params.configuration }));
    let cards = dedupeAndRank(parsed.matches, String(params.query), mode, revision);
    const allowedKinds = new Set(params.sourceKinds || ["first_party"]);
    if (params.includeGenerated) allowedKinds.add("generated");
    if (params.includeVendored) allowedKinds.add("vendored");
    cards = cards.filter((card) => allowedKinds.has(card.sourceKind));
    if (params.distinctPaths === true) { const paths = new Set(); cards = cards.filter((card) => { if (paths.has(card.path)) return false; paths.add(card.path); return true; }); }
    const cursor = params.cursor ? cursorDecode(params.cursor) : { offset: 0, queryHash: sha256(JSON.stringify({ query: params.query, mode, paths: params.paths || ["."], distinctPaths: params.distinctPaths === true })).slice(0, 16) };
    const expectedHash = sha256(JSON.stringify({ query: params.query, mode, paths: params.paths || ["."], distinctPaths: params.distinctPaths === true })).slice(0, 16);
    if (cursor.queryHash !== expectedHash) throw new Error("lexical search cursor does not match query");
    const offset = Math.max(0, Number(cursor.offset || 0));
    const page = cards.slice(offset, offset + limit);
    let rawOutputPath;
    if (params.persistRaw === true) {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-code-context-rg-"));
      rawOutputPath = path.join(dir, "rg.jsonl");
      await fsp.writeFile(rawOutputPath, run.stdout, { mode: 0o600 });
    }
    const envelope = createRetrievalEnvelope({ provider: "ripgrep", query: params.query, strategyId: `lexical:${mode}`, revision, configuration: params.configuration, freshness: "fresh", gatingSafe: true, items: page, elapsedMs: Date.now() - started, candidatesRetrieved: cards.length, bytesRetrieved: Buffer.byteLength(run.stdout), tokensRetrieved: Math.ceil(Buffer.byteLength(run.stdout) / 4), tokensReturned: Math.ceil(Buffer.byteLength(JSON.stringify(page)) / 4), truncated: offset + limit < cards.length, degradation: parsed.errors.length ? { code: "malformed_rg_output", message: parsed.errors.join("; ") } : null });
    envelope.cursor = offset + limit < cards.length ? cursorEncode({ offset: offset + limit, queryHash: expectedHash }) : null;
    envelope.rawOutputPath = rawOutputPath;
    envelope.backend = "ripgrep";
    return envelope;
  }
  return { config, search };
}

module.exports = { createLexicalSearchAdapter, parseRgJson, dedupeAndRank, classifyScore, normalizeSearchPath, cursorEncode, cursorDecode, runRg };
