"use strict";

/** Reusable trace observability runtime. Pi extensions/core should map events into this API. */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { TraceAdapter, MemoryJsonStorage, NullSink, RecordingSink } = require("./integration-boundary");
const { sanitizeManagedDiagnosticState, sanitizeManagedStateValue } = require("./managed-state-sanitizer");
const { FileIntegrationStorage } = require("./file-integration-storage");
const { DEFAULT_HEADROOM_RATIO, retainTraceFiles, traceProjectPrefix } = require("./trace-retention");

const TRACE_CATEGORIES = Object.freeze([
  "prompt_assembly", "context_injection", "memory_retrieval", "tool_exposure",
  "model_request", "model_response", "token_accounting", "retry", "compaction",
  "file_edit", "shell_execution", "verifier_result", "agent_branching",
  "failure_state", "cancellation", "session", "message", "performance", "retrieval",
]);

function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function stableStringify(value) { return JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v, 2) ?? "null"; }
function nowIso() { return new Date().toISOString(); }
function truncate(s, n = 1200) { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n)}…<${s.length - n} chars>` : s; }
function normalizeTraceEvent(event = {}) {
  return {
    event_id: event.event_id || event.id || crypto.randomUUID(),
    timestamp: event.timestamp || nowIso(),
    monotonic_ms: event.monotonic_ms || (typeof performance !== "undefined" ? performance.now() : Date.now()),
    category: TRACE_CATEGORIES.includes(event.category) ? event.category : "session",
    name: event.name || event.type || "event",
    correlation_id: event.correlation_id || event.correlationId || crypto.randomUUID(),
    parent_event_id: event.parent_event_id || event.parentId,
    session_id: event.session_id || event.sessionId,
    agent_id: event.agent_id || event.agentId,
    subsystem: event.subsystem || "pi",
    severity: event.severity || "info",
    payload: event.payload,
    duration_ms: event.duration_ms ?? event.durationMs,
  };
}

class TraceMetrics {
  constructor() { this.subsystems = new Map(); this.categories = new Map(); }
  observe(e) {
    const s = this.subsystems.get(e.subsystem) || { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    s.count++; if (e.severity === "error" || e.severity === "fatal") s.errors++;
    if (e.duration_ms) { s.totalMs += e.duration_ms; s.maxMs = Math.max(s.maxMs, e.duration_ms); }
    this.subsystems.set(e.subsystem, s);
    this.categories.set(e.category, (this.categories.get(e.category) || 0) + 1);
  }
  json() { return { subsystems: Object.fromEntries([...this.subsystems].map(([k, v]) => [k, { ...v, avgMs: v.count ? v.totalMs / v.count : 0 }])), categories: Object.fromEntries(this.categories) }; }
}

class FailureAnalyzer {
  constructor({ sink = new NullSink(), max = 200 } = {}) { this.sink = sink; this.max = max; this.recent = []; }
  observe(e, emit) {
    this.recent.push(e); this.recent = this.recent.slice(-this.max);
    if (e.category === "retry" && this.recent.filter((x) => x.category === "retry" && x.correlation_id === e.correlation_id).length >= 3) {
      emit({ category: "failure_state", name: "detected.retry_loop", subsystem: "trace.analyzer", severity: "warn", correlation_id: e.correlation_id, payload: { window: this.recent.length } });
    }
    if ((e.severity === "error" || e.severity === "fatal") && this.recent.filter((x) => x.name === e.name && x.subsystem === e.subsystem && (x.severity === "error" || x.severity === "fatal")).length >= 3) {
      emit({ category: "failure_state", name: "detected.recursive_failure", subsystem: "trace.analyzer", severity: "warn", correlation_id: e.correlation_id, payload: { name: e.name, subsystem: e.subsystem } });
    }
  }
}

class FileTraceStorage {
  constructor({ root = path.join(process.env.HOME || ".", ".pi", "agent", "traces"), sessionId = "trace", rotateBytes = 25 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024, headroomRatio = DEFAULT_HEADROOM_RATIO, maxFiles = 200, maxAgeDays = 14, cwd = process.cwd(), compressPayloadBytes = 32 * 1024, capturePayloads = false } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("invalid trace session id");
    if (![rotateBytes, maxTotalBytes, maxFiles, maxAgeDays].every((value) => Number.isFinite(value) && value > 0)) throw new Error("trace retention limits must be positive finite numbers");
    if (!(Number.isFinite(headroomRatio) && headroomRatio >= 0 && headroomRatio < 1)) throw new Error("trace headroom ratio must be in [0, 1)");
    this.root = root; this.sessionId = sessionId; this.rotateBytes = rotateBytes; this.maxTotalBytes = maxTotalBytes; this.headroomRatio = headroomRatio; this.compressPayloadBytes = compressPayloadBytes; this.capturePayloads = capturePayloads; this.seq = 0;
    this.maxFiles = maxFiles; this.maxAgeDays = maxAgeDays; this.cwd = cwd; this.bytesSinceRetention = 0;
    this.files = new FileIntegrationStorage(root);
    this.fileKey = `${traceProjectPrefix(cwd)}${sessionId}`;
    this.file = path.join(root, `${this.fileKey}.jsonl`);
    this.leaseKey = `.active-${sessionId}-${process.pid}-${crypto.randomUUID()}`;
    this.files.writeJson(this.leaseKey, { pid: process.pid, file: path.basename(this.file) });
    try { this.enforceRetention(); }
    catch (error) { this.files.deleteJson(this.leaseKey); throw error; }
  }
  path() { return this.file; }
  write(event) {
    const e = this.materialize(event);
    if (this.closed) throw new Error("trace storage is closed");
    this.files.appendJsonl(this.fileKey, e);
    this.bytesSinceRetention += Buffer.byteLength(JSON.stringify(e)) + 1;
    this.seq++; this.rotateIfNeeded();
    if (this.bytesSinceRetention >= 256 * 1024) this.enforceRetention();
    return this.file;
  }
  materialize(e) {
    if (!this.capturePayloads) {
      const metadata = {};
      for (const key of Object.keys(e || {})) {
        if (key !== "payload") metadata[key] = e[key];
      }
      return { ...sanitizeManagedStateValue(metadata), payload: undefined };
    }
    const sanitized = sanitizeManagedStateValue(e);
    if (sanitized.payload == null) return { ...sanitized, payload: undefined };
    const materialized = { ...sanitized, payload: sanitizeManagedDiagnosticState(sanitized.payload).value };
    const text = stableStringify(materialized.payload);
    if (Buffer.byteLength(text) <= this.compressPayloadBytes) return materialized;
    const gz = zlib.gzipSync(Buffer.from(text));
    return { ...materialized, payload: undefined, payload_ref: { encoding: "gzip+base64", sha256: sha256(text), original_bytes: Buffer.byteLength(text), data: gz.toString("base64") } };
  }
  rotateIfNeeded() {
    if (fs.existsSync(this.file) && fs.statSync(this.file).size >= Math.min(this.rotateBytes, this.maxTotalBytes)) {
      fs.renameSync(this.file, `${this.file}.${Date.now()}.${this.seq}`);
      this.enforceRetention();
    }
  }
  enforceRetention() {
    this.retention = retainTraceFiles(this.root, { cwd: this.cwd, maxTotalBytes: this.maxTotalBytes, headroomRatio: this.headroomRatio, maxFiles: this.maxFiles, maxAgeDays: this.maxAgeDays, apply: true });
    this.bytesSinceRetention = 0;
    return this.retention;
  }
  close() {
    if (this.closed) return;
    this.files.deleteJson(this.leaseKey);
    this.closed = true;
    this.enforceRetention();
  }
  readEvents() { return ReplayIndex.readEvents(this.file); }
}

class ReplayIndex {
  static readEvents(file) {
    try { return fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  }
  static summary(events) { return { steps: events.length, categories: events.reduce((m, e) => (m[e.category] = (m[e.category] || 0) + 1, m), {}), first: events[0]?.timestamp, last: events.at(-1)?.timestamp }; }
  static export(events, correlationId) { return correlationId ? events.filter((e) => e.correlation_id?.startsWith(correlationId) || e.correlation_id === correlationId) : events; }
}

class TraceRuntime {
  constructor({ enabled = true, storage, sink = new NullSink(), maxRecent = 500, sessionId = "trace", root, cwd, rotateBytes, maxTotalBytes, headroomRatio, maxFiles, maxAgeDays, compressPayloadBytes, capturePayloads, clock = () => Date.now() } = {}) {
    this.enabled = enabled; this.sink = sink; this.maxRecent = maxRecent; this.clock = clock; this.recentEvents = []; this.metrics = new TraceMetrics(); this.analyzer = new FailureAnalyzer({ sink }); this.correlationId = crypto.randomUUID();
    this.storage = storage || (this.enabled ? new FileTraceStorage({ root, cwd, sessionId, rotateBytes, maxTotalBytes, headroomRatio, maxFiles, maxAgeDays, compressPayloadBytes, capturePayloads }) : {});
  }
  setCorrelation(id = crypto.randomUUID()) { this.correlationId = id; return id; }
  emit(event) {
    if (!this.enabled) return { enabled: false, skipped: true };
    const e = normalizeTraceEvent({ correlation_id: this.correlationId, ...event });
    this.recentEvents.push(e); this.recentEvents = this.recentEvents.slice(-this.maxRecent);
    this.metrics.observe(e); if (this.storage.write) this.storage.write(e); else this.storage.appendJsonl?.("trace/events", e); this.sink.emit({ type: "trace.event", category: e.category, name: e.name, severity: e.severity });
    this.analyzer.observe(e, (derived) => this.emit(derived));
    return e;
  }
  async span(base, fn) { const start = this.clock(); const opened = this.emit({ ...base, name: `${base.name}.start` }); try { const result = await fn(); this.emit({ ...base, name: `${base.name}.end`, parent_event_id: opened.event_id, duration_ms: this.clock() - start }); return result; } catch (error) { this.emit({ ...base, category: "failure_state", name: `${base.name}.error`, parent_event_id: opened.event_id, severity: "error", duration_ms: this.clock() - start, payload: { message: error.message, stack: error.stack } }); throw error; } }
  recent(limit = 50) { return this.recentEvents.slice(-limit); }
  events() { return this.storage.readEvents?.() || this.storage.readJsonl?.("trace/events") || this.recentEvents.slice(); }
  status() { return { trace_file: this.storage.path?.(), metrics: this.metrics.json(), recent: this.recentEvents.length, enabled: this.enabled, retention: this.storage.retention }; }
  close() { this.storage.close?.(); }
  replaySummary() { return ReplayIndex.summary(this.events()); }
  export(correlationId) { return ReplayIndex.export(this.events(), correlationId); }
}

function createTraceRuntime(options = {}) { return new TraceRuntime(options); }

module.exports = { TRACE_CATEGORIES, TraceAdapter, MemoryJsonStorage, NullSink, RecordingSink, TraceMetrics, FailureAnalyzer, FileTraceStorage, ReplayIndex, TraceRuntime, createTraceRuntime, normalizeTraceEvent, sha256, stableStringify, truncate };
