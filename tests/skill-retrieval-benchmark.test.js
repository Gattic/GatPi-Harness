"use strict";

const assert = require("node:assert/strict");
const { createPiIntegrationBoundary, MemoryJsonStorage } = require("../src/integration-boundary");

const boundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage() });
boundary.skills.registerProvider({ providerId: "bench", skills: [
  { name: "Debug failing tests", description: "Inspect failure, patch code, run targeted tests", category: "debugging", triggerConditions: ["failing tests", "test failure"], requiredTools: ["read", "edit", "bash"], workflowSteps: [{ description: "Inspect failing test" }, { description: "Patch root cause" }, { description: "Run tests" }], validationStrategy: { kind: "command", commands: ["npm test"] }, confidenceScore: 0.91 },
  { name: "Documentation update", description: "Update README and verify examples", category: "documentation", triggerConditions: ["docs", "readme"], requiredTools: ["read", "edit"], workflowSteps: [{ description: "Edit docs" }, { description: "Run example" }], validationStrategy: { kind: "evidence", requiredEvidence: ["example output"] }, confidenceScore: 0.86 },
  { name: "Refactor module", description: "Refactor implementation while preserving behavior", category: "refactor", triggerConditions: ["refactor", "cleanup module"], requiredTools: ["read", "edit", "bash"], workflowSteps: [{ description: "Inspect module" }, { description: "Refactor code" }, { description: "Run regression tests" }], validationStrategy: { kind: "command", commands: ["npm test"] }, confidenceScore: 0.88 },
] });

const debug = boundary.skills.suggest("Fix the failing parser tests", { tools: ["read", "edit", "bash"] }).suggestions;
assert.equal(debug[0].name, "Debug failing tests", "debug task should rank debugging skill first");
const docs = boundary.skills.suggest("Update README documentation", { tools: ["read", "edit"] }).suggestions;
assert.equal(docs[0].name, "Documentation update", "docs task should rank docs skill first");
const refactor = boundary.skills.suggest("Refactor the module and preserve behavior", { tools: ["read", "edit", "bash"] }).suggestions;
assert.equal(refactor[0].name, "Refactor module", "refactor task should rank refactor skill first");

const reviewed = [
  ["Fix the failing parser tests", "Debug failing tests"],
  ["Update README documentation", "Documentation update"],
  ["Refactor the module and preserve behavior", "Refactor module"],
  ["Explain current branch status", null],
  ["Answer whether the service is healthy", null],
];
let correct = 0;
for (const [task, expected] of reviewed) {
  const shown = boundary.skills.retrieve(task, { limit: 1, minScore: 0.5 }).skills[0]?.name || null;
  if (shown === expected) correct++;
  assert.equal(shown, expected, `fixed skill relevance fixture: ${task}`);
}
const precision = correct / reviewed.length;
assert(precision >= 0.8, `reviewed skill suggestion precision ${precision} must meet 0.80`);

console.log("skill retrieval benchmark tests passed");
