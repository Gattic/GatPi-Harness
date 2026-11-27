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

async function cleanup() {
  try {
    const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
    await streamModule.closeAcpConversations?.();
  } catch {}
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
    await acpDeadlineTests();
    await loginTests();
    await providerTests();
    await streamAuthorityTests();
    await streamUsageTests();
    await streamToolCallTests();
    await streamToolFidelityTests();
    await promptFidelityTests();
    await sessionContinuityTests();
    await questionAuthorityTests();
    console.log("antigravity-acp runtime, zip, install, auth, login, model and provider tests passed");
  } finally {
    await cleanup();
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
    const finish = () => {
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
    };
    // A long background command leaves the server silent until it finishes.
    const delay = Number(process.env.ACP_MOCK_PROMPT_DELAY_MS || 0);
    if (delay > 0) setTimeout(finish, delay);
    else finish();
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
      if (process.env.ACP_MOCK_TOOL_UPDATE === "1") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call",
              kind: "execute",
              status: "in_progress",
              title: "Run the baseline unit tests",
              rawInput: { CommandLine: "npm test", WaitMsBeforeAsync: 1000 },
            },
          },
        });
      }
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

const NOISY_ACP_SERVER = String.raw`
process.stderr.write('/home/x/types.py:18270: SyntaxWarning: "\\/" is an invalid escape sequence. Such sequences will not work in the future. Did you mean "\\\\/"? A raw string is also an option.\n');
process.stderr.write('agent runtime: model backend unavailable\n');
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {});
`;

async function acpDeadlineTests() {
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const dir = tempDir("pi-acp-deadline-");
  const mockPath = path.join(dir, "mock-acp.cjs");
  fs.writeFileSync(mockPath, MOCK_ACP_SERVER);
  let logCount = 0;

  const make = (options = {}, env = {}) => {
    const logPath = path.join(dir, `mock-${logCount++}.jsonl`);
    const client = new acpModule.AcpClient({
      command: process.execPath,
      args: [mockPath],
      cwd: dir,
      env: { ...process.env, ACP_MOCK_LOG: logPath, ...env },
      initializeTimeoutMs: 5_000,
      operationTimeoutMs: 5_000,
      onPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
      ...options,
    });
    return { client, logPath };
  };

  // A prompt has no deadline of its own: the server is silent while a background
  // command runs, so a timer could only fail a turn that is still working.
  const patient = make({}, { ACP_MOCK_PROMPT_DELAY_MS: "1200" });
  assert.equal(
    patient.client.promptTimeoutMs,
    undefined,
    "a prompt waits for the server instead of an arbitrary deadline",
  );
  await patient.client.initialize();
  await patient.client.newSession(dir);
  const started = Date.now();
  const slow = await patient.client.prompt("session-1", [{ type: "text", text: "Run the tests" }]);
  assert.equal(slow.stopReason, "end_turn");
  assert(Date.now() - started >= 1_000, "a slow turn is allowed to finish");
  await patient.client.close().catch(() => undefined);

  // A deadline that is asked for explicitly still fails, names what the server was
  // doing, and stops the server's turn rather than leaving it running invisibly.
  const impatient = make(
    { promptTimeoutMs: 200 },
    { ACP_MOCK_PROMPT_DELAY_MS: "1200", ACP_MOCK_TOOL_UPDATE: "1" },
  );
  await impatient.client.initialize();
  await impatient.client.newSession(dir);
  await assert.rejects(
    impatient.client.prompt("session-1", [{ type: "text", text: "Run the tests" }]),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /ACP session\/prompt timed out after 200ms/u);
      assert.match(
        error.message,
        /last activity: tool_call execute in_progress "npm test" \(\d+s ago\)/u,
        "the timeout names what the server was doing",
      );
      return true;
    },
  );
  const cancelDeadline = Date.now() + 2_000;
  let cancelled = false;
  while (!cancelled && Date.now() < cancelDeadline) {
    const written = fs.existsSync(impatient.logPath)
      ? fs.readFileSync(impatient.logPath, "utf8").trim().split("\n").filter(Boolean)
      : [];
    cancelled = written.some((line) => {
      try {
        return JSON.parse(line).method === "session/cancel";
      } catch {
        return false;
      }
    });
    if (!cancelled) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(cancelled, "an imposed deadline cancels the server turn");
  await impatient.client.close().catch(() => undefined);

  // The bundle's own Python warnings are noise, not the reason for a failure.
  const noisyPath = path.join(dir, "noisy-acp.cjs");
  fs.writeFileSync(noisyPath, NOISY_ACP_SERVER);
  const noisy = new acpModule.AcpClient({
    command: process.execPath,
    args: [noisyPath],
    cwd: dir,
    initializeTimeoutMs: 200,
    operationTimeoutMs: 200,
  });
  await assert.rejects(noisy.initialize(), (error) => {
    assert.match(error.message, /ACP initialize timed out after 200ms/u);
    assert.match(error.message, /server stderr: .*model backend unavailable/u);
    assert.doesNotMatch(
      error.message,
      /SyntaxWarning|invalid escape sequence/u,
      "the bundle's syntax warnings never reach a failure message",
    );
    return true;
  });
  await noisy.close().catch(() => undefined);
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
      update({ sessionUpdate: "tool_call", toolCallId: "call-1", kind: "execute", title: "git status --short", status: "pending", rawInput: { CommandLine: "git status --short" } });
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
                return { response: options.permission };
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

  // The server's tool call is recorded as a provider-executed block: Pi shows it and
  // never runs it, and the server's own outcome becomes the call's result.
  const finalMessage = allowed.events.at(-1).message;
  const call = finalMessage.content.find((block) => block.type === "toolCall");
  assert(call, "the ACP tool call is recorded in the transcript");
  assert.equal(call.id, "call-1");
  assert.equal(call.name, "bash", "a shell call keeps Pi's own tool name so it renders like any command");
  assert.deepEqual(call.arguments, { command: "git status --short" });
  assert.equal(call.providerExecuted, true, "Pi must not run a call the server already ran");
  assert.deepEqual(call.providerResult, { content: "clean", isError: false });
  assert(
    allowed.events.some((event) => event.type === "toolcall_start" && event.contentIndex === 0),
    "the call streams as a tool-call block",
  );
  assert(allowed.events.some((event) => event.type === "toolcall_end" && event.toolCall === call));

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

// The real server reports context occupancy as `usage_update` notifications (tokens
// currently in context), while the prompt result's usage sums every internal model call
// of the turn. A Pi turn that ran 35 model calls reported 3,037,697 aggregate tokens
// against a 1,048,576 window (289.7%) while its last request held only 135,678 (12.9%).
function mockUsageServer(options) {
  return String.raw`
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const update = (payload) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: payload } });
let promptId;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
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
    case "session/new":
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
      ${options.usageUpdate ? 'update({ sessionUpdate: "usage_update", used: 135678, size: 1048576 });' : ""}
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
      send({
        jsonrpc: "2.0",
        id: promptId,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 165388, outputTokens: 32251, cachedReadTokens: 2840058, totalTokens: 3037697 },
        },
      });
      break;
  }
});
`;
}

async function streamUsageTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");

  async function run(options) {
    const dir = tempDir("pi-acp-usage-");
    const mockPath = path.join(dir, "mock-usage.cjs");
    fs.writeFileSync(mockPath, mockUsageServer(options));
    const stream = streamModule.createAcpStream(
      neon,
      { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Add the banner" }] },
      { cwd: dir, thinking: { level: "high" } },
      {
        resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
        createClient: (clientOptions) =>
          new acpModule.AcpClient({
            ...clientOptions,
            initializeTimeoutMs: 5_000,
            operationTimeoutMs: 5_000,
            promptTimeoutMs: 5_000,
          }),
        cwd: dir,
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    return events.at(-1).message;
  }

  // The 290% case: billing totals stay the turn aggregate, context is the last request.
  const reported = await run({ usageUpdate: true });
  assert.equal(reported.usage.input, 165_388, "billing input stays the turn aggregate");
  assert.equal(reported.usage.cacheRead, 2_840_058, "billing cache reads stay the turn aggregate");
  assert.equal(reported.usage.totalTokens, 3_037_697, "billing total stays the turn aggregate");
  assert.equal(reported.usage.contextTokens, 135_678, "context is the server's last request occupancy");
  const window = neon.contextWindow;
  assert.equal(((reported.usage.totalTokens / window) * 100).toFixed(1), "289.7");
  assert.equal(((reported.usage.contextTokens / window) * 100).toFixed(1), "12.9");
  assert(
    reported.usage.contextTokens / window < 0.8,
    "the context percentage stays below the proactive compaction threshold",
  );

  // A server that reports no occupancy leaves context unknown; Pi then estimates from
  // messages instead of reading the aggregate turn usage.
  const unreported = await run({ usageUpdate: false });
  assert.equal(unreported.usage.contextTokens, null);
  assert.equal(unreported.usage.totalTokens, 3_037_697);
}

// A server whose tool calls exercise the mapping: an edit announced without
// rawInput, a failed call whose text arrives as content blocks, a terminal
// update for a call it never announced, an update with no id, and a call with
// no kind.
const MOCK_TOOL_SERVER = String.raw`
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const update = (payload) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: payload } });
let promptId;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
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
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          models: { currentModelId: "gemini-4-neon", availableModels: [] },
          configOptions: [],
        },
      });
      break;
    case "session/set_config_option":
    case "session/set_model":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "session/prompt":
      promptId = message.id;
      update({ sessionUpdate: "tool_call", toolCallId: "call-edit", kind: "edit", title: "src/app.ts", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-edit", status: "failed", content: [{ type: "text", text: "permission denied" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-late", status: "completed", rawOutput: "ok" });
      update({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: "orphan" });
      update({ sessionUpdate: "tool_call", toolCallId: "call-plain", status: "pending" });
      // Antigravity reports a shell result as a structured rawOutput, not a string.
      update({ sessionUpdate: "tool_call", toolCallId: "call-shell", kind: "execute", title: "echo ok", status: "in_progress", rawInput: { command_line: "echo ok", working_dir: "/tmp" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-shell", status: "completed", rawOutput: { commandLine: "echo ok", workingDir: "/tmp", exitCode: 0, exit_code: 0, combinedOutput: "ok\r\n", formatted_output: "ok\r\n" } });
      update({ sessionUpdate: "tool_call", toolCallId: "call-exit", kind: "execute", title: "exit 2", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-exit", status: "completed", rawOutput: { exitCode: 2, combinedOutput: "boom\r\n" } });
      update({ sessionUpdate: "tool_call", toolCallId: "call-nested", kind: "read", title: "a.txt", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-nested", status: "completed", content: [{ type: "content", content: { type: "text", text: "nested" } }] });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;

async function streamToolCallTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");
  const dir = tempDir("pi-acp-tools-");
  const mockPath = path.join(dir, "mock-tools.cjs");
  fs.writeFileSync(mockPath, MOCK_TOOL_SERVER);
  const events = [];
  const stream = streamModule.createAcpStream(
    neon,
    { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Edit the file" }] },
    { cwd: dir },
    {
      resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
      createClient: (clientOptions) =>
        new acpModule.AcpClient({
          ...clientOptions,
          initializeTimeoutMs: 5_000,
          operationTimeoutMs: 5_000,
          promptTimeoutMs: 5_000,
        }),
      cwd: dir,
    },
  );
  for await (const event of stream) events.push(event);

  const message = events.at(-1).message;
  const calls = message.content.filter((block) => block.type === "toolCall");
  assert.equal(calls.length, 6, "each announced call is recorded once");

  const edit = calls.find((call) => call.id === "call-edit");
  assert.equal(edit.name, "acp_edit");
  assert.deepEqual(edit.arguments, { title: "src/app.ts" }, "a call without rawInput keeps its title");
  assert.equal(edit.providerExecuted, true);
  assert.deepEqual(
    edit.providerResult,
    { content: "permission denied", isError: true },
    "a failed call reports an error result",
  );

  const late = calls.find((call) => call.id === "call-late");
  assert.equal(late.name, "acp_tool", "a call reported only by its update is recorded");
  assert.deepEqual(late.providerResult, { content: "ok", isError: false });

  const plain = calls.find((call) => call.id === "call-plain");
  assert.equal(plain.name, "acp_tool", "a call without a kind keeps the generic name");
  assert.equal(plain.providerResult, undefined, "a running call has no result yet");

  const shell = calls.find((call) => call.id === "call-shell");
  assert.equal(shell.name, "bash", "an execute kind becomes Pi's own shell row");
  assert.deepEqual(shell.arguments, { command: "echo ok", cwd: "/tmp" });
  assert.deepEqual(
    shell.providerResult,
    { content: "ok\r\n", isError: false },
    "a structured rawOutput contributes the shell's output",
  );

  const exit = calls.find((call) => call.id === "call-exit");
  assert.equal(exit.name, "acp_execute", "a shell call with no command stays generic");
  assert.deepEqual(
    exit.providerResult,
    { content: "boom\r\n", isError: true },
    "a non-zero exit marks the result as an error",
  );

  const nested = calls.find((call) => call.id === "call-nested");
  assert.deepEqual(
    nested.providerResult,
    { content: "nested", isError: false },
    "a nested content block contributes its text",
  );

  assert(
    !calls.some((call) => call.providerResult?.content === "orphan"),
    "an update without an id records nothing",
  );
  assert.equal(message.stopReason, "stop");
}
const MOCK_FIDELITY_SERVER = String.raw`
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const update = (payload) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: payload } });
const root = process.cwd();
const notes = root + "/notes.txt";
const letters = root + "/a.txt";
const big = Array.from({ length: 40000 }, (_, index) => "line " + (index + 1)).join("\n");
let promptId;
let nextRequestId = 900;
const waiters = new Map();
const rl = readline.createInterface({ input: process.stdin });

function request(method, params) {
  const id = nextRequestId++;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) {
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
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
          agentCapabilities: {
            sessionCapabilities: { additionalDirectories: {} },
          },
        },
      });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          models: { currentModelId: "gemini-4-neon", availableModels: [] },
          configOptions: [],
        },
      });
      break;
    case "session/set_config_option":
    case "session/set_model":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "session/prompt":
      promptId = message.id;
      runPrompt();
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
});

async function runPrompt() {
  // A shell call whose output is far longer than Pi shows: the row keeps the tail and names
  // a file holding the whole text, exactly as Pi's own bash tool does.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-big",
    kind: "execute",
    title: "seq 1 40000",
    status: "pending",
    rawInput: { CommandLine: "seq 1 40000", Cwd: "/tmp" },
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-big",
    status: "in_progress",
    rawOutput: { combinedOutput: big.slice(0, 20000) },
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-big",
    status: "completed",
    rawOutput: { exitCode: 0, combinedOutput: big },
  });

  // A call that is still running keeps the output its last update carried.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-progress",
    kind: "execute",
    title: "npm test",
    status: "in_progress",
    rawInput: { CommandLine: "npm test" },
  });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-progress",
    status: "in_progress",
    rawOutput: { combinedOutput: "running 3 of 12 suites" },
  });

  // The server describes a file it creates as a diff, and asks Pi to write it.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-write",
    kind: "edit",
    title: "Create notes.txt",
    status: "pending",
    locations: [{ path: notes }],
    content: [{ type: "diff", path: notes, newText: "hello", _meta: { kind: "add" } }],
    rawInput: { TargetFile: notes, CodeContent: "hello" },
  });
  await request("fs/write_text_file", { sessionId: "session-1", path: notes, content: "hello" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-write", status: "completed", rawOutput: "Create notes.txt" });

  // A read comes back through Pi, so the row has to say what Pi read.
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-read",
    kind: "read",
    title: "Read a.txt",
    status: "pending",
    locations: [{ path: letters }],
    rawInput: { file_path: letters },
  });
  const read = await request("fs/read_text_file", { sessionId: "session-1", path: letters });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-read",
    status: "completed",
    content: [{ type: "text", text: read.result.content }],
  });

  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
  send({
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  });
}
`;

// ACP tool rows carry what Pi's own tools carry: a command the server ran reads as a command,
// the full output of a long call is kept in a file the row names, a running call shows its latest
// output, and file work Pi performed for the server is reported on the row that asked for it.
async function streamToolFidelityTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");
  const dir = tempDir("pi-acp-fidelity-");
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta");
  const mockPath = path.join(dir, "mock-fidelity.cjs");
  fs.writeFileSync(mockPath, MOCK_FIDELITY_SERVER);
  const events = [];
  const stream = streamModule.createAcpStream(
    neon,
    { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Work the task" }] },
    { cwd: dir },
    {
      resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
      createClient: (clientOptions) =>
        new acpModule.AcpClient({
          ...clientOptions,
          initializeTimeoutMs: 5_000,
          operationTimeoutMs: 5_000,
          promptTimeoutMs: 5_000,
        }),
      cwd: dir,
      fileHandlers: {
        async readTextFile(request) {
          return { content: fs.readFileSync(request.path, "utf8") };
        },
        async writeTextFile(request) {
          fs.writeFileSync(request.path, request.content, "utf8");
        },
      },
    },
  );
  for await (const event of stream) events.push(event);

  const message = events.at(-1).message;
  const calls = message.content.filter((block) => block.type === "toolCall");
  const bigOutputPath = path.join(dir, "notes.txt");
  assert.equal(fs.readFileSync(bigOutputPath, "utf8"), "hello", "Pi wrote the file the server asked for");

  const big = calls.find((call) => call.id === "call-big");
  assert.equal(big.name, "bash", "an execute kind renders as Pi's own shell row");
  assert.deepEqual(big.arguments, { command: "seq 1 40000", cwd: "/tmp" });
  const bigContent = big.providerResult.content;
  const notice = /\[Showing lines (\d+)-(\d+) of 40000(?: \(50KB limit\))?\. Full output: (.+)\]$/u.exec(bigContent);
  assert(notice, "the row names where the whole output went");
  const shown = bigContent.slice(0, bigContent.indexOf("\n\n[Showing"));
  assert(shown.trimEnd().endsWith("line 40000"), "the row keeps the tail of a long output");
  assert(!shown.includes("line 1\n"), "the head of a long output is not what the row shows");
  const fullOutputPath = notice[3];
  assert(fullOutputPath.startsWith(os.tmpdir()), "the full output goes to the output directory");
  const fullOutput = fs.readFileSync(fullOutputPath, "utf8");
  assert(fullOutput.startsWith("line 1\nline 2"), "the file holds the whole output, not just the tail");
  assert(fullOutput.endsWith("line 40000"));
  assert.equal(fullOutput.split("\n").length, 40000);
  fs.rmSync(fullOutputPath, { force: true });

  const progress = calls.find((call) => call.id === "call-progress");
  assert.deepEqual(
    progress.providerResult,
    { content: "running 3 of 12 suites", isError: false },
    "a running call shows the output its last update carried",
  );

  const write = calls.find((call) => call.id === "call-write");
  assert.equal(write.name, "write", "a diff the server described renders as Pi's own write row");
  assert.deepEqual(write.arguments, { path: bigOutputPath, content: "hello" });
  assert(
    write.providerResult.content.includes(`Pi wrote 5 bytes to ${bigOutputPath}`),
    "the row reports the file Pi wrote for the server",
  );
  assert(write.providerResult.content.includes("Create notes.txt"));

  const read = calls.find((call) => call.id === "call-read");
  assert.equal(read.name, "read", "a read kind renders as Pi's own read row");
  assert.deepEqual(read.arguments, { path: path.join(dir, "a.txt") });
  assert(
    read.providerResult.content.includes(`Pi read 2 lines of ${path.join(dir, "a.txt")}`),
    "the row reports the file Pi read for the server",
  );
  assert(read.providerResult.content.includes("alpha\nbeta"));
  assert.equal(message.stopReason, "stop");
}
const MOCK_PROMPT_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const logPath = process.env.ACP_PROMPT_LOG;
const append = process.env.ACP_APPEND === "1";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (logPath) fs.appendFileSync(logPath, line + "\n");
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "1.5.2" },
          authMethods: [{ id: "oauth", name: "Google OAuth" }],
          agentCapabilities: append ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {},
        },
      });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          models: { currentModelId: "gemini-4-neon", availableModels: [] },
          configOptions: [],
        },
      });
      break;
    case "session/set_config_option":
    case "session/set_model":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
        },
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;

// The prompt is Pi's transcript, not a retelling of it: Pi's system prompt reaches the session as
// metadata when the server says it takes one, images Pi was given are forwarded, and prior thinking
// stays out of the assistant's visible text.
async function promptFidelityTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");
  const context = {
    systemPrompt: "Pi's rules",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "I see it" },
        ],
      },
    ],
  };

  const withSystem = streamModule.buildPrompt(context);
  assert.equal(withSystem[0].type, "text");
  assert(withSystem[0].text.startsWith("System instructions:\nPi's rules"));
  assert.deepEqual(
    withSystem.find((block) => block.type === "image"),
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    "an image Pi was given reaches the server",
  );
  assert(
    !withSystem.some((block) => block.text?.includes("hidden reasoning")),
    "prior thinking is not resent as assistant prose",
  );
  assert(
    withSystem.some((block) => block.text === "Assistant:\nI see it"),
    "the assistant's visible answer is resent",
  );
  const withoutSystem = streamModule.buildPrompt(context, { omitSystemPrompt: true });
  assert(
    !withoutSystem.some((block) => block.text?.includes("System instructions")),
    "the session metadata carries the system prompt instead of the prompt",
  );

  async function run(append) {
    // Each run is its own workspace, so each gets its own server and session.
    const workspace = tempDir(`pi-acp-prompt-${append ? "append" : "plain"}-`);
    const mockPath = path.join(workspace, "mock-prompt.cjs");
    fs.writeFileSync(mockPath, MOCK_PROMPT_SERVER);
    const logPath = path.join(workspace, "log.jsonl");
    const events = [];
    const stream = streamModule.createAcpStream(neon, context, { cwd: workspace }, {
      resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
      createClient: (clientOptions) =>
        new acpModule.AcpClient({
          ...clientOptions,
          initializeTimeoutMs: 5_000,
          operationTimeoutMs: 5_000,
          promptTimeoutMs: 5_000,
          env: { ...process.env, ACP_PROMPT_LOG: logPath, ACP_APPEND: append ? "1" : "0" },
        }),
      cwd: workspace,
    });
    for await (const event of stream) events.push(event);
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { events, lines };
  }

  const withAppend = await run(true);
  const appendNew = withAppend.lines.find((line) => line.method === "session/new");
  assert.deepEqual(
    appendNew.params._meta,
    { antigravity: { systemPrompt: { append: "Pi's rules" } } },
    "Pi's system prompt is offered as session metadata",
  );
  const appendPrompt = withAppend.lines.find((line) => line.method === "session/prompt");
  assert(
    !appendPrompt.params.prompt.some((block) => block.text?.includes("System instructions")),
    "the system prompt is not repeated in the prompt",
  );
  assert(
    appendPrompt.params.prompt.some((block) => block.type === "image" && block.data === "aGVsbG8="),
    "the image is sent in the prompt",
  );
  assert.equal(withAppend.events.at(-1).message.stopReason, "stop");

  const withoutAppend = await run(false);
  const plainNew = withoutAppend.lines.find((line) => line.method === "session/new");
  assert.equal(plainNew.params._meta, undefined, "a server without the capability gets no metadata");
  const plainPrompt = withoutAppend.lines.find((line) => line.method === "session/prompt");
  assert(
    plainPrompt.params.prompt.some((block) => block.text?.startsWith("System instructions:\nPi's rules")),
    "a server without the capability gets the system prompt in the prompt",
  );
}
const MOCK_CONTINUITY_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const logPath = process.env.ACP_CONTINUITY_LOG;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (logPath) fs.appendFileSync(logPath, line + "\n");
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "1.5.2" },
          authMethods: [{ id: "oauth", name: "Google OAuth" }],
          agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
        },
      });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          models: { currentModelId: "gemini-4-neon", availableModels: [] },
          configOptions: [],
        },
      });
      break;
    case "session/set_config_option":
    case "session/set_model":
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
        },
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;

// A workspace keeps one server and one session between Pi turns, and a turn sends only what the
// session has not seen. A transcript Pi rewrote (a compaction, a branch edit) no longer matches
// what the session holds, so that turn starts a fresh session with the whole transcript.
async function sessionContinuityTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");
  const workspace = tempDir("pi-acp-continuity-");
  const mockPath = path.join(workspace, "mock-continuity.cjs");
  fs.writeFileSync(mockPath, MOCK_CONTINUITY_SERVER);
  const logPath = path.join(workspace, "log.jsonl");
  let clients = 0;

  async function turn(context) {
    const events = [];
    const stream = streamModule.createAcpStream(neon, context, { cwd: workspace }, {
      resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
      createClient: (clientOptions) => {
        clients++;
        return new acpModule.AcpClient({
          ...clientOptions,
          initializeTimeoutMs: 5_000,
          operationTimeoutMs: 5_000,
          promptTimeoutMs: 5_000,
          env: { ...process.env, ACP_CONTINUITY_LOG: logPath },
        });
      },
      cwd: workspace,
    });
    for await (const event of stream) events.push(event);
    return events;
  }

  const readLog = () =>
    fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const prompts = () => readLog().filter((line) => line.method === "session/prompt");
  const newSessions = () => readLog().filter((line) => line.method === "session/new");

  const userOne = { role: "user", content: "first task" };
  const first = await turn({ systemPrompt: "Pi's rules", messages: [userOne] });
  const assistantOne = first.at(-1).message;
  assert.equal(assistantOne.stopReason, "stop");
  assert.equal(clients, 1, "the first turn starts the server");
  assert.equal(newSessions().length, 1, "the first turn creates the session");
  assert.equal(prompts().length, 1);

  const userTwo = { role: "user", content: "second task" };
  await turn({ systemPrompt: "Pi's rules", messages: [userOne, assistantOne, userTwo] });
  assert.equal(clients, 1, "the next turn reuses the running server");
  assert.equal(newSessions().length, 1, "the next turn reuses the session");
  const secondPrompt = prompts()[1].params.prompt;
  assert.equal(secondPrompt.length, 1, "only the new message is sent");
  assert.equal(secondPrompt[0].text, "User:\nsecond task");
  assert(
    !secondPrompt.some((block) => block.text?.includes("System instructions")),
    "the session keeps the system prompt it was given",
  );

  // Pi rewrote its transcript: the session's context no longer describes it.
  const summary = { role: "user", content: "Summary of the conversation so far" };
  const userThree = { role: "user", content: "third task" };
  await turn({ systemPrompt: "Pi's rules", messages: [summary, userThree] });
  assert.equal(clients, 2, "a rewritten transcript starts a fresh server");
  assert.equal(newSessions().length, 2, "a rewritten transcript starts a fresh session");
  const thirdPrompt = prompts()[2].params.prompt;
  assert(
    thirdPrompt.some((block) => block.text === "User:\nSummary of the conversation so far"),
    "the fresh session gets the whole transcript",
  );
  assert(thirdPrompt.some((block) => block.text === "User:\nthird task"));
  await streamModule.closeAcpConversations();
}

// A server that asks the person a question instead of asking permission for a
// call, and ends its turn when the question is declined.
const MOCK_QUESTION_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.ACP_MOCK_LOG;
const trustPrompt = process.env.ACP_MOCK_TRUST === "1";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
const update = (payload) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: payload } });
let promptId;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    log({ permissionResponse: message.result });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for your answer." } });
    send({
      jsonrpc: "2.0",
      id: promptId,
      result: {
        stopReason: trustPrompt ? "end_turn" : "cancelled",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
    case "session/new":
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
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-9",
        kind: trustPrompt ? "other" : "ask_user",
        title: trustPrompt ? "Trust this workspace?" : "Which package manager should I use?",
        status: "pending",
        rawInput: { Question: trustPrompt ? "Trust this workspace?" : "Which package manager should I use?" },
      });
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          toolCall: {
            toolCallId: "call-9",
            kind: trustPrompt ? "other" : "ask_user",
            title: trustPrompt ? "Trust this workspace?" : "Which package manager should I use?",
          },
          options: trustPrompt
            ? [
                { optionId: "allow", name: "Trust", kind: "allow_once" },
                { optionId: "deny", name: "Do not trust", kind: "reject_once" },
              ]
            : [
                { optionId: "npm", name: "npm" },
                { optionId: "pnpm", name: "pnpm" },
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

// A question is the person's decision: Pi declines it, shows it in the
// transcript, and ends the turn instead of failing it. A workspace-trust prompt
// is answered from Pi's own trust decision, never with a standing grant.
async function questionAuthorityTests() {
  const streamModule = await jiti.import(path.join(EXT, "stream.ts"));
  const modelsModule = await jiti.import(path.join(EXT, "models.ts"));
  const acpModule = await jiti.import(path.join(EXT, "acp.ts"));
  const { createAcpPermissionGate } = require(path.join(ROOT, "src", "acp-permission-gate.js"));
  const neon = modelsModule.FALLBACK_MODELS.find((model) => model.id === "gemini-4-neon");

  async function ask(options = {}) {
    const dir = tempDir("pi-acp-question-");
    const mockPath = path.join(dir, "mock-question.cjs");
    fs.writeFileSync(mockPath, MOCK_QUESTION_SERVER);
    const logPath = path.join(dir, "mock.log");
    const asked = [];
    const gate = createAcpPermissionGate({
      cwd: dir,
      getContext: () => ({ isProjectTrusted: () => options.trusted === true }),
    });
    const stream = streamModule.createAcpStream(
      neon,
      { systemPrompt: "Be helpful", messages: [{ role: "user", content: "Set up the repo" }] },
      { cwd: dir },
      {
        resolveRuntime: async () => ({ command: process.execPath, args: [mockPath], source: "env" }),
        createClient: (clientOptions) =>
          new acpModule.AcpClient({
            ...clientOptions,
            env: {
              ...process.env,
              ACP_MOCK_LOG: logPath,
              ACP_MOCK_TRUST: options.trustPrompt ? "1" : "0",
            },
            initializeTimeoutMs: 5_000,
            operationTimeoutMs: 5_000,
            promptTimeoutMs: 5_000,
          }),
        cwd: dir,
        permission: (request) => gate.request(request),
        onQuestion: (question) => asked.push(question),
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const log = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { events, asked, log };
  }

  const declined = await ask();
  assert.equal(
    declined.log.find((entry) => entry.permissionResponse).permissionResponse.outcome.outcome,
    "cancelled",
    "a question is declined, never answered with one of its options",
  );
  assert.equal(declined.asked.length, 1, "the question reaches Pi's transcript callback");
  assert.equal(declined.asked[0].text, "Which package manager should I use?");
  assert.equal(declined.asked[0].kind, "ask_user");
  assert.equal(declined.asked[0].trust, false);
  assert.deepEqual(
    declined.asked[0].options.map((option) => option.id),
    ["npm", "pnpm"],
    "the question keeps every answer the server offered",
  );
  assert.equal(declined.events.at(-1).type, "done", "an unanswered question ends the turn instead of failing it");
  assert.equal(declined.events.at(-1).message.stopReason, "stop");
  assert(
    declined.events.some((event) => event.type === "text_delta" && event.delta === "Waiting for your answer."),
    "what the server said before asking stays in the transcript",
  );

  // Pi trusts the workspace, so its own trust decision answers the prompt.
  const trusted = await ask({ trustPrompt: true, trusted: true });
  assert.equal(trusted.asked[0].trust, true, "a trust prompt is recognized as one");
  assert.equal(
    trusted.log.find((entry) => entry.permissionResponse).permissionResponse.outcome.optionId,
    "allow",
    "a trusted workspace is accepted",
  );
  assert.equal(trusted.events.at(-1).message.stopReason, "stop");

  // An untrusted workspace leaves the prompt to the person.
  const untrusted = await ask({ trustPrompt: true, trusted: false });
  assert.equal(
    untrusted.log.find((entry) => entry.permissionResponse).permissionResponse.outcome.outcome,
    "cancelled",
    "an untrusted workspace is never accepted on the person's behalf",
  );
  await streamModule.closeAcpConversations();
}
