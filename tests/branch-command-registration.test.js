"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");

for (const command of ["branch-list", "branch-show", "branch-diff", "branch-merge", "branch-rollback", "ask", "ask-status", "ask-panel", "ask-fork", "ask-clear", "subagent-preflight", "subagent", "subagent-create", "subagent-run", "subagent-list", "subagent-show", "subagent-wait", "subagent-steer", "subagent-interrupt", "subagent-cancel", "subagent-continue", "subagent-resume", "subagent-merge", "subagent-status", "subagent-events", "subagent-export", "subagent-prune"]) {
  assert(source.includes(`pi.registerCommand("${command}"`), `${command} command should be registered`);
}

assert(source.includes("previewMerge"), "branch-merge should support dry-run preview");
assert(source.includes("pre-rollback checkpoint"), "branch-rollback should create a pre-rollback checkpoint before apply");
assert(source.includes("PI_COGNITIVE_AUTO_BRANCH === \"1\""), "automatic branching should remain opt-in");
assert(source.includes("BRANCHING_ENABLED"), "manual branch commands should have an explicit enable switch");
assert(source.includes('name: "create_subagent"'), "model-callable subagent tool should be registered");
assert(source.includes('pi.appendEntry?.("subagent.result"'), "subagent merge should append parent-visible custom session entries");
assert(!source.includes("PI_SUBAGENT_MAX_DEPTH"), "nested delegation depth is fixed at one rather than configurable");
assert(source.includes('ctx.ui.setWidget("subagents", lines, { placement: "above" })'), "reasoning-runtime-only installations should retain the legacy subagent widget");
const chatFocusSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "chat-focus", "index.ts"), "utf8");
assert(chatFocusSource.includes('ctx.ui.setWidget("subagents", undefined)'), "chat-focus should replace the legacy widget when both extensions are loaded");
assert(chatFocusSource.includes('{ placement: "belowEditor" }'), "subagent UX should expose the shared below-editor chat strip");
assert(source.includes("startSubagentCommandRun(pi, ctx, sub.id"), "single /subagent command should create and start a non-blocking command runner");
assert(source.includes('const runner = "rpc"'), "subagent commands use the single detached RPC runner");
assert(!source.includes('executionMode: "pi-fork"'), "replacement-session execution is removed");
assert(source.includes("runtime.subagentRuns?.get(id)?.abort()"), "subagent cancel should abort an active command-side runner");
assert(source.includes('piContext: { cwd: runtime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, executionMode: "tool-rpc" }'), "topology commands pass model and thinking to the canonical RPC sidecar context");

console.log("branch command registration tests passed");
