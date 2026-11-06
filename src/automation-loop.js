"use strict";

// Ralph-style same-prompt automation loop. The library owns deterministic
// state, settlement evaluation, completion detection, and prompt rendering;
// the Pi extension owns lifecycle events and message delivery.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 3;
const FINAL_STATUSES = new Set(["completed", "cancelled", "max_iterations", "failed"]);
const OPEN_STATUSES = new Set(["active", "paused"]);
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_STALLS = 3;
const MAX_ITERATIONS_LIMIT = 500;
const MAX_PROMPT_CHARS = 100_000;
const MAX_HISTORY = 200;

function nowIso() { return new Date().toISOString(); }
function sha(value, n = 16) { return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, n); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function safeText(text, max = 1000) {
  const value = String(text || "")
    .replace(/\b(?:(?:sk|pk|ghp|github_pat|glpat|xox[baprs]|ya29|hf)[-_][-_a-zA-Z0-9]{12,}|AIza[-_a-zA-Z0-9]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)(\s*[:=]\s*)([^\s'\"`]+).*/gi, "$1$2[REDACTED]")
    .replace(/^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*)(\s*=\s*).*/gim, "$1$2[REDACTED]");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
function atomicWrite(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function telemetryCode(value, fallback = "unspecified") {
  const code = String(value || fallback).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return code || fallback;
}
function sanitizeTelemetryEvent(event = {}, at = nowIso()) {
  const row = {
    at: String(event.at || at).slice(0, 40),
    kind: telemetryCode(event.kind || "lifecycle"),
    operation: telemetryCode(event.operation || "status"),
    outcome: ["succeeded", "domain-negative", "blocked", "not-applicable", "cancelled", "timed-out", "infrastructure-failed", "unknown"].includes(event.outcome) ? event.outcome : "unknown",
  };
  for (const key of ["loopId", "reasonCode", "source", "status", "verdict", "completionMode"]) if (event[key] != null) row[key] = telemetryCode(event[key]);
  if (typeof event.eligible === "boolean") row.eligible = event.eligible;
  if (Number.isFinite(Number(event.iteration))) row.iteration = Math.max(0, Number(event.iteration));
  return row;
}
function appendJsonlPrivate(file, value) {
  const dir = path.dirname(file);
  ensureDir(dir);
  try { fs.chmodSync(dir, 0o700); } catch {}
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function loopId(now = new Date()) { return `loop_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomBytes(3).toString("hex")}`; }
function positiveInteger(value, fallback, label, { allowZero = false, max = MAX_ITERATIONS_LIMIT } = {}) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  const valid = Number.isInteger(number) && (allowZero ? number >= 0 : number > 0) && number <= max;
  if (!valid) throw new Error(`${label} must be ${allowZero ? "0 or " : ""}an integer from ${allowZero ? 0 : 1} to ${max}`);
  return number;
}

function shellWords(input) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of String(input || "")) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { words.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote in loop arguments");
  if (current) words.push(current);
  return words;
}

function parseLoopArgs(args = "", options = {}) {
  const words = shellWords(args);
  const prompt = [];
  const values = {};
  let positionalOnly = false;
  const aliases = {
    "--max": "maxIterations", "--max-iterations": "maxIterations",
    "--promise": "completionPromise", "--completion-promise": "completionPromise", "--until": "completionPromise",
    "--max-stalls": "maxStalls", "--prompt-file": "promptFile", "--file": "promptFile",
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--") { positionalOnly = true; continue; }
    if (!positionalOnly && word.startsWith("--")) {
      const equal = word.indexOf("=");
      const flag = equal >= 0 ? word.slice(0, equal) : word;
      const key = aliases[flag];
      if (!key) throw new Error(`unknown loop option: ${flag}`);
      const value = equal >= 0 ? word.slice(equal + 1) : words[++i];
      if (value === undefined || value === "") throw new Error(`${flag} requires a value`);
      values[key] = value;
      continue;
    }
    prompt.push(word);
  }
  const defaultMax = positiveInteger(options.defaultMaxIterations, DEFAULT_MAX_ITERATIONS, "default max iterations", { allowZero: Boolean(options.allowUnbounded) });
  const maxIterations = positiveInteger(values.maxIterations, defaultMax, "max iterations", { allowZero: Boolean(options.allowUnbounded) });
  if (maxIterations === 0 && !options.allowUnbounded) throw new Error("unbounded loops require PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED=1");
  const maxStalls = positiveInteger(values.maxStalls, options.defaultMaxStalls ?? DEFAULT_MAX_STALLS, "max stalls", { allowZero: true, max: 100 });
  const completionPromise = values.completionPromise === undefined ? null : String(values.completionPromise).trim();
  if (completionPromise && completionPromise.length > 500) throw new Error("completion promise must be at most 500 characters");
  return { prompt: prompt.join(" ").trim(), promptFile: values.promptFile || null, maxIterations, maxStalls, completionPromise: completionPromise || null };
}

function normalizePromise(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
const ASSISTANT_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
function normalizeAssistantStopReason(value) {
  const reason = String(value || "unknown");
  return ASSISTANT_STOP_REASONS.has(reason) ? reason : "unknown";
}
function explicitAutomationIntent(text) {
  const value = normalizePromise(text).toLowerCase();
  if (!value) return false;
  return [
    /\b(?:use|start|run|launch|invoke|execute)\b.{0,60}\b(?:automation|autonomous|ralph|same[- ]prompt)\b.{0,20}\bloop\b/,
    /\b(?:loop|iterat(?:e|ing|ion)|repeat(?:ed|ing)?)\b.{0,100}\buntil\b.{0,60}\b(?:complete|completed|done|finished|green|pass(?:es|ing)?)\b/,
    /\b(?:work|fix|implement|finish|continue|keep going)\b.{0,100}\b(?:autonomously|until (?:it is |this is |fully )?(?:complete|done|finished)|without stopping)\b/,
    /\bautonomously\b.{0,100}\b(?:work|fix|implement|finish|continue|iterate)\b/,
    /\bwork[- ]until[- ]complete\b|\bdo not stop until\b|\bdon['’]?t stop until\b/,
  ].some((pattern) => pattern.test(value));
}
function completionPromiseDetected(text, promise) {
  if (!promise) return false;
  const wanted = normalizePromise(promise);
  const output = String(text || "");
  for (const match of output.matchAll(/<promise>([\s\S]*?)<\/promise>/gi)) {
    const endsResponse = output.slice(Number(match.index || 0) + match[0].length).trim() === "";
    if (endsResponse && normalizePromise(match[1]) === wanted) return true;
  }
  return false;
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function latestAssistant(branch = []) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return {
        entry,
        index: i,
        id: entry.id || entry.message.id || `assistant-${i}`,
        text: messageText(entry.message),
        stopReason: normalizeAssistantStopReason(entry.message.stopReason),
      };
    }
  }
  return null;
}

function assistantSettlementDisposition(assistant) {
  if (!assistant) return { action: "ignore", stopReason: "missing" };
  const stopReason = normalizeAssistantStopReason(assistant.stopReason);
  if (stopReason === "error" || stopReason === "aborted") return { action: "pause", stopReason };
  return { action: "settle", stopReason };
}

function iterationActivity(branch = [], startIndex = 0) {
  let toolCalls = 0;
  let toolErrors = 0;
  const tools = {};
  for (const entry of branch.slice(Math.max(0, Number(startIndex) || 0))) {
    if (entry?.type !== "message" || !entry.message) continue;
    if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const part of entry.message.content) if (part?.type === "toolCall") { toolCalls++; const name = String(part.name || "unknown"); tools[name] = (tools[name] || 0) + 1; }
    }
    if (entry.message.role === "toolResult" && entry.message.isError === true) toolErrors++;
  }
  return { toolCalls, toolErrors, tools };
}

function createContinuationToken() { return crypto.randomBytes(12).toString("hex"); }

async function waitForQueuedAgentStart(ctx, startEntryCount, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 10_000));
  const clock = options.clock || Date.now;
  const yieldTurn = options.yieldTurn || (() => new Promise((resolve) => setImmediate(resolve)));
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    if (!ctx.isIdle()) return "started";
    const branch = ctx.sessionManager?.getBranch?.() || [];
    const completed = branch.slice(Math.max(0, Number(startEntryCount || 0))).some((entry) => entry?.type === "message" && entry.message?.role === "assistant");
    if (completed) return "completed";
    await yieldTurn();
  }
  throw new Error(`queued automation-loop turn did not start within ${timeoutMs}ms`);
}

function buildLoopPrompt(state, { delivery = null } = {}) {
  const max = state.maxIterations > 0 ? state.maxIterations : "∞";
  const completion = state.completionPromise
    ? [
        "- Do NOT call automation_loop operation=complete for this loop.",
        "- Complete only when every requirement is objectively satisfied, then end your FINAL response with exactly:",
        `  <promise>${state.completionPromise}</promise>`,
        "- Never emit that promise merely to escape the loop.",
      ]
    : ["- When objectively complete, call automation_loop with operation=complete and cite concrete evidence."];
  const envelope = delivery?.token
    ? [`<!-- pi-automation-loop:${state.id}:${state.iteration}:${delivery.token} -->`]
    : [];
  return [
    state.prompt,
    "",
    `--- Automation loop iteration ${state.iteration}/${max} ---`,
    ...envelope,
    "Continue from the current files, git history, ledgers, and prior evidence; do not restart completed work.",
    "Loop contract:",
    "- This automation loop is already active. Do NOT call automation_loop operation=start.",
    "- Choose the smallest unmet acceptance criterion or highest-value bottleneck for this iteration.",
    "- Prefer one focused change/probe at a time. Treat failures and null results as evidence; do not repeat a settled failed approach.",
    "- Verify material changes. Record important PASS/FAIL/NULL/PARTIAL results with automation_loop operation=checkpoint.",
    "- Pi-managed bg_run and run_deck work started in this iteration is awaited automatically before the next iteration. Pause only for unmanaged/external waits, credentials, resource authorization, strategic judgment, or user input.",
    ...completion,
  ].join("\n");
}

function parseLoopDelivery(text) {
  const value = String(text || "");
  const generatedBlock = /--- Automation loop iteration (\d+)\/(\d+|∞) ---\r?\n(?:<!-- pi-automation-loop:([a-zA-Z0-9_-]+):(\d+):([a-f0-9]{16,64}) -->\r?\n)?Continue from the current files, git history, ledgers, and prior evidence; do not restart completed work\./g;
  let marker = null;
  for (const match of value.matchAll(generatedBlock)) marker = match;
  if (!marker) return null;
  const prompt = value.slice(0, Number(marker.index || 0)).trim();
  return {
    loopId: marker[3] || null,
    iteration: Number(marker[4] || marker[1]),
    markerIteration: Number(marker[1]),
    token: marker[5] || null,
    legacy: !marker[3],
    promptHash: sha(prompt),
  };
}

function validateLoopDelivery(state, delivery) {
  if (!state) return { ok: false, reason: "unknown-loop" };
  if (state.status !== "active") return { ok: false, reason: "loop-inactive" };
  if (!delivery || delivery.iteration !== delivery.markerIteration) return { ok: false, reason: "invalid-envelope" };
  if (delivery.loopId && delivery.loopId !== state.id) return { ok: false, reason: "wrong-loop" };
  if (delivery.promptHash !== state.promptHash) return { ok: false, reason: "wrong-prompt" };
  if (delivery.iteration !== state.iteration) return { ok: false, reason: "stale-iteration" };
  if (delivery.legacy) return state.pendingContinuation
    ? { ok: false, reason: "legacy-superseded-by-token" }
    : { ok: true, reason: "legacy-current" };
  const pending = state.pendingContinuation;
  if (!pending) return { ok: false, reason: "no-pending-continuation" };
  if (pending.iteration !== delivery.iteration || pending.token !== delivery.token) return { ok: false, reason: "stale-token" };
  return { ok: true, reason: "current" };
}

function completionGuidance(state) {
  if (!state?.completionPromise) {
    return { mode: "tool-evidence", message: "Call automation_loop operation=complete with concrete evidence when objectively complete." };
  }
  const requiredTag = `<promise>${state.completionPromise}</promise>`;
  if (state.status !== "active") {
    return {
      mode: "resume-then-final-response-promise",
      requiredTag,
      message: `Loop ${state.id} is ${state.status}. Tool completion is intentionally disabled. A human must use /loop-resume before the model can finish an active iteration with exactly ${requiredTag}.`,
    };
  }
  return {
    mode: "final-response-promise",
    requiredTag,
    message: `This loop uses an exact final-response promise. Do not call automation_loop complete. When objectively complete, end the FINAL response with exactly ${requiredTag}.`,
  };
}

function appendContinuationEvent(state, event) {
  const row = {
    at: event.at,
    iteration: Math.max(1, Number(event.iteration || state.iteration || 1)),
    tokenHash: event.tokenHash || null,
    queuedAt: event.queuedAt || null,
    outcome: event.outcome === "delivered" ? "delivered" : "dropped",
    reason: safeText(event.reason || "unspecified", 120),
  };
  const duplicate = (state.continuationEvents || []).some((item) => item.iteration === row.iteration && item.tokenHash === row.tokenHash && item.outcome === row.outcome);
  return duplicate ? state : { ...state, continuationEvents: [...(state.continuationEvents || []), row].slice(-MAX_HISTORY) };
}

function closePendingContinuation(state, at, reason) {
  const pending = state.pendingContinuation;
  if (!pending) return state;
  const next = appendContinuationEvent(state, { at, iteration: pending.iteration, tokenHash: pending.tokenHash || sha(pending.token), queuedAt: pending.queuedAt || null, outcome: "dropped", reason });
  return { ...next, pendingContinuation: null };
}

function createLoopState(input = {}, options = {}) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("loop prompt is required");
  const maxPromptChars = positiveInteger(options.maxPromptChars, MAX_PROMPT_CHARS, "max prompt chars", { max: 1_000_000 });
  if (prompt.length > maxPromptChars) throw new Error(`loop prompt exceeds ${maxPromptChars} characters`);
  const now = options.now || nowIso();
  const maxIterations = positiveInteger(input.maxIterations, DEFAULT_MAX_ITERATIONS, "max iterations", { allowZero: Boolean(options.allowUnbounded) });
  if (maxIterations === 0 && !options.allowUnbounded) throw new Error("unbounded loops are disabled");
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id || loopId(new Date(now)),
    sessionId: String(input.sessionId || "ephemeral"),
    prompt,
    promptHash: sha(prompt),
    status: "active",
    iteration: 1,
    maxIterations,
    maxStalls: positiveInteger(input.maxStalls, DEFAULT_MAX_STALLS, "max stalls", { allowZero: true, max: 100 }),
    stallCount: 0,
    completionPromise: input.completionPromise ? String(input.completionPromise).slice(0, 500) : null,
    iterationStartEntryCount: Math.max(0, Number(input.iterationStartEntryCount || 0)),
    iterationStartFingerprint: input.iterationStartFingerprint || null,
    iterationStartManagedWork: input.iterationStartManagedWork || null,
    backgroundWait: null,
    lastBackgroundWait: null,
    pendingContinuation: null,
    continuationEvents: [],
    lifecycleEvents: [],
    lastAssistantHash: null,
    lastSettledEntryId: null,
    outcomeSettlementEntryId: null,
    pauseReason: null,
    checkpoints: [],
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

function evaluateSettlement(state, observation = {}, options = {}) {
  if (!state || state.status !== "active") return { state, action: "noop", reason: "loop is not active" };
  if (!observation.assistantEntryId) return { state, action: "noop", reason: "no assistant message" };
  if (observation.assistantEntryId === state.lastSettledEntryId) return { state, action: "noop", reason: "settlement already processed" };
  const now = options.now || nowIso();
  const assistantHash = sha(normalizePromise(observation.assistantText));
  const progressChanged = Boolean(observation.progressFingerprint && observation.progressFingerprint !== state.iterationStartFingerprint);
  const repeated = Boolean(state.lastAssistantHash && state.lastAssistantHash === assistantHash);
  const stalled = repeated && !progressChanged;
  const stallCount = stalled ? Number(state.stallCount || 0) + 1 : 0;
  const record = {
    iteration: state.iteration,
    at: now,
    settlementBoundary: "agent_settled",
    assistantStopReason: normalizeAssistantStopReason(observation.assistantStopReason),
    assistantHash,
    progressChanged,
    toolCalls: Math.max(0, Number(observation.toolCalls || 0)),
    toolErrors: Math.max(0, Number(observation.toolErrors || 0)),
    tools: observation.tools || {},
    completionPromiseDetected: completionPromiseDetected(observation.assistantText, state.completionPromise),
    stalled,
  };
  let next = { ...state, lastAssistantHash: assistantHash, lastSettledEntryId: observation.assistantEntryId, stallCount, history: [...(state.history || []), record].slice(-MAX_HISTORY), updatedAt: now };
  if (record.completionPromiseDetected) {
    next = closePendingContinuation({ ...next, status: "completed", completedAt: now, completionMode: "promise", pauseReason: null }, now, "loop-completed");
    return { state: next, action: "completed", reason: "completion promise detected", record };
  }
  if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
    next = closePendingContinuation({ ...next, status: "max_iterations", completedAt: now, pauseReason: `maximum iterations reached (${state.maxIterations})` }, now, "maximum-iterations");
    return { state: next, action: "max_iterations", reason: next.pauseReason, record };
  }
  if (state.maxStalls > 0 && stallCount >= state.maxStalls) {
    next = closePendingContinuation({ ...next, status: "paused", pausedAt: now, pauseReason: `stalled for ${stallCount} identical no-progress iteration(s)` }, now, "automatic-stall-pause");
    return { state: next, action: "paused", reason: next.pauseReason, record };
  }
  next = {
    ...next,
    iteration: state.iteration + 1,
    iterationStartEntryCount: Math.max(0, Number(observation.nextEntryCount || 0)),
    iterationStartFingerprint: observation.progressFingerprint || null,
  };
  return { state: next, action: "continue", reason: progressChanged ? "workspace progress detected" : "iteration incomplete", record };
}

function summarizeLoop(state, { includePrompt = false } = {}) {
  if (!state) return null;
  const summary = {
    id: state.id,
    sessionId: state.sessionId,
    status: state.status,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    maxStalls: state.maxStalls,
    stallCount: state.stallCount,
    completionPromise: state.completionPromise,
    completionAction: completionGuidance(state),
    pauseReason: state.pauseReason,
    backgroundWait: state.backgroundWait || null,
    lastBackgroundWait: state.lastBackgroundWait || null,
    pendingContinuation: state.pendingContinuation ? {
      iteration: state.pendingContinuation.iteration,
      tokenHash: state.pendingContinuation.tokenHash || sha(state.pendingContinuation.token),
      queuedAt: state.pendingContinuation.queuedAt,
    } : null,
    recentContinuationEvents: (state.continuationEvents || []).slice(-10),
    recentLifecycleEvents: (state.lifecycleEvents || []).slice(-10),
    promptHash: state.promptHash,
    checkpoints: (state.checkpoints || []).slice(-10),
    recentHistory: (state.history || []).slice(-10),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
  };
  if (includePrompt) summary.prompt = state.prompt;
  return summary;
}

class AutomationLoopStore {
  constructor({ cwd = process.cwd(), root = path.join(cwd, ".pi", "automation-loop"), clock, allowUnbounded = false, maxPromptChars = MAX_PROMPT_CHARS } = {}) {
    this.cwd = cwd;
    this.root = root;
    this.clock = clock;
    this.allowUnbounded = allowUnbounded;
    this.maxPromptChars = maxPromptChars;
  }
  now() { return this.clock ? new Date(this.clock()).toISOString() : nowIso(); }
  file(id) { return path.join(this.root, "loops", `${id}.json`); }
  telemetryFile() { return path.join(this.root, "telemetry.jsonl"); }
  recordTelemetry(event = {}) {
    const row = sanitizeTelemetryEvent(event, this.now());
    appendJsonlPrivate(this.telemetryFile(), row);
    return row;
  }
  telemetry({ limit = 100 } = {}) { return readJsonl(this.telemetryFile()).slice(-Math.max(1, Math.min(1000, Number(limit) || 100))); }
  list() {
    let names = [];
    try { names = fs.readdirSync(path.join(this.root, "loops")).filter((name) => name.endsWith(".json")); } catch { return []; }
    return names.map((name) => readJson(path.join(this.root, "loops", name), null)).filter(Boolean).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  get(id) { return id ? readJson(this.file(id), null) : null; }
  current(sessionId) { return [...this.list()].reverse().find((state) => state.sessionId === String(sessionId) && OPEN_STATUSES.has(state.status)); }
  active(sessionId) { return [...this.list()].reverse().find((state) => state.sessionId === String(sessionId) && state.status === "active"); }
  recent(sessionId) { return [...this.list()].reverse().find((state) => !sessionId || state.sessionId === String(sessionId)); }
  create(input) {
    if (this.current(input.sessionId)) throw new Error("an automation loop is already active or paused in this session");
    const state = createLoopState(input, { now: this.now(), allowUnbounded: this.allowUnbounded, maxPromptChars: this.maxPromptChars });
    const saved = this.save(state);
    this.recordTelemetry({ kind: "start", operation: "start", outcome: "succeeded", eligible: true, source: input.startSource || "unknown", loopId: saved.id, iteration: saved.iteration, status: saved.status, completionMode: saved.completionPromise ? "promise" : "tool-evidence" });
    return saved;
  }
  save(state) {
    const previous = this.get(state.id);
    const next = {
      ...state,
      schemaVersion: SCHEMA_VERSION,
      pendingContinuation: state.pendingContinuation || null,
      continuationEvents: Array.isArray(state.continuationEvents) ? state.continuationEvents.slice(-MAX_HISTORY) : [],
      lifecycleEvents: Array.isArray(state.lifecycleEvents) ? state.lifecycleEvents.slice(-MAX_HISTORY) : [],
      updatedAt: this.now(),
    };
    atomicWrite(this.file(next.id), next);
    if (previous && previous.status !== next.status) {
      const terminal = FINAL_STATUSES.has(next.status);
      const outcome = next.status === "completed" ? "succeeded" : next.status === "cancelled" ? "cancelled" : next.status === "paused" ? "blocked" : next.status === "max_iterations" ? "timed-out" : next.status === "failed" ? "infrastructure-failed" : "succeeded";
      this.recordTelemetry({ kind: terminal ? "terminal" : "status-transition", operation: terminal ? "complete" : next.status, outcome, loopId: next.id, iteration: next.iteration, status: next.status, reasonCode: next.status === "paused" ? "loop-paused" : next.status === "max_iterations" ? "maximum-iterations" : next.status, completionMode: next.completionMode || (next.completionPromise ? "promise" : "tool-evidence") });
    }
    return next;
  }
  update(id, mutate) {
    const state = this.get(id);
    if (!state) throw new Error(`automation loop not found: ${id}`);
    return this.save(mutate({ ...state }));
  }
  queueContinuation(id, input = {}) {
    return this.update(id, (state) => {
      if (state.status !== "active") throw new Error(`cannot queue continuation for ${state.status} loop ${id}`);
      const iteration = Math.max(1, Number(input.iteration || 0));
      if (iteration !== state.iteration) throw new Error(`cannot queue stale iteration ${iteration}; current iteration is ${state.iteration}`);
      const token = String(input.token || "");
      if (!/^[a-f0-9]{16,64}$/.test(token)) throw new Error("continuation token must be 16-64 lowercase hex characters");
      if (state.pendingContinuation) throw new Error(`loop ${id} already has a pending continuation`);
      state.pendingContinuation = { iteration, token, tokenHash: sha(token), queuedAt: this.now() };
      return state;
    });
  }
  markContinuationDelivered(id, input = {}) {
    return this.update(id, (state) => {
      const delivery = input.delivery || {};
      const validation = validateLoopDelivery(state, delivery);
      if (!validation.ok) throw new Error(`cannot deliver loop continuation: ${validation.reason}`);
      const tokenHash = delivery.token ? sha(delivery.token) : `legacy-${delivery.iteration}`;
      state = appendContinuationEvent(state, { at: this.now(), iteration: delivery.iteration, tokenHash, queuedAt: state.pendingContinuation?.queuedAt || null, outcome: "delivered", reason: validation.reason });
      state.pendingContinuation = null;
      state.iterationStartEntryCount = Math.max(0, Number(input.iterationStartEntryCount || 0));
      state.iterationStartFingerprint = input.iterationStartFingerprint || null;
      state.iterationStartManagedWork = input.iterationStartManagedWork || null;
      return state;
    });
  }
  recordContinuationDrop(id, input = {}) {
    return this.update(id, (state) => {
      const tokenHash = input.token ? sha(input.token) : input.tokenHash || `legacy-${input.iteration || state.iteration}`;
      return appendContinuationEvent(state, { at: this.now(), iteration: input.iteration || state.iteration, tokenHash, outcome: "dropped", reason: input.reason || "stale-delivery" });
    });
  }
  dropPendingContinuation(id, reason = "pending-continuation-dropped") {
    return this.update(id, (state) => closePendingContinuation(state, this.now(), reason));
  }
  checkpoint(id, input = {}) {
    const saved = this.update(id, (state) => {
      if (FINAL_STATUSES.has(state.status)) throw new Error(`cannot checkpoint final loop ${id}`);
      const checkpoint = {
        at: this.now(),
        iteration: state.iteration,
        verdict: ["pass", "fail", "null", "partial", "note"].includes(input.verdict) ? input.verdict : "note",
        summary: safeText(input.summary || "loop checkpoint", 800),
        evidence: Array.from(new Set((Array.isArray(input.evidence) ? input.evidence : input.evidence ? [input.evidence] : []).map((item) => safeText(item, 300)).filter(Boolean))).slice(0, 20),
      };
      state.checkpoints = [...(state.checkpoints || []), checkpoint].slice(-MAX_HISTORY);
      return state;
    });
    this.recordTelemetry({ kind: "checkpoint", operation: "checkpoint", outcome: "succeeded", loopId: saved.id, iteration: saved.iteration, status: saved.status, verdict: saved.checkpoints.at(-1)?.verdict || "note" });
    return saved;
  }
  pause(id, reason = "paused") {
    return this.update(id, (state) => closePendingContinuation({ ...state, status: "paused", pauseReason: safeText(reason, 500), pausedAt: this.now() }, this.now(), "loop-paused"));
  }
  pauseForAssistantFailure(id, stopReason = "error") {
    return this.update(id, (state) => {
      const at = this.now();
      const normalized = ["error", "aborted"].includes(String(stopReason)) ? String(stopReason) : "error";
      const next = closePendingContinuation({
        ...state,
        status: "paused",
        pauseReason: `provider run settled with assistant stop reason ${normalized}; resume after provider recovery`,
        pausedAt: at,
        lifecycleEvents: [...(state.lifecycleEvents || []), { at, kind: "assistant-failure", settlementBoundary: "agent_settled", assistantStopReason: normalized }].slice(-MAX_HISTORY),
      }, at, "assistant-failure");
      return next;
    });
  }
  resume(id, input = {}) {
    return this.update(id, (state) => {
      if (state.status !== "paused") throw new Error(`loop ${id} is not paused`);
      return {
        ...state,
        status: "active",
        pauseReason: null,
        outcomeSettlementEntryId: null,
        backgroundWait: null,
        pendingContinuation: null,
        resumedAt: this.now(),
        iterationStartEntryCount: Math.max(0, Number(input.iterationStartEntryCount || 0)),
        iterationStartFingerprint: input.iterationStartFingerprint || null,
        iterationStartManagedWork: input.iterationStartManagedWork || null,
      };
    });
  }
  cancel(id, reason = "cancelled by user") {
    return this.update(id, (state) => closePendingContinuation({ ...state, status: "cancelled", pauseReason: safeText(reason, 500), completedAt: this.now() }, this.now(), "loop-cancelled"));
  }
  complete(id, input = {}) {
    return this.update(id, (state) => {
      if (state.completionPromise) throw new Error(`loop ${id} requires the exact completion promise; tool completion is disabled`);
      const evidence = (Array.isArray(input.evidence) ? input.evidence : []).map((item) => safeText(item, 300)).filter(Boolean);
      if (!evidence.length) throw new Error("loop completion requires at least one concrete evidence reference");
      return closePendingContinuation({ ...state, status: "completed", completedAt: this.now(), completionMode: "tool-evidence", completionSummary: safeText(input.summary || "completed with evidence", 800), completionEvidence: evidence.slice(0, 20), pauseReason: null }, this.now(), "loop-completed");
    });
  }
}

module.exports = {
  SCHEMA_VERSION,
  FINAL_STATUSES,
  OPEN_STATUSES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_STALLS,
  shellWords,
  parseLoopArgs,
  explicitAutomationIntent,
  completionPromiseDetected,
  latestAssistant,
  assistantSettlementDisposition,
  iterationActivity,
  createContinuationToken,
  waitForQueuedAgentStart,
  buildLoopPrompt,
  parseLoopDelivery,
  validateLoopDelivery,
  completionGuidance,
  createLoopState,
  evaluateSettlement,
  summarizeLoop,
  AutomationLoopStore,
  safeText,
};
