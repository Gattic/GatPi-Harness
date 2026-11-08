"use strict";

// Behavioral load test for every Pi extension: imports each index.ts through
// Pi's own TS loader (jiti) and runs its default export against a stub Pi API.
// Catches broken imports, top-level throw, and registration failures that
// source-grep checks cannot see. Resolves jiti/typebox from either a published
// global package or the linked Pi monorepo; skips (exit 0) when pi is absent.

const assert = require("node:assert/strict");
const { execSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");
const { buildRepoContext } = require("../src/repo-context.js");
const { applyRoadmapPlan } = require("../src/roadmap-plan-application.js");
const { EvidenceStore, createEvidencePacket } = require("../src/evidence-binder.js");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source.js");
const { ROLE_OUTPUT_SCHEMAS, validateJsonSchema } = require("../src/role-result-schemas.js");
const { HermesAdvisoryAdapter } = require("../src/integration-boundary.js");

let piPackageRoot = null;
try {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const candidate = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("extension-load tests skipped (global pi install not found)");
  process.exit(0);
}

function resolveRuntimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  const workspace = path.resolve(piPackageRoot, "..", workspaceName);
  if (fs.existsSync(path.join(workspace, "package.json"))) return fs.realpathSync(workspace);
  throw new Error(`Could not resolve @earendil-works/${packageName} from ${piPackageRoot}`);
}

const jitiEntry = require.resolve("jiti", { paths: [piPackageRoot] });
const jitiModule = require(jitiEntry);
const createJiti = jitiModule.createJiti || jitiModule;
const typeboxEntry = require.resolve("typebox", { paths: [piPackageRoot] });
const aiPackageRoot = resolveRuntimePackage("pi-ai", "ai");
const aliases = {
  typebox: typeboxEntry,
  "@earendil-works/pi-coding-agent": piPackageRoot,
  // jiti's exact package alias does not resolve exported subpaths. Keep the
  // subpaths Pi's extension loader aliases (compat for custom-compaction
  // extensions, providers/all for multi-login's provider aliases).
  "@earendil-works/pi-ai/compat": path.join(aiPackageRoot, "dist", "compat.js"),
  "@earendil-works/pi-ai/providers/all": path.join(aiPackageRoot, "dist", "providers", "all.js"),
  "@earendil-works/pi-ai": aiPackageRoot,
  "@earendil-works/pi-tui": resolveRuntimePackage("pi-tui", "tui"),
  "@earendil-works/pi-agent-core": resolveRuntimePackage("pi-agent-core", "agent"),
};

function extensionEntries() {
  const entries = [];
  for (const root of [path.resolve(".pi", "extensions"), path.resolve("extensions")]) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, "index.ts");
      if (fs.existsSync(file)) entries.push({ name: `${path.basename(root)}/${name}`, file });
    }
  }
  return entries;
}

const COMMAND_ONLY_MODEL_TOOLS = {
  "extensions/output-compactor": "output_compactor",
};

function stubPi(registered, events = { on: () => {}, off: () => {}, emit: () => {} }) {
  const noop = () => {};
  registered.hooks ||= [];
  registered.commandDefs ||= {};
  registered.toolDefs ||= [];
  registered.activeTools ||= [];
  return {
    registerCommand: (name, definition) => { registered.commands.push(name); registered.commandDefs[name] = definition; },
    getCommands: () => registered.commands.map(name => ({ name, source: "extension" })),
    registerTool: (def) => { registered.tools.push(def?.name); registered.toolDefs.push(def); },
    getAllTools: () => [...new Set(["read", "grep", "find", "ls", "edit", "write", "bash", ...registered.tools])].map((name) => ({ name })),
    getActiveTools: () => [...registered.activeTools],
    setActiveTools: (names) => { registered.activeTools = [...names]; },
    registerShortcut: noop,
    registerMessageRenderer: noop,
    registerProvider: noop,
    registerVirtualModel: noop,
    on: (event, handler) => { registered.hooks.push({ event, handler }); },
    off: noop,
    events,
    system: { addSystemPrompt: noop },
    appendSystemPrompt: noop,
    sendUserMessage: noop,
    sendMessage: noop,
    setSessionName: noop,
    exec: async (command, args = [], options = {}) => {
      const result = spawnSync(command, args, { cwd: options.cwd, env: options.env || process.env, timeout: options.timeout, encoding: "utf8" });
      return { stdout: String(result.stdout || ""), stderr: String(result.stderr || result.error?.message || ""), code: result.status ?? (result.error ? 1 : 0), killed: Boolean(result.signal) };
    },
  };
}

(async () => {
  const entries = extensionEntries();
  assert.ok(entries.length >= 25, `expected to discover the extension fleet, found ${entries.length}`);
  const failures = [];
  const fleetToolNames = [];
  for (const { name, file } of entries) {
    const registered = { commands: [], tools: [] };
    try {
      const jiti = createJiti(file, { interopDefault: true, alias: aliases });
      const mod = await jiti.import(file);
      const fn = mod.default || mod;
      assert.equal(typeof fn, "function", "extension must export a default function");
      if (name === "extensions/prompt-suggestions") {
        const priorConfig = process.env.PI_PROMPT_SUGGESTIONS_CONFIG;
        const priorModel = process.env.PI_PROMPT_SUGGESTIONS_MODEL;
        process.env.PI_PROMPT_SUGGESTIONS_CONFIG = path.join(tmpFixture("pi-prompt-model-config-"), "prompt-suggestions.json");
        delete process.env.PI_PROMPT_SUGGESTIONS_MODEL;
        try {
          const failedPacket = await mod.requestPromptModelSuggestion({ getBranch: () => { throw new ReferenceError("packet context unavailable"); } }, process.cwd());
          assert.deepEqual(failedPacket, { ok: false, suggestion: null, outcome: "infrastructure-failed", reasonCode: "unknown" }, "prompt packet construction failures remain non-fatal without erasing categorical failure state");
          const notConfigured = await mod.requestPromptModelSuggestion({ getBranch: () => [{ message: { role: "user", content: "Inspect" } }, { message: { role: "assistant", content: "Next step: run tests" } }] }, process.cwd());
          assert.deepEqual(notConfigured, { ok: false, suggestion: null, outcome: "not-applicable", reasonCode: "model-not-configured" }, "an unset suggestion model skips refinement without a Hermes fallback");
          const cancelled = mod.suggestionFailure(Object.assign(new Error("cancelled"), { reasonCode: "cancelled" }));
          assert.deepEqual(cancelled, { ok: false, suggestion: null, outcome: "cancelled", reasonCode: "cancelled" }, "cancellation remains non-fatal and specifically classified");
          const timedOut = mod.suggestionFailure(Object.assign(new Error("timed out"), { code: "PROMPT_SUGGESTION_TIMEOUT", reasonCode: "timeout" }));
          assert.deepEqual(timedOut, { ok: false, suggestion: null, outcome: "timed-out", reasonCode: "timeout" }, "provider timeouts remain distinct from other failures");
        } finally {
          if (priorConfig === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_CONFIG;
          else process.env.PI_PROMPT_SUGGESTIONS_CONFIG = priorConfig;
          if (priorModel === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_MODEL;
          else process.env.PI_PROMPT_SUGGESTIONS_MODEL = priorModel;
        }
      }
      fn(stubPi(registered));
      const total = registered.commands.length + registered.tools.length;
      if (["extensions/git-evidence-courier", "extensions/verification-center"].includes(name)) {
        const fixture = tmpFixture("pi-security-checkpoint-tool-");
        const priorBin = process.env.PI_SEMGREP_BIN, priorAdvisory = process.env.PI_SEMGREP_ADVISORY;
        try {
          fs.mkdirSync(path.join(fixture, "src")); fs.mkdirSync(path.join(fixture, "tests")); fs.mkdirSync(path.join(fixture, ".pi"));
          fs.writeFileSync(path.join(fixture, ".gitignore"), ".pi/\n");
          fs.writeFileSync(path.join(fixture, ".semgrep.yml"), "rules: []\n");
          fs.writeFileSync(path.join(fixture, "src/auth.js"), "module.exports = true;\n");
          fs.writeFileSync(path.join(fixture, "tests/check.test.js"), "require('node:assert/strict').equal(require('../src/auth'), true);\n");
          const scanner = path.join(fixture, ".pi", "scanner");
          fs.writeFileSync(scanner, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'scan' && !process.argv.includes('--validate')) {
  fs.appendFileSync('.pi/scans', 'scan\\n');
  console.log(JSON.stringify({ results: [{ check_id: 'fixture.security', path: 'src/auth.js', start: { line: 1, col: 1 }, extra: { severity: 'WARNING', message: 'Review fixture finding' } }], errors: [] }));
}
`);
          fs.chmodSync(scanner, 0o755);
          for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "-qm", "fixture"]]) assert.equal(spawnSync("git", args, { cwd: fixture }).status, 0);
          fs.appendFileSync(path.join(fixture, "src/auth.js"), "// changed\n");
          process.env.PI_SEMGREP_BIN = scanner; process.env.PI_SEMGREP_ADVISORY = "0";
          const courier = name === "extensions/git-evidence-courier";
          const tool = registered.toolDefs.find(row => row.name === (courier ? "gitverify" : "verification_center"));
          const input = { files: ["src/auth.js"], commands: [{ id: "fixture", kind: "unit", command: "node", args: ["tests/check.test.js"] }] };
          if (!courier) {
            const plan = await tool.execute("security-plan", { operation: "plan", profile: "changed", input }, undefined, undefined, { cwd: fixture });
            assert.equal(plan.details.security.applicable, true);
            assert(!fs.existsSync(path.join(fixture, ".pi/scans")), "verification planning never scans");
          }
          const result = await tool.execute("security-checkpoint", courier ? {} : { operation: "run", profile: "changed", input }, undefined, undefined, { cwd: fixture });
          const checkpoint = courier ? result.details.security : result.details.evidence.semgrep;
          assert.equal(checkpoint.status, "findings");
          assert.equal(checkpoint.semgrep.findings[0].checkId, "fixture.security");
          assert.equal(checkpoint.gatingSafe, false);
          assert.match(result.content[0].text, /Semgrep security checkpoint: findings/);
          assert.match(result.content[0].text, /fixture.security/);
          assert.equal(courier ? result.details.ok : result.details.evidence.ok, true, "optional findings do not overwrite baseline verifier outcomes");
          assert.equal(fs.readFileSync(path.join(fixture, ".pi/scans"), "utf8").trim().split("\n").length, 1);
          if (!courier) {
            process.env.PI_SEMGREP_BIN = path.join(fixture, "missing-scanner");
            const required = await tool.execute("required-security", { operation: "run", profile: "changed", input: { ...input, requiredProviders: ["semgrep"] } }, undefined, undefined, { cwd: fixture });
            assert.equal(required.details.evidence.semgrep.readiness.blocking, true);
            assert.equal(required.details.evidence.ok, false, "explicitly required provider absence blocks verification");
            const optional = await tool.execute("optional-security", { operation: "run", profile: "changed", input }, undefined, undefined, { cwd: fixture });
            assert.equal(optional.details.evidence.semgrep.status, "unavailable");
            assert.equal(optional.details.evidence.ok, true, "optional scanner absence does not suppress or fail baseline verifiers");
          }
        } finally {
          if (priorBin == null) delete process.env.PI_SEMGREP_BIN; else process.env.PI_SEMGREP_BIN = priorBin;
          if (priorAdvisory == null) delete process.env.PI_SEMGREP_ADVISORY; else process.env.PI_SEMGREP_ADVISORY = priorAdvisory;
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      }
      if (name === ".pi/extensions/output-compactor") {
        // The compactor must actually rewrite oversized builtin-tool results,
        // not merely carry a policy table.
        const fixture = tmpFixture("pi-output-compactor-");
        const ctx = { cwd: fixture, hasUI: false, ui: { notify: () => {} }, sessionManager: { getSessionId: () => "fixture-session" } };
        const hook = registered.hooks.find((row) => row.event === "tool_result").handler;
        const readText = Array.from({ length: 400 }, (_, index) => `line ${index + 1} ${"x".repeat(80)}`).join("\n");
        const readResult = await hook({ toolName: "read", toolCallId: "call-1", input: { path: "src/big.js", offset: 1 }, content: [{ type: "text", text: readText }], details: {}, isError: false }, ctx);
        assert(readResult?.content?.[0]?.text?.length < readText.length, "oversized read output is bounded");
        assert.match(readResult.content[0].text, /continue with read path=src\/big\.js offset=/);
        const bashText = `${"noise\n".repeat(2000)}ERROR: real failure`;
        const bashResult = await hook({ toolName: "bash", toolCallId: "call-2", input: { command: "make" }, content: [{ type: "text", text: bashText }], details: {}, isError: false }, ctx);
        assert(bashResult?.content?.[0]?.text?.trimEnd().endsWith("ERROR: real failure"), "tail bounding keeps the failure");
        const exempt = await hook({ toolName: "read", toolCallId: "call-3", input: { path: "src/big.js", verbose: true }, content: [{ type: "text", text: readText }], details: {}, isError: false }, ctx);
        assert.equal(exempt, undefined, "explicit verbose requests are never rewritten");
        const nested = await hook({ toolName: "read", toolCallId: "call-4", parentToolCallId: "parent", input: { path: "src/big.js" }, content: [{ type: "text", text: readText }], details: {}, isError: false }, ctx);
        assert.equal(nested, undefined, "nested codemode calls keep canonical data");
        fs.rmSync(fixture, { recursive: true, force: true });
      }
      if (name === "extensions/policy-enforcer") {
        const fixture = tmpFixture("pi-policy-directory-command-");
        const cwd = path.join(fixture, "source");
        const friend = path.join(fixture, "friend with spaces");
        for (const dir of [cwd, friend]) fs.mkdirSync(dir);
        const notices = [];
        const ctx = { cwd, hasUI: false, ui: { notify: (message, level) => notices.push({ message, level }) } };
        const command = (name, args = "") => registered.commandDefs[name].handler(args, ctx);
        const hook = registered.hooks.find((row) => row.event === "tool_call").handler;
        const event = { toolName: "edit", input: { path: path.join(friend, "new", "file.txt"), edits: [] } };
        const policyTool = registered.toolDefs.find((row) => row.name === "policy_enforcer");
        try {
          await command("policy-mode", "block");
          assert.equal((await hook(event, ctx)).block, true);
          assert.equal(await command("policy-approve-directory", JSON.stringify(friend)), undefined, "Pi commands fulfill Promise<void>");
          const approved = JSON.parse(notices.at(-1).message);
          assert.equal(approved.approval.expiresAt, null, "command creates a permanent grant");
          assert.equal(await hook(event, ctx), undefined, "live hook honors recursive write/edit grants");
          const checked = await policyTool.execute("directory-check", { operation: "check", input: { toolName: event.toolName, input: event.input } }, undefined, undefined, ctx);
          assert.equal(checked.details.allow, true, "tool check agrees with the active hook");
          await command("policy-approvals");
          assert(notices.at(-1).message.includes(approved.approval.key));
          await assert.rejects(() => policyTool.execute("directory-grant", { operation: "approve", input: { request: approved.approval.request } }, undefined, undefined, ctx), /Use \/policy-approve-directory/);

          const policyDir = path.join(cwd, ".pi", "policy-gate");
          fs.mkdirSync(policyDir, { recursive: true });
          const protectedDir = path.join(friend, "private");
          fs.writeFileSync(path.join(policyDir, "policy.json"), JSON.stringify({ denyPathPrefixes: [protectedDir] }));
          const protectedEvent = { toolName: "write", input: { path: path.join(protectedDir, "secret.txt") } };
          assert.equal((await hook(protectedEvent, ctx)).block, true, "live hook retains project deny prefixes");
          const protectedCheck = await policyTool.execute("protected-check", { operation: "check", input: { toolName: protectedEvent.toolName, input: protectedEvent.input } }, undefined, undefined, ctx);
          assert.equal(protectedCheck.details.allow, false);
          assert.equal(await hook(event, ctx), undefined, "unprotected descendants remain allowed");

          await command("policy-revoke", approved.approval.key);
          assert.equal((await hook(event, ctx)).block, true);
          await command("policy-approve-directory", `'${friend}'`);
          const singleQuoted = JSON.parse(notices.at(-1).message);
          await command("policy-revoke", singleQuoted.approval.key);
          for (const invalid of ["", '"unterminated', JSON.stringify([friend]), path.join(fixture, "missing")]) {
            await assert.rejects(() => command("policy-approve-directory", invalid));
          }
          const state = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "policy-enforcer", "approvals.json"), "utf8"));
          assert.deepEqual(state.approvals, [], "invalid commands create no authority");

          // pi-dash's phone answers in parallel with the desktop dialog; the first decision wins and the
          // phone's still-pending card is withdrawn. Without an answer surface the desktop dialog decides.
          const phoneFixture = tmpFixture("pi-policy-phone-approval-");
          const emitted = [];
          const desktop = { calls: 0, answer: () => new Promise(() => {}) };
          const phoneCtx = { cwd: phoneFixture, hasUI: true, ui: { notify() {}, confirm: () => { desktop.calls++; return desktop.answer(); } } };
          const phoneRegistered = { commands: [], tools: [] };
          const phoneApi = stubPi(phoneRegistered, {
            on: () => {},
            off: () => {},
            emit: (channel, data) => {
              emitted.push({ channel, data });
              if (channel !== "approval:request") return;
              if (phoneApi.offline) return;
              data.handled = true;
              setTimeout(() => data.respond(phoneApi.decision), 0);
            },
          });
          fn(phoneApi);
          const phoneHook = phoneRegistered.hooks.find((row) => row.event === "tool_call").handler;
          const risky = { toolName: "bash", input: { command: "rm -rf ." } };
          try {
            await phoneRegistered.commandDefs["policy-mode"].handler("approval", phoneCtx);
            phoneApi.decision = "accept";
            assert.equal(await phoneHook(risky, phoneCtx), undefined, "a phone acceptance allows the call");
            assert.equal(desktop.calls, 1, "the desktop dialog is offered at the same time");
            assert.equal(emitted.find((row) => row.channel === "approval:request").data.request.title, "Policy approval required");
            assert.equal(emitted.find((row) => row.channel === "approval:settle").data.id, emitted.find((row) => row.channel === "approval:request").data.request.id);
            assert.equal(JSON.parse(fs.readFileSync(path.join(phoneFixture, ".pi", "policy-enforcer", "approvals.json"), "utf8")).approvals.length, 1, "the acceptance grants the same 24h approval as the desktop");

            fs.rmSync(path.join(phoneFixture, ".pi", "policy-enforcer", "approvals.json"), { force: true });
            emitted.length = 0;
            phoneApi.decision = "deny";
            assert.equal((await phoneHook(risky, phoneCtx)).block, true, "a phone denial blocks the call");
            assert.equal(fs.existsSync(path.join(phoneFixture, ".pi", "policy-enforcer", "approvals.json")), false, "a denial records no approval");

            emitted.length = 0;
            phoneApi.offline = true;
            desktop.answer = async () => true;
            assert.equal(await phoneHook(risky, phoneCtx), undefined, "without an answer surface the desktop dialog decides");
            assert.equal(emitted.filter((row) => row.channel === "approval:settle").length, 0, "a request the bridge did not take is not withdrawn");
            emitted.length = 0;
            desktop.answer = async () => false;
            fs.rmSync(path.join(phoneFixture, ".pi", "policy-enforcer", "approvals.json"), { force: true });
            assert.equal((await phoneHook(risky, phoneCtx)).block, true, "a desktop denial still blocks the call");
          } finally {
            fs.rmSync(phoneFixture, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      }
      if (name === "extensions/prompt-suggestions") {
        const fixture = tmpFixture("pi-prompt-cancellation-");
        const priorConfig = process.env.PI_PROMPT_SUGGESTIONS_CONFIG;
        const priorModel = process.env.PI_PROMPT_SUGGESTIONS_MODEL;
        process.env.PI_PROMPT_SUGGESTIONS_CONFIG = path.join(fixture, "prompt-suggestions.json");
        delete process.env.PI_PROMPT_SUGGESTIONS_MODEL;
        fs.writeFileSync(process.env.PI_PROMPT_SUGGESTIONS_CONFIG, JSON.stringify({ schemaVersion: 1, provider: "fixture", modelId: "suggestion" }));
        let editor;
        let leaf = 0;
        let idle = true;
        const pending = [];
        const suggestionModel = { provider: "fixture", id: "suggestion" };
        const registry = {
          find: (provider, modelId) => provider === suggestionModel.provider && modelId === suggestionModel.id ? suggestionModel : undefined,
          hasConfiguredAuth: () => true,
          complete: (_model, _context, options) => new Promise((resolve) => pending.push({ signal: options.signal, resolve })),
        };
        const hook = (event) => registered.hooks.find((row) => row.event === event).handler;
        const ctx = {
          cwd: fixture,
          isIdle: () => idle,
          modelRegistry: registry,
          sessionManager: { getLeafId: () => String(leaf), getBranch: () => [
            { message: { role: "user", content: "Inspect the project" } },
            { message: { role: "assistant", content: "Next step: inspect the next task" } },
          ] },
          ui: { setEditorComponent: (factory) => {
            editor = factory({ requestRender() {}, terminal: { rows: 45, columns: 120 } }, { borderColor: (text) => text }, { matches: () => false });
          } },
        };
        try {
          hook("session_start")({}, ctx);
          hook("agent_settled")({}, ctx);
          assert.equal(pending.length, 1);
          assert.equal(editor.status().source, "local", "local guidance is immediate while the configured model remains unresolved");
          editor.precomputeEmptyPromptSuggestion();
          assert.equal(pending.length, 1, "deadline-free work stays deduplicated per idle state");
          editor.handleInput("\u001b");
          assert.equal(pending[0].signal.aborted, true, "dismissal cancels unbounded refinement immediately");
          editor.handleInput("\u0012");
          assert.equal(pending.length, 2, "retry starts immediately without a cooldown");
          pending[0].resolve({ stopReason: "stop", content: [{ type: "text", text: "An obsolete suggestion" }] });
          await new Promise(setImmediate);
          assert.equal(editor.status().inFlight, true, "late cancelled results cannot clear the replacement request");
          assert.equal(editor.status().source, "local");
          editor.handleInput("\t");
          assert.equal(editor.getText(), "inspect the next task");
          assert.equal(pending[1].signal.aborted, true, "acceptance cancels unused provider work");
          editor.setText("");
          leaf++;
          editor.precomputeEmptyPromptSuggestion();
          editor.handleInput("x");
          assert.equal(pending[2].signal.aborted, true, "typing cancels without waiting for another render");
          editor.setText("");
          leaf++;
          editor.precomputeEmptyPromptSuggestion();
          idle = false;
          hook("before_agent_start")({}, ctx);
          assert.equal(pending[3].signal.aborted, true, "a new agent turn cancels unbounded refinement");
          editor.precomputeEmptyPromptSuggestion();
          assert.equal(pending.length, 4, "working sessions do not schedule suggestions");
          idle = true;
          leaf++;
          hook("agent_settled")({}, ctx);
          assert.equal(pending.length, 5);
          editor.setText("/prompt-suggestions");
          editor.onSubmit = () => editor.setText("");
          editor.handleInput("\r");
          assert.equal(pending[4].signal.aborted, true, "submission cancels work before the submit handler runs");
          assert.equal(editor.status().idle, true, "commands handled without agent turns cannot leave a timed submission lock");
          assert(editor.render(120).some(line => line.startsWith("↳ ")), "no-turn commands preserve the suggestion without manual retry");
          assert.equal(pending.length, 5, "no-turn commands reuse the cached suggestion");
          leaf++;
          editor.handleInput("\u0012"); // Explicit retry still requests a fresh refinement.
          assert.equal(pending.length, 6);
          hook("session_shutdown")({}, ctx);
          assert.equal(pending[5].signal.aborted, true, "shutdown/reload cancels unbounded refinement");
          for (const request of pending) request.resolve({ stopReason: "stop", content: [{ type: "text", text: "A stale result" }] });
          await new Promise(setImmediate);
          assert.equal(editor.status().source, "local", "late results after shutdown never replace the local cache");
          ctx.sessionManager.getBranch = () => [{ message: { role: "user", content: "Inspect the project" } }];
          hook("session_start")({}, ctx);
          editor.precomputeEmptyPromptSuggestion();
          assert.equal(pending.length, 7);
          assert.equal(editor.status().hasSuggestion, false);
          assert.equal(editor.status().inFlight, true);
          editor.handleInput("\u001b");
          assert.equal(pending[6].signal.aborted, true, "Escape also cancels a pending-only indicator without a local suggestion");
          pending[6].resolve({ stopReason: "stop", content: [{ type: "text", text: "A dismissed late result" }] });
          await new Promise(setImmediate);
          assert.equal(editor.status().hasSuggestion, false);
        } finally {
          hook("session_shutdown")({}, ctx);
          if (priorConfig === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_CONFIG;
          else process.env.PI_PROMPT_SUGGESTIONS_CONFIG = priorConfig;
          if (priorModel === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_MODEL;
          else process.env.PI_PROMPT_SUGGESTIONS_MODEL = priorModel;
          fs.rmSync(fixture, { recursive: true, force: true });
        }
      }
      if (name === "extensions/git-evidence-courier") {
        const fixture = tmpFixture("pi-git-evidence-parity-");
        execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: fixture });
        fs.writeFileSync(path.join(fixture, "tracked.txt"), "base\n");
        fs.writeFileSync(path.join(fixture, "rename-me.txt"), "base\n");
        execSync("git add -A && git commit -qm base", { cwd: fixture });
        fs.writeFileSync(path.join(fixture, "tracked.txt"), "changed\n");
        execSync("git mv rename-me.txt renamed.txt", { cwd: fixture });
        for (let index = 0; index < 18; index++) fs.writeFileSync(path.join(fixture, `new-${index}.txt`), "x\n");
        const repoContext = buildRepoContext(fixture);
        const evidenceTool = registered.toolDefs.find((tool) => tool.name === "gitevidence");
        const evidence = await evidenceTool.execute("evidence", {}, undefined, undefined, { cwd: fixture });
        assert.equal(evidence.details.totalChanged, repoContext.git.totalChanged, "Repo Context and Git Evidence agree on the complete changed-path count");
        assert.equal(repoContext.git.totalChanged, 20);
        assert.equal(repoContext.git.shownChanged, 15);

        const isolatedFixture = tmpFixture("pi-gitverify-postgres-");
        execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: isolatedFixture });
        fs.mkdirSync(path.join(isolatedFixture, "prisma"));
        fs.writeFileSync(path.join(isolatedFixture, "package.json"), '{"scripts":{"test":"node --test"}}\n');
        fs.writeFileSync(path.join(isolatedFixture, "prisma", "schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
        execSync("git add -A && git commit -qm base", { cwd: isolatedFixture });

        const isolationCalls = [];
        const isolatedRegistered = { commands: [], tools: [] };
        const isolatedPi = stubPi(isolatedRegistered);
        const localExec = isolatedPi.exec;
        const resources = { container: false, volume: false };
        isolatedPi.exec = async (command, args = [], options = {}) => {
          isolationCalls.push({ command, args: [...args] });
          if (command === "docker") {
            const operation = args[0];
            if (operation === "info") return { stdout: "27.0.0\n", stderr: "", code: 0, killed: false };
            if (operation === "volume") {
              assert.ok(["create", "inspect", "rm"].includes(args[1]), `unexpected volume operation: ${args[1]}`);
              if (args[1] === "create") resources.volume = true;
              if (args[1] === "rm") resources.volume = false;
              if (args[1] === "inspect" && !resources.volume) return { stdout: "", stderr: "No such volume", code: 1, killed: false };
              return { stdout: args[1] === "inspect" ? "isolated\n" : `${args.at(-1)}\n`, stderr: "", code: 0, killed: false };
            }
            if (operation === "run") {
              resources.container = true;
              return { stdout: "isolated-container-id\n", stderr: "", code: 0, killed: false };
            }
            if (operation === "port") return { stdout: "127.0.0.1:49152\n", stderr: "", code: 0, killed: false };
            if (operation === "exec") return { stdout: "gitverify_test accepting connections\n", stderr: "", code: 0, killed: false };
            if (operation === "inspect") return resources.container
              ? { stdout: "isolated\n", stderr: "", code: 0, killed: false }
              : { stdout: "", stderr: "No such container", code: 1, killed: false };
            if (operation === "stop") {
              resources.container = false;
              return { stdout: `${args.at(-1)}\n`, stderr: "", code: 0, killed: false };
            }
            throw new Error(`unexpected Docker operation: ${operation}`);
          }
          if (command === "env") {
            const shellPosition = args.indexOf("sh");
            const verifyCommand = shellPosition >= 0 ? args[shellPosition + 2] : "";
            if (String(verifyCommand).startsWith("npm ")) {
              const testUrl = args.find((entry) => entry.startsWith("TEST_DATABASE_URL="))?.slice("TEST_DATABASE_URL=".length) ?? "";
              return { stdout: verifyCommand === "npm test --if-present" ? `database=${testUrl}\n` : "ok\n", stderr: "", code: 0, killed: false };
            }
          }
          return localExec(command, args, options);
        };
        fn(isolatedPi);
        const verifyTool = isolatedRegistered.toolDefs.find((tool) => tool.name === "gitverify");
        const verification = await verifyTool.execute("verify", {}, undefined, undefined, { cwd: isolatedFixture });
        assert.equal(verification.details.ok, true);
        assert.equal(verification.details.isolatedPostgres.provisioned, true);
        assert.equal(verification.details.isolatedPostgres.loopbackPort, 49152);
        assert.equal(verification.details.isolatedPostgres.cleanup, "removed");
        const npmTestCall = isolationCalls.find((call) => call.command === "env" && call.args.at(-1) === "npm test --if-present");
        assert.ok(npmTestCall, "npm test runs with isolated database environment variables");
        const shellPosition = npmTestCall.args.indexOf("sh");
        const assignments = Object.fromEntries(npmTestCall.args.slice(0, shellPosition).map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
        assert.match(assignments.TEST_DATABASE_URL, /^postgresql:\/\/gitverify:[a-f0-9]+@127\.0\.0\.1:49152\/gitverify_test$/);
        assert.equal(assignments.DATABASE_URL, assignments.TEST_DATABASE_URL);
        assert.equal(assignments.DIRECT_DATABASE_URL, assignments.TEST_DATABASE_URL);
        const generatedPassword = new URL(assignments.TEST_DATABASE_URL).password;
        assert.ok(!verification.content[0].text.includes(assignments.TEST_DATABASE_URL), "verification report redacts a database URL emitted by a verifier");
        assert.ok(!verification.content[0].text.includes(generatedPassword), "verification report redacts the generated database password");
        assert.ok(!JSON.stringify(verification.details).includes(assignments.TEST_DATABASE_URL), "verification details redact a database URL emitted by a verifier");
        assert.ok(!JSON.stringify(verification.details).includes(generatedPassword), "verification details redact the generated database password");
        assert.ok(!isolationCalls.some((call) => call.args.includes("compose")), "gitverify never invokes repository Compose services");
        const runtimeCalls = isolationCalls.filter((call) => call.command === "docker");
        assert.deepEqual(runtimeCalls.at(-2).args.slice(0, 2), ["volume", "rm"], "owned volume removal follows container cleanup");
        assert.deepEqual(runtimeCalls.at(-1).args.slice(0, 2), ["volume", "inspect"], "final runtime operation confirms volume absence");
        assert.deepEqual(resources, { container: false, volume: false }, "both isolated resources are removed");
      }
      if (name === "extensions/roadmap") {
        const fixture = tmpFixture("pi-roadmap-tool-");
        const roadmapTool = registered.toolDefs.find((tool) => tool.name === "roadmap_update");
        const ctx = { cwd: fixture, hasUI: false };
        const beforeAgentStart = registered.hooks.find((hook) => hook.event === "before_agent_start")?.handler;
        assert.equal(typeof beforeAgentStart, "function", "Roadmap must own standalone activation instead of depending on a topology planner");
        registered.activeTools = ["roadmap_update"];
        const promptEvent = { prompt: "Investigate the regression and fix it", systemPrompt: "Chained parent instructions" };
        const routerModule = await jiti.import(path.resolve("extensions/tool-surface-router/index.ts"));
        for (const restricted of [false, true]) {
          const combined = { commands: [], tools: [], activeTools: [] };
          const combinedPi = stubPi(combined);
          fn(combinedPi);
          (routerModule.default || routerModule)(combinedPi);
          combined.activeTools = restricted ? ["read"] : combinedPi.getAllTools().map((tool) => tool.name);
          const emit = async (event, data) => {
            let result;
            for (const hook of combined.hooks.filter((hook) => hook.event === event)) result = await hook.handler(data, ctx) || result;
            return result;
          };
          await emit("session_start", {});
          for (const prompt of [promptEvent.prompt, "Continue", "Review then commit our changes"]) {
            await emit("input", { text: prompt, source: "interactive" });
            const result = await emit("before_agent_start", { ...promptEvent, prompt });
            if (restricted) assert.equal(result, undefined, "the combined lifecycle preserves child-role tool restrictions");
            else assert.match(result?.systemPrompt || "", /roadmap_update action=start/, "the default router must not suppress standalone guidance on ordinary tasks or follow-ups");
          }
        }
        const originalAutoRoute = process.env.PI_TOPOLOGY_AUTO_ROUTE;
        try {
          let standalonePrompt;
          for (const mode of ["off", "delegate"]) {
            process.env.PI_TOPOLOGY_AUTO_ROUTE = mode;
            const result = await beforeAgentStart(promptEvent, ctx);
            assert(result.systemPrompt.startsWith(promptEvent.systemPrompt), "roadmap guidance preserves earlier system instructions");
            assert.match(result.systemPrompt, /roadmap_update action=start.*milestones/);
            assert.match(result.systemPrompt, /multi-step/);
            assert.match(result.systemPrompt, /simple|one-step/i, "trivial requests are exempt from planning overhead");
            assert.match(result.systemPrompt, /No roadmap active/);
            if (standalonePrompt) assert.equal(result.systemPrompt, standalonePrompt, "standalone activation is independent of topology mode");
            standalonePrompt = result.systemPrompt;
            assert.equal(fs.existsSync(path.join(fixture, ".pi", "roadmap", "active.json")), false, "guidance never fabricates a model plan");
          }
          registered.activeTools = ["read"];
          assert.equal(await beforeAgentStart(promptEvent, ctx), undefined, "disabled roadmap tools and restricted roles receive no mutation instructions");
        } finally {
          if (originalAutoRoute === undefined) delete process.env.PI_TOPOLOGY_AUTO_ROUTE;
          else process.env.PI_TOPOLOGY_AUTO_ROUTE = originalAutoRoute;
          registered.activeTools = ["roadmap_update"];
        }
        assert.match(roadmapTool.promptGuidelines.join("\n"), /proactively.*multi-step/i);
        assert.match(roadmapTool.promptGuidelines.join("\n"), /leave unstarted work pending.*blocked\/paused only for actual blockers or pauses/, "pending work must not become nonactionable just because it is incomplete");
        assert.doesNotMatch(roadmapTool.promptGuidelines.join("\n"), /Use roadmap_update when the user asks to track/, "explicit tracking requests are not the only activation trigger");
        const rootResult = await roadmapTool.execute("root", { action: "start", title: "Root", items: ["Implement"] }, undefined, undefined, ctx);
        assert.equal(rootResult.details.delta.changedRoadmap.nested, false);
        assert.equal(rootResult.details.fullState, false, "ordinary mutations return compact envelopes rather than full state");
        const nestedResult = await roadmapTool.execute("nested", { action: "start", title: "Verify", items: ["Run checks"] }, undefined, undefined, ctx);
        assert.equal(nestedResult.details.delta.changedRoadmap.nested, true);
        assert.equal(nestedResult.details.delta.changedRoadmap.parentRoadmapId, rootResult.details.roadmap.id);
        const planResult = await roadmapTool.execute("plan", { action: "replace", title: "Executable plan", milestones: [{ title: "Phase 0", goals: ["Baseline", "Bars"] }, { title: "Phase 1", goals: ["Implement"] }] }, undefined, undefined, ctx);
        const planState = JSON.parse(fs.readFileSync(path.join(fixture, ".pi", "roadmap", "active.json"), "utf8"));
        assert.equal(planState.items.length, 2, "plan milestones become root tasks in one operation");
        assert.equal(planState.items[0].subtasks[0].items[0].title, "Baseline", "milestone goals become nested items");
        const staleResult = await roadmapTool.execute("stale", { action: "set_status", itemId: "missing", status: "done" }, undefined, undefined, ctx);
        assert.equal(staleResult.details.error.code, "ROADMAP_STALE_ITEM");
        const invalidResult = await roadmapTool.execute("invalid", { action: "unsupported" }, undefined, undefined, ctx);
        assert.equal(invalidResult.details.error.code, "ROADMAP_INVALID_OPERATION");
        const replacement = await roadmapTool.execute("replace", { action: "replace", title: "Explicit new root", items: ["Next"] }, undefined, undefined, ctx);
        assert.equal(replacement.details.delta.changedRoadmap.nested, false);
        assert.notEqual(replacement.details.roadmap.id, rootResult.details.roadmap.id);
        const fabricatedVerification = await roadmapTool.execute("fake-evidence", { action: "set_status", itemId: "1", status: "verified", evidenceId: "fabricated-proof" }, undefined, undefined, ctx);
        assert.equal(fabricatedVerification.details.error.code, "ROADMAP_INVALID_EVIDENCE", "fabricated IDs cannot substantiate roadmap verification");
        const evidenceStore = new EvidenceStore({ cwd: fixture });
        const packet = evidenceStore.saveEvidence(createEvidencePacket({ id: "evidence_extension_pass", source: "extension-load", ok: true, commands: ["node tests/extension-load.test.js"], summary: "focused extension verification passed" }));
        const substantiatedVerification = await roadmapTool.execute("real-evidence", { action: "set_status", itemId: "1", status: "verified", evidenceId: packet.id }, undefined, undefined, ctx);
        assert.equal(substantiatedVerification.details.delta.changed[0].status, "verified", "registered passing evidence authorizes verified status");
        applyRoadmapPlan({ cwd: fixture, runId: "toprun-extension-reload", roadmapPlan: { title: "Externally applied topology plan", milestones: [{ title: "External phase", goals: ["External goal"] }] } });
        const externallyReloaded = await roadmapTool.execute("show-external", { action: "show" }, undefined, undefined, ctx);
        assert.match(externallyReloaded.content[0].text, /Externally applied topology plan/, "roadmap extension reloads parent topology applications instead of overwriting them from stale memory");
        const statePath = path.join(fixture, ".pi", "roadmap", "active.json");
        const savedState = fs.readFileSync(statePath, "utf8");
        const activePrompt = await beforeAgentStart(promptEvent, ctx);
        assert.match(activePrompt.systemPrompt, /Externally applied topology plan/);
        assert.match(activePrompt.systemPrompt, /External goal/);
        assert.match(activePrompt.systemPrompt, /do not start a duplicate/i);
        assert.match(activePrompt.systemPrompt, /before.*final response/i, "standalone continuation includes settlement responsibility");
        assert.match(activePrompt.systemPrompt, /within the current task's scope/, "a new request must not prompt indiscriminate updates of earlier work");
        assert.match(activePrompt.systemPrompt, /leave unstarted work pending/, "per-turn guidance preserves future actionable work");
        assert.equal(fs.readFileSync(statePath, "utf8"), savedState, "headless per-turn context does not mutate previous session state");
        await roadmapTool.execute("block", { action: "set_status", itemId: "1.1.1", status: "blocked", note: "External dependency" }, undefined, undefined, ctx);
        const blockedPrompt = await beforeAgentStart(promptEvent, ctx);
        assert.match(blockedPrompt.systemPrompt, /active: none/);
        assert.match(blockedPrompt.systemPrompt, /parentId|close.*shelve/, "blocked-only state must not suggest an automatic nesting parent");
        await roadmapTool.execute("shelve", { action: "shelve" }, undefined, undefined, ctx);
        const shelvedPrompt = await beforeAgentStart(promptEvent, ctx);
        assert.match(shelvedPrompt.systemPrompt, /lifecycle: shelved/);
        assert.match(shelvedPrompt.systemPrompt, /resume/i);
        const freshRegistration = { commands: [], tools: [], activeTools: ["roadmap_update"] };
        fn(stubPi(freshRegistration));
        const reloadedPrompt = await freshRegistration.hooks.find((hook) => hook.event === "before_agent_start").handler(promptEvent, ctx);
        assert.equal(reloadedPrompt.systemPrompt, shelvedPrompt.systemPrompt, "fresh sessions recover persisted roadmap context without a topology handoff");
        applyRoadmapPlan({ cwd: fixture, runId: "toprun-context-reload", roadmapPlan: { title: "Fresh external plan", milestones: [{ title: "New phase", goals: ["New goal"] }] } });
        const externalPrompt = await beforeAgentStart(promptEvent, ctx);
        assert.match(externalPrompt.systemPrompt, /Fresh external plan/, "the turn hook reloads external writes without a preceding roadmap tool call");
        await roadmapTool.execute("large", { action: "replace", title: "Large plan", items: Array.from({ length: 500 }, (_, i) => `Item ${i + 1} ${"x".repeat(180)}`) }, undefined, undefined, ctx);
        await roadmapTool.execute("last", { action: "active", itemId: "500" }, undefined, undefined, ctx);
        const largePrompt = await beforeAgentStart(promptEvent, ctx);
        assert(largePrompt.systemPrompt.length < 3000, "automatic context is bounded independently of roadmap size");
        assert.match(largePrompt.systemPrompt, /Item 500/, "bounded context retains the active scope rather than only the first page");
        await roadmapTool.execute("clear", { action: "clear" }, undefined, undefined, ctx);
        assert.match((await beforeAgentStart(promptEvent, ctx)).systemPrompt, /No roadmap active/, "cleared state is not reinjected from cache");

        // Concurrent sessions in one directory own independent roadmaps and can
        // explicitly adopt earlier work instead of overwriting it.
        const sessionCtx = (sessionId) => ({ cwd: fixture, hasUI: false, sessionManager: { getSessionId: () => sessionId } });
        const sessionOne = sessionCtx("session-one");
        const sessionTwo = sessionCtx("session-two");
        const sessionStartHook = registered.hooks.find((hook) => hook.event === "session_start").handler;
        await sessionStartHook({}, sessionOne);
        const sessionOnePlan = await roadmapTool.execute("session-one-plan", { action: "replace", title: "Session one plan", milestones: [{ title: "Phase", goals: ["Goal A", "Goal B"] }] }, undefined, undefined, sessionOne);
        const sessionBatch = await roadmapTool.execute("session-one-batch", { action: "set_status", itemIds: ["1"], status: "done", cascade: true }, undefined, undefined, sessionOne);
        assert.equal(sessionBatch.details.delta.changedCount, 3, "one batched call settles a milestone and its nested goals");
        await sessionStartHook({}, sessionTwo);
        const sessionTwoShow = await roadmapTool.execute("session-two-show", { action: "show" }, undefined, undefined, sessionTwo);
        assert.match(sessionTwoShow.content[0].text, /No roadmap active/, "a second session starts without the first session's roadmap");
        assert.match(sessionTwoShow.content[0].text, /Session one plan/, "an idle session discovers earlier roadmaps in the same directory");
        const adopted = await roadmapTool.execute("session-two-adopt", { action: "adopt", roadmapId: sessionOnePlan.details.roadmap.id }, undefined, undefined, sessionTwo);
        assert.equal(adopted.details.operation, "adopt");
        assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, ".pi", "roadmap", "sessions", "session-two", "active.json"), "utf8")).title, "Session one plan");
        assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, ".pi", "roadmap", "sessions", "session-one", "active.json"), "utf8")).title, "Session one plan", "adoption leaves the owning session's packet untouched");
        assert.equal(fs.existsSync(path.join(fixture, ".pi", "roadmap", "active.json")), false, "session roadmaps never populate the shared directory store");
        assert.match((await beforeAgentStart(promptEvent, sessionTwo)).systemPrompt, /Session one plan/, "the adopted roadmap is the session's canonical plan");
        // A scope change must be honored even without a fresh session_start;
        // resume/fork reuse this extension instance with a new session id.
        const sessionThree = sessionCtx("session-three");
        const unstartedShow = await roadmapTool.execute("session-three-show", { action: "show" }, undefined, undefined, sessionThree);
        assert.match(unstartedShow.content[0].text, /No roadmap active/, "a session id without a fresh session_start still gets its own empty store");
        assert.equal(unstartedShow.details.candidates.some((entry) => Object.prototype.hasOwnProperty.call(entry, "store")), false, "discovery results expose roadmap ids, not other sessions' store paths");
        const sessionTwoAgain = await roadmapTool.execute("session-two-again", { action: "show" }, undefined, undefined, sessionTwo);
        assert.match(sessionTwoAgain.content[0].text, /Session one plan/, "switching scope back reloads the owning session's roadmap instead of leaking another session's state");
      }
      if (name === "extensions/privacy-guard") {
        const fixture = tmpFixture("pi-privacy-global-");
        const project = path.join(fixture, "project");
        const stateRoot = path.join(project, ".pi", "session-mining");
        const sessionRoot = path.join(fixture, "sessions");
        fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(stateRoot, "latest.json"), "{}\n", { mode: 0o600 });
        fs.mkdirSync(path.join(sessionRoot, "project"), { recursive: true, mode: 0o755 });
        fs.chmodSync(sessionRoot, 0o755);
        fs.chmodSync(path.join(sessionRoot, "project"), 0o755);
        const sessionFile = path.join(sessionRoot, "project", "fixture.jsonl");
        fs.writeFileSync(sessionFile, "{}\n", { mode: 0o644 });
        fs.chmodSync(sessionFile, 0o644);
        const privacyTool = registered.toolDefs.find((tool) => tool.name === "privacy_guard");
        const unsafe = await privacyTool.execute("privacy", { operation: "scan", input: { roots: [stateRoot], rawSessionPermissions: true, sessionRoot } }, undefined, undefined, { cwd: project });
        assert.equal(unsafe.details.scope.rawSessionPermissions, true);
        assert.equal(unsafe.details.scope.contentReadFromRawSessions, false);
        assert.equal(unsafe.details.permissionPosture.nonPrivateFiles, 1);
        assert.equal(unsafe.details.permissionPosture.nonPrivateDirectories, 2);
        assert(unsafe.details.findings.some((finding) => finding.pattern === "unsafe-session-permissions"));
        assert.doesNotMatch(JSON.stringify(unsafe.details), new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "privacy results persist no raw project/session paths");
        fs.chmodSync(sessionRoot, 0o700);
        fs.chmodSync(path.join(sessionRoot, "project"), 0o700);
        fs.chmodSync(sessionFile, 0o600);
        const safe = await privacyTool.execute("privacy", { operation: "scan", input: { roots: [stateRoot], rawSessionPermissions: true, sessionRoot } }, undefined, undefined, { cwd: project });
        assert.equal(safe.details.permissionPosture.compliant, true);
        assert.equal(safe.details.ok, true);
        assert.equal(safe.details.coverage.identityHolds, true);
        const defaultCoverage = await privacyTool.execute("privacy-default-roots", { operation: "scan", input: {} }, undefined, undefined, { cwd: project });
        assert(defaultCoverage.details.rootStatus.some((row) => row.scope === "project-state:session-mining" && row.exists), "default scan covers available session-mining state");
        assert(defaultCoverage.details.rootStatus.some((row) => row.scope === "project-state:traces" && !row.exists), "default scan reports absent configured runtime roots explicitly");
        assert.equal(defaultCoverage.details.coverage.scopeComplete, true, "optional absent default roots do not imply skipped available state");
        const explicitMissing = await privacyTool.execute("privacy-missing-root", { operation: "scan", input: { roots: [stateRoot, path.join(project, ".pi", "missing-runtime-root")] } }, undefined, undefined, { cwd: project });
        assert.equal(explicitMissing.details.coverage.absentRoots, 1);
        assert.equal(explicitMissing.details.coverage.scopeComplete, false, "an absent explicitly requested root fails scope completeness truthfully");
        assert.equal(explicitMissing.details.ok, false);
        const explicitRaw = await privacyTool.execute("privacy-raw", { operation: "scan", input: { roots: [sessionRoot], sessionRoot } }, undefined, undefined, { cwd: project });
        assert.equal(explicitRaw.details.scope.contentReadFromRawSessions, true, "explicit raw-session roots are truthfully reported as content reads");
        assert.equal(explicitRaw.details.scope.rawSessionPermissions, false, "content scanning and permission posture remain separate scopes");
        const largeState = path.join(stateRoot, "large.json");
        fs.writeFileSync(largeState, `${"ab12".repeat(525_000)} sk-${"A".repeat(32)}\n`, { mode: 0o600 });
        const largeScan = await privacyTool.execute("privacy-large", { operation: "scan", input: { roots: [stateRoot] } }, undefined, undefined, { cwd: project });
        assert(largeScan.details.findings.some((finding) => finding.pattern === "openai-key"), "files above the old 2 MB cutoff are streamed and scanned");
        assert.equal(largeScan.details.coverage.discoveredFiles, 2);
        const boundedScan = await privacyTool.execute("privacy-bounded", { operation: "scan", input: { roots: [stateRoot], maxFiles: 1 } }, undefined, undefined, { cwd: project });
        assert.equal(boundedScan.details.coverage.complete, false);
        assert.equal(boundedScan.details.truncated, true, "explicit scan bounds cannot look complete");
        const snapshotRoot = path.join(project, ".pi", "session-branches", "snapshots"); fs.mkdirSync(snapshotRoot, { recursive: true });
        fs.writeFileSync(path.join(snapshotRoot, "large-snapshot.json"), `{"filesystemState":{"files":{".env":"redacted","safe.txt":"${"z".repeat(2_100_000)}"}},"metadata":{}}`, { mode: 0o600 });
        const snapshotScan = await privacyTool.execute("privacy-snapshot", { operation: "scan", input: { roots: [snapshotRoot] } }, undefined, undefined, { cwd: project });
        assert(snapshotScan.details.findings.some((finding) => finding.pattern === "private-snapshot-path"), "large branch snapshots are streamed while private recovery paths remain detectable");
        assert.equal(snapshotScan.details.coverage.complete, true);
        const sourceRoot = path.join(project, ".pi", "extensions", "fixture");
        fs.mkdirSync(sourceRoot, { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, "index.ts"), "const token = createContinuationToken();\n");
        const dynamicSource = await privacyTool.execute("privacy-source", { operation: "scan", input: { roots: [sourceRoot], includeSource: true, includeIgnored: true } }, undefined, undefined, { cwd: project });
        assert.equal(dynamicSource.details.ok, true, "dynamic source expressions are not hard-coded credentials");
        assert(dynamicSource.details.ignoredFindings.some((finding) => finding.pattern === "api-key-assignment" && finding.reason === "dynamic source expression, not a hard-coded credential literal"));
        fs.writeFileSync(path.join(sourceRoot, "literal.ts"), "const token = \"abcdefghijklmnopqrstuvwx\";\n");
        const literalSource = await privacyTool.execute("privacy-source-literal", { operation: "scan", input: { roots: [sourceRoot], includeSource: true } }, undefined, undefined, { cwd: project });
        assert.equal(literalSource.details.ok, false, "hard-coded credential-like source literals remain actionable");
        assert(literalSource.details.findings.some((finding) => finding.pattern === "api-key-assignment"));
      }
      if (name === "extensions/role-sidecar") {
        assert.equal(total, 0, "role sidecar must be inert without PI_ROLE_SIDECAR=1");
        const oldEnabled = process.env.PI_ROLE_SIDECAR;
        const oldContract = process.env.PI_ROLE_CONTRACT_B64;
        const oldParent = process.env.PI_SUBAGENT_PARENT_ID;
        const oldExpectedModel = process.env.PI_ROLE_EXPECTED_MODEL;
        const oldExpectedThinking = process.env.PI_ROLE_EXPECTED_THINKING_LEVEL;
        const contract = { schemaVersion: 2, contractVersion: "role-v2", roleId: "evidence-auditor", workspacePolicy: "shared-readonly", mutationPolicy: "forbidden", toolPolicy: { allowedTools: ["read", "grep", "find", "ls", "submit_role_result"], deniedTools: ["edit", "write", "bash", "role_diff", "role_verify"] }, modelPolicy: { mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" }, budget: { maxModelCalls: 6, maxToolCalls: 40, maxResultChars: 12000 }, outputSchema: ROLE_OUTPUT_SCHEMAS["evidence-auditor"], completionPolicy: { allowEmptySummary: false, minimumSummaryChars: 1, rejectedSummaries: ["placeholder", "todo", "tbd", "n/a", "none", "unknown"], requireEvidence: false, requireVerificationVerdict: false } };
        process.env.PI_ROLE_SIDECAR = "1";
        process.env.PI_ROLE_CONTRACT_B64 = Buffer.from(JSON.stringify(contract)).toString("base64url");
        process.env.PI_SUBAGENT_PARENT_ID = "sub_extension_load";
        process.env.PI_ROLE_EXPECTED_MODEL = "provider/role-test";
        process.env.PI_ROLE_EXPECTED_THINKING_LEVEL = "high";
        const sidecar = { commands: [], tools: [], toolDefs: [], hooks: [], activeTools: [] };
        const sidecarPi = stubPi(sidecar);
        const sidecarExecCalls = [];
        sidecarPi.exec = async (command, args = [], options = {}) => { sidecarExecCalls.push({ command, args, options }); return { stdout: "", stderr: "", code: 0, killed: false }; };
        let actionsLegal = false;
        const actionDuringLoad = () => { throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."); };
        sidecarPi.getAllTools = () => {
          if (!actionsLegal) return actionDuringLoad();
          return [...new Set(["read", "grep", "find", "ls", "edit", "write", "bash", ...sidecar.tools])].map((toolName) => ({ name: toolName }));
        };
        sidecarPi.setActiveTools = (names) => { if (!actionsLegal) return actionDuringLoad(); sidecar.activeTools = [...names]; };
        try {
          fn(sidecarPi);
          assert.deepEqual(sidecar.activeTools, [], "role-sidecar extension loading performs registration only");
          actionsLegal = true;
          const sessionStart = sidecar.hooks.find((hook) => hook.event === "session_start")?.handler;
          assert.equal(typeof sessionStart, "function", "role policy activation is deferred to session_start");
          await sessionStart({ type: "session_start", reason: "startup" }, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high" });
          assert.deepEqual(sidecar.activeTools, contract.toolPolicy.allowedTools);
          const beforeAgentStart = sidecar.hooks.find((hook) => hook.event === "before_agent_start")?.handler;
          const injectedPrompt = await beforeAgentStart({ systemPrompt: "base" }, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high" });
          assert.match(injectedPrompt.systemPrompt, /call submit_role_result once.*never more than once.*reserved model call/i, "the active model sees the single-submission and correction-reserve contract");

          process.env.PI_ROLE_CONTRACT_B64 = Buffer.from(JSON.stringify({ ...contract, budget: null })).toString("base64url");
          const unbudgeted = { commands: [], tools: [], toolDefs: [], hooks: [], activeTools: [] };
          fn(stubPi(unbudgeted));
          const inherited = { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high", cwd: process.cwd(), abort: () => assert.fail("no task call budget") };
          await unbudgeted.hooks.find(hook => hook.event === "session_start").handler({}, inherited);
          for (let count = 0; count < 100; count++) {
            await unbudgeted.hooks.find(hook => hook.event === "before_provider_request").handler({ payload: {} }, inherited);
            await unbudgeted.hooks.find(hook => hook.event === "turn_end").handler({}, inherited);
            assert.equal(await unbudgeted.hooks.find(hook => hook.event === "tool_call").handler({ toolName: "read", toolCallId: `unbudgeted-${count}`, input: { path: "README.md" } }, inherited), undefined);
          }
          assert(unbudgeted.activeTools.includes("read"), "unbudgeted execution never enters a forced submission phase");

          const missingContract = { ...contract, toolPolicy: { allowedTools: [...contract.toolPolicy.allowedTools, "missing_role_tool"], deniedTools: contract.toolPolicy.deniedTools } };
          process.env.PI_ROLE_CONTRACT_B64 = Buffer.from(JSON.stringify(missingContract)).toString("base64url");
          const missing = { commands: [], tools: [], toolDefs: [], hooks: [], activeTools: [] };
          const missingPi = stubPi(missing);
          let missingActionsLegal = false;
          const missingGetAllTools = missingPi.getAllTools;
          missingPi.getAllTools = () => { if (!missingActionsLegal) return actionDuringLoad(); return missingGetAllTools(); };
          missingPi.setActiveTools = (names) => { if (!missingActionsLegal) return actionDuringLoad(); missing.activeTools = [...names]; };
          fn(missingPi);
          missingActionsLegal = true;
          await assert.rejects(() => missing.hooks.find((hook) => hook.event === "session_start").handler({}, {}), /missing required role tools.*missing_role_tool/);
          const missingBeforeProvider = missing.hooks.find((hook) => hook.event === "before_provider_request").handler;
          let missingAborted = 0;
          await assert.rejects(() => missingBeforeProvider({ payload: {} }, { abort: () => { missingAborted += 1; } }), /tool policy was not activated/);
          assert.equal(missingAborted, 1, "an unavailable required tool aborts before provider execution");

          // A `*` allowlist entry (mcp__blender__*) must expand to the tools that
          // are actually registered in this child, never be reported as missing.
          const mcpContract = { ...contract, toolPolicy: { allowedTools: [...contract.toolPolicy.allowedTools, "mcp__blender__*"], deniedTools: contract.toolPolicy.deniedTools } };
          process.env.PI_ROLE_CONTRACT_B64 = Buffer.from(JSON.stringify(mcpContract)).toString("base64url");
          const mcpState = { commands: [], tools: [], toolDefs: [], hooks: [], activeTools: [] };
          const mcpPi = stubPi(mcpState);
          mcpPi.getAllTools = () => ["read", "grep", "find", "ls", "edit", "write", "bash", "role_diff", "role_domain", "submit_role_result", "mcp__blender__execute_blender_code", "mcp__other__tool"].map((name) => ({ name }));
          mcpPi.setActiveTools = (names) => { mcpState.activeTools = [...names]; };
          fn(mcpPi);
          await mcpState.hooks.find((hook) => hook.event === "session_start").handler({}, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high" });
          assert(mcpState.activeTools.includes("mcp__blender__execute_blender_code"), "the MCP pattern expands to its registered tools");
          assert(!mcpState.activeTools.includes("mcp__other__tool"), "the MCP pattern stays scoped to its own server");
          const mcpGate = mcpState.hooks.find((hook) => hook.event === "tool_call").handler;
          const mcpContext = { cwd: process.cwd(), model: { provider: "provider", id: "role-test" }, thinkingLevel: "high" };
          assert.equal(await mcpGate({ toolName: "mcp__blender__execute_blender_code", toolCallId: "mcp-allowed", input: { code: "print(1)" } }, mcpContext), undefined, "a tool matched by the pattern passes the call gate");
          assert.equal((await mcpGate({ toolName: "mcp__other__tool", toolCallId: "mcp-denied", input: {} }, mcpContext))?.block, true, "a tool outside the pattern is blocked");

          const malformedContract = { ...contract, toolPolicy: { allowedTools: [...contract.toolPolicy.allowedTools, "write"], deniedTools: contract.toolPolicy.deniedTools } };
          process.env.PI_ROLE_CONTRACT_B64 = Buffer.from(JSON.stringify(malformedContract)).toString("base64url");
          assert.throws(() => fn(stubPi({ commands: [], tools: [] })), /both allows and denies: write/);
        } finally {
          if (oldEnabled === undefined) delete process.env.PI_ROLE_SIDECAR; else process.env.PI_ROLE_SIDECAR = oldEnabled;
          if (oldContract === undefined) delete process.env.PI_ROLE_CONTRACT_B64; else process.env.PI_ROLE_CONTRACT_B64 = oldContract;
          if (oldParent === undefined) delete process.env.PI_SUBAGENT_PARENT_ID; else process.env.PI_SUBAGENT_PARENT_ID = oldParent;
          if (oldExpectedModel === undefined) delete process.env.PI_ROLE_EXPECTED_MODEL; else process.env.PI_ROLE_EXPECTED_MODEL = oldExpectedModel;
          if (oldExpectedThinking === undefined) delete process.env.PI_ROLE_EXPECTED_THINKING_LEVEL; else process.env.PI_ROLE_EXPECTED_THINKING_LEVEL = oldExpectedThinking;
        }
        assert.deepEqual(sidecar.tools.sort(), ["role_diff", "role_domain", "role_verify", "submit_role_result"], "the sidecar registers the contract-restricted domain tool without granting it to reviewers");
        await assert.rejects(() => sidecar.toolDefs.find(tool => tool.name === "role_domain").execute("denied-domain", { operation: "elf-headers", file: "README.md" }, undefined, undefined, { cwd: process.cwd() }), /SPECIALIST_OPERATION_DENIED/);
        const roleVerifyDefinition = sidecar.toolDefs.find((tool) => tool.name === "role_verify");
        assert.match(JSON.stringify(roleVerifyDefinition?.parameters), /parallel-evidence-benchmark/);
        assert.match(JSON.stringify(roleVerifyDefinition?.parameters), /check-all/, "the model-visible verifier schema publishes the required stable command IDs");
        await roleVerifyDefinition.execute("verify-clean-env", { commandId: "check-all" }, undefined, undefined, { cwd: process.cwd() });
        assert.equal(sidecarExecCalls.at(-1).command, "env");
        assert(sidecarExecCalls.at(-1).args.includes("PI_ROLE_SIDECAR=") && sidecarExecCalls.at(-1).args.includes("PI_SUBAGENT_RPC_DEPTH="), "repository checks run without inheriting active sidecar or nested-RPC state");
        assert.deepEqual(sidecarExecCalls.at(-1).args.slice(-2), ["bash", "scripts/check-all.sh"]);
        const beforeProvider = sidecar.hooks.find((hook) => hook.event === "before_provider_request").handler;
        let mismatchAborted = 0;
        await assert.rejects(() => beforeProvider({ payload: {} }, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "low", abort: () => { mismatchAborted += 1; } }), /role inference policy mismatch/);
        assert.equal(mismatchAborted, 1, "an inference-profile mismatch aborts before provider execution");
        let aborted = 0;
        const turnEnd = sidecar.hooks.find((hook) => hook.event === "turn_end").handler;
        for (let i = 0; i < 4; i++) {
          await beforeProvider({ payload: { i } }, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high", abort: () => { aborted += 1; } });
          await turnEnd();
        }
        assert.deepEqual(sidecar.activeTools, ["submit_role_result"], "the last two provider turns expose only typed result submission");
        const toolCall = sidecar.hooks.find((hook) => hook.event === "tool_call").handler;
        assert.equal(await toolCall({ toolName: "submit_role_result", toolCallId: "submit-first", input: {} }, { cwd: process.cwd() }), undefined, "the first submission attempt in a model response is admitted");
        const duplicateSubmit = await toolCall({ toolName: "submit_role_result", toolCallId: "submit-duplicate", input: {} }, { cwd: process.cwd() });
        assert.equal(duplicateSubmit.block, true);
        assert.match(duplicateSubmit.reason, /only one submit_role_result call is allowed per model response/, "parallel duplicate submissions in one response are rejected deterministically");
        await beforeProvider({ payload: { correction: true } }, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high", abort: () => { aborted += 1; } });
        await turnEnd();
        assert.equal(await toolCall({ toolName: "submit_role_result", toolCallId: "submit-correction", input: {} }, { cwd: process.cwd() }), undefined, "the next reserved model response admits one corrected submission");
        assert.equal((await toolCall({ toolName: "write", toolCallId: "denied", input: { path: "README.md" } }, { cwd: process.cwd() })).block, true, "denied tools remain fail-closed after activation");
        assert.equal((await toolCall({ toolName: "read", toolCallId: "escape", input: { path: "../outside" } }, { cwd: process.cwd() })).block, true, "read paths cannot escape the child workspace");
        let budgetBlock;
        for (let i = 0; i < 47; i++) budgetBlock = await toolCall({ toolName: "read", toolCallId: `call-${i}`, input: { path: "README.md" } }, { cwd: process.cwd() });
        assert.equal(budgetBlock?.block, true, "the child blocks calls beyond the exact tool budget, including earlier denied attempts");
        const submit = sidecar.toolDefs.find((tool) => tool.name === "submit_role_result");
        assert.equal(submit.parameters.properties.summary.minLength, undefined, "transport validation lets semantic completion policy observe short submission attempts");
        assert.equal(submit.parameters.properties.evidence.minItems, undefined, "transport validation lets semantic completion policy observe evidence-free submission attempts");
        assert.equal(contract.outputSchema.properties.summary.minLength, 1, "the canonical result schema remains strict");
        const validAudit = {
          summary: "Audited one claim.", findings: [], evidence: [],
          claims: [{ id: "claim-1", statement: "The claim is supported.", status: "accepted", evidenceRefs: ["ev-1"] }],
          evidenceRefs: [{ id: "ev-1", kind: "path", source: "README.md" }],
          auditDecisions: [{ claimId: "claim-1", decision: "accepted", rationale: "The cited path supports it.", evidenceRefs: ["ev-1"] }],
          rejectedClaims: [], unresolvedGaps: [],
          coverage: { expectedCategories: ["claim"], observedCategories: ["claim"], missingCategories: [], ratio: 1 },
        };
        const observedInvalidAudit = { ...validAudit, claims: [{ id: "claim-1", text: "The claim is supported.", evidenceRefIds: ["ev-1"] }] };
        assert(validateJsonSchema(submit.parameters, observedInvalidAudit).some((error) => error.includes("statement") || error.includes("additional property")), "noncanonical nested fields remain transport-invalid");
        assert.deepEqual(validateJsonSchema(submit.parameters, validAudit), [], "a canonical auditor result passes the transport schema");
        const placeholderAudit = { ...validAudit, summary: "" };
        assert.deepEqual(validateJsonSchema(submit.parameters, placeholderAudit), [], "a completion-invalid attempt reaches the submission lifecycle gate");
        assert(validateJsonSchema(contract.outputSchema, placeholderAudit).some((error) => error.includes("summary")), "the canonical result schema still rejects the same empty summary");
        await assert.rejects(() => submit.execute("invalid-placeholder", { ...validAudit, summary: "placeholder" }, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionFile: () => null } }), /placeholder rather than a meaningful result/, "placeholder submissions are rejected semantically after admission");
        await assert.rejects(() => submit.execute("invalid-roadmap", { ...validAudit, roadmapPlan: { title: "noop2", milestones: [{ title: "noop", goals: ["noop"] }] } }, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionFile: () => null } }), /roadmapPlan .*placeholder/, "no-op roadmap fields are rejected before submission");
        const submitted = await submit.execute("submit", validAudit, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionFile: () => null } });
        assert.equal(submitted.terminate, true);
        assert.equal(submitted.details.result.schemaVersion, 2);
        await assert.rejects(() => submit.execute("submit-again", validAudit, undefined, undefined, { cwd: process.cwd(), sessionManager: { getSessionFile: () => null } }), /already submitted successfully/, "a successful result can be accepted only once");
        assert.equal((await toolCall({ toolName: "submit_role_result", toolCallId: "submit-after-success", input: {} }, { cwd: process.cwd() })).block, true, "later model output cannot resubmit after acceptance");
        for (let i = 5; i < 7; i++) await beforeProvider({ payload: { i } }, { model: { provider: "provider", id: "role-test" }, thinkingLevel: "high", abort: () => { aborted += 1; } });
        assert.equal(aborted, 1, "the child aborts before the first over-budget model request");
        assert(sidecar.hooks.some((hook) => hook.event === "tool_call"));
      } else assert.ok(total > 0, "extension registered no commands or tools against the stub API");

      if (COMMAND_ONLY_MODEL_TOOLS[name]) {
        assert.ok(registered.commands.length > 0, `${name} retains its command/migration surface`);
        assert.ok(!registered.tools.includes(COMMAND_ONLY_MODEL_TOOLS[name]), `${COMMAND_ONLY_MODEL_TOOLS[name]} is not model-visible by default`);
      }
      if (name === "extensions/pi-queue") {
        assert.deepEqual([...registered.tools].sort(), ["pi_queue_list", "pi_queue_status"]);
        assert.deepEqual(registered.hooks.map((hook) => hook.event).sort(), ["session_shutdown", "session_start"], "Loading registers lifecycle hooks only; no socket, timer or process starts");
        // The Redis client install is a gitignored per-checkout prerequisite. Derive
        // the expected fail-closed outcome from the actual dependency state so the
        // same assertions hold in a fresh worktree and an installed checkout.
        const clientInstalled = fs.existsSync(path.join(__dirname, "..", "src", "pi-queue", "node_modules", "ioredis", "package.json"));
        const unconfigured = clientInstalled ? "not-configured" : "not-installed";
        const home = tmpFixture("pi-queue-extension-");
        const previous = { PI_QUEUE_ENV: process.env.PI_QUEUE_ENV, PI_QUEUE: process.env.PI_QUEUE };
        try {
          process.env.PI_QUEUE = "1";
          process.env.PI_QUEUE_ENV = path.join(home, "not-configured.env");
          const status = registered.toolDefs.find((tool) => tool.name === "pi_queue_status");
          const offline = await status.execute("offline", {}, undefined, undefined, { cwd: home, mode: "print" });
          assert.equal(offline.details.outcome, unconfigured, `A ${clientInstalled ? "installed" : "absent"} client reports ${unconfigured} instead of silently bypassing the queue`);
          assert.equal(offline.details.ready, false, "An unconfigured queue is never reported ready");
          assert.match(offline.details.reason, clientInstalled ? /client\.env/ : /setup-pi-queue/);
          const messages = [];
          await registered.commandDefs["queue-status"].handler("", { cwd: home, mode: "print", hasUI: true, ui: { notify: (text) => messages.push(text) } });
          assert.equal(JSON.parse(messages[0]).outcome, unconfigured);

          const providers = [];
          const wrapped = { commands: [], tools: [] };
          const api = stubPi(wrapped);
          api.registerProvider = (id, config) => providers.push([id, config]);
          await fn(api);
          const start = wrapped.hooks.find((hook) => hook.event === "session_start").handler;
          const registry = (...models) => ({ hasUI: false, modelRegistry: { getAll: () => models } });
          await start({}, registry({ provider: "anthropic", api: "anthropic-messages" }));
          assert.equal(providers.length, 0, "A machine without the DeepSeek provider is left untouched");
          await start({}, registry({ provider: "local", api: "openai-completions" }, { provider: "anthropic", api: "anthropic-messages" }));
          await start({}, registry({ provider: "local", api: "openai-responses" }));
          assert.deepEqual(providers.map(([id, config]) => [id, config.api, typeof config.streamSimple]),
            [["local", "openai-completions", "function"], ["local", "openai-responses", "function"]],
            "Every session start wraps local under the API its models use, so no runtime is left unwrapped");
          const mixedErrors = [];
          const originalError = console.error;
          console.error = (message) => mixedErrors.push(message);
          try { await start({}, registry({ provider: "local", api: "openai-completions" }, { provider: "local", api: "openai-responses" })); }
          finally { console.error = originalError; }
          assert.equal(providers.length, 2, "A provider whose models use several APIs cannot be wrapped completely");
          assert.match(mixedErrors.join("\n"), /NOT queued/, "and the gap is reported instead of silently bypassing the queue");
          const model = { id: "DeepSeek-V4.1-Flash-1017", provider: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1" };
          const events = [];
          for await (const event of providers[0][1].streamSimple(model, { messages: [] }, {})) events.push(event);
          assert.deepEqual(events.map((event) => event.type), ["error"]);
          assert.match(events[0].error.errorMessage, new RegExp(`${unconfigured}.*PI_QUEUE=0`, "s"), "A queue that cannot be configured fails closed instead of calling the model directly");

          const disabled = { commands: [], tools: [] };
          process.env.PI_QUEUE = "0";
          await fn(stubPi(disabled));
          assert.equal(disabled.tools.length + disabled.commands.length + disabled.hooks.length, 0, "PI_QUEUE=0 leaves local requests direct");
        } finally {
          for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
          fs.rmSync(home, { recursive: true, force: true });
        }
      }
      if (name !== "extensions/role-sidecar") fleetToolNames.push(...registered.tools);

      if (name === "extensions/memory-explorer") {
        const curator = registered.toolDefs.find((tool) => tool.name === "memory_curator");
        const input = registered.hooks.find((hook) => hook.event === "input")?.handler;
        assert.equal(typeof input, "function", "memory curator tracks explicit current-user intent");
        const cwd = tmpFixture("pi-memory-curator-intent-");
        const ctx = { cwd, sessionManager: { getSessionId: () => "memory-intent-test" } };
        const readOnlyPlan = await curator.execute("read-only", { operation: "plan" }, undefined, undefined, ctx);
        assert.notEqual(readOnlyPlan.details?.outcome, "blocked", "read-only curation planning requires no mutation authorization");
        const previewSave = await curator.execute("preview-save", { operation: "save", input: { candidate: { kind: "decision", title: "Preview", content: "Preview without an apply flag.", verification: "verified" } } }, undefined, undefined, ctx);
        assert.equal(previewSave.details.outcome, "preview", "save without apply=true is a pure preview");
        const blockedSave = await curator.execute("blocked-save", { operation: "save", input: { apply: true, candidate: { kind: "decision", title: "Blocked", content: "No intent was supplied.", verification: "verified" } } }, undefined, undefined, ctx);
        assert.equal(blockedSave.details.reasonCode, "explicit-memory-management-intent-required");
        assert.equal(fs.existsSync(path.join(cwd, ".pi", "project-memory", "decisions.jsonl")), false, "preview and blocked mutation write no decision state");
        input({ source: "user", text: "Please review and curate stale memory state." }, ctx);
        const allowed = await curator.execute("allowed", { operation: "plan" }, undefined, undefined, ctx);
        assert.notEqual(allowed.details?.outcome, "blocked", "read-only operations remain available after explicit intent");
        const sameTurn = await curator.execute("same-turn", { operation: "review" }, undefined, undefined, ctx);
        assert.notEqual(sameTurn.details?.outcome, "blocked", "read-only review is non-mutating");
        const vault = path.join(cwd, "vault"); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
        const m0Queue = await curator.execute("m0-review-queue", { operation: "reviewQueue", input: { apply: true, vault, candidate: { kind: "risk", title: "Review fixture", content: "Review this bounded fixture.", verification: "unverified" } } }, undefined, undefined, ctx);
        assert.equal(m0Queue.details.reason, "review-queue-not-authorized-at-rollout-stage");
        assert.equal(fs.existsSync(path.join(cwd, ".pi", "project-memory", "decisions.jsonl")), false, "M0 review queue writes no rejected or queued decision");
        fs.mkdirSync(path.join(cwd, ".pi", "memory-effectiveness"), { recursive: true });
        fs.writeFileSync(path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json"), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), source: currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") }), highestAuthorizedStage: "M1", scores: { privacyBoundary: { status: "pass" }, migrationRollback: { status: "pass" } }, aggregates: { privacy: { unresolvedHighSeverity: 0 } } }));
        const oldVault = process.env.PI_OBSIDIAN_VAULT; const oldStage = process.env.PI_PROJECT_MEMORY_STAGE; process.env.PI_OBSIDIAN_VAULT = vault; process.env.PI_PROJECT_MEMORY_STAGE = "M1";
        try {
          input({ source: "user", text: "Please save this reviewed memory decision." }, ctx);
          const saved = await curator.execute("save", { operation: "save", input: { apply: true, candidate: { kind: "decision", title: "Explicit memory fixture", content: "Canonical project memory uses reviewed Obsidian notes.", verification: "verified", sourceFingerprints: ["fixture-v1"] } } }, undefined, undefined, ctx);
          assert.equal(saved.details.outcome, "saved");
          assert.equal(saved.details.entry.content, undefined, "curator result does not echo the candidate body");
          assert.equal(saved.details.rollout.effectiveStage, "M1");
        } finally { if (oldVault === undefined) delete process.env.PI_OBSIDIAN_VAULT; else process.env.PI_OBSIDIAN_VAULT = oldVault; if (oldStage === undefined) delete process.env.PI_PROJECT_MEMORY_STAGE; else process.env.PI_PROJECT_MEMORY_STAGE = oldStage; }
        input({ source: "user", text: "Explain the current branch." }, ctx);
        const readAfterReset = await curator.execute("read-after-reset", { operation: "plan" }, undefined, undefined, ctx);
        assert.notEqual(readAfterReset.details?.outcome, "blocked", "unrelated input does not block pure reads");
        const reset = await curator.execute("reset", { operation: "save", input: { apply: true, candidate: { kind: "decision", title: "No intent", content: "This mutation must remain blocked.", verification: "verified" } } }, undefined, undefined, ctx);
        assert.equal(reset.details.reasonCode, "explicit-memory-management-intent-required", "unrelated current-user input clears mutation authorization");
      }

      if (name === "extensions/prompt-suggestions") {
        assert.ok(registered.hooks.some((hook) => hook.event === "agent_settled"), "prompt suggestions should wait for Pi's settled lifecycle event");
        assert.ok(!registered.hooks.some((hook) => hook.event === "agent_end"), "prompt suggestions should not launch while Pi may still retry or continue");

        const clean = mod.cleanPromptSuggestion;
        assert.equal(typeof clean, "function", "prompt suggestion cleaning should be behaviorally testable");
        const completeOverSoftLimit = "Fix the merge blockers: wire production asset registration into hot reload for real registry assets, add missing registry types/classification, and replace synthetic soak with an engine/streaming/GL soak. Verify with MCP reload probe and targeted engine, streaming, and GL soak tests.";
        assert.ok(completeOverSoftLimit.length > 240, "regression fixture should exceed the model's soft length target");
        assert.equal(clean(completeOverSoftLimit), completeOverSoftLimit, "a modest model length overrun must remain complete instead of being truncated");
        assert.equal(clean("Investigate the failure and t…"), null, "an already incomplete trailing-ellipsis suggestion should be rejected");
        assert.equal(clean("Investigate the failure and t..."), null, "an already incomplete ASCII-ellipsis suggestion should be rejected");
        assert.equal(clean("x".repeat(1201)), null, "an excessive suggestion should be rejected instead of truncated");
        assert.equal(clean("one\ntwo\nthree\nfour\nfive\nsix\nseven"), null, "too many suggestion lines should be rejected instead of silently dropped");

        const extract = mod.extractExplicitNextStep;
        assert.equal(typeof extract, "function", "explicit next-step extraction should be behaviorally testable");
        assert.equal(extract("Next steps:\none\ntwo\nthree\nfour\nfive\nsix\nseven"), null, "explicit next-step extraction should not silently drop extra lines");
        const userMessage = { message: { role: "user", content: "Repair the extension." } };
        assert.equal(mod.bestNextStepPromptSuggestion({ getBranch: () => [userMessage, { message: { role: "assistant", content: "All checks passed. The working tree is clean." } }] }), "Continue with the best next step", "the restored deterministic fallback should not impose v5 completion wording");
        assert.equal(mod.bestNextStepPromptSuggestion({ getBranch: () => [userMessage, { message: { role: "assistant", content: "Next step: Run /reload and confirm the extension." } }] }), "Run /reload and confirm the extension.", "the original labelled next-step behavior should not suppress reload prompts");

        const publicExcerpt = mod.publicSessionExcerpt;
        assert.equal(typeof publicExcerpt, "function", "the restored bounded recent-context builder should be behaviorally testable");
        const contextMessages = [
          { message: { role: "user", content: "old context that should fall outside the eight-message window" } },
          { message: { role: "assistant", content: "old outcome that should also fall outside the window" } },
          ...Array.from({ length: 6 }, (_, index) => ({ message: { role: index % 2 ? "assistant" : "user", content: index === 0 ? "bounded context 0 token=abcdefghijklmnopqrst" : index === 1 ? "bounded context 1\n$ git push origin main" : `bounded context ${index}` } })),
          { message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Verified /home/example/private/file." }] } },
          { message: { role: "toolResult", content: "focused verification passed" } },
        ];
        const excerpt = publicExcerpt({ getBranch: () => contextMessages });
        assert.doesNotMatch(excerpt, /old context|old outcome|private reasoning/, "recent context should keep only eight public messages and exclude reasoning");
        assert.match(excerpt, /^\[user\] bounded context 0 \[REDACTED_CREDENTIAL\]/m, "recent context should retain bounded role ordering while redacting secrets");
        assert.match(excerpt, /\[assistant\] bounded context 1 \[REDACTED_COMMAND\]/, "recent context should redact command lines");
        assert.match(excerpt, /\[assistant\] Verified \[REDACTED_PATH\]/, "recent context should redact private paths");
        assert.match(excerpt, /\[toolResult\] focused verification passed$/, "recent context should retain the latest bounded public outcome");

        const truncationExcerpt = publicExcerpt({ getBranch: () => [
          userMessage,
          { message: { role: "toolResult", content: `${"x".repeat(894)}/home/private/path` } },
          { message: { role: "assistant", content: "Verification passed." } },
        ] });
        assert.doesNotMatch(truncationExcerpt, /\/home\//, "a path cut at the 900-character context boundary must remain redacted");
        assert.doesNotThrow(
          () => new HermesAdvisoryAdapter({ cwd: process.cwd() }).validateInput("promptSuggestion", { publicRecentContext: truncationExcerpt, skillContext: null }),
          "the typed prompt-suggestion boundary must accept scanner-safe context after JSON serialization",
        );

        const skillContext = mod.skillSuggestionContext;
        assert.equal(typeof skillContext, "function", "skill telemetry filtering should be behaviorally testable");
        const telemetryRoot = tmpFixture("pi-skill-suggestion-");
        const metricsFile = path.join(telemetryRoot, ".pi", "cognitive-automation", "skills", "metrics.jsonl");
        fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
        fs.writeFileSync(metricsFile, `${JSON.stringify({ type: "skill.evaluated", skillId: "advisory-only", ok: false, evidence: { invoked: false } })}\n`);
        assert.equal(skillContext(telemetryRoot), "", "advisory-only evaluations must not produce skill failure guidance");
        fs.appendFileSync(metricsFile, `${JSON.stringify({ type: "skill.evaluated", skillId: "explicit-skill", ok: false, evidence: { invoked: true } })}\n`);
        assert.match(skillContext(telemetryRoot), /1 recent skill failure.*explicit-skill/, "explicitly invoked failures should remain available to guidance");
      }
    } catch (error) {
      failures.push(`${name}: ${String(error?.message || error).split("\n")[0]}`);
    }
  }
  assert.deepEqual(failures, [], `extensions failed to load/register:\n${failures.join("\n")}`);
  const parentToolCount = new Set(fleetToolNames).size;
  assert.equal(parentToolCount, 66, "the exact default fleet includes default-on native CodeMode, the optional-tool activation control, project_scope, specialist controls, two queue tools, and the sectioned-write append tool");
  assert(fleetToolNames.includes("codemode"));
  assert(fleetToolNames.includes("activate_tools"));
  assert(fleetToolNames.includes("project_scope"));
  assert(fleetToolNames.includes("specialist_tasks"));
  assert.deepEqual(fleetToolNames.filter((tool) => Object.values(COMMAND_ONLY_MODEL_TOOLS).includes(tool)), [], "experimental command-only tools stay out of the default fleet");
  console.log(`extension-load tests passed (${entries.length} extensions; ${parentToolCount} default parent tools)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
