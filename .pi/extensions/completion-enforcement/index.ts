import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENFORCEMENT_MODULE = join(LIB_ROOT, "src", "completion-enforcement.js");
// Pi reloads TypeScript extensions with jiti module caching disabled, but local
// CommonJS helpers remain in Node's require cache. Evict this helper so /reload
// cannot pair a new extension with stale enforcement exports.
try { delete require.cache[require.resolve(ENFORCEMENT_MODULE)]; } catch {}
const {
  COMPLETION_ENFORCEMENT_VERSION,
  buildContinuationPrompt,
  decideContinuation,
  detectUserBoundary,
  normalizeMaxContinuations,
} = require(ENFORCEMENT_MODULE);
const { classifyTaskModality, resolveTaskObjective, taskObjectiveFromSession } = require(join(LIB_ROOT, "src", "task-modality.js"));
const { instrumentExtensionCommands, notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Field evidence: implementation turns ended after partial increments and
// invented an "execution-budget checkpoint" that pi does not impose. This
// extension continues an authorized implementation turn when its final message
// stops on an unevidenced limit or partial-progress claim. Read-only turns
// (investigation, planning, verification, answer) are never enforced, and
// explicit user pauses, scope limits, and questions are never overridden.
const DECISION_HISTORY = 20;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function latestAssistantMessage(entries: any[]): { id: string; text: string; stopReason?: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // Compaction summaries reframe prior work; anything older than the boundary
    // is stale and must not be judged as this turn's result.
    if (entry?.type === "compaction") return undefined;
    if (entry?.type !== "message") continue;
    // A newer user message means the model has not answered it yet; an older
    // assistant message is stale and must not be judged as this turn's result.
    // Extension-authored prompts are persisted as user messages too.
    if (entry.message?.role === "user") return undefined;
    if (entry.message?.role !== "assistant") continue;
    return {
      id: String(entry.id ?? entry.message.timestamp ?? index),
      text: textOf(entry.message.content),
      stopReason: entry.message.stopReason,
    };
  }
  return undefined;
}

export default function completionEnforcement(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi) as ExtensionAPI;

  // Read per factory invocation (pi re-evaluates extensions on /reload) so a
  // changed control takes effect without restarting the process.
  const enabled = process.env.PI_COMPLETION_ENFORCEMENT !== "0";
  const maxContinuations = normalizeMaxContinuations(process.env.PI_COMPLETION_MAX_CONTINUATIONS);

  const state = {
    objective: "",
    policy: undefined as any,
    userBoundary: false,
    commandTurn: false,
    continuations: 0,
    capNotified: false,
    lastAssistantId: "",
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    status: {
      enabled,
      maxContinuations,
      modality: "unclassified",
      userBoundary: false,
      commandTurn: false,
      continuationsSent: 0,
      skippedNotIdle: 0,
      skippedOtherOwner: 0,
      skippedStopReason: 0,
      errors: 0,
      lastReason: undefined as string | undefined,
      lastError: undefined as string | undefined,
      decisions: [] as Array<{ at: string; action: string; reason: string; modality: string }>,
    },
  };

  const clearTimer = () => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const record = (action: string, reason: string) => {
    state.status.lastReason = reason;
    state.status.decisions.push({ at: new Date().toISOString(), action, reason, modality: state.status.modality });
    if (state.status.decisions.length > DECISION_HISTORY) state.status.decisions.splice(0, state.status.decisions.length - DECISION_HISTORY);
  };

  const reset = () => {
    clearTimer();
    state.objective = "";
    state.policy = undefined;
    state.userBoundary = false;
    state.commandTurn = false;
    state.continuations = 0;
    state.capNotified = false;
    state.lastAssistantId = "";
    state.status.modality = "unclassified";
    state.status.userBoundary = false;
    state.status.commandTurn = false;
    state.status.continuationsSent = 0;
    state.status.skippedNotIdle = 0;
    state.status.skippedOtherOwner = 0;
    state.status.skippedStopReason = 0;
    state.status.errors = 0;
    state.status.lastReason = undefined;
    state.status.lastError = undefined;
    state.status.decisions = [];
  };

  // Send on the next tick so other settled handlers (compaction rescue,
  // automation loop) can queue their own continuation first. The decision is
  // re-checked after that window instead of sending blindly.
  const scheduleContinuation = (ctx: any, reason: string) => {
    clearTimer();
    const sessionId = typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
    const timer = setTimeout(() => {
      state.timer = undefined;
      try {
        if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
          state.status.skippedNotIdle += 1;
          return;
        }
        if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
          state.status.skippedOtherOwner += 1;
          record("settle", "other-continuation-owner");
          return;
        }
        if (sessionId !== undefined && typeof ctx.sessionManager?.getSessionId === "function" && ctx.sessionManager.getSessionId() !== sessionId) return;
        state.continuations += 1;
        Promise.resolve(pi.sendUserMessage(buildContinuationPrompt(state.objective))).then(
          () => {
            state.status.continuationsSent += 1;
            notify(ctx, `Completion enforcement: continuing implementation (${state.continuations}/${maxContinuations}); "${reason}" is not an evidenced stop.`, "info");
          },
          (error: unknown) => {
            state.status.errors += 1;
            state.status.lastError = error instanceof Error ? error.message : String(error);
          },
        );
      } catch (error) {
        state.status.errors += 1;
        state.status.lastError = error instanceof Error ? error.message : String(error);
      }
    }, 0);
    timer.unref?.();
    state.timer = timer;
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    reset();
    // A resumed session keeps the objective recorded by the reasoning runtime,
    // so enforcement applies to the task that is actually still in progress.
    try {
      const objective = taskObjectiveFromSession(ctx.sessionManager.getBranch());
      if (!objective) return;
      const policy = classifyTaskModality(objective);
      state.objective = objective;
      state.policy = policy;
      state.status.modality = policy?.modality || "unclassified";
      state.userBoundary = detectUserBoundary(objective);
      state.status.userBoundary = state.userBoundary;
    } catch (error) {
      state.status.errors += 1;
      state.status.lastError = error instanceof Error ? error.message : String(error);
    }
  });

  pi.on("input", (event: any) => {
    const text = typeof event?.text === "string" ? event.text.trim() : "";
    // Extension-authored prompts (including this extension's continuation)
    // repeat the user's authorized task; they must not replace its objective or
    // reset the modality to "unclassified".
    if (!text || event?.source === "extension") return { action: "continue" as const };
    // Slash commands (skills, templates) expand into prompts that are not the
    // user's task statement; they must not replace the tracked objective. Until
    // a real instruction arrives, enforcement stays inert for the command turn
    // instead of continuing it under the previous implementation objective.
    if (text.startsWith("/")) {
      state.commandTurn = true;
      state.status.commandTurn = true;
      state.continuations = 0;
      state.capNotified = false;
      state.lastAssistantId = "";
      clearTimer();
      return { action: "continue" as const };
    }
    state.commandTurn = false;
    state.status.commandTurn = false;
    const parentTask = state.objective ? { objective: state.objective, policy: state.policy } : undefined;
    const policy = classifyTaskModality(text, { parentTask });
    const objective = resolveTaskObjective(text, { parentTask }) || state.objective;
    state.objective = objective;
    state.policy = policy;
    state.status.modality = policy?.modality || "unclassified";
    // A bare continuation keeps the user's existing pause/scope limit; a new
    // instruction replaces it.
    if (objective !== text) {
      if (detectUserBoundary(text)) state.userBoundary = true;
    } else {
      state.userBoundary = detectUserBoundary(text);
    }
    state.status.userBoundary = state.userBoundary;
    state.continuations = 0;
    state.capNotified = false;
    state.lastAssistantId = "";
    clearTimer();
    return { action: "continue" as const };
  });

  pi.on("agent_settled", (event: any, ctx: any) => {
    if (!enabled) return;
    try {
      // An aborted turn is a user decision, never an unfinished task.
      if (event?.aborted) {
        record("settle", "user-aborted");
        return;
      }
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
        state.status.skippedNotIdle += 1;
        return;
      }
      // Another continuation owner (compaction rescue, automation loop, monitor
      // wake) already queued work for this settle.
      if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
        state.status.skippedOtherOwner += 1;
        record("settle", "other-continuation-owner");
        return;
      }
      // A slash-command/skill turn is not the tracked implementation task; do
      // not continue it under a previous objective or modality.
      if (state.commandTurn) {
        record("settle", "command-turn");
        return;
      }
      const entries = ctx.sessionManager.getBranch();
      const last = latestAssistantMessage(entries);
      if (!last || last.id === state.lastAssistantId) return;
      state.lastAssistantId = last.id;
      if (last.stopReason && last.stopReason !== "stop") {
        // Aborted, errored, or output-limited turns are handled elsewhere and
        // must not be continued from here.
        state.status.skippedStopReason += 1;
        record("settle", `stop-reason-${last.stopReason}`);
        return;
      }
      const decision = decideContinuation({
        modality: state.policy?.modality,
        text: last.text,
        continuationCount: state.continuations,
        maxContinuations,
        userBoundary: state.userBoundary,
      });
      record(decision.action, decision.reason);
      if (decision.action !== "continue") {
        if (decision.reason === "continuation-cap" && !state.capNotified) {
          state.capNotified = true;
          notify(ctx, `Completion enforcement: continuation cap reached (${maxContinuations}); stopping enforcement for this request. Send a new instruction or raise PI_COMPLETION_MAX_CONTINUATIONS.`, "warning");
        }
        return;
      }
      scheduleContinuation(ctx, decision.reason);
    } catch (error) {
      state.status.errors += 1;
      state.status.lastError = error instanceof Error ? error.message : String(error);
    }
  });

  pi.on("session_shutdown", () => {
    clearTimer();
  });

  pi.registerCommand("completion-enforcement-status", {
    description: "Show completion-enforcement state (modality, continuations, last decision reasons)",
    handler: async (_args: string, ctx: any) => {
      const report = {
        version: COMPLETION_ENFORCEMENT_VERSION,
        ...state.status,
        objectiveChars: state.objective.length,
      };
      notify(ctx, JSON.stringify(report, null, 2), "info");
    },
  });
}
