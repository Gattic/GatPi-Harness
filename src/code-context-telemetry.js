"use strict";

const crypto = require("node:crypto");
const ALLOWED_EVENTS = new Set(["query.classified", "budget.planned", "provider.started", "provider.completed", "provider.degraded", "candidates.retrieved", "candidates.deduped", "candidates.ranked", "candidates.selected", "context.packed", "content.ref_reused", "content.expanded", "tests.proposed", "tests.executed", "edit.localized", "verification.linked"]);
function hash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20); }
function sanitize(value, options = {}, depth = 0) {
  if (depth > 4) return "[bounded]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, options.maxString || 300);
  if (Array.isArray(value)) return value.slice(0, options.maxItems || 30).map((item) => sanitize(item, options, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:source|body|content|transcript|prompt|raw|before|after|workspaceEdit)$/i.test(key)) continue;
    if (/snippet|preview|context/i.test(key) && !options.captureSnippets) continue;
    out[key] = sanitize(item, options, depth + 1);
  }
  return out;
}
class CodeContextTelemetry {
  constructor(options = {}) { this.emitter = typeof options.emit === "function" ? options.emit : null; this.sessionId = options.sessionId || null; this.projectId = options.projectId || null; this.captureSnippets = options.captureSnippets === true || process.env.PI_CODE_CONTEXT_TELEMETRY_SNIPPETS === "1"; this.counts = {}; }
  setContext(input = {}) { this.sessionId = input.sessionId || this.sessionId; this.projectId = input.projectId || this.projectId; }
  emit(name, payload = {}) {
    if (!ALLOWED_EVENTS.has(name)) return { emitted: false, reason: "unsupported-event" };
    this.counts[name] = (this.counts[name] || 0) + 1;
    if (!this.emitter) return { emitted: false, reason: "no-subscriber" };
    const event = { schemaVersion: 1, name, eventId: `retrieval_${hash(`${name}:${payload.queryId || payload.runId || ""}:${this.counts[name]}`)}`, sessionId: this.sessionId, projectId: this.projectId, queryId: payload.queryId, strategyId: payload.strategyId, runId: payload.runId, rolloutMode: payload.rolloutMode, payload: sanitize(payload, { captureSnippets: this.captureSnippets }) };
    try { this.emitter(event); return { emitted: true, eventId: event.eventId }; } catch { return { emitted: false, reason: "emitter-failed" }; }
  }
  async span(name, payload, fn) { const started = Date.now(); this.emit(`${name}.started`, payload); try { const result = await fn(); this.emit(`${name}.completed`, { ...payload, durationMs: Date.now() - started }); return result; } catch (error) { this.emit("provider.degraded", { ...payload, durationMs: Date.now() - started, code: error.code, messageHash: hash(error.message) }); throw error; } }
  status() { return { enabled: Boolean(this.emitter), sessionId: this.sessionId, projectId: this.projectId, captureSnippets: this.captureSnippets, counts: { ...this.counts } }; }
}
function createCodeContextTelemetry(options) { return new CodeContextTelemetry(options); }
module.exports = { ALLOWED_EVENTS, hash, sanitize, CodeContextTelemetry, createCodeContextTelemetry };
