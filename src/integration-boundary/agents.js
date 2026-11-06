"use strict";

const path = require("node:path");
const { MemoryJsonStorage, NullSink, noopResult, safe, writePrivateExport } = require("./common.js");
const { FileIntegrationStorage } = require("../file-integration-storage");
const { AgentRoleRegistry, TopologyExecutionEngine, TopologyRegistry, filterTraceEvents, listBuiltInRoleTopologies, loadTopologyConfig, loadTopologyConfigDir, loadTopologyExtension, materializeRoleAwareTopology, replayTrace, topologyRoadmapHandoffs, validateRoleAwareTopology } = require("../multi-agent-topologies");
const { selectRoleInferenceProfile } = require("../role-contracts");
const { normalizeSkillGovernance, topologyEligibility } = require("../skill-governance");
const { curatedPiSkillPack } = require("../skill-packs");
const { SkillStore, SkillSynthesisEngine, nativeAgentSkillProvider, promoteHermesSkillCandidate, quarantineHermesSkillCandidate } = require("../skill-synthesis");
const { publicRecord, publicResult } = require("../subagent-lifecycle");
const { SubagentService } = require("../subagents");

class SubagentAdapter {
  constructor({ enabled = true, cwd = process.cwd(), store, branchManager, runner, trace, sink = new NullSink(), config = {} } = {}) {
    this.enabled = enabled; this.sink = sink;
    this.service = new SubagentService({ cwd, store, branchManager, runner, trace, config });
  }
  preflight(args, options) { return this.enabled ? this.service.preflightSubagent(args, options) : noopResult("subagents.preflight"); }
  createSubagent(args) { if (!this.enabled) return noopResult("subagents.createSubagent"); const r = this.service.createSubagent(args); this.sink.emit({ type: "subagent.created", id: r.id, branchId: r.branchId }); return publicRecord(r); }
  launchSubagent(args) { return this.enabled ? this.service.launchSubagent(args) : noopResult("subagents.launchSubagent"); }
  async runSubagent(args) { if (!this.enabled) return noopResult("subagents.runSubagent"); return publicResult(await this.service.runSubagent(args)); }
  async waitSubagent(args) { if (!this.enabled) return noopResult("subagents.waitSubagent"); const result = await this.service.waitSubagent(args); return result?.waiting ? result : publicResult(result); }
  steerSubagent(args) { return this.enabled ? this.service.steerSubagent(args) : noopResult("subagents.steerSubagent"); }
  interruptSubagent(args) { return this.enabled ? this.service.interruptSubagent(args) : noopResult("subagents.interruptSubagent"); }
  async cancelSubagent(args) { if (!this.enabled) return noopResult("subagents.cancelSubagent"); const record = await this.service.cancelSubagent(args); return publicRecord(record, this.service.store.getResult(record.id)); }
  continueSubagent(args) { if (!this.enabled) return noopResult("subagents.continueSubagent"); return publicRecord(this.service.continueSubagent(args)); }
  resumeSubagent(args) { if (!this.enabled) return noopResult("subagents.resumeSubagent"); return publicRecord(this.service.resumeSubagent(args)); }
  getSubagent(args) { if (!this.enabled) return null; const record = this.service.getSubagent(args); return record ? publicRecord(record, record.result) : null; }
  listSubagents(args) { return this.enabled ? this.service.listSubagents(args).map((record) => publicRecord(record, this.service.store.getResult(record.id))) : []; }
  subscribe(listener) { return this.enabled ? this.service.subscribe(listener) : () => {}; }
  cancelAll() { if (!this.enabled) return Promise.resolve([]); return Promise.all(this.service.listSubagents().filter((record) => ["created", "queued", "running"].includes(record.status)).map((record) => this.cancelSubagent({ subagentId: record.id, reason: "adapter-cancel-all" }))); }
  mergeSubagentResult(args) { if (!this.enabled) return noopResult("subagents.mergeSubagentResult"); return this.service.mergeSubagentResult(args); }
  previewSubagentPatch(args) { if (!this.enabled) return noopResult("subagents.previewSubagentPatch"); return this.service.previewSubagentPatch(args); }
  applySubagentPatch(args) { if (!this.enabled) return Promise.resolve(noopResult("subagents.applySubagentPatch")); return this.service.applySubagentPatch(args); }
  events(args) { return this.enabled ? this.service.events(args) : []; }
  status(args) { return this.enabled ? this.service.status(args) : noopResult("subagents.status"); }
  exportSubagents(args) { if (!this.enabled) return noopResult("subagents.exportSubagents"); return this.service.exportSubagents(args); }
  pruneSubagents(args) { if (!this.enabled) return noopResult("subagents.pruneSubagents"); return this.service.pruneSubagents(args); }
  recoverInterruptedRuns(args) { return this.enabled ? this.service.recoverInterruptedRuns(args) : []; }
}

function isCurrentRoleV2TopologyRun(run = {}) {
  return [2, 3].includes(Number(run.schemaVersion)) && Number(run.roleRuntimeVersion) === 2 && run.contractVersion === "role-v2" && Number(run.resultSchemaVersion) === 2;
}

function summarizeTopologyRuns(rows = []) {
  const byStatus = {};
  const bySchemaVersion = {};
  let totalDurationMs = 0;
  let errors = 0;
  let blockedNodes = 0;
  let skippedNodes = 0;
  let degradedJoins = 0;
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    bySchemaVersion[row.schemaVersion || "unknown"] = (bySchemaVersion[row.schemaVersion || "unknown"] || 0) + 1;
    totalDurationMs += Number(row.durationMs || 0);
    errors += Number(row.errors || 0);
    blockedNodes += Number(row.blockedNodes || 0);
    skippedNodes += Number(row.skippedNodes || 0);
    degradedJoins += Number(row.degradedJoins || 0);
  }
  return { totalRuns: rows.length, byStatus, bySchemaVersion, passRate: rows.length ? (byStatus.succeeded || 0) / rows.length : null, meanDurationMs: rows.length ? totalDurationMs / rows.length : 0, totalDurationMs, errors, failures: byStatus.failed || 0, partials: byStatus.partial || 0, blockedNodes, skippedNodes, degradedJoins };
}

class MultiAgentTopologyAdapter {
  constructor({ enabled = true, storage = new MemoryJsonStorage(), sink = new NullSink(), trace, memory, tools = {}, roles = [], topologies = [], extensions = [], configFiles = [], configDirs = [], options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.sink = sink;
    this.roles = new AgentRoleRegistry({ roles });
    this.topologies = new TopologyRegistry({ topologies: options.loadBuiltInTopologies === false ? [] : listBuiltInRoleTopologies() });
    for (const topology of topologies || []) {
      if (this.topologies.topologies.has(topology.topologyId)) {
        const materialized = materializeRoleAwareTopology(topology, { roles: this.roles.list(), provenance: { source: "constructor-override" } });
        const validation = validateRoleAwareTopology(materialized, { roles: this.roles.list() });
        if (!validation.ok) throw new Error(`invalid topology override ${topology.topologyId}: ${validation.issues.join("; ")}`);
        this.topologies.register(materialized);
      } else this.topologies.register(topology);
    }
    for (const file of configFiles || []) loadTopologyConfig(file, { roleRegistry: this.roles, topologyRegistry: this.topologies });
    for (const dir of configDirs || []) loadTopologyConfigDir(dir, { roleRegistry: this.roles, topologyRegistry: this.topologies });
    for (const extension of extensions || []) loadTopologyExtension(extension, { roleRegistry: this.roles, topologyRegistry: this.topologies });
    this.engine = new TopologyExecutionEngine({ roleRegistry: this.roles, topologyRegistry: this.topologies, trace, memory, tools, ...(options || {}) });
  }
  registerRole(role) { if (!this.enabled) return noopResult("topologies.registerRole"); return this.roles.register(role); }
  createCustomReadOnlyRole(input) { if (!this.enabled) return noopResult("topologies.createCustomReadOnlyRole"); return this.roles.customReadOnly(input); }
  registerTopology(topology) { if (!this.enabled) return noopResult("topologies.registerTopology"); return this.topologies.register(topology); }
  listRoles() { return this.enabled ? this.roles.list() : []; }
  discoverRoles() { return this.enabled ? this.roles.descriptors() : []; }
  recommendRole(roleId, { env = process.env, inheritedModel = null, inheritedThinkingLevel = null } = {}) {
    if (!this.enabled) return { ...noopResult("topologies.recommendRole"), execute: false, advisoryOnly: true };
    const role = this.roles.resolve(roleId);
    if (role.autoRoutePolicy !== "suggest") throw Object.assign(new Error(`role ${role.roleId} is not eligible for suggest-only recommendation`), { code: "ROLE_SUGGESTION_NOT_ALLOWED" });
    if (role.workspacePolicy !== "shared-readonly" || role.mutationPolicy !== "forbidden") throw Object.assign(new Error(`role ${role.roleId} is not a safe read-only recommendation`), { code: "ROLE_SUGGESTION_UNSAFE" });
    const profile = selectRoleInferenceProfile(role.modelPolicy, { roleId: role.roleId, inheritedModel, inheritedThinkingLevel, env });
    return { schemaVersion: 1, roleId: role.roleId, model: profile.selectedModel, thinkingLevel: profile.selectedThinkingLevel, workspacePolicy: role.workspacePolicy, mutationPolicy: role.mutationPolicy, autoRoutePolicy: role.autoRoutePolicy, execute: false, advisoryOnly: true };
  }
  refineRole(roleId, override, options = {}) { if (!this.enabled) return noopResult("topologies.refineRole"); const result = this.roles.refine(roleId, override, options); const publicResult = { changed: result.changed, role: this.roles.descriptors().find((role) => role.roleId === result.role.roleId), beforeRevision: result.beforeRevision, afterRevision: result.afterRevision }; if (result.changed) this.storage.appendJsonl?.("topologies/role-refinements", { schemaVersion: 1, at: new Date().toISOString(), roleId: result.role.roleId, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, reasonCode: "reviewed-refinement", changedFields: Object.keys(override || {}).map((key) => key === "systemPrompt" ? "taskScope" : key).sort() }); return publicResult; }
  roleRefinementHistory(roleId) { return this.enabled ? this.roles.history(roleId) : []; }
  rollbackRoleRefinement(roleId, revision, options = {}) { if (!this.enabled) return noopResult("topologies.rollbackRoleRefinement"); const result = this.roles.rollbackRefinement(roleId, revision, options); return { rolledBack: true, role: this.roles.descriptors().find((role) => role.roleId === result.role.roleId), revision: result.revision }; }
  listTopologies() { return this.enabled ? this.topologies.list() : []; }
  roadmapHandoffs(run) { return this.enabled ? topologyRoadmapHandoffs(run) : []; }
  async execute(topologyOrId, input, options) { if (!this.enabled) return noopResult("topologies.execute"); const topologyId = typeof topologyOrId === "string" ? topologyOrId : topologyOrId?.topologyId; const safeInput = topologyId === "governed-skill-intake" ? { sourceId: String(input?.sourceId || ""), task: `Review pinned staged skill source ${String(input?.sourceId || "")}` } : input; const result = await this.engine.execute(topologyOrId, safeInput, options); this.storage.writeJson?.(`topologies/runs/${result.runId}`, result); const nodeStates = result.nodeStates || []; const joins = result.joinDecisions || []; this.storage.appendJsonl?.("topologies/runs", { runId: result.runId, topologyId: result.topologyId, status: result.status, startedAt: result.startedAt, finishedAt: result.finishedAt, durationMs: result.durationMs, errors: result.errors?.length || 0, blockedNodes: nodeStates.filter((node) => node.status === "blocked").length, skippedNodes: nodeStates.filter((node) => node.status === "skipped").length, degradedJoins: joins.filter((join) => join.degraded).length, evidenceCount: nodeStates.reduce((sum, node) => sum + Number(node.evidenceCount || 0), 0), schemaVersion: result.schemaVersion, roleRuntimeVersion: result.roleRuntimeVersion, contractVersion: result.contractVersion, resultSchemaVersion: result.resultSchemaVersion, cohort: isCurrentRoleV2TopologyRun(result) ? "current-v2" : "legacy" }); this.recordMetrics(result); return result; }
  getRun(runId) { return this.enabled ? this.storage.readJson?.(`topologies/runs/${runId}`, null) || null : null; }
  listRuns({ topologyId, limit = 50 } = {}) { if (!this.enabled) return []; const rows = this.storage.readJsonl?.("topologies/runs") || []; const filtered = rows.filter((r) => !topologyId || r.topologyId === topologyId); return Number.isFinite(limit) ? filtered.slice(-limit) : filtered; }
  exportRun({ runId, file } = {}) { const run = this.getRun(runId); if (!run) throw new Error(`topology run not found: ${runId}`); if (file) writePrivateExport(file, run); return run; }
  pruneRuns({ keepRecent = 50, olderThanMs = 0, topologyId } = {}) { if (!this.enabled) return noopResult("topologies.pruneRuns"); const rows = this.listRuns({ topologyId, limit: Infinity }).sort((a, b) => Date.parse(b.finishedAt || b.startedAt || 0) - Date.parse(a.finishedAt || a.startedAt || 0)); const cutoff = olderThanMs ? Date.now() - olderThanMs : Infinity; const pruned = []; for (const row of rows.slice(Math.max(0, keepRecent))) { const at = Date.parse(row.finishedAt || row.startedAt || 0); if (olderThanMs && (!Number.isFinite(at) || at > cutoff)) continue; this.storage.deleteJson?.(`topologies/runs/${row.runId}`); pruned.push(row); } return { pruned: pruned.length, archived: pruned, remaining: Math.max(0, rows.length - pruned.length) }; }
  recordMetrics(result = {}) { const state = this.storage.readJson?.("topologies/metrics", { totalRuns: 0, byTopology: {}, byStatus: {}, failuresByNode: {}, retries: 0, toolDenials: 0, fallbackCount: 0, subagentNodeCount: 0, totalDurationMs: 0, blockedNodes: 0, skippedNodes: 0, degradedJoins: 0, evidenceCount: 0 }) || {}; state.totalRuns = (state.totalRuns || 0) + 1; state.totalDurationMs = (state.totalDurationMs || 0) + Number(result.durationMs || 0); state.byStatus = state.byStatus || {}; state.byStatus[result.status] = (state.byStatus[result.status] || 0) + 1; state.byTopology = state.byTopology || {}; const t = state.byTopology[result.topologyId] || { runs: 0, byStatus: {}, totalDurationMs: 0, failures: 0, partials: 0 }; t.runs += 1; t.totalDurationMs += Number(result.durationMs || 0); t.byStatus[result.status] = (t.byStatus[result.status] || 0) + 1; t.failures += result.status === "failed" ? 1 : 0; t.partials += result.status === "partial" ? 1 : 0; state.byTopology[result.topologyId] = t; state.failuresByNode = state.failuresByNode || {}; for (const e of result.errors || []) if (e.nodeId) state.failuresByNode[e.nodeId] = (state.failuresByNode[e.nodeId] || 0) + 1; for (const r of result.results || []) { state.retries = (state.retries || 0) + Math.max(0, Number(r.attempts || 1) - 1); if (r.provenance?.subagentId) state.subagentNodeCount = (state.subagentNodeCount || 0) + 1; } for (const node of result.nodeStates || []) { state.blockedNodes = (state.blockedNodes || 0) + (node.status === "blocked" ? 1 : 0); state.skippedNodes = (state.skippedNodes || 0) + (node.status === "skipped" ? 1 : 0); state.evidenceCount = (state.evidenceCount || 0) + Number(node.evidenceCount || 0); } state.degradedJoins = (state.degradedJoins || 0) + (result.joinDecisions || []).filter((join) => join.degraded).length; state.toolDenials = (state.toolDenials || 0) + (result.trace || []).filter((e) => e.type === "topology.tool_denied" || e.name === "topology.tool_denied").length; if (result.fallbackOf) state.fallbackCount = (state.fallbackCount || 0) + 1; this.storage.writeJson?.("topologies/metrics", state); return state; }
  metrics({ topologyId } = {}) {
    const rows = this.listRuns({ topologyId, limit: Infinity });
    const currentRows = rows.filter(isCurrentRoleV2TopologyRun);
    const legacyRows = rows.filter((row) => !isCurrentRoleV2TopologyRun(row));
    const overall = summarizeTopologyRuns(rows);
    const reliability = { contractVersion: "role-v2", resultSchemaVersion: 2, ...summarizeTopologyRuns(currentRows) };
    const legacy = summarizeTopologyRuns(legacyRows);
    return { ...(topologyId ? { topologyId } : {}), ...overall, passRate: reliability.passRate, reliability, legacy, legacyRuns: legacy.totalRuns, currentRuns: reliability.totalRuns };
  }
  trace(options = {}) { return this.enabled ? filterTraceEvents(this.engine.trace?.export?.() || this.engine.trace?.events?.() || [], options) : []; }
  replay(options = {}) { return this.enabled ? replayTrace(this.engine.trace?.export?.() || this.engine.trace?.events?.() || [], options) : []; }
}

function clearSpecialistRuntimeCache() {
  for (const module of ["subagent-task-contracts.js", "subagent-task-state.js", "subagent-tasks.js", "subagent-workspaces.js", "specialist-roles.js", "specialist-tools.js", "specialist-diagnostics.js", "diagnostic-evidence.js", "specialist-verifiers.js", "specialist-runtime.js", "specialist-blenderai.js", "specialist-lean.js", "specialist-rea.js", "resource-guard.js", "verification-pipeline.js"]) {
    delete require.cache[require.resolve(`../${module}`)];
  }
}

class SpecialistToolsAdapter {
  capabilityStatus(contract) { return require("../specialist-tools").capabilityStatus(contract); }
  resolveRequiredTools(contract, actualTools, options) { return require("../role-contracts").resolveRequiredTools(contract, actualTools, options); }
  toolAllowedByPolicy(toolPolicy, name) { return require("../role-contracts").toolAllowedByPolicy(toolPolicy, name); }
  run(input) { return require("../specialist-tools").runContained(input); }
  domain(input) { return require("../specialist-tools").runDomain(input); }
  guardMutation(input) { return require("../specialist-tools").guardMutation(input); }
}

class SubagentTasksAdapter {
  constructor(options) {
    this.enabled = options.enabled === true; this.disabledReason = "specialist-tasks-disabled";
    let policy = {};
    if (this.enabled && options.policyFile) {
      try { policy = require("../subagent-tasks").loadTaskPolicy(options.cwd, options.policyFile); }
      catch (error) { this.enabled = false; this.disabledReason = `task-policy:${error.code || "invalid"}`; }
    }
    this.service = this.enabled ? new (require("../subagent-tasks").SubagentTaskService)({ ...options, ...policy }) : null;
  }
  planningContext() { return this.enabled ? this.service.planningContext() : { ...noopResult("tasks.context"), reason: this.disabledReason }; }
  preflight(graph, options = {}) { if (!this.enabled) return { ...noopResult("tasks.preflight"), allowed: false, reasons: [this.disabledReason] };  const result = this.service.preflight(graph, options); return { allowed: result.allowed, graphDigest: result.graphDigest, reasons: result.reasons }; }
  run(graph, options) { if (!this.enabled) return noopResult("tasks.run"); return this.service.run(graph, options); }
  status(runId) { return this.enabled ? this.service.status(runId) : noopResult("tasks.status"); }
  cancel(runId) { return this.enabled ? this.service.cancel(runId) : noopResult("tasks.cancel"); }
  apply(input) { return this.enabled ? this.service.apply(input) : noopResult("tasks.apply"); }
  feedback(input) { return this.enabled ? this.service.feedback(input) : noopResult("tasks.feedback"); }
  evidence(input) { return this.enabled ? this.service.evidence(input.runId, input.taskId) : []; }
  capabilities() { return this.enabled ? this.service.capabilities() : { ...noopResult("tasks.capabilities"), reason: this.disabledReason, domains: require("../specialist-verifiers").domainCapabilities() }; }
  metrics() { return this.enabled ? this.service.metrics() : noopResult("tasks.metrics"); }
}

class SkillSynthesisAdapter {
  constructor({ enabled = true, storage = null, cwd = null, sink = new NullSink(), trace, memory, hermes = null, options = {} } = {}) {
    const projectCwd = options.cwd || cwd || process.cwd();
    storage ||= cwd ? new FileIntegrationStorage(path.join(cwd, ".pi", "cognitive-automation")) : new MemoryJsonStorage();
    this.enabled = enabled; this.storage = storage; this.sink = sink; this.cwd = projectCwd; this.hermes = hermes;
    this.store = options.store || new SkillStore({ storage, prefix: options.prefix || "skills" });
    this.engine = new SkillSynthesisEngine({ store: this.store, trace, memory, ...(options.engineOptions || {}) });
    if (this.enabled) {
      if (options.loadCurated !== false) this.engine.registerProvider({ ...curatedPiSkillPack(), silent: true });
      if (options.loadNative !== false) this.engine.registerProvider(nativeAgentSkillProvider({ cwd: options.cwd || process.cwd(), dirs: options.nativeDirs, silent: true }));
      for (const provider of options.providers || []) this.engine.registerProvider(provider);
    }
  }
  capture(input) { if (!this.enabled) return noopResult("skills.capture"); const r = this.engine.capture(input); this.sink.emit({ type: "skill.capture", captureId: r.captureId, outcome: r.outcome }); return r; }
  captureTopologyRun(run, extra) { if (!this.enabled) return noopResult("skills.captureTopologyRun"); return this.engine.captureTopologyRun(run, extra); }
  captureTrace(events, extra) { if (!this.enabled) return noopResult("skills.captureTrace"); return this.engine.captureTrace(events, extra); }
  captureSubagentResult(result, extra) { if (!this.enabled) return noopResult("skills.captureSubagentResult"); return this.engine.captureSubagentResult(result, extra); }
  captureGoalState(goal, extra) { if (!this.enabled) return noopResult("skills.captureGoalState"); return this.engine.captureGoalState(goal, extra); }
  captureExecutionOutcome(packet, extra) { if (!this.enabled) return noopResult("skills.captureExecutionOutcome"); return this.engine.captureExecutionOutcome(packet, extra); }
  captureReasoningReplay(replay, extra) { if (!this.enabled) return noopResult("skills.captureReasoningReplay"); return this.engine.captureReasoningReplay(replay, extra); }
  synthesize(options) { if (!this.enabled) return { ...noopResult("skills.synthesize"), skills: [], groups: [] }; return this.engine.synthesize(options); }
  async draftAgentSkill(skillId, options = {}) { if (!this.enabled) return noopResult("skills.draftAgentSkill"); if (!this.hermes) throw new Error("Hermes advisory adapter is unavailable for skill drafting"); if (options.userAuthorized !== true && options.automaticAuthorized !== true) { const error = new Error("Hermes Agent Skill drafting requires explicit current-user intent or a field-authorized automatic gate"); error.code = "HERMES_SKILL_DRAFT_UNAUTHORIZED"; throw error; } const prepared = this.engine.hermesDraftPacket(skillId); const result = await this.hermes.draftSkillCandidate(prepared.packet, { signal: options.signal, timeoutMs: options.timeoutMs, probeAuth: options.probeAuth === true, sessionHash: options.sessionHash }); const quarantined = quarantineHermesSkillCandidate({ cwd: this.cwd, skill: prepared.skill, captures: prepared.captures, draft: result.value, receipt: result.receipt }); this.store.recordMetric({ type: "skill.hermes_draft", skillId, candidateId: quarantined.candidateId, receiptId: result.receipt.receiptId, eligibility: prepared.eligibility, automatic: options.automaticAuthorized === true }); return { ...quarantined, receipt: result.receipt, eligibility: prepared.eligibility }; }
  promoteAgentSkill(candidateId, options = {}) { if (!this.enabled) return noopResult("skills.promoteAgentSkill"); return promoteHermesSkillCandidate({ cwd: this.cwd, candidateId, apply: options.apply === true, userApproved: options.userApproved === true }); }
  retrieve(query, options) { if (!this.enabled) return { ...noopResult("skills.retrieve"), skills: [], ranked: [] }; return this.engine.retrieve(query, options); }
  suggest(query, options) { if (!this.enabled) return { ...noopResult("skills.suggest"), suggestions: [] }; return this.engine.suggest(query, options); }
  injectPacket(skillOrId) { if (!this.enabled) return noopResult("skills.injectPacket"); return this.engine.injectPacket(skillOrId); }
  resolveExplicitInvocation(input) { return this.enabled ? this.engine.resolveExplicitInvocation(input) : []; }
  settlementOutcome(input) { return this.enabled ? this.engine.settlementOutcome(input) : null; }
  evaluate(skillId, evidence) { if (!this.enabled) return noopResult("skills.evaluate"); return this.engine.evaluate(skillId, evidence); }
  governance(skillId) { if (!this.enabled) return noopResult("skills.governance"); const skill = this.engine.getSkill(skillId); return skill ? { ...normalizeSkillGovernance(skill), topologyEligibility: topologyEligibility(skill) } : null; }
  listEvaluations(skillId, options = {}) { return this.enabled ? this.store.listMetrics({ type: "skill.evaluated", skillId, ...options }).map((row) => row.evaluation || row) : []; }
  approve(skillId, options) { if (!this.enabled) return noopResult("skills.approve"); return this.engine.approve(skillId, options); }
  deprecate(skillId, reason) { if (!this.enabled) return noopResult("skills.deprecate"); return this.engine.deprecate(skillId, reason); }
  rollback(skillId, version) { if (!this.enabled) return noopResult("skills.rollback"); return this.engine.rollback(skillId, version); }
  synthesizeTopologyTemplate(skillOrId) { if (!this.enabled) return noopResult("skills.synthesizeTopologyTemplate"); return this.engine.synthesizeTopologyTemplate(skillOrId); }
  replay(ref) { if (!this.enabled) return noopResult("skills.replay"); return this.engine.replay(ref); }
  compare(leftId, rightId) { if (!this.enabled) return noopResult("skills.compare"); return this.engine.compare(leftId, rightId); }
  abTest(skillId, task, baseline) { if (!this.enabled) return noopResult("skills.abTest"); return this.engine.abTest(skillId, task, baseline); }
  registerProvider(provider) { if (!this.enabled) return noopResult("skills.registerProvider"); return this.engine.registerProvider(provider); }
  doctor() { return this.enabled ? this.engine.doctor() : noopResult("skills.doctor"); }
  exportPacket() { return this.enabled ? this.engine.exportPacket() : noopResult("skills.exportPacket"); }
  importPacket(packet) { return this.enabled ? this.engine.importPacket(packet) : noopResult("skills.importPacket"); }
  compactEvents() { return this.enabled ? this.engine.compactEvents() : noopResult("skills.compactEvents"); }
  snapshot(options) { return this.enabled ? this.engine.snapshot(options) : noopResult("skills.snapshot"); }
  restoreSnapshot(snapshotId) { return this.enabled ? this.engine.restoreSnapshot(snapshotId) : noopResult("skills.restoreSnapshot"); }
  listSnapshots(args) { return this.enabled ? this.engine.listSnapshots(args) : []; }
  listSkills(args) { return this.enabled ? this.engine.listSkills(args) : []; }
  getSkill(id) { return this.enabled ? this.engine.getSkill(id) : null; }
  listCaptures(args) { return this.enabled ? this.engine.listCaptures(args) : []; }
  listFailurePatterns(args) { return this.enabled ? this.store.listFailurePatterns(args) : []; }
  status() { return this.enabled ? this.engine.status() : noopResult("skills.status"); }
  prune(options) { return this.enabled ? this.engine.prune(options) : noopResult("skills.prune"); }
  metrics() { return this.enabled ? this.engine.metrics() : noopResult("skills.metrics"); }
  compoundingRecords(options) { return this.enabled ? this.store.compoundingRecords(options) : { captures: [], skills: [], evaluations: [], failurePatterns: [], failureEvents: [] }; }
  recordFailurePatternOutcome(patternId, input) { return this.enabled ? this.store.recordFailurePatternOutcome(patternId, input) : noopResult("skills.recordFailurePatternOutcome"); }
  provenanceRecords({ limit = 200 } = {}) {
    if (!this.enabled) return { captures: [], skills: [], failurePatterns: [], evaluations: [] };
    const captures = this.store.listCaptures({ limit }).map((item) => ({ captureId: item.captureId, createdAt: item.createdAt, outcome: item.outcome, workflowSignature: item.workflowSignature, replayRefs: Object.fromEntries(Object.entries(item.replayRefs || {}).filter(([key]) => /(?:id|ref)$/i.test(key))), verification: { evidenceIds: (item.verification?.evidenceIds || item.verification?.evidenceRefs || []).slice(0, 64) }, provenance: { executionPacketId: item.provenance?.executionPacketId || null, packetId: item.provenance?.packetId || null, topologyRunId: item.provenance?.topologyRunId || null, evidenceIds: (item.provenance?.evidenceIds || []).slice(0, 64) } }));
    const skills = this.store.listSkills({ limit }).map((item) => ({ skillId: item.skillId, version: item.version, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, provenance: { captureIds: (item.provenance?.captureIds || []).slice(0, 64), sourceHash: item.provenance?.sourceHash || null }, evidenceState: item.evidenceState ? { sourceTrust: { status: item.evidenceState.sourceTrust?.status || "unknown" } } : null, versionHistory: (item.versionHistory || []).slice(-64).map((row) => ({ version: row.version })) }));
    const failurePatterns = this.store.listFailurePatterns({ limit }).map((item) => ({ patternId: item.patternId, signature: item.signature, linkedCaptureIds: (item.linkedCaptureIds || []).slice(0, 64), createdAt: item.createdAt }));
    return { captures, skills, failurePatterns, evaluations: this.store.listMetrics({ type: "skill.evaluated", limit }).map((row) => ({ skillId: row.skillId || row.evaluation?.skillId, version: row.version || row.evaluation?.version, evidenceIds: (row.evidenceIds || row.evaluation?.evidenceIds || []).slice(0, 64), at: row.at })) };
  }
}

module.exports = {
  SubagentAdapter,
  isCurrentRoleV2TopologyRun,
  summarizeTopologyRuns,
  MultiAgentTopologyAdapter,
  clearSpecialistRuntimeCache,
  SpecialistToolsAdapter,
  SubagentTasksAdapter,
  SkillSynthesisAdapter,
};
