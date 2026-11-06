#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { loadJson } = require("../src/memory-effectiveness");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const {
  buildReviewedGoldReview,
  loadReviewedGoldReviews,
  writeReviewedGoldReviews,
} = require("../src/memory-effectiveness-reviewed-gold");

const cwd = process.cwd();
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const caseRef = value("--case");
const separator = caseRef?.indexOf(":") ?? -1;
const caseType = separator > 0 ? caseRef.slice(0, separator) : "";
const caseId = separator > 0 ? caseRef.slice(separator + 1) : "";
const apply = args.includes("--write") && args.includes("--yes");
const humanConfirmed = args.includes("--human-confirmed");
const reviewerId = process.env.PI_REVIEWED_GOLD_REVIEWER_ID;
const signingKey = process.env.PI_REVIEWED_GOLD_SIGNING_KEY;
if (!caseRef || !caseType || !caseId) throw new Error("--case=<retrieval|save>:<case-id> is required");

const manifestFile = path.join(cwd, "tests", "fixtures", "memory-effectiveness", "manifest.json");
const inputFile = path.join(cwd, ".pi", "memory-effectiveness", "input.json");
const reviewsFile = path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-reviews.json");
const manifest = loadJson(manifestFile);
const input = loadJson(inputFile);
const source = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") });
const review = buildReviewedGoldReview({
  manifest,
  retrievalResults: input.retrievalResults,
  saveResults: input.saveResults,
  source,
  caseType,
  caseId,
  reviewerId,
  signingKey,
  humanConfirmed,
});
const current = loadReviewedGoldReviews(reviewsFile);
const reviews = [...current.filter((row) => row.caseType !== review.caseType || row.caseId !== review.caseId), review];
if (apply) writeReviewedGoldReviews(reviewsFile, reviews);
process.stdout.write(`${JSON.stringify({
  ok: true,
  written: apply,
  reviewId: review.reviewId,
  manifestHash: review.manifestHash,
  caseSetId: review.caseSetId,
  resultSetId: review.resultSetId,
  caseType: review.caseType,
  caseId: review.caseId,
  caseHash: review.caseHash,
  resultHash: review.resultHash,
  reviewerHash: review.reviewerHash,
  reviewedAt: review.reviewedAt,
  signatureAlgorithm: "hmac-sha256",
}, null, 2)}\n`);
