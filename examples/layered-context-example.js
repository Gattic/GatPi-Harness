"use strict";

const { LayeredContextMemory } = require("../src/layered-context");

const memory = new LayeredContextMemory();

memory.upsert({
  layer: "L0",
  title: "Core operating rule",
  content: "Permanent rules and safety constraints cannot be overridden by task-local context.",
  tags: ["principle"],
  verification: "verified",
  protected: true,
});

memory.upsert({
  layer: "L1",
  title: "Hermes advisory architecture",
  content: "Pi remains the fast harness and owns canonical project memory; Hermes provides typed, explicit, off-path advice without mutation authority.",
  tags: ["architecture", "contract"],
  verification: "verified",
  architecturalImportance: 1,
});

memory.upsert({
  layer: "L2",
  title: "Current task",
  content: "Refactor linear context packing into a semantic five-layer context hierarchy.",
  tags: ["objective"],
  verification: "verified",
});

memory.upsert({
  layer: "L3",
  title: "Working file",
  content: "src/layered-context.js implements scoring, packing, compaction, integrity, and metrics.",
  dependencyRefs: ["src/layered-context.js"],
  verification: "verified",
});

memory.upsert({
  layer: "L4",
  title: "Scratch idea",
  content: "Try several scoring weights and keep the observable formula simple.",
  ttlMs: 5 * 60 * 1000,
});

const packed = memory.pack({
  tokenBudget: 180,
  query: "context architecture off-path Hermes advice",
  dependencyFocus: ["src/layered-context.js"],
});

console.log(packed.text);
console.log("\n--- observations ---");
console.log(JSON.stringify(packed.observations, null, 2));
console.log("\n--- metrics ---");
console.log(JSON.stringify(memory.metrics(), null, 2));
