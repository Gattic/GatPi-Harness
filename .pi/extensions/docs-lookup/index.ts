import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createDocsLookup, parseCliArgs, formatSize } = require(join(LIB_ROOT, "src", "docs-lookup.js"));

// Env knobs are parsed in src/docs-lookup.js: process.env.PI_DOCS_LOOKUP process.env.PI_DOCS_ALLOW_OUTSIDE process.env.PI_DOCS_MAX_LINES process.env.PI_DOCS_MAX_BYTES process.env.PI_DOCS_MAX_FILES process.env.PI_DOCS_MAX_RESULTS process.env.PI_DOCS_MAX_FILE_BYTES
const docs = createDocsLookup();
const ENABLED = docs.config.enabled;
const OUTPUT_MAX_LINES = docs.config.outputMaxLines;
const OUTPUT_MAX_BYTES = docs.config.outputMaxBytes;

type ToolContext = { cwd: string; ui?: any };
const Operation = StringEnum(["status", "search", "read", "package"] as const);
const Source = StringEnum(["local", "node_modules", "all"] as const);

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

export default function docsLookupExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;

  pi.registerCommand("docs-status", { description: "Show local docs lookup status", handler: async (args: string, ctx: any) => notify(ctx, docs.status(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("docs-lookup", { description: "Search local/package docs: /docs-lookup [--package pkg] <query>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, docs.search(ctx, { ...parsed.opts, query: parsed.positional.join(" ") })); } });
  pi.registerCommand("docs-read", { description: "Read a docs file: /docs-read <path> [--offset n] [--limit n]", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, docs.read(ctx, { ...parsed.opts, file: parsed.positional[0] || parsed.opts.file })); } });
  pi.registerCommand("docs-package", { description: "Inspect installed package docs: /docs-package <package-name>", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, docs.packageLookup(ctx, { ...parsed.opts, packageName: parsed.opts.packageName || parsed.positional[0] })); } });

  pi.registerTool({
    name: "docs_lookup",
    label: "Docs lookup",
    outputSchema: require("../../../src/pi-extension-kit.js").TOOL_OUTPUT_SCHEMAS.docs_lookup,
    description: `Search and read local repository docs plus installed node_modules package docs without network access. Output is truncated to ${OUTPUT_MAX_LINES} lines or ${formatSize(OUTPUT_MAX_BYTES)}.`,
    promptSnippet: "Search/read local repository docs and installed package docs by exact installed version",
    promptGuidelines: ["Use docs_lookup before relying on memory for library and active-project APIs when local docs are available.", "For Pi itself (extensions, themes, skills, TUI, SDK, providers, or models), use the read tool on $PI_SOURCE_ROOT/packages/coding-agent/README.md, docs/, and examples/ (default source checkout: ../GatPi); do not weaken docs_lookup confinement with PI_DOCS_ALLOW_OUTSIDE.", "Use docs_lookup package with packageName to inspect installed package README/types instead of hallucinating APIs."],
    parameters: Type.Object({ operation: Type.Optional(Operation), query: Type.Optional(Type.String({ description: "Search query for operation=search." })), path: Type.Optional(Type.String({ description: "Project path for docs lookup. Defaults to cwd; explicit escapes require PI_DOCS_ALLOW_OUTSIDE=1." })), file: Type.Optional(Type.String({ description: "Docs file path for operation=read." })), source: Type.Optional(Source), packageName: Type.Optional(Type.String({ description: "Installed node_modules package name, e.g. typebox or @scope/pkg." })), offset: Type.Optional(Type.Number({ description: "1-indexed line offset for operation=read." })), limit: Type.Optional(Type.Number({ description: "Maximum lines for operation=read." })), maxResults: Type.Optional(Type.Number({ description: "Maximum search results." })), contextLines: Type.Optional(Type.Number({ description: "Search snippet context lines." })), includeSourceTypes: Type.Optional(Type.Boolean({ description: "Include .d.ts/.ts/.js docs-like source files in local search." })), input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) {
      const p = mergeInput(params);
      const op = p.operation || "search";
      if (op === "status") return docs.status(ctx, p);
      if (op === "search") return docs.search(ctx, p);
      if (op === "read") return docs.read(ctx, p);
      if (op === "package") return docs.packageLookup(ctx, p);
      throw new Error(`Unknown docs_lookup operation: ${op}`);
    },
  });
}
