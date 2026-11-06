"use strict";
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { MemoryJsonStorage, CognitiveMemoryAdapter } = require("../src/integration-boundary");

const entries = [];
for (let i = 0; i < 1200; i++) {
  entries.push({
    id: `mem_episodic_perf_${i}`,
    type: "episodic",
    title: `Assistant turn ${i}`,
    content: `public summary ${i}`,
    tags: ["assistant-turn"],
    createdAt: Date.now() - i,
    updatedAt: Date.now() - i,
    lastAccessedAt: Date.now() - i,
    confidence: 0.45,
    verification: "inferred",
    provenance: { source: "test" },
  });
}
const storage = new MemoryJsonStorage({ "cognitive-memory": { version: 1, lastConsolidatedAt: 0, entries, audit: [] } });
const start = performance.now();
const adapter = new CognitiveMemoryAdapter({ storage });
const elapsed = performance.now() - start;
assert.equal(adapter.metrics().totalEntries, entries.length);
assert(elapsed < 500, `memory hydration should be linear/fast, got ${elapsed.toFixed(1)}ms`);
console.log("integration-boundary-hydration-performance tests passed");
