"use strict";

const { CognitiveMemory } = require("../src/cognitive-memory");

const memory = new CognitiveMemory();

memory.remember({
  type: "strategic",
  title: "Harness direction",
  content: "Keep Pi fast; optional provider advisories must stay explicit, off-path, observable, and unable to own canonical memory.",
  tags: ["performance", "maintainability"],
  symbols: ["HermesAdvisoryAdapter"],
  confidence: 0.95,
  verification: "verified",
  provenance: { source: "project-policy" },
});

memory.remember({
  type: "semantic",
  title: "Hermes advisory contract",
  content: "Hermes receives typed privacy-safe packets, returns typed suggestions with metadata-only receipts, and cannot mutate canonical state.",
  tags: ["architecture", "contract", "invariant"],
  symbols: ["HermesAdvisoryAdapter"],
  paths: ["extensions/hermes-advisory/index.ts"],
  confidence: 0.96,
  verification: "verified",
  provenance: { source: "durable-recall" },
});

memory.remember({
  type: "procedural",
  title: "Hermes advisory smoke validation",
  content: "Run scripts/smoke-hermes-advisory.sh and confirm typed output with metadata-only receipts.",
  tags: ["testing", "workflow"],
  symbols: ["HermesAdvisoryAdapter"],
  paths: ["scripts/smoke-hermes-advisory.sh"],
  confidence: 0.9,
  verification: "verified",
  provenance: { source: "test" },
});

memory.remember({
  type: "episodic",
  title: "Prior advisory validation",
  content: "The synthetic advisory smoke passed; field acceptance and memory-promotion precision remain unmeasured.",
  tags: ["execution-history", "risk"],
  paths: ["scripts/smoke-hermes-advisory.sh"],
  confidence: 0.82,
  verification: "verified",
  provenance: { source: "session-summary" },
});

console.log(JSON.stringify(memory.consolidate({ force: true }).decisions, null, 2));
const result = memory.retrieve("off-path advisory architecture and testing workflow", { architectureFocus: 0.8, limit: 5 });
console.log(result.observations.included.map((x) => ({ type: x.type, title: x.title, score: x.score.total.toFixed(3), why: x.why })));
