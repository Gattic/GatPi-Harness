"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { writePrivateJson } = require("./project-memory-decisions");

const PRIVACY_EVIDENCE_SCHEMA_VERSION = 1;
const PRIVACY_REVIEW_SCHEMA_VERSION = 1;
const DEFAULT_PRIVACY_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REVIEW_DISPOSITIONS = Object.freeze(["false-positive-structured", "retained-bounded", "remediated"]);

function hash(value) { return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function safeCount(value) { const count = Number(value); return Number.isInteger(count) && count >= 0 ? count : 0; }
function safeString(value) { return typeof value === "string" ? value : ""; }
function candidateProjection(row = {}) {
  return {
    reviewHandle: safeString(row.reviewHandle),
    file: safeString(row.file),
    pattern: safeString(row.pattern),
    severity: safeString(row.severity),
    bytes: safeCount(row.bytes),
    line: safeCount(row.line),
  };
}
function permissionProjection(value) {
  if (!value) return null;
  return {
    available: value.available === true,
    rootHash: safeString(value.rootHash),
    files: safeCount(value.files),
    directories: safeCount(value.directories),
    nonPrivateFiles: safeCount(value.nonPrivateFiles),
    nonPrivateDirectories: safeCount(value.nonPrivateDirectories),
    unsafeEntries: safeCount(value.unsafeEntries),
    scanErrors: safeCount(value.scanErrors),
    compliant: value.compliant === true,
  };
}
function scanProjection(scan = {}) {
  const coverage = scan.coverage || {};
  const summary = scan.summary || {};
  return {
    scope: {
      projectState: scan.scope?.projectState === true,
      source: scan.scope?.source === true,
      rawSessionPermissions: scan.scope?.rawSessionPermissions === true,
      contentReadFromRawSessions: scan.scope?.contentReadFromRawSessions === true,
    },
    roots: Array.isArray(scan.roots) ? scan.roots.map(safeString) : [],
    rootStatus: Array.isArray(scan.rootStatus) ? scan.rootStatus.map((row) => ({ scope: safeString(row.scope), exists: row.exists === true })) : [],
    permissionPosture: permissionProjection(scan.permissionPosture),
    coverage: {
      discoveredFiles: safeCount(coverage.discoveredFiles),
      discoveredBytes: safeCount(coverage.discoveredBytes),
      scannedFiles: safeCount(coverage.scannedFiles),
      scannedBytes: safeCount(coverage.scannedBytes),
      skippedFiles: safeCount(coverage.skippedFiles),
      erroredFiles: safeCount(coverage.erroredFiles),
      accountedFiles: safeCount(coverage.accountedFiles),
      stateFingerprint: safeString(coverage.stateFingerprint),
      identityHolds: coverage.identityHolds === true,
      complete: coverage.complete === true,
      configuredRoots: safeCount(coverage.configuredRoots),
      availableRoots: safeCount(coverage.availableRoots),
      absentRoots: safeCount(coverage.absentRoots),
      scopeComplete: coverage.scopeComplete === true,
    },
    summary: {
      actionable: safeCount(summary.actionable),
      ignored: safeCount(summary.ignored),
      high: safeCount(summary.bySeverity?.high ?? summary.high),
      medium: safeCount(summary.bySeverity?.medium ?? summary.medium),
      low: safeCount(summary.bySeverity?.low ?? summary.low),
      complete: summary.complete === true,
    },
    findings: Array.isArray(scan.findings) ? scan.findings.map(candidateProjection) : [],
    truncated: scan.truncated === true,
    resultTruncated: scan.resultTruncated === true,
  };
}
function validReview(review, candidateSetId, handles) {
  const core = { schemaVersion: PRIVACY_REVIEW_SCHEMA_VERSION, candidateSetId, reviewHandle: review?.reviewHandle, disposition: review?.disposition, humanConfirmed: true, reviewerHash: review?.reviewerHash, reviewedAt: review?.reviewedAt };
  return review?.schemaVersion === PRIVACY_REVIEW_SCHEMA_VERSION
    && review.candidateSetId === candidateSetId
    && handles.has(review.reviewHandle)
    && REVIEW_DISPOSITIONS.includes(review.disposition)
    && review.humanConfirmed === true
    && /^sha256:[a-f0-9]{64}$/.test(safeString(review.reviewerHash))
    && Number.isFinite(Date.parse(safeString(review.reviewedAt)))
    && review.reviewId === `privacy-review:${hash(core).slice(7)}`;
}
function coverageQualified(scan, { requireRawPermissions = false } = {}) {
  const coverage = scan.coverage || {};
  const findings = Array.isArray(scan.findings) ? scan.findings : [];
  const severityCount = (severity) => findings.filter((row) => row.severity === severity).length;
  const countsConsistent = scan.summary?.actionable === findings.length
    && scan.summary?.high === severityCount("high")
    && scan.summary?.medium === severityCount("medium")
    && scan.summary?.low === severityCount("low");
  const complete = coverage.complete === true
    && coverage.scopeComplete === true
    && coverage.identityHolds === true
    && /^sha256:[a-f0-9]{64}$/.test(safeString(coverage.stateFingerprint))
    && coverage.skippedFiles === 0
    && coverage.erroredFiles === 0
    && coverage.discoveredFiles === coverage.scannedFiles
    && coverage.discoveredFiles === coverage.accountedFiles
    && scan.truncated === false
    && scan.resultTruncated === false;
  const permissionReady = !requireRawPermissions || (scan.scope?.rawSessionPermissions === true && scan.scope?.contentReadFromRawSessions === false && scan.permissionPosture?.compliant === true);
  return complete && countsConsistent && permissionReady;
}
function buildPrivacyRolloutEvidence({ primaryScan, backupScan, source, reviews = [], generatedAt = new Date().toISOString() } = {}) {
  const primary = scanProjection(primaryScan);
  const backup = scanProjection(backupScan);
  const scanId = `privacy-scan:${hash({ primary, backup }).slice(7)}`;
  const candidateSetId = `privacy-candidates:${hash({ source: { revision: safeString(source?.revision), configHash: safeString(source?.configHash) }, roots: primary.roots, findings: primary.findings }).slice(7)}`;
  const handles = new Set(primary.findings.map((row) => row.reviewHandle).filter(Boolean));
  const validReviews = reviews.filter((review) => validReview(review, candidateSetId, handles));
  const reviewedHandles = new Set(validReviews.map((review) => review.reviewHandle));
  const unresolved = primary.findings.filter((row) => !reviewedHandles.has(row.reviewHandle));
  const primaryCoverageQualified = coverageQualified(primary, { requireRawPermissions: true });
  const backupCoverageQualified = coverageQualified(backup);
  const backupClean = backup.findings.length === 0;
  const unresolvedHighSeverity = primary.findings.filter((row) => row.severity === "high").length + backup.findings.filter((row) => row.severity === "high").length;
  const qualified = primaryCoverageQualified && backupCoverageQualified && backupClean && unresolvedHighSeverity === 0 && unresolved.length === 0;
  const evidence = {
    schemaVersion: PRIVACY_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    source: { revision: safeString(source?.revision), configHash: safeString(source?.configHash) },
    scanId,
    candidateSetId,
    primary,
    backup,
    reviews: validReviews.map((review) => ({
      schemaVersion: PRIVACY_REVIEW_SCHEMA_VERSION,
      reviewId: safeString(review.reviewId),
      candidateSetId,
      reviewHandle: review.reviewHandle,
      disposition: review.disposition,
      humanConfirmed: true,
      reviewerHash: review.reviewerHash,
      reviewedAt: review.reviewedAt,
    })),
    summary: {
      primaryCoverageQualified,
      backupCoverageQualified,
      backupClean,
      actionable: primary.findings.length,
      unresolvedHighSeverity,
      reviewedCandidates: reviewedHandles.size,
      unresolvedActionable: unresolved.length,
      qualified,
    },
  };
  return { ...evidence, evidenceId: `privacy-evidence:${hash(evidence).slice(7)}` };
}
function validatePrivacyRolloutEvidence(evidence = {}, currentSource = {}, { now = Date.now(), maxAgeMs = DEFAULT_PRIVACY_EVIDENCE_MAX_AGE_MS } = {}) {
  const reasons = [];
  if (evidence.schemaVersion !== PRIVACY_EVIDENCE_SCHEMA_VERSION) reasons.push("invalid-schema");
  if (evidence.source?.revision !== currentSource.revision) reasons.push("source-revision-mismatch");
  if (evidence.source?.configHash !== currentSource.configHash) reasons.push("config-hash-mismatch");
  const generatedMs = Date.parse(safeString(evidence.generatedAt));
  if (!Number.isFinite(generatedMs)) reasons.push("missing-generated-at");
  else if (generatedMs > now + 5 * 60 * 1000) reasons.push("evidence-from-future");
  else if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now - generatedMs > maxAgeMs) reasons.push("evidence-expired");
  const rebuilt = buildPrivacyRolloutEvidence({ primaryScan: evidence.primary, backupScan: evidence.backup, source: evidence.source, reviews: evidence.reviews, generatedAt: evidence.generatedAt });
  if (evidence.scanId !== rebuilt.scanId) reasons.push("scan-id-mismatch");
  if (evidence.candidateSetId !== rebuilt.candidateSetId) reasons.push("candidate-set-id-mismatch");
  if (evidence.evidenceId !== rebuilt.evidenceId) reasons.push("evidence-id-mismatch");
  if (JSON.stringify(evidence.summary) !== JSON.stringify(rebuilt.summary)) reasons.push("summary-mismatch");
  const text = JSON.stringify(evidence);
  if (/\/home\/|\/Users\/|[A-Za-z]:\\\\Users\\\\/.test(text)) reasons.push("absolute-path");
  if (/"(?:prompt|transcript|reasoning|toolOutput|command|sessionId)"\s*:/i.test(text)) reasons.push("forbidden-field");
  return { ok: reasons.length === 0, reasons, qualified: reasons.length === 0 && rebuilt.summary.qualified === true, rebuilt };
}
function privacyInputFromEvidence(evidence, currentSource, options) {
  const validation = validatePrivacyRolloutEvidence(evidence, currentSource, options);
  if (!validation.ok) throw new Error(`privacy rollout evidence invalid: ${validation.reasons.join(",")}`);
  const summary = validation.rebuilt.summary;
  return {
    evidenceId: evidence.evidenceId,
    scanId: evidence.scanId,
    candidateSetId: evidence.candidateSetId,
    evidenceQualified: validation.qualified,
    unresolvedHighSeverity: summary.unresolvedHighSeverity,
    unresolvedActionable: summary.unresolvedActionable,
    reviewedCandidates: summary.reviewedCandidates,
    candidateCount: summary.actionable,
    primaryCoverageQualified: summary.primaryCoverageQualified,
    backupCoverageQualified: summary.backupCoverageQualified,
  };
}
function buildPrivacyReview({ evidence, reviewHandle, disposition, reviewerId, humanConfirmed, reviewedAt = new Date().toISOString() } = {}) {
  if (humanConfirmed !== true) throw new Error("privacy review requires explicit human confirmation");
  if (!REVIEW_DISPOSITIONS.includes(disposition)) throw new Error(`invalid privacy review disposition: ${disposition || "missing"}`);
  const candidate = evidence?.primary?.findings?.find((row) => row.reviewHandle === reviewHandle);
  if (!candidate) throw new Error("privacy review handle is absent from the current bound scan");
  if (!reviewerId) throw new Error("privacy review requires a local reviewer identity");
  const reviewerHash = hash({ reviewerId: String(reviewerId) });
  const core = { schemaVersion: PRIVACY_REVIEW_SCHEMA_VERSION, candidateSetId: evidence.candidateSetId, reviewHandle, disposition, humanConfirmed: true, reviewerHash, reviewedAt };
  return { ...core, reviewId: `privacy-review:${hash(core).slice(7)}` };
}
function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function loadPrivacyReviews(file) { const value = loadJson(file, []); return Array.isArray(value) ? value : []; }
function writePrivacyRolloutEvidence(file, evidence) { writePrivateJson(file, evidence); return evidence; }
function writePrivacyReviews(file, reviews) { writePrivateJson(file, reviews); return reviews; }

module.exports = {
  PRIVACY_EVIDENCE_SCHEMA_VERSION,
  PRIVACY_REVIEW_SCHEMA_VERSION,
  DEFAULT_PRIVACY_EVIDENCE_MAX_AGE_MS,
  REVIEW_DISPOSITIONS,
  scanProjection,
  buildPrivacyRolloutEvidence,
  validatePrivacyRolloutEvidence,
  privacyInputFromEvidence,
  buildPrivacyReview,
  loadPrivacyReviews,
  writePrivacyRolloutEvidence,
  writePrivacyReviews,
};
