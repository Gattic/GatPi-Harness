"use strict";
const assert = require("node:assert/strict");
const { evaluatePolicy } = require("../src/runtime-policy");
const { TopologyExecutionEngine, AgentRoleRegistry, TopologyRegistry, evaluateEdgeCondition } = require("../src/multi-agent-topologies");
const { isUnsafeNextPrompt } = require("../.pi/extensions/goal/goal-runner.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-workflow-ext-");
  assert.equal(evaluatePolicy("rm -rf .", { cwd: tmp }).ok, false, "policy denies recursive removal");
  assert.equal(evaluatePolicy("sudo make install", { cwd: tmp }).ok, false, "policy denies sudo");
  assert.equal(evaluatePolicy({ kind: "write", path: "../outside.txt" }, { cwd: tmp }).ok, false, "policy denies outside-repo writes");
  const previousHome = process.env.HOME;
  try {
    const fakeHome = tmpFixture("pi-policy-home-");
    process.env.HOME = fakeHome;
    assert.equal(evaluatePolicy({ kind: "read", path: "~/.ssh/id_rsa" }, { cwd: tmp, policy: { denyPathPrefixes: ["~/.ssh"] } }).ok, false, "policy expands ~ before deny-prefix checks");
  } finally {
    process.env.HOME = previousHome;
  }
  assert.equal(evaluatePolicy("npm install left-pad", { cwd: tmp }).severity, "warn", "policy warns on package installs");
  assert.equal(evaluatePolicy({ tool: "automation_loop" }, { cwd: tmp }).severity, "allow", "automation loop is an approved harness control tool");
  assert.match(isUnsafeNextPrompt("npm install left-pad", tmp), /policy gate|package/i, "goal runner uses policy gate for package installs");

  const roles = new AgentRoleRegistry();
  roles.register({ roleId: "runner", displayName: "Runner", allowedTools: ["danger"], memoryPolicy: "none" });
  const topologies = new TopologyRegistry();
  topologies.register({ topologyId: "policy-topology", executionMode: "sequential", failurePolicy: "fail-fast", aggregationPolicy: "last", nodes: [{ id: "n", roleId: "runner", tool: "danger", args: [{ kind: "write", path: "../x" }] }], edges: [], terminalNodes: ["n"] });
  const engine = new TopologyExecutionEngine({ roleRegistry: roles, topologyRegistry: topologies, cwd: tmp, tools: { danger: (x) => x } });
  const denied = await engine.execute("policy-topology", {}, { cwd: tmp });
  assert.equal(denied.status, "failed", "topology tool node is policy-gated");
  assert.match(JSON.stringify(denied.errors), /policy denied|outside repo/i);

  topologies.register({ topologyId: "compact-topology", executionMode: "sequential", failurePolicy: "fail-fast", aggregationPolicy: "last", nodes: [{ id: "n", roleId: "runner", tool: "danger", args: [{ ok: true }] }], edges: [], terminalNodes: ["n"] });
  const ok = await engine.execute("compact-topology", {}, { cwd: tmp });
  assert.equal(ok.status, "succeeded");
  assert.ok(ok.results[0].content.length < JSON.stringify(ok.results[0].payload.output).length + 20, "tool-node output is compactly formatted");
  assert.equal(evaluateEdgeCondition("ok", { status: "succeeded", validation: { status: "unchecked" } }, { requireTyped: true }), false, "v2 ok edges reject untyped upstream results");
  assert.equal(evaluateEdgeCondition("no_errors", { status: "succeeded", validation: { status: "valid" }, payload: { schemaVersion: 2, contractVersion: "role-v2" } }, { requireTyped: true }), true, "v2 edges accept validated typed upstream results");

  console.log("workflow extension behavior tests passed");
})();
