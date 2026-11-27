"use strict";

// The ACP client surface Pi advertises: `fs.readTextFile`/`fs.writeTextFile`
// when it has handlers, `terminal` never, and Pi's MCP servers in `session/new`.
// A mock server drives the callbacks so the JSON-RPC dispatch is exercised for
// real, including the refusal Pi sends when a capability is not advertised.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  console.log("acp-client-callbacks tests passed; extension behavior skipped (global pi install not found)");
  process.exit(0);
}

const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
const createJiti = jitiModule.createJiti || jitiModule;
const aiRoot = fs.existsSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  ? fs.realpathSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  : fs.realpathSync(path.resolve(piPackageRoot, "..", "ai"));
const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "extensions", "multi-login", "antigravity-acp");
const jiti = createJiti(path.join(EXT, "acp.ts"), {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": piPackageRoot,
    "@earendil-works/pi-ai": aiRoot,
  },
});

const { tmpFixture } = require("./helpers/tmp-fixture");

const MOCK_ACP_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.env.ACP_MOCK_LOG;
const rl = readline.createInterface({ input: process.stdin });
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptId;

function request(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, line + "\n");
  if (message.method === undefined && message.id !== undefined) {
    const settle = pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      settle(message);
    }
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      break;
    case "session/prompt":
      promptId = message.id;
      (async () => {
        const read = await request(900, "fs/read_text_file", {
          sessionId: "session-1",
          path: process.env.ACP_MOCK_FILE,
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(read) } },
          },
        });
        const write = await request(901, "fs/write_text_file", {
          sessionId: "session-1",
          path: process.env.ACP_MOCK_OUT,
          content: "written\n",
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(write) } },
          },
        });
        const terminal = await request(902, "terminal/create", { sessionId: "session-1", command: "ls" });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(terminal) } },
          },
        });
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      })();
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;

const MCP_SERVERS = [
  { name: "filesystem", command: "npx", args: ["-y", "server-filesystem"], env: [{ name: "ROOT", value: "/tmp" }] },
  { type: "http", name: "docs", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
];

function readLog(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function main() {
  const { AcpClient } = await jiti.import(path.join(EXT, "acp.ts"));
  const dir = tmpFixture("pi-acp-callbacks-");
  const mockPath = path.join(dir, "mock-acp.cjs");
  fs.writeFileSync(mockPath, MOCK_ACP_SERVER);
  const sourceFile = path.join(dir, "source.txt");
  fs.writeFileSync(sourceFile, "from disk\n");

  // --- advertised capabilities and the callback round trip -----------------
  {
    const logPath = path.join(dir, "mock-with-handlers.log");
    const outFile = path.join(dir, "written.txt");
    const updates = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [mockPath],
      cwd: dir,
      env: {
        ...process.env,
        ACP_MOCK_LOG: logPath,
        ACP_MOCK_FILE: sourceFile,
        ACP_MOCK_OUT: outFile,
      },
      mcpServers: MCP_SERVERS,
      fileHandlers: {
        readTextFile: async (request) => ({ content: fs.readFileSync(request.path, "utf8") }),
        writeTextFile: async (request) => {
          fs.writeFileSync(request.path, request.content, "utf8");
        },
      },
      initializeTimeoutMs: 5_000,
      operationTimeoutMs: 5_000,
      onUpdate: (notification) => updates.push(notification),
    });
    try {
      await client.initialize();
      const session = await client.newSession(dir);
      assert.equal(session.sessionId, "session-1");
      await client.prompt("session-1", [{ type: "text", text: "Go" }]);
    } finally {
      await client.close().catch(() => undefined);
    }

    const lines = readLog(logPath);
    const initialize = lines.find((line) => line.method === "initialize");
    assert.deepEqual(initialize.params.clientCapabilities, {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    });
    const sessionNew = lines.find((line) => line.method === "session/new");
    assert.deepEqual(sessionNew.params.mcpServers, MCP_SERVERS, "Pi's MCP servers travel with session/new");
    assert.equal(sessionNew.params.cwd, dir);

    const texts = updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => JSON.parse(update.update.content.text));
    assert.deepEqual(texts[0].result, { content: "from disk\n" }, "fs/read_text_file is answered with the file content");
    assert.deepEqual(texts[1].result, {}, "fs/write_text_file is answered with an empty result");
    assert.equal(fs.readFileSync(outFile, "utf8"), "written\n", "the handler wrote the file");
    assert.equal(texts[2].error.code, -32601, "terminal/* stays unadvertised and is refused");
  }

  // --- without handlers Pi advertises nothing and refuses the callbacks ----
  {
    const logPath = path.join(dir, "mock-without-handlers.log");
    const outFile = path.join(dir, "never-written.txt");
    const updates = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [mockPath],
      cwd: dir,
      env: {
        ...process.env,
        ACP_MOCK_LOG: logPath,
        ACP_MOCK_FILE: sourceFile,
        ACP_MOCK_OUT: outFile,
      },
      initializeTimeoutMs: 5_000,
      operationTimeoutMs: 5_000,
      onUpdate: (notification) => updates.push(notification),
    });
    try {
      await client.initialize();
      await client.newSession(dir);
      await client.prompt("session-1", [{ type: "text", text: "Go" }]);
    } finally {
      await client.close().catch(() => undefined);
    }

    const lines = readLog(logPath);
    const initialize = lines.find((line) => line.method === "initialize");
    assert.deepEqual(initialize.params.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    const sessionNew = lines.find((line) => line.method === "session/new");
    assert.deepEqual(sessionNew.params.mcpServers, [], "without servers the list is empty");
    const texts = updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => JSON.parse(update.update.content.text));
    assert.equal(texts[0].error.code, -32601);
    assert.equal(texts[1].error.code, -32601);
    assert.equal(fs.existsSync(outFile), false, "nothing was written");
  }

  // --- a refusing handler surfaces its reason to the server ---------------
  {
    const logPath = path.join(dir, "mock-refused.log");
    const updates = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [mockPath],
      cwd: dir,
      env: {
        ...process.env,
        ACP_MOCK_LOG: logPath,
        ACP_MOCK_FILE: sourceFile,
        ACP_MOCK_OUT: path.join(dir, "refused.txt"),
      },
      fileHandlers: {
        readTextFile: async () => {
          throw new Error("acp-permission block read");
        },
        writeTextFile: async () => {
          throw new Error("acp-permission block write");
        },
      },
      initializeTimeoutMs: 5_000,
      operationTimeoutMs: 5_000,
      onUpdate: (notification) => updates.push(notification),
    });
    try {
      await client.initialize();
      await client.newSession(dir);
      await client.prompt("session-1", [{ type: "text", text: "Go" }]);
    } finally {
      await client.close().catch(() => undefined);
    }
    const texts = updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => JSON.parse(update.update.content.text));
    assert.equal(texts[0].error.code, -32603);
    assert.match(texts[0].error.message, /acp-permission block read/u);
    assert.match(texts[1].error.message, /acp-permission block write/u);
  }

  console.log("acp-client-callbacks tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
