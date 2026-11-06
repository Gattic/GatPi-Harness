import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HermesAdvisoryAdapter } = require("../../src/integration-boundary.js");
const { buildHermesIntegrationScorecard, writeHermesIntegrationScorecard } = require("../../src/hermes-integration-scorecard.js");
const { instrumentExtensionCommands } = require("../../src/pi-extension-kit.js");

const EXTENSION_VERSION = "hermes-advisory-extension-2026-08-23.2";
const ENABLED = !["0", "false", "off", "disabled"].includes(String(process.env.PI_HERMES_ADVISORY || "1").toLowerCase());
const adapters = new Map<string, any>();
function adapterFor(cwd: string): any {
  let adapter = adapters.get(cwd);
  if (!adapter) {
    adapter = new HermesAdvisoryAdapter({ cwd, authority: { advisoryDraftAllowed: true, canonicalPromotionAllowed: false, automaticMutationAllowed: false } });
    adapters.set(cwd, adapter);
  }
  return adapter;
}
function textResult(value: unknown, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details }; }
function explicitHermesIntent(text: unknown): boolean { return /\bhermes\b/i.test(String(text || "")) && /\b(plan|review|evidence|advise|decision|decide|status|doctor|feedback)\b/i.test(String(text || "")); }
function commandInput(args: string, label: string): Record<string, unknown> { const value = String(args || "").trim(); if (!value) throw new Error(`${label} requires a bounded public task or evidence reference`); return { request: value, evidenceRefs: [] }; }
async function show(ctx: ExtensionCommandContext, title: string, value: unknown) { const body = typeof value === "string" ? value : JSON.stringify(value, null, 2); if (ctx.hasUI) ctx.ui.notify(`${title}\n${body}`, "info"); else console.log(body); }

export default function hermesAdvisoryExtension(pi: ExtensionAPI) {
  if (!ENABLED) return;
  pi = instrumentExtensionCommands(pi, { extension: "hermes-advisory", version: EXTENSION_VERSION }) as ExtensionAPI;
  let currentTurnAuthorized = false;

  pi.on("before_agent_start", async (event: any) => {
    currentTurnAuthorized = explicitHermesIntent(event.prompt);
  });
  pi.on("agent_end", () => { currentTurnAuthorized = false; });

  pi.registerCommand("hermes-status", {
    description: "Show Hermes provider readiness separately from advisory and mutation authority",
    handler: async (_args, ctx) => show(ctx, "Hermes advisory status", adapterFor(ctx.cwd).status()),
  });
  pi.registerCommand("hermes-doctor", {
    description: "Run explicit bounded Hermes authentication and optional curation readiness probes",
    handler: async (args, ctx) => {
      const adapter = adapterFor(ctx.cwd);
      const auth = await adapter.probeAuth({ sessionHash: ctx.sessionManager?.getSessionId?.() });
      const curation = /(?:^|\s)--curation(?:\s|$)/.test(args) && auth.ready ? await adapter.probeCuration({ sessionHash: ctx.sessionManager?.getSessionId?.() }) : null;
      await show(ctx, "Hermes doctor", { auth, curation, authority: adapter.status() });
    },
  });
  pi.registerCommand("hermes-plan", {
    description: "Request a typed, read-only Hermes plan for explicit public task text",
    handler: async (args, ctx) => { const result = await adapterFor(ctx.cwd).plan(commandInput(args, "hermes-plan"), { probeAuth: true, sessionHash: ctx.sessionManager?.getSessionId?.() }); await show(ctx, `Hermes plan receipt ${result.receipt.receiptId}`, result.value); },
  });
  pi.registerCommand("hermes-review", {
    description: "Request a typed, read-only Hermes review of explicit public evidence references",
    handler: async (args, ctx) => { const result = await adapterFor(ctx.cwd).review(commandInput(args, "hermes-review"), { probeAuth: true, sessionHash: ctx.sessionManager?.getSessionId?.() }); await show(ctx, `Hermes review receipt ${result.receipt.receiptId}`, result.value); },
  });
  pi.registerCommand("hermes-evidence", {
    description: "Request a typed summary of explicit bounded evidence references",
    handler: async (args, ctx) => { const result = await adapterFor(ctx.cwd).summarizeEvidence(commandInput(args, "hermes-evidence"), { probeAuth: true, sessionHash: ctx.sessionManager?.getSessionId?.() }); await show(ctx, `Hermes evidence receipt ${result.receipt.receiptId}`, result.value); },
  });
  pi.registerCommand("hermes-scorecard", {
    description: "Build the qualified-denominator Hermes assistant/memory/skill scorecard; add --write to persist private JSON",
    handler: async (args, ctx) => { const result = /(?:^|\s)--write(?:\s|$)/.test(args) ? writeHermesIntegrationScorecard({ cwd: ctx.cwd }) : { card: buildHermesIntegrationScorecard({ cwd: ctx.cwd }), output: null }; await show(ctx, result.output ? `Hermes scorecard written: ${result.output}` : "Hermes scorecard preview", result.card); },
  });
  pi.registerCommand("hermes-feedback", {
    description: "Record explicit accept/reject disposition for a Hermes advisory receipt",
    handler: async (args, ctx) => { const [receiptId, verdict] = String(args || "").trim().split(/\s+/); if (!receiptId || !["accept", "reject"].includes(verdict)) throw new Error("Usage: /hermes-feedback <receipt-id> accept|reject"); const row = adapterFor(ctx.cwd).recordAcceptance({ receiptId, accepted: verdict === "accept", sessionHash: ctx.sessionManager?.getSessionId?.() }); await show(ctx, "Hermes feedback recorded", row); },
  });

  pi.registerTool({
    name: "hermes_advisory",
    label: "Hermes advisory",
    description: "Use Hermes only when the current user explicitly requests Hermes. Operations are read-only and return typed advisory drafts; this tool cannot mutate memory, install skills, publish, or claim completion.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("status"), Type.Literal("plan"), Type.Literal("review"), Type.Literal("summarize_evidence")]),
      request: Type.Optional(Type.String({ maxLength: 12000 })),
      evidenceRefs: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 64 })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const adapter = adapterFor(ctx.cwd);
      if (!currentTurnAuthorized) throw new Error("Hermes advisory use requires explicit current-user Hermes intent");
      if (params.operation === "status") return textResult(adapter.status(), { mutation: "none" });
      const packet = { request: String(params.request || "").trim(), evidenceRefs: params.evidenceRefs || [] };
      if (!packet.request && !packet.evidenceRefs.length) throw new Error("Hermes advisory requires bounded public request text or evidence references");
      const options = { signal, probeAuth: true, sessionHash: ctx.sessionManager?.getSessionId?.() };
      const result = params.operation === "plan" ? await adapter.plan(packet, options) : params.operation === "review" ? await adapter.review(packet, options) : await adapter.summarizeEvidence(packet, options);
      return textResult(result.value, { receiptId: result.receipt.receiptId, operation: params.operation, mutation: "none" });
    },
  });
}
