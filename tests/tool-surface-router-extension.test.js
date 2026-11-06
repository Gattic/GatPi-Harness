"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

// Runs the real tool-surface-router extension against a stub Pi API. Within a
// session the surface only grows, because every change to it invalidated the
// Anthropic prompt cache in the 2026-10-03 field sessions; a post-compaction
// "carry on" must keep the task's tools rather than reset them.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

delete process.env.PI_TOOL_SURFACE_ROUTER;

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("tool surface router extension tests skipped (global pi install not found)");
  process.exit(0);
}

(async () => {
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve("extensions/tool-surface-router/index.ts");
  const jiti = createJiti(extensionFile, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piPackageRoot, typebox: require.resolve("typebox", { paths: [piPackageRoot] }) } });
  const mod = await jiti.import(extensionFile);

  const baseline = ["read", "bash", "edit", "write", "roadmap_update", "activate_tools"];
  const optional = ["debug_ledger", "fix_recall", "safe_try", "evidence_inbox", "commit_plan", "run_deck", "run_monitor", "experiment_ledger", "automation_loop", "ci_pr_companion"];
  const all = [...baseline, ...optional].sort();
  let active = [...all];
  let setCalls = 0;
  const hooks = [];
  const registered = new Map();
  const noop = () => {};
  (mod.default || mod)({
    on: (event, handler) => hooks.push({ event, handler }),
    registerCommand: noop,
    registerTool: (definition) => { registered.set(definition.name, definition); },
    getAllTools: () => all.map((name) => ({ name, sourceInfo: { path: `/home/user/ext/${name}/index.ts` } })),
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; setCalls++; },
  });

  const cwd = tmpFixture("pi-tool-surface-");
  const ctx = { cwd };
  const input = async (text, source = "interactive") => {
    for (const hook of hooks.filter((row) => row.event === "input")) await hook.handler({ text, source }, ctx);
    return new Set(active);
  };
  const debugGroup = ["debug_ledger", "fix_recall", "safe_try", "evidence_inbox"];

  try {
    for (const hook of hooks.filter((row) => row.event === "session_start")) await hook.handler({}, ctx);
    assert.deepEqual([...active].sort(), [...baseline].sort(), "session start hides the optional groups");

    let tools = await input("Debug this flaky regression in the parser.");
    assert(tools.has("debug_ledger"), "the classified debug intent activates its primary tool");
    assert(debugGroup.filter((tool) => tool !== "debug_ledger").every((tool) => !tools.has(tool)), "and not the whole debug group");
    assert(!tools.has("commit_plan"));

    tools = await input("The conversation history above was just compacted automatically. Carry on with the task you were already working on.", "extension");
    assert(tools.has("debug_ledger"), "a continuation keeps the task's tools");
    assert(!tools.has("commit_plan") && !tools.has("automation_loop"), "a continuation does not switch on every optional tool");

    tools = await input("The monitored job settled. Commit the results.", "extension");
    assert(tools.has("commit_plan"), "a continuation can add what its own text asks for");
    assert(tools.has("debug_ledger"), "and still keeps the task's tools");

    const before = setCalls;
    tools = await input("Explain the scoring rules.");
    assert(tools.has("debug_ledger") && tools.has("commit_plan"), "a turn that needs no optional tools removes nothing");
    assert.equal(setCalls, before, "an unchanged surface is not re-applied");

    for (const hook of hooks.filter((row) => row.event === "session_start")) await hook.handler({}, ctx);
    assert.deepEqual([...active].sort(), [...baseline].sort(), "a new session returns to the baseline");

    // The activation tool answers the question the injected context used to
    // answer wrongly: it names what exists, what is blocked, and declares the
    // requested tool for this session without widening a restricted surface.
    const activate = registered.get("activate_tools");
    assert(activate, "activate_tools is registered by the router extension");
    assert(active.includes("activate_tools"), "the activation capability stays on the baseline surface");
    const call = (tools) => activate.execute("activate", tools === undefined ? {} : { tools }, null, null, ctx);

    let result = await call();
    assert.match(result.content[0].text, /debug_ledger \(inactive\)/, "the catalog names eligible optional tools as inactive, not absent");
    assert.match(result.content[0].text, /Optional harness tools/);

    result = await call(["debug_ledger", "not_a_tool"]);
    assert.match(result.content[0].text, /Activated: debug_ledger/);
    assert.match(result.content[0].text, /Unknown optional tool: not_a_tool/);
    assert(active.includes("debug_ledger"), "activation declares the tool for this session");
    assert.deepEqual(result.details.activated, ["debug_ledger"]);

    result = await call(["debug_ledger"]);
    assert.match(result.content[0].text, /Already active: debug_ledger/, "repeat activation is a no-op");

    const activatedSurface = new Set(active);
    tools = await input("Explain the scoring rules.");
    assert(tools.has("debug_ledger"), "a later turn keeps an explicitly activated tool");
    assert(activatedSurface.has("activate_tools"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log("tool surface router extension tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
