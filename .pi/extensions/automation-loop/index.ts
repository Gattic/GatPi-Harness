import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const {
  AutomationLoopStore,
  parseLoopArgs,
  explicitAutomationIntent,
  buildLoopPrompt,
  parseLoopDelivery,
  validateLoopDelivery,
  createContinuationToken,
  waitForQueuedAgentStart,
  latestAssistant,
  assistantSettlementDisposition,
  iterationActivity,
  evaluateSettlement,
  summarizeLoop,
  completionGuidance,
} = require(join(LIB_ROOT, "src", "automation-loop.js"));
const { notify, setTurnExitCode } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { ExecutionOutcomeAdapter } = require(join(LIB_ROOT, "src", "integration-boundary.js"));
const {
  snapshotManagedWork,
  managedWorkDependencies,
  waitForManagedWork,
  formatManagedWork,
} = require(join(LIB_ROOT, "src", "managed-background.js"));

const ENABLED = process.env.PI_AUTOMATION_LOOP !== "0";
const ALLOW_UNBOUNDED = process.env.PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED === "1";
const DEFAULT_MAX = Number(process.env.PI_AUTOMATION_LOOP_MAX_ITERATIONS || 20);
const DEFAULT_MAX_STALLS = Number(process.env.PI_AUTOMATION_LOOP_MAX_STALLS || 3);
const MAX_PROMPT_CHARS = Number(process.env.PI_AUTOMATION_LOOP_MAX_PROMPT_CHARS || 100_000);
const BACKGROUND_POLL_MS = Math.max(100, Number(process.env.PI_AUTOMATION_LOOP_BACKGROUND_POLL_MS || 2000));
const STATUS_KEY = "automation-loop";
const EXECUTION_OUTCOME_CAPTURE = process.env.PI_EXECUTION_OUTCOME_CAPTURE !== "0";
const LOOP_OUTCOME_PRODUCER_VERSION = "automation-loop-extension-2026-07-31.1";
const outcomeAdapters = new Map<string, any>();

type AnyCtx = any;

function sessionId(ctx: AnyCtx): string {
  return String(ctx.sessionManager?.getSessionId?.() || ctx.sessionManager?.getSessionFile?.() || "ephemeral");
}
function storeFor(ctx: AnyCtx) {
  return new AutomationLoopStore({ cwd: ctx.cwd, allowUnbounded: ALLOW_UNBOUNDED, maxPromptChars: MAX_PROMPT_CHARS });
}
function outcomeAdapterFor(cwd: string) {
  if (!outcomeAdapters.has(cwd)) outcomeAdapters.set(cwd, new ExecutionOutcomeAdapter({ cwd, enabled: EXECUTION_OUTCOME_CAPTURE }));
  return outcomeAdapters.get(cwd);
}
function persistLoopOutcome(cwd: string, state: any, assistantEntryId: string | null, ctx: AnyCtx) {
  if (!EXECUTION_OUTCOME_CAPTURE) return null;
  try {
    const adapter = outcomeAdapterFor(cwd);
    const packet = adapter.buildLoopSettlement(state, { assistantEntryId, projectKey: cwd, producerVersion: LOOP_OUTCOME_PRODUCER_VERSION });
    return packet ? adapter.save(packet) : null;
  } catch (error: any) {
    safeNotify(ctx, `Loop outcome capture failed closed: ${error?.message || String(error)}`, "warning");
    return null;
  }
}
function shortPrompt(prompt: string, max = 140): string {
  const text = String(prompt || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function showStatus(ctx: AnyCtx, state: any) {
  try {
    if (!ctx.hasUI || !ctx.ui?.setStatus) return;
    if (!state || !["active", "paused"].includes(state.status)) return ctx.ui.setStatus(STATUS_KEY, undefined);
    const max = state.maxIterations > 0 ? state.maxIterations : "∞";
    const waiting = state.backgroundWait?.dependencies?.length || 0;
    ctx.ui.setStatus(STATUS_KEY, state.status === "paused" ? `loop paused ${state.iteration}/${max}` : waiting ? `loop waiting ${waiting} · ${state.iteration}/${max}` : `loop ${state.iteration}/${max}`);
  } catch {}
}
function safeNotify(ctx: AnyCtx, message: string, level: "info" | "warning" | "error" = "info") {
  try { notify(ctx, message, level); } catch { console.log(message); }
}
function rejectionCode(error: any): string {
  const message = String(error?.message || error || "").toLowerCase();
  if (/autonomous goal/.test(message)) return "goal-active";
  if (/already active|already paused|already running/.test(message)) return "loop-active";
  if (/unbounded/.test(message)) return "unbounded-disabled";
  if (/prompt/.test(message)) return "invalid-prompt";
  return "start-rejected";
}
function blockedToolResult(store: any, operation: string, reasonCode: string, message: string, state?: any, extra: any = {}): AgentToolResult<Record<string, unknown>> {
  const loop = state ? summarizeLoop(state) : null;
  const details = { operation, outcome: "blocked", status: "blocked", ok: false, blocked: true, reasonCode, loop, ...extra };
  store.recordTelemetry({ kind: "rejection", operation, outcome: "blocked", eligible: extra.eligible, source: "tool", reasonCode, loopId: state?.id, iteration: state?.iteration, status: state?.status });
  return { content: [{ type: "text", text: message }], details };
}
function notApplicableToolResult(store: any, operation: string, reasonCode: string, message: string): AgentToolResult<Record<string, unknown>> {
  const details = { operation, outcome: "not-applicable", status: "not-applicable", ok: null, notApplicable: true, reasonCode };
  store.recordTelemetry({ kind: "not-applicable", operation, outcome: "not-applicable", source: "tool", reasonCode });
  return { content: [{ type: "text", text: message }], details };
}
function formatState(state: any, includePrompt = false): string {
  if (!state) return "No automation loop found in this session.";
  const summary = summarizeLoop(state, { includePrompt });
  const lines = [
    `Automation loop ${summary.id}`,
    `status: ${summary.status}`,
    `iteration: ${summary.iteration}/${summary.maxIterations > 0 ? summary.maxIterations : "∞"}`,
    `stalls: ${summary.stallCount}/${summary.maxStalls || "disabled"}`,
    `completion promise: ${summary.completionPromise || "none (evidence-backed automation_loop completion)"}`,
    `completion action: ${summary.completionAction?.mode || "unknown"}`,
    `prompt: ${includePrompt ? summary.prompt : shortPrompt(state.prompt)}`,
  ];
  if (summary.pauseReason) lines.push(`reason: ${summary.pauseReason}`);
  if (summary.backgroundWait?.dependencies?.length) lines.push(`waiting for: ${formatManagedWork(summary.backgroundWait.dependencies)}`);
  if (summary.pendingContinuation) lines.push(`pending continuation: iteration ${summary.pendingContinuation.iteration} queued ${summary.pendingContinuation.queuedAt}`);
  if (summary.checkpoints.length) lines.push("checkpoints:", ...summary.checkpoints.slice(-5).map((row: any) => `- #${row.iteration} ${row.verdict}: ${row.summary}`));
  return lines.join("\n");
}
function readPromptFile(cwd: string, requested: string): string {
  const root = realpathSync(cwd);
  const unresolved = resolve(cwd, String(requested || "").replace(/^@/, ""));
  if (unresolved !== root && !unresolved.startsWith(`${root}${sep}`)) throw new Error("prompt file must be inside the current repository");
  if (!existsSync(unresolved)) throw new Error(`prompt file not found: ${requested}`);
  const target = realpathSync(unresolved);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("prompt file symlink resolves outside the current repository");
  const size = statSync(target).size;
  if (size > MAX_PROMPT_CHARS) throw new Error(`prompt file exceeds ${MAX_PROMPT_CHARS} bytes`);
  return readFileSync(target, "utf8").trim();
}
async function workspaceFingerprint(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  try {
    const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    if (root.code !== 0) return null;
    const [head, status, diff] = await Promise.all([
      pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 }),
      pi.exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], { cwd, timeout: 5000 }),
      pi.exec("git", ["diff", "--stat", "--", ".", ":(exclude).pi/automation-loop/**"], { cwd, timeout: 5000 }),
    ]);
    const statusWithoutOwnState = String(status.stdout || "").split("\n").filter((line) => !line.includes(".pi/automation-loop/")).join("\n");
    return createHash("sha256").update([head.stdout, statusWithoutOwnState, diff.stdout].join("\n")).digest("hex").slice(0, 20);
  } catch { return null; }
}
function startOptions() {
  return { defaultMaxIterations: DEFAULT_MAX, defaultMaxStalls: DEFAULT_MAX_STALLS, allowUnbounded: ALLOW_UNBOUNDED };
}
function activeGoal(cwd: string): any | null {
  const root = join(cwd, ".pi", "goal-state");
  let names: string[] = [];
  try { names = readdirSync(root).filter((name) => name.endsWith(".json") && !name.endsWith(".archive.json")); } catch { return null; }
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, name), "utf8"));
      const goal = Array.isArray(parsed?.goals) ? [...parsed.goals].reverse().find((item: any) => item?.status === "running") : null;
      if (goal) return goal;
    } catch {}
  }
  return null;
}
async function createState(pi: ExtensionAPI, ctx: AnyCtx, input: any) {
  const store = storeFor(ctx);
  const sid = sessionId(ctx);
  const goal = activeGoal(ctx.cwd);
  if (goal) throw new Error(`autonomous goal ${goal.id || "unknown"} is already running; stop it before starting an automation loop`);
  const current = store.current(sid);
  if (current) throw new Error(`loop ${current.id} is already ${current.status}; stop it before starting another`);
  const branch = ctx.sessionManager?.getBranch?.() || [];
  return store.create({
    sessionId: sid,
    prompt: input.prompt,
    maxIterations: input.maxIterations,
    maxStalls: input.maxStalls,
    completionPromise: input.completionPromise,
    iterationStartEntryCount: branch.length,
    iterationStartFingerprint: await workspaceFingerprint(pi, ctx.cwd),
    iterationStartManagedWork: snapshotManagedWork(ctx.cwd),
    startSource: input.startSource || "unknown",
  });
}
async function queueIteration(pi: ExtensionAPI, ctx: AnyCtx, store: any, state: any) {
  const current = store.get(state.id);
  if (!current || current.status !== "active" || current.iteration !== state.iteration) return current;
  if (current.pendingContinuation) return current;
  const token = createContinuationToken();
  let queued = current;
  try {
    queued = store.queueContinuation(current.id, { iteration: current.iteration, token });
    const startEntryCount = (ctx.sessionManager?.getBranch?.() || []).length;
    pi.sendUserMessage(buildLoopPrompt(queued, { delivery: { token } }), { deliverAs: "followUp" });
    await waitForQueuedAgentStart(ctx, startEntryCount);
    return store.get(current.id);
  } catch (error: any) {
    try {
      const latest = store.get(current.id);
      if (latest?.pendingContinuation) store.dropPendingContinuation(current.id, "queue-failed");
      store.pause(current.id, `failed to queue iteration: ${error?.message || String(error)}`);
    } catch {}
    return store.get(current.id);
  }
}
async function waitThenQueueIteration(pi: ExtensionAPI, ctx: AnyCtx, store: any, state: any, waiters?: Set<string>) {
  const wait = state.backgroundWait;
  if (!wait?.dependencies?.length) return queueIteration(pi, ctx, store, state);
  if (waiters?.has(state.id)) return;
  waiters?.add(state.id);
  try {
    const result = await waitForManagedWork(store.cwd, wait.dependencies, {
      pollMs: BACKGROUND_POLL_MS,
      shouldContinue: () => {
        const current = store.get(state.id);
        return current?.status === "active" && current.backgroundWait?.startedAt === wait.startedAt;
      },
    });
    if (result.outcome !== "settled") return;
    const current = store.get(state.id);
    if (current?.status !== "active" || current.backgroundWait?.startedAt !== wait.startedAt) return;
    const ready = store.save({
      ...current,
      backgroundWait: null,
      iterationStartManagedWork: snapshotManagedWork(store.cwd),
      lastBackgroundWait: {
        startedAt: wait.startedAt,
        settledAt: new Date().toISOString(),
        waitedMs: result.waitedMs,
        dependencies: wait.dependencies,
      },
    });
    showStatus(ctx, ready);
    safeNotify(ctx, `Loop ${ready.id}: managed background work settled; queueing iteration ${ready.iteration}/${ready.maxIterations || "∞"}.`, "info");
    await queueIteration(pi, ctx, store, ready);
  } finally {
    waiters?.delete(state.id);
  }
}
async function waitForCommandTurn(ctx: AnyCtx, startEntryCount: number) {
  if (!new Set(["print", "json"]).has(ctx.mode) || typeof ctx.waitForIdle !== "function") return;
  const outcome = await waitForQueuedAgentStart(ctx, startEntryCount);
  if (outcome === "started") await ctx.waitForIdle();
}
async function sendFromCommand(pi: ExtensionAPI, ctx: AnyCtx, prompt: string) {
  const startEntryCount = (ctx.sessionManager?.getBranch?.() || []).length;
  const send = typeof ctx.sendUserMessage === "function" ? ctx.sendUserMessage.bind(ctx) : pi.sendUserMessage.bind(pi);
  await send(prompt, { deliverAs: "followUp" });
  await waitForCommandTurn(ctx, startEntryCount);
}
async function startFromCommand(pi: ExtensionAPI, args: string, ctx: AnyCtx) {
  const parsed = parseLoopArgs(args || "", startOptions());
  if (parsed.promptFile && parsed.prompt) throw new Error("use either prompt text or --prompt-file, not both");
  const prompt = parsed.promptFile ? readPromptFile(ctx.cwd, parsed.promptFile) : parsed.prompt;
  if (!prompt) throw new Error("Usage: /loop <prompt> [--max=20] [--promise=DONE] or /loop --prompt-file=TASK.md");
  const state = await createState(pi, ctx, { ...parsed, prompt, startSource: "command" });
  showStatus(ctx, state);
  notify(ctx, `Started automation loop ${state.id}: ${shortPrompt(state.prompt)}\niteration 1/${state.maxIterations || "∞"}`, "info");
  await sendFromCommand(pi, ctx, buildLoopPrompt(state));
  return state;
}

export default function automationLoop(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  const settling = new Set<string>();
  const backgroundWaiters = new Set<string>();
  const baselineRefreshPending = new Set<string>();
  const toolStartAuthorized = new Map<string, boolean>();
  let runtimeCwd: string | null = null;
  let runtimeSessionId: string | null = null;

  pi.on("session_start", async (_event: any, ctx: AnyCtx) => {
    runtimeCwd = ctx.cwd;
    runtimeSessionId = sessionId(ctx);
    toolStartAuthorized.set(runtimeSessionId, false);
    const store = storeFor(ctx);
    let state = store.current(runtimeSessionId);
    showStatus(ctx, state);
    if (state?.status === "active" && state.backgroundWait?.dependencies?.length) {
      void waitThenQueueIteration(pi, ctx, store, state, backgroundWaiters).catch((error: any) => {
        try { store.pause(state.id, `background wait recovery failed: ${error?.message || String(error)}`); } catch {}
        safeNotify(ctx, `Automation loop background wait recovery failed: ${error?.message || String(error)}`, "warning");
      });
    } else if (state?.status === "active" && state.pendingContinuation) {
      state = store.dropPendingContinuation(state.id, "session-recovery-requeue");
      safeNotify(ctx, `Loop ${state.id}: re-queueing interrupted continuation for iteration ${state.iteration}.`, "info");
      await queueIteration(pi, ctx, store, state);
    }
  });

  pi.on("input", (event: any, ctx: AnyCtx) => {
    const sid = sessionId(ctx);
    if (event.source !== "extension") {
      toolStartAuthorized.set(sid, explicitAutomationIntent(event.text));
      return { action: "continue" };
    }
    const delivery = parseLoopDelivery(event.text);
    if (!delivery) return { action: "continue" };
    const store = storeFor(ctx);
    const state = delivery.loopId
      ? store.get(delivery.loopId)
      : [...store.list()].reverse().find((item: any) => item.sessionId === sid && item.promptHash === delivery.promptHash);
    const validation = validateLoopDelivery(state, delivery);
    if (!state || state.sessionId !== sid || !validation.ok) {
      const dropReason = !state ? "unknown-loop" : state.sessionId !== sid ? "wrong-session" : validation.reason;
      if (state) {
        try { store.recordContinuationDrop(state.id, { iteration: delivery.iteration, token: delivery.token, reason: dropReason }); } catch {}
      }
      safeNotify(ctx, `Dropped stale automation-loop continuation (${dropReason}).`, "warning");
      return { action: "handled" };
    }
    const branch = ctx.sessionManager?.getBranch?.() || [];
    const delivered = store.markContinuationDelivered(state.id, {
      delivery,
      iterationStartEntryCount: branch.length,
      iterationStartFingerprint: state.iterationStartFingerprint,
      iterationStartManagedWork: state.iterationStartManagedWork,
    });
    baselineRefreshPending.add(delivered.id);
    showStatus(ctx, delivered);
    return { action: "continue" };
  });

  pi.on("agent_start", async (_event: any, ctx: AnyCtx) => {
    const cwd = ctx.cwd;
    const sid = sessionId(ctx);
    const store = new AutomationLoopStore({ cwd, allowUnbounded: ALLOW_UNBOUNDED, maxPromptChars: MAX_PROMPT_CHARS });
    const state = store.active(sid);
    if (!state || !baselineRefreshPending.delete(state.id)) return;
    const branch = ctx.sessionManager?.getBranch?.() || [];
    const progressFingerprint = await workspaceFingerprint(pi, cwd);
    const current = store.get(state.id);
    if (!current || current.status !== "active" || current.iteration !== state.iteration) return;
    store.save({
      ...current,
      iterationStartEntryCount: branch.length,
      iterationStartFingerprint: progressFingerprint,
      iterationStartManagedWork: snapshotManagedWork(cwd),
    });
  });

  pi.on("agent_settled", async (_event: any, ctx: AnyCtx) => {
    let cwd = runtimeCwd;
    let sid = runtimeSessionId;
    try { cwd = ctx.cwd; sid = sessionId(ctx); } catch {}
    if (!cwd || !sid) return;
    const store = new AutomationLoopStore({ cwd, allowUnbounded: ALLOW_UNBOUNDED, maxPromptChars: MAX_PROMPT_CHARS });
    const state = store.active(sid) || store.recent(sid);
    if (!state) return;
    let settlementKey: string | null = null;
    try {
      let branch: any[] = [];
      try { branch = ctx.sessionManager?.getBranch?.() || []; } catch {}
      const assistant = latestAssistant(branch);
      if (!assistant) return;
      if (state.status !== "active") {
        const finalized = state.outcomeSettlementEntryId ? state : store.save({ ...state, outcomeSettlementEntryId: assistant.id });
        persistLoopOutcome(cwd, finalized, assistant.id, ctx);
        return;
      }
      if (assistant.id === state.lastSettledEntryId) return;
      settlementKey = `${state.id}:${assistant.id}`;
      if (settling.has(settlementKey)) return;
      settling.add(settlementKey);
      const disposition = assistantSettlementDisposition(assistant);
      if (disposition.action === "ignore") return;
      if (disposition.action === "pause") {
        const paused = store.save({ ...store.pauseForAssistantFailure(state.id, disposition.stopReason), outcomeSettlementEntryId: assistant.id });
        persistLoopOutcome(cwd, paused, assistant.id, ctx);
        showStatus(ctx, paused);
        try { setTurnExitCode(ctx, 1); } catch { process.exitCode ||= 1; }
        safeNotify(ctx, `Loop ${paused.id} paused after provider ${disposition.stopReason}; no iteration was consumed. Use /loop-resume after provider recovery.`, "warning");
        return;
      }
      const activity = iterationActivity(branch, state.iterationStartEntryCount);
      const progressFingerprint = await workspaceFingerprint(pi, cwd);
      const result = evaluateSettlement(state, {
        assistantEntryId: assistant.id,
        assistantText: assistant.text,
        assistantStopReason: assistant.stopReason,
        settlementBoundary: "agent_settled",
        progressFingerprint,
        nextEntryCount: branch.length,
        ...activity,
      });
      if (result.action === "noop") return;
      const managedWork = result.action === "continue" ? snapshotManagedWork(cwd) : null;
      const dependencies = result.action === "continue"
        ? managedWorkDependencies(state.iterationStartManagedWork, managedWork)
        : [];
      const nextState = result.action === "continue"
        ? {
            ...result.state,
            iterationStartManagedWork: dependencies.length ? state.iterationStartManagedWork : managedWork,
            backgroundWait: dependencies.length ? {
              startedAt: new Date().toISOString(),
              afterIteration: state.iteration,
              dependencies,
            } : null,
          }
        : result.state;
      const saved = store.save(nextState);
      persistLoopOutcome(cwd, saved, assistant.id, ctx);
      showStatus(ctx, saved);
      if (result.action === "continue" && dependencies.length) {
        safeNotify(ctx, `Loop ${saved.id}: iteration ${state.iteration} settled; waiting for ${formatManagedWork(dependencies)} before iteration ${saved.iteration}.`, "info");
        await waitThenQueueIteration(pi, ctx, store, saved, backgroundWaiters);
      } else if (result.action === "continue") {
        safeNotify(ctx, `Loop ${saved.id}: iteration ${state.iteration} settled; queueing ${saved.iteration}/${saved.maxIterations || "∞"}.`, "info");
        await queueIteration(pi, ctx, store, saved);
      } else if (result.action === "completed") {
        safeNotify(ctx, `Loop ${saved.id} completed at iteration ${saved.iteration}: ${result.reason}`, "info");
      } else if (result.action === "max_iterations") {
        try { setTurnExitCode(ctx, 1); } catch { process.exitCode ||= 1; }
        safeNotify(ctx, `Loop ${saved.id} stopped incomplete: ${result.reason}`, "warning");
      } else if (result.action === "paused") {
        try { setTurnExitCode(ctx, 1); } catch { process.exitCode ||= 1; }
        safeNotify(ctx, `Loop ${saved.id} paused: ${result.reason}. Use /loop-resume after reviewing it.`, "warning");
      }
    } catch (error: any) {
      try { store.pause(state.id, `settlement failed: ${error?.message || String(error)}`); } catch {}
      try { setTurnExitCode(ctx, 1); } catch { process.exitCode ||= 1; }
      safeNotify(ctx, `Automation loop settlement failed: ${error?.message || String(error)}`, "warning");
    } finally { if (settlementKey) settling.delete(settlementKey); }
  });

  const startHandler = async (args: string, ctx: AnyCtx) => {
    try { await startFromCommand(pi, args, ctx); }
    catch (error: any) {
      try { storeFor(ctx).recordTelemetry({ kind: "rejection", operation: "start", outcome: "blocked", eligible: true, source: "command", reasonCode: rejectionCode(error) }); } catch {}
      setTurnExitCode(ctx, 1); notify(ctx, error?.message || String(error), "warning");
    }
  };
  const stopHandler = async (args: string, ctx: AnyCtx) => {
    const store = storeFor(ctx); const state = store.current(sessionId(ctx));
    if (!state) return notify(ctx, "No active or paused automation loop in this session.", "warning");
    const stopped = store.cancel(state.id, args.trim() || "cancelled by user");
    showStatus(ctx, stopped); notify(ctx, `Cancelled automation loop ${stopped.id} at iteration ${stopped.iteration}.`, "info");
  };

  pi.registerCommand("loop", { description: "Start a bounded Ralph-style same-prompt automation loop", handler: startHandler });
  pi.registerCommand("ralph-loop", { description: "Alias for /loop", handler: startHandler });
  pi.registerCommand("loop-status", { description: "Show current/recent automation loop status", handler: async (_args: string, ctx: AnyCtx) => { const store = storeFor(ctx); notify(ctx, formatState(store.current(sessionId(ctx)) || store.recent(sessionId(ctx))), "info"); } });
  pi.registerCommand("loop-list", { description: "List recent automation loops in this repository", handler: async (_args: string, ctx: AnyCtx) => { const rows = storeFor(ctx).list().slice(-20); notify(ctx, rows.length ? rows.map((state: any) => `${state.id}\t${state.status}\t${state.iteration}/${state.maxIterations || "∞"}\t${shortPrompt(state.prompt, 90)}`).join("\n") : "No automation loops found.", "info"); } });
  pi.registerCommand("loop-log", { description: "Show recent checkpoints and iteration metadata: /loop-log [count]", handler: async (args: string, ctx: AnyCtx) => {
    const store = storeFor(ctx); const state = store.current(sessionId(ctx)) || store.recent(sessionId(ctx));
    if (!state) return notify(ctx, "No automation loop found.", "warning");
    const count = Math.max(1, Math.min(100, Number(args.trim()) || 20));
    notify(ctx, JSON.stringify({ ...summarizeLoop(state), checkpoints: (state.checkpoints || []).slice(-count), recentHistory: (state.history || []).slice(-count) }, null, 2), "info");
  } });
  pi.registerCommand("loop-pause", { description: "Pause the active automation loop", handler: async (args: string, ctx: AnyCtx) => {
    const store = storeFor(ctx); const state = store.active(sessionId(ctx));
    if (!state) return notify(ctx, "No active automation loop in this session.", "warning");
    const paused = store.pause(state.id, args.trim() || "paused by user"); showStatus(ctx, paused); notify(ctx, `Paused loop ${paused.id}.`, "info");
  } });
  pi.registerCommand("loop-resume", { description: "Resume a paused or interrupted automation loop", handler: async (_args: string, ctx: AnyCtx) => {
    const store = storeFor(ctx); const state = store.current(sessionId(ctx));
    if (!state) return notify(ctx, "No paused or interrupted automation loop in this session.", "warning");
    if (state.backgroundWait?.dependencies?.length) return notify(ctx, `Loop ${state.id} is already waiting for ${formatManagedWork(state.backgroundWait.dependencies)}; it will continue automatically when they settle.`, "info");
    if (state.pendingContinuation) return notify(ctx, `Loop ${state.id} already has iteration ${state.pendingContinuation.iteration} queued; stale-delivery protection will continue it or drop it if state changes.`, "info");
    const branch = ctx.sessionManager?.getBranch?.() || [];
    const nextInput = { iterationStartEntryCount: branch.length, iterationStartFingerprint: await workspaceFingerprint(pi, ctx.cwd), iterationStartManagedWork: snapshotManagedWork(ctx.cwd) };
    const resumed = state.status === "paused" ? store.resume(state.id, nextInput) : store.save({ ...state, ...nextInput, resumedAt: new Date().toISOString() });
    showStatus(ctx, resumed); notify(ctx, `Resumed loop ${resumed.id} at iteration ${resumed.iteration}.`, "info"); await sendFromCommand(pi, ctx, buildLoopPrompt(resumed));
  } });
  pi.registerCommand("loop-stop", { description: "Cancel the active or paused automation loop", handler: stopHandler });
  pi.registerCommand("cancel-ralph", { description: "Alias for /loop-stop", handler: stopHandler });
  pi.registerCommand("loop-help", { description: "Show automation-loop usage", handler: async (_args: string, ctx: AnyCtx) => notify(ctx, [
    "Usage:",
    "  /loop <prompt> --max=20 --promise=DONE",
    "  /loop --prompt-file=TASK.md --max-stalls=3",
    "  /loop-status  /loop-log  /loop-pause  /loop-resume  /loop-stop",
    "Completion promise form: <promise>DONE</promise>",
    "With a promise, never call automation_loop complete; finish an active iteration with the exact final-response tag.",
    "Without a promise, the model must call automation_loop operation=complete with concrete evidence.",
    "Pi-managed bg_run/run_deck work started during an iteration is awaited before the next iteration.",
    "Queued continuations carry an iteration token and are dropped if the loop is paused, final, or has advanced.",
  ].join("\n"), "info") });

  pi.registerTool({
    name: "automation_loop",
    label: "Automation Loop",
    description: "Start or control a bounded Ralph-style same-prompt task loop. Start is accepted only after explicit user loop/autonomy intent. Pi-managed bg_run/run_deck work is awaited automatically. With a completion promise, never call complete: emit the exact tag in the final response. Without a promise, complete requires objective evidence.",
    promptSnippet: "Start/control a bounded same-prompt automation loop with evidence checkpoints",
    promptGuidelines: [
      "Use automation_loop start only when the current user explicitly requests a Ralph/automation loop, repeated autonomous iteration, or work-until-complete behavior; otherwise continue normally without starting a loop.",
      "During an automation_loop, checkpoint material PASS/FAIL/NULL results. bg_run/run_deck work started in the iteration is awaited automatically; pause for unmanaged waits or human/resource decisions.",
      "If automation_loop status shows a completion promise, never call operation=complete; end the final response with the exact promise tag only after objective completion. Without a promise, never complete without objective evidence.",
    ],
    parameters: Type.Object({
      operation: StringEnum(["status", "start", "checkpoint", "pause", "complete"] as const),
      prompt: Type.Optional(Type.String()),
      maxIterations: Type.Optional(Type.Number()),
      maxStalls: Type.Optional(Type.Number()),
      completionPromise: Type.Optional(Type.String()),
      verdict: Type.Optional(StringEnum(["pass", "fail", "null", "partial", "note"] as const)),
      summary: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: AnyCtx) {
      params ||= {};
      const store = storeFor(ctx); const sid = sessionId(ctx);
      if (params.operation === "status") {
        const state = store.current(sid) || store.recent(sid);
        if (!state) return notApplicableToolResult(store, "status", "no-loop", "No automation loop found.");
        const details = { ...summarizeLoop(state), operation: "status", outcome: "succeeded", ok: true };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
      if (params.operation === "start") {
        const eligible = toolStartAuthorized.get(sid) === true;
        toolStartAuthorized.set(sid, false);
        store.recordTelemetry({ kind: "start-eligibility", operation: "start", outcome: eligible ? "succeeded" : "blocked", eligible, source: "tool", reasonCode: eligible ? "explicit-intent-present" : "explicit-intent-required" });
        if (!eligible) return blockedToolResult(store, "start", "explicit-intent-required", "automation_loop start requires an explicit current user request for a Ralph/automation loop, repeated autonomous iteration, or work-until-complete behavior", undefined, { eligible: false });
        if (!String(params.prompt || "").trim()) return blockedToolResult(store, "start", "missing-prompt", "automation_loop start requires prompt", undefined, { eligible: true });
        try {
          const parsed = parseLoopArgs("", { ...startOptions(), defaultMaxIterations: params.maxIterations ?? DEFAULT_MAX, defaultMaxStalls: params.maxStalls ?? DEFAULT_MAX_STALLS });
          const state = await createState(pi, ctx, { prompt: params.prompt, maxIterations: parsed.maxIterations, maxStalls: parsed.maxStalls, completionPromise: params.completionPromise || null, startSource: "tool" });
          showStatus(ctx, state);
          const details = { ...summarizeLoop(state), operation: "start", outcome: "succeeded", ok: true };
          return { content: [{ type: "text", text: `Automation loop ${state.id} started at iteration 1/${state.maxIterations || "∞"}. Continue the requested task now; future iterations will receive the same prompt automatically.` }], details };
        } catch (error: any) {
          const code = rejectionCode(error);
          return blockedToolResult(store, "start", code, error?.message || String(error), undefined, { eligible: true });
        }
      }
      const state = store.current(sid);
      if (!state) return notApplicableToolResult(store, params.operation, "no-loop", "No active or paused automation loop exists in this session.");
      if (params.operation === "checkpoint") {
        const saved = store.checkpoint(state.id, { verdict: params.verdict, summary: params.summary, evidence: params.evidence });
        const details = { ...summarizeLoop(saved), operation: "checkpoint", outcome: "succeeded", ok: true }; return { content: [{ type: "text", text: `Checkpoint recorded for loop ${saved.id} iteration ${saved.iteration}.` }], details };
      }
      if (params.operation === "pause") {
        const saved = store.pause(state.id, params.reason || params.summary || "paused by agent for external/user dependency"); showStatus(ctx, saved);
        const details = { ...summarizeLoop(saved), operation: "pause", outcome: "succeeded", ok: true }; return { content: [{ type: "text", text: `Loop ${saved.id} paused: ${saved.pauseReason}` }], details, terminate: true };
      }
      if (params.operation === "complete") {
        if (state.completionPromise) {
          const guidance = completionGuidance(state);
          return blockedToolResult(store, "complete", "completion-promise-required", guidance.message, state);
        }
        if (!Array.isArray(params.evidence) || !params.evidence.filter(Boolean).length) return blockedToolResult(store, "complete", "completion-evidence-required", "Loop completion requires at least one concrete evidence reference.", state);
        const saved = store.complete(state.id, { summary: params.summary, evidence: params.evidence }); showStatus(ctx, saved);
        const details = { ...summarizeLoop(saved), operation: "complete", outcome: "succeeded", ok: true }; return { content: [{ type: "text", text: `Loop ${saved.id} completed with evidence.` }], details, terminate: true };
      }
      throw new Error(`unknown automation_loop operation: ${params.operation}`);
    },
  });
}
