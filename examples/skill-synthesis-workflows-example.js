"use strict";

/** Runnable deterministic examples for the skill synthesis lifecycle. */
const { createPiIntegrationBoundary, MemoryJsonStorage, RecordingSink } = require("../src/integration-boundary");

const boundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), sink: new RecordingSink() });

function topologyRun(runId, task, nodes, tools = ["read", "edit", "bash"], status = "succeeded") {
  return {
    runId,
    topologyId: "planner-coder-verifier",
    status,
    durationMs: 1000,
    input: { task },
    results: nodes.map(([id, role, summary]) => ({ nodeId: id, role, status: status === "succeeded" ? "succeeded" : "failed", summary })),
    trace: tools.map((tool) => ({ type: "topology.tool_call", payload: { tool } })),
    errors: status === "failed" ? [{ nodeId: "verify", message: "verification failed" }] : [],
    aggregation: { summary: `${task}: ${status}` },
  };
}

const debug = boundary.skills.captureTopologyRun(topologyRun("debug-1", "Fix failing parser test", [["plan", "planner", "Find failing parser case"], ["code", "coder", "Patch parser"], ["verify", "verifier", "Run parser tests"]]), { repository: { name: "repo-a" }, verification: { ok: true, commands: ["node tests/parser.test.js"] } });
const refactor = boundary.skills.captureTopologyRun(topologyRun("refactor-1", "Refactor prompt suggestion state", [["inspect", "researcher", "Inspect state flow"], ["code", "refactorer", "Extract state helper"], ["verify", "verifier", "Run prompt suggestion tests"]]), { repository: { name: "repo-a" }, verification: { ok: true, commands: ["node tests/prompt-suggestions.test.js"] } });
const failure = boundary.skills.captureTopologyRun(topologyRun("failure-1", "Fix flaky command", [["plan", "planner", "Plan retry"], ["verify", "verifier", "Command failed"]], ["bash"], "failed"), { repository: { name: "repo-a" }, verification: { ok: false } });

const synthesized = boundary.skills.synthesize({ minRepeats: 1 });
const suggestions = boundary.skills.suggest("Fix a similar parser regression", { repository: "repo-a", tools: ["read", "edit", "bash"], includeDrafts: true });
const topology = boundary.skills.synthesizeTopologyTemplate(synthesized.skills[0].skillId);
const replay = boundary.skills.replay(debug.captureId);
const ab = boundary.skills.abTest(synthesized.skills[0].skillId, "Fix a similar parser regression", { score: 0.4 });
const provider = boundary.skills.registerProvider({ providerId: "repo-a-procedures", skills: [{ name: "Repository-specific docs memory", description: "Update repo docs and verify examples", category: "documentation", triggerConditions: ["repo-a docs"], applicableRepositories: ["repo-a"], workflowSteps: [{ description: "Edit docs" }, { description: "Run examples" }], validationStrategy: { kind: "command", commands: ["node examples/skill-synthesis-example.js"] }, confidenceScore: 0.88 }] });

console.log(JSON.stringify({
  examples: [
    "successful debugging workflow becomes reusable skill",
    "refactor workflow synthesis",
    "planner-executor-verifier skill extraction",
    "failure learning example",
    "automatic skill retrieval on similar task",
    "workflow topology synthesis",
    "repository-specific procedural memory",
  ],
  captures: [debug.captureId, refactor.captureId, failure.captureId],
  skills: synthesized.skills.map((s) => ({ id: s.skillId, name: s.name, status: s.status })),
  suggestions: suggestions.suggestions.map((s) => ({ id: s.skillId, score: Number(s.score.toFixed(3)) })),
  replaySteps: replay.steps.length,
  abRecommendation: ab.recommendation,
  topologyId: topology.topologyId,
  providerSkills: provider.skills.map((s) => s.skillId),
  failurePatterns: boundary.skills.listFailurePatterns().length,
}, null, 2));
