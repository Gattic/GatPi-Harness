"use strict";

process.env.PI_ROLE_MUTATION = "isolated";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AgentRoleRegistry, TopologyExecutionEngine } = require("../src/multi-agent-topologies");
const { narrowRoleContract } = require("../src/role-contracts");

(async () => {
  const roles = new AgentRoleRegistry();
  const attempts = [];
  const tools = {
    read: async () => "read-ok",
    edit: async () => "edit-ok",
    bash: async () => "bash-ok",
    role_verify: async () => "verify-ok",
    "memory.write": async () => "memory-write-ok",
  };
  const run = async (roleId, toolName, extraNode = {}) => {
    const engine = new TopologyExecutionEngine({ roleRegistry: roles, tools, agentExecutor: async ({ context }) => { attempts.push(`${roleId}:${toolName}`); const content = await context.tools[toolName](); return roleId === "verifier" ? { content, payload: { summary: "Approved verifier runner completed successfully.", evidence: [{ kind: "command", source: toolName }], verification: { status: "passed", evidence: [content] } } } : { content }; } });
    return engine.execute({ topologyId: `policy-${roleId}-${toolName}`.replace(/[^a-z0-9-]/gi, "-"), failurePolicy: "continue-on-error", nodes: [{ id: "n", roleId, ...extraNode }] }, { task: "policy" });
  };

  assert.equal((await run("reviewer", "read")).status, "succeeded", "reviewer can inspect");
  assert((await run("reviewer", "edit")).errors.some((e) => /tool denied/.test(e.message)), "reviewer cannot edit");
  assert.equal((await run("verifier", "role_verify")).status, "succeeded", "verifier can run only the approved verification runner");
  assert((await run("verifier", "bash")).errors.some((e) => /tool denied/.test(e.message)), "verifier cannot execute arbitrary shell commands");
  assert((await run("verifier", "edit")).errors.some((e) => /tool denied/.test(e.message)), "verifier cannot edit");
  assert((await run("researcher", "edit")).errors.some((e) => /tool denied/.test(e.message)), "researcher cannot mutate repo");
  assert.equal((await run("evidence-auditor", "read")).status, "succeeded", "evidence auditor can inspect cited evidence");
  assert((await run("evidence-auditor", "edit")).errors.some((e) => /tool denied/.test(e.message)), "evidence auditor cannot mutate repo");
  assert((await run("evidence-auditor", "bash")).errors.some((e) => /tool denied/.test(e.message)), "evidence auditor cannot execute shell commands");

  const curatorEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async () => ({ content: "verified upstream evidence", payload: { summary: "Upstream verification completed successfully.", evidence: [{ kind: "command", source: "fixture" }], verification: { status: "passed", evidence: ["fixture passed"] } } }) });
  const curator = await curatorEngine.execute({ topologyId: "curator-memory", executionMode: "sequential", nodes: [{ id: "verify", roleId: "verifier" }, { id: "m", roleId: "memory-curator", memoryPolicy: "ephemeral" }], edges: [{ source: "verify", target: "m", condition: "ok" }] }, {});
  assert.equal(curator.status, "succeeded", "memory curator can write memory when policy allows it and verified upstream evidence exists");
  const memoryEngine = new TopologyExecutionEngine({ roleRegistry: roles, agentExecutor: async ({ context }) => { context.memory.write({ type: "semantic", title: "policy", content: "ok" }); return { content: "ok" }; } });
  const reviewerMemory = await memoryEngine.execute({ topologyId: "reviewer-memory", failurePolicy: "continue-on-error", nodes: [{ id: "m", roleId: "reviewer", memoryPolicy: "read-only" }] }, {});
  assert(reviewerMemory.errors.some((e) => /memory write denied/.test(e.message)), "reviewer read-only memory cannot write");

  const pseudo = new Set(["rg", "diff", "search", "browser", "test", "lint", "typecheck", "benchmark"]);
  for (const name of fs.readdirSync(path.join(__dirname, "..", ".pi", "topologies")).filter((file) => file.endsWith(".json"))) {
    const packet = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".pi", "topologies", name), "utf8"));
    for (const node of (packet.topologies || []).flatMap((topology) => topology.nodes || [])) {
      for (const tool of node.allowedTools || node.toolPolicy?.allowedTools || []) assert(!pseudo.has(tool), `${name}:${node.id} must not request pseudo-tool ${tool}`);
      const role = roles.get(node.roleId || node.role || "worker");
      assert.doesNotThrow(() => narrowRoleContract(role, {
        ...(node.workspacePolicy ? { workspacePolicy: node.workspacePolicy } : {}),
        ...((node.allowedTools || node.deniedTools || node.toolPolicy) ? { toolPolicy: node.toolPolicy || { allowedTools: node.allowedTools || role.toolPolicy.allowedTools, deniedTools: node.deniedTools || [] } } : {}),
      }), `${name}:${node.id} must be a valid narrow-only contract`);
    }
  }

  assert(attempts.length >= 6);
  console.log("topology policy conformance tests passed");
})();
