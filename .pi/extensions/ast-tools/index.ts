import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createAstTools, parseCliArgs } = require(join(LIB_ROOT, "src", "ast-tools.js"));

// Env knobs are parsed in src/ast-tools.js: process.env.PI_AST_TOOLS process.env.PI_AST_ALLOW_OUTSIDE process.env.PI_AST_MAX_LINES process.env.PI_AST_MAX_BYTES process.env.PI_AST_MAX_FILES process.env.PI_AST_MAX_RESULTS process.env.PI_AST_MAX_CHANGES
const ast = createAstTools();
const ENABLED = ast.config.enabled;

type ToolContext = { cwd: string; ui?: any };
const SearchKind = StringEnum(["node", "function", "class", "binding", "import", "require", "call", "identifier", "regex", "text", "type", "struct", "enum"] as const);
const RefactorKind = StringEnum(["identifier", "text", "regex", "call"] as const);
const Mode = StringEnum(["preview", "apply"] as const);
const VerboseField = Type.Optional(Type.Boolean({ description: "Return the raw match list instead of the bounded retrieval view." }));
const BudgetField = Type.Optional(Type.Number({ description: "Token budget for the model-facing match view." }));

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
async function queuedRefactor(ctx: ToolContext, params: any) {
  if ((params.mode || (params.apply ? "apply" : "preview")) !== "apply") return ast.refactor(ctx, params);
  const preview = await ast.refactor(ctx, { ...params, mode: "preview" });
  const files = (preview.details?.changes || []).map((c: any) => resolve(ctx.cwd, c.file)).sort();
  let idx = 0;
  const run = async (): Promise<any> => {
    if (idx >= files.length) return ast.refactor(ctx, { ...params, mode: "apply" });
    const file = files[idx++];
    return withFileMutationQueue(file, run);
  };
  return run();
}

export default function astToolsExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  require(join(LIB_ROOT, "src", "pi-extension-kit.js")).observeFixedOpportunity(pi, { extension: "ast-tools", version: "opportunity-pilot-v1", triggerId: "semantic-edit-intent", sourceFile: fileURLToPath(import.meta.url), tools: ["ast_search", "ast_refactor"], matches: (text: string) => /\b(?:rename|refactor|call[ -]?sites?|structural search)\b/i.test(text) });

  pi.registerCommand("ast-status", { description: "Show AST search/refactor adapter status", handler: async (args: string, ctx: any) => notify(ctx, ast.status(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("ast-search", { description: "Structural search: /ast-search [--kind call|function|class|identifier|regex|text] <pattern>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, ast.search(ctx, { ...parsed.opts, pattern: parsed.opts.pattern || parsed.positional.join(" ") })); } });
  pi.registerCommand("ast-refactor-preview", { description: "Preview structural refactor: /ast-refactor-preview [--kind identifier] <pattern> --replacement <text>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, ast.refactor(ctx, { ...parsed.opts, mode: "preview", pattern: parsed.opts.pattern || parsed.positional.join(" ") })); } });
  pi.registerCommand("ast-refactor-apply", { description: "Apply structural refactor with checkpoint: /ast-refactor-apply [--kind identifier] <pattern> --replacement <text>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, queuedRefactor(ctx, { ...parsed.opts, mode: "apply", pattern: parsed.opts.pattern || parsed.positional.join(" ") })); } });
  pi.registerCommand("ast-refactor-rollback", { description: "Rollback latest or specified AST refactor checkpoint", handler: async (args: string, ctx: any) => notify(ctx, ast.rollback(ctx, { checkpointId: (args || "").trim() || undefined })) });

  pi.registerTool({
    name: "ast_search",
    label: "AST search",
    description: "Search code with regex-backed declaration and lexical heuristics, not a parser. Comments/strings may match and complex syntax may be missed. Returns ranked matches within a token budget and a refinement hint when the match limit is reached; verbose=true returns the raw list.",
    promptSnippet: "Search declarations or text using bounded lexical heuristics (not a real AST)",
    promptGuidelines: ["Use ast_search for a focused lexical/declaration query when useful; do not repeat an already sufficient code_context search. Its matches are not compiler-resolved references."],
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Project path. Defaults to cwd; explicit escapes require PI_AST_ALLOW_OUTSIDE=1." })), file: Type.Optional(Type.String({ description: "Single file to search." })), files: Type.Optional(Type.Array(Type.String(), { description: "Files to search." })), kind: Type.Optional(SearchKind), pattern: Type.Optional(Type.String({ description: "Pattern to search for. Optional for kind=node to list heuristic declarations/calls." })), language: Type.Optional(Type.String({ description: "Language filter, e.g. typescript, javascript, python." })), regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regex for node-name matching." })), flags: Type.Optional(Type.String({ description: "Regex flags." })), caseSensitive: Type.Optional(Type.Boolean()), include: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), maxResults: Type.Optional(Type.Number({ description: "Maximum matches to collect; default 50." })), maxFiles: Type.Optional(Type.Number()), verbose: VerboseField, budgetTokens: BudgetField, input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return ast.search(ctx, mergeInput(params)); },
  });

  pi.registerTool({
    name: "ast_refactor",
    label: "AST refactor",
    description: "Preview/apply/rollback checkpointed lexical replacements. Regex-backed, not scope-aware: identifiers/calls may also match comments, strings, or unrelated bindings. Use live LSP for semantic rename.",
    promptSnippet: "Preview/apply/rollback lexical replacements; checkpoints do not prove semantic correctness",
    promptGuidelines: ["Use ast_refactor with mode=preview before mode=apply for broad mechanical edits.", "Use ast_refactor rollback if an applied structural refactor needs to be reverted before further drift."],
    parameters: Type.Object({ operation: Type.Optional(StringEnum(["refactor", "rollback", "status"] as const)), mode: Type.Optional(Mode), path: Type.Optional(Type.String()), file: Type.Optional(Type.String()), files: Type.Optional(Type.Array(Type.String())), kind: Type.Optional(RefactorKind), pattern: Type.Optional(Type.String({ description: "Identifier/text/regex/call name to replace." })), replacement: Type.Optional(Type.String({ description: "Replacement text or name." })), language: Type.Optional(Type.String()), flags: Type.Optional(Type.String()), checkpointId: Type.Optional(Type.String()), include: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), maxChanges: Type.Optional(Type.Number()), maxFiles: Type.Optional(Type.Number()), input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) {
      const p = mergeInput(params);
      const op = p.operation || "refactor";
      if (op === "status") return ast.status(ctx, p);
      if (op === "rollback") return ast.rollback(ctx, p);
      return queuedRefactor(ctx, p);
    },
  });
}
