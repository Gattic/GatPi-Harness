"use strict";

// The grandfather baseline for the passive privacy gate. Findings are content
// handles only: the scan walks runtime-state roots and never records paths.

const crypto = require("node:crypto");

function handleOf(value) { return `project-state:${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`; }

function buildPrivacyBaseline(scanResult = {}, { sourceRevision = null, now = Date.now() } = {}) {
  const findings = Array.isArray(scanResult.findings) ? scanResult.findings : [];
  const high = findings.filter((row) => row.severity === "high");
  const medium = findings.filter((row) => row.severity === "medium");
  return {
    schemaVersion: 1,
    kind: "privacy-baseline",
    baselineAt: new Date(now).toISOString(),
    sourceRevision,
    counts: { actionable: findings.length, high: high.length, medium: medium.length },
    // A finding's `file` is already a content handle. Grandfathering is keyed by
    // that handle, so a remediated file stops matching without a re-review.
    recordFileHashes: [...new Set(high.map((row) => String(row.file || "")).filter(Boolean))].sort(),
    codeHighHandles: [],
    permissionPostureCompliant: scanResult.permissionPosture?.compliant === true,
    note: "Pre-instrumentation findings are grandfathered; only new record-format highs gate.",
  };
}

module.exports = { handleOf, buildPrivacyBaseline };
