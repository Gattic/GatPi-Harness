"use strict";

const crypto = require("node:crypto");
const { normalizeBudget } = require("./subagent-result-validator");
const { ACTUAL_CHILD_TOOLS, resolveRequiredTools, selectRoleInferenceProfile, validateRoleContract, roleRevisionHash } = require("./role-contracts");
const { redactMemoryText } = require("./memory-content-scanner");

const SUBAGENT_PUBLIC_API_VERSION = 1;
const ACTIVE_STATUSES = new Set(["created", "queued", "running"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const PUBLIC_EVENT_TYPES = new Set([
  "subagent.created", "subagent.admitted", "subagent.queued", "subagent.started",
  "subagent.steer_acknowledged", "subagent.steer_rejected", "subagent.interrupt_acknowledged",
  "subagent.cancel_acknowledged", "subagent.process_closed", "subagent.completed",
  "subagent.failed", "subagent.cancelled", "subagent.timed_out", "subagent.continuation_linked",
  "subagent.cleanup_complete", "subagent.baseline_satisfied", "subagent.result_rejected", "subagent.merged",
  "subagent.patch_previewed", "subagent.patch_applied", "subagent.exported", "subagent.pruned",
  "subagent.preflighted",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
function stableStringify(value) { return JSON.stringify(canonical(value)); }
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function safeId(value) { const text = String(value || ""); return /^[A-Za-z0-9_.:-]{1,160}$/.test(text) ? text : null; }
function safeCode(value, fallback = null) { const text = String(value || "").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100); return text || fallback; }
function finite(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function roleRevision(contract) {
  return contract ? roleRevisionHash(contract) : null;
}
function publicWorkspace(workspace = {}, diagnostics = {}) {
  const source = diagnostics?.workspace || workspace || {};
  return {
    policy: source.policy || workspace.policy || null,
    state: workspace.state || null,
    retained: source.retained === true || workspace.retained === true,
    patchHash: source.patchHash || workspace.patchHash || null,
    patchBytes: finite(source.patchBytes ?? workspace.patchBytes),
    changedPathCount: Array.isArray(source.changedPaths) ? source.changedPaths.length : Array.isArray(workspace.changedPaths) ? workspace.changedPaths.length : finite(source.changedPathCount ?? workspace.changedPathCount),
    parentRevision: source.parentRevision || workspace.parentRevision || null,
  };
}
function publicDiagnostics(diagnostics = {}) {
  return {
    diagnosticsSchemaVersion: Number(diagnostics.diagnosticsSchemaVersion || diagnostics.diagnostics_schema_version || 2),
    modelCalls: finite(diagnostics.modelCalls ?? diagnostics.model_calls),
    toolCalls: finite(diagnostics.toolCalls ?? diagnostics.tool_calls),
    toolResults: finite(diagnostics.toolResults ?? diagnostics.tool_results),
    toolFailures: finite(diagnostics.toolFailures ?? diagnostics.tool_failures),
    tokenUsage: canonical(diagnostics.tokenUsage || diagnostics.token_usage || {}),
    callAccounting: { modelCalls: diagnostics.callAccounting?.modelCalls === true, toolCalls: diagnostics.callAccounting?.toolCalls === true },
    sourceReads: diagnostics.sourceReads ? Object.fromEntries(["requested", "uniqueRequests", "repeatedRequests"].map(key => [key, Number.isFinite(diagnostics.sourceReads[key]) ? diagnostics.sourceReads[key] : null])) : null,
    queueWaitMs: finite(diagnostics.queueWaitMs ?? diagnostics.queue_wait_ms),
    startupDurationMs: finite(diagnostics.startupDurationMs),
    promptDurationMs: finite(diagnostics.promptDurationMs),
    executionDurationMs: finite(diagnostics.executionDurationMs ?? diagnostics.execution_duration_ms),
    totalDurationMs: finite(diagnostics.totalDurationMs ?? diagnostics.total_duration_ms ?? diagnostics.duration_ms),
    wallClockBudgetMs: finite(diagnostics.wallClockBudgetMs ?? diagnostics.wall_clock_budget_ms),
    rpcConcurrencyLimit: diagnostics.rpcConcurrencyLimit ?? diagnostics.rpc_concurrency_limit ?? null,
    selectedModel: diagnostics.selectedModel || diagnostics.selected_model || null,
    effectiveModel: diagnostics.effectiveModel || diagnostics.effective_model || null,
    fallbackModel: diagnostics.fallbackModel || diagnostics.fallback_model || null,
    selectedThinkingLevel: diagnostics.selectedThinkingLevel || diagnostics.selected_thinking_level || null,
    effectiveThinkingLevel: diagnostics.effectiveThinkingLevel || diagnostics.effective_thinking_level || null,
    workspace: publicWorkspace({}, diagnostics),
    errorCodes: [...new Set((diagnostics.errors || []).map((error) => safeCode(error?.code || error?.name || "error", "error")))].slice(0, 20),
  };
}
function redactPublicValue(value, depth = 0) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactMemoryText(value, { maxChars: 2000 });
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactPublicValue(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, redactPublicValue(item, depth + 1)]));
  return value;
}
function publicResult(result = {}) {
  if (!result || typeof result !== "object") return null;
  const submitted = result.submitted_result || result.submittedResult || null;
  return {
    schemaVersion: Number(result.schemaVersion || 1),
    contractVersion: result.contractVersion || null,
    subagentId: result.subagentId || result.subagent_id || null,
    parentSessionId: result.parentSessionId || result.parent_session_id || null,
    branchId: result.branchId || result.branch_id || null,
    roleId: result.roleId || result.role || null,
    status: result.status || "unknown",
    summary: redactMemoryText(result.summary || submitted?.summary || "", { maxChars: 2000 }),
    findings: redactPublicValue(submitted?.findings || result.findings || []),
    evidence: redactPublicValue(submitted?.evidence || result.evidence || []),
    artifacts: redactPublicValue(submitted?.artifacts || result.artifacts || []),
    proposedPatch: redactPublicValue(submitted?.proposedPatch ?? result.proposedPatch ?? null),
    workspaceDisposition: redactPublicValue(result.workspaceDisposition || null),
    verification: redactPublicValue(submitted?.verification || result.verification || { status: "unchecked", evidence: [] }),
    roadmapPlan: redactPublicValue(submitted?.roadmapPlan || result.roadmapPlan || undefined),
    termination: result.termination ? { code: safeCode(result.termination.code, "unknown"), stopReason: safeCode(result.termination.stopReason), messageCode: safeCode(result.termination.messageCode) } : null,
    diagnostics: publicDiagnostics(result.diagnostics || {}),
    receiptId: result.receiptId || null,
  };
}
function publicResultSummary(result = {}) {
  const projected = publicResult(result);
  if (!projected) return null;
  return { schemaVersion: projected.schemaVersion, contractVersion: projected.contractVersion, subagentId: projected.subagentId, roleId: projected.roleId, status: projected.status, summary: projected.summary, verification: { status: projected.verification?.status || "unchecked", evidenceCount: Array.isArray(projected.verification?.evidence) ? projected.verification.evidence.length : 0 }, findingCount: projected.findings.length, evidenceCount: projected.evidence.length, artifactCount: projected.artifacts.length, proposedPatch: projected.proposedPatch ? { patchHash: projected.proposedPatch.patchHash || null, patchBytes: finite(projected.proposedPatch.patchBytes), changedPathCount: Array.isArray(projected.proposedPatch.changedPaths) ? projected.proposedPatch.changedPaths.length : 0 } : null, workspaceDisposition: projected.workspaceDisposition ? { status: projected.workspaceDisposition.status || null, changedPathCount: Array.isArray(projected.workspaceDisposition.changedPaths) ? projected.workspaceDisposition.changedPaths.length : 0 } : null, termination: projected.termination, diagnostics: projected.diagnostics, receiptId: projected.receiptId };
}
function publicRecord(record = {}, result = null) {
  if (!record || typeof record !== "object") return null;
  let revision = record.roleRevision || null;
  if (!revision && record.roleContract) {
    // Saved history may predate today's contract requirements. Projection is
    // not launch authorization: keep it readable without inventing a revision
    // or weakening the strict validation used by preflight and new launches.
    try { revision = roleRevision(record.roleContract); } catch { /* Unvalidated historical revision remains unknown. */ }
  }
  return {
    schemaVersion: Number(record.schemaVersion || 3),
    apiVersion: SUBAGENT_PUBLIC_API_VERSION,
    id: record.id,
    parentSessionId: record.parentSessionId || null,
    parentSubagentId: record.parentSubagentId || null,
    previousAttemptId: record.previousAttemptId || null,
    rootAttemptId: record.rootAttemptId || record.id,
    attempt: Number(record.attempt || 1),
    childKey: record.childKey || null,
    topologyRunId: record.metadata?.topologyRunId || null,
    topologyId: record.metadata?.topologyId || null,
    nodeId: record.metadata?.nodeId || null,
    branchId: record.branchId || null,
    trajectoryId: record.trajectoryId || record.branchId || null,
    role: record.role || null,
    typedRole: Boolean(record.roleContract || record.roleContractVersion),
    roleRevision: revision,
    taskHash: record.taskHash || (record.task ? `sha256:${sha256(record.task)}` : null),
    status: record.status || "unknown",
    controlState: record.controlState || null,
    resumable: record.resumable === true,
    workspacePolicy: record.workspacePolicy || null,
    mutationPolicy: record.mutationPolicy || null,
    memoryPolicy: record.memoryPolicy || null,
    contextProjection: canonical(record.contextProjection || record.roleContract?.maxContextPolicy || null),
    toolPolicy: canonical(record.toolPolicy || null),
    modelPolicy: canonical(record.modelPolicy || null),
    budget: canonical(record.budget || {}),
    mergePolicy: record.mergePolicy || "none",
    workspace: publicWorkspace(record.workspace || {}, result?.diagnostics || {}),
    createdAt: record.createdAt || null,
    admittedAt: record.admittedAt || null,
    queuedAt: record.queuedAt || null,
    startedAt: record.startedAt || null,
    processClosedAt: record.processClosedAt || null,
    finishedAt: record.finishedAt || null,
    updatedAt: record.updatedAt || null,
    launchDigest: record.launchDigest || null,
    receiptId: record.receiptId || result?.receiptId || null,
    termination: record.termination ? { code: safeCode(record.termination.code, "unknown"), stopReason: safeCode(record.termination.stopReason), messageCode: safeCode(record.termination.messageCode) } : null,
    diagnostics: publicDiagnostics(record.diagnostics || result?.diagnostics || {}),
    result: publicResultSummary(result),
  };
}
function publicEvent(event = {}) {
  const type = PUBLIC_EVENT_TYPES.has(event.type) ? event.type : "subagent.event";
  return {
    schemaVersion: 1,
    apiVersion: SUBAGENT_PUBLIC_API_VERSION,
    id: safeId(event.id),
    at: event.at || null,
    sequence: Number(event.sequence || 0),
    type,
    subagentId: safeId(event.subagentId),
    parentSessionId: safeId(event.parentSessionId),
    branchId: safeId(event.branchId),
    topologyRunId: safeId(event.topologyRunId),
    topologyId: safeId(event.topologyId),
    nodeId: safeId(event.nodeId),
    status: safeCode(event.status),
    control: safeCode(event.control),
    acknowledgement: safeCode(event.acknowledgement),
    reasonCode: safeCode(event.reasonCode || event.errorCode),
    termination: event.termination ? { code: safeCode(event.termination.code), stopReason: safeCode(event.termination.stopReason) } : null,
    counts: canonical(event.counts || undefined),
    durationMs: event.durationMs == null ? null : finite(event.durationMs),
    receiptId: safeId(event.receiptId),
    launchDigest: /^sha256:[a-f0-9]{64}$/.test(String(event.launchDigest || "")) ? event.launchDigest : null,
    previousAttemptId: safeId(event.previousAttemptId),
  };
}
function ceilingAllows(args, effective, reasons) {
  const ceiling = args.capabilityCeiling || {};
  if (Array.isArray(ceiling.allowedRoles) && !ceiling.allowedRoles.includes(effective.roleId)) reasons.push("role-ceiling-denied");
  if (Array.isArray(ceiling.workspacePolicies) && !ceiling.workspacePolicies.includes(effective.workspacePolicy)) reasons.push("workspace-ceiling-denied");
  if (ceiling.allowMutation === false && effective.mutationPolicy !== "forbidden") reasons.push("mutation-ceiling-denied");
  if (Array.isArray(ceiling.allowedTools)) {
    const allowed = new Set(ceiling.allowedTools);
    if (effective.tools.some((tool) => !allowed.has(tool))) reasons.push("tool-ceiling-denied");
  }
  if (Array.isArray(ceiling.allowedModels) && effective.model && !ceiling.allowedModels.includes(effective.model)) reasons.push("model-ceiling-denied");
  if (ceiling.maxBudget) for (const [name, value] of Object.entries(effective.budget || {})) if (ceiling.maxBudget[name] != null && Number(value) > Number(ceiling.maxBudget[name])) reasons.push(`budget-ceiling-${safeCode(name)}`);
}
function resolveSubagentPreflight(args = {}, options = {}) {
  const reasons = [];
  const degraded = [];
  let contract = null;
  try { contract = args.roleContract ? validateRoleContract(args.roleContract) : null; } catch { reasons.push("role-contract-invalid"); }
  const roleId = contract?.roleId || safeCode(args.role, "worker");
  const workspacePolicy = args.workspacePolicy || contract?.workspacePolicy || "shared-readonly";
  const mutationPolicy = args.mutationPolicy || contract?.mutationPolicy || "forbidden";
  if (workspacePolicy === "handler-only") reasons.push("handler-only-role");
  if (!new Set(["shared-readonly", "isolated-worktree"]).has(workspacePolicy)) reasons.push("workspace-policy-invalid");
  if (!new Set(["forbidden", "proposed-patch", "isolated-only"]).has(mutationPolicy)) reasons.push("mutation-policy-invalid");
  if (workspacePolicy !== "isolated-worktree" && mutationPolicy !== "forbidden") reasons.push("mutation-requires-isolation");
  if (args.parentSubagentId || Number(args.depth || 1) > 1) reasons.push("nested-delegation-denied");
  const activeCount = finite(options.activeCount);
  const maxConcurrent = finite(options.maxConcurrentPerParent, 8);
  if (activeCount >= maxConcurrent) reasons.push("parent-concurrency-saturated");
  const budget = contract?.budget === null ? null : normalizeBudget(args.budget || contract?.budget || {}, options.defaultBudget || {});
  let tools = [];
  let missingTools = [];
  if (contract) {
    const resolved = resolveRequiredTools(contract, options.actualTools || ACTUAL_CHILD_TOOLS);
    tools = resolved.available;
    missingTools = resolved.missing;
    if (missingTools.length) reasons.push("required-tools-unavailable");
  } else tools = Array.isArray(args.toolPolicy?.allowedTools) ? args.toolPolicy.allowedTools.filter((tool) => (options.actualTools || ACTUAL_CHILD_TOOLS).includes(tool)) : [];
  let profile = { selectedModel: null, fallbackModel: null, selectedThinkingLevel: null, modelPolicySource: null, thinkingPolicySource: null };
  if (contract || args.modelPolicy) {
    try {
      profile = selectRoleInferenceProfile(args.modelPolicy || contract?.modelPolicy, { inheritedModel: options.inheritedModel || null, inheritedThinkingLevel: options.inheritedThinkingLevel || null, env: options.env || process.env, roleId });
    } catch (error) { (options.allowUnresolvedInference ? degraded : reasons).push(safeCode(error?.code || "inference-profile-unresolved")); }
  }
  const effective = {
    roleId,
    roleRevision: roleRevision(contract),
    workspacePolicy,
    mutationPolicy,
    tools: [...new Set(tools)].sort(),
    missingTools: [...new Set(missingTools)].sort(),
    model: profile.selectedModel || null,
    fallbackModel: profile.fallbackModel || null,
    thinkingLevel: profile.selectedThinkingLevel || null,
    modelPolicySource: profile.modelPolicySource || null,
    thinkingPolicySource: profile.thinkingPolicySource || null,
    contextProjection: canonical(args.contextProjection || contract?.maxContextPolicy || { kind: "summarized", maxTokens: 8000 }),
    memoryPolicy: args.memoryPolicy || contract?.memoryPolicy || "none",
    budget: canonical(budget),
  };
  ceilingAllows(args, effective, reasons);
  const normalizedReasons = [...new Set(reasons.map((reason) => safeCode(reason, "blocked")))].sort();
  const normalizedDegraded = [...new Set(degraded.map((reason) => safeCode(reason, "degraded")))].sort();
  const digestInput = { apiVersion: SUBAGENT_PUBLIC_API_VERSION, parentSessionId: safeId(args.parentSessionId), taskHash: args.taskHash || (args.task ? `sha256:${sha256(args.task)}` : null), mergePolicy: args.mergePolicy || "none", effective };
  const launchDigest = `sha256:${sha256(digestInput)}`;
  return {
    schemaVersion: 1,
    apiVersion: SUBAGENT_PUBLIC_API_VERSION,
    decision: normalizedReasons.length ? "blocked" : normalizedDegraded.length ? "degraded" : "allowed",
    allowed: normalizedReasons.length === 0,
    reasons: normalizedReasons,
    degradations: normalizedDegraded,
    effective,
    taskHash: digestInput.taskHash,
    launchDigest,
    sideEffects: { processes: 0, sessions: 0, records: 0, workspaces: 0, locks: 0, telemetryRows: 0, cacheWrites: 0 },
  };
}
function createSubagentReceipt(record = {}, result = {}) {
  const publicRecordValue = publicRecord(record, result);
  const core = {
    schemaVersion: 1,
    apiVersion: SUBAGENT_PUBLIC_API_VERSION,
    subagentId: publicRecordValue.id,
    rootAttemptId: publicRecordValue.rootAttemptId,
    previousAttemptId: publicRecordValue.previousAttemptId,
    attempt: publicRecordValue.attempt,
    role: publicRecordValue.role,
    roleRevision: publicRecordValue.roleRevision,
    launchDigest: publicRecordValue.launchDigest,
    status: publicRecordValue.status,
    termination: publicRecordValue.termination,
    processClosedAt: publicRecordValue.processClosedAt,
    finishedAt: publicRecordValue.finishedAt,
    accounting: publicRecordValue.diagnostics,
  };
  return { ...core, receiptId: `receipt_${sha256(core).slice(0, 20)}` };
}

module.exports = {
  SUBAGENT_PUBLIC_API_VERSION,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  PUBLIC_EVENT_TYPES,
  canonical,
  stableStringify,
  sha256,
  roleRevision,
  publicDiagnostics,
  publicResult,
  publicResultSummary,
  publicRecord,
  publicEvent,
  resolveSubagentPreflight,
  createSubagentReceipt,
};
