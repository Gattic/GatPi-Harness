"use strict";

/**
 * Compatibility facade for the former internal cognitive-orchestration module.
 *
 * The harness no longer attempts to implement reasoning internally. Reasoning is
 * model-side. This facade preserves older imports for routing/model metadata,
 * while delegating durable work products to `reasoning-runtime` artifacts.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ReasoningRuntime } = require("./reasoning-runtime");

const ROLE_IDS = Object.freeze({
  PLANNER: "planner",
  EXECUTOR: "executor",
  VERIFIER: "verifier",
  SUMMARIZER: "summarizer",
  ROUTER: "router",
  MEMORY: "memory-consolidator",
});

const ROLE_CAPABILITIES = Object.freeze({
  [ROLE_IDS.PLANNER]: ["planning-artifacts", "task-decomposition"],
  [ROLE_IDS.EXECUTOR]: ["executor-actions"],
  [ROLE_IDS.VERIFIER]: ["verifier-evidence", "failure-analysis"],
  [ROLE_IDS.SUMMARIZER]: ["result-summary"],
  [ROLE_IDS.ROUTER]: ["model-selection"],
  [ROLE_IDS.MEMORY]: ["memory-updates"],
});

const DEFAULT_PROMPTS = Object.freeze(Object.fromEntries(Object.values(ROLE_IDS).map((id) => [id, `Produce explicit ${id} artifacts. Do not expose private reasoning; provide public results and evidence only.`])));
const DEFAULT_TOOLS = Object.freeze({
  [ROLE_IDS.PLANNER]: ["read", "search"],
  [ROLE_IDS.EXECUTOR]: ["read", "search", "edit", "write", "shell"],
  [ROLE_IDS.VERIFIER]: ["read", "search", "shell", "test"],
  [ROLE_IDS.SUMMARIZER]: [],
  [ROLE_IDS.ROUTER]: [],
  [ROLE_IDS.MEMORY]: ["memory.write"],
});

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function estimateTokens(value) { return Math.ceil(JSON.stringify(value ?? "").length / 4); }
function estimateCost(model, tokenBudget) { return ((model.inputCostPerMTok || 0) + (model.outputCostPerMTok || 0) * 0.25) * tokenBudget / 1_000_000; }
function classifyTask(value) {
  const text = String(typeof value === "string" ? value : JSON.stringify(value || {})).toLowerCase();
  if (/verify|test|failure|evidence/.test(text)) return "verification";
  if (/implement|edit|patch|code/.test(text)) return "implementation";
  if (/memory|summari[sz]e/.test(text)) return "memory";
  return "planning";
}
function unique(xs) { return Array.from(new Set((xs || []).filter(Boolean))); }

class ModelRegistry {
  constructor({ models = [], statsFile = null } = {}) { this.models = new Map(); this.statsFile = statsFile; this.stats = statsFile ? readJson(statsFile, {}) : {}; for (const m of models) this.register(m); }
  register(model) { if (!model?.id) throw new Error("model requires id"); const m = { provider: "model", capabilities: [], contextWindow: 8192, latencyMs: 1000, reliability: 0.8, fallback: [], invoke: null, ...model, capabilities: unique(model.capabilities) }; this.models.set(m.id, m); this.stats[m.id] ||= { calls: 0, failures: 0, avgLatencyMs: m.latencyMs, tokens: 0 }; return m; }
  get(id) { return this.models.get(id); }
  list() { return Array.from(this.models.values()); }
  select({ role, required = [], tokenBudget = 4096, exclude = [] } = {}) { const caps = unique([...(ROLE_CAPABILITIES[role] || []), ...required]); const excluded = new Set(exclude); const candidates = this.list().filter((m) => !excluded.has(m.id) && m.contextWindow >= tokenBudget && caps.every((c) => m.capabilities.includes(c))); candidates.sort((a, b) => (b.reliability || 0) - (a.reliability || 0)); const primary = candidates[0] || null; return primary ? { primary, chain: this.fallbackChain(primary.id, excluded) } : null; }
  fallbackChain(id, excluded = new Set()) { const out = []; const seen = new Set([id, ...excluded]); const visit = (x) => { for (const fid of this.get(x)?.fallback || []) if (!seen.has(fid) && this.get(fid)) { seen.add(fid); out.push(this.get(fid)); visit(fid); } }; visit(id); return out; }
  record(id, { ok, latencyMs = 0, tokens = 0 } = {}) { const s = this.stats[id] ||= { calls: 0, failures: 0, avgLatencyMs: 0, tokens: 0 }; s.calls++; if (!ok) s.failures++; s.tokens += tokens; s.avgLatencyMs = s.avgLatencyMs ? s.avgLatencyMs * 0.8 + latencyMs * 0.2 : latencyMs; if (this.statsFile) writeJson(this.statsFile, this.stats); }
}

class RoleMemory { constructor(role) { this.role = role; this.entries = []; } remember(type, content, metadata = {}) { const e = { role: this.role, type, content, metadata, at: new Date().toISOString() }; this.entries.push(e); return e; } view() { return this.entries.slice(); } }
class MessageBus { constructor() { this.messages = []; } publish(m) { const msg = { at: new Date().toISOString(), ...m }; this.messages.push(msg); return msg; } transcript() { return this.messages.slice(); } }

class CognitiveRole {
  constructor({ id, prompt, tools = null, memory = null, handler = null } = {}) { this.id = id; this.prompt = prompt || DEFAULT_PROMPTS[id]; this.tools = new Set(tools || DEFAULT_TOOLS[id] || []); this.memory = memory || new RoleMemory(id); this.handler = handler; }
  memoryView() { return this.memory.view(); }
  canUse(tool) { return this.tools.has(tool); }
  async run({ input, registry, route, bus, metrics, correlationId } = {}) {
    const selected = route?.model || registry?.select({ role: this.id })?.primary;
    const chain = [selected, ...(registry?.fallbackChain(selected?.id || "") || [])].filter(Boolean);
    if (!chain.length && !this.handler) return { role: this.id, model: null, output: { artifactRequired: true, input }, latencyMs: 0, tokens: estimateTokens(input) };
    let lastError;
    for (const model of chain.length ? chain : [{ id: "handler" }]) {
      const start = Date.now();
      try {
        const output = this.handler ? await this.handler({ role: this.id, system: this.prompt, input, memory: [], tools: Array.from(this.tools), correlationId }, model) : await model.invoke({ role: this.id, system: this.prompt, input, memory: [], tools: Array.from(this.tools), correlationId });
        const latencyMs = Date.now() - start; const tokens = estimateTokens(input) + estimateTokens(output); registry?.record?.(model.id, { ok: true, latencyMs, tokens }); metrics?.recordRoleRun?.(this.id, { ok: true, model: model.id, latencyMs, tokens }); bus?.publish?.({ from: this.id, to: "runtime", type: "model_artifact", correlationId, payload: output }); return { role: this.id, model: model.id, output, latencyMs, tokens };
      } catch (error) { lastError = error; registry?.record?.(model.id, { ok: false, latencyMs: Date.now() - start, tokens: estimateTokens(input) }); }
    }
    throw lastError;
  }
}

class RouterPolicy { constructor({ registry } = {}) { this.registry = registry; } route({ role, task, tokenBudget = 4096, excludeModelIds = [] } = {}) { const selection = this.registry?.select({ role, tokenBudget, exclude: excludeModelIds }); return { role, classification: classifyTask(task), tokenBudget, model: selection?.primary || null, fallback: selection?.chain || [] }; } }
class ArchitectureMetrics { constructor({ file = null } = {}) { this.file = file; this.data = file ? readJson(file, { roles: {}, completedTasks: 0 }) : { roles: {}, completedTasks: 0 }; } recordRoleRun(role, event) { const r = this.data.roles[role] ||= { runs: 0, failures: 0, tokens: 0 }; r.runs++; if (!event.ok) r.failures++; r.tokens += event.tokens || 0; this.persist(); } completeTask() { this.data.completedTasks++; this.persist(); } snapshot() { return { ...this.data }; } persist() { if (this.file) writeJson(this.file, this.data); } }

class CognitiveCoordinator {
  constructor({ runtime = null, storage = null, sink = null } = {}) { this.runtime = runtime || new ReasoningRuntime({ storage, sink }); }
  async orchestrate(task, options = {}) { const plan = this.runtime.createPlan({ objective: task, steps: options.steps || [], source: "model" }); const decomposition = this.runtime.decomposeTask({ task, subtasks: options.subtasks || [] }); const checkpoint = this.runtime.createCheckpoint({ kind: "plan", publicSummary: "Scaffold created; model must provide reasoning artifacts and verifier evidence.", artifactIds: [plan.id, decomposition.id] }); return { kind: "reasoning.scaffold", task, plan, decomposition, checkpoint, artifacts: this.runtime.publicArtifacts() }; }
  arbitrate({ verification } = {}) { if (verification?.ok === false) return { decision: "revise", reason: "verifier evidence failed" }; return { decision: "needs_evidence", reason: "acceptance requires verifier evidence, not reflection" }; }
}

function createDefaultRoles() { return Object.fromEntries(Object.values(ROLE_IDS).map((id) => [id, new CognitiveRole({ id })])); }
function createDefaultRegistry() { return new ModelRegistry({ models: Object.entries(ROLE_CAPABILITIES).map(([role, capabilities]) => ({ id: `${role}-model`, capabilities, contextWindow: 32000 })) }); }

module.exports = { ROLE_IDS, ROLE_CAPABILITIES, DEFAULT_PROMPTS, DEFAULT_TOOLS, ModelRegistry, RoleMemory, MessageBus, CognitiveRole, RouterPolicy, ArchitectureMetrics, CognitiveCoordinator, createDefaultRoles, createDefaultRegistry, estimateCost, estimateTokens, classifyTask };
