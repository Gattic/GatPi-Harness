"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writePrivateJson } = require("./project-memory-decisions");
const { reviewedGoldManifestHash, reviewedGoldResultSet } = require("./memory-effectiveness-reviewed-gold");

const SCORECARD_SCHEMA_VERSION = 1;
const SCORE_STATUSES = Object.freeze(["pass", "fail", "blocked", "insufficient-data"]);
const EVIDENCE_CLASSES = Object.freeze(["lifetime", "deterministic", "migration", "exact-version-field", "synthetic-readiness", "real-fixture-vault-curation", "user-reviewed-gold"]);
function hashJson(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function loadJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function percentile(values, fraction) { if (!values.length) return null; const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]; }
function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
function statusFor(metric, bar, direction = "gte", prerequisites = true) { if (!prerequisites) return "blocked"; if (metric == null || !Number.isFinite(Number(metric))) return "insufficient-data"; return direction === "lte" ? (Number(metric) <= bar ? "pass" : "fail") : (Number(metric) >= bar ? "pass" : "fail"); }
function score(status, metric, bar, evidenceClass, sampleSize, note, gateEligible = true) { if (!SCORE_STATUSES.includes(status)) throw new Error(`invalid score status: ${status}`); return { status, metric, bar, evidenceClass, gateEligible: Boolean(gateEligible), sampleSize: Number(sampleSize || 0), ...(note ? { note } : {}) }; }
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
function buildScorecard({ manifest, source = {}, retrievalResults = [], saveResults = [], performance = {}, field = {}, curation = {}, migration = {}, privacy = {}, evidence = {}, generatedAt = new Date().toISOString() } = {}) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("memory effectiveness manifest schemaVersion 1 required");
  if (!["synthetic-readiness", "user-reviewed-gold"].includes(manifest.evidenceClass)) throw new Error("memory effectiveness manifest requires an explicit synthetic-readiness or user-reviewed-gold evidenceClass");
  const retrieval = evaluateRetrieval(manifest, retrievalResults); const saves = evaluateSaves(manifest, saveResults); const bars = manifest.bars || {}; const manifestHash = reviewedGoldManifestHash(manifest); const reviewedResultSet = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
  const expectedReviewedCases = retrieval.cases.length + saves.total;
  const reviewedGoldQualified = evidence.evidenceClass === "user-reviewed-gold"
    && evidence.evidenceQualified === true
    && /^reviewed-gold-evidence:[a-f0-9]{64}$/.test(String(evidence.evidenceId || ""))
    && evidence.reviewedManifestHash === manifestHash
    && evidence.reviewedCaseSetId === reviewedResultSet.caseSetId
    && evidence.reviewedResultSetId === reviewedResultSet.resultSetId
    && evidence.sourceRevision === source.revision
    && evidence.sourceConfigHash === source.configHash
    && reviewedResultSet.summary.complete === true
    && Number(evidence.reviewedCases) === expectedReviewedCases
    && Number(evidence.expectedReviewedCases) === expectedReviewedCases;
  const temporalReady = Number(field.exactVersionUses) >= Number(bars.minimumExactVersionUses || 30) && Number(field.independentSessions) >= Number(bars.minimumIndependentSessions || 10) && Number(field.observedDays) >= Number(bars.minimumObservedDays || 14); const exactVersionFieldQualified = temporalReady && field.evidenceClass === "exact-version-field" && typeof field.cohortId === "string" && field.cohortId.length > 0 && field.sourceRevision === source.revision;
  const realCurationQualified = Number(curation.attempts || 0) >= 20 && curation.evidenceClass === "real-fixture-vault-curation" && curation.fixtureVault === true;
  const retrievalEvidenceClass = reviewedGoldQualified ? "user-reviewed-gold" : "synthetic-readiness";
  const unresolvedHighSeverity = Number(privacy.unresolvedHighSeverity || 0);
  const unresolvedActionable = Number(privacy.unresolvedActionable || 0);
  const privacyEvidenceQualified = privacy.evidenceQualified === true;
  const privacyMetric = unresolvedHighSeverity + unresolvedActionable;
  const privacyBoundarySafe = validatePrivacyBoundary({ manifest, source, retrievalResults, saveResults, performance, field, curation, migration, privacy, evidence }).ok;
  const scores = {
    privacyBoundary: score(privacyBoundarySafe && privacyEvidenceQualified && privacyMetric === 0 ? "pass" : "fail", privacyMetric, 0, "deterministic", Number(privacy.candidateCount || (privacyMetric + Number(privacy.reviewedCandidates || 0))), privacyEvidenceQualified ? undefined : "current identity-bound privacy evidence and completed human review are required", privacyEvidenceQualified),
    retrievalPrecisionAt5: score(statusFor(retrieval.precisionAt5, bars.precisionAt5), retrieval.precisionAt5, bars.precisionAt5, retrievalEvidenceClass, retrieval.cases.length, reviewedGoldQualified ? undefined : "synthetic fixtures validate deterministic behavior only; signed reviewed gold is absent", reviewedGoldQualified),
    retrievalRecallAt5: score(statusFor(retrieval.recallAt5, bars.recallAt5), retrieval.recallAt5, bars.recallAt5, retrievalEvidenceClass, retrieval.cases.length, reviewedGoldQualified ? undefined : "synthetic fixtures validate deterministic behavior only; signed reviewed gold is absent", reviewedGoldQualified),
    crossProjectContamination: score(statusFor(retrieval.contamination, bars.crossProjectContamination, "lte"), retrieval.contamination, bars.crossProjectContamination, "deterministic", retrieval.cases.length),
    localRecallP95Ms: score(statusFor(performance.localRecallP95Ms, bars.localRecallP95Ms, "lte"), performance.localRecallP95Ms ?? null, bars.localRecallP95Ms, "deterministic", Number(performance.localRecallSamples || 0)),
    explicitSavePrecision: score(statusFor(saves.precision, bars.explicitSavePrecision), saves.precision, bars.explicitSavePrecision, retrievalEvidenceClass, saves.total, reviewedGoldQualified ? undefined : "synthetic fixtures validate deterministic behavior only; signed reviewed gold is absent", reviewedGoldQualified),
    automaticSavePrecision: score(exactVersionFieldQualified ? statusFor(field.automaticSavePrecision, bars.automaticSavePrecision) : "blocked", field.automaticSavePrecision ?? null, bars.automaticSavePrecision, "exact-version-field", Number(field.independentSessions || 0), exactVersionFieldQualified ? undefined : "qualified exact-version cohort, source revision, independent sessions, and observed days are required", exactVersionFieldQualified),
    currentFactStaleRate: score(Number(field.independentSessions || 0) === 0 ? "insufficient-data" : (exactVersionFieldQualified ? statusFor(field.currentFactStaleRate, bars.currentFactStaleRate, "lte") : "blocked"), field.currentFactStaleRate ?? null, bars.currentFactStaleRate, "exact-version-field", Number(field.independentSessions || 0), exactVersionFieldQualified ? undefined : "unqualified field evidence", exactVersionFieldQualified),
    exactVersionUses: score(Number(field.exactVersionUses || 0) === 0 ? "insufficient-data" : (exactVersionFieldQualified ? statusFor(field.exactVersionUses, bars.minimumExactVersionUses) : "blocked"), Number(field.exactVersionUses || 0), bars.minimumExactVersionUses, "exact-version-field", Number(field.exactVersionUses || 0), exactVersionFieldQualified ? undefined : "unqualified field evidence", exactVersionFieldQualified),
    exactVersionSessions: score(Number(field.independentSessions || 0) === 0 ? "insufficient-data" : (exactVersionFieldQualified ? statusFor(field.independentSessions, bars.minimumIndependentSessions) : "blocked"), Number(field.independentSessions || 0), bars.minimumIndependentSessions, "exact-version-field", Number(field.independentSessions || 0), exactVersionFieldQualified ? undefined : "unqualified field evidence", exactVersionFieldQualified),
    observedDays: score(Number(field.observedDays || 0) === 0 ? "insufficient-data" : (exactVersionFieldQualified ? statusFor(field.observedDays, bars.minimumObservedDays) : "blocked"), Number(field.observedDays || 0), bars.minimumObservedDays, "exact-version-field", Number(field.independentSessions || 0), exactVersionFieldQualified ? undefined : "unqualified field evidence", exactVersionFieldQualified),
    realCuration: score(Number(curation.attempts || 0) < 20 ? "insufficient-data" : (realCurationQualified ? (Number(curation.successRate) >= 0.9 && Number(curation.timeoutRate) <= 0.1 && Number(curation.p95Ms) <= 120000 ? "pass" : "fail") : "blocked"), curation.successRate ?? null, 0.9, "real-fixture-vault-curation", Number(curation.attempts || 0), realCurationQualified ? undefined : "real fixture-vault provenance is required", realCurationQualified),
    migrationRollback: score(migration.rollbackPassed === true ? "pass" : (migration.previewPassed === true ? "blocked" : "insufficient-data"), migration.rollbackPassed ?? null, true, "migration", Number(migration.fixtures || 0)),
  };
  const values = Object.values(scores).map((row) => row.status); const deterministicReady = [scores.privacyBoundary, scores.crossProjectContamination, scores.localRecallP95Ms, scores.migrationRollback].every((row) => row.status === "pass"); const releaseReady = values.every((value) => value === "pass") && Object.values(scores).every((row) => row.gateEligible); const highestAuthorizedStage = !deterministicReady || !reviewedGoldQualified ? "M0" : !realCurationQualified ? "M2" : !exactVersionFieldQualified ? "M3" : (releaseReady ? "M5" : "M3");
  return { schemaVersion: SCORECARD_SCHEMA_VERSION, generatedAt, classifierVersion: manifest.classifierVersion, manifestHash, source: { revision: source.revision || "unknown", configHash: source.configHash || "unknown", activeSessionExclusion: source.activeSessionExclusion || { requested: 0, matched: 0, excluded: 0, unmatched: 0 } }, evidenceClasses: EVIDENCE_CLASSES, evidenceQualification: { manifestEvidenceClass: manifest.evidenceClass, reviewedGoldQualified, reviewedGoldEvidenceId: reviewedGoldQualified ? evidence.evidenceId : null, exactVersionFieldQualified, realCurationQualified, expectedReviewedCases }, bars, aggregates: { retrieval, saves, performance, field, curation, migration, privacy }, scores, decision: releaseReady ? "ship" : "no-go-deferred", highestAuthorizedStage, automaticBehaviorAuthorized: releaseReady };
}
function writePrivateScorecard(file, scorecard) { const privacy = validatePrivacyBoundary(scorecard); if (!privacy.ok) throw new Error(`scorecard privacy validation failed: ${privacy.issues.join(",")}`); writePrivateJson(path.resolve(file), scorecard); return { file: path.resolve(file), hash: `sha256:${hashJson(scorecard)}` }; }

module.exports = { SCORECARD_SCHEMA_VERSION, SCORE_STATUSES, EVIDENCE_CLASSES, hashJson, percentile, evaluateRetrieval, evaluateSaves, validatePrivacyBoundary, buildScorecard, writePrivateScorecard, loadJson };
