import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { SCOPE_ENV, projectScope, assertProjectScope, describeScope, stateInventory, readLogs, readStateFile } = require(join(LIB_ROOT, "src", "project-scope.js"));
const { notify, instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// A second directory is never discovered implicitly. The session project scope
// is the working directory plus directories named in PI_HARNESS_PROJECT_DIRS or
// granted with /policy-approve-directory, and this tool reads only their `.pi`
// state: the folder inventory, bounded log tails, and bounded state files.
const ENABLED = process.env.PI_PROJECT_SCOPE !== "0";
const EXTENSION_VERSION = "project-scope-2026-11-06.1";
const MAX_STATE_BYTES = 64 * 1024;

type ToolContext = { cwd: string; ui?: any };
const Operation = StringEnum(["list", "state", "logs", "read"] as const);

function boundedJson(value: any, maxChars = 24000) {
  const text = JSON.stringify(value, null, 2);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

function resolveTarget(ctx: ToolContext, input: any) {
  const scope = projectScope(ctx.cwd);
  if (!input?.path) return { scope, root: scope.roots[0] };
  const target = resolve(ctx.cwd, String(input.path));
  const resolved = assertProjectScope(ctx.cwd, target, { label: "project_scope" });
  return { scope: resolved.scope, root: resolved.root };
}

function execute(input: any, ctx: ToolContext) {
  const operation = String(input?.operation || "list");
  if (operation === "list") {
    return describeScope(projectScope(ctx.cwd), { maxEntries: 0 });
  }
  const { scope, root } = resolveTarget(ctx, input);
  const sinceMinutes = Number(input?.sinceMinutes || 0);
  const sinceMs = Number.isFinite(sinceMinutes) && sinceMinutes > 0 ? Date.now() - sinceMinutes * 60 * 1000 : 0;
  if (operation === "state") {
    return { ...stateInventory(root.path, { maxEntries: Number(input?.maxEntries || 50) }), scope: { primary: scope.primary, roots: scope.paths } };
  }
  if (operation === "logs") {
    return readLogs(root.path, {
      maxFiles: Number(input?.maxFiles || 5),
      maxLines: Number(input?.maxLines || 80),
      maxBytes: Number(input?.maxBytes || 16 * 1024),
      sinceMs,
    });
  }
  if (operation === "read") {
    return readStateFile(root.path, input?.file, { maxBytes: Number(input?.maxBytes || MAX_STATE_BYTES) });
  }
  throw new Error(`Unknown project_scope operation: ${operation}`);
}

export default function projectScopeExtension(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi, { extension: "project-scope", version: EXTENSION_VERSION }) as ExtensionAPI;
  if (!ENABLED) return;

  pi.registerTool({
    name: "project_scope",
    label: "Project scope",
    description: `Access the .pi state, logs, and files of another project directory that is in the session project scope (working directory, ${SCOPE_ENV}, or a /policy-approve-directory grant). Read-only and bounded: list scope roots, inventory a root's .pi state, tail its diagnostic logs, or read one bounded state file.`,
    promptSnippet: "Read another in-scope project directory's .pi state, logs, and state files",
    promptGuidelines: [
      "Use project_scope list first to see which directories are in scope; a directory is in scope only when it is the working directory, named in PI_HARNESS_PROJECT_DIRS, or granted with /policy-approve-directory.",
      "Use project_scope state before project_scope logs so you know which state directories actually exist and how large they are.",
      "project_scope is read-only; harness mutations still belong to the tool that owns that state (for example memory_curator for memories).",
    ],
    parameters: Type.Object({
      operation: Type.Optional(Operation),
      path: Type.Optional(Type.String({ description: "Project directory in the session scope. Defaults to the working directory; a subdirectory resolves to its owning scope root." })),
      file: Type.Optional(Type.String({ description: "State file for operation=read, relative to the root's .pi directory." })),
      maxEntries: Type.Optional(Type.Number({ description: "Maximum top-level .pi entries for operation=state." })),
      maxFiles: Type.Optional(Type.Number({ description: "Maximum newest log files for operation=logs." })),
      maxLines: Type.Optional(Type.Number({ description: "Maximum tail lines per log file for operation=logs." })),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes read per file for operation=read or operation=logs." })),
      sinceMinutes: Type.Optional(Type.Number({ description: "Only include log files modified within the last N minutes." })),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) {
      const details = execute({ ...(params?.input || {}), ...params }, ctx);
      return { content: [{ type: "text", text: boundedJson(details) }], details };
    },
  });

  pi.registerCommand("project-scope", {
    description: "Show the session project scope and another directory's .pi state: /project-scope [list|state|logs|read] [path] [file]",
    handler: async (args: string, ctx: any) => {
      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      const operation = ["list", "state", "logs", "read"].includes(tokens[0]) ? tokens[0] : "list";
      const path = ["list"].includes(operation) ? undefined : tokens[1];
      const file = operation === "read" ? tokens[2] : undefined;
      try {
        const details = execute({ operation, path, file }, ctx);
        notify(ctx, boundedJson(details, 12000), "info");
      } catch (error: any) {
        notify(ctx, String(error?.message || error), "error");
      }
    },
  });
}
