import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { openThread, recordAttempt, resolveThread, listThreads, showThread, formatThread, openThreadsSummary } = require(join(LIB_ROOT, "src", "debug-ledger.js"));
const { notify, createContextInjector } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: "the issue still persists" bug loops are the worst human
// friction (same message 9x in one day; failed knob toggles retried across
// sessions). One durable thread per bug: hypothesis -> change -> observation
// -> verdict, injected at session start so dead ends are not retried.
const ENABLED = process.env.PI_DEBUG_LEDGER !== "0";
const INJECT = process.env.PI_DEBUG_LEDGER_INJECT !== "0";

export default function debugLedger(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  const injection = createContextInjector({ customType: "debug-ledger", maxChars: process.env.PI_DEBUG_LEDGER_INJECT_MAX_CHARS });

  pi.on("session_start", () => injection.reset());
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    if (!INJECT) return;
    let summary = "";
    try { summary = openThreadsSummary(ctx.cwd); } catch { return; }
    return injection.inject(summary);
  });

  pi.registerCommand("debug-open", { description: "Open (or reopen) a durable debug thread: /debug-open <bug title>", handler: async (args: string, ctx: any) => {
    const thread = openThread(ctx.cwd, String(args || "").trim() || "untitled bug");
    notify(ctx, `${thread.duplicate ? "existing" : "opened"} thread ${thread.threadId}\n${formatThread(thread)}`, "info");
  }});
  pi.registerCommand("debug-attempt", { description: "Record an attempt: /debug-attempt <thread-id> <hypothesis> :: <change> :: <observation> :: <fixed|partial|no-change|worse>", handler: async (args: string, ctx: any) => {
    const [head, ...rest] = String(args || "").trim().split(/\s+/);
    const [hypothesis, change, observation, verdict] = rest.join(" ").split("::").map((part) => part.trim());
    try { notify(ctx, formatThread(recordAttempt(ctx.cwd, head, { hypothesis, change, observation, verdict })), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("debug-list", { description: "List debug threads: /debug-list [open|resolved]", handler: async (args: string, ctx: any) => {
    const status = ["open", "resolved"].includes(String(args || "").trim()) ? String(args).trim() : undefined;
    const threads = listThreads(ctx.cwd, { status });
    notify(ctx, threads.length ? threads.map((t: any) => `${t.threadId} [${t.status}] ${t.attempts.length} attempts - ${t.title}`).join("\n") : "No debug threads", "info");
  }});
  pi.registerCommand("debug-show", { description: "Show a debug thread: /debug-show <thread-id>", handler: async (args: string, ctx: any) => {
    try { notify(ctx, formatThread(showThread(ctx.cwd, String(args || "").trim())), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("debug-resolve", { description: "Resolve a debug thread: /debug-resolve <thread-id> [resolution note]", handler: async (args: string, ctx: any) => {
    const [head, ...rest] = String(args || "").trim().split(/\s+/);
    try { notify(ctx, formatThread(resolveThread(ctx.cwd, head, rest.join(" "))), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});

  pi.registerTool({
    name: "debug_ledger",
    label: "Debug ledger",
    description: "Durable per-bug thread of hypothesis -> change -> observation -> verdict. Open a thread when starting a bug hunt, record every attempt (especially failed ones), check it before retrying a change, resolve with the confirmed fix.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("open"), Type.Literal("attempt"), Type.Literal("list"), Type.Literal("show"), Type.Literal("resolve")]),
      title: Type.Optional(Type.String({ description: "Bug title (open)" })),
      threadId: Type.Optional(Type.String({ description: "Thread id (attempt/show/resolve)" })),
      hypothesis: Type.Optional(Type.String()),
      change: Type.Optional(Type.String({ description: "What was changed/toggled, e.g. a knob or code edit" })),
      observation: Type.Optional(Type.String({ description: "What actually happened after the change" })),
      verdict: Type.Optional(Type.Union([Type.Literal("fixed"), Type.Literal("partial"), Type.Literal("no-change"), Type.Literal("worse"), Type.Literal("unverified")])),
      evidence: Type.Optional(Type.Array(Type.String())),
      recallId: Type.Optional(Type.String({ description: "Optional fix_recall retrieval id that informed this attempt" })),
      note: Type.Optional(Type.String({ description: "Resolution note (resolve)" })),
      status: Type.Optional(Type.String({ description: "Filter for list: open|resolved" })),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = params.operation;
      let details: any;
      if (op === "open") details = openThread(ctx.cwd, params.title || "untitled bug");
      else if (op === "attempt") details = recordAttempt(ctx.cwd, params.threadId, params);
      else if (op === "resolve") details = resolveThread(ctx.cwd, params.threadId, params.note);
      else if (op === "show") details = showThread(ctx.cwd, params.threadId);
      else details = listThreads(ctx.cwd, { status: params.status });
      const text = Array.isArray(details)
        ? details.map((t: any) => `${t.threadId} [${t.status}] ${t.attempts.length} attempts - ${t.title}`).join("\n") || "No debug threads"
        : formatThread(details);
      return { content: [{ type: "text", text }], details };
    },
  });
}
