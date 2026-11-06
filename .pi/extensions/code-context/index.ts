import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createCodeContextService } = require(join(LIB_ROOT, "src", "code-context-service.js"));

const Operation = StringEnum(["repoMap", "search", "symbolGet", "symbolRelations", "buildQuery", "changeImpact", "diagnostics"] as const);
const Detail = StringEnum(["card", "outline", "body"] as const);
type ToolContext = { cwd: string };
function mergeInput(params: any) {
  const { input, ...rest } = params || {};
  const merged: any = { ...(input || {}), ...rest };
  for (const key of ["path", "file"]) if (merged[key] == null || String(merged[key]).trim().toLowerCase() === "undefined") delete merged[key];
  for (const key of ["seeds", "changedPaths", "paths", "languages", "kinds", "sourceKinds", "files", "relationKinds", "entities"]) if (typeof merged[key] === "string") merged[key] = merged[key].split(",").map((item: string) => item.trim()).filter(Boolean);
  return merged;
}
const StringList = Type.Union([Type.String(), Type.Array(Type.String())]);

export default function codeContextExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "code-context" }) as ExtensionAPI;
  const service = createCodeContextService({ telemetry: { emit: (event: any) => { try { pi.events?.emit?.("code-context:retrieval", event); } catch {} } } });
  const pending = new Map<string, { toolName: string; input: any; nested: boolean }>();
  pi.on("session_start" as any, async (_event: any, ctx: any) => {
    const branch = ctx.sessionManager?.getBranch?.() || [];
    const summary = service.startSession(ctx, branch);
    pi.appendEntry?.("code-context.ledger", { event: "session_start", ...summary });
  });
  pi.on("tool_call" as any, (event: any) => { pending.set(event.toolCallId, { toolName: event.toolName || event.name || "", input: event.input || event.args || {}, nested: Boolean(event.parentToolCallId) }); });
  pi.on("tool_result" as any, (event: any, ctx: any) => {
    const previous = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (event.isError || event.error) return;
    const toolName = event.toolName || event.name || previous?.toolName || "";
    const input = event.input || event.args || previous?.input || {};
    const mark = service.codegraph.shouldMarkStaleFromTool(toolName, input, event.details);
    if (!mark.stale) return;
    service.invalidate(service.codegraph.touchedFilesFromTool(ctx.cwd, toolName, input));
  });
  pi.on("session_compact" as any, async (_event: any, ctx: any) => {
    const result = service.compact(ctx.sessionManager?.getBranch?.() || []);
    pi.appendEntry?.("code-context.ledger", { event: "session_compact", visible: result.visibleRefs.length, entriesScanned: result.entriesScanned });
  });
  pi.on("session_shutdown" as any, async (_event: any, ctx: any) => {
    service.reconstruct(ctx.sessionManager?.getBranch?.() || []);
    await service.close();
    pending.clear();
  });
  pi.registerTool({
    name: "code_context",
    label: "Code Context",
    outputSchema: require("../../../src/pi-extension-kit.js").TOOL_OUTPUT_SCHEMAS.code_context,
    description: "Retrieve a small provider-neutral model of the codebase, then expand exact source only on request. Returns ranked cards with explicit freshness, degradation, provenance, and token budgets.",
    promptSnippet: "Use code_context repoMap/search/symbol cards before broad source reads; request detail=body only after localization",
    promptGuidelines: [
      "Locate once: use code_context repoMap for unfamiliar code, search for known text, and read the localized source; do not repeat the same lookup through AST and CodeGraph.",
      "Treat stale, degraded, compiler-fallback, and gatingSafe=false results as advisory.",
      "Use symbolGet detail=body only for a localized symbol/range. Use live LSP for semantic references/rename, CodeGraph for dependency questions, and Semgrep at risk-focused verification checkpoints; none is a mandatory prelude to every edit.",
    ],
    parameters: Type.Object({
      operation: Type.Optional(Operation),
      path: Type.Optional(Type.String({ description: "Project path inside the current cwd." })),
      task: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
      seeds: Type.Optional(StringList),
      changedPaths: Type.Optional(StringList),
      paths: Type.Optional(StringList),
      languages: Type.Optional(StringList),
      kinds: Type.Optional(StringList),
      sourceKinds: Type.Optional(StringList),
      symbolId: Type.Optional(Type.String()),
      symbol: Type.Optional(Type.String({ description: "For symbolRelations, use a CodeGraph symbol name, not a symbolId; resolution is name-based and advisory." })),
      file: Type.Optional(Type.String()),
      files: Type.Optional(StringList),
      line: Type.Optional(Type.Number()),
      column: Type.Optional(Type.Number()),
      range: Type.Optional(Type.Any()),
      detail: Type.Optional(Detail),
      relationKinds: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "symbolRelations supports calls only; graph relations are advisory." })),
      relation: Type.Optional(Type.String()),
      entities: Type.Optional(StringList),
      entity: Type.Optional(Type.String()),
      direction: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Number({ description: "symbolRelations currently supports one-hop traversal only (depth=1)." })),
      maximumDepth: Type.Optional(Type.Number()),
      maximumResults: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
      cursor: Type.Optional(Type.String()),
      budgetTokens: Type.Optional(Type.Number()),
      revision: Type.Optional(Type.Any()),
      configuration: Type.Optional(Type.Any()),
      includeGenerated: Type.Optional(Type.Boolean()),
      includeVendored: Type.Optional(Type.Boolean()),
      input: Type.Optional(Type.Any()),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) {
      const input = { ...mergeInput(params), contentVisible: !pending.get(_id)?.nested };
      const result = await service.execute(ctx, input.operation || "repoMap", input, signal);
      return { content: [{ type: "text", text: service.render(result) }], details: result };
    },
  });
}
