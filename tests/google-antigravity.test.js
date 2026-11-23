"use strict";

// Google Antigravity handshake: OAuth client shape, Cloud Code Assist envelope,
// SSE transport and multi-login wiring. Every network call is mocked; the test
// never contacts Google and never opens the OAuth callback port.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { tmpFixture } = require("./helpers/tmp-fixture");
const { isAccountFailure } = require("../src/multi-login.js");

// The extension reads Google's OAuth client identifiers from the environment or a
// machine-local file. The suite supplies synthetic values; a real client is never
// committed or needed here.
process.env.PI_ANTIGRAVITY_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.PI_ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
delete process.env.PI_ANTIGRAVITY_OAUTH_CONFIG;

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("google-antigravity tests passed; extension behavior skipped (global pi install not found)");
  process.exit(0);
}

const aiRoot = fs.existsSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  ? fs.realpathSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  : fs.realpathSync(path.resolve(piPackageRoot, "..", "ai"));

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function textResponse(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain" } });
}

function sseResponse(chunks) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function interaction({ manualCode, onNotify } = {}) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    notify(event) {
      onNotify?.(event);
    },
    prompt(prompt) {
      const own = prompt.signal ?? controller.signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("prompt aborted"));
        if (own.aborted) return abort();
        own.addEventListener("abort", abort, { once: true });
        if (manualCode === undefined) return;
        resolve(manualCode);
      });
    },
    cancel() {
      controller.abort();
    },
  };
}

function stateFromAuthUrl(url) {
  return new URL(url).searchParams.get("state");
}

(async () => {
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const moduleFile = path.resolve("extensions/multi-login/antigravity/index.ts");
  const jiti = createJiti(moduleFile, {
    interopDefault: true,
    alias: {
      "@earendil-works/pi-coding-agent": piPackageRoot,
      "@earendil-works/pi-ai/providers/all": path.join(aiRoot, "dist", "providers", "all.js"),
      "@earendil-works/pi-ai": aiRoot,
    },
  });
  const antigravity = await jiti.import(moduleFile);
  const oauth = await jiti.import(path.resolve("extensions/multi-login/antigravity/oauth.ts"));
  const streamModule = await jiti.import(path.resolve("extensions/multi-login/antigravity/stream.ts"));
  const modelsModule = await jiti.import(path.resolve("extensions/multi-login/antigravity/models.ts"));

  const { antigravityProvider, ANTIGRAVITY_PROVIDER_ID } = antigravity;
  const ACP_PROVIDER_ID = "google-antigravity-acp";
  const { buildAuthorizationUrl, parseAuthorizationInput, discoverProject, refreshAntigravityToken, antigravityClient, antigravityCredentialsFile, DEFAULT_PROJECT_ID } = oauth;
  const { buildRequest, convertMessages, streamAntigravity, streamSimpleAntigravity } = streamModule;
  const { STATIC_ANTIGRAVITY_MODELS, ANTIGRAVITY_ENDPOINTS, currentAntigravityModels, resetAntigravityModelCache, discoverAntigravityModels, parseProvisionedModelIds, modelForId } = modelsModule;

  // --- Authorization URL matches Antigravity's client contract -------------
  {
    const url = new URL(buildAuthorizationUrl("verifier-123", "challenge-123"));
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.pathname, "/o/oauth2/v2/auth");
    const params = url.searchParams;
    assert.equal(params.get("client_id"), process.env.PI_ANTIGRAVITY_CLIENT_ID, "the configured client id reaches the authorization URL");
    assert.equal(params.get("redirect_uri"), "http://localhost:51121/oauth-callback");
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("code_challenge"), "challenge-123");
    assert.equal(params.get("state"), "verifier-123");
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("prompt"), "consent");
    const scopes = params.get("scope").split(" ");
    for (const scope of [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ]) {
      assert.ok(scopes.includes(scope), `scope ${scope}`);
    }
  }

  // --- Client credentials come from the environment or a machine-local file ---
  {
    const savedId = process.env.PI_ANTIGRAVITY_CLIENT_ID;
    const savedSecret = process.env.PI_ANTIGRAVITY_CLIENT_SECRET;
    const savedConfig = process.env.PI_ANTIGRAVITY_OAUTH_CONFIG;
    const credentialsDir = tmpFixture("antigravity-credentials-");
    const credentialsFile = path.join(credentialsDir, "antigravity-oauth.json");
    try {
      delete process.env.PI_ANTIGRAVITY_CLIENT_ID;
      delete process.env.PI_ANTIGRAVITY_CLIENT_SECRET;
      process.env.PI_ANTIGRAVITY_OAUTH_CONFIG = path.join(credentialsDir, "absent.json");
      assert.throws(
        () => buildAuthorizationUrl("verifier", "challenge"),
        /set PI_ANTIGRAVITY_CLIENT_ID and PI_ANTIGRAVITY_CLIENT_SECRET, or write \{"clientId": "\.\.\.", "clientSecret": "\.\.\."\} to .*absent\.json/,
        "a missing client fails with the environment and file options named",
      );

      fs.writeFileSync(credentialsFile, JSON.stringify({ clientId: "file-client-id", clientSecret: "file-client-secret" }), { mode: 0o600 });
      process.env.PI_ANTIGRAVITY_OAUTH_CONFIG = credentialsFile;
      assert.deepEqual(antigravityClient(), { clientId: "file-client-id", clientSecret: "file-client-secret" }, "the machine-local file supplies the client when the environment does not");
      assert.equal(new URL(buildAuthorizationUrl("verifier", "challenge")).searchParams.get("client_id"), "file-client-id");

      fs.writeFileSync(credentialsFile, "{not json");
      assert.throws(() => antigravityClient(), /is not valid JSON/, "a malformed credentials file is reported instead of ignored");
      fs.writeFileSync(credentialsFile, JSON.stringify({ clientId: "only-id" }));
      assert.throws(() => antigravityClient(), /needs Google client credentials/, "a partial credentials file is rejected");
      assert.equal(antigravityCredentialsFile(), credentialsFile, "the configured path wins over the agent directory");

      delete process.env.PI_ANTIGRAVITY_OAUTH_CONFIG;
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = credentialsDir;
      try {
        assert.equal(antigravityCredentialsFile(), credentialsFile, "the default location sits in the agent directory beside settings.json");
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    } finally {
      process.env.PI_ANTIGRAVITY_CLIENT_ID = savedId;
      process.env.PI_ANTIGRAVITY_CLIENT_SECRET = savedSecret;
      if (savedConfig === undefined) delete process.env.PI_ANTIGRAVITY_OAUTH_CONFIG;
      else process.env.PI_ANTIGRAVITY_OAUTH_CONFIG = savedConfig;
      fs.rmSync(credentialsDir, { recursive: true, force: true });
    }
  }

  // --- Manual authorization input -----------------------------------------
  assert.deepEqual(parseAuthorizationInput(""), {});
  assert.deepEqual(parseAuthorizationInput("http://localhost:51121/oauth-callback?code=abc&state=xyz"), {
    code: "abc",
    state: "xyz",
  });
  assert.deepEqual(parseAuthorizationInput("bare-code"), { code: "bare-code" });

  // --- Login through the browser callback, then token + project discovery --
  {
    const calls = [];
    const fetchMock = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
      }
      if (String(url).includes("userinfo")) return jsonResponse({ email: "user@example.test" });
      if (String(url).includes("loadCodeAssist")) return jsonResponse({ cloudaicompanionProject: { id: "proj-1" } });
      throw new Error(`unexpected url ${url}`);
    };

    let resolveCallback;
    const server = { waitForCode: () => new Promise((resolve) => { resolveCallback = resolve; }), close() {} };
    let authUrl;
    const flow = interaction({ onNotify: (event) => { if (event.type === "auth_url") authUrl = event.url; } });
    const provider = antigravityProvider({ fetch: fetchMock, startCallbackServer: async () => server });

    const pending = provider.auth.oauth.login(flow);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(authUrl, "auth url announced before waiting");
    resolveCallback({ code: "code-1", state: stateFromAuthUrl(authUrl) });
    const credential = await pending;

    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, "access-1");
    assert.equal(credential.refresh, "refresh-1");
    assert.equal(credential.projectId, "proj-1");
    assert.equal(credential.email, "user@example.test");
    assert.ok(credential.expires > Date.now(), "expiry in the future");

    const tokenCall = calls.find((call) => call.url.includes("oauth2.googleapis.com/token"));
    const body = new URLSearchParams(tokenCall.init.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "code-1");
    assert.equal(body.get("redirect_uri"), "http://localhost:51121/oauth-callback");
    assert.equal(body.get("client_id"), process.env.PI_ANTIGRAVITY_CLIENT_ID, "the token exchange uses the configured client id");
    assert.equal(body.get("client_secret"), process.env.PI_ANTIGRAVITY_CLIENT_SECRET, "the token exchange uses the configured client secret");
    assert.ok(body.get("code_verifier"));
    assert.equal(tokenCall.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  }

  // --- Login without a callback server falls back to the pasted URL --------
  {
    const fetchMock = async (url) => {
      if (String(url).includes("token")) {
        return jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 60 });
      }
      if (String(url).includes("userinfo")) return textResponse("no userinfo");
      if (String(url).includes("loadCodeAssist")) return textResponse("unavailable", 500);
      throw new Error(`unexpected url ${url}`);
    };
    let authUrl;
    let promptSeen;
    const flow = interaction({
      manualCode: undefined,
      onNotify: (event) => { if (event.type === "auth_url") authUrl = event.url; },
    });
    flow.prompt = async (prompt) => {
      promptSeen = prompt;
      return `http://localhost:51121/oauth-callback?code=code-2&state=${stateFromAuthUrl(authUrl)}`;
    };
    const provider = antigravityProvider({ fetch: fetchMock, startCallbackServer: async () => null });
    const credential = await provider.auth.oauth.login(flow);
    assert.equal(promptSeen.type, "manual_code");
    assert.equal(credential.access, "access-2");
    assert.equal(credential.projectId, DEFAULT_PROJECT_ID, "falls back to the IDE default project");
    assert.equal(credential.email, undefined, "userinfo failures stay optional");
  }

  // --- A mismatched state is rejected --------------------------------------
  {
    let authUrl;
    const flow = interaction({ onNotify: (event) => { if (event.type === "auth_url") authUrl = event.url; } });
    flow.prompt = async () => `http://localhost:51121/oauth-callback?code=code-3&state=wrong`;
    const provider = antigravityProvider({ fetch: async () => jsonResponse({}), startCallbackServer: async () => null });
    await assert.rejects(provider.auth.oauth.login(flow), /state mismatch/);
    assert.ok(authUrl);
  }

  // --- Refresh keeps the project and rotates the access token --------------
  {
    const calls = [];
    const fetchMock = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ access_token: "access-3", expires_in: 3600 });
    };
    const refreshed = await refreshAntigravityToken(
      { refresh: "refresh-3", access: "old", expires: 0, projectId: "proj-3" },
      fetchMock,
    );
    assert.equal(refreshed.access, "access-3");
    assert.equal(refreshed.refresh, "refresh-3", "keeps the refresh token when the server omits one");
    assert.equal(refreshed.projectId, "proj-3");
    const body = new URLSearchParams(calls[0].init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-3");
    await assert.rejects(
      refreshAntigravityToken({ refresh: "r", access: "a", expires: 0 }, fetchMock),
      /missing the Cloud Code Assist project id/,
    );

    // A credential that only ever saw the fallback project re-discovers the account's own.
    const rediscovery = [];
    const rediscoveringFetch = async (url) => {
      rediscovery.push(String(url));
      if (String(url).includes("loadCodeAssist")) return jsonResponse({ cloudaicompanionProject: "aicode-consumers" });
      return jsonResponse({ access_token: "access-4", expires_in: 3600 });
    };
    const rediscovered = await refreshAntigravityToken(
      { refresh: "refresh-4", access: "old", expires: 0, projectId: DEFAULT_PROJECT_ID },
      rediscoveringFetch,
    );
    assert.equal(rediscovered.projectId, "aicode-consumers", "the fallback project is replaced by the account's project");
    assert.equal(rediscovery.length, 2);
  }

  // --- Project discovery tries prod, then the sandbox endpoint -------------
  {
    const seen = [];
    const requests = [];
    const project = await discoverProject("token", async (url, init) => {
      seen.push(String(url));
      requests.push(init);
      if (String(url).includes("daily-cloudcode")) return jsonResponse({ cloudaicompanionProject: "proj-sandbox" });
      return textResponse("nope", 404);
    });
    assert.equal(project, "proj-sandbox");
    assert.deepEqual(seen, [
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
    ]);
    const metadata = JSON.parse(requests[0].headers["Client-Metadata"]);
    assert.deepEqual(metadata, { ideType: "ANTIGRAVITY", platform: "DARWIN_ARM64", pluginType: "CLOUD_CODE", ideName: "antigravity" }, "the IDE identity is what makes the endpoint report the account's project");
    assert.deepEqual(JSON.parse(requests[0].body), { metadata });
    assert.match(requests[0].headers["User-Agent"], /^antigravity\//u);

    // No endpoint reports a project: fall back to the shared default.
    const fallback = await discoverProject("token", async () => jsonResponse({ allowedTiers: [] }));
    assert.equal(fallback, DEFAULT_PROJECT_ID);
  }

  // --- Request envelope carries Antigravity's fingerprints -----------------
  const tool = {
    name: "read",
    description: "Read a file",
    parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { path: { const: "a" } } },
  };
  const systemContext = (text = "SYSTEM PROMPT") => ({
    messages: [
      { role: "system", content: text, toolsAdded: [tool], timestamp: 0 },
      { role: "user", content: "hello", timestamp: 1 },
    ],
  });
  const gemini = STATIC_ANTIGRAVITY_MODELS.find((entry) => entry.id === "gemini-3-flash");
  const claude = STATIC_ANTIGRAVITY_MODELS.find((entry) => entry.id === "claude-sonnet-4-6");
  {
    const request = buildRequest(gemini, systemContext(), "proj-1", {
      thinking: { enabled: true, level: "HIGH" },
      toolChoice: "auto",
    });
    assert.equal(request.project, "proj-1");
    assert.equal(request.model, "gemini-3-flash");
    assert.equal(request.requestType, "agent");
    assert.equal(request.userAgent, "antigravity");
    assert.match(request.requestId, /^agent-\d+-/u);
    assert.deepEqual(request.request.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
    assert.match(request.request.systemInstruction.parts[0].text, /^You are Antigravity/u);
    assert.match(request.request.systemInstruction.parts[1].text, /\[ignore\]You are Antigravity/u);
    assert.equal(request.request.systemInstruction.parts[2].text, "SYSTEM PROMPT");
    assert.deepEqual(request.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "HIGH" });
    const declaration = request.request.tools[0].functionDeclarations[0];
    assert.ok(declaration.parametersJsonSchema, "Gemini uses parametersJsonSchema");
    assert.deepEqual(declaration.parametersJsonSchema.properties.path, { enum: ["a"] }, "const rewritten as enum");
    assert.deepEqual(request.request.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  }
  {
    const request = buildRequest(claude, systemContext(), "proj-2", {});
    const declaration = request.request.tools[0].functionDeclarations[0];
    assert.ok(declaration.parameters, "Claude models use the legacy parameters field");
    assert.equal(declaration.parametersJsonSchema, undefined);
    assert.equal(declaration.parameters.$schema, undefined);
    assert.equal(request.request.generationConfig, undefined, "no thinking config without a reasoning request");
  }
  {
    const disabled = buildRequest(gemini, systemContext(), "proj-1", { thinking: { enabled: false } });
    assert.deepEqual(disabled.request.generationConfig.thinkingConfig, { thinkingLevel: "MINIMAL" });
    const budget = buildRequest(claude, systemContext(), "p", {
      thinking: { enabled: true, budgetTokens: 2048 },
    });
    assert.deepEqual(budget.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 2048 });
  }

  // --- Message conversion keeps signatures and merges tool responses -------
  {
    const sameModel = {
      messages: [
        { role: "system", content: "s", timestamp: 0 },
        {
          role: "assistant",
          provider: gemini.provider,
          api: gemini.api,
          model: gemini.id,
          content: [
            { type: "thinking", thinking: "plan", thinkingSignature: "c2lnbmF0dXJl" },
            { type: "text", text: "answer", textSignature: "c2lnbmF0dXJl" },
            { type: "toolCall", id: "call|1", name: "read", arguments: { path: "a" }, thoughtSignature: "c2lnbmF0dXJl" },
          ],
        },
        { role: "toolResult", toolCallId: "call|1", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", toolCallId: "call|2", toolName: "read", isError: true, content: [{ type: "text", text: "boom" }] },
      ],
    };
    const contents = convertMessages(gemini, sameModel);
    const modelTurn = contents[0];
    assert.equal(modelTurn.role, "model");
    assert.deepEqual(modelTurn.parts[0], { thought: true, text: "plan", thoughtSignature: "c2lnbmF0dXJl" });
    assert.deepEqual(modelTurn.parts[1], { text: "answer", thoughtSignature: "c2lnbmF0dXJl" });
    assert.equal(modelTurn.parts[2].functionCall.id, "call_1", "tool ids are normalized for Gemini 3");
    assert.equal(modelTurn.parts[2].thoughtSignature, "c2lnbmF0dXJl");
    assert.equal(contents.length, 2, "both tool results share one user turn");
    assert.deepEqual(contents[1].parts[0].functionResponse, { name: "read", response: { output: "ok" }, id: "call_1" });
    assert.deepEqual(contents[1].parts[1].functionResponse, { name: "read", response: { error: "boom" }, id: "call_2" });
  }
  {
    const crossModel = {
      messages: [
        { role: "system", content: "s", timestamp: 0 },
        {
          role: "assistant",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-opus-5-5",
          content: [
            { type: "thinking", thinking: "plan", thinkingSignature: "c2lnbmF0dXJl" },
            { type: "text", text: "answer", textSignature: "c2lnbmF0dXJl" },
          ],
        },
      ],
    };
    const parts = convertMessages(gemini, crossModel)[0].parts;
    assert.deepEqual(parts[0], { text: "plan" }, "foreign thinking loses its signature");
    assert.deepEqual(parts[1], { text: "answer" }, "foreign text loses its signature");
  }
  {
    const imageResult = {
      messages: [
        { role: "system", content: "s", timestamp: 0 },
        { role: "toolResult", toolCallId: "c", toolName: "shot", isError: false, content: [
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ] },
      ],
    };
    const geminiContents = convertMessages(gemini, imageResult);
    assert.equal(geminiContents.length, 1, "Gemini 3 nests images in the function response");
    assert.equal(geminiContents[0].parts[0].functionResponse.parts[0].inlineData.data, "AAAA");
    const claudeContents = convertMessages(claude, imageResult);
    assert.equal(claudeContents.length, 1, "Claude also accepts images nested in the function response");
    assert.equal(claudeContents[0].parts[0].functionResponse.parts[0].inlineData.data, "AAAA");
  }


  // --- SSE transport: envelope, headers, block events and usage ------------
  {
    const seen = [];
    const fetchMock = async (url, init) => {
      seen.push({ url: String(url), init });
      return sseResponse([
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "Th", thought: true, thoughtSignature: "c2lnbmF0dXJl" }] } }] } },
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "inking", thought: true }] } }] } },
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] } },
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo", thoughtSignature: "c2lnbmF0dXJl" }] } }] } },
        {
          response: {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ functionCall: { name: "read", args: { path: "a" }, id: "call-1" }, thoughtSignature: "c2lnbmF0dXJl" }],
                },
              },
            ],
          },
        },
        {
          response: {
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 100,
              cachedContentTokenCount: 40,
              candidatesTokenCount: 10,
              thoughtsTokenCount: 5,
              totalTokenCount: 115,
            },
            responseId: "resp-1",
          },
        },
      ]);
    };

    const events = [];
    const stream = streamAntigravity(gemini, systemContext(), { apiKey: JSON.stringify({ token: "access-x", projectId: "proj-x" }) }, fetchMock);
    for await (const event of stream) events.push(event);

    assert.deepEqual(seen.map((call) => call.url), [
      `${ANTIGRAVITY_ENDPOINTS[0]}/v1internal:streamGenerateContent?alt=sse`,
    ]);
    const headers = seen[0].init.headers;
    assert.equal(headers.Authorization, "Bearer access-x");
    assert.equal(headers.Accept, "text/event-stream");
    assert.match(headers["User-Agent"], /^antigravity\/1\.107\.0 darwin\/arm64$/u);
    assert.equal(headers["anthropic-beta"], undefined, "Gemini requests carry no Claude beta header");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.project, "proj-x");
    assert.equal(body.model, "gemini-3-flash");
    assert.equal(body.requestType, "agent");
    assert.equal(body.request.contents[0].parts[0].text, "hello");

    const types = events.map((event) => event.type);
    assert.equal(types[0], "start");
    assert.equal(types.at(-1), "done");
    for (const type of ["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end"]) {
      assert.ok(types.includes(type), `stream emits ${type}`);
    }
    const done = events.at(-1);
    assert.equal(done.reason, "toolUse", "a tool call wins over the STOP finish reason");
    const message = done.message;
    assert.equal(message.api, "google-generative-ai");
    assert.equal(message.provider, "google-antigravity");
    assert.equal(message.responseId, "resp-1");
    assert.deepEqual(message.content[0], { type: "thinking", thinking: "Thinking", thinkingSignature: "c2lnbmF0dXJl" });
    assert.deepEqual(message.content[1], { type: "text", text: "Hello", textSignature: "c2lnbmF0dXJl" });
    assert.deepEqual(message.content[2], {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "a" },
      thoughtSignature: "c2lnbmF0dXJl",
    });
    assert.deepEqual(
      { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, totalTokens: message.usage.totalTokens },
      { input: 60, output: 15, cacheRead: 40, totalTokens: 115 },
      "cached prompt tokens are subtracted from input",
    );
    assert.ok(message.usage.cost.total > 0, "cost is calculated from the catalog");
  }

  // --- 403/404 cascade through the sandbox and prod endpoints -------------
  {
    const urls = [];
    const fetchMock = async (url) => {
      urls.push(String(url));
      if (urls.length === 1) return textResponse("forbidden", 403);
      if (urls.length === 2) return textResponse("not found", 404);
      return sseResponse([{ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
    };
    const events = [];
    const stream = streamAntigravity(gemini, systemContext(), { apiKey: JSON.stringify({ token: "t", projectId: "p" }) }, fetchMock);
    for await (const event of stream) events.push(event);
    assert.equal(urls.length, 3);
    assert.match(urls[0], /^https:\/\/daily-cloudcode-pa/u);
    assert.match(urls[1], /^https:\/\/autopush-cloudcode-pa/u);
    assert.match(urls[2], /^https:\/\/cloudcode-pa\.googleapis\.com/u);
    assert.equal(events.at(-1).message.content[0].text, "ok");
  }

  // --- Terminal errors are reported on the stream --------------------------
  {
    const fetchMock = async () => jsonResponse({ error: { message: "invalid argument" } }, 400);
    const events = [];
    const stream = streamAntigravity(gemini, systemContext(), { apiKey: JSON.stringify({ token: "t", projectId: "p" }) }, fetchMock);
    for await (const event of stream) events.push(event);
    const error = events.at(-1);
    assert.equal(error.type, "error");
    assert.equal(error.error.stopReason, "error");
    assert.equal(error.error.errorMessage, "Cloud Code Assist API error (400): invalid argument");
  }

  // --- Missing credentials fail before any request -------------------------
  {
    const stream = streamAntigravity(gemini, systemContext(), {}, async () => {
      throw new Error("must not fetch");
    });
    const events = [];
    for await (const event of stream) events.push(event);
    assert.match(events.at(-1).error.errorMessage, /requires OAuth authentication/u);
  }

  // --- Simple options map onto Antigravity's thinking controls -------------
  {
    const bodies = [];
    const fetchMock = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([{ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
    };
    const options = { apiKey: JSON.stringify({ token: "t", projectId: "p" }) };
    for await (const _ of streamSimpleAntigravity(gemini, systemContext(), { ...options, reasoning: "high" }, fetchMock)) { /* drain */ }
    assert.deepEqual(bodies[0].request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "HIGH" });
    assert.deepEqual(bodies[0].request.generationConfig.maxOutputTokens, gemini.maxTokens);

    bodies.length = 0;
    for await (const _ of streamSimpleAntigravity(gemini, systemContext(), { ...options }, fetchMock)) { /* drain */ }
    assert.deepEqual(bodies[0].request.generationConfig.thinkingConfig, { thinkingLevel: "MINIMAL" });

    bodies.length = 0;
    for await (const _ of streamSimpleAntigravity(claude, systemContext(), { ...options, reasoning: "high" }, fetchMock)) { /* drain */ }
    assert.deepEqual(bodies[0].request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 16384 });
    assert.equal(bodies[0].request.generationConfig.maxOutputTokens, claude.maxTokens);
  }

  // --- Claude requests carry the interleaved-thinking beta header ---------
  {
    const headers = [];
    const fetchMock = async (url, init) => {
      headers.push(init.headers);
      return sseResponse([{ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
    };
    const stream = streamSimpleAntigravity(claude, systemContext(), {
      apiKey: JSON.stringify({ token: "t", projectId: "p" }),
      reasoning: "high",
    }, fetchMock);
    for await (const _ of stream) { /* drain */ }
    assert.equal(headers[0]["anthropic-beta"], "interleaved-thinking-2025-05-14");
  }

  // --- Multi-login registers ACP by default; Cloud Code stays opt-in ------
  {
    const agentDir = tmpFixture("antigravity-agent-");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configFile = path.join(agentDir, "multi-login.json");
    const multiLoginModule = await jiti.import(path.resolve("extensions/multi-login/index.ts"));
    const loadExtension = () => {
      const instance = { providers: [], commands: [], handlers: new Map() };
      (multiLoginModule.default || multiLoginModule)({
        registerProvider: (provider) => instance.providers.push(provider),
        registerVirtualModel: () => {},
        registerCommand: (name) => instance.commands.push(name),
        setModel: async () => true,
        on: (event, handler) => instance.handlers.set(event, handler),
      });
      return instance;
    };

    try {
      fs.writeFileSync(configFile, JSON.stringify({
        accounts: { anthropic: 1 },
        priority: ["anthropic/claude-opus-5-5"],
      }));
      const withoutAntigravity = loadExtension();
      assert.deepEqual(
        withoutAntigravity.providers.map((provider) => provider.id),
        ["anthropic", ACP_PROVIDER_ID],
        "ACP is registered by default; Cloud Code remains opt-in",
      );
      const acp = withoutAntigravity.providers.find((provider) => provider.id === ACP_PROVIDER_ID);
      assert(acp);
      assert.equal(acp.auth.oauth.name, "Google Antigravity ACP (Google account)");
      assert(acp.getModels().some((model) => model.id === "gemini-4-neon"));

      fs.writeFileSync(configFile, JSON.stringify({
        accounts: { "google-antigravity": 2 },
        priority: ["google-antigravity/gemini-3-flash", "anthropic/claude-opus-5-5"],
      }));
      const withAntigravity = loadExtension();
      assert.deepEqual(withAntigravity.providers.map((provider) => provider.id), ["anthropic", ANTIGRAVITY_PROVIDER_ID, ACP_PROVIDER_ID, `${ANTIGRAVITY_PROVIDER_ID}-account-2`]);
      const base = withAntigravity.providers.find((provider) => provider.id === ANTIGRAVITY_PROVIDER_ID);
      const alias = withAntigravity.providers.find((provider) => provider.id === `${ANTIGRAVITY_PROVIDER_ID}-account-2`);
      assert.equal(base.auth.oauth.name, "Google Antigravity (Google account)");
      assert.equal(base.auth.oauth.isSubscription, true);
      for (const operation of ["login", "refresh", "toAuth"]) assert.equal(typeof alias.auth.oauth[operation], "function");
      assert.equal(alias.auth.apiKey, undefined, "aliases store only their own OAuth credential");
      assert.ok(alias.getModels().every((entry) => entry.provider === alias.id));
      assert.equal(alias.getModels().length, STATIC_ANTIGRAVITY_MODELS.length, "no discovery ran, so the static snapshot is served");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }

  // --- Dynamic catalog from the account's provisioned models ---------------
  {
    resetAntigravityModelCache();
    assert.equal(currentAntigravityModels().length, STATIC_ANTIGRAVITY_MODELS.length, "the static snapshot is the pre-discovery catalog");

    const quota = {
      buckets: [
        { modelId: "gemini-4-neon", remainingFraction: 0.99 },
        { modelId: "gemini-4-neon", remainingFraction: 0.5 },
        { modelId: "claude-opus-5-5-high" },
        { modelId: "tab_flash_lite_preview" },
        { modelId: "chat_20706" },
        { modelId: "  " },
        { remainingFraction: 1 },
      ],
    };
    assert.deepEqual(parseProvisionedModelIds(quota), ["gemini-4-neon", "claude-opus-5-5-high"], "deduped, tab/chat models and blanks dropped");
    assert.deepEqual(parseProvisionedModelIds({}), []);
    assert.deepEqual(parseProvisionedModelIds(null), []);
    assert.deepEqual(parseProvisionedModelIds({ buckets: "nope" }), []);

    const neon = modelForId("gemini-4-neon");
    assert.equal(neon.name, "Gemini 4 Neon (Antigravity)");
    assert.equal(neon.reasoning, true);
    assert.deepEqual(neon.input, ["text", "image"]);
    assert.equal(neon.contextWindow, 1048576);
    const opus = modelForId("claude-opus-5-5-high");
    assert.equal(opus.name, "Claude Opus 5.5 High (Antigravity)");
    assert.equal(opus.contextWindow, 200000);
    assert.deepEqual(opus.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    const lite = modelForId("gemini-3.5-flash-lite");
    assert.equal(lite.name, "Gemini 3.5 Flash Lite (Antigravity)");
    assert.deepEqual(lite.cost, { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 });
    const gpt = modelForId("gpt-oss-120b-medium");
    assert.equal(gpt.reasoning, false);
    assert.deepEqual(gpt.input, ["text"]);
    assert.equal(modelForId("claude-sonnet-4-6").name, "Claude Sonnet 4.6 (Antigravity)", "static entries win over inference");

    // Live fetch: quota ids are the entitlement; the catalog supplies names and limits.
    const calls = [];
    const liveFetch = async (url, init) => {
      const target = String(url);
      calls.push({ url: target, method: init.method, userAgent: init.headers["User-Agent"], body: init.body });
      if (target.includes("fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-4-neon": { displayName: "Gemini 4 Neon (XHigh)", supportsImages: true, supportsThinking: true, maxTokens: 2097152, maxOutputTokens: 65536 },
            "claude-sonnet-5-5-high": { displayName: "Claude Sonnet 5.5 (High)", supportsImages: true, supportsThinking: true, maxTokens: 1000000, maxOutputTokens: 128000 },
            tab_jump_flash_lite_preview: { maxTokens: 16384, maxOutputTokens: 4096 },
            chat_20706: { maxTokens: 16384 },
          },
        });
      }
      return jsonResponse({ buckets: [{ modelId: "gemini-4-neon" }, { modelId: "claude-sonnet-5-5-high" }, { modelId: "tab_jump_flash_lite_preview" }, { modelId: "chat_20706" }] });
    };
    const discovered = await discoverAntigravityModels({ accessToken: "token-1", projectId: "proj-1", fetchImpl: liveFetch, force: true });
    assert.deepEqual(discovered.map((entry) => entry.id), ["gemini-4-neon", "claude-sonnet-5-5-high"], "tab and chat models excluded");
    assert.equal(discovered[0].name, "Gemini 4 Neon (XHigh) (Antigravity)", "the endpoint's own display name wins");
    assert.equal(discovered[0].contextWindow, 2097152);
    assert.equal(discovered[0].maxTokens, 65536);
    assert.equal(discovered[1].contextWindow, 1000000);
    assert.equal(discovered[1].cost.input, 3, "cost still comes from the model family");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `${ANTIGRAVITY_ENDPOINTS[0]}/v1internal:retrieveUserQuota`);
    assert.equal(calls[1].url, `${ANTIGRAVITY_ENDPOINTS[0]}/v1internal:fetchAvailableModels`);
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].userAgent, /^antigravity\//u);
    assert.deepEqual(JSON.parse(calls[0].body), { project: "proj-1" });
    assert.deepEqual(JSON.parse(calls[1].body), { project: "proj-1" });
    assert.equal(currentAntigravityModels().length, 2, "the discovered list becomes the synchronous catalog");
    assert.deepEqual(currentAntigravityModels().map((entry) => entry.id), ["gemini-4-neon", "claude-sonnet-5-5-high"]);

    // Cache: a second call within the TTL does not touch the network.
    const cached = await discoverAntigravityModels({ accessToken: "token-1", projectId: "proj-1", fetchImpl: async () => { throw new Error("network used"); } });
    assert.equal(cached.length, 2);

    // Endpoint cascade: a failing endpoint falls through to the next one.
    const cascadeUrls = [];
    const cascadeFetch = async (url) => {
      cascadeUrls.push(String(url));
      if (cascadeUrls.length === 1) return textResponse("blocked", 403);
      if (String(url).includes("fetchAvailableModels")) return jsonResponse({ models: { "gemini-3-flash": { displayName: "Gemini 3 Flash" } } });
      return jsonResponse({ buckets: [{ modelId: "gemini-3-flash" }] });
    };
    const cascaded = await discoverAntigravityModels({ accessToken: "token-1", projectId: "proj-2", fetchImpl: cascadeFetch, force: true });
    assert.deepEqual(cascaded.map((entry) => entry.id), ["gemini-3-flash"]);
    assert.equal(cascadeUrls.length, 3);
    assert.equal(cascadeUrls[1], `${ANTIGRAVITY_ENDPOINTS[1]}/v1internal:retrieveUserQuota`);
    assert.equal(cascadeUrls[2], `${ANTIGRAVITY_ENDPOINTS[1]}/v1internal:fetchAvailableModels`);

    // Without a catalog the quota ids still form a catalog, with inferred metadata.
    const quotaOnly = await discoverAntigravityModels({
      accessToken: "token-1",
      projectId: "proj-6",
      fetchImpl: async (url) => (String(url).includes("fetchAvailableModels") ? textResponse("forbidden", 403) : jsonResponse({ buckets: [{ modelId: "gemini-4-carbon" }, { modelId: "chat_23310" }] })),
      force: true,
    });
    assert.deepEqual(quotaOnly.map((entry) => entry.id), ["gemini-4-carbon"]);
    assert.equal(quotaOnly[0].name, "Gemini 4 Carbon (Antigravity)");

    // An unnamed catalog entry (tiered alias) keeps inferred metadata.
    const unnamed = await discoverAntigravityModels({
      accessToken: "token-1",
      projectId: "proj-7",
      fetchImpl: async (url) => (String(url).includes("fetchAvailableModels") ? jsonResponse({ models: { "gemini-3.8-flash-tiered": { supportsThinking: true, maxTokens: 1048576 } } }) : jsonResponse({ buckets: [{ modelId: "gemini-3.8-flash-tiered" }] })),
      force: true,
    });
    assert.deepEqual(unnamed.map((entry) => entry.id), ["gemini-3.8-flash-tiered"]);
    assert.equal(unnamed[0].name, "Gemini 3.8 Flash Tiered (Antigravity)", "an unnamed model keeps its inferred name");
    assert.equal(unnamed[0].contextWindow, 1048576);

    // Failure keeps the previous catalog and reports nothing new.
    const before = currentAntigravityModels();
    const failed = await discoverAntigravityModels({
      accessToken: "token-1",
      projectId: "proj-3",
      fetchImpl: async () => textResponse("denied", 403),
      force: true,
    });
    assert.equal(failed, undefined);
    assert.equal(currentAntigravityModels(), before, "previous catalog retained on failure");

    const empty = await discoverAntigravityModels({
      accessToken: "token-1",
      projectId: "proj-4",
      fetchImpl: async () => jsonResponse({ buckets: [] }),
      force: true,
    });
    assert.equal(empty, undefined, "an empty quota response is not a catalog");

    // Abort is honored.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      discoverAntigravityModels({ accessToken: "token-1", projectId: "proj-5", fetchImpl: async () => jsonResponse({}), force: true, signal: controller.signal }),
      /abort/iu,
    );

    resetAntigravityModelCache();
    assert.equal(currentAntigravityModels().length, STATIC_ANTIGRAVITY_MODELS.length);
  }

  // --- Cloud Code Assist exhaustion and invalid keys trigger failover ------
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: "You have exhausted your capacity on this model. Your quota will reset after 2h." }), true);
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: "API key not valid. Please pass a valid API key." }), true);
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: "API_KEY_INVALID" }), true);
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: "429 Too Many Requests" }), false, "generic throttling stays on the account");
  assert.equal(isAccountFailure({ stopReason: "error", errorMessage: "503 service unavailable" }), false);

  console.log("google-antigravity tests passed (credentials resolution, auth URL, callback/manual login, refresh, project discovery, envelope, conversion, SSE transport, endpoint cascade, dynamic catalog discovery and caching, multi-login wiring, failover classification)");
})();
