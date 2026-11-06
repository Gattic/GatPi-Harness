"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
// .worktrees holds linked checkouts of the same repository on other branches.
const DEFAULT_IGNORE = new Set([".git", ".claude", ".worktrees", "node_modules", "node_modules/.cache", ".pi", "dist", "build", "coverage", ".next", "target", "vendor"]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".d.ts", ".ts", ".js", ".json"]);

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function configFromEnv(env = process.env, overrides = {}) {
  return {
    enabled: env.PI_DOCS_LOOKUP !== "0",
    allowOutsideCwd: overrides.allowOutsideCwd != null ? Boolean(overrides.allowOutsideCwd) : env.PI_DOCS_ALLOW_OUTSIDE === "1",
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_DOCS_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_DOCS_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    maxFiles: clampNumber(Number(overrides.maxFiles || env.PI_DOCS_MAX_FILES || 3000), 1, 50000),
    maxResults: clampNumber(Number(overrides.maxResults || env.PI_DOCS_MAX_RESULTS || 20), 1, 200),
    maxFileBytes: clampNumber(Number(overrides.maxFileBytes || env.PI_DOCS_MAX_FILE_BYTES || 2_000_000), 1024, 20_000_000),
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
  if (!config.allowOutsideCwd && !isInside(cwd, absolute)) throw new Error(`docs_lookup project path must stay inside cwd (${cwd}). Set PI_DOCS_ALLOW_OUTSIDE=1 to allow ${absolute}.`);
  return absolute;
}
function normalizeProjectFile(projectPath, file) {
  const raw = stripAt(file);
  if (!raw) throw new Error("docs_lookup path must not be empty");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  if (!isInside(projectPath, absolute)) throw new Error(`docs_lookup path must stay inside project path: ${file}`);
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
      for (const ch of line) { if (Buffer.byteLength(acc + ch, "utf8") > maxBytes) break; acc += ch; }
      out.push(acc); bytes = Buffer.byteLength(acc, "utf8"); break;
    }
    out.push(line); bytes += lineBytes;
  }
  return { content: out.join("\n"), truncated: out.length < lines.length || bytes < totalBytes, outputLines: out.length, totalLines: lines.length, outputBytes: bytes, totalBytes };
}
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function readJson(file, fallback) { try { return JSON.parse(readText(file)); } catch { return fallback; } }
function stat(file) { try { return fs.statSync(file); } catch { return null; } }
function envReport(env = process.env) {
  return {
    PI_DOCS_LOOKUP: env.PI_DOCS_LOOKUP ?? null,
    PI_DOCS_ALLOW_OUTSIDE: env.PI_DOCS_ALLOW_OUTSIDE ?? null,
    PI_DOCS_MAX_LINES: env.PI_DOCS_MAX_LINES ?? null,
    PI_DOCS_MAX_BYTES: env.PI_DOCS_MAX_BYTES ?? null,
    PI_DOCS_MAX_FILES: env.PI_DOCS_MAX_FILES ?? null,
    PI_DOCS_MAX_RESULTS: env.PI_DOCS_MAX_RESULTS ?? null,
    PI_DOCS_MAX_FILE_BYTES: env.PI_DOCS_MAX_FILE_BYTES ?? null,
  };
}
function normalizeArray(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeArray);
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
function isIgnored(rel) {
  const parts = rel.split(/[\\/]+/);
  for (const part of parts) if (DEFAULT_IGNORE.has(part)) return true;
  return false;
}
function packageRoot(projectPath, packageName) {
  if (!packageName) return null;
  const base = path.join(projectPath, "node_modules");
  const root = packageName.startsWith("@") ? path.join(base, ...packageName.split("/")) : path.join(base, packageName);
  const st = stat(root);
  return st?.isDirectory() ? root : null;
}
function walkDocs(root, options = {}) {
  const out = [];
  const maxFiles = options.maxFiles || configFromEnv().maxFiles;
  const maxFileBytes = options.maxFileBytes || configFromEnv().maxFileBytes;
  function walk(relDir) {
    if (out.length >= maxFiles) return;
    let names = [];
    try { names = fs.readdirSync(path.join(root, relDir)); } catch { return; }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isIgnored(rel)) continue;
      const full = path.join(root, rel);
      const st = stat(full);
      if (!st) continue;
      if (st.isDirectory()) walk(rel);
      else if (st.isFile() && st.size <= maxFileBytes && isDocFile(rel, options)) out.push({ path: rel.replace(/\\/g, "/"), full, bytes: st.size, source: options.source || "local" });
      if (out.length >= maxFiles) break;
    }
  }
  walk("");
  return out;
}
function isDocFile(rel, options = {}) {
  const base = path.basename(rel).toLowerCase();
  const ext = path.extname(rel).toLowerCase();
  if (["readme", "readme.md", "changelog.md", "license", "license.md", "api.md", "index.d.ts"].includes(base)) return true;
  if (/^(docs?|documentation|guides?|examples?)\//i.test(rel)) return DOC_EXTENSIONS.has(ext);
  if (options.includeSourceTypes && [".d.ts", ".ts", ".js"].includes(ext)) return true;
  return [".md", ".mdx", ".txt", ".rst", ".adoc"].includes(ext);
}
function collectDocs(projectPath, params = {}, config = configFromEnv()) {
  const source = params.source || "all";
  const docs = [];
  if (source === "all" || source === "local") docs.push(...walkDocs(projectPath, { source: "local", maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, includeSourceTypes: params.includeSourceTypes }));
  if (source === "all" || source === "node_modules") {
    if (params.packageName) {
      const root = packageRoot(projectPath, params.packageName);
      if (root) docs.push(...walkDocs(root, { source: "node_modules", maxFiles: Math.min(config.maxFiles, 1000), maxFileBytes: config.maxFileBytes, includeSourceTypes: true }).map((d) => ({ ...d, packageName: params.packageName, path: `node_modules/${params.packageName}/${d.path}` })));
    } else {
      const nm = path.join(projectPath, "node_modules");
      const packageJsons = [];
      try {
        for (const name of fs.readdirSync(nm).slice(0, 500)) {
          if (name.startsWith(".")) continue;
          if (name.startsWith("@")) {
            for (const scoped of fs.readdirSync(path.join(nm, name)).slice(0, 200)) packageJsons.push(`${name}/${scoped}`);
          } else packageJsons.push(name);
        }
      } catch {}
      for (const pkg of packageJsons.slice(0, 200)) {
        const root = packageRoot(projectPath, pkg);
        if (!root) continue;
        for (const file of ["README.md", "readme.md", "CHANGELOG.md", "index.d.ts"]) {
          const full = path.join(root, file);
          const st = stat(full);
          if (st?.isFile() && st.size <= config.maxFileBytes) docs.push({ path: `node_modules/${pkg}/${file}`, full, bytes: st.size, source: "node_modules", packageName: pkg });
        }
      }
    }
  }
  return docs;
}
function queryTerms(query) {
  return String(query || "").toLowerCase().split(/[^a-z0-9_$@.-]+/).filter((t) => t.length > 1);
}
function snippetForLines(lines, lineIndex, context = 4) {
  const start = Math.max(0, lineIndex - context);
  const end = Math.min(lines.length, lineIndex + context + 1);
  return { startLine: start + 1, endLine: end, text: lines.slice(start, end).join("\n") };
}
function scoreDoc(text, terms) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const count = (lower.match(re) || []).length;
    score += count * (term.length > 4 ? 2 : 1);
  }
  return score;
}
function searchDocs(projectPath, params = {}, config = configFromEnv()) {
  const query = String(params.query || "").trim();
  if (!query) throw new Error("query is required");
  const terms = queryTerms(query);
  const docs = collectDocs(projectPath, params, config);
  const results = [];
  for (const doc of docs) {
    const text = readText(doc.full);
    const score = scoreDoc(text, terms);
    if (!score) continue;
    const lines = text.split(/\r?\n/);
    let bestLine = 0;
    let bestLineScore = -1;
    for (let i = 0; i < lines.length; i++) {
      const s = scoreDoc(lines[i], terms);
      if (s > bestLineScore) { bestLineScore = s; bestLine = i; }
    }
    const snippet = snippetForLines(lines, bestLine, params.contextLines == null ? 4 : Number(params.contextLines));
    results.push({ path: doc.path, source: doc.source, packageName: doc.packageName, bytes: doc.bytes, score, ...snippet });
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { generatedAt: new Date().toISOString(), projectPath, query, terms, source: params.source || "all", results: results.slice(0, params.maxResults || config.maxResults), summary: { searched: docs.length, matches: results.length, returned: Math.min(results.length, params.maxResults || config.maxResults) } };
}
function packageInfo(projectPath, params = {}) {
  const packageName = params.packageName;
  if (!packageName) throw new Error("packageName is required");
  const root = packageRoot(projectPath, packageName);
  if (!root) return { generatedAt: new Date().toISOString(), projectPath, packageName, found: false, guidance: `No node_modules package found for ${packageName}. Run package installation first or use source=local.` };
  const pkg = readJson(path.join(root, "package.json"), {});
  const docs = collectDocs(projectPath, { ...params, source: "node_modules", packageName }, configFromEnv()).slice(0, 50);
  const readme = docs.find((d) => /readme/i.test(path.basename(d.path)));
  return { generatedAt: new Date().toISOString(), projectPath, packageName, found: true, root: path.relative(projectPath, root).replace(/\\/g, "/"), package: { name: pkg.name, version: pkg.version, type: pkg.type, main: pkg.main, module: pkg.module, types: pkg.types || pkg.typings, exports: pkg.exports ? Object.keys(pkg.exports).slice(0, 20) : undefined, dependencies: pkg.dependencies ? Object.keys(pkg.dependencies).slice(0, 50) : [] }, docs: docs.map((d) => ({ path: d.path, bytes: d.bytes, source: d.source })).slice(0, 50), readmePreview: readme ? readText(readme.full).split(/\r?\n/).slice(0, 40).join("\n") : undefined };
}
function readDoc(projectPath, params = {}, config = configFromEnv()) {
  const rel = normalizeProjectFile(projectPath, params.file || params.path || "");
  const full = path.join(projectPath, rel);
  const st = stat(full);
  if (!st?.isFile()) throw new Error(`No doc file found: ${rel}`);
  if (st.size > config.maxFileBytes) throw new Error(`Doc file too large (${formatSize(st.size)}): ${rel}`);
  const lines = readText(full).split(/\r?\n/);
  const offset = Math.max(1, Number(params.offset || 1));
  const limit = clampNumber(Number(params.limit || 160), 1, 1000);
  return { generatedAt: new Date().toISOString(), projectPath, path: rel, offset, limit, totalLines: lines.length, text: lines.slice(offset - 1, offset - 1 + limit).join("\n") };
}
async function saveFullOutput(text) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-lookup-"));
  const file = path.join(dir, "output.txt");
  await fsp.writeFile(file, text, "utf8");
  return file;
}
async function toolResult(details, config, label = "docs_lookup") {
  let text = typeof details === "string" ? details : JSON.stringify(details, null, 2);
  const truncation = truncateHead(text, { maxLines: config.outputMaxLines, maxBytes: config.outputMaxBytes });
  text = truncation.content.trimEnd();
  if (truncation.truncated) {
    const fullOutputPath = await saveFullOutput(typeof details === "string" ? details : JSON.stringify(details, null, 2));
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
    else if (token === "--package" || token === "--package-name") opts.packageName = next();
    else if (token.startsWith("--package=")) opts.packageName = token.slice("--package=".length);
    else if (token === "--source") opts.source = next();
    else if (token.startsWith("--source=")) opts.source = token.slice("--source=".length);
    else if (token === "--max-results") opts.maxResults = Number(next());
    else if (token.startsWith("--max-results=")) opts.maxResults = Number(token.slice("--max-results=".length));
    else if (token === "--offset") opts.offset = Number(next());
    else if (token.startsWith("--offset=")) opts.offset = Number(token.slice("--offset=".length));
    else if (token === "--limit") opts.limit = Number(next());
    else if (token.startsWith("--limit=")) opts.limit = Number(token.slice("--limit=".length));
    else positional.push(token);
  }
  return { opts, positional };
}
function createDocsLookup(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  async function status(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    const local = collectDocs(projectPath, { source: "local" }, { ...config, maxFiles: Math.min(config.maxFiles, 1000) });
    const node = collectDocs(projectPath, { source: "node_modules", packageName: params.packageName }, { ...config, maxFiles: Math.min(config.maxFiles, 500) });
    return toolResult({ generatedAt: new Date().toISOString(), enabled: config.enabled, projectPath, localDocs: local.length, nodeModuleDocs: node.length, packageName: params.packageName || null, env: envReport(), advisory: "Local-first docs retrieval. No network access is performed." }, config);
  }
  async function search(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    return toolResult(searchDocs(projectPath, params, config), config);
  }
  async function read(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path || params.projectPath, config);
    return toolResult(readDoc(projectPath, params, config), config);
  }
  async function packageLookup(ctx, params = {}) {
    const projectPath = resolveProjectPath(ctx, params.path, config);
    return toolResult(packageInfo(projectPath, params), config);
  }
  return { config, status, search, read, packageLookup, parseCliArgs, collectDocs, searchDocs, packageInfo, readDoc };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  configFromEnv,
  createDocsLookup,
  parseCliArgs,
  splitArgs,
  collectDocs,
  searchDocs,
  packageInfo,
  readDoc,
  truncateHead,
  formatSize,
};
