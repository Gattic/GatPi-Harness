"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
const tuiSmoke = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-subagent-tui.sh"), "utf8");
const toolName = source.indexOf('name: "create_subagent"');
const toolStart = source.lastIndexOf("pi.registerTool({", toolName);
assert(toolStart >= 0, "create_subagent tool is registered");
const toolSource = source.slice(toolStart, source.indexOf('pi.registerCommand("reasoning-debug-context"', toolStart));

for (const operation of ["preflight", "create", "launch", "run", "list", "status", "get", "wait", "steer", "interrupt", "cancel", "continue", "resume", "merge"]) {
  assert(toolSource.includes(`\"${operation}\"`) || toolSource.includes(`operation === "${operation}"`), `tool supports ${operation}`);
}
assert(toolSource.includes("normalizeOperation(params.operation"), "operation aliases resolve through the shared normalizer");
assert(source.includes('queue: "launch"') && source.includes('inspect: "get"') && source.includes('trace: "get"'), "queue/inspect/trace resolve to launch/get");
assert(toolSource.includes("normalizeOperation(params.mergePolicy"), "mergePolicy aliases resolve through the shared normalizer");
assert(source.includes('manual: "none"'), "mergePolicy manual maps to none");
assert(toolSource.includes("queue is an alias for launch") && toolSource.includes("manual is treated as none"), "the schema documents accepted aliases instead of rejecting them as invalid enum values");
assert(toolSource.includes('operation: Type.Optional(Type.String({ description: "Operation: preflight'), "operation is a described string so case and alias variants reach the normalizer instead of a literal-only enum");
assert(toolSource.includes("createSubagentForContext"), "tool create path uses shared subagent creation helper");
assert(source.includes("function resolveSubagentRoleArgs"), "direct subagents resolve registered roles before creation");
assert(source.includes('roleResolution: "registered"'), "registered role resolution is recorded");
assert(source.includes('roleResolution: "custom-read-only"'), "unknown roles require an explicit read-only custom-role path");
assert(source.includes("createCustomReadOnlyRole"), "custom roles resolve through the canonical bounded role-v2 contract factory");
assert(source.includes('roleResolution: "custom-read-only"'), "custom role provenance remains explicit");
assert(source.includes("Unknown subagent role"), "unknown role labels without a prompt are rejected");
assert(source.includes("Ambiguous subagent role"), "normalized role collisions fail closed");
assert(source.includes("is handler-only and must run inside a topology"), "handler-only roles cannot be misrouted into RPC sidecars");
assert(source.includes("ctx?.sessionManager?.getSessionId?.()"), "subagent parent identity should use the real Pi session id instead of collapsing tool calls into pi-session");
assert(source.includes("process.env.PI_SUBAGENT_MAX_CONCURRENT || 8"), "default subagent record headroom should exceed 4-way critique fanout");
assert(source.includes("function isSubagentBranch") && source.includes('metadata?.kind === "subagent"'), "extension parent branch selection should not chain sibling critique subagents under prior subagent branches");
assert(toolSource.includes('executionMode: "parallel"'), "subagent tool should allow sibling run calls to execute in parallel for skill fanout");
assert(!toolSource.includes('executionMode: "sequential"'), "subagent tool must not serialize critique/research skill fanout");
assert(toolSource.includes('executionMode: "tool-rpc"'), "tool run should execute through the RPC sidecar backend");
assert(source.includes('pi.registerCommand("subagent-patch-preview"'), "retained workspace patches have an explicit preview command");
assert(source.includes('pi.registerCommand("subagent-patch-apply"') && source.includes("--yes"), "filesystem patch transfer requires an explicit parent apply action");
assert(source.includes("this never applies filesystem changes"), "trajectory merge is explicitly distinct from filesystem patch transfer");
assert(toolSource.includes("const created ="), "tool launch/run creates a subagent in a single tool call when task is supplied");
assert(toolSource.includes("launchSubagent({ subagentId: id"), "tool launch uses the canonical detached lifecycle path");
assert(toolSource.includes("runSubagent({ subagentId: id"), "tool run composes detached launch with bounded wait");
assert(toolSource.includes("preflightSubagentForContext"), "tool exposes the shared side-effect-free preflight resolver");
assert(toolSource.includes("compactRoleToolOutcome(result)"), "tool run exposes only the compact canonical role outcome instead of raw child output");
assert(source.includes("roleToolResultOverride(event)"), "role-related semantic failures are converted into error tool results");
assert(!source.includes("subagentCommandUsesFork") && !source.includes('executionMode: "pi-fork"'), "replacement-session subagent execution is removed rather than retained as a fallback");
assert(!toolSource.includes("commandRequired: true"), "model-tool execution has no command fallback path");
assert(!source.includes("sendUserMessage(`/subagent-run"), "tool run must not inject /subagent-run as a chat follow-up");
assert(!source.includes("setEditorText?."), "tool run must not mutate the prompt editor");
assert(toolSource.includes("appendSubagentParentEntry(pi, merged)"), "tool merge appends parent-visible subagent result entry");
assert(toolSource.includes("mergeSubagentResult"), "tool merge uses SubagentService merge");
assert(source.includes('pi.appendEntry?.("role-run"'), "role execution persists compact non-context provenance");
assert(toolSource.includes('appendRoleRunEntry(pi, record, result, "subagent-tool")'), "tool-side subagent completion records role-run provenance");
assert(toolSource.includes("compactRoleToolOutcome(result)"), "model tool returns canonical compact status and termination metadata");
assert(source.includes('appendTopologyRoleRuns(pi, result, "auto-router")'), "auto-routed topology roles record execution provenance");
assert(source.includes("PI_SUBAGENT_STATE_ROOT") && source.includes("new SubagentStore"), "subagent role state can be isolated for smoke tests");
assert(tuiSmoke.includes("PI_SUBAGENT_STATE_ROOT='$state_root/subagents'"), "subagent TUI smoke uses isolated role state");
assert(!tuiSmoke.includes("rm -rf .pi/subagents"), "subagent TUI smoke must not delete project role evidence");

console.log("subagent tool source tests passed");
