"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { readHarnessEnvironment } = require("../src/harness-environment");
const { DEFAULT_DELEGATE_MODEL, DEFAULT_ROLE_CONTRACTS, roleModelsMatch } = require("../src/role-contracts");
const { SubagentRunner, resolveRoleModel } = require("../src/subagents");

const root = path.resolve(__dirname, "..");
const runner = new SubagentRunner();
const contracts = new Map(DEFAULT_ROLE_CONTRACTS.map((contract) => [contract.roleId, contract]));
const coder = contracts.get("coder");

const configured = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "sparky0", id: "DeepSeek-V4.1-Flash-1017" },
];

// Provider-qualified pins keep their provider when it is configured.
assert.deepEqual(
  resolveRoleModel("sparky0/DeepSeek-V4.1-Flash-1017", { availableModels: configured, inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "sparky0/DeepSeek-V4.1-Flash-1017", modelPolicySource: null },
);

// A placeholder provider is remapped to a configured provider that offers the id.
assert.deepEqual(
  resolveRoleModel("local/DeepSeek-V4.1-Flash-1017", { availableModels: configured, inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "sparky0/DeepSeek-V4.1-Flash-1017", modelPolicySource: "derived" },
);

// A bare model id resolves through the configured providers.
assert.deepEqual(
  resolveRoleModel("DeepSeek-V4.1-Flash-1017", { availableModels: configured, inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "sparky0/DeepSeek-V4.1-Flash-1017", modelPolicySource: "derived" },
);

// The parent's provider wins when it offers the same model id.
assert.deepEqual(
  resolveRoleModel("DeepSeek-V4.1-Flash-1017", { availableModels: [{ provider: "anthropic", id: "DeepSeek-V4.1-Flash-1017" }, { provider: "sparky0", id: "DeepSeek-V4.1-Flash-1017" }], inheritedModel: "sparky0/DeepSeek-V4.1-Flash-1017" }),
  { model: "sparky0/DeepSeek-V4.1-Flash-1017", modelPolicySource: "derived" },
);

// An unavailable id falls back to the parent's resolved model.
assert.deepEqual(
  resolveRoleModel("DeepSeek-V4.1-Flash-1017", { availableModels: [{ provider: "anthropic", id: "claude-opus-5-5" }], inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "anthropic/claude-opus-5-5", modelPolicySource: "inherit" },
);

// An empty configured set also falls back to the parent model.
assert.deepEqual(
  resolveRoleModel("DeepSeek-V4.1-Flash-1017", { availableModels: [], inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "anthropic/claude-opus-5-5", modelPolicySource: "inherit" },
);

// Callers that cannot supply a registry keep the resolved policy value.
assert.deepEqual(
  resolveRoleModel("DeepSeek-V4.1-Flash-1017", { inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "DeepSeek-V4.1-Flash-1017", modelPolicySource: null },
);

// The legacy "local" placeholder never survives as a provider.
assert.deepEqual(
  resolveRoleModel("local/DeepSeek-V4.1-Flash-1017", { inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "DeepSeek-V4.1-Flash-1017", modelPolicySource: null },
);

// A pin with no model id is unresolved: inherit the parent when possible and
// fail explicitly otherwise.
assert.deepEqual(
  resolveRoleModel("local/", { inheritedModel: "anthropic/claude-opus-5-5" }),
  { model: "anthropic/claude-opus-5-5", modelPolicySource: "inherit" },
);
assert.throws(
  () => resolveRoleModel("local/", {}),
  (error) => error.code === "ROLE_MODEL_UNRESOLVED",
);

// Policy comparison splits provider/id, recovers the bare id a sidecar reports
// after splitting it on "/", and treats the placeholder provider as neutral.
assert.equal(roleModelsMatch("DeepSeek-V4.1-Flash-1017", { provider: "DeepSeek-V4.1-Flash-1017", id: "" }), true);
assert.equal(roleModelsMatch("local/DeepSeek-V4.1-Flash-1017", { provider: "sparky0", id: "DeepSeek-V4.1-Flash-1017" }), true);
assert.equal(roleModelsMatch("sparky0/DeepSeek-V4.1-Flash-1017", { provider: "sparky0", id: "DeepSeek-V4.1-Flash-1017" }), true);
assert.equal(roleModelsMatch("sparky0/DeepSeek-V4.1-Flash-1017", { provider: "anthropic", id: "DeepSeek-V4.1-Flash-1017" }), false);
assert.equal(roleModelsMatch("local/", { provider: "sparky0", id: "DeepSeek-V4.1-Flash-1017" }), false);
assert.equal(roleModelsMatch("DeepSeek-V4.1-Flash-1017", { provider: "local", id: "" }), false);

const launch = runner.rpcArgs(
  { id: "derivation-coder", roleContract: coder, toolPolicy: coder.toolPolicy },
  { cwd: root, model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high", availableModels: configured },
);
assert.equal(launch.args[launch.args.indexOf("--model") + 1], "sparky0/DeepSeek-V4.1-Flash-1017", "rpcArgs derives a configured provider");
assert.equal(launch.env.PI_ROLE_EXPECTED_MODEL, "sparky0/DeepSeek-V4.1-Flash-1017", "sidecar expectation matches the derived model");
assert.equal(launch.provenance.selectedModel, "sparky0/DeepSeek-V4.1-Flash-1017");
assert.equal(launch.provenance.modelPolicySource, "derived");

const fallbackLaunch = runner.rpcArgs(
  { id: "derivation-fallback", roleContract: coder, toolPolicy: coder.toolPolicy },
  { cwd: root, model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high", availableModels: [{ provider: "anthropic", id: "claude-opus-5-5" }] },
);
assert.equal(fallbackLaunch.args[fallbackLaunch.args.indexOf("--model") + 1], "anthropic/claude-opus-5-5", "rpcArgs falls back to the parent model");
assert.equal(fallbackLaunch.env.PI_ROLE_EXPECTED_MODEL, "anthropic/claude-opus-5-5");
assert.equal(fallbackLaunch.provenance.modelPolicySource, "inherit");

// rpcArgs matrix: no registry keeps the provider-neutral policy value, an empty
// registry inherits the parent, a placeholder pin is normalized or derived, and
// an empty model id in operator configuration is rejected.
const savedCoderEnv = { model: process.env.PI_ROLE_MODEL_CODER, thinking: process.env.PI_ROLE_THINKING_CODER };
try {
  delete process.env.PI_ROLE_MODEL_CODER;
  delete process.env.PI_ROLE_THINKING_CODER;
  const bareLaunch = runner.rpcArgs(
    { id: "matrix-bare", roleContract: coder, toolPolicy: coder.toolPolicy },
    { cwd: root, model: { provider: "fixture", id: "parent" }, thinkingLevel: "high" },
  );
  assert.equal(bareLaunch.args[bareLaunch.args.indexOf("--model") + 1], DEFAULT_DELEGATE_MODEL, "no registry keeps the provider-neutral delegate model");
  assert.equal(bareLaunch.env.PI_ROLE_EXPECTED_MODEL, DEFAULT_DELEGATE_MODEL);
  assert.equal(bareLaunch.provenance.selectedModel, DEFAULT_DELEGATE_MODEL);
  assert.equal(bareLaunch.provenance.modelPolicySource, "preferred");

  const emptyRegistryLaunch = runner.rpcArgs(
    { id: "matrix-inherit", roleContract: coder, toolPolicy: coder.toolPolicy },
    { cwd: root, model: { provider: "fixture", id: "parent" }, thinkingLevel: "high", availableModels: [] },
  );
  assert.equal(emptyRegistryLaunch.args[emptyRegistryLaunch.args.indexOf("--model") + 1], "fixture/parent", "an empty registry inherits the parent model");
  assert.equal(emptyRegistryLaunch.provenance.modelPolicySource, "inherit");

  process.env.PI_ROLE_MODEL_CODER = `local/${DEFAULT_DELEGATE_MODEL}`;
  const placeholderLaunch = runner.rpcArgs(
    { id: "matrix-placeholder", roleContract: coder, toolPolicy: coder.toolPolicy },
    { cwd: root, model: { provider: "fixture", id: "parent" }, thinkingLevel: "high" },
  );
  assert.equal(placeholderLaunch.args[placeholderLaunch.args.indexOf("--model") + 1], DEFAULT_DELEGATE_MODEL, "a placeholder provider is normalized to the bare id without a registry");
  assert.equal(placeholderLaunch.env.PI_ROLE_EXPECTED_MODEL, DEFAULT_DELEGATE_MODEL);
  assert.equal(placeholderLaunch.provenance.selectedModel, DEFAULT_DELEGATE_MODEL);
  assert.equal(placeholderLaunch.provenance.modelPolicySource, "environment");

  const placeholderDerivedLaunch = runner.rpcArgs(
    { id: "matrix-placeholder-derived", roleContract: coder, toolPolicy: coder.toolPolicy },
    { cwd: root, model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high", availableModels: configured },
  );
  assert.equal(placeholderDerivedLaunch.args[placeholderDerivedLaunch.args.indexOf("--model") + 1], "sparky0/DeepSeek-V4.1-Flash-1017", "a placeholder pin derives a configured provider");
  assert.equal(placeholderDerivedLaunch.provenance.modelPolicySource, "derived");

  const configuredPlaceholderLaunch = runner.rpcArgs(
    { id: "matrix-registry-local", roleContract: coder, toolPolicy: coder.toolPolicy },
    { cwd: root, model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high", availableModels: [{ provider: "local", id: DEFAULT_DELEGATE_MODEL }] },
  );
  assert.equal(configuredPlaceholderLaunch.args[configuredPlaceholderLaunch.args.indexOf("--model") + 1], `local/${DEFAULT_DELEGATE_MODEL}`, "a provider actually registered as local stays usable");
  assert.equal(configuredPlaceholderLaunch.provenance.modelPolicySource, "derived");

  process.env.PI_ROLE_MODEL_CODER = "local/";
  assert.throws(
    () => runner.rpcArgs(
      { id: "matrix-empty-id", roleContract: coder, toolPolicy: coder.toolPolicy },
      { cwd: root, model: { provider: "fixture", id: "parent" }, thinkingLevel: "high" },
    ),
    /requires a model id/,
    "an empty model id in operator configuration is rejected",
  );
} finally {
  if (savedCoderEnv.model === undefined) delete process.env.PI_ROLE_MODEL_CODER;
  else process.env.PI_ROLE_MODEL_CODER = savedCoderEnv.model;
  if (savedCoderEnv.thinking === undefined) delete process.env.PI_ROLE_THINKING_CODER;
  else process.env.PI_ROLE_THINKING_CODER = savedCoderEnv.thinking;
}

const env = readHarnessEnvironment({ root }).values;
assert.equal(env.PI_ROLE_MODEL_CODER, DEFAULT_DELEGATE_MODEL, "guarded defaults pin the provider-neutral delegate model");
assert.equal(env.PI_ROLE_MODEL_CODER.includes("/"), false, "guarded role pins do not name a placeholder provider");

console.log("role model derivation tests passed");
