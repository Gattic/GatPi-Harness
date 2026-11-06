import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { openExperiment, recordGate, closeExperiment, listExperiments, showExperiment, formatExperiment, openExperimentsSummary } = require(join(LIB_ROOT, "src", "experiment-ledger.js"));
const { notify, createContextInjector } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: ~170 hand-written memory files track pre-registered gate
// ladders (E0..E4, PASS/FAIL/NULL, GPU-hours, ship/no-go) because the
// harness has no experiment-shaped state; the debug ledger is bug-shaped.
const ENABLED = process.env.PI_EXPERIMENT_LEDGER !== "0";
const INJECT = process.env.PI_EXPERIMENT_LEDGER_INJECT !== "0";

export default function experimentLedger(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  const injection = createContextInjector({ customType: "experiment-ledger", maxChars: process.env.PI_EXPERIMENT_LEDGER_INJECT_MAX_CHARS });

  pi.on("session_start", () => injection.reset());
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    if (!INJECT) return;
    let summary = "";
    try { summary = openExperimentsSummary(ctx.cwd); } catch { return; }
    return injection.inject(summary);
  });

  pi.registerCommand("exp-open", { description: "Open an experiment: /exp-open <title> :: <hypothesis> :: <bar1; bar2> :: <arm1; arm2>", handler: async (args: string, ctx: any) => {
    const [title, hypothesis, bars, arms] = String(args || "").split("::").map((part) => part.trim());
    const experiment = openExperiment(ctx.cwd, title, { hypothesis, bars, arms });
    notify(ctx, `${experiment.duplicate ? "existing" : "opened"} ${experiment.experimentId}\n${formatExperiment(experiment)}`, "info");
  }});
  pi.registerCommand("exp-gate", { description: "Record a gate verdict: /exp-gate <exp-id> <gate> <pass|fail|null-result|partial> [metrics/note]", handler: async (args: string, ctx: any) => {
    const [experimentId, gate, verdict, ...rest] = String(args || "").trim().split(/\s+/);
    try { notify(ctx, formatExperiment(recordGate(ctx.cwd, experimentId, { gate, verdict, note: rest.join(" ") || undefined })), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("exp-list", { description: "List experiments: /exp-list [open|closed]", handler: async (args: string, ctx: any) => {
    const status = ["open", "closed"].includes(String(args || "").trim()) ? String(args).trim() : undefined;
    const experiments = listExperiments(ctx.cwd, { status });
    notify(ctx, experiments.length ? experiments.map((e: any) => `${e.experimentId} [${e.status}${e.decision ? `: ${e.decision}` : ""}] ${e.gates.length} gates - ${e.title}`).join("\n") : "No experiments", "info");
  }});
  pi.registerCommand("exp-show", { description: "Show an experiment: /exp-show <exp-id>", handler: async (args: string, ctx: any) => {
    try { notify(ctx, formatExperiment(showExperiment(ctx.cwd, String(args || "").trim())), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("exp-close", { description: "Close an experiment: /exp-close <exp-id> <ship|no-go|shelved> [note]", handler: async (args: string, ctx: any) => {
    const [experimentId, decision, ...rest] = String(args || "").trim().split(/\s+/);
    try { notify(ctx, formatExperiment(closeExperiment(ctx.cwd, experimentId, { decision, note: rest.join(" ") || undefined })), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});

  pi.registerTool({
    name: "experiment_ledger",
    label: "Experiment ledger",
    description: "Durable per-experiment thread: hypothesis, PRE-REGISTERED bars (write them before running anything), arms, gate verdicts (e.g. E0 bit-parity, E1 units, E3 cheap-gate, E4 ship gate) with metrics and GPU-hours, and a ship/no-go/shelved closure. Open a thread when an experiment arc starts, record every gate verdict (especially FAIL/NULL - they prevent re-running settled questions), link runs (run_deck ids) and commits, close with the decision. Check open experiments before launching a run so arms and bars match what was pre-registered.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("open"), Type.Literal("gate"), Type.Literal("close"), Type.Literal("list"), Type.Literal("show")]),
      title: Type.Optional(Type.String({ description: "Experiment title (open)" })),
      experimentId: Type.Optional(Type.String()),
      hypothesis: Type.Optional(Type.String()),
      bars: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Pre-registered pass bars, e.g. 'val@2500 <= 2.72; 0 grad-skips' (open)" })),
      arms: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Arm configs/flags (open)" })),
      gate: Type.Optional(Type.String({ description: "Gate label, e.g. E0/E1/E3/pilot (gate)" })),
      verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("null-result"), Type.Literal("partial")])),
      metrics: Type.Optional(Type.String({ description: "Measured numbers vs the bar (gate)" })),
      note: Type.Optional(Type.String()),
      gpuHours: Type.Optional(Type.Number()),
      runId: Type.Optional(Type.String({ description: "run_deck run id to link (gate)" })),
      commit: Type.Optional(Type.String({ description: "Commit hash to link (gate)" })),
      decision: Type.Optional(Type.Union([Type.Literal("ship"), Type.Literal("no-go"), Type.Literal("shelved")])),
      status: Type.Optional(Type.String({ description: "Filter for list: open|closed" })),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = params.operation;
      let details: any;
      if (op === "open") details = openExperiment(ctx.cwd, params.title, params);
      else if (op === "gate") details = recordGate(ctx.cwd, params.experimentId, params);
      else if (op === "close") details = closeExperiment(ctx.cwd, params.experimentId, params);
      else if (op === "show") details = showExperiment(ctx.cwd, params.experimentId);
      else details = listExperiments(ctx.cwd, { status: params.status });
      const text = Array.isArray(details)
        ? details.map((e: any) => `${e.experimentId} [${e.status}${e.decision ? `: ${e.decision}` : ""}] ${e.gates.length} gates - ${e.title}`).join("\n") || "No experiments"
        : formatExperiment(details);
      return { content: [{ type: "text", text }], details };
    },
  });
}
