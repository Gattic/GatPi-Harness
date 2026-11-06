"use strict";

const { normalizeCandidate, validateCandidate } = require("./project-memory-schema");
const TRANSIENT_GIT = /\b(?:current\s+)?(?:git\s+)?(?:branch|head|sha|commit|dirty\s+(?:tree|status)|working\s+tree|staged|unstaged)\b/i;
const ROUTINE_SUCCESS = /\b(?:tests?|build|lint|typecheck|verification|command)\s+(?:all\s+)?(?:pass(?:ed)?|succeed(?:ed)?|completed)\b/i;
const RECOVERED_FAILURE = /\b(?:failed|failure|error|crash)\b[\s\S]{0,160}\b(?:recovered|fixed|now\s+passes|succeeded\s+on\s+retry)\b/i;
const HYPOTHESIS = /\b(?:maybe|might|possibly|hypothesis|suspect|could\s+be)\b/i;
function classifyProjectMemoryCandidate(input = {}, { explicit = false, automatic = false, operatorCapture = false } = {}) {
  const candidate = normalizeCandidate(input); const validation = validateCandidate(candidate); if (!validation.ok) return { action: "reject", reason: validation.issues[0] || "invalid", candidate };
  const text = `${candidate.title}\n${candidate.content}`;
  if (TRANSIENT_GIT.test(text)) return { action: "reject", reason: "transient", candidate };
  if (automatic && (ROUTINE_SUCCESS.test(text) || RECOVERED_FAILURE.test(text))) return { action: "reject", reason: "transient", candidate };
  if (operatorCapture) {
    if (!["decision", "constraint", "procedure", "risk"].includes(candidate.kind) || candidate.verification !== "unverified" || candidate.standing || candidate.supersedes.length || candidate.contradicts.length) return { action: "reject", reason: "capture-policy", candidate };
    if (HYPOTHESIS.test(text)) return { action: "reject", reason: "speculative", candidate };
    return { action: "save", reason: "operator-capture", label: "saved-labeled", candidate };
  }
  if (automatic && (candidate.verification === "contradicted" || !["verified", "corroborated"].includes(candidate.verification))) return { action: "review", reason: "unverified", candidate };
  if (automatic && HYPOTHESIS.test(text)) return { action: "review", reason: "unverified", candidate };
  if (explicit) return { action: "save", reason: "explicit-save", label: ["verified", "corroborated"].includes(candidate.verification) ? "saved" : "saved-labeled", candidate };
  if (["verified", "corroborated"].includes(candidate.verification)) return { action: "save", reason: "verified-durable", label: "saved", candidate };
  return { action: "shadow", reason: "unverified", candidate };
}
module.exports = { TRANSIENT_GIT, ROUTINE_SUCCESS, RECOVERED_FAILURE, HYPOTHESIS, classifyProjectMemoryCandidate };
