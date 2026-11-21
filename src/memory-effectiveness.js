"use strict";

// Reporting-only memory effectiveness scorecard. Stage eligibility comes from
// passive telemetry in memory-rollout-telemetry.js; this module summarizes the
// declared fixtures and measurements without authorizing any stage.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writePrivateJson } = require("./project-memory-decisions");

const SCORECARD_SCHEMA_VERSION = 1;
const SCORE_STATUSES = Object.freeze(["pass", "fail", "blocked", "insufficient-data"]);
const EVIDENCE_CLASSES = Object.freeze(["lifetime", "deterministic", "migration", "synthetic-readiness"]);

function hashJson(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalValue(value[key])]));
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function manifestHashOf(manifest) { return `sha256:${crypto.createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`; }
function loadJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function percentile(values, fraction) { if (!values.length) return null; const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]; }
function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
function statusFor(metric, bar, direction = "gte") { if (metric == null || !Number.isFinite(Number(metric))) return "insufficient-data"; return direction === "lte" ? (Number(metric) <= bar ? "pass" : "fail") : (Number(metric) >= bar ? "pass" : "fail"); }
function score(status, metric, bar, evidenceClass, sampleSize, note) { if (!SCORE_STATUSES.includes(status)) throw new Error(`invalid score status: ${status}`); return { status, metric, bar, evidenceClass, sampleSize: Number(sampleSize || 0), ...(note ? { note } : {}) }; }
function evaluateRetrieval(manifest, results = []) {
  const byId = new Map(results.map((row) => [row.id, row])); let relevantReturned = 0; let relevantTotal = 0; let returnedAt5 = 0; let contamination = 0; let knownMisses = 0;
  const cases = [];
  for (const expected of manifest.retrievalCases || []) {
    const result = byId.get(expected.id) || { rankedIds: [] }; const top = (result.rankedIds || []).slice(0, 5); const relevant = expected.relevantIds || []; const hits = relevant.filter((id) => top.includes(id)); const forbiddenHits = (expected.forbiddenIds || []).filter((id) => top.includes(id));
    relevantReturned += hits.length; relevantTotal += relevant.length; returnedAt5 += top.length; contamination += forbiddenHits.length; if (hits.length < relevant.length) knownMisses++;
    cases.push({ id: expected.id, relevant: relevant.length, hits: hits.length, returnedAt5: top.length, forbiddenHits: forbiddenHits.length, passed: hits.length === relevant.length && forbiddenHits.length === 0 && relevant.every((id) => top.indexOf(id) < Number(expected.requiredTopK || 5)) });
  }
  return { cases, precisionAt5: ratio(relevantReturned, returnedAt5), recallAt5: ratio(relevantReturned, relevantTotal), relevantReturned, relevantTotal, returnedAt5, contamination, knownMisses };
}
function evaluateSaves(manifest, results = []) {
  const byId = new Map(results.map((row) => [row.id, row.outcome])); let correct = 0; let total = 0;
  const cases = (manifest.saveCases || []).map((expected) => { const actual = byId.get(expected.id) || "missing"; const passed = actual === expected.expected; total++; if (passed) correct++; return { id: expected.id, expected: expected.expected, actual, passed }; });
  return { cases, correct, total, precision: ratio(correct, total) };
}
function validatePrivacyBoundary(value) {
  const text = JSON.stringify(value);
  const issues = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}/.test(text)) issues.push("secret-like-value");
  if (/\/home\/[^\s"']+|\/Users\/[^\s"']+|[A-Za-z]:\\\\Users\\\\/.test(text)) issues.push("local-path");
  if (/"(?:prompt|transcript|reasoning|toolOutput|command|sessionId)"\s*:/i.test(text)) issues.push("forbidden-field");
  return { ok: issues.length === 0, issues };
}
function buildScorecard({ manifest, source = {}, retrievalResults = [], saveResults = [], performance = {}, field = {}, curation = {}, migration = {}, privacy = {}, generatedAt = new Date().toISOString() } = {}) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("memory effectiveness manifest schemaVersion 1 required");
  if (manifest.evidenceClass !== "synthetic-readiness") throw new Error("memory effectiveness manifest requires evidenceClass synthetic-readiness");
  const retrieval = evaluateRetrieval(manifest, retrievalResults);
  const saves = evaluateSaves(manifest, saveResults);
  const bars = manifest.bars || {};
  const manifestHash = manifestHashOf(manifest);
  const fieldSessions = Number(field.independentSessions || 0);
  const curationAttempts = Number(curation.attempts || 0);
  const privacyMetric = Number(privacy.unresolvedHighSeverity || 0) + Number(privacy.unresolvedActionable || 0);
  const privacyBoundarySafe = validatePrivacyBoundary({ manifest, source, retrievalResults, saveResults, performance, field, curation, migration, privacy }).ok;
  const syntheticNote = "synthetic fixtures validate deterministic behavior only; stage gates read passive telemetry";
  const scores = {
    privacyBoundary: score(privacyBoundarySafe && privacyMetric === 0 ? "pass" : "fail", privacyMetric, 0, "deterministic", Number(privacy.candidateCount || privacyMetric)),
    retrievalPrecisionAt5: score(statusFor(retrieval.precisionAt5, bars.precisionAt5), retrieval.precisionAt5, bars.precisionAt5, "synthetic-readiness", retrieval.cases.length, syntheticNote),
    retrievalRecallAt5: score(statusFor(retrieval.recallAt5, bars.recallAt5), retrieval.recallAt5, bars.recallAt5, "synthetic-readiness", retrieval.cases.length, syntheticNote),
    crossProjectContamination: score(statusFor(retrieval.contamination, bars.crossProjectContamination, "lte"), retrieval.contamination, bars.crossProjectContamination, "deterministic", retrieval.cases.length),
    localRecallP95Ms: score(statusFor(performance.localRecallP95Ms, bars.localRecallP95Ms, "lte"), performance.localRecallP95Ms ?? null, bars.localRecallP95Ms, "deterministic", Number(performance.localRecallSamples || 0)),
    explicitSavePrecision: score(statusFor(saves.precision, bars.explicitSavePrecision), saves.precision, bars.explicitSavePrecision, "synthetic-readiness", saves.total, syntheticNote),
    automaticSavePrecision: score(fieldSessions === 0 ? "insufficient-data" : statusFor(field.automaticSavePrecision, bars.automaticSavePrecision), field.automaticSavePrecision ?? null, bars.automaticSavePrecision, "lifetime", fieldSessions, "declared field measurement; the A gate reads passive telemetry"),
    currentFactStaleRate: score(fieldSessions === 0 ? "insufficient-data" : statusFor(field.currentFactStaleRate, bars.currentFactStaleRate, "lte"), field.currentFactStaleRate ?? null, bars.currentFactStaleRate, "lifetime", fieldSessions),
    exactVersionUses: score(Number(field.exactVersionUses || 0) === 0 ? "insufficient-data" : statusFor(field.exactVersionUses, bars.minimumExactVersionUses), Number(field.exactVersionUses || 0), bars.minimumExactVersionUses, "lifetime", Number(field.exactVersionUses || 0)),
    exactVersionSessions: score(fieldSessions === 0 ? "insufficient-data" : statusFor(fieldSessions, bars.minimumIndependentSessions), fieldSessions, bars.minimumIndependentSessions, "lifetime", fieldSessions),
    observedDays: score(Number(field.observedDays || 0) === 0 ? "insufficient-data" : statusFor(field.observedDays, bars.minimumObservedDays), Number(field.observedDays || 0), bars.minimumObservedDays, "lifetime", fieldSessions),
    realCuration: score(curationAttempts < 20 ? "insufficient-data" : (Number(curation.successRate) >= 0.9 && Number(curation.timeoutRate) <= 0.1 && Number(curation.p95Ms) <= 120000 ? "pass" : "fail"), curation.successRate ?? null, 0.9, "lifetime", curationAttempts),
    migrationRollback: score(migration.rollbackPassed === true ? "pass" : (migration.previewPassed === true ? "blocked" : "insufficient-data"), migration.rollbackPassed ?? null, true, "migration", Number(migration.fixtures || 0)),
  };
  const releaseReady = Object.values(scores).every((row) => row.status === "pass");
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    authority: "reporting-only",
    generatedAt,
    classifierVersion: manifest.classifierVersion,
    manifestHash,
    source: { revision: source.revision || "unknown", configHash: source.configHash || "unknown", activeSessionExclusion: source.activeSessionExclusion || { requested: 0, matched: 0, excluded: 0, unmatched: 0 } },
    evidenceClasses: EVIDENCE_CLASSES,
    bars,
    aggregates: { retrieval, saves, performance, field, curation, migration, privacy },
    scores,
    decision: releaseReady ? "ship" : "no-go-deferred",
  };
}
function writePrivateScorecard(file, scorecard) { const privacy = validatePrivacyBoundary(scorecard); if (!privacy.ok) throw new Error(`scorecard privacy validation failed: ${privacy.issues.join(",")}`); writePrivateJson(path.resolve(file), scorecard); return { file: path.resolve(file), hash: `sha256:${hashJson(scorecard)}` }; }

module.exports = { SCORECARD_SCHEMA_VERSION, SCORE_STATUSES, EVIDENCE_CLASSES, hashJson, canonicalJson, manifestHashOf, percentile, evaluateRetrieval, evaluateSaves, validatePrivacyBoundary, buildScorecard, writePrivateScorecard, loadJson };
