"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { workingTreeRevision, revisionId } = require("./code-context-revision.js");

const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".cu", ".h", ".hh", ".hpp", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".kt", ".lean"]);
// .worktrees holds linked checkouts of the same repository on other branches;
// counting them would inflate the measured source footprint.
const EXCLUDED_DIRECTORIES = new Set([".git", ".pi", ".codegraph", ".worktrees", "node_modules", "vendor", "dist", "build", "coverage"]);
const OPTIONAL_BINARIES = Object.freeze(["serena", "scip", "scip-typescript", "zoekt", "zoekt-webserver", "codeql", "joern"]);
const SCALE_BARS = Object.freeze({ lexicalWarmP95Ms: 2000, semanticStartupP95Ms: 2000 });

function percentile(values, p = 0.95) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return rows.length ? rows[Math.min(rows.length - 1, Math.ceil(rows.length * p) - 1)] : null;
}
function sourceFootprint(root, options = {}) {
  const maximumFiles = Math.max(1, Number(options.maximumFiles || 200000));
  const extensionRoot = path.join(root, ".pi", "extensions");
  const stack = fs.existsSync(extensionRoot) ? [root, extensionRoot] : [root];
  let sourceFiles = 0; let sourceBytes = 0; let truncated = false;
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!EXCLUDED_DIRECTORIES.has(entry.name)) stack.push(absolute); continue; }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      sourceFiles += 1;
      try { sourceBytes += fs.statSync(absolute).size; } catch {}
      if (sourceFiles >= maximumFiles) { truncated = true; stack.length = 0; break; }
    }
  }
  return { sourceFiles, sourceBytes, truncated, maximumFiles };
}
function commandAvailable(binary, options = {}) {
  const result = (options.spawnSync || spawnSync)("which", [binary], { encoding: "utf8", timeout: 5000, shell: false });
  return result.status === 0;
}
function measureLexical(root, options = {}) {
  const iterations = Math.max(1, Math.min(100, Number(options.iterations || 10)));
  const runner = options.spawnSync || spawnSync;
  const rg = options.rgBin || process.env.PI_CODE_CONTEXT_RG_BIN || "rg";
  const durationsMs = []; const failures = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    const result = runner(rg, ["--json", "--max-count", "20", "createCodeContextService", "src", ".pi/extensions"], { cwd: root, encoding: "utf8", timeout: Number(options.timeoutMs || 10000), maxBuffer: 1024 * 1024, shell: false });
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    durationsMs.push(durationMs);
    if (![0, 1].includes(result.status)) failures.push({ iteration: index, status: result.status, signal: result.signal || null, code: result.error?.code || null });
  }
  return { provider: "rg-json", iterations, durationsMs: durationsMs.map((value) => Number(value.toFixed(3))), warmP95Ms: percentile(durationsMs.slice(1).length ? durationsMs.slice(1) : durationsMs), failures };
}
function evaluateScaleGates(measurements = {}, demand = {}) {
  const lexicalP95 = Number(measurements.lexical?.warmP95Ms);
  const semanticP95 = measurements.semanticStartupP95Ms == null ? null : Number(measurements.semanticStartupP95Ms);
  const nonnegative = (value, fallback) => { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : fallback; };
  const repositoryCount = Math.max(1, nonnegative(demand.repositoryCount, 1));
  const deepQueries = nonnegative(demand.classifiedDeepQueries, 0);
  const conceptualMisses = nonnegative(demand.conceptualIssueMisses, 0);
  const lexicalMeasured = Number.isFinite(lexicalP95) && (measurements.lexical?.failures?.length || 0) === 0;
  const semanticMeasured = Number.isFinite(semanticP95);
  const gates = {
    zoekt: { eligible: lexicalMeasured && lexicalP95 > SCALE_BARS.lexicalWarmP95Ms, measured: lexicalMeasured, value: lexicalMeasured ? lexicalP95 : null, bar: SCALE_BARS.lexicalWarmP95Ms, reason: !lexicalMeasured ? "lexical latency unavailable or degraded" : lexicalP95 > SCALE_BARS.lexicalWarmP95Ms ? "rg exceeds the warm latency bar" : "rg remains within the warm latency bar" },
    scip: { eligible: semanticMeasured && semanticP95 > SCALE_BARS.semanticStartupP95Ms, measured: semanticMeasured, value: semanticMeasured ? semanticP95 : null, bar: SCALE_BARS.semanticStartupP95Ms, reason: !semanticMeasured ? "no measured live-LSP startup/indexing pressure" : semanticP95 > SCALE_BARS.semanticStartupP95Ms ? "live semantic startup exceeds the materiality bar" : "live semantic startup remains within the materiality bar" },
    centralizedMultiRepository: { eligible: repositoryCount > 1, measured: true, value: repositoryCount, reason: repositoryCount > 1 ? "multi-repository deployment requested" : "single-repository deployment" },
    deepAnalysis: { eligible: deepQueries > 0, measured: true, value: deepQueries, reason: deepQueries > 0 ? "classified deep-analysis questions observed" : "no classified dataflow/path demand observed" },
    embeddings: { eligible: conceptualMisses > 0, measured: true, value: conceptualMisses, reason: conceptualMisses > 0 ? "conceptual retrieval misses observed" : "no measured conceptual retrieval misses" },
  };
  const eligibleProviders = Object.entries(gates).filter(([, gate]) => gate.eligible).map(([name]) => name);
  return { bars: SCALE_BARS, gates, eligible: eligibleProviders.length > 0, eligibleProviders, decision: eligibleProviders.length ? "review-optional-provider-pilot" : "block-batch-7", advisoryOnly: true };
}
function collectScaleGateEvidence(root, options = {}) {
  const footprint = sourceFootprint(root, options);
  const lexical = measureLexical(root, options);
  const binaries = Object.fromEntries(OPTIONAL_BINARIES.map((binary) => [binary, commandAvailable(binary, options)]));
  const demand = { repositoryCount: Number(options.repositoryCount || 1), classifiedDeepQueries: Number(options.classifiedDeepQueries || 0), conceptualIssueMisses: Number(options.conceptualIssueMisses || 0) };
  const measurements = { footprint, lexical, semanticStartupP95Ms: options.semanticStartupP95Ms == null ? null : Number(options.semanticStartupP95Ms), optionalBinaries: binaries };
  return { schemaVersion: 1, benchmark: "progressive-codebase-retrieval-scale-gates", measuredAt: new Date().toISOString(), revision: revisionId(workingTreeRevision(root)), measurements, demand, ...evaluateScaleGates(measurements, demand) };
}

module.exports = { SOURCE_EXTENSIONS, OPTIONAL_BINARIES, SCALE_BARS, percentile, sourceFootprint, commandAvailable, measureLexical, evaluateScaleGates, collectScaleGateEvidence };
