"use strict";

const crypto = require("node:crypto");
const { compactRetrievalEnvelope } = require("./code-context-contracts.js");
const { renderProviderEnvelope } = require("./provider-result-rendering.js");

function stableStringify(value, space = 2) {
  const seen = new WeakSet();
  const normalize = (input) => {
    if (input == null || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out = {};
    for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
    return out;
  };
  return JSON.stringify(normalize(value), null, space);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value, 0)).digest("hex");
}

function truncateText(text, max = 1200) {
  const value = String(text == null ? "" : text);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 28)).trimEnd()}…<${value.length - max} more chars>`;
}

function parseJsonText(text) {
  if (typeof text !== "string") return { ok: false, value: text };
  const trimmed = text.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return { ok: false, value: text };
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch { return { ok: false, value: text }; }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && part.type === "text") return String(part.text || "");
    return "";
  }).filter(Boolean).join("\n");
}

const PRIORITY_KEYS = [
  "id", "runId", "topologyRunId", "topologyId", "skillId", "captureId", "patchId", "checkpointId",
  "status", "ok", "profile", "operation", "action", "severity", "file", "filePath", "path", "range", "signature", "contentRef", "outputRef", "failureKind", "expected", "actual", "topFrames", "command",
  "freshness", "degradation", "gatingSafe", "scoreReasons", "durationMs", "duration_ms", "confidence", "confidenceScore", "score", "summary", "reason", "error", "message",
];

function summarizeValue(value, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 3;
  const maxArrayItems = options.maxArrayItems ?? 3;
  const maxObjectKeys = options.maxObjectKeys ?? 12;
  const maxString = options.maxString ?? 260;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateText(value.replace(/\s+/g, " ").trim(), maxString);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[Array(${value.length})]`;
    return `[Object(${Object.keys(value || {}).length} keys)]`;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, maxArrayItems).map((item) => summarizeValue(item, options, depth + 1)),
      truncated: value.length > maxArrayItems,
    };
  }
  const keys = Object.keys(value);
  const out = { type: "object", keys: keys.length };
  const selected = [];
  for (const key of PRIORITY_KEYS) if (Object.prototype.hasOwnProperty.call(value, key)) selected.push(key);
  for (const key of keys.sort()) if (!selected.includes(key) && selected.length < maxObjectKeys) selected.push(key);
  for (const key of selected.slice(0, maxObjectKeys)) out[key] = summarizeValue(value[key], options, depth + 1);
  if (keys.length > selected.length) out.truncatedKeys = keys.length - selected.length;
  return out;
}

function renderCompactJson(value, options = {}) {
  const maxChars = options.maxChars ?? 2400;
  const summary = summarizeValue(value, options);
  return truncateText(stableStringify(summary), maxChars);
}

function renderTopologyRun(run, options = {}) {
  const maxErrors = options.maxErrors ?? 3;
  const maxResults = options.maxResults ?? 12;
  const lines = [];
  const symbols = { succeeded: "✓", partial: "◐", running: "◐", failed: "✗", cancelled: "✗", "timed-out": "✗", timed_out: "✗", skipped: "↷", blocked: "○", pending: "○" };
  lines.push(`topology ${run?.topologyId || run?.topology?.topologyId || "unknown"}: ${run?.status || "unknown"}`);
  if (run?.runId) lines.push(`run: ${run.runId}`);
  if (run?.durationMs != null) lines.push(`duration: ${Math.round(Number(run.durationMs) || 0)}ms`);
  if (run?.execution) lines.push(`mode=${run.execution.mode || "unknown"} concurrency=${run.execution.concurrencyLimit || 1} failure=${run.execution.failurePolicy || "unknown"} partial=${run.execution.partialPolicy || "forbid"} aggregation=${run.execution.aggregationPolicy || "terminal"}`);
  const states = Array.isArray(run?.nodeStates) && run.nodeStates.length
    ? run.nodeStates
    : (Array.isArray(run?.results) ? run.results.map((result) => ({ nodeId: result.nodeId || result.agentId || result.roleId || result.id, roleId: result.role || result.roleId, status: result.status || (result.ok === false ? "failed" : "succeeded"), evidenceCount: Array.isArray(result.evidenceRefs) ? result.evidenceRefs.length : 0 })) : []);
  if (states.length) {
    lines.push(`nodes: ${states.length}`);
    for (const state of states.slice(0, maxResults)) {
      const status = state.status || "pending";
      const timing = state.durationMs != null ? ` ${Math.round(Number(state.durationMs) || 0)}ms` : "";
      const evidence = Number(state.evidenceCount || 0) ? ` evidence=${Number(state.evidenceCount)}` : "";
      const join = state.requiredInputs != null ? ` inputs=${Number(state.successfulInputs || 0)}/${Number(state.requiredInputs || 0)}` : "";
      const reason = state.reason ? ` reason=${truncateText(state.reason, 120)}` : "";
      lines.push(`${symbols[status] || "•"} ${state.nodeId || "node"} role=${state.roleId || "worker"} status=${status}${timing}${evidence}${join}${reason}`);
    }
    if (states.length > maxResults) lines.push(`- … ${states.length - maxResults} more node state(s)`);
  }
  const joins = Array.isArray(run?.joinDecisions) ? run.joinDecisions : [];
  for (const join of joins.filter((item) => item.degraded || item.satisfied === false).slice(0, 6)) lines.push(`join ${join.nodeId}: ${join.mode} ${join.successfulInputs}/${join.minimumSuccessfulInputs} successful satisfied=${join.satisfied} degraded=${join.degraded}`);
  const errors = Array.isArray(run?.errors) ? run.errors : [];
  if (errors.length) {
    lines.push(`errors: ${errors.length}`);
    for (const error of errors.slice(0, maxErrors)) lines.push(`- ${error.nodeId || "node"}: ${truncateText(error?.message || error?.reason || stableStringify(error, 0), 220)}`);
  }
  if (run?.aggregation) {
    const payload = run.aggregation?.payload || run.aggregation;
    const counts = ["claims", "evidenceRefs", "auditDecisions", "disagreements", "rejectedClaims", "unresolvedGaps", "recommendedActions"].filter((key) => Array.isArray(payload?.[key])).map((key) => `${key}=${payload[key].length}`);
    lines.push(`aggregation: present keys=${Object.keys(run.aggregation || {}).slice(0, 12).join(",")}${counts.length ? ` ${counts.join(" ")}` : ""}`);
  }
  return lines.join("\n");
}

function renderRetrievalEnvelope(envelope, options = {}) {
  return compactRetrievalEnvelope(envelope, options);
}

function isRetrievalEnvelope(payload) {
  return Boolean(payload && payload.schemaVersion === 1 && Array.isArray(payload.items) && payload.queryId);
}

function compactToolPayload(toolName, payload, options = {}) {
  // Every retrieval provider validates into the same envelope, so the same
  // provider-aware renderer applies here as in the tool itself. This keeps the
  // compactor a backstop instead of a second, diverging rendering path.
  if (toolName === "code_context" || isRetrievalEnvelope(payload)) {
    if (isRetrievalEnvelope(payload) && ["codegraph", "semgrep", "ast"].includes(payload.provider)) return renderProviderEnvelope(payload, options);
    return renderRetrievalEnvelope(payload, options);
  }
  if (toolName === "run_topology" || payload?.runId || payload?.topologyRunId || payload?.topology?.topologyId) return renderTopologyRun(payload, options);
  return renderCompactJson(payload, options);
}

function compactToolContent({ toolName, content, details, maxChars = 2400 } = {}) {
  const text = contentText(content);
  const parsed = parseJsonText(text);
  const payload = details != null ? details : parsed.ok ? parsed.value : text;
  const originalChars = typeof payload === "string" ? payload.length : stableStringify(payload, 0).length;
  if (typeof payload === "string") return truncateText(payload, maxChars);
  const compact = compactToolPayload(toolName, payload, { maxChars });
  if (compact.length >= originalChars && text && text.length <= maxChars) return text;
  return compact;
}

function toolResultContent(text) {
  return [{ type: "text", text: String(text || "") }];
}

module.exports = {
  stableStringify,
  sha256,
  truncateText,
  parseJsonText,
  contentText,
  summarizeValue,
  renderCompactJson,
  renderTopologyRun,
  renderRetrievalEnvelope,
  compactToolPayload,
  compactToolContent,
  toolResultContent,
};
