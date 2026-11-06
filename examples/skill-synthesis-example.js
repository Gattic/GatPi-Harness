"use strict";

const { createPiIntegrationBoundary, MemoryJsonStorage, RecordingSink } = require("../src/integration-boundary");

const boundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), sink: new RecordingSink() });

const run = {
  runId: "toprun_example_debug",
  topologyId: "planner-coder-verifier",
  status: "succeeded",
  durationMs: 900,
  input: { task: "Fix a regression and verify tests" },
  results: [
    { nodeId: "plan", role: "planner", status: "succeeded", summary: "Identify failing test and plan narrow fix" },
    { nodeId: "code", role: "coder", status: "succeeded", summary: "Patch the implementation" },
    { nodeId: "verify", role: "verifier", status: "succeeded", summary: "Run targeted and full tests" },
  ],
  trace: [
    { type: "topology.tool_call", payload: { tool: "read" } },
    { type: "topology.tool_call", payload: { tool: "edit" } },
    { type: "topology.tool_call", payload: { tool: "bash" } },
  ],
  aggregation: { summary: "Regression fixed with verification evidence" },
  errors: [],
};

const capture = boundary.skills.captureTopologyRun(run, {
  repository: { name: "demo-repo" },
  verification: { ok: true, commands: ["npm test"] },
});
console.log("capture", capture.captureId, capture.outcome, capture.score.toFixed(2));

const synthesized = boundary.skills.synthesize({ minRepeats: 1, approve: true });
console.log("skills", synthesized.skills.map((s) => ({ id: s.skillId, name: s.name, status: s.status, confidence: s.confidenceScore.toFixed(2) })));

const suggestions = boundary.skills.suggest("Fix failing tests in a similar repository", { tools: ["read", "edit", "bash"] });
console.log("suggestions", suggestions.suggestions.map((s) => ({ id: s.skillId, score: s.score.toFixed(2), name: s.name })));

const template = boundary.skills.synthesizeTopologyTemplate(synthesized.skills[0].skillId);
console.log("topology", JSON.stringify(template, null, 2));
