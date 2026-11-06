import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createLspAdapter, parseCliArgs, formatSize } = require(join(LIB_ROOT, "src", "lsp-adapter.js"));

// Env knobs are parsed in src/lsp-adapter.js: process.env.PI_LSP process.env.PI_LSP_LIVE process.env.PI_LSP_TIMEOUT_MS process.env.PI_LSP_DIAGNOSTIC_TIMEOUT_MS process.env.PI_LSP_MAX_BUFFER process.env.PI_LSP_MAX_LINES process.env.PI_LSP_MAX_BYTES process.env.PI_LSP_ALLOW_OUTSIDE process.env.PI_LSP_MAX_FILES process.env.PI_LSP_MAX_RESULTS
const adapter = createLspAdapter();
const ENABLED = adapter.config.enabled;
const OUTPUT_MAX_LINES = adapter.config.outputMaxLines;
const OUTPUT_MAX_BYTES = adapter.config.outputMaxBytes;

type ToolContext = { cwd: string; ui?: any };
const Operation = StringEnum(["status", "diagnostics", "symbols", "workspaceSymbols", "definition", "references", "implementations", "incomingCalls", "outgoingCalls", "typeSupertypes", "typeSubtypes", "hover", "codeActions", "renamePreview", "renameApply"] as const);
const PathField = Type.Optional(Type.String({ description: "Project path. Defaults to the current Pi working directory. Explicit paths outside cwd require PI_LSP_ALLOW_OUTSIDE=1." }));
const FileField = Type.Optional(Type.String({ description: "File path relative to the project path. A leading @ is ignored." }));
const FilesField = Type.Optional(Type.Array(Type.String(), { description: "File paths relative to the project path." }));
const PositionFields = { line: Type.Optional(Type.Number({ description: "1-indexed line number." })), column: Type.Optional(Type.Number({ description: "1-indexed column number." })) };

async function notify(ctx: any, promise: Promise<any>) {
  try {
    const result = await promise;
    const text = result.content?.[0]?.text || JSON.stringify(result.details, null, 2);
    ctx.ui.notify(text, "info");
  } catch (e: any) {
    ctx.ui.notify(String(e?.message || e), "error");
  }
}
function mergeInput(params: any) { return { ...(params?.input || {}), ...(params || {}) }; }
function symbolParams(args: string) {
  const parsed = parseCliArgs(args);
  const positional = parsed.positional || [];
  if (positional[0] && !parsed.opts.symbol) parsed.opts.symbol = positional[0];
  return parsed.opts;
}
async function queuedRename(ctx: ToolContext, params: any, signal?: AbortSignal) {
  if (!params.apply) return adapter.rename(ctx, params, signal);
  const preview = await adapter.rename(ctx, { ...params, apply: false }, signal);
  if (preview.details?.backend !== "live-lsp" || !preview.details?.gatingSafe || !preview.details?.preview) throw new Error("renameApply requires a successful gating-safe live-lsp preview");
  const files = (preview.details?.changes || []).map((c: any) => resolve(ctx.cwd, c.file)).sort();
  let idx = 0;
  const run = async (): Promise<any> => {
    if (idx >= files.length) return adapter.rename(ctx, { ...params, apply: true, preview: preview.details.preview }, signal);
    const file = files[idx++];
    return withFileMutationQueue(file, run);
  };
  return run();
}

export default function lspExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;

  pi.registerCommand("lsp-status", { description: "Show local LSP/compiler-tooling availability", handler: async (args: string, ctx: any) => notify(ctx, adapter.status(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("lsp-diagnostics", { description: "Run local diagnostics: /lsp-diagnostics [--file f] [files...]", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, adapter.diagnostics(ctx, { ...parsed.opts, files: parsed.positional })); } });
  pi.registerCommand("lsp-symbols", { description: "List document/project symbols: /lsp-symbols [--file f] [--language lang]", handler: async (args: string, ctx: any) => notify(ctx, adapter.documentSymbols(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("lsp-definition", { description: "Find symbol definitions: /lsp-definition <symbol> or --file f --line n --column n", handler: async (args: string, ctx: any) => notify(ctx, adapter.definition(ctx, symbolParams(args))) });
  pi.registerCommand("lsp-references", { description: "Find symbol references: /lsp-references <symbol> or --file f --line n --column n", handler: async (args: string, ctx: any) => notify(ctx, adapter.references(ctx, symbolParams(args))) });
  pi.registerCommand("lsp-hover", { description: "Show fallback hover context: /lsp-hover --file f --line n --column n", handler: async (args: string, ctx: any) => notify(ctx, adapter.hover(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("lsp-rename-preview", { description: "Preview lexical rename: /lsp-rename-preview <symbol> <newName>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); if (!parsed.opts.symbol && parsed.positional[0]) parsed.opts.symbol = parsed.positional[0]; if (!parsed.opts.newName && parsed.positional[1]) parsed.opts.newName = parsed.positional[1]; await notify(ctx, adapter.rename(ctx, { ...parsed.opts, apply: false })); } });
  pi.registerCommand("lsp-rename-apply", { description: "Apply a live-LSP rename after a hash-validated preview: /lsp-rename-apply <symbol> <newName>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); if (!parsed.opts.symbol && parsed.positional[0]) parsed.opts.symbol = parsed.positional[0]; if (!parsed.opts.newName && parsed.positional[1]) parsed.opts.newName = parsed.positional[1]; await notify(ctx, queuedRename(ctx, { ...parsed.opts, apply: true })); } });

  pi.on("session_shutdown" as any, async () => { await adapter.closeAll(); });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Use local language/compiler tooling plus deterministic fallback indexing for diagnostics, symbols, definition, references, hover, and safe rename preview/apply. Output is truncated to ${OUTPUT_MAX_LINES} lines or ${formatSize(OUTPUT_MAX_BYTES)}.`,
    promptSnippet: "Use local LSP/compiler-style facts for diagnostics, symbols, definitions, references, hover, and rename preview/apply",
    promptGuidelines: ["Use lsp diagnostics before or after compiler-sensitive edits when a focused language check is needed.", "Use lsp definition/references/hover before guessing symbol locations; fallback results are advisory when no language server is installed.", "Use lsp renamePreview before renameApply for lexical rename operations."],
    parameters: Type.Object({ operation: Type.Optional(Operation), path: PathField, file: FileField, files: FilesField, ...PositionFields, symbol: Type.Optional(Type.String({ description: "Symbol name. If omitted for definition/references/hover/rename, provide file+line+column." })), newName: Type.Optional(Type.String({ description: "New symbol name for renamePreview/renameApply." })), language: Type.Optional(Type.String({ description: "Optional language filter, e.g. typescript, javascript, python, go, rust." })), changed: Type.Optional(Type.Boolean({ description: "For diagnostics, focus changed files when git metadata is available." })), maxResults: Type.Optional(Type.Number({ description: "Maximum references/symbols/results." })), maxFiles: Type.Optional(Type.Number({ description: "Maximum files to scan." })), timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds for live requests, fallback analysis workers, and diagnostic commands." })), input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) {
      const p = mergeInput(params);
      const op = p.operation || "status";
      if (op === "status") return adapter.status(ctx, p);
      if (op === "diagnostics") return adapter.diagnostics(ctx, p, signal);
      if (op === "symbols") return adapter.documentSymbols(ctx, p, signal);
      if (op === "workspaceSymbols") return adapter.workspaceSymbols(ctx, p, signal);
      if (op === "definition") return adapter.definition(ctx, p, signal);
      if (op === "references") return adapter.references(ctx, p, signal);
      if (op === "implementations") return adapter.implementations(ctx, p, signal);
      if (op === "incomingCalls") return adapter.callHierarchy(ctx, { ...p, direction: "incoming" }, signal);
      if (op === "outgoingCalls") return adapter.callHierarchy(ctx, { ...p, direction: "outgoing" }, signal);
      if (op === "typeSupertypes") return adapter.typeHierarchy(ctx, { ...p, direction: "supertypes" }, signal);
      if (op === "typeSubtypes") return adapter.typeHierarchy(ctx, { ...p, direction: "subtypes" }, signal);
      if (op === "hover") return adapter.hover(ctx, p, signal);
      if (op === "codeActions") return adapter.codeActions(ctx, p, signal);
      if (op === "renamePreview") return adapter.rename(ctx, { ...p, apply: false }, signal);
      if (op === "renameApply") return queuedRename(ctx, { ...p, apply: true }, signal);
      throw new Error(`Unknown lsp operation: ${op}`);
    },
  });
}
