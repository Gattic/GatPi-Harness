import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type EditorOptions, type EditorTheme, type KeyId, type TUI } from "@earendil-works/pi-tui";

type SessionManagerLike = {
  getBranch?: () => unknown[];
  getEntries?: () => unknown[];
  getLeafId?: () => string | null | undefined;
};

type ModelIdleChecker = () => boolean;
type SuggestionListener = (suggestion: string | null) => void;

const require = createRequire(import.meta.url);
const { refinementPolicy, DEFAULT_POLICY: REFINEMENT_POLICY_DEFAULTS } = require("../../src/prompt-suggestion-policy.js");
const { DEFAULT_CONTEXT_CHARS, MAX_CONTEXT_CHARS, PUBLIC_MESSAGE_CHARS, configPath, formatModelRef, inspectModelConfig, parseModelRef, promptTextIsSafe, readModelConfig, redactPromptText, requestModelSuggestion, writeModelConfig } = require("../../src/prompt-suggestion-model.js");
const { createExtensionTelemetry, instrumentExtensionCommands } = require("../../src/pi-extension-kit.js");
const { readPromptSuggestionTelemetryEvents } = require("../../src/extension-telemetry.js");

// These operator overrides use the same KeyId syntax as Pi's keyboard bindings.
const DEFAULT_ACCEPT_KEY = (process.env.PI_PROMPT_SUGGESTION_ACCEPT_KEY as KeyId | undefined) || "tab";
const DEFAULT_RETRY_KEY = (process.env.PI_PROMPT_SUGGESTION_RETRY_KEY as KeyId | undefined) || "ctrl+r";
function envInteger(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}
function envRate(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}
const REFINE_MODE = process.env.PI_PROMPT_SUGGESTIONS_REFINE ?? "auto";
const REFINE_ENABLED = !["0", "false", "off", "disabled"].includes(String(REFINE_MODE).toLowerCase());
const REFINE_MIN_ATTEMPTS = envInteger("PI_PROMPT_SUGGESTIONS_REFINE_MIN_ATTEMPTS", REFINEMENT_POLICY_DEFAULTS.minAttempts, 0);
const REFINE_MIN_ACCEPTANCE_RATE = envRate("PI_PROMPT_SUGGESTIONS_REFINE_MIN_ACCEPTANCE_RATE", REFINEMENT_POLICY_DEFAULTS.minAcceptanceRate);
const REFINE_MAX_FAILURE_RATE = envRate("PI_PROMPT_SUGGESTIONS_REFINE_MAX_FAILURE_RATE", REFINEMENT_POLICY_DEFAULTS.maxFailureRate);
const REFINE_WINDOW_DAYS = envInteger("PI_PROMPT_SUGGESTIONS_REFINE_WINDOW_DAYS", REFINEMENT_POLICY_DEFAULTS.windowDays, 1);
const DISABLED = process.env.PI_PROMPT_SUGGESTIONS === "0" || process.env.PI_PROMPT_SUGGESTIONS === "false";
const MAX_RENDERED_SUGGESTION_LINES = 6;
const MAX_SUGGESTION_CHARS = 1200;
const REFINE_MAX_CONTEXT_CHARS = Math.max(1000, Math.min(MAX_CONTEXT_CHARS, envInteger("PI_PROMPT_SUGGESTIONS_CONTEXT_CHARS", DEFAULT_CONTEXT_CHARS, 1000)));
const EXTENSION_VERSION = "prompt-suggestions-2026-10-18.1";
// Extension-bus event carrying the next-prompt suggestion (string) or null, for
// status consumers such as the pi-dash session dashboard.
const SUGGESTION_CHANGED_EVENT = "prompt-suggestion:changed";
const SUGGESTION_REQUEST_EVENT = "prompt-suggestion:request";

type PromptTelemetry = (source: "local" | "model" | "none", action: "generated" | "refined" | "skipped" | "shown" | "accepted" | "dismissed" | "retried" | "timed-out" | "failed", outcome: string, latencyMs?: number, reasonCode?: string) => void;
type PromptSuggestionOutcome = "succeeded" | "blocked" | "not-applicable" | "cancelled" | "timed-out" | "infrastructure-failed";
type PromptSuggestionResult = { ok: true; suggestion: string; outcome: "succeeded"; reasonCode: "ready" } | { ok: false; suggestion: null; outcome: Exclude<PromptSuggestionOutcome, "succeeded">; reasonCode: string };
type ModelRegistryLike = { find(provider: string, modelId: string): unknown; complete(model: unknown, context: unknown, options?: unknown): Promise<{ stopReason?: string; errorMessage?: string; content?: unknown }>; hasConfiguredAuth?(model: unknown): boolean; getAvailable?(): unknown[] };
type PromptSuggestionRequestOptions = { signal?: AbortSignal; registry?: ModelRegistryLike; config?: { provider: string; modelId: string } };

const ADVISORY_FAILURE_REASONS = new Set(["disabled", "privacy", "authentication", "authentication-proof-missing", "provider-model", "transport", "timeout", "cancelled", "missing-binary", "unavailable", "unexpected-response", "backoff-active", "invalid-suggestion", "invalid-config", "invalid-packet", "model-not-configured", "model-unavailable", "unknown"]);
function advisoryFailureReason(error: unknown): string {
  const row = error && typeof error === "object" ? error as { code?: unknown; category?: unknown; reasonCode?: unknown } : {};
  const reason = String(row.reasonCode || row.category || "").trim().toLowerCase();
  if (ADVISORY_FAILURE_REASONS.has(reason)) return reason;
  const code = String(row.code || "").toUpperCase();
  if (code.includes("DISABLED")) return "disabled";
  if (code.includes("UNSAFE")) return "privacy";
  if (code.includes("AUTH")) return "authentication";
  if (code.includes("NOT_READY")) return "backoff-active";
  return "unknown";
}
function advisoryFailureOutcome(reasonCode: string): Exclude<PromptSuggestionOutcome, "succeeded"> {
  if (reasonCode === "timeout") return "timed-out";
  if (reasonCode === "cancelled") return "cancelled";
  if (["backoff-active", "privacy"].includes(reasonCode)) return "blocked";
  if (["disabled", "missing-binary", "unavailable", "model-not-configured", "model-unavailable"].includes(reasonCode)) return "not-applicable";
  return "infrastructure-failed";
}
export function suggestionFailure(error: unknown): PromptSuggestionResult {
  const reasonCode = advisoryFailureReason(error);
  return { ok: false, suggestion: null, outcome: advisoryFailureOutcome(reasonCode), reasonCode };
}

function textFromContent(content: unknown, maxChars = 4000): string {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 4000;
  if (typeof content === "string") return content.slice(0, cap);
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const block = content as { type?: unknown; text?: unknown; content?: unknown };
    const type = String(block.type || "").toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning")) return "";
    return String(block.text ?? block.content ?? "").slice(0, cap);
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let remaining = cap;
  for (const block of content) {
    if (!remaining) break;
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = String((block as { text?: unknown }).text ?? "").slice(0, remaining);
      if (text) {
        parts.push(text);
        remaining -= text.length;
      }
    }
  }
  return parts.join("\n");
}

function cleanPromptSuggestionLine(line: string, stripLeadingListMarker = true): string {
  const cleaned = line.replace(/[^\S\n]+/g, " ").trim();
  if (!stripLeadingListMarker) {
    return cleaned
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .replace(/[`_]/g, "")
      .trim();
  }
  return cleaned
    .replace(/^[-*\d.)\s"'“”‘’]+/, "")
    .replace(/[`*_]/g, "")
    .trim();
}

export function cleanPromptSuggestion(text: string, maxLength = MAX_SUGGESTION_CHARS, stripFirstLineListMarker = true): string | null {
  const rawLines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length > MAX_RENDERED_SUGGESTION_LINES) return null;

  const lines = rawLines.map((line, index) => cleanPromptSuggestionLine(line, stripFirstLineListMarker && index === 0));
  const cleaned = lines.join("\n").trim();
  const compact = cleaned.replace(/\s+/g, " ").trim();
  if (compact.length < 3) return null;
  const firstLineForCommandCheck = cleanPromptSuggestionLine(rawLines[0] || "", true);
  if (firstLineForCommandCheck.startsWith("/") || /^!\s*/.test(firstLineForCommandCheck)) return null;

  // Never turn a usable generated prompt into an incomplete one. The model's
  // 240-character target is advisory; modest overruns are safe, while truly
  // excessive or already-truncated suggestions fall back to the local prompt.
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : MAX_SUGGESTION_CHARS;
  if (cleaned.length > limit || /(?:…|\.{3})\s*$/.test(cleaned)) return null;
  return cleaned;
}

function splitPromptSuggestionLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").slice(0, MAX_RENDERED_SUGGESTION_LINES);
}

export function extractExplicitNextStep(text: string): string | null {
  // Only treat labelled recommendations as explicit next-step suggestions.
  // A loose search for "next step" also matches ordinary prose such as
  // "best next step” suggestion when...", producing sentence fragments.
  const nextStepLabel = text.match(/(?:^|[\n.!?])[^\S\n]*(?:the[^\S\n]+)?(?:(?:recommended|suggested)[^\S\n]+)?next(?:[^\S\n]+best)?[^\S\n]+steps?[^\S\n]*(?:is|are|:|-)[^\S\n]*(?:[:：][^\S\n]*)?/i);
  if (!nextStepLabel || nextStepLabel.index === undefined) return null;

  const remainder = text.slice(nextStepLabel.index + nextStepLabel[0].length).replace(/\r\n?/g, "\n");
  const [firstLine = "", ...followingLines] = remainder.split("\n");
  if (firstLine.trim()) return cleanPromptSuggestion(firstLine);

  const blockLines: string[] = [];
  for (const line of followingLines) {
    if (!line.trim()) break;
    blockLines.push(line);
    if (blockLines.length > MAX_RENDERED_SUGGESTION_LINES) return null;
  }
  return blockLines.length ? cleanPromptSuggestion(blockLines.join("\n"), MAX_SUGGESTION_CHARS, false) : null;
}

export function bestNextStepPromptSuggestion(sessionManager: SessionManagerLike): string | null {
  const entries = (sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? []) as Array<Record<string, unknown>>;
  const messages = entries
    .map((entry) => (entry && typeof entry === "object" ? (entry as { message?: unknown }).message : undefined))
    .filter((message): message is Record<string, unknown> => !!message && typeof message === "object");

  if (!messages.some((message) => message.role === "user")) return null;
  if (!messages.some((message) => message.role === "assistant" || message.role === "toolResult")) return null;

  const last = [...messages].reverse().find((message) => ["assistant", "toolResult", "bashExecution"].includes(String(message.role)));
  if (!last) return "Continue with the best next step";

  const content = textFromContent(last.content ?? (last as { output?: unknown }).output ?? "", 2400);
  const explicit = extractExplicitNextStep(content);
  if (explicit) return explicit;

  const lower = content.toLowerCase();
  const looksVerified = /\b(all checks passed|tests? passed|validation passed|smoke checks passed|verified|fixed)\b/.test(lower);
  if (last.role === "toolResult" && ((last as { isError?: unknown }).isError || (!looksVerified && /\b(error|failed|exception|traceback)\b/.test(lower)))) {
    return "Investigate the failed command and fix the root cause";
  }
  if (!looksVerified && /\b(failing|failed|failure|test failure|tests failed)\b/.test(lower)) {
    return "Fix the failing behavior and verify it with tests";
  }
  if (/\b(todo|follow[- ]?up|remaining|not yet|still need|next)\b/.test(lower)) {
    return "Continue with the next unfinished task";
  }
  if (/\?\s*$/.test(content.trim())) {
    return "Answer the open question and continue";
  }

  return "Continue with the best next step";
}

function sessionMessages(sessionManager: SessionManagerLike): Array<Record<string, unknown>> {
  const entries = (sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? []) as Array<Record<string, unknown>>;
  return entries
    .map((entry) => (entry && typeof entry === "object" ? (entry as { message?: unknown }).message : undefined))
    .filter((message): message is Record<string, unknown> => !!message && typeof message === "object");
}

function scannerSafeContextMessage(message: Record<string, unknown>): string | null {
  const role = ["user", "assistant", "toolResult", "bashExecution"].includes(String(message.role)) ? String(message.role) : "other";
  const text = redactPromptText(textFromContent(message.content ?? (message as { output?: unknown }).output ?? "", PUBLIC_MESSAGE_CHARS), PUBLIC_MESSAGE_CHARS);
  if (!text || !promptTextIsSafe(text, PUBLIC_MESSAGE_CHARS)) return null;
  return `[${role}] ${text}`;
}

export function publicSessionExcerpt(sessionManager: SessionManagerLike): string | null {
  const excerpt = sessionMessages(sessionManager).slice(-8).map(scannerSafeContextMessage).filter(Boolean).join("\n");
  const bounded = excerpt.length > REFINE_MAX_CONTEXT_CHARS ? excerpt.slice(-REFINE_MAX_CONTEXT_CHARS) : excerpt;
  return bounded && promptTextIsSafe(bounded, REFINE_MAX_CONTEXT_CHARS) ? bounded : null;
}

function recentSubagentToolResults(sessionManager: SessionManagerLike): boolean {
  return sessionMessages(sessionManager).slice(-8).some((message) => {
    if (String(message.role) !== "toolResult") return false;
    const toolName = String((message as { toolName?: unknown }).toolName || "").toLowerCase();
    if (toolName.includes("subagent")) return true;
    const text = textFromContent(message.content ?? "", 800).toLowerCase();
    return text.includes("subagent_id") || text.includes("subagent ");
  });
}

export async function requestPromptModelSuggestion(sessionManager: SessionManagerLike, cwd: string, options: PromptSuggestionRequestOptions = {}): Promise<PromptSuggestionResult> {
  try {
    const packet = promptSuggestionPacket(sessionManager, cwd);
    const loaded = options.config ? { ok: true as const, config: options.config } : readModelConfig();
    if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: `PROMPT_SUGGESTION_${loaded.reasonCode.replace(/-/g, "_").toUpperCase()}`, reasonCode: loaded.reasonCode });
    const result = await requestModelSuggestion({ registry: options.registry, config: loaded.config, packet, signal: options.signal, maxContextChars: REFINE_MAX_CONTEXT_CHARS });
    const suggestion = cleanPromptSuggestion(result.value);
    return suggestion
      ? { ok: true, suggestion, outcome: "succeeded", reasonCode: "ready" }
      : { ok: false, suggestion: null, outcome: "infrastructure-failed", reasonCode: "invalid-suggestion" };
  } catch (error) {
    return suggestionFailure(error);
  }
}

export function skillSuggestionContext(cwd: string): string {
  try {
    const rows = readFileSync(join(cwd, ".pi", "cognitive-automation", "skills", "metrics.jsonl"), "utf8")
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .slice(-8)
      .map((line) => JSON.parse(line));
    // Advisory retrieval is not skill use. Only explicit invocations/manual
    // evaluations carry invoked:true and may affect next-step guidance.
    const evaluated = rows.filter((r) => r.type === "skill.evaluated" && r.evidence?.invoked === true);
    const failed = evaluated.filter((r) => r.ok === false).slice(-3);
    const used = evaluated.slice(-3);
    if (!failed.length && !used.length) return "";
    return `\n\nLocal skill telemetry (public, advisory): ${failed.length ? `${failed.length} recent skill failure(s); ask to inspect failure evidence before reuse.` : ""} ${used.length ? `recent skill ids: ${used.map((r) => r.skillId).filter(Boolean).join(", ")}` : ""}`.slice(0, 800);
  } catch { return ""; }
}

function currentRefinementPolicy(cwd: string) {
  const sinceAt = new Date(Date.now() - Math.max(1, REFINE_WINDOW_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  const events = readPromptSuggestionTelemetryEvents({ cwd, sinceAt });
  return refinementPolicy(events, { mode: REFINE_MODE, minAttempts: REFINE_MIN_ATTEMPTS, minAcceptanceRate: REFINE_MIN_ACCEPTANCE_RATE, maxFailureRate: REFINE_MAX_FAILURE_RATE });
}

function promptSuggestionPacket(sessionManager: SessionManagerLike, cwd: string): Record<string, unknown> {
  return {
    publicRecentContext: publicSessionExcerpt(sessionManager),
    skillContext: skillSuggestionContext(cwd).trim() || null,
  };
}

class PromptSuggestionEditor extends CustomEditor {
  private dismissedForText: string | null = null;
  private readonly acceptKey: KeyId;
  private readonly retryKey: KeyId;
  private readonly ghost: (text: string) => string;
  private readonly sessionManager: SessionManagerLike;
  private readonly cwd: string;
  private readonly tuiRef: TUI;
  private pendingEmptyPromptState: string | null = null;
  private emptyPromptSuggestionState: string | null = null;
  private emptyPromptSuggestion: string | null = null;
  private emptyPromptSuggestionSource: "local" | "model" | null = null;
  private emptyPromptAbort: AbortController | null = null;
  private readonly keybindingsRef: any;
  private readonly isIdleRef: ModelIdleChecker;
  private modelWorking = false;
  private suggestionsConsumed = false;
  private readonly telemetry: PromptTelemetry;
  private lastShownSuggestionKey: string | null = null;
  private lastRefinementFailureReason: string | null = null;
  private readonly onSuggestionChange: SuggestionListener;
  private readonly registry: ModelRegistryLike | undefined;
  private publishedSuggestion: string | null = null;

  constructor(tui: TUI, theme: EditorTheme, keybindings: any, sessionManager: SessionManagerLike, cwd: string, registry: ModelRegistryLike | undefined, private readonly getCommands: ExtensionAPI["getCommands"], isIdle: ModelIdleChecker = () => true, telemetry: PromptTelemetry = () => {}, onSuggestionChange: SuggestionListener = () => {}, options?: EditorOptions) {
    super(tui, theme, keybindings, options);
    // If running on a locally patched Pi that already has core prompt suggestions,
    // disable the core implementation so the extension remains the single source
    // of prompt suggestions. On stock Pi this method is absent and this is a no-op.
    (this as unknown as { setPromptSuggestionsEnabled?: (enabled: boolean) => void }).setPromptSuggestionsEnabled?.(false);
    this.acceptKey = DEFAULT_ACCEPT_KEY;
    this.retryKey = DEFAULT_RETRY_KEY;
    this.ghost = theme.borderColor;
    this.sessionManager = sessionManager;
    this.cwd = cwd;
    this.registry = registry;
    this.tuiRef = tui;
    this.keybindingsRef = keybindings;
    this.isIdleRef = isIdle;
    this.telemetry = telemetry;
    this.onSuggestionChange = onSuggestionChange;
  }

  // The session's suggested next prompt, independent of this editor's typed
  // text or dismissal: other clients (e.g. pi-dash) offer it in their own input.
  private currentSuggestion(): string | null {
    if (DISABLED || this.modelWorking || this.suggestionsConsumed) return null;
    return this.emptyPromptSuggestionState === this.emptyPromptState() ? this.emptyPromptSuggestion : null;
  }

  private publishSuggestion(): void {
    const suggestion = this.currentSuggestion();
    if (suggestion === this.publishedSuggestion) return;
    this.publishedSuggestion = suggestion;
    this.onSuggestionChange(suggestion);
  }

  private emptyPromptState(): string {
    return String(this.sessionManager.getLeafId?.() ?? sessionMessages(this.sessionManager).length);
  }

  private cancelEmptyPromptSuggestion(): void {
    this.pendingEmptyPromptState = null;
    this.emptyPromptAbort?.abort();
    this.emptyPromptAbort = null;
  }

  setModelWorking(working: boolean): void {
    this.modelWorking = working;
    if (!working) this.suggestionsConsumed = false;
    if (working) this.cancelEmptyPromptSuggestion();
    this.publishSuggestion();
    this.tuiRef.requestRender();
  }

  private isModelIdle(): boolean {
    if (this.modelWorking) return false;
    try {
      return this.isIdleRef();
    } catch {
      return true;
    }
  }

  precomputeEmptyPromptSuggestion(): void {
    this.scheduleEmptyPromptSuggestion();
  }

  status(): Record<string, unknown> {
    return {
      state: this.emptyPromptState(),
      cachedState: this.emptyPromptSuggestionState,
      pendingState: this.pendingEmptyPromptState,
      source: this.emptyPromptSuggestionSource,
      hasSuggestion: Boolean(this.emptyPromptSuggestion),
      inFlight: this.isSuggestionInFlight(),
      idle: this.isModelIdle(),
      modelWorking: this.modelWorking,
      retryKey: this.retryKey,
      refinementEnabled: REFINE_ENABLED,
      refinementPolicy: currentRefinementPolicy(this.cwd),
      modelConfig: inspectModelConfig(this.registry),
      lastRefinementFailureReason: this.lastRefinementFailureReason,
    };
  }

  dispose(): void {
    this.cancelEmptyPromptSuggestion();
    if (this.publishedSuggestion !== null) {
      this.publishedSuggestion = null;
      this.onSuggestionChange(null);
    }
  }

  private scheduleEmptyPromptSuggestion(options: { force?: boolean; bypassSubagentRefinementSkip?: boolean } = {}): void {
    if (!this.isModelIdle()) return;
    if (this.suggestionsConsumed) return;
    if (DISABLED || this.getText().length > 0 || this.dismissedForText === "") return;
    const state = this.emptyPromptState();
    if (!options.force && (this.pendingEmptyPromptState === state || this.emptyPromptSuggestionState === state)) return;
    if (sessionMessages(this.sessionManager).length === 0) return;

    // Integration contract: keep the editor responsive even when the configured
    // model is slow or unavailable. A deterministic local next-step suggestion
    // is shown first; the model may refine it later for the same empty-prompt state.
    const localStartedAt = Date.now();
    const localSuggestion = bestNextStepPromptSuggestion(this.sessionManager);
    const localLatencyMs = Date.now() - localStartedAt;
    this.telemetry("local", "generated", localSuggestion ? "succeeded" : "not-applicable", localLatencyMs);
    if (localSuggestion) {
      this.emptyPromptSuggestionState = state;
      this.emptyPromptSuggestion = localSuggestion;
      this.emptyPromptSuggestionSource = "local";
      this.publishSuggestion();
      this.tuiRef.requestRender();
    }

    const loaded = readModelConfig();
    if (!loaded.ok) {
      this.lastRefinementFailureReason = loaded.reasonCode;
      this.telemetry("model", "skipped", "not-applicable", 0, loaded.reasonCode);
      return;
    }
    const policy = currentRefinementPolicy(this.cwd);
    const automaticAttemptAllowed = policy.automatic || policy.bootstrap;
    if (options.force ? !policy.manual : !automaticAttemptAllowed) {
      this.telemetry("model", "skipped", "not-applicable");
      return;
    }
    if (!options.bypassSubagentRefinementSkip && recentSubagentToolResults(this.sessionManager)) {
      this.telemetry("model", "skipped", "not-applicable");
      return;
    }
    this.emptyPromptAbort?.abort();
    const controller = new AbortController();
    this.emptyPromptAbort = controller;
    this.pendingEmptyPromptState = state;
    this.tuiRef.requestRender();
    const refinementStartedAt = Date.now();
    void requestPromptModelSuggestion(this.sessionManager, this.cwd, { signal: controller.signal, registry: this.registry, config: loaded.config }).then((result) => {
      const refinementLatencyMs = Date.now() - refinementStartedAt;
      if (this.emptyPromptAbort !== controller) {
        this.telemetry("model", "skipped", "cancelled", refinementLatencyMs);
        return;
      }
      this.emptyPromptAbort = null;
      this.pendingEmptyPromptState = null;
      if (controller.signal.aborted) {
        this.telemetry("model", "skipped", "cancelled", refinementLatencyMs);
        return;
      }
      if (!this.isModelIdle() || this.getText().length > 0 || this.emptyPromptState() !== state) {
        this.telemetry("model", "skipped", "cancelled", refinementLatencyMs);
        return;
      }
      if (!result.ok) {
        this.lastRefinementFailureReason = result.reasonCode;
        const action = result.outcome === "timed-out" ? "timed-out" : ["blocked", "not-applicable", "cancelled"].includes(result.outcome) ? "skipped" : "failed";
        this.telemetry("model", action, result.outcome, refinementLatencyMs, result.reasonCode);
        if (this.emptyPromptSuggestionState !== state) {
          this.emptyPromptSuggestionState = state;
          this.emptyPromptSuggestion = null;
          this.emptyPromptSuggestionSource = null;
          this.publishSuggestion();
        }
        this.tuiRef.requestRender();
        return;
      }
      this.lastRefinementFailureReason = null;
      this.telemetry("model", "refined", "succeeded", refinementLatencyMs, result.reasonCode);
      this.emptyPromptSuggestionState = state;
      this.emptyPromptSuggestion = result.suggestion;
      this.emptyPromptSuggestionSource = "model";
      this.publishSuggestion();
      this.tuiRef.requestRender();
    });
  }

  private suggestion(): string | null {
    if (DISABLED || this.suggestionsConsumed) return null;
    if (!this.isModelIdle()) {
      this.cancelEmptyPromptSuggestion();
      return null;
    }
    if (this.isShowingAutocomplete?.()) return null;
    const text = this.getText();
    if (this.dismissedForText === text) return null;

    if (text.length === 0) {
      const state = this.emptyPromptState();
      if (this.emptyPromptSuggestionState === state) return this.emptyPromptSuggestion;
      this.scheduleEmptyPromptSuggestion();
      return null;
    }

    this.cancelEmptyPromptSuggestion();
    return null;
  }

  private isSuggestionInFlight(): boolean {
    if (DISABLED || !this.isModelIdle() || this.isShowingAutocomplete?.()) return false;
    const text = this.getText();
    if (text.length > 0 || this.dismissedForText === text) return false;
    return this.pendingEmptyPromptState === this.emptyPromptState();
  }

  private dismissSuggestion(): boolean {
    if (!this.suggestion() && !this.isSuggestionInFlight()) return false;
    this.telemetry(this.emptyPromptSuggestionSource || "none", "dismissed", "succeeded");
    this.dismissedForText = this.getText();
    this.cancelEmptyPromptSuggestion();
    return true;
  }

  retrySuggestion(): boolean {
    if (DISABLED || !this.isModelIdle() || this.getText().length > 0 || sessionMessages(this.sessionManager).length === 0) return false;
    this.telemetry(this.emptyPromptSuggestionSource || "none", "retried", "succeeded");
    this.suggestionsConsumed = false;
    this.dismissedForText = null;
    this.cancelEmptyPromptSuggestion();
    this.emptyPromptSuggestionState = null;
    this.emptyPromptSuggestion = null;
    this.emptyPromptSuggestionSource = null;
    // Manual retry is user-initiated, so it may ask the configured model even
    // when automatic refinement was skipped after subagent-heavy results.
    this.scheduleEmptyPromptSuggestion({ force: true, bypassSubagentRefinementSkip: true });
    this.publishSuggestion();
    this.tuiRef.requestRender();
    return true;
  }

  private acceptSuggestion(): boolean {
    const suggestion = this.suggestion();
    if (!suggestion) return false;
    this.telemetry(this.emptyPromptSuggestionSource || "none", "accepted", "succeeded");
    this.insertTextAtCursor(suggestion);
    this.cancelEmptyPromptSuggestion();
    this.dismissedForText = null;
    return true;
  }

  private isSubmitKey(data: string): boolean {
    return Boolean(this.keybindingsRef?.matches?.(data, "tui.input.submit")) || matchesKey(data, "enter");
  }

  private cancelSuggestionOnSubmit(data: string): void {
    const text = this.getText().trim();
    if (text.length === 0) return;
    if (this.isShowingAutocomplete?.()) return;
    if (!this.isSubmitKey(data)) return;
    // Pi handles registered extension commands before model input. Approvals
    // and other no-turn commands must not consume the cached next prompt.
    // Templates, skills, and unknown slash commands still enter preflight.
    if (text.startsWith("/") && this.getCommands().some(command => command.source === "extension" && command.name === text.slice(1).split(" ", 1)[0])) {
      this.cancelEmptyPromptSuggestion();
      return;
    }
    this.consumeSuggestions();
  }

  consumeSuggestions(): void {
    // Consume until settlement (or explicit retry), not merely a leaf change:
    // pre-prompt compaction can restore isIdle() before our start hook runs.
    this.suggestionsConsumed = true;
    this.cancelEmptyPromptSuggestion();
    this.emptyPromptSuggestionState = null;
    this.emptyPromptSuggestion = null;
    this.emptyPromptSuggestionSource = null;
    this.publishSuggestion();
    this.tuiRef.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, this.acceptKey) && this.acceptSuggestion()) return;
    if (matchesKey(data, this.retryKey) && this.retrySuggestion()) return;
    if (matchesKey(data, "escape") && this.dismissSuggestion()) return;
    this.cancelSuggestionOnSubmit(data);
    super.handleInput(data);
    if (this.getText().length > 0) this.cancelEmptyPromptSuggestion();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const suggestion = this.suggestion();
    const inFlight = this.isSuggestionInFlight();
    if ((!suggestion && !inFlight) || width <= 0) return lines;
    if (suggestion) {
      const shownKey = `${this.emptyPromptState()}:${this.emptyPromptSuggestionSource || "none"}`;
      if (this.lastShownSuggestionKey !== shownKey) {
        this.lastShownSuggestionKey = shownKey;
        this.telemetry(this.emptyPromptSuggestionSource || "none", "shown", "succeeded");
      }
    }

    const acceptHint = this.acceptKey === "tab" ? "Tab" : this.acceptKey;
    const retryHint = this.retryKey === "ctrl+r" ? "Ctrl+R" : this.retryKey;
    const pendingHint = inFlight ? " · suggesting…" : "";
    const hint = suggestion ? `${acceptHint} accept · ${retryHint} retry · Esc dismiss${pendingHint}` : "suggesting…";
    const suggestionLineValues = suggestion ? splitPromptSuggestionLines(suggestion) : ["suggesting…"];
    const prefixWidth = visibleWidth("↳ ");
    const contentWidth = Math.max(0, width - prefixWidth);
    if (contentWidth <= 0) return lines;

    let firstVisualLine = true;
    for (const line of suggestionLineValues) {
      const wrapped = wrapTextWithAnsi(this.ghost(line || " "), contentWidth);
      for (const display of wrapped) {
        const prefix = firstVisualLine ? "↳ " : "  ";
        lines.push(truncateToWidth(prefix + display, width, ""));
        firstVisualLine = false;
      }
    }

    if (suggestion && !firstVisualLine) {
      const suffix = this.ghost(`  ${hint}`);
      const lastIndex = lines.length - 1;
      if (visibleWidth(lines[lastIndex]) + visibleWidth(suffix) <= width) {
        lines[lastIndex] += suffix;
      } else {
        lines.push(truncateToWidth(`  ${this.ghost(hint)}`, width, ""));
      }
    }
    return lines;
  }
}

export default function promptSuggestionsExtension(pi: ExtensionAPI) {
  let editor: PromptSuggestionEditor | null = null;
  pi = instrumentExtensionCommands(pi, { extension: "prompt-suggestions", version: EXTENSION_VERSION }) as ExtensionAPI;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor?.dispose();
      const telemetry = createExtensionTelemetry({ cwd: ctx.cwd, extension: "prompt-suggestions", version: EXTENSION_VERSION });
      editor = new PromptSuggestionEditor(tui, theme, keybindings, ctx.sessionManager, ctx.cwd, ctx.modelRegistry as ModelRegistryLike | undefined, () => pi.getCommands(), () => ctx.isIdle(), (source, action, outcome, latencyMs, reasonCode) => { telemetry.promptSuggestion(source, action, outcome, latencyMs, reasonCode); }, (suggestion) => { pi.events.emit(SUGGESTION_CHANGED_EVENT, suggestion); });
      editor.setModelWorking(!ctx.isIdle());
      return editor;
    });
  });

  // A command may explicitly send a model prompt. Input runs after command
  // dispatch but before compaction, closing that path's preflight gap too.
  pi.on("input", () => {
    editor?.consumeSuggestions();
  });

  pi.on("before_agent_start", () => {
    editor?.setModelWorking(true);
  });

  pi.on("agent_start", () => {
    editor?.setModelWorking(true);
  });

  pi.on("agent_settled", () => {
    editor?.setModelWorking(false);
    editor?.precomputeEmptyPromptSuggestion();
  });

  pi.on("session_shutdown", () => {
    editor?.dispose();
    editor = null;
  });

  // Remote clients request the same retry as Ctrl+R; never touch or submit editor text.
  pi.events.on(SUGGESTION_REQUEST_EVENT, (data) => {
    const request = data as { respond?: (error: string | null) => void } | null;
    if (typeof request?.respond !== "function") return;
    if (!editor) {
      request.respond("Prompt suggestions are unavailable; the session editor is not active");
      return;
    }
    request.respond(editor.retrySuggestion() ? null : "Prompt suggestions require an enabled extension, idle pi, an existing conversation, and an empty desktop editor");
  });

  pi.registerCommand("prompt-suggestions", {
    description: "Show prompt suggestion extension status",
    handler: async (_args, ctx) => {
      const model = inspectModelConfig(ctx.modelRegistry as ModelRegistryLike | undefined);
      ctx.ui.notify(
        DISABLED
          ? "Prompt suggestions extension is disabled by PI_PROMPT_SUGGESTIONS=0"
          : `Prompt suggestions extension is active; accept key: ${DEFAULT_ACCEPT_KEY}; retry key: ${DEFAULT_RETRY_KEY}; refinement policy: ${JSON.stringify(currentRefinementPolicy(ctx.cwd))}; model: ${model.ok ? `${model.modelRef} (${model.available ? "available" : "unavailable"})` : model.reasonCode}; config: ${model.file || (model.source === "environment" ? "environment override" : configPath())}; state: ${JSON.stringify(editor?.status?.() || { editor: "not initialized" })}`,
        "info",
      );
    },
  });

  pi.registerCommand("prompt-suggestions-model", {
    description: "Choose the machine-wide model used for prompt suggestions: /prompt-suggestions-model <provider/modelId>",
    handler: async (args, ctx) => {
      const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
      if (!registry?.find) { ctx.ui.notify("Pi's model registry is unavailable", "error"); return; }
      let ref = String(args || "").trim();
      if (!ref) {
        const available = (registry.getAvailable?.() ?? []) as Array<{ provider?: unknown; id?: unknown }>;
        const options = [...new Set(available.map((model) => model?.provider && model?.id ? `${String(model.provider)}/${String(model.id)}` : "").filter(Boolean))].sort();
        if (!options.length) { ctx.ui.notify("No models with working authentication are available", "error"); return; }
        ref = (await ctx.ui.select("Prompt suggestion model", options)) || "";
        if (!ref) return;
      }
      const parsed = parseModelRef(ref);
      if (!parsed) { ctx.ui.notify("Usage: /prompt-suggestions-model <provider/modelId>", "error"); return; }
      if (!registry.find(parsed.provider, parsed.modelId)) { ctx.ui.notify(`Model not found: ${ref}`, "error"); return; }
      try {
        const saved = writeModelConfig(parsed);
        ctx.ui.notify(`Prompt suggestion model saved machine-wide: ${formatModelRef(saved.config)} (${saved.file})`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save prompt suggestion model: ${(error as Error).message}`, "error");
      }
    },
  });
}
