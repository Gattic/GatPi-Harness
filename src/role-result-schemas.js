"use strict";

const { DOSSIER_SCHEMA, VISUAL_CRITIQUE_SCHEMA } = require("./specialist-schemas");
const { validateJsonSchema } = require("./specialist-contracts");
const ROLE_RESULT_SCHEMA_VERSION = 2;
const ROLE_CONTRACT_VERSION = "role-v2";
const ROADMAP_GOAL_MAX_LENGTH = 400;
const EVIDENCE_TEXT_MAX_LENGTH = 2000;
const EVIDENCE_ID_MAX_LENGTH = 128;
const EVIDENCE_ITEMS_MAX = 64;
const CLAIMS_MAX = 48;
const ANALYSIS_ASSIGNMENTS_MAX = 8;
const SYNTHESIS_ITEMS_MAX = 32;
const RESULT_STATUSES = Object.freeze(["succeeded", "failed", "cancelled", "timed_out"]);
const VERIFICATION_STATUSES = Object.freeze(["unchecked", "passed", "failed"]);

const ROADMAP_PLAN_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "milestones"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 240 },
    milestones: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        required: ["title", "goals"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 240 },
          goals: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: ROADMAP_GOAL_MAX_LENGTH } },
        },
      },
    },
  },
});

const boundedString = (maxLength = EVIDENCE_TEXT_MAX_LENGTH) => ({ type: "string", minLength: 1, maxLength });
const boundedStringArray = (maxItems = SYNTHESIS_ITEMS_MAX, maxLength = EVIDENCE_TEXT_MAX_LENGTH) => ({ type: "array", maxItems, items: boundedString(maxLength) });
const EVIDENCE_REFERENCE_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "kind", "source"],
  additionalProperties: false,
  properties: {
    id: boundedString(EVIDENCE_ID_MAX_LENGTH),
    kind: boundedString(80),
    source: boundedString(500),
    locator: { type: "string", maxLength: 500 },
    observation: { type: "string", maxLength: EVIDENCE_TEXT_MAX_LENGTH },
  },
});
const CLAIM_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "statement", "evidenceRefs"],
  additionalProperties: false,
  properties: {
    id: boundedString(EVIDENCE_ID_MAX_LENGTH),
    statement: boundedString(EVIDENCE_TEXT_MAX_LENGTH),
    status: { enum: ["proposed", "accepted", "rejected", "uncertain"] },
    evidenceRefs: boundedStringArray(16, EVIDENCE_ID_MAX_LENGTH),
    confidence: { type: "number", minimum: 0, maximum: 1 },
    uncertainty: { type: "string", maxLength: 1000 },
  },
});
const ANALYSIS_ASSIGNMENT_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "angle", "objective"],
  additionalProperties: false,
  properties: {
    id: boundedString(EVIDENCE_ID_MAX_LENGTH),
    angle: boundedString(120),
    objective: boundedString(EVIDENCE_TEXT_MAX_LENGTH),
    exclusions: boundedStringArray(12, 500),
    acceptanceCriteria: boundedStringArray(12, 500),
  },
});
const ANALYSIS_PLAN_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "assignments"],
  additionalProperties: false,
  properties: {
    title: boundedString(240),
    assignments: { type: "array", minItems: 1, maxItems: ANALYSIS_ASSIGNMENTS_MAX, items: ANALYSIS_ASSIGNMENT_SCHEMA },
  },
});
const AUDIT_DECISION_SCHEMA = Object.freeze({
  type: "object",
  required: ["claimId", "decision", "rationale", "evidenceRefs"],
  additionalProperties: false,
  properties: {
    claimId: boundedString(EVIDENCE_ID_MAX_LENGTH),
    decision: { enum: ["accepted", "rejected", "uncertain"] },
    rationale: boundedString(EVIDENCE_TEXT_MAX_LENGTH),
    evidenceRefs: boundedStringArray(16, EVIDENCE_ID_MAX_LENGTH),
  },
});
const ISSUE_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "summary"],
  additionalProperties: false,
  properties: {
    id: boundedString(EVIDENCE_ID_MAX_LENGTH),
    summary: boundedString(EVIDENCE_TEXT_MAX_LENGTH),
    claimIds: boundedStringArray(16, EVIDENCE_ID_MAX_LENGTH),
    evidenceRefs: boundedStringArray(16, EVIDENCE_ID_MAX_LENGTH),
    severity: { enum: ["info", "low", "medium", "high"] },
  },
});
const ACTION_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "action"],
  additionalProperties: false,
  properties: {
    id: boundedString(EVIDENCE_ID_MAX_LENGTH),
    action: boundedString(EVIDENCE_TEXT_MAX_LENGTH),
    evidenceRefs: boundedStringArray(16, EVIDENCE_ID_MAX_LENGTH),
    priority: { enum: ["low", "medium", "high"] },
  },
});
const COVERAGE_SCHEMA = Object.freeze({
  type: "object",
  required: ["expectedCategories", "observedCategories", "missingCategories", "ratio"],
  additionalProperties: false,
  properties: {
    expectedCategories: boundedStringArray(16, 120),
    observedCategories: boundedStringArray(16, 120),
    missingCategories: boundedStringArray(16, 120),
    ratio: { type: "number", minimum: 0, maximum: 1 },
  },
});



const publicResultProperties = {
  dossier: DOSSIER_SCHEMA,
  visualCritique: VISUAL_CRITIQUE_SCHEMA,
  summary: { type: "string", minLength: 1 },
  findings: { type: "array", items: { type: "object" } },
  evidence: { type: "array", items: { type: "object" } },
  artifacts: { type: "array", items: { type: "object" } },
  proposedPatch: { anyOf: [{ type: "object" }, { type: "null" }] },
  verification: {
    type: "object",
    required: ["status", "evidence"],
    properties: {
      status: { enum: VERIFICATION_STATUSES },
      evidence: { type: "array" },
    },
  },
  roadmapPlan: ROADMAP_PLAN_SCHEMA,
  analysisPlan: ANALYSIS_PLAN_SCHEMA,
  claims: { type: "array", maxItems: CLAIMS_MAX, items: CLAIM_SCHEMA },
  evidenceRefs: { type: "array", maxItems: EVIDENCE_ITEMS_MAX, items: EVIDENCE_REFERENCE_SCHEMA },
  auditDecisions: { type: "array", maxItems: CLAIMS_MAX, items: AUDIT_DECISION_SCHEMA },
  disagreements: { type: "array", maxItems: SYNTHESIS_ITEMS_MAX, items: ISSUE_SCHEMA },
  rejectedClaims: { type: "array", maxItems: CLAIMS_MAX, items: AUDIT_DECISION_SCHEMA },
  unresolvedGaps: { type: "array", maxItems: SYNTHESIS_ITEMS_MAX, items: ISSUE_SCHEMA },
  recommendedActions: { type: "array", maxItems: SYNTHESIS_ITEMS_MAX, items: ACTION_SCHEMA },
  coverage: COVERAGE_SCHEMA,
};

function outputSchema(required = ["summary"], propertyOverrides = {}) {
  return { type: "object", required, properties: { ...publicResultProperties, ...propertyOverrides } };
}

const ANALYSIS_PLANNER_OUTPUT_SCHEMA = Object.freeze(outputSchema(["summary", "findings", "evidence", "analysisPlan"]));
const EVIDENCE_WORKER_OUTPUT_SCHEMA = Object.freeze(outputSchema(["summary", "findings", "evidence", "claims", "evidenceRefs"]));
const EVIDENCE_AUDITOR_OUTPUT_SCHEMA = Object.freeze(outputSchema(["summary", "findings", "evidence", "claims", "evidenceRefs", "auditDecisions", "rejectedClaims", "unresolvedGaps", "coverage"]));
const EVIDENCE_SYNTHESIS_OUTPUT_SCHEMA = Object.freeze(outputSchema(["summary", "findings", "claims", "evidenceRefs", "auditDecisions", "disagreements", "rejectedClaims", "unresolvedGaps", "recommendedActions", "coverage"]));

const SKILL_INTAKE_FINDING_SCHEMA = Object.freeze({
  type: "object",
  required: ["id", "category", "severity", "code", "summary"],
  additionalProperties: false,
  properties: {
    id: boundedString(EVIDENCE_ID_MAX_LENGTH),
    category: { enum: ["instruction", "dependency", "supply-chain", "security", "privacy", "license", "review", "provenance"] },
    severity: { enum: ["info", "low", "medium", "high"] },
    code: boundedString(120),
    summary: boundedString(1000),
    locator: { type: "string", maxLength: 500 },
    evidenceRefs: boundedStringArray(16, EVIDENCE_ID_MAX_LENGTH),
  },
});
const SKILL_INTAKE_SOURCE_SCHEMA = Object.freeze({
  type: "object",
  required: ["sourceId", "revision", "treeHash", "contentHash", "licenseId", "licenseHash", "fileCount", "totalBytes"],
  additionalProperties: false,
  properties: {
    sourceId: boundedString(EVIDENCE_ID_MAX_LENGTH),
    revision: boundedString(96),
    treeHash: boundedString(80),
    contentHash: boundedString(80),
    licenseId: boundedString(80),
    licenseHash: boundedString(80),
    fileCount: { type: "integer", minimum: 1, maximum: 256 },
    totalBytes: { type: "integer", minimum: 1, maximum: 2097152 },
  },
});
function skillIntakeOutput(requiredField, propertySchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "contractVersion", "summary", "evidence", requiredField],
    properties: {
      schemaVersion: { enum: [ROLE_RESULT_SCHEMA_VERSION] },
      contractVersion: { enum: [ROLE_CONTRACT_VERSION] },
      ...publicResultProperties,
      summary: boundedString(1000),
      evidence: { type: "array", maxItems: EVIDENCE_ITEMS_MAX, items: { type: "object" } },
      findings: { type: "array", maxItems: SYNTHESIS_ITEMS_MAX, items: SKILL_INTAKE_FINDING_SCHEMA },
      [requiredField]: propertySchema,
    },
  };
}
const SKILL_INTAKE_MANIFEST_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("manifestValidation", {
  type: "object", required: ["passed", "validationId", "source", "files"], additionalProperties: false,
  properties: { passed: { type: "boolean" }, validationId: boundedString(EVIDENCE_ID_MAX_LENGTH), source: SKILL_INTAKE_SOURCE_SCHEMA, files: { type: "array", minItems: 1, maxItems: 256, items: { type: "object" } } },
}));
const SKILL_INTAKE_FILTER_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("filterResult", {
  type: "object", required: ["passed", "findingCount", "highSeverityCount", "source", "files"], additionalProperties: false,
  properties: { passed: { type: "boolean" }, findingCount: { type: "integer", minimum: 0, maximum: 256 }, highSeverityCount: { type: "integer", minimum: 0, maximum: 256 }, source: SKILL_INTAKE_SOURCE_SCHEMA, files: { type: "array", minItems: 1, maxItems: 256, items: { type: "object" } } },
}));
const SKILL_INTAKE_READ_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("sourceReading", {
  type: "object", required: ["source", "filesReviewed", "evidenceRefs"], additionalProperties: false,
  properties: { source: SKILL_INTAKE_SOURCE_SCHEMA, filesReviewed: boundedStringArray(256, 500), evidenceRefs: boundedStringArray(64, EVIDENCE_ID_MAX_LENGTH) },
}));
const SKILL_INTAKE_WORKFLOW_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("workflow", {
  type: "object", required: ["name", "description", "steps", "requiredTools", "evidenceRefs", "source"], additionalProperties: false,
  properties: { name: boundedString(160), description: boundedString(2000), steps: { type: "array", minItems: 1, maxItems: 16, items: { type: "object" } }, requiredTools: boundedStringArray(32, 120), evidenceRefs: boundedStringArray(32, EVIDENCE_ID_MAX_LENGTH), source: SKILL_INTAKE_SOURCE_SCHEMA },
}));
const SKILL_INTAKE_SCORE_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("objectiveScore", {
  type: "object", required: ["passed", "score", "dimensions", "evidenceRefs", "source"], additionalProperties: false,
  properties: { passed: { type: "boolean" }, score: { type: "number", minimum: 0, maximum: 1 }, dimensions: { type: "object" }, rationale: { type: "string", maxLength: 2000 }, evidenceRefs: boundedStringArray(32, EVIDENCE_ID_MAX_LENGTH), source: SKILL_INTAKE_SOURCE_SCHEMA },
}));
const SKILL_INTAKE_CANDIDATE_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("candidatePackage", {
  type: "object", required: ["name", "description", "category", "triggerConditions", "workflowSteps", "requiredTools", "expectedOutputs", "validationStrategy", "source"], additionalProperties: false,
  properties: { name: boundedString(160), description: boundedString(2000), category: { enum: ["debugging", "refactor", "verification", "topology", "tool-use", "retrieval", "coordination", "documentation", "general"] }, triggerConditions: boundedStringArray(16, 500), workflowSteps: { type: "array", minItems: 1, maxItems: 16, items: { type: "object" } }, requiredTools: boundedStringArray(32, 120), expectedOutputs: boundedStringArray(16, 500), validationStrategy: { type: "object" }, source: SKILL_INTAKE_SOURCE_SCHEMA },
}));
const SKILL_INTAKE_REVIEW_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("reviewDecision", {
  type: "object", required: ["decision", "rationale", "evidenceRefs"], additionalProperties: false,
  properties: { decision: { enum: ["accepted", "rejected", "uncertain"] }, rationale: boundedString(2000), evidenceRefs: { ...boundedStringArray(32, EVIDENCE_ID_MAX_LENGTH), minItems: 1 } },
}));
const SKILL_INTAKE_AUDIT_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("auditDecision", {
  type: "object", required: ["decision", "rationale", "evidenceRefs", "coverageComplete"], additionalProperties: false,
  properties: { decision: { enum: ["accepted", "rejected", "uncertain"] }, rationale: boundedString(2000), evidenceRefs: { ...boundedStringArray(64, EVIDENCE_ID_MAX_LENGTH), minItems: 1 }, coverageComplete: { type: "boolean" } },
}));
const SKILL_INTAKE_FINAL_OUTPUT_SCHEMA = Object.freeze(skillIntakeOutput("candidate", {
  type: "object", required: ["candidateId", "status", "source", "packetHash", "relativePath"], additionalProperties: false,
  properties: { candidateId: boundedString(EVIDENCE_ID_MAX_LENGTH), status: { enum: ["candidate"] }, source: SKILL_INTAKE_SOURCE_SCHEMA, packetHash: boundedString(80), relativePath: boundedString(500) },
}));

const ROLE_OUTPUT_SCHEMAS = Object.freeze({
  coordinator: outputSchema(["summary", "findings"]),
  planner: outputSchema(["summary", "findings", "evidence"], {
    summary: { type: "string", minLength: 32 },
    evidence: { type: "array", minItems: 1, items: { type: "object" } },
  }),
  researcher: outputSchema(["summary", "findings", "evidence"]),
  reviewer: outputSchema(["summary", "findings", "evidence", "verification"], {
    summary: { type: "string", minLength: 32 },
    evidence: { type: "array", minItems: 1, items: { type: "object" } },
  }),
  coder: outputSchema(["summary", "evidence", "artifacts", "proposedPatch", "verification"], {
    summary: { type: "string", minLength: 32 },
    evidence: { type: "array", minItems: 1, items: { type: "object" } },
  }),
  verifier: outputSchema(["summary", "evidence", "verification"], {
    evidence: { type: "array", minItems: 1, items: { type: "object" } },
    verification: {
      type: "object",
      required: ["status", "evidence"],
      properties: {
        status: { enum: VERIFICATION_STATUSES },
        evidence: { type: "array", minItems: 1 },
      },
    },
  }),
  refactorer: outputSchema(["summary", "evidence", "artifacts", "proposedPatch", "verification"], {
    summary: { type: "string", minLength: 32 },
    evidence: { type: "array", minItems: 1, items: { type: "object" } },
  }),
  benchmark: outputSchema(["summary", "findings", "evidence", "verification"]),
  "evidence-auditor": EVIDENCE_AUDITOR_OUTPUT_SCHEMA,
  "memory-curator": outputSchema(["summary", "evidence"]),
  "tool-specialist": outputSchema(["summary", "evidence"]),
  "skill-intake-handler": SKILL_INTAKE_MANIFEST_OUTPUT_SCHEMA,
  worker: outputSchema(["summary", "findings", "evidence"]),
  generic: outputSchema(["summary", "findings", "evidence"]),
});


function boundedText(value, maxChars = 12000) {
  const text = String(value || "").trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function normalizeRoadmapPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const milestones = Array.isArray(input.milestones) ? input.milestones.map((milestone) => ({
    title: String(milestone?.title || "").trim(),
    goals: Array.isArray(milestone?.goals) ? milestone.goals.map((goal) => String(goal || "").trim()) : [],
  })) : [];
  return { title: String(input.title || "").trim(), milestones };
}

function normalizePublicSubmission(input = {}, { maxResultChars = 12000 } = {}) {
  const roadmapPlan = normalizeRoadmapPlan(input.roadmapPlan ?? input.roadmap_plan);
  const result = {
    ...(input.schemaVersion != null ? { schemaVersion: Number(input.schemaVersion) } : {}),
    ...(input.contractVersion != null ? { contractVersion: String(input.contractVersion) } : {}),
    summary: boundedText(input.summary, maxResultChars),
    findings: Array.isArray(input.findings) ? input.findings : [],
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
    proposedPatch: input.proposedPatch ?? input.proposed_patch ?? null,
    verification: input.verification && typeof input.verification === "object"
      ? { status: input.verification.status || "unchecked", evidence: Array.isArray(input.verification.evidence) ? input.verification.evidence : [] }
      : { status: "unchecked", evidence: [] },
    ...(roadmapPlan ? { roadmapPlan } : {}),
  };
  if (input.analysisPlan && typeof input.analysisPlan === "object" && !Array.isArray(input.analysisPlan)) result.analysisPlan = input.analysisPlan;
  for (const field of ["claims", "evidenceRefs", "auditDecisions", "disagreements", "rejectedClaims", "unresolvedGaps", "recommendedActions"]) if (Array.isArray(input[field])) result[field] = input[field];
  if (input.coverage && typeof input.coverage === "object" && !Array.isArray(input.coverage)) result.coverage = input.coverage;
  for (const field of ["dossier", "visualCritique", "manifestValidation", "filterResult", "sourceReading", "workflow", "objectiveScore", "candidatePackage", "reviewDecision", "auditDecision", "candidate"]) if (input[field] && typeof input[field] === "object" && !Array.isArray(input[field])) result[field] = input[field];
  return result;
}

function validateRoleSubmission(input, { schema = ROLE_OUTPUT_SCHEMAS.generic, maxResultChars = 12000, allowEmptySummary = false } = {}) {
  const result = normalizePublicSubmission(input, { maxResultChars });
  const errors = validateJsonSchema(schema, result);
  if (result.dossier && !errors.length) {
    const structure = require("./specialist-verifiers").verifyDossier({ dossier: result.dossier });
    if (!structure.ok) errors.push(`$.dossier: ${structure.stderr}`);
  }
  if (!allowEmptySummary && !result.summary) errors.push("$.summary must not be empty");
  const serialized = JSON.stringify(result);
  if (serialized.length > maxResultChars) errors.push(`$ exceeds ${maxResultChars} serialized characters`);
  return { ok: errors.length === 0, errors, result };
}

function isPlaceholderText(value, rejectedValues = []) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  const rejected = new Set(rejectedValues.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  return rejected.has(text) || !/[a-z0-9]/i.test(text) || /^(?:placeholder|todo|tbd|n\/a|none|unknown|noop|no-op|fixme|xxx|x)(?:\d+)?$/i.test(text);
}

function hasMeaningfulEvidenceDetail(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  return Object.entries(item).some(([key, value]) => !["id", "kind", "type"].includes(key) && value != null && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.trim().length >= 3 && !isPlaceholderText(value)) || (Array.isArray(value) && value.length > 0) || (typeof value === "object" && Object.keys(value).length > 0)));
}

function completionPolicyErrors(result, contract = {}) {
  const policy = contract.completionPolicy || {};
  const errors = [];
  const summary = String(result?.summary || "").trim();
  const minimumSummaryChars = Number(policy.minimumSummaryChars || 0);
  const rejectedSummaries = policy.rejectedSummaries || [];
  if (minimumSummaryChars && summary.length < minimumSummaryChars) errors.push(`$.summary must contain at least ${minimumSummaryChars} meaningful characters`);
  if (isPlaceholderText(summary, rejectedSummaries)) errors.push("$.summary is a placeholder rather than a meaningful result");
  if (policy.requireEvidence === true && !result?.evidence?.length) errors.push("$.evidence must contain at least one supporting item");
  else if (policy.requireEvidence === true && !result.evidence.some(hasMeaningfulEvidenceDetail)) errors.push("$.evidence must contain at least one item with supporting detail");
  if (policy.requireVerificationVerdict === true && !["passed", "failed"].includes(result?.verification?.status)) errors.push("$.verification.status must be passed or failed");
  if (result?.roadmapPlan) {
    if (isPlaceholderText(result.roadmapPlan.title, rejectedSummaries)) errors.push("$.roadmapPlan.title is a placeholder rather than a meaningful title");
    for (const [index, milestone] of (result.roadmapPlan.milestones || []).entries()) {
      if (isPlaceholderText(milestone?.title, rejectedSummaries)) errors.push(`$.roadmapPlan.milestones[${index}].title is a placeholder rather than a meaningful title`);
      for (const [goalIndex, goal] of (milestone?.goals || []).entries()) if (isPlaceholderText(goal, rejectedSummaries)) errors.push(`$.roadmapPlan.milestones[${index}].goals[${goalIndex}] is a placeholder rather than a meaningful goal`);
    }
  }
  return errors;
}

function createRoleResultEnvelope({ contract, subagentId, status = "succeeded", termination, submission = {}, diagnostics = {} } = {}) {
  const publicResult = normalizePublicSubmission(submission, { maxResultChars: contract?.budget?.maxResultChars || 12000 });
  return {
    schemaVersion: ROLE_RESULT_SCHEMA_VERSION,
    contractVersion: ROLE_CONTRACT_VERSION,
    subagentId: String(subagentId || ""),
    roleId: String(contract?.roleId || ""),
    status,
    termination: termination || { code: status === "succeeded" ? "submitted" : status, stopReason: status === "succeeded" ? "toolUse" : null, message: status === "succeeded" ? "typed role result submitted" : status },
    ...publicResult,
    diagnostics: {
      modelCalls: Number(diagnostics.modelCalls || 0),
      toolCalls: Number(diagnostics.toolCalls || 0),
      toolResults: Number(diagnostics.toolResults || 0),
      toolFailures: Number(diagnostics.toolFailures || 0),
      unmatchedToolCallIds: Array.isArray(diagnostics.unmatchedToolCallIds) ? diagnostics.unmatchedToolCallIds : [],
      queueWaitMs: Number(diagnostics.queueWaitMs || 0),
      executionDurationMs: Number(diagnostics.executionDurationMs || 0),
      totalDurationMs: Number(diagnostics.totalDurationMs || 0),
      budgets: diagnostics.budgets || contract?.budget || {},
      workspace: diagnostics.workspace || { policy: contract?.workspacePolicy || "shared-readonly" },
      childSessionFile: diagnostics.childSessionFile || null,
    },
  };
}

function validateRoleResultEnvelope(envelope, { contract, subagentId } = {}) {
  const errors = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, errors: ["result envelope must be an object"] };
  if (Number(envelope.schemaVersion) !== ROLE_RESULT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${ROLE_RESULT_SCHEMA_VERSION}`);
  if (envelope.contractVersion !== ROLE_CONTRACT_VERSION) errors.push(`contractVersion must be ${ROLE_CONTRACT_VERSION}`);
  if (!RESULT_STATUSES.includes(envelope.status)) errors.push("status is invalid");
  if (!envelope.subagentId) errors.push("subagentId is required");
  if (subagentId && envelope.subagentId !== subagentId) errors.push("subagentId does not match the active child");
  if (!envelope.roleId) errors.push("roleId is required");
  if (contract?.roleId && envelope.roleId !== contract.roleId) errors.push("roleId does not match the active contract");
  if (!envelope.termination || typeof envelope.termination !== "object") errors.push("termination is required");
  if (!String(envelope.termination?.code || "").trim()) errors.push("termination.code is required");
  if (envelope.status === "succeeded" && envelope.termination?.code !== "submitted") errors.push("successful v2 results require submitted termination");
  if (envelope.status !== "succeeded" && ["submitted", "completed"].includes(envelope.termination?.code)) errors.push("non-success v2 results require a non-success termination code");
  const effectiveSchema = contract?.outputSchema || ROLE_OUTPUT_SCHEMAS[envelope.roleId] || ROLE_OUTPUT_SCHEMAS.generic;
  for (const field of effectiveSchema.required || []) if (!Object.prototype.hasOwnProperty.call(envelope, field) || envelope[field] === undefined) errors.push(`$.${field} missing required property`);
  const submission = validateRoleSubmission(envelope, {
    schema: effectiveSchema,
    maxResultChars: contract?.budget?.maxResultChars || 12000,
    allowEmptySummary: contract?.completionPolicy?.allowEmptySummary === true,
  });
  errors.push(...submission.errors);
  if (envelope.status === "succeeded") errors.push(...completionPolicyErrors(submission.result, contract));
  if (!envelope.diagnostics || typeof envelope.diagnostics !== "object") errors.push("diagnostics are required");
  else {
    for (const field of ["modelCalls", "toolCalls", "toolResults", "toolFailures", "queueWaitMs", "executionDurationMs", "totalDurationMs"]) if (!Number.isFinite(Number(envelope.diagnostics[field]))) errors.push(`diagnostics.${field} must be numeric`);
    if (!Array.isArray(envelope.diagnostics.unmatchedToolCallIds)) errors.push("diagnostics.unmatchedToolCallIds must be an array");
  }
  return { ok: errors.length === 0, errors, result: envelope };
}

module.exports = {
  ROLE_RESULT_SCHEMA_VERSION,
  ROLE_CONTRACT_VERSION,
  RESULT_STATUSES,
  VERIFICATION_STATUSES,
  ROADMAP_GOAL_MAX_LENGTH,
  EVIDENCE_TEXT_MAX_LENGTH,
  EVIDENCE_ID_MAX_LENGTH,
  EVIDENCE_ITEMS_MAX,
  CLAIMS_MAX,
  ANALYSIS_ASSIGNMENTS_MAX,
  SYNTHESIS_ITEMS_MAX,
  ROADMAP_PLAN_SCHEMA,
  EVIDENCE_REFERENCE_SCHEMA,
  CLAIM_SCHEMA,
  ANALYSIS_PLAN_SCHEMA,
  AUDIT_DECISION_SCHEMA,
  COVERAGE_SCHEMA,
  ANALYSIS_PLANNER_OUTPUT_SCHEMA,
  EVIDENCE_WORKER_OUTPUT_SCHEMA,
  EVIDENCE_AUDITOR_OUTPUT_SCHEMA,
  EVIDENCE_SYNTHESIS_OUTPUT_SCHEMA,
  SKILL_INTAKE_FINDING_SCHEMA,
  SKILL_INTAKE_SOURCE_SCHEMA,
  SKILL_INTAKE_MANIFEST_OUTPUT_SCHEMA,
  SKILL_INTAKE_FILTER_OUTPUT_SCHEMA,
  SKILL_INTAKE_READ_OUTPUT_SCHEMA,
  SKILL_INTAKE_WORKFLOW_OUTPUT_SCHEMA,
  SKILL_INTAKE_SCORE_OUTPUT_SCHEMA,
  SKILL_INTAKE_CANDIDATE_OUTPUT_SCHEMA,
  SKILL_INTAKE_REVIEW_OUTPUT_SCHEMA,
  SKILL_INTAKE_AUDIT_OUTPUT_SCHEMA,
  SKILL_INTAKE_FINAL_OUTPUT_SCHEMA,
  ROLE_OUTPUT_SCHEMAS,
  validateJsonSchema,
  normalizePublicSubmission,
  validateRoleSubmission,
  isPlaceholderText,
  hasMeaningfulEvidenceDetail,
  completionPolicyErrors,
  createRoleResultEnvelope,
  validateRoleResultEnvelope,
};
