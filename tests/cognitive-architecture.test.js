"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROLE_IDS,
  ROLE_CAPABILITIES,
  ModelRegistry,
  CognitiveRole,
  CognitiveCoordinator,
  ArchitectureMetrics,
  createDefaultRegistry,
} = require("../src/cognitive-architecture");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-cognitive-arch-");
  const seen = [];
  const invoke = (id, fn) => async (payload) => { seen.push({ id, role: payload.role, system: payload.system, memory: payload.memory, tools: payload.tools, input: payload.input }); return fn(payload); };
  const registry = new ModelRegistry({ models: [
    { id: "plan", capabilities: ROLE_CAPABILITIES[ROLE_IDS.PLANNER], contextWindow: 10000, latencyMs: 1, invoke: invoke("plan", () => ({ planArtifact: { steps: ["edit src"] }, privateReasoning: "not for harness" })) },
    { id: "good", capabilities: ROLE_CAPABILITIES[ROLE_IDS.PLANNER], contextWindow: 10000, latencyMs: 1, invoke: invoke("good", () => ({ planArtifact: { steps: ["fallback"] } })) },
  ], statsFile: path.join(tmp, "model-stats.json") });

  const metrics = new ArchitectureMetrics({ file: path.join(tmp, "metrics.json") });
  const role = new CognitiveRole({ id: ROLE_IDS.PLANNER });
  const result = await role.run({ input: { task: "produce explicit plan artifact" }, registry, route: { model: registry.get("plan") }, metrics });
  assert.equal(result.model, "plan");
  assert.equal(seen[0].memory.length, 0, "compat role does not inject private role memory as reasoning context");
  assert(seen[0].system.includes("Do not expose private reasoning"), "prompt contract prevents private reasoning exposure");
  assert(fs.existsSync(path.join(tmp, "model-stats.json")), "model registry persists routing stats");

  const fallbackRegistry = new ModelRegistry({ models: [
    { id: "bad", capabilities: ROLE_CAPABILITIES[ROLE_IDS.PLANNER], contextWindow: 10000, fallback: ["good"], invoke: async () => { throw new Error("down"); } },
    { id: "good", capabilities: ROLE_CAPABILITIES[ROLE_IDS.PLANNER], contextWindow: 10000, invoke: async () => ({ planArtifact: { steps: ["fallback"] } }) },
  ] });
  const fallback = await role.run({ input: { task: "plan" }, registry: fallbackRegistry, route: { model: fallbackRegistry.get("bad") } });
  assert.equal(fallback.model, "good", "fallback chain recovers from failed primary");

  const coordinator = new CognitiveCoordinator();
  const scaffold = await coordinator.orchestrate("Refactor harness toward model-side reasoning", { steps: ["artifact schema", "tests"] });
  assert.equal(scaffold.kind, "reasoning.scaffold");
  assert.equal(scaffold.plan.type, "plan");
  assert.equal(coordinator.arbitrate({ verification: { ok: true } }).decision, "needs_evidence", "reflection alone is not proof");
  assert.equal(coordinator.arbitrate({ verification: { ok: false } }).decision, "revise");

  const defaultRegistry = createDefaultRegistry();
  const selected = defaultRegistry.select({ role: ROLE_IDS.EXECUTOR, tokenBudget: 12000 });
  assert(selected.primary.capabilities.includes("executor-actions"), "capability-aware routing selects executor-artifact model");

  console.log("cognitive-architecture compatibility tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
