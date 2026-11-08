"use strict";

const { compactToolContent, contentText } = require("./result-rendering.js");
const { estimateTextTokens } = require("./provider-result-rendering.js");

/** Room reserved for the omission marker and continuation hint. */
const MARKER_RESERVE = 240;
const MIN_MAX_CHARS = 1200;

// Caps come from a 30-day local corpus (198 sessions, 157,615 tool results):
// read+bash were 75.2% of tool-output characters, the top six tools 91%, and
// the top 10% of calls produced 49.9% of all characters. `head` keeps the start
// (files and paged views continue by offset), `tail` keeps the end (failures and
// pi's truncation footer live there), `structured` compacts JSON field-first
// instead of cutting through a record.
const DEFAULT_POLICIES = Object.freeze({
  read: { mode: "head", maxChars: 8000, continuation: "read" },
  bash: { mode: "tail", maxChars: 8000, continuation: "bash" },
  test_runner: { mode: "tail", maxChars: 8000, continuation: "bash" },
  docs_lookup: { mode: "head", maxChars: 8000, continuation: "docs" },
  ast_refactor: { mode: "structured", maxChars: 6000, continuation: "generic" },
  ast_search: { mode: "structured", maxChars: 6000, continuation: "generic" },
  lsp: { mode: "structured", maxChars: 6000, continuation: "generic" },
  debug_ledger: { mode: "head", maxChars: 8000, continuation: "debug" },
  bg_run: { mode: "tail", maxChars: 8000, continuation: "bash" },
  roadmap_update: { mode: "head", maxChars: 4000, continuation: "roadmap" },
  memory_curator: { mode: "structured", maxChars: 6000, continuation: "generic" },
  memory_explorer: { mode: "structured", maxChars: 6000, continuation: "generic" },
  create_subagent: { mode: "head", maxChars: 6000, continuation: "generic" },
  specialist_tasks: { mode: "structured", maxChars: 6000, continuation: "generic" },
  test_gap_planner: { mode: "structured", maxChars: 6000, continuation: "generic" },
  codegraph_context: { mode: "structured", maxChars: 8000, continuation: "generic" },
  codegraph_query: { mode: "structured", maxChars: 6000, continuation: "generic" },
  semgrep_codegraph: { mode: "structured", maxChars: 6000, continuation: "generic" },
  code_context: { mode: "structured", maxChars: 6000, continuation: "generic" },
});

function policyTools() {
  return Object.keys(DEFAULT_POLICIES).sort();
}

function policyFor(toolName) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_POLICIES, toolName) ? DEFAULT_POLICIES[toolName] : null;
}

/** Image and attachment blocks must never be dropped by a text cap. */
function hasNonTextBlock(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && typeof part === "object" && part.type !== "text");
}

/**
 * A result is left untouched when the caller asked for raw detail, already set a
 * bound, or the tool rendered inside its own budget. Each exemption is reported
 * so telemetry can attribute the unsaved population instead of hiding it.
 */
function exemptionReason({ content, details, input } = {}) {
  if (input && input.verbose === true) return "verbose";
  if (input && Number(input.maxChars) > 0) return "explicit-max-chars";
  const budgetTokens = Number(details?.rendering?.budgetTokens);
  if (Number.isFinite(budgetTokens) && budgetTokens > 0) {
    if (estimateTextTokens(contentText(content)) <= budgetTokens) return "native-bounded";
  }
  if (hasNonTextBlock(content)) return "non-text-content";
  return null;
}

function continuationFor(kind, { input, text } = {}) {
  switch (kind) {
    case "read": {
      const path = String(input?.path || "").trim();
      const requested = Number(input?.offset);
      const start = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1;
      const lines = String(text || "").split("\n").length;
      const next = start + lines;
      return path ? `continue with read path=${path} offset=${next}` : `continue with read offset=${next}`;
    }
    case "bash":
      return "re-run with a narrower command, or redirect output to a file and read a range";
    case "docs":
      return "continue with docs_lookup operation=read and offset/limit";
    case "debug":
      return "use debug_ledger show with attemptLimit for the full ledger";
    case "roadmap":
      return "use roadmap_update action=show with focusId/offset/limit";
    default:
      return "refine the request or pass verbose=false";
  }
}

function headBound(text, maxChars, continuation) {
  const room = Math.max(0, maxChars - MARKER_RESERVE);
  let head = text.slice(0, room);
  const newline = head.lastIndexOf("\n");
  if (newline > 0) head = head.slice(0, newline);
  const omitted = text.length - head.length;
  const hint = continuation(head);
  return `${head}\n\n[… ${omitted} chars omitted; ${hint}]`;
}

function tailBound(text, maxChars, continuation) {
  const room = Math.max(0, maxChars - MARKER_RESERVE);
  let tail = text.slice(text.length - room);
  const newline = tail.indexOf("\n");
  if (newline >= 0 && newline < room / 2) tail = tail.slice(newline + 1);
  const omitted = text.length - tail.length;
  const hint = continuation(tail);
  return `[… ${omitted} chars omitted from the start; ${hint}]\n\n${tail}`;
}

/**
 * Bounds one model-visible tool result. Returns the original text unchanged when
 * the tool has no policy, the caller asked for detail, or the result already fits.
 */
function boundToolResult({ toolName, content, details, input, isError = false } = {}) {
  const text = contentText(content);
  const policy = policyFor(toolName);
  if (!policy) return { changed: false, text, policy: null, reason: "no-policy", savedChars: 0 };
  const exempt = exemptionReason({ content, details, input });
  if (exempt) return { changed: false, text, policy, reason: exempt, savedChars: 0 };
  const maxChars = Math.max(MIN_MAX_CHARS, Number(policy.maxChars) || 0);
  if (text.length <= maxChars) return { changed: false, text, policy, reason: "within-budget", savedChars: 0 };
  if (policy.mode === "structured") {
    const compact = compactToolContent({ toolName, content, details, maxChars });
    if (compact.length < text.length) {
      return { changed: true, text: compact, policy, reason: isError ? "structured-error" : "structured", savedChars: text.length - compact.length };
    }
  }
  const continuation = (slice) => continuationFor(policy.continuation, { input, text: slice });
  const bounded = policy.mode === "tail" ? tailBound(text, maxChars, continuation) : headBound(text, maxChars, continuation);
  return { changed: true, text: bounded, policy, reason: isError ? `${policy.mode}-error` : policy.mode, savedChars: text.length - bounded.length };
}

module.exports = {
  DEFAULT_POLICIES,
  MARKER_RESERVE,
  MIN_MAX_CHARS,
  policyTools,
  policyFor,
  exemptionReason,
  continuationFor,
  headBound,
  tailBound,
  boundToolResult,
};
