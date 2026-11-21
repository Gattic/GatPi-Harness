"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadJson, evaluateRetrieval, evaluateSaves, validatePrivacyBoundary, buildScorecard, writePrivateScorecard, percentile, manifestHashOf } = require("../src/memory-effectiveness");
const { tmpFixture } = require("./helpers/tmp-fixture");

const manifest = loadJson(path.join(__dirname, "fixtures", "memory-effectiveness", "manifest.json"));
assert.equal(validatePrivacyBoundary(manifest).ok, true);
const retrievalResults = manifest.retrievalCases.map((row) => ({ id: row.id, rankedIds: [...row.relevantIds] }));
const saveResults = manifest.saveCases.map((row) => ({ id: row.id, outcome: row.expected }));
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
  privacy: { unresolvedHighSeverity: 0, unresolvedActionable: 0, candidateCount: 4 },
});
assert.equal(scorecard.authority, "reporting-only", "the scorecard reports; it never authorizes a stage");
assert.equal(scorecard.manifestHash, manifestHashOf(manifest));
assert.equal(scorecard.scores.retrievalPrecisionAt5.status, "pass");
assert.equal(scorecard.scores.retrievalPrecisionAt5.evidenceClass, "synthetic-readiness");
assert.equal(scorecard.scores.retrievalPrecisionAt5.gateEligible, undefined);
assert.equal(scorecard.scores.exactVersionSessions.status, "fail", "declared field measurements report directly, without a cohort attestation");
assert.equal(scorecard.scores.realCuration.status, "insufficient-data");
assert.equal(scorecard.decision, "no-go-deferred");
assert.equal(scorecard.highestAuthorizedStage, undefined, "artifact stage authorization is gone");
assert.equal(scorecard.evidenceQualification, undefined);
assert.equal(scorecard.scores.privacyBoundary.status, "pass");
assert.equal(validatePrivacyBoundary(scorecard).ok, true);

// A manifest that still declares an artifact evidence class is refused.
assert.throws(() => buildScorecard({ manifest: { ...manifest, evidenceClass: "user-reviewed-gold" } }), /synthetic-readiness/);
assert.throws(() => buildScorecard({}), /schemaVersion 1 required/);

// Declared privacy counts are reported as-is; the passive scan is the gate.
const privacyHigh = buildScorecard({ manifest, privacy: { unresolvedHighSeverity: 1, unresolvedActionable: 0, candidateCount: 1 } });
assert.equal(privacyHigh.scores.privacyBoundary.status, "fail");

const unsafe = validatePrivacyBoundary({ prompt: "must not persist" });
assert.equal(unsafe.ok, false);
const tmp = tmpFixture("memory-effectiveness-"); const file = path.join(tmp, "private", "scorecard.json");
writePrivateScorecard(file, scorecard);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

console.log("memory effectiveness tests passed");
