"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { readHarnessEnvironment } = require("../src/harness-environment");
const { DEFAULT_DELEGATE_MODEL, DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
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

const env = readHarnessEnvironment({ root }).values;
assert.equal(env.PI_ROLE_MODEL_CODER, DEFAULT_DELEGATE_MODEL, "guarded defaults pin the provider-neutral delegate model");
assert.equal(env.PI_ROLE_MODEL_CODER.includes("/"), false, "guarded role pins do not name a placeholder provider");

console.log("role model derivation tests passed");
