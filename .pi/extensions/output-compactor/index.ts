import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { contentText, renderCompactJson, toolResultContent } = require(join(LIB_ROOT, "src", "result-rendering.js"));
const { boundToolResult, policyFor, policyTools } = require(join(LIB_ROOT, "src", "tool-output-bounds.js"));
const { modelToolEnabled } = require(join(LIB_ROOT, "src", "extension-portfolio.js"));
const { createExtensionTelemetry, contextSessionKind } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const ENABLED = process.env.PI_OUTPUT_COMPACTOR !== "0";
const MODEL_TOOL_ENABLED = modelToolEnabled("output-compactor");
const requestedMode = String(process.env.PI_OUTPUT_COMPACTOR_MODE === undefined ? "canary" : process.env.PI_OUTPUT_COMPACTOR_MODE).trim().toLowerCase();
const MODE = ["off", "canary", "all"].includes(requestedMode) ? requestedMode : "off";
const configuredMaxChars = process.env.PI_OUTPUT_COMPACTOR_MAX_CHARS === undefined ? 2400 : Number(process.env.PI_OUTPUT_COMPACTOR_MAX_CHARS);
const MAX_CHARS = Number.isFinite(configuredMaxChars) && configuredMaxChars > 0 ? configuredMaxChars : 2400;
// The canary set is the policy tool set: the tools that actually dominate tool
// output in local sessions (read, bash, roadmap_update, bg_run, debug_ledger,
// docs_lookup, ast_*, lsp, codegraph_context and the unbounded spike tools).
const DEFAULT_CANARY_TOOLS = policyTools();
const configuredCanaryTools = process.env.PI_OUTPUT_COMPACTOR_CANARY_TOOLS === undefined ? DEFAULT_CANARY_TOOLS.join(",") : process.env.PI_OUTPUT_COMPACTOR_CANARY_TOOLS;
const CANARY_TOOLS = new Set(String(configuredCanaryTools).split(",").map((value) => value.trim()).filter((value) => /^[A-Za-z0-9_.:+-]+$/.test(value)));
const EXTENSION_VERSION = "output-compactor-2026-10-29.1";

function textOf(content: any) { return contentText(content); }
function selected(toolName: string) { return MODE === "all" || (MODE === "canary" && CANARY_TOOLS.has(toolName)); }
function sessionId(ctx: any) { try { return String(ctx?.sessionManager?.getSessionId?.() || ""); } catch { return ""; } }

export default function outputCompactor(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "output-compactor", version: EXTENSION_VERSION }) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("output-compact", { description: "Compact JSON/tool output: /output-compact <json>", handler: async (args: string, ctx: any) => {
    let value: any = args || ""; try { value = JSON.parse(args); } catch {}
    ctx.ui.notify(renderCompactJson(value, { maxChars: MAX_CHARS }), "info");
  }});
  pi.registerCommand("output-compactor-status", { description: "Show output-compactor policy and command-only model-tool status", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ enabled: ENABLED, mode: MODE, modelToolEnabled: MODEL_TOOL_ENABLED, modelToolOptIn: "PI_OUTPUT_COMPACTOR_MODEL_TOOL=1", canonical: "tool-specific result rendering", maxChars: MAX_CHARS, canaryTools: [...CANARY_TOOLS].sort(), policyTools: policyTools(), policies: policyTools().map((name: string) => ({ tool: name, ...policyFor(name) })) }, null, 2), "info") });
  const observations = new Map<string, { inputChars: number; modelChars: number; budgetTokens: number }>();
  pi.on("session_shutdown", () => { observations.clear(); });
  // Observe the final result after every tool_result transformer has run. Only
  // counts survive the call; neither bodies nor arguments enter telemetry.
  pi.on("tool_execution_end", (event: any, ctx: any) => {
    if (event.parentToolCallId) return;
    const outputChars = textOf(event.result?.content).length;
    const before = observations.get(event.toolCallId) || { inputChars: outputChars, modelChars: outputChars, budgetTokens: 0 };
    observations.delete(event.toolCallId);
    const telemetry = createExtensionTelemetry({ cwd: ctx.cwd, extension: "output-compactor", version: EXTENSION_VERSION });
    telemetry.featureSignal("tool-result-rendering", "observed", { tool: event.toolName, toolCallId: event.toolCallId, reason: "final-result", outcome: event.isError ? "infrastructure-failed" : "succeeded", sessionKind: contextSessionKind(ctx), sessionToken: telemetry.sessionToken(sessionId(ctx)), ...before, outputChars, savedChars: Math.max(0, before.inputChars - outputChars) });
  });
  pi.on("tool_result" as any, (event: any, ctx: any) => {
    // Nested callers need canonical data, not the model-facing bounded view.
    if (event.parentToolCallId) return;
    const text = textOf(event.content);
    const rawChars = Number(event.details?.rendering?.rawChars);
    const budgetTokens = Number(event.details?.rendering?.budgetTokens);
    observations.set(event.toolCallId, { inputChars: Number.isFinite(rawChars) && rawChars >= 0 ? rawChars : text.length, modelChars: text.length, budgetTokens: Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : 0 });
    const policy = policyFor(event.toolName);
    // Telemetry is created lazily: most results are small and never observed.
    let telemetry: any = null;
    const signal = (action: string, reason: string, outputChars: number, durationMs?: number) => {
      telemetry ||= createExtensionTelemetry({ cwd: ctx.cwd, extension: "output-compactor", version: EXTENSION_VERSION });
      telemetry.featureSignal("output-compactor", action, { tool: event.toolName, reason, outcome: action === "compacted" ? "succeeded" : "not-applicable", sessionKind: contextSessionKind(ctx), sessionToken: telemetry.sessionToken(sessionId(ctx)), inputChars: text.length, outputChars, savedChars: Math.max(0, text.length - outputChars), ...(durationMs === undefined ? {} : { durationMs }) });
    };
    // A disabled or out-of-scope compactor still observes the large results it
    // would have bounded, so the unsaved population stays attributable.
    const bypassReason = MODE === "off" ? "disabled" : !policy ? "no-policy" : !selected(event.toolName) ? "outside-canary" : null;
    if (bypassReason) {
      if (text.length > MAX_CHARS) signal("bypassed", bypassReason, text.length);
      return;
    }
    const startedAt = Date.now();
    const bound = boundToolResult({ toolName: event.toolName, content: event.content, details: event.details, input: event.input, isError: event.isError === true });
    if (!bound.changed || bound.text.length >= text.length) {
      // Results inside the cap are the normal case; only oversized results that
      // escaped the bound are worth a bypass signal.
      if (text.length > policy.maxChars) signal("bypassed", bound.reason, text.length, Date.now() - startedAt);
      return;
    }
    signal("compacted", bound.reason, bound.text.length, Date.now() - startedAt);
    return { content: toolResultContent(bound.text) };
  });
  if (MODEL_TOOL_ENABLED) pi.registerTool({ name: "output_compactor", label: "Output compactor (experimental)", description: "Compatibility-only manual compaction. Prefer tool-specific result rendering so verbose payloads are not resent by the model.", parameters: Type.Object({ input: Type.Optional(Type.Any()), maxChars: Type.Optional(Type.Number()) }), async execute(_id: string, params: any) { const text = renderCompactJson(params.input ?? {}, { maxChars: params.maxChars || MAX_CHARS }); return { content: [{ type: "text", text }], details: { compacted: true, lifecycle: "experimental" } }; } });
}
