#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildPrivacyReview,
  loadPrivacyReviews,
  writePrivacyReviews,
} = require("../src/memory-effectiveness-privacy");

const cwd = process.cwd();
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const reviewHandle = value("--handle");
const disposition = value("--disposition");
const apply = args.includes("--write") && args.includes("--yes");
const humanConfirmed = args.includes("--human-confirmed");
const reviewerId = process.env.PI_PRIVACY_REVIEWER_ID;
if (!reviewHandle) throw new Error("--handle=<current-privacy-handle> is required");
if (!disposition) throw new Error("--disposition=<false-positive-structured|retained-bounded|remediated> is required");

const evidenceFile = path.join(cwd, ".pi", "privacy-guard", "rollout-evidence.json");
const reviewsFile = path.join(cwd, ".pi", "privacy-guard", "rollout-reviews.json");
const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
const review = buildPrivacyReview({ evidence, reviewHandle, disposition, reviewerId, humanConfirmed });
const current = loadPrivacyReviews(reviewsFile);
const reviews = [...current.filter((row) => row.candidateSetId !== review.candidateSetId || row.reviewHandle !== review.reviewHandle), review];
if (apply) writePrivacyReviews(reviewsFile, reviews);
process.stdout.write(`${JSON.stringify({
  ok: true,
  written: apply,
  reviewId: review.reviewId,
  candidateSetId: review.candidateSetId,
  reviewHandle: review.reviewHandle,
  disposition: review.disposition,
  reviewerHash: review.reviewerHash,
  reviewedAt: review.reviewedAt,
}, null, 2)}\n`);
