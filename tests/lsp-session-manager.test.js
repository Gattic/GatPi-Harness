#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { LspSessionManager } = require("../src/lsp-session-manager.js");

(async () => {
  const root = path.resolve(__dirname, "fixtures", "code-context", "workspace");
  const fake = path.resolve(__dirname, "fixtures", "fake-lsp-server.js");
  const definition = { id: "fake", languages: ["javascript"], command: process.execPath, args: [fake], executable: { found: true, path: process.execPath } };
  const registry = {
    forLanguage(language) { return language === "javascript" ? definition : null; },
    candidates(language) { return !language || language === "javascript" ? [definition] : []; },
    status() { return [definition]; },
  };
  const manager = new LspSessionManager({ registry, timeoutMs: 500 });
  assert.equal(manager.sessions.size, 0, "server must be lazy");
  const input = { root, language: "javascript", configuration: "test", server: definition };
  const session = await manager.get(input);
  assert.equal(session.client.initialized, true);
  assert.equal(session.serverInfo.name, "fake-lsp");
  assert.equal(manager.sessions.size, 1);

  const slow = session.client.request("test/delay", { delay: 40, value: "slow" });
  const fast = session.client.request("test/delay", { delay: 5, value: "fast" });
  assert.deepEqual(await Promise.all([slow, fast]), ["slow", "fast"], "out-of-order responses must match request IDs");

  const diagnostics = new Promise((resolve) => session.client.once("diagnostics", resolve));
  const uri = pathToFileURL(path.join(root, "src", "parser.js")).href;
  session.client.openDocument({ uri, languageId: "javascript", version: 1, text: "foo\n" });
  const published = await diagnostics;
  assert.equal(published.diagnostics[0].code, "fake");

  await assert.rejects(session.client.request("test/timeout", {}, { timeoutMs: 25 }), (error) => error.code === "LSP_TIMEOUT");
  const controller = new AbortController();
  const cancelled = session.client.request("test/delay", { delay: 100, value: "late" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error) => error.name === "AbortError");

  const crashed = await manager.request(input, "test/crash", {});
  assert.equal(crashed.degradation.code, "server_crash");
  const restarted = await manager.get(input);
  assert.notEqual(restarted.client, session.client, "crashed session should restart lazily");
  assert.equal(restarted.client.initialized, true);

  const closed = await manager.closeAll();
  assert.equal(closed.closed, 1);
  assert.equal(manager.sessions.size, 0);
  console.log("lsp session manager tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
