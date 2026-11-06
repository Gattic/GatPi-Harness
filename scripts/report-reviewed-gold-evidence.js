#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { loadJson } = require("../src/memory-effectiveness");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const {
  buildReviewedGoldEvidence,
  validateReviewedGoldEvidence,
  loadReviewedGoldReviews,
  writeReviewedGoldEvidence,
} = require("../src/memory-effectiveness-reviewed-gold");

const cwd = process.cwd();
const args = process.argv.slice(2);
const apply = args.includes("--write") && args.includes("--yes");
const signingKey = process.env.PI_REVIEWED_GOLD_SIGNING_KEY;
const manifestFile = path.join(cwd, "tests", "fixtures", "memory-effectiveness", "manifest.json");
const inputFile = path.join(cwd, ".pi", "memory-effectiveness", "input.json");
const reviewsFile = path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-reviews.json");
const evidenceFile = path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-evidence.json");
const manifest = loadJson(manifestFile);
const input = loadJson(inputFile);
const source = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") });
const evidence = buildReviewedGoldEvidence({
  manifest,
  retrievalResults: input.retrievalResults,
  saveResults: input.saveResults,
  source,
  reviews: loadReviewedGoldReviews(reviewsFile),
  signingKey,
});
const validation = validateReviewedGoldEvidence(evidence, {
  manifest,
  retrievalResults: input.retrievalResults,
  saveResults: input.saveResults,
  currentSource: source,
  signingKey,
});
if (!validation.ok) throw new Error(`generated reviewed-gold evidence failed validation: ${validation.reasons.join(",")}`);
if (apply) writeReviewedGoldEvidence(evidenceFile, evidence);
process.stdout.write(`${JSON.stringify({
  ok: evidence.summary.qualified,
  written: apply,
  evidenceId: evidence.evidenceId,
  evidenceClass: evidence.evidenceClass,
  manifestHash: evidence.manifest.manifestHash,
  caseSetId: evidence.manifest.caseSetId,
  resultSetId: evidence.results.resultSetId,
  summary: evidence.summary,
  signatureAlgorithm: "hmac-sha256",
  validationReasons: validation.reasons,
}, null, 2)}\n`);
