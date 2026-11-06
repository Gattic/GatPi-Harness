"use strict";

const assert = require("node:assert/strict");
const { shapeAnthropicOAuthPayload: shape, withAnthropicOAuth } = require("../src/anthropic-oauth.js");

const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const prefix = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const terminator = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const payload = (content = "hello world this is a test message") => ({
  model: "claude-opus-5-5",
  stream: true,
  max_tokens: 64,
  messages: [{ role: "user", content }],
  system: [{ type: "text", text: identity, cache_control: { type: "ephemeral" } }],
});

// Golden values are fixed reference captures, not computed by the implementation under test.
for (const [text, header] of [
  ["hello world this is a test message", "x-anthropic-billing-header: cc_version=2.1.288.a41; cc_entrypoint=sdk-cli; cch=a1c5f;"],
  ["Hi", "x-anthropic-billing-header: cc_version=2.1.288.9ae; cc_entrypoint=sdk-cli; cch=3639e;"],
  ["𐐀🙂 héllo", "x-anthropic-billing-header: cc_version=2.1.288.17d; cc_entrypoint=sdk-cli; cch=face4;"],
]) {
  for (const content of [text, [{ type: "image", source: {} }, { type: "text", text }]]) {
    const original = payload(content);
    original.messages.push({ role: "user", content: "Do not hash this later message" });
    const before = structuredClone(original);
    const result = shape(original);
    assert.equal(result.system[0].text, header);
    assert.deepEqual(result.system[1], original.system[0], "native identity and cache controls survive");
    assert.deepEqual(original, before, "caller payload is not mutated");
    assert.deepEqual(shape(result), result, "already shaped payloads do not accumulate markers or edits");
  }
}

// Normalize only the Pi preamble, retaining actual instructions, tools, and project/user context.
{
  const original = payload();
  const suffix = "\n\n<project_context>\nKeep authored files safe.\n</project_context>";
  original.system.push({ type: "text", cache_control: { type: "ephemeral" }, text: [
    "Keep this prefix.\n" + prefix,
    "<tools>\n- read: Read files\n</tools>",
    "In addition to the tools above, other tools may exist.",
    "Do not edit credentials.",
    "Here is some useful information about the environment you are running in:",
    "Pi documentation (read only when the user asks about pi itself):\n" + terminator,
  ].join("\n\n") + suffix });
  original.system.push({ type: "text", text: "Independent system block", cache_control: { type: "ephemeral" } });
  const before = structuredClone(original);
  const result = shape(original);
  const text = result.system[2].text;
  assert.ok(text.startsWith("Keep this prefix.\nYou are an expert coding assistant.\nBe concise and helpful."));
  assert.ok(!text.includes("operating inside pi"));
  assert.ok(!text.includes("In addition to the tools above"));
  assert.ok(!text.includes("Pi documentation"));
  assert.ok(text.includes("<tools>\n- read: Read files\n</tools>"));
  assert.ok(text.includes("Do not edit credentials."));
  assert.ok(text.includes("Environment context you are running in:"));
  assert.ok(text.endsWith(suffix));
  assert.deepEqual(result.system[2].cache_control, original.system[1].cache_control);
  assert.deepEqual(result.system[3], original.system[2]);
  assert.deepEqual(original, before);

  const changedPreamble = payload();
  changedPreamble.system.push({ type: "text", text: prefix + "\n\n# Project Context\n\nKeep this project instruction." });
  assert.ok(shape(changedPreamble).system[2].text.endsWith("\n\n# Project Context\n\nKeep this project instruction."));
}

// Retain the old tool ordering repair without changing tool ids, thinking signatures or results.
{
  const original = payload();
  const thinking = { type: "thinking", thinking: "fixture", signature: "fixture-signature" };
  const tool = { type: "tool_use", id: "toolu_fixture", name: "Read", input: { path: "fixture" } };
  const text = { type: "text", text: "trailing text" };
  const resultMessage = { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "result" }] };
  original.messages.push({ role: "assistant", content: [thinking, tool, text] }, resultMessage);
  const result = shape(original);
  assert.deepEqual(result.messages.slice(1), [
    { role: "assistant", content: [thinking, text] },
    { role: "assistant", content: [tool] },
    resultMessage,
  ]);
  assert.deepEqual(shape(result), result);
}

for (const original of [null, {}, { model: "other", messages: [] }, { ...payload(), system: [{ type: "text", text: "API-key prompt" }] }]) {
  assert.equal(shape(original), original, "non-OAuth or unrelated payloads are untouched");
}
for (const content of ["", [{ type: "image", source: {} }]]) {
  const result = shape(payload(content));
  assert.equal(result.system.length, 1, "no fabricated billing hash for an absent first user text");
}

(async () => {
  const calls = [];
  const native = {
    id: "anthropic",
    auth: { oauth: { login() {}, refresh() {}, toAuth() {} }, apiKey: { resolve() {} } },
    getModels() {},
    stream: (...args) => (calls.push(args), "native-stream"),
    streamSimple: (...args) => (calls.push(args), "native-simple-stream"),
  };
  const provider = withAnthropicOAuth(native);
  assert.equal(provider.auth, native.auth, "login, refresh, auth resolution remain native");
  assert.equal(provider.getModels, native.getModels);
  const model = { id: "fixture", provider: "anthropic" };
  const context = { messages: [] };
  const signal = new AbortController().signal;
  for (const method of ["stream", "streamSimple"]) {
    for (const replace of [false, true]) {
      const options = {
        apiKey: "sk-ant-oat01-fixture",
        signal,
        fetch() {}, onResponse() {}, onProviderStreamEvent() {},
        onPayload: async (body, actualModel) => {
          assert.equal(actualModel, model);
          if (replace) return { ...body, callerMarker: "replacement" };
          body.callerMarker = "mutation";
        },
      };
      const stream = provider[method](model, context, options);
      assert.equal(stream, method === "stream" ? "native-stream" : "native-simple-stream", "stream is returned synchronously");
      const [actualModel, actualContext, actualOptions] = calls.at(-1);
      assert.equal(actualModel, model);
      assert.equal(actualContext, context);
      for (const key of ["signal", "fetch", "onResponse", "onProviderStreamEvent"]) assert.equal(actualOptions[key], options[key]);
      const shaped = await actualOptions.onPayload(payload(), model);
      assert.equal(shaped.callerMarker, replace ? "replacement" : "mutation");
      assert.ok(shaped.system[0].text.startsWith("x-anthropic-billing-header:"));
    }
    const apiKeyOptions = { apiKey: "sk-ant-api03-fixture", onPayload: () => payload() };
    provider[method](model, context, apiKeyOptions);
    assert.equal(calls.at(-1)[2], apiKeyOptions, "API key opts and callback pass through even for Claude identity prompts");
    const error = new Error("caller hook failure");
    provider[method](model, context, { apiKey: "sk-ant-oat01-fixture", onPayload: async () => { throw error; } });
    await assert.rejects(calls.at(-1)[2].onPayload(payload(), model), (actual) => actual === error);
  }
  console.log("anthropic-oauth tests passed (golden payloads, normalization, idempotence, stream composition)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
