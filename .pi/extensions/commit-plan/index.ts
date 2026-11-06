import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { proposeCommitPlan, applyCommitGroup, formatCommitPlan } = require(join(LIB_ROOT, "src", "commit-plan.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: 1 commit in 549 git invocations - work accumulates in big
// uncommitted trees and gets hand-chunked into logical commits later. This
// proposes the groups; the model refines messages and applies group by group.
const ENABLED = process.env.PI_COMMIT_PLAN !== "0";

export default function commitPlan(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("commit-plan", { description: "Propose logically grouped commits for the current working tree", handler: async (_args: string, ctx: any) => {
    try { notify(ctx, formatCommitPlan(proposeCommitPlan(ctx.cwd)), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerTool({
    name: "commit_plan",
    label: "Commit planner",
    description: "Group the working tree's committable changes into logical commits (source+test pairs, docs, scripts) and apply them one group at a time. Call plan immediately before apply, refine the starter message, and pass exactly one returned file group. Harness runtime state under .pi is rejected; tracked project extension source under .pi/extensions remains committable.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("plan"), Type.Literal("apply")]),
      files: Type.Optional(Type.Array(Type.String(), { description: "Exactly one current file group returned by operation=plan. .pi runtime paths (except project extension source) and stale/unchanged paths are rejected." })),
      message: Type.Optional(Type.String({ description: "Refined commit message (apply)" })),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      if (params.operation === "apply") {
        const details = applyCommitGroup(ctx.cwd, params.files, params.message);
        return { content: [{ type: "text", text: `committed: ${details.head}` }], details };
      }
      const details = proposeCommitPlan(ctx.cwd);
      return { content: [{ type: "text", text: formatCommitPlan(details) }], details };
    },
  });
}
