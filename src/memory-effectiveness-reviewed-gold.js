"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { writePrivateJson } = require("./project-memory-decisions");

const REVIEWED_GOLD_EVIDENCE_SCHEMA_VERSION = 1;
const REVIEWED_GOLD_REVIEW_SCHEMA_VERSION = 1;
const DEFAULT_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEWED_GOLD_EVIDENCE_CLASS = "user-reviewed-gold";
const CASE_TYPES = Object.freeze(["retrieval", "save"]);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalValue(value[key])]));
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function hash(value) { return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`; }
function signingKeyBuffer(signingKey) {
  const key = Buffer.isBuffer(signingKey) ? signingKey : Buffer.from(String(signingKey || ""), "utf8");
  if (key.length < 32) throw new Error("reviewed-gold signing key must contain at least 32 bytes");
  return key;
}
function sign(value, signingKey) { return `hmac-sha256:${crypto.createHmac("sha256", signingKeyBuffer(signingKey)).update(canonicalJson(value)).digest("hex")}`; }
function signatureValid(signature, value, signingKey) {
  if (!SIGNATURE.test(String(signature || ""))) return false;
  const expected = Buffer.from(sign(value, signingKey));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function safeString(value) { return typeof value === "string" ? value : ""; }
function safeSource(source = {}) { return { revision: safeString(source.revision), configHash: safeString(source.configHash) }; }
function reviewedGoldManifestHash(manifest = {}) { return hash(manifest); }
function resultIndex(rows = []) {
  const map = new Map(); let duplicateResults = 0; let invalidResults = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = safeString(row?.id);
    if (!SAFE_ID.test(id)) { invalidResults++; continue; }
    if (map.has(id)) duplicateResults++;
    else map.set(id, row);
  }
  return { map, duplicateResults, invalidResults };
}
function reviewedGoldResultSet(manifest = {}, retrievalResults = [], saveResults = []) {
  const manifestHash = reviewedGoldManifestHash(manifest);
  const retrievalExpected = Array.isArray(manifest.retrievalCases) ? manifest.retrievalCases : [];
  const saveExpected = Array.isArray(manifest.saveCases) ? manifest.saveCases : [];
  const retrievalIndex = resultIndex(retrievalResults);
  const saveIndex = resultIndex(saveResults);
  const expectedKeys = new Set(); let invalidCases = 0; let duplicateCases = 0; let missingResults = 0;
  const cases = [];
  for (const [caseType, expectedRows, index] of [["retrieval", retrievalExpected, retrievalIndex], ["save", saveExpected, saveIndex]]) {
    for (const expected of expectedRows) {
      const caseId = safeString(expected?.id); const caseKey = `${caseType}:${caseId}`;
      if (!SAFE_ID.test(caseId)) invalidCases++;
      if (expectedKeys.has(caseKey)) duplicateCases++;
      expectedKeys.add(caseKey);
      const result = index.map.get(caseId);
      if (!result) missingResults++;
      const resultValue = caseType === "retrieval"
        ? { id: caseId, rankedIds: Array.isArray(result?.rankedIds) ? result.rankedIds.map(String) : [] }
        : { id: caseId, outcome: safeString(result?.outcome) };
      cases.push({ caseType, caseId, caseHash: hash({ caseType, expected }), resultHash: result ? hash({ caseType, result: resultValue }) : null });
    }
  }
  const expectedRetrievalIds = new Set(retrievalExpected.map((row) => safeString(row?.id)));
  const expectedSaveIds = new Set(saveExpected.map((row) => safeString(row?.id)));
  const unexpectedResults = [...retrievalIndex.map.keys()].filter((id) => !expectedRetrievalIds.has(id)).length + [...saveIndex.map.keys()].filter((id) => !expectedSaveIds.has(id)).length;
  const duplicateResults = retrievalIndex.duplicateResults + saveIndex.duplicateResults;
  const invalidResults = retrievalIndex.invalidResults + saveIndex.invalidResults;
  const summary = {
    expectedCases: cases.length,
    retrievalCases: retrievalExpected.length,
    saveCases: saveExpected.length,
    missingResults,
    duplicateCases,
    duplicateResults,
    unexpectedResults,
    invalidCases,
    invalidResults,
  };
  summary.complete = summary.expectedCases > 0 && [missingResults, duplicateCases, duplicateResults, unexpectedResults, invalidCases, invalidResults].every((count) => count === 0);
  const caseSetId = `reviewed-gold-cases:${hash({ manifestHash, cases: cases.map(({ caseType, caseId, caseHash }) => ({ caseType, caseId, caseHash })) }).slice(7)}`;
  const resultSetId = `reviewed-gold-results:${hash({ manifestHash, cases: cases.map(({ caseType, caseId, resultHash }) => ({ caseType, caseId, resultHash })) }).slice(7)}`;
  return { manifestHash, caseSetId, resultSetId, cases, summary };
}
function reviewCore(review = {}) {
  return {
    schemaVersion: REVIEWED_GOLD_REVIEW_SCHEMA_VERSION,
    evidenceClass: REVIEWED_GOLD_EVIDENCE_CLASS,
    source: safeSource(review.source),
    manifestHash: safeString(review.manifestHash),
    caseSetId: safeString(review.caseSetId),
    resultSetId: safeString(review.resultSetId),
    caseType: safeString(review.caseType),
    caseId: safeString(review.caseId),
    caseHash: safeString(review.caseHash),
    resultHash: safeString(review.resultHash),
    humanConfirmed: true,
    reviewerHash: safeString(review.reviewerHash),
    reviewedAt: safeString(review.reviewedAt),
  };
}
function buildReviewedGoldReview({ manifest, retrievalResults = [], saveResults = [], source, caseType, caseId, reviewerId, signingKey, humanConfirmed, reviewedAt = new Date().toISOString() } = {}) {
  if (humanConfirmed !== true) throw new Error("reviewed-gold review requires explicit human confirmation");
  if (!CASE_TYPES.includes(caseType)) throw new Error(`invalid reviewed-gold case type: ${caseType || "missing"}`);
  if (!SAFE_ID.test(safeString(caseId))) throw new Error("reviewed-gold review requires a valid case ID");
  if (!reviewerId) throw new Error("reviewed-gold review requires a local reviewer identity");
  signingKeyBuffer(signingKey);
  const resultSet = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
  if (!resultSet.summary.complete) throw new Error("reviewed-gold review requires a complete, duplicate-free current result set");
  const descriptor = resultSet.cases.find((row) => row.caseType === caseType && row.caseId === caseId);
  if (!descriptor) throw new Error("reviewed-gold case is absent from the current manifest");
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error("reviewed-gold review requires a valid review time");
  const core = reviewCore({
    source,
    manifestHash: resultSet.manifestHash,
    caseSetId: resultSet.caseSetId,
    resultSetId: resultSet.resultSetId,
    caseType,
    caseId,
    caseHash: descriptor.caseHash,
    resultHash: descriptor.resultHash,
    reviewerHash: hash({ reviewerId: String(reviewerId) }),
    reviewedAt,
  });
  const signature = sign(core, signingKey);
  return { ...core, reviewId: `reviewed-gold-review:${hash({ core, signature }).slice(7)}`, signature };
}
function validReview(review, expected, source, signingKey, generatedAt) {
  if (!review || review.schemaVersion !== REVIEWED_GOLD_REVIEW_SCHEMA_VERSION || review.evidenceClass !== REVIEWED_GOLD_EVIDENCE_CLASS || review.humanConfirmed !== true) return false;
  if (!CASE_TYPES.includes(review.caseType) || !SAFE_ID.test(safeString(review.caseId)) || !HASH.test(safeString(review.reviewerHash))) return false;
  if (review.source?.revision !== source.revision || review.source?.configHash !== source.configHash) return false;
  if (review.manifestHash !== expected.manifestHash || review.caseSetId !== expected.caseSetId || review.resultSetId !== expected.resultSetId) return false;
  const descriptor = expected.cases.find((row) => row.caseType === review.caseType && row.caseId === review.caseId);
  if (!descriptor || review.caseHash !== descriptor.caseHash || review.resultHash !== descriptor.resultHash) return false;
  const reviewedMs = Date.parse(safeString(review.reviewedAt)); const generatedMs = Date.parse(safeString(generatedAt));
  if (!Number.isFinite(reviewedMs) || !Number.isFinite(generatedMs) || reviewedMs > generatedMs + 5 * 60 * 1000) return false;
  const core = reviewCore(review);
  if (!signatureValid(review.signature, core, signingKey)) return false;
  return review.reviewId === `reviewed-gold-review:${hash({ core, signature: review.signature }).slice(7)}`;
}
function buildReviewedGoldEvidence({ manifest, retrievalResults = [], saveResults = [], source, reviews = [], signingKey, generatedAt = new Date().toISOString() } = {}) {
  signingKeyBuffer(signingKey);
  const safeCurrentSource = safeSource(source);
  const resultSet = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
  const currentReviews = (Array.isArray(reviews) ? reviews : []).filter((review) => validReview(review, resultSet, safeCurrentSource, signingKey, generatedAt));
  const latestByCase = new Map();
  for (const review of currentReviews) {
    const key = `${review.caseType}:${review.caseId}`; const previous = latestByCase.get(key);
    if (!previous || Date.parse(review.reviewedAt) > Date.parse(previous.reviewedAt)) latestByCase.set(key, review);
  }
  const orderedReviews = resultSet.cases.map((row) => latestByCase.get(`${row.caseType}:${row.caseId}`)).filter(Boolean);
  const reviewedRetrievalCases = orderedReviews.filter((row) => row.caseType === "retrieval").length;
  const reviewedSaveCases = orderedReviews.filter((row) => row.caseType === "save").length;
  const reviewedCases = orderedReviews.length;
  const summary = {
    expectedCases: resultSet.summary.expectedCases,
    reviewedCases,
    retrievalCases: resultSet.summary.retrievalCases,
    reviewedRetrievalCases,
    saveCases: resultSet.summary.saveCases,
    reviewedSaveCases,
    unresolvedCases: Math.max(0, resultSet.summary.expectedCases - reviewedCases),
    resultSetComplete: resultSet.summary.complete,
  };
  summary.complete = summary.resultSetComplete && summary.expectedCases > 0 && summary.reviewedCases === summary.expectedCases && summary.unresolvedCases === 0;
  summary.qualified = summary.complete;
  const base = {
    schemaVersion: REVIEWED_GOLD_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    evidenceClass: REVIEWED_GOLD_EVIDENCE_CLASS,
    source: safeCurrentSource,
    manifest: {
      manifestHash: resultSet.manifestHash,
      classifierVersion: safeString(manifest?.classifierVersion),
      declaredEvidenceClass: safeString(manifest?.evidenceClass),
      caseSetId: resultSet.caseSetId,
    },
    results: {
      resultSetId: resultSet.resultSetId,
      expectedCases: resultSet.summary.expectedCases,
      retrievalCases: resultSet.summary.retrievalCases,
      saveCases: resultSet.summary.saveCases,
      complete: resultSet.summary.complete,
    },
    reviews: orderedReviews,
    summary,
  };
  const evidenceId = `reviewed-gold-evidence:${hash(base).slice(7)}`;
  const signed = { ...base, evidenceId };
  return { ...signed, signature: sign(signed, signingKey) };
}
function validateReviewedGoldEvidence(evidence = {}, { manifest, retrievalResults = [], saveResults = [], currentSource = {}, signingKey, now = Date.now(), maxAgeMs = DEFAULT_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS } = {}) {
  const reasons = [];
  try { signingKeyBuffer(signingKey); } catch { reasons.push("missing-or-invalid-signing-key"); }
  if (evidence.schemaVersion !== REVIEWED_GOLD_EVIDENCE_SCHEMA_VERSION) reasons.push("invalid-schema");
  if (evidence.evidenceClass !== REVIEWED_GOLD_EVIDENCE_CLASS) reasons.push("invalid-evidence-class");
  if (evidence.source?.revision !== currentSource.revision) reasons.push("source-revision-mismatch");
  if (evidence.source?.configHash !== currentSource.configHash) reasons.push("config-hash-mismatch");
  const generatedMs = Date.parse(safeString(evidence.generatedAt));
  if (!Number.isFinite(generatedMs)) reasons.push("missing-generated-at");
  else if (generatedMs > now + 5 * 60 * 1000) reasons.push("evidence-from-future");
  else if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now - generatedMs > maxAgeMs) reasons.push("evidence-expired");
  const expected = reviewedGoldResultSet(manifest, retrievalResults, saveResults);
  if (evidence.manifest?.manifestHash !== expected.manifestHash) reasons.push("manifest-hash-mismatch");
  if (evidence.manifest?.caseSetId !== expected.caseSetId) reasons.push("case-set-id-mismatch");
  if (evidence.results?.resultSetId !== expected.resultSetId) reasons.push("result-set-id-mismatch");
  let rebuilt = null;
  if (!reasons.includes("missing-or-invalid-signing-key")) {
    const signed = { ...evidence }; delete signed.signature;
    if (!signatureValid(evidence.signature, signed, signingKey)) reasons.push("artifact-signature-invalid");
    rebuilt = buildReviewedGoldEvidence({ manifest, retrievalResults, saveResults, source: evidence.source, reviews: evidence.reviews, signingKey, generatedAt: evidence.generatedAt });
    if (evidence.evidenceId !== rebuilt.evidenceId) reasons.push("evidence-id-mismatch");
    if (canonicalJson(evidence) !== canonicalJson(rebuilt)) reasons.push("artifact-projection-mismatch");
  }
  const text = JSON.stringify(evidence);
  if (/\/home\/|\/Users\/|[A-Za-z]:\\\\Users\\\\/.test(text)) reasons.push("absolute-path");
  if (/"(?:prompt|transcript|reasoning|toolOutput|command|sessionId|reviewerId|signingKey|privateKey)"\s*:/i.test(text)) reasons.push("forbidden-field");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], qualified: reasons.length === 0 && rebuilt?.summary?.qualified === true, rebuilt };
}
function reviewedGoldInputFromEvidence(evidence, options) {
  const validation = validateReviewedGoldEvidence(evidence, options);
  if (!validation.ok) throw new Error(`reviewed-gold evidence invalid: ${validation.reasons.join(",")}`);
  return {
    evidenceClass: REVIEWED_GOLD_EVIDENCE_CLASS,
    evidenceId: evidence.evidenceId,
    evidenceQualified: validation.qualified,
    reviewedManifestHash: validation.rebuilt.manifest.manifestHash,
    reviewedCaseSetId: validation.rebuilt.manifest.caseSetId,
    reviewedResultSetId: validation.rebuilt.results.resultSetId,
    sourceRevision: validation.rebuilt.source.revision,
    sourceConfigHash: validation.rebuilt.source.configHash,
    reviewedCases: validation.rebuilt.summary.reviewedCases,
    expectedReviewedCases: validation.rebuilt.summary.expectedCases,
  };
}
function emptyReviewedGoldInput() {
  return { evidenceClass: REVIEWED_GOLD_EVIDENCE_CLASS, evidenceQualified: false, reviewedCases: 0, expectedReviewedCases: 0 };
}
function loadReviewedGoldReviews(file) { try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; } }
function writeReviewedGoldReviews(file, reviews) { writePrivateJson(file, reviews); return reviews; }
function writeReviewedGoldEvidence(file, evidence) { writePrivateJson(file, evidence); return evidence; }

module.exports = {
  REVIEWED_GOLD_EVIDENCE_SCHEMA_VERSION,
  REVIEWED_GOLD_REVIEW_SCHEMA_VERSION,
  DEFAULT_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS,
  REVIEWED_GOLD_EVIDENCE_CLASS,
  CASE_TYPES,
  canonicalJson,
  reviewedGoldManifestHash,
  reviewedGoldResultSet,
  buildReviewedGoldReview,
  buildReviewedGoldEvidence,
  validateReviewedGoldEvidence,
  reviewedGoldInputFromEvidence,
  emptyReviewedGoldInput,
  loadReviewedGoldReviews,
  writeReviewedGoldReviews,
  writeReviewedGoldEvidence,
};
