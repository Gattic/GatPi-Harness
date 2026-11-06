"use strict";

const OUTCOME_SCHEMA_VERSION = 2;
const CANONICAL_OUTCOMES = Object.freeze([
  "succeeded",
  "domain-negative",
  "blocked",
  "not-applicable",
  "cancelled",
  "timed-out",
  "infrastructure-failed",
  "unknown",
]);
const OUTCOME_SET = new Set(CANONICAL_OUTCOMES);
const RELIABILITY_FAILURE_OUTCOMES = new Set(["timed-out", "infrastructure-failed"]);
const NEGATIVE_OUTCOMES = new Set(["domain-negative", "blocked", "cancelled", "timed-out", "infrastructure-failed"]);
// Backward-compatible export name. A semantic/domain-negative result is not
// extension infrastructure friction and must not feed generic reliability candidates.
const FAILURE_OUTCOMES = RELIABILITY_FAILURE_OUTCOMES;

const OUTCOME_ALIASES = Object.freeze({
  success: "succeeded",
  successful: "succeeded",
  passed: "succeeded",
  pass: "succeeded",
  complete: "succeeded",
  completed: "succeeded",
  ok: "succeeded",
  infrastructure_failed: "infrastructure-failed",
  infrastructurefailure: "infrastructure-failed",
  negative: "domain-negative",
  domain_negative: "domain-negative",
  failed_check: "domain-negative",
  denied: "blocked",
  rejected: "blocked",
  paused: "blocked",
  policy_blocked: "blocked",
  "policy-blocked": "blocked",
  skipped: "not-applicable",
  not_applicable: "not-applicable",
  notapplicable: "not-applicable",
  noop: "not-applicable",
  "no-op": "not-applicable",
  canceled: "cancelled",
  aborted: "cancelled",
  timeout: "timed-out",
  timed_out: "timed-out",
  timedout: "timed-out",
  max_iterations: "timed-out",
  "max-iterations": "timed-out",
});

const DOMAIN_NEGATIVE_OPERATIONS = Object.freeze({
  build_project: new Set(["build", "configure", "default"]),
  test_project: new Set(["test", "default"]),
  test_runner: new Set(["run", "rerunfailures", "default"]),
  privacy_guard: new Set(["scan"]),
  evidence_binder: new Set(["check", "bind", "captureverification"]),
  gitverify: new Set(["default"]),
  semgrep_scan: new Set(["scan", "default"]),
  semgrep_codegraph: new Set(["scan", "default"]),
  verification_center: new Set(["run", "evidence"]),
  gitevidence: new Set(["readiness"]),
});

function normalizedToken(value) { return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-"); }
function normalizeOutcome(value, fallback = "unknown") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return OUTCOME_SET.has(fallback) ? fallback : "unknown";
  if (OUTCOME_SET.has(raw)) return raw;
  const normalized = normalizedToken(raw);
  if (OUTCOME_SET.has(normalized)) return normalized;
  return OUTCOME_ALIASES[raw] || OUTCOME_ALIASES[normalized] || (OUTCOME_SET.has(fallback) ? fallback : "unknown");
}

function firstDefined(object, paths) {
  for (const parts of paths) {
    let value = object;
    for (const part of parts) value = value && typeof value === "object" ? value[part] : undefined;
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function operationToken(value) { return String(value || "default").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "default"; }
function expectedNegativeFor(toolName, operation, declared) {
  const explicit = normalizeOutcome(declared, "unknown");
  if (["domain-negative", "blocked", "not-applicable", "cancelled", "timed-out"].includes(explicit)) return explicit;
  const tool = String(toolName || "").trim();
  const operations = DOMAIN_NEGATIVE_OPERATIONS[tool];
  if (!operations) return null;
  const op = operationToken(operation);
  return operations.has(op) || operations.has("default") ? "domain-negative" : null;
}

function inferOutcome(details, { isError = false, toolName = "", operation = "", expectedNegative, errorCategory = "" } = {}) {
  const value = details && typeof details === "object" ? details : {};
  const raw = firstDefined(value, [
    ["outcome"], ["status"], ["result", "outcome"], ["result", "status"], ["details", "outcome"], ["details", "status"],
    ["evidence", "status"], ["verification", "status"], ["termination", "status"], ["verdict"],
  ]);
  const rawToken = normalizedToken(raw);
  const declaredNegative = expectedNegativeFor(toolName, operation, expectedNegative);
  const genericFailure = ["failed", "failure", "error", "fail"].includes(rawToken);
  if (raw !== undefined && !genericFailure) {
    const normalized = normalizeOutcome(raw, "unknown");
    if (normalized !== "unknown") return normalized;
  }
  if (value.notApplicable === true || value.not_applicable === true || value.skipped === true) return "not-applicable";
  if (value.blocked === true || value.allowed === false || Number(value.policyBlocks || 0) > 0) return "blocked";
  if (value.cancelled === true || value.canceled === true || value.aborted === true) return "cancelled";
  if (value.timedOut === true || value.timed_out === true || value.timeout === true) return "timed-out";

  const reason = String(value.reason || value.errorCode || "").toLowerCase();
  if (/command-failed|adapter-failed|adapter-crash|infrastructure|parse-error/.test(reason)) return "infrastructure-failed";
  if (value.skipped === true || /missing-binary|no-files|disabled|not-applicable/.test(reason)) return "not-applicable";
  const findingCount = Array.isArray(value.findings) ? value.findings.length : Number(value.findings || value.summary?.findings || value.semgrep?.summary?.findings || value.privacyFindings || 0);
  const failedChecks = Number(value.summary?.failed || value.failed || 0);
  if (findingCount > 0 || failedChecks > 0 || value.verificationOk === false || value.verification?.ok === false || value.isClean === false) return declaredNegative || "domain-negative";

  const category = String(errorCategory || value.errorCategory || value.category || "").toLowerCase();
  if (/policy|safety|approval|boundary|automation-contract/.test(category)) return "blocked";
  if (/missing-prerequisite/.test(category)) return declaredNegative || "domain-negative";
  if (/cancel|abort|interrupt/.test(category)) return "cancelled";
  if (/timeout|timed-out/.test(category)) return "timed-out";
  if (/command-failure|test-failure|build-failure|finding/.test(category)) return declaredNegative || "domain-negative";

  if (genericFailure || value.ok === false || value.success === false) {
    if (declaredNegative) return declaredNegative;
    return isError ? "infrastructure-failed" : "domain-negative";
  }
  if (value.ok === true || value.success === true) return "succeeded";
  if (isError) return declaredNegative || "infrastructure-failed";
  return "unknown";
}

function normalizeLoopOutcome(status, details = {}) {
  const token = normalizedToken(status);
  if (details.providerFailure === true && ["failed", "paused", "blocked"].includes(token)) return "infrastructure-failed";
  if (token === "completed") return "succeeded";
  if (["max-iterations", "maximum-iterations", "stalled"].includes(token)) return "timed-out";
  if (["paused", "blocked", "awaiting-evidence"].includes(token)) return "blocked";
  if (["cancelled", "canceled", "aborted"].includes(token)) return "cancelled";
  if (token === "failed") {
    if (details.providerFailure === true || /provider|infrastructure|adapter/.test(String(details.errorCategory || details.reason || "").toLowerCase())) return "infrastructure-failed";
    return normalizeOutcome(details.outcome, "domain-negative");
  }
  return normalizeOutcome(status || details.outcome, "unknown");
}

function normalizeGoalOutcome(status, details = {}) {
  const token = normalizedToken(status);
  if (details.providerFailure === true && ["failed", "paused", "blocked"].includes(token)) return "infrastructure-failed";
  if (token === "completed") return "succeeded";
  if (["blocked", "paused", "awaiting-user", "awaiting-evidence"].includes(token)) return "blocked";
  if (["cancelled", "canceled", "aborted"].includes(token)) return "cancelled";
  if (["not-applicable", "skipped", "untouched"].includes(token)) return "not-applicable";
  if (token === "failed") {
    if (details.providerFailure === true || /provider|infrastructure|adapter/.test(String(details.errorCategory || details.reason || "").toLowerCase())) return "infrastructure-failed";
    return normalizeOutcome(details.outcome, "domain-negative");
  }
  return normalizeOutcome(status || details.outcome, "unknown");
}

function isReliabilityFailureOutcome(value) { return RELIABILITY_FAILURE_OUTCOMES.has(normalizeOutcome(value)); }
function isFailureOutcome(value) { return isReliabilityFailureOutcome(value); }
function isNegativeOutcome(value) { return NEGATIVE_OUTCOMES.has(normalizeOutcome(value)); }
function isCanonicalOutcome(value) { return OUTCOME_SET.has(value); }

module.exports = {
  OUTCOME_SCHEMA_VERSION,
  CANONICAL_OUTCOMES,
  OUTCOME_SET,
  FAILURE_OUTCOMES,
  RELIABILITY_FAILURE_OUTCOMES,
  NEGATIVE_OUTCOMES,
  DOMAIN_NEGATIVE_OPERATIONS,
  normalizeOutcome,
  normalizeLoopOutcome,
  normalizeGoalOutcome,
  inferOutcome,
  isFailureOutcome,
  isReliabilityFailureOutcome,
  isNegativeOutcome,
  isCanonicalOutcome,
};
