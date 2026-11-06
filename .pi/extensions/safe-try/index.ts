import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createCheckpoint, revertCheckpoint, listCheckpoints, formatCheckpoints } = require(join(LIB_ROOT, "src", "safe-try.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: 31 reverts and "made it worse" attempts. Snapshot before a
// risky attempt, restore in one call; restores never delete files created
// after the checkpoint (they are reported instead).
const ENABLED = process.env.PI_SAFE_TRY !== "0";

export default function safeTry(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("try", { description: "Create a safe-try checkpoint before a risky attempt: /try [label]", handler: async (args: string, ctx: any) => {
    try { const cp = createCheckpoint(ctx.cwd, String(args || "").trim() || "checkpoint"); notify(ctx, `checkpoint ${cp.id} (untracked snapshot: ${cp.untrackedCount}); revert with /try-revert ${cp.id}`, "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("try-revert", { description: "Restore the working tree to a safe-try checkpoint: /try-revert <id>", handler: async (args: string, ctx: any) => {
    try { notify(ctx, JSON.stringify(revertCheckpoint(ctx.cwd, String(args || "").trim()), null, 2), "warning"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("try-list", { description: "List safe-try checkpoints", handler: async (_args: string, ctx: any) => notify(ctx, formatCheckpoints(listCheckpoints(ctx.cwd)), "info") });
  pi.registerTool({
    name: "safe_try",
    label: "Safe-try checkpoints",
    description: "Snapshot the working tree before a risky attempt and restore it in one call if the attempt makes things worse. checkpoint {label} before the attempt; revert {id} to roll back (files created after the checkpoint are reported, never deleted); list to see checkpoints. Pair with debug_ledger: record the attempt verdict, revert on 'worse'.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("checkpoint"), Type.Literal("revert"), Type.Literal("list")]),
      label: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = params.operation;
      const details = op === "checkpoint" ? createCheckpoint(ctx.cwd, params.label) : op === "revert" ? revertCheckpoint(ctx.cwd, params.id) : listCheckpoints(ctx.cwd);
      const text = Array.isArray(details) ? formatCheckpoints(details) : JSON.stringify(details, null, 2);
      return { content: [{ type: "text", text }], details };
    },
  });
}
