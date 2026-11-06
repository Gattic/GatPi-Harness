"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { readHarnessEnvironment } = require("../src/harness-environment");
const {
  DEFAULT_DELEGATE_MODEL,
  DEFAULT_ROLE_CONTRACTS,
  createCustomReadOnlyContract,
  selectRoleInferenceProfile,
  roleModelEnvName,
  roleThinkingEnvName,
} = require("../src/role-contracts");
const { runtimeSourceFingerprint, RUNTIME_SOURCE_FILES } = require("../src/runtime-source-fingerprint");
const { AgentRoleRegistry } = require("../src/multi-agent-topologies");
const { SubagentRunner, SubagentService } = require("../src/subagents");
const { resolveSubagentPreflight } = require("../src/subagent-lifecycle");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { SubagentTaskService } = require("../src/subagent-tasks");

const root = path.resolve(__dirname, "..");
const env = readHarnessEnvironment({ root }).values;
const contracts = new Map(DEFAULT_ROLE_CONTRACTS.map((contract) => [contract.roleId, contract]));
const expected = {
  planner: ["local/DeepSeek-V4.1-Flash-1017", "high"],
  researcher: ["local/DeepSeek-V4.1-Flash-1017", "medium"],
  reviewer: ["local/DeepSeek-V4.1-Flash-1017", "high"],
  coder: ["local/DeepSeek-V4.1-Flash-1017", "high"],
  verifier: ["local/DeepSeek-V4.1-Flash-1017", "low"],
  refactorer: ["local/DeepSeek-V4.1-Flash-1017", "high"],
  benchmark: ["local/DeepSeek-V4.1-Flash-1017", "medium"],
  "evidence-auditor": ["local/DeepSeek-V4.1-Flash-1017", "high"],
  worker: ["local/DeepSeek-V4.1-Flash-1017", "low"],
};

for (const [roleId, [model, thinkingLevel]] of Object.entries(expected)) {
  const contract = contracts.get(roleId);
  assert(contract, `${roleId} is registered`);
  assert(contract.budget.maxModelCalls > 0, `${roleId} is model-backed`);
  const profile = selectRoleInferenceProfile(contract.modelPolicy, {
    roleId,
    inheritedModel: "provider/global-default-must-not-win",
    inheritedThinkingLevel: "off",
    env,
  });
  assert.equal(profile.selectedModel, model, `${roleId} model`);
  assert.equal(profile.selectedThinkingLevel, thinkingLevel, `${roleId} thinking`);
  assert.equal(profile.modelPolicySource, "environment");
  assert.equal(profile.thinkingPolicySource, "environment");
}

const specialistThinking = {
  integrator: "high",
  "mathematical-researcher": "high",
  "reverse-engineer": "high",
  "3d-modeler": "high",
  "3d-critic": "high",
  "reliability-investigator": "high",
  "code-profiler": "high",
  "security-reviewer": "high",
};
const modelRoles = DEFAULT_ROLE_CONTRACTS.filter((contract) => contract.workspacePolicy !== "handler-only");
assert.deepEqual(modelRoles.map((contract) => contract.roleId).sort(), [...Object.keys(expected), ...Object.keys(specialistThinking), "patch-reviewer"].sort(), "every built-in model role is covered");
for (const contract of modelRoles) {
  const profile = selectRoleInferenceProfile(contract.modelPolicy, { roleId: contract.roleId, inheritedModel: "provider/parent", inheritedThinkingLevel: "high", env: {} });
  assert.equal(profile.selectedModel, contract.budget === null ? "provider/parent" : DEFAULT_DELEGATE_MODEL, `${contract.roleId} follows its inference policy`);
  assert.equal(profile.selectedThinkingLevel, specialistThinking[contract.roleId] || "high", `${contract.roleId} preserves its declared effort policy without configuration`);
}

// Exercise the shared direct/topology launch path, including exact sidecar expectations.
const runner = new SubagentRunner();
const inferenceNames = modelRoles.flatMap(({ roleId }) => [roleModelEnvName(roleId), roleThinkingEnvName(roleId)]);
const savedEnv = Object.fromEntries(inferenceNames.map((name) => [name, process.env[name]]));
try {
  for (const name of inferenceNames) {
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
  for (const contract of modelRoles) {
    // Configured role environment wins for every model role; only unconfigured
    // specialists fall back to the inherited parent profile.
    const configuredModel = env[roleModelEnvName(contract.roleId)];
    const configuredThinking = env[roleThinkingEnvName(contract.roleId)];
    const thinkingLevel = configuredThinking || expected[contract.roleId]?.[1] || specialistThinking[contract.roleId] || "high";
    const launch = runner.rpcArgs({ id: `profile-${contract.roleId}`, roleContract: contract, toolPolicy: contract.toolPolicy }, { cwd: root, model: { provider: "provider", id: "parent" }, thinkingLevel: "high" });
    const selectedModel = configuredModel || (contract.budget === null ? "provider/parent" : DEFAULT_DELEGATE_MODEL);
    assert.equal(launch.args[launch.args.indexOf("--model") + 1], selectedModel, `${contract.roleId} RPC model`);
    assert.equal(launch.args[launch.args.indexOf("--thinking") + 1], thinkingLevel, `${contract.roleId} RPC effort`);
    assert.equal(launch.env.PI_ROLE_EXPECTED_MODEL, selectedModel);
    assert.equal(launch.env.PI_ROLE_EXPECTED_THINKING_LEVEL, thinkingLevel);
  }
} finally {
  for (const name of inferenceNames) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
}

// Specialist tasks are unbudgeted, but budget:null must not silently discard
// explicit operator inference overrides (PI_ROLE_MODEL_*/PI_ROLE_THINKING_*).
const storage = new MemoryJsonStorage();
const tasks = new SubagentTaskService({ cwd: root, storage, topologies: new MultiAgentTopologyAdapter({ storage }), subagents: new SubagentService({ cwd: root, runner }), evidenceStore: new MemoryEvidenceStore(storage) });
const specialist = tasks.taskRole(contracts.get("3d-modeler"), {});
assert.equal(specialist.budget, null, "specialist task roles remain unbudgeted");
assert.deepEqual(specialist.modelPolicy, { mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" }, "specialist task roles inherit by default");
const specialistEnv = { PI_ROLE_MODEL_3D_MODELER: "provider/specialist-override", PI_ROLE_THINKING_3D_MODELER: "low" };
const savedSpecialistEnv = Object.fromEntries(Object.keys(specialistEnv).map((name) => [name, process.env[name]]));
try {
  for (const name of Object.keys(specialistEnv)) delete process.env[name];
  const inheritedLaunch = runner.rpcArgs({ id: "specialist-inherit", roleContract: specialist, toolPolicy: specialist.toolPolicy }, { cwd: root, model: { provider: "provider", id: "parent" }, thinkingLevel: "high" });
  assert.equal(inheritedLaunch.args[inheritedLaunch.args.indexOf("--model") + 1], "provider/parent", "unconfigured specialist tasks inherit the parent model");
  assert.equal(inheritedLaunch.args[inheritedLaunch.args.indexOf("--thinking") + 1], "high", "unconfigured specialist tasks inherit the parent effort");
  assert.equal(inheritedLaunch.provenance.modelPolicySource, "inherit");
  for (const [name, value] of Object.entries(specialistEnv)) process.env[name] = value;
  const overrideLaunch = runner.rpcArgs({ id: "specialist-override", roleContract: specialist, toolPolicy: specialist.toolPolicy }, { cwd: root, model: { provider: "provider", id: "parent" }, thinkingLevel: "high" });
  assert.equal(overrideLaunch.args[overrideLaunch.args.indexOf("--model") + 1], "provider/specialist-override", "specialist tasks honor the role model override");
  assert.equal(overrideLaunch.args[overrideLaunch.args.indexOf("--thinking") + 1], "low", "specialist tasks honor the role thinking override");
  assert.equal(overrideLaunch.provenance.modelPolicySource, "environment");
  assert.equal(overrideLaunch.provenance.thinkingPolicySource, "environment");
  assert.equal(overrideLaunch.env.PI_ROLE_EXPECTED_MODEL, "provider/specialist-override");
  assert.equal(overrideLaunch.env.PI_ROLE_EXPECTED_THINKING_LEVEL, "low");
  const overrideWithRpc = runner.rpcArgs({ id: "specialist-override-rpc", roleContract: specialist, toolPolicy: specialist.toolPolicy }, { cwd: root, model: { provider: "provider", id: "parent" }, thinkingLevel: "high", rpc: { model: "wrong/override", thinkingLevel: "high" } });
  assert.equal(overrideWithRpc.args[overrideWithRpc.args.indexOf("--model") + 1], "provider/specialist-override", "environment beats the RPC profile override for unbudgeted roles");
  assert.equal(overrideWithRpc.args[overrideWithRpc.args.indexOf("--thinking") + 1], "low", "environment effort beats the RPC profile override for unbudgeted roles");
  const preflight = resolveSubagentPreflight({ roleContract: specialist, task: "Inspect the bounded specialist fixture." }, { inheritedModel: "provider/parent", inheritedThinkingLevel: "high", actualTools: specialist.toolPolicy.allowedTools, activeCount: 0, env: { ...specialistEnv } });
  assert.equal(preflight.allowed, true, JSON.stringify(preflight.reasons));
  assert.equal(preflight.effective.model, "provider/specialist-override", "preflight resolves the specialist override");
  assert.equal(preflight.effective.thinkingLevel, "low");
  assert.equal(preflight.effective.modelPolicySource, "environment");
  assert.equal(preflight.effective.thinkingPolicySource, "environment");
} finally {
  for (const [name, value] of Object.entries(savedSpecialistEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

for (const roleId of ["coordinator", "memory-curator", "skill-intake-handler", "tool-specialist"]) {
  const contract = contracts.get(roleId);
  assert.equal(contract.budget.maxModelCalls, 0, `${roleId} remains handler-only`);
  assert.equal(env[roleModelEnvName(roleId)], undefined, `${roleId} has no configured model`);
  assert.equal(env[roleThinkingEnvName(roleId)], undefined, `${roleId} has no configured thinking`);
}

const custom = createCustomReadOnlyContract({ roleId: "simple-custom", systemPrompt: "Inspect one caller-defined read-only concern and report bounded evidence." });
const customProfile = selectRoleInferenceProfile(custom.modelPolicy, {
  roleId: custom.roleId,
  inheritedModel: "provider/parent",
  inheritedThinkingLevel: "high",
  env: {},
});
assert.equal(customProfile.selectedModel, DEFAULT_DELEGATE_MODEL);
assert.equal(customProfile.selectedThinkingLevel, "high");
assert.equal(customProfile.modelPolicySource, "preferred");
assert.equal(customProfile.thinkingPolicySource, "inherit");

const registry = new AgentRoleRegistry();
registry.register({ roleId: "registered-custom", description: "Inspect a bounded custom concern." });
const registered = registry.get("registered-custom");
assert.equal(selectRoleInferenceProfile(registered.modelPolicy, { inheritedModel: "provider/parent", inheritedThinkingLevel: "medium", env: {} }).selectedModel, DEFAULT_DELEGATE_MODEL);
for (const contract of [custom, registered]) {
  const launch = runner.rpcArgs({ id: contract.roleId, roleContract: contract, toolPolicy: contract.toolPolicy }, { cwd: root, model: { provider: "provider", id: "parent" }, thinkingLevel: "medium" });
  assert.equal(launch.env.PI_ROLE_EXPECTED_MODEL, DEFAULT_DELEGATE_MODEL);
  assert.equal(launch.env.PI_ROLE_EXPECTED_THINKING_LEVEL, "medium", "custom delegates retain parent effort");
}

assert(RUNTIME_SOURCE_FILES.includes("config/harness-defaults.env"), "role inference defaults participate in the runtime fingerprint");
assert(runtimeSourceFingerprint(root).files.includes("config/harness-defaults.env"));

console.log("role reasoning policy tests passed");
