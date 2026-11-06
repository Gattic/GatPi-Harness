"use strict";

// Real CustomEditor submission/preflight regression. The configured suggestion
// model is stubbed at the model-registry boundary; no provider calls, sleeps, or
// private editor mutations.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

process.env.PI_PROMPT_SUGGESTIONS = "1";
process.env.PI_PROMPT_SUGGESTIONS_REFINE = "1";
process.env.PI_PROMPT_SUGGESTION_ACCEPT_KEY = "tab";
process.env.PI_PROMPT_SUGGESTION_RETRY_KEY = "ctrl+r";

let piRoot;
try {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  piRoot = fs.realpathSync(path.join(globalRoot, "@earendil-works/pi-coding-agent"));
} catch {
  console.log("prompt submission tests skipped (global pi install not found)");
  process.exit(0);
}
const runtimePackage = (name, workspace) => {
  const installed = path.join(piRoot, "node_modules/@earendil-works", name);
  return fs.existsSync(path.join(installed, "package.json")) ? fs.realpathSync(installed) : path.resolve(piRoot, "..", workspace);
};
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const { tmpFixture } = require("./helpers/tmp-fixture");
const aiRoot = runtimePackage("pi-ai", "ai");
const alias = {
  typebox: require.resolve("typebox", { paths: [piRoot] }),
  "@earendil-works/pi-coding-agent": piRoot,
  "@earendil-works/pi-ai/compat": path.join(aiRoot, "dist/compat.js"),
  "@earendil-works/pi-ai": aiRoot,
  "@earendil-works/pi-tui": runtimePackage("pi-tui", "tui"),
  "@earendil-works/pi-agent-core": runtimePackage("pi-agent-core", "agent"),
};

(async () => {
  const filename = path.resolve("extensions/prompt-suggestions/index.ts");
  const jiti = createJiti(filename, { interopDefault: true, alias });
  const mod = await jiti.import(filename);
  const hooks = new Map();
  // Suggestions published on the extension bus for status consumers (pi-dash).
  const published = [];
  const listeners = new Map();
  const events = {
    on: (event, listener) => listeners.set(event, listener),
    emit: (event, value) => {
      if (event === "prompt-suggestion:changed") published.push(value);
      listeners.get(event)?.(value);
    },
  };
  const commands = new Map();
  const api = {
    on: (event, handler) => hooks.set(event, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    getCommands: () => [
      ...[...commands.keys()].map(name => ({ name, source: "extension" })),
      { name: "review", source: "prompt" },
      { name: "skill:review", source: "skill" },
    ],
    registerTool() {}, events,
  };
  (mod.default || mod)(api);
  const policy = await jiti.import(path.resolve(".pi/extensions/policy-enforcer/index.ts"));
  (policy.default || policy)(api);
  const cwd = tmpFixture("pi-prompt-preflight-");
  process.env.PI_PROMPT_SUGGESTIONS_CONFIG = path.join(cwd, "prompt-suggestions.json");
  delete process.env.PI_PROMPT_SUGGESTIONS_MODEL;
  fs.writeFileSync(process.env.PI_PROMPT_SUGGESTIONS_CONFIG, JSON.stringify({ schemaVersion: 1, provider: "fixture", modelId: "suggestion" }));
  let editor, submission, releasePreflight;
  let agentActive = false, compacting = false;
  let leaf = "prior-assistant";
  const branch = [
    { message: { role: "user", content: "Inspect the project" } },
    { message: { role: "assistant", content: "Next step: inspect the next task" } },
  ];
  const pending = [];
  const suggestionModel = { provider: "fixture", id: "suggestion" };
  const registry = {
    find: (provider, modelId) => provider === suggestionModel.provider && modelId === suggestionModel.id ? suggestionModel : undefined,
    hasConfiguredAuth: () => true,
    complete: (_model, _context, options) => new Promise((resolve) => pending.push({ signal: options.signal, resolve })),
  };
  const ctx = {
    cwd, isIdle: () => !agentActive && !compacting,
    modelRegistry: registry,
    sessionManager: { getLeafId: () => leaf, getBranch: () => branch },
    ui: { notify() {}, setEditorComponent(factory) {
      editor = factory({ requestRender() {}, terminal: { rows: 45, columns: 120 } }, { borderColor: text => text }, { matches: () => false });
    } },
  };
  const emit = (event, data = {}) => hooks.get(event)?.(data, ctx);
  const hasHint = () => editor.render(120).some(line => line.startsWith("↳ "));
  const assertSuppressed = (label) => {
    editor.precomputeEmptyPromptSuggestion();
    assert.equal(hasHint(), false, `${label}: no hint or pending indicator`);
    assert.equal(hasHint(), false, `${label}: repeat render cannot regenerate a hint`);
    editor.handleInput("\t");
    assert.equal(editor.getText().trim(), "", `${label}: Tab cannot insert a stale prompt`);
    editor.setText("");
    assert.equal(pending.length, 1, `${label}: no replacement provider request`);
  };
  try {
    emit("session_start");
    emit("agent_settled");
    assert.equal(hasHint(), true);
    assert.equal(editor.status().source, "local");
    assert.equal(pending.length, 1);
    assert.deepEqual(published, ["inspect the next task"], "the settled suggestion is published once");
    const gate = new Promise((resolve) => { releasePreflight = resolve; });
    editor.onSubmit = (text) => {
      assert.equal(text, "Begin a different task");
      editor.setText("");
      submission = (async () => {
        await gate;
        emit("before_agent_start");
        assert.equal(editor.status().idle, false, "own start hook suppresses before core becomes active");
        agentActive = true;
        emit("agent_start");
      })();
    };
    editor.setText("Begin a different task");
    editor.handleInput("\r");
    assert.ok(submission, "Enter reaches the real editor's submit callback");
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(editor.status().idle, true, "submission does not invent a busy state");
    assert.equal(published.at(-1), null, "submission withdraws the published suggestion");
    assertSuppressed("stable-leaf preflight");

    // AgentSession.prompt can compact before before_agent_start. Completing
    // compaction changes the leaf and restores isIdle while an earlier async
    // start handler is still pending. It is NOT a settled agent turn.
    compacting = true;
    assert.equal(editor.status().idle, false);
    assertSuppressed("compaction in progress");
    leaf = "preflight-compaction";
    branch.push({ type: "compaction", id: leaf, summary: "Earlier work", firstKeptEntryId: "prior-assistant", tokensBefore: 10000 });
    emit("session_compact");
    compacting = false;
    await new Promise(setImmediate);
    assert.equal(ctx.isIdle(), true);
    assert.equal(editor.status().modelWorking, false, "the agent has not started");
    assertSuppressed("completed compaction before agent start");
    pending[0].resolve({ stopReason: "stop", content: [{ type: "text", text: "A stale pre-submit refinement" }] });
    await new Promise(setImmediate);
    assertSuppressed("late provider completion after compaction");
    assert.deepEqual(published, ["inspect the next task", null], "suppressed states publish nothing");

    releasePreflight();
    await submission;
    emit("agent_end");
    assert.equal(hasHint(), false, "agent_end must not rearm hints before retries settle");
    agentActive = false;
    assert.equal(hasHint(), false, "idle alone is not settlement");
    emit("agent_settled");
    assert.equal(hasHint(), true, "settlement rearms hints even without another leaf change");
    assert.equal(pending.length, 2);
    assert.equal(published.at(-1), "inspect the next task", "settlement republishes the suggestion");

    let commandSubmission;
    editor.onSubmit = (text) => {
      editor.setText("");
      const [name, ...args] = text.slice(1).split(" ");
      commandSubmission = commands.get(name).handler(args.join(" "), ctx);
    };
    const beforeCommand = [...published];
    editor.setText("/prompt-suggestions");
    editor.handleInput("\r");
    await commandSubmission;
    assert.equal(editor.status().idle, true, "a no-turn command leaves Pi idle");
    assert.equal(pending[1].signal.aborted, true);
    assert.equal(hasHint(), true, "a handled command preserves the local hint without retry or settlement");
    editor.precomputeEmptyPromptSuggestion();
    assert.equal(pending.length, 2, "handled commands do not schedule replacement refinement");
    assert.deepEqual(published, beforeCommand, "handled commands do not withdraw the published suggestion");
    pending[1].resolve({ stopReason: "stop", content: [{ type: "text", text: "A cancelled pre-command refinement" }] });
    await new Promise(setImmediate);
    assert.equal(editor.status().source, "local");

    editor.handleInput("\u0012");
    assert.equal(pending.length, 3, "explicit retry remains available after a command");
    const refined = "Continue the approved task and run its focused tests";
    pending[2].resolve({ stopReason: "stop", content: [{ type: "text", text: refined }] });
    await new Promise(setImmediate);
    assert.equal(editor.status().source, "model");
    const beforeApproval = [...published];
    for (const command of ["/policy-approve approval_abcdef", `/policy-approve-directory ${JSON.stringify(cwd)}`]) {
      editor.handleInput(command);
      assert.equal(hasHint(), false, "typing an approval hides the hint without consuming it");
      editor.handleInput("\r");
      await commandSubmission;
      assert.equal(hasHint(), true, `${command}: approval preserves the refined hint`);
      assert.equal(editor.status().source, "model", "approval must not replace refinement with a local fallback");
      assert.deepEqual(published, beforeApproval, "approval does not withdraw or regenerate the shared suggestion");
      assert.equal(pending.length, 3, "approval does not make another provider request");
      editor.handleInput("\t");
      assert.equal(editor.getText(), refined, "Tab still accepts the exact suggestion after approval");
      editor.setText("");
    }
    const approvals = JSON.parse(fs.readFileSync(path.join(cwd, ".pi/policy-enforcer/approvals.json"), "utf8"));
    assert.equal(approvals.approvals.length, 2, "real approval handlers ran without an agent turn");

    // Registered commands can still start model turns through sendUserMessage.
    api.registerCommand("continue-task", { handler: async () => emit("input", { text: "Continue", source: "extension" }) });
    editor.setText("/continue-task");
    editor.handleInput("\r");
    await commandSubmission;
    assert.equal(editor.status().idle, true, "input arrives before agent start");
    assert.equal(hasHint(), false, "a command's model input consumes the preserved suggestion");
    assert.equal(published.at(-1), null);
    leaf = "command-preflight-compaction";
    assert.equal(hasHint(), false, "command-started preflight cannot revive hints on a new leaf");

    editor.onSubmit = () => editor.setText("");
    for (const prompt of ["/review", "/skill:review", "/unknown", "/policy-approve-not-registered", "another submission"]) {
      emit("agent_settled");
      assert.equal(hasHint(), true);
      const request = pending.at(-1);
      editor.setText(prompt);
      editor.handleInput("\r");
      assert.equal(request.signal.aborted, true);
      assert.equal(hasHint(), false, `${prompt}: model prompts remain consumed during preflight`);
      assert.equal(published.at(-1), null);
    }
    leaf = "failed-preflight-metadata";
    assert.equal(hasHint(), false, "metadata changes do not rearm failed model preflight");
    editor.handleInput("\u0012");
    assert.equal(hasHint(), true, "explicit retry still rearms failed-preflight recovery");
    editor.setText("another submission");
    editor.handleInput("\r");
    assert.equal(hasHint(), false, "submitting again consumes the manual retry too");
    emit("session_start");
    emit("agent_settled");
    assert.equal(hasHint(), true, "a new editor/session does not inherit consumption");

    const requestSuggestion = () => {
      let handled = false, error;
      events.emit("prompt-suggestion:request", { respond: (reason) => { handled = true; error = reason; } });
      assert.equal(handled, true, "remote requests must receive an explicit response");
      return error;
    };
    const beforeRequest = pending.length;
    const superseded = pending.at(-1);
    assert.equal(requestSuggestion(), null);
    assert.equal(superseded.signal.aborted, true, "remote retry cancels superseded refinement");
    assert.equal(pending.length, beforeRequest + 1, "remote retry requests a fresh refinement");
    pending.at(-1).resolve({ stopReason: "stop", content: [{ type: "text", text: "Review the new task and run focused tests" }] });
    await new Promise(setImmediate);
    assert.equal(published.at(-1), "Review the new task and run focused tests");
    assert.equal(editor.getText(), "", "remote requests never insert or submit a prompt");

    editor.setText("Keep the desktop draft");
    assert.match(requestSuggestion(), /idle.*conversation.*empty desktop editor/i);
    assert.equal(editor.getText(), "Keep the desktop draft");
    assert.equal(pending.length, beforeRequest + 1, "a typed desktop draft blocks regeneration");
    editor.setText("");
    agentActive = true;
    assert.match(requestSuggestion(), /idle/);
    agentActive = false;
    const savedBranch = branch.splice(0);
    assert.match(requestSuggestion(), /conversation/);
    branch.push(...savedBranch);
    emit("session_shutdown");
    assert.match(requestSuggestion(), /unavailable/);
    assert.equal(pending.length, beforeRequest + 1, "busy, empty, and ended sessions make no request");
  } finally {
    releasePreflight?.();
    await submission;
    emit("session_shutdown");
    for (const request of pending) request.resolve({ stopReason: "stop", content: [{ type: "text", text: "A cancelled test result" }] });
    await new Promise(setImmediate);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  assert.equal(published.at(-1), null, "shutdown withdraws the published suggestion");
  assert.ok(published.every((value, index) => index === 0 || value !== published[index - 1]), "only changes are published");
  console.log("prompt submission preflight tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
