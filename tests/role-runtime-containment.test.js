"use strict";

const assert = require("node:assert/strict");
const { inspectAutoRouteSafety, AUTO_ROUTE_MUTATION_BLOCKED } = require("../src/role-runtime-containment");

const roles = [
  { roleId: "reviewer", allowedTools: ["read", "grep", "diff"] },
  { roleId: "coder", allowedTools: ["read", "edit", "write"] },
  { roleId: "verifier", allowedTools: ["read", "bash", "test"] },
  { roleId: "memory-curator", allowedTools: ["memory.write"] },
];
const safe = inspectAutoRouteSafety({ topology: { topologyId: "review", nodes: [{ id: "review", roleId: "reviewer" }] }, roles });
assert.equal(safe.ok, true);
assert.equal(safe.reason, "read-only shadow topology");
for (const [topology, expectedNode] of [
  [{ topologyId: "implement", nodes: [{ id: "review", roleId: "reviewer" }, { id: "code", roleId: "coder" }] }, "code"],
  [{ topologyId: "verify", nodes: [{ id: "verify", roleId: "verifier" }] }, "verify"],
  [{ topologyId: "memory", nodes: [{ id: "remember", roleId: "memory-curator" }] }, "remember"],
  [{ topologyId: "custom-shell", nodes: [{ id: "shell", roleId: "reviewer", allowedTools: ["bash"] }] }, "shell"],
]) {
  const result = inspectAutoRouteSafety({ topology, roles });
  assert.equal(result.ok, false);
  assert.equal(result.code, AUTO_ROUTE_MUTATION_BLOCKED);
  assert(result.mutatingNodes.some((node) => node.nodeId === expectedNode));
}
assert.equal(inspectAutoRouteSafety({ topology: null, roles }).ok, false);
assert.equal(inspectAutoRouteSafety({ topology: { topologyId: "future", nodes: [{ id: "code", roleId: "coder" }] }, roles, runtimeV2Available: true }).ok, false, "workspace isolation alone does not authorize delegation");
assert.equal(inspectAutoRouteSafety({ topology: { topologyId: "delegated", nodes: [{ id: "code", roleId: "coder" }] }, roles, runtimeV2Available: true, allowIsolatedDelegation: true }).ok, true, "an owned delegate path may use isolated mutating roles");

console.log("role runtime containment tests passed");
