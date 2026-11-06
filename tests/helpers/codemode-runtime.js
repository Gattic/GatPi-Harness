"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { tmpFixture } = require("./tmp-fixture");

async function installedRuntime() {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const root = fs.realpathSync(path.join(globalRoot, "@earendil-works/pi-coding-agent"));
  const sdk = await import(pathToFileURL(require.resolve(root)).href);
  const aiRoot = fs.realpathSync(path.join(root, "..", "ai"));
  const ai = await import(pathToFileURL(path.join(aiRoot, "dist/compat.js")).href);
  return { sdk, ai, root };
}

async function createRuntime(options = {}) {
  const { sdk, ai, root } = await installedRuntime();
  const directory = tmpFixture("pi-codemode-acceptance-");
  const cwd = options.cwd || path.join(directory, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(directory, "agent");
  fs.mkdirSync(agentDir, { mode: 0o700 });
  const faux = options.inference ? null : ai.registerFauxProvider();
  const model = options.inference?.model || faux.getModel();
  const modelRuntime = options.inference?.modelRuntime || await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  if (faux) modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "synthetic-codemode-test", api: faux.api, models: faux.models });
  const repo = path.resolve(__dirname, "../..");
  const files = options.extensions || ["extensions/codemode/index.ts", ".pi/extensions/code-context/index.ts", ".pi/extensions/docs-lookup/index.ts", ".pi/extensions/test-runner/index.ts", ".pi/extensions/policy-enforcer/index.ts", ".pi/extensions/output-compactor/index.ts", "extensions/tool-surface-router/index.ts"];
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: files.map(file => path.join(repo, file)), extensionFactories: options.extensionFactories || [] });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  const { session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime, thinkingLevel: options.inference?.thinkingLevel || "off", resourceLoader, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...options.settings }), sessionManager: options.sessionManager || sdk.SessionManager.inMemory(cwd), ...(options.tools ? { tools: options.tools } : {}), ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}), ...(options.noTools ? { noTools: "all" } : {}) });
  const events = [];
  session.subscribe(event => events.push(event));
  await session.bindExtensions({});
  return {
    sdk, ai, root, cwd, directory, session, events, faux,
    async script(code, prompt = "Execute the requested synthetic acceptance script.") {
      faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
      await session.prompt(prompt);
      return session.messages.findLast(message => message.role === "toolResult" && message.toolName === "codemode");
    },
    async close() { session.dispose(); faux?.unregister(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

module.exports = { installedRuntime, createRuntime };
