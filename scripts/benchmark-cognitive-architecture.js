#!/usr/bin/env node
"use strict";

const { ROLE_IDS, ROLE_CAPABILITIES, ModelRegistry, CognitiveCoordinator } = require("../src/cognitive-architecture");

function mk(id, role) {
  return { id, capabilities: ROLE_CAPABILITIES[role], contextWindow: 16000, latencyMs: 1, invoke: async () => role === ROLE_IDS.VERIFIER ? { ok: true, disagreements: [] } : { ok: true } };
}

(async () => {
  const registry = new ModelRegistry({ models: [
    mk("router", ROLE_IDS.ROUTER), mk("planner", ROLE_IDS.PLANNER), mk("executor", ROLE_IDS.EXECUTOR),
    mk("verifier", ROLE_IDS.VERIFIER), mk("summarizer", ROLE_IDS.SUMMARIZER), mk("memory", ROLE_IDS.MEMORY),
  ] });
  const coordinator = new CognitiveCoordinator({ registry, requireDistinctModels: true });
  const iterations = Number(process.argv[2] || 100);
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await coordinator.orchestrate(`benchmark task ${i}`);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const perTaskMs = elapsedMs / iterations;
  console.log(JSON.stringify({ iterations, elapsedMs, perTaskMs, tasksPerSecond: 1000 / perTaskMs, metrics: coordinator.metrics.snapshot() }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
