#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadJson, buildScorecard, writePrivateScorecard, validatePrivacyBoundary } = require("../src/memory-effectiveness");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { DEFAULT_PRIVACY_EVIDENCE_MAX_AGE_MS, privacyInputFromEvidence } = require("../src/memory-effectiveness-privacy");
const { DEFAULT_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS, reviewedGoldInputFromEvidence, emptyReviewedGoldInput } = require("../src/memory-effectiveness-reviewed-gold");

const cwd = process.cwd();
const args = new Set(process.argv.slice(2));
const manifestFile = path.join(cwd, "tests", "fixtures", "memory-effectiveness", "manifest.json");
const inputFile = path.join(cwd, ".pi", "memory-effectiveness", "input.json");
const privateFile = path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json");
const privacyEvidenceFile = path.join(cwd, ".pi", "privacy-guard", "rollout-evidence.json");
const reviewedGoldEvidenceFile = path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-evidence.json");
const publicFile = path.join(cwd, "docs", "memory-effectiveness-scorecard.json");
function readOptional(file) { try { return loadJson(file); } catch { return {}; } }

const manifest = loadJson(manifestFile);
const input = readOptional(inputFile);
const privacyEvidence = loadJson(privacyEvidenceFile);
const source = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") });
const configuredPrivacyMaxAgeMs = Number(process.env.PI_PROJECT_MEMORY_PRIVACY_EVIDENCE_MAX_AGE_MS);
const privacyMaxAgeMs = Number.isFinite(configuredPrivacyMaxAgeMs) && configuredPrivacyMaxAgeMs >= 0 ? configuredPrivacyMaxAgeMs : DEFAULT_PRIVACY_EVIDENCE_MAX_AGE_MS;
const privacyInput = privacyInputFromEvidence(privacyEvidence, source, { maxAgeMs: privacyMaxAgeMs });
if (Object.hasOwn(input, "privacy")) throw new Error("privacy counts must come from the bound privacy evidence artifact, not memory-effectiveness input");
if (Object.hasOwn(input, "evidence")) throw new Error("reviewed-gold qualification must come from the signed reviewed-gold evidence artifact, not memory-effectiveness input");
let reviewedGoldInput = emptyReviewedGoldInput();
if (fs.existsSync(reviewedGoldEvidenceFile)) {
  const reviewedGoldEvidence = loadJson(reviewedGoldEvidenceFile);
  const configuredReviewedGoldMaxAgeMs = Number(process.env.PI_PROJECT_MEMORY_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS);
  const reviewedGoldMaxAgeMs = Number.isFinite(configuredReviewedGoldMaxAgeMs) && configuredReviewedGoldMaxAgeMs >= 0 ? configuredReviewedGoldMaxAgeMs : DEFAULT_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS;
  reviewedGoldInput = reviewedGoldInputFromEvidence(reviewedGoldEvidence, { manifest, retrievalResults: input.retrievalResults, saveResults: input.saveResults, currentSource: source, signingKey: process.env.PI_REVIEWED_GOLD_SIGNING_KEY, maxAgeMs: reviewedGoldMaxAgeMs });
}
const scorecard = buildScorecard({ manifest, ...input, privacy: privacyInput, evidence: reviewedGoldInput, source: { ...(input.source || {}), ...source } });
const privacyCheck = validatePrivacyBoundary(scorecard);
if (!privacyCheck.ok) throw new Error(`refusing unsafe scorecard: ${privacyCheck.issues.join(",")}`);
const written = writePrivateScorecard(privateFile, scorecard);
if (args.has("--public")) fs.writeFileSync(publicFile, `${JSON.stringify(scorecard, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, decision: scorecard.decision, highestAuthorizedStage: scorecard.highestAuthorizedStage, manifestHash: scorecard.manifestHash, reviewedGoldQualified: scorecard.evidenceQualification.reviewedGoldQualified, reviewedGoldEvidenceId: scorecard.evidenceQualification.reviewedGoldEvidenceId, privateHash: written.hash, publicWritten: args.has("--public") }, null, 2)}\n`);
