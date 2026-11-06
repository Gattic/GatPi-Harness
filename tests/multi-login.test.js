"use strict";

// Multi-login: alias logins per provider and prioritized account failover. Loads the real
// extension through Pi's jiti loader with the real built-in providers and a stub Pi API.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { expandPriority, nextCandidate, isAccountFailure, validateConfig, CooldownStore, DirectoryModelStore } = require("../src/multi-login.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const model = (provider, id) => ({ provider, id, api: "test-api" });

function registry(models, signedIn) {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (m) => signedIn.has(m.provider),
  };
}

const config = validateConfig(
  { accounts: { anthropic: 2, openai: 2 }, priority: ["anthropic/opus", "openai/astra", "openai/sol"] },
  "fixture",
);
const entries = expandPriority(config.priority, config.accounts);
assert.deepEqual(
  entries.map((e) => `${e.provider}/${e.modelId}`),
  ["anthropic/opus", "anthropic-account-2/opus", "openai/astra", "openai-account-2/astra", "openai/sol", "openai-account-2/sol"],
  "each model is tried on every login before the next model",
);
const models = entries.map((e) => model(e.provider, e.modelId));
const all = new Set(["anthropic", "anthropic-account-2", "openai", "openai-account-2"]);

// The next usable entry below the failed model; unsigned and cooled accounts are skipped.
{
  const next = (failed, signedIn, cooldowns = {}) => nextCandidate(failed, entries, registry(models, signedIn), cooldowns)?.ref;
  assert.equal(next(model("anthropic", "opus"), all), "anthropic-account-2/opus");
  assert.equal(next(model("anthropic", "opus"), new Set(["anthropic", "openai"])), "openai/astra");
  assert.equal(next(model("anthropic-account-2", "opus"), all, { openai: Date.now() + 1000 }), "openai-account-2/astra");
  assert.equal(next(model("openai", "astra"), new Set(["openai"]), { openai: Date.now() + 1000 }), undefined, "a cooled provider is skipped for every model");
  assert.equal(next(model("openai-account-2", "sol"), all), undefined, "the list does not wrap back to higher priorities");
  assert.equal(next(model("google", "gemini"), all), "anthropic/opus", "a model outside the list falls back to the top");
}

// Only explicit exhaustion or auth failures trigger failover, not a generic 429.
for (const text of [
  "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
  "You have hit your usage limit",
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
  '429 {"error":{"message":"No more usage available until reset"}}',
  "insufficient_quota",
  "You exceeded your current quota, please check your plan and billing details",
  "Your credit balance is too low to access the Anthropic API.",
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  "OpenAI Codex token refresh failed (401)",
]) {
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: text }), true, text);
}
for (const text of [
  '429 {"type":"rate_limit_error"}',
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
  "429 Too many requests",
  "Rate limit reached for requests per minute",
  "429 quota for tokens per minute exceeded; retry later",
  "529 overloaded_error", "503 service unavailable", "fetch failed",
]) {
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: text }), false, text);
}

// Cooldowns persist across store instances and expire.
{
  const dir = tmpFixture("multi-login-state-");
  let now = 1_000;
  const store = new CooldownStore(path.join(dir, "state.json"), () => now);
  store.coolDown("anthropic", 1);
  assert.deepEqual(Object.keys(new CooldownStore(store.file, () => now).read()), ["anthropic"]);
  now += 60_001;
  assert.deepEqual(store.read(), {});
  fs.rmSync(dir, { recursive: true });
}

// Exact provider/account + model choices are independent per normalized absolute directory.
{
  const dir = tmpFixture("multi-login-models-");
  const store = new DirectoryModelStore(path.join(dir, "models"));
  const first = path.join(dir, "project-a");
  const second = path.join(dir, "project-b");
  assert.equal(store.read(first), undefined);
  store.write(first, { ...model("anthropic-account-2", "opus"), apiKey: "not-persisted" });
  const restarted = new DirectoryModelStore(store.dir);
  restarted.write(second, model("openai", "astra"));
  assert.deepEqual(restarted.read(`${first}/nested/..`), { provider: "anthropic-account-2", modelId: "opus" });
  store.write(first, model("openai", "sol"));
  assert.deepEqual(restarted.read(first), { provider: "openai", modelId: "sol" });
  assert.deepEqual(store.read(second), { provider: "openai", modelId: "astra" });
  const files = fs.readdirSync(store.dir);
  assert.equal(files.length, 2, "overwrites do not retain extra state or temporary files");
  for (const file of files) {
    assert.match(file, /^[a-f0-9]{64}\.json$/);
    const record = fs.readFileSync(path.join(store.dir, file), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(record)), ["provider", "modelId"]);
    assert.ok(!record.includes(dir));
  }
  const invalid = new DirectoryModelStore(path.join(dir, "invalid"));
  invalid.write(first, model("anthropic", "opus"));
  const invalidFile = path.join(invalid.dir, fs.readdirSync(invalid.dir)[0]);
  fs.writeFileSync(invalidFile, "{");
  assert.throws(() => invalid.read(first), SyntaxError, "corrupt state is not silently discarded");
  fs.writeFileSync(invalidFile, '{"provider":"anthropic"}');
  assert.throws(() => invalid.read(first), /invalid directory model selection/);
  fs.rmSync(dir, { recursive: true });
}

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("multi-login logic tests passed; extension behavior skipped (global pi install not found)");
  process.exit(0);
}

// Exercise the actual registered provider and native Pi transport; never contact a live endpoint.
async function assertAnthropicHandshake(provider) {
  const signal = new AbortController().signal;
  let authUrl;
  let exchanges = 0;
  const networkGuard = globalThis.fetch;
  const interaction = {
    signal,
    notify: (event) => { if (event.type === "auth_url") authUrl = new URL(event.url); },
    prompt: async (request) => request.type === "select" ? "copy_code" : `fixture-code#${authUrl.searchParams.get("state")}`,
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://platform.claude.com/v1/oauth/token");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.ok(body.client_id);
    assert.equal(init.signal.aborted, false);
    if (exchanges++ === 0) {
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.code, "fixture-code");
      assert.equal(body.state, authUrl.searchParams.get("state"));
      assert.equal(body.code_verifier, body.state);
      assert.equal(body.redirect_uri, authUrl.searchParams.get("redirect_uri"));
      assert.equal(authUrl.origin, "https://claude.ai");
      assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authUrl.searchParams.get("code_challenge"), createHash("sha256").update(body.code_verifier).digest("base64url"));
      assert.ok(authUrl.searchParams.get("scope").split(" ").includes("user:inference"));
      assert.ok(authUrl.searchParams.get("scope").split(" ").includes("user:sessions:claude_code"));
    } else {
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, "fixture-refresh");
      assert.equal(body.scope, undefined, "refresh preserves the native scope contract");
    }
    return new Response(JSON.stringify({
      access_token: `sk-ant-oat01-fixture-${exchanges}`,
      refresh_token: exchanges === 1 ? "fixture-refresh" : "fixture-refresh-rotated",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal(provider.auth.oauth.isSubscription, true);
    const credential = await provider.auth.oauth.login(interaction);
    assert.equal(credential.type, "oauth");
    assert.deepEqual(await provider.auth.oauth.toAuth(credential), { apiKey: "sk-ant-oat01-fixture-1" });
    const refreshed = await provider.auth.oauth.refresh(credential, signal);
    assert.equal(refreshed.refresh, "fixture-refresh-rotated");
    assert.ok(refreshed.expires > Date.now());
    assert.deepEqual(await provider.auth.oauth.toAuth(refreshed), { apiKey: "sk-ant-oat01-fixture-2" });
    await assert.rejects(provider.auth.oauth.login({
      ...interaction,
      prompt: async (request) => request.type === "select" ? "copy_code" : "fixture-code#wrong-state",
    }), /OAuth state mismatch/);
    assert.equal(exchanges, 2, "bad OAuth state is rejected before token exchange");
  } finally {
    globalThis.fetch = networkGuard;
  }

  const nativeModel = provider.getModels().find((m) => m.id === "claude-opus-5-5");
  const requestModel = { ...nativeModel, baseUrl: "https://fixture.invalid" };
  const prompt = "You are an expert coding assistant operating inside pi, a coding agent harness.\n\nDo not edit credentials.\n\nPi documentation (read only when the user asks about pi itself):\n- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)\n\n<project_context>Keep this.</project_context>";
  const context = { messages: [
    { role: "system", content: prompt, timestamp: 0, toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] },
    { role: "user", content: "hello world this is a test message", timestamp: 1 },
  ] };
  const before = structuredClone(context);
  const events = [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: nativeModel.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  for (const method of ["stream", "streamSimple"]) {
    for (const oauth of [true, false]) {
      let captured;
      let requests = 0;
      let payloadCalls = 0;
      let responseCalls = 0;
      const rawEvents = [];
      const apiKey = oauth ? "sk-ant-oat01-fixture-2" : "sk-ant-api03-fixture";
      const stream = provider[method](requestModel, context, {
        apiKey, maxRetries: 0, maxTokens: 32, signal,
        headers: { "x-fixture-header": "kept" },
        onPayload: async (body, actualModel) => {
          payloadCalls++;
          assert.equal(actualModel.provider, provider.id);
          return { ...body, metadata: { user_id: "fixture-user" } };
        },
        onResponse: async (response) => { responseCalls++; assert.equal(response.status, 200); },
        onProviderStreamEvent: async (event) => { rawEvents.push(event.type); },
        fetch: async (url, init) => {
          assert.equal(new URL(url).hostname, "fixture.invalid");
          requests++;
          const headers = new Headers(init.headers);
          assert.equal(headers.get("x-fixture-header"), "kept");
          assert.equal(headers.get("anthropic-version"), "2023-06-01");
          assert.equal(headers.get("authorization"), oauth ? `Bearer ${apiKey}` : null);
          assert.equal(headers.get("x-api-key"), oauth ? null : apiKey);
          if (oauth) {
            assert.equal(headers.get("x-app"), "cli");
            assert.match(headers.get("user-agent"), /^claude-cli\//);
            assert.ok(headers.get("anthropic-beta").includes("oauth-2025-04-20"));
            assert.ok(headers.get("anthropic-beta").includes("claude-code-20250219"));
          }
          captured = JSON.parse(init.body);
          return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
            status: 200, headers: { "content-type": "text/event-stream" },
          });
        },
      });
      assert.equal(typeof stream.result, "function", "native stream API remains synchronous");
      const result = await stream.result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(result.content[0].text, "ok");
      assert.equal(result.provider, provider.id);
      assert.equal(result.model, nativeModel.id);
      assert.equal(result.usage.input, 5);
      assert.equal(result.usage.output, 1);
      assert.equal(requests, 1);
      assert.equal(payloadCalls, 1);
      assert.equal(responseCalls, 1);
      assert.deepEqual(rawEvents, events.map((event) => event.type));
      assert.equal(captured.model, nativeModel.id);
      assert.equal(captured.max_tokens, 32);
      assert.deepEqual(captured.metadata, { user_id: "fixture-user" });
      assert.equal(captured.tools[0].name, oauth ? "Read" : "read");
      if (oauth) {
        assert.equal(captured.system[0].text, "x-anthropic-billing-header: cc_version=2.1.288.a41; cc_entrypoint=sdk-cli; cch=a1c5f;");
        assert.equal(captured.system.filter((block) => block.text.startsWith("x-anthropic-billing-header:")).length, 1);
        assert.equal(captured.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
        assert.ok(captured.system[1].cache_control);
        assert.ok(captured.system[2].cache_control);
        assert.ok(!captured.system[2].text.includes("operating inside pi"));
        assert.ok(captured.system[2].text.includes("Do not edit credentials."));
        assert.ok(captured.system[2].text.endsWith("<project_context>Keep this.</project_context>"));
      } else {
        assert.equal(captured.system.length, 1);
        assert.equal(captured.system[0].text, prompt, "API-key request prompt remains byte-for-byte unchanged");
      }
      assert.deepEqual(context, before, "serialization never edits the stored transcript");
    }
  }
}

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
globalThis.fetch = async () => { throw new Error("multi-login test attempted an unmocked network request"); };

(async () => {
  const aiRoot = fs.existsSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
    ? fs.realpathSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
    : fs.realpathSync(path.resolve(piPackageRoot, "..", "ai"));
  const agentDir = tmpFixture("multi-login-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.writeFileSync(
    path.join(agentDir, "multi-login.json"),
    JSON.stringify({ accounts: { anthropic: 2 }, priority: ["anthropic/claude-opus-5-5", "anthropic-account-2/claude-opus-5-5"] }),
  );

  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve("extensions/multi-login/index.ts");
  const jiti = createJiti(extensionFile, {
    interopDefault: true,
    alias: {
      "@earendil-works/pi-coding-agent": piPackageRoot,
      "@earendil-works/pi-ai/providers/all": path.join(aiRoot, "dist", "providers", "all.js"),
      "@earendil-works/pi-ai": aiRoot,
    },
  });
  const mod = await jiti.import(extensionFile);

  function loadExtension(ctx, setModelOverride) {
    const instance = { ctx, providers: [], virtualModels: [], handlers: new Map(), commands: [], selected: [] };
    (mod.default || mod)({
      registerProvider: (provider) => instance.providers.push(provider),
      registerVirtualModel: (definition) => instance.virtualModels.push(definition),
      registerCommand: (name) => instance.commands.push(name),
      setModel: async (m) => {
        if (setModelOverride) return setModelOverride(m);
        // Real Pi rejects the switch by throwing when the target has no usable credential.
        if (!instance.ctx.modelRegistry.hasConfiguredAuth(m)) throw new Error(`No API key for ${m.provider}/${m.id}`);
        const previousModel = instance.ctx.model;
        instance.selected.push(m);
        instance.ctx.model = m;
        if (previousModel?.provider !== m.provider || previousModel?.id !== m.id) {
          await instance.handlers.get("model_select")({ model: m, previousModel, source: "set" }, instance.ctx);
        }
        return true;
      },
      on: (event, handler) => instance.handlers.set(event, handler),
    });
    return instance;
  }
  const initial = loadExtension();
  const { providers, virtualModels, handlers, selected } = initial;

  // Both the base and alias use the shaped transport and retain the built-in OAuth flow.
  assert.deepEqual(providers.map((p) => p.id), ["anthropic", "anthropic-account-2"]);
  assert.equal(virtualModels.length, 0, "failover switches real models; no virtual model is registered");
  for (const provider of providers) await assertAnthropicHandshake(provider);

  // The exact extension also loads in isolated children: registration and login
  // survive, but no hook may replace the selected provider/model or write state.
  const parentId = process.env.PI_SUBAGENT_PARENT_ID;
  const beforeChild = fs.readdirSync(agentDir);
  try {
    process.env.PI_SUBAGENT_PARENT_ID = "child-auth-regression";
    const child = loadExtension();
    assert.deepEqual(child.providers.map(p => p.id), providers.map(p => p.id));
    assert.equal(child.handlers.size, 0, "no child failover, cooldown or directory-model hooks");
    assert.deepEqual(child.commands, [], "no child cooldown reset command");
    assert.deepEqual(child.selected, [], "registration does not change the inherited model");
    for (const [index, provider] of child.providers.entries()) {
      // builtinProviders() creates fresh instances per load; aliases within
      // this load must retain their own base provider's native OAuth callbacks.
      if (index > 0) for (const operation of ["login", "refresh", "toAuth"]) assert.equal(provider.auth.oauth[operation], child.providers[0].auth.oauth[operation]);
      await assertAnthropicHandshake(provider);
    }
    assert.deepEqual(fs.readdirSync(agentDir), beforeChild, "child registration writes no credential, cooldown or model files");
  } finally {
    if (parentId === undefined) delete process.env.PI_SUBAGENT_PARENT_ID;
    else process.env.PI_SUBAGENT_PARENT_ID = parentId;
  }
  const alias = providers[1];
  const aliasModels = alias.getModels();
  assert.ok(aliasModels.some((m) => m.id === "claude-opus-5-5"));
  assert.ok(aliasModels.every((m) => m.provider === "anthropic-account-2"));
  assert.equal(typeof alias.auth.oauth.login, "function");
  assert.equal(await alias.auth.apiKey.resolve({ credential: undefined }), undefined, "aliases ignore ambient env keys");

  const primary = model("anthropic", "claude-opus-5-5");
  const secondary = aliasModels.find((m) => m.id === "claude-opus-5-5");
  const firstCwd = path.join(agentDir, "project-a");
  const secondCwd = path.join(agentDir, "project-b");
  const savedModels = new DirectoryModelStore(path.join(agentDir, "multi-login-models"));
  function context(cwd = firstCwd, current = primary) {
    const notices = [];
    return {
      cwd,
      model: current,
      modelRegistry: registry([primary, secondary], new Set(["anthropic", "anthropic-account-2"])),
      sessionManager: { getBranch: () => [{ type: "model_change", provider: current.provider, modelId: current.id }] },
      notices,
      ui: { notify: (...args) => notices.push(args) },
    };
  }
  const ctx = context();
  initial.ctx = ctx;
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.deepEqual(savedModels.read(firstCwd), { provider: primary.provider, modelId: primary.id }, "first visit remembers the current model");
  const failure = (provider, errorMessage) => ({ message: { role: "assistant", provider, model: "claude-opus-5-5", stopReason: "error", errorMessage } });

  // Generic 429s preserve the error and model, do not notify/switch, and do not create cooldowns.
  const throttled = failure("anthropic", '429 {"error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}');
  const unchanged = structuredClone(throttled);
  assert.equal(await handlers.get("message_end")(throttled, ctx), undefined);
  assert.deepEqual(throttled, unchanged);
  assert.deepEqual(selected, []);
  assert.deepEqual(ctx.notices, []);
  assert.equal(fs.existsSync(path.join(agentDir, "multi-login-state.json")), false);

  // Explicit exhausted usage, even in a 429, switches accounts immediately and is retryable.
  const result = await handlers.get("message_end")(failure("anthropic", '429 {"error":{"type":"rate_limit_error","message":"You\'re out of extra usage."}}'), ctx);
  assert.deepEqual(selected, [secondary], "the session moves to the next login of the same model");
  assert.deepEqual(savedModels.read(firstCwd), { provider: secondary.provider, modelId: secondary.id }, "failover persists the selected account");
  assert.match(result.message.errorMessage, /retrying on anthropic-account-2\/claude-opus-5-5/);
  assert.match(result.message.errorMessage, /rate limit retry/);
  assert.match(result.message.errorMessage, /You're out of extra usage/, "retain the original reason");

  // The last usable account keeps the original error and the session model.
  assert.equal(await handlers.get("message_end")(failure("anthropic-account-2", "usage limit"), ctx), undefined);
  assert.equal(selected.length, 1);
  // Transient errors are left to Pi's own retry.
  assert.equal(await handlers.get("message_end")(failure("anthropic", "529 overloaded_error"), ctx), undefined);

  // A rejected switch (missing credential or provider error) must not abort the turn or move the session.
  new CooldownStore(path.join(agentDir, "multi-login-state.json")).clear();
  const brokenCtx = context(path.join(agentDir, "broken-project"));
  const broken = loadExtension(brokenCtx, () => { throw new Error("No API key for anthropic-account-2/claude-opus-5-5"); });
  const brokenResult = await broken.handlers.get("message_end")(failure("anthropic", "429 You're out of extra usage."), brokenCtx);
  assert.equal(brokenResult, undefined, "a failed switch returns no retry directive");
  assert.deepEqual(broken.selected, []);
  assert.equal(brokenCtx.model, primary, "the session model is unchanged when the switch fails");
  assert.match(brokenCtx.notices[0][0], /Could not switch to anthropic-account-2\/claude-opus-5-5/);
  assert.ok(new CooldownStore(path.join(agentDir, "multi-login-state.json")).read().anthropic > Date.now(), "the failed account is still cooled down");

  async function start(ctx, reason = "startup") {
    const instance = loadExtension(ctx);
    await instance.handlers.get("session_start")({ reason }, ctx);
    return instance;
  }
  async function choose(instance, next, source) {
    const previousModel = instance.ctx.model;
    instance.ctx.model = next;
    await instance.handlers.get("model_select")({ model: next, previousModel, source }, instance.ctx);
  }

  // Fresh sessions restore the account, while another directory starts independently.
  for (const reason of ["startup", "new"]) {
    const restored = await start(context(), reason);
    assert.deepEqual(restored.selected, [secondary]);
    assert.match(
      restored.ctx.notices[0][0],
      /restored saved directory model anthropic-account-2\/claude-opus-5-5 \(was anthropic\/claude-opus-5-5\)/,
      "a restore is announced, never silent",
    );
  }
  const other = await start(context(secondCwd));
  assert.deepEqual(other.selected, []);
  assert.deepEqual(savedModels.read(secondCwd), { provider: primary.provider, modelId: primary.id });
  for (const source of ["set", "cycle"]) {
    await choose(other, secondary, source);
    assert.deepEqual((await start(context(secondCwd))).selected, [secondary], `${source} survives a new extension instance`);
    await choose(other, primary, source);
    assert.deepEqual((await start(context(secondCwd, secondary))).selected, [primary]);
    assert.deepEqual((await start(context())).selected, [secondary], "another directory's choice is untouched");
  }
  const outsidePriority = model("custom-provider", "models/custom");
  await choose(other, outsidePriority, "set");
  const customCtx = context(secondCwd);
  customCtx.modelRegistry = registry([primary, outsidePriority], new Set([primary.provider, outsidePriority.provider]));
  assert.deepEqual((await start(customCtx)).selected, [outsidePriority], "model choice is not restricted to failover priority");

  // Reloading, resuming, forking and restored history do not replace the directory preference.
  for (const reason of ["reload", "resume", "fork"]) {
    const resumed = await start(context(), reason);
    assert.deepEqual(resumed.selected, []);
    await choose(resumed, primary, "restore");
    assert.deepEqual(savedModels.read(firstCwd), { provider: secondary.provider, modelId: secondary.id });
  }
  const history = context();
  history.sessionManager.getBranch = () => [{ type: "message" }];
  assert.deepEqual((await start(history)).selected, [], "startup with an existing conversation keeps its model");
  assert.deepEqual((await start(context(firstCwd, secondary))).selected, [], "matching defaults do not trigger another model change");

  // One-shot CLI model/scope choices are authoritative and do not overwrite the saved default.
  const originalArgv = process.argv;
  try {
    for (const args of [["--model", "anthropic/opus"], ["--provider", "anthropic"], ["--models", "anthropic/*"]]) {
      process.argv = [...originalArgv.slice(0, 2), ...args];
      assert.deepEqual((await start(context())).selected, []);
      assert.deepEqual(savedModels.read(firstCwd), { provider: secondary.provider, modelId: secondary.id });
    }
  } finally {
    process.argv = originalArgv;
  }

  // Unregistered or signed-out saved models leave the current model and stored choice intact.
  for (const unavailable of ["unknown", "signed-out"]) {
    const unavailableCtx = context();
    unavailableCtx.modelRegistry = registry(unavailable === "unknown" ? [primary] : [primary, secondary], new Set([primary.provider]));
    const instance = await start(unavailableCtx);
    assert.deepEqual(instance.selected, []);
    assert.equal(instance.ctx.model, primary);
    assert.match(instance.ctx.notices[0][0], /saved directory model .* is unavailable/);
    assert.deepEqual(savedModels.read(firstCwd), { provider: secondary.provider, modelId: secondary.id });
    await choose(instance, primary, "set");
    assert.deepEqual(savedModels.read(firstCwd), { provider: primary.provider, modelId: primary.id }, "a later choice is still remembered after a failed restore");
    savedModels.write(firstCwd, secondary);
  }

  // Pi may decline a switch without throwing; the current model and the saved choice both survive.
  const decliningCtx = context();
  const declining = loadExtension(decliningCtx, () => false);
  await declining.handlers.get("session_start")({ reason: "startup" }, decliningCtx);
  assert.deepEqual(declining.selected, []);
  assert.equal(decliningCtx.model, primary);
  assert.match(decliningCtx.notices[0][0], /saved directory model .* is unavailable; keeping the current model/);
  assert.deepEqual(savedModels.read(firstCwd), { provider: secondary.provider, modelId: secondary.id }, "a declined restore leaves the saved choice intact");

  // With no second Anthropic login, exhausted usage advances to the next priority model.
  fs.writeFileSync(path.join(agentDir, "multi-login.json"), JSON.stringify({
    accounts: { anthropic: 2 }, priority: ["anthropic/claude-opus-5-5", "openai/astra", "openai/sol"],
  }));
  const nextModel = model("openai", "astra");
  const fallbackCtx = context(path.join(agentDir, "fallback-project"));
  fallbackCtx.modelRegistry = registry([primary, secondary, nextModel, model("openai", "sol")], new Set(["anthropic", "openai"]));
  const fallback = loadExtension(fallbackCtx);
  const switched = await fallback.handlers.get("message_end")(failure("anthropic", "429 No more usage available"), fallbackCtx);
  assert.deepEqual(fallback.selected, [nextModel]);
  assert.match(switched.message.errorMessage, /retrying on openai\/astra/);
  assert.ok(new CooldownStore(path.join(agentDir, "multi-login-state.json")).read().anthropic > Date.now());
  const stateBeforeThrottle = fs.readFileSync(path.join(agentDir, "multi-login-state.json"), "utf8");
  assert.equal(await fallback.handlers.get("message_end")(throttled, fallbackCtx), undefined);
  assert.equal(fs.readFileSync(path.join(agentDir, "multi-login-state.json"), "utf8"), stateBeforeThrottle, "throttling does not extend an existing cooldown");
  assert.deepEqual(fallback.selected, [nextModel]);

  // The shipped priority must resolve against the actual built-in catalog and Codex login.
  fs.unlinkSync(path.join(agentDir, "multi-login.json"));
  const { builtinProviders } = await jiti.import(path.join(aiRoot, "dist", "providers", "all.js"));
  const nativeModels = builtinProviders().flatMap((provider) => provider.getModels());
  const defaultCtx = context(path.join(agentDir, "default-priority-project"));
  defaultCtx.modelRegistry = registry(nativeModels, new Set(["anthropic", "openai-codex"]));
  const defaults = loadExtension(defaultCtx);
  assert.ok(defaults.providers.some((provider) => provider.id === "openai-codex-account-2"));
  await defaults.handlers.get("message_end")(failure("anthropic", "429 You're out of extra usage."), defaultCtx);
  assert.equal(defaultCtx.model.provider, "openai-codex");
  assert.equal(defaultCtx.model.id, "gpt-6-astra");
  assert.equal(defaults.selected.length, 1);

  fs.rmSync(agentDir, { recursive: true });
  console.log("multi-login tests passed (directory model persistence + announced restore, restore/failover switch failures, failover, base + alias, both stream APIs, offline OAuth login/refresh + HTTP/SSE handshake)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});
