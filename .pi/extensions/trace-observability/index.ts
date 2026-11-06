import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTraceRuntime, stableStringify, truncate, sha256 } = require("../../../src/trace-observability.js");

type TraceCategory = "prompt_assembly" | "context_injection" | "memory_retrieval" | "retrieval" | "tool_exposure" | "model_request" | "model_response" | "token_accounting" | "retry" | "compaction" | "file_edit" | "shell_execution" | "verifier_result" | "agent_branching" | "failure_state" | "cancellation" | "session" | "message" | "performance";
type Severity = "debug" | "info" | "warn" | "error" | "fatal";

function sessionId(ctx: any) {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (file) return createHash("sha256").update(file).digest("hex").slice(0, 16);
  return createHash("sha256").update(`${ctx?.cwd || process.cwd()}:${process.pid}`).digest("hex").slice(0, 16);
}
function messageSummary(message: any) {
  if (!message) return undefined;
  const content = Array.isArray(message.content) ? message.content.map((b: any) => b?.text || b?.thinking || b?.name || b?.type).join("\n") : String(message.content || "");
  return { role: message.role, content: truncate(content, 1000), usage: message.usage, stopReason: message.stopReason, toolName: message.toolName, isError: message.isError };
}
function safeJson(x: any) { try { return JSON.parse(JSON.stringify(x)); } catch { return String(x); } }
function fileHash(file: string) { try { return sha256(readFileSync(file)); } catch { return undefined; } }
function readText(file: string) { try { return readFileSync(file, "utf8"); } catch { return undefined; } }
function semanticDiff(before = "", after = "") {
  const b = before.split("\n"), a = after.split("\n");
  return { beforeHash: sha256(before), afterHash: sha256(after), linesBefore: b.length, linesAfter: a.length, deltaLines: a.length - b.length, changed: before !== after };
}

export default function traceObservability(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  let trace: any;
  let sid = "trace";
  let currentAgentStart = 0;
  let modelRequestStart = 0;
  let retryCount = 0;
  let preFiles: Record<string, { hash?: string; text?: string }> = {};
  let retrievalListener: ((event: any) => void) | null = null;
  let retrievalUnsubscribe: (() => void) | null = null;
  let retrievalMeta: { sessionId: string; projectId: string } | null = null;

  function ensure(ctx: any) {
    const next = sessionId(ctx);
    if (!trace || sid !== next) {
      trace?.close();
      sid = next;
      trace = createTraceRuntime({
        enabled: process.env.PI_TRACE_ENABLED !== "0",
        root: process.env.PI_TRACE_DIR || join(ctx.cwd, ".pi", "traces"),
        sessionId: sid,
        cwd: ctx.cwd,
        maxFiles: Number(process.env.PI_TRACE_MAX_FILES || 200),
        maxAgeDays: Number(process.env.PI_TRACE_MAX_AGE_DAYS || 14),
        rotateBytes: Number(process.env.PI_TRACE_ROTATE_BYTES || 25 * 1024 * 1024),
        maxTotalBytes: Number(process.env.PI_TRACE_MAX_TOTAL_BYTES || 128 * 1024 * 1024),
        headroomRatio: Number(process.env.PI_TRACE_HEADROOM_RATIO || 0.25),
        compressPayloadBytes: Number(process.env.PI_TRACE_COMPRESS_PAYLOAD_BYTES || 32 * 1024),
        capturePayloads: process.env.PI_TRACE_CAPTURE_PAYLOADS !== "0",
        maxRecent: Number(process.env.PI_TRACE_RECENT || 500),
      });
    }
    return trace;
  }
  function emit(ctx: any, category: TraceCategory, name: string, subsystem: string, payload?: unknown, severity: Severity = "info", duration_ms?: number) {
    // Stale-safe: in headless (-p) runs pi replaces the session at turn end,
    // so late handlers receive a ctx that throws on any property access.
    // Tracing must never surface an extension error for that.
    try {
      return ensure(ctx).emit({ category, name, subsystem, payload, severity, duration_ms, session_id: sid, agent_id: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined });
    } catch {
      return undefined;
    }
  }

  function unsubscribeRetrieval() {
    try { retrievalUnsubscribe?.(); } catch {}
    retrievalListener = null; retrievalUnsubscribe = null; retrievalMeta = null;
  }
  function subscribeRetrieval(ctx: any) {
    unsubscribeRetrieval();
    if (process.env.PI_TRACE_ENABLED === "0" || !pi.events?.on) return;
    const activeTrace = ensure(ctx);
    const activeSession = ctx.sessionManager?.getSessionId?.() || ctx.sessionManager?.getSessionFile?.() || sid;
    const sessionId = createHash("sha256").update(String(activeSession)).digest("hex").slice(0, 20);
    const projectId = createHash("sha256").update(String(ctx.cwd || "")).digest("hex").slice(0, 16);
    retrievalMeta = { sessionId, projectId };
    retrievalListener = (event: any) => {
      if (!retrievalMeta || process.env.PI_TRACE_ENABLED === "0") return;
      try { activeTrace.emit({ category: "retrieval", name: event?.name || "retrieval.event", subsystem: "code-context", session_id: retrievalMeta.sessionId, payload: { ...safeJson(event), sessionId: retrievalMeta.sessionId, projectId: retrievalMeta.projectId } }); } catch {}
    };
    retrievalUnsubscribe = pi.events.on("code-context:retrieval", retrievalListener);
  }

  pi.on("session_start" as any, async (event: any, ctx: any) => { ensure(ctx).setCorrelation(randomUUID()); subscribeRetrieval(ctx); emit(ctx, "session", "session_start", "session", { event, cwd: ctx.cwd, trace_file: ensure(ctx).status().trace_file }); });
  pi.on("session_shutdown" as any, async (event: any, ctx: any) => {
    try { emit(ctx, "session", "session_shutdown", "session", { event, metrics: trace?.status().metrics }); }
    finally { unsubscribeRetrieval(); trace?.close(); trace = undefined; }
  });
  // session_before_* return values are control protocol. Observer hooks must
  // never return the trace event from emit(), or they overwrite a prior
  // extension's cancel/compaction/summary result in ExtensionRunner.
  pi.on("session_before_switch" as any, (event: any, ctx: any) => { emit(ctx, "agent_branching", "session_before_switch", "session", event); });
  pi.on("session_before_fork" as any, (event: any, ctx: any) => { emit(ctx, "agent_branching", "session_before_fork", "session", event); });
  pi.on("session_before_compact" as any, (event: any, ctx: any) => { emit(ctx, "compaction", "session_before_compact", "compaction", { event, usage: ctx.getContextUsage?.() }); });
  pi.on("session_compact" as any, (event: any, ctx: any) => emit(ctx, "compaction", "session_compact", "compaction", { event, usage: ctx.getContextUsage?.() }));
  pi.on("session_before_tree" as any, (event: any, ctx: any) => { emit(ctx, "agent_branching", "session_before_tree", "session", event); });
  pi.on("session_tree" as any, (event: any, ctx: any) => emit(ctx, "agent_branching", "session_tree", "session", event));

  pi.on("before_agent_start" as any, (event: any, ctx: any) => {
    currentAgentStart = performance.now(); ensure(ctx).setCorrelation(randomUUID());
    emit(ctx, "prompt_assembly", "before_agent_start", "prompt", { prompt: event.prompt, systemPromptHash: sha256(event.systemPrompt || ""), tools: event.systemPromptOptions?.selectedTools, contextFiles: event.systemPromptOptions?.contextFiles?.map((f: any) => f.path || f.name) });
  });
  pi.on("agent_start" as any, (_event: any, ctx: any) => emit(ctx, "session", "agent_start", "agent", { cwd: ctx.cwd }));
  pi.on("agent_end" as any, (event: any, ctx: any) => { let usage: unknown; try { usage = ctx.getContextUsage?.(); } catch { return; } return emit(ctx, "performance", "agent_end", "agent", { messages: event.messages?.map(messageSummary), retryCount, usage }, "info", performance.now() - currentAgentStart); });
  pi.on("turn_start" as any, (event: any, ctx: any) => emit(ctx, "session", "turn_start", "agent", event));
  pi.on("turn_end" as any, (event: any, ctx: any) => emit(ctx, "token_accounting", "turn_token_accounting", "tokens", { turnIndex: event.turnIndex, usage: ctx.getContextUsage?.(), message: messageSummary(event.message), toolResultCount: event.toolResults?.length }));
  pi.on("message_start" as any, (event: any, ctx: any) => emit(ctx, "message", "message_start", "message", messageSummary(event.message), "debug"));
  pi.on("message_update" as any, (event: any, ctx: any) => emit(ctx, "model_response", "message_update", "model", { message: messageSummary(event.message), assistantMessageEvent: safeJson(event.assistantMessageEvent) }, "debug"));
  pi.on("message_end" as any, (event: any, ctx: any) => { emit(ctx, event.message?.role === "assistant" ? "model_response" : "message", "message_end", "message", messageSummary(event.message)); if (event.message?.usage) emit(ctx, "token_accounting", "message_usage", "tokens", event.message.usage); });
  pi.on("context" as any, (event: any, ctx: any) => emit(ctx, "context_injection", "context_pre_model", "context", { message_count: event.messages?.length, messages_hash: sha256(event.messages), usage: ctx.getContextUsage?.() }));
  pi.on("before_provider_request" as any, (event: any, ctx: any) => { modelRequestStart = performance.now(); emit(ctx, "model_request", "before_provider_request", "provider", { payload_hash: sha256(event.payload), payload: event.payload }); });
  pi.on("after_provider_response" as any, (event: any, ctx: any) => { const sev: Severity = event.status >= 500 ? "error" : event.status === 429 ? "warn" : "info"; if (event.status === 429 || event.status >= 500) retryCount++; emit(ctx, event.status === 429 ? "retry" : "model_response", "after_provider_response", "provider", { status: event.status, headers: event.headers, retryCount }, sev, modelRequestStart ? performance.now() - modelRequestStart : undefined); });

  pi.on("tool_call" as any, async (event: any, ctx: any) => {
    const name = event.toolName || event.name; const args = event.input || event.args || {};
    if (["edit", "write", "read"].includes(name) && args.path) { const full = join(ctx.cwd, args.path); preFiles[args.path] = { hash: fileHash(full), text: readText(full) }; }
    emit(ctx, name === "bash" ? "shell_execution" : ["edit", "write"].includes(name) ? "file_edit" : "tool_exposure", "tool_call", "tools", { toolName: name, input: args });
  });
  pi.on("tool_result" as any, (event: any, ctx: any) => emit(ctx, "tool_exposure", "tool_result", "tools", { toolName: event.toolName, isError: event.isError, result: event.result }, event.isError ? "error" : "info"));
  pi.on("tool_execution_end" as any, async (event: any, ctx: any) => {
    const payload: any = { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result };
    if (["edit", "write"].includes(event.toolName)) {
      payload.files = {};
      for (const [p, before] of Object.entries(preFiles)) { const after = readText(join(ctx.cwd, p)); payload.files[p] = { pre_hash: before.hash, post_hash: after ? sha256(after) : undefined, semantic_diff: semanticDiff(before.text, after) }; }
      preFiles = {};
    }
    emit(ctx, event.toolName === "bash" ? "shell_execution" : ["edit", "write"].includes(event.toolName) ? "file_edit" : "tool_exposure", "tool_execution_end", "tools", payload, event.isError ? "error" : "info");
  });
  pi.on("user_bash" as any, (event: any, ctx: any) => emit(ctx, "shell_execution", "user_bash", "shell", event));
  pi.on("input" as any, (event: any, ctx: any) => { if (event.text?.startsWith("/")) emit(ctx, "session", "slash_or_input", "input", { source: event.source, text: event.text }); });
  pi.on("model_select" as any, (event: any, ctx: any) => emit(ctx, "session", "model_select", "model", event));
  pi.on("thinking_level_select" as any, (event: any, ctx: any) => emit(ctx, "session", "thinking_level_select", "model", event));

  pi.registerCommand("trace-status", { description: "Show trace subsystem status and metrics", handler: async (_args: string, ctx: any) => ctx.ui.notify(stableStringify(ensure(ctx).status()), "info") });
  pi.registerCommand("trace-live", { description: "Show recent live trace events; optional filter text", handler: async (args: string, ctx: any) => { const f = args?.trim(); const rows = ensure(ctx).recent(30).filter((e: any) => !f || stableStringify(e).includes(f)).map((e: any) => `${e.timestamp} ${e.severity.padEnd(5)} ${e.category.padEnd(18)} ${e.name} ${e.duration_ms ? Math.round(e.duration_ms)+"ms" : ""}`); if (process.env.PI_TRACE_LIVE_WIDGET === "1" && ctx.hasUI) ctx.ui.setWidget("trace-live", rows); else ctx.ui.notify(rows.join("\n") || "No trace events", "info"); } });
  pi.registerCommand("trace-timeline", { description: "Show current session event timeline", handler: async (_args: string, ctx: any) => { const rows = ensure(ctx).events().slice(-80).map((e: any, i: number) => `${String(i).padStart(3)} ${e.timestamp.slice(11,23)} ${String(e.correlation_id).slice(0,8)} ${e.category}:${e.name} ${e.duration_ms ? Math.round(e.duration_ms)+"ms" : ""}`); ctx.ui.notify(rows.join("\n") || "No timeline", "info"); } });
  pi.registerCommand("trace-errors", { description: "Show error/failure focused trace view", handler: async (_args: string, ctx: any) => { const rows = ensure(ctx).recent(100).filter((e: any) => e.severity === "error" || e.severity === "fatal" || e.category === "failure_state").slice(-50).map((e: any) => `${e.timestamp} ${e.severity} ${e.name} ${truncate(stableStringify(e.payload), 500)}`); ctx.ui.notify(rows.join("\n") || "No trace errors", "info"); } });
  pi.registerCommand("trace-subagents", { description: "Show subagent/agent-branching trace events", handler: async (_args: string, ctx: any) => { const rows = ensure(ctx).events().filter((e: any) => e.category === "agent_branching" || String(e.name || "").startsWith("subagent.")).slice(-80).map((e: any) => `${e.timestamp} ${e.severity.padEnd(5)} ${e.category}:${e.name} ${e.agent_id || ""} ${truncate(stableStringify(e.payload), 500)}`); ctx.ui.notify(rows.join("\n") || "No subagent trace events", "info"); } });
  pi.registerCommand("trace-export", { description: "Export trace JSON; args: [correlation_id]", handler: async (args: string, ctx: any) => { const corr = args?.trim(); const events = ensure(ctx).export(corr); const out = join(process.env.PI_TRACE_DIR || join(ctx.cwd, ".pi", "traces"), `${sid}${corr ? `-${corr.slice(0,8)}` : ""}.export.json`); writeFileSync(out, stableStringify({ exported_at: new Date().toISOString(), session_id: sid, events, metrics: ensure(ctx).status().metrics })); ctx.ui.notify(`Exported ${events.length} trace events to ${out}`, "info"); } });
  pi.registerCommand("trace-replay", { description: "Offline replay inspect: args [step|summary] [index]", handler: async (args: string, ctx: any) => { const [mode, idx] = (args || "summary").trim().split(/\s+/); const events = ensure(ctx).events(); if (mode === "step") { const e = events[Number(idx || 0)]; ctx.ui.notify(e ? stableStringify(e) : "No such replay step", "info"); return; } ctx.ui.notify(stableStringify(ensure(ctx).replaySummary()), "info"); } });
}
