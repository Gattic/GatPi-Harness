"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildPrivacyRolloutEvidence,
  validatePrivacyRolloutEvidence,
  privacyInputFromEvidence,
  buildPrivacyReview,
  writePrivacyRolloutEvidence,
  writePrivacyReviews,
} = require("../src/memory-effectiveness-privacy");
const { sourceFiles } = require("../src/memory-effectiveness-source");
const { tmpFixture } = require("./helpers/tmp-fixture");

const identityFiles = sourceFiles(path.resolve(__dirname, ".."));
for (const file of ["src/memory-effectiveness-privacy.js", "src/privacy-guard-scan.js", "scripts/report-privacy-rollout-evidence.mjs", "scripts/review-privacy-rollout-evidence.js"]) assert(identityFiles.some((item) => item.endsWith(file)), `${file} participates in scorecard source identity`);

const source = { revision: "content:fixture", configHash: "sha256:fixture" };
const primary = {
  scope: { projectState: true, source: false, rawSessionPermissions: true, contentReadFromRawSessions: false },
  roots: ["project-state:debug-ledger", "project-state:project-memory"],
  rootStatus: [{ scope: "project-state:debug-ledger", exists: true }, { scope: "project-state:project-memory", exists: true }],
  permissionPosture: { available: true, rootHash: "fixture-root", files: 3, directories: 2, nonPrivateFiles: 0, nonPrivateDirectories: 0, unsafeEntries: 0, scanErrors: 0, compliant: true },
  coverage: { discoveredFiles: 2, discoveredBytes: 200, scannedFiles: 2, scannedBytes: 200, skippedFiles: 0, erroredFiles: 0, accountedFiles: 2, stateFingerprint: `sha256:${"a".repeat(64)}`, identityHolds: true, complete: true, configuredRoots: 2, availableRoots: 2, absentRoots: 0, scopeComplete: true },
  summary: { actionable: 2, ignored: 0, bySeverity: { medium: 2 }, complete: true },
  findings: [
    { reviewHandle: "privacy_fixture_a", file: "project-state:aaaaaaaaaaaa", pattern: "full-transcript-hint", severity: "medium", bytes: 100, line: 4 },
    { reviewHandle: "privacy_fixture_b", file: "project-state:bbbbbbbbbbbb", pattern: "full-transcript-hint", severity: "medium", bytes: 100, line: 7 },
  ],
  truncated: false,
  resultTruncated: false,
};
const backup = {
  scope: { projectState: true, source: false, rawSessionPermissions: false, contentReadFromRawSessions: false },
  roots: ["explicit-state-root"],
  rootStatus: [{ scope: "explicit-state-root", exists: true }],
  coverage: { discoveredFiles: 1, discoveredBytes: 50, scannedFiles: 1, scannedBytes: 50, skippedFiles: 0, erroredFiles: 0, accountedFiles: 1, stateFingerprint: `sha256:${"b".repeat(64)}`, identityHolds: true, complete: true, configuredRoots: 1, availableRoots: 1, absentRoots: 0, scopeComplete: true },
  summary: { actionable: 0, ignored: 0, bySeverity: {}, complete: true },
  findings: [],
  truncated: false,
  resultTruncated: false,
};
const generatedAt = new Date().toISOString();
const incomplete = buildPrivacyRolloutEvidence({ primaryScan: primary, backupScan: backup, source, generatedAt });
assert.equal(incomplete.summary.primaryCoverageQualified, true);
assert.equal(incomplete.summary.backupCoverageQualified, true);
assert.equal(incomplete.summary.unresolvedHighSeverity, 0);
assert.equal(incomplete.summary.unresolvedActionable, 2);
assert.equal(incomplete.summary.qualified, false);
assert.deepEqual(validatePrivacyRolloutEvidence(incomplete, source).reasons, []);
assert.equal(privacyInputFromEvidence(incomplete, source).evidenceQualified, false);

assert.throws(() => buildPrivacyReview({ evidence: incomplete, reviewHandle: "privacy_fixture_a", disposition: "false-positive-structured", reviewerId: "reviewer", humanConfirmed: false }), /human confirmation/);
assert.throws(() => buildPrivacyReview({ evidence: incomplete, reviewHandle: "privacy_unknown", disposition: "false-positive-structured", reviewerId: "reviewer", humanConfirmed: true }), /absent/);
const first = buildPrivacyReview({ evidence: incomplete, reviewHandle: "privacy_fixture_a", disposition: "false-positive-structured", reviewerId: "reviewer", humanConfirmed: true, reviewedAt: generatedAt });
const second = buildPrivacyReview({ evidence: incomplete, reviewHandle: "privacy_fixture_b", disposition: "retained-bounded", reviewerId: "reviewer", humanConfirmed: true, reviewedAt: generatedAt });
const complete = buildPrivacyRolloutEvidence({ primaryScan: primary, backupScan: backup, source, reviews: [first, second], generatedAt });
assert.equal(complete.candidateSetId, incomplete.candidateSetId, "reviews bind to a stable source-qualified candidate set");
assert.equal(complete.summary.reviewedCandidates, 2);
assert.equal(complete.summary.unresolvedActionable, 0);
assert.equal(complete.summary.qualified, true);
assert.equal(validatePrivacyRolloutEvidence(complete, source).qualified, true);
assert.equal(privacyInputFromEvidence(complete, source).evidenceQualified, true);
assert.equal(JSON.stringify(complete).includes("/home/"), false);

const sourceMismatch = validatePrivacyRolloutEvidence(complete, { revision: "content:other", configHash: source.configHash });
assert(sourceMismatch.reasons.includes("source-revision-mismatch"));
const tampered = structuredClone(complete); tampered.summary.unresolvedActionable = 99;
assert(validatePrivacyRolloutEvidence(tampered, source).reasons.includes("evidence-id-mismatch") || validatePrivacyRolloutEvidence(tampered, source).reasons.includes("summary-mismatch"));
const forgedReview = structuredClone(first); forgedReview.disposition = "remediated";
const forged = buildPrivacyRolloutEvidence({ primaryScan: primary, backupScan: backup, source, reviews: [forgedReview, second], generatedAt });
assert.equal(forged.summary.reviewedCandidates, 1, "review hashes prevent disposition tampering");
assert.equal(forged.summary.qualified, false);

const tmp = tmpFixture("privacy-evidence-");
const evidenceFile = path.join(tmp, "state", "evidence.json");
const reviewsFile = path.join(tmp, "state", "reviews.json");
writePrivacyRolloutEvidence(evidenceFile, incomplete);
writePrivacyReviews(reviewsFile, [first]);
assert.equal(fs.statSync(evidenceFile).mode & 0o777, 0o600);
assert.equal(fs.statSync(reviewsFile).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(evidenceFile)).mode & 0o777, 0o700);

console.log("memory effectiveness privacy evidence tests passed");
