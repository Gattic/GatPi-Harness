"use strict";

/**
 * Self-improving skill synthesis substrate.
 *
 * This module turns public, replayable execution artifacts (topology runs,
 * traces, verifier evidence, subagent/goal summaries) into governed procedural
 * skills.  It deliberately does not inspect or store private reasoning; skills
 * are reusable HOW-to-solve patterns with provenance, validation strategy,
 * versioning, retrieval scoring, failure learning, and rollback support.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_ROLE_CONTRACTS } = require("./role-contracts");
const { materializeRoleAwareTopology, validateRoleAwareTopology } = require("./role-topologies");
const { validateExecutionOutcomePacket } = require("./execution-outcome");
const { SKILL_GOVERNANCE_SCHEMA_VERSION, sha256: governanceSha256, applySkillGovernance, normalizeSkillEvaluation, applyEvaluation, approvalGate, setApproval, topologyEligibility } = require("./skill-governance");
const { scanMemoryContent } = require("./memory-content-scanner");

const SKILL_CATEGORIES = Object.freeze(["debugging", "refactor", "verification", "topology", "tool-use", "retrieval", "coordination", "documentation", "general"]);
const SKILL_STATUSES = Object.freeze(["draft", "candidate", "approved", "deprecated", "rolled_back", "rejected"]);
const CAPTURE_OUTCOMES = Object.freeze(["succeeded", "failed", "cancelled", "unknown"]);
const COMPOUNDING_EVIDENCE_CLASSES = new Set(["deterministic", "synthetic", "migration", "exact-version-field", "user-reviewed-gold"]);
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;

function nowIso() { return new Date().toISOString(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function shortHash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, 12); }
function uniq(xs) { return Array.from(new Set((xs || []).filter(Boolean).map(String))); }
function observedNumber(value) { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function arr(x) { return Array.isArray(x) ? x : x == null ? [] : [x]; }
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(Number(n)) ? Number(n) : 0)); }
function text(value) { return String(value == null ? "" : typeof value === "string" ? value : stableStringify(value)); }
function normalize(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9_./:-]+/g, " ").trim(); }
function tokens(s) { return normalize(s).split(/\s+/).filter(Boolean); }
function overlap(a, b) {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit / Math.sqrt(A.size * B.size);
}
function ensureOneOf(kind, value, allowed) { if (!allowed.includes(value)) throw new Error(`invalid ${kind}: ${value}`); return value; }
function safeError(error) { return { message: error?.message || String(error), name: error?.name || "Error", code: error?.code }; }

function workflowSignature({ toolSequence = [], workflowSteps = [], topology = null } = {}) {
  const tools = toolSequence.map((t) => t.tool || t.name || t.toolName).filter(Boolean).join(">");
  const steps = workflowSteps.map((s) => s.kind || s.role || s.name || s.description).filter(Boolean).join(">");
  const topo = topology?.topologyId || topology?.id || "";
  return shortHash(`${topo}|${tools}|${steps}`);
}

class ExecutionCapture {
  constructor(input = {}) {
    const at = input.createdAt || nowIso();
    const outcome = input.outcome || (input.status === "succeeded" ? "succeeded" : input.status === "failed" ? "failed" : "unknown");
    ensureOneOf("capture outcome", outcome, CAPTURE_OUTCOMES);
    this.captureId = input.captureId || `cap_${shortHash({ task: input.task || input.prompt, at, source: input.source, runId: input.runId || input.topologyRunId })}`;
    this.createdAt = at;
    this.updatedAt = input.updatedAt || at;
    this.source = input.source || "manual";
    this.task = String(input.task || input.prompt || input.objective || "").slice(0, 2000);
    this.repository = clone(input.repository || {});
    this.contextRefs = clone(input.contextRefs || []);
    this.prompt = input.prompt ? String(input.prompt).slice(0, 4000) : null;
    this.topology = clone(input.topology || null);
    this.agentTopology = clone(input.agentTopology || input.topology || null);
    this.toolSequence = arr(input.toolSequence).map((t, i) => ({ index: i, tool: t.tool || t.name || t.toolName || "unknown", ok: t.ok !== false, inputShape: t.inputShape || Object.keys(t.input || t.args || {}).sort(), summary: String(t.summary || t.result || "").slice(0, 500), durationMs: Number(t.durationMs || t.duration_ms || 0) }));
    this.workflowSteps = arr(input.workflowSteps).map((s, i) => ({ id: s.id || `step-${i + 1}`, index: i, kind: s.kind || s.role || s.type || "step", description: String(s.description || s.task || s.summary || s.content || "").slice(0, 1000), status: s.status || "unknown", role: s.role || s.roleId || null }));
    this.reasoningArtifactIds = uniq(input.reasoningArtifactIds || []);
    this.verification = clone(input.verification || {});
    this.failures = arr(input.failures || input.errors).map((e) => typeof e === "string" ? { message: e } : clone(e));
    this.retries = Number(input.retries || 0);
    this.metrics = { latencyMs: 0, tokenUsage: {}, toolCalls: this.toolSequence.length, modelCalls: 0, verificationOk: this.verification.ok === true, ...(input.metrics || {}) };
    this.outcome = outcome;
    this.finalOutcome = String(input.finalOutcome || input.summary || "").slice(0, 2000);
    this.replayRefs = clone(input.replayRefs || {});
    this.provenance = { source: this.source, ...(input.provenance || {}) };
    this.redaction = clone(input.redaction || { privateReasoningStored: false, transcriptStored: false });
    this.workflowSignature = input.workflowSignature || workflowSignature(this);
    this.score = input.score == null ? scoreExecutionCapture(this) : Number(input.score);
  }
  toJSON() { return { ...this }; }
}

class Skill {
  constructor(input = {}) {
    const at = input.createdAt || nowIso();
    const category = input.category || inferCategory(`${input.name || ""}\n${input.description || ""}\n${arr(input.domainTags).join(" ")}`);
    ensureOneOf("skill category", category, SKILL_CATEGORIES);
    ensureOneOf("skill status", input.status || "draft", SKILL_STATUSES);
    this.skillId = input.skillId || `skill_${shortHash({ name: input.name, category, trigger: input.triggerConditions, at })}`;
    this.version = Number(input.version || 1);
    this.status = input.status || "draft";
    this.name = String(input.name || "Untitled skill").slice(0, 160);
    this.description = String(input.description || "").slice(0, 2000);
    this.category = category;
    this.triggerConditions = arr(input.triggerConditions).map(String);
    this.domainTags = uniq(input.domainTags || []);
    this.applicableRepositories = uniq(input.applicableRepositories || []);
    this.requiredTools = uniq(input.requiredTools || []);
    this.requiredContext = arr(input.requiredContext).map(String);
    this.workflowSteps = arr(input.workflowSteps).map((s, i) => ({ id: s.id || `step-${i + 1}`, order: s.order ?? i + 1, kind: s.kind || "action", description: String(s.description || s.task || s.summary || s).slice(0, 1200), role: s.role || null, tools: uniq(s.tools || []) }));
    this.executionGraph = clone(input.executionGraph || { nodes: this.workflowSteps.map((s) => ({ id: s.id, label: s.kind, role: s.role })), edges: [] });
    this.expectedOutputs = arr(input.expectedOutputs).map(String);
    this.validationStrategy = clone(input.validationStrategy || { kind: "evidence", requiredEvidence: ["verification"], commands: [], rollback: "manual" });
    this.confidenceScore = clamp01(input.confidenceScore ?? 0.5);
    this.successMetrics = clone(input.successMetrics || { attempts: 0, successes: 0, failures: 0, successRate: 0, meanLatencyMs: 0, meanToolCalls: 0 });
    this.failurePatterns = arr(input.failurePatterns).map((f) => typeof f === "string" ? { signature: f } : clone(f));
    this.provenance = { createdAt: at, captureIds: uniq(input.provenance?.captureIds || input.captureIds || []), sources: uniq(input.provenance?.sources || [input.source || "synthesis"]), ...(input.provenance || {}) };
    this.examples = arr(input.examples).map((e) => typeof e === "string" ? { task: e } : clone(e));
    this.historicalEffectiveness = clone(input.historicalEffectiveness || { uses: 0, accepted: 0, rejected: 0, lastUsedAt: null, score: this.confidenceScore });
    this.versionHistory = clone(input.versionHistory || [{ version: this.version, at, change: input.change || "initial", skillHash: shortHash({ name: this.name, steps: this.workflowSteps }) }]);
    this.governance = clone(input.governance || { approval: "draft", minConfidence: 0.65, sandboxRequired: true, rollbackToVersion: null, unsafe: false });
    this.createdAt = at;
    this.updatedAt = input.updatedAt || at;
    this.governanceSchemaVersion = Number(input.governanceSchemaVersion || 1);
    this.evidenceState = clone(input.evidenceState || null);
    this.approvals = clone(input.approvals || null);
    applySkillGovernance(this);
  }
  toJSON() { return { ...this }; }
}

class FailurePattern {
  constructor(input = {}) {
    const at = input.createdAt || nowIso();
    this.patternId = input.patternId || `failpat_${shortHash({ signature: input.signature, at })}`;
    this.signature = input.signature || shortHash(input.symptoms || input.failures || input);
    this.symptoms = arr(input.symptoms).map(String);
    this.likelyCauses = arr(input.likelyCauses).map(String);
    this.badToolSequences = arr(input.badToolSequences).map((s) => Array.isArray(s) ? s : String(s).split(/>/));
    this.mitigationStrategy = String(input.mitigationStrategy || "Inspect failure evidence, reduce scope, rerun verification.");
    this.linkedCaptureIds = uniq(input.linkedCaptureIds || input.captureIds || []);
    this.confidence = clamp01(input.confidence ?? 0.45);
    this.createdAt = at;
    this.updatedAt = input.updatedAt || at;
    this.provenance = clone(input.provenance || {});
  }
  toJSON() { return { ...this }; }
}

function inferCategory(raw) {
  const s = normalize(raw);
  if (/debug|fail|error|test|bug|fix/.test(s)) return "debugging";
  if (/refactor|rename|cleanup|extract/.test(s)) return "refactor";
  if (/verify|test|lint|compile|benchmark/.test(s)) return "verification";
  if (/topology|planner|coder|reviewer|agent|coordinate/.test(s)) return "topology";
  if (/tool|bash|edit|write|read/.test(s)) return "tool-use";
  if (/memory|retrieve|search|recall/.test(s)) return "retrieval";
  if (/doc|readme/.test(s)) return "documentation";
  return "general";
}

function scoreExecutionCapture(capture) {
  const verification = capture.verification?.ok === true || capture.metrics?.verificationOk ? 1 : capture.outcome === "succeeded" ? 0.75 : 0;
  const retryPenalty = clamp01(1 - (capture.retries || 0) / 5);
  const failurePenalty = clamp01(1 - (capture.failures?.length || 0) / 5);
  const toolEfficiency = clamp01(1 / (1 + Math.max(0, (capture.toolSequence?.length || 0) - 6) / 10));
  const latency = Number(capture.metrics?.latencyMs || 0);
  const latencyEfficiency = latency ? clamp01(1 / (1 + latency / 300000)) : 0.8;
  return clamp01(0.44 * verification + 0.18 * retryPenalty + 0.16 * failurePenalty + 0.12 * toolEfficiency + 0.10 * latencyEfficiency);
}

function captureFromTopologyRun(run = {}, extra = {}) {
  const workflowSteps = (run.results || []).map((r) => ({ id: r.nodeId || r.agentId, kind: "agent", role: r.role, description: r.summary || r.content, status: r.status }));
  const toolSequence = (run.trace || []).filter((e) => e.type === "topology.tool_call" || e.name === "topology.tool_call" || e.payload?.tool).map((e) => ({ tool: e.tool || e.payload?.tool, ok: e.severity !== "error", summary: e.type || e.name }));
  const errors = run.errors || [];
  return new ExecutionCapture({ source: "topology-run", runId: run.runId, topologyRunId: run.runId, task: run.input?.task || extra.task || run.topologyId, topology: { topologyId: run.topologyId }, workflowSteps, toolSequence, failures: errors, retries: (run.results || []).reduce((n, r) => n + Math.max(0, Number(r.attempts || 1) - 1), 0), metrics: { latencyMs: run.durationMs, toolCalls: toolSequence.length }, outcome: run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "unknown", finalOutcome: run.aggregation?.summary || run.aggregation?.content || run.status, replayRefs: { topologyRunId: run.runId }, provenance: { source: "topology-run", runId: run.runId }, ...extra });
}

function captureFromTrace(events = [], extra = {}) {
  const toolEvents = events.filter((e) => ["tool_exposure", "shell_execution", "file_edit"].includes(e.category) && /tool_call|user_bash|execution/.test(e.name || ""));
  const failures = events.filter((e) => e.category === "failure_state" || e.severity === "error" || e.severity === "fatal");
  const verificationEvents = events.filter((e) => e.category === "verifier_result" || /verifier|verification/.test(e.name || ""));
  const firstPrompt = events.find((e) => e.category === "prompt_assembly")?.payload?.prompt;
  const toolSequence = toolEvents.map((e) => ({ tool: e.payload?.toolName || e.payload?.tool || e.name, ok: e.severity !== "error", summary: e.name, durationMs: e.duration_ms || e.durationMs }));
  return new ExecutionCapture({ source: "trace", task: extra.task || firstPrompt || "trace execution", prompt: firstPrompt, toolSequence, workflowSteps: events.filter((e) => ["prompt_assembly", "agent_branching", "verifier_result"].includes(e.category)).map((e, i) => ({ id: e.event_id || e.id || `event-${i}`, kind: e.category, description: e.name, status: e.severity === "error" ? "failed" : "succeeded" })), verification: { ok: verificationEvents.length ? !verificationEvents.some((e) => e.severity === "error" || e.payload?.ok === false) : undefined, events: verificationEvents.length }, failures, retries: events.filter((e) => e.category === "retry").length, metrics: { latencyMs: events.reduce((n, e) => n + Number(e.duration_ms || e.durationMs || 0), 0), toolCalls: toolSequence.length }, outcome: failures.length ? "failed" : "succeeded", replayRefs: { correlationId: events[0]?.correlation_id }, provenance: { source: "trace", eventCount: events.length }, ...extra });
}

function captureFromSubagentResult(result = {}, extra = {}) {
  const diagnostics = result.diagnostics || {};
  return new ExecutionCapture({
    source: "subagent-result",
    task: result.task || extra.task || result.summary || "subagent task",
    workflowSteps: [{ id: result.subagent_id || "subagent", kind: "subagent", role: result.role, description: result.summary || result.final_response || result.task || "subagent result", status: result.status || "unknown" }],
    toolSequence: [],
    failures: ["failed", "timed_out", "cancelled"].includes(result.status) ? diagnostics.errors || [{ message: result.status }] : [],
    retries: Number(diagnostics.retries || 0),
    metrics: { latencyMs: diagnostics.duration_ms || diagnostics.durationMs || 0, toolCalls: diagnostics.tool_calls || diagnostics.toolCalls || 0, modelCalls: diagnostics.model_calls || diagnostics.modelCalls || 0, tokenUsage: diagnostics.token_usage || diagnostics.tokenUsage || {} },
    outcome: result.status === "succeeded" ? "succeeded" : ["failed", "timed_out", "cancelled"].includes(result.status) ? "failed" : "unknown",
    finalOutcome: result.summary || result.final_response || "",
    replayRefs: { subagentId: result.subagent_id, branchId: result.branch_id },
    provenance: { source: "subagent-result", subagentId: result.subagent_id },
    ...extra,
  });
}

function captureFromGoalState(goal = {}, extra = {}) {
  const history = goal.history || [];
  const observations = goal.observations || [];
  return new ExecutionCapture({
    source: "goal-run",
    task: goal.goal || extra.task || "autonomous goal",
    workflowSteps: history.map((h, i) => ({ id: `goal-${i + 1}`, kind: "goal-iteration", description: h.nextPrompt || h.status || JSON.stringify(h).slice(0, 400), status: h.status || "unknown" })),
    toolSequence: history.filter((h) => h.executed || h.nextPrompt).map((h) => ({ tool: "pi-turn", ok: h.status !== "failed", summary: h.nextPrompt || h.status })),
    failures: goal.status === "failed" || goal.status === "blocked" ? [{ message: goal.status, observations: observations.slice(-3) }] : [],
    retries: Math.max(0, Number(goal.iteration || history.length || 0) - 1),
    metrics: { toolCalls: history.length, latencyMs: 0 },
    outcome: goal.status === "completed" ? "succeeded" : ["failed", "blocked", "cancelled"].includes(goal.status) ? "failed" : "unknown",
    finalOutcome: observations.at?.(-1) || goal.status || "",
    replayRefs: { goalId: goal.id },
    provenance: { source: "goal-run", goalId: goal.id },
    ...extra,
  });
}

function captureFromExecutionOutcome(input = {}, extra = {}) {
  const validation = validateExecutionOutcomePacket(input);
  if (!validation.ok) throw new Error(`invalid execution outcome capture: ${validation.issues.join("; ")}`);
  const packet = validation.packet;
  const captureOutcome = packet.outcome === "succeeded" ? "succeeded" : packet.outcome === "cancelled" ? "cancelled" : packet.outcome === "not-applicable" || packet.outcome === "unknown" ? "unknown" : "failed";
  const failed = captureOutcome === "failed";
  return new ExecutionCapture({
    captureId: `cap_exec_${packet.packetId.slice("execout_".length)}`,
    createdAt: packet.settledAt,
    source: "execution-outcome",
    task: packet.task.hash,
    prompt: null,
    contextRefs: packet.evidenceRefs,
    workflowSteps: packet.workflow.steps.map((step, index) => ({ id: `execution-${index + 1}`, kind: step.kind, role: step.role, description: `${step.kind}:${step.status}`, status: step.status })),
    toolSequence: packet.workflow.toolNames.map((tool) => ({ tool, ok: !failed, inputShape: [], summary: "settled-execution-metadata" })),
    verification: { ok: packet.outcome === "succeeded" && packet.evidenceRefs.length > 0 ? true : undefined, evidenceIds: packet.evidenceRefs, artifactIds: packet.artifactRefs.map((artifact) => artifact.id) },
    failures: failed ? [{ message: packet.outcome }] : [],
    retries: packet.workflow.retries,
    metrics: { latencyMs: packet.metrics.durationMs, toolCalls: packet.metrics.toolCalls, modelCalls: packet.metrics.modelCalls },
    outcome: captureOutcome,
    finalOutcome: [packet.outcome, ...packet.reasonCodes].join(":"),
    replayRefs: { executionOutcomePacketId: packet.packetId, sourceRunId: packet.source.runId },
    provenance: { source: "execution-outcome", packetId: packet.packetId, sourceKind: packet.source.kind, sourceRecordHash: packet.source.sourceRecordHash, projectKeyHash: packet.provenance.projectKeyHash },
    redaction: { privateReasoningStored: false, transcriptStored: false, promptStored: false, assistantOutputStored: false, commandArgumentsStored: false },
    ...extra,
  });
}

function captureFromReasoningReplay(replay = [], extra = {}) {
  const failures = replay.filter((r) => r.type === "failure_analysis" || /fail/i.test(r.summary || ""));
  const verifiers = replay.filter((r) => /verifier/.test(r.type || ""));
  return new ExecutionCapture({
    source: "reasoning-replay",
    task: extra.task || replay.find((r) => r.type === "plan")?.summary || "reasoning artifact timeline",
    workflowSteps: replay.map((r, i) => ({ id: r.id || `reason-${i + 1}`, kind: r.type || "artifact", description: r.summary || r.id || "artifact", status: failures.includes(r) ? "failed" : "succeeded" })),
    verification: { ok: verifiers.length ? !verifiers.some((v) => v.ok === false) : undefined, artifacts: verifiers.map((v) => v.id) },
    failures,
    metrics: { toolCalls: 0, modelCalls: 0 },
    outcome: failures.length ? "failed" : "succeeded",
    replayRefs: { reasoningReplay: true },
    provenance: { source: "reasoning-replay", artifacts: replay.map((r) => r.id).filter(Boolean) },
    ...extra,
  });
}

function skillFromCaptures(captures = [], input = {}) {
  const sorted = captures.slice().sort((a, b) => b.score - a.score);
  const best = sorted[0];
  if (!best) throw new Error("skill synthesis requires at least one capture");
  const allText = captures.map((c) => `${c.task}\n${c.finalOutcome}\n${c.workflowSteps.map((s) => s.description).join("\n")}`).join("\n");
  const requiredTools = uniq(captures.flatMap((c) => c.toolSequence.map((t) => t.tool))).filter((t) => t !== "unknown");
  const steps = compressWorkflowSteps(captures);
  const successes = captures.filter((c) => c.outcome === "succeeded").length;
  const failures = captures.length - successes;
  const category = input.category || inferCategory(`${allText}\n${requiredTools.join(" ")}`);
  const validationCommands = uniq(captures.flatMap((c) => c.verification?.commands || c.verification?.command || []).map(String));
  return new Skill({
    name: input.name || nameFromCapture(best, category),
    description: input.description || `Reusable ${category} workflow synthesized from ${captures.length} execution capture(s).`,
    category,
    status: input.status || (successes > 0 ? "candidate" : "draft"),
    triggerConditions: input.triggerConditions || deriveTriggers(captures, category),
    domainTags: input.domainTags || uniq([category, ...tokens(allText).filter((t) => t.length > 4).slice(0, 10)]),
    applicableRepositories: input.applicableRepositories || uniq(captures.map((c) => c.repository?.name || c.repository?.path || c.provenance?.cwd).filter(Boolean)),
    requiredTools,
    requiredContext: input.requiredContext || ["task objective", "relevant files", successes ? "verification evidence" : "failure evidence"],
    workflowSteps: steps,
    executionGraph: graphFromSteps(steps, best.topology),
    expectedOutputs: input.expectedOutputs || ["implemented change or actionable result", "verification evidence", "concise summary"],
    validationStrategy: input.validationStrategy || { kind: "verification-sequence", requiredEvidence: ["tests-or-equivalent"], commands: validationCommands, rollback: "use branch/session rollback before unsafe mutation" },
    confidenceScore: clamp01(0.25 + 0.45 * (successes / captures.length) + 0.20 * (captures.reduce((n, c) => n + c.score, 0) / captures.length) + 0.10 * Math.min(1, captures.length / 3)),
    successMetrics: { attempts: captures.length, successes, failures, successRate: captures.length ? successes / captures.length : 0, meanLatencyMs: avg(captures.map((c) => c.metrics.latencyMs || 0)), meanToolCalls: avg(captures.map((c) => c.toolSequence.length)) },
    failurePatterns: input.failurePatterns || extractFailurePatterns(captures).map((p) => ({ patternId: p.patternId, signature: p.signature, mitigationStrategy: p.mitigationStrategy })),
    provenance: { captureIds: captures.map((c) => c.captureId), sources: uniq(captures.map((c) => c.source)), synthesizedAt: nowIso(), workflowSignatures: uniq(captures.map((c) => c.workflowSignature)) },
    examples: captures.slice(0, 3).map((c) => ({ captureId: c.captureId, task: c.task, outcome: c.outcome, score: c.score })),
    ...input,
  });
}

function avg(xs) { const ys = xs.filter((x) => Number.isFinite(Number(x))).map(Number); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0; }
function nameFromCapture(c, category) { const base = String(c.task || c.topology?.topologyId || `${category} workflow`).replace(/\s+/g, " ").trim(); return `${category}: ${base.slice(0, 80)}`; }
function deriveTriggers(captures, category) { return uniq([category, ...captures.map((c) => c.task).filter(Boolean).slice(0, 3)]).map((x) => `Task resembles: ${x}`); }
function compressWorkflowSteps(captures) {
  const seen = new Set(); const out = [];
  for (const c of captures) {
    const steps = c.workflowSteps.length ? c.workflowSteps : c.toolSequence.map((t) => ({ kind: "tool", description: `Use ${t.tool}`, tools: [t.tool] }));
    for (const s of steps) {
      const key = normalize(`${s.kind}:${s.role}:${s.description}`).slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: s.kind || "step", role: s.role || null, description: s.description || s.summary || key, tools: uniq(s.tools || (s.kind === "tool" ? [s.tool] : [])) });
      if (out.length >= 12) return out;
    }
  }
  return out.length ? out : [{ kind: "plan", description: "Inspect context and define a minimal verified path" }, { kind: "execute", description: "Apply the reusable workflow" }, { kind: "verify", description: "Collect evidence before completion" }];
}
function graphFromSteps(steps, topology) { return { topologyId: topology?.topologyId || null, nodes: steps.map((s, i) => ({ id: s.id || `step-${i + 1}`, label: s.kind, role: s.role, tools: s.tools })), edges: steps.slice(1).map((s, i) => ({ source: steps[i].id || `step-${i + 1}`, target: s.id || `step-${i + 2}`, condition: "ok" })) }; }

function extractFailurePatterns(captures = []) {
  const failed = captures.filter((c) => c.outcome === "failed" || c.failures.length);
  const groups = new Map();
  for (const c of failed) {
    const sig = shortHash(`${c.toolSequence.map((t) => t.tool).join(">")}|${c.failures.map((f) => f.message || f.name || f.code).join("|")}`);
    const xs = groups.get(sig) || []; xs.push(c); groups.set(sig, xs);
  }
  return Array.from(groups.entries()).map(([signature, xs]) => new FailurePattern({ signature, symptoms: uniq(xs.flatMap((c) => c.failures.map((f) => f.message || f.name || f.code || "failure"))).slice(0, 6), likelyCauses: ["tool error", "verification failure", "insufficient context"], badToolSequences: uniq(xs.map((c) => c.toolSequence.map((t) => t.tool).join(">"))).map((s) => s.split(">")), mitigationStrategy: "Inspect failing evidence, reduce scope, repair the first failing step, and rerun validation before reusing this workflow.", linkedCaptureIds: xs.map((c) => c.captureId), confidence: clamp01(0.35 + xs.length / 5), provenance: { source: "failure-learning" } }));
}

class SkillStore {
  constructor({ storage, prefix = "skills" } = {}) { this.storage = storage; this.prefix = prefix; }
  key(...parts) { return [this.prefix, ...parts].join("/"); }
  saveCapture(capture) { const c = capture instanceof ExecutionCapture ? capture : new ExecutionCapture(capture); this.storage.writeJson(this.key("captures", c.captureId), c); this.storage.appendJsonl(this.key("captures"), { captureId: c.captureId, at: c.createdAt, source: c.source, outcome: c.outcome, score: c.score, workflowSignature: c.workflowSignature, task: c.task.slice(0, 240) }); return clone(c); }
  getCapture(id) { const c = this.storage.readJson(this.key("captures", id), null); return c ? new ExecutionCapture(c) : null; }
  listCaptures({ outcome, source, limit = 100 } = {}) {
    const rows = this.storage.readJsonl(this.key("captures"));
    const seen = new Set();
    const latestRows = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const captureId = rows[i]?.captureId;
      if (!captureId || seen.has(captureId)) continue;
      seen.add(captureId);
      latestRows.push(rows[i]);
    }
    const captures = latestRows.reverse().map((r) => this.getCapture(r.captureId)).filter(Boolean)
      .filter((c) => (!outcome || c.outcome === outcome) && (!source || c.source === source));
    return Number.isFinite(limit) ? captures.slice(-limit) : captures;
  }
  saveSkill(skill, { version = true } = {}) { const s = skill instanceof Skill ? skill : new Skill(skill); const existed = !!this.storage.readJson?.(this.key("records", s.skillId), null); this.storage.writeJson(this.key("records", s.skillId), s); this.storage.appendJsonl(this.key("events"), { at: nowIso(), type: version || !existed ? "skill.saved" : "skill.updated", skillId: s.skillId, version: s.version, status: s.status }); if (version) this.storage.writeJson(this.key("versions", s.skillId, String(s.version)), s); return clone(s); }
  getSkill(id) { const s = this.storage.readJson(this.key("records", id), null); return s ? new Skill(s) : null; }
  listSkills({ status, category, limit = 100 } = {}) { const out = []; const rows = this.storage.readJsonl(this.key("events")).filter((e) => e.type === "skill.saved"); const ids = uniq(rows.map((e) => e.skillId)); for (const id of ids) { const s = this.getSkill(id); if (!s) continue; if (status && s.status !== status) continue; if (category && s.category !== category) continue; out.push(s); } out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); return Number.isFinite(limit) ? out.slice(0, limit) : out; }
  saveFailurePattern(pattern) {
    const incoming = pattern instanceof FailurePattern ? pattern : new FailurePattern(pattern);
    const existing = this.listFailurePatterns({ limit: Infinity }).find((item) => item.signature === incoming.signature);
    const p = existing ? new FailurePattern({ ...existing.toJSON(), linkedCaptureIds: uniq([...(existing.linkedCaptureIds || []), ...(incoming.linkedCaptureIds || [])]), confidence: Math.max(existing.confidence, incoming.confidence), updatedAt: nowIso() }) : incoming;
    this.storage.writeJson(this.key("failure-patterns", p.patternId), p);
    this.storage.appendJsonl(this.key("events"), { at: nowIso(), type: existing ? "failure_pattern.matched" : "failure_pattern.saved", patternId: p.patternId, signature: p.signature });
    this.recordMetric({ type: existing ? "failure_pattern.matched" : "failure_pattern.discovered", patternId: p.patternId, linkedCaptureCount: p.linkedCaptureIds.length, newLinkedCaptures: existing ? p.linkedCaptureIds.filter((id) => !(existing.linkedCaptureIds || []).includes(id)).length : p.linkedCaptureIds.length, evidenceClass: "deterministic" });
    return clone(p);
  }
  recordFailurePatternOutcome(patternId, input = {}) {
    const pattern = this.listFailurePatterns({ limit: Infinity }).find((item) => item.patternId === patternId);
    if (!pattern) throw new Error(`failure pattern not found: ${patternId}`);
    const result = input.result === "succeeded" ? "succeeded" : input.result === "failed" ? "failed" : "unknown";
    const evidenceIds = uniq(input.evidenceIds || []).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(id))).slice(0, 64);
    const requestedClass = COMPOUNDING_EVIDENCE_CLASSES.has(input.evidenceClass) ? input.evidenceClass : "deterministic";
    const sessionIdHash = SHA256_ID.test(String(input.sessionIdHash || "")) ? String(input.sessionIdHash) : null;
    const evidenceClass = requestedClass === "exact-version-field" && (!sessionIdHash || !evidenceIds.length) ? "deterministic" : requestedClass;
    const row = { type: "failure_pattern.post_mitigation", patternId, mitigationReused: input.mitigationReused === true, result, captureId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(input.captureId || "")) ? String(input.captureId) : null, evidenceClass, sessionIdHash: evidenceClass === "exact-version-field" ? sessionIdHash : null, evidenceIds };
    this.recordMetric(row);
    return clone(row);
  }
  listFailurePatterns({ limit = 100 } = {}) { const ids = uniq(this.storage.readJsonl(this.key("events")).filter((e) => e.type === "failure_pattern.saved").map((e) => e.patternId)); const xs = ids.map((id) => this.storage.readJson(this.key("failure-patterns", id), null)).filter(Boolean).map((p) => new FailurePattern(p)); return Number.isFinite(limit) ? xs.slice(-limit) : xs; }
  eventStats() { const events = this.storage.readJsonl(this.key("events")); const saved = events.filter((e) => e.type === "skill.saved"); const counts = {}; for (const e of saved) counts[e.skillId] = (counts[e.skillId] || 0) + 1; return { events: events.length, skillSaved: saved.length, duplicateSaved: Object.entries(counts).filter(([, n]) => n > 1).map(([skillId, count]) => ({ skillId, count })) }; }
  compactEvents() { if (!this.storage.writeJsonl) return { compacted: false, reason: "storage does not support writeJsonl" }; const events = this.storage.readJsonl(this.key("events")); const latestSaved = new Map(); const others = []; for (const e of events) { if (e.type === "skill.saved") latestSaved.set(e.skillId, e); else others.push(e); } const compacted = [...latestSaved.values(), ...others].sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))); this.storage.writeJsonl(this.key("events"), compacted); return { compacted: true, before: events.length, after: compacted.length, removed: events.length - compacted.length }; }
  recordMetric(event) { this.storage.appendJsonl(this.key("metrics"), { at: event?.at || nowIso(), ...event }); }
  listMetrics({ type, skillId, limit = 1000 } = {}) { const rows = (this.storage.readJsonl(this.key("metrics")) || []).filter((row) => (!type || row.type === type) && (!skillId || row.skillId === skillId)); return Number.isFinite(limit) ? rows.slice(-limit) : rows; }
  compoundingRecords({ limit = 1000 } = {}) {
    const captures = this.listCaptures({ limit }).map((item) => ({ captureId: item.captureId, source: item.source, outcome: item.outcome, verificationOk: item.verification?.ok === true || item.metrics?.verificationOk === true, evidenceIds: uniq(item.verification?.evidenceIds || item.verification?.evidenceRefs || item.provenance?.evidenceIds || []).slice(0, 64), metrics: { latencyMs: observedNumber(item.metrics?.latencyMs), toolCalls: observedNumber(item.metrics?.toolCalls), modelCalls: observedNumber(item.metrics?.modelCalls), contextAdded: observedNumber(item.metrics?.contextAdded) }, createdAt: item.createdAt }));
    const skills = this.listSkills({ limit }).map((item) => ({ skillId: item.skillId, version: item.version, status: item.status, sourceHash: item.evidenceState?.sourceTrust?.sourceHash, sourceTrust: item.evidenceState?.sourceTrust?.status, captureIds: uniq(item.provenance?.captureIds || []).slice(0, 64), field: { status: item.evidenceState?.field?.status || "insufficient-data", exactVersionUses: Number(item.evidenceState?.field?.exactVersionUses || 0), observedDays: Number(item.evidenceState?.field?.observedDays || 0), independentSessions: Number(item.evidenceState?.field?.independentSessions || 0) }, approvals: { ...(item.approvals || {}) } }));
    const evaluations = this.listMetrics({ type: "skill.evaluated", limit }).map((row) => ({ ...(row.evaluation || row) }));
    const failurePatterns = this.listFailurePatterns({ limit }).map((item) => ({ patternId: item.patternId, signature: item.signature, linkedCaptureIds: uniq(item.linkedCaptureIds || []).slice(0, 64), createdAt: item.createdAt }));
    const failureEvents = this.listMetrics({ limit }).filter((row) => String(row.type || "").startsWith("failure_pattern.")).map((row) => ({ type: row.type, patternId: row.patternId, linkedCaptureCount: Number(row.linkedCaptureCount || 0), newLinkedCaptures: Number(row.newLinkedCaptures || 0), mitigationReused: row.mitigationReused === true, result: row.result || null, captureId: row.captureId || null, evidenceClass: COMPOUNDING_EVIDENCE_CLASSES.has(row.evidenceClass) ? row.evidenceClass : "deterministic", sessionIdHash: SHA256_ID.test(String(row.sessionIdHash || "")) ? row.sessionIdHash : null, evidenceIds: uniq(row.evidenceIds || []).slice(0, 64), at: row.at }));
    return { captures, skills, evaluations, failurePatterns, failureEvents };
  }
  metrics() { const skills = this.listSkills({ limit: Infinity }); const captures = this.listCaptures({ limit: Infinity }); const byStatus = {}; const byCategory = {}; const byFieldStatus = {}; const approvals = { advisoryRetrieval: {}, routing: {}, publishing: {} }; for (const s of skills) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; byCategory[s.category] = (byCategory[s.category] || 0) + 1; const field = s.evidenceState?.field?.status || "insufficient-data"; byFieldStatus[field] = (byFieldStatus[field] || 0) + 1; for (const scope of Object.keys(approvals)) { const value = s.approvals?.[scope] || "unknown"; approvals[scope][value] = (approvals[scope][value] || 0) + 1; } } return { governanceSchemaVersion: SKILL_GOVERNANCE_SCHEMA_VERSION, governanceMode: process.env.PI_SKILL_GOVERNANCE_V2 === "0" ? "legacy-ranking" : "v2", skills: skills.length, captures: captures.length, failurePatterns: this.listFailurePatterns({ limit: Infinity }).length, byStatus, byCategory, byFieldStatus, approvals, approved: byStatus.approved || 0, fieldProven: byFieldStatus["field-proven"] || 0, meanConfidence: avg(skills.map((s) => s.confidenceScore)) }; }
  rollback(skillId, version) { const old = this.storage.readJson(this.key("versions", skillId, String(version)), null); if (!old) throw new Error(`skill version not found: ${skillId}@${version}`); const current = this.getSkill(skillId); const restored = new Skill({ ...old, version: (current?.version || old.version || 1) + 1, status: "rolled_back", updatedAt: nowIso(), versionHistory: [...(current?.versionHistory || old.versionHistory || []), { version: (current?.version || old.version || 1) + 1, at: nowIso(), change: `rollback to version ${version}`, skillHash: shortHash(old) }], governance: { ...(old.governance || {}), rollbackToVersion: version } }); return this.saveSkill(restored); }
  prune({ keepSkills = 100, keepCaptures = 300, minConfidence = 0.05, pruneDrafts = true } = {}) { const skills = this.listSkills({ limit: Infinity }).sort((a, b) => (b.confidenceScore - a.confidenceScore) || String(b.updatedAt).localeCompare(String(a.updatedAt))); const captures = this.listCaptures({ limit: Infinity }).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))); const prunedSkills = []; const prunedCaptures = []; for (const s of skills.slice(keepSkills)) if (s.status !== "approved") { this.storage.deleteJson?.(this.key("records", s.skillId)); prunedSkills.push(s.skillId); } for (const s of skills) if (pruneDrafts && s.status === "draft" && s.confidenceScore < minConfidence) { this.storage.deleteJson?.(this.key("records", s.skillId)); prunedSkills.push(s.skillId); } for (const c of captures.slice(keepCaptures)) { this.storage.deleteJson?.(this.key("captures", c.captureId)); prunedCaptures.push(c.captureId); } this.storage.appendJsonl(this.key("events"), { at: nowIso(), type: "skill.pruned", prunedSkills, prunedCaptures }); return { prunedSkills: uniq(prunedSkills), prunedCaptures: uniq(prunedCaptures), remainingSkills: this.listSkills({ limit: Infinity }).length, remainingCaptures: this.listCaptures({ limit: Infinity }).length }; }
  exportPacket() { return { version: 2, governanceSchemaVersion: SKILL_GOVERNANCE_SCHEMA_VERSION, exportedAt: nowIso(), skills: this.listSkills({ limit: Infinity }).map((s) => s.toJSON()), captures: this.listCaptures({ limit: Infinity }).map((c) => c.toJSON()), failurePatterns: this.listFailurePatterns({ limit: Infinity }).map((p) => p.toJSON()), evaluations: this.listMetrics({ type: "skill.evaluated", limit: Infinity }).map((row) => row.evaluation || row), metrics: this.metrics() }; }
  importPacket(packet = {}) { const skills = []; const captures = []; const patterns = []; for (const c of packet.captures || []) captures.push(this.saveCapture(c)); for (const s of packet.skills || []) skills.push(this.saveSkill(new Skill(s))); for (const p of packet.failurePatterns || []) patterns.push(this.saveFailurePattern(p)); this.storage.appendJsonl(this.key("events"), { at: nowIso(), type: "skill.imported", skills: skills.length, captures: captures.length, patterns: patterns.length }); return { skills: skills.length, captures: captures.length, failurePatterns: patterns.length }; }
  snapshot({ snapshotId = null, note = "manual" } = {}) { const id = snapshotId || `snapshot_${new Date().toISOString().replace(/[:.]/g, "-")}_${shortHash(note)}`; const packet = { ...this.exportPacket(), snapshotId: id, note }; const key = this.key("snapshots", id); const location = this.storage.writeJson(key, packet); this.storage.appendJsonl(this.key("snapshots"), { at: nowIso(), snapshotId: id, note, skills: packet.skills.length, captures: packet.captures.length, location }); return { snapshotId: id, key, location, skills: packet.skills.length, captures: packet.captures.length, failurePatterns: packet.failurePatterns.length }; }
  restoreSnapshot(snapshotId) { const packet = this.storage.readJson(this.key("snapshots", snapshotId), null); if (!packet) throw new Error(`skill snapshot not found: ${snapshotId}`); return { snapshotId, ...this.importPacket(packet) }; }
  listSnapshots({ limit = 20 } = {}) { const rows = this.storage.readJsonl(this.key("snapshots")); return Number.isFinite(limit) ? rows.slice(-limit) : rows; }
}

function parseFrontmatterMarkdown(raw = "") {
  const m = String(raw).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {}; let body = String(raw || "");
  if (m) { body = m[2] || ""; for (const line of (m[1] || "").split(/\n/)) { const mm = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/); if (mm) meta[mm[1]] = mm[2].replace(/^['"]|['"]$/g, ""); } }
  const title = body.match(/^#\s+(.+)$/m)?.[1];
  const description = meta.description || body.match(/^>\s*(.+)$/m)?.[1] || body.split(/\n\n+/).find((p) => p.trim() && !p.trim().startsWith("#")) || "Native Pi agent skill";
  return { meta, body, title, description: String(description).replace(/\s+/g, " ").slice(0, 1000) };
}

const nativeSkillDiscoveryCache = new Map();
function nativeSkillDirsSignature(candidates) {
  return candidates.map((base) => {
    try {
      const rows = fs.readdirSync(base, { withFileTypes: true }).filter((ent) => ent.isDirectory()).map((ent) => {
        const file = path.join(base, ent.name, "SKILL.md");
        try { const st = fs.statSync(file); return `${ent.name}:${st.mtimeMs}:${st.size}`; } catch { return `${ent.name}:missing`; }
      }).sort();
      return `${base}=[${rows.join(",")}]`;
    } catch { return `${base}=missing`; }
  }).join("|");
}
function discoverNativeAgentSkills({ cwd = process.cwd(), dirs = null } = {}) {
  const candidates = dirs || [path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".pi", "agent", "skills"), path.join(cwd, ".agents", "skills"), path.join(cwd, ".pi", "skills")];
  const signature = nativeSkillDirsSignature(candidates);
  const cacheKey = `${cwd}|${candidates.join("|")}`;
  const cached = nativeSkillDiscoveryCache.get(cacheKey);
  if (cached?.signature === signature) return cached.skills.map((s) => new Skill(s));
  const skills = [];
  for (const base of candidates) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = path.join(base, ent.name, "SKILL.md");
      let raw = "";
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const parsed = parseFrontmatterMarkdown(raw);
      const nativeName = String(parsed.meta.name || ent.name || parsed.title || "native-skill").trim();
      skills.push(new Skill({
        skillId: `native_${shortHash(file)}`,
        name: `Native Agent Skill: ${nativeName}`,
        description: parsed.description,
        category: inferCategory(`${nativeName}\n${parsed.description}`),
        status: "approved",
        triggerConditions: [`Use native /skill:${nativeName}`, nativeName, parsed.description],
        domainTags: uniq(["native-agent-skill", nativeName, ...tokens(parsed.description).slice(0, 8)]),
        requiredTools: [],
        requiredContext: ["current task", `native skill file: ${file}`],
        workflowSteps: [{ id: "invoke-native-skill", kind: "native-agent-skill", description: `Invoke Pi native Agent Skill with /skill:${nativeName}`, tools: [] }],
        expectedOutputs: ["native Agent Skill guidance or execution result"],
        validationStrategy: { kind: "native-agent-skill", requiredEvidence: ["review output", "verify resulting changes when applicable"], commands: [], rollback: "native skill is advisory; use normal branch/session rollback for mutations" },
        confidenceScore: 0.82,
        provenance: { sources: ["native-agent-skill"], nativeSkillName: nativeName, file, sourceHash: governanceSha256(raw) },
        governance: { approval: "approved", minConfidence: 0.65, sandboxRequired: false, unsafe: false, nativeAgentSkill: true, command: `/skill:${nativeName}` },
      }));
    }
  }
  nativeSkillDiscoveryCache.set(cacheKey, { signature, skills: skills.map((s) => s.toJSON()) });
  return skills;
}

function nativeAgentSkillProvider(options = {}) { const skills = discoverNativeAgentSkills(options); return { providerId: "native-agent-skills", skills, silent: options.silent !== false }; }

class SkillSynthesisEngine {
  constructor({ store, trace, memory, clock = nowIso } = {}) { this.store = store || new SkillStore({ storage: { readJson: () => null, writeJson: () => {}, appendJsonl: () => {}, readJsonl: () => [] } }); this.trace = trace; this.memory = memory; this.clock = clock; this.providers = []; }
  emit(name, payload = {}, severity = "info") { this.trace?.emit?.({ category: name.includes("failure") ? "failure_state" : name.includes("retrieved") ? "memory_retrieval" : "session", name: `skill.${name}`, severity, payload }); }
  capture(input) { const c = input instanceof ExecutionCapture ? input : new ExecutionCapture(input); const saved = this.store.saveCapture(c); this.emit("capture.created", { captureId: saved.captureId, outcome: saved.outcome, score: saved.score }); if (saved.outcome === "failed") for (const p of extractFailurePatterns([c])) this.store.saveFailurePattern(p); return saved; }
  captureTopologyRun(run, extra) { return this.capture(captureFromTopologyRun(run, extra)); }
  captureTrace(events, extra) { return this.capture(captureFromTrace(events, extra)); }
  registerProvider(provider = {}) {
    const packet = typeof provider === "function" ? provider({ engine: this, store: this.store }) : provider;
    const providerId = packet.providerId || packet.name || `provider_${shortHash(packet)}`;
    const saved = [];
    for (const raw of packet.skills || []) {
      const candidate = new Skill({ source: providerId, status: raw.status || "approved", governance: { approval: raw.status || "approved", sandboxRequired: false, ...(raw.governance || {}) }, ...raw });
      const existing = this.store.getSkill(candidate.skillId);
      saved.push(existing || this.store.saveSkill(candidate));
    }
    for (const raw of packet.captures || []) this.capture({ source: providerId, ...raw });
    this.providers.push({ providerId, skills: saved.map((s) => s.skillId), registeredAt: nowIso() });
    if (!packet.silent) this.emit("provider.registered", { providerId, skills: saved.length });
    return { providerId, skills: saved };
  }
  synthesize({ captureIds = null, captures = null, minScore = 0.62, minRepeats = 3, minSuccessRate = 0.8, minIndependentRuns = minRepeats >= 3 ? 2 : 1, minVerifiedSuccesses = minRepeats >= 3 ? 2 : 0, minConfidence = minRepeats >= 3 ? 0.65 : 0, approve = false, ...options } = {}) {
    const source = captures ? captures.map((c) => c instanceof ExecutionCapture ? c : new ExecutionCapture(c)) : captureIds ? captureIds.map((id) => this.store.getCapture(id)).filter(Boolean) : this.store.listCaptures({ limit: Infinity }).filter((c) => c.score >= minScore || c.outcome === "succeeded");
    const groups = clusterCaptures(source, options);
    const skills = [];
    for (const group of groups.filter((g) => g.captures.length >= minRepeats)) {
      const skill = skillFromCaptures(group.captures, options);
      const eligibility = hermesSkillEligibility(skill, group.captures, { minRepeats, minSuccessRate, minIndependentRuns, minVerifiedSuccesses, minConfidence });
      if (!eligibility.eligible) continue;
      skill.governance.unsafe = isUnsafeSkill(skill).unsafe;
      skill.governance.synthesisEligibility = eligibility;
      // Synthesis never grants retrieval, routing, publishing, or field-proof authority.
      // The legacy approve option remains parseable only to surface an explicit failed gate.
      if (approve) skill.governance.implicitApprovalGate = { applied: false, reasons: ["implicit-promotion-disabled"] };
      const saved = this.store.saveSkill(skill);
      this.memory?.remember?.({ type: "procedural", title: saved.name, content: renderSkillForMemory(saved), tags: ["skill", saved.category, ...saved.domainTags.slice(0, 6)], verification: saved.status === "approved" ? "verified" : "inferred", confidence: saved.confidenceScore, provenance: { source: "skill-synthesis", skillId: saved.skillId, captureIds: saved.provenance.captureIds } });
      skills.push(saved);
      this.emit("created", { skillId: saved.skillId, status: saved.status, confidence: saved.confidenceScore, unsafe: saved.governance.unsafe });
    }
    return { skills, groups: groups.map((g) => ({ signature: g.signature, captures: g.captures.map((c) => c.captureId), similarity: g.similarity })) };
  }
  retrieve(query, options = {}) {
    const skills = this.store.listSkills({ status: options.includeDrafts ? undefined : options.status || undefined, category: options.category, limit: Infinity });
    const ranked = skills.map((skill) => ({ skill, score: scoreSkillRetrieval(skill, query, options), why: explainSkillRetrieval(skill, query, options) })).filter((x) => x.score >= (options.minScore ?? 0.08)).sort((a, b) => b.score - a.score || b.skill.confidenceScore - a.skill.confidenceScore).slice(0, options.limit || 8);
    this.emit("retrieved", { query: String(query).slice(0, 200), count: ranked.length });
    return { skills: ranked.map((r) => r.skill), ranked };
  }
  suggest(query, options = {}) { const r = this.retrieve(query, options); return { suggestions: r.ranked.map(({ skill, score, why }) => ({ skillId: skill.skillId, name: skill.name, category: skill.category, score, confidence: skill.confidenceScore, status: skill.status, why, inject: this.injectPacket(skill) })) }; }
  injectPacket(skillOrId) { const skill = typeof skillOrId === "string" ? this.store.getSkill(skillOrId) : skillOrId; if (!skill) throw new Error("skill not found"); this.emit("injected", { skillId: skill.skillId, version: skill.version }); return { kind: "skill.injection", skillId: skill.skillId, version: skill.version, sourceHash: skill.evidenceState?.sourceTrust?.sourceHash, name: skill.name, guidance: skill.workflowSteps.map((s) => `${s.order}. ${s.description}`).join("\n"), requiredTools: skill.requiredTools, validationStrategy: skill.validationStrategy, confidence: skill.confidenceScore, governance: skill.governance, evidenceState: skill.evidenceState, approvals: skill.approvals }; }
  resolveExplicitInvocation(input) { const name = explicitSkillCommandName(input); if (!name) return []; const matches = [...new Set(this.store.listSkills({ limit: Infinity }).filter((skill) => nativeSkillName(skill) === name).map((skill) => skill.skillId))]; return matches.length === 1 ? matches : []; }
  settlementOutcome(input) { return skillSettlementOutcome(input); }
  evaluate(skillId, evidence = {}) { const skill = this.store.getSkill(skillId); if (!skill) throw new Error(`skill not found: ${skillId}`); const evaluation = normalizeSkillEvaluation(skill, evidence, nowIso()); const ok = evaluation.result === "succeeded"; const m = skill.successMetrics; m.attempts = Number(m.attempts || 0) + 1; if (ok) m.successes = Number(m.successes || 0) + 1; else m.failures = Number(m.failures || 0) + 1; m.successRate = m.attempts ? m.successes / m.attempts : 0; if (evaluation.latencyMs) m.meanLatencyMs = avg([m.meanLatencyMs, evaluation.latencyMs]); if (evaluation.toolCalls) m.meanToolCalls = avg([m.meanToolCalls, evaluation.toolCalls]); skill.confidenceScore = clamp01(0.60 * skill.confidenceScore + 0.40 * (ok ? 1 : 0)); skill.historicalEffectiveness.uses++; if (ok) skill.historicalEffectiveness.accepted++; else skill.historicalEffectiveness.rejected++; skill.historicalEffectiveness.score = skill.confidenceScore; if (evidence.sandboxPassed === true) { skill.evidenceState.sandbox.status = "passed"; skill.evidenceState.sandbox.evidenceIds = uniq([...(skill.evidenceState.sandbox.evidenceIds || []), ...evaluation.evidenceIds]); } if (evidence.sandboxPassed === false) skill.evidenceState.sandbox.status = "failed"; const prior = this.store.listMetrics({ type: "skill.evaluated", skillId, limit: Infinity }).map((row) => row.evaluation || row); applyEvaluation(skill, evaluation, prior); skill.updatedAt = nowIso(); const saved = this.store.saveSkill(skill, { version: false }); this.store.recordMetric({ type: "skill.evaluated", skillId, version: saved.version, sourceHash: saved.evidenceState.sourceTrust.sourceHash, ok, confidence: saved.confidenceScore, evaluation }); this.emit("evaluated", { skillId, version: saved.version, sourceHash: saved.evidenceState.sourceTrust.sourceHash, ok, confidence: saved.confidenceScore }, ok ? "info" : "warn"); return saved; }
  approve(skillId, { scope = "routing", decision = "approve", minConfidence = 0.65, requireSandbox = false } = {}) { const skill = this.store.getSkill(skillId); if (!skill) throw new Error(`skill not found: ${skillId}`); skill.governance.unsafe = isUnsafeSkill(skill).unsafe; const gate = approvalGate(skill, scope); if (requireSandbox && skill.evidenceState.sandbox.status !== "passed") gate.reasons.push("sandbox-not-passed"); const threshold = Math.max(0.65, Number(minConfidence || 0.65)); if (decision !== "revoke" && skill.confidenceScore < threshold) gate.reasons.push(`confidence-below-${threshold}`); if (decision !== "revoke" && gate.reasons.length) throw new Error(`skill ${scope} approval blocked: ${[...new Set(gate.reasons)].join(", ")}`); setApproval(skill, scope, decision); if (decision !== "revoke") skill.status = "approved"; skill.governance.approval = `${scope}:${decision}`; skill.updatedAt = nowIso(); const saved = this.store.saveSkill(skill); this.store.recordMetric({ type: "skill.approval", skillId, version: saved.version, sourceHash: saved.evidenceState.sourceTrust.sourceHash, scope, decision }); return saved; }
  deprecate(skillId, reason = "deprecated by user") { const skill = this.store.getSkill(skillId); if (!skill) throw new Error(`skill not found: ${skillId}`); skill.status = "deprecated"; skill.updatedAt = nowIso(); skill.versionHistory.push({ version: skill.version, at: nowIso(), change: reason, skillHash: shortHash(skill) }); const saved = this.store.saveSkill(skill, { version: false }); this.emit("deprecated", { skillId, reason }); return saved; }
  rollback(skillId, version) { const r = this.store.rollback(skillId, version); this.emit("rollback", { skillId, version }); return r; }
  replay(ref) { const capture = this.store.getCapture(ref) || this.listCaptures({ limit: Infinity }).find((c) => c.replayRefs?.topologyRunId === ref || c.workflowSignature === ref); if (!capture) throw new Error(`capture not found: ${ref}`); const steps = capture.workflowSteps.map((s, i) => ({ index: i, type: "workflow", id: s.id, kind: s.kind, role: s.role, status: s.status, summary: s.description })); const tools = capture.toolSequence.map((t, i) => ({ index: steps.length + i, type: "tool", tool: t.tool, ok: t.ok, summary: t.summary })); return { captureId: capture.captureId, outcome: capture.outcome, score: capture.score, task: capture.task, steps: [...steps, ...tools], replayRefs: capture.replayRefs, provenance: capture.provenance }; }
  compare(leftId, rightId) { const left = this.getSkill(leftId); const right = this.getSkill(rightId); if (!left || !right) throw new Error("both skills must exist for comparison"); const similarity = skillSimilarity(left, right); const scores = { left: left.confidenceScore * (left.successMetrics.successRate || 0.5), right: right.confidenceScore * (right.successMetrics.successRate || 0.5) }; const winner = scores.left === scores.right ? "undecided" : scores.left > scores.right ? left.skillId : right.skillId; this.emit("compared", { leftId, rightId, winner, similarity }); return { left: left.skillId, right: right.skillId, similarity, scores, winner, tradeoffs: { tools: { left: left.requiredTools, right: right.requiredTools }, status: { left: left.status, right: right.status } } }; }
  captureSubagentResult(result, extra) { return this.capture(captureFromSubagentResult(result, extra)); }
  captureGoalState(goal, extra) { return this.capture(captureFromGoalState(goal, extra)); }
  captureExecutionOutcome(packet, extra) {
    const capture = captureFromExecutionOutcome(packet, extra);
    const existing = this.store.getCapture(capture.captureId);
    return existing ? { ...clone(existing), duplicate: true } : this.capture(capture);
  }
  captureReasoningReplay(replay, extra) { return this.capture(captureFromReasoningReplay(replay, extra)); }
  abTest(skillId, task, baseline = {}) { const skill = this.getSkill(skillId); if (!skill) throw new Error(`skill not found: ${skillId}`); const retrieval = scoreSkillRetrieval(skill, task, baseline); const predicted = clamp01(0.42 * skill.confidenceScore + 0.28 * retrieval + 0.20 * (skill.successMetrics.successRate || 0.5) + 0.10 * (skill.status === "approved" ? 1 : 0.5)); const base = clamp01(baseline.score ?? 0.5); const result = { skillId, task, mode: "sandbox-advisory", baselineScore: base, skillPredictedScore: predicted, recommendation: predicted > base ? "use-skill" : "baseline", injection: this.injectPacket(skill), deterministic: true }; this.store.recordMetric({ type: "skill.ab_test", ...result }); this.emit("ab_test", { skillId, recommendation: result.recommendation, predicted }); return result; }
  status() { const metrics = this.metrics(); const skills = this.listSkills({ limit: Infinity }); const summary = (s) => ({ skillId:s.skillId, version:s.version, sourceHash:s.evidenceState?.sourceTrust?.sourceHash, name:s.name, status:s.status, confidence:s.confidenceScore, evidenceState:s.evidenceState, approvals:s.approvals }); return { ...metrics, topSkills: skills.slice().sort((a,b)=>b.confidenceScore-a.confidenceScore).slice(0,5).map(summary), needsReview: skills.filter((s)=>s.status === "candidate" || s.governance?.unsafe || s.approvals?.routing !== "approved" || s.evidenceState?.field?.status !== "field-proven").slice(0,10).map((s)=>({ ...summary(s), unsafe:s.governance?.unsafe, gateReasons: topologyEligibility(s).reasons })), recentCaptures: this.listCaptures({ limit: 5 }).map((c)=>({ captureId:c.captureId, outcome:c.outcome, score:c.score, task:c.task.slice(0,120) })) }; }
  doctor() { const skills = this.listSkills({ limit: Infinity }); const captures = this.listCaptures({ limit: Infinity }); const captureIds = new Set(captures.map((c) => c.captureId)); const issues = []; const seen = new Set(); for (const s of skills) { if (seen.has(s.skillId)) issues.push({ severity: "warn", type: "duplicate-skill", skillId: s.skillId }); seen.add(s.skillId); for (const id of s.provenance?.captureIds || []) if (!captureIds.has(id)) issues.push({ severity: "warn", type: "dangling-capture", skillId: s.skillId, captureId: id }); const unsafe = isUnsafeSkill(s); if (s.status === "approved" && unsafe.unsafe) issues.push({ severity: "error", type: "unsafe-approved-skill", skillId: s.skillId, reasons: unsafe.reasons }); if (!SKILL_STATUSES.includes(s.status)) issues.push({ severity: "error", type: "invalid-status", skillId: s.skillId, status: s.status }); if (!SKILL_CATEGORIES.includes(s.category)) issues.push({ severity: "error", type: "invalid-category", skillId: s.skillId, category: s.category }); } const eventStats = this.store.eventStats(); for (const d of eventStats.duplicateSaved) issues.push({ severity: "warn", type: "duplicate-skill-saved-event", ...d }); return { ok: !issues.some((i) => i.severity === "error"), issues, checked: { skills: skills.length, captures: captures.length, failurePatterns: this.store.listFailurePatterns({ limit: Infinity }).length, events: eventStats } }; }
  prune(options) { const result = this.store.prune(options); this.emit("pruned", result); return result; }
  exportPacket() { const packet = this.store.exportPacket(); this.emit("exported", { skills: packet.skills.length, captures: packet.captures.length }); return packet; }
  importPacket(packet) { const result = this.store.importPacket(packet); this.emit("imported", result); return result; }
  synthesizeTopologyTemplate(skillOrId) {
    const skill = typeof skillOrId === "string" ? this.store.getSkill(skillOrId) : skillOrId;
    if (!skill) throw new Error("skill not found");
    const eligibility = topologyEligibility(skill);
    if (isUnsafeSkill(skill).unsafe || !eligibility.ok) throw new Error(`skill cannot synthesize executable topology template: ${eligibility.reasons.join(", ") || "unsafe-skill"}`);
    const compiled = compileSynthesizedRoadmapGate(skill.workflowSteps.map(synthesizedRoleNode), skill);
    const nodes = compiled.nodes;
    const topology = materializeRoleAwareTopology({
      topologyId: `skill-${skill.skillId}`,
      name: skill.name,
      description: skill.description,
      executionMode: "sequential",
      failurePolicy: "fail-fast",
      aggregationPolicy: "last",
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id, condition: node.roleId === "verifier" ? "no_errors" : "ok" })),
      terminalNodes: [nodes.at(-1)?.id].filter(Boolean),
      metadata: { synthesizedFromSkill: skill.skillId, skillVersion: skill.version, skillSourceHash: skill.evidenceState.sourceTrust.sourceHash, approval: skill.governance.approval, approvals: skill.approvals, evidenceState: skill.evidenceState, ...(compiled.roadmapPlanGate ? { roadmapPlanGate: compiled.roadmapPlanGate } : {}) },
    }, { provenance: { source: "skill-synthesis", skillId: skill.skillId, skillVersion: skill.version } });
    const validation = validateRoleAwareTopology(topology);
    if (!validation.ok) throw new Error(`synthesized topology is invalid: ${validation.issues.join("; ")}`);
    return topology;
  }
  listSkills(args) { return this.store.listSkills(args); }
  getSkill(id) { return this.store.getSkill(id); }
  listCaptures(args) { return this.store.listCaptures(args); }
  hermesDraftPacket(skillId) { const skill = this.getSkill(skillId); if (!skill) throw new Error(`skill not found: ${skillId}`); const captureIds = new Set(skill.provenance?.captureIds || []); const captures = this.listCaptures({ limit: Infinity }).filter((capture) => captureIds.has(capture.captureId)); return { skill, captures, packet: buildHermesSkillDraftPacket(skill, captures), eligibility: hermesSkillEligibility(skill, captures) }; }
  recordFailurePatternOutcome(patternId, input) { return this.store.recordFailurePatternOutcome(patternId, input); }
  compoundingRecords(args) { return this.store.compoundingRecords(args); }
  compactEvents() { const r = this.store.compactEvents(); this.emit("compact", r); return r; }
  snapshot(options) { const r = this.store.snapshot(options); this.emit("snapshot", r); return r; }
  restoreSnapshot(snapshotId) { const r = this.store.restoreSnapshot(snapshotId); this.emit("restore", r, "warn"); return r; }
  listSnapshots(args) { return this.store.listSnapshots(args); }
  metrics() { return { ...this.store.metrics(), providers: this.providers.length }; }
}

function clusterCaptures(captures, { similarityThreshold = 0.74 } = {}) {
  const groups = [];
  for (const c of captures) {
    let best = null;
    for (const g of groups) {
      const sim = captureSimilarity(c, g.captures[0]);
      if (sim >= similarityThreshold && (!best || sim > best.sim)) best = { group: g, sim };
    }
    if (best) { best.group.captures.push(c); best.group.similarity = avg([best.group.similarity, best.sim]); }
    else groups.push({ signature: c.workflowSignature || workflowSignature(c), captures: [c], similarity: 1 });
  }
  return groups.map((g) => ({ ...g, captures: g.captures.sort((a, b) => b.score - a.score) }));
}
function sequenceSimilarity(a = [], b = []) { const A = a.map((x) => x.tool || x.kind || x.role || x.description || x).join(">"); const B = b.map((x) => x.tool || x.kind || x.role || x.description || x).join(">"); if (!A && !B) return 1; return 0.5 * overlap(A, B) + 0.5 * (1 - editDistance(A, B) / Math.max(A.length, B.length, 1)); }
function editDistance(a, b) { const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length]; }
function captureSimilarity(a, b) { return clamp01(0.30 * overlap(a.task, b.task) + 0.28 * sequenceSimilarity(a.toolSequence, b.toolSequence) + 0.24 * sequenceSimilarity(a.workflowSteps, b.workflowSteps) + 0.10 * overlap(a.topology?.topologyId, b.topology?.topologyId) + 0.08 * (a.outcome === b.outcome ? 1 : 0)); }
function skillSimilarity(a, b) { return clamp01(0.35 * overlap(`${a.name}\n${a.description}`, `${b.name}\n${b.description}`) + 0.25 * sequenceSimilarity(a.workflowSteps, b.workflowSteps) + 0.20 * sequenceSimilarity(a.requiredTools, b.requiredTools) + 0.10 * (a.category === b.category ? 1 : 0) + 0.10 * overlap(a.domainTags.join(" "), b.domainTags.join(" "))); }
function isUnsafeSkill(skill) { const reasons = []; const raw = renderSkillForMemory(skill); const safety = scanMemoryContent(raw, { maxChars: 20_000 }); reasons.push(...safety.blockingReasons); if (/rm\s+-rf|sudo|chmod\s+-R|chown\s+-R|curl\s+.*\|\s*(sh|bash)|outside\s+repo/i.test(raw)) reasons.push("destructive-or-privileged-action"); if (!JSON.stringify(skill.validationStrategy || {}).match(/verify|test|evidence|lint|compile/i)) reasons.push("missing-validation-strategy"); return { unsafe: reasons.length > 0, reasons: [...new Set(reasons)] }; }
function renderSkillForMemory(skill) { return [`Skill ${skill.skillId} v${skill.version}: ${skill.name}`, skill.description, `Triggers: ${skill.triggerConditions.join("; ")}`, `Tools: ${skill.requiredTools.join(", ") || "none"}`, "Workflow:", ...skill.workflowSteps.map((s) => `${s.order}. ${s.description}`), `Validation: ${text(skill.validationStrategy).slice(0, 500)}`].join("\n"); }
function captureExecutionKey(capture) { return String(capture.replayRefs?.sourceRunId || capture.replayRefs?.topologyRunId || capture.replayRefs?.executionOutcomePacketId || capture.replayRefs?.correlationId || capture.replayRefs?.subagentId || capture.replayRefs?.goalId || capture.captureId); }
function hermesSkillEligibility(skill, captures, { minRepeats = 3, minSuccessRate = 0.8, minIndependentRuns = 2, minVerifiedSuccesses = 2, minConfidence = 0.65 } = {}) {
  const rows = captures || [];
  const successes = rows.filter((capture) => capture.outcome === "succeeded");
  const successRate = rows.length ? successes.length / rows.length : 0;
  const independentRuns = new Set(rows.map(captureExecutionKey).filter(Boolean)).size;
  const verifiedSuccesses = successes.filter((capture) => capture.verification?.ok === true || (capture.verification?.evidenceIds || []).length > 0).length;
  const reasons = [];
  if (rows.length < minRepeats) reasons.push(`repeats-below-${minRepeats}`);
  if (successRate < minSuccessRate) reasons.push(`success-rate-below-${minSuccessRate}`);
  if (independentRuns < minIndependentRuns) reasons.push(`independent-runs-below-${minIndependentRuns}`);
  if (verifiedSuccesses < minVerifiedSuccesses) reasons.push(`verified-successes-below-${minVerifiedSuccesses}`);
  if (Number(skill?.confidenceScore || 0) < minConfidence) reasons.push(`confidence-below-${minConfidence}`);
  if (skill && isUnsafeSkill(skill).unsafe) reasons.push("unsafe-skill");
  return { eligible: reasons.length === 0, reasons, repeats: rows.length, successes: successes.length, successRate, independentRuns, verifiedSuccesses, thresholds: { minRepeats, minSuccessRate, minIndependentRuns, minVerifiedSuccesses, minConfidence } };
}
function buildHermesSkillDraftPacket(skill, captures) {
  const eligibility = hermesSkillEligibility(skill, captures);
  if (!eligibility.eligible) { const error = new Error(`Hermes skill draft is not eligible: ${eligibility.reasons.join(", ")}`); error.code = "HERMES_SKILL_NOT_ELIGIBLE"; error.eligibility = eligibility; throw error; }
  const packet = {
    schemaVersion: 1,
    skillId: skill.skillId,
    category: skill.category,
    candidateName: String(skill.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || `skill-${shortHash(skill.skillId)}`,
    triggerBoundary: uniq(skill.domainTags || []).slice(0, 12),
    requiredTools: uniq(skill.requiredTools || []).slice(0, 32),
    workflow: (skill.workflowSteps || []).slice(0, 20).map((step) => ({ order: step.order, kind: step.kind, role: step.role || null, tools: uniq(step.tools || []).slice(0, 12) })),
    verification: { kind: skill.validationStrategy?.kind || "evidence", requiredEvidence: uniq(skill.validationStrategy?.requiredEvidence || []).slice(0, 16), rollback: skill.validationStrategy?.rollback ? "required" : "unspecified" },
    failurePatterns: (skill.failurePatterns || []).slice(0, 12).map((pattern) => ({ signature: String(pattern.signature || pattern.patternId || "failure").slice(0, 160), mitigationRequired: true })),
    captures: captures.slice(0, 64).map((capture) => ({ captureId: capture.captureId, executionRefHash: `sha256:${crypto.createHash("sha256").update(captureExecutionKey(capture)).digest("hex")}`, outcome: capture.outcome, verified: capture.verification?.ok === true || (capture.verification?.evidenceIds || []).length > 0, evidenceIds: uniq(capture.verification?.evidenceIds || []).slice(0, 32), workflowKinds: uniq((capture.workflowSteps || []).map((step) => step.kind)).slice(0, 20), toolNames: uniq((capture.toolSequence || []).map((tool) => tool.tool)).slice(0, 32) })),
    eligibility,
  };
  const safety = scanMemoryContent(JSON.stringify(packet), { maxChars: 20_000 });
  if (!safety.safe) { const error = new Error(`Hermes skill packet is unsafe: ${safety.blockingReasons.join(", ")}`); error.code = "HERMES_SKILL_PACKET_UNSAFE"; throw error; }
  return packet;
}
function validateAgentSkillDraft(draft) {
  if (!draft || Number(draft.schemaVersion) !== 1) throw new Error("Agent Skill draft schemaVersion must be 1");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(draft.name || "")) || String(draft.name).length > 64) throw new Error("Agent Skill name is invalid");
  const markdown = String(draft.skillMarkdown || "");
  const parsed = parseFrontmatterMarkdown(markdown);
  if (parsed.meta.name !== draft.name || !parsed.meta.description || parsed.meta.description !== draft.description) throw new Error("Agent Skill frontmatter must match the typed name and description");
  const safety = scanMemoryContent(markdown, { maxChars: 20_000 });
  if (!safety.safe) throw new Error(`Agent Skill draft failed safety validation: ${safety.blockingReasons.join(", ")}`);
  if (/\]\((?:\/|[A-Za-z]:\\|\.\.\/)/.test(markdown)) throw new Error("Agent Skill references must remain relative to the skill directory");
  return { schemaVersion: 1, name: draft.name, description: draft.description, skillMarkdown: `${markdown.trim()}\n`, files: [] };
}
function ensurePrivateDirectory(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`skill quarantine path is not a private directory: ${dir}`); fs.chmodSync(dir, 0o700); }
function writePrivateJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); fs.chmodSync(file, 0o600); }
function quarantineHermesSkillCandidate({ cwd = process.cwd(), skill, captures, draft, receipt } = {}) {
  const normalized = validateAgentSkillDraft(draft);
  const candidateId = `hermes_skill_${shortHash({ skillId: skill.skillId, sourceHash: skill.evidenceState?.sourceTrust?.sourceHash, outputHash: receipt?.receiptId, markdown: normalized.skillMarkdown })}`;
  const root = path.join(cwd, ".pi", "hermes-skill-candidates"); const dir = path.join(root, candidateId);
  ensurePrivateDirectory(root);
  if (fs.existsSync(dir)) return { candidateId, directory: dir, duplicate: true, status: "quarantined" };
  ensurePrivateDirectory(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), normalized.skillMarkdown, { mode: 0o600, flag: "wx" });
  const provenance = { schemaVersion: 1, candidateId, status: "quarantined", createdAt: nowIso(), hermesReceiptId: receipt?.receiptId || null, hermesSourceVersion: receipt?.sourceVersion || null, sourceSkillId: skill.skillId, sourceSkillVersion: skill.version, sourceSkillHash: skill.evidenceState?.sourceTrust?.sourceHash || null, captureIds: captures.map((capture) => capture.captureId), executionRefHashes: captures.map((capture) => `sha256:${crypto.createHash("sha256").update(captureExecutionKey(capture)).digest("hex")}`), promotion: null };
  writePrivateJson(path.join(dir, "provenance.json"), provenance);
  return { candidateId, directory: dir, duplicate: false, status: "quarantined", draft: normalized, provenance };
}
function promoteHermesSkillCandidate({ cwd = process.cwd(), candidateId, apply = false, userApproved = false } = {}) {
  if (!/^hermes_skill_[a-f0-9]{12}$/.test(String(candidateId || ""))) throw new Error("invalid Hermes skill candidate ID");
  const sourceDir = path.join(cwd, ".pi", "hermes-skill-candidates", candidateId); const provenanceFile = path.join(sourceDir, "provenance.json"); const skillFile = path.join(sourceDir, "SKILL.md");
  for (const file of [provenanceFile, skillFile]) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent Skill promotion source must contain regular files"); }
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8")); const markdown = fs.readFileSync(skillFile, "utf8"); const parsed = parseFrontmatterMarkdown(markdown); const draft = validateAgentSkillDraft({ schemaVersion: 1, name: parsed.meta.name, description: parsed.meta.description, skillMarkdown: markdown });
  const targetDir = path.join(cwd, ".agents", "skills", draft.name); const preview = { candidateId, sourceDir, targetDir, name: draft.name, apply: Boolean(apply), userApproved: Boolean(userApproved) };
  if (!apply) return { ...preview, outcome: "preview", applied: false };
  if (!userApproved) { const error = new Error("Agent Skill promotion requires explicit current-user approval"); error.code = "HERMES_SKILL_PROMOTION_APPROVAL_REQUIRED"; throw error; }
  if (fs.existsSync(targetDir)) throw new Error(`Agent Skill target already exists: ${path.relative(cwd, targetDir)}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const promoted = { ...provenance, status: "promoted", promotion: { promotedAt: nowIso(), target: path.relative(cwd, targetDir).replace(/\\/g, "/"), authority: "explicit-current-user" } };
  fs.writeFileSync(path.join(targetDir, "SKILL.md"), draft.skillMarkdown, { flag: "wx" });
  fs.writeFileSync(path.join(targetDir, "provenance.json"), `${JSON.stringify(promoted, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(provenanceFile, `${JSON.stringify(promoted, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(provenanceFile, 0o600);
  return { ...preview, outcome: "promoted", applied: true };
}
function nativeSkillName(skill) { return String(skill.provenance?.nativeSkillName || skill.governance?.command || skill.name || "").replace(/^\/skill:/, "").replace(/^Native Agent Skill:\s*/i, "").toLowerCase(); }
function explicitSkillCommandName(input) { const match = String(input || "").trim().match(/^\/skill:([^\s]+)(?:\s|$)/i); return match ? match[1].toLowerCase() : null; }
function skillSettlementOutcome({ stopReason, toolError = false, failureSignal = false } = {}) { const reason = String(stopReason || "unknown"); const eligible = reason === "stop" || reason === "toolUse"; return { eligible, ok: eligible ? !toolError && !failureSignal : null, stopReason: reason, toolError: Boolean(toolError), failureSignal: Boolean(failureSignal) }; }
function isSmallDocReviewCommitTask(query) {
  const raw = text(query).toLowerCase();
  const q = normalize(raw);
  if (!q) return false;
  const hasReview = /\b(review|inspect|check|audit)\b/.test(q) || /\bdiff\b.*\b(consistency|commit)\b/.test(q);
  const hasCommit = /\b(commit|committed|committing|check in|check-in|checkpoint)\b/.test(q);
  const docLike = /\b(doc|docs|documentation|readme|markdown|md|ledger|brief|note|notes|prompt|research|writeup|phase|hdi|db1)\b/.test(q) || /\.(md|markdown|rst|adoc)\b/.test(raw);
  const buildOrSubsystemSignals = raw.includes("c++") || /\b(cpp|cmake|makefile|ninja|compiler|compile|linker|build system|sanitizer|ci pipeline|large subsystem|execution program|production readiness|production-readiness)\b/.test(q);
  return hasReview && hasCommit && docLike && !buildOrSubsystemSignals;
}
function isRoutineDiffReviewCommitTask(query) {
  const raw = text(query).toLowerCase();
  const q = normalize(raw);
  if (!q) return false;
  const hasReview = /\b(review|inspect|check|audit)\b/.test(q) || /\bdiff\b.*\b(edge cases?|consistency|clean|commit)\b/.test(q);
  const hasChangeArtifact = /\b(diff|patch|changes?|updates?|modified files?)\b/.test(q);
  const hasCommit = /\b(commit|committed|committing|check in|check-in|land)\b/.test(q);
  const hasRoutineVerification = /\b(rerun|re-run|run|verify|verified|test|tests|lint|typecheck|type-check|if clean|green|consistency|edge cases?)\b/.test(q);
  const broadScopeSignals = /\b(large subsystem|execution program|production readiness|production-readiness|architecture review|security review)\b/.test(q);
  return hasReview && hasChangeArtifact && hasCommit && hasRoutineVerification && !broadScopeSignals;
}
function hasExplicitAuditIntent(query) {
  const q = normalize(text(query).toLowerCase());
  return /\b(audit|critique|production readiness|production-readiness|top[- ]?roi|adversarial review|risk review|architecture review|security review)\b/.test(q);
}
function hasExplicitApiDesignIntent(query) {
  const q = normalize(text(query).toLowerCase());
  return /\b(api[- ]?design|api review|api evolution|api boundary|api boundaries|interface design|interface review|public interface|contract documentation|contract design|interface specification|module boundary|library boundary|evolution plan)\b/.test(q) || /\b(design|review|evolve|evolution)\b.*\b(api|interface|boundary|contract)\b/.test(q);
}
function hasExplicitPerfIntent(query) {
  const raw = text(query).toLowerCase();
  const q = normalize(raw);
  return /\b(perf|performance|profile|profiling|benchmark|optimi[sz]e|hotspot|flamegraph|nsys|perf stat|perf record)\b/.test(q);
}
function hasExplicitObservabilityIntent(query) {
  const q = normalize(text(query).toLowerCase());
  return /\b(observability|observable|logging|structured log|diagnostic|diagnostics|telemetry|metrics|trace instrumentation|runtime diagnostics?)\b/.test(q);
}
function hasExplicitBuildIntent(query) {
  const q = normalize(text(query).toLowerCase());
  return /\b(build system|compile failure|compiler|linker|cmake|makefile|ninja|toolchain|sanitizer|ci pipeline)\b/.test(q) || /\b(run|rerun|re-run)\b.*\b(build|compile)\b/.test(q);
}
function isDatasetOrPretokenizationTask(query) {
  const raw = text(query).toLowerCase();
  const q = normalize(raw);
  if (!q) return false;
  const datasetSignal = /\b(fineweb|huggingfacefw|hugging\s*face|hf dataset|dataset|datasets|pile data|the pile|parquet|jsonl\.zst|\.tok\.bin|pretok(?:enized|enize|enization)?|pre[- ]?tokeni[sz]e|tokeni[sz]e|pretokenization|pretokenized|pretok[-_]?data|pretok_dir|vocab\.bpe|ai1|ai2)\b/.test(q) || /huggingface\.co\/datasets/.test(raw);
  const dataAction = /\b(download|mirror|save|copy|sync|fetch|convert|stream|shard|shards?|preprocess|prepare|pack|layout|manifest|resume|status report|status update|pretok(?:enized|enize|enization)?|pre[- ]?tokeni[sz]e|tokeni[sz]e|pretokenization)\b/.test(q);
  return datasetSignal && dataAction;
}
function isRoutineStatusReportTask(query) {
  const q = normalize(text(query).toLowerCase());
  if (!q) return false;
  const statusOnly = /\b(status report|status update|give (?:a )?status|check status|where are we|progress report)\b/.test(q);
  const specialistIntent = hasExplicitPerfIntent(q) || hasExplicitAuditIntent(q) || hasExplicitObservabilityIntent(q) || hasExplicitTestDesignIntent(q) || hasExplicitBuildIntent(q);
  return statusOnly && !specialistIntent;
}
function isGoalOrSkillFailureInvestigation(query) {
  const raw = text(query).toLowerCase();
  const q = normalize(raw);
  return /\bgoal_\d{8,}_[a-z0-9]+\b/.test(raw) || /\bskill failure evidence\b/.test(q) || /\bnative skill failures?\b/.test(q) || /\b(recent\s+)?(?:\w+\s+){0,3}skill failures?\b/.test(q) || /\bwhy\b.*\bgoal\b.*\bblocked\b/.test(q) || /\bgoal\b.*\bblocked\b/.test(q);
}
function isGenericImplementationOrTestTask(query) {
  const q = normalize(text(query).toLowerCase());
  if (!q) return false;
  const genericVerb = /\b(implement|fix|patch|refactor|extract|move|split|update|run|rerun|re-run|inspect|investigate|debug|review)\b/;
  const genericObject = /\b(phase\s+[0-9ivxlcdm]+|remediation plan|unit tests?|runtime tests?|test suite|tests?|failures?|diff|asset|sidecar refactor)\b/;
  const specialtyIntent = hasExplicitAuditIntent(q) || hasExplicitApiDesignIntent(q) || hasExplicitObservabilityIntent(q);
  return genericVerb.test(q) && genericObject.test(q) && !specialtyIntent;
}
function hasExplicitTestDesignIntent(query) {
  const q = normalize(text(query).toLowerCase());
  const designVerb = /\b(design|add|write|create|generate|draft|expand|cover)\b/;
  const testArtifact = /\b(regression tests?|regression cases?|tests?|test cases?|test suite)\b/;
  return /\b(test[- ]?design|test strategy|test plan|coverage plan)\b/.test(q) || (designVerb.test(q) && testArtifact.test(q));
}
function hasExplicitResearchFrameworkIntent(query) {
  const q = normalize(text(query).toLowerCase());
  return /\b(research[- ]?framework[- ]?design|research framework|mathematical framework|theoretical framework|first principles|first-principles|formal derivation|dynamical analysis|research program|novel framework)\b/.test(q) || /\b(design|propose|develop|formulate)\b.*\b(framework|research program|mathematical model)\b/.test(q);
}
function hasExplicitConcurrencyIntent(query) {
  const q = normalize(text(query).toLowerCase());
  return /\b(concurrency|concurrent|thread(?:s|ing)?|mutex(?:es)?|lock[- ]?free|deadlock|livelock|race condition|data race|atomic(?:s)?|memory ordering|memory model|synchroni[sz]ation|rwlock|semaphore|condition variable|parallel c|std::thread|std::atomic)\b/.test(q);
}
function isMathProofEngineeringImplementationTask(query) {
  const q = normalize(text(query).toLowerCase());
  if (!q) return false;
  const mathProofSignal = /\b(lean|theorem|lemma|proof[- ]?engineering|formalization|formalize|formalising|formalise|formalised|formalized|proof certificate|formal certificate|certificate bridge|reg[- ]?cert|soj[- ]?cert|db1|all[- ]?prime|p[- ]?integral|p\^?2|finite diagnostic|finite[- ]?diagnostic|obstruction|branch[- ]?equation|normal[- ]?form|quotient[- ]?transport|trace[-\/]defect|recurrence state|ell[_-]?n|m[_-]?n|u[_-]?n|g[_-]?n)\b/.test(q);
  const implementationSignal = /\b(implement|add|update|modify|run|rerun|re-run|validate|validation|verify|review|inspect|audit|docs?|ledger|commit|probe|script|generated outputs?|diff|stage|push)\b/.test(q);
  const proofRepoSignal = /\b(frontier[- ]?math[- ]?proof[- ]?engineering|math proof[- ]?engineering|proof object|lean bridge|claim boundary)\b/.test(q);
  return implementationSignal && (mathProofSignal || proofRepoSignal);
}
function skillSelectionRule(skill, query) {
  const native = nativeSkillName(skill);
  const skillKey = normalize(`${skill.skillId || ""} ${native} ${skill.name || ""}`);
  const mathProofImplementation = isMathProofEngineeringImplementationTask(query);
  const explicitConcurrency = hasExplicitConcurrencyIntent(query);
  const datasetTask = isDatasetOrPretokenizationTask(query);
  const routineStatusReport = isRoutineStatusReportTask(query);
  if (datasetTask) {
    const noisyDatasetSelectors = /\b(durable[- ]bug[- ]hunt|test[- ]design|audit|handoff|failure[- ]pattern investigation|perf|code[- ]review|subsystem[- ]plan|research[- ]framework[- ]design|experiment[- ]gate[- ]lifecycle|security|build)\b/;
    if (noisyDatasetSelectors.test(skillKey)) {
      if (native === "build" && hasExplicitBuildIntent(query)) return { multiplier: 1, reason: "dataset-or-pretokenization-task-explicit-build" };
      return { multiplier: 0, reason: "dataset-or-pretokenization-task" };
    }
  }
  if (routineStatusReport) {
    const noisyStatusSelectors = /\b(durable[- ]bug[- ]hunt|handoff|failure[- ]pattern investigation|perf|code[- ]review|audit|test[- ]design|subsystem[- ]plan|research[- ]framework[- ]design|experiment[- ]gate[- ]lifecycle|security|build)\b/;
    if (noisyStatusSelectors.test(skillKey)) return { multiplier: 0, reason: "routine-status-report" };
  }
  if (mathProofImplementation && native === "concurrency" && !explicitConcurrency) return { multiplier: 0, reason: "math-proof-engineering-implementation-task" };
  if (mathProofImplementation && ["research-framework-design", "experiment-gate-lifecycle"].includes(native)) return { multiplier: 0, reason: "math-proof-engineering-implementation-task" };
  if (mathProofImplementation && native === "frontier-math-proof-engineering") return { multiplier: 1.35, reason: "math-proof-engineering-implementation-task" };
  if (native === "concurrency" && !explicitConcurrency) return { multiplier: 0, reason: "no-explicit-concurrency-intent" };
  if (isSmallDocReviewCommitTask(query) && ["build", "subsystem-plan", "audit"].includes(native)) return { multiplier: 0, reason: "small-doc-review-commit-task" };
  if (isRoutineDiffReviewCommitTask(query)) {
    if (native === "audit" && !hasExplicitAuditIntent(query)) return { multiplier: 0, reason: "small-diff-review-commit-task" };
    if (native === "api-design" && !hasExplicitApiDesignIntent(query)) return { multiplier: 0, reason: "small-diff-review-commit-task" };
    if (native === "perf" && !hasExplicitPerfIntent(query)) return { multiplier: 0, reason: "small-diff-review-commit-task" };
    if (native === "observability" && !hasExplicitObservabilityIntent(query)) return { multiplier: 0, reason: "small-diff-review-commit-task" };
    if (native === "test-design" && !hasExplicitTestDesignIntent(query)) return { multiplier: 0, reason: "small-diff-review-commit-task" };
    if (native === "research-framework-design" && !hasExplicitResearchFrameworkIntent(query)) return { multiplier: 0, reason: "small-diff-review-commit-task" };
  }
  if (isGoalOrSkillFailureInvestigation(query)) {
    if (native === "audit" && !hasExplicitAuditIntent(query)) return { multiplier: 0, reason: "goal-or-skill-failure-investigation" };
    if (native === "api-design" && !hasExplicitApiDesignIntent(query)) return { multiplier: 0, reason: "goal-or-skill-failure-investigation" };
    if (native === "perf" && !hasExplicitPerfIntent(query)) return { multiplier: 0, reason: "goal-or-skill-failure-investigation" };
    if (native === "observability" && !hasExplicitObservabilityIntent(query)) return { multiplier: 0, reason: "goal-or-skill-failure-investigation" };
  }
  if (isGenericImplementationOrTestTask(query)) {
    if (native === "audit" && !hasExplicitAuditIntent(query)) return { multiplier: 0, reason: "generic-implementation-or-test-task" };
    if (native === "api-design" && !hasExplicitApiDesignIntent(query)) return { multiplier: 0, reason: "generic-implementation-or-test-task" };
    if (native === "observability" && !hasExplicitObservabilityIntent(query)) return { multiplier: 0, reason: "generic-implementation-or-test-task" };
  }
  if (native === "audit" && hasExplicitApiDesignIntent(query) && !hasExplicitAuditIntent(query)) return { multiplier: 0, reason: "api-design-task-without-audit-intent" };
  if (native === "observability" && hasExplicitApiDesignIntent(query) && !hasExplicitObservabilityIntent(query)) return { multiplier: 0, reason: "api-design-task-without-observability-intent" };
  if (native === "audit" && hasExplicitPerfIntent(query) && !hasExplicitAuditIntent(query)) return { multiplier: 0, reason: "performance-task-without-audit-intent" };
  if (native === "observability" && hasExplicitPerfIntent(query) && !hasExplicitObservabilityIntent(query)) return { multiplier: 0, reason: "performance-task-without-observability-intent" };
  return { multiplier: 1, reason: null };
}
function scoreSkillRetrieval(skill, query, options = {}) { const q = text(query); const task = overlap(q, `${skill.name}\n${skill.description}\n${skill.triggerConditions.join("\n")}\n${skill.domainTags.join(" ")}`); const repo = options.repository ? Math.max(...skill.applicableRepositories.map((r) => overlap(r, options.repository)), 0) : 0.4; const tools = options.tools?.length ? options.tools.filter((t) => skill.requiredTools.includes(t)).length / Math.max(1, skill.requiredTools.length || 1) : 0.5; const effectiveness = skill.historicalEffectiveness?.score ?? skill.confidenceScore; const status = skill.status === "approved" ? 1 : skill.status === "candidate" ? 0.72 : 0.42; const unsafe = skill.governance?.unsafe ? 0.45 : 1; const selection = skillSelectionRule(skill, q); return clamp01(selection.multiplier * unsafe * (0.38 * task + 0.14 * repo + 0.14 * tools + 0.20 * effectiveness + 0.14 * status)); }
function explainSkillRetrieval(skill, query, options) { const selection = skillSelectionRule(skill, text(query)); return { taskSimilarity: overlap(text(query), `${skill.name}\n${skill.description}`), confidence: skill.confidenceScore, status: skill.status, unsafe: Boolean(skill.governance?.unsafe), requiredTools: skill.requiredTools, category: skill.category, repositoryMatched: Boolean(options.repository && skill.applicableRepositories.some((r) => overlap(r, options.repository) > 0.2)), selectionRule: selection.reason }; }
function roleForStep(step) { const k = normalize(`${step.kind} ${step.description}`); if (/plan|design|outline/.test(k)) return "planner"; if (/review|audit|critique/.test(k)) return "reviewer"; if (/verify|test|lint|check|benchmark/.test(k)) return "verifier"; if (/refactor|cleanup|restructure/.test(k)) return "refactorer"; if (/code|edit|write|implement|fix|repair|update|create/.test(k)) return "coder"; if (/research|inspect|read|find|investigate|map/.test(k)) return "researcher"; return "researcher"; }
function synthesizedRoleNode(step) {
  const known = new Map(DEFAULT_ROLE_CONTRACTS.map((role) => [role.roleId, role]));
  const requested = String(step.role || "").trim().toLowerCase();
  const roleId = known.has(requested) ? requested : roleForStep(step);
  const contract = known.get(roleId);
  const requestedTools = Array.isArray(step.tools) ? step.tools : [];
  const allowedTools = requestedTools.filter((tool) => contract.toolPolicy.allowedTools.includes(tool));
  return { id: step.id, roleId, task: step.description, ...(allowedTools.length ? { allowedTools } : {}) };
}
function compileSynthesizedRoadmapGate(inputNodes, skill = {}) {
  const contracts = new Map(DEFAULT_ROLE_CONTRACTS.map((role) => [role.roleId, role]));
  const nodes = inputNodes.map(clone);
  const implementationIndexes = nodes.map((node, index) => ({ node, index })).filter(({ node }) => contracts.get(node.roleId)?.mutationPolicy === "proposed-patch");
  if (!implementationIndexes.length) return { nodes, roadmapPlanGate: null };
  const firstImplementationIndex = implementationIndexes[0].index;
  let plannerIndex = nodes.map((node, index) => ({ node, index })).filter(({ node, index }) => node.roleId === "planner" && index < firstImplementationIndex).at(-1)?.index;
  if (!Number.isInteger(plannerIndex)) {
    const used = new Set(nodes.map((node) => node.id));
    let plannerId = "roadmap-plan";
    for (let ordinal = 2; used.has(plannerId); ordinal++) plannerId = `roadmap-plan-${ordinal}`;
    nodes.splice(firstImplementationIndex, 0, { id: plannerId, roleId: "planner", task: `Plan ${skill.name || "the synthesized workflow"} and emit roadmapPlan milestones with nested goals for parent application before implementation` });
    plannerIndex = firstImplementationIndex;
  }
  const planner = nodes[plannerIndex];
  const plannerSchema = clone(contracts.get("planner").outputSchema);
  plannerSchema.required = [...new Set([...(plannerSchema.required || []), "roadmapPlan"])];
  planner.outputSchema = plannerSchema;
  if (!/roadmapPlan/.test(String(planner.task || ""))) planner.task = `${planner.task || "Plan the workflow"}; emit roadmapPlan milestones with nested goals for parent application before implementation`;
  const beforeNodeIds = nodes.filter((node) => contracts.get(node.roleId)?.mutationPolicy === "proposed-patch").map((node) => node.id);
  return { nodes, roadmapPlanGate: { plannerNodeId: planner.id, beforeNodeIds } };
}

module.exports = { SKILL_CATEGORIES, SKILL_STATUSES, CAPTURE_OUTCOMES, ExecutionCapture, Skill, FailurePattern, SkillStore, SkillSynthesisEngine, discoverNativeAgentSkills, nativeAgentSkillProvider, captureFromTopologyRun, captureFromTrace, captureFromSubagentResult, captureFromGoalState, captureFromExecutionOutcome, captureFromReasoningReplay, skillFromCaptures, extractFailurePatterns, scoreExecutionCapture, scoreSkillRetrieval, workflowSignature, renderSkillForMemory, clusterCaptures, captureSimilarity, skillSimilarity, sequenceSimilarity, isUnsafeSkill, explicitSkillCommandName, skillSettlementOutcome, captureExecutionKey, hermesSkillEligibility, buildHermesSkillDraftPacket, validateAgentSkillDraft, quarantineHermesSkillCandidate, promoteHermesSkillCandidate };
