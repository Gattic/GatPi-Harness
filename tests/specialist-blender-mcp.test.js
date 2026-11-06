"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash, resolveRequiredTools, ACTUAL_CHILD_TOOLS } = require("../src/role-contracts");
const { capabilityStatus } = require("../src/specialist-capabilities");
const { tmpFixture } = require("./helpers/tmp-fixture");

const modeler = DEFAULT_ROLE_CONTRACTS.find((contract) => contract.roleId === "3d-modeler");

// The producer drives a live Blender scene through pi's MCP client, so the
// pattern has to survive contract validation, tool resolution and the launch
// allowlist that becomes `--tools`.
assert.ok(modeler.toolPolicy.allowedTools.includes("mcp__blender__*"), "3d-modeler allowlists the Blender MCP server");
assert.deepEqual(modeler.settings.blenderMcp, { server: "blender", host: "localhost", port: 9876 }, "3d-modeler declares its Blender MCP binding");
assert.match(modeler.systemPrompt, /mcp__blender__execute_blender_code/, "the objective names the MCP entry point");
assert.match(modeler.systemPrompt, /outside the task sandbox/, "the contract records the MCP containment boundary");

// A pattern is conditional: it never makes a role unavailable when the static
// child tool list has no MCP tools, and it expands to its live matches.
const withoutMcp = resolveRequiredTools(modeler, ACTUAL_CHILD_TOOLS, { throwOnMissing: true });
assert.deepEqual(withoutMcp.missing, [], "an MCP pattern is not a missing tool");
assert.ok(!withoutMcp.available.includes("mcp__blender__*"), "a pattern is not reported as a literal tool");
const withMcp = resolveRequiredTools(modeler, [...ACTUAL_CHILD_TOOLS, "mcp__blender__execute_blender_code", "mcp__blender__get_objects_summary", "mcp__other__tool"]);
assert.deepEqual(withMcp.available.filter((tool) => tool.startsWith("mcp__")), ["mcp__blender__execute_blender_code", "mcp__blender__get_objects_summary"], "the pattern expands only to its own server's tools");

// Preflight distinguishes a registered server with a live listener from one
// that is absent or unreachable, so a run cannot burn an attempt on dead calls.
const home = tmpFixture("pi-blender-mcp-");
const env = { ...process.env, HOME: home };
const unconfigured = capabilityStatus(modeler, { env, cwd: home });
assert.ok(unconfigured.reasons.includes("blender-mcp:server-not-configured:blender"), JSON.stringify(unconfigured.reasons));
fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
fs.writeFileSync(path.join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { blender: { command: "blender-mcp" } } }));
const configured = capabilityStatus(modeler, { env, cwd: home });
assert.ok(!configured.reasons.includes("blender-mcp:server-not-configured:blender"), JSON.stringify(configured.reasons));
if (fs.existsSync("/proc/net/tcp")) {
  // The socket-table check is skipped, not failed, where /proc is unavailable.
  const unreachable = capabilityStatus({ settings: { ...modeler.settings, blenderMcp: { server: "blender", host: "localhost", port: 65533 } } }, { env, cwd: home });
  assert.ok(unreachable.reasons.includes("blender-mcp:listener-unreachable:localhost:65533"), JSON.stringify(unreachable.reasons));
}

assert.equal(typeof roleRevisionHash(modeler), "string");

// The child launches with --no-extensions, which also disables the built-in MCP
// client; an MCP allowlist only works if the launch loads that built-in back.
const { SubagentRunner } = require("../src/subagents");
const runner = new SubagentRunner();
const launch = runner.rpcArgs({ id: "blender-launch", roleContract: modeler, toolPolicy: modeler.toolPolicy }, { cwd: home, model: { provider: "local", id: "test-model" }, thinkingLevel: "medium" });
assert.ok(launch.args.includes("--no-extensions"), "the child disables extension discovery");
assert.ok(launch.args.includes("builtin:mcp"), "an MCP allowlist loads the built-in MCP client explicitly");
const plain = runner.rpcArgs({ id: "plain-launch", roleContract: DEFAULT_ROLE_CONTRACTS.find((contract) => contract.roleId === "reviewer") }, { cwd: home, model: { provider: "local", id: "test-model" }, thinkingLevel: "medium" });
assert.ok(!plain.args.includes("builtin:mcp"), "a role without MCP tools does not load the MCP client");

console.log("✓ 3d-modeler allowlists mcp__blender__*, patterns resolve without blocking, and preflight gates the MCP binding");
console.log("✓ the child launch restores the built-in MCP client for MCP allowlists only");
