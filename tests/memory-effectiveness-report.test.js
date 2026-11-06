"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { buildPrivacyRolloutEvidence, writePrivacyRolloutEvidence } = require("../src/memory-effectiveness-privacy");
const { reviewedGoldResultSet, buildReviewedGoldReview, buildReviewedGoldEvidence, writeReviewedGoldEvidence } = require("../src/memory-effectiveness-reviewed-gold");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const reportScript = path.join(root, "scripts", "report-memory-effectiveness.js");
const reviewScript = path.join(root, "scripts", "review-reviewed-gold-evidence.js");
const collectorScript = path.join(root, "scripts", "report-reviewed-gold-evidence.js");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "memory-effectiveness", "manifest.json"), "utf8"));
const retrievalResults = manifest.retrievalCases.map((row) => ({ id: row.id, rankedIds: [...row.relevantIds] }));
const saveResults = manifest.saveCases.map((row) => ({ id: row.id, outcome: row.expected }));
const input = {
  retrievalResults,
  saveResults,
  performance: { localRecallP95Ms: 10, localRecallSamples: 10 },
  field: { independentSessions: 0, observedDays: 0, currentFactStaleRate: 0 },
  curation: { attempts: 0, successRate: 0, timeoutRate: 0, p95Ms: 0 },
  migration: { previewPassed: true, rollbackPassed: true, fixtures: 1 },
};
const source = currentMemorySourceEvidence({ implementationRoot: root });
const signingKey = "reviewed-gold-report-test-signing-key-material";
const generatedAt = new Date().toISOString();
const resultSet = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
const reviews = resultSet.cases.map((row) => buildReviewedGoldReview({ manifest, retrievalResults, saveResults, source, caseType: row.caseType, caseId: row.caseId, reviewerId: "report-test-reviewer", signingKey, humanConfirmed: true, reviewedAt: generatedAt }));
const reviewedGoldEvidence = buildReviewedGoldEvidence({ manifest, retrievalResults, saveResults, source, reviews, signingKey, generatedAt });
const primaryScan = {
  scope: { projectState: true, source: false, rawSessionPermissions: true, contentReadFromRawSessions: false },
  roots: ["project-state:fixture", "project-state:project-memory"],
  rootStatus: [{ scope: "project-state:fixture", exists: true }, { scope: "project-state:project-memory", exists: true }],
  permissionPosture: { available: true, rootHash: "fixture", files: 0, directories: 0, nonPrivateFiles: 0, nonPrivateDirectories: 0, unsafeEntries: 0, scanErrors: 0, compliant: true },
  coverage: { discoveredFiles: 0, discoveredBytes: 0, scannedFiles: 0, scannedBytes: 0, skippedFiles: 0, erroredFiles: 0, accountedFiles: 0, stateFingerprint: `sha256:${"d".repeat(64)}`, identityHolds: true, complete: true, configuredRoots: 2, availableRoots: 2, absentRoots: 0, scopeComplete: true },
  summary: { actionable: 0, ignored: 0, bySeverity: {}, complete: true },
  findings: [], truncated: false, resultTruncated: false,
};
const backupScan = {
  scope: { projectState: true, source: false, rawSessionPermissions: false, contentReadFromRawSessions: false },
  roots: ["explicit-state-root"], rootStatus: [{ scope: "explicit-state-root", exists: true }],
  coverage: { discoveredFiles: 0, discoveredBytes: 0, scannedFiles: 0, scannedBytes: 0, skippedFiles: 0, erroredFiles: 0, accountedFiles: 0, stateFingerprint: `sha256:${"e".repeat(64)}`, identityHolds: true, complete: true, configuredRoots: 1, availableRoots: 1, absentRoots: 0, scopeComplete: true },
  summary: { actionable: 0, ignored: 0, bySeverity: {}, complete: true },
  findings: [], truncated: false, resultTruncated: false,
};
const privacyEvidence = buildPrivacyRolloutEvidence({ primaryScan, backupScan, source, generatedAt });
assert.equal(privacyEvidence.summary.qualified, true);

const cwd = tmpFixture("memory-effectiveness-report-");
fs.mkdirSync(path.join(cwd, "tests", "fixtures", "memory-effectiveness"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".pi", "memory-effectiveness"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".pi", "privacy-guard"), { recursive: true });
fs.writeFileSync(path.join(cwd, "tests", "fixtures", "memory-effectiveness", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const inputFile = path.join(cwd, ".pi", "memory-effectiveness", "input.json");
const reviewedGoldFile = path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-evidence.json");
fs.writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`);
writePrivacyRolloutEvidence(path.join(cwd, ".pi", "privacy-guard", "rollout-evidence.json"), privacyEvidence);
const env = { ...process.env, PI_REVIEWED_GOLD_REVIEWER_ID: "report-test-reviewer", PI_REVIEWED_GOLD_SIGNING_KEY: signingKey };
const reviewRun = spawnSync(process.execPath, [reviewScript, `--case=retrieval:${manifest.retrievalCases[0].id}`, "--human-confirmed", "--write", "--yes"], { cwd, env, encoding: "utf8" });
assert.equal(reviewRun.status, 0, reviewRun.stderr);
assert.equal(JSON.parse(reviewRun.stdout).written, true);
const reviewsFile = path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-reviews.json");
assert.equal(fs.statSync(reviewsFile).mode & 0o777, 0o600);
const collectorRun = spawnSync(process.execPath, [collectorScript, "--write", "--yes"], { cwd, env, encoding: "utf8" });
assert.equal(collectorRun.status, 0, collectorRun.stderr);
assert.equal(JSON.parse(collectorRun.stdout).ok, false, "one human-reviewed case cannot qualify the artifact");
assert.equal(JSON.parse(collectorRun.stdout).summary.reviewedCases, 1);
assert.equal(fs.statSync(reviewedGoldFile).mode & 0o777, 0o600);
writeReviewedGoldEvidence(reviewedGoldFile, reviewedGoldEvidence);
function run() { return spawnSync(process.execPath, [reportScript], { cwd, env, encoding: "utf8" }); }

const success = run();
assert.equal(success.status, 0, success.stderr);
const output = JSON.parse(success.stdout);
assert.equal(output.reviewedGoldQualified, true);
assert.equal(output.reviewedGoldEvidenceId, reviewedGoldEvidence.evidenceId);
assert.equal(output.highestAuthorizedStage, "M2");
const scorecardFile = path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json");
const scorecard = JSON.parse(fs.readFileSync(scorecardFile, "utf8"));
assert.equal(scorecard.evidenceQualification.reviewedGoldQualified, true);
assert.equal(scorecard.scores.retrievalPrecisionAt5.gateEligible, true);
assert.equal(fs.statSync(scorecardFile).mode & 0o777, 0o600);

fs.writeFileSync(inputFile, `${JSON.stringify({ ...input, evidence: { evidenceQualified: true } }, null, 2)}\n`);
const bareInput = run();
assert.notEqual(bareInput.status, 0);
assert.match(bareInput.stderr, /must come from the signed reviewed-gold evidence artifact/);
fs.writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`);
const tampered = structuredClone(reviewedGoldEvidence); tampered.summary.reviewedCases = 999;
writeReviewedGoldEvidence(reviewedGoldFile, tampered);
const tamperedRun = run();
assert.notEqual(tamperedRun.status, 0);
assert.match(tamperedRun.stderr, /reviewed-gold evidence invalid/);
fs.rmSync(reviewedGoldFile);
const absent = run();
assert.equal(absent.status, 0, absent.stderr);
assert.equal(JSON.parse(absent.stdout).reviewedGoldQualified, false);
assert.equal(JSON.parse(absent.stdout).highestAuthorizedStage, "M0");

console.log("memory effectiveness report ingestion tests passed");
