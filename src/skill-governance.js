"use strict";

const crypto = require("node:crypto");

const SKILL_GOVERNANCE_SCHEMA_VERSION = 2;
const SOURCE_TRUST = new Set(["trusted", "reviewed", "untrusted", "unknown"]);
const SCHEMA_STATUS = new Set(["valid", "invalid", "unknown"]);
const SANDBOX_STATUS = new Set(["passed", "failed", "not-run"]);
const VERIFICATION_STATUS = new Set(["passed", "failed", "insufficient-data"]);
const FIELD_STATUS = new Set(["field-proven", "failed", "insufficient-data"]);
const APPROVAL_VALUES = new Set(["allowed", "blocked", "approved", "not-approved", "revoked"]);
const APPROVAL_SCOPES = new Set(["advisoryRetrieval", "routing", "publishing"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function sha256(value) { return `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stable(value))).digest("hex")}`; }
function ids(values, max = 64) { return [...new Set((values || []).map(String).filter((value) => SAFE_ID.test(value)))].slice(0, max); }
function status(value, allowed, fallback) { return allowed.has(value) ? value : fallback; }
function sourceKind(skill = {}) {
  const sources = [...(skill.provenance?.sources || []), skill.provenance?.source, skill.source].filter(Boolean).map(String);
  if (sources.some((value) => value === "native-agent-skill" || value === "pi-curated-core")) return "trusted";
  if (sources.some((value) => ["synthesis", "skill-synthesis", "execution", "topology-run", "goal-run"].includes(value))) return "reviewed";
  if (sources.some((value) => /import|provider|intake/.test(value))) return "untrusted";
  return "unknown";
}
function sourceHashForSkill(skill = {}) {
  const explicit = skill.evidenceState?.sourceTrust?.sourceHash || skill.provenance?.sourceHash;
  if (SHA256.test(String(explicit || ""))) return String(explicit);
  return sha256({
    skillId: skill.skillId,
    version: Number(skill.version || 1),
    name: skill.name,
    description: skill.description,
    category: skill.category,
    triggerConditions: skill.triggerConditions || [],
    requiredTools: skill.requiredTools || [],
    workflowSteps: skill.workflowSteps || [],
    validationStrategy: skill.validationStrategy || {},
    sources: skill.provenance?.sources || [],
  });
}
function defaultApprovals(skill = {}) {
  const legacyApproved = skill.status === "approved" || skill.governance?.approval === "approved";
  return {
    advisoryRetrieval: legacyApproved ? "allowed" : "blocked",
    routing: "not-approved",
    publishing: "not-approved",
  };
}
function normalizeApprovals(skill = {}) {
  const defaults = defaultApprovals(skill);
  const current = skill.approvals || {};
  return {
    advisoryRetrieval: ["allowed", "blocked", "revoked"].includes(current.advisoryRetrieval) ? current.advisoryRetrieval : defaults.advisoryRetrieval,
    routing: ["approved", "not-approved", "revoked"].includes(current.routing) ? current.routing : defaults.routing,
    publishing: ["approved", "not-approved", "revoked"].includes(current.publishing) ? current.publishing : defaults.publishing,
  };
}
function normalizeSkillGovernance(skill = {}, options = {}) {
  const captureCount = Number.isFinite(Number(options.captureCount)) ? Math.max(0, Math.floor(Number(options.captureCount))) : (skill.provenance?.captureIds || []).length;
  const evidenceState = skill.evidenceState || {};
  const sourceTrust = evidenceState.sourceTrust || {};
  const schema = evidenceState.schema || {};
  const sandbox = evidenceState.sandbox || {};
  const local = evidenceState.localVerification || {};
  const field = evidenceState.field || {};
  const inferredTrust = sourceKind(skill);
  const successes = Number(skill.successMetrics?.successes || 0);
  return {
    governanceSchemaVersion: SKILL_GOVERNANCE_SCHEMA_VERSION,
    evidenceState: {
      sourceTrust: {
        status: status(sourceTrust.status, SOURCE_TRUST, inferredTrust),
        sourceHash: sourceHashForSkill(skill),
      },
      schema: {
        status: status(schema.status, SCHEMA_STATUS, "valid"),
        schemaVersion: SKILL_GOVERNANCE_SCHEMA_VERSION,
      },
      sandbox: {
        status: status(sandbox.status, SANDBOX_STATUS, "not-run"),
        evidenceIds: ids(sandbox.evidenceIds),
      },
      localVerification: {
        status: status(local.status, VERIFICATION_STATUS, captureCount > 0 && successes > 0 ? "passed" : "insufficient-data"),
        captureCount,
        evidenceIds: ids(local.evidenceIds),
      },
      field: {
        status: status(field.status, FIELD_STATUS, "insufficient-data"),
        exactVersionUses: Math.max(0, Math.floor(Number(field.exactVersionUses || 0))),
        observedDays: Math.max(0, Math.floor(Number(field.observedDays || 0))),
        independentSessions: Math.max(0, Math.floor(Number(field.independentSessions || 0))),
        evidenceIds: ids(field.evidenceIds),
      },
    },
    approvals: normalizeApprovals(skill),
  };
}
function applySkillGovernance(skill = {}, options = {}) {
  const normalized = normalizeSkillGovernance(skill, options);
  skill.governanceSchemaVersion = normalized.governanceSchemaVersion;
  skill.evidenceState = normalized.evidenceState;
  skill.approvals = normalized.approvals;
  return skill;
}
function normalizeSkillEvaluation(skill = {}, evidence = {}, at = new Date().toISOString()) {
  const governance = normalizeSkillGovernance(skill);
  const sourceHash = governance.evidenceState.sourceTrust.sourceHash;
  const requestedSourceHash = evidence.sourceHash || sourceHash;
  const requestedVersion = Number(evidence.version || skill.version || 1);
  const exactVersion = requestedVersion === Number(skill.version || 1) && requestedSourceHash === sourceHash;
  const result = evidence.ok === false ? "failed" : "succeeded";
  const cohortId = SAFE_ID.test(String(evidence.cohortId || "")) ? String(evidence.cohortId) : null;
  const arm = ["control", "candidate"].includes(evidence.arm) ? evidence.arm : null;
  const sessionIdHash = SHA256.test(String(evidence.sessionIdHash || "")) ? String(evidence.sessionIdHash) : null;
  const requestedEvidenceClass = ["deterministic", "synthetic", "migration", "exact-version-field", "user-reviewed-gold"].includes(evidence.evidenceClass) ? evidence.evidenceClass : "deterministic";
  const normalizedEvidenceClass = requestedEvidenceClass === "exact-version-field" && !(exactVersion && cohortId && arm && sessionIdHash) ? "deterministic" : requestedEvidenceClass;
  const observedCount = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Math.max(0, Math.floor(Number(value)));
  return {
    schemaVersion: 2,
    evaluationId: `skilleval_${sha256({ skillId: skill.skillId, version: requestedVersion, sourceHash: requestedSourceHash, captureId: evidence.captureId || null, outcomeId: evidence.outcomeId || null, at }).slice(7, 31)}`,
    at: new Date(at).toISOString(),
    skillId: skill.skillId,
    version: requestedVersion,
    sourceHash: requestedSourceHash,
    exactVersion,
    evidenceClass: normalizedEvidenceClass,
    captureId: SAFE_ID.test(String(evidence.captureId || "")) ? String(evidence.captureId) : null,
    outcomeId: SAFE_ID.test(String(evidence.outcomeId || "")) ? String(evidence.outcomeId) : null,
    routingMode: ["explicit", "advisory", "suggested", "automatic", "sandbox"].includes(evidence.routingMode) ? evidence.routingMode : evidence.invoked ? "explicit" : "advisory",
    cohortId,
    arm,
    sessionIdHash,
    result,
    evidenceIds: ids(evidence.evidenceIds || evidence.completionEvidenceIds),
    unsupportedClaimDetected: typeof evidence.unsupportedClaimDetected === "boolean" ? evidence.unsupportedClaimDetected : null,
    userReviewEvidenceIds: ids(evidence.userReviewEvidenceIds),
    latencyMs: observedCount(evidence.latencyMs),
    toolCalls: observedCount(evidence.toolCalls),
    modelCalls: observedCount(evidence.modelCalls),
    contextAdded: observedCount(evidence.contextAdded),
    taskHash: SHA256.test(String(evidence.taskHash || "")) ? String(evidence.taskHash) : sha256(evidence.task || "unknown"),
  };
}
function applyEvaluation(skill = {}, evaluation = {}, priorEvaluations = []) {
  applySkillGovernance(skill);
  const local = skill.evidenceState.localVerification;
  const field = skill.evidenceState.field;
  const evidenceIds = ids([...(local.evidenceIds || []), ...(evaluation.evidenceIds || [])]);
  if (evaluation.result === "failed") local.status = "failed";
  else if (evaluation.exactVersion && evaluation.evidenceIds?.length) local.status = "passed";
  local.evidenceIds = evidenceIds;
  if (evaluation.evidenceClass === "exact-version-field" && evaluation.exactVersion) {
    const exactRows = [...priorEvaluations, evaluation].filter((row) => row.evidenceClass === "exact-version-field" && row.exactVersion && row.skillId === skill.skillId && Number(row.version) === Number(skill.version) && row.sourceHash === skill.evidenceState.sourceTrust.sourceHash);
    field.exactVersionUses = exactRows.length;
    field.observedDays = new Set(exactRows.map((row) => String(row.at).slice(0, 10))).size;
    field.independentSessions = new Set(exactRows.map((row) => row.sessionIdHash).filter(Boolean)).size;
    field.evidenceIds = ids(exactRows.flatMap((row) => row.evidenceIds || []));
    if (evaluation.result === "failed") field.status = "failed";
    else if (field.status !== "field-proven") field.status = "insufficient-data";
  }
  return skill;
}
function approvalGate(skill = {}, scope = "advisoryRetrieval") {
  if (!APPROVAL_SCOPES.has(scope)) return { ok: false, reasons: ["unknown-approval-scope"] };
  const normalized = normalizeSkillGovernance(skill);
  const reasons = [];
  const unsafe = Boolean(skill.governance?.unsafe);
  if (unsafe) reasons.push("unsafe-skill");
  if (normalized.evidenceState.schema.status !== "valid") reasons.push("schema-invalid-or-unknown");
  if (scope !== "advisoryRetrieval") {
    if (!new Set(["trusted", "reviewed"]).has(normalized.evidenceState.sourceTrust.status)) reasons.push("source-not-trusted-or-reviewed");
    if (normalized.evidenceState.localVerification.status !== "passed") reasons.push("local-verification-not-passed");
    if (normalized.evidenceState.sandbox.status === "failed") reasons.push("sandbox-failed");
  }
  if (scope === "publishing") {
    if (normalized.approvals.routing !== "approved") reasons.push("routing-not-approved");
    if (normalized.evidenceState.field.status !== "field-proven") reasons.push("exact-version-not-field-proven");
  }
  return { ok: reasons.length === 0, reasons, evidenceState: normalized.evidenceState, approvals: normalized.approvals };
}
function setApproval(skill = {}, scope, decision = "approve") {
  if (!APPROVAL_SCOPES.has(scope)) throw new Error(`unknown skill approval scope: ${scope}`);
  applySkillGovernance(skill);
  const revoke = decision === "revoke";
  if (scope === "advisoryRetrieval") skill.approvals.advisoryRetrieval = revoke ? "revoked" : "allowed";
  else skill.approvals[scope] = revoke ? "revoked" : "approved";
  return skill;
}
function topologyEligibility(skill = {}) {
  const gate = approvalGate(skill, "routing");
  if (normalizeSkillGovernance(skill).approvals.routing !== "approved") gate.reasons.push("routing-not-approved");
  return { ...gate, ok: gate.reasons.length === 0, reasons: [...new Set(gate.reasons)] };
}

module.exports = {
  SKILL_GOVERNANCE_SCHEMA_VERSION,
  SOURCE_TRUST,
  SCHEMA_STATUS,
  SANDBOX_STATUS,
  VERIFICATION_STATUS,
  FIELD_STATUS,
  APPROVAL_SCOPES,
  sha256,
  sourceHashForSkill,
  normalizeSkillGovernance,
  applySkillGovernance,
  normalizeSkillEvaluation,
  applyEvaluation,
  approvalGate,
  setApproval,
  topologyEligibility,
};
