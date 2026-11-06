"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { BUILTIN_ROLE_TOPOLOGIES, validateRoleAwareTopology, isTopologyImplementationCapable } = require("../src/role-topologies");
const { MultiAgentTopologyAdapter, MemoryJsonStorage, NullSink } = require("../src/integration-boundary");
const { buildFanout, DEFAULT_RPC_CONCURRENCY, DEFAULT_MAX_WORKERS } = require("../src/plan-fanout");
const { topologyRunLearningCohort } = require("../src/learning-loop");
const { recommendTopologies } = require("../src/project-intelligence");

const root = path.resolve(__dirname, "..");
const roleIds = new Set(DEFAULT_ROLE_CONTRACTS.map((role) => role.roleId));
assert(BUILTIN_ROLE_TOPOLOGIES.length >= 13, "trusted external repositories receive the full safe built-in topology set");
assert.deepEqual(topologyRunLearningCohort({ status: "succeeded" }), { cohort: "legacy", reliabilityEligible: false });
assert.deepEqual(topologyRunLearningCohort({ schemaVersion: 2, roleRuntimeVersion: 2, contractVersion: "role-v2", resultSchemaVersion: 2, status: "succeeded" }), { cohort: "current-v2", reliabilityEligible: true });
assert.deepEqual(topologyRunLearningCohort({ schemaVersion: 3, roleRuntimeVersion: 2, contractVersion: "role-v2", resultSchemaVersion: 2, status: "partial" }), { cohort: "current-v2", reliabilityEligible: true });
for (const topology of BUILTIN_ROLE_TOPOLOGIES) {
  assert.equal(topology.schemaVersion, 3);
  assert.equal(topology.roleRuntimeVersion, 2);
  assert.equal(topology.contractVersion, "role-v2");
  assert.equal(topology.resultSchemaVersion, 2);
  assert.equal(topology.metadata.provenance.source, "builtin");
  assert.equal(topology.metadata.requiresTypedResults, true);
  assert.deepEqual(validateRoleAwareTopology(topology), { ok: true, issues: [] });
  if (isTopologyImplementationCapable(topology)) {
    const gate = topology.metadata.roadmapPlanGate;
    assert(gate?.plannerNodeId && gate.beforeNodeIds?.length, `${topology.topologyId} applies a roadmapPlan before implementation`);
    const planner = topology.nodes.find((node) => node.id === gate.plannerNodeId);
    assert(planner?.outputSchema?.required?.includes("roadmapPlan"), `${topology.topologyId} requires a typed roadmapPlan`);
  }
  for (const node of topology.nodes) {
    assert(roleIds.has(node.roleId), `${topology.topologyId}/${node.id} uses a registered role`);
    assert.equal(node.roleContractVersion, "role-v2");
    assert(["handler-only", "shared-readonly", "isolated-worktree"].includes(node.workspacePolicy));
    assert(["forbidden", "proposed-patch", "isolated-only"].includes(node.mutationPolicy));
    assert(node.budget && Number.isFinite(node.budget.maxModelCalls) && Number.isFinite(node.budget.maxToolCalls));
    assert(node.outputSchema?.type === "object");
    assert(["all", "quorum", "min-success", "best-effort"].includes(node.joinPolicy?.mode));
    if (node.mutationPolicy !== "forbidden") assert.equal(node.workspacePolicy, "isolated-worktree");
    if (node.workspacePolicy === "handler-only") assert.equal(node.executionMode, "handler");
  }
}
const evidenceTopology = BUILTIN_ROLE_TOPOLOGIES.find((topology) => topology.topologyId === "parallel-evidence-synthesis");
assert(evidenceTopology, "parallel evidence synthesis is a canonical built-in recipe");
assert.equal(evidenceTopology.executionMode, "dag");
assert.equal(evidenceTopology.concurrencyLimit, 4);
assert.equal(evidenceTopology.partialPolicy, "report");
assert.equal(evidenceTopology.nodes.find((node) => node.id === "audit").joinPolicy.mode, "min-success");
assert.equal(evidenceTopology.nodes.find((node) => node.id === "audit").joinPolicy.minimumSuccessfulInputs, 3);
assert(evidenceTopology.nodes.every((node) => node.mutationPolicy === "forbidden"), "parallel evidence synthesis is fully read-only");
const plannerCoder = BUILTIN_ROLE_TOPOLOGIES.find((topology) => topology.topologyId === "planner-coder-verifier");
const executablePlanner = plannerCoder.nodes.find((node) => node.roleId === "planner");
assert.match(executablePlanner.task, /roadmapPlan/, "implementation planner explicitly emits the parent-applied roadmap hierarchy");
assert(executablePlanner.outputSchema.required.includes("roadmapPlan"), "implementation topologies fail closed when the executable hierarchy is omitted");
const unorderedImplementation = JSON.parse(JSON.stringify(plannerCoder));
unorderedImplementation.executionMode = "dag";
unorderedImplementation.edges = unorderedImplementation.edges.filter((edge) => edge.source !== executablePlanner.id);
assert(validateRoleAwareTopology(unorderedImplementation).issues.some((issue) => /ordered before implementation/.test(issue)), "registration rejects a roadmap gate whose planner is not upstream of implementation");

const external = new MultiAgentTopologyAdapter({ storage: new MemoryJsonStorage(), sink: new NullSink() });
const installed = new Set(external.listTopologies().map((topology) => topology.topologyId));
for (const topologyId of ["planner-coder-verifier", "reviewer-verifier-gate", "parallel-evidence-synthesis", "docs-update", "security-review", "refactor-with-safety-net", "dependency-upgrade", "failing-ci-triage", "performance-regression", "release-prep", "autonomous-coding-workflow", "memory-curator-after-success"]) assert(installed.has(topologyId), `external boundary includes ${topologyId}`);
const recommendations = recommendTopologies({ docs: [{ path: "README.md" }], ci: [{ file: "ci.yml" }], languages: [{ language: "javascript" }], dependencies: [{ file: "package.json" }], codegraph: { initialized: true }, semgrep: { ready: true } });
assert(recommendations.length > 4);
assert(recommendations.every((topologyId) => installed.has(topologyId)), "project intelligence recommends only installed canonical role-aware topologies");

assert.equal(DEFAULT_RPC_CONCURRENCY, 2);
assert(DEFAULT_MAX_WORKERS <= 8, "default fanout is evidence-bounded");
const plan = `# Work\n- [ ] Implement parser changes in \`src/parser.js\`\n- [ ] Review parser behavior in \`src/parser.js\`\n- [ ] Document behavior in \`docs/parser.md\`\n- [ ] Add tests in \`tests/parser.test.js\``;
const fanout = buildFanout(root, plan, { planFile: "plan.md" });
assert.equal(fanout.concurrency, 2);
assert(fanout.waves.length >= 2, "large/conflicting fanout proceeds in bounded waves");
assert.equal(fanout.workers[0].roleId, "coder");
assert.equal(fanout.workers[0].workspacePolicy, "isolated-worktree");
assert.equal(fanout.workers[0].mutationPolicy, "proposed-patch");
assert.equal(fanout.workers[0].mergePolicy, "proposed_patch");
assert.equal(fanout.workers[1].roleId, "reviewer");
assert.equal(fanout.workers[1].workspacePolicy, "shared-readonly");
assert(fanout.workers[1].dependencies.includes(fanout.workers[0].id), "overlapping file zones serialize through explicit dependencies");
for (const worker of fanout.workers) {
  assert(worker.fileZones.length);
  assert(worker.budget.maxModelCalls > 0 && worker.budget.maxToolCalls > 0);
  assert(worker.expectedOutputSchema?.type === "object");
  assert(worker.verificationRequirements.length);
  assert.deepEqual(worker.handledOutcomes, ["succeeded", "timed_out", "invalid_output", "partial_patch", "cancelled", "failed"]);
  assert(!/you are not alone|edits? (?:the parent|directly)/i.test(worker.task));
}

// The 101-skill bundle retired the legacy dispatching skills, so the contract
// applies to whichever installed skill still delegates to subagents. The scan
// must cover the whole managed catalog: a layout change that hid the skills
// would otherwise leave the loop below with nothing to check.
const skillRoot = path.join("skills", "skills");
const catalogFiles = fs.readdirSync(path.join(root, skillRoot), { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, skillRoot, entry.name, "SKILL.md"))).map((entry) => path.join(skillRoot, entry.name, "SKILL.md"));
const managedSkills = fs.readFileSync(path.join(root, skillRoot, "managed-skills.txt"), "utf8").split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
assert(catalogFiles.length > 0, "the skill catalog is not empty");
assert.equal(catalogFiles.length, managedSkills.length, "the scan covers every managed skill");
const skillFiles = catalogFiles.filter((file) => /allowed-tools:.*\b(?:Agent|Task)\b|dispatch[^\n]{0,80}\bsubagents?\b/i.test(fs.readFileSync(path.join(root, file), "utf8")));
for (const file of skillFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert(source.includes("## Pi Roles v2 dispatch contract"), `${file} declares its enforceable role contract`);
  for (const token of ["roleId", "workspacePolicy", "maxModelCalls", "maxToolCalls", "timed_out", "invalid_output", "partial_patch", "cancelled"]) assert(source.includes(token), `${file} handles ${token}`);
  assert(!/\bExplore subagents?\b|\bgeneral-purpose subagents?\b|\bAgent subagents?\b|\b10\+ subagents?\b|subagents apply edits directly/i.test(source), `${file} has no obsolete cosmetic/unbounded role wording`);
}

for (const name of fs.readdirSync(path.join(root, ".pi", "topologies")).filter((name) => name.endsWith(".json"))) {
  const packet = JSON.parse(fs.readFileSync(path.join(root, ".pi", "topologies", name), "utf8"));
  for (const topology of packet.topologies || []) for (const node of topology.nodes || []) {
    if ((topology.nodes || []).some((candidate) => candidate.mutationPolicy === "proposed-patch")) assert(topology.metadata?.roadmapPlanGate, `${name} declares the parent roadmap application gate`);
    assert(roleIds.has(node.roleId), `${name}/${node.id} uses a registered role`);
    for (const field of ["roleContractVersion", "workspacePolicy", "mutationPolicy", "budget", "outputSchema"]) assert(node[field] != null, `${name}/${node.id} declares ${field}`);
    if (["planner-coder-verifier.json", "autonomous-coding-workflow.json"].includes(name) && node.roleId === "planner") assert(node.outputSchema.required.includes("roadmapPlan"), `${name} requires the executable roadmap hierarchy before downstream implementation`);
    if (node.roleId === "reviewer") assert(Number(node.budget?.maxModelCalls || 0) >= 8, `${name} preserves the reviewer result-submission reserve`);
    if (node.mutationPolicy !== "forbidden") assert.equal(node.workspacePolicy, "isolated-worktree");
  }
}

const recipes = fs.readFileSync(path.join(root, "src", "topology-recipes.js"), "utf8");
assert(recipes.includes('require("./role-topologies.js")'), "run_topology recipe administration consumes canonical built-in topologies");
assert(!recipes.includes("all nodes are subagents"));
const example = fs.readFileSync(path.join(root, "examples", "multi-agent-topologies-example.js"), "utf8");
assert(example.includes("previewSubagentPatch") && example.includes("applySubagentPatch"), "example uses explicit patch preview/apply");
const productDocs = fs.readFileSync(path.join(root, "docs", "productization-extensions.md"), "utf8");
assert(productDocs.includes("typed worker specifications") && productDocs.includes("explicit patch preview"));

console.log("role consumer contract tests passed");
