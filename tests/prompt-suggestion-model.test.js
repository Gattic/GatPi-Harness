#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");
const {
  configPath,
  formatModelRef,
  inspectModelConfig,
  parseModelRef,
  readModelConfig,
  requestModelSuggestion,
  writeModelConfig,
} = require("../src/prompt-suggestion-model.js");

const fixture = tmpFixture("pi-prompt-suggestion-model-");
const env = { ...process.env, PI_PROMPT_SUGGESTIONS_CONFIG: path.join(fixture, "agent", "prompt-suggestions.json") };
delete env.PI_PROMPT_SUGGESTIONS_MODEL;

assert.deepEqual(parseModelRef("openai-codex/gpt-6-astra"), { provider: "openai-codex", modelId: "gpt-6-astra" });
assert.deepEqual(parseModelRef("openrouter/anthropic/claude-sonnet-4.5"), { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" });
assert.equal(parseModelRef("missing-separator"), null);
assert.equal(parseModelRef("/missing-provider"), null);
assert.equal(parseModelRef("provider/"), null);
assert.equal(parseModelRef("provider/model with space"), null);

(async () => {
  const agentEnv = { ...env, PI_CODING_AGENT_DIR: path.join(fixture, "agent-dir") };
  delete agentEnv.PI_PROMPT_SUGGESTIONS_CONFIG;
  assert.equal(configPath(agentEnv), path.join(fixture, "agent-dir", "prompt-suggestions.json"), "the default config lives in the machine-wide agent directory");
  assert.equal(readModelConfig({ env: { ...agentEnv, PI_PROMPT_SUGGESTIONS_MODEL: "missing-separator" } }).reasonCode, "invalid-config", "an invalid model override fails explicitly");

  const missing = readModelConfig({ env });
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, "model-not-configured", "an unset machine-wide model is explicit, not a Hermes fallback");
  assert.equal(missing.file, env.PI_PROMPT_SUGGESTIONS_CONFIG);

  const saved = writeModelConfig({ provider: "openai-codex", modelId: "gpt-6-astra" }, { env });
  assert.equal(saved.ok, true);
  assert.equal(formatModelRef(saved.config), "openai-codex/gpt-6-astra");
  assert.equal(fs.statSync(saved.file).mode & 0o777, 0o600, "the machine-wide model config stays private");
  const loaded = readModelConfig({ env });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.config, { provider: "openai-codex", modelId: "gpt-6-astra" });
  assert.equal(loaded.source, "file");

  const envOverride = readModelConfig({ env: { ...env, PI_PROMPT_SUGGESTIONS_MODEL: "anthropic/claude-sonnet-5-5" } });
  assert.equal(envOverride.ok, true);
  assert.deepEqual(envOverride.config, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
  assert.equal(envOverride.source, "environment");

  fs.writeFileSync(env.PI_PROMPT_SUGGESTIONS_CONFIG, "{not json");
  const invalid = readModelConfig({ env });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reasonCode, "invalid-config");
  writeModelConfig({ provider: "openai-codex", modelId: "gpt-6-astra" }, { env });

  const model = { provider: "openai-codex", id: "gpt-6-astra" };
  const registry = {
    find: (provider, modelId) => provider === model.provider && modelId === model.id ? model : undefined,
    hasConfiguredAuth: (candidate) => candidate === model,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Run the focused tests and verify the result." }] }),
  };
  const inspection = inspectModelConfig(registry, { env });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.modelRef, "openai-codex/gpt-6-astra");
  assert.equal(inspection.available, true);
  assert.equal(inspection.authConfigured, true);

  const packet = { publicRecentContext: "[user] Inspect the project", skillContext: null };
  const calls = [];
  const recordingRegistry = {
    ...registry,
    complete: async (selected, context, options) => {
      calls.push({ selected, context, options });
      return { stopReason: "stop", content: [{ type: "text", text: "Run the focused tests and verify the result." }] };
    },
  };
  const result = await requestModelSuggestion({ registry: recordingRegistry, config: loaded.config, packet, signal: new AbortController().signal });
  assert.equal(result.value, "Run the focused tests and verify the result.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selected, model, "the configured model must be resolved through the registry");
  assert.match(calls[0].context.systemPrompt, /Return ONLY one concise, complete prompt for the best next step/, "the model receives the original suggestion instruction");
  assert.match(calls[0].context.messages[0].content[0].text, /Recent chat context:\n\[user\] Inspect the project/, "the model receives the bounded public context");
  assert.equal(calls[0].options.signal instanceof AbortSignal, true, "cancellation propagates to the provider call");

  await assert.rejects(
    () => requestModelSuggestion({ registry, config: { provider: "anthropic", modelId: "missing" }, packet }),
    (error) => error.reasonCode === "model-unavailable",
    "a configured model absent from the registry fails explicitly",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry: undefined, config: loaded.config, packet }),
    (error) => error.reasonCode === "model-unavailable",
    "a missing model registry fails explicitly",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry, config: loaded.config, packet: { publicRecentContext: "context", rawTranscript: "private" } }),
    (error) => error.reasonCode === "invalid-packet",
    "unsupported packet fields are rejected",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry, packet }),
    (error) => error.reasonCode === "model-not-configured",
    "a missing model configuration is explicit",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry: { ...registry, complete: async () => ({ stopReason: "aborted", content: [] }) }, config: loaded.config, packet }),
    (error) => error.reasonCode === "cancelled",
    "provider cancellation is classified",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry: { ...registry, complete: async () => ({ stopReason: "stop", content: [] }) }, config: loaded.config, packet }),
    (error) => error.reasonCode === "invalid-suggestion",
    "an empty response is not accepted as a suggestion",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry, config: loaded.config, packet: { publicRecentContext: "api_key=abcdefghijklmnopqrst" } }),
    (error) => error.reasonCode === "privacy",
    "secret-bearing context is rejected before a provider call",
  );
  await assert.rejects(
    () => requestModelSuggestion({ registry: { ...registry, complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "api_key=abcdefghijklmnopqrst" }] }) }, config: loaded.config, packet }),
    (error) => error.reasonCode === "privacy",
    "secret-bearing model output is rejected",
  );

  console.log("prompt suggestion model checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
