"use strict";

// Awareness must match the declared surface. The task router removes optional
// groups from the baseline, so a block that names an undeclared tool reads as
// stale harness state and sends the model looking for a CLI instead of the
// activation path.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

delete process.env.PI_HARNESS_AWARE;

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("harness awareness tests skipped (global pi install not found)");
  process.exit(0);
}

(async () => {
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve(".pi/extensions/harness-awareness/index.ts");
  const jiti = createJiti(extensionFile, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piPackageRoot } });
  const mod = await jiti.import(extensionFile);
  const { awarenessPrompt } = mod;
  assert.equal(typeof awarenessPrompt, "function", "the awareness block is a pure function of the active surface");

  let text = awarenessPrompt(["read", "activate_tools"]);
  assert.match(text, /activate_tools\(\{ tools: \[names\] \}\)/, "activation is named once when it is available");
  assert.doesNotMatch(text, /open a debug_ledger thread/, "no awareness for a tool that is not declared");
  assert.doesNotMatch(text, /run_deck launch/, "no awareness for a tool that is not declared");
  assert.doesNotMatch(text, /Harness workflow tools active/, "an empty surface has no workflow header");

  text = awarenessPrompt(["read", "activate_tools", "debug_ledger", "fix_recall", "safe_try", "evidence_inbox"]);
  assert.match(text, /Harness workflow tools active in this session/);
  assert.match(text, /open a debug_ledger thread/);
  assert.doesNotMatch(text, /run_deck launch/, "activating one family does not advertise another");

  text = awarenessPrompt(["debug_ledger", "fix_recall"]);
  assert.doesNotMatch(text, /open a debug_ledger thread/, "a partially declared family is not advertised as complete");

  assert.equal(awarenessPrompt(["read", "bash"]), "", "a restricted surface without activation advertises nothing");

  const hooks = [];
  (mod.default || mod)({
    on: (event, handler) => hooks.push({ event, handler }),
    registerCommand: () => {},
    getActiveTools: () => ["read", "activate_tools", "run_deck"],
  });
  const handler = hooks.find((row) => row.event === "before_agent_start").handler;
  const result = await handler({ systemPrompt: "BASE" });
  assert.match(result.systemPrompt, /^BASE\n\n/);
  assert.match(result.systemPrompt, /run_deck launch/);
  assert.doesNotMatch(result.systemPrompt, /debug_ledger thread/);

  // Without the active-tool API, leave the system prompt untouched rather than
  // guess which tools exist.
  const hooks2 = [];
  (mod.default || mod)({ on: (event, handler) => hooks2.push({ event, handler }), registerCommand: () => {} });
  const result2 = await hooks2.find((row) => row.event === "before_agent_start").handler({ systemPrompt: "BASE" });
  assert.equal(result2, undefined);

  console.log("harness awareness tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
