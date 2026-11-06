import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { startJob, jobStatus, jobLogs, stopJob, listJobs, formatJobs } = require(join(LIB_ROOT, "src", "bg-jobs.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: 35 builds/month were killed by the 2-minute default
// timeout and re-run by hand. Long commands belong in detached background
// jobs with a job table, streamed logs, and explicit stop.
const ENABLED = process.env.PI_BG_RUN !== "0";

export default function bgRun(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("bg", { description: "Run a long command as a detached background job: /bg <command>", handler: async (args: string, ctx: any) => {
    const command = String(args || "").trim();
    if (!command) return notify(ctx, "Usage: /bg <command>", "warning");
    const job = startJob(ctx.cwd, command);
    notify(ctx, `started ${job.jobId} (pid ${job.pid}): ${job.name}\nlogs: /bg-logs ${job.jobId}`, "info");
  }});
  pi.registerCommand("bg-status", { description: "Show background jobs: /bg-status [job-id]", handler: async (args: string, ctx: any) => {
    const id = String(args || "").trim();
    try { notify(ctx, id ? JSON.stringify(jobStatus(ctx.cwd, id, { recordInteraction: true }), null, 2) : formatJobs(listJobs(ctx.cwd)), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("bg-logs", { description: "Show a background job's log tail: /bg-logs <job-id>", handler: async (args: string, ctx: any) => {
    try { notify(ctx, jobLogs(ctx.cwd, String(args || "").trim(), { recordInteraction: true }).text || "(no output yet)", "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("bg-stop", { description: "Stop a background job: /bg-stop <job-id>", handler: async (args: string, ctx: any) => {
    try { notify(ctx, JSON.stringify(stopJob(ctx.cwd, String(args || "").trim()), null, 2), "warning"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerTool({
    name: "bg_run",
    label: "Background jobs",
    description: "Run long commands (builds, full test suites, servers) as detached background jobs instead of blocking or hitting tool timeouts. Operations: start {command,name?}, status {jobId?}, logs {jobId}, stop {jobId}. Manual status/log access remains available; when the user explicitly asks for periodic notification, attach run_monitor instead of repeating status/log polling.",
    promptGuidelines: ["Use status/logs for an explicit point-in-time inspection.", "When the user asks for periodic checks or notification on settlement, start run_monitor for this job; it observes without autonomous model turns."],
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("logs"), Type.Literal("stop")]),
      command: Type.Optional(Type.String({ description: "Shell command to run (start)" })),
      name: Type.Optional(Type.String()),
      jobId: Type.Optional(Type.String()),
      maxChars: Type.Optional(Type.Number({ description: "Log tail size (logs)" })),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = params.operation;
      let details: any;
      if (op === "start") {
        if (!params.command) throw new Error("bg_run start requires command");
        details = startJob(ctx.cwd, params.command, { name: params.name });
      } else if (op === "logs") details = jobLogs(ctx.cwd, params.jobId, { maxChars: params.maxChars, recordInteraction: true });
      else if (op === "stop") details = stopJob(ctx.cwd, params.jobId);
      else details = params.jobId ? jobStatus(ctx.cwd, params.jobId, { recordInteraction: true }) : listJobs(ctx.cwd);
      const text = op === "logs" ? details.text || "(no output yet)" : Array.isArray(details) ? formatJobs(details) : JSON.stringify(details, null, 2);
      return { content: [{ type: "text", text }], details };
    },
  });
}
