"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BENCHMARK_ID = "progressive-codebase-retrieval";
const BENCHMARK_SCHEMA_VERSION = 4;
const COHORT_SCHEMA_VERSION = 1;
const BENCHMARK_CONFIG_VERSION = "code-context-semantic-bars-v2";
const SEMANTIC_BARS = Object.freeze({ definitionMrr: 0.90, fileRecallAt5: 0.95, retrievalDegradationCount: 0 });
const SOURCE_FILES = Object.freeze([
  "src/code-context-contracts.js",
  "src/code-context-service.js",
  "src/code-context-rollout.js",
  "src/repository-map.js",
  "src/change-impact.js",
  "src/codegraph-adapter.js",
  "src/code-context-gold-review.js",
  "scripts/benchmark-code-context.js",
  "scripts/run-code-context-paired-benchmark.js",
  "scripts/run-code-context-test-selection-benchmark.js",
]);
const RUNTIME_CONFIG_KEYS = Object.freeze([
  "PI_CODEGRAPH", "PI_CODEGRAPH_BIN", "PI_CODEGRAPH_ADVISORY",
  "PI_LSP", "PI_LSP_LIVE", "PI_SEMGREP", "PI_SEMGREP_BIN", "PI_SEMGREP_CONFIG", "PI_SEMGREP_METRICS",
]);

function stable(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
}
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex"); }
function fileFingerprint(root, files) {
  const rows = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    try { rows.push({ file, hash: sha256(fs.readFileSync(absolute)) }); }
    catch { return null; }
  }
  return sha256(rows);
}
function runtimeProviderConfigHash(env = process.env) {
  return sha256(Object.fromEntries(RUNTIME_CONFIG_KEYS.map((key) => [key, env[key] ?? null])));
}
function currentCodeContextCohort(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  const manifestFile = options.manifestFile || path.join(projectRoot, "tests", "fixtures", "code-context", "manifest.json");
  let fixtureManifestHash = null;
  try { fixtureManifestHash = sha256(fs.readFileSync(manifestFile)); } catch {}
  const sourceFingerprint = fileFingerprint(projectRoot, options.sourceFiles || SOURCE_FILES);
  const benchmarkConfigHash = sha256({ version: BENCHMARK_CONFIG_VERSION, bars: options.bars || SEMANTIC_BARS });
  const strategyId = String(options.strategyId || process.env.PI_CODE_CONTEXT_STRATEGY_ID || "repository-map-v1");
  const providerConfigHash = String(options.providerConfigHash || runtimeProviderConfigHash(options.env || process.env));
  const fields = {
    schemaVersion: COHORT_SCHEMA_VERSION,
    benchmarkSchemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmark: BENCHMARK_ID,
    sourceFingerprint,
    benchmarkConfigVersion: BENCHMARK_CONFIG_VERSION,
    benchmarkConfigHash,
    fixtureManifestHash,
    strategyId,
    providerConfigHash,
  };
  const complete = Boolean(sourceFingerprint && fixtureManifestHash && strategyId && providerConfigHash);
  return { ...fields, complete, cohortKey: complete ? sha256(fields) : null };
}
function compareCodeContextCohorts(expected, actual) {
  const fields = ["schemaVersion", "benchmarkSchemaVersion", "benchmark", "sourceFingerprint", "benchmarkConfigVersion", "benchmarkConfigHash", "fixtureManifestHash", "strategyId", "providerConfigHash"];
  const changedFields = fields.filter((field) => expected?.[field] !== actual?.[field]);
  const compatible = Boolean(expected?.complete && actual?.complete && expected?.cohortKey && expected.cohortKey === actual.cohortKey && changedFields.length === 0);
  return { compatible, comparisonReason: compatible ? "exact-cohort-match" : !expected?.complete ? "expected-cohort-incomplete" : !actual?.complete ? "report-cohort-incomplete" : "cohort-mismatch", changedFields };
}

module.exports = {
  BENCHMARK_ID,
  BENCHMARK_SCHEMA_VERSION,
  COHORT_SCHEMA_VERSION,
  BENCHMARK_CONFIG_VERSION,
  SEMANTIC_BARS,
  SOURCE_FILES,
  RUNTIME_CONFIG_KEYS,
  sha256,
  fileFingerprint,
  runtimeProviderConfigHash,
  currentCodeContextCohort,
  compareCodeContextCohorts,
};
