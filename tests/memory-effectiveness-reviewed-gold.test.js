"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadJson, buildScorecard } = require("../src/memory-effectiveness");
const {
  reviewedGoldResultSet,
  buildReviewedGoldReview,
  buildReviewedGoldEvidence,
  validateReviewedGoldEvidence,
  reviewedGoldInputFromEvidence,
  writeReviewedGoldReviews,
  writeReviewedGoldEvidence,
} = require("../src/memory-effectiveness-reviewed-gold");
const { sourceFiles } = require("../src/memory-effectiveness-source");
const { evidenceFromScorecard } = require("../src/project-memory-runtime");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout");
const { tmpFixture } = require("./helpers/tmp-fixture");

const identityFiles = sourceFiles(path.resolve(__dirname, ".."));
for (const file of ["src/memory-effectiveness-reviewed-gold.js", "scripts/report-reviewed-gold-evidence.js", "scripts/review-reviewed-gold-evidence.js"]) assert(identityFiles.some((item) => item.endsWith(file)), `${file} participates in scorecard source identity`);

const manifest = loadJson(path.join(__dirname, "fixtures", "memory-effectiveness", "manifest.json"));
const retrievalResults = manifest.retrievalCases.map((row) => ({ id: row.id, rankedIds: [...row.relevantIds] }));
const saveResults = manifest.saveCases.map((row) => ({ id: row.id, outcome: row.expected }));
const source = { revision: "content:reviewed-gold-fixture", configHash: `sha256:${"b".repeat(64)}` };
const signingKey = "reviewed-gold-test-signing-key-material-32-bytes";
const generatedAt = "2026-08-14T12:00:00.000Z";
const resultSet = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
assert.equal(resultSet.summary.complete, true);
assert.equal(resultSet.summary.expectedCases, 12);
assert.match(resultSet.caseSetId, /^reviewed-gold-cases:[a-f0-9]{64}$/);
assert.match(resultSet.resultSetId, /^reviewed-gold-results:[a-f0-9]{64}$/);
assert.throws(() => buildReviewedGoldReview({ manifest, retrievalResults, saveResults, source, caseType: "retrieval", caseId: manifest.retrievalCases[0].id, reviewerId: "reviewer", signingKey, humanConfirmed: false }), /human confirmation/);
assert.throws(() => buildReviewedGoldReview({ manifest, retrievalResults, saveResults, source, caseType: "retrieval", caseId: "missing", reviewerId: "reviewer", signingKey, humanConfirmed: true }), /absent/);
assert.throws(() => buildReviewedGoldReview({ manifest, retrievalResults, saveResults, source, caseType: "retrieval", caseId: manifest.retrievalCases[0].id, reviewerId: "reviewer", signingKey: "short", humanConfirmed: true }), /32 bytes/);

const reviews = resultSet.cases.map((row) => buildReviewedGoldReview({ manifest, retrievalResults, saveResults, source, caseType: row.caseType, caseId: row.caseId, reviewerId: "local-gold-reviewer", signingKey, humanConfirmed: true, reviewedAt: generatedAt }));
assert.equal(reviews.length, 12);
assert.match(reviews[0].reviewId, /^reviewed-gold-review:[a-f0-9]{64}$/);
assert.match(reviews[0].signature, /^hmac-sha256:[a-f0-9]{64}$/);
assert.equal(JSON.stringify(reviews).includes("local-gold-reviewer"), false, "raw reviewer identity must not persist");
assert.equal(JSON.stringify(reviews).includes(signingKey), false, "signing key must not persist");

const incomplete = buildReviewedGoldEvidence({ manifest, retrievalResults, saveResults, source, reviews: reviews.slice(0, 11), signingKey, generatedAt });
assert.equal(incomplete.summary.reviewedCases, 11);
assert.equal(incomplete.summary.qualified, false);
const incompleteValidation = validateReviewedGoldEvidence(incomplete, { manifest, retrievalResults, saveResults, currentSource: source, signingKey, now: Date.parse(generatedAt) });
assert.deepEqual(incompleteValidation.reasons, []);
assert.equal(incompleteValidation.qualified, false);

const complete = buildReviewedGoldEvidence({ manifest, retrievalResults, saveResults, source, reviews, signingKey, generatedAt });
assert.equal(complete.manifest.declaredEvidenceClass, "synthetic-readiness", "the source fixture is not relabeled");
assert.equal(complete.summary.reviewedCases, 12);
assert.equal(complete.summary.unresolvedCases, 0);
assert.equal(complete.summary.qualified, true);
assert.match(complete.evidenceId, /^reviewed-gold-evidence:[a-f0-9]{64}$/);
assert.match(complete.signature, /^hmac-sha256:[a-f0-9]{64}$/);
assert.equal(JSON.stringify(complete).includes("queryTerms"), false, "artifact stores hashes rather than reviewed fixture content");
const validation = validateReviewedGoldEvidence(complete, { manifest, retrievalResults, saveResults, currentSource: source, signingKey, now: Date.parse(generatedAt) });
assert.deepEqual(validation.reasons, []);
assert.equal(validation.qualified, true);
const scorecardInput = reviewedGoldInputFromEvidence(complete, { manifest, retrievalResults, saveResults, currentSource: source, signingKey, now: Date.parse(generatedAt) });
assert.equal(scorecardInput.evidenceQualified, true);
assert.equal(scorecardInput.reviewedCases, 12);

const qualifiedPrivacy = { evidenceId: "privacy-evidence:fixture", scanId: "privacy-scan:fixture", evidenceQualified: true, unresolvedHighSeverity: 0, unresolvedActionable: 0, reviewedCandidates: 0, candidateCount: 0 };
const scorecard = buildScorecard({ manifest, source, retrievalResults, saveResults, evidence: scorecardInput, performance: { localRecallP95Ms: 10, localRecallSamples: 10 }, migration: { previewPassed: true, rollbackPassed: true, fixtures: 1 }, privacy: qualifiedPrivacy });
assert.equal(scorecard.evidenceQualification.manifestEvidenceClass, "synthetic-readiness");
assert.equal(scorecard.evidenceQualification.reviewedGoldQualified, true);
assert.equal(scorecard.evidenceQualification.reviewedGoldEvidenceId, complete.evidenceId);
assert.equal(scorecard.scores.retrievalPrecisionAt5.evidenceClass, "user-reviewed-gold");
assert.equal(scorecard.scores.explicitSavePrecision.gateEligible, true);
assert.equal(scorecard.highestAuthorizedStage, "M2");
const rollout = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M2" }, evidenceFromScorecard(scorecard));
assert.equal(rollout.effectiveStage, "M2", "signed reviewed gold can authorize M2 even when the original manifest is synthetic");
assert.equal(rollout.promotionBlocked, false);
assert.equal(rollout.controls.taskRecall, true);
assert.equal(rollout.controls.candidateCapture, false);

const tampered = structuredClone(complete); tampered.summary.reviewedCases = 99;
const tamperedValidation = validateReviewedGoldEvidence(tampered, { manifest, retrievalResults, saveResults, currentSource: source, signingKey, now: Date.parse(generatedAt) });
assert(tamperedValidation.reasons.includes("artifact-signature-invalid"));
assert(tamperedValidation.reasons.includes("artifact-projection-mismatch"));
const forgedReview = structuredClone(reviews[0]); forgedReview.resultHash = `sha256:${"c".repeat(64)}`;
const forgedEvidence = buildReviewedGoldEvidence({ manifest, retrievalResults, saveResults, source, reviews: [forgedReview, ...reviews.slice(1)], signingKey, generatedAt });
assert.equal(forgedEvidence.summary.reviewedCases, 11, "review signatures prevent result tampering from inflating coverage");
assert.equal(forgedEvidence.summary.qualified, false);
const changedResults = structuredClone(retrievalResults); changedResults[0].rankedIds = ["different-result"];
assert(validateReviewedGoldEvidence(complete, { manifest, retrievalResults: changedResults, saveResults, currentSource: source, signingKey, now: Date.parse(generatedAt) }).reasons.includes("result-set-id-mismatch"));
assert(validateReviewedGoldEvidence(complete, { manifest, retrievalResults, saveResults, currentSource: { ...source, revision: "content:other" }, signingKey, now: Date.parse(generatedAt) }).reasons.includes("source-revision-mismatch"));
assert(validateReviewedGoldEvidence(complete, { manifest, retrievalResults, saveResults, currentSource: source, signingKey: "", now: Date.parse(generatedAt) }).reasons.includes("missing-or-invalid-signing-key"));
assert(validateReviewedGoldEvidence(complete, { manifest, retrievalResults, saveResults, currentSource: source, signingKey, now: Date.parse("2026-08-30T12:00:00.000Z") }).reasons.includes("evidence-expired"));
const duplicateResults = [...retrievalResults, retrievalResults[0]];
assert.equal(reviewedGoldResultSet(manifest, duplicateResults, saveResults).summary.complete, false);

const tmp = tmpFixture("reviewed-gold-evidence-");
const reviewsFile = path.join(tmp, "state", "reviews.json");
const evidenceFile = path.join(tmp, "state", "evidence.json");
writeReviewedGoldReviews(reviewsFile, reviews);
writeReviewedGoldEvidence(evidenceFile, complete);
assert.equal(fs.statSync(reviewsFile).mode & 0o777, 0o600);
assert.equal(fs.statSync(evidenceFile).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(evidenceFile)).mode & 0o777, 0o700);

console.log("memory effectiveness reviewed-gold evidence tests passed");
