"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadJson, evaluateRetrieval, evaluateSaves, validatePrivacyBoundary, buildScorecard, writePrivateScorecard, percentile } = require("../src/memory-effectiveness");
const { reviewedGoldResultSet } = require("../src/memory-effectiveness-reviewed-gold");
const { tmpFixture } = require("./helpers/tmp-fixture");

const manifest = loadJson(path.join(__dirname, "fixtures", "memory-effectiveness", "manifest.json"));
assert.equal(validatePrivacyBoundary(manifest).ok, true);
const retrievalResults = manifest.retrievalCases.map((row) => ({ id: row.id, rankedIds: [...row.relevantIds] }));
const saveResults = manifest.saveCases.map((row) => ({ id: row.id, outcome: row.expected }));
const qualifiedPrivacy = { evidenceId: "privacy-evidence:fixture", scanId: "privacy-scan:fixture", evidenceQualified: true, unresolvedHighSeverity: 0, unresolvedActionable: 0, reviewedCandidates: 4, candidateCount: 4 };
const retrieval = evaluateRetrieval(manifest, retrievalResults);
assert.equal(retrieval.recallAt5, 1);
assert.ok(retrieval.precisionAt5 >= 0.9);
assert.equal(retrieval.contamination, 0);
assert.equal(evaluateSaves(manifest, saveResults).precision, 1);
assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);

const scorecard = buildScorecard({
  manifest,
  source: { revision: "abc123", configHash: "sha256:test", activeSessionExclusion: { requested: 1, matched: 1, excluded: 1, unmatched: 0 } },
  retrievalResults,
  saveResults,
  performance: { localRecallP95Ms: 12, localRecallSamples: 50 },
  field: { independentSessions: 3, observedDays: 1, currentFactStaleRate: 0 },
  curation: { attempts: 1, successRate: 1, timeoutRate: 0, p95Ms: 20 },
  migration: { previewPassed: true, rollbackPassed: false, fixtures: 1 },
  privacy: qualifiedPrivacy,
});
assert.equal(scorecard.scores.retrievalPrecisionAt5.status, "pass");
assert.equal(scorecard.scores.retrievalPrecisionAt5.evidenceClass, "synthetic-readiness", "unreviewed fixture output is never labeled user-reviewed gold");
assert.equal(scorecard.scores.retrievalPrecisionAt5.gateEligible, false);
assert.equal(scorecard.scores.exactVersionSessions.status, "blocked", "numeric field samples without exact-version cohort provenance cannot authorize a field gate");
assert.equal(scorecard.scores.automaticSavePrecision.status, "blocked");
assert.equal(scorecard.scores.realCuration.status, "insufficient-data");
assert.equal(scorecard.decision, "no-go-deferred");
assert.equal(scorecard.automaticBehaviorAuthorized, false);
assert.equal(scorecard.highestAuthorizedStage, "M0");
assert.equal(scorecard.evidenceQualification.reviewedGoldQualified, false);
assert.equal(scorecard.scores.privacyBoundary.status, "pass");
assert.equal(validatePrivacyBoundary(scorecard).ok, true);
const unboundPrivacy = buildScorecard({ manifest, privacy: { unresolvedHighSeverity: 0, unresolvedActionable: 0 } });
assert.equal(unboundPrivacy.scores.privacyBoundary.status, "fail", "bare zero counts cannot satisfy the privacy gate");
assert.equal(unboundPrivacy.scores.privacyBoundary.gateEligible, false);
const reviewedSet = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
const reviewedScorecard = buildScorecard({ manifest, source: { revision: "abc123", configHash: "sha256:test" }, retrievalResults, saveResults, performance: { localRecallP95Ms: 12, localRecallSamples: 50 }, evidence: { evidenceClass: "user-reviewed-gold", evidenceId: `reviewed-gold-evidence:${"a".repeat(64)}`, evidenceQualified: true, reviewedManifestHash: reviewedSet.manifestHash, reviewedCaseSetId: reviewedSet.caseSetId, reviewedResultSetId: reviewedSet.resultSetId, sourceRevision: "abc123", sourceConfigHash: "sha256:test", reviewedCases: manifest.retrievalCases.length + manifest.saveCases.length, expectedReviewedCases: manifest.retrievalCases.length + manifest.saveCases.length }, migration: { rollbackPassed: true, fixtures: 1 }, privacy: qualifiedPrivacy });
assert.equal(reviewedScorecard.scores.retrievalPrecisionAt5.evidenceClass, "user-reviewed-gold");
assert.equal(reviewedScorecard.scores.retrievalPrecisionAt5.gateEligible, true);
assert.equal(reviewedScorecard.evidenceQualification.reviewedGoldEvidenceId, `reviewed-gold-evidence:${"a".repeat(64)}`);
const spoofedReview = buildScorecard({ manifest, retrievalResults, saveResults, evidence: { userReviewedGold: true, reviewedManifestHash: scorecard.manifestHash, reviewedCases: 999 } });
assert.equal(spoofedReview.evidenceQualification.reviewedGoldQualified, false, "obsolete bare flags cannot upgrade a synthetic manifest to reviewed gold");
const forgedField = buildScorecard({ manifest, source: { revision: "abc123" }, retrievalResults, saveResults, performance: { localRecallP95Ms: 12, localRecallSamples: 50 }, field: { exactVersionUses: 30, independentSessions: 10, observedDays: 14, automaticSavePrecision: 1, currentFactStaleRate: 0 }, migration: { rollbackPassed: true }, privacy: qualifiedPrivacy });
assert.equal(forgedField.scores.automaticSavePrecision.status, "blocked", "unqualified numeric field fixtures cannot satisfy an exact-version gate");
assert.equal(forgedField.evidenceQualification.exactVersionFieldQualified, false);
const qualifiedField = buildScorecard({ manifest, source: { revision: "abc123" }, field: { evidenceClass: "exact-version-field", cohortId: "cohort-reviewed", sourceRevision: "abc123", exactVersionUses: 30, independentSessions: 10, observedDays: 14, automaticSavePrecision: 1, currentFactStaleRate: 0 } });
assert.equal(qualifiedField.evidenceQualification.exactVersionFieldQualified, true);
assert.equal(qualifiedField.scores.exactVersionUses.status, "pass");
assert.equal(qualifiedField.scores.exactVersionSessions.status, "pass");

const unsafe = validatePrivacyBoundary({ prompt: "must not persist" });
assert.equal(unsafe.ok, false);
const tmp = tmpFixture("memory-effectiveness-"); const file = path.join(tmp, "private", "scorecard.json");
writePrivateScorecard(file, scorecard);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

console.log("memory effectiveness tests passed");
