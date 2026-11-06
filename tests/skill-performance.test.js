"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { createPiIntegrationBoundary, MemoryJsonStorage } = require("../src/integration-boundary");

const boundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), skills: { options: { loadCurated: false, loadNative: false } } });
const skills = [];
for (let i = 0; i < 500; i++) {
  skills.push({
    skillId: `skill_perf_${i}`,
    name: `Perf skill ${i}`,
    description: i % 5 === 0 ? "Debug failing tests and verify" : "General workflow",
    category: i % 5 === 0 ? "debugging" : "general",
    status: i % 3 === 0 ? "approved" : "candidate",
    triggerConditions: [`task ${i}`, i % 5 === 0 ? "failing tests" : "general"],
    workflowSteps: [{ description: "Inspect" }, { description: "Execute" }, { description: "Verify evidence" }],
    validationStrategy: { kind: "evidence", requiredEvidence: ["verification"] },
    confidenceScore: 0.5 + (i % 50) / 100,
  });
}
boundary.skills.registerProvider({ providerId: "perf", skills });

const started = performance.now();
const result = boundary.skills.suggest("debug failing tests with verification", { tools: ["read", "bash"], limit: 10 });
const elapsed = performance.now() - started;
assert(result.suggestions.length > 0);
assert(elapsed < 250, `skill retrieval should stay fast on 500 skills, got ${elapsed.toFixed(1)}ms`);

console.log("skill performance tests passed");
