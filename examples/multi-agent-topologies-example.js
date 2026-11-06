"use strict";

const {
  AgentRoleRegistry,
  TopologyRegistry,
  TopologyExecutionEngine,
  AgentResult,
  listBuiltInRoleTopologies,
  validateRoleAwareTopology,
} = require("../src/multi-agent-topologies");
const { SubagentService } = require("../src/subagents");

// Trusted external repositories receive these validated defaults without
// copying pi-harness/.pi/topologies into their own tree.
const builtIns = listBuiltInRoleTopologies();
for (const topology of builtIns) {
  const validation = validateRoleAwareTopology(topology);
  if (!validation.ok) throw new Error(`${topology.topologyId}: ${validation.issues.join("; ")}`);
}

// Deterministic examples should remain read-only. Mutating role nodes are
// executed through SubagentService so their cwd is an isolated Git worktree.
const roles = new AgentRoleRegistry();
const topologies = new TopologyRegistry({ topologies: builtIns });
const engine = new TopologyExecutionEngine({
  roleRegistry: roles,
  topologyRegistry: topologies,
  subagentExecutor: {
    execute: async ({ node, role, context }) => new AgentResult({
      agentId: node.id,
      nodeId: node.id,
      role: role.roleId,
      status: "succeeded",
      content: `${role.displayName} handled ${context.task}`,
      summary: `${node.id} done`,
      payload: {
        schemaVersion: 2,
        contractVersion: "role-v2",
        summary: `${node.id} done`,
        findings: [],
        evidence: [{ kind: "example", path: "examples/multi-agent-topologies-example.js" }],
      },
    }),
  },
});

// Filesystem transfer is separate from topology/trajectory success. Callers
// previewSubagentPatch first and only applySubagentPatch after explicit parent
// acceptance plus a caller-supplied verification callback.
async function applyAcceptedProposal(service, subagentId, verify) {
  const preview = service.previewSubagentPatch({ subagentId });
  return service.applySubagentPatch({ subagentId, preview, explicit: true, verify });
}

(async () => {
  const result = await engine.execute("research-advisory", { task: "Explain the built-in role topology contract" });
  const parallelEvidence = builtIns.find((topology) => topology.topologyId === "parallel-evidence-synthesis");
  console.log(JSON.stringify({
    status: result.status,
    topologyId: result.topologyId,
    versions: { schemaVersion: result.schemaVersion, roleRuntimeVersion: result.roleRuntimeVersion, contractVersion: result.contractVersion, resultSchemaVersion: result.resultSchemaVersion },
    builtInCount: builtIns.length,
    parallelEvidence: {
      mode: parallelEvidence.executionMode,
      concurrencyLimit: parallelEvidence.concurrencyLimit,
      partialPolicy: parallelEvidence.partialPolicy,
      nodes: parallelEvidence.nodes.map((node) => ({ id: node.id, roleId: node.roleId, contextPolicy: node.contextPolicy, joinPolicy: node.joinPolicy })),
      edges: parallelEvidence.edges,
    },
  }, null, 2));

  // Run the fixed deterministic orchestration comparison with:
  // node scripts/benchmark-parallel-evidence-topology.js
  // It does not authorize routing changes or claim live model quality.

  // This instance is shown only to make the explicit transfer API concrete;
  // no mutating child or parent apply is started by the example itself.
  const service = new SubagentService({ cwd: process.cwd() });
  void service;
  void applyAcceptedProposal;
})();
