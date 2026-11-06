import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  createMonitor,
  checkMonitor,
  stopMonitor,
  requireMonitor,
  readMonitor,
  listMonitors,
  formatMonitor,
  formatMonitors,
  classifyMonitorIntent,
} = require(join(LIB_ROOT, "src", "run-monitor.js"));
const { notify, createExtensionTelemetry, contextSessionKind } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { recordManagedProcessEvent } = require(join(LIB_ROOT, "src", "managed-process-metrics.js"));

const ENABLED = process.env.PI_RUN_MONITOR !== "0";
const CONFIGURED_INTERVAL_MS = Number(process.env.PI_RUN_MONITOR_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
const CONFIGURED_TIMEOUT_MS = Number(process.env.PI_RUN_MONITOR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
const MAX_ACTIVE = Math.max(1, Number(process.env.PI_RUN_MONITOR_MAX_ACTIVE) || 8);
const INTENT_TELEMETRY = process.env.PI_RUN_MONITOR_INTENT_TELEMETRY !== "0";
const STATUS_KEY = "run-monitor";
const EXTENSION_VERSION = "run-monitor-2026-10-01.1";

function sessionId(ctx: any): string {
  return String(ctx.sessionManager.getSessionId());
}

// Who observed a monitor transition. Background timers and session restore
// announce the edge; commands notify their own result, and tool results already
// carry the outcome to the model. No observer sends a user message.
type Observer = "background" | "command" | "tool";

function kindAlias(value: string): "bg_run" | "run_deck" {
  const normalized = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (["job", "bg", "bg_run"].includes(normalized)) return "bg_run";
  if (["run", "deck", "run_deck"].includes(normalized)) return "run_deck";
  throw new Error(`unknown monitor target kind: ${value}. Use bg_run or run_deck.`);
}

export default function runMonitor(pi: ExtensionAPI) {
  pi = require("../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "run-monitor", version: EXTENSION_VERSION }) as ExtensionAPI;
  if (!ENABLED) return;

  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const inFlight = new Map<string, Promise<any>>();
  let shuttingDown = false;
  let sessionGeneration = 0;
  const pendingIntents = new Map<string, { acted: boolean }>();

  const recorder = (ctx: any) => createExtensionTelemetry({ cwd: ctx.cwd, extension: "run-monitor", version: EXTENSION_VERSION });
  const sessionMetadata = (ctx: any) => {
    const telemetry = recorder(ctx);
    return { telemetry, sessionKind: contextSessionKind(ctx), sessionToken: telemetry.sessionToken(sessionId(ctx)) };
  };
  const featureSignal = (ctx: any, action: string, monitor: any, outcome = "succeeded") => {
    if (!INTENT_TELEMETRY) return;
    const session = sessionMetadata(ctx);
    const durationMs = monitor?.finishedAt && monitor?.createdAt ? Math.max(0, Date.parse(monitor.finishedAt) - Date.parse(monitor.createdAt)) : 0;
    session.telemetry.featureSignal("run-monitor", action, { reason: monitor?.kind || "unknown", outcome, sessionKind: session.sessionKind, sessionToken: session.sessionToken, durationMs, sampleCount: Number(monitor?.checks || 0) });
  };
  const recordOpportunity = (ctx: any, acted: boolean) => {
    if (!INTENT_TELEMETRY) return;
    const session = sessionMetadata(ctx);
    session.telemetry.opportunity("managed-long-run-monitor-intent", "eligible", acted, "unknown", acted ? "displaced" : "unknown", session.sessionKind, session.sessionToken);
  };
  const markIntentActed = (ctx: any, directCommand = false) => {
    const key = sessionId(ctx);
    const pending = pendingIntents.get(key);
    if (directCommand) {
      pendingIntents.delete(key);
      recordOpportunity(ctx, true);
    } else if (pending) {
      pending.acted = true;
    }
  };
  const flushIntent = (ctx: any) => {
    const key = sessionId(ctx);
    const pending = pendingIntents.get(key);
    if (!pending) return;
    pendingIntents.delete(key);
    recordOpportunity(ctx, pending.acted);
  };

  const clearTimer = (monitorId: string) => {
    const timer = timers.get(monitorId);
    if (timer) clearInterval(timer);
    timers.delete(monitorId);
  };

  const refreshStatus = (ctx: any) => {
    const count = timers.size;
    ctx.ui.setStatus(STATUS_KEY, count ? `monitoring ${count} run${count === 1 ? "" : "s"}` : undefined);
  };

  const checkScript = join(LIB_ROOT, "scripts", "run-monitor-check.js");
  const runScriptCheck = (ctx: any, monitor: any) => new Promise((resolve, reject) => {
    const ownerSessionId = sessionId(ctx);
    execFile(process.execPath, [
      checkScript,
      "--cwd", ctx.cwd,
      "--monitor", monitor.monitorId,
      "--session", ownerSessionId,
      "--json",
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 }, (error: any, stdout: string) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve(readMonitor(ctx.cwd, monitor.monitorId) || { ...monitor, scriptCheck: result.scriptCheck });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });

  const pollOnce = async (ctx: any, monitorId: string, observer: Observer) => {
    if (shuttingDown) return null;
    const generation = sessionGeneration;
    const announce = observer === "background";
    const ownerSessionId = sessionId(ctx);
    let before: any;
    let after: any;
    try {
      before = requireMonitor(ctx.cwd, monitorId, { ownerSessionId });
      after = checkMonitor(ctx.cwd, monitorId, { ownerSessionId });
    } catch (error: any) {
      clearTimer(monitorId);
      refreshStatus(ctx);
      if (before) featureSignal(ctx, "error", before, "infrastructure-failed");
      if (announce) notify(ctx, `run monitor ${monitorId} failed: ${error.message || String(error)}`, "warning");
      return null;
    }

    if (after.status !== "active") {
      clearTimer(monitorId);
      refreshStatus(ctx);
      if (before.status === "active" && after.status !== "stopped") {
        const action = after.status === "timed_out" ? "timed-out" : after.status;
        featureSignal(ctx, action, after, after.status === "error" ? "infrastructure-failed" : after.status === "timed_out" ? "timed-out" : "succeeded");
        if (after.status === "settled") {
          try { recordManagedProcessEvent(ctx.cwd, after.kind, after.targetId, "settlement-notified", { eventKey: after.monitorId }); } catch {}
          featureSignal(ctx, "settlement-notified", after);
        }
        try {
          after = await runScriptCheck(ctx, after);
        } catch (error: any) {
          notify(ctx, `run monitor ${after.monitorId} script check failed: ${error.message || String(error)}`, "warning");
        }
      }
      if (announce && before.status === "active" && after.status !== "stopped" && !shuttingDown && generation === sessionGeneration) {
        const level = after.status === "matched" || after.status === "settled" ? "info" : "warning";
        notify(ctx, formatMonitor(after), level);
      }
    }
    return after;
  };

  const poll = (ctx: any, monitorId: string, observer: Observer) => {
    const existing = inFlight.get(monitorId);
    if (existing) return existing;
    const promise = pollOnce(ctx, monitorId, observer);
    inFlight.set(monitorId, promise);
    const settle = () => { if (inFlight.get(monitorId) === promise) inFlight.delete(monitorId); };
    promise.then(settle, settle);
    return promise;
  };

  const schedule = (ctx: any, monitor: any) => {
    clearTimer(monitor.monitorId);
    if (monitor.status !== "active") {
      refreshStatus(ctx);
      return;
    }
    const timer = setInterval(() => {
      void poll(ctx, monitor.monitorId, "background").catch((error: any) => {
        if (!shuttingDown) notify(ctx, `run monitor ${monitor.monitorId} check failed: ${error.message || String(error)}`, "warning");
      });
    }, monitor.intervalMs);
    timer.unref?.();
    timers.set(monitor.monitorId, timer);
    refreshStatus(ctx);
  };

  const start = async (ctx: any, params: any, observer: Exclude<Observer, "background">) => {
    shuttingDown = false;
    const ownerSessionId = sessionId(ctx);
    const active = listMonitors(ctx.cwd, { ownerSessionId, status: "active" });
    if (active.length >= MAX_ACTIVE) throw new Error(`run monitor limit reached (${MAX_ACTIVE}); stop an existing monitor first`);
    let monitor = createMonitor(ctx.cwd, {
      kind: params.kind,
      targetId: params.targetId,
      pattern: params.pattern,
      intervalMs: params.intervalMs ?? CONFIGURED_INTERVAL_MS,
      timeoutMs: params.timeoutMs ?? CONFIGURED_TIMEOUT_MS,
      ownerSessionId,
    });
    markIntentActed(ctx, observer === "command");
    featureSignal(ctx, "started", monitor);
    schedule(ctx, monitor);
    if (monitor.status !== "active") {
      const action = monitor.status === "timed_out" ? "timed-out" : monitor.status;
      featureSignal(ctx, action, monitor, monitor.status === "error" ? "infrastructure-failed" : monitor.status === "timed_out" ? "timed-out" : "succeeded");
    }
    if (monitor.status === "settled") {
      try { recordManagedProcessEvent(ctx.cwd, monitor.kind, monitor.targetId, "settlement-notified", { eventKey: monitor.monitorId }); } catch {}
      featureSignal(ctx, "settlement-notified", monitor);
    }
    if (monitor.status !== "active") {
      try {
        monitor = await runScriptCheck(ctx, monitor);
      } catch (error: any) {
        notify(ctx, `run monitor ${monitor.monitorId} script check failed: ${error.message || String(error)}`, "warning");
      }
    }
    return monitor;
  };

  pi.on("input" as any, (event: any, ctx: any) => {
    if (!INTENT_TELEMETRY || event.source === "extension") return { action: "continue" };
    if (classifyMonitorIntent(event.text).eligible) pendingIntents.set(sessionId(ctx), { acted: false });
    return { action: "continue" };
  });

  pi.on("agent_settled" as any, async (_event: any, ctx: any) => { flushIntent(ctx); });

  pi.on("session_start", async (_event: any, ctx: any) => {
    shuttingDown = false;
    sessionGeneration += 1;
    pendingIntents.delete(sessionId(ctx));
    const ownerSessionId = sessionId(ctx);
    for (const monitor of listMonitors(ctx.cwd, { ownerSessionId, status: "active" })) {
      const checked = await poll(ctx, monitor.monitorId, "background").catch((error: any) => {
        notify(ctx, `run monitor ${monitor.monitorId} check failed: ${error.message || String(error)}`, "warning");
        return null;
      });
      if (checked?.status === "active") schedule(ctx, checked);
    }
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    shuttingDown = true;
    sessionGeneration += 1;
    flushIntent(ctx);
    for (const monitorId of timers.keys()) clearTimer(monitorId);
    if (event.reason !== "reload") {
      const ownerSessionId = sessionId(ctx);
      for (const monitor of listMonitors(ctx.cwd, { ownerSessionId, status: "active" })) {
        const stopped = stopMonitor(ctx.cwd, monitor.monitorId, { ownerSessionId, reason: `owning Pi session ${event.reason}` });
        featureSignal(ctx, "stopped", stopped);
      }
    }
    refreshStatus(ctx);
  });

  pi.registerCommand("monitor-start", {
    description: "Periodically monitor a bg_run/run_deck target and run a script check when it settles or matches",
    handler: async (args: string, ctx: any) => {
      const [head, pattern] = String(args || "").split("::").map((part) => part.trim());
      const [kindText, targetId, intervalSeconds, timeoutSeconds] = head.split(/\s+/);
      if (!kindText || !targetId) {
        return notify(ctx, "Usage: /monitor-start <bg_run|run_deck> <target-id> [interval-seconds] [timeout-seconds] [:: pattern]", "warning");
      }
      try {
        const monitor = await start(ctx, {
          kind: kindAlias(kindText),
          targetId,
          pattern: pattern || undefined,
          intervalMs: intervalSeconds ? Number(intervalSeconds) * 1_000 : undefined,
          timeoutMs: timeoutSeconds ? Number(timeoutSeconds) * 1_000 : undefined,
        }, "command");
        notify(ctx, formatMonitor(monitor), "info");
      } catch (error: any) {
        notify(ctx, error.message || String(error), "warning");
      }
    },
  });

  pi.registerCommand("monitor-status", {
    description: "Show one run monitor or all monitors owned by this Pi session",
    handler: async (args: string, ctx: any) => {
      const monitorId = String(args || "").trim();
      try {
        const ownerSessionId = sessionId(ctx);
        const text = monitorId
          ? formatMonitor(requireMonitor(ctx.cwd, monitorId, { ownerSessionId }))
          : formatMonitors(listMonitors(ctx.cwd, { ownerSessionId }));
        notify(ctx, text, "info");
      } catch (error: any) {
        notify(ctx, error.message || String(error), "warning");
      }
    },
  });

  pi.registerCommand("monitor-check", {
    description: "Check a run monitor immediately; terminal edges show the script probe",
    handler: async (args: string, ctx: any) => {
      const monitorId = String(args || "").trim();
      if (!monitorId) return notify(ctx, "Usage: /monitor-check <monitor-id>", "warning");
      const checked = await poll(ctx, monitorId, "command").catch((error: any) => {
        notify(ctx, error.message || String(error), "warning");
        return null;
      });
      if (checked) notify(ctx, formatMonitor(checked), "info");
    },
  });

  pi.registerCommand("monitor-stop", {
    description: "Stop a run monitor without stopping its target process",
    handler: async (args: string, ctx: any) => {
      const monitorId = String(args || "").trim();
      if (!monitorId) return notify(ctx, "Usage: /monitor-stop <monitor-id>", "warning");
      try {
        const monitor = stopMonitor(ctx.cwd, monitorId, { ownerSessionId: sessionId(ctx) });
        featureSignal(ctx, "stopped", monitor);
        clearTimer(monitor.monitorId);
        refreshStatus(ctx);
        notify(ctx, formatMonitor(monitor), "info");
      } catch (error: any) {
        notify(ctx, error.message || String(error), "warning");
      }
    },
  });

  pi.registerCommand("monitors", {
    description: "List run monitors owned by this Pi session",
    handler: async (_args: string, ctx: any) => notify(ctx, formatMonitors(listMonitors(ctx.cwd, { ownerSessionId: sessionId(ctx) })), "info"),
  });

  pi.registerTool({
    name: "run_monitor",
    label: "Run monitor",
    description: "Periodically check a registered bg_run or run_deck target while the owning Pi session is alive. start creates an edge-triggered monitor that stops and notifies when optional literal milestone text appears, the target settles, the observation deadline expires, or checking errors. Terminal edges run scripts/run-monitor-check.js and show its target probe in the notification; no monitor check sends a user message or starts a model turn. status/list inspect monitors; check samples immediately; stop stops only the monitor, never the target process.",
    promptSnippet: "Monitor bg_run/run_deck work and report settlement or milestones without starting model turns",
    promptGuidelines: [
      "Use run_monitor after bg_run or run_deck when the user asks for periodic monitoring or notification of a long-running process. Its checks are script-backed and never wake the model, so end the turn instead of polling.",
      "Do not use automation_loop merely to babysit one long-running process; run_monitor observes process state without repeating model work.",
    ],
    parameters: Type.Object({
      operation: StringEnum(["start", "status", "check", "stop", "list"] as const),
      kind: Type.Optional(StringEnum(["bg_run", "run_deck"] as const)),
      targetId: Type.Optional(Type.String({ description: "job-* id for bg_run or run-* id for run_deck" })),
      monitorId: Type.Optional(Type.String()),
      intervalMs: Type.Optional(Type.Number({ description: "Polling interval; clamped to 1 second through 1 hour" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Observation deadline; clamped to 1 second through 7 days" })),
      pattern: Type.Optional(Type.String({ description: "Optional bounded literal text matched against the target log tail" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const ownerSessionId = sessionId(ctx);
      let details: any;
      if (params.operation === "start") {
        if (!params.kind || !params.targetId) throw new Error("run_monitor start requires kind and targetId");
        details = await start(ctx, params, "tool");
      } else if (params.operation === "check") {
        if (!params.monitorId) throw new Error("run_monitor check requires monitorId");
        details = await poll(ctx, params.monitorId, "tool");
        if (!details) throw new Error(`run monitor check failed: ${params.monitorId}`);
      } else if (params.operation === "stop") {
        if (!params.monitorId) throw new Error("run_monitor stop requires monitorId");
        details = stopMonitor(ctx.cwd, params.monitorId, { ownerSessionId });
        featureSignal(ctx, "stopped", details);
        clearTimer(details.monitorId);
        refreshStatus(ctx);
      } else if (params.operation === "status" && params.monitorId) {
        details = requireMonitor(ctx.cwd, params.monitorId, { ownerSessionId });
      } else {
        details = listMonitors(ctx.cwd, { ownerSessionId });
      }
      const text = Array.isArray(details) ? formatMonitors(details) : formatMonitor(details);
      return { content: [{ type: "text", text }], details };
    },
  });
}
