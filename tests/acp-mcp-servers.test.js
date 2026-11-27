"use strict";

// Pi's MCP configuration, translated into ACP `mcpServers` entries. These tests
// pin the merge rules Pi uses (global then trusted project, replacement by name,
// override-only project entries), the ACP v1 entry shapes, env expansion, and
// the entries that cannot be handed over faithfully.

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
  console.log("acp-mcp-servers tests passed; extension behavior skipped (global pi install not found)");
  process.exit(0);
}

const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
const createJiti = jitiModule.createJiti || jitiModule;
const aiRoot = fs.existsSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  ? fs.realpathSync(path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai"))
  : fs.realpathSync(path.resolve(piPackageRoot, "..", "ai"));
const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "extensions", "multi-login", "antigravity-acp");
const jiti = createJiti(path.join(EXT, "mcp-servers.ts"), {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": piPackageRoot,
    "@earendil-works/pi-ai": aiRoot,
  },
});

const { tmpFixture } = require("./helpers/tmp-fixture");

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  const { loadAcpMcpServers } = await jiti.import(path.join(EXT, "mcp-servers.ts"));

  // --- stdio and HTTP entries, env expansion --------------------------------
  {
    const agentDir = tmpFixture("pi-acp-mcp-agent-");
    const cwd = tmpFixture("pi-acp-mcp-project-");
    process.env.PI_ACP_TEST_TOKEN = "secret-token";
    writeJson(path.join(agentDir, "mcp.json"), {
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "~/work"] },
        docs: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${PI_ACP_TEST_TOKEN}" },
        },
        literal: { command: "mcp-literal", env: { ESCAPED: "$$HOME", NAME: "$PI_ACP_TEST_TOKEN" } },
      },
    });
    const result = loadAcpMcpServers({ agentDir, cwd, projectTrusted: true });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.servers.length, 3);

    const filesystem = result.servers[0];
    assert.equal(filesystem.name, "filesystem");
    assert.equal(filesystem.command, "npx", "stdio entries carry no type tag");
    assert.equal("type" in filesystem, false);
    assert.deepEqual(filesystem.args, ["-y", "server-filesystem", path.join(require("node:os").homedir(), "work")]);
    assert.deepEqual(filesystem.env, [], "no env means an empty list");

    const docs = result.servers[1];
    assert.equal(docs.type, "http");
    assert.equal(docs.url, "https://example.com/mcp");
    assert.deepEqual(docs.headers, [{ name: "Authorization", value: "Bearer secret-token" }]);

    const literal = result.servers[2];
    assert.deepEqual(literal.env, [
      { name: "ESCAPED", value: "$HOME" },
      { name: "NAME", value: "secret-token" },
    ]);
    delete process.env.PI_ACP_TEST_TOKEN;
  }

  // --- project config: replacement, override-only, disabled -----------------
  {
    const agentDir = tmpFixture("pi-acp-mcp-agent-");
    const cwd = tmpFixture("pi-acp-mcp-project-");
    writeJson(path.join(agentDir, "mcp.json"), {
      mcpServers: {
        trello: { url: "https://mcp.trello.com/v1" },
        shared: { command: "global-shared" },
        off: { command: "global-off" },
        local: { command: "global-local" },
      },
    });
    writeJson(path.join(cwd, ".pi", "mcp.json"), {
      mcpServers: {
        local: { command: "project-local", args: ["--project"] },
        shared: { enabled: false },
        off: { enabled: true },
      },
    });
    const trusted = loadAcpMcpServers({ agentDir, cwd, projectTrusted: true });
    assert.deepEqual(trusted.errors, []);
    assert.deepEqual(
      trusted.servers.map((server) => server.name),
      ["trello", "off", "local"],
      "a replacement keeps the entry's position; a project override that disables the server skips it",
    );
    assert.deepEqual(trusted.skipped, [{ name: "shared", reason: "disabled in mcp.json" }]);
    const local = trusted.servers.find((server) => server.name === "local");
    assert.equal(local.command, "project-local", "the project entry replaces the global one");
    assert.deepEqual(local.args, ["--project"]);

    const untrusted = loadAcpMcpServers({ agentDir, cwd, projectTrusted: false });
    const untrustedLocal = untrusted.servers.find((server) => server.name === "local");
    assert.equal(untrustedLocal.command, "global-local", "an untrusted project's mcp.json is ignored");
  }

  // --- entries Pi cannot hand over -----------------------------------------
  {
    const agentDir = tmpFixture("pi-acp-mcp-agent-");
    const cwd = tmpFixture("pi-acp-mcp-project-");
    writeJson(path.join(agentDir, "mcp.json"), {
      mcpServers: {
        oauth: { url: "https://example.com/mcp", oauth: { clientId: "pi" } },
        commandEnv: { command: "srv", env: { TOKEN: "!pass show token" } },
        commandHeader: { url: "https://example.com/mcp", headers: { Authorization: "!pass show token" } },
        missingVar: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${PI_ACP_UNSET_VAR}" } },
        withCwd: { command: "srv", cwd: "./sub" },
        empty: { description: "nothing" },
        "bad name": { command: "srv" },
        disabled: { command: "srv", enabled: false },
        kept: { command: "srv" },
      },
    });
    const result = loadAcpMcpServers({ agentDir, cwd, projectTrusted: true });
    const reasons = Object.fromEntries(result.skipped.map((item) => [item.name, item.reason]));
    assert.match(reasons.oauth, /OAuth/u);
    assert.match(reasons.commandEnv, /shell command/u);
    assert.match(reasons.commandHeader, /shell command/u);
    assert.match(reasons.missingVar, /PI_ACP_UNSET_VAR/u);
    assert.match(reasons.withCwd, /cwd/u);
    assert.match(reasons["bad name"], /invalid server name/u);
    assert.match(reasons.empty, /command.*url/u);
    assert.match(reasons.disabled, /disabled/u);
    assert.deepEqual(result.servers.map((server) => server.name), ["kept"]);
  }

  // --- invalid configuration is reported, not thrown -----------------------
  {
    const agentDir = tmpFixture("pi-acp-mcp-agent-");
    const cwd = tmpFixture("pi-acp-mcp-project-");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "mcp.json"), "{ not json");
    writeJson(path.join(cwd, ".pi", "mcp.json"), { mcpServers: { bad: { command: "srv" } } });
    const result = loadAcpMcpServers({ agentDir, cwd, projectTrusted: true });
    // The broken global file is reported; the valid project entry still loads.
    assert.deepEqual(result.servers.map((server) => server.name), ["bad"]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /mcp\.json/u);
  }

  // --- an override without a global server is an error ---------------------
  {
    const agentDir = tmpFixture("pi-acp-mcp-agent-");
    const cwd = tmpFixture("pi-acp-mcp-project-");
    writeJson(path.join(cwd, ".pi", "mcp.json"), { mcpServers: { ghost: { enabled: false } } });
    const result = loadAcpMcpServers({ agentDir, cwd, projectTrusted: true });
    assert.equal(result.servers.length, 0);
    assert.match(result.errors[0], /needs "command" or "url"/u);
  }

  console.log("acp-mcp-servers tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
