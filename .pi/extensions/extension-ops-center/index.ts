import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { scanExtensionRegistry, smokePlan, renderRegistryMarkdown } = require(join(LIB_ROOT, "src", "extension-registry.js"));
const { writeJson, readExtensionTelemetry, instrumentExtensionCommands, telemetrySessionToken } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { compareExtensionCohorts, contextSessionKind } = require(join(LIB_ROOT, "src", "extension-telemetry.js"));
const { operationCanaryPlan, recordOperationCanary } = require(join(LIB_ROOT, "src", "extension-canaries.js"));
const { portfolioReport } = require(join(LIB_ROOT, "src", "extension-portfolio.js"));
const { opportunityReviewReport, reviewOpportunity } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const ENABLED = process.env.PI_EXTENSION_OPS !== "0";
const STATE_DIR = ".pi/extension-ops";
const EXTENSION_VERSION = "extension-ops-2026-07-25.2";

function runtimeMetadata(pi: any) {
  const errors: string[] = [];
  let tools: any[] | undefined; let activeTools: string[] | undefined; let commands: any[] | undefined;
  try { tools = pi.getAllTools(); } catch (error: any) { errors.push(`tools:${error?.message || String(error)}`); }
  try { activeTools = pi.getActiveTools(); } catch (error: any) { errors.push(`active-tools:${error?.message || String(error)}`); }
  try { commands = pi.getCommands(); } catch (error: any) { errors.push(`commands:${error?.message || String(error)}`); }
  return { available: Boolean(tools || commands), tools, activeTools, commands, errors };
}
function aggregateAudit(cwd: string) {
  try { const value = JSON.parse(readFileSync(join(cwd, ".pi", "session-audit", "latest.json"), "utf8")); return value?.privacy?.aggregateOnly === true ? value : {}; }
  catch { return {}; }
}
function currentSessionToken(ctx: any) {
  try { return telemetrySessionToken(ctx.sessionManager.getSessionId(), { cwd: ctx.cwd }); }
  catch { return "none"; }
}
function telemetry(ctx: any) { return readExtensionTelemetry({ cwd: ctx.cwd, excludeSessionToken: currentSessionToken(ctx) }); }
function registry(ctx: any, pi: any) {
  const inventory = scanExtensionRegistry({ cwd: ctx.cwd, runtime: runtimeMetadata(pi) });
  inventory.portfolio = portfolioReport(inventory, telemetry(ctx), aggregateAudit(ctx.cwd));
  return inventory;
}
function canaries(ctx: any, pi: any) {
  const report = registry(ctx, pi);
  const plan = operationCanaryPlan(report, runtimeMetadata(pi));
  const evidence = readExtensionTelemetry({ cwd: ctx.cwd }).canaries;
  return { plan, evidence };
}
function renderOpsDocs(report: any) {
  return `${renderRegistryMarkdown(report)}\n\n## Lifecycle portfolio\n\n- Schema: ${report.portfolio.schemaVersion}\n- Records/tool decisions: ${report.portfolio.summary.extensions}/${report.portfolio.summary.tools}\n- Default active model tools: ${report.portfolio.summary.defaultActiveToolsBefore} → ${report.portfolio.summary.defaultActiveToolsAfter}\n- Observation: ${report.portfolio.observation.observedDays}/${report.portfolio.observation.requiredDays} days (${report.portfolio.summary.observationStatus})\n- Reconciled: ${report.portfolio.summary.reconciled}\n- Records: [extension portfolio](./extension-portfolio/README.md)\n`;
}
function format(report: any) {
  return [
    `Extension ops: configuredRoots=${report.summary.configuredRoots} extensions=${report.summary.extensions}`,
    `declared commands/tools=${report.summary.commands}/${report.summary.tools}`,
    `registered commands/tools=${report.summary.registeredCommands}/${report.summary.registeredTools}; active tools=${report.summary.activeTools}`,
    `loaded=${report.summary.loaded}; degraded=${report.summary.degraded}; conditional=${report.summary.conditional}`,
    `conflicts=${report.summary.conflicts}; unexplained=${report.summary.unexplainedDiscrepancies}`,
    `portfolio=${report.portfolio.summary.extensions} extensions/${report.portfolio.summary.tools} tool decisions; default active=${report.portfolio.summary.defaultActiveToolsBefore}->${report.portfolio.summary.defaultActiveToolsAfter}`,
    `observation=${report.portfolio.observation.observedDays}/${report.portfolio.observation.requiredDays} classified interactive days (${report.portfolio.summary.observationStatus}); adoption records=${report.portfolio.summary.measuredAdoptionRecords}; opportunity records=${report.portfolio.summary.measuredOpportunityRecords}; lifecycle=${report.portfolio.summary.lifecycleAuthority}; reconciled=${report.portfolio.summary.reconciled}`,
  ].join("\n");
}

export default function extensionOpsCenter(pi: ExtensionAPI) {
  if (!ENABLED) return;
  pi = instrumentExtensionCommands(pi, { extension: "extension-ops-center", version: EXTENSION_VERSION }) as ExtensionAPI;

  pi.registerCommand("extensions-opportunities", { description: "Show source-qualified opportunity review queues and usefulness gates", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(opportunityReviewReport(ctx.cwd, { excludeSessionToken: currentSessionToken(ctx) }), null, 2), "info") });
  pi.registerCommand("extensions-opportunity-review", { description: "Human-only usefulness review: /extensions-opportunity-review <event-id>", handler: async (args, ctx: any) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const eventId = String(args || "").trim();
    const text = await ctx.ui.editor("Review one real opportunity", JSON.stringify({ reviewer: { kind: "human", id: "" }, evidenceIds: [], value: null, coreDisplacement: null, analysisOutcome: null }, null, 2));
    if (!text || text.length > 8192 || !await ctx.ui.confirm("Record your judgment?", "value: helpful/not-helpful; coreDisplacement: displaced/shell-used/not-applicable. No automatic lifecycle change.")) return;
    try { reviewOpportunity(ctx.cwd, eventId, JSON.parse(text)); ctx.ui.notify("Review recorded without adding an opportunity.", "info"); } catch (error: any) { ctx.ui.notify(error.message, "warning"); }
  } });

  pi.registerCommand("extensions-report", { description: "Show Pi extension inventory summary", handler: async (_args: string, ctx: any) => { const report = registry(ctx, pi); writeJson(join(ctx.cwd, STATE_DIR, "latest-registry.json"), report); ctx.ui.notify(format(report), report.summary.conflicts || report.summary.unexplainedDiscrepancies ? "warning" : "info"); } });
  pi.registerCommand("extensions-inventory", { description: "Show full extension command/tool/env inventory", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(registry(ctx, pi), null, 2), "info") });
  pi.registerCommand("extensions-conflicts", { description: "Show duplicate command/tool registrations", handler: async (_args: string, ctx: any) => { const report = registry(ctx, pi); ctx.ui.notify(JSON.stringify(report.conflicts, null, 2), report.summary.conflicts ? "warning" : "info"); } });
  pi.registerCommand("extensions-portfolio", { description: "Show versioned lifecycle records, model-tool decisions, and evidence sufficiency", handler: async (_args: string, ctx: any) => { const report = registry(ctx, pi).portfolio; ctx.ui.notify(JSON.stringify(report, null, 2), report.summary.reconciled ? "info" : "warning"); } });
  pi.registerCommand("extensions-smoke-plan", { description: "Show extension smoke-test command matrix", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(smokePlan(registry(ctx, pi)), null, 2), "info") });
  pi.registerCommand("extensions-canaries", { description: "Show operation-level extension canary templates and recorded metadata evidence", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(canaries(ctx, pi), null, 2), "info") });
  pi.registerCommand("extensions-docs", { description: "Write extension inventory and lifecycle summary markdown", handler: async (_args: string, ctx: any) => { const out = join(ctx.cwd, "docs", "extension-inventory.md"); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, renderOpsDocs(registry(ctx, pi))); ctx.ui.notify(`Wrote ${out}`, "info"); } });
  pi.registerTool({
    name: "extension_ops",
    label: "Extension ops",
    description: "Inventory Pi extensions, reconcile lifecycle/model-tool decisions, inspect exact-source telemetry cohorts, compare pre/post operation evidence, manage metadata-only operation canary records, detect conflicts, generate smoke plans, and render docs.",
    parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("report"), Type.Literal("inventory"), Type.Literal("portfolio"), Type.Literal("telemetry"), Type.Literal("compare"), Type.Literal("canaries"), Type.Literal("conflicts"), Type.Literal("smokePlan"), Type.Literal("docs")])), input: Type.Optional(Type.Any({ description: "compare: extension plus optional before/after fingerprints or versions. canaries: optional record {canaryId, stage, outcome, durationMs, version}; records metadata only." })) }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const operation = params.operation || "report";
      const report = registry(ctx, pi);
      let details: any = report;
      if (operation === "telemetry") details = telemetry(ctx);
      else if (operation === "compare") details = compareExtensionCohorts(telemetry(ctx), params.input || {});
      else if (operation === "canaries") {
        const view = canaries(ctx, pi);
        if (params.input?.record) {
          const token = telemetrySessionToken(ctx.sessionManager?.getSessionId?.(), { cwd: ctx.cwd });
          const recorded = recordOperationCanary({ cwd: ctx.cwd, plan: view.plan, record: params.input.record, sessionKind: contextSessionKind(ctx), sessionToken: token });
          details = { recorded, plan: view.plan, evidence: readExtensionTelemetry({ cwd: ctx.cwd }).canaries };
        } else details = view;
      }
      else if (operation === "portfolio") details = report.portfolio;
      else if (operation === "conflicts") details = report.conflicts;
      else if (operation === "smokePlan") details = smokePlan(report);
      else if (operation === "docs") details = { markdown: renderOpsDocs(report) };
      return { content: [{ type: "text", text: operation === "report" ? format(report) : JSON.stringify(details, null, 2) }], details };
    },
  });
}
