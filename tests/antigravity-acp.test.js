"use strict";

// Antigravity ACP runtime, credential and provider tests. Every download,
// process and network call is mocked; the real 1.5.2 archive is never fetched
// and the real ACP server is never installed or started.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execSync } = require("node:child_process");

let piPackageRoot;
try {
  const candidate = path.join(
    execSync("npm root -g", { encoding: "utf8" }).trim(),
    "@earendil-works",
    "pi-coding-agent",
  );
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("antigravity-acp tests passed; extension behavior skipped (global pi install not found)");
  process.exit(0);
}

const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
const createJiti = jitiModule.createJiti || jitiModule;
const aiRoot = fs.existsSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  ? fs.realpathSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  : fs.realpathSync(path.resolve(piPackageRoot, "..", "ai"));
const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "extensions", "multi-login", "antigravity-acp");
const jiti = createJiti(path.join(EXT, "manifest.ts"), {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": piPackageRoot,
    "@earendil-works/pi-ai": aiRoot,
  },
});
const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a minimal ZIP with stored or deflated entries. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method === 8 ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += 30 + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function responseFrom(buffer) {
  return new Response(buffer, { status: 200, headers: { "content-type": "application/zip" } });
}

async function main() {
  try {
    const manifestModule = await jiti.import(path.join(EXT, "manifest.ts"));
    const manifest = manifestModule.loadManifest();
    assert.equal(manifest.version, "1.5.2");
    assert.equal(manifestModule.platformKey("linux", "x64"), "linux-x86_64");
    assert.equal(manifestModule.platformKey("darwin", "arm64"), "darwin-aarch64");
    assert.throws(() => manifestModule.platformKey("linux", "ia32"), /no runtime/u);
    const release = manifestModule.selectRelease(manifest, "linux-x86_64");
    assert.match(release.archive, /agy-acp-server-1\.5\.2-linux-x86_64\.zip$/u);
    assert.equal(
      release.archiveSha256,
      "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852",
    );
    assert.equal(release.archiveBytes, 273964075);
    assert.equal(release.binaryName, "agy_acp_server.par");
    assert.equal(release.harnessName, "localharness_external");
    assert.deepEqual(release.args, ["--uid="]);
    assert.throws(
      () => manifestModule.validateManifest({ ...manifest, version: "1.4.1" }),
      /must pin 1\.5\.2/u,
    );
    assert.throws(
      () =>
        manifestModule.validateManifest({
          ...manifest,
          platforms: { ...manifest.platforms, "linux-x86_64": { ...release, archiveSha256: "bad" } },
        }),
      /invalid SHA-256/u,
    );
    assert.throws(
      () =>
        manifestModule.validateManifest({
          ...manifest,
          platforms: { ...manifest.platforms, "linux-x86_64": { ...release, binaryName: ".." } },
        }),
      /unsafe file name/u,
    );

    const zipModule = await jiti.import(path.join(EXT, "zip.ts"));
    const fixtureZip = makeZip([
      { name: "agy_acp_server.par", data: Buffer.from("server-binary") },
      { name: "localharness_external", data: Buffer.from("harness-binary"), method: 8 },
    ]);
    const zipPath = path.join(tempDir("pi-acp-zip-"), "fixture.zip");
    fs.writeFileSync(zipPath, fixtureZip);
    const entries = zipModule.readZipDirectory(zipPath);
    assert.deepEqual(entries.map((entry) => entry.name), [
      "agy_acp_server.par",
      "localharness_external",
    ]);
    const extracted = path.join(tempDir("pi-acp-extract-"), "out");
    await zipModule.extractZipFile(zipPath, extracted, [
      "agy_acp_server.par",
      "localharness_external",
    ]);
    assert.equal(fs.readFileSync(path.join(extracted, "agy_acp_server.par"), "utf8"), "server-binary");
    assert.equal(
      fs.readFileSync(path.join(extracted, "localharness_external"), "utf8"),
      "harness-binary",
    );
    assert.equal(
      fs.statSync(path.join(extracted, "agy_acp_server.par")).mode & 0o111,
      0o111,
    );
    await assert.rejects(
      zipModule.extractZipFile(zipPath, path.join(tempDir("pi-acp-missing-"), "out"), ["missing"]),
      /unexpected|missing|entries/u,
    );
    const extraZip = path.join(tempDir("pi-acp-extra-"), "extra.zip");
    fs.writeFileSync(
      extraZip,
      makeZip([
        { name: "agy_acp_server.par", data: Buffer.from("server-binary") },
        { name: "localharness_external", data: Buffer.from("harness-binary"), method: 8 },
        { name: "extra-payload", data: Buffer.from("extra") },
      ]),
    );
    await assert.rejects(
      zipModule.extractZipFile(extraZip, path.join(tempDir("pi-acp-extra-out-"), "out"), [
        "agy_acp_server.par",
        "localharness_external",
      ]),
      /unexpected|entries/u,
    );
    const traversalZip = path.join(tempDir("pi-acp-traversal-"), "traversal.zip");
    fs.writeFileSync(traversalZip, makeZip([{ name: "../evil", data: Buffer.from("evil") }]));
    await assert.rejects(
      zipModule.extractZipFile(traversalZip, path.join(tempDir("pi-acp-traversal-out-"), "out")),
      /Path traversal/u,
    );

    const installModule = await jiti.import(path.join(EXT, "install.ts"));
    const entry = {
      archive: "https://dl.google.com/agy-extensions/releases/linux/test.zip",
      archiveSha256: crypto.createHash("sha256").update(fixtureZip).digest("hex"),
      archiveBytes: fixtureZip.length,
      binaryName: "agy_acp_server.par",
      binaryBytes: Buffer.byteLength("server-binary"),
      harnessName: "localharness_external",
      harnessBytes: Buffer.byteLength("harness-binary"),
      args: ["--uid="],
    };
    const installRoot = tempDir("pi-acp-install-");
    const installed = await installModule.installRuntime(entry, "1.5.2", {
      root: installRoot,
      platform: "linux-x86_64",
      fetch: async () => responseFrom(fixtureZip),
    });
    assert.equal(fs.readFileSync(installed.command, "utf8"), "server-binary");
    assert.equal(fs.readFileSync(installed.harness, "utf8"), "harness-binary");
    const record = JSON.parse(
      fs.readFileSync(path.join(installRoot, "versions", entry.archiveSha256, "install.json"), "utf8"),
    );
    assert.equal(record.version, "1.5.2");
    assert.equal(record.platform, "linux-x86_64");
    assert.equal(record.archiveSha256, entry.archiveSha256);
    assert.deepEqual(record.args, ["--uid="]);
    assert.equal(
      fs.readlinkSync(path.join(installRoot, "current")),
      path.join("versions", entry.archiveSha256),
    );
    assert.equal(
      fs.realpathSync(installModule.installedRuntime(installRoot).command),
      fs.realpathSync(installed.command),
    );
    if (process.platform !== "win32") {
      fs.chmodSync(installed.command, 0o644);
      assert.equal(installModule.installedRuntime(installRoot), undefined);
      fs.chmodSync(installed.command, 0o755);
    }
    const customManifest = {
      schemaVersion: 1,
      version: "1.5.2",
      generatedAt: "test",
      platforms: { "linux-x86_64": entry },
    };
    const ensuredRoot = tempDir("pi-acp-ensure-");
    const ensured = await installModule.ensureRuntime(customManifest, "linux-x86_64", {
      root: ensuredRoot,
      fetch: async () => responseFrom(fixtureZip),
    });
    assert.equal(fs.readFileSync(ensured.command, "utf8"), "server-binary");
    const ensuredRecordPath = path.join(
      ensuredRoot,
      "versions",
      entry.archiveSha256,
      "install.json",
    );
    const tamperedRecord = JSON.parse(fs.readFileSync(ensuredRecordPath, "utf8"));
    tamperedRecord.archiveSha256 = "0".repeat(64);
    fs.writeFileSync(ensuredRecordPath, `${JSON.stringify(tamperedRecord, null, 2)}\n`);
    let refetched = 0;
    const reinstalled = await installModule.ensureRuntime(customManifest, "linux-x86_64", {
      root: ensuredRoot,
      fetch: async () => {
        refetched++;
        return responseFrom(fixtureZip);
      },
    });
    assert.equal(refetched, 1);
    assert.equal(reinstalled.record.archiveSha256, entry.archiveSha256);
    await assert.rejects(
      installModule.installRuntime(entry, "1.5.2", {
        root: tempDir("pi-acp-bad-"),
        fetch: async () => responseFrom(Buffer.from("not a zip")),
      }),
      /SHA-256|bytes/u,
    );
    const oversizedPath = path.join(tempDir("pi-acp-oversized-"), "oversized.zip");
    await assert.rejects(
      installModule.downloadArchive(
        "https://dl.google.com/agy-extensions/releases/linux/test.zip",
        oversizedPath,
        4,
        "0".repeat(64),
        async () => responseFrom(Buffer.from("0123456789")),
      ),
      /exceeds|bytes/u,
    );
    assert.equal(fs.existsSync(oversizedPath), false);

    const runtimeModule = await jiti.import(path.join(EXT, "runtime.ts"));
    assert.deepEqual(runtimeModule.platformArgs("linux"), ["--uid="]);
    assert.deepEqual(runtimeModule.platformArgs("darwin"), []);
    const envRoot = tempDir("pi-acp-runtime-");
    const script = path.join(envRoot, "agy_acp_server.par");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(script, 0o755);
    const scriptLaunch = await runtimeModule.resolveRuntime({
      env: { ...process.env, AGY_ACP_BIN: script, HOME: envRoot },
      autoInstall: false,
    });
    assert.equal(scriptLaunch.source, "env");
    assert.deepEqual(scriptLaunch.args, []);
    const native = path.join(envRoot, "native-agy");
    fs.writeFileSync(native, "not a script");
    fs.chmodSync(native, 0o755);
    const nativeLaunch = await runtimeModule.resolveRuntime({
      env: { ...process.env, AGY_ACP_BIN: native, HOME: envRoot },
      autoInstall: false,
    });
    assert.deepEqual(
      nativeLaunch.args,
      process.platform === "linux" ? ["--uid="] : [],
    );
    const managedLaunch = await runtimeModule.resolveRuntime({
      env: { ...process.env, HOME: envRoot },
      root: installRoot,
      platform: "linux-x86_64",
      manifest: customManifest,
      autoInstall: false,
    });
    assert.equal(managedLaunch.source, "managed");
    assert.equal(fs.realpathSync(managedLaunch.command), fs.realpathSync(installed.command));
    assert.deepEqual(managedLaunch.args, ["--uid="]);
    await assert.rejects(
      runtimeModule.resolveRuntime({
        env: { ...process.env, HOME: envRoot, PATH: "" },
        autoInstall: false,
      }),
      /not installed/u,
    );

    const authModule = await jiti.import(path.join(EXT, "auth.ts"));
    const authHome = tempDir("pi-acp-auth-");
    const authEnv = { ...process.env, HOME: authHome, GEMINI_HOME: "" };
    const authDir = authModule.resolveAcpDirectory(authEnv);
    assert.equal(authDir, path.join(authHome, ".gemini", "antigravity-acp"));
    assert.equal(authModule.inspectAuth(authEnv).status, "missing");
    const ensureEnv = {
      ...process.env,
      HOME: tempDir("pi-acp-auth-ensure-"),
      GEMINI_HOME: "",
    };
    const ensureDir = authModule.resolveAcpDirectory(ensureEnv);
    authModule.ensureDefaultAuth(ensureEnv);
    const ensureSettingsPath = path.join(ensureDir, "settings.json");
    assert.equal(
      JSON.parse(fs.readFileSync(ensureSettingsPath, "utf8")).auth.type,
      "oauth-personal",
    );
    assert.equal(fs.statSync(ensureSettingsPath).mode & 0o777, 0o600);
    fs.writeFileSync(
      ensureSettingsPath,
      JSON.stringify({ auth: { type: "oauth-personal" }, keep: true }),
    );
    authModule.ensureDefaultAuth(ensureEnv);
    assert.equal(JSON.parse(fs.readFileSync(ensureSettingsPath, "utf8")).keep, true);
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
    assert.equal(authModule.inspectAuth(authEnv).status, "configured-not-authenticated");
    fs.writeFileSync(
      path.join(authDir, "acp_token.json"),
      JSON.stringify({ refresh_token: "fixture-refresh-token" }),
    );
    const health = authModule.inspectAuth(authEnv);
    assert.equal(health.status, "oauth-refreshable");
    assert.equal(health.authType, "oauth-personal");
    assert.equal(authModule.hasAuth(authEnv), true);
    assert.equal(JSON.stringify(health).includes("fixture-refresh-token"), false);
    fs.writeFileSync(path.join(authDir, "acp_token.json"), "{bad json");
    assert.equal(authModule.inspectAuth(authEnv).status, "corrupt");
    const geminiHome = path.join(authHome, "custom-gemini");
    assert.equal(
      authModule.resolveAcpDirectory({ ...authEnv, GEMINI_HOME: geminiHome }),
      path.join(geminiHome, "antigravity-acp"),
    );
    authModule.clearAuth(authEnv);
    assert.equal(fs.existsSync(path.join(authDir, "acp_token.json")), false);
    assert.equal(authModule.inspectAuth(authEnv).status, "missing");

    const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
    const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");
    const carbon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-carbon");
    assert(neon);
    assert(carbon);
    assert.equal(neon.reasoning, true);
    assert.equal(neon.thinkingLevelMap.high, "gemini-4-neon-high");
    assert.equal(carbon.thinkingLevelMap.high, "gemini-4-carbon-high");
    assert.deepEqual(modelsModule.splitEffortSuffix("gemini-4-neon-high"), {
      base: "gemini-4-neon",
      effort: "high",
    });
    assert.equal(modelsModule.splitEffortSuffix("gemini-4-neon"), undefined);
    const projected = modelsModule.projectModels([
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    ]);
    const projectedNeon = projected.find((model) => model.id === "gemini-4-neon");
    assert(projectedNeon);
    assert.equal(projectedNeon.thinkingLevelMap.high, "gemini-4-neon-high");
    assert.equal(projectedNeon.name, "Gemini 4 Neon");
    const projectedCarbon = projected.find((model) => model.id === "gemini-4-carbon");
    assert(projectedCarbon);
    assert.equal(projectedCarbon.reasoning, false);
    assert.equal(modelsModule.acpModelId(neon, "high"), "gemini-4-neon-high");
    assert.equal(modelsModule.acpModelId(carbon, "medium"), "gemini-4-carbon-medium");
    assert.equal(modelsModule.thinkingLevel({ thinking: { level: "low" } }), "low");
    assert.equal(modelsModule.thinkingLevel({}), "medium");
    const restored = modelsModule.restoreModels(projected);
    assert.equal(restored.length, projected.length);
    assert.equal(restored.find((model) => model.id === "gemini-4-neon").thinkingLevelMap.medium, "gemini-4-neon-medium");

    await acpTests();
    await loginTests();
    await providerTests();
    await streamAuthorityTests();
    console.log("antigravity-acp runtime, zip, install, auth, login, model and provider tests passed");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
const MOCK_ACP_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.ACP_MOCK_LOG;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-neon",
    options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
  },
  {
    id: "thinking_level",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];
let promptId = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (logPath) fs.appendFileSync(logPath, line + "\n");
  if (message.id === 999 && message.method === undefined) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Think" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hi" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: promptId,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });
    return;
  }
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "1.5.2" },
          authMethods: [{ id: "oauth", name: "Google OAuth" }],
          agentCapabilities: {},
        },
      });
      break;
    case "authenticate":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          models: {
            currentModelId: "gemini-4-neon",
            availableModels: [{ modelId: "gemini-4-neon", name: "Gemini 4 Neon" }],
          },
          configOptions,
        },
      });
      break;
    case "session/set_config_option":
      configOptions = configOptions.map((option) =>
        option.id === message.params.configId
          ? { ...option, currentValue: message.params.value }
          : option,
      );
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
      break;
    case "session/set_model":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "session/prompt":
      promptId = message.id;
      send({
        jsonrpc: "2.0",
        id: 999,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          options: [{ optionId: "allow_once", name: "Allow once" }],
        },
      });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
  }
});
`;

const ERROR_ACP_SERVER = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "mock initialize failure" },
      }) + "\n",
    );
  }
});
`;

async function acpTests() {
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const clientDir = tempDir("pi-acp-client-");
  const mockPath = path.join(clientDir, "mock-acp.cjs");
  fs.writeFileSync(mockPath, MOCK_ACP_SERVER);
  const logPath = path.join(clientDir, "mock.log");
  const updates = [];
  const permissions = [];
  const client = new acpModule.AcpClient({
    command: process.execPath,
    args: [mockPath],
    cwd: clientDir,
    env: { ...process.env, ACP_MOCK_LOG: logPath },
    initializeTimeoutMs: 5_000,
    operationTimeoutMs: 5_000,
    promptTimeoutMs: 5_000,
    onUpdate: (notification) => updates.push(notification),
    onPermission: async (request) => {
      permissions.push(request);
      return { outcome: { outcome: "cancelled" } };
    },
  });
  try {
    const initialized = await client.initialize();
    assert.equal(initialized.agentInfo.name, "antigravity-acp");
    assert.equal(initialized.agentInfo.version, "1.5.2");
    assert.equal(initialized.authMethods[0].id, "oauth");
    await client.authenticate("oauth");
    const session = await client.newSession(clientDir);
    assert.equal(session.sessionId, "session-1");
    assert.equal(session.models.availableModels[0].modelId, "gemini-4-neon");
    await client.setModel("session-1", "gemini-4-neon-high");
    const response = await client.prompt("session-1", [{ type: "text", text: "Hello" }]);
    assert.equal(response.stopReason, "end_turn");
    assert.equal(response.usage.totalTokens, 15);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].update.sessionUpdate, "agent_thought_chunk");
    assert.equal(updates[0].update.content.text, "Think");
    assert.equal(updates[1].update.sessionUpdate, "agent_message_chunk");
    assert.equal(updates[1].update.content.text, "Hi");
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].options[0].optionId, "allow_once");
  } finally {
    await client.close().catch(() => undefined);
  }
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const configRequests = lines.filter((line) => line.method === "session/set_config_option");
  assert.equal(configRequests.length, 2);
  assert.deepEqual(
    configRequests.map((line) => [line.params.configId, line.params.value]),
    [
      ["model", "gemini-4-neon"],
      ["thinking_level", "high"],
    ],
  );
  assert(lines.some((line) => line.method === "session/prompt"));

  const errorPath = path.join(clientDir, "error-acp.cjs");
  fs.writeFileSync(errorPath, ERROR_ACP_SERVER);
  const errorClient = new acpModule.AcpClient({
    command: process.execPath,
    args: [errorPath],
    cwd: clientDir,
    initializeTimeoutMs: 5_000,
    operationTimeoutMs: 5_000,
  });
  await assert.rejects(
    errorClient.initialize(),
    (error) => error.name === "AcpRpcError" && error.code === -32603,
  );
  await errorClient.close().catch(() => undefined);
}

async function loginTests() {
  const loginModule = await jiti.import(path.join(EXT, "login.ts"));
  const providerModule = await jiti.import(path.join(EXT, "index.ts"));

  const signInUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code" +
    "&client_id=1071006060591-abc.apps.googleusercontent.com" +
    "&redirect_uri=http%3A%2F%2F127.0.0.1%3A36141%2F" +
    "&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform" +
    "&state=STATE-1&code_challenge=challenge";

  // The server prints its URL inside an xdg-open failure; other lines carry nothing.
  assert.equal(
    loginModule.authUrlFromLine(`xdg-open: no method available for opening '${signInUrl}'`),
    signInUrl,
  );
  assert.equal(loginModule.authUrlFromLine("SyntaxWarning: invalid escape sequence"), undefined);

  const described = loginModule.describeAuthUrl(signInUrl);
  assert.equal(described.port, 36141);
  assert.equal(described.state, "STATE-1");
  assert.equal(loginModule.describeAuthUrl("not a url").port, undefined);
  assert.equal(
    loginModule.describeAuthUrl("https://accounts.google.com/o/oauth2/v2/auth?state=s").port,
    undefined,
  );

  assert.deepEqual(
    loginModule.parsePastedCredential("http://127.0.0.1:36141/?code=4%2F0abc&state=STATE-1"),
    { code: "4/0abc", state: "STATE-1" },
  );
  assert.deepEqual(loginModule.parsePastedCredential("4/0abc-def"), { code: "4/0abc-def" });
  assert.deepEqual(loginModule.parsePastedCredential("code=4/0abc"), { code: "4/0abc" });
  assert.deepEqual(loginModule.parsePastedCredential("   "), {});
  assert.deepEqual(loginModule.parsePastedCredential("http://127.0.0.1:36141/"), {});
  assert.equal(
    loginModule.parsePastedCredential("http://127.0.0.1:36141/?error=access_denied").error,
    "access_denied",
  );

  await assert.rejects(
    () => loginModule.deliverLoginCode({ url: signInUrl }, { code: "x" }),
    /no loopback callback port/u,
  );

  const authHealth = {
    status: "oauth-refreshable",
    tokenFile: true,
    settingsFile: false,
    directory: "",
    tokenPath: "",
    settingsPath: "",
  };
  const initialized = {
    protocolVersion: 1,
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  };

  /** A provider whose client resolves `authenticate` only when the test says so. */
  function loginProvider(overrides = {}) {
    let authResolver;
    let resolveRequested = false;
    let options;
    const fakeClient = {
      initialize: async () => initialized,
      authenticate: () =>
        new Promise((resolve) => {
          authResolver = resolve;
          if (resolveRequested) resolve();
        }),
      newSession: async () => ({ sessionId: "session-1" }),
      setModel: async () => {},
      prompt: async () => ({ stopReason: "end_turn" }),
      close: async () => {},
    };
    const provider = providerModule.antigravityAcpProvider({
      runtime: async () => ({ command: "mock", args: [], source: "env" }),
      createClient: (clientOptions) => {
        options = clientOptions;
        return fakeClient;
      },
      ensureAuth: () => {},
      inspectAuth: () => authHealth,
      waitForAuth: async () => true,
      ...overrides,
    });
    return {
      provider,
      options: () => options,
      // Safe before `authenticate` is reached: the request settles once it arrives.
      resolveAuth: () => {
        if (authResolver) authResolver();
        else resolveRequested = true;
      },
    };
  }

  /** Wait until the provider created its client, so stderr can be delivered to it. */
  async function whenClientReady(run) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (run.options()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("the login client was never created");
  }

  // 1. The URL reaches the dialog, and a pasted redirect URL completes the flow.
  {
    const notifications = [];
    const delivered = [];
    const run = loginProvider({
      fetch: async (input) => {
        delivered.push(String(input));
        run.resolveAuth();
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    const login = run.provider.auth.oauth.login({
      notify: (notification) => notifications.push(notification),
      prompt: async () => "http://127.0.0.1:36141/?code=4%2F0abc&state=STATE-1",
    });
    await whenClientReady(run);
    assert.equal(run.options().operationTimeoutMs, 5 * 60_000);
    run.options().onStderr(`xdg-open: no method available for opening '${signInUrl}'`);
    const credential = await login;
    assert.equal(credential.access, "antigravity-acp-managed");
    assert.equal(notifications[0].type, "progress");
    assert.match(notifications[0].message, /Opening Log in with Google/u);
    const authUrl = notifications.find((notification) => notification.type === "auth_url");
    assert(authUrl);
    assert.equal(authUrl.url, signInUrl);
    assert.match(authUrl.instructions, /ssh -L 36141:127\.0\.0\.1:36141/u);
    assert.equal(delivered.length, 1);
    const callback = new URL(delivered[0]);
    assert.equal(callback.origin, "http://127.0.0.1:36141");
    assert.equal(callback.searchParams.get("code"), "4/0abc");
    assert.equal(callback.searchParams.get("state"), "STATE-1");
  }

  // 2. The browser finishing first retires the paste prompt without delivering anything.
  {
    let aborted = false;
    const delivered = [];
    const run = loginProvider({
      fetch: async (input) => {
        delivered.push(String(input));
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    const login = run.provider.auth.oauth.login({
      notify: () => {},
      prompt: (prompt) =>
        new Promise((_resolve, reject) => {
          prompt.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("Login cancelled"));
          });
        }),
    });
    await whenClientReady(run);
    run.options().onStderr(`opening '${signInUrl}'`);
    run.resolveAuth();
    assert.equal((await login).access, "antigravity-acp-managed");
    assert.equal(aborted, true);
    assert.equal(delivered.length, 0);
  }

  // 3. An already-signed-in server prints no URL, so nothing is prompted.
  {
    const notifications = [];
    let prompted = 0;
    const run = loginProvider();
    const login = run.provider.auth.oauth.login({
      notify: (notification) => notifications.push(notification),
      prompt: async () => {
        prompted++;
        return "";
      },
    });
    await whenClientReady(run);
    run.resolveAuth();
    assert.equal((await login).access, "antigravity-acp-managed");
    assert.equal(prompted, 0);
    assert.equal(notifications.filter((notification) => notification.type === "auth_url").length, 0);
  }

  // 4. An empty paste keeps waiting for the browser instead of delivering a code.
  {
    const delivered = [];
    const run = loginProvider({
      fetch: async (input) => {
        delivered.push(String(input));
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    const login = run.provider.auth.oauth.login({
      notify: () => {},
      prompt: async () => "   ",
    });
    await whenClientReady(run);
    run.options().onStderr(`opening '${signInUrl}'`);
    setTimeout(() => run.resolveAuth(), 20);
    assert.equal((await login).access, "antigravity-acp-managed");
    assert.equal(delivered.length, 0);
  }

  // 5. A pasted error stops the login with Google's reason.
  {
    const run = loginProvider();
    const login = run.provider.auth.oauth.login({
      notify: () => {},
      prompt: async () => "http://127.0.0.1:36141/?error=access_denied",
    });
    await whenClientReady(run);
    run.options().onStderr(`opening '${signInUrl}'`);
    await assert.rejects(login, /Google sign-in failed: access_denied/u);
  }

  // 6. A rejected paste reports the server's answer instead of pretending success.
  {
    const run = loginProvider({
      fetch: async () => ({ ok: false, status: 400, text: async () => "" }),
    });
    const login = run.provider.auth.oauth.login({
      notify: () => {},
      prompt: async () => "4/0stale",
    });
    await whenClientReady(run);
    run.options().onStderr(`opening '${signInUrl}'`);
    await assert.rejects(login, /rejected the pasted code \(HTTP 400\)/u);
  }

  // 7. Callers without a prompt (older integrations) still wait for the browser.
  {
    const run = loginProvider();
    const login = run.provider.auth.oauth.login({ notify: () => {} });
    await whenClientReady(run);
    run.options().onStderr(`opening '${signInUrl}'`);
    setTimeout(() => run.resolveAuth(), 20);
    assert.equal((await login).access, "antigravity-acp-managed");
  }
}

async function providerTests() {
  const providerModule = await jiti.import(path.join(EXT, "index.ts"));
  let fakeOptions;
  const setModelCalls = [];
  const fakeClient = {
    initialize: async () => ({
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.5.2" },
      authMethods: [{ id: "oauth", name: "Google OAuth" }],
      agentCapabilities: {},
    }),
    authenticate: async () => {},
    newSession: async () => ({
      sessionId: "session-1",
      models: {
        currentModelId: "gemini-4-neon",
        availableModels: [{ modelId: "gemini-4-neon", name: "Gemini 4 Neon" }],
      },
      configOptions: [],
    }),
    setModel: async (_sessionId, modelId) => {
      setModelCalls.push(modelId);
    },
    prompt: async (sessionId) => {
      fakeOptions.onUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
      });
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      };
    },
    close: async () => {},
  };
  let authEnsured = 0;
  const provider = providerModule.antigravityAcpProvider({
    ensureAuth: () => {
      authEnsured++;
    },
    runtime: async () => ({ command: "mock", args: [], source: "env" }),
    createClient: (options) => {
      fakeOptions = options;
      return fakeClient;
    },
    inspectAuth: () => ({
      status: "oauth-refreshable",
      tokenFile: true,
      settingsFile: false,
      directory: "",
      tokenPath: "",
      settingsPath: "",
    }),
    now: () => 1_000,
    waitForAuth: async () => true,
  });

  assert.equal(provider.id, "google-antigravity-acp");
  assert.equal(provider.name, "Google Antigravity (ACP)");
  const models = provider.getModels();
  assert(models.some((model) => model.id === "gemini-4-neon"));
  assert(models.some((model) => model.id === "gemini-4-carbon"));
  const neon = models.find((model) => model.id === "gemini-4-neon");
  assert(neon);

  assert.equal((await provider.auth.oauth.toAuth()).apiKey, "antigravity-acp-managed");
  const refreshed = await provider.auth.oauth.refresh(
    { access: "old" },
    new AbortController().signal,
  );
  assert.equal(refreshed.access, "antigravity-acp-managed");
  assert.equal(refreshed.expires, 1_000 + 3_600_000);

  const notifications = [];
  const login = await provider.auth.oauth.login({
    notify: (notification) => notifications.push(notification),
  });
  assert.equal(login.access, "antigravity-acp-managed");
  assert.equal(authEnsured, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Opening Google OAuth/u);

  const events = [];
  for await (const event of provider.stream(
    neon,
    { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Hi" }] },
    {},
  )) {
    events.push(event);
  }
  assert(events.some((event) => event.type === "text_delta" && event.delta === "Hello"));
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(setModelCalls, ["gemini-4-neon-medium"]);

  const highEvents = [];
  for await (const event of provider.stream(
    neon,
    { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Hi" }] },
    { thinking: { level: "high" } },
  )) {
    highEvents.push(event);
  }
  assert.deepEqual(setModelCalls, ["gemini-4-neon-medium", "gemini-4-neon-high"]);

  let offlinePublished;
  await provider.refreshModels({
    allowNetwork: false,
    stored: { models: provider.getModels() },
    publish: async (publication) => {
      offlinePublished = publication;
    },
  });
  assert(offlinePublished);

  const discoveredProvider = providerModule.antigravityAcpProvider({
    runtime: async () => ({ command: "mock", args: [], source: "env" }),
    createClient: () => fakeClient,
    inspectAuth: () => ({
      status: "oauth-refreshable",
      tokenFile: true,
      settingsFile: false,
      directory: "",
      tokenPath: "",
      settingsPath: "",
    }),
    discoverModels: async () => [
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    ],
    now: () => 2_000,
  });
  let onlinePublished;
  await discoveredProvider.refreshModels({
    allowNetwork: true,
    signal: new AbortController().signal,
    stored: {},
    publish: async (publication) => {
      onlinePublished = publication;
    },
  });
  assert(onlinePublished);
  assert(onlinePublished.persist.models.some((model) => model.id === "gemini-4-neon"));
  assert(discoveredProvider.getModels().some((model) => model.id === "gemini-4-neon"));
}

// A server that raises one permission request during a prompt, reports tool
// activity, and advertises (or not) additional-directory support.
const MOCK_STREAM_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.ACP_MOCK_LOG;
const withDirectories = process.env.ACP_MOCK_DIRECTORIES === "1";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
let promptId;
const update = (payload) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: payload } });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    log({ permissionResponse: message.result });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: "clean",
    });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
    return;
  }
  switch (message.method) {
    case "initialize":
      log({ method: "initialize" });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "1.5.2" },
          authMethods: [{ id: "oauth", name: "Google OAuth" }],
          agentCapabilities: {
            sessionCapabilities: withDirectories ? { additionalDirectories: {} } : {},
          },
        },
      });
      break;
    case "session/new":
      log({ method: "session/new", params: message.params });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon", name: "Gemini 4 Neon" }] },
          configOptions: [
            { id: "model", category: "model", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Neon" }] },
            { id: "thinking_level", category: "thought_level", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
          ],
        },
      });
      break;
    case "session/set_config_option":
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
      break;
    case "session/prompt":
      promptId = message.id;
      update({ sessionUpdate: "tool_call", toolCallId: "call-1", kind: "execute", title: "git status --short", status: "pending" });
      send({
        jsonrpc: "2.0",
        id: 4242,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          toolCall: { toolCallId: "call-1", kind: "execute", title: "git status --short", rawInput: { CommandLine: "git status --short" } },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;

async function streamAuthorityTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");

  async function run(options) {
    const dir = tempDir("pi-acp-stream-");
    const mockPath = path.join(dir, "mock-stream.cjs");
    fs.writeFileSync(mockPath, MOCK_STREAM_SERVER);
    const logPath = path.join(dir, "mock.log");
    const extra = path.join(dir, "extra");
    fs.mkdirSync(extra);
    const activity = [];
    const permissions = [];
    const stream = streamModule.createAcpStream(
      neon,
      { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Run git status" }] },
      { cwd: dir, thinking: { level: "high" } },
      {
        resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
        createClient: (clientOptions) =>
          new acpModule.AcpClient({
            ...clientOptions,
            env: {
              ...process.env,
              ACP_MOCK_LOG: logPath,
              ACP_MOCK_DIRECTORIES: options.directories ? "1" : "0",
            },
            initializeTimeoutMs: 5_000,
            operationTimeoutMs: 5_000,
            promptTimeoutMs: 5_000,
          }),
        cwd: dir,
        ...(options.permission
          ? {
              permission: async (request) => {
                permissions.push(request);
                return options.permission;
              },
            }
          : {}),
        ...(options.directories ? { additionalDirectories: [extra] } : {}),
        onToolActivity: (entry) => activity.push(entry),
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const log = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { events, activity, permissions, log, extra };
  }

  // Pi's decision reaches the server, and the workspace Pi authorizes is passed through.
  const allowed = await run({
    permission: { outcome: { outcome: "selected", optionId: "allow" } },
    directories: true,
  });
  assert.equal(allowed.permissions.length, 1, "the server's permission request reaches Pi");
  assert.equal(allowed.permissions[0].toolCall.kind, "execute");
  assert.deepEqual(
    allowed.log.find((entry) => entry.method === "session/new").params.additionalDirectories,
    [allowed.extra],
    "Pi's project scope is offered to the session",
  );
  assert.equal(
    allowed.log.find((entry) => entry.permissionResponse).permissionResponse.outcome.optionId,
    "allow",
  );
  assert(
    allowed.activity.some((entry) => entry.kind === "execute" && entry.title === "git status --short"),
    "tool activity is reported while the ACP agent works",
  );
  assert(allowed.activity.some((entry) => entry.status === "completed"));
  assert(allowed.events.some((event) => event.type === "text_delta" && event.delta === "Done"));
  assert.equal(allowed.events.at(-1).type, "done");
  assert.equal(allowed.events.at(-1).message.stopReason, "stop");

  // Without a gate the provider denies instead of approving, and a server that
  // does not advertise extra directories never receives them.
  const denied = await run({ directories: false });
  assert.equal(
    denied.log.find((entry) => entry.permissionResponse).permissionResponse.outcome.outcome,
    "cancelled",
    "an ACP permission request is never approved without Pi's policy",
  );
  assert.equal(
    denied.log.find((entry) => entry.method === "session/new").params.additionalDirectories,
    undefined,
  );
}
