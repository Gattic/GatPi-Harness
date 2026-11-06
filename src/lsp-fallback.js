"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inferLanguage } = require("./lsp-server-registry.js");

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".cu", ".cuh"]);
// .worktrees holds linked checkouts of the same repository on other branches.
const IGNORE = new Set([".git", ".worktrees", "node_modules", ".pi", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv", "venv", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const MAX_FILE_BYTES = 2_000_000;
function boundedLimit(value, fallback, maximum) { const n = Number(value ?? fallback); return Number.isFinite(n) && n > 0 ? Math.min(maximum, Math.max(1, Math.floor(n))) : fallback; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function wordOffsets(text, symbol, max = Infinity) {
  const offsets = [];
  let at = 0;
  const isWord = (char) => /[A-Za-z0-9_$]/.test(char || "");
  while (offsets.length < max && (at = String(text).indexOf(symbol, at)) >= 0) {
    const end = at + symbol.length;
    if (!isWord(text[at - 1]) && !isWord(text[end])) offsets.push({ index: at, end });
    at = Math.max(end, at + 1);
  }
  return offsets;
}
function offsetToPosition(text, offset) { const rows = text.slice(0, Math.max(0, offset)).split("\n"); return { line: rows.length, column: rows.at(-1).replace(/\r$/, "").length + 1 }; }
function positionToOffset(text, line = 1, column = 1) { const rows = text.split("\n"); let offset = 0; for (let i = 1; i < Math.max(1, line); i++) offset += (rows[i - 1] || "").length + 1; return offset + Math.max(0, column - 1); }
function wordAt(text, offset) { const re = /[A-Za-z_$][\w$]*/g; let match; while ((match = re.exec(text))) if (match.index <= offset && re.lastIndex >= offset) return { word: match[0], start: match.index, end: re.lastIndex }; return null; }
function maskCommentsAndStrings(text) {
  // Keep UTF-16 code-unit offsets (including astral characters) aligned with source/LSP positions.
  const chars = text.split("");
  let quote = null, lineComment = false, blockComment = false, escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], n = chars[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; else chars[i] = " "; continue; }
    if (blockComment) { if (c === "*" && n === "/") { chars[i] = chars[i + 1] = " "; blockComment = false; i++; } else if (c !== "\n" && c !== "\r") chars[i] = " "; continue; }
    if (quote) { if (escaped) { chars[i] = " "; escaped = false; continue; } if (c === "\\") { chars[i] = " "; escaped = true; continue; } if (c === quote) { chars[i] = " "; quote = null; } else if (c !== "\n" && c !== "\r") chars[i] = " "; continue; }
    if (c === "/" && n === "/") { chars[i] = chars[i + 1] = " "; lineComment = true; i++; continue; }
    if (c === "/" && n === "*") { chars[i] = chars[i + 1] = " "; blockComment = true; i++; continue; }
    if (c === "\"" || c === "'" || c === "`") { chars[i] = " "; quote = c; }
  }
  return chars.join("");
}
function normalizeFile(root, value) {
  const raw = String(value || "").replace(/^@/, "");
  if (!raw) throw new Error("LSP file path must not be empty");
  const absolute = path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`LSP file must stay inside project path: ${value}`);
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`LSP fallback does not follow symlinks: ${value}`);
  }
  return relative.split(path.sep).join("/");
}
function readSource(root, file, encoding = "utf8") {
  const full = path.join(root, normalizeFile(root, file));
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`LSP fallback requires a regular file of at most ${MAX_FILE_BYTES} bytes: ${file}`);
  return fs.readFileSync(full, encoding);
}
function listFiles(root, params = {}, maxFiles = 2500, workspace = false) {
  const limit = boundedLimit(params.maxFiles, boundedLimit(maxFiles, 2500, 20000), 20000);
  const out = [], seen = new Set();
  const accepts = (file, stat) => stat.isFile() && stat.size <= MAX_FILE_BYTES && SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) && (!params.language || inferLanguage(file) === params.language);
  function admit(file, stat) {
    if (out.length < limit && !seen.has(file) && accepts(file, stat)) { seen.add(file); out.push(file); }
  }
  // Seed explicit requests BEFORE walking/capping. Validate even capped-out explicit paths.
  const explicit = [params.file, ...(params.files || [])].filter(Boolean).map((file) => normalizeFile(root, file));
  for (const file of explicit) admit(file, fs.lstatSync(path.join(root, file)));
  if ((!workspace && params.file) || params.files?.length) return out;
  function walk(relative) {
    if (out.length >= limit) return;
    let names = [];
    try { names = fs.readdirSync(path.join(root, relative)); } catch { return; }
    for (const name of names.sort()) {
      if (IGNORE.has(name)) continue;
      const file = relative ? `${relative}/${name}` : name;
      let stat;
      try { stat = fs.lstatSync(path.join(root, file)); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(file);
      else admit(file, stat);
      if (out.length >= limit) break;
    }
  }
  walk("");
  return out;
}
function declarationMatches(text, symbol, typed = true) {
  const matches = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    // Horizontal whitespace only: every line is visited once, never retried from
    // successive blank lines. Modifier and keyword tokens have disjoint boundaries.
    const match = /^[ \t]*(?:(?:export|pub|public|private|protected|static|async|default|extern|inline)[ \t]+)*(?:function|class|const|let|var|def|type|struct|enum|fn|interface)[ \t]+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      match.index += offset;
      if (!symbol || match[1] === symbol) matches.push(match);
    }
    if (typed) {
      // Deterministic C-like declaration approximation. Split the prefix once;
      // do not partition overlapping repetitions of word/space characters.
      const paren = line.indexOf("(");
      if (paren >= 0) {
        const tokens = line.slice(0, paren).trim().split(/[ \t]+/);
        const name = tokens.at(-1);
        if (name !== match?.[1] && tokens.length >= 2 && /^[A-Za-z_$][\w$]*$/.test(name) && tokens.slice(0, -1).every((token) => /^[A-Za-z_$][\w$<>:*&\[\]]*$/.test(token)) && (!symbol || name === symbol)) {
          matches.push({ 0: line.slice(0, paren + 1), 1: name, index: offset });
        }
      }
    }
    offset += line.length + 1;
  }
  const exportsPattern = /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)[ \t]*=/g;
  let match;
  while ((match = exportsPattern.exec(text))) if (!symbol || match[1] === symbol) matches.push(match);
  return matches.sort((a, b) => a.index - b.index);
}
function symbolFromMatch(file, text, symbol, match, kind = "definition") {
  const start = match.index + (text[match.index] === "\n" ? 1 : 0);
  const end = Math.max(start + symbol.length, match.index + match[0].length);
  return { file, name: symbol, kind, loc: { start: offsetToPosition(text, start), end: offsetToPosition(text, end) }, range: { start, end }, preview: text.slice(start, Math.min(end, start + 500)).split(/\r?\n/).slice(0, 3).join("\n") };
}
function inferSymbol(root, params) {
  if (params.file) normalizeFile(root, params.file);
  if (params.symbol) return String(params.symbol);
  if (!params.file) throw new Error("symbol or file+line+column is required");
  const file = normalizeFile(root, params.file);
  const text = readSource(root, file);
  const found = wordAt(text, positionToOffset(text, Number(params.line || 1), Number(params.column || 1)));
  if (!found) throw new Error(`No symbol found at ${file}:${params.line || 1}:${params.column || 1}`);
  return found.word;
}
function createFallbackProvider(options = {}) {
  const maxFiles = boundedLimit(options.maxFiles, 2500, 20000);
  const maxResults = boundedLimit(options.maxResults, 200, 2000);
  const base = { backend: "fallback", capabilities: ["symbols", "definition", "references", "hover", "renamePreview"], freshness: "unknown", gatingSafe: false, advisory: true };
  function symbols(root, params = {}) {
    const files = listFiles(root, params, params.maxFiles || maxFiles);
    const rows = [];
    const requested = String(params.query || params.symbol || "").trim();
    const limit = boundedLimit(params.maxResults, maxResults, 2000);
    for (const file of files) {
      const text = readSource(root, file);
      const masked = maskCommentsAndStrings(text);
      for (const match of declarationMatches(masked, requested, false)) {
        if (rows.length >= limit) break;
        rows.push(symbolFromMatch(file, text, match[1], match, "symbol"));
      }
      if (rows.length >= limit) break;
    }
    const degradation = requested && rows.length === 0
      ? { code: "advisory_no_match", message: `No exact lexical symbol match was found for ${requested}.`, retryable: false }
      : { code: "lexical_fallback", message: "Symbols are exact lexical declarations, not compiler-resolved symbols.", retryable: false };
    return { ...base, projectPath: root, filesScanned: files.length, query: requested || null, matchPolicy: requested ? "exact-symbol" : "all-declarations", symbols: rows, truncated: rows.length >= limit, degradation };
  }
  function definition(root, params = {}) {
    const symbol = inferSymbol(root, params);
    const files = listFiles(root, params, maxFiles, true);
    const definitions = [];
    const limit = boundedLimit(params.maxResults, 20, 2000);
    for (const file of files) {
      const text = readSource(root, file);
      const masked = maskCommentsAndStrings(text);
      for (const match of declarationMatches(masked, symbol)) {
        if (definitions.length >= limit) break;
        definitions.push(symbolFromMatch(file, text, symbol, match));
      }
      if (definitions.length >= limit) break;
    }
    return { ...base, projectPath: root, symbol, definitions, degradation: { code: "lexical_fallback", message: "Definitions are lexical declaration matches, not compiler-resolved.", retryable: false } };
  }
  function references(root, params = {}) {
    const symbol = inferSymbol(root, params);
    const files = listFiles(root, params, maxFiles, true);
    const references = [];
    const limit = boundedLimit(params.maxResults, maxResults, 2000);
    for (const file of files) {
      const text = readSource(root, file);
      const lines = text.split(/\r?\n/);
      const masked = maskCommentsAndStrings(text);
      const remaining = Math.max(0, limit - references.length);
      for (const match of wordOffsets(masked, symbol, remaining)) {
        const start = offsetToPosition(text, match.index);
        references.push({ file, symbol, loc: { start, end: offsetToPosition(text, match.end) }, range: { start: match.index, end: match.end }, preview: (lines[start.line - 1] || "").trim().slice(0, 500) });
      }
      if (references.length >= limit) break;
    }
    return { ...base, projectPath: root, symbol, references, truncated: references.length >= limit, degradation: { code: "lexical_fallback", message: "References exclude obvious comments/strings but are not scope-resolved.", retryable: false } };
  }
  function hover(root, params = {}) {
    if (!params.file) throw new Error("file is required for hover");
    const file = normalizeFile(root, params.file);
    const text = readSource(root, file);
    const found = wordAt(text, positionToOffset(text, Number(params.line || 1), Number(params.column || 1)));
    if (!found) return { ...base, projectPath: root, file, hover: null };
    const result = definition(root, { ...params, symbol: found.word, maxResults: 5 });
    const line = offsetToPosition(text, found.start).line;
    return { ...base, projectPath: root, file, symbol: found.word, location: offsetToPosition(text, found.start), context: text.split(/\r?\n/).slice(Math.max(0, line - 4), line + 3).map((row) => row.slice(0, 500)).join("\n"), definitions: result.definitions, degradation: { code: "lexical_fallback", message: "Hover is local source context, not resolved type data.", retryable: false } };
  }
  function renamePreview(root, params = {}) {
    const symbol = inferSymbol(root, params);
    const newName = String(params.newName || "");
    if (!/^[A-Za-z_$][\w$]*$/.test(newName)) throw new Error(`Invalid newName for lexical rename: ${newName}`);
    const refs = references(root, { ...params, symbol, maxResults: params.maxResults || maxResults });
    const byFile = new Map();
    for (const ref of refs.references) { const rows = byFile.get(ref.file) || []; rows.push({ range: ref.range, loc: ref.loc, newText: newName }); byFile.set(ref.file, rows); }
    const changes = Array.from(byFile, ([file, edits]) => ({ file, expectedHash: sha256(readSource(root, file, null)), edits: edits.sort((a, b) => b.range.start - a.range.start) }));
    return { ...base, projectPath: root, operation: "renamePreview", symbol, newName, applied: false, changes, degradation: { code: "fallback_preview_only", message: "Fallback rename cannot be applied automatically.", retryable: false } };
  }
  return { backend: "fallback", capabilities: base.capabilities, symbols, definition, references, hover, renamePreview, inferSymbol, listFiles };
}

module.exports = { SOURCE_EXTENSIONS, maskCommentsAndStrings, offsetToPosition, positionToOffset, wordAt, normalizeFile, listFiles, createFallbackProvider };
