import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const {
  createCodegraphAdapter,
  parseCliArgs,
} = require(join(LIB_ROOT, "src", "codegraph-adapter.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Env knobs are parsed in src/codegraph-adapter.js: process.env.PI_CODEGRAPH process.env.PI_CODEGRAPH_BIN process.env.PI_CODEGRAPH_TIMEOUT_MS process.env.PI_CODEGRAPH_MAX_BUFFER process.env.PI_CODEGRAPH_MAX_LINES process.env.PI_CODEGRAPH_MAX_BYTES process.env.PI_CODEGRAPH_ALLOW_OUTSIDE process.env.PI_CODEGRAPH_AUTO_SYNC process.env.PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS process.env.PI_CODEGRAPH_ADVISORY process.env.PI_CODEGRAPH_ADVISORY_TIMEOUT_MS
const adapter = createCodegraphAdapter();
const ENABLED = adapter.config.enabled;

const PathField = Type.Optional(Type.String({ description: "Project path. Defaults to the current Pi working directory. By default this must stay inside cwd; set PI_CODEGRAPH_ALLOW_OUTSIDE=1 to override." }));
const TimeoutField = Type.Optional(Type.Number({ description: "Command timeout in milliseconds." }));
const VerboseField = Type.Optional(Type.Boolean({ description: "Return the raw provider output instead of the bounded retrieval view." }));
const BudgetField = Type.Optional(Type.Number({ description: "Token budget for the model-facing retrieval view." }));
const LinesField = Type.Optional(Type.Number({ description: "Maximum model-facing report lines." }));

async function notifyResult(ctx: any, promise: Promise<any>) {
  try {
    const result = await promise;
    const text = result.content?.[0]?.text || JSON.stringify(result.details, null, 2);
    notify(ctx, text, "info");
  } catch (e: any) {
    notify(ctx, String(e?.message || e), "error");
  }
}
export default function codegraphExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;

  const pending = new Map<string, any>();
  const autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleAutoSync(projectPath: string) {
    if (!adapter.config.autoSync) return;
    const previous = autoSyncTimers.get(projectPath);
    if (previous) clearTimeout(previous);
    autoSyncTimers.set(projectPath, setTimeout(async () => {
      autoSyncTimers.delete(projectPath);
      try { await adapter.sync({ cwd: projectPath }, { path: projectPath }); }
      catch (e: any) { try { adapter.recordCodegraphError(projectPath, "auto-sync", e); } catch {} }
    }, adapter.config.autoSyncDebounceMs));
  }

  pi.on("tool_call" as any, async (event: any, ctx: any) => {
    const toolName = event.toolName || event.name;
    const input = event.input || event.args || {};
    pending.set(event.toolCallId, { toolName, input, cwd: ctx.cwd, snapshot: await adapter.toolMutationSnapshot(ctx.cwd, toolName, input) });
  });
  pi.on("tool_result" as any, async (event: any) => {
    const pre = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!pre || !pre.snapshot.size) return;
    const after = await adapter.toolMutationSnapshot(pre.cwd, pre.toolName, pre.input);
    const mark = adapter.shouldMarkStaleFromTool(pre.toolName, pre.input, event.details);
    for (const { projectPath, changedFiles } of adapter.changedMutationProjects(pre.snapshot, after)) {
      adapter.recordMutation(projectPath, { source: "tool_result", toolName: pre.toolName, reason: mark.reason || `CodeGraph may be stale after ${pre.toolName}`, changedFiles });
      scheduleAutoSync(projectPath);
    }
  });
  pi.on("session_shutdown", () => {
    for (const timer of autoSyncTimers.values()) clearTimeout(timer);
    autoSyncTimers.clear();
    pending.clear();
  });

  pi.registerCommand("codegraph-status", { description: "Show CodeGraph index status for this repo", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.status(ctx, { ...parsed.opts, path: parsed.opts.path || parsed.positional[0] })); } });
  pi.registerCommand("codegraph-sync", { description: "Sync CodeGraph changes for this repo; use --full for full index", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.sync(ctx, { ...parsed.opts, path: parsed.opts.path || parsed.positional[0] })); } });
  pi.registerCommand("codegraph-query", { description: "Search CodeGraph symbols: /codegraph-query [--kind kind] [--limit n] <search>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); const search = parsed.positional.join(" "); if (!search) return notify(ctx, "Usage: /codegraph-query [--kind kind] [--limit n] <search>", "warning"); await notifyResult(ctx, adapter.query(ctx, { ...parsed.opts, search })); } });
  pi.registerCommand("codegraph-context", { description: "Build CodeGraph task context: /codegraph-context [--max-files n] <task>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); const task = parsed.positional.join(" "); if (!task) return notify(ctx, "Usage: /codegraph-context [--max-files n] <task>", "warning"); await notifyResult(ctx, adapter.context(ctx, { ...parsed.opts, task })); } });
  pi.registerCommand("codegraph-affected", { description: "Find tests affected by changed source files", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.affected(ctx, { ...parsed.opts, files: parsed.positional })); } });
  pi.registerCommand("codegraph-files", { description: "Show project file structure from the CodeGraph index", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.files(ctx, parsed.opts)); } });
  pi.registerCommand("codegraph-doctor", { description: "Diagnose CodeGraph binary, index, freshness, and env knobs", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.doctor(ctx, { ...parsed.opts, path: parsed.opts.path || parsed.positional[0] })); } });

  pi.registerTool({
    name: "codegraph_status",
    label: "CodeGraph status",
    description: "Show CodeGraph index health/statistics. Returns the freshness verdict plus a bounded report; verbose=true returns the raw output.",
    promptSnippet: "Show CodeGraph index health and statistics for the current project",
    parameters: Type.Object({ path: PathField, verbose: VerboseField, maxLines: LinesField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) { return adapter.status(ctx, params || {}, signal); },
  });

  pi.registerTool({
    name: "codegraph_query",
    label: "CodeGraph query",
    description: "Search CodeGraph symbols/nodes. Returns ranked symbol cards within a token budget; verbose=true returns raw JSON.",
    promptSnippet: "Search indexed symbols/nodes with CodeGraph",
    promptGuidelines: ["Use codegraph_query for an explicit graph-backed lookup or provider diagnosis; do not repeat sufficient code_context results."],
    parameters: Type.Object({ search: Type.String({ description: "Symbol or text to search for." }), path: PathField, limit: Type.Optional(Type.Number({ description: "Maximum results; default 10, maximum 200." })), kind: Type.Optional(Type.String({ description: "Optional node kind filter, e.g. function, class, method, file." })), verbose: VerboseField, budgetTokens: BudgetField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) { return adapter.query(ctx, params || {}, signal); },
  });

  pi.registerTool({
    name: "codegraph_context",
    label: "CodeGraph context",
    description: "Build task-focused CodeGraph context: symbols, blast radius and relationship counts. Verbatim source is omitted unless includeSource=true; verbose=true returns raw output.",
    promptSnippet: "Build task-focused code context from CodeGraph",
    promptGuidelines: ["Use codegraph_context only when source plus dependency context is needed beyond code_context cards, not as an additional mandatory lookup."],
    parameters: Type.Object({ task: Type.String({ description: "Task or question to explore." }), path: PathField, maxFiles: Type.Optional(Type.Number({ description: "Maximum files to include source from; default 10, maximum 100." })), includeSource: Type.Optional(Type.Boolean({ description: "Append the verbatim source section; omitted by default to keep explore cheap." })), verbose: VerboseField, budgetTokens: BudgetField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) { return adapter.context(ctx, params || {}, signal); },
  });

  pi.registerTool({
    name: "codegraph_affected",
    label: "CodeGraph affected tests",
    description: "Find test files affected by changed source files. Returns an advisory test list within a token budget; verbose=true returns raw JSON.",
    promptSnippet: "Find likely affected tests for changed source files with CodeGraph",
    promptGuidelines: ["Use one impact lookup (code_context changeImpact, codegraph_affected, or semgrep_codegraph) when it adds relevant test hints. Graph suggestions are additive; never omit baseline tests because the graph is empty."],
    parameters: Type.Object({ files: Type.Optional(Type.Array(Type.String(), { description: "Changed files. Defaults to CodeGraph's changed-file detection when omitted." })), path: PathField, depth: Type.Optional(Type.Number({ description: "Dependency traversal depth; default 5, maximum 50." })), filter: Type.Optional(Type.String({ description: "Custom glob filter for test files." })), verbose: VerboseField, budgetTokens: BudgetField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) { return adapter.affected(ctx, params || {}, signal); },
  });

  pi.registerTool({
    name: "codegraph_sync",
    label: "CodeGraph sync",
    description: "Sync CodeGraph changes, or run a full index with fullIndex=true. Returns a bounded report; verbose=true returns the raw output.",
    promptSnippet: "Sync or fully index CodeGraph for the current project",
    promptGuidelines: ["Sync only when the next graph operation needs freshness and auto-sync has not already caught up; use fullIndex=true only when incremental sync is insufficient."],
    parameters: Type.Object({ path: PathField, fullIndex: Type.Optional(Type.Boolean({ description: "Run `codegraph index` instead of incremental `codegraph sync`." })), verbose: VerboseField, maxLines: LinesField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) { return adapter.sync(ctx, params || {}, signal); },
  });


  pi.registerTool({
    name: "codegraph_doctor",
    label: "CodeGraph doctor",
    description: "Diagnose CodeGraph binary availability, version, project initialization, freshness state, env knobs, and non-blocking advisory-mode risks.",
    promptSnippet: "Diagnose CodeGraph integration health",
    parameters: Type.Object({ path: PathField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: any) { return adapter.doctor(ctx, params || {}); },
  });
}
