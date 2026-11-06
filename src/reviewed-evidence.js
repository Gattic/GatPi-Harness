"use strict";

const crypto = require("node:crypto");
const hash = (value) => `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
const percentile = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
function reviewer(input) {
  if (input?.reviewer?.kind !== "human" || !String(input.reviewer.id || "").trim()) throw new Error("an explicit human reviewer is required");
  return hash(String(input.reviewer.id).trim());
}
function safeEvidenceIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16 || value.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id))) throw new Error("1-16 evidence IDs required");
  return [...new Set(value)];
}
function validateReviewEvidence(cwd, ids, options = {}) {
  const { EvidenceStore } = require("./evidence-binder");
  const result = new EvidenceStore({ cwd }).validateEvidenceIds(ids, { requireOk: false, requireCurrentTree: false, ...options });
  if (!result.ok) throw new Error(`registered review evidence required: ${result.reason}`);
  return result;
}
module.exports = { hash, percentile, reviewer, safeEvidenceIds, validateReviewEvidence };
