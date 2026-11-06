"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { LspFallbackRunner } = require("./lsp-fallback-runner.js");
const { inferLanguage: registryInferLanguage, serverRegistry } = require("./lsp-server-registry.js");
const { LspSessionManager, classifyFailure } = require("./lsp-session-manager.js");
const { previewWorkspaceEdit, applyWorkspaceEdit } = require("./semantic-editor.js");
const { readChangeSet } = require("./code-context-revision.js");
const { normalizeDiagnostics } = require("./diagnostic-normalizer.js");

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".json"]);
// .worktrees holds linked checkouts of the same repository on other branches;
// workspace-wide symbol scans must not mix branches.
const DEFAULT_IGNORE = new Set([".git", ".worktrees", "node_modules", ".pi", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv", "venv"]);

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function configFromEnv(env = process.env, overrides = {}) {
  return {
    enabled: env.PI_LSP !== "0",
    timeoutMs: clampNumber(Number(overrides.timeoutMs || env.PI_LSP_TIMEOUT_MS || 30000), 1000, 10 * 60 * 1000),
    diagnosticTimeoutMs: clampNumber(Number(overrides.diagnosticTimeoutMs || env.PI_LSP_DIAGNOSTIC_TIMEOUT_MS || env.PI_LSP_TIMEOUT_MS || 30000), 1000, 10 * 60 * 1000),
    maxBuffer: clampNumber(Number(overrides.maxBuffer || env.PI_LSP_MAX_BUFFER || 10 * 1024 * 1024), 1024 * 1024, 100 * 1024 * 1024),
    allowOutsideCwd: overrides.allowOutsideCwd != null ? Boolean(overrides.allowOutsideCwd) : env.PI_LSP_ALLOW_OUTSIDE === "1",
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_LSP_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_LSP_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    maxFiles: clampNumber(Number(overrides.maxFiles || env.PI_LSP_MAX_FILES || 2500), 1, 20000),
    maxResults: clampNumber(Number(overrides.maxResults || env.PI_LSP_MAX_RESULTS || 200), 1, 2000),
    live: overrides.live != null ? Boolean(overrides.live) : env.PI_LSP_LIVE !== "0",
  };
}
function stripAt(value) {
  const text = String(value || "").trim();
  return text.startsWith("@") ? text.slice(1) : text;
}
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function resolveProjectPath(ctx, inputPath, config = configFromEnv()) {
  const raw = stripAt(inputPath) || ".";
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const absolute = path.resolve(cwd, raw);
  if (!config.allowOutsideCwd && (!isInside(cwd, absolute) || !isInside(fs.realpathSync(cwd), fs.realpathSync(absolute)))) {
    throw new Error(`LSP project path must stay inside cwd (${cwd}). Set PI_LSP_ALLOW_OUTSIDE=1 to allow ${absolute}.`);
  }
  return absolute;
}
function normalizeProjectFile(projectPath, file) {
  const raw = stripAt(file);
  if (!raw) throw new Error("LSP file path must not be empty");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  if (!isInside(projectPath, absolute)) throw new Error(`LSP file must stay inside project path: ${file}`);
  return path.relative(projectPath, absolute).replace(/\\/g, "/");
}
function stripAnsi(text) { return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ""); }
function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}
function truncateHead(text, options = {}) {
  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const value = String(text || "");
  const lines = value.split(/\r?\n/);
  const totalBytes = Buffer.byteLength(value, "utf8");
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength((out.length ? "\n" : "") + line, "utf8");
    if (out.length >= maxLines || (out.length && bytes + lineBytes > maxBytes)) break;
    if (!out.length && lineBytes > maxBytes) {
      let acc = "";
      for (const ch of line) {
        if (Buffer.byteLength(acc + ch, "utf8") > maxBytes) break;
        acc += ch;
      }
      out.push(acc);
      bytes = Buffer.byteLength(acc, "utf8");
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  return { content: out.join("\n"), truncated: out.length < lines.length || bytes < totalBytes, outputLines: out.length, totalLines: lines.length, outputBytes: bytes, totalBytes };
}
function executableInfo(bin, env = process.env) {
  const hasSep = bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin);
  const candidates = hasSep ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin, found: true, path: candidate }; } catch {}
  }
  return { bin, found: false, path: hasSep ? path.resolve(bin) : null };
}
function envReport(env = process.env) {
  return {
    PI_LSP: env.PI_LSP ?? null,
    PI_LSP_TIMEOUT_MS: env.PI_LSP_TIMEOUT_MS ?? null,
    PI_LSP_DIAGNOSTIC_TIMEOUT_MS: env.PI_LSP_DIAGNOSTIC_TIMEOUT_MS ?? null,
    PI_LSP_MAX_BUFFER: env.PI_LSP_MAX_BUFFER ?? null,
    PI_LSP_MAX_LINES: env.PI_LSP_MAX_LINES ?? null,
    PI_LSP_MAX_BYTES: env.PI_LSP_MAX_BYTES ?? null,
    PI_LSP_ALLOW_OUTSIDE: env.PI_LSP_ALLOW_OUTSIDE ?? null,
    PI_LSP_MAX_FILES: env.PI_LSP_MAX_FILES ?? null,
    PI_LSP_MAX_RESULTS: env.PI_LSP_MAX_RESULTS ?? null,
    PI_LSP_LIVE: env.PI_LSP_LIVE ?? null,
  };
}
function shellQuote(arg) {
  const text = String(arg);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
function commandText(command, args = []) { return [command, ...args].map(shellQuote).join(" "); }
function stable(value) { if (value == null || typeof value !== "object") return value; if (Array.isArray(value)) return value.map(stable); return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])])); }
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex"); }
function liveRenamePreviewHash(projectPath, preview = {}) { return sha256({ schemaVersion: 1, projectRootHash: sha256(path.resolve(projectPath)), backend: preview.backend, server: preview.server, symbol: preview.symbol || null, newName: preview.newName, workspaceEdit: preview.workspaceEdit, expectedHashes: preview.expectedHashes }); }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(file) { try { return fs.statSync(file).isDirectory(); } catch { return false; } }
function inferLanguage(file) { return registryInferLanguage(file); }
function languageExtensions(language) {
  if (language === "typescript") return [".ts", ".tsx", ".mts", ".cts"];
  if (language === "javascript") return [".js", ".jsx", ".mjs", ".cjs"];
  if (language === "python") return [".py"];
  if (language === "go") return [".go"];
  if (language === "rust") return [".rs"];
  return Array.from(SOURCE_EXTENSIONS);
}
function walkFiles(projectPath, options = {}) {
  const maxFiles = options.maxFiles || configFromEnv().maxFiles;
  const ignore = new Set([...(options.ignore || []), ...DEFAULT_IGNORE]);
  const out = [];
  function walk(relDir) {
    if (out.length >= maxFiles) return;
    const absDir = path.join(projectPath, relDir);
    let names = [];
    try { names = fs.readdirSync(absDir); } catch { return; }
    for (const name of names) {
      if (ignore.has(name)) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const full = path.join(projectPath, relPath);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(relPath);
      else if (st.isFile() && st.size <= (options.maxFileBytes || 2_000_000) && SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) out.push(relPath);
      if (out.length >= maxFiles) break;
    }
  }
  walk("");
  return out;
}
function candidateFiles(projectPath, params = {}, config = configFromEnv()) {
  if (params.file) return [normalizeProjectFile(projectPath, params.file)];
  if (params.files?.length) return Array.from(new Set(params.files.map((f) => normalizeProjectFile(projectPath, f))));
  const all = walkFiles(projectPath, { maxFiles: params.maxFiles || config.maxFiles });
  if (params.language) {
    const exts = new Set(languageExtensions(params.language));
    return all.filter((f) => exts.has(path.extname(f).toLowerCase()));
  }
  return all;
}
function offsetToLineCol(text, offset) {
  const prefix = text.slice(0, Math.max(0, offset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
function lineColToOffset(text, line, column) {
  const lines = text.split("\n");
  let offset = 0;
  const targetLine = Math.max(1, Number(line || 1));
  for (let i = 1; i < targetLine; i++) offset += (lines[i - 1] || "").length + 1;
  return offset + Math.max(0, Number(column || 1) - 1);
}
function wordAt(text, offset) {
  const re = /[A-Za-z_$][\w$]*/g;
  let match;
  while ((match = re.exec(text))) {
    if (match.index <= offset && re.lastIndex >= offset) return { word: match[0], start: match.index, end: re.lastIndex };
  }
  return null;
}
function makeSymbol(file, text, kind, name, start, end, extra = {}) {
  return { file, name, kind, loc: { start: offsetToLineCol(text, start), end: offsetToLineCol(text, end) }, range: { start, end }, preview: text.slice(start, Math.min(end, start + 240)).split(/\r?\n/).slice(0, 4).join("\n"), ...extra };
}
function extractSymbolsFromText(file, text) {
  const language = inferLanguage(file);
  const symbols = [];
  const specs = [];
  if (["javascript", "typescript"].includes(language)) {
    specs.push(
      { kind: "class", re: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/g, name: 1 },
      { kind: "function", re: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, name: 1 },
      { kind: "binding", re: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, name: 1 },
      { kind: "method", re: /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g, name: 1 },
      { kind: "commonjs", re: /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g, name: 1 }
    );
  } else if (language === "python") {
    specs.push(
      { kind: "function", re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm, name: 1 },
      { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)\b/gm, name: 1 }
    );
  } else if (language === "go") {
    specs.push(
      { kind: "function", re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/gm, name: 1 },
      { kind: "type", re: /^type\s+([A-Za-z_][\w]*)\s+/gm, name: 1 }
    );
  } else if (language === "rust") {
    specs.push(
      { kind: "function", re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/gm, name: 1 },
      { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/gm, name: 1 },
      { kind: "enum", re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)\b/gm, name: 1 }
    );
  }
  for (const spec of specs) {
    let match;
    while ((match = spec.re.exec(text))) {
      symbols.push(makeSymbol(file, text, spec.kind, match[spec.name], match.index + (text[match.index] === "\n" ? 1 : 0), spec.re.lastIndex));
    }
  }
  symbols.sort((a, b) => a.file.localeCompare(b.file) || a.range.start - b.range.start);
  return symbols;
}
function splitArgs(input) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input || ""))) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"));
  return tokens;
}
function parseCliArgs(input) {
  const tokens = splitArgs(input);
  const opts = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];
    if (token === "--path" || token === "-p") opts.path = next();
    else if (token.startsWith("--path=")) opts.path = token.slice("--path=".length);
    else if (token === "--file" || token === "-f") opts.file = next();
    else if (token.startsWith("--file=")) opts.file = token.slice("--file=".length);
    else if (token === "--line") opts.line = Number(next());
    else if (token.startsWith("--line=")) opts.line = Number(token.slice("--line=".length));
    else if (token === "--column" || token === "--col") opts.column = Number(next());
    else if (token.startsWith("--column=")) opts.column = Number(token.slice("--column=".length));
    else if (token === "--symbol" || token === "-s") opts.symbol = next();
    else if (token.startsWith("--symbol=")) opts.symbol = token.slice("--symbol=".length);
    else if (token === "--new-name") opts.newName = next();
    else if (token.startsWith("--new-name=")) opts.newName = token.slice("--new-name=".length);
    else if (token === "--language") opts.language = next();
    else if (token.startsWith("--language=")) opts.language = token.slice("--language=".length);
    else if (token === "--max-results") opts.maxResults = Number(next());
    else if (token.startsWith("--max-results=")) opts.maxResults = Number(token.slice("--max-results=".length));
    else if (token === "--timeout-ms") opts.timeoutMs = Number(next());
    else if (token.startsWith("--timeout-ms=")) opts.timeoutMs = Number(token.slice("--timeout-ms=".length));
    else positional.push(token);
  }
  return { opts, positional };
}
function runExec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    }, (error, stdout = "", stderr = "") => {
      resolve({ ok: !error, code: error ? (error.code || error.signal || error.status || 1) : 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), command: commandText(command, args), args, cwd: options.cwd, error: error ? String(error.message || error) : null });
    });
  });
}
function parseDiagnosticLines(output, projectPath) {
  const diagnostics = [];
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([^:]+):\s*(.*)$/i);
    if (m) {
      diagnostics.push({ file: path.relative(projectPath, path.resolve(projectPath, m[1])).replace(/\\/g, "/"), line: Number(m[2]), column: Number(m[3]), severity: m[4].toLowerCase(), code: m[5], message: m[6], raw: line });
      continue;
    }
    m = line.match(/^(.+?):(\d+):(\d+):\s*(.*)$/);
    if (m) diagnostics.push({ file: path.relative(projectPath, path.resolve(projectPath, m[1])).replace(/\\/g, "/"), line: Number(m[2]), column: Number(m[3]), severity: /warning/i.test(m[4]) ? "warning" : "error", message: m[4], raw: line });
  }
  return diagnostics;
}
function jsonDiagnostics(projectPath, files) {
  const diagnostics = [];
  for (const file of files.filter((f) => path.extname(f).toLowerCase() === ".json")) {
    try { JSON.parse(readText(path.join(projectPath, file))); }
    catch (e) { diagnostics.push({ file, line: 1, column: 1, severity: "error", message: String(e?.message || e), source: "json-parse" }); }
  }
  return diagnostics;
}
function simpleBalanceDiagnostics(projectPath, files) {
  const diagnostics = [];
  for (const file of files) {
    const language = inferLanguage(file);
    if (!["javascript", "typescript", "go", "rust", "java"].includes(language)) continue;
    const text = readText(path.join(projectPath, file));
    const stack = [];
    const pairs = { "(": ")", "[": "]", "{": "}" };
    const open = new Set(Object.keys(pairs));
    const close = new Set(Object.values(pairs));
    let quote = null, escaped = false, lineComment = false, blockComment = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (lineComment) { if (c === "\n") lineComment = false; continue; }
      if (blockComment) { if (c === "*" && n === "/") { blockComment = false; i++; } continue; }
      if (quote) { if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; } if (c === quote) quote = null; continue; }
      if (c === "/" && n === "/") { lineComment = true; i++; continue; }
      if (c === "/" && n === "*") { blockComment = true; i++; continue; }
      if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
      if (open.has(c)) stack.push({ c, offset: i });
      else if (close.has(c)) {
        const top = stack.pop();
        if (!top || pairs[top.c] !== c) {
          const loc = offsetToLineCol(text, i);
          diagnostics.push({ file, line: loc.line, column: loc.column, severity: "error", message: `Unbalanced closing ${c}`, source: "balanced-syntax" });
          break;
        }
      }
    }
    if (stack.length) {
      const top = stack[stack.length - 1];
      const loc = offsetToLineCol(text, top.offset);
      diagnostics.push({ file, line: loc.line, column: loc.column, severity: "warning", message: `Unclosed ${top.c}`, source: "balanced-syntax" });
    }
  }
  return diagnostics;
}
async function changedFiles(cwd) { return readChangeSet(cwd).changedPaths; }
async function saveFullOutput(prefix, text) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "output.txt");
  await fsp.writeFile(file, text, "utf8");
  return file;
}
async function toolResult(details, config, label = "LSP") {
  let text = typeof details === "string" ? details : JSON.stringify(details, null, 2);
  const truncation = truncateHead(text, { maxLines: config.outputMaxLines, maxBytes: config.outputMaxBytes });
  text = truncation.content.trimEnd();
  if (truncation.truncated) {
    const fullOutputPath = await saveFullOutput("pi-lsp-", typeof details === "string" ? details : JSON.stringify(details, null, 2));
    text += `\n\n[${label} output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
    if (typeof details === "object" && details) details.truncation = { ...truncation, fullOutputPath };
  }
  return { content: [{ type: "text", text: text || "(no output)" }], details };
}
function lspPosition(params = {}) { return { line: Math.max(0, Number(params.line || 1) - 1), character: Math.max(0, Number(params.column || 1) - 1) }; }
function lspUriFile(projectPath, uri) {
  const absolute = String(uri || "").startsWith("file:") ? fileURLToPath(uri) : path.resolve(projectPath, String(uri || ""));
  return normalizeProjectFile(projectPath, absolute);
}
function normalizeLspRange(range = {}) {
  return { startLine: Number(range.start?.line || 0) + 1, startColumn: Number(range.start?.character || 0) + 1, endLine: Number(range.end?.line || 0) + 1, endColumn: Number(range.end?.character || 0) + 1 };
}
function normalizeLocations(projectPath, value, kind) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.map((row) => {
    const target = row.targetUri ? { uri: row.targetUri, range: row.targetSelectionRange || row.targetRange } : row;
    return { file: lspUriFile(projectPath, target.uri), uri: target.uri, kind, range: normalizeLspRange(target.range), backend: "live-lsp", gatingSafe: true };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn);
}
function lspCapabilities(session) { return Object.keys(session?.capabilities || {}).filter((key) => session.capabilities[key]).sort(); }
function createLspAdapter(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  const registry = overrides.registry || serverRegistry(process.env, overrides.registryOptions);
  const sessionManager = overrides.sessionManager || new LspSessionManager({ registry, timeoutMs: config.timeoutMs, Client: overrides.Client, clientOptions: overrides.clientOptions });
  const fallback = new LspFallbackRunner({ maxFiles: config.maxFiles, maxResults: config.maxResults, timeoutMs: config.timeoutMs, Worker: overrides.FallbackWorker });
  const renamePreviews = new Map();
  function rememberRenamePreview(projectPath, preview) {
    const previewHash = liveRenamePreviewHash(projectPath, preview);
    renamePreviews.set(previewHash, { projectPath: path.resolve(projectPath), newName: preview.newName, previewHash });
    while (renamePreviews.size > 64) renamePreviews.delete(renamePreviews.keys().next().value);
    return previewHash;
  }
  function consumeRenamePreview(projectPath, preview, newName) {
    if (preview?.schemaVersion !== 1 || preview?.backend !== "live-lsp" || !preview?.workspaceEdit || !preview?.expectedHashes || !preview?.previewHash) {
      const error = new Error("renameApply requires a hashed live-lsp renamePreview result"); error.code = "LSP_RENAME_PREVIEW_REQUIRED"; throw error;
    }
    const calculated = liveRenamePreviewHash(projectPath, preview);
    if (calculated !== preview.previewHash) { const error = new Error("renamePreview hash does not match its workspace edit and expected file hashes"); error.code = "LSP_RENAME_PREVIEW_HASH_MISMATCH"; throw error; }
    const trusted = renamePreviews.get(preview.previewHash);
    if (!trusted || trusted.projectPath !== path.resolve(projectPath)) { const error = new Error("renamePreview was not issued by this live LSP adapter instance"); error.code = "LSP_RENAME_PREVIEW_UNTRUSTED"; throw error; }
    if (trusted.newName !== newName || preview.newName !== newName) { const error = new Error("renameApply newName differs from the hashed renamePreview"); error.code = "LSP_RENAME_PREVIEW_MISMATCH"; throw error; }
    renamePreviews.delete(preview.previewHash);
    return trusted;
  }

  async function liveContext(projectPath, params = {}, signal) {
    if (!config.live || !params.file) return { available: false, reason: !params.file ? "file_required" : "live_disabled" };
    const file = normalizeProjectFile(projectPath, params.file);
    const language = params.language || inferLanguage(file);
    const server = registry.forLanguage(language);
    if (!server) return { available: false, reason: "server_unavailable", language, file };
    try {
      const session = await sessionManager.get({ root: projectPath, language, configuration: params.configuration, server }, { timeoutMs: params.timeoutMs || config.timeoutMs, signal });
      const uri = pathToFileURL(path.join(projectPath, file)).href;
      const text = readText(path.join(projectPath, file));
      const opened = session.client.documents.get(uri);
      if (!opened) session.client.openDocument({ uri, languageId: language, version: 1, text });
      else if (opened.text !== text) session.client.changeDocument({ uri, version: opened.version + 1, text });
      return { available: true, projectPath, file, language, server, session, uri, text };
    } catch (error) { return { available: true, error, degradation: classifyFailure(error), projectPath, file, language, server }; }
  }
  async function semanticRequest(projectPath, params, method, requestParams, signal) {
    const context = await liveContext(projectPath, params, signal);
    if (!context.available || context.error) return context;
    try {
      const result = await context.session.client.request(method, typeof requestParams === "function" ? requestParams(context) : requestParams, { timeoutMs: params.timeoutMs || config.timeoutMs, signal });
      return { ...context, result };
    } catch (error) { return { ...context, error, degradation: classifyFailure(error) }; }
  }
  function liveBase(request) {
    return { backend: "live-lsp", server: request.server?.id, serverInfo: request.session?.serverInfo || null, capabilities: lspCapabilities(request.session), freshness: "fresh", degradation: request.degradation || null, gatingSafe: !request.degradation && !request.error, advisory: false };
  }
  async function status(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const files = walkFiles(projectPath, { maxFiles: Math.min(500, config.maxFiles) });
    const languages = {};
    for (const file of files) languages[inferLanguage(file)] = (languages[inferLanguage(file)] || 0) + 1;
    const servers = registry.status();
    const liveAvailable = config.live && servers.some((server) => server.found === true);
    const details = { generatedAt: new Date().toISOString(), enabled: config.enabled, liveEnabled: config.live, projectPath, cwd: ctx.cwd, adapter: "lsp-facade", backend: "facade", lazy: true, note: "Language servers start only on the first file-scoped semantic operation. Compiler diagnostics and lexical fallback remain explicit.", servers, sessions: sessionManager.status().sessions, languages, sampledFiles: files.length, env: envReport(), supportedOperations: { fallback: fallback.capabilities.slice(), compilerDiagnostics: true, liveSemantic: liveAvailable ? ["definition", "references", "implementations", "hover", "callHierarchy", "typeHierarchy", "codeActions", "renamePreview", "renameApply"] : [] }, liveCapabilitiesAvailable: liveAvailable, recommendations: ["Treat backend=fallback as advisory.", "Require a live-lsp rename preview with a same-instance hash before apply."] };
    return toolResult(details, config);
  }
  async function diagnostics(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    let files = candidateFiles(projectPath, params, config);
    if (params.changed) {
      const changed = await changedFiles(projectPath);
      files = changed.length ? changed.filter((f) => SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase())) : files;
    }
    const commands = [];
    const diagnostics = [...jsonDiagnostics(projectPath, files), ...simpleBalanceDiagnostics(projectPath, files)];
    const timeoutMs = clampNumber(Number(params.timeoutMs || config.diagnosticTimeoutMs), 1000, 10 * 60 * 1000);
    const jsFiles = files.filter((f) => [".js", ".mjs", ".cjs"].includes(path.extname(f).toLowerCase()));
    if (executableInfo("node").found) {
      for (const file of jsFiles.slice(0, 50)) {
        const run = await runExec("node", ["--check", file], { cwd: projectPath, timeoutMs, maxBuffer: config.maxBuffer, signal });
        commands.push(run);
        if (!run.ok) diagnostics.push(...parseDiagnosticLines(`${run.stdout}\n${run.stderr}`, projectPath).map((d) => ({ ...d, source: "node --check" })));
      }
    }
    const pyFiles = files.filter((f) => path.extname(f).toLowerCase() === ".py");
    if (pyFiles.length && executableInfo("python3").found) {
      const run = await runExec("python3", ["-m", "py_compile", ...pyFiles.slice(0, 100)], { cwd: projectPath, timeoutMs, maxBuffer: config.maxBuffer, signal });
      commands.push(run);
      if (!run.ok) diagnostics.push(...parseDiagnosticLines(`${run.stdout}\n${run.stderr}`, projectPath).map((d) => ({ ...d, source: "python py_compile" })));
    }
    const tsFiles = files.filter((f) => [".ts", ".tsx", ".mts", ".cts"].includes(path.extname(f).toLowerCase()));
    if ((tsFiles.length || fileExists(path.join(projectPath, "tsconfig.json"))) && executableInfo("tsc").found) {
      const args = fileExists(path.join(projectPath, "tsconfig.json")) ? ["--noEmit", "--pretty", "false"] : ["--noEmit", "--pretty", "false", "--skipLibCheck", ...tsFiles.slice(0, 80)];
      const run = await runExec("tsc", args, { cwd: projectPath, timeoutMs, maxBuffer: config.maxBuffer, signal });
      commands.push(run);
      if (!run.ok) diagnostics.push(...parseDiagnosticLines(`${run.stdout}\n${run.stderr}`, projectPath).map((d) => ({ ...d, source: "tsc" })));
    }
    if (fileExists(path.join(projectPath, "go.mod")) && executableInfo("go").found && (params.language === "go" || files.some((f) => f.endsWith(".go")))) {
      const run = await runExec("go", ["test", "./..."], { cwd: projectPath, timeoutMs, maxBuffer: config.maxBuffer, signal });
      commands.push(run);
      if (!run.ok) diagnostics.push(...parseDiagnosticLines(`${run.stdout}\n${run.stderr}`, projectPath).map((d) => ({ ...d, source: "go test" })));
    }
    if (fileExists(path.join(projectPath, "Cargo.toml")) && executableInfo("cargo").found && (params.language === "rust" || files.some((f) => f.endsWith(".rs")))) {
      const run = await runExec("cargo", ["check"], { cwd: projectPath, timeoutMs, maxBuffer: config.maxBuffer, signal });
      commands.push(run);
      if (!run.ok) diagnostics.push(...parseDiagnosticLines(`${run.stdout}\n${run.stderr}`, projectPath).map((d) => ({ ...d, source: "cargo check" })));
    }
    const normalized = normalizeDiagnostics(diagnostics, { provider: commands.length ? "compiler" : "fallback", revision: params.revision, sinceRevision: params.sinceRevision, previous: params.previousDiagnostics, freshness: "fresh", gatingSafe: commands.length > 0 });
    const details = { generatedAt: new Date().toISOString(), projectPath, backend: commands.length ? "compiler" : "fallback", capabilities: commands.map((run) => run.command.split(" ")[0]).filter(Boolean), freshness: "fresh", degradation: commands.length ? null : { code: "syntax_fallback", message: "No compiler diagnostic command was available.", retryable: false }, gatingSafe: commands.length > 0, filesChecked: files.length, diagnostics: normalized.diagnostics, diagnosticDelta: { sinceRevision: normalized.sinceRevision, deduplicated: normalized.deduplicated, errors: normalized.errors }, summary: { errors: normalized.diagnostics.filter((d) => d.severity === "error").length, warnings: normalized.diagnostics.filter((d) => d.severity !== "error").length }, commands: commands.map((r) => ({ ok: r.ok, code: r.code, command: r.command, stdout: truncateHead(r.stdout, { maxLines: 80, maxBytes: 12000 }).content, stderr: truncateHead(r.stderr, { maxLines: 80, maxBytes: 12000 }).content })) };
    return toolResult(details, config);
  }
  async function documentSymbols(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    if (params.file) {
      const live = await semanticRequest(projectPath, params, "textDocument/documentSymbol", (context) => ({ textDocument: { uri: context.uri } }), signal);
      if (live.available && !live.error) {
        const symbols = (live.result || []).map((symbol) => ({ name: symbol.name, detail: symbol.detail, kind: symbol.kind, file: live.file, range: normalizeLspRange(symbol.selectionRange || symbol.range), backend: "live-lsp", gatingSafe: true }));
        return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), filesScanned: 1, symbols: symbols.slice(0, params.maxResults || config.maxResults), truncated: symbols.length > (params.maxResults || config.maxResults) }, config);
      }
    }
    return toolResult({ generatedAt: new Date().toISOString(), ...await fallback.request("symbols", projectPath, params, signal) }, config);
  }
  async function definition(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await semanticRequest(projectPath, params, "textDocument/definition", (context) => ({ textDocument: { uri: context.uri }, position: lspPosition(params) }), signal);
    if (live.available && !live.error) return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), symbol: params.symbol, definitions: normalizeLocations(projectPath, live.result, "definition") }, config);
    const details = await fallback.request("definition", projectPath, params, signal);
    if (live.degradation) details.liveDegradation = live.degradation;
    return toolResult({ generatedAt: new Date().toISOString(), ...details }, config);
  }
  async function references(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await semanticRequest(projectPath, params, "textDocument/references", (context) => ({ textDocument: { uri: context.uri }, position: lspPosition(params), context: { includeDeclaration: params.includeDeclaration !== false } }), signal);
    if (live.available && !live.error) {
      const refs = normalizeLocations(projectPath, live.result, "reference").slice(0, params.maxResults || config.maxResults);
      return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), symbol: params.symbol, references: refs, summary: { files: new Set(refs.map((ref) => ref.file)).size, references: refs.length } }, config);
    }
    const details = await fallback.request("references", projectPath, params, signal);
    if (live.degradation) details.liveDegradation = live.degradation;
    return toolResult({ generatedAt: new Date().toISOString(), ...details }, config);
  }
  async function hover(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await semanticRequest(projectPath, params, "textDocument/hover", (context) => ({ textDocument: { uri: context.uri }, position: lspPosition(params) }), signal);
    if (live.available && !live.error) return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), file: live.file, hover: live.result ? { contents: live.result.contents, range: live.result.range ? normalizeLspRange(live.result.range) : null } : null }, config);
    const details = await fallback.request("hover", projectPath, params, signal);
    if (live.degradation) details.liveDegradation = live.degradation;
    return toolResult({ generatedAt: new Date().toISOString(), ...details }, config);
  }
  async function rename(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const newName = params.newName;
    if (!newName) throw new Error("newName is required");
    const apply = params.apply === true || params.operation === "renameApply";
    if (apply) {
      consumeRenamePreview(projectPath, params.preview, newName);
      const prepared = previewWorkspaceEdit(projectPath, params.preview.workspaceEdit, { expectedHashes: params.preview.expectedHashes });
      const applied = await applyWorkspaceEdit(projectPath, prepared, { queue: params.queue });
      return toolResult({ generatedAt: new Date().toISOString(), projectPath, operation: "renameApply", backend: "live-lsp", server: params.preview.server, capabilities: params.preview.capabilities || [], freshness: "fresh", degradation: null, gatingSafe: true, applied: true, previewHash: params.preview.previewHash, changes: applied.changes, summary: applied.summary, provenance: params.preview.provenance }, config);
    }
    const live = await liveContext(projectPath, params, signal);
    if (live.available && !live.error) {
      try {
        const position = lspPosition(params);
        let prepared = null;
        if (live.session.capabilities?.renameProvider && typeof live.session.capabilities.renameProvider === "object" && live.session.capabilities.renameProvider.prepareProvider) prepared = await live.session.client.request("textDocument/prepareRename", { textDocument: { uri: live.uri }, position }, { timeoutMs: params.timeoutMs || config.timeoutMs, signal });
        const workspaceEdit = await live.session.client.request("textDocument/rename", { textDocument: { uri: live.uri }, position, newName }, { timeoutMs: params.timeoutMs || config.timeoutMs, signal });
        const preview = previewWorkspaceEdit(projectPath, workspaceEdit || {});
        const expectedHashes = Object.fromEntries(preview.changes.map((change) => [change.file, change.expectedHash]));
        const changes = preview.changes.map(({ before, after, ...change }) => change);
        const livePreview = { schemaVersion: 1, backend: "live-lsp", server: live.server.id, capabilities: lspCapabilities(live.session), symbol: params.symbol || null, newName, workspaceEdit, expectedHashes, provenance: [{ provider: "lsp", server: live.server.id, operation: "textDocument/rename" }] };
        livePreview.previewHash = rememberRenamePreview(projectPath, livePreview);
        return toolResult({ generatedAt: new Date().toISOString(), projectPath, operation: "renamePreview", ...liveBase(live), prepared, symbol: params.symbol, newName, applied: false, previewHash: livePreview.previewHash, changes, summary: preview.summary, preview: livePreview }, config);
      } catch (error) { live.error = error; live.degradation = classifyFailure(error); }
    }
    const details = await fallback.request("renamePreview", projectPath, params, signal);
    if (live.degradation) details.liveDegradation = live.degradation;
    return toolResult({ generatedAt: new Date().toISOString(), ...details }, config);
  }

  async function implementations(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await semanticRequest(projectPath, params, "textDocument/implementation", (context) => ({ textDocument: { uri: context.uri }, position: lspPosition(params) }), signal);
    if (live.available && !live.error) return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), implementations: normalizeLocations(projectPath, live.result, "implementation") }, config);
    return toolResult({ generatedAt: new Date().toISOString(), projectPath, backend: "fallback", capabilities: [], freshness: "unknown", gatingSafe: false, degradation: live.degradation || { code: "unsupported_fallback", message: "Implementation lookup requires a live LSP server.", retryable: false }, implementations: [] }, config);
  }
  async function workspaceSymbols(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    if (params.file) return documentSymbols(ctx, params, signal);
    if (!config.live) return documentSymbols(ctx, params, signal);
    const sampleFile = params.language ? undefined : (await fallback.request("listFiles", projectPath, { ...params, maxFiles: 1 }, signal))[0];
    const language = params.language || inferLanguage(sampleFile);
    const server = registry.forLanguage(language);
    if (!server) return toolResult({ generatedAt: new Date().toISOString(), ...await fallback.request("symbols", projectPath, params, signal) }, config);
    try {
      const session = await sessionManager.get({ root: projectPath, language, configuration: params.configuration, server }, { signal, timeoutMs: params.timeoutMs || config.timeoutMs });
      const result = await session.client.request("workspace/symbol", { query: params.query || params.symbol || "" }, { signal, timeoutMs: params.timeoutMs || config.timeoutMs });
      const symbols = (result || []).map((symbol) => ({ name: symbol.name, kind: symbol.kind, file: lspUriFile(projectPath, symbol.location?.uri), range: normalizeLspRange(symbol.location?.range), backend: "live-lsp", gatingSafe: true }));
      return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase({ session, server }), symbols }, config);
    } catch (error) { return toolResult({ generatedAt: new Date().toISOString(), ...await fallback.request("symbols", projectPath, params, signal), liveDegradation: classifyFailure(error) }, config); }
  }
  async function callHierarchy(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await liveContext(projectPath, params, signal);
    if (!live.available || live.error) return toolResult({ generatedAt: new Date().toISOString(), projectPath, backend: "fallback", capabilities: [], freshness: "unknown", gatingSafe: false, degradation: live.degradation || { code: "unsupported_fallback", message: "Call hierarchy requires a live LSP server.", retryable: false }, calls: [] }, config);
    try {
      const items = await live.session.client.request("textDocument/prepareCallHierarchy", { textDocument: { uri: live.uri }, position: lspPosition(params) }, { signal, timeoutMs: params.timeoutMs || config.timeoutMs });
      const direction = params.direction === "outgoing" ? "outgoing" : "incoming";
      const calls = [];
      for (const item of (items || []).slice(0, params.maxResults || 20)) {
        const rows = await live.session.client.request(`callHierarchy/${direction}Calls`, { item }, { signal, timeoutMs: params.timeoutMs || config.timeoutMs });
        calls.push(...(rows || []));
      }
      return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), direction, calls }, config);
    } catch (error) { return toolResult({ generatedAt: new Date().toISOString(), projectPath, backend: "live-lsp", capabilities: lspCapabilities(live.session), freshness: "unknown", gatingSafe: false, degradation: classifyFailure(error), calls: [] }, config); }
  }
  async function typeHierarchy(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await liveContext(projectPath, params, signal);
    if (!live.available || live.error) return toolResult({ generatedAt: new Date().toISOString(), projectPath, backend: "fallback", capabilities: [], freshness: "unknown", gatingSafe: false, degradation: live.degradation || { code: "unsupported_fallback", message: "Type hierarchy requires a live LSP server.", retryable: false }, types: [] }, config);
    try {
      const items = await live.session.client.request("textDocument/prepareTypeHierarchy", { textDocument: { uri: live.uri }, position: lspPosition(params) }, { signal, timeoutMs: params.timeoutMs || config.timeoutMs });
      const direction = params.direction === "supertypes" ? "supertypes" : "subtypes";
      const types = [];
      for (const item of (items || []).slice(0, params.maxResults || 20)) {
        const rows = await live.session.client.request(`typeHierarchy/${direction}`, { item }, { signal, timeoutMs: params.timeoutMs || config.timeoutMs });
        types.push(...(rows || []));
      }
      return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...liveBase(live), direction, types }, config);
    } catch (error) { return toolResult({ generatedAt: new Date().toISOString(), projectPath, backend: "live-lsp", capabilities: lspCapabilities(live.session), freshness: "unknown", gatingSafe: false, degradation: classifyFailure(error), types: [] }, config); }
  }
  async function codeActions(ctx, params = {}, signal) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const live = await semanticRequest(projectPath, params, "textDocument/codeAction", (context) => ({ textDocument: { uri: context.uri }, range: { start: lspPosition(params), end: lspPosition({ line: params.endLine || params.line, column: params.endColumn || params.column }) }, context: { diagnostics: params.diagnostics || [], only: params.only } }), signal);
    return toolResult({ generatedAt: new Date().toISOString(), projectPath, ...(live.available && !live.error ? liveBase(live) : { backend: "fallback", capabilities: [], freshness: "unknown", gatingSafe: false, degradation: live.degradation || { code: "unsupported_fallback", message: "Code actions require a live LSP server.", retryable: false } }), advisory: true, actions: live.result || [] }, config);
  }
  async function closeAll() {
    renamePreviews.clear();
    const [sessions, workers] = await Promise.all([sessionManager.closeAll(), fallback.closeAll()]);
    return { ...sessions, fallbackWorkersClosed: workers.closed };
  }
  return { config, status, diagnostics, documentSymbols, workspaceSymbols, definition, references, implementations, hover, rename, callHierarchy, typeHierarchy, codeActions, closeAll, sessionManager, parseCliArgs, resolveProjectPath: (ctx, p) => resolveProjectPath(ctx, p, config), normalizeProjectFile };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  configFromEnv,
  createLspAdapter,
  parseCliArgs,
  splitArgs,
  inferLanguage,
  extractSymbolsFromText,
  resolveProjectPath,
  normalizeProjectFile,
  executableInfo,
  truncateHead,
  formatSize,
  liveRenamePreviewHash,
};
