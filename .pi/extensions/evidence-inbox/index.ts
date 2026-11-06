import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { scanEvidence, formatEvidence } = require(join(LIB_ROOT, "src", "evidence-inbox.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: 92 image attachments plus perf.data/log shuttling per bug
// loop. List opaque artifact references; trusted providers resolve paths only
// in memory so durable evidence and telemetry remain path-free.
const ENABLED = process.env.PI_EVIDENCE_INBOX !== "0";

export default function evidenceInbox(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("evidence", { description: "List recent evidence artifacts (screenshots, logs, profiles): /evidence [minutes]", handler: async (args: string, ctx: any) => {
    const minutes = Number(String(args || "").trim()) || undefined;
    notify(ctx, formatEvidence(scanEvidence(ctx.cwd, { sinceMinutes: minutes })), "info");
  }});
  pi.registerTool({
    name: "evidence_inbox",
    label: "Evidence inbox",
    description: "List opaque references for recent evidence artifacts and governed visual manifests from configured roots. Use artifactRef in debug or visual verification workflows; absolute paths are not returned or persisted.",
    parameters: Type.Object({
      sinceMinutes: Type.Optional(Type.Number({ description: "Look-back window (default 240)" })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: "Filter: image|video|log|profile|trace|visual-manifest" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const details = scanEvidence(ctx.cwd, { sinceMinutes: params.sinceMinutes, kinds: params.kinds, limit: params.limit });
      return { content: [{ type: "text", text: formatEvidence(details) }], details };
    },
  });
}
