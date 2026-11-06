"use strict";

const AUTO_ROUTE_MUTATION_BLOCKED = "AUTO_ROUTE_MUTATION_BLOCKED";
const MUTATING_AUTO_ROUTE_ROLES = new Set(["coder", "refactorer", "verifier", "benchmark", "memory-curator", "tool-specialist"]);
const MUTATING_AUTO_ROUTE_TOOLS = new Set(["bash", "edit", "write", "test", "lint", "typecheck", "benchmark", "memory.write"]);

function inspectAutoRouteSafety({ topology, roles = [], runtimeV2Available = false, allowIsolatedDelegation = false } = {}) {
  if (!topology) return { ok: false, code: AUTO_ROUTE_MUTATION_BLOCKED, reason: "topology not found", mutatingNodes: [] };
  const roleMap = new Map(roles.map((role) => [role.roleId, role]));
  const mutatingNodes = (topology.nodes || []).filter((node) => {
    const roleId = node.roleId || node.role || "worker";
    const role = roleMap.get(roleId);
    const tools = new Set([...(role?.toolPolicy?.allowedTools || role?.allowedTools || []), ...(node.allowedTools || []), ...(node.tool ? [node.tool] : [])]);
    return role?.mutationPolicy && role.mutationPolicy !== "forbidden"
      || role?.workspacePolicy === "isolated-worktree"
      || node.workspacePolicy === "isolated-worktree"
      || MUTATING_AUTO_ROUTE_ROLES.has(roleId)
      || [...tools].some((tool) => MUTATING_AUTO_ROUTE_TOOLS.has(tool));
  }).map((node) => ({ nodeId: node.id, roleId: node.roleId || node.role || "worker" }));
  if (mutatingNodes.length && !runtimeV2Available) return { ok: false, code: AUTO_ROUTE_MUTATION_BLOCKED, reason: "role runtime v2 workspace isolation is unavailable", mutatingNodes };
  if (mutatingNodes.length && !allowIsolatedDelegation) return { ok: false, code: AUTO_ROUTE_MUTATION_BLOCKED, reason: "isolated delegation authority is unavailable", mutatingNodes };
  return { ok: true, code: null, reason: mutatingNodes.length ? "isolated delegation" : "read-only shadow topology", mutatingNodes: [] };
}

module.exports = {
  AUTO_ROUTE_MUTATION_BLOCKED,
  MUTATING_AUTO_ROUTE_ROLES,
  MUTATING_AUTO_ROUTE_TOOLS,
  inspectAutoRouteSafety,
};
