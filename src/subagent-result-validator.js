"use strict";

const { validateRoleResultEnvelope } = require("./role-result-schemas");

const DEFAULT_MAX_RESULT_CHARS = 12000;

function finiteLimit(value, fallback = Infinity) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeBudget(budget = {}, defaults = {}) {
  // Null explicitly means no task budget; result size remains a transport guard.
  if (budget === null) return { maxSteps: Infinity, maxModelCalls: Infinity, maxToolCalls: Infinity, wallClockMs: Infinity, maxQueueWaitMs: Infinity, maxResultChars: 131072, maxLengthContinuations: 0 };
  const maxModelCalls = finiteLimit(budget.maxModelCalls ?? budget.maxSteps, finiteLimit(defaults.maxModelCalls ?? defaults.maxSteps));
  return {
    ...defaults,
    ...budget,
    maxSteps: maxModelCalls,
    maxModelCalls,
    maxToolCalls: finiteLimit(budget.maxToolCalls, finiteLimit(defaults.maxToolCalls)),
    wallClockMs: finiteLimit(budget.wallClockMs, finiteLimit(defaults.wallClockMs)),
    maxQueueWaitMs: finiteLimit(budget.maxQueueWaitMs, finiteLimit(defaults.maxQueueWaitMs)),
    maxResultChars: finiteLimit(budget.maxResultChars, finiteLimit(defaults.maxResultChars, DEFAULT_MAX_RESULT_CHARS)),
    maxLengthContinuations: finiteLimit(budget.maxLengthContinuations, finiteLimit(defaults.maxLengthContinuations, 0)),
  };
}

function toolCallId(part, messageIndex, partIndex) {
  return String(part?.id || part?.toolCallId || `missing-call-id:${messageIndex}:${partIndex}`);
}

function messageDiagnostics(messages = []) {
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
  const calls = new Map();
  const results = new Map();
  let modelCalls = 0;
  let toolFailures = 0;
  let readRequests = 0, unknownReadRequests = 0;
  const readKeys = new Set();
  const addUsage = (total, value) => total != null && Number.isFinite(value) && value >= 0 ? total + value : null;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message?.role === "assistant") {
      modelCalls += 1;
      const usage = message.usage || {};
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) tokenUsage[key] = addUsage(tokenUsage[key], usage[key]);
      tokenUsage.cost.total = addUsage(tokenUsage.cost.total, usage.cost?.total);
      for (let partIndex = 0; partIndex < (Array.isArray(message.content) ? message.content.length : 0); partIndex++) {
        const part = message.content[partIndex];
        if (part?.type !== "toolCall") continue;
        const id = toolCallId(part, messageIndex, partIndex);
        if (!calls.has(id)) {
          const name = part.name || part.toolName || null;
          calls.set(id, { id, name });
          if (name === "read") {
            readRequests++;
            const args = part.arguments;
            if (typeof args?.path === "string") readKeys.add(JSON.stringify([args.path, args.offset ?? 1, args.limit ?? null]));
            else unknownReadRequests++;
          }
        }
      }
    }
    if (message?.role === "toolResult") {
      const id = String(message.toolCallId || `missing-result-id:${messageIndex}`);
      if (!results.has(id)) results.set(id, { id, name: message.toolName || null, isError: message.isError === true });
      if (message.isError === true) toolFailures += 1;
    }
  }
  if (!modelCalls) { for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) tokenUsage[key] = null; tokenUsage.cost.total = null; }
  const unmatchedToolCallIds = [...calls.keys()].filter((id) => !results.has(id));
  const unmatchedToolResultIds = [...results.keys()].filter((id) => !calls.has(id));
  const diagnostics = {
    diagnosticsSchemaVersion: 2,
    modelCalls,
    toolCalls: calls.size,
    toolResults: results.size,
    toolFailures,
    unmatchedToolCallIds,
    unmatchedToolResultIds,
    toolCallIds: [...calls.keys()],
    toolResultIds: [...results.keys()],
    sourceReads: { requested: readRequests, uniqueRequests: unknownReadRequests ? null : readKeys.size, repeatedRequests: unknownReadRequests ? null : readRequests - readKeys.size },
    tokenUsage,
  };
  return withLegacyDiagnosticAliases(diagnostics);
}

function withLegacyDiagnosticAliases(diagnostics = {}) {
  return {
    ...diagnostics,
    model_calls: Number(diagnostics.modelCalls ?? diagnostics.model_calls ?? 0),
    tool_calls: Number(diagnostics.toolCalls ?? diagnostics.tool_calls ?? 0),
    tool_results: Number(diagnostics.toolResults ?? diagnostics.tool_results ?? 0),
    tool_failures: Number(diagnostics.toolFailures ?? diagnostics.tool_failures ?? 0),
    unmatched_tool_call_ids: diagnostics.unmatchedToolCallIds || diagnostics.unmatched_tool_call_ids || [],
    unmatched_tool_result_ids: diagnostics.unmatchedToolResultIds || diagnostics.unmatched_tool_result_ids || [],
    token_usage: diagnostics.tokenUsage || diagnostics.token_usage || {},
  };
}

function budgetViolation(diagnostics = {}, budgetInput = {}) {
  const budget = normalizeBudget(budgetInput);
  const modelCalls = Number(diagnostics.modelCalls ?? diagnostics.model_calls ?? 0);
  const toolCalls = Number(diagnostics.toolCalls ?? diagnostics.tool_calls ?? 0);
  const resultChars = Number(diagnostics.resultChars ?? diagnostics.result_chars ?? 0);
  if (Number.isFinite(budget.maxModelCalls) && modelCalls > budget.maxModelCalls) return { code: "SUBAGENT_BUDGET_MODEL_CALLS", terminationCode: "budget_model_calls", limit: budget.maxModelCalls, actual: modelCalls };
  if (Number.isFinite(budget.maxToolCalls) && toolCalls > budget.maxToolCalls) return { code: "SUBAGENT_BUDGET_TOOL_CALLS", terminationCode: "budget_tool_calls", limit: budget.maxToolCalls, actual: toolCalls, boundedToolOvershoot: Math.max(0, toolCalls - budget.maxToolCalls) };
  if (Number.isFinite(budget.maxResultChars) && resultChars > budget.maxResultChars) return { code: "SUBAGENT_BUDGET_OUTPUT", terminationCode: "budget_output", limit: budget.maxResultChars, actual: resultChars };
  return null;
}

function terminalAssistantMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "assistant") return messages[index];
  return null;
}

function publicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const type = String(part?.type || "").toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning") || type === "toolcall") return "";
    return String(part?.text || part?.content || "");
  }).filter(Boolean).join("\n");
}

function structuredResultFromMessage(message) {
  if (message?.role !== "toolResult" || message.toolName !== "submit_role_result" || message.isError === true) return null;
  const details = message.details?.result ?? message.details;
  if (details && typeof details === "object" && !Array.isArray(details)) return details;
  const text = publicText(message.content).trim();
  if (!text) return null;
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function structuredResults(messages = []) {
  const results = [];
  const seenToolCallIds = new Set();
  for (const message of messages) {
    const result = structuredResultFromMessage(message);
    if (!result) continue;
    const toolCallId = String(message.toolCallId || `missing-submit-id:${results.length}`);
    if (seenToolCallIds.has(toolCallId)) continue;
    seenToolCallIds.add(toolCallId);
    results.push(result);
  }
  return results;
}

function parseStructuredResult(messages = []) {
  return structuredResults(messages).at(-1) || null;
}

function validationFailure(code, stopReason, message, diagnostics, extra = {}) {
  return { ok: false, termination: { code, stopReason: stopReason || null, message }, diagnostics, finalResponse: "", submittedResult: null, ...extra };
}

function validateRpcCompletion({ agentEnd, messages = [], budget: budgetInput = {}, maxResultChars, roleContract = null, requireRoleResultV2 = false, subagentId } = {}) {
  const budget = budgetInput === null ? normalizeBudget(null) : normalizeBudget({ ...budgetInput, ...(maxResultChars == null ? {} : { maxResultChars }) });
  const diagnostics = messageDiagnostics(Array.isArray(messages) ? messages : []);
  const terminal = terminalAssistantMessage(messages);
  const acceptedSubmissions = structuredResults(messages);
  const structured = acceptedSubmissions.at(-1) || null;
  diagnostics.acceptedResultSubmissions = acceptedSubmissions.length;
  const stopReason = terminal?.stopReason || null;
  const finalResponse = structured ? String(structured.summary || structured.final_response || structured.finalResponse || "").trim() : publicText(terminal?.content).trim();
  diagnostics.resultChars = finalResponse.length;
  diagnostics.result_chars = finalResponse.length;
  const violation = budgetViolation(diagnostics, budget);
  if (violation) return validationFailure(violation.terminationCode, stopReason, `subagent ${violation.terminationCode} limit exceeded (${violation.actual} > ${violation.limit})`, withLegacyDiagnosticAliases({ ...diagnostics, ...violation }), { violation });
  if (!agentEnd || typeof agentEnd !== "object") return validationFailure("rpc_protocol", stopReason, "Pi RPC completion event was missing", diagnostics);
  if (!terminal && !structured) return validationFailure("empty_result", null, "Pi RPC run produced no terminal assistant result", diagnostics);
  if (stopReason === "error") return validationFailure("provider_error", stopReason, "Pi RPC terminal assistant reported an error", diagnostics);
  if (stopReason === "aborted") return validationFailure("aborted", stopReason, "Pi RPC terminal assistant was aborted", diagnostics);
  if (stopReason === "length") return validationFailure("output_limit", stopReason, "Pi RPC terminal assistant reached its output limit", diagnostics);
  // An unmatched call means work may still be running and cannot count as
  // success. An orphan result is diagnostic noise from an incomplete provider
  // transcript, but it does not represent unfinished child work.
  if (diagnostics.unmatchedToolCallIds.length) return validationFailure("incomplete_tool_use", stopReason, "Pi RPC tool-call accounting was incomplete", diagnostics);
  if (acceptedSubmissions.length > 1) return validationFailure("invalid_result", stopReason, "role-v2 completion accepts exactly one successful submit_role_result call", diagnostics, { resultErrors: ["multiple successful role result submissions"] });
  if (requireRoleResultV2 && !structured) return validationFailure("invalid_result", stopReason, "role-v2 completion requires submit_role_result", diagnostics);
  if (structured && (requireRoleResultV2 || roleContract)) {
    const roleValidation = validateRoleResultEnvelope(structured, { contract: roleContract, subagentId });
    if (!roleValidation.ok) return validationFailure("invalid_result", stopReason, `role-v2 result validation failed: ${roleValidation.errors.join("; ")}`, diagnostics, { resultErrors: roleValidation.errors });
  }
  if (stopReason === "toolUse" && !structured) return validationFailure("incomplete_tool_use", stopReason, "Pi RPC run ended on tool use without a submitted result", diagnostics);
  if (!structured && !finalResponse) return validationFailure("empty_result", stopReason, "Pi RPC terminal assistant returned empty output", diagnostics);
  return {
    ok: true,
    termination: { code: structured ? "submitted" : "completed", stopReason, message: structured ? "structured result submitted" : "terminal assistant output accepted" },
    diagnostics,
    finalResponse,
    submittedResult: structured,
  };
}

function createRpcBudgetTracker(budgetInput = {}) {
  const budget = normalizeBudget(budgetInput);
  const toolCallIds = new Set();
  const toolResultIds = new Set();
  let modelCalls = 0;
  let toolFailures = 0;
  let resultChars = 0;
  let violation = null;
  const snapshot = () => withLegacyDiagnosticAliases({
    diagnosticsSchemaVersion: 2,
    modelCalls,
    toolCalls: toolCallIds.size,
    toolResults: toolResultIds.size,
    toolFailures,
    unmatchedToolCallIds: [...toolCallIds].filter((id) => !toolResultIds.has(id)),
    unmatchedToolResultIds: [...toolResultIds].filter((id) => !toolCallIds.has(id)),
    resultChars,
    boundedToolOvershoot: Number.isFinite(budget.maxToolCalls) ? Math.max(0, toolCallIds.size - budget.maxToolCalls) : 0,
    tokenUsage: {},
  });
  return {
    budget,
    observe(event = {}) {
      if (violation) return violation;
      if (event.type === "message_start" && event.message?.role === "assistant") modelCalls += 1;
      if (event.type === "tool_execution_start") toolCallIds.add(String(event.toolCallId || `missing-stream-tool-id:${toolCallIds.size}`));
      if (event.type === "tool_execution_end") {
        toolResultIds.add(String(event.toolCallId || `missing-stream-result-id:${toolResultIds.size}`));
        if (event.isError === true || event.result?.isError === true) toolFailures += 1;
      }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") resultChars += String(event.assistantMessageEvent.delta || "").length;
      violation = budgetViolation(snapshot(), budget);
      return violation;
    },
    snapshot,
    get violation() { return violation; },
  };
}

function errorFromValidation(validation) {
  const error = new Error(validation?.termination?.message || "invalid subagent RPC result");
  const codeMap = {
    provider_error: "SUBAGENT_PROVIDER_ERROR",
    aborted: "SUBAGENT_ABORTED",
    output_limit: "SUBAGENT_OUTPUT_LIMIT",
    empty_result: "SUBAGENT_EMPTY_RESULT",
    incomplete_tool_use: "SUBAGENT_INCOMPLETE_TOOL_USE",
    rpc_protocol: "SUBAGENT_RPC_PROTOCOL",
    invalid_result: "SUBAGENT_INVALID_RESULT",
    budget_model_calls: "SUBAGENT_BUDGET_MODEL_CALLS",
    budget_tool_calls: "SUBAGENT_BUDGET_TOOL_CALLS",
    budget_output: "SUBAGENT_BUDGET_OUTPUT",
  };
  error.code = validation?.violation?.code || codeMap[validation?.termination?.code] || "SUBAGENT_INVALID_RESULT";
  if (validation?.termination?.code === "aborted") error.name = "AbortError";
  error.termination = validation?.termination;
  error.subagentDiagnostics = validation?.diagnostics;
  return error;
}

module.exports = {
  DEFAULT_MAX_RESULT_CHARS,
  normalizeBudget,
  messageDiagnostics,
  withLegacyDiagnosticAliases,
  budgetViolation,
  terminalAssistantMessage,
  parseStructuredResult,
  structuredResults,
  validateRpcCompletion,
  createRpcBudgetTracker,
  errorFromValidation,
};
