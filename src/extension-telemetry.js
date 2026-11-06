"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { inferOutcome, normalizeOutcome, OUTCOME_SCHEMA_VERSION } = require("./outcome-schema");
const { overlayReviews } = require("./extension-opportunity-reviews-store");

const TELEMETRY_SCHEMA_VERSION = 6;
const TELEMETRY_KINDS = new Set(["command", "model-tool", "prompt-suggestion", "context-injection", "auto-router", "recommendation", "opportunity", "feature-signal", "canary"]);
const PROMPT_ACTIONS = new Set(["generated", "refined", "skipped", "shown", "accepted", "dismissed", "retried", "timed-out", "failed"]);
const PROMPT_SOURCES = new Set(["local", "model", "hermes", "none"]);
const PROMPT_REASON_CODES = new Set(["other", "ready", "disabled", "privacy", "authentication", "authentication-proof-missing", "provider-model", "transport", "timeout", "cancelled", "missing-binary", "unavailable", "unexpected-response", "backoff-active", "invalid-suggestion", "invalid-config", "invalid-packet", "model-not-configured", "model-unavailable", "unknown"]);
const LEGACY_PROMPT_TELEMETRY_SCHEMAS = new Set([1]);
const LEGACY_PROMPT_OUTCOMES = new Set(["succeeded", "not-applicable", "cancelled", "timed-out", "infrastructure-failed", "unknown"]);
const ROUTER_STAGES = new Set(["suggested", "shown", "accepted", "dismissed", "overridden", "corrected", "executed", "rejected", "completed"]);
const RECOMMENDATION_SOURCES = new Set(["router", "skill"]);
const RECOMMENDATION_ACTIONS = new Set(["shown", "accepted", "dismissed", "overridden", "corrected"]);
const CONFIDENCE_BANDS = new Set(["high", "medium", "low", "unknown"]);
const SESSION_KINDS = new Set(["interactive", "headless-smoke", "deterministic-fixture", "unknown"]);
const OPPORTUNITY_ELIGIBILITY = new Set(["eligible", "ineligible", "unknown"]);
const OPPORTUNITY_VALUES = new Set(["helpful", "not-helpful", "unknown"]);
const CORE_DISPLACEMENT = new Set(["displaced", "shell-used", "not-applicable", "unknown"]);
const OPPORTUNITY_TRIGGER_EXTENSIONS = Object.freeze({
  "managed-long-run-monitor-intent": "run-monitor",
  "research-vault-intent": "obsidian",
  "semantic-edit-intent": "ast-tools",
  "workflow-plan-intent": "roadmap",
  "topology-admin-intent": "reasoning-runtime",
  "plan-fanout-intent": "reasoning-runtime",
  "codegraph-query-intent": "codegraph",
  "ci-pr-intent": "ci-pr-companion",
  "extension-ops-intent": "extension-ops-center",
  "performance-intent": "runtime-doctor",
  "security-scan-intent": "semgrep",
  "memory-governance-intent": "memory-explorer",
  "evidence-artifact-intent": "evidence-inbox",
});
const FIXED_OPPORTUNITY_TRIGGERS = new Set(Object.keys(OPPORTUNITY_TRIGGER_EXTENSIONS));
const FEATURE_ACTIONS = new Set(["observed", "compacted", "bypassed", "started", "matched", "settled", "timed-out", "stopped", "error", "settlement-notified"]);
const CANARY_STAGES = new Set(["planned", "passed", "failed", "not-applicable"]);
const SOURCE_FINGERPRINT_PATTERN = /^source_[a-f0-9]{16}$/;
const SESSION_TOKEN_PATTERN = /^session_[a-f0-9]{24}$/;
const EVENT_ID_PATTERN = /^ext_event_[a-f0-9]{16}$/;
const EVENT_ID_CACHE = new Map();
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function nowIso(clock) {
  const value = typeof clock === "function" ? clock() : new Date().toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
function hash(value, n = 16) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, n); }
function finiteNonnegative(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function safeIdentifier(value, fallback = "unknown", max = 100) {
  const text = String(value || "").trim();
  return text && text.length <= max && /^[A-Za-z0-9_.:+-]+$/.test(text) ? text : fallback;
}
function safeReason(value) { return safeIdentifier(value, "other", 80); }
function safeSourceFingerprint(value) { const text = String(value || "").trim(); return SOURCE_FINGERPRINT_PATTERN.test(text) ? text : "unavailable"; }
function sourceFingerprintForFile(file) {
  try { return `source_${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16)}`; }
  catch { return "unavailable"; }
}
function inferExtensionSourceFile(stack = new Error().stack) {
  for (const line of String(stack || "").split("\n")) {
    const match = line.match(/(?:file:\/\/)?(\/[^\s()]+[\/](?:\.pi[\/])?extensions[\/][^\/]+[\/]index\.[cm]?[jt]s)(?::\d+){0,2}/i);
    if (match?.[1]) return match[1];
  }
  return null;
}
function inferExtensionSourceFingerprint(stack = new Error().stack) { const file = inferExtensionSourceFile(stack); return file ? sourceFingerprintForFile(file) : "unavailable"; }
function bool(value) { return value === true; }
function coarseSessionKind(value) {
  const normalized = String(value || "unknown").trim().toLowerCase().replace(/_/g, "-");
  return SESSION_KINDS.has(normalized) ? normalized : "unknown";
}
function safeSessionToken(value) {
  const token = String(value || "none").trim();
  return SESSION_TOKEN_PATTERN.test(token) ? token : "none";
}
function telemetrySaltFile(cwd, stateDir) {
  return path.join(stateDir || path.join(cwd, ".pi", "extension-telemetry"), "session-token.key");
}
function telemetrySessionToken(value, { cwd = process.cwd(), stateDir } = {}) {
  const sessionId = String(value || "").trim();
  if (!sessionId) return "none";
  try {
    const file = telemetrySaltFile(path.resolve(cwd), stateDir);
    let key;
    try { key = fs.readFileSync(file); }
    catch {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
      key = crypto.randomBytes(32);
      try { fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" }); }
      catch { key = fs.readFileSync(file); }
    }
    try { fs.chmodSync(file, 0o600); } catch {}
    return `session_${crypto.createHmac("sha256", key).update(sessionId).digest("hex").slice(0, 24)}`;
  } catch { return "none"; }
}
function fixedStringValues(schema, out = new Set()) {
  if (!schema || typeof schema !== "object") return out;
  if (typeof schema.const === "string") out.add(schema.const);
  if (Array.isArray(schema.enum)) for (const value of schema.enum) if (typeof value === "string") out.add(value);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[key])) for (const child of schema[key]) fixedStringValues(child, out);
  return out;
}
function declaredToolOperation(definition, params, policy) {
  const raw = String(params?.operation || "").trim();
  if (!raw) return "default";
  const allowed = fixedStringValues(definition?.parameters?.properties?.operation);
  if (policy && typeof policy === "object") for (const key of Object.keys(policy)) if (key !== "default") allowed.add(key);
  return allowed.has(raw) ? raw : "other";
}
function contextSessionKind(ctx) {
  if (["rpc", "json", "print"].includes(ctx?.mode)) return "headless-smoke";
  if (ctx?.fixture === true || ctx?.metadata?.fixture === true) return "deterministic-fixture";
  if (ctx?.mode === "tui") return "interactive";
  const explicit = ctx?.sessionKind || ctx?.sessionType || ctx?.metadata?.sessionKind;
  if (explicit) return coarseSessionKind(explicit);
  if (ctx?.hasUI === true) return "interactive";
  if (ctx?.hasUI === false) return "headless-smoke";
  return "unknown";
}
function contextSessionId(ctx) {
  try { return String(ctx?.sessionManager?.getSessionId?.() || ""); }
  catch { return ""; }
}

function createTelemetryEvent(kind, input = {}, options = {}) {
  if (!TELEMETRY_KINDS.has(kind)) throw new Error(`unsupported extension telemetry kind: ${kind}`);
  const timestamp = nowIso(options.clock);
  const base = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    outcomeSchemaVersion: OUTCOME_SCHEMA_VERSION,
    timestamp,
    kind,
    extension: safeIdentifier(input.extension),
    version: safeIdentifier(input.version, "unknown", 120),
    sourceFingerprint: safeSourceFingerprint(input.sourceFingerprint),
  };
  let fields;
  if (kind === "command") {
    fields = {
      commandId: safeIdentifier(input.commandId),
      outcome: normalizeOutcome(input.outcome),
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
    };
  } else if (kind === "model-tool") {
    fields = {
      tool: safeIdentifier(input.tool),
      operation: safeIdentifier(input.operation, "default", 80),
      stage: "terminal",
      outcome: normalizeOutcome(input.outcome),
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
      durationMs: Math.round(finiteNonnegative(input.durationMs)),
    };
  } else if (kind === "prompt-suggestion") {
    fields = {
      source: PROMPT_SOURCES.has(input.source) ? input.source : "none",
      action: PROMPT_ACTIONS.has(input.action) ? input.action : "failed",
      outcome: normalizeOutcome(input.outcome),
      latencyMs: Math.round(finiteNonnegative(input.latencyMs)),
      reasonCode: PROMPT_REASON_CODES.has(input.reasonCode) ? input.reasonCode : "other",
    };
  } else if (kind === "context-injection") {
    const chars = Math.round(finiteNonnegative(input.chars));
    const renderedChars = Math.max(chars, Math.round(finiteNonnegative(input.renderedChars ?? chars)));
    const changed = bool(input.changed);
    fields = {
      chars,
      renderedChars,
      savedChars: Math.max(0, renderedChars - chars),
      reason: safeReason(input.reason),
      changed,
      // Injection health was previously unreadable because this kind carried no
      // outcome at all. Record the terminal state so a reader can separate a
      // delivered injection from one that had nothing to deliver.
      outcome: normalizeOutcome(input.outcome, changed && chars > 0 ? "succeeded" : "not-applicable"),
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
    };
  } else if (kind === "auto-router") {
    fields = {
      stage: ROUTER_STAGES.has(input.stage) ? input.stage : "rejected",
      route: safeIdentifier(input.route || input.topologyId, "unknown", 120),
      outcome: normalizeOutcome(input.outcome),
      outcomeLinkId: safeIdentifier(input.outcomeLinkId || input.routeId, "none", 120),
    };
  } else if (kind === "recommendation") {
    fields = {
      source: RECOMMENDATION_SOURCES.has(input.source) ? input.source : "router",
      action: RECOMMENDATION_ACTIONS.has(input.action) ? input.action : "corrected",
      candidate: safeIdentifier(input.candidate, "unknown", 120),
      confidenceBand: CONFIDENCE_BANDS.has(input.confidenceBand) ? input.confidenceBand : "unknown",
      outcome: normalizeOutcome(input.outcome),
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
    };
  } else if (kind === "opportunity") {
    const triggerId = OPPORTUNITY_TRIGGER_EXTENSIONS[input.triggerId] === base.extension ? input.triggerId : "unknown";
    const eligibility = triggerId !== "unknown" && OPPORTUNITY_ELIGIBILITY.has(input.eligibility) ? input.eligibility : "unknown";
    const acted = triggerId !== "unknown" && bool(input.acted);
    fields = {
      triggerId,
      eligibility,
      acted,
      // An offered opportunity that the operator did not take is a settled
      // non-event, not an unknown outcome.
      outcome: normalizeOutcome(input.outcome, eligibility === "eligible" ? (acted ? "succeeded" : "not-applicable") : "not-applicable"),
      value: triggerId !== "unknown" && OPPORTUNITY_VALUES.has(input.value) ? input.value : "unknown",
      coreDisplacement: triggerId !== "unknown" && CORE_DISPLACEMENT.has(input.coreDisplacement) ? input.coreDisplacement : "unknown",
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
    };
  } else if (kind === "canary") {
    fields = {
      canaryId: safeIdentifier(input.canaryId, "unknown", 120),
      tool: safeIdentifier(input.tool),
      operation: safeIdentifier(input.operation, "default", 80),
      stage: CANARY_STAGES.has(input.stage) ? input.stage : "planned",
      outcome: normalizeOutcome(input.outcome),
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
      durationMs: Math.round(finiteNonnegative(input.durationMs)),
    };
  } else {
    const inputChars = Math.round(finiteNonnegative(input.inputChars));
    const outputChars = Math.round(finiteNonnegative(input.outputChars));
    fields = {
      feature: safeIdentifier(input.feature, "unknown", 120),
      // A saving that cannot be attributed to the tool that produced the result
      // cannot be acted on, so the producing tool is part of the signal.
      tool: safeIdentifier(input.tool, "unattributed"),
      action: FEATURE_ACTIONS.has(input.action) ? input.action : "observed",
      reason: safeReason(input.reason),
      outcome: normalizeOutcome(input.outcome),
      sessionKind: coarseSessionKind(input.sessionKind),
      sessionToken: safeSessionToken(input.sessionToken),
      inputChars,
      outputChars,
      ...(input.feature === "tool-result-rendering" ? { modelChars: Math.round(finiteNonnegative(input.modelChars)), budgetTokens: Math.round(finiteNonnegative(input.budgetTokens)) } : {}),
      savedChars: Math.max(0, Math.round(finiteNonnegative(input.savedChars ?? (input.action === "compacted" ? inputChars - outputChars : 0)))),
      durationMs: Math.round(finiteNonnegative(input.durationMs)),
      sampleCount: Math.round(finiteNonnegative(input.sampleCount)),
    };
  }
  const event = { ...base, ...fields };
  // Fast sibling calls can finish with identical counts in the same millisecond.
  // Bind observer identities without persisting the runtime call identifier.
  event.eventId = `ext_event_${hash(kind === "feature-signal" && input.feature === "tool-result-rendering" ? { event, callId: input.toolCallId } : event)}`;
  return event;
}

function eventIdsInFile(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const cached = EVENT_ID_CACHE.get(file);
  if (cached?.size === size) return cached.ids;
  const ids = new Set();
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean)) {
      try { const id = JSON.parse(line)?.eventId; if (EVENT_ID_PATTERN.test(String(id || ""))) ids.add(id); } catch {}
    }
  } catch {}
  EVENT_ID_CACHE.set(file, { size, ids });
  return ids;
}
function withTelemetryLock(file, fn) {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 40; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
      try { return fn(); }
      finally { fs.closeSync(descriptor); try { fs.unlinkSync(lock); } catch {} }
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      if (error?.code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; } } catch {}
      Atomics.wait(LOCK_WAIT, 0, 0, 5);
    }
  }
  throw new Error("extension telemetry append lock timed out");
}
function appendPrivateJsonl(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return withTelemetryLock(file, () => {
    const id = String(value?.eventId || "");
    const ids = eventIdsInFile(file);
    if (EVENT_ID_PATTERN.test(id) && ids.has(id)) return false;
    const row = `${JSON.stringify(value)}\n`;
    fs.appendFileSync(file, row, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
    if (EVENT_ID_PATTERN.test(id)) ids.add(id);
    EVENT_ID_CACHE.set(file, { size: (() => { try { return fs.statSync(file).size; } catch { return 0; } })(), ids });
    return true;
  });
}

function telemetryFile(cwd, stateDir) { return path.join(stateDir || path.join(cwd, ".pi", "extension-telemetry"), "events.jsonl"); }

function createExtensionTelemetry({ cwd = process.cwd(), stateDir, clock, extension = "unknown", version = "unknown", sourceFingerprint = inferExtensionSourceFingerprint(), enabled = process.env.PI_EXTENSION_TELEMETRY !== "0" } = {}) {
  const file = telemetryFile(path.resolve(cwd), stateDir);
  const exactSourceFingerprint = safeSourceFingerprint(sourceFingerprint);
  const emit = (kind, input = {}) => {
    if (!enabled) return { ok: true, skipped: true, reason: "telemetry-disabled" };
    try {
      const event = createTelemetryEvent(kind, { ...input, extension, version, sourceFingerprint: exactSourceFingerprint }, { clock });
      const appended = appendPrivateJsonl(file, event);
      return appended ? { ok: true, event } : { ok: true, skipped: true, reason: "duplicate-event", event };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  };
  return {
    file,
    enabled: Boolean(enabled),
    emit,
    sessionToken(sessionId) { return telemetrySessionToken(sessionId, { cwd: path.resolve(cwd), stateDir }); },
    command(commandId, outcome = "succeeded", sessionKind = "unknown", sessionToken = "none") { return emit("command", { commandId, outcome, sessionKind, sessionToken }); },
    modelTool(tool, operation, outcome, sessionKind, durationMs = 0, sessionToken = "none") { return emit("model-tool", { tool, operation, outcome, sessionKind, durationMs, sessionToken }); },
    promptSuggestion(source, action, outcome = "unknown", latencyMs = 0, reasonCode = "other") { return emit("prompt-suggestion", { source, action, outcome, latencyMs, reasonCode }); },
    contextInjection(chars, reason, changed, renderedChars = chars, sessionKind = "unknown", sessionToken = "none") { return emit("context-injection", { chars, reason, changed, renderedChars, sessionKind, sessionToken }); },
    autoRouter(stage, route, outcome = "unknown", outcomeLinkId = "none") { return emit("auto-router", { stage, route, outcome, outcomeLinkId }); },
    recommendation(source, action, candidate, confidenceBand = "unknown", outcome = "unknown", sessionKind = "unknown", sessionToken = "none") { return emit("recommendation", { source, action, candidate, confidenceBand, outcome, sessionKind, sessionToken }); },
    opportunity(triggerId, eligibility, acted = false, value = "unknown", coreDisplacement = "unknown", sessionKind = "unknown", sessionToken = "none") { return emit("opportunity", { triggerId, eligibility, acted, value, coreDisplacement, sessionKind, sessionToken }); },
    featureSignal(feature, action, input = {}) { return emit("feature-signal", { feature, action, ...input }); },
    canary(canaryId, tool, operation, stage = "planned", outcome = "unknown", durationMs = 0, sessionKind = "unknown", sessionToken = "none") { return emit("canary", { canaryId, tool, operation, stage, outcome, durationMs, sessionKind, sessionToken }); },
  };
}

function readTelemetryEvents({ cwd = process.cwd(), stateDir, file, sinceAt, untilAt, excludeSessionToken } = {}) {
  const target = file || telemetryFile(path.resolve(cwd), stateDir);
  const sinceMs = sinceAt == null ? -Infinity : new Date(sinceAt).getTime();
  const untilMs = untilAt == null ? Infinity : new Date(untilAt).getTime();
  const excluded = safeSessionToken(excludeSessionToken);
  const raw = [];
  let excludedEventCount = 0;
  try {
    for (const line of fs.readFileSync(target, "utf8").split(/\n+/).filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        const at = Date.parse(String(event?.timestamp || ""));
        const inCohort = event?.schemaVersion === TELEMETRY_SCHEMA_VERSION && TELEMETRY_KINDS.has(event.kind) && Number.isFinite(at) && at >= sinceMs && at <= untilMs;
        if (!inCohort) continue;
        if (excluded !== "none" && event.sessionToken === excluded) { excludedEventCount++; continue; }
        raw.push(event);
      } catch {}
    }
  } catch {}
  const seen = new Set();
  const duplicateIds = new Set();
  const unique = raw.filter((event) => {
    const id = String(event?.eventId || "");
    if (!EVENT_ID_PATTERN.test(id)) return true;
    if (seen.has(id)) { duplicateIds.add(id); return false; }
    seen.add(id);
    return true;
  }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.eventId).localeCompare(String(b.eventId)));
  Object.defineProperty(unique, "telemetryIntegrity", { enumerable: false, value: {
    rawEventCount: raw.length,
    uniqueEventCount: unique.length,
    duplicateEventCount: raw.length - unique.length,
    duplicateEventIdGroups: duplicateIds.size,
    exclusionRequested: excluded !== "none",
    excludedEventCount,
  } });
  return unique;
}

// Prompt-suggestion policy continuity is narrower than general telemetry
// compatibility. Schema-v1 prompt rows already used the same fixed,
// metadata-only source/action/outcome fields, so validated rows can continue
// the evidence cohort without reinterpreting legacy command/tool failures.
function promptPolicyTelemetryRow(event) {
  return {
    schemaVersion: event.schemaVersion,
    timestamp: String(event.timestamp),
    kind: "prompt-suggestion",
    extension: "prompt-suggestions",
    version: safeIdentifier(event.version, "unknown", 120),
    sourceFingerprint: safeSourceFingerprint(event.sourceFingerprint),
    source: event.source,
    action: event.action,
    outcome: event.outcome,
    latencyMs: Math.round(finiteNonnegative(event.latencyMs)),
    reasonCode: PROMPT_REASON_CODES.has(event.reasonCode) ? event.reasonCode : "other",
    eventId: safeIdentifier(event.eventId, "unknown", 120),
  };
}
function readPromptSuggestionTelemetryEvents({ cwd = process.cwd(), stateDir, file, sinceAt, untilAt } = {}) {
  const target = file || telemetryFile(path.resolve(cwd), stateDir);
  const sinceMs = sinceAt == null ? -Infinity : new Date(sinceAt).getTime();
  const untilMs = untilAt == null ? Infinity : new Date(untilAt).getTime();
  try {
    const rows = fs.readFileSync(target, "utf8").split(/\n+/).filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line);
        const at = Date.parse(String(event?.timestamp || ""));
        if (!Number.isFinite(at) || at < sinceMs || at > untilMs || event?.kind !== "prompt-suggestion" || event?.extension !== "prompt-suggestions") return [];
        if (event.schemaVersion === TELEMETRY_SCHEMA_VERSION) return PROMPT_SOURCES.has(event.source) && PROMPT_ACTIONS.has(event.action) ? [promptPolicyTelemetryRow(event)] : [];
        const compatible = LEGACY_PROMPT_TELEMETRY_SCHEMAS.has(event.schemaVersion)
          && PROMPT_SOURCES.has(event.source)
          && PROMPT_ACTIONS.has(event.action)
          && LEGACY_PROMPT_OUTCOMES.has(event.outcome);
        return compatible ? [promptPolicyTelemetryRow(event)] : [];
      } catch { return []; }
    }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.eventId).localeCompare(String(b.eventId)));
    const seen = new Set();
    return rows.filter((row) => { const id = String(row.eventId || ""); if (!id || id === "unknown") return true; if (seen.has(id)) return false; seen.add(id); return true; });
  } catch { return []; }
}

function increment(map, key, amount = 1) { map.set(key, (map.get(key) || 0) + amount); }
function countRows(map, fields) {
  return Array.from(map.entries()).map(([key, count]) => {
    const values = JSON.parse(key);
    return { ...Object.fromEntries(fields.map((field, index) => [field, values[index]])), count };
  }).sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function summarizeExtensionTelemetry(events = [], options = {}) {
  const byKind = new Map(); const outcomes = new Map(); const commands = new Map(); const modelTools = new Map(); const modelToolOutcomes = new Map(); const modelToolSessionKinds = new Map(); const prompts = new Map(); const routers = new Map(); const injections = new Map(); const injectionBreakdown = new Map(); const recommendations = new Map(); const opportunities = new Map(); const featureSignals = new Map(); const canaries = new Map(); const cohorts = new Map();
  const interactiveSessions = new Map(); const extensionInteractiveSessions = new Map(); const extensionInteractiveActions = new Map(); const interactiveDays = new Set();
  let interactiveEvents = 0; let tokenizedInteractiveEvents = 0;
  let featureInputChars = 0; let featureOutputChars = 0; let featureSavedChars = 0; let featureDurationMs = 0; let featureEventCount = 0; let featureSampleCount = 0;
  let injectionChars = 0; let renderedInjectionChars = 0; let savedInjectionChars = 0; let changedInjections = 0; let interactiveInjectionCount = 0; let interactiveInjectionChars = 0; let eligibleModelToolOutcomes = 0; let unknownModelToolOutcomes = 0; let recommendationAccepted = 0; let recommendationDismissed = 0; let recommendationOverridden = 0; let recommendationCorrected = 0; let recommendationShown = 0; let eligibleOpportunities = 0; let actedOpportunities = 0; let valuedOpportunities = 0; let helpfulOpportunities = 0; let displacedCore = 0; let shellUsed = 0;
  for (const event of events) {
    increment(byKind, event.kind);
    const cohortKey = JSON.stringify([event.extension, event.version || "unknown", safeSourceFingerprint(event.sourceFingerprint)]);
    const cohort = cohorts.get(cohortKey) || { eventCount: 0, firstAt: event.timestamp, lastAt: event.timestamp, commands: 0, modelTools: 0, canaries: 0, outcomes: new Map(), operations: new Map() };
    cohort.eventCount++;
    cohort.firstAt = String(event.timestamp) < String(cohort.firstAt) ? event.timestamp : cohort.firstAt;
    cohort.lastAt = String(event.timestamp) > String(cohort.lastAt) ? event.timestamp : cohort.lastAt;
    if (event.kind === "command") cohort.commands++;
    if (event.kind === "model-tool") { cohort.modelTools++; increment(cohort.operations, JSON.stringify([event.tool, event.operation, event.outcome])); }
    if (event.kind === "canary") cohort.canaries++;
    if (event.outcome) increment(cohort.outcomes, event.outcome);
    cohorts.set(cohortKey, cohort);
    if (event.outcome) increment(outcomes, event.outcome);
    if (event.sessionKind === "interactive") {
      interactiveEvents++;
      increment(extensionInteractiveActions, event.extension);
      const day = String(event.timestamp || "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) interactiveDays.add(day);
      if (safeSessionToken(event.sessionToken) !== "none") {
        tokenizedInteractiveEvents++;
        const token = event.sessionToken;
        const current = interactiveSessions.get(token) || { firstAt: event.timestamp, lastAt: event.timestamp, events: 0 };
        current.firstAt = String(event.timestamp) < String(current.firstAt) ? event.timestamp : current.firstAt;
        current.lastAt = String(event.timestamp) > String(current.lastAt) ? event.timestamp : current.lastAt;
        current.events++;
        interactiveSessions.set(token, current);
        if (!extensionInteractiveSessions.has(event.extension)) extensionInteractiveSessions.set(event.extension, new Set());
        extensionInteractiveSessions.get(event.extension).add(token);
      }
    }
    if (event.kind === "command") increment(commands, JSON.stringify([event.extension, event.commandId, event.outcome, event.sessionKind]));
    if (event.kind === "model-tool") {
      increment(modelTools, JSON.stringify([event.extension, event.tool, event.operation, event.outcome, event.sessionKind]));
      increment(modelToolOutcomes, event.outcome || "unknown");
      increment(modelToolSessionKinds, event.sessionKind || "unknown");
      eligibleModelToolOutcomes++;
      if (event.outcome === "unknown") unknownModelToolOutcomes++;
    }
    if (event.kind === "prompt-suggestion") increment(prompts, JSON.stringify([event.extension, event.source, event.action, event.outcome, PROMPT_REASON_CODES.has(event.reasonCode) ? event.reasonCode : "other"]));
    if (event.kind === "auto-router") increment(routers, JSON.stringify([event.extension, event.stage, event.route, event.outcome]));
    if (event.kind === "recommendation") {
      increment(recommendations, JSON.stringify([event.extension, event.source, event.action, event.candidate, event.confidenceBand, event.outcome, event.sessionKind]));
      if (event.action === "shown") recommendationShown++;
      if (event.action === "accepted") recommendationAccepted++;
      if (event.action === "dismissed") recommendationDismissed++;
      if (event.action === "overridden") recommendationOverridden++;
      if (event.action === "corrected") recommendationCorrected++;
    }
    if (event.kind === "opportunity") {
      increment(opportunities, JSON.stringify([event.extension, event.triggerId, event.eligibility, event.acted, event.value, event.coreDisplacement, event.sessionKind, event.version, event.sourceFingerprint, event.reviewed === true]));
      if (event.sessionKind === "interactive" && event.eligibility === "eligible") { eligibleOpportunities++; if (event.acted) actedOpportunities++; }
      if (event.sessionKind === "interactive" && ["helpful", "not-helpful"].includes(event.value)) { valuedOpportunities++; if (event.value === "helpful") helpfulOpportunities++; }
      if (event.sessionKind === "interactive" && event.coreDisplacement === "displaced") displacedCore++;
      if (event.sessionKind === "interactive" && event.coreDisplacement === "shell-used") shellUsed++;
    }
    if (event.kind === "canary") increment(canaries, JSON.stringify([event.extension, event.sourceFingerprint, event.canaryId, event.tool, event.operation, event.stage, event.outcome, event.sessionKind]));
    if (event.kind === "feature-signal") {
      const key = JSON.stringify([event.extension, event.feature, event.action, event.reason, event.outcome, event.sessionKind, event.tool || "unattributed", event.budgetTokens || 0]);
      const stats = featureSignals.get(key) || { count: 0, inputChars: 0, modelChars: 0, outputChars: 0, savedChars: 0, durationMs: 0, sampleCount: 0 };
      stats.count++;
      stats.inputChars += finiteNonnegative(event.inputChars);
      stats.modelChars += finiteNonnegative(event.modelChars);
      stats.outputChars += finiteNonnegative(event.outputChars);
      stats.savedChars += finiteNonnegative(event.savedChars);
      stats.durationMs += finiteNonnegative(event.durationMs);
      stats.sampleCount += finiteNonnegative(event.sampleCount);
      featureSignals.set(key, stats);
      featureInputChars += finiteNonnegative(event.inputChars);
      featureOutputChars += finiteNonnegative(event.outputChars);
      featureSavedChars += finiteNonnegative(event.savedChars);
      featureDurationMs += finiteNonnegative(event.durationMs);
      featureSampleCount += finiteNonnegative(event.sampleCount);
      featureEventCount++;
    }
    if (event.kind === "context-injection") {
      increment(injections, JSON.stringify([event.extension, event.reason, event.changed, event.sessionKind || "unknown"]));
      const chars = finiteNonnegative(event.chars);
      const renderedChars = Math.max(chars, finiteNonnegative(event.renderedChars ?? chars));
      const savedChars = Math.max(0, finiteNonnegative(event.savedChars ?? (renderedChars - chars)));
      injectionChars += chars;
      renderedInjectionChars += renderedChars;
      savedInjectionChars += savedChars;
      if (event.changed) changedInjections++;
      if (event.sessionKind === "interactive") { interactiveInjectionCount++; interactiveInjectionChars += chars; }
      const key = JSON.stringify([event.extension, event.reason, event.sessionKind || "unknown"]);
      const stats = injectionBreakdown.get(key) || { count: 0, chars: 0, renderedChars: 0, savedChars: 0 };
      stats.count++; stats.chars += chars; stats.renderedChars += renderedChars; stats.savedChars += savedChars;
      injectionBreakdown.set(key, stats);
    }
  }
  const firstInteractiveAt = Array.from(interactiveSessions.values()).map((row) => row.firstAt).sort()[0] || null;
  const lastInteractiveAt = Array.from(interactiveSessions.values()).map((row) => row.lastAt).sort().at(-1) || null;
  const tokenCoverage = interactiveEvents ? Number((tokenizedInteractiveEvents / interactiveEvents).toFixed(4)) : 0;
  const integrity = events.telemetryIntegrity || { rawEventCount: events.length, uniqueEventCount: events.length, duplicateEventCount: 0, duplicateEventIdGroups: 0, exclusionRequested: safeSessionToken(options.excludeSessionToken) !== "none", excludedEventCount: 0 };
  const currentSessionExcluded = integrity.exclusionRequested === true;
  const featureSignalRows = Array.from(featureSignals.entries()).map(([key, stats]) => {
    const [extension, feature, action, reason, outcome, sessionKind, tool, budgetTokens] = JSON.parse(key);
    return { extension, feature, tool, action, reason, outcome, sessionKind, budgetTokens, ...stats, averageDurationMs: stats.count ? Number((stats.durationMs / stats.count).toFixed(2)) : 0 };
  }).sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const versionCohorts = Array.from(cohorts.entries()).map(([key, stats]) => {
    const [extension, version, sourceFingerprint] = JSON.parse(key);
    const outcomeRows = countRows(new Map(Array.from(stats.outcomes, ([name, count]) => [JSON.stringify([name]), count])), ["outcome"]);
    const terminal = outcomeRows.reduce((sum, row) => sum + row.count, 0);
    const negative = outcomeRows.filter((row) => !["succeeded", "not-applicable", "unknown"].includes(row.outcome)).reduce((sum, row) => sum + row.count, 0);
    return { extension, version, sourceFingerprint, eventCount: stats.eventCount, firstAt: stats.firstAt, lastAt: stats.lastAt, commands: stats.commands, modelTools: stats.modelTools, canaries: stats.canaries, outcomes: outcomeRows, operations: countRows(stats.operations, ["tool", "operation", "outcome"]), negativeRate: terminal ? Number((negative / terminal).toFixed(4)) : null };
  }).sort((a, b) => a.extension.localeCompare(b.extension) || String(a.firstAt).localeCompare(String(b.firstAt)) || a.sourceFingerprint.localeCompare(b.sourceFingerprint));
  const sourceTransitions = [];
  for (const extension of Array.from(new Set(versionCohorts.map((row) => row.extension))).sort()) {
    const rows = versionCohorts.filter((row) => row.extension === extension && row.sourceFingerprint !== "unavailable").sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)) || a.sourceFingerprint.localeCompare(b.sourceFingerprint));
    const distinctRows = rows.filter((row, index) => index === 0 || row.sourceFingerprint !== rows[index - 1].sourceFingerprint);
    for (let index = 1; index < distinctRows.length; index++) sourceTransitions.push({ extension, before: distinctRows[index - 1], after: distinctRows[index], eventDelta: distinctRows[index].eventCount - distinctRows[index - 1].eventCount, negativeRateDelta: distinctRows[index].negativeRate == null || distinctRows[index - 1].negativeRate == null ? null : Number((distinctRows[index].negativeRate - distinctRows[index - 1].negativeRate).toFixed(4)) });
  }
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventCount: events.length,
    rawEventCount: integrity.rawEventCount,
    uniqueEventCount: integrity.uniqueEventCount,
    duplicateEventCount: integrity.duplicateEventCount,
    duplicateEventIdGroups: integrity.duplicateEventIdGroups,
    firstAt: events[0]?.timestamp || null,
    lastAt: events.at(-1)?.timestamp || null,
    byKind: countRows(new Map(Array.from(byKind, ([key, value]) => [JSON.stringify([key]), value])), ["kind"]),
    outcomes: countRows(new Map(Array.from(outcomes, ([key, value]) => [JSON.stringify([key]), value])), ["outcome"]),
    commands: countRows(commands, ["extension", "commandId", "outcome", "sessionKind"]),
    versionCohorts,
    sourceTransitions,
    interactiveCohort: {
      sessions: interactiveSessions.size,
      observedDays: interactiveDays.size,
      firstAt: firstInteractiveAt,
      lastAt: lastInteractiveAt,
      interactiveEvents,
      tokenizedInteractiveEvents,
      tokenCoverage,
      currentSessionExcluded,
      excludedEvents: integrity.excludedEventCount,
      gatingSafe: currentSessionExcluded && interactiveDays.size >= 30 && tokenCoverage >= 0.95,
      rows: Array.from(extensionInteractiveSessions.entries()).map(([extension, tokens]) => ({ extension, sessions: tokens.size, actions: extensionInteractiveActions.get(extension) || 0 })).sort((a, b) => b.sessions - a.sessions || a.extension.localeCompare(b.extension)),
    },
    modelTools: {
      eligible: eligibleModelToolOutcomes,
      unknown: unknownModelToolOutcomes,
      unknownRate: eligibleModelToolOutcomes ? Number((unknownModelToolOutcomes / eligibleModelToolOutcomes).toFixed(4)) : 0,
      outcomes: countRows(new Map(Array.from(modelToolOutcomes, ([key, value]) => [JSON.stringify([key]), value])), ["outcome"]),
      sessionKinds: countRows(new Map(Array.from(modelToolSessionKinds, ([key, value]) => [JSON.stringify([key]), value])), ["sessionKind"]),
      rows: countRows(modelTools, ["extension", "tool", "operation", "outcome", "sessionKind"]),
    },
    promptSuggestions: countRows(prompts, ["extension", "source", "action", "outcome", "reasonCode"]),
    contextInjections: { count: Array.from(injections.values()).reduce((sum, value) => sum + value, 0), chars: injectionChars, renderedChars: renderedInjectionChars, savedChars: savedInjectionChars, reductionPct: renderedInjectionChars > 0 ? Number(((savedInjectionChars / renderedInjectionChars) * 100).toFixed(2)) : 0, averageChars: Array.from(injections.values()).reduce((sum, value) => sum + value, 0) > 0 ? Number((injectionChars / Array.from(injections.values()).reduce((sum, value) => sum + value, 0)).toFixed(2)) : 0, changed: changedInjections, interactive: { count: interactiveInjectionCount, chars: interactiveInjectionChars, averageChars: interactiveInjectionCount ? Number((interactiveInjectionChars / interactiveInjectionCount).toFixed(2)) : 0 }, rows: countRows(injections, ["extension", "reason", "changed", "sessionKind"]), breakdown: Array.from(injectionBreakdown.entries()).map(([key, stats]) => { const [extension, reason, sessionKind] = JSON.parse(key); return { extension, reason, sessionKind, ...stats }; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) },
    autoRouter: countRows(routers, ["extension", "stage", "route", "outcome"]),
    recommendations: { shown: recommendationShown, reviewed: recommendationAccepted + recommendationOverridden + recommendationCorrected, accepted: recommendationAccepted, dismissed: recommendationDismissed, overridden: recommendationOverridden, corrected: recommendationCorrected, precision: recommendationAccepted + recommendationOverridden + recommendationCorrected ? Number((recommendationAccepted / (recommendationAccepted + recommendationOverridden + recommendationCorrected)).toFixed(4)) : null, correctionRate: recommendationAccepted + recommendationOverridden + recommendationCorrected ? Number(((recommendationOverridden + recommendationCorrected) / (recommendationAccepted + recommendationOverridden + recommendationCorrected)).toFixed(4)) : null, rows: countRows(recommendations, ["extension", "source", "action", "candidate", "confidenceBand", "outcome", "sessionKind"]) },
    opportunities: { eligible: eligibleOpportunities, acted: actedOpportunities, actionRate: eligibleOpportunities ? Number((actedOpportunities / eligibleOpportunities).toFixed(4)) : null, valued: valuedOpportunities, helpful: helpfulOpportunities, valueRate: valuedOpportunities ? Number((helpfulOpportunities / valuedOpportunities).toFixed(4)) : null, coreDisplacement: { displaced: displacedCore, shellUsed, displacementRate: displacedCore + shellUsed ? Number((displacedCore / (displacedCore + shellUsed)).toFixed(4)) : null }, rows: countRows(opportunities, ["extension", "triggerId", "eligibility", "acted", "value", "coreDisplacement", "sessionKind", "version", "sourceFingerprint", "reviewed"]) },
    canaries: { count: Array.from(canaries.values()).reduce((sum, value) => sum + value, 0), rows: countRows(canaries, ["extension", "sourceFingerprint", "canaryId", "tool", "operation", "stage", "outcome", "sessionKind"]) },
    featureSignals: {
      inputChars: featureInputChars,
      outputChars: featureOutputChars,
      savedChars: featureSavedChars,
      reductionPct: featureInputChars ? Number(((featureSavedChars / featureInputChars) * 100).toFixed(2)) : 0,
      durationMs: featureDurationMs,
      averageDurationMs: featureEventCount ? Number((featureDurationMs / featureEventCount).toFixed(2)) : 0,
      sampleCount: featureSampleCount,
      rows: featureSignalRows,
    },
    privacy: { metadataOnly: true, containsArguments: false, containsPrompts: false, containsPaths: false, containsOutputs: false, sessionIdentifiers: "HMAC-SHA256 local-salt tokens" },
  };
}
function readExtensionTelemetry(options = {}) {
  const events = overlayReviews(readTelemetryEvents(options), options.cwd || process.cwd());
  return summarizeExtensionTelemetry(events, options);
}
function aggregateSourceCohort(rows, sourceFingerprint) {
  const matching = rows.filter((row) => row.sourceFingerprint === sourceFingerprint);
  if (!matching.length) return null;
  const outcomes = new Map();
  const operations = new Map();
  for (const row of matching) {
    for (const outcome of row.outcomes || []) outcomes.set(outcome.outcome, (outcomes.get(outcome.outcome) || 0) + outcome.count);
    for (const operation of row.operations || []) {
      const key = `${operation.tool}\u0000${operation.operation}\u0000${operation.outcome}`;
      operations.set(key, (operations.get(key) || 0) + operation.count);
    }
  }
  const eventCount = matching.reduce((total, row) => total + row.eventCount, 0);
  const terminal = Array.from(outcomes.entries()).filter(([outcome]) => outcome !== "unknown").reduce((total, [, count]) => total + count, 0);
  const negative = Array.from(outcomes.entries()).filter(([outcome]) => !["succeeded", "not-applicable", "unknown"].includes(outcome)).reduce((total, [, count]) => total + count, 0);
  const versions = [...new Set(matching.map((row) => row.version))].sort();
  return {
    extension: matching[0].extension,
    version: versions.length === 1 ? versions[0] : "multiple",
    versions,
    sourceFingerprint,
    eventCount,
    firstAt: matching.map((row) => row.firstAt).sort()[0],
    lastAt: matching.map((row) => row.lastAt).sort().at(-1),
    commands: matching.reduce((total, row) => total + row.commands, 0),
    modelTools: matching.reduce((total, row) => total + row.modelTools, 0),
    canaries: matching.reduce((total, row) => total + row.canaries, 0),
    outcomes: Array.from(outcomes.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([outcome, count]) => ({ outcome, count })),
    operations: Array.from(operations.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => { const [tool, operation, outcome] = key.split("\u0000"); return { tool, operation, outcome, count }; }),
    negativeRate: terminal ? Number((negative / terminal).toFixed(4)) : null,
  };
}

function compareExtensionCohorts(summary = {}, input = {}) {
  const extension = safeIdentifier(input.extension);
  const rows = (summary.versionCohorts || []).filter((row) => row.extension === extension && row.sourceFingerprint !== "unavailable").sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)) || a.sourceFingerprint.localeCompare(b.sourceFingerprint));
  const availableFingerprints = [...new Set(rows.map((row) => row.sourceFingerprint))];
  const beforeFingerprint = safeSourceFingerprint(input.beforeFingerprint || rows.find((row) => input.beforeVersion && row.version === input.beforeVersion)?.sourceFingerprint || availableFingerprints.at(-2));
  const afterFingerprint = safeSourceFingerprint(input.afterFingerprint || rows.find((row) => input.afterVersion && row.version === input.afterVersion)?.sourceFingerprint || availableFingerprints.at(-1));
  const before = aggregateSourceCohort(rows, beforeFingerprint);
  const after = aggregateSourceCohort(rows, afterFingerprint);
  if (!before || !after || before.sourceFingerprint === after.sourceFingerprint) return { outcome: "not-applicable", extension, reason: "Two distinct exact source cohorts are required for comparison.", available: rows.map(({ version, sourceFingerprint, firstAt, lastAt, eventCount }) => ({ version, sourceFingerprint, firstAt, lastAt, eventCount })) };
  const operationKeys = new Set([...(before.operations || []).map((row) => `${row.tool}\u0000${row.operation}`), ...(after.operations || []).map((row) => `${row.tool}\u0000${row.operation}`)]);
  const operations = Array.from(operationKeys).sort().map((key) => {
    const [tool, operation] = key.split("\u0000");
    const aggregate = (cohort) => (cohort.operations || []).filter((row) => row.tool === tool && row.operation === operation).reduce((acc, row) => { acc.count += row.count; if (!["succeeded", "not-applicable", "unknown"].includes(row.outcome)) acc.negative += row.count; return acc; }, { count: 0, negative: 0 });
    const left = aggregate(before); const right = aggregate(after);
    return { tool, operation, beforeCount: left.count, afterCount: right.count, countDelta: right.count - left.count, beforeNegativeRate: left.count ? Number((left.negative / left.count).toFixed(4)) : null, afterNegativeRate: right.count ? Number((right.negative / right.count).toFixed(4)) : null };
  });
  return { outcome: "succeeded", extension, before, after, eventDelta: after.eventCount - before.eventCount, negativeRateDelta: before.negativeRate == null || after.negativeRate == null ? null : Number((after.negativeRate - before.negativeRate).toFixed(4)), operations };
}

function inferExtensionId(stack = new Error().stack) {
  for (const line of String(stack || "").split("\n")) {
    const match = line.match(/[\\/](?:\.pi[\\/])?extensions[\\/]([^\\/]+)[\\/](?:index\.)?[cm]?[jt]s(?::\d+)?/i);
    if (match) return safeIdentifier(match[1]);
  }
  return "unknown";
}

function instrumentExtensionCommands(pi, metadata = {}) {
  const extension = safeIdentifier(metadata.extension || inferExtensionId());
  const version = safeIdentifier(metadata.version || "extension-telemetry-v3", "extension-telemetry-v3", 120);
  const sourceFingerprint = safeSourceFingerprint(metadata.sourceFingerprint || inferExtensionSourceFingerprint());
  const outcomePolicies = metadata.outcomePolicies && typeof metadata.outcomePolicies === "object" ? metadata.outcomePolicies : {};
  const recorders = new Map();
  const recorderFor = (ctx) => {
    const cwd = path.resolve(ctx?.cwd || process.cwd());
    if (!recorders.has(cwd)) recorders.set(cwd, createExtensionTelemetry({ cwd, extension, version, sourceFingerprint }));
    return recorders.get(cwd);
  };
  const sessionMetadata = (ctx) => {
    const recorder = recorderFor(ctx);
    return { recorder, kind: contextSessionKind(ctx), token: recorder.sessionToken(contextSessionId(ctx)) };
  };
  const registerCommand = typeof pi.registerCommand === "function" ? pi.registerCommand.bind(pi) : null;
  const registerTool = typeof pi.registerTool === "function" ? pi.registerTool.bind(pi) : null;
  const declaredOutcome = (tool, operation) => {
    const policy = outcomePolicies[tool];
    if (!policy) return undefined;
    if (typeof policy === "string") return policy;
    return policy[operation] || policy.default;
  };
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerCommand" && registerCommand) return (name, options = {}) => registerCommand(name, {
        ...options,
        async handler(args, ctx) {
          try {
            const result = await options.handler(args, ctx);
            const inferred = inferOutcome(result?.details || result, { isError: false });
            const session = sessionMetadata(ctx);
            session.recorder.command(name, inferred === "unknown" ? "succeeded" : inferred, session.kind, session.token);
            return result;
          } catch (error) {
            const session = sessionMetadata(ctx);
            session.recorder.command(name, "infrastructure-failed", session.kind, session.token);
            throw error;
          }
        },
      });
      if (property === "registerTool" && registerTool) return (definition = {}) => registerTool({
        ...definition,
        async execute(id, params = {}, signal, update, ctx) {
          const startedAt = Date.now();
          const policy = outcomePolicies[definition.name];
          const operation = declaredToolOperation(definition, params, policy);
          try {
            let result = await definition.execute(id, params, signal, update, ctx);
            if (definition.outputSchema) result = require("./tool-result-contracts").structuredToolResult(definition.outputSchema, result);
            const details = result?.details || result;
            const inferred = inferOutcome(details, {
              isError: result?.isError === true,
              toolName: definition.name,
              operation,
              expectedNegative: declaredOutcome(definition.name, operation),
            });
            const session = sessionMetadata(ctx);
            session.recorder.modelTool(definition.name, operation, inferred === "unknown" ? "succeeded" : inferred, session.kind, Date.now() - startedAt, session.token);
            return result;
          } catch (error) {
            const message = String(error?.message || error).toLowerCase();
            const outcome = signal?.aborted || /abort|cancel/.test(message) ? "cancelled" : /timed?\s*out|timeout/.test(message) ? "timed-out" : "infrastructure-failed";
            const session = sessionMetadata(ctx);
            session.recorder.modelTool(definition.name, operation, outcome, session.kind, Date.now() - startedAt, session.token);
            throw error;
          }
        },
      });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  FIXED_OPPORTUNITY_TRIGGERS,
  OPPORTUNITY_TRIGGER_EXTENSIONS,
  createTelemetryEvent,
  createExtensionTelemetry,
  readTelemetryEvents,
  readPromptSuggestionTelemetryEvents,
  summarizeExtensionTelemetry,
  readExtensionTelemetry,
  compareExtensionCohorts,
  instrumentExtensionCommands,
  inferExtensionId,
  inferExtensionSourceFile,
  inferExtensionSourceFingerprint,
  sourceFingerprintForFile,
  safeIdentifier,
  contextSessionKind,
  telemetrySessionToken,
};
