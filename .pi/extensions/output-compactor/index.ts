import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { compactToolContent, contentText, renderCompactJson, toolResultContent } = require(join(LIB_ROOT, "src", "result-rendering.js"));
const { modelToolEnabled } = require(join(LIB_ROOT, "src", "extension-portfolio.js"));
const { estimateTextTokens } = require(join(LIB_ROOT, "src", "provider-result-rendering.js"));
const { createExtensionTelemetry, contextSessionKind } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const ENABLED = process.env.PI_OUTPUT_COMPACTOR !== "0";
const MODEL_TOOL_ENABLED = modelToolEnabled("output-compactor");
const requestedMode = String(process.env.PI_OUTPUT_COMPACTOR_MODE === undefined ? "canary" : process.env.PI_OUTPUT_COMPACTOR_MODE).trim().toLowerCase();
const MODE = ["off", "canary", "all"].includes(requestedMode) ? requestedMode : "off";
const configuredMaxChars = process.env.PI_OUTPUT_COMPACTOR_MAX_CHARS === undefined ? 2400 : Number(process.env.PI_OUTPUT_COMPACTOR_MAX_CHARS);
const MAX_CHARS = Number.isFinite(configuredMaxChars) && configuredMaxChars > 0 ? configuredMaxChars : 2400;
const DEFAULT_CANARY_TOOLS = ["evidence_binder", "extension_ops", "learning_loop", "run_deck", "run_topology", "runtime_doctor", "verification_center"];
const configuredCanaryTools = process.env.PI_OUTPUT_COMPACTOR_CANARY_TOOLS === undefined ? DEFAULT_CANARY_TOOLS.join(",") : process.env.PI_OUTPUT_COMPACTOR_CANARY_TOOLS;
const CANARY_TOOLS = new Set(String(configuredCanaryTools).split(",").map((value) => value.trim()).filter((value) => /^[A-Za-z0-9_.:+-]+$/.test(value)));
const KNOWN_TOOLS = new Set(["bg_run", "code_context", "evidence_binder", "test_runner", "build_project", "run_deck", "run_monitor", "create_subagent", "run_topology", "runtime_doctor", "verification_center", "memory_explorer", "memory_curator", "test_gap_planner", "project_intelligence", "extension_ops", "learning_loop"]);
const EXTENSION_VERSION = "output-compactor-2026-10-28.1";

function textOf(content: any) { return contentText(content); }
function structured(text: string) { const trimmed = text.trim(); return trimmed.startsWith("{") || trimmed.startsWith("["); }
function eligible(event: any) {
  const text = textOf(event.content);
  return { text, eligible: text.length > MAX_CHARS && (KNOWN_TOOLS.has(event.toolName) || structured(text)) };
}
function selected(toolName: string) { return MODE === "all" || (MODE === "canary" && CANARY_TOOLS.has(toolName)); }
function sessionId(ctx: any) { try { return String(ctx?.sessionManager?.getSessionId?.() || ""); } catch { return ""; } }

export default function outputCompactor(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "output-compactor", version: EXTENSION_VERSION }) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("output-compact", { description: "Compact JSON/tool output: /output-compact <json>", handler: async (args: string, ctx: any) => {
    let value: any = args || ""; try { value = JSON.parse(args); } catch {}
    ctx.ui.notify(renderCompactJson(value, { maxChars: MAX_CHARS }), "info");
  }});
  pi.registerCommand("output-compactor-status", { description: "Show output-compactor canary and command-only model-tool status", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ enabled: ENABLED, mode: MODE, modelToolEnabled: MODEL_TOOL_ENABLED, modelToolOptIn: "PI_OUTPUT_COMPACTOR_MODEL_TOOL=1", canonical: "tool-specific result rendering", maxChars: MAX_CHARS, canaryTools: [...CANARY_TOOLS].sort(), knownTools: [...KNOWN_TOOLS].sort() }, null, 2), "info") });
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
    // Nested callers need canonical data, not the model-facing compact view.
    if (event.parentToolCallId) return;
    const observation = eligible(event);
    const rawChars = Number(event.details?.rendering?.rawChars);
    const budgetTokens = Number(event.details?.rendering?.budgetTokens);
    observations.set(event.toolCallId, { inputChars: Number.isFinite(rawChars) && rawChars >= 0 ? rawChars : observation.text.length, modelChars: observation.text.length, budgetTokens: Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : 0 });
    const nativeBounded = budgetTokens > 0 && estimateTextTokens(observation.text) <= budgetTokens;
    if (!observation.eligible || event.input?.verbose === true || nativeBounded) return;
    const telemetry = createExtensionTelemetry({ cwd: ctx.cwd, extension: "output-compactor", version: EXTENSION_VERSION });
    const sessionKind = contextSessionKind(ctx);
    const sessionToken = telemetry.sessionToken(sessionId(ctx));
    // A disabled compactor still observes the large results it would have
    // compacted, so the unsaved population stays attributable instead of
    // disappearing from the measurement.
    if (MODE === "off") {
      telemetry.featureSignal("output-compactor", "bypassed", { tool: event.toolName, reason: "disabled", outcome: "not-applicable", sessionKind, sessionToken, inputChars: observation.text.length, outputChars: observation.text.length });
      return;
    }
    if (!selected(event.toolName)) {
      telemetry.featureSignal("output-compactor", "bypassed", { tool: event.toolName, reason: "outside-canary", outcome: "not-applicable", sessionKind, sessionToken, inputChars: observation.text.length, outputChars: observation.text.length });
      return;
    }
    const startedAt = Date.now();
    const compact = compactToolContent({ toolName: event.toolName, content: event.content, details: event.details, maxChars: MAX_CHARS });
    const rendered = `${compact}\n\n[output-compactor: compacted verbose tool output; full details remain in tool result details/session trace when available]`;
    if (rendered.length >= observation.text.length) {
      telemetry.featureSignal("output-compactor", "bypassed", { tool: event.toolName, reason: "no-reduction", outcome: "not-applicable", sessionKind, sessionToken, inputChars: observation.text.length, outputChars: observation.text.length, durationMs: Date.now() - startedAt });
      return;
    }
    telemetry.featureSignal("output-compactor", "compacted", { tool: event.toolName, reason: event.toolName, outcome: "succeeded", sessionKind, sessionToken, inputChars: observation.text.length, outputChars: rendered.length, savedChars: observation.text.length - rendered.length, durationMs: Date.now() - startedAt });
    return { content: toolResultContent(rendered) };
  });
  if (MODEL_TOOL_ENABLED) pi.registerTool({ name: "output_compactor", label: "Output compactor (experimental)", description: "Compatibility-only manual compaction. Prefer tool-specific result rendering so verbose payloads are not resent by the model.", parameters: Type.Object({ input: Type.Optional(Type.Any()), maxChars: Type.Optional(Type.Number()) }), async execute(_id: string, params: any) { const text = renderCompactJson(params.input ?? {}, { maxChars: params.maxChars || MAX_CHARS }); return { content: [{ type: "text", text }], details: { compacted: true, lifecycle: "experimental" } }; } });
}
