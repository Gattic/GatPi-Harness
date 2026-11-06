"use strict";

/**
 * Multi-agent topology layer built on Pi's branch-backed subagents and local
 * integration boundary.  This module is intentionally runtime-agnostic: tests
 * and extensions can inject deterministic handlers, while live Pi can route
 * nodes through SubagentService so Hermes/tool governance stays on the Pi path.
 */

const crypto = require("node:crypto");
const { evaluatePolicy } = require("./runtime-policy");
const fs = require("node:fs");
const path = require("node:path");
const { SubagentService, SubagentRunner } = require("./subagents");
const {
  DEFAULT_ROLE_CONTRACTS,
  validateRoleContract,
  createCustomReadOnlyContract,
  narrowRoleContract,
  roleRevisionHash,
  roleDescriptor,
} = require("./role-contracts");
const { ROLE_OUTPUT_SCHEMAS, validateJsonSchema, normalizePublicSubmission, completionPolicyErrors } = require("./role-result-schemas");
const { resolveRoleRuntimeConfig, assertRoleRuntimeExecutionAllowed } = require("./role-runtime-rollout");
const {
  TOPOLOGY_SCHEMA_VERSION,
  ROLE_RUNTIME_VERSION,
  CONTRACT_VERSION,
  RESULT_SCHEMA_VERSION,
  listBuiltInRoleTopologies,
  getBuiltInRoleTopology,
  materializeRoleAwareTopology,
  validateRoleAwareTopology,
  roadmapPlannerPrecedesImplementation,
  isTopologyImplementationCapable,
  normalizeJoinPolicy,
  JOIN_POLICY_MODES,
  PARTIAL_POLICIES,
  nodeRequiresAllJoin,
} = require("./role-topologies");
const { applyRoadmapPlan, reconcileRoadmapPlan } = require("./roadmap-plan-application");

const AGENT_EXECUTION_MODES = Object.freeze(["handler", "subagent"]);
const TOPOLOGY_EXECUTION_MODES = Object.freeze(["sequential", "parallel", "dag"]);
const CONTEXT_POLICIES = Object.freeze(["full", "summarized", "evidence-only", "task-only", "dependency-neighborhood", "memory-backed", "isolated-scratch"]);
const NODE_OUTCOME_STATUSES = Object.freeze(["pending", "running", "succeeded", "failed", "cancelled", "timed-out", "skipped", "blocked"]);
const MEMORY_POLICIES = Object.freeze(["none", "read-only", "write-only", "read-write", "ephemeral", "shared-topology", "private-agent"]);
const FAILURE_POLICIES = Object.freeze(["fail-fast", "continue-on-error"]);
const AGGREGATION_POLICIES = Object.freeze(["all", "terminal", "last", "concat", "vote"]);
const SUCCESSFUL_AGENT_STATUSES = new Set(["succeeded"]);
const SAFE_HANDLER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function normalizeHandlerRegistry(input = {}) {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input || {});
  const registry = new Map();
  for (const [handlerId, handler] of entries) {
    if (!SAFE_HANDLER_ID.test(String(handlerId || ""))) throw new Error(`invalid topology handlerId: ${handlerId}`);
    if (typeof handler !== "function") throw new Error(`topology handler ${handlerId} must be a function`);
    registry.set(String(handlerId), handler);
  }
  return registry;
}

function nowIso() { return new Date().toISOString(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function compactToolContent(output, max = 1200) {
  if (typeof output === "string") return output.length > max ? `${output.slice(0, max)}…` : output;
  if (output && typeof output === "object") {
    const summary = output.summary || output.message || output.status || output.ok;
    const keys = Object.keys(output).slice(0, 12).join(", ");
    const text = summary ? `summary=${String(summary)} keys=${keys}` : JSON.stringify(output);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return String(output ?? "");
}
function shortHash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 12); }
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function ensureOneOf(kind, value, allowed) { if (!allowed.includes(value)) throw new Error(`invalid ${kind}: ${value}`); return value; }
function safeError(error) {
  const termination = error?.termination || error?.result?.termination || error?.result?.payload?.termination || null;
  return { message: error?.message || String(error), name: error?.name || "Error", code: error?.code, ...(termination ? { termination: clone(termination) } : {}) };
}
function deduplicateErrors(errors = []) {
  const unique = [];
  for (const error of errors) {
    const identity = [error?.code || null, error?.name || "Error", error?.message || String(error)];
    const index = unique.findIndex((existing) => {
      const sameCause = JSON.stringify([existing?.code || null, existing?.name || "Error", existing?.message || String(existing)]) === JSON.stringify(identity);
      return sameCause && (!existing?.nodeId || !error?.nodeId || existing.nodeId === error.nodeId);
    });
    if (index < 0) unique.push(error);
    else if (!unique[index]?.nodeId && error?.nodeId) unique[index] = error;
  }
  return unique;
}
function normalizeRoleId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function renderTask(task, input) { return typeof task === "function" ? task(input) : String(task || input?.task || "").replace(/\{\{\s*task\s*\}\}/g, String(input?.task || "")); }
function roadmapPlanFromResult(result = {}) {
  const candidates = [result.roadmapPlan, result.payload?.roadmapPlan, result.payload?.payload?.roadmapPlan, result.payload?.result?.roadmapPlan, result.payload?.submitted_result?.roadmapPlan, result.payload?.submittedResult?.roadmapPlan];
  return candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) || null;
}
function resultField(result = {}, field) {
  const candidates = [result?.[field], result?.payload?.[field], result?.payload?.payload?.[field], result?.payload?.result?.[field], result?.payload?.submitted_result?.[field], result?.payload?.submittedResult?.[field]];
  return candidates.find((candidate) => candidate !== undefined);
}
function topologyRoadmapHandoffs(run = {}) {
  const reconciliations = new Map(asArray(run.roadmapReconciliations).filter((entry) => entry?.plannerNodeId).map((entry) => [String(entry.plannerNodeId), entry]));
  return asArray(run.roadmapApplications)
    .filter((application) => application?.applied === true && application?.roadmapId)
    .slice(0, 8)
    .map((application) => {
      const plannerNodeId = String(application.plannerNodeId || "");
      const reconciliation = reconciliations.get(plannerNodeId) || {};
      const outcome = reconciliation.outcome || "unreconciled";
      return {
        runId: run.runId || null,
        topologyId: run.topologyId || null,
        plannerNodeId: plannerNodeId || null,
        roadmapId: application.roadmapId,
        parentRoadmapId: application.parentRoadmapId || null,
        parentItemId: application.parentItemId || null,
        planFingerprint: application.planFingerprint || null,
        roadmapFingerprint: application.roadmapFingerprint || null,
        topologyStatus: reconciliation.topologyStatus || run.status || null,
        reconciliationStatus: reconciliation.reconciliationStatus || "missing",
        outcome,
        itemCount: Number(reconciliation.itemCount ?? application.itemCount ?? 0),
        requiresParentFollowThrough: !["completed", "already-completed"].includes(outcome),
      };
    });
}
function evidenceProjection(result = {}) {
  const projected = {
    nodeId: result.nodeId || null,
    role: result.role || result.payload?.roleId || null,
    status: result.status || "failed",
    error: result.error ? safeError(result.error) : null,
  };
  for (const field of ["analysisPlan", "claims", "evidenceRefs", "auditDecisions", "disagreements", "rejectedClaims", "unresolvedGaps", "recommendedActions", "coverage", "verification", "workspaceDisposition"]) {
    const value = resultField(result, field);
    if (value !== undefined) projected[field] = clone(value);
  }
  return projected;
}
function subagentTaskFromContext(node, context = {}) {
  const base = context.task || renderTask(node.task, context.input || {});
  const deps = asArray(context.dependencyResults).map((r) => ({
    nodeId: r.nodeId,
    role: r.role,
    status: r.status,
    ...(r.summary || r.content ? { summary: r.summary || r.content } : {}),
    ...(r.artifacts ? { artifacts: r.artifacts } : {}),
    ...(resultField(r, "workspaceDisposition") ? { workspaceDisposition: resultField(r, "workspaceDisposition") } : {}),
    ...(roadmapPlanFromResult(r) ? { roadmapPlan: roadmapPlanFromResult(r) } : {}),
    ...(resultField(r, "analysisPlan") ? { analysisPlan: resultField(r, "analysisPlan") } : {}),
    ...(resultField(r, "claims") ? { claims: resultField(r, "claims") } : {}),
    ...(resultField(r, "evidenceRefs") ? { evidenceRefs: resultField(r, "evidenceRefs") } : {}),
    ...(resultField(r, "auditDecisions") ? { auditDecisions: resultField(r, "auditDecisions") } : {}),
    ...(resultField(r, "coverage") ? { coverage: resultField(r, "coverage") } : {}),
    ...(resultField(r, "filterResult") ? { filterResult: resultField(r, "filterResult") } : {}),
    ...(resultField(r, "sourceReading") ? { sourceReading: resultField(r, "sourceReading") } : {}),
    ...(resultField(r, "workflow") ? { workflow: resultField(r, "workflow") } : {}),
    ...(resultField(r, "objectiveScore") ? { objectiveScore: resultField(r, "objectiveScore") } : {}),
    ...(resultField(r, "candidatePackage") ? { candidatePackage: resultField(r, "candidatePackage") } : {}),
    ...(resultField(r, "reviewDecision") ? { reviewDecision: resultField(r, "reviewDecision") } : {}),
    ...(resultField(r, "auditDecision") ? { auditDecision: resultField(r, "auditDecision") } : {}),
    ...(r.error ? { error: safeError(r.error) } : {}),
  })).filter((r) => r.nodeId || r.summary || r.status);
  if (!deps.length) return base;
  return [base, "Upstream topology context:", JSON.stringify(deps, null, 2)].join("\n\n");
}
function roleOverrideFromNode(node, registeredRole) {
  return {
    ...(node.workspacePolicy ? { workspacePolicy: node.workspacePolicy } : {}),
    ...(node.mutationPolicy ? { mutationPolicy: node.mutationPolicy } : {}),
    ...((node.allowedTools || node.deniedTools || node.toolPolicy) ? { toolPolicy: node.toolPolicy || { allowedTools: node.allowedTools || registeredRole.toolPolicy.allowedTools, deniedTools: node.deniedTools || [] } } : {}),
    ...(node.timeoutMs || node.budget ? { budget: { ...(node.budget || {}), ...(node.timeoutMs ? { wallClockMs: node.timeoutMs } : {}) } } : {}),
    ...(node.modelPolicy ? { modelPolicy: node.modelPolicy } : {}),
    ...(node.outputSchema ? { outputSchema: node.outputSchema } : {}),
    ...(node.systemPrompt ? { systemPrompt: node.systemPrompt } : {}),

  };
}
function validateSimpleSchema(schema, value, contract = null) {
  if (!schema) return { status: "unchecked" };
  const target = value?.payload?.submitted_result && typeof value.payload.submitted_result === "object" ? normalizePublicSubmission(value.payload.submitted_result) : value?.payload && typeof value.payload === "object" ? value.payload : value;
  const errors = [...validateJsonSchema(schema, target), ...(schema?.properties?.summary ? completionPolicyErrors(target, contract || {}) : [])];
  return errors.length ? { status: "invalid", errors, reason: errors.join("; ") } : { status: "valid" };
}

class AgentMessage {
  constructor(input = {}) {
    const at = input.timestamp || nowIso();
    this.messageId = input.messageId || `msg_${shortHash({ at, sender: input.sender, receiver: input.receiver, content: input.content, random: crypto.randomBytes(4).toString("hex") })}`;
    this.sender = input.sender || null;
    this.receiver = input.receiver || null;
    this.role = input.role || null;
    this.content = String(input.content || "");
    this.payload = input.payload == null ? null : clone(input.payload);
    this.attachments = clone(input.attachments || []);
    this.contextRefs = clone(input.contextRefs || []);
    this.provenance = clone(input.provenance || {});
    this.timestamp = at;
    this.confidence = input.confidence == null ? null : Number(input.confidence);
    this.validation = input.validation || { status: "unchecked" };
    this.error = input.error ? safeError(input.error) : null;
  }
}

class AgentResult extends AgentMessage {
  constructor(input = {}) {
    super({ ...input, sender: input.sender || input.agentId, receiver: input.receiver || "topology" });
    this.agentId = input.agentId || this.sender;
    this.nodeId = input.nodeId || null;
    this.status = input.status || (this.error ? "failed" : "succeeded");
    this.summary = input.summary || this.content.slice(0, 500);
    this.artifacts = clone(input.artifacts || []);
    this.diagnostics = clone(input.diagnostics || {});
    this.termination = clone(input.termination || input.payload?.termination || null);
    this.attempts = input.attempts || 1;
  }
}

class AgentExecutionStatusError extends Error {
  constructor(result) {
    super(`agent ${result?.nodeId || result?.agentId || "unknown"} returned non-success status: ${result?.status || "unknown"}`);
    this.name = "AgentExecutionStatusError";
    this.code = "AGENT_NON_SUCCESS";
    this.result = result;
  }
}

class AgentVerificationGateError extends Error {
  constructor(result, verificationStatus) {
    super(`verifier ${result?.nodeId || result?.agentId || "unknown"} did not pass verification: ${verificationStatus || "unchecked"}`);
    this.name = "AgentVerificationGateError";
    this.code = "AGENT_VERIFICATION_GATE_FAILED";
    this.verificationStatus = verificationStatus || "unchecked";
    this.result = { ...clone(result), status: "failed", error: { name: this.name, code: this.code, message: this.message }, verificationGate: { required: "passed", actual: this.verificationStatus } };
  }
}

class AgentRoleRegistry {
  constructor({ roles = [] } = {}) { this.roles = new Map(); this.refinementHistory = new Map(); registerDefaultAgentRoles(this); for (const role of roles) this.register(role); }
  register(role = {}) {
    if (!role.roleId) throw new Error("agent role requires roleId");
    if (Object.prototype.hasOwnProperty.call(role, "outputSchema") && role.outputSchema == null) throw new Error(`role ${role.roleId} requires an output schema`);
    const explicitOutputSchema = !!role.outputSchema && Number(role.schemaVersion) !== 2;
    let contract;
    if (Number(role.schemaVersion) === 2 || role.contractVersion === "role-v2") contract = validateRoleContract(role);
    else {
      const requestedTools = Array.isArray(role.allowedTools) ? role.allowedTools : [];
      const mutating = requestedTools.some((tool) => ["edit", "write", "bash"].includes(tool));
      const handlerOnly = typeof role.handler === "function";
      const base = handlerOnly
        ? DEFAULT_ROLE_CONTRACTS.find((candidate) => candidate.roleId === "tool-specialist")
        : createCustomReadOnlyContract({ roleId: role.roleId, systemPrompt: role.systemPrompt || role.description || `Complete the bounded ${role.roleId} role task.` });
      const allowedTools = handlerOnly ? requestedTools : Array.from(new Set([...(requestedTools.length ? requestedTools : base.toolPolicy.allowedTools.filter((tool) => tool !== "submit_role_result")), "submit_role_result"]));
      contract = validateRoleContract({
        ...base,
        roleId: normalizeRoleId(role.roleId),
        displayName: role.displayName || role.roleId,
        description: role.description || base.description,
        intent: role.intent || normalizeRoleId(role.roleId),
        systemPrompt: role.systemPrompt && role.systemPrompt.length >= 80 ? role.systemPrompt : `${base.systemPrompt}\n\nRole-specific objective: ${role.systemPrompt || role.description || role.roleId}.`,
        workspacePolicy: role.workspacePolicy || (handlerOnly ? "handler-only" : mutating ? "isolated-worktree" : "shared-readonly"),
        mutationPolicy: role.mutationPolicy || (mutating ? "proposed-patch" : "forbidden"),
        toolPolicy: { allowedTools, deniedTools: [...(role.deniedTools || [])] },
        modelPolicy: role.modelPolicy || { ...base.modelPolicy, ...(role.modelPreference ? { mode: "preferred", preference: role.modelPreference } : {}) },
        budget: { ...base.budget, ...(role.budget || {}), ...(role.timeoutMs ? { wallClockMs: role.timeoutMs } : {}) },
        outputSchema: role.outputSchema || ROLE_OUTPUT_SCHEMAS.generic,
        completionPolicy: role.completionPolicy || base.completionPolicy,
        autoRoutePolicy: role.autoRoutePolicy || "never",
        memoryPolicy: role.memoryPolicy || base.memoryPolicy,
        maxContextPolicy: role.maxContextPolicy || base.maxContextPolicy,
        retryPolicy: role.retryPolicy || base.retryPolicy,
        settings: { ...base.settings, ...(role.settings || {}), legacyOutputSchemaExplicit: explicitOutputSchema },
        handler: role.handler || null,
        validate: role.validate || null,
        postProcess: role.postProcess || null,
      });
    }
    ensureOneOf("memory policy", contract.memoryPolicy, MEMORY_POLICIES);
    if (this.roles.has(contract.roleId) && role.roleId !== contract.roleId) throw new Error(`ambiguous normalized agent role: ${role.roleId}`);
    this.roles.set(contract.roleId, contract);
    return contract;
  }
  get(roleId) { const role = this.roles.get(roleId); if (!role) throw new Error(`agent role not registered: ${roleId}`); return role; }
  resolve(roleId) {
    const exact = this.roles.get(roleId);
    if (exact) return exact;
    const normalized = normalizeRoleId(roleId);
    const matches = Array.from(this.roles.values()).filter((role) => normalizeRoleId(role.roleId) === normalized || normalizeRoleId(role.displayName) === normalized || (role.settings?.aliases || []).some((alias) => normalizeRoleId(alias) === normalized));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`ambiguous agent role: ${roleId}`);
    throw new Error(`agent role not registered: ${roleId}`);
  }
  customReadOnly(input) { return createCustomReadOnlyContract(input); }
  refine(roleId, override = {}, options = {}) {
    if (options.reviewed !== true || String(options.reason || "").trim().length < 8) { const error = new Error("role refinement requires explicit reviewed approval and a bounded reason"); error.code = "ROLE_REFINEMENT_REVIEW_REQUIRED"; throw error; }
    if (override.outputSchema || override.policyElevation) throw Object.assign(new Error("role refinements cannot replace output schemas or elevate policy"), { code: "ROLE_POLICY_BROADENING" });
    const base = this.resolve(roleId); const beforeRevision = roleRevisionHash(base); const refined = narrowRoleContract(base, override); const afterRevision = roleRevisionHash(refined);
    if (beforeRevision === afterRevision) return { changed: false, role: refined, beforeRevision, afterRevision };
    const rows = this.refinementHistory.get(base.roleId) || [];
    const changedFields = Object.keys(override).map((key) => key === "systemPrompt" ? "taskScope" : key).sort();
    rows.push({ schemaVersion: 1, at: new Date().toISOString(), reasonCode: "reviewed-refinement", reasonHash: `sha256:${crypto.createHash("sha256").update(String(options.reason)).digest("hex")}`, beforeRevision, afterRevision, changedFields, prior: base });
    this.refinementHistory.set(base.roleId, rows.slice(-20)); this.roles.set(base.roleId, refined);
    return { changed: true, role: refined, beforeRevision, afterRevision };
  }
  rollbackRefinement(roleId, revision, options = {}) {
    if (options.reviewed !== true) { const error = new Error("role refinement rollback requires explicit reviewed approval"); error.code = "ROLE_REFINEMENT_REVIEW_REQUIRED"; throw error; }
    const id = this.resolve(roleId).roleId; const rows = this.refinementHistory.get(id) || []; const index = rows.findLastIndex((row) => row.beforeRevision === revision);
    if (index < 0) throw new Error(`role refinement revision not found: ${revision}`);
    const target = rows[index].prior; this.roles.set(id, target); this.refinementHistory.set(id, rows.slice(0, index)); return { role: target, revision: roleRevisionHash(target), rolledBack: true };
  }
  history(roleId) { const id = this.resolve(roleId).roleId; return (this.refinementHistory.get(id) || []).map(({ prior: _prior, ...row }) => row); }
  descriptors() { return Array.from(this.roles.values()).map(roleDescriptor); }
  list() { return Array.from(this.roles.values()).map((r) => ({ ...r, validate: undefined, postProcess: undefined, handler: undefined })); }
}

function memoryCuratorHandler(context, { node } = {}) {
  const dependencies = asArray(context?.dependencyResults).map((result) => ({ nodeId: result.nodeId, role: result.role, status: result.status, summary: String(result.summary || result.content || "").slice(0, 1200) }));
  if (!dependencies.length) throw new Error("memory curator requires verified upstream results");
  if (dependencies.some((result) => !SUCCESSFUL_AGENT_STATUSES.has(result.status))) throw new Error("memory curator refuses non-success upstream results");
  const title = `Topology result: ${context?.topology?.topologyId || node?.id || "run"}`;
  const content = dependencies.map((result) => `${result.nodeId || result.role || "agent"}: ${result.summary}`).join("\n").slice(0, 4000);
  const stored = context.memory.write({ type: "procedural", title, content, verification: "verified", confidence: 0.85, tags: ["topology", "verified-result"] });
  return { content: `Curated verified topology summary: ${title}`, summary: title, payload: { schemaVersion: 2, contractVersion: "role-v2", summary: title, evidence: dependencies.map((result) => ({ nodeId: result.nodeId, status: result.status, summary: result.summary })), accepted: stored?.accepted !== false, title, dependencyCount: dependencies.length } };
}

function coordinatorHandler(context, { node } = {}) {
  const dependencies = asArray(context?.dependencyResults);
  if (node?.reducer === "evidence-synthesis") {
    const auditDecisions = dependencies.flatMap((result) => asArray(resultField(result, "auditDecisions")));
    const acceptedIds = new Set(auditDecisions.filter((decision) => decision?.decision === "accepted").map((decision) => decision.claimId));
    const claims = dependencies.flatMap((result) => asArray(resultField(result, "claims"))).filter((claim) => acceptedIds.has(claim?.id) || claim?.status === "accepted");
    const evidenceRefs = dependencies.flatMap((result) => asArray(resultField(result, "evidenceRefs")));
    const rejectedClaims = dependencies.flatMap((result) => asArray(resultField(result, "rejectedClaims"))).concat(auditDecisions.filter((decision) => decision?.decision === "rejected"));
    const disagreements = dependencies.flatMap((result) => asArray(resultField(result, "disagreements")));
    const unresolvedGaps = dependencies.flatMap((result) => asArray(resultField(result, "unresolvedGaps")));
    const recommendedActions = dependencies.flatMap((result) => asArray(resultField(result, "recommendedActions")));
    const coverage = dependencies.map((result) => resultField(result, "coverage")).find(Boolean) || { expectedCategories: [], observedCategories: [], missingCategories: [], ratio: 0 };
    const summary = `Synthesized ${claims.length} accepted claim(s); ${rejectedClaims.length} rejected and ${unresolvedGaps.length} unresolved.`;
    const payload = {
      schemaVersion: 2,
      contractVersion: "role-v2",
      summary,
      findings: claims.map((claim) => ({ claimId: claim.id, statement: claim.statement, evidenceRefs: claim.evidenceRefs || [] })),
      evidence: [],
      claims,
      evidenceRefs,
      auditDecisions,
      disagreements,
      rejectedClaims,
      unresolvedGaps,
      recommendedActions,
      coverage,
      verification: { status: "unchecked", evidence: [] },
    };
    return { content: summary, summary, payload };
  }
  return { content: `Aggregated ${dependencies.length} typed upstream result(s).`, summary: `Aggregated ${dependencies.length} result(s)`, payload: { schemaVersion: 2, contractVersion: "role-v2", summary: `Aggregated ${dependencies.length} result(s)`, findings: dependencies.map((result) => ({ nodeId: result.nodeId, status: result.status, summary: result.summary })) } };
}

function registerDefaultAgentRoles(registry) {
  for (const contract of DEFAULT_ROLE_CONTRACTS) registry.register({
    ...contract,
    handler: contract.roleId === "memory-curator" ? memoryCuratorHandler : contract.roleId === "coordinator" ? coordinatorHandler : contract.handler,
  });
}

class TopologyRegistry {
  constructor({ topologies = [] } = {}) { this.topologies = new Map(); for (const t of topologies) this.register(t); }
  register(topology = {}) {
    if (!topology.topologyId) throw new Error("topology requires topologyId");
    if (!Array.isArray(topology.nodes) || topology.nodes.length === 0) throw new Error("topology requires nodes");
    const edges = clone(topology.edges || []);
    const incomingCounts = new Map(topology.nodes.map((node) => [node.id, 0]));
    for (const edge of edges) incomingCounts.set(edge.target, (incomingCounts.get(edge.target) || 0) + 1);
    const sourceSchemaVersion = Number(topology.schemaVersion || TOPOLOGY_SCHEMA_VERSION);
    const metadata = clone(topology.metadata || {});
    if (sourceSchemaVersion === 2) metadata.compatibility = { sourceSchemaVersion: 2, normalizedToSchemaVersion: TOPOLOGY_SCHEMA_VERSION, defaultJoinPolicy: "all", ...(metadata.compatibility || {}) };
    const normalized = {
      schemaVersion: TOPOLOGY_SCHEMA_VERSION,
      roleRuntimeVersion: topology.roleRuntimeVersion || ROLE_RUNTIME_VERSION,
      contractVersion: topology.contractVersion || CONTRACT_VERSION,
      resultSchemaVersion: topology.resultSchemaVersion || RESULT_SCHEMA_VERSION,
      topologyId: topology.topologyId,
      name: topology.name || topology.topologyId,
      description: topology.description || "",
      nodes: topology.nodes.map((n) => ({ contextPolicy: topology.contextPolicy || "dependency-neighborhood", memoryPolicy: topology.memoryPolicy, ...n, joinPolicy: normalizeJoinPolicy(n.joinPolicy, incomingCounts.get(n.id) || 0) })),
      edges,
      entryNode: topology.entryNode || topology.nodes[0]?.id,
      terminalNodes: topology.terminalNodes || [],
      executionMode: topology.executionMode || "dag",
      concurrencyLimit: Math.max(1, Number(topology.concurrencyLimit || (topology.executionMode === "sequential" ? 1 : 4))),
      failurePolicy: topology.failurePolicy || "fail-fast",
      aggregationPolicy: topology.aggregationPolicy || "terminal",
      partialPolicy: topology.partialPolicy || "forbid",
      memoryPolicy: topology.memoryPolicy || "none",
      tracingPolicy: topology.tracingPolicy || { enabled: true },
      fallbackTopology: topology.fallbackTopology || null,
      metadata,
      tags: clone(topology.tags || []),
    };
    ensureOneOf("topology execution mode", normalized.executionMode, TOPOLOGY_EXECUTION_MODES);
    ensureOneOf("topology failure policy", normalized.failurePolicy, FAILURE_POLICIES);
    ensureOneOf("aggregation policy", normalized.aggregationPolicy, AGGREGATION_POLICIES);
    ensureOneOf("partial policy", normalized.partialPolicy, PARTIAL_POLICIES);
    for (const n of normalized.nodes) if (!n.id) throw new Error("topology node requires id");
    this.topologies.set(normalized.topologyId, normalized);
    return normalized;
  }
  get(id) { const t = this.topologies.get(id); if (!t) throw new Error(`topology not registered: ${id}`); return t; }
  list() { return Array.from(this.topologies.values()).map(clone); }
}

class ToolPermissionError extends Error { constructor(toolName, agentId) { super(`tool denied for ${agentId}: ${toolName}`); this.name = "ToolPermissionError"; this.code = "TOOL_DENIED"; } }

class ToolPermissionPolicy {
  constructor({ trace, cwd = process.cwd(), policy = {} } = {}) { this.trace = trace; this.cwd = cwd; this.policy = policy; }
  isAllowed(toolName, role) {
    const denied = new Set(role.toolPolicy?.deniedTools || role.deniedTools || []);
    if (denied.has(toolName) || denied.has("*")) return false;
    const allowed = role.toolPolicy?.allowedTools || role.allowedTools || [];
    return allowed.includes("*") || allowed.includes(toolName);
  }
  wrap(tools = {}, role, node, run) {
    const out = {};
    for (const [name, fn] of Object.entries(tools || {})) {
      out[name] = async (...args) => {
        if (!this.isAllowed(name, role, node)) {
          this.trace?.emit?.({ category: "tool_exposure", name: "topology.tool_denied", severity: "warn", agent_id: node.id, payload: { tool: name, roleId: role.roleId, topologyRunId: run.runId } });
          throw new ToolPermissionError(name, node.id);
        }
        const firstArg = args && args[0] && typeof args[0] === "object" ? args[0] : {};
        const policyDecision = evaluatePolicy({ tool: name, input: args, kind: firstArg.kind || "topology-tool", path: firstArg.path || firstArg.file || firstArg.filePath, command: firstArg.command || firstArg.cmd }, { cwd: run.cwd || this.cwd, policy: this.policy });
        if (!policyDecision.ok) {
          this.trace?.emit?.({ category: "tool_exposure", name: "topology.policy_denied", severity: "warn", agent_id: node.id, payload: { tool: name, roleId: role.roleId, topologyRunId: run.runId, reasons: policyDecision.reasons } });
          throw new Error(`topology policy denied ${name}: ${policyDecision.reasons.join("; ")}`);
        }
        this.trace?.emit?.({ category: "tool_exposure", name: "topology.tool_call", agent_id: node.id, payload: { tool: name, topologyRunId: run.runId, policySeverity: policyDecision.severity } });
        return fn(...args);
      };
    }
    return out;
  }
}

class TopologyMemoryPolicy {
  constructor({ memory, trace } = {}) { this.memory = memory; this.trace = trace; this.ephemeral = new Map(); }
  facade(policy, run, node) {
    const p = ensureOneOf("memory policy", policy || "none", MEMORY_POLICIES);
    const canRead = ["read-only", "read-write", "shared-topology", "private-agent"].includes(p);
    const canWrite = ["write-only", "read-write", "ephemeral", "shared-topology", "private-agent"].includes(p);
    const key = p === "private-agent" ? `${run.runId}:${node.id}` : run.runId;
    return {
      policy: p,
      read: (query, options = {}) => {
        if (!canRead || !this.memory?.retrieve) throw new Error(`memory read denied for ${node.id}`);
        const result = this.memory.retrieve(query, options);
        this.trace?.emit?.({ category: "memory_retrieval", name: "topology.memory_read", agent_id: node.id, payload: { policy: p, query: String(query).slice(0, 120), count: result.entries?.length || 0 } });
        return result;
      },
      write: (entry = {}) => {
        if (!canWrite) throw new Error(`memory write denied for ${node.id}`);
        const withProvenance = { ...entry, provenance: { ...(entry.provenance || {}), topologyRunId: run.runId, topologyId: run.topology.topologyId, agentId: node.id, source: entry.provenance?.source || "multi-agent-topology" } };
        if (p === "ephemeral") { const xs = this.ephemeral.get(key) || []; xs.push(withProvenance); this.ephemeral.set(key, xs); return { accepted: true, entry: withProvenance, ephemeral: true }; }
        if (!this.memory?.remember) throw new Error("memory adapter unavailable");
        const result = this.memory.remember(withProvenance);
        this.trace?.emit?.({ category: "memory_retrieval", name: "topology.memory_write", agent_id: node.id, payload: { policy: p, accepted: result.accepted, title: entry.title } });
        return result;
      },
    };
  }
}

function roleContractForTopologyNode(role, node, context) {
  if (context?.topology?.topologyId !== "governed-skill-intake" || !["bounded-read", "workflow-extract"].includes(node?.id)) return role;
  const sourceId = String(context?.input?.sourceId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId)) throw new Error("governed skill intake requires a safe sourceId before read access");
  const files = asArray(context?.dependencyResults).flatMap((result) => {
    const filtered = resultField(result, "filterResult");
    const reading = resultField(result, "sourceReading");
    return [...asArray(filtered?.files).map((file) => file?.relativePath), ...asArray(reading?.filesReviewed)];
  }).filter(Boolean).map((value) => String(value).replace(/\\/g, "/"));
  if (!files.length || files.some((value) => value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("governed skill intake has no valid manifest-confined read paths");
  const allowedPrivateReadPaths = [...new Set(files)].slice(0, 256).map((relativePath) => `.pi/skill-intake/sources/${sourceId}/${relativePath}`);
  return { ...role, settings: { ...(role.settings || {}), allowedPrivateReadPaths, restrictReadPaths: true } };
}

class SubagentTopologyExecutor {
  constructor({ service, cwd, trace } = {}) { this.service = service || new SubagentService({ cwd, trace, runner: new SubagentRunner() }); }
  async execute({ node, role, context, run }) {
    if (role.workspacePolicy === "handler-only") throw new Error(`role ${role.roleId} is handler-only and cannot launch as a subagent`);
    const childRole = roleContractForTopologyNode(role, node, context);
    const seedPatches = asArray(context.dependencyResults).map((result) => result?.payload?.diagnostics?.workspace || result?.workspace).filter((workspace) => workspace?.patchFile && workspace?.patchHash && Array.isArray(workspace?.changedPaths));
    const sub = this.service.createSubagent({
      parentSessionId: run.parentSessionId || run.runId,
      parentBranchId: run.parentBranchId,
      parentTrajectoryId: run.parentBranchId,
      role: role.roleId,
      task: subagentTaskFromContext(node, context),
      systemPrompt: childRole.systemPrompt,
      roleContract: childRole,
      toolPolicy: childRole.toolPolicy,
      modelPolicy: childRole.modelPolicy,
      modelPreference: childRole.modelPreference,
      workspacePolicy: childRole.workspacePolicy,
      mutationPolicy: childRole.mutationPolicy,
      seedPatches,
      memoryPolicy: node.memoryPolicy || childRole.memoryPolicy,
      budget: childRole.budget,
      mergePolicy: "none",
      metadata: { topologyRunId: run.runId, topologyId: run.topology.topologyId, nodeId: node.id, roleResolution: "registered", contractVersion: childRole.contractVersion, seedPatchHashes: seedPatches.map((patch) => patch.patchHash) },
    });
    const intakeNoSession = run.topology.topologyId === "governed-skill-intake";
    const result = await this.service.runSubagent({ subagentId: sub.id, context: { ...(run.piContext || {}), images: context.images || [], signal: run.signal || run.piContext?.signal, cwd: run.cwd, ...(intakeNoSession ? { rpc: { ...(run.piContext?.rpc || {}), noSession: true } } : {}) } });
    const publicResult = result.submitted_result && typeof result.submitted_result === "object" ? normalizePublicSubmission(result.submitted_result) : {};
    return new AgentResult({ agentId: node.id, nodeId: node.id, role: role.roleId, status: result.status, content: result.final_response || result.summary, summary: result.summary, payload: { ...result, ...publicResult }, artifacts: result.artifacts, diagnostics: result.diagnostics, termination: result.termination, provenance: { subagentId: sub.id, branchId: sub.branchId, workspacePolicy: role.workspacePolicy, contractVersion: role.contractVersion } });
  }
}

function assertImplementationRoadmapGate(topology, roles = []) {
  const roleById = new Map(asArray(roles).map((role) => [role.roleId, role]));
  const implementationNodes = asArray(topology?.nodes).filter((node) => (node.mutationPolicy || roleById.get(node.roleId)?.mutationPolicy) === "proposed-patch");
  if (!implementationNodes.length) return;
  const gate = topology?.metadata?.roadmapPlanGate;
  const planner = asArray(topology?.nodes).find((node) => node.id === gate?.plannerNodeId && node.roleId === "planner");
  const gatedNodeIds = new Set(asArray(gate?.beforeNodeIds));
  if (!gate || !planner || implementationNodes.some((node) => !gatedNodeIds.has(node.id) || !roadmapPlannerPrecedesImplementation(topology, planner.id, node.id))) {
    const error = new Error(`implementation topology ${topology?.topologyId || "unknown"} requires a parent roadmapPlan application gate covering every implementation node`);
    error.code = "TOPOLOGY_ROADMAP_GATE_REQUIRED";
    throw error;
  }
}

function assertTopologyJoinSafety(topology, roles = []) {
  const roleById = new Map(asArray(roles).map((role) => [role.roleId, role]));
  const incomingCounts = new Map(asArray(topology?.nodes).map((node) => [node.id, 0]));
  for (const edge of asArray(topology?.edges)) incomingCounts.set(edge.target, (incomingCounts.get(edge.target) || 0) + 1);
  if ((topology?.partialPolicy || "forbid") === "report" && asArray(topology?.nodes).some((node) => (node.mutationPolicy || roleById.get(node.roleId)?.mutationPolicy) !== "forbidden")) {
    const error = new Error("partialPolicy report is allowed only for fully read-only topologies");
    error.code = "TOPOLOGY_PARTIAL_MUTATION_FORBIDDEN";
    throw error;
  }
  for (const node of asArray(topology?.nodes)) {
    const joinPolicy = normalizeJoinPolicy(node.joinPolicy, incomingCounts.get(node.id) || 0);
    if (nodeRequiresAllJoin(node, roleById, topology) && joinPolicy.mode !== "all") {
      const error = new Error(`topology node ${node.id} requires joinPolicy all`);
      error.code = "TOPOLOGY_UNSAFE_JOIN_POLICY";
      throw error;
    }
  }
}

function evaluateEdgeCondition(condition, result = {}, { requireTyped = false } = {}) {
  const c = String(condition || "").trim();
  if (!c || c === "true" || c === "always") return true;
  const typed = result.validation?.status === "valid" && Number(result.payload?.schemaVersion) === 2 && result.payload?.contractVersion === "role-v2";
  if (requireTyped && (c === "ok" || c === "no_errors") && !typed) return false;
  if (c === "ok") return SUCCESSFUL_AGENT_STATUSES.has(result.status) && result.error == null && result.payload?.ok !== false;
  if (c === "no_errors") return SUCCESSFUL_AGENT_STATUSES.has(result.status) && !result.error && !(Array.isArray(result.payload?.errors) && result.payload.errors.length) && !(Array.isArray(result.diagnostics?.errors) && result.diagnostics.errors.length);
  const confidence = c.match(/^confidence\s*>=\s*([0-9.]+)$/);
  if (confidence) return Number(result.confidence ?? result.payload?.confidence ?? 0) >= Number(confidence[1]);
  const status = c.match(/^status\s*==\s*([a-z_ -]+)$/i);
  if (status) return String(result.status || "") === status[1].trim();
  return false;
}

class TopologyExecutionEngine {
  constructor({ roleRegistry = new AgentRoleRegistry(), topologyRegistry = new TopologyRegistry(), trace, memory, tools = {}, handlerRegistry = {}, agentExecutor, subagentExecutor, roadmapPlanApplier = applyRoadmapPlan, roadmapPlanReconciler = reconcileRoadmapPlan, clock = () => Date.now(), cwd = process.cwd(), policy = {}, roleRuntimeConfig, enforceRoleRollout = false } = {}) {
    this.roleRegistry = roleRegistry; this.topologyRegistry = topologyRegistry; this.trace = trace; this.memoryPolicy = new TopologyMemoryPolicy({ memory, trace }); this.toolPolicy = new ToolPermissionPolicy({ trace, cwd, policy }); this.tools = tools; this.handlerRegistry = normalizeHandlerRegistry(handlerRegistry); this.agentExecutor = agentExecutor; this.subagentExecutor = subagentExecutor; this.roadmapPlanApplier = roadmapPlanApplier; this.roadmapPlanReconciler = roadmapPlanReconciler; this.clock = clock; this.roleRuntimeConfig = roleRuntimeConfig || resolveRoleRuntimeConfig(process.env, { cwd }); this.enforceRoleRollout = enforceRoleRollout;
  }

  async execute(topologyOrId, input = {}, options = {}) {
    const topology = typeof topologyOrId === "string" ? this.topologyRegistry.get(topologyOrId) : this.topologyRegistry.register({ ...topologyOrId, topologyId: topologyOrId.topologyId || `inline_${shortHash(topologyOrId)}` });
    assertRoleRuntimeExecutionAllowed({ config: options.roleRuntimeConfig || this.roleRuntimeConfig, topology, enforceRollout: options.enforceRoleRollout ?? this.enforceRoleRollout });
    const roles = this.roleRegistry.list();
    assertImplementationRoadmapGate(topology, roles);
    assertTopologyJoinSafety(topology, roles);
    const run = {
      runId: options.runId || `toprun_${shortHash({ topologyId: topology.topologyId, at: nowIso(), random: crypto.randomBytes(4).toString("hex") })}`,
      topology,
      input: clone(input),
      cwd: options.cwd || options.piContext?.ctx?.cwd || this.toolPolicy.cwd,
      parentSessionId: options.parentSessionId,
      parentBranchId: options.parentBranchId,
      piContext: options.piContext,
      signal: options.signal,
      taskExecutor: options.taskExecutor,
      startedAt: nowIso(),
      results: new Map(),
      messages: [],
      errors: [],
      events: [],
      nodeStates: new Map(topology.nodes.map((node) => [node.id, { nodeId: node.id, roleId: node.roleId || node.role || "worker", status: "pending", reason: null, durationMs: 0, evidenceCount: 0 }])),
      joinDecisions: [],
      toleratedFailureNodeIds: new Set(),
      partial: false,
      roadmapApplications: new Map(),
      roadmapApplicationPromises: new Map(),
      roadmapReconciliations: new Map(),
    };
    this.emit(run, "topology.started", { topologyId: topology.topologyId, executionMode: topology.executionMode, concurrencyLimit: topology.concurrencyLimit });
    const started = this.clock();
    const packetFromRun = ({ status, aggregation, extraErrors = [] }) => ({
      schemaVersion: TOPOLOGY_SCHEMA_VERSION,
      roleRuntimeVersion: ROLE_RUNTIME_VERSION,
      contractVersion: CONTRACT_VERSION,
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      runId: run.runId,
      topologyId: topology.topologyId,
      status,
      execution: { mode: topology.executionMode, concurrencyLimit: topology.concurrencyLimit, failurePolicy: topology.failurePolicy, partialPolicy: topology.partialPolicy, aggregationPolicy: topology.aggregationPolicy },
      startedAt: run.startedAt,
      finishedAt: nowIso(),
      durationMs: this.clock() - started,
      results: Array.from(run.results.values()).map(clone),
      messages: run.messages.map(clone),
      errors: deduplicateErrors([...clone(run.errors), ...extraErrors].map((error) => ({ ...clone(error), ...safeError(error) }))),
      nodeStates: Array.from(run.nodeStates.values()).map(clone),
      joinDecisions: clone(run.joinDecisions),
      roadmapApplications: Array.from(run.roadmapApplications.values()).map(clone),
      roadmapReconciliations: Array.from(run.roadmapReconciliations.values()).map(clone),
      aggregation,
      trace: run.events.map(clone),
    });
    try {
      await this.runDag(run);
      const aggregation = this.aggregate(run);
      const terminalIds = new Set(topology.terminalNodes?.length ? topology.terminalNodes : topology.nodes.filter((node) => !(topology.edges || []).some((edge) => edge.source === node.id)).map((node) => node.id));
      const terminalSucceeded = [...terminalIds].every((nodeId) => run.results.get(nodeId)?.status === "succeeded");
      const onlyToleratedErrors = run.errors.every((error) => error.nodeId && run.toleratedFailureNodeIds.has(error.nodeId));
      const status = !run.errors.length && !run.partial && terminalSucceeded
        ? "succeeded"
        : topology.partialPolicy === "report" && terminalSucceeded && onlyToleratedErrors && run.partial
          ? "partial"
          : "failed";
      await this.reconcileRoadmapPlans(run, status);
      const packet = packetFromRun({ status, aggregation });
      this.emit(run, "topology.completed", { status: packet.status, resultCount: packet.results.length, partial: run.partial });
      return packet;
    } catch (error) {
      for (const state of run.nodeStates.values()) if (["pending", "running"].includes(state.status)) Object.assign(state, { status: "blocked", reason: run.signal?.aborted ? "topology-cancelled" : "fail-fast", finishedAt: nowIso() });
      const failedStatus = run.signal?.aborted ? "cancelled" : "failed";
      let reconciliationError = null;
      try { await this.reconcileRoadmapPlans(run, failedStatus); }
      catch (settlementError) { reconciliationError = settlementError; }
      this.emit(run, "topology.failed", { error: error.message });
      if (topology.fallbackTopology && !options._fallback && !reconciliationError && !String(error?.code || "").startsWith("TOPOLOGY_ROADMAP_RECONCILIATION_")) {
        this.emit(run, "topology.fallback", { fallbackTopology: topology.fallbackTopology });
        const fallbackTopology = this.topologyRegistry.get(topology.fallbackTopology);
        const fallback = await this.execute(topology.fallbackTopology, input, { ...options, _fallback: true });
        fallback.fallbackOf = topology.topologyId;
        fallback.previousErrors = deduplicateErrors([...run.errors, safeError(error)].map((item) => ({ ...clone(item), ...safeError(item) })));
        fallback.previousRoadmapReconciliations = Array.from(run.roadmapReconciliations.values()).map(clone);
        fallback.fallbackStatus = fallback.status;
        const primaryMutating = isTopologyImplementationCapable(topology, this.roleRegistry.list());
        const fallbackMutating = isTopologyImplementationCapable(fallbackTopology, this.roleRegistry.list());
        if (primaryMutating && !fallbackMutating) {
          fallback.status = "failed";
          fallback.incompleteMutation = true;
          fallback.mutationStatus = "incomplete";
        }
        return fallback;
      }
      return packetFromRun({ status: failedStatus, aggregation: null, extraErrors: [safeError(error), ...(reconciliationError ? [safeError(reconciliationError)] : [])] });
    }
  }

  graph(topology) {
    const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
    const incoming = new Map(topology.nodes.map((n) => [n.id, []]));
    const outgoing = new Map(topology.nodes.map((n) => [n.id, []]));
    for (const edge of topology.edges || []) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error(`invalid edge ${edge.source}->${edge.target}`);
      incoming.get(edge.target).push(edge); outgoing.get(edge.source).push(edge);
    }
    return { nodes, incoming, outgoing };
  }

  async runDag(run) {
    const { topology } = run;
    const g = this.graph(topology);
    const done = new Set();
    const running = new Set();
    const recordedJoins = new Set();
    const concurrency = topology.executionMode === "sequential" ? 1 : topology.concurrencyLimit;
    const joinDecision = (node) => {
      const incoming = g.incoming.get(node.id) || [];
      const policy = normalizeJoinPolicy(node.joinPolicy, incoming.length);
      if (!incoming.length) return { settled: true, satisfied: true, policy, totalInputs: 0, allowedInputs: 0, successfulInputs: 0, failedInputs: [], unavailableInputs: [] };
      if (!incoming.every((edge) => done.has(edge.source))) return { settled: false, satisfied: false, policy };
      const rows = incoming.map((edge) => ({ edge, result: run.results.get(edge.source), allowed: this.edgeAllowed(edge, run) }));
      const allowed = rows.filter((row) => row.allowed);
      const successful = allowed.filter((row) => row.result?.status === "succeeded");
      const failedInputs = rows.filter((row) => row.result && row.result.status !== "succeeded").map((row) => row.edge.source);
      const unavailableInputs = rows.filter((row) => !row.result || !row.allowed).map((row) => row.edge.source);
      const satisfied = policy.mode === "all" ? allowed.length === incoming.length && successful.length === incoming.length : successful.length >= policy.minimumSuccessfulInputs;
      return { settled: true, satisfied, policy, totalInputs: incoming.length, allowedInputs: allowed.length, successfulInputs: successful.length, failedInputs, unavailableInputs };
    };
    const recordJoin = (node, decision) => {
      if (recordedJoins.has(node.id) || !decision.totalInputs) return;
      recordedJoins.add(node.id);
      const degraded = decision.successfulInputs < decision.totalInputs;
      const record = { nodeId: node.id, mode: decision.policy.mode, minimumSuccessfulInputs: decision.policy.minimumSuccessfulInputs, totalInputs: decision.totalInputs, allowedInputs: decision.allowedInputs, successfulInputs: decision.successfulInputs, failedInputs: decision.failedInputs, unavailableInputs: decision.unavailableInputs, satisfied: decision.satisfied, degraded };
      Object.assign(run.nodeStates.get(node.id), { dependencyCount: decision.totalInputs, successfulInputs: decision.successfulInputs, requiredInputs: decision.policy.minimumSuccessfulInputs, joinPolicy: clone(decision.policy) });
      run.joinDecisions.push(record);
      if (decision.satisfied && degraded) {
        run.partial = true;
        for (const nodeId of [...decision.failedInputs, ...decision.unavailableInputs]) run.toleratedFailureNodeIds.add(nodeId);
      }
      this.emit(run, "join.evaluated", record);
    };
    const ready = () => {
      const available = [];
      for (const node of topology.nodes) {
        if (done.has(node.id) || running.has(node.id)) continue;
        const decision = joinDecision(node);
        if (decision.settled && decision.satisfied) {
          recordJoin(node, decision);
          available.push(node);
        }
      }
      return available.slice(0, Math.max(0, concurrency - running.size));
    };
    const settleUnavailable = () => {
      let changed = false;
      for (const node of topology.nodes) {
        if (done.has(node.id) || running.has(node.id)) continue;
        const decision = joinDecision(node);
        if (!decision.settled || decision.satisfied) continue;
        recordJoin(node, decision);
        const status = decision.allowedInputs === 0 ? "skipped" : "blocked";
        const reason = status === "skipped" ? "edge-conditions-rejected-all-inputs" : `join-${decision.policy.mode}-threshold-not-met`;
        const state = run.nodeStates.get(node.id);
        Object.assign(state, { status, reason, finishedAt: nowIso(), dependencyCount: decision.totalInputs, successfulInputs: decision.successfulInputs, requiredInputs: decision.policy.minimumSuccessfulInputs, joinPolicy: clone(decision.policy) });
        done.add(node.id);
        this.emit(run, `agent.${status}`, { nodeId: node.id, roleId: state.roleId, reason });
        changed = true;
      }
      return changed;
    };
    while (done.size < topology.nodes.length) {
      if (run.signal?.aborted) throw Object.assign(new Error("topology execution cancelled"), { code: "TOPOLOGY_CANCELLED" });
      const batch = ready();
      if (!batch.length && running.size === 0) {
        if (settleUnavailable()) continue;
        const unresolved = topology.nodes.filter((node) => !done.has(node.id)).map((node) => node.id);
        if (unresolved.length) throw new Error(`topology stalled; unresolved nodes: ${unresolved.join(", ")}`);
        break;
      }
      await Promise.all(batch.map(async (node) => {
        running.add(node.id);
        const state = run.nodeStates.get(node.id);
        const nodeStartedAt = this.clock();
        Object.assign(state, { status: "running", reason: null, startedAt: nowIso() });
        try {
          const result = await this.runNode(node, run, g);
          run.results.set(node.id, result);
          Object.assign(state, { status: result.status === "timed_out" ? "timed-out" : result.status === "cancelled" ? "cancelled" : "succeeded", finishedAt: nowIso(), durationMs: this.clock() - nodeStartedAt, evidenceCount: asArray(resultField(result, "evidenceRefs") || resultField(result, "evidence")).length });
          done.add(node.id);
        } catch (error) {
          const result = error?.result || new AgentResult({ agentId: node.id, nodeId: node.id, role: node.roleId || node.role || "worker", status: error?.code === "AGENT_TIMEOUT" ? "timed_out" : error?.code === "TOPOLOGY_CANCELLED" ? "cancelled" : "failed", content: error?.message || "node failed", summary: error?.message || "node failed", error, termination: { code: error?.code || "failed", stopReason: null } });
          run.results.set(node.id, result);
          run.errors.push({ nodeId: node.id, ...safeError(error), status: result.status });
          Object.assign(state, { status: result.status === "timed_out" ? "timed-out" : result.status === "cancelled" ? "cancelled" : "failed", reason: error?.code || error?.message || "failed", finishedAt: nowIso(), durationMs: this.clock() - nodeStartedAt, evidenceCount: asArray(resultField(result, "evidenceRefs") || resultField(result, "evidence")).length });
          done.add(node.id);
          if (topology.failurePolicy === "fail-fast") throw error;
        } finally { running.delete(node.id); }
      }));
    }
  }

  edgeAllowed(edge, run) {
    const sourceResult = run.results.get(edge.source);
    if (!sourceResult) return false;
    if (typeof edge.condition === "function") return !!edge.condition({ run, sourceResult });
    if (typeof edge.condition === "string") return evaluateEdgeCondition(edge.condition, sourceResult, { requireTyped: run.topology.metadata?.requiresTypedResults === true });
    return edge.condition == null || edge.condition === true;
  }

  async applyRoadmapPlanGate(node, run) {
    const gate = run.topology.metadata?.roadmapPlanGate;
    if (!gate || !asArray(gate.beforeNodeIds).includes(node.id)) return null;
    const plannerNodeId = String(gate.plannerNodeId || "");
    if (!plannerNodeId) throw Object.assign(new Error("roadmapPlan gate is missing plannerNodeId"), { code: "TOPOLOGY_ROADMAP_GATE_INVALID" });
    if (run.roadmapApplications.has(plannerNodeId)) return run.roadmapApplications.get(plannerNodeId);
    if (run.roadmapApplicationPromises.has(plannerNodeId)) return run.roadmapApplicationPromises.get(plannerNodeId);
    const pending = Promise.resolve().then(async () => {
      const plannerResult = run.results.get(plannerNodeId);
      const roadmapPlan = roadmapPlanFromResult(plannerResult);
      if (!roadmapPlan) throw Object.assign(new Error(`planner node ${plannerNodeId} did not provide roadmapPlan before ${node.id}`), { code: "TOPOLOGY_ROADMAP_PLAN_MISSING" });
      if (typeof this.roadmapPlanApplier !== "function") throw Object.assign(new Error("parent roadmapPlan applier is unavailable"), { code: "TOPOLOGY_ROADMAP_APPLIER_MISSING" });
      const application = await this.roadmapPlanApplier({ cwd: run.cwd, roadmapPlan: clone(roadmapPlan), parentId: run.input?.roadmapParentId, runId: run.runId, topologyId: run.topology.topologyId, plannerNodeId, beforeNodeId: node.id });
      if (application?.applied !== true) throw Object.assign(new Error("parent roadmapPlan application did not confirm success"), { code: "TOPOLOGY_ROADMAP_APPLICATION_FAILED" });
      const record = { plannerNodeId, beforeNodeId: node.id, ...clone(application) };
      run.roadmapApplications.set(plannerNodeId, record);
      this.emit(run, "roadmap.applied", record);
      return record;
    }).finally(() => run.roadmapApplicationPromises.delete(plannerNodeId));
    run.roadmapApplicationPromises.set(plannerNodeId, pending);
    return pending;
  }

  async reconcileRoadmapPlans(run, status) {
    if (!run.roadmapApplications.size) return [];
    if (typeof this.roadmapPlanReconciler !== "function") throw Object.assign(new Error("parent roadmapPlan reconciler is unavailable"), { code: "TOPOLOGY_ROADMAP_RECONCILIATION_FAILED" });
    for (const [plannerNodeId, application] of run.roadmapApplications) {
      if (run.roadmapReconciliations.has(plannerNodeId)) continue;
      try {
        const reconciliation = await this.roadmapPlanReconciler({ cwd: run.cwd, application: clone(application), runId: run.runId, topologyId: run.topology.topologyId, status, reason: `topology-${status}` });
        if (reconciliation?.reconciled !== true) throw new Error("parent roadmapPlan reconciliation did not confirm settlement");
        const record = { plannerNodeId, topologyStatus: status, reconciliationStatus: "succeeded", ...clone(reconciliation) };
        run.roadmapReconciliations.set(plannerNodeId, record);
        this.emit(run, "roadmap.reconciled", record);
      } catch (cause) {
        const error = Object.assign(new Error(cause?.message || "parent roadmapPlan reconciliation failed"), { code: cause?.code || "TOPOLOGY_ROADMAP_RECONCILIATION_FAILED", cause });
        const record = { plannerNodeId, topologyStatus: status, reconciliationStatus: "failed", roadmapId: application.roadmapId || null, error: safeError(error) };
        run.roadmapReconciliations.set(plannerNodeId, record);
        this.emit(run, "roadmap.reconciliation_failed", record);
        throw error;
      }
    }
    return Array.from(run.roadmapReconciliations.values()).map(clone);
  }

  async runNode(node, run, graph) {
    await this.applyRoadmapPlanGate(node, run);
    const registeredRole = this.roleRegistry.get(node.roleId || node.role || "worker");
    const baseRole = narrowRoleContract(registeredRole, roleOverrideFromNode(node, registeredRole));
    const alternateRoleIds = [...(node.retryPolicy?.alternateRoleIds || []), ...(baseRole.retryPolicy?.alternateRoleIds || [])];
    const attempts = Math.max(1, 1 + Number(node.retryPolicy?.maxRetries ?? baseRole.retryPolicy?.maxRetries ?? 0));
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const alternate = attempt > 1 && alternateRoleIds[attempt - 2] ? this.roleRegistry.get(alternateRoleIds[attempt - 2]) : null;
      const role = alternate ? narrowRoleContract(alternate, roleOverrideFromNode(node, alternate)) : baseRole;
      if (run.signal?.aborted) throw new Error("topology execution cancelled");
      const started = this.clock();
      this.emit(run, "agent.started", { nodeId: node.id, roleId: role.roleId, attempt });
      try {
        const context = this.contextFor(node, run, graph, role);
        const engineOwnsTimeout = (node.executionMode || "handler") !== "subagent";
        const result = await this.withTimeout(engineOwnsTimeout ? node.timeoutMs || role.timeoutMs : 0, () => this.invokeNode(node, role, context, run));
        const finalResult = result instanceof AgentResult ? result : new AgentResult({ agentId: node.id, nodeId: node.id, role: role.roleId, status: result?.status, content: result?.content || result?.final_response || result?.summary || JSON.stringify(result || {}), summary: result?.summary, payload: result?.payload ?? result, artifacts: result?.artifacts, diagnostics: result?.diagnostics, termination: result?.termination, attempts: attempt });
        if (!SUCCESSFUL_AGENT_STATUSES.has(finalResult.status)) throw new AgentExecutionStatusError(finalResult);
        const shouldValidateSchema = run.topology.metadata?.requiresTypedResults === true || typeof role.validate === "function" || role.settings?.legacyOutputSchemaExplicit || finalResult.payload?.schemaVersion === 2;
        finalResult.validation = role.validate ? role.validate(finalResult) : shouldValidateSchema ? validateSimpleSchema(role.outputSchema || node.outputSchema, finalResult, role) : { status: "unchecked", reason: "deterministic compatibility executor did not return a role-v2 envelope" };
        if (finalResult.validation?.status === "invalid") {
          const error = new Error(finalResult.validation.reason || "agent output validation failed");
          error.code = "AGENT_RESULT_SCHEMA_INVALID";
          error.result = finalResult;
          throw error;
        }
        if (role.roleId === "verifier") {
          const verificationStatus = resultField(finalResult, "verification")?.status || "unchecked";
          if (verificationStatus !== "passed") throw new AgentVerificationGateError(finalResult, verificationStatus);
        }
        const post = role.postProcess ? await role.postProcess(finalResult, context) : finalResult;
        this.emit(run, "agent.completed", { nodeId: node.id, roleId: role.roleId, attempt, durationMs: this.clock() - started, status: finalResult.status, termination: finalResult.termination });
        run.messages.push(post);
        return post;
      } catch (error) {
        lastError = error;
        const failedStatus = error?.result?.status || "failed";
        const failedTermination = error?.result?.termination || error?.result?.payload?.termination || { code: error?.code || "failed", stopReason: null };
        this.emit(run, "agent.failed", { nodeId: node.id, roleId: role.roleId, attempt, status: failedStatus, termination: failedTermination, error: error.message });
        if (attempt < attempts) this.emit(run, "agent.retry", { nodeId: node.id, roleId: role.roleId, attempt });
      }
    }
    throw lastError;
  }

  async invokeNode(node, role, context, run) {
    if (node.tool) {
      const fn = context.tools?.[node.tool];
      if (!fn) throw new Error(`topology node tool unavailable: ${node.tool}`);
      const args = Array.isArray(node.args) ? node.args : node.args == null ? [] : [node.args];
      const output = await fn(...args);
      return { content: compactToolContent(output), summary: `${node.tool} completed`, payload: { tool: node.tool, args, output } };
    }
    if (node.handlerId) {
      if (role.workspacePolicy !== "handler-only" || role.budget?.maxModelCalls !== 0 || role.budget?.maxToolCalls !== 0) throw new Error(`topology handlerId ${node.handlerId} requires a zero-call handler-only role`);
      const handler = this.handlerRegistry.get(node.handlerId);
      if (!handler) throw Object.assign(new Error(`topology handler is not registered: ${node.handlerId}`), { code: "TOPOLOGY_HANDLER_UNREGISTERED" });
      return handler(context, { node, role, run });
    }
    if (node.handler) return node.handler(context, { node, role, run });
    if (role.handler) return role.handler(context, { node, role, run });
    if ((node.executionMode || "handler") === "subagent") {
      if (node.metadata?.specialistTaskId && !run.taskExecutor) throw new Error("specialist task nodes require the validated task-graph executor");
      const executor = (node.metadata?.specialistTaskId ? run.taskExecutor : null) || this.subagentExecutor || new SubagentTopologyExecutor({ trace: this.trace, cwd: run.cwd || this.toolPolicy.cwd });
      return executor.execute({ node, role, context, run });
    }
    if (this.agentExecutor) return this.agentExecutor({ node, role, context, run });
    const error = new Error(`topology node ${node.id} has no handler, tool, agent executor, or subagent execution mode`);
    error.code = "TOPOLOGY_EXECUTOR_MISSING";
    throw error;
  }

  contextFor(node, run, graph, roleOverride = null) {
    const role = roleOverride || this.roleRegistry.get(node.roleId || node.role || "worker");
    const policy = ensureOneOf("context policy", node.contextPolicy || role.maxContextPolicy?.kind || "dependency-neighborhood", CONTEXT_POLICIES);
    const incomingEdges = graph.incoming.get(node.id) || [];
    const joinPolicy = normalizeJoinPolicy(node.joinPolicy, incomingEdges.length);
    let deps = incomingEdges.map((edge) => ({ edge, result: run.results.get(edge.source) })).filter((item) => item.result);
    if (joinPolicy.mode === "all") deps = deps.filter(({ edge }) => this.edgeAllowed(edge, run));
    else if (!joinPolicy.includeFailedInputs) deps = deps.filter(({ edge, result }) => this.edgeAllowed(edge, run) && result.status === "succeeded");
    let dependencyResults = deps.map(({ edge, result }) => edge.transform ? edge.transform(result, { run, node }) : result);
    if (policy === "task-only" || policy === "isolated-scratch") dependencyResults = [];
    if (policy === "summarized") dependencyResults = dependencyResults.map((result) => ({
      nodeId: result.nodeId,
      status: result.status,
      summary: result.summary,
      confidence: result.confidence,
      workspace: result.payload?.diagnostics?.workspace || null,
      ...(resultField(result, "workspaceDisposition") ? { workspaceDisposition: resultField(result, "workspaceDisposition") } : {}),
      ...(roadmapPlanFromResult(result) ? { roadmapPlan: roadmapPlanFromResult(result) } : {}),
    }));
    if (policy === "evidence-only") dependencyResults = dependencyResults.map(evidenceProjection);
    const memory = this.memoryPolicy.facade(node.memoryPolicy || role.memoryPolicy || run.topology.memoryPolicy, run, node);
    const context = { policy, task: renderTask(node.task || run.input.task, run.input), input: policy === "isolated-scratch" ? { task: run.input.task } : clone(run.input), dependencyResults, allResults: policy === "full" ? Array.from(run.results.values()).map(clone) : undefined, scratch: {}, memory, tools: this.toolPolicy.wrap(this.tools, role, node, run), topology: { runId: run.runId, topologyId: run.topology.topologyId }, node: clone({ ...node, handler: undefined }) };
    if (policy === "memory-backed" && memory.policy !== "none") { try { context.memoryContext = memory.read(context.task, { limit: 8 }); } catch {} }
    this.emit(run, "context.projected", { nodeId: node.id, policy, dependencyCount: dependencyResults.length, memoryPolicy: memory.policy });
    return context;
  }

  withTimeout(timeoutMs, fn) {
    if (!timeoutMs || timeoutMs <= 0) return fn();
    let timer;
    return Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`agent timeout exceeded (${timeoutMs}ms)`); e.code = "AGENT_TIMEOUT"; reject(e); }, timeoutMs); timer.unref?.(); })]).finally(() => clearTimeout(timer));
  }

  aggregate(run) {
    const { topology } = run;
    const results = Array.from(run.results.values());
    const terminalIds = topology.terminalNodes.length ? new Set(topology.terminalNodes) : new Set(results.filter((r) => !topology.edges.some((e) => e.source === r.nodeId)).map((r) => r.nodeId));
    const terminal = results.filter((r) => terminalIds.has(r.nodeId));
    if (typeof topology.aggregationPolicy === "function") return topology.aggregationPolicy({ run, results, terminal });
    if (topology.aggregationPolicy === "all") return { results };
    if (topology.aggregationPolicy === "last") return results.at(-1) || null;
    if (topology.aggregationPolicy === "concat") return { content: (terminal.length ? terminal : results).map((r) => r.content).join("\n\n"), results: terminal.length ? terminal : results };
    if (topology.aggregationPolicy === "vote") {
      const votes = new Map(); for (const r of terminal) votes.set(r.payload?.vote || r.content, (votes.get(r.payload?.vote || r.content) || 0) + 1);
      const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] || null; return { winner: winner?.[0] || null, votes: Object.fromEntries(votes), results: terminal };
    }
    return { results: terminal.length ? terminal : results };
  }

  emit(run, name, payload = {}) {
    const event = { id: `topevt_${shortHash({ runId: run.runId, name, payload, at: nowIso() })}`, at: nowIso(), type: `topology.${name}`, topologyRunId: run.runId, topologyId: run.topology.topologyId, ...payload };
    run.events.push(event);
    const category = name.includes("failed") ? "failure_state" : name.includes("retry") ? "retry" : name.includes("context") ? "context_injection" : "agent_branching";
    this.trace?.emit?.({ category, name: event.type, agent_id: payload.nodeId, payload: event, severity: name.includes("failed") ? "error" : "info" });
    return event;
  }
}

function loadTopologyConfig(file, { roleRegistry, topologyRegistry } = {}) {
  const packet = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const role of packet.roles || []) roleRegistry.register(role);
  for (const raw of packet.topologies || []) {
    const topology = materializeRoleAwareTopology(raw, { roles: roleRegistry.list(), provenance: { source: "project-config", file: path.resolve(file) } });
    const validation = validateRoleAwareTopology(topology, { roles: roleRegistry.list() });
    if (!validation.ok) throw new Error(`invalid role-aware topology ${raw.topologyId}: ${validation.issues.join("; ")}`);
    topologyRegistry.register(topology);
  }
  return { file, roles: packet.roles?.length || 0, topologies: packet.topologies?.length || 0 };
}

function loadTopologyConfigDir(dir, registries = {}) {
  const loaded = [];
  try {
    for (const name of fs.readdirSync(dir).sort()) if (name.endsWith(".json")) loaded.push(loadTopologyConfig(path.join(dir, name), registries));
  } catch {}
  return loaded;
}

function filterTraceEvents(events = [], { runId, topologyId, agentId } = {}) {
  return events.filter((e) => (!runId || e.topologyRunId === runId || e.payload?.topologyRunId === runId) && (!topologyId || e.topologyId === topologyId || e.payload?.topologyId === topologyId) && (!agentId || e.nodeId === agentId || e.agent_id === agentId || e.payload?.nodeId === agentId));
}
function replayTrace(events = [], options = {}) {
  return filterTraceEvents(events, options).map((e, index) => ({ index, at: e.at || e.timestamp, type: e.type || e.name, topologyRunId: e.topologyRunId || e.payload?.topologyRunId, topologyId: e.topologyId || e.payload?.topologyId, nodeId: e.nodeId || e.agent_id || e.payload?.nodeId, summary: e.error || e.payload?.error || e.status || e.name || e.type }));
}

function loadTopologyExtension(moduleOrPath, { roleRegistry, topologyRegistry } = {}) {
  const mod = typeof moduleOrPath === "string" ? require(moduleOrPath) : moduleOrPath;
  if (typeof mod === "function") return mod({ roleRegistry, topologyRegistry });
  if (typeof mod.registerMultiAgentTopologies === "function") return mod.registerMultiAgentTopologies({ roleRegistry, topologyRegistry });
  for (const role of mod.roles || []) roleRegistry.register(role);
  for (const raw of mod.topologies || []) {
    const topology = materializeRoleAwareTopology(raw, { roles: roleRegistry.list(), provenance: { source: "topology-extension", module: typeof moduleOrPath === "string" ? path.resolve(moduleOrPath) : "inline-module" } });
    const validation = validateRoleAwareTopology(topology, { roles: roleRegistry.list() });
    if (!validation.ok) throw new Error(`invalid role-aware topology extension ${raw.topologyId}: ${validation.issues.join("; ")}`);
    topologyRegistry.register(topology);
  }
  return { roles: mod.roles?.length || 0, topologies: mod.topologies?.length || 0 };
}

function createTopologyTemplates() {
  return {
    plannerCoderVerifier: (id = "planner-coder-verifier") => ({ ...getBuiltInRoleTopology("planner-coder-verifier"), topologyId: id }),
    parallelEvidenceSynthesis: (id = "parallel-evidence-synthesis") => ({ ...getBuiltInRoleTopology("parallel-evidence-synthesis"), topologyId: id }),
    fanOutReview: (id = "research-code-review") => materializeRoleAwareTopology({ topologyId: id, name: "Researcher -> Planner -> Coder -> Reviewer", executionMode: "dag", concurrencyLimit: 2, aggregationPolicy: "terminal", metadata: { roadmapPlanGate: { plannerNodeId: "plan", beforeNodeIds: ["code"] } }, nodes: [{ id: "research", roleId: "researcher" }, { id: "plan", roleId: "planner", outputSchema: { ...clone(ROLE_OUTPUT_SCHEMAS.planner), required: [...new Set([...(ROLE_OUTPUT_SCHEMAS.planner.required || []), "roadmapPlan"])] } }, { id: "code", roleId: "coder" }, { id: "review", roleId: "patch-reviewer" }], edges: [{ source: "research", target: "plan", condition: "ok" }, { source: "plan", target: "code", condition: "ok" }, { source: "code", target: "review", condition: "no_errors" }], terminalNodes: ["review"] }, { provenance: { source: "runtime-template" } }),
    debate: (id = "debate") => materializeRoleAwareTopology({ topologyId: id, name: "Two critics and judge", executionMode: "dag", concurrencyLimit: 2, aggregationPolicy: "last", nodes: [{ id: "critic_a", roleId: "reviewer" }, { id: "critic_b", roleId: "reviewer" }, { id: "judge", roleId: "coordinator" }], edges: [{ source: "critic_a", target: "judge", condition: "ok" }, { source: "critic_b", target: "judge", condition: "ok" }], terminalNodes: ["judge"] }, { provenance: { source: "runtime-template" } }),
  };
}

module.exports = {
  AGENT_EXECUTION_MODES,
  TOPOLOGY_EXECUTION_MODES,
  CONTEXT_POLICIES,
  MEMORY_POLICIES,
  FAILURE_POLICIES,
  AGGREGATION_POLICIES,
  JOIN_POLICY_MODES,
  PARTIAL_POLICIES,
  NODE_OUTCOME_STATUSES,
  AgentMessage,
  AgentResult,
  AgentExecutionStatusError,
  AgentVerificationGateError,
  AgentRoleRegistry,
  TopologyRegistry,
  TopologyExecutionEngine,
  normalizeHandlerRegistry,
  ToolPermissionPolicy,
  ToolPermissionError,
  TopologyMemoryPolicy,
  SubagentTopologyExecutor,
  loadTopologyConfig,
  loadTopologyConfigDir,
  loadTopologyExtension,
  filterTraceEvents,
  replayTrace,
  validateSimpleSchema,
  evaluateEdgeCondition,
  evidenceProjection,
  subagentTaskFromContext,
  roadmapPlanFromResult,
  topologyRoadmapHandoffs,
  assertTopologyJoinSafety,
  normalizeRoleId,
  createTopologyTemplates,
  listBuiltInRoleTopologies,
  materializeRoleAwareTopology,
  validateRoleAwareTopology,
};
