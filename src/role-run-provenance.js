"use strict";

/** Compact schema-v4 parent-session provenance for delegated role runs. */

const { redactMemoryText } = require("./memory-content-scanner");

const ROLE_RUN_SCHEMA_VERSION = 4;
const ROLE_RUN_FIELDS = Object.freeze([
  "schemaVersion", "roleRunSchemaVersion", "roleRuntimeVersion", "contractVersion", "resultSchemaVersion", "runtimeSourceHash", "at", "source",
  "roleId", "roleResolution", "status", "terminalCategory", "typedResultValid", "accountingValid", "mutationMode", "fixture", "eligibleLive", "eligibilityReason", "parentSessionId", "subagentId", "branchId", "topologyRunId",
  "topologyId", "nodeId", "modelPreference", "selectedModel", "effectiveModel", "fallbackModel", "modelPolicySource",
  "selectedThinkingLevel", "effectiveThinkingLevel", "thinkingPolicySource",
  "toolPolicy", "workspace", "childSessionFile", "childSessionDir", "termination", "budget",
  "modelCalls", "toolCalls", "toolResults", "toolFailures", "queueWaitMs", "executionDurationMs",
  "totalDurationMs", "wallClockBudgetMs", "taskHash", "resultHash",
]);
const STRING_FIELDS = new Set([
  "contractVersion", "runtimeSourceHash", "at", "source", "roleId", "roleResolution", "status", "terminalCategory", "mutationMode", "eligibilityReason", "parentSessionId", "subagentId",
  "branchId", "topologyRunId", "topologyId", "nodeId", "modelPreference", "selectedModel", "effectiveModel", "fallbackModel",
  "modelPolicySource", "selectedThinkingLevel", "effectiveThinkingLevel", "thinkingPolicySource", "childSessionFile", "childSessionDir", "taskHash", "resultHash",
]);
const NUMBER_FIELDS = new Set([
  "schemaVersion", "roleRunSchemaVersion", "roleRuntimeVersion", "resultSchemaVersion", "modelCalls", "toolCalls", "toolResults",
  "toolFailures", "queueWaitMs", "executionDurationMs", "totalDurationMs", "wallClockBudgetMs",
]);
const BUDGET_FIELDS = Object.freeze(["maxSteps", "maxModelCalls", "maxToolCalls", "wallClockMs", "maxQueueWaitMs", "maxResultChars", "maxLengthContinuations"]);
const TERMINAL_ROLE_STATUSES = Object.freeze(["succeeded", "failed", "cancelled", "timed_out"]);
const ROLE_EXECUTION_TOOLS = new Set(["create_subagent", "run_topology", "auto_role_router"]);

function boundedString(value, max = 1000) {
  if (value == null) return null;
  return String(value).slice(0, max);
}
function boundedNames(values, max = 64) {
  return Array.isArray(values) ? values.slice(0, max).map((value) => boundedString(value, 160)).filter(Boolean) : [];
}
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function sanitizeBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(BUDGET_FIELDS.filter((field) => value[field] != null).map((field) => [field, finiteNumber(value[field])]));
}
function sanitizeTermination(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { code: boundedString(value.code, 120), stopReason: boundedString(value.stopReason, 120) };
}
function sanitizeToolPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { allowedTools: boundedNames(value.allowedTools), deniedTools: boundedNames(value.deniedTools) };
}
function sanitizeWorkspace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    policy: boundedString(value.policy, 120),
    retained: value.retained === true,
    pathHash: boundedString(value.pathHash, 128),
    patchHash: boundedString(value.patchHash, 128),
    patchBytes: finiteNumber(value.patchBytes),
    changedPaths: Array.isArray(value.changedPaths)
      ? value.changedPaths.slice(0, 1000).map((item) => ({ pathHash: boundedString(item?.pathHash, 128) })).filter((item) => item.pathHash)
      : [],
  };
}

function sanitizeRoleRunRecord(input = {}) {
  const output = {};
  for (const field of ROLE_RUN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (STRING_FIELDS.has(field)) output[field] = boundedString(input[field]);
    else if (NUMBER_FIELDS.has(field)) output[field] = finiteNumber(input[field]);
    else if (field === "budget") output[field] = sanitizeBudget(input[field]);
    else if (field === "termination") output[field] = sanitizeTermination(input[field]);
    else if (field === "toolPolicy") output[field] = sanitizeToolPolicy(input[field]);
    else if (field === "workspace") output[field] = sanitizeWorkspace(input[field]);
    else if (["typedResultValid", "accountingValid", "fixture", "eligibleLive"].includes(field)) output[field] = input[field] === true;
  }
  return output;
}

function compactRoleToolOutcome(input = {}) {
  const validStatus = TERMINAL_ROLE_STATUSES.includes(input.status);
  const status = validStatus ? input.status : "failed";
  const reportedTermination = validStatus ? sanitizeTermination(input.termination) : null;
  const termination = !reportedTermination || (status === "succeeded" && reportedTermination.code !== "submitted") || (status !== "succeeded" && ["submitted", "completed"].includes(reportedTermination.code))
    ? { code: status === "succeeded" ? "submitted" : "invalid_result", stopReason: null }
    : reportedTermination;
  const diagnostics = input.diagnostics || {};
  return {
    schemaVersion: finiteNumber(input.schemaVersion || 2),
    contractVersion: boundedString(input.contractVersion || "role-v2", 80),
    subagentId: boundedString(input.subagentId || input.subagent_id, 160),
    roleId: boundedString(input.roleId || input.role, 160),
    status,
    termination,
    summary: redactMemoryText(boundedString(input.summary || (status === "succeeded" ? "Role completed." : `Role ${status}.`), 1000), { maxChars: 1000 }),
    verification: { status: boundedString(input.verification?.status || "unchecked", 80) },
    diagnostics: {
      modelCalls: finiteNumber(diagnostics.modelCalls ?? diagnostics.model_calls),
      toolCalls: finiteNumber(diagnostics.toolCalls ?? diagnostics.tool_calls),
      toolResults: finiteNumber(diagnostics.toolResults ?? diagnostics.tool_results),
      toolFailures: finiteNumber(diagnostics.toolFailures ?? diagnostics.tool_failures),
      queueWaitMs: finiteNumber(diagnostics.queueWaitMs ?? diagnostics.queue_wait_ms),
      executionDurationMs: finiteNumber(diagnostics.executionDurationMs ?? diagnostics.execution_duration_ms),
      totalDurationMs: finiteNumber(diagnostics.totalDurationMs ?? diagnostics.total_duration_ms ?? diagnostics.duration_ms),
    },
  };
}

function roleToolResultOverride(event = {}) {
  if (!ROLE_EXECUTION_TOOLS.has(event.toolName)) return undefined;
  const details = event.details && typeof event.details === "object" ? event.details : {};
  if (event.toolName === "create_subagent" && details.executed !== true) return undefined;
  const candidate = event.toolName === "auto_role_router" ? details.result : event.toolName === "create_subagent" ? (details.result || details) : details;
  const status = candidate?.status || details.status;
  if (!TERMINAL_ROLE_STATUSES.includes(status) || status === "succeeded") return undefined;
  return { content: event.content, details: event.details, isError: true };
}

module.exports = {
  ROLE_RUN_SCHEMA_VERSION,
  ROLE_RUN_FIELDS,
  BUDGET_FIELDS,
  TERMINAL_ROLE_STATUSES,
  sanitizeRoleRunRecord,
  compactRoleToolOutcome,
  roleToolResultOverride,
};
