"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicJson } = require("./code-content-cache.js");
const { normalizeRepositoryPath } = require("./code-context-revision.js");
const MAX_EDGES = 5000;
const MAX_TESTS = 1000;

const DYNAMIC_RELATIONS = new Set(["covered", "loaded", "called"]);
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function percentile(values, p) { const rows = values.filter(Number.isFinite).sort((a, b) => a - b); if (!rows.length) return null; return rows[Math.min(rows.length - 1, Math.floor((rows.length - 1) * p))]; }
class TestEvidenceIndex {
  constructor(root, options = {}) { this.root = path.resolve(root); this.file = path.resolve(options.file || path.join(this.root, ".pi", "code-context", "test-evidence.json")); this.edges = new Map(); this.durations = new Map(); this.load(); }
  load() { try { const value = JSON.parse(fs.readFileSync(this.file, "utf8")); for (const item of value.edges || []) this.edges.set(item.id, item); for (const [test, rows] of Object.entries(value.durations || {})) this.durations.set(test, rows); } catch {} }
  persist() { atomicJson(this.file, { schemaVersion: 1, edges: Array.from(this.edges.values()).sort((a, b) => a.id.localeCompare(b.id)), durations: Object.fromEntries(Array.from(this.durations.entries()).sort(([a], [b]) => a.localeCompare(b))) }); return this.file; }
  ingest(rows, options = {}) {
    const accepted = [], rejected = [];
    for (const row of rows || []) {
      const relation = row.relation || row.type;
      if (!row.test || !row.entity || !DYNAMIC_RELATIONS.has(relation)) { rejected.push({ row, reason: "test/entity and covered|loaded|called relation required" }); continue; }
      const item = { id: row.id || `testedge_${hash({ test: row.test, entity: row.entity, relation, configuration: row.configuration || options.configuration || "default", revision: row.revision || options.revision }).slice(0, 24)}`, test: String(row.test).replace(/\\/g, "/"), entity: String(row.entity).replace(/\\/g, "/"), relation, configuration: row.configuration || options.configuration || "default", revision: row.revision || options.revision || "unknown", confidence: Math.max(0, Math.min(1, Number(row.confidence || (relation === "covered" ? 0.98 : relation === "called" ? 0.95 : 0.9)))), freshness: row.freshness || "fresh", gatingSafe: row.gatingSafe !== false, evidenceRef: row.evidenceRef || options.evidenceRef || null };
      try { item.test = normalizeRepositoryPath(this.root, item.test); item.entity = normalizeRepositoryPath(this.root, item.entity); }
      catch { rejected.push({ reason: "outside-repository" }); continue; }
      if (!this.edges.has(item.id) && this.edges.size >= MAX_EDGES && item.revision !== "unknown" && item.freshness === "fresh" && item.gatingSafe) {
        // Qualified observations supersede other revisions only within their configuration.
        // Historical evidence and other configurations have independent lifetimes.
        for (const [id, previous] of this.edges) {
          if (!previous.historical && previous.configuration === item.configuration && previous.revision !== item.revision) this.edges.delete(id);
        }
      }
      if (!this.edges.has(item.id) && this.edges.size >= MAX_EDGES) { rejected.push({ reason: "evidence-capacity" }); continue; }
      this.edges.set(item.id, item); accepted.push(item);
      if (Number.isFinite(Number(row.durationMs))) this.recordDuration(item.test, Number(row.durationMs));
    }
    return { accepted, rejected };
  }
  ingestHistorical(rows, options = {}) {
    const accepted = [];
    for (const row of rows || []) {
      if (!row.test || !row.entity) continue;
      const item = { id: row.id || `history_${hash({ test: row.test, entity: row.entity, commit: row.commit || row.revision }).slice(0, 24)}`, test: String(row.test).replace(/\\/g, "/"), entity: String(row.entity).replace(/\\/g, "/"), relation: row.relation || "co-change", configuration: row.configuration || "default", revision: row.revision || "historical", confidence: Math.min(0.49, Math.max(0, Number(row.confidence || 0.35))), freshness: row.freshness || "fresh", gatingSafe: false, historical: true, evidenceRef: row.commit || row.evidenceRef || options.evidenceRef || null };
      if (!this.edges.has(item.id) && this.edges.size >= MAX_EDGES) break;
      this.edges.set(item.id, item); accepted.push(item);
    }
    return accepted;
  }
  recordDuration(test, durationMs) { if (!this.durations.has(test) && this.durations.size >= MAX_TESTS) return; const values = this.durations.get(test) || []; values.push(Math.max(0, durationMs)); this.durations.set(test, values.slice(-100)); }
  estimatedRuntime(test) { const values = this.durations.get(test) || []; return percentile(values, 0.5) || 1000; }
  durationStats(test) { const values = this.durations.get(test) || []; return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null }; }
  queryEntity(entity, options = {}) {
    return Array.from(this.edges.values()).filter(item => item.entity === entity && item.configuration === (options.configuration || "default")).map(item => {
      const current = Boolean(options.revision && item.revision !== "unknown" && item.revision === options.revision && item.freshness === "fresh");
      return { ...item, freshness: current ? "fresh" : "stale", gatingSafe: current && item.gatingSafe === true && !item.historical, estimatedRuntimeMs: this.estimatedRuntime(item.test) };
    }).sort((a, b) => b.confidence - a.confidence || a.test.localeCompare(b.test));
  }
  summary() { return { edges: this.edges.size, testsWithDurations: this.durations.size, historical: Array.from(this.edges.values()).filter((item) => item.historical).length }; }
}

module.exports = { DYNAMIC_RELATIONS, percentile, TestEvidenceIndex };
