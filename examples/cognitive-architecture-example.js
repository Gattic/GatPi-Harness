"use strict";

const {
  ROLE_IDS,
  ROLE_CAPABILITIES,
  ModelRegistry,
  CognitiveCoordinator,
} = require("../src/cognitive-architecture");

const model = (id, role, output) => ({
  id,
  capabilities: ROLE_CAPABILITIES[role],
  contextWindow: 24000,
  latencyMs: 25,
  invoke: async (payload) => ({ ...output, handledBy: id, visibleTools: payload.tools }),
});

(async () => {
  const registry = new ModelRegistry({ models: [
    model("fast-router", ROLE_IDS.ROUTER, { classification: "implementation", tokenBudget: 8000 }),
    model("deep-planner", ROLE_IDS.PLANNER, { plan: ["split roles", "wire registry", "verify isolation"] }),
    model("coder-specialist", ROLE_IDS.EXECUTOR, { patches: [{ file: "src/cognitive-architecture.js", kind: "refactor" }] }),
    model("skeptical-verifier", ROLE_IDS.VERIFIER, { ok: true, disagreements: [], invariants: ["distinct roles", "verifier isolated"] }),
    model("compact-summarizer", ROLE_IDS.SUMMARIZER, { summary: "Role-specialized architecture accepted." }),
    model("memory-writer", ROLE_IDS.MEMORY, { consolidated: true, entries: ["Verified role architecture"] }),
  ] });

  const coordinator = new CognitiveCoordinator({ registry, requireDistinctModels: true });
  const result = await coordinator.orchestrate("Implement role-specialized multi-model cognitive architecture");
  console.log(JSON.stringify({
    arbitration: result.arbitration,
    models: {
      router: result.router.model,
      planner: result.plan.model,
      executor: result.implementation.model,
      verifier: result.verification.model,
      summarizer: result.summary.model,
      memory: result.memory.model,
    },
    metrics: result.metrics,
  }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
