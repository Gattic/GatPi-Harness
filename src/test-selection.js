"use strict";

// Affected-test selection for the test runner.
//
// Filename-substring matching ("lexical") cannot answer "which tests exercise
// this module": 49 of 192 src modules have no lexically matching test, and a
// module with a differently named test (src/trace-observability.js ->
// tests/trace-adapter.test.js) was verified by unrelated queue/adapter tests.
// This module builds a static import graph of the project and selects tests
// that transitively depend on a changed file. Lexical stem matching is kept as
// a complementary signal for docs and scripts, but it never fabricates a
// passing verification on its own.

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20000;
const IGNORED_NAMES = new Set([
  ".git", ".worktrees", "node_modules", ".codegraph", ".pytest_cache",
  "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__",
  ".venv", "venv", "summaryexample_files",
]);
const RESOLVE_SUFFIXES = [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".mts", ".cts"];

function normalizePath(file) { return String(file || "").replace(/\\/g, "/"); }

function shouldSkip(relative, name) {
  if (IGNORED_NAMES.has(name)) return true;
  const parts = relative.split("/");
  // .pi holds runtime state; only project extension sources are code. The .pi
  // directory itself is walked so .pi/extensions can be reached.
  if (relative === ".pi") return false;
  if (parts[0] === ".pi" && parts[1] !== "extensions") return true;
  return false;
}

function walkSourceFiles(cwd, { maxFiles = DEFAULT_MAX_FILES, maxBytes = MAX_SOURCE_BYTES } = {}) {
  const root = path.resolve(cwd);
  const files = [];
  let truncated = false;
  let skipped = 0;
  const walk = (directory, relative) => {
    let names;
    try { names = fs.readdirSync(directory).sort(); } catch { skipped++; return; }
    for (const name of names) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const childRelative = relative ? `${relative}/${name}` : name;
      if (shouldSkip(childRelative, name)) continue;
      const child = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(child); } catch { skipped++; continue; }
      if (stat.isSymbolicLink()) { skipped++; continue; }
      if (stat.isDirectory()) { walk(child, childRelative); continue; }
      if (!stat.isFile() || !SOURCE_EXTENSIONS.test(name)) continue;
      if (stat.size > maxBytes) { skipped++; continue; }
      files.push(childRelative);
    }
  };
  walk(root, "");
  return { files, truncated, skipped };
}

function parseSpecifiers(text) {
  const specifiers = [];
  const patterns = [
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bexport\s+[^;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) specifiers.push(match[1]);
  }
  return Array.from(new Set(specifiers));
}

function resolveSpecifier(fromRelative, specifier, fileSet, cwd = process.cwd()) {
  const value = String(specifier || "").trim();
  if (!value || !(value.startsWith(".") || value.startsWith("/"))) return null;
  const base = value.startsWith("/")
    ? normalizePath(path.relative(path.resolve(cwd), value))
    : normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), value)));
  const candidates = [base, ...RESOLVE_SUFFIXES.map((suffix) => `${base}${suffix}`)];
  for (const suffix of RESOLVE_SUFFIXES) candidates.push(`${base}/index${suffix}`);
  for (const candidate of candidates) if (fileSet.has(candidate)) return candidate;
  return null;
}

function buildImportGraph(cwd, options = {}) {
  const { files, truncated, skipped: initialSkipped } = walkSourceFiles(cwd, options);
  const fileSet = new Set(files);
  const graph = new Map();
  let skipped = initialSkipped;
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(cwd, file), "utf8"); } catch { graph.set(file, []); skipped++; continue; }
    const dependencies = [];
    for (const specifier of parseSpecifiers(text)) {
      const resolved = resolveSpecifier(file, specifier, fileSet, cwd);
      if (resolved && resolved !== file) dependencies.push(resolved);
    }
    graph.set(file, Array.from(new Set(dependencies)).sort());
  }
  return { graph, files, truncated, skipped, complete: !truncated && skipped === 0 };
}

function reverseDependents(graph) {
  const dependents = new Map();
  for (const [file, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!dependents.has(dependency)) dependents.set(dependency, new Set());
      dependents.get(dependency).add(file);
    }
  }
  return dependents;
}

function lexicalStem(file) {
  const base = path.posix.basename(normalizePath(file)).replace(/\.[^.]+$/, "").toLowerCase();
  return base === "index" ? path.posix.basename(path.posix.dirname(normalizePath(file))).toLowerCase() : base;
}

function lexicalMatches(changedFiles, testFiles) {
  const matches = [];
  for (const changed of changedFiles) {
    const stem = lexicalStem(changed);
    if (stem.length < 4) continue;
    for (const test of testFiles) {
      if (normalizePath(test).toLowerCase().includes(stem)) matches.push(test);
    }
  }
  return Array.from(new Set(matches));
}

function affectedTestFiles({ cwd = process.cwd(), changedFiles = [], testFiles = [], graph = null, maxFiles } = {}) {
  const changed = Array.from(new Set(changedFiles.map(normalizePath)));
  const tests = Array.from(new Set(testFiles.map(normalizePath)));
  const testSet = new Set(tests);
  const importGraph = graph || buildImportGraph(cwd, { maxFiles }).graph;
  const dependents = reverseDependents(importGraph);
  const selected = new Set();
  const direct = [];
  const viaImport = [];

  for (const file of changed) {
    if (testSet.has(file)) { selected.add(file); direct.push(file); }
  }
  // Walk dependents from every changed non-test file. This is the reverse
  // closure: any test that imports the file directly or through a helper.
  const queue = changed.filter((file) => !testSet.has(file));
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    for (const dependent of dependents.get(current) || []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      if (testSet.has(dependent)) { selected.add(dependent); viaImport.push(dependent); }
      else queue.push(dependent);
    }
  }

  const lexical = lexicalMatches(changed, tests).filter((test) => !selected.has(test));
  for (const test of lexical) selected.add(test);

  const ordered = Array.from(selected).sort();
  const strategies = [];
  if (direct.length) strategies.push("direct");
  if (viaImport.length) strategies.push("import-graph");
  if (lexical.length) strategies.push("lexical");
  return {
    testFiles: ordered,
    strategies,
    direct: direct.sort(),
    importGraph: viaImport.sort(),
    lexical: lexical.sort(),
    changedFiles: changed,
    discoveredTestFiles: tests.length,
    graph: { files: importGraph.size, complete: graph ? graph.complete !== false : true },
    truncated: Boolean(graph && graph.truncated),
  };
}

module.exports = {
  IGNORED_NAMES,
  SOURCE_EXTENSIONS,
  normalizePath,
  walkSourceFiles,
  parseSpecifiers,
  resolveSpecifier,
  buildImportGraph,
  reverseDependents,
  lexicalStem,
  lexicalMatches,
  affectedTestFiles,
};
