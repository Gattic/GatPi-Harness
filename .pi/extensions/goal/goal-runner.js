"use strict";

const { readFileSync } = require("node:fs");
const path = require("node:path");

let createTraceRuntime;
let evaluatePolicy;
try {
  ({ createTraceRuntime } = require("../../../src/trace-observability.js"));
} catch {
  createTraceRuntime = undefined;
}
try {
  ({ evaluatePolicy } = require("../../../src/runtime-policy.js"));
} catch {
  evaluatePolicy = undefined;
}
const { GoalControllerAdapter, HermesAdvisoryAdapter } = require("../../../src/integration-boundary.js");

function commandOutput(error) {
  if (!error || typeof error !== "object") return String(error);
  const meta = [error.killed ? "process killed" : null, error.signal ? `signal=${error.signal}` : null, error.code != null ? `exitCode=${error.code}` : null].filter(Boolean);
  const output = String(error.message || error.name || "controller error").replace(/\s+/g, " ").slice(0, 400);
  return [output, meta.length ? `[${meta.join(", ")}]` : null].filter(Boolean).join("\n");
}

function controllerErrorCategory(error) {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const category = String(current.category || current.reasonCode || "").trim();
    if (category) return category;
    current = current.cause;
  }
  return "unknown";
}

function controllerErrorRetryAfter(error) {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const retryAt = Date.parse(String(current.retryAfter || ""));
    if (Number.isFinite(retryAt)) return new Date(retryAt).toISOString();
    current = current.cause;
  }
  return null;
}

const FINAL_STATUSES = new Set(["completed", "blocked", "failed", "cancelled"]);
const INITIAL_HERMES_TIMEOUT_MAX_ATTEMPTS = 2;

function extractFirstJsonObject(text) {
  const source = String(text || "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("No valid JSON object found in Hermes output");
}

function validateDecision(value) {
  return new GoalControllerAdapter().parseDecision(value);
}

function createFixtureHermesAsk(file) {
  const decisions = readFileSync(file, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let index = 0;
  return async () => {
    if (index >= decisions.length) return decisions.at(-1) || JSON.stringify({ schemaVersion: 3, status: "blocked", action: null, reasonCode: "fixture-exhausted", requiresUserInput: false, completionEvidenceIds: [] });
    return decisions[index++];
  };
}

function limitText(text, max = 8000) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}…<${value.length - max} chars>` : value;
}

function redactSensitiveText(text) {
  return limitText(text)
    .replace(/\b((?:sk|pk|ghp|github_pat|glpat|xox[baprs]|ya29|hf|AIza)[-_a-zA-Z0-9]{16,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)(\s*[:=]\s*)([^\s'\"`]+).*/gi, "$1$2[REDACTED]")
    .replace(/^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*)(\s*=\s*).*/gim, "$1$2[REDACTED]");
}

function summarizeEntries(entries, startIndex) {
  const added = entries.slice(startIndex);
  const lines = [];
  for (const entry of added) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role || "message";
    const content = entry.message.content;
    const textParts = [];
    if (typeof content === "string") textParts.push(content);
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === "text" && typeof part.text === "string") textParts.push(part.text);
        if (part && part.type === "toolCall" && typeof part.name === "string") textParts.push(`Tool ${part.name}: ${JSON.stringify(part.arguments || {}).slice(0, 500)}`);
      }
    }
    const text = redactSensitiveText(textParts.join("\n").replace(/\s+/g, " ").trim());
    if (text) lines.push(`${role}: ${text.slice(0, 1200)}`);
  }
  return lines.join("\n") || "No new session entries were recorded.";
}

function formatObservation(iteration, decision, result, dispatch = {}) {
  return [
    `[${new Date().toISOString()}] iteration ${iteration}`,
    `status: ${decision.status}`,
    `reasonCode: ${decision.reasonCode || "unknown"}`,
    decision.action ? `action: ${decision.action.kind}` : undefined,
    dispatch.dispatchMode ? `dispatchMode: ${dispatch.dispatchMode}` : undefined,
    dispatch.promptSource ? `promptSource: ${dispatch.promptSource}` : undefined,
    dispatch.actionResultCode ? `actionResultCode: ${dispatch.actionResultCode}` : undefined,
    `evidenceIds: ${(decision.completionEvidenceIds || []).join(",") || "none"}`,
    `result: ${redactSensitiveText(String(result || "")).slice(0, 4000)}`,
  ].filter(Boolean).join("\n");
}

function makeHistoryRecord(iteration, decision, result, executed = false, dispatch = {}) {
  return {
    schemaVersion: 2,
    iteration,
    at: new Date().toISOString(),
    status: decision.status,
    action: decision.action || null,
    attemptedActionKind: dispatch.action?.kind || decision.action?.kind || null,
    reasonCode: decision.reasonCode || "unknown",
    requiresUserInput: decision.requiresUserInput,
    completionEvidenceIds: decision.completionEvidenceIds || [],
    dispatchMode: dispatch.dispatchMode || "none",
    promptSource: dispatch.promptSource || null,
    actionResultCode: dispatch.actionResultCode || dispatch.reasonCode || "not-dispatched",
    actionLatencyMs: Number(dispatch.latencyMs || 0),
    proofRejectionReason: dispatch.proofRejectionReason || null,
    executed,
    result: redactSensitiveText(String(result || "")).slice(0, 8000),
  };
}

function makePendingPromptRecord(iteration, decision, branchStart, dispatch = {}) {
  return {
    schemaVersion: 2,
    iteration,
    branchStart,
    decision,
    dispatch: { dispatchMode: dispatch.dispatchMode, promptSource: dispatch.promptSource || null, actionResultCode: dispatch.actionResultCode || dispatch.reasonCode, latencyMs: Number(dispatch.latencyMs || 0), startedAt: Number(dispatch.startedAt || Date.now()) },
  };
}

function decisionFromPendingPrompt(pending) {
  if (!pending.decision) throw new Error("pending prompt is missing its typed decision");
  return validateDecision(pending.decision);
}

function capturePendingPromptObservation(state, ctx) {
  const pending = state?.pendingPrompt;
  if (!pending) return { state, captured: false };
  const branch = ctx?.sessionManager?.getBranch?.() || [];
  const branchStart = Number.isFinite(pending.branchStart) ? pending.branchStart : Math.max(0, branch.length - 1);
  const result = summarizeEntries(branch, branchStart);
  const decision = decisionFromPendingPrompt(pending);
  const iteration = Number.isFinite(pending.iteration) ? pending.iteration : state.iteration;
  const dispatch = { ...(pending.dispatch || {}), latencyMs: pending.dispatch?.startedAt ? Math.max(0, Date.now() - pending.dispatch.startedAt) : Number(pending.dispatch?.latencyMs || 0) };
  state.observations = [...(state.observations || []), formatObservation(iteration, decision, result, dispatch)];
  state.history = [...(state.history || []), makeHistoryRecord(iteration, decision, result, true, dispatch)];
  delete state.pendingPrompt;
  return { state, captured: true };
}

function pendingPromptHasBranchOutput(state, ctx) {
  const pending = state?.pendingPrompt;
  if (!pending) return true;
  const branch = ctx?.sessionManager?.getBranch?.() || [];
  const branchStart = Number.isFinite(pending.branchStart) ? pending.branchStart : 0;
  return branch.slice(branchStart).some((entry) => entry?.type === "message" && entry.message?.role === "assistant");
}

function isWithinPath(target, base) {
  const relative = path.relative(base, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNegatedWriteReference(text, verbIndex) {
  const boundary = Math.max(
    text.lastIndexOf("\n", verbIndex),
    text.lastIndexOf(".", verbIndex),
    text.lastIndexOf(";", verbIndex),
    text.lastIndexOf(",", verbIndex),
  );
  const prefix = text.slice(boundary + 1, verbIndex);
  return /\b(?:do\s+not|don't|dont|never|avoid|without)\b/i.test(prefix);
}

function findWriteLikeOutsideRepoPath(text, cwd) {
  if (!cwd) return undefined;
  const repo = path.resolve(cwd);
  const writePathPattern = /\b(?:write|edit|modify|create|delete)\b(?!-)[^\n]*?(?<![\w.-])(\/[^\s'"`),.;]+)/gi;
  let match;
  while ((match = writePathPattern.exec(text)) !== null) {
    if (isNegatedWriteReference(text, match.index)) continue;
    const abs = match[1];
    if (!isWithinPath(path.resolve(abs), repo)) return abs;
  }
  return undefined;
}

function isUnsafeNextPrompt(prompt, cwd = process.cwd()) {
  if (process.env.PI_GOAL_ALLOW_UNSAFE === "1") return undefined;
  const text = String(prompt || "");
  const checks = [
    [/\brm\s+-[^\n]*r[f]?\b|\brm\s+-[^\n]*f[^\n]*r\b|\brm\s+-rf\b/i, "recursive/force removal"],
    [/\bsudo\b/i, "sudo command"],
    [/\b(?:curl|wget)\b[^\n]*(?:\||>)/i, "network download piped or redirected"],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/i, "package installation"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive permission/ownership change"],
  ];
  for (const [pattern, reason] of checks) if (pattern.test(text)) return `Blocked unsafe autonomous action: ${reason}`;
  const abs = findWriteLikeOutsideRepoPath(text, cwd);
  if (abs) return `Blocked write-like action outside repo: ${abs}`;
  if (evaluatePolicy) {
    const decision = evaluatePolicy({ command: text, kind: "goal-nextPrompt" }, { cwd });
    if (!decision.ok || decision.severity === "warn") return `Blocked by policy gate: ${decision.reasons.join("; ")}`;
  }
  return undefined;
}

function publicGoalPacket(state, cwd = process.cwd()) {
  const projectName = (path.basename(path.resolve(cwd || process.cwd())) || "repo").replace(/[^a-zA-Z0-9._-]/g, "_");
  return {
    goalId: state.id,
    goal: state.goal,
    status: state.status,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    executionContext: {
      projectName,
      workspaceRef: "current-project",
      currentProjectAvailable: true,
      localInspectionAvailable: true,
    },
    approvedTopologyIds: (state.actionAuthority?.approvedTopologyIds || []).slice(0, 32),
    completionEvidenceIds: (state.completionEvidenceIds || []).slice(0, 64),
    recentActions: (state.history || []).slice(-10).map((record) => ({
      iteration: record.iteration,
      status: record.status,
      actionKind: record.attemptedActionKind || record.action?.kind || null,
      dispatchMode: record.dispatchMode || "none",
      actionResultCode: record.actionResultCode || "unknown",
      evidenceIds: (record.completionEvidenceIds || []).slice(0, 32),
      proofRejectionReason: record.proofRejectionReason || null,
    })),
  };
}

class GoalRunner {
  constructor({ store, hermesAsk, hermes, maxIterations = 50, traceRuntime, sendUserMessage, onFinalized, controllerAdapter, evidenceAdapter, wait, now } = {}) {
    if (!store) throw new Error("GoalRunner requires a GoalStore");
    this.store = store;
    this.hermesAsk = hermesAsk || (process.env.PI_GOAL_CONTROLLER_FIXTURE ? createFixtureHermesAsk(process.env.PI_GOAL_CONTROLLER_FIXTURE) : null);
    this.hermes = hermes || new HermesAdvisoryAdapter({ cwd: store.cwd, authority: { canonicalPromotionAllowed: false, automaticMutationAllowed: false } });
    this.defaultMaxIterations = maxIterations;
    this.wait = typeof wait === "function" ? wait : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
    this.now = typeof now === "function" ? now : Date.now;
    this.lastParseError = undefined;
    this.sendUserMessage = sendUserMessage;
    this.onFinalized = typeof onFinalized === "function" ? onFinalized : null;
    this.controllerAdapter = controllerAdapter || new GoalControllerAdapter();
    this.evidenceAdapter = evidenceAdapter || null;
    this.trace = traceRuntime || (createTraceRuntime && process.env.PI_GOAL_TRACE_ENABLED !== "0" ? createTraceRuntime({ sessionId: "goal", subsystem: "goal" }) : undefined);
    this.running = false;
    this.cancelRequested = false;
  }

  emitTrace(name, payload = {}, severity = "info", category = "session") {
    try {
      this.trace?.emit({ subsystem: "goal", category, name, severity, payload });
    } catch {
      // tracing must never affect goal execution
    }
  }

  async start(goal, ctx, options = {}) {
    if (this.running) throw new Error("A goal is already running");
    let state = await this.store.create(goal, { maxIterations: options.maxIterations || this.defaultMaxIterations, approvedTopologyIds: options.approvedTopologyIds || [] });
    state.traceCorrelationId = this.trace?.correlationId;
    state = await this.store.save(state);
    this.emitTrace("goal.started", { id: state.id, goal: state.goal, maxIterations: state.maxIterations, traceCorrelationId: state.traceCorrelationId });
    return this.run(state, ctx);
  }

  async resume(ctx) {
    if (this.running) throw new Error("A goal is already running");
    const state = await this.store.getMostRecentUnfinished();
    if (!state) return undefined;
    if (FINAL_STATUSES.has(state.status) && state.status !== "blocked") return undefined;
    state.status = "running";
    if (state.iteration >= state.maxIterations) state.maxIterations = state.iteration + this.defaultMaxIterations;
    const saved = await this.store.save(state);
    return this.run(saved, ctx);
  }

  async stop() {
    this.cancelRequested = true;
    const state = await this.store.cancelActive();
    if (state) await this.notifyFinalized(state);
    return state;
  }

  async notifyFinalized(state) {
    if (!this.onFinalized || !FINAL_STATUSES.has(state?.status)) return;
    try { await this.onFinalized(state); }
    catch (error) { this.emitTrace("goal.finalized_callback_failed", { id: state.id, status: state.status, error: error instanceof Error ? error.message : String(error) }, "warn", "failure_state"); }
  }

  async finalize(state) {
    const saved = await this.store.save(state);
    await this.notifyFinalized(saved);
    return saved;
  }

  async failState(state, error) {
    state.status = "blocked";
    this.emitTrace("goal.runner_error", { id: state.id, error: error instanceof Error ? error.message : String(error) }, "error", "failure_state");
    state.observations = [...(state.observations || []), `[${new Date().toISOString()}] Goal runner error: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`];
    state.history = state.history || [];
    await this.finalize(state).catch(() => undefined);
  }

  async askHermesDecision(state) {
    const packet = publicGoalPacket(state, this.store.cwd);
    const parseForCurrentProject = (value) => this.controllerAdapter.parseDecision(value, { currentProjectAvailable: true, goalId: state.id });
    if (!this.hermesAsk) {
      try {
        const result = await this.hermes.decide(packet, {
          probeAuth: true,
          validate: parseForCurrentProject,
        });
        return { decision: result.value, repairTurns: result.receipt.repairTurns || 0, receiptId: result.receipt.receiptId };
      } catch (error) {
        const wrapped = new Error(`Hermes advisory controller failed: ${commandOutput(error)}`);
        wrapped.kind = "hermes_command";
        wrapped.cause = error;
        throw wrapped;
      }
    }
    let raw;
    try { raw = await this.hermesAsk(this.store.cwd, JSON.stringify(packet)); }
    catch (error) { const wrapped = new Error(`Hermes controller fixture failed: ${commandOutput(error)}`); wrapped.kind = "hermes_command"; wrapped.cause = error; throw wrapped; }
    try { return { decision: parseForCurrentProject(extractFirstJsonObject(raw)), repairTurns: 0 }; }
    catch (firstError) {
      const repairPrompt = ["Repair this typed goal decision.", `Parser error: ${firstError instanceof Error ? firstError.message : String(firstError)}`, "Return only one strict schema-v3 JSON object with fields: schemaVersion, status, action, reasonCode, requiresUserInput, completionEvidenceIds. Every executable action must include a complete Hermes-authored prompt that Pi can execute verbatim. No extra fields.", raw].join("\n\n");
      const repairedRaw = await this.hermesAsk(this.store.cwd, repairPrompt);
      try { return { decision: parseForCurrentProject(extractFirstJsonObject(repairedRaw)), repairTurns: 1 }; }
      catch (secondError) { const error = new Error(`Malformed Hermes JSON after repair: ${secondError instanceof Error ? secondError.message : String(secondError)}`); error.repairTurns = 1; this.lastParseError = { at: new Date().toISOString(), message: error.message }; throw error; }
    }
  }

  async askHermesDecisionWithInitialTimeoutRetry(state) {
    const maxAttempts = state.iteration === 1 ? INITIAL_HERMES_TIMEOUT_MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return { ...(await this.askHermesDecision(state)), controllerAttempts: attempt };
      } catch (error) {
        const errorCategory = controllerErrorCategory(error);
        if (errorCategory === "timeout" && attempt < maxAttempts) {
          const retryAfter = controllerErrorRetryAfter(error);
          const retryAt = Date.parse(String(retryAfter || ""));
          const retryDelayMs = Number.isFinite(retryAt) ? Math.max(0, retryAt - this.now()) : 0;
          this.emitTrace("goal.hermes_timeout_retry", { id: state.id, iteration: state.iteration, attempt, maxAttempts, errorCategory, retryAfter, retryDelayMs }, "warn", "failure_state");
          if (retryDelayMs > 0) await this.wait(retryDelayMs);
          continue;
        }
        error.errorCategory = errorCategory;
        error.controllerAttempts = attempt;
        throw error;
      }
    }
    throw new Error("Initial Hermes controller retry loop exhausted without a result");
  }

  async validateCompletionProof(state, decision) {
    if (!decision.completionEvidenceIds?.length) return { ok: false, reason: "completion-evidence-required", results: [] };
    if (!this.evidenceAdapter || typeof this.evidenceAdapter.validateCompletion !== "function") return { ok: false, reason: "goal-evidence-adapter-unavailable", results: [] };
    try {
      const result = await Promise.resolve(this.evidenceAdapter.validateCompletion({ evidenceIds: decision.completionEvidenceIds, goalCreatedAt: state.createdAt, expectedFingerprints: state.evidenceFingerprints || {} }));
      return result && typeof result === "object" ? result : { ok: false, reason: "goal-evidence-invalid-response", results: [] };
    } catch (error) {
      return { ok: false, reason: "goal-evidence-validation-failed", results: [], errorCode: error?.code || "validation-error" };
    }
  }

  async run(initialState, ctx) {
    this.running = true;
    this.cancelRequested = false;
    let state = initialState;
    try {
      const pendingCapture = capturePendingPromptObservation(state, ctx);
      if (pendingCapture.captured) {
        state = await this.store.save(pendingCapture.state);
        this.emitTrace("goal.pending_prompt_captured", { id: state.id, iteration: state.iteration }, "info", "message");
      }
      while (state.status === "running" && state.iteration < state.maxIterations) {
        if (this.cancelRequested) {
          state.status = "cancelled";
          this.emitTrace("goal.cancelled", { id: state.id, iteration: state.iteration }, "warn", "cancellation");
          state.observations.push(`[${new Date().toISOString()}] Cancelled by user.`);
          state = await this.finalize(state);
          return state;
        }

        state.iteration += 1;
        state = await this.store.save(state);

        let decision;
        let repairTurns = 0;
        let controllerAttempts = 1;
        try {
          ({ decision, repairTurns = 0, controllerAttempts = 1 } = await this.askHermesDecisionWithInitialTimeoutRetry(state));
          state.controllerRepairTurns = Number(state.controllerRepairTurns || 0) + repairTurns;
          this.emitTrace("goal.hermes_decision", { id: state.id, iteration: state.iteration, status: decision.status, requiresUserInput: decision.requiresUserInput, actionKind: decision.action?.kind || null, completionEvidenceCount: decision.completionEvidenceIds?.length || 0, controllerAttempts }, "info", "model_response");
        } catch (error) {
          state.status = "blocked";
          state.controllerRepairTurns = Number(state.controllerRepairTurns || 0) + Number(error?.repairTurns || 0);
          const commandFailure = error?.kind === "hermes_command";
          const errorCategory = error?.errorCategory || controllerErrorCategory(error);
          controllerAttempts = Number(error?.controllerAttempts || 1);
          if (!commandFailure) this.lastParseError = { at: new Date().toISOString(), message: error.message };
          const eventName = commandFailure ? "goal.hermes_command_failed" : "goal.malformed_hermes_json";
          const label = commandFailure ? "Hermes controller command failed" : "Hermes controller returned malformed JSON";
          this.emitTrace(eventName, { id: state.id, iteration: state.iteration, error: error.message, errorCategory, controllerAttempts }, "error", "failure_state");
          state.observations.push(`[${new Date().toISOString()}] ${label}. ${redactSensitiveText(error.message)}`);
          state.history = [...(state.history || []), { iteration: state.iteration, at: new Date().toISOString(), status: "blocked", error: redactSensitiveText(error.message), errorKind: commandFailure ? "hermes_command" : "malformed_hermes_json", errorCategory, controllerAttempts }];
          state = await this.finalize(state);
          return state;
        }

        let terminalDispatch = { dispatchMode: "none", actionResultCode: "terminal-decision", latencyMs: 0 };
        if (decision.status === "completed") {
          const proof = await this.validateCompletionProof(state, decision);
          if (!proof.ok) {
            terminalDispatch = { ...terminalDispatch, actionResultCode: "completion-proof-rejected", proofRejectionReason: proof.reason };
            this.emitTrace("goal.completion_rejected", { id: state.id, iteration: state.iteration, reasonCode: proof.reason, evidenceIds: decision.completionEvidenceIds || [] }, "warn", "verifier_result");
            decision = { ...decision, status: "blocked", reasonCode: "completion-proof-rejected" };
          } else {
            terminalDispatch = { ...terminalDispatch, actionResultCode: "completion-proof-accepted" };
            state.completionEvidenceIds = decision.completionEvidenceIds || [];
          }
        }

        if (["completed", "blocked", "failed"].includes(decision.status)) {
          state.status = decision.status;
          const result = decision.status === "completed"
            ? "Goal completion accepted from current passing evidence IDs."
            : terminalDispatch.proofRejectionReason
              ? `Completion rejected: ${terminalDispatch.proofRejectionReason}.`
              : "Hermes stopped the goal loop without dispatching another action.";
          state.observations.push(formatObservation(state.iteration, decision, result, terminalDispatch));
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, decision, result, false, terminalDispatch)];
          this.emitTrace("goal.final_status", { id: state.id, status: state.status, iteration: state.iteration }, state.status === "failed" ? "error" : "info", state.status === "failed" ? "failure_state" : "session");
          state = await this.finalize(state);
          return state;
        }

        const actionStartedAt = Date.now();
        const dispatch = this.controllerAdapter.dispatch(decision.action, state);
        dispatch.startedAt = actionStartedAt;
        if (!dispatch.ok) {
          state.status = "blocked";
          const blockedDecision = { ...decision, status: "blocked", action: null, reasonCode: dispatch.reasonCode };
          const result = `Typed goal action rejected: ${dispatch.reasonCode}.`;
          state.observations.push(formatObservation(state.iteration, blockedDecision, result, { ...dispatch, actionResultCode: "dispatch-rejected" }));
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, blockedDecision, result, false, { ...dispatch, actionResultCode: "dispatch-rejected" })];
          this.emitTrace("goal.action_rejected", { id: state.id, iteration: state.iteration, actionKind: decision.action?.kind, reasonCode: dispatch.reasonCode }, "warn", "failure_state");
          state = await this.finalize(state);
          return state;
        }

        if (dispatch.dispatchMode === "ask-user") {
          state.status = "blocked";
          state.pendingUserQuestion = dispatch.question;
          const blockedDecision = { ...decision, status: "blocked", action: null, reasonCode: "user-input-required" };
          const result = `User input required: ${redactSensitiveText(dispatch.question)}`;
          state.observations.push(formatObservation(state.iteration, blockedDecision, result, { ...dispatch, actionResultCode: "awaiting-user" }));
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, blockedDecision, result, false, { ...dispatch, actionResultCode: "awaiting-user" })];
          this.emitTrace("goal.user_input_required", { id: state.id, iteration: state.iteration }, "warn", "failure_state");
          state = await this.finalize(state);
          return state;
        }

        const unsafeReason = isUnsafeNextPrompt(dispatch.prompt, this.store.cwd);
        if (unsafeReason) {
          state.status = "blocked";
          const blockedDecision = { ...decision, status: "blocked", action: null, reasonCode: "unsafe-dispatch-blocked" };
          const result = `${unsafeReason}. Set PI_GOAL_ALLOW_UNSAFE=1 only if you explicitly accept the risk.`;
          state.observations.push(formatObservation(state.iteration, blockedDecision, result, { ...dispatch, actionResultCode: "safety-rejected" }));
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, blockedDecision, result, false, { ...dispatch, actionResultCode: "safety-rejected" })];
          this.emitTrace("goal.unsafe_prompt_blocked", { id: state.id, iteration: state.iteration, reason: unsafeReason }, "warn", "failure_state");
          state = await this.finalize(state);
          return state;
        }

        const beforeCount = ctx.sessionManager.getBranch().length;
        this.emitTrace("goal.action_executing", { id: state.id, iteration: state.iteration, actionKind: decision.action.kind, dispatchMode: dispatch.dispatchMode }, "info", "message");
        if (process.env.PI_GOAL_EXECUTION_FIXTURE_RESULT) {
          const result = process.env.PI_GOAL_EXECUTION_FIXTURE_RESULT;
          const outcome = { ...dispatch, actionResultCode: "fixture-executed", latencyMs: Math.max(0, Date.now() - actionStartedAt) };
          state.observations.push(formatObservation(state.iteration, decision, result, outcome));
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, decision, result, true, outcome)];
          this.emitTrace("goal.prompt_executed_fixture", { id: state.id, iteration: state.iteration }, "info", "message");
          state = await this.store.save(state);
          continue;
        }
        try {
          const send = typeof ctx.sendUserMessage === "function" ? ctx.sendUserMessage.bind(ctx) : this.sendUserMessage;
          if (typeof send !== "function") throw new Error("No harness sendUserMessage API is available in this mode");
          await send(dispatch.prompt, { deliverAs: "followUp" });
          if (typeof ctx.waitForIdle === "function") await ctx.waitForIdle();
          else {
            state.pendingPrompt = makePendingPromptRecord(state.iteration, decision, beforeCount, { ...dispatch, actionResultCode: "queued" });
            state.observations = [...(state.observations || []), `[${new Date().toISOString()}] Queued typed goal action ${decision.action.kind} for turn ${state.iteration}; waiting for agent_end before continuing.`];
            this.emitTrace("goal.prompt_queued", { id: state.id, iteration: state.iteration, actionKind: decision.action.kind }, "info", "message");
            return this.store.save(state);
          }
        } catch (error) {
          state.status = "blocked";
          const blockedDecision = { ...decision, status: "blocked", action: null, reasonCode: "action-execution-failed" };
          const result = `Failed to execute typed action through the harness: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`;
          const failedDispatch = { ...dispatch, actionResultCode: "execution-failed", latencyMs: Math.max(0, Date.now() - actionStartedAt) };
          state.observations.push(formatObservation(state.iteration, blockedDecision, result, failedDispatch));
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, blockedDecision, result, false, failedDispatch)];
          this.emitTrace("goal.prompt_execution_failed", { id: state.id, iteration: state.iteration, error: result }, "error", "failure_state");
          state = await this.finalize(state);
          return state;
        }
        const result = summarizeEntries(ctx.sessionManager.getBranch(), beforeCount);
        const persisted = await this.store.get(state.id);
        const outcome = { ...dispatch, actionResultCode: "prompt-settled", latencyMs: Math.max(0, Date.now() - actionStartedAt) };
        if (this.cancelRequested || persisted?.status === "cancelled") {
          state = persisted || state;
          state.status = "cancelled";
          this.emitTrace("goal.cancelled", { id: state.id, iteration: state.iteration }, "warn", "cancellation");
          state.observations = [...(state.observations || []), formatObservation(state.iteration, decision, result, outcome), `[${new Date().toISOString()}] Cancelled by user.`];
          state.history = [...(state.history || []), makeHistoryRecord(state.iteration, decision, result, true, outcome)];
          state = await this.finalize(state);
          return state;
        }
        state.observations.push(formatObservation(state.iteration, decision, result, outcome));
        state.history = [...(state.history || []), makeHistoryRecord(state.iteration, decision, result, true, outcome)];
        this.emitTrace("goal.action_executed", { id: state.id, iteration: state.iteration, actionKind: decision.action.kind, dispatchMode: dispatch.dispatchMode }, "info", "message");
        state = await this.store.save(state);
      }

      if (state.status === "running") {
        state.status = "blocked";
        state.observations.push(`[${new Date().toISOString()}] Max iteration limit reached (${state.maxIterations}); goal marked blocked to avoid an infinite loop.`);
        state.history = [...(state.history || []), { iteration: state.iteration, at: new Date().toISOString(), status: "blocked", reason: "max iteration limit reached" }];
        this.emitTrace("goal.max_iterations_reached", { id: state.id, maxIterations: state.maxIterations }, "warn", "failure_state");
        state = await this.finalize(state);
      }
      return state;
    } finally {
      this.running = false;
      this.cancelRequested = false;
    }
  }
}

module.exports = {
  GoalRunner,
  extractFirstJsonObject,
  validateDecision,
  summarizeEntries,
  publicGoalPacket,
  isUnsafeNextPrompt,
  pendingPromptHasBranchOutput,
  createFixtureHermesAsk,
  commandOutput,
};
