"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { assertProjectScope } = require("./project-scope.js");
const crypto = require("node:crypto");

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const STATE_DIR = path.join(".pi", "ast-refactor");
// .worktrees holds linked checkouts of the same repository on other branches;
// broad lexical refactors must never rewrite another branch's copies.
const DEFAULT_IGNORE = new Set([".git", ".claude", ".worktrees", "node_modules", ".pi", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv", "venv"]);
const { astSearchEnvelope, renderAstSearch, recordResultRendering } = require("./provider-result-rendering.js");

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp"]);

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function configFromEnv(env = process.env, overrides = {}) {
  return {
    enabled: env.PI_AST_TOOLS !== "0",
    allowOutsideCwd: overrides.allowOutsideCwd != null ? Boolean(overrides.allowOutsideCwd) : env.PI_AST_ALLOW_OUTSIDE === "1",
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_AST_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_AST_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    maxFiles: clampNumber(Number(overrides.maxFiles || env.PI_AST_MAX_FILES || 2500), 1, 20000),
    maxResults: clampNumber(Number(overrides.maxResults || env.PI_AST_MAX_RESULTS || 50), 1, 10000),
    maxChanges: clampNumber(Number(overrides.maxChanges || env.PI_AST_MAX_CHANGES || 1000), 1, 20000),
  };
}
function stripAt(value) {
  const text = String(value || "").trim();
  return text.startsWith("@") ? text.slice(1) : text;
}
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function resolveProjectPath(ctx, inputPath, config = configFromEnv()) {
  const raw = stripAt(inputPath) || ".";
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const absolute = path.resolve(cwd, raw);
  assertProjectScope(cwd, absolute, { label: "AST", envVar: "PI_AST_ALLOW_OUTSIDE", allowOutside: config.allowOutsideCwd });
  return absolute;
}
function normalizeProjectFile(projectPath, file) {
  const raw = stripAt(file);
  if (!raw) throw new Error("AST file path must not be empty");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  if (!isInside(projectPath, absolute)) throw new Error(`AST file must stay inside project path: ${file}`);
  return path.relative(projectPath, absolute).replace(/\\/g, "/");
}
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
      out.push(acc); bytes = Buffer.byteLength(acc, "utf8"); break;
    }
    out.push(line); bytes += lineBytes;
  }
  return { content: out.join("\n"), truncated: out.length < lines.length || bytes < totalBytes, outputLines: out.length, totalLines: lines.length, outputBytes: bytes, totalBytes };
}
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, data) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function stateRoot(cwd) { const root = path.join(cwd, STATE_DIR); ensureDir(path.join(root, "checkpoints")); return root; }
function latestFile(cwd) { return path.join(stateRoot(cwd), "latest.json"); }
function checkpointFile(cwd, id) { return path.join(stateRoot(cwd), "checkpoints", `${id}.json`); }
function envReport(env = process.env) {
  return {
    PI_AST_TOOLS: env.PI_AST_TOOLS ?? null,
    PI_AST_ALLOW_OUTSIDE: env.PI_AST_ALLOW_OUTSIDE ?? null,
    PI_AST_MAX_LINES: env.PI_AST_MAX_LINES ?? null,
    PI_AST_MAX_BYTES: env.PI_AST_MAX_BYTES ?? null,
    PI_AST_MAX_FILES: env.PI_AST_MAX_FILES ?? null,
    PI_AST_MAX_RESULTS: env.PI_AST_MAX_RESULTS ?? null,
    PI_AST_MAX_CHANGES: env.PI_AST_MAX_CHANGES ?? null,
  };
}
function inferLanguage(file) {
  const ext = path.extname(file || "").toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  return "text";
}
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
    let names = [];
    try { names = fs.readdirSync(path.join(projectPath, relDir)); } catch { return; }
    for (const name of names) {
      if (ignore.has(name)) continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      const full = path.join(projectPath, rel);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(rel);
      else if (st.isFile() && st.size <= (options.maxFileBytes || 2_000_000) && SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) out.push(rel);
      if (out.length >= maxFiles) break;
    }
  }
  walk("");
  return out;
}
function candidateFiles(projectPath, params = {}, config = configFromEnv()) {
  let files;
  if (params.file) files = [normalizeProjectFile(projectPath, params.file)];
  else if (params.files?.length) files = params.files.map((f) => normalizeProjectFile(projectPath, f));
  else files = walkFiles(projectPath, { maxFiles: params.maxFiles || config.maxFiles });
  if (params.language) {
    const exts = new Set(languageExtensions(params.language));
    files = files.filter((f) => exts.has(path.extname(f).toLowerCase()));
  }
  if (params.include) {
    const includes = normalizeArray(params.include);
    files = files.filter((f) => includes.some((needle) => f.includes(needle)));
  }
  if (params.exclude) {
    const excludes = normalizeArray(params.exclude);
    files = files.filter((f) => !excludes.some((needle) => f.includes(needle)));
  }
  return Array.from(new Set(files));
}
function normalizeArray(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeArray);
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
function offsetToLineCol(text, offset) {
  const prefix = text.slice(0, Math.max(0, offset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
function escapeRe(text) { return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function lineAt(text, offset) { return text.split(/\r?\n/)[offsetToLineCol(text, offset).line - 1] || ""; }
function makeMatch(file, text, kind, name, start, end, extra = {}) {
  return { file, kind, name, loc: { start: offsetToLineCol(text, start), end: offsetToLineCol(text, end) }, range: { start, end }, preview: lineAt(text, start).trim(), ...extra };
}
function callRegex(language, pattern = "[A-Za-z_$][\\w$]*") {
  if (language === "python") return new RegExp(`(?<!def\\s)\\b(${pattern})\\s*\\(`, "g");
  return new RegExp(`\\b(${pattern})\\s*\\(`, "g");
}
function parseNodes(file, text) {
  const language = inferLanguage(file);
  const nodes = [];
  const specs = [];
  if (["javascript", "typescript"].includes(language)) {
    specs.push(
      { kind: "class", re: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/g, name: 1 },
      { kind: "function", re: /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, name: 1 },
      { kind: "binding", re: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, name: 1 },
      { kind: "import", re: /(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g, name: 2 },
      { kind: "require", re: /require\s*\(\s*["']([^"']+)["']\s*\)/g, name: 1 }
    );
  } else if (language === "python") {
    specs.push(
      { kind: "function", re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm, name: 1 },
      { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)\b/gm, name: 1 },
      { kind: "import", re: /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm, name: 1 }
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
      const name = match[spec.name] || match[2] || match[1] || "";
      nodes.push(makeMatch(file, text, spec.kind, name, match.index + (text[match.index] === "\n" ? 1 : 0), spec.re.lastIndex));
    }
  }
  let call;
  const cre = callRegex(language);
  while ((call = cre.exec(text))) nodes.push(makeMatch(file, text, "call", call[1], call.index, cre.lastIndex));
  nodes.sort((a, b) => a.range.start - b.range.start || a.kind.localeCompare(b.kind));
  return nodes;
}
function matcher(pattern, options = {}) {
  if (!pattern) return () => true;
  if (options.regex) {
    const flags = options.flags || "";
    const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    return (text) => { re.lastIndex = 0; return re.test(text); };
  }
  const needle = String(pattern);
  return (text) => options.caseSensitive ? String(text).includes(needle) : String(text).toLowerCase().includes(needle.toLowerCase());
}
function searchFile(projectPath, file, params = {}) {
  const text = readText(path.join(projectPath, file));
  const kind = params.kind || "node";
  const max = params.maxResults || configFromEnv().maxResults;
  const matches = [];
  if (["node", "function", "class", "binding", "import", "require", "call", "type", "struct", "enum"].includes(kind)) {
    const m = matcher(params.pattern, { regex: params.regex, flags: params.flags, caseSensitive: params.caseSensitive });
    for (const node of parseNodes(file, text)) {
      if (kind !== "node" && node.kind !== kind) continue;
      if (!m(node.name) && !m(node.preview)) continue;
      matches.push(node);
      if (matches.length >= max) break;
    }
    return matches;
  }
  if (kind === "identifier") {
    const re = new RegExp(`\\b${escapeRe(params.pattern)}\\b`, "g");
    let match;
    while ((match = re.exec(text)) && matches.length < max) matches.push(makeMatch(file, text, "identifier", match[0], match.index, re.lastIndex));
    return matches;
  }
  if (kind === "regex") {
    const re = new RegExp(params.pattern, params.flags?.includes("g") ? params.flags : `${params.flags || ""}g`);
    let match;
    while ((match = re.exec(text)) && matches.length < max) matches.push(makeMatch(file, text, "regex", match[0], match.index, re.lastIndex));
    return matches;
  }
  const needle = params.caseSensitive ? String(params.pattern || "") : String(params.pattern || "").toLowerCase();
  const hay = params.caseSensitive ? text : text.toLowerCase();
  let idx = hay.indexOf(needle);
  while (idx >= 0 && matches.length < max) {
    matches.push(makeMatch(file, text, "text", params.pattern, idx, idx + String(params.pattern || "").length));
    idx = hay.indexOf(needle, idx + Math.max(1, needle.length));
  }
  return matches;
}
function refactorFile(projectPath, file, params = {}) {
  const full = path.join(projectPath, file);
  const before = readText(full);
  const kind = params.kind || "identifier";
  const pattern = String(params.pattern || "");
  const replacement = String(params.replacement ?? "");
  let after = before;
  const changes = [];
  const pushChange = (start, end, beforeText, afterText) => changes.push({ file, kind, loc: { start: offsetToLineCol(before, start), end: offsetToLineCol(before, end) }, range: { start, end }, beforeText, afterText, preview: lineAt(before, start).trim() });

  if (kind === "identifier") {
    const re = new RegExp(`\\b${escapeRe(pattern)}\\b`, "g");
    after = before.replace(re, (m, offset) => { pushChange(offset, offset + m.length, m, replacement); return replacement; });
  } else if (kind === "text") {
    if (!pattern) throw new Error("text refactor requires pattern");
    let idx = before.indexOf(pattern);
    while (idx >= 0) { pushChange(idx, idx + pattern.length, pattern, replacement); idx = before.indexOf(pattern, idx + Math.max(1, pattern.length)); }
    after = before.split(pattern).join(replacement);
  } else if (kind === "regex") {
    const re = new RegExp(pattern, params.flags?.includes("g") ? params.flags : `${params.flags || ""}g`);
    after = before.replace(re, (...args) => {
      const match = args[0];
      const offset = args[args.length - 2];
      const out = match.replace(new RegExp(pattern, params.flags || ""), replacement);
      pushChange(offset, offset + match.length, match, out);
      return out;
    });
  } else if (kind === "call") {
    const re = new RegExp(`\\b${escapeRe(pattern)}\\s*\\(`, "g");
    after = before.replace(re, (m, offset) => { const out = `${replacement}(`; pushChange(offset, offset + pattern.length, pattern, replacement); return out; });
  } else {
    throw new Error(`Unsupported refactor kind: ${kind}`);
  }
  return { file, changed: before !== after, replacements: changes.length, changes, beforeHash: sha256(before), afterHash: sha256(after), before, after };
}
async function saveFullOutput(prefix, text) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "output.txt");
  await fsp.writeFile(file, text, "utf8");
  return file;
}
async function toolResult(details, config, label = "AST", options = {}) {
  if (details && typeof details === "object") Object.assign(details, { backend: "regex", gatingSafe: false, advisory: "Lexical heuristics only; not parsed, scope-aware, or a semantic rename. Comments and strings may match." });
  let text;
  if (Array.isArray(details?.matches)) {
    // Search results validate into the shared retrieval envelope so the same
    // renderer and token budget cover AST alongside CodeGraph and Semgrep.
    const envelope = astSearchEnvelope({ matches: details.matches, matchLimit: details.maxResults, truncatedMatches: details.truncated === true, metadata: { operation: "search" } });
    const rawText = [`Lexical AST search: ${details.matches.length} match(es)${envelope.truncatedMatches ? " (limit reached)" : ""}. ${details.advisory}`, ...details.matches.map((match) => `${match.file}:${match.loc.start.line}:${match.loc.start.column} ${match.kind} ${match.name} — ${match.preview}`)].join("\n");
    text = options.verbose === true ? rawText : renderAstSearch(envelope, { operation: "ast_search", budgetTokens: options.budgetTokens });
    Object.assign(details, envelope);
    recordResultRendering(details, text, rawText, { ...options, operation: "ast_search" });
    return { content: [{ type: "text", text }], details };
  }
  text = typeof details === "string" ? details : JSON.stringify(details, null, 2);
  const truncation = truncateHead(text, { maxLines: config.outputMaxLines, maxBytes: config.outputMaxBytes });
  text = truncation.content.trimEnd();
  if (truncation.truncated) {
    const fullOutputPath = await saveFullOutput("pi-ast-", typeof details === "string" ? details : JSON.stringify(details, null, 2));
    text += `\n\n[${label} output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
    if (typeof details === "object" && details) details.truncation = { ...truncation, fullOutputPath };
  }
  return { content: [{ type: "text", text: text || "(no output)" }], details };
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
    else if (token === "--kind" || token === "-k") opts.kind = next();
    else if (token.startsWith("--kind=")) opts.kind = token.slice("--kind=".length);
    else if (token === "--language") opts.language = next();
    else if (token.startsWith("--language=")) opts.language = token.slice("--language=".length);
    else if (token === "--replacement" || token === "-r") opts.replacement = next();
    else if (token.startsWith("--replacement=")) opts.replacement = token.slice("--replacement=".length);
    else if (token === "--regex") opts.regex = true;
    else if (token === "--apply") opts.mode = "apply";
    else if (token === "--preview") opts.mode = "preview";
    else if (token === "--max-results") opts.maxResults = Number(next());
    else if (token.startsWith("--max-results=")) opts.maxResults = Number(token.slice("--max-results=".length));
    else positional.push(token);
  }
  return { opts, positional };
}
function createAstTools(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  async function status(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const files = walkFiles(projectPath, { maxFiles: Math.min(500, config.maxFiles) });
    const languages = {};
    for (const file of files) languages[inferLanguage(file)] = (languages[inferLanguage(file)] || 0) + 1;
    return toolResult({ generatedAt: new Date().toISOString(), enabled: config.enabled, projectPath, stateDir: path.join(projectPath, STATE_DIR), adapter: "regex-backed structural AST fallback", sampledFiles: files.length, languages, env: envReport(), supportedKinds: ["node", "function", "class", "binding", "import", "require", "call", "identifier", "regex", "text"], advisory: "No parser dependencies are required; matches are structural/lexical and should be reviewed for complex syntax." }, config);
  }
  async function search(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const files = candidateFiles(projectPath, params, config);
    const max = clampNumber(Number(params.maxResults || config.maxResults), 1, 10000);
    const matches = [];
    let filesScanned = 0;
    for (const file of files) {
      filesScanned++;
      const rows = searchFile(projectPath, file, { ...params, maxResults: max - matches.length });
      matches.push(...rows);
      if (matches.length >= max) break;
    }
    return toolResult({ generatedAt: new Date().toISOString(), projectPath, kind: params.kind || "node", pattern: params.pattern || null, filesScanned, maxResults: max, matches, summary: { matches: matches.length, files: new Set(matches.map((m) => m.file)).size }, truncated: matches.length >= max }, config, "AST", { verbose: params.verbose === true, budgetTokens: params.budgetTokens });
  }
  async function refactor(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const mode = params.mode || (params.apply ? "apply" : "preview");
    if (!["preview", "apply"].includes(mode)) throw new Error("mode must be preview or apply");
    if (!params.pattern) throw new Error("pattern is required");
    if (params.replacement == null) throw new Error("replacement is required");
    const files = candidateFiles(projectPath, params, config);
    const raw = [];
    let totalChanges = 0;
    for (const file of files) {
      const result = refactorFile(projectPath, file, params);
      if (!result.changed) continue;
      raw.push(result);
      totalChanges += result.replacements;
      if (totalChanges >= (params.maxChanges || config.maxChanges)) break;
    }
    const changed = raw.map(({ before, after, changes, ...rest }) => ({ ...rest, changes: changes.slice(0, 50) }));
    let checkpoint = null;
    if (mode === "apply" && raw.length) {
      const id = `ast_${sha256({ at: Date.now(), pattern: params.pattern, replacement: params.replacement, files: raw.map((r) => r.file) }).slice(0, 16)}`;
      checkpoint = { id, createdAt: new Date().toISOString(), params: { ...params, mode }, files: raw.map((r) => ({ file: r.file, beforeHash: r.beforeHash, afterHash: r.afterHash, before: r.before, after: r.after })) };
      writeJson(checkpointFile(projectPath, id), checkpoint);
      writeJson(latestFile(projectPath), { checkpointId: id, at: checkpoint.createdAt });
      for (const result of raw) await fsp.writeFile(path.join(projectPath, result.file), result.after, "utf8");
    }
    return toolResult({ generatedAt: new Date().toISOString(), projectPath, mode, applied: mode === "apply", kind: params.kind || "identifier", pattern: params.pattern, replacement: params.replacement, summary: { files: raw.length, replacements: totalChanges }, changes: changed, checkpointId: checkpoint?.id || null, advisory: "Preview/apply uses structural lexical matching; review preview before broad applies." }, config);
  }
  async function rollback(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const checkpointId = params.checkpointId || readJson(latestFile(projectPath), {})?.checkpointId;
    if (!checkpointId) throw new Error("No AST refactor checkpoint id supplied and no latest checkpoint found.");
    const checkpoint = readJson(checkpointFile(projectPath, checkpointId), null);
    if (!checkpoint) throw new Error(`No checkpoint found for ${checkpointId}`);
    const restored = [];
    for (const file of checkpoint.files || []) {
      const full = path.join(projectPath, file.file);
      const current = readText(full);
      if (sha256(current) !== file.afterHash) restored.push({ file: file.file, ok: false, reason: "file-drifted-after-refactor", expectedHash: file.afterHash, actualHash: sha256(current) });
      else { await fsp.writeFile(full, file.before, "utf8"); restored.push({ file: file.file, ok: true, restoredHash: file.beforeHash }); }
    }
    return toolResult({ generatedAt: new Date().toISOString(), projectPath, checkpointId, restored, ok: restored.every((r) => r.ok) }, config);
  }
  return { config, status, search, refactor, rollback, parseCliArgs, parseNodes, searchFile, refactorFile };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  STATE_DIR,
  configFromEnv,
  createAstTools,
  parseCliArgs,
  splitArgs,
  inferLanguage,
  parseNodes,
  searchFile,
  refactorFile,
  truncateHead,
  formatSize,
};
