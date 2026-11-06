"use strict";

process.env.PI_ROLE_MUTATION = "isolated";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPiIntegrationBoundary, MemoryJsonStorage, RecordingSink } = require("../src/integration-boundary");
const { AgentRoleRegistry, TopologyRegistry, TopologyExecutionEngine, ToolPermissionError, SubagentTopologyExecutor, loadTopologyExtension, loadTopologyConfigDir, replayTrace, validateSimpleSchema, evaluateEdgeCondition, evidenceProjection, subagentTaskFromContext, createTopologyTemplates, listBuiltInRoleTopologies, materializeRoleAwareTopology, normalizeRoleId } = require("../src/multi-agent-topologies");
const { isTopologyImplementationCapable } = require("../src/role-topologies");
const { applyRoadmapPlan, reconcileRoadmapPlan } = require("../src/roadmap-plan-application");
const { createRoadmap, getActivePath, getProgress, loadRoadmap, saveRoadmap } = require("../.pi/extensions/roadmap/roadmap-state.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function findRoadmapById(roadmap, roadmapId) {
  if (!roadmap) return null;
  if (roadmap.id === roadmapId) return roadmap;
  for (const item of roadmap.items || []) {
    for (const subtask of item.subtasks || []) {
      const found = findRoadmapById(subtask, roadmapId);
      if (found) return found;
    }
  }
  return null;
}

(async () => {
  const roles = new AgentRoleRegistry();
  roles.register({ roleId: "det", displayName: "Deterministic", allowedTools: ["read"], deniedTools: ["write"], memoryPolicy: "read-write", retryPolicy: { maxRetries: 1 } });
  assert.equal(roles.get("det").displayName, "Deterministic");
  assert(roles.list().some((r) => r.roleId === "planner"));
  assert.equal(roles.resolve("Reviewer").roleId, "reviewer", "role lookup normalizes registered display names");
  assert.equal(normalizeRoleId(" Security Reviewer "), "security-reviewer");

  const topologies = new TopologyRegistry();
  topologies.register({ topologyId: "seq", executionMode: "sequential", aggregationPolicy: "last", nodes: [{ id: "a", roleId: "det" }, { id: "b", roleId: "det" }], edges: [{ source: "a", target: "b" }], terminalNodes: ["b"] });
  assert.equal(topologies.get("seq").nodes.length, 2);

  const calls = [];
  const engine = new TopologyExecutionEngine({
    roleRegistry: roles,
    topologyRegistry: topologies,
    tools: { read: async (x) => `read:${x}`, write: async () => "bad" },
    agentExecutor: async ({ node, context }) => {
      calls.push(node.id);
      const read = await context.tools.read(node.id);
      return { content: `${node.id}:${read}:${context.dependencyResults.map((r) => r.nodeId).join(",")}`, summary: node.id, payload: { deps: context.dependencyResults.length } };
    },
  });
  const seq = await engine.execute("seq", { task: "work" });
  assert.equal(seq.schemaVersion, 3, "topology execution packets use schema v3");
  assert.equal(seq.status, "succeeded");
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(seq.aggregation.nodeId, "b");
  assert.equal(seq.results.find((r) => r.nodeId === "b").payload.deps, 1);

  topologies.register({ topologyId: "fan", executionMode: "dag", concurrencyLimit: 2, aggregationPolicy: "terminal", nodes: [{ id: "left", roleId: "det" }, { id: "right", roleId: "det" }, { id: "join", roleId: "det" }], edges: [{ source: "left", target: "join" }, { source: "right", target: "join" }], terminalNodes: ["join"] });
  const fan = await engine.execute("fan", { task: "fanout" });
  assert.equal(fan.results.length, 3);
  assert.equal(fan.results.find((r) => r.nodeId === "join").payload.deps, 2);
  assert(fan.nodeStates.every((state) => state.status === "succeeded"));

  const partialEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node, context }) => { if (node.id === "bad" || node.id === "also-bad") throw new Error("worker failed"); return { content: node.id, summary: node.id, payload: { dependencyCount: context.dependencyResults.length } }; } });
  const partialRun = await partialEngine.execute({ topologyId: "partial-min-success", executionMode: "dag", concurrencyLimit: 4, failurePolicy: "continue-on-error", partialPolicy: "report", nodes: [{ id: "one", roleId: "worker" }, { id: "two", roleId: "worker" }, { id: "three", roleId: "worker" }, { id: "bad", roleId: "worker" }, { id: "join", roleId: "worker", contextPolicy: "evidence-only", joinPolicy: { mode: "min-success", minimumSuccessfulInputs: 3, includeFailedInputs: true } }], edges: ["one", "two", "three", "bad"].map((source) => ({ source, target: "join", condition: "always" })), terminalNodes: ["join"] }, { task: "partial" });
  assert.equal(partialRun.status, "partial", "a tolerated exploratory worker failure is reported as partial, never success");
  assert.equal(partialRun.results.find((result) => result.nodeId === "join").payload.dependencyCount, 4, "evidence-only reducers receive explicit failed-worker envelopes");
  assert.equal(partialRun.nodeStates.find((state) => state.nodeId === "bad").status, "failed");
  assert.equal(partialRun.joinDecisions.find((join) => join.nodeId === "join").successfulInputs, 3);
  assert.equal(partialRun.joinDecisions.find((join) => join.nodeId === "join").degraded, true);

  const blockedRun = await partialEngine.execute({ topologyId: "blocked-min-success", executionMode: "dag", concurrencyLimit: 4, failurePolicy: "continue-on-error", partialPolicy: "report", nodes: [{ id: "one", roleId: "worker" }, { id: "two", roleId: "worker" }, { id: "bad", roleId: "worker" }, { id: "also-bad", roleId: "worker" }, { id: "join", roleId: "worker", joinPolicy: { mode: "min-success", minimumSuccessfulInputs: 3, includeFailedInputs: true } }], edges: ["one", "two", "bad", "also-bad"].map((source) => ({ source, target: "join", condition: "always" })), terminalNodes: ["join"] }, { task: "blocked" });
  assert.equal(blockedRun.status, "failed");
  assert.equal(blockedRun.nodeStates.find((state) => state.nodeId === "join").status, "blocked");

  const runJoinMode = async (mode, failedIds = [], minimumSuccessfulInputs) => {
    const modeEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node }) => { if (failedIds.includes(node.id)) throw new Error(`${node.id} failed`); return { content: node.id, summary: node.id }; } });
    const sources = ["a1", "a2", "a3", "a4"];
    return modeEngine.execute({ topologyId: `join-${mode}-${failedIds.length}`, executionMode: "dag", concurrencyLimit: 4, failurePolicy: "continue-on-error", partialPolicy: "report", nodes: [...sources.map((id) => ({ id, roleId: "worker" })), { id: "join", roleId: "worker", joinPolicy: { mode, ...(minimumSuccessfulInputs == null ? {} : { minimumSuccessfulInputs }), includeFailedInputs: true } }], edges: sources.map((source) => ({ source, target: "join", condition: "always" })), terminalNodes: ["join"] }, {});
  };
  assert.equal((await runJoinMode("all")).status, "succeeded", "all requires all four successful inputs");
  const allFailed = await runJoinMode("all", ["a4"]);
  assert.equal(allFailed.status, "failed");
  assert.equal(allFailed.nodeStates.find((state) => state.nodeId === "join").status, "blocked");
  assert.equal((await runJoinMode("quorum", ["a4"])).status, "partial", "quorum accepts three of four but reports degradation");
  assert.equal((await runJoinMode("min-success", ["a4"], 3)).status, "partial", "min-success uses the explicit threshold");
  assert.equal((await runJoinMode("best-effort", ["a2", "a3", "a4"])).status, "partial", "best-effort accepts one success but never reports full success");

  const projected = evidenceProjection({ nodeId: "worker", role: "researcher", status: "succeeded", summary: "pre-merged conclusion must not cross", payload: { claims: [{ id: "c1", statement: "Claim", evidenceRefs: ["e1"] }], evidenceRefs: [{ id: "e1", kind: "source", source: "src/a.js" }] } });
  assert.equal(projected.summary, undefined, "evidence-only projection excludes worker narrative conclusions");
  assert.equal(projected.claims.length, 1);
  const projectedBaseline = evidenceProjection({ nodeId: "code", role: "coder", status: "succeeded", payload: { workspaceDisposition: { status: "baseline-satisfied", changedPaths: ["src/example.js"], reason: "Inherited task-relevant changes already satisfy the delegated assignment." } } });
  assert.equal(projectedBaseline.workspaceDisposition.status, "baseline-satisfied", "evidence projections preserve an authorized inherited-baseline disposition");

  await assert.rejects(() => partialEngine.execute({ topologyId: "unsafe-partial-verifier", partialPolicy: "report", nodes: [{ id: "verify", roleId: "verifier", joinPolicy: { mode: "best-effort" } }] }, {}), (error) => error.code === "TOPOLOGY_PARTIAL_MUTATION_FORBIDDEN");
  await assert.rejects(() => partialEngine.execute({ topologyId: "unsafe-verifier-join", nodes: [{ id: "source", roleId: "det" }, { id: "verify", roleId: "verifier", joinPolicy: { mode: "best-effort" } }], edges: [{ source: "source", target: "verify", condition: "always" }] }, {}), (error) => error.code === "TOPOLOGY_UNSAFE_JOIN_POLICY");

  let activeEvidenceWorkers = 0;
  let maximumActiveEvidenceWorkers = 0;
  const evidenceTopology = listBuiltInRoleTopologies().find((topology) => topology.topologyId === "parallel-evidence-synthesis");
  const evidenceFixture = { ...evidenceTopology, nodes: evidenceTopology.nodes.map((node) => ({ ...node, executionMode: node.roleId === "coordinator" ? "handler" : "handler" })) };
  const workerIds = new Set(["research", "compare", "check", "gaps"]);
  const evidenceEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node, context }) => {
    const base = { schemaVersion: 2, contractVersion: "role-v2", summary: `${node.id} completed its bounded assignment from repository evidence.`, findings: [], evidence: [{ kind: "path", source: `src/${node.id}.js` }], verification: { status: "passed", evidence: [`${node.id} fixture passed`] } };
    if (node.id === "scope") return { payload: { ...base, analysisPlan: { title: "Four angles", assignments: [...workerIds].map((id) => ({ id, angle: id, objective: `Inspect ${id}` })) } } };
    if (workerIds.has(node.id)) {
      assert.equal(context.dependencyResults.length, 1, `${node.id} sees only the shared scope result`);
      assert.equal(context.allResults, undefined, `${node.id} cannot see sibling trajectories`);
      activeEvidenceWorkers += 1;
      maximumActiveEvidenceWorkers = Math.max(maximumActiveEvidenceWorkers, activeEvidenceWorkers);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeEvidenceWorkers -= 1;
      return { payload: { ...base, claims: [{ id: `claim-${node.id}`, statement: `${node.id} claim`, status: "proposed", evidenceRefs: [`evidence-${node.id}`] }], evidenceRefs: [{ id: `evidence-${node.id}`, kind: node.id, source: `src/${node.id}.js` }] } };
    }
    if (node.id === "audit") {
      const claims = context.dependencyResults.flatMap((result) => result.claims || []);
      const evidenceRefs = context.dependencyResults.flatMap((result) => result.evidenceRefs || []);
      return { payload: { ...base, claims: claims.map((claim) => ({ ...claim, status: "accepted" })), evidenceRefs, auditDecisions: claims.map((claim) => ({ claimId: claim.id, decision: "accepted", rationale: "Supported by fixture evidence", evidenceRefs: claim.evidenceRefs })), rejectedClaims: [], unresolvedGaps: [], coverage: { expectedCategories: [...workerIds], observedCategories: [...workerIds], missingCategories: [], ratio: 1 } } };
    }
    throw new Error(`unexpected fixture node ${node.id}`);
  } });
  const evidenceRun = await evidenceEngine.execute(evidenceFixture, { task: "fixture evidence synthesis" });
  assert.equal(evidenceRun.status, "succeeded");
  assert.equal(evidenceRun.aggregation.payload.claims.length, 4);
  assert.equal(evidenceRun.aggregation.payload.coverage.ratio, 1);
  assert.equal(evidenceRun.aggregation.payload.rejectedClaims.length, 0);
  assert(maximumActiveEvidenceWorkers >= 4, "the topology engine starts all four independent evidence workers in one bounded batch");

  let capturedSubagent;
  const subExec = new SubagentTopologyExecutor({ service: { createSubagent(args) { capturedSubagent = args; return { id: "sub1", branchId: "br1" }; }, runSubagent: async () => ({ status: "succeeded", summary: "sub ok", final_response: "sub ok", artifacts: [], diagnostics: {}, submitted_result: { summary: "Subagent completed with bounded public evidence.", findings: [], evidence: [{ kind: "path", source: "src/example.js" }], unresolvedGaps: [{ id: "gap-1", summary: "A bounded gap remains." }], coverage: { expectedCategories: ["source"], observedCategories: [], missingCategories: ["source"], ratio: 0 } } }) } });
  const subResult = await subExec.execute({ node: { id: "code", roleId: "det", task: "Implement {{task}}" }, role: roles.get("det"), context: { task: "Implement feature", dependencyResults: [{ nodeId: "plan", status: "succeeded", summary: "Plan summary" }] }, run: { runId: "run1", parentSessionId: "sess1", topology: { topologyId: "top1" } } });
  assert.equal(subResult.status, "succeeded");
  assert.equal(subResult.payload.unresolvedGaps.length, 1, "role-specific public fields are promoted for topology aggregation");
  assert.equal(subResult.payload.coverage.ratio, 0, "coverage remains visible outside nested submitted_result envelopes");
  assert(capturedSubagent.task.startsWith("Implement feature"), "subagent task should use already-rendered node context");
  assert(!capturedSubagent.task.includes("Implement Implement"), "subagent task should not double-render {{task}}");
  assert(capturedSubagent.task.includes("Plan summary"), "subagent task includes upstream dependency summaries");
  assert.deepEqual(capturedSubagent.toolPolicy, { allowedTools: ["read", "submit_role_result"], deniedTools: ["write"] }, "subagent nodes receive the registered role-v2 policy including typed result submission");
  assert.equal(capturedSubagent.roleContract.contractVersion, "role-v2");
  assert.equal(capturedSubagent.workspacePolicy, "shared-readonly");
  assert.equal(capturedSubagent.metadata.roleResolution, "registered");
  assert(subagentTaskFromContext({ task: "Verify {{task}}" }, { task: "Verify feature" }).startsWith("Verify feature"));
  const baselineVerifierTask = subagentTaskFromContext({ task: "Verify inherited implementation" }, { dependencyResults: [{ nodeId: "code", role: "coder", status: "succeeded", summary: "No child-local patch was required.", payload: { workspaceDisposition: { status: "baseline-satisfied", changedPaths: ["src/example.js"], reason: "Inherited task-relevant changes already satisfy the delegated assignment." } } }] });
  assert.match(baselineVerifierTask, /"workspaceDisposition"[\s\S]*"baseline-satisfied"/, "downstream verifier tasks receive the inherited-baseline disposition even without a seed patch");
  const inheritedDisposition = { status: "baseline-satisfied", changedPaths: ["src/example.js"], reason: "Inherited task-relevant changes already satisfy the delegated assignment." };
  let summarizedDependencies;
  const summarizedContextEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node, context }) => {
    if (node.id === "source") return { summary: "Inherited implementation is ready for verification.", payload: { workspaceDisposition: inheritedDisposition } };
    summarizedDependencies = context.dependencyResults;
    return { summary: "Summarized context inspected." };
  } });
  const summarizedContextRun = await summarizedContextEngine.execute({ topologyId: "summarized-baseline-context", nodes: [{ id: "source", roleId: "det" }, { id: "target", roleId: "det", contextPolicy: "summarized" }], edges: [{ source: "source", target: "target", condition: "ok" }] }, { task: "Inspect summarized inherited context" });
  assert.equal(summarizedContextRun.status, "succeeded");
  assert.deepEqual(summarizedDependencies[0].workspaceDisposition, inheritedDisposition, "summarized topology projection preserves the authorized inherited-baseline disposition before task rendering");
  const upstreamPatch = { patchFile: "/tmp/synthetic.patch", patchHash: "abc123", changedPaths: ["src/a.js"], parentRevision: "head", parentStatusFingerprint: "status" };
  await subExec.execute({ node: { id: "verify", roleId: "verifier", task: "Verify proposal" }, role: roles.get("verifier"), context: { task: "Verify proposal", dependencyResults: [{ nodeId: "code", status: "succeeded", summary: "implemented", payload: { diagnostics: { workspace: upstreamPatch } } }] }, run: { runId: "run2", parentSessionId: "sess1", topology: { topologyId: "top1" } } });
  assert.deepEqual(capturedSubagent.seedPatches, [upstreamPatch], "downstream isolated roles seed the validated upstream proposal without applying it to the parent");

  let ungatedImplementationStarted = false;
  const ungatedEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => { ungatedImplementationStarted = true; return { content: "implemented" }; } });
  await assert.rejects(() => ungatedEngine.execute({ topologyId: "ungated-custom", nodes: [{ id: "code", roleId: "coder" }] }, { task: "change" }), (error) => error.code === "TOPOLOGY_ROADMAP_GATE_REQUIRED");
  assert.equal(ungatedImplementationStarted, false, "custom implementation topologies cannot bypass parent roadmap application");
  await assert.rejects(() => ungatedEngine.execute({ topologyId: "incomplete-custom-gate", metadata: { roadmapPlanGate: { plannerNodeId: "missing", beforeNodeIds: [] } }, nodes: [{ id: "code", roleId: "coder" }] }, { task: "change" }), (error) => error.code === "TOPOLOGY_ROADMAP_GATE_REQUIRED", "a truthy but incomplete custom gate cannot bypass parent roadmap application");
  await assert.rejects(() => ungatedEngine.execute({ topologyId: "unordered-custom-gate", executionMode: "dag", metadata: { roadmapPlanGate: { plannerNodeId: "plan", beforeNodeIds: ["code"] } }, nodes: [{ id: "plan", roleId: "planner" }, { id: "code", roleId: "coder" }], edges: [] }, { task: "change" }), (error) => error.code === "TOPOLOGY_ROADMAP_GATE_REQUIRED", "a custom gate must order its planner before implementation");
  assert.equal(ungatedImplementationStarted, false, "invalid custom gates fail before implementation starts");

  const missingExecutor = await new TopologyExecutionEngine({ roleRegistry: roles }).execute({ topologyId: "missing-executor", nodes: [{ id: "n", roleId: "det" }] }, {});
  assert.equal(missingExecutor.status, "failed", "handler-less topology nodes fail closed");
  assert.equal(missingExecutor.errors.length, 1, "the node error and fail-fast catch are deduplicated by semantic identity");
  assert.equal(missingExecutor.errors[0].nodeId, "n", "deduplication retains the actionable node-scoped error");
  assert(missingExecutor.errors.some((error) => error.code === "TOPOLOGY_EXECUTOR_MISSING"));

  const delayedChildSettlement = await new TopologyExecutionEngine({ roleRegistry: roles, subagentExecutor: { execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: "succeeded", summary: "Planner child settled under its authoritative timeout owner.", payload: { schemaVersion: 2, contractVersion: "role-v2", summary: "Planner child settled under its authoritative timeout owner.", findings: [], evidence: [{ kind: "runtime", summary: "The child returned its own settled result." }], artifacts: [], proposedPatch: null, verification: { status: "unchecked", evidence: [] } }, termination: { code: "submitted", stopReason: "toolUse" } };
  } } }).execute({ topologyId: "child-owned-timeout", nodes: [{ id: "plan", roleId: "planner", executionMode: "subagent", timeoutMs: 5 }] }, { task: "await child settlement" });
  assert.equal(delayedChildSettlement.status, "succeeded", "the topology engine does not race a subagent's authoritative wall-clock timeout");
  assert.equal(delayedChildSettlement.results[0].termination.code, "submitted");

  let timedOutCalls = 0;
  const timedOutExecutor = new SubagentTopologyExecutor({ service: { createSubagent(args) { timedOutCalls += 1; return { id: `timeout-${timedOutCalls}`, branchId: `branch-${timedOutCalls}`, ...args }; }, runSubagent: async () => ({ status: "timed_out", termination: { code: "wall_clock", stopReason: null }, summary: "Subagent timed out.", final_response: "timeout", artifacts: [], diagnostics: { errors: [{ message: "timeout" }] } }) } });
  const timedOutTopology = await new TopologyExecutionEngine({ roleRegistry: roles, subagentExecutor: timedOutExecutor }).execute({ topologyId: "timeout-topology", executionMode: "sequential", failurePolicy: "fail-fast", metadata: { roadmapPlanGate: { plannerNodeId: "plan", beforeNodeIds: ["code"] } }, nodes: [{ id: "plan", roleId: "planner", executionMode: "subagent" }, { id: "code", roleId: "coder", executionMode: "subagent" }], edges: [{ source: "plan", target: "code", condition: "ok" }], terminalNodes: ["code"] }, { task: "proof" });
  assert.equal(timedOutTopology.status, "failed", "timed-out subagents fail the topology");
  assert.equal(timedOutTopology.results[0].status, "timed_out", "non-success result is retained for diagnostics");
  assert.equal(timedOutTopology.results[0].termination.code, "wall_clock", "topology nodes retain the canonical child termination code");
  assert.equal(timedOutTopology.errors.length, 1, "one child failure produces one public topology error");
  assert.equal(timedOutTopology.errors[0].termination.code, "wall_clock", "the public error retains the actionable child termination detail");
  const timedOutTrace = timedOutTopology.trace.find((event) => event.type === "topology.agent.failed");
  assert.equal(timedOutTrace.status, "timed_out");
  assert.equal(timedOutTrace.termination.code, "wall_clock", "topology trace uses the same child terminal outcome");
  assert.equal(timedOutTopology.nodeStates[0].status, "timed-out");
  assert.equal(timedOutCalls, 1, "ok edge does not admit a timed-out upstream node");
  const cancelledExecutor = new SubagentTopologyExecutor({ service: { createSubagent: () => ({ id: "cancelled", branchId: "cancelled-branch" }), runSubagent: async () => ({ status: "cancelled", termination: { code: "cancelled", stopReason: null }, summary: "cancelled", final_response: "cancelled", artifacts: [], diagnostics: {} }) } });
  const cancelledTopology = await new TopologyExecutionEngine({ roleRegistry: roles, subagentExecutor: cancelledExecutor }).execute({ topologyId: "cancelled-topology", nodes: [{ id: "research", roleId: "researcher", executionMode: "subagent" }] }, {});
  assert.equal(cancelledTopology.status, "failed");
  assert.equal(cancelledTopology.nodeStates[0].status, "cancelled");
  assert.equal(evaluateEdgeCondition("ok", { status: "timed_out" }), false);
  assert.equal(evaluateEdgeCondition("no_errors", { status: "cancelled", diagnostics: { errors: [] } }), false);

  const continueEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node }) => { if (node.id === "bad") throw new Error("bad node"); return { content: "ok" }; } });
  const continued = await continueEngine.execute({ topologyId: "continue-failed", executionMode: "dag", failurePolicy: "continue-on-error", nodes: [{ id: "bad", roleId: "planner" }, { id: "good", roleId: "planner" }] }, {});
  assert.equal(continued.status, "failed", "continue-on-error controls scheduling, not the final truth status");
  assert(continued.results.some((result) => result.nodeId === "good"));
  const distinctSameMessage = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => { throw new Error("shared failure text"); } }).execute({ topologyId: "distinct-same-message", executionMode: "dag", failurePolicy: "continue-on-error", nodes: [{ id: "first", roleId: "planner" }, { id: "second", roleId: "planner" }] }, {});
  assert.deepEqual(distinctSameMessage.errors.map((error) => error.nodeId).sort(), ["first", "second"], "semantic deduplication retains identical failures from distinct nodes");

  const templates = createTopologyTemplates();
  assert(templates.plannerCoderVerifier().nodes.every((node) => node.executionMode === "subagent"), "live starter templates execute real subagents");
  assert.equal(templates.parallelEvidenceSynthesis().topologyId, "parallel-evidence-synthesis");
  const normalizedV2 = materializeRoleAwareTopology({ schemaVersion: 2, topologyId: "legacy-v2", nodes: [{ id: "research", roleId: "researcher" }], edges: [], terminalNodes: ["research"] }, { roles: roles.list(), provenance: { source: "test-v2" } });
  assert.equal(normalizedV2.schemaVersion, 3);
  assert.equal(normalizedV2.metadata.compatibility.sourceSchemaVersion, 2);
  assert.equal(normalizedV2.nodes[0].joinPolicy.mode, "all");
  assert.equal(normalizedV2.partialPolicy, "forbid");
  for (const topology of listBuiltInRoleTopologies().filter((candidate) => isTopologyImplementationCapable(candidate, roles.list()))) {
    const gate = topology.metadata?.roadmapPlanGate;
    assert(gate?.plannerNodeId, `${topology.topologyId} requires a parent roadmap application gate`);
    const planner = topology.nodes.find((node) => node.id === gate.plannerNodeId);
    assert(planner?.outputSchema?.required?.includes("roadmapPlan"), `${topology.topologyId} requires a typed executable planner result`);
  }
  const gatedCalls = [];
  const typedEnvelope = (node) => node.roleId === "planner"
    ? { schemaVersion: 2, contractVersion: "role-v2", summary: "Bounded implementation plan based on repository evidence.", findings: [], evidence: [{ kind: "path", source: "src/example.js" }], roadmapPlan: { title: "Topology plan", milestones: [{ title: "Implement", goals: ["Change code"] }] } }
    : node.roleId === "coder"
      ? { schemaVersion: 2, contractVersion: "role-v2", summary: "Implemented the bounded change in the isolated workspace.", findings: [], evidence: [{ kind: "command", source: "test" }], artifacts: [], proposedPatch: {}, verification: { status: "passed", evidence: ["test passed"] } }
      : { schemaVersion: 2, contractVersion: "role-v2", summary: "Verification passed with repository evidence.", findings: [], evidence: [{ kind: "command", source: "test" }], artifacts: [], proposedPatch: null, verification: { status: "passed", evidence: ["test passed"] } };
  const invalidPlannerCases = [
    ["trivial", { summary: "x", findings: [], evidence: [] }, /summary|evidence/],
    ["no-evidence", { summary: "This planner summary is long enough but cites no repository evidence.", findings: [], evidence: [] }, /evidence/],
    ["empty-evidence", { summary: "This planner summary claims evidence but supplies no supporting detail.", findings: [], evidence: [{}] }, /supporting detail/],
    ["noop-roadmap", { summary: "This planner summary is meaningful and cites a repository path.", findings: [], evidence: [{ kind: "path", source: "src/example.js" }], roadmapPlan: { title: "noop2", milestones: [{ title: "noop", goals: ["noop"] }] } }, /roadmapPlan/],
  ];
  for (const [caseId, payload, errorPattern] of invalidPlannerCases) {
    const invalidPlannerRun = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => ({ content: String(payload.summary), payload }) }).execute({ topologyId: `invalid-planner-${caseId}`, metadata: { requiresTypedResults: true }, nodes: [{ id: "plan", roleId: "planner" }] }, {});
    assert.equal(invalidPlannerRun.status, "failed", `${caseId} planner output cannot pass topology completion`);
    assert.equal(invalidPlannerRun.errors.length, 1, `${caseId} planner failure is not duplicated`);
    assert.equal(invalidPlannerRun.errors[0].code, "AGENT_RESULT_SCHEMA_INVALID");
    assert.match(invalidPlannerRun.errors[0].message, errorPattern);
  }
  const gatedTopology = { ...templates.plannerCoderVerifier("gated-plan"), nodes: templates.plannerCoderVerifier("gated-plan").nodes.map((node) => ({ ...node, executionMode: "handler" })) };
  const gatedEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node, context }) => { gatedCalls.push(node.id); if (node.id === "code") assert(context.dependencyResults[0].roadmapPlan, "bounded planner hierarchy reaches the implementation context"); return { content: node.id, summary: node.id, payload: typedEnvelope(node) }; }, roadmapPlanApplier: async ({ roadmapPlan }) => { gatedCalls.push("roadmap-applied"); assert.equal(roadmapPlan.title, "Topology plan"); return { applied: true, roadmapId: "roadmap-test", planFingerprint: "fixture" }; }, roadmapPlanReconciler: async () => ({ reconciled: true, outcome: "completed", roadmapId: "roadmap-test" }) });
  const gatedRun = await gatedEngine.execute(gatedTopology, { task: "implement" });
  assert.equal(gatedRun.status, "succeeded");
  assert.deepEqual(gatedCalls.slice(0, 3), ["plan", "roadmap-applied", "code"], "the parent applies roadmapPlan before implementation starts");
  assert.equal(gatedRun.roadmapApplications.length, 1);
  assert.equal(gatedRun.roadmapReconciliations.length, 1, "the parent reconciles the applied hierarchy once after terminal success");
  let blockedCodeStarted = false;
  const blockedGateEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ node }) => { if (node.id === "code") blockedCodeStarted = true; return { content: node.id, summary: node.id, payload: typedEnvelope(node) }; }, roadmapPlanApplier: async () => { throw new Error("roadmap unavailable"); } });
  const blockedGateRun = await blockedGateEngine.execute({ ...gatedTopology, topologyId: "blocked-gated-plan" }, { task: "implement" });
  assert.equal(blockedGateRun.status, "failed");
  assert.equal(blockedCodeStarted, false, "implementation fails closed when parent roadmap application fails");

  const settlementRoot = tmpFixture("pi-topology-roadmap-settlement-");
  saveRoadmap(settlementRoot, createRoadmap("Parent delivery", ["Integrate delegated proposal", "Ship follow-up"]));
  const settlementCalls = [];
  let failSettlementCode = false;
  let settlementVerifierStarts = 0;
  const settlementEngine = new TopologyExecutionEngine({
    roleRegistry: roles,
    cwd: settlementRoot,
    roadmapPlanApplier: async (args) => { settlementCalls.push(`apply:${args.runId}`); return applyRoadmapPlan(args); },
    roadmapPlanReconciler: async (args) => { settlementCalls.push(`reconcile:${args.runId}:${args.status}`); return reconcileRoadmapPlan(args); },
    agentExecutor: async ({ node, role, context }) => {
      assert.equal(role.toolPolicy.allowedTools.includes("roadmap_update"), false, `${role.roleId} child has no parent roadmap mutation authority`);
      if (node.id === "code") {
        assert(context.dependencyResults[0].roadmapPlan, "coder receives the public plan without roadmap mutation authority");
        if (failSettlementCode) {
          const error = new Error("fixture implementation failed");
          error.code = "FIXTURE_IMPLEMENTATION_FAILED";
          throw error;
        }
      }
      if (node.id === "verify") settlementVerifierStarts += 1;
      return { content: node.id, summary: node.id, payload: typedEnvelope(node) };
    },
  });
  const successfulSettlement = await settlementEngine.execute({ ...gatedTopology, topologyId: "roadmap-settlement-success" }, { task: "implement" }, { cwd: settlementRoot, runId: "toprun-roadmap-success" });
  assert.equal(successfulSettlement.status, "succeeded");
  assert.equal(successfulSettlement.roadmapApplications.length, 1);
  assert.equal(successfulSettlement.roadmapReconciliations.length, 1);
  assert.equal(successfulSettlement.roadmapReconciliations[0].outcome, "completed");
  assert.deepEqual(settlementCalls, ["apply:toprun-roadmap-success", "reconcile:toprun-roadmap-success:succeeded"], "success applies before execution and reconciles exactly once at settlement");
  let settledRoadmap = loadRoadmap(settlementRoot);
  const successfulHierarchy = findRoadmapById(settledRoadmap, successfulSettlement.roadmapApplications[0].roadmapId);
  assert(successfulHierarchy, "successful reconciliation targets the exact applied hierarchy");
  assert.equal(getProgress(successfulHierarchy).complete, getProgress(successfulHierarchy).total, "successful delegated hierarchy is checked off");
  assert.deepEqual(getActivePath(settledRoadmap).map(({ item }) => item.title), ["Integrate delegated proposal"], "settling delegated work resumes the captured parent item");
  assert.equal(settledRoadmap.items[0].status, "active", "isolated topology success does not falsely complete the parent integration item");

  failSettlementCode = true;
  const verifierStartsBeforeFailure = settlementVerifierStarts;
  const failedSettlement = await settlementEngine.execute({ ...gatedTopology, topologyId: "roadmap-settlement-failure" }, { task: "implement" }, { cwd: settlementRoot, runId: "toprun-roadmap-failure" });
  assert.equal(failedSettlement.status, "failed");
  assert(failedSettlement.errors.some((error) => error.code === "FIXTURE_IMPLEMENTATION_FAILED"), "roadmap reconciliation preserves the original topology failure");
  assert.equal(failedSettlement.roadmapReconciliations.length, 1);
  assert.equal(failedSettlement.roadmapReconciliations[0].outcome, "shelved");
  assert.equal(settlementVerifierStarts, verifierStartsBeforeFailure, "fail-fast still blocks downstream verification");
  assert.deepEqual(settlementCalls.slice(-2), ["apply:toprun-roadmap-failure", "reconcile:toprun-roadmap-failure:failed"], "failure reconciles the one recorded hierarchy exactly once");
  settledRoadmap = loadRoadmap(settlementRoot);
  const failedHierarchy = findRoadmapById(settledRoadmap, failedSettlement.roadmapApplications[0].roadmapId);
  assert(failedHierarchy, "failed reconciliation targets the exact applied hierarchy");
  assert.equal(failedHierarchy.lifecycle.status, "shelved", "failed delegated work cannot remain an actionable nesting target");
  assert.deepEqual(getActivePath(settledRoadmap).map(({ item }) => item.title), ["Integrate delegated proposal"], "failed delegated work also resumes the captured parent item");
  assert.equal(settledRoadmap.items[0].subtasks.length, 2, "successive delegations become settled siblings rather than unbounded descendants");

  const verifierResult = (status) => ({
    content: `verification ${status}`,
    summary: `Verification completed with explicit ${status} evidence.`,
    payload: { schemaVersion: 2, contractVersion: "role-v2", summary: `Verification completed with explicit ${status} evidence.`, evidence: [{ kind: "command", source: "test" }], verification: { status, evidence: [`test ${status}`] } },
  });
  for (const status of ["unchecked", "failed"]) {
    const verifierGateRun = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => verifierResult(status) }).execute({ topologyId: `verifier-gate-${status}`, nodes: [{ id: "verify", roleId: "verifier" }], terminalNodes: ["verify"] }, {});
    assert.equal(verifierGateRun.status, "failed", `verifier ${status} cannot pass the topology gate`);
    assert.equal(verifierGateRun.nodeStates[0].status, "failed");
    assert.equal(verifierGateRun.errors[0].code, status === "unchecked" ? "AGENT_RESULT_SCHEMA_INVALID" : "AGENT_VERIFICATION_GATE_FAILED");
    if (status === "failed") assert.equal(verifierGateRun.results[0].verificationGate.actual, status, "the failed gate preserves the domain verdict");
  }
  const passedVerifierRun = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => verifierResult("passed") }).execute({ topologyId: "verifier-gate-passed", nodes: [{ id: "verify", roleId: "verifier" }], terminalNodes: ["verify"] }, {});
  assert.equal(passedVerifierRun.status, "succeeded", "only verification.status=passed satisfies a verifier gate");

  const toolNode = await new TopologyExecutionEngine({ roleRegistry: roles, tools: { read: async (p) => `file:${p}` } }).execute({ topologyId: "tool-node", nodes: [{ id: "readme", roleId: "det", tool: "read", args: ["README.md"] }] }, {});
  assert.equal(toolNode.status, "succeeded");
  assert.equal(toolNode.results[0].payload.output, "file:README.md");

  let denied = false;
  const denyEngine = new TopologyExecutionEngine({ roleRegistry: roles, tools: { write: async () => "bad" }, agentExecutor: async ({ context }) => context.tools.write("x") });
  const deniedResult = await denyEngine.execute({ topologyId: "deny", nodes: [{ id: "n", roleId: "det" }], failurePolicy: "continue-on-error" }, {});
  denied = deniedResult.errors[0]?.code === "TOOL_DENIED" || /tool denied/.test(deniedResult.errors[0]?.message || "");
  assert(denied, "permission denial is surfaced");
  assert(new ToolPermissionError("write", "n").code === "TOOL_DENIED");

  const storage = new MemoryJsonStorage();
  const sink = new RecordingSink();
  const boundary = createPiIntegrationBoundary({ storage, sink, topologies: { tools: { read: async () => "ok" }, options: { agentExecutor: async ({ node, context }) => { if (node.id === "reader") context.memory.read("seed", { limit: 1 }); if (node.id === "writer") context.memory.write({ type: "semantic", title: "Topology fact", content: "stored", verification: "verified" }); return { content: node.id }; } } } });
  boundary.memory.remember({ type: "semantic", title: "seed", content: "seed fact", verification: "verified" });
  boundary.topologies.registerRole({ roleId: "mem", allowedTools: ["read"], memoryPolicy: "read-write" });
  boundary.topologies.registerTopology({ topologyId: "memtop", executionMode: "sequential", nodes: [{ id: "reader", roleId: "mem", memoryPolicy: "read-only" }, { id: "writer", roleId: "mem", memoryPolicy: "write-only" }], edges: [{ source: "reader", target: "writer" }], terminalNodes: ["writer"] });
  const mem = await boundary.topologies.execute("memtop", { task: "memory" });
  assert.equal(mem.status, "succeeded");
  assert.equal(boundary.topologies.getRun(mem.runId).runId, mem.runId, "topology run is persisted");
  assert(boundary.topologies.listRuns({ topologyId: "memtop" }).some((r) => r.runId === mem.runId), "topology run index is persisted");
  const memMetrics = boundary.topologies.metrics({ topologyId: "memtop" });
  assert.equal(memMetrics.totalRuns, 1, "topology metrics retain overall run counts");
  assert.equal(memMetrics.legacy.totalRuns, 0, "new topology packets carry current role-v2 provenance");
  assert.equal(memMetrics.reliability.totalRuns, 1, "role-v2 packets participate in current reliability metrics");
  assert.equal(memMetrics.passRate, 1, "schema-versioned role-v2 success counts toward current reliability");
  storage.appendJsonl("topologies/runs", { runId: "legacy-run", topologyId: "memtop", status: "succeeded", durationMs: 1 });
  const mixedMetrics = boundary.topologies.metrics({ topologyId: "memtop" });
  assert.equal(mixedMetrics.totalRuns, 2);
  assert.equal(mixedMetrics.currentRuns, 1);
  assert.equal(mixedMetrics.legacyRuns, 1);
  assert.equal(mixedMetrics.reliability.totalRuns, 1, "legacy packets are excluded from v2 reliability success metrics");
  const partialStorage = new MemoryJsonStorage();
  const partialBoundary = createPiIntegrationBoundary({ storage: partialStorage, topologies: { options: { agentExecutor: async ({ node }) => { if (node.id === "bad") throw new Error("fixture failure"); return { content: node.id, summary: node.id }; } } } });
  partialBoundary.topologies.registerTopology({ topologyId: "metric-partial", executionMode: "dag", failurePolicy: "continue-on-error", partialPolicy: "report", nodes: [{ id: "good", roleId: "worker" }, { id: "bad", roleId: "worker" }, { id: "reduce", roleId: "worker", joinPolicy: { mode: "best-effort", includeFailedInputs: true } }], edges: [{ source: "good", target: "reduce", condition: "always" }, { source: "bad", target: "reduce", condition: "always" }], terminalNodes: ["reduce"] });
  const persistedPartial = await partialBoundary.topologies.execute("metric-partial", {});
  assert.equal(persistedPartial.status, "partial");
  const partialMetrics = partialBoundary.topologies.metrics({ topologyId: "metric-partial" });
  assert.equal(partialMetrics.passRate, 0, "partial runs never inflate the success pass rate");
  assert.equal(partialMetrics.partials, 1);
  assert.equal(partialMetrics.degradedJoins, 1);
  assert.equal(boundary.topologies.metrics({}).totalRuns >= 1, true, "persistent topology metrics are available");
  assert.equal(boundary.topologies.exportRun({ runId: mem.runId }).runId, mem.runId, "topology export returns run packet");
  const exportRoot = tmpFixture("pi-topology-export-");
  const exportFile = path.join(exportRoot, "run.json");
  boundary.topologies.exportRun({ runId: mem.runId, file: exportFile });
  assert.equal(fs.statSync(exportRoot).mode & 0o777, 0o700, "topology export directories are private");
  assert.equal(fs.statSync(exportFile).mode & 0o777, 0o600, "topology export files are private");
  if (process.platform !== "win32") {
    const outsideExport = path.join(exportRoot, "outside.txt");
    const linkedExport = path.join(exportRoot, "linked.json");
    fs.writeFileSync(outsideExport, "unchanged", { mode: 0o644 });
    fs.chmodSync(outsideExport, 0o644); // Establish the asserted baseline independently of the process umask.
    fs.symlinkSync(outsideExport, linkedExport);
    assert.throws(() => boundary.topologies.exportRun({ runId: mem.runId, file: linkedExport }), /unsafe|symbolic/i, "topology exports refuse symlink destinations");
    assert.equal(fs.readFileSync(outsideExport, "utf8"), "unchanged");
    assert.equal(fs.statSync(outsideExport).mode & 0o777, 0o644, "topology export refusal never chmods a symlink target");
  }
  assert.equal(boundary.topologies.pruneRuns({ topologyId: "memtop", keepRecent: 0 }).pruned, 2, "topology prune removes old run packets");
  assert(boundary.memory.retrieve("Topology fact").entries.length >= 1, "memory write includes persisted provenance");
  assert(boundary.trace.export().some((e) => e.name === "topology.memory_write" || e.name === "topology.topology.completed"));

  let tries = 0;
  const retryEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => { tries++; if (tries === 1) throw new Error("flaky"); return { content: "ok" }; } });
  const retry = await retryEngine.execute({ topologyId: "retry", nodes: [{ id: "r", roleId: "det" }] }, {});
  assert.equal(retry.status, "succeeded");
  assert.equal(tries, 2);

  const isolated = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ context }) => ({ content: String(context.allResults || "none"), payload: { deps: context.dependencyResults.length, inputKeys: Object.keys(context.input) } }) }).execute({ topologyId: "iso", executionMode: "sequential", nodes: [{ id: "a", roleId: "det" }, { id: "b", roleId: "det", contextPolicy: "isolated-scratch" }], edges: [{ source: "a", target: "b" }], terminalNodes: ["b"] }, { task: "x", secret: "hidden" });
  assert.equal(isolated.results.find((r) => r.nodeId === "b").payload.deps, 0);
  assert.deepEqual(isolated.results.find((r) => r.nodeId === "b").payload.inputKeys, ["task"]);

  roles.register({ roleId: "schema", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } });
  const schemaBad = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => ({ payload: { ok: "yes" } }) }).execute({ topologyId: "schema-bad", nodes: [{ id: "s", roleId: "schema" }] }, {});
  assert.equal(schemaBad.status, "failed");
  const schemaOk = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => ({ payload: { ok: true } }) }).execute({ topologyId: "schema-ok", nodes: [{ id: "s", roleId: "schema" }] }, {});
  assert.equal(schemaOk.status, "succeeded");
  assert.equal(validateSimpleSchema({ type: "object", properties: { mode: { enum: ["a"] }, xs: { type: "array", items: { type: "number" } }, nested: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } }, { payload: { mode: "a", xs: [1], nested: { ok: true } } }).status, "valid");
  assert.equal(validateSimpleSchema({ type: "object", properties: { mode: { enum: ["a"] } } }, { payload: { mode: "b" } }).status, "invalid");
  assert.equal(evaluateEdgeCondition("ok", { status: "succeeded", payload: { ok: true } }), true);
  assert.equal(evaluateEdgeCondition("always", { status: "failed" }), true, "always edges schedule recovery nodes after failures");
  assert.equal(evaluateEdgeCondition("confidence>=0.7", { confidence: 0.8 }), true);
  assert.equal(evaluateEdgeCondition("no_errors", { status: "succeeded", diagnostics: { errors: [] } }), true);

  roles.register({ roleId: "alt" });
  let usedAlt = false;
  const alt = await new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ role }) => { if (role.roleId === "det") throw new Error("primary failed"); usedAlt = role.roleId === "alt"; return { content: "alternate" }; } }).execute({ topologyId: "alt-retry", nodes: [{ id: "n", roleId: "det", retryPolicy: { maxRetries: 1, alternateRoleIds: ["alt"] } }] }, {});
  assert.equal(alt.status, "succeeded");
  assert(usedAlt, "alternate role retry was used");

  const fallbackEngine = new TopologyExecutionEngine({ roleRegistry: roles, topologyRegistry: new TopologyRegistry({ topologies: [{ topologyId: "fallback", nodes: [{ id: "f", roleId: "worker" }] }] }), roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fallback-test" }), roadmapPlanReconciler: async () => ({ reconciled: true, outcome: "shelved", roadmapId: "fallback-test" }), agentExecutor: async ({ node }) => { if (node.id === "bad") throw new Error("boom"); if (node.id === "plan") return { content: "plan", payload: { roadmapPlan: { title: "Fallback plan", milestones: [{ title: "Attempt", goals: ["Implement"] }] } } }; return { content: "fallback ok" }; } });
  const fallback = await fallbackEngine.execute({ topologyId: "primary", fallbackTopology: "fallback", metadata: { roadmapPlanGate: { plannerNodeId: "plan", beforeNodeIds: ["bad"] } }, nodes: [{ id: "plan", roleId: "planner" }, { id: "bad", roleId: "coder" }], edges: [{ source: "plan", target: "bad", condition: "ok" }] }, {});
  assert.equal(fallback.status, "failed", "a read-only fallback cannot convert failed mutation into success");
  assert.equal(fallback.fallbackStatus, "succeeded");
  assert.equal(fallback.incompleteMutation, true);
  assert.equal(fallback.fallbackOf, "primary");
  assert(fallback.previousErrors.some((error) => /boom/.test(error.message)));

  const tmp = tmpFixture("pi-topology-config-");
  fs.writeFileSync(path.join(tmp, "topologies.json"), JSON.stringify({ roles: [{ roleId: "cfg" }], topologies: [{ topologyId: "cfg-top", nodes: [{ id: "c", roleId: "cfg" }] }] }));
  const loaded = loadTopologyConfigDir(tmp, { roleRegistry: roles, topologyRegistry: topologies });
  assert.equal(loaded.length, 1);
  assert.equal(roles.get("cfg").roleId, "cfg");
  assert.equal(topologies.get("cfg-top").topologyId, "cfg-top");

  loadTopologyExtension({ roles: [{ roleId: "ext-role" }], topologies: [{ topologyId: "ext-top", nodes: [{ id: "x", roleId: "ext-role" }] }] }, { roleRegistry: roles, topologyRegistry: topologies });
  assert.equal(roles.get("ext-role").roleId, "ext-role");
  assert.equal(topologies.get("ext-top").topologyId, "ext-top");
  assert(replayTrace(boundary.trace.export()).some((e) => e.type === "topology.topology.completed"), "trace replay exposes topology events");

  console.log("multi-agent topology tests passed");
})();
