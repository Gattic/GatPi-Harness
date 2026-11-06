import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { routeToolSurface, activationCatalog, activateManagedTools } = require(join(LIB_ROOT, "src", "tool-surface-router.js"));
const { createExtensionTelemetry, contextSessionKind, sourceFingerprintForFile, instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "extension-telemetry.js"));

const ENABLED = process.env.PI_TOOL_SURFACE_ROUTER !== "0";
const EXTENSION_VERSION = "tool-surface-router-2026-10-26.1";

type Opportunity = { trigger: string; extension: string; tools: string[]; acted?: boolean };
type RouteState = {
  initialized: boolean;
  initialActive: string[];
  allNames: string[];
  sourceByExtension: Map<string, string>;
  last: any;
  opportunities: Opportunity[];
};

function extensionIdFromTool(tool: any) {
  const source = String(tool?.sourceInfo?.path || "");
  const match = source.match(/[\\/](?:\.pi[\\/])?extensions[\\/]([^\\/]+)[\\/]index\.[cm]?[jt]s$/i);
  return match?.[1] || null;
}

function sessionId(ctx: any) {
  try { return String(ctx?.sessionManager?.getSessionId?.() || ""); }
  catch { return ""; }
}

function sameNames(left: string[], right: string[]) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function renderCatalog(catalog: any[]) {
  const lines = ["Optional harness tools (activate with tools: [names]; inactive tools are not declared in this session):"];
  for (const group of catalog) {
    const tools = group.tools.map((row: any) => row.reason ? `${row.name} (${row.state}: ${row.reason})` : `${row.name} (${row.state})`);
    lines.push(`- ${group.id}: ${tools.join(", ")}`);
  }
  return lines.join("\n");
}

function renderActivation(result: any) {
  const lines: string[] = [];
  if (result.activated.length) lines.push(`Activated: ${result.activated.join(", ")}`);
  if (result.alreadyActive.length) lines.push(`Already active: ${result.alreadyActive.join(", ")}`);
  if (result.blocked.length) lines.push(`Blocked: ${result.blocked.map((row: any) => `${row.tool} (${row.reason})`).join(", ")}`);
  if (result.ineligible.length) lines.push(`Not eligible in this session: ${result.ineligible.join(", ")}`);
  if (result.unknown.length) lines.push(`Unknown optional tool: ${result.unknown.join(", ")}`);
  return lines.join("\n") || "No tools activated.";
}

export default function toolSurfaceRouter(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi, { extension: "tool-surface-router", version: EXTENSION_VERSION }) as ExtensionAPI;
  if (!ENABLED) return;
  const state: RouteState = { initialized: false, initialActive: [], allNames: [], sourceByExtension: new Map(), last: null, opportunities: [] };
  const recorders = new Map<string, any>();

  const initialize = () => {
    const all = pi.getAllTools?.() || [];
    state.allNames = all.map((tool: any) => String(tool.name)).filter(Boolean).sort();
    state.initialActive = (pi.getActiveTools?.() || []).filter((name: string) => state.allNames.includes(name));
    state.sourceByExtension.clear();
    for (const tool of all) {
      const extension = extensionIdFromTool(tool);
      const file = tool?.sourceInfo?.path;
      if (extension && file && !state.sourceByExtension.has(extension)) state.sourceByExtension.set(extension, sourceFingerprintForFile(file));
    }
    state.initialized = true;
  };

  const apply = (prompt: string, cwd: string, reset = false) => {
    if (!state.initialized) initialize();
    const current = pi.getActiveTools?.() || [];
    const route = routeToolSurface({
      prompt,
      cwd,
      env: process.env,
      allToolNames: state.allNames,
      initialActiveToolNames: state.initialActive,
      currentActiveToolNames: current,
      reset,
    });
    const next = [...route.activeTools].sort();
    const now = [...current].sort();
    if (!sameNames(now, next)) pi.setActiveTools(next);
    state.last = { ...route, activeTools: next, at: new Date().toISOString() };
    state.opportunities = route.opportunities.map((row: Opportunity) => ({ ...row, acted: false }));
    return route;
  };

  // The model cannot wait for a later user prompt to mention its task when the
  // need appears mid-session (a discovered bug, a run it just launched). This
  // one baseline tool carries the same eligibility and readiness answer the
  // router uses, so activation cannot widen a restricted child surface or
  // bypass a configuration/provider gate.
  pi.registerTool({
    name: "activate_tools",
    label: "Activate optional tools",
    description: "Activate optional harness tools that the task router keeps off the default tool surface (debug ledger, fix recall, safe try, evidence inbox, run deck, run monitor, experiment ledger, automation loop, commit plan, delegation/topology, memory/vault, codegraph, semgrep, evidence, CI, queue, extension governance). Call with no arguments to list every optional tool with its state and blockers; pass tools: [names] to activate them for this session. Activation is additive and session-scoped; configuration and provider gates still apply.",
    parameters: Type.Object({
      tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool names to activate; omit to list the catalog" })),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      if (!state.initialized) initialize();
      const options = {
        allToolNames: state.allNames,
        initialActiveToolNames: state.initialActive,
        currentActiveToolNames: pi.getActiveTools?.() || [],
        cwd: ctx?.cwd,
        env: process.env,
      };
      const requested = Array.isArray(params?.tools) ? params.tools.map(String) : [];
      if (!requested.length) {
        const catalog = activationCatalog(options);
        return { content: [{ type: "text", text: renderCatalog(catalog) }], details: { catalog } };
      }
      const result = activateManagedTools({ ...options, tools: requested });
      if (result.activated.length) {
        pi.setActiveTools(result.activeTools);
        if (state.last) state.last = { ...state.last, activeTools: result.activeTools };
      }
      return { content: [{ type: "text", text: renderActivation(result) }], details: result };
    },
  });

  pi.on("session_start" as any, (_event: any, ctx: any) => {
    initialize();
    apply("", ctx.cwd, true);
  });

  // Every turn keeps the tools already active and can only add to them (see
  // routeToolSurface).
  pi.on("input" as any, (event: any, ctx: any) => {
    apply(String(event?.text || ""), ctx.cwd);
  });

  pi.on("tool_call" as any, (event: any) => {
    const tool = String(event?.toolName || event?.name || "");
    for (const opportunity of state.opportunities) if (opportunity.tools.includes(tool)) opportunity.acted = true;
  });

  pi.on("agent_settled" as any, (_event: any, ctx: any) => {
    if (!state.opportunities.length) return;
    const active = new Set(pi.getActiveTools?.() || []);
    const kind = contextSessionKind(ctx);
    for (const opportunity of state.opportunities) {
      const fingerprint = state.sourceByExtension.get(opportunity.extension) || "unavailable";
      const key = `${ctx.cwd}:${opportunity.extension}:${fingerprint}`;
      if (!recorders.has(key)) recorders.set(key, createExtensionTelemetry({ cwd: ctx.cwd, extension: opportunity.extension, version: EXTENSION_VERSION, sourceFingerprint: fingerprint }));
      const recorder = recorders.get(key);
      const eligible = opportunity.tools.some((tool) => active.has(tool));
      recorder.opportunity(opportunity.trigger, eligible ? "eligible" : "ineligible", opportunity.acted === true, "unknown", "unknown", kind, recorder.sessionToken(sessionId(ctx)));
    }
    state.opportunities = [];
  });

  pi.registerCommand("tool-surface", {
    description: "Show deterministic task-aware tool-surface routing state",
    handler: async (_args: string, ctx: any) => {
      if (!state.initialized) initialize();
      ctx.ui.notify(JSON.stringify({
        version: EXTENSION_VERSION,
        enabled: ENABLED,
        allTools: state.allNames.length,
        initialActive: state.initialActive.length,
        currentActive: pi.getActiveTools?.() || [],
        route: state.last,
        privacy: { promptPersisted: false, toolArgumentsPersisted: false, fixedIntentLabelsOnly: true },
      }, null, 2), "info");
    },
  });
}
