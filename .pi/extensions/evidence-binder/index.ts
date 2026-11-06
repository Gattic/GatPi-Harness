import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { EvidenceStore, createEvidencePacket, evidenceSummary, captureVerificationEvidence, formatClaimCheck } = require(join(LIB_ROOT, "src", "evidence-binder.js"));
const { normalizeOperation } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const ENABLED = process.env.PI_EVIDENCE_BINDER !== "0";
// Automatic post-response claim warnings are intentionally opt-in. The binder is
// useful as an explicit proof/claim workflow, but warning on every assistant
// summary is noisy before evidence packets have been captured.
const AUTO_WARN = process.env.PI_EVIDENCE_BINDER_WARN === "1";
function store(ctx: any) { return new EvidenceStore({ cwd: ctx.cwd }); }
function textOf(content: any) { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.map((p: any) => p?.text || "").join("\n"); }
function captureLatest(ctx: any) { return captureVerificationEvidence(ctx.cwd, { store: store(ctx) }); }

export default function evidenceBinder(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "evidence-binder", outcomePolicies: { evidence_binder: { check: "domain-negative", bind: "domain-negative", captureVerification: "domain-negative" } } }) as ExtensionAPI;
  if (!ENABLED) return;
  pi.on("message_end" as any, (event: any, ctx: any) => {
    if (!AUTO_WARN || event.message?.role !== "assistant") return;
    const s = store(ctx).status();
    if (!s.evidenceCount) return;
    const text = textOf(event.message.content);
    const result = store(ctx).checkText(text);
    if (result.claims.length && !result.ok) ctx.ui.notify(formatClaimCheck(result), "warning");
  });
  pi.registerCommand("evidence-status", { description: "Show evidence binder status", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ autoWarn: AUTO_WARN, ...store(ctx).status() }, null, 2), "info") });
  pi.registerCommand("evidence-capture-verification", { description: "Capture latest Verification Center evidence as a proof packet", handler: async (_args: string, ctx: any) => { const packet = captureLatest(ctx); const view = packet.captured === false ? packet : evidenceSummary(packet, ctx.cwd); ctx.ui.notify(JSON.stringify(view, null, 2), packet.captured === false || !packet.ok ? "warning" : "info"); } });
  pi.registerCommand("claim-check", { description: "Check text claims against captured evidence: /claim-check <text>", handler: async (args: string, ctx: any) => { const result = store(ctx).checkText(args || ""); store(ctx).recordClaimCheck(args || "", result); ctx.ui.notify(formatClaimCheck(result), result.ok ? "info" : "warning"); } });
  pi.registerCommand("evidence-report", { description: "Show recent evidence and claim checks", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ autoWarn: AUTO_WARN, ...store(ctx).status() }, null, 2), "info") });
  pi.registerTool({
    name: "evidence_binder",
    label: "Evidence binder",
    description: "Capture proof packets and check completion/verification claims against evidence. captureVerification returns outcome=not-applicable with an actionable next step when Verification Center has not run yet; missing prerequisites are never tool failures.",
    parameters: Type.Object({ operation: Type.Optional(Type.String({ description: "Operation: status, captureVerification, capture, check, or bind. Case, snake_case, and kebab-case variants are accepted; captureLatest/verification and claimCheck are aliases." })), text: Type.Optional(Type.String({ description: "Claim text for check/bind." })), input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = normalizeOperation(params.operation, { toolName: "evidence_binder", defaultOperation: "status", operations: ["status", "captureVerification", "capture", "check", "bind"], aliases: { captureLatest: "captureVerification", verification: "captureVerification", claimCheck: "check" } });
      let details: any;
      if (op === "captureVerification") { const packet = captureLatest(ctx); details = packet.captured === false ? packet : evidenceSummary(packet, ctx.cwd); }
      else if (op === "capture") details = evidenceSummary(store(ctx).saveEvidence(createEvidencePacket(params.input || {})), ctx.cwd);
      else if (op === "check" || op === "bind") { details = store(ctx).checkText(params.text || params.input?.text || ""); store(ctx).recordClaimCheck(params.text || params.input?.text || "", details); }
      else details = { autoWarn: AUTO_WARN, ...store(ctx).status({ detail: params.input?.detail === true, limit: params.input?.limit, detailLimit: params.input?.detailLimit }) };
      return { content: [{ type: "text", text: op === "check" || op === "bind" ? formatClaimCheck(details) : JSON.stringify(details, null, 2) }], details };
    },
  });
}
