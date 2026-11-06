import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { launchRun, attachRun, runStatus, watchRun, noteRun, finishRun, listRuns, formatRuns, formatRunStatus, runsSummary } = require(join(LIB_ROOT, "src", "run-deck.js"));
const { notify, createContextInjector } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining (glades-ml): "Give a status report on the current run" x69
// verbatim, 154x as a family - 36% of all human turns - each answered with a
// hand-built ls -td/tail/grep/nvidia-smi compound. One durable run record +
// one status call replaces that ritual.
const ENABLED = process.env.PI_RUN_DECK !== "0";
const INJECT = process.env.PI_RUN_DECK_INJECT !== "0";

export default function runDeck(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  const injection = createContextInjector({ customType: "run-deck", maxChars: process.env.PI_RUN_DECK_INJECT_MAX_CHARS });

  pi.on("session_start", () => injection.reset());
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    if (!INJECT) return;
    let summary = "";
    try { summary = runsSummary(ctx.cwd); } catch { return; }
    return injection.inject(summary);
  });

  pi.registerCommand("run-status", { description: "Status of the current (or given) long-running run: /run-status [run-id]", handler: async (args: string, ctx: any) => {
    try { notify(ctx, formatRunStatus(runStatus(ctx.cwd, String(args || "").trim() || undefined, { recordInteraction: true })), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("runs", { description: "List registered runs: /runs [running|exited|finished|shipped|killed|failed]", handler: async (args: string, ctx: any) => {
    const status = String(args || "").trim() || undefined;
    notify(ctx, formatRuns(listRuns(ctx.cwd, { status })), "info");
  }});
  pi.registerCommand("run-launch", { description: "Launch a run as a detached job and register it: /run-launch <command> [:: name [:: log path/pattern]]", handler: async (args: string, ctx: any) => {
    const [command, name, logPath] = String(args || "").split("::").map((part) => part.trim());
    if (!command) return notify(ctx, "Usage: /run-launch <command> [:: name [:: log path/pattern]]", "warning");
    try { const run = launchRun(ctx.cwd, command, { name: name || undefined, logPath: logPath || undefined }); notify(ctx, `registered ${run.runId} (job ${run.jobId}, pid ${run.pid})`, "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("run-attach", { description: "Register an externally-launched run: /run-attach <log path or pattern like logs/x_*/run.log> [:: name [:: pgrep pattern]]", handler: async (args: string, ctx: any) => {
    const [logPath, name, pidPattern] = String(args || "").split("::").map((part) => part.trim());
    if (!logPath) return notify(ctx, "Usage: /run-attach <log path/pattern> [:: name [:: pgrep pattern]]", "warning");
    try { const run = attachRun(ctx.cwd, { logPath, name: name || undefined, pidPattern: pidPattern || undefined }); notify(ctx, `attached ${run.runId}: ${run.name}`, "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("run-finish", { description: "Close out a run: /run-finish <run-id> <finished|killed|shipped|failed> [verdict]", handler: async (args: string, ctx: any) => {
    const [runId, status, ...rest] = String(args || "").trim().split(/\s+/);
    try { const run = finishRun(ctx.cwd, runId, { status, verdict: rest.join(" ") || undefined }); notify(ctx, `${run.runId} -> ${run.status}${run.verdict ? `: ${run.verdict}` : ""}`, "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});

  pi.registerTool({
    name: "run_deck",
    label: "Run deck",
    description: "Durable registry + status for long-running runs (training, downloads, pretokenization). Operations: launch/attach register once; status gives point-in-time vitals; watch is a short bounded milestone wait; note/finish record observations and final evidence. Manual status remains available. For an explicit request for periodic notification or settlement alerting, attach run_monitor instead of repeating status/watch calls; monitoring never starts model turns.",
    promptGuidelines: ["Use status for an explicit point-in-time report and watch only for a short bounded milestone.", "When the user requests periodic checks or notification on settlement, attach run_monitor to this run rather than repeatedly polling."],
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("launch"), Type.Literal("attach"), Type.Literal("status"), Type.Literal("watch"), Type.Literal("note"), Type.Literal("finish"), Type.Literal("list")]),
      command: Type.Optional(Type.String({ description: "Shell command (launch)" })),
      name: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String()),
      logPath: Type.Optional(Type.String({ description: "Log file or one-level wildcard pattern (attach/launch)" })),
      pidPattern: Type.Optional(Type.String({ description: "pgrep -f pattern for alive checks of external runs" })),
      pattern: Type.Optional(Type.String({ description: "Milestone regex (watch)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Watch bound, capped at 9 minutes" })),
      note: Type.Optional(Type.String()),
      status: Type.Optional(Type.String({ description: "finish: finished|killed|shipped|failed; list: filter" })),
      verdict: Type.Optional(Type.String({ description: "Final verdict, e.g. banked val numbers (finish)" })),
      metrics: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = params.operation;
      let details: any;
      let text: string;
      if (op === "launch") { details = launchRun(ctx.cwd, params.command, params); text = `registered ${details.runId} (job ${details.jobId}, pid ${details.pid})`; }
      else if (op === "attach") { details = attachRun(ctx.cwd, params); text = `attached ${details.runId}: ${details.name}`; }
      else if (op === "status") { details = runStatus(ctx.cwd, params.runId, { recordInteraction: true }); text = formatRunStatus(details); }
      else if (op === "watch") { if (!String(params.pattern || "").trim()) throw new Error("run_deck operation=watch requires a milestone pattern. Use operation=status for one point-in-time inspection, or run_monitor for periodic settlement notification."); details = await watchRun(ctx.cwd, params.runId, { ...params, recordInteraction: true }); text = `${details.outcome} after ${Math.round(details.elapsedMs / 1000)}s${details.tail ? `\n${details.tail}` : ""}`; }
      else if (op === "note") { details = noteRun(ctx.cwd, params.runId, params.note); text = `noted on ${details.runId}`; }
      else if (op === "finish") { details = finishRun(ctx.cwd, params.runId, params); text = `${details.runId} -> ${details.status}`; }
      else { details = listRuns(ctx.cwd, { status: params.status }); text = formatRuns(details); }
      return { content: [{ type: "text", text }], details };
    },
  });
}
