import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { recallFixes, formatRecall } = require(join(LIB_ROOT, "src", "fix-recall.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// The same bug classes recur across sessions; fixes that worked are
// forgotten. Search resolved debug-ledger threads and learning outcomes for
// a similar error signature before debugging from scratch.
const ENABLED = process.env.PI_FIX_RECALL !== "0";

export default function fixRecall(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("fix-recall", { description: "Search past fixes and record metadata-only attribution; add --no-record to disable telemetry", handler: async (args: string, ctx: any) => {
    const text = String(args || ""); const record = !/(^|\s)--no-record(\s|$)/.test(text); const query = text.replace(/(^|\s)--no-record(?=\s|$)/g, " ").trim();
    if (!query) return notify(ctx, "Usage: /fix-recall [--no-record] <error text>", "warning");
    notify(ctx, formatRecall(recallFixes(ctx.cwd, query, { record })), "info");
  }});
  pi.registerTool({
    name: "fix_recall",
    label: "Fix recall",
    description: "Search past fixes. By default this appends privacy-safe retrieval metadata (never the query/error text) so later debug attempts can attribute usefulness; set record=false for a pure read. Fix Recall never auto-applies changes.",
    parameters: Type.Object({ error: Type.String({ description: "The error text or failure summary to match against past fixes" }), record: Type.Optional(Type.Boolean({ description: "Record metadata-only retrieval attribution; defaults true" })) }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const details = recallFixes(ctx.cwd, params.error, { record: params.record !== false });
      return { content: [{ type: "text", text: formatRecall(details) }], details };
    },
  });
}
