"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

// Runs the real reasoning-runtime extension against a stub Pi API to check what
// the model receives across turns: the reasoning scaffold must reach the model
// whenever the turn's modality changes (a stale "planning: no mutation"
// scaffold reached an implementation turn in a 2026-10-02 field session), and
// an extension-authored continuation must keep the user's scaffold.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

for (const name of ["PI_JEV_TURN_INTENT", "PI_SUBAGENT_PARENT_ID"]) delete process.env[name];
process.env.PI_COGNITIVE_AUTO_VERIFY = "0";
process.env.PI_COGNITIVE_AUTO_BRANCH = "0";
process.env.PI_COGNITIVE_ORCHESTRATION_ENABLED = "0";

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("reasoning scaffold turn tests skipped (global pi install not found)");
  process.exit(0);
}

function runtimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  return fs.realpathSync(path.resolve(piPackageRoot, "..", workspaceName));
}

(async () => {
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve(".pi/extensions/reasoning-runtime/index.ts");
  const aiRoot = runtimePackage("pi-ai", "ai");
  const jiti = createJiti(extensionFile, {
    interopDefault: true,
    alias: {
      typebox: require.resolve("typebox", { paths: [piPackageRoot] }),
      "@earendil-works/pi-coding-agent": piPackageRoot,
      "@earendil-works/pi-ai/compat": path.join(aiRoot, "dist", "compat.js"),
      "@earendil-works/pi-ai": aiRoot,
      "@earendil-works/pi-tui": runtimePackage("pi-tui", "tui"),
      "@earendil-works/pi-agent-core": runtimePackage("pi-agent-core", "agent"),
    },
  });
  const mod = await jiti.import(extensionFile);
  const hooks = [];
  const noop = () => {};
  const tools = new Map(), commands = [];
  let branch = [];
  const api = {
    on: (event, handler) => hooks.push({ event, handler }),
    registerCommand: name => commands.push(name), registerTool: tool => tools.set(tool.name, tool), registerShortcut: noop, registerMessageRenderer: noop,
    getCommands: () => [], getAllTools: () => [], getActiveTools: () => [], setActiveTools: noop,
    events: { on: noop, off: noop, emit: noop }, appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }), sendMessage: noop, sendUserMessage: noop, setSessionName: noop,
  };
  (mod.default || mod)(api);
  const center = await jiti.import(path.resolve(".pi/extensions/verification-center/index.ts"));
  (center.default || center)(api);
  assert(!commands.includes("skill-pilot-review") && !commands.includes("entropy-pilot-review"), "retired human outcome commands are not exposed");
  const cwd = tmpFixture("pi-scaffold-turns-");
  execSync("git init -q", { cwd });
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
  // The pilot enrolls exactly one native change-verify skill. Provide it as a
  // fixture and hide the developer's own skill directories from discovery.
  const previousHome = process.env.HOME;
  const home = tmpFixture("pi-scaffold-home-");
  process.env.HOME = home;
  fs.mkdirSync(path.join(cwd, ".pi/skills/change-verify"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi/skills/change-verify/SKILL.md"), "---\nname: change-verify\ndescription: Verify an existing change with repository-defined checks\n---\n# Change verify\nRun the checks that cover the diff.\n");
  fs.mkdirSync(path.join(cwd, "tests"));
  fs.writeFileSync(path.join(cwd, "tests/oracle.test.js"), "console.log('fixture passed');\n");
  const ctx = { cwd, hasUI: true, mode: "tui", isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus: noop, setWidget: noop, notify: noop, setEditorComponent: noop }, sessionManager: { getBranch: () => branch, getLeafId: () => null, getSessionId: () => "session" } };
  const emit = async (event, data) => {
    let result;
    for (const hook of hooks.filter((row) => row.event === event)) result = (await hook.handler(data, ctx)) || result;
    return result;
  };
  async function turn(text, source = "interactive") {
    await emit("input", { text, source });
    const result = await emit("before_agent_start", { prompt: text, systemPrompt: "" });
    // Pi persists both interactive and extension-authored inputs as user messages.
    branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    return result?.message?.content || "";
  }
  const scaffoldOf = (content) => content.split(/\n(?=### )/).find((section) => section.startsWith("### Reasoning scaffold")) || null;

  try {
    await emit("session_start", {});
    const first = await turn("Explain how the parser module works.");
    assert.match(scaffoldOf(first) || "", /modality: answer/, "the first turn carries the full scaffold");

    const second = await turn("Fix the off-by-one bug in src/parser.js.");
    assert.match(second, /changed sections only/, "later turns are delta updates");
    assert.match(scaffoldOf(second) || "", /modality: implementation/, "a modality change re-sends the scaffold");
    assert.doesNotMatch(second, /modality: answer/);

    const third = await turn("Fix the null check in src/lexer.js.");
    assert.equal(scaffoldOf(third), null, "an unchanged scaffold is not re-sent");

    const userContinuation = await turn("Continue");
    assert.doesNotMatch(userContinuation, /modality: (?:answer|planning)|### Active objective\nContinue/);
    const fullPlan = await turn("Using your feedback and recommendations, finish our Vulkan implementation plan in full.");
    assert.doesNotMatch(fullPlan, /modality: planning|no mutation or repair step/);
    const continuation = await turn("The conversation history above was just compacted automatically. Carry on with the task you were already working on.", "extension");
    assert.equal(scaffoldOf(continuation), null, "an extension-authored continuation keeps the user's scaffold");
    assert.doesNotMatch(continuation, /### Active objective\nThe conversation history/, "compaction instructions do not replace the parent objective");

    const back = await turn("Did we implement all of the recommendations in plan-update.md in full?");
    assert.match(scaffoldOf(back) || "", /modality: answer/, "a status question replaces the implementation scaffold");
    assert.doesNotMatch(scaffoldOf(back) || "", /change: Implement|modality: implementation/);
    assert.match(back, /Derived labels.*cannot grant permission/);
    const requestedRepair = await turn("Is the implementation complete? Implement what remains.");
    assert.match(scaffoldOf(requestedRepair) || "", /modality: implementation/, "a following explicit action retains implementation intent");
    const explanation = await turn("Explain how the lexer module works.");
    assert.match(scaffoldOf(explanation) || "", /modality: answer/, "the next user turn is classified on its own");

    const restrictedTask = "Review the lexer without edits. Preserve the public API.";
    await turn(restrictedTask);
    const restrictedBranch = [...branch];
    await turn("The conversation history above was just compacted automatically. Carry on with the task you were already working on.", "extension");
    await emit("session_shutdown", {});
    await emit("session_start", { reason: "reload" });
    const resumed = await turn("Continue");
    assert.match(resumed, /### Active objective\nReview the lexer without edits/, "reload restores the user task, not an extension-authored user message");
    assert.match(scaffoldOf(resumed) || "", /modality: investigation/);
    assert.match(resumed, /Preserve the public API/);

    await turn("Implement the remaining lexer features.");
    const implementationBranch = [...branch];
    branch = [...restrictedBranch];
    await emit("session_tree", { newLeafId: "restricted", oldLeafId: "implementation" });
    const navigated = await turn("Continue");
    assert.match(navigated, /### Active objective\nReview the lexer without edits/);
    assert.match(scaffoldOf(navigated) || "", /modality: investigation/, "an abandoned branch cannot supply implementation intent");
    // Even identical context must be resent after navigation: the active branch
    // may not contain the injection remembered from the branch just left.
    branch = [...restrictedBranch];
    await emit("session_tree", { newLeafId: "restricted-again", oldLeafId: "restricted" });
    assert.match(scaffoldOf(await turn("Continue")) || "", /modality: investigation/);
    branch = [...implementationBranch];
    await emit("session_tree", { newLeafId: "implementation", oldLeafId: "restricted-again" });
    assert.match(scaffoldOf(await turn("Continue")) || "", /modality: implementation/);
    branch = [];
    await emit("session_tree", { newLeafId: null, oldLeafId: "implementation" });
    assert.match(scaffoldOf(await turn("Continue")) || "", /modality: unclassified/, "an empty branch does not inherit any previous task");

    const { openExperiment } = require("../src/experiment-ledger");
    openExperiment(cwd, "machine verification advisory v2");
    require("../scripts/manage-advisory-pilots").run("init", { cwd });
    const injected = await turn("Verify this patch and review the diff.");
    const stateFile = path.join(cwd, ".pi/advisory-skill-pilot/machine-pilot.json");
    let state = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(state.cases.length, 1, "a first request enrolls even before the session has a leaf entry");
    assert(injected.includes("captured and assessed automatically"), "both arms use automatic evidence capture without human judgment");
    assert.equal(injected.includes("Advisory skill pilot:"), state.cases[0].arm === "candidate");
    await emit("before_provider_request", {});
    const command = { id: "oracle", kind: "unit", command: "node", args: ["tests/oracle.test.js"] };
    const input = { operation: "run", profile: "changed", input: { files: ["tests/oracle.test.js"], commands: [command] } };
    const verification = await tools.get("verification_center").execute("fixture-proof", input, undefined, noop, ctx);
    assert.equal(verification.details.evidence.ok, true);
    assert.deepEqual(verification.details.evidence.executedCommands, [{ id: "oracle", command: "node", args: ["tests/oracle.test.js"] }]);
    await emit("tool_result", { toolName: "verification_center", toolCallId: "fixture-proof", input, ...verification });
    await emit("agent_settled", {});
    state = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(state.cases[0].status, "settled");
    assert.equal(state.cases[0].metrics.modelCalls, 1);
    assert.equal(state.cases[0].delivered, state.cases[0].arm === "candidate");
    assert.equal(state.cases[0].assessment.status, "resolved", `real runtime hook automatically assesses and captures the proof: ${JSON.stringify(state.cases[0].assessment)}`);
    assert.match(state.cases[0].assessment.evidenceId, /^machine_evidence_/);
    assert.equal(state.cases[0].review, undefined);
    assert.equal(fs.existsSync(path.join(cwd, ".pi/advisory-skill-pilot/pilot.json")), false, "new initialization does not create or alter legacy outcome labels");
    await turn("Verify this patch and review the diff.", "extension");
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).cases.length, 1, "extension-authored continuations never create field samples");
  } finally {
    await emit("session_shutdown", {});
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log("reasoning scaffold turn tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
