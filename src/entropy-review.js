"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { FileIntegrationStorage, withStorageLock } = require("./file-integration-storage");
const { hash, percentile, reviewer, safeEvidenceIds, validateReviewEvidence } = require("./reviewed-evidence");
const { showExperiment } = require("./experiment-ledger");
const EXPERIMENT_ID = "exp-entropy-warning-calibration-pilot";
const POLICY = Object.freeze({ maxCases: 100, maxDays: 45, minimumWarned: 20, minimumUnwarned: 20, actionablePrecision: 0.8, falsePositiveRate: 0.1, observationP95Ms: 10, observationShare: 0.01 });
const LATENCY_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, Number.MAX_SAFE_INTEGER];
const ACTIONS = new Set(["compact_context", "branch_session", "isolate_failing_agents", "reset_volatile_memory", "request_failure_analysis"]);

class EntropyReview {
  constructor({ cwd = process.cwd(), clock = Date.now, env = process.env } = {}) {
    this.cwd = cwd; this.clock = clock; this.active = null;
    this.storage = new FileIntegrationStorage(path.join(cwd, ".pi", "entropy-review"), { maxJsonBytes: 1024 * 1024 });
    this.sourceHash = hash(["entropy-monitor.js", "entropy-review.js", "integration-boundary.js", "file-integration-storage.js", "reviewed-evidence.js"].map(file => fs.readFileSync(path.join(__dirname, file), "utf8")));
    this.configurationHash = hash([env.PI_COGNITIVE_ENTROPY_ENABLED, env.PI_COGNITIVE_TIMING, env.PI_TRACE_ENABLED, env.PI_TRACE_CAPTURE_PAYLOADS]);
  }
  state() {
    const state = this.storage.readJson("cohort");
    if (!state && fs.existsSync(this.storage.jsonPath("cohort"))) throw new Error("entropy review state is unreadable; preserve it");
    return state;
  }
  initialize() {
    return withStorageLock(this.storage.jsonPath("cohort"), () => {
      const prior = this.state(); if (prior) return prior;
      if (showExperiment(this.cwd, EXPERIMENT_ID)?.status !== "open") throw new Error("entropy calibration must be preregistered");
      const state = { schemaVersion: 1, status: "collecting", experimentId: EXPERIMENT_ID, policy: POLICY, createdAt: new Date(this.clock()).toISOString(), sourceHash: this.sourceHash, configurationHash: this.configurationHash, cases: [] };
      this.storage.writeJson("cohort", state); return state;
    });
  }
  begin({ interactive, sessionId, requestId }) {
    if (!interactive || !sessionId || !requestId) return;
    if (this.active) this.settle();
    const state = this.state();
    if (!state || state.status !== "collecting" || state.cases.length >= POLICY.maxCases || this.clock() - Date.parse(state.createdAt) >= POLICY.maxDays * 86400000) return;
    if (state.sourceHash !== this.sourceHash || state.configurationHash !== this.configurationHash) return;
    const caseId = `incident_${hash([sessionId, requestId]).slice(7, 31)}`;
    if (state.cases.some(c => c.caseId === caseId)) return;
    this.active = { caseId, sessionIdHash: hash(sessionId), startedAt: new Date(this.clock()).toISOString(), startedMonotonic: performance.now(), observationCount: 0, observationMs: 0, observationMaxMs: 0, observationHistogram: LATENCY_BUCKETS.map(() => 0), firstWarningMs: null, actions: [], review: null };
  }
  observe(snapshot, elapsedMs) {
    if (!this.active) return;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("invalid diagnostic duration");
    const row = this.active;
    row.observationHistogram[LATENCY_BUCKETS.findIndex(bound => elapsedMs <= bound)]++;
    row.observationCount++; row.observationMs += elapsedMs; row.observationMaxMs = Math.max(row.observationMaxMs, elapsedMs);
    const actions = (snapshot.stabilization?.actions || []).map(a => a.type).filter(a => ACTIONS.has(a));
    if (actions.length && row.firstWarningMs === null) row.firstWarningMs = Math.max(0, this.clock() - Date.parse(row.startedAt));
    row.actions = [...new Set([...row.actions, ...actions])];
  }
  settle() {
    if (!this.active) return null;
    const { startedMonotonic, ...row } = this.active; this.active = null;
    row.elapsedMs = Math.max(1, performance.now() - startedMonotonic); row.settledAt = new Date(this.clock()).toISOString();
    return withStorageLock(this.storage.jsonPath("cohort"), () => {
      const state = this.state();
      if (!state || state.cases.length >= POLICY.maxCases || state.cases.some(c => c.caseId === row.caseId)) return null;
      state.cases.push(row); this.storage.writeJson("cohort", state); return row;
    });
  }
  review(caseId, input) {
    const reviewerHash = reviewer(input), evidenceIds = safeEvidenceIds(input.evidenceIds);
    if (typeof input.incident !== "boolean" || typeof input.actionable !== "boolean" || typeof input.privacyViolation !== "boolean") throw new Error("incident, actionable and privacyViolation require explicit boolean labels");
    if (input.actionable && !input.incident) throw new Error("actionable warning requires a real incident");
    return withStorageLock(this.storage.jsonPath("cohort"), () => {
      const state = this.state(), row = state?.cases.find(c => c.caseId === caseId);
      if (!row) throw new Error("unknown settled incident case");
      if (row.review) throw new Error("incident already reviewed");
      validateReviewEvidence(this.cwd, evidenceIds, { minCreatedAt: row.startedAt });
      if (input.incident && (!Number.isFinite(input.incidentOffsetMs) || input.incidentOffsetMs < 0 || input.incidentOffsetMs > Date.parse(row.settledAt) - Date.parse(row.startedAt))) throw new Error("incidentOffsetMs must locate the incident within the task");
      row.review = { reviewerHash, evidenceIds, reviewedAt: new Date(this.clock()).toISOString(), incident: input.incident, actionable: input.actionable, privacyViolation: input.privacyViolation, incidentOffsetMs: input.incident ? input.incidentOffsetMs : null };
      if (input.privacyViolation) state.status = "stopped";
      this.storage.writeJson("cohort", state); return row;
    });
  }
  stop() {
    return withStorageLock(this.storage.jsonPath("cohort"), () => { const state = this.state(); if (state) { state.status = "stopped"; this.storage.writeJson("cohort", state); } return { status: state?.status || "not-initialized" }; });
  }
  report() {
    const state = this.state(); if (!state) return { status: "not-initialized", interventionsAuthorized: false };
    const rows = state.cases, reviewed = rows.filter(r => r.review), warned = reviewed.filter(r => r.actions.length), unwarned = reviewed.filter(r => !r.actions.length), negatives = reviewed.filter(r => !r.review.incident);
    const precision = warned.length ? warned.filter(r => r.review.actionable).length / warned.length : null;
    const fpr = negatives.length ? negatives.filter(r => r.actions.length).length / negatives.length : null;
    const histogram = LATENCY_BUCKETS.map((_, i) => rows.reduce((sum, row) => sum + row.observationHistogram[i], 0));
    const observations = histogram.reduce((sum, count) => sum + count, 0);
    let cumulative = 0;
    const p95Bucket = histogram.findIndex(count => (cumulative += count) >= observations * 0.95);
    const observationUpperP95Ms = observations ? LATENCY_BUCKETS[p95Bucket] : null;
    const overheadShare = rows.length ? rows.reduce((s, r) => s + r.observationMs, 0) / rows.reduce((s, r) => s + r.elapsedMs, 0) : null;
    const violations = reviewed.filter(r => r.review.privacyViolation).length;
    const identityMatches = state.sourceHash === this.sourceHash && state.configurationHash === this.configurationHash;
    const complete = identityMatches && observations > 0 && warned.length >= POLICY.minimumWarned && unwarned.length >= POLICY.minimumUnwarned && negatives.length > 0 && reviewed.length === rows.length;
    const pass = complete && precision >= POLICY.actionablePrecision && fpr <= POLICY.falsePositiveRate && observationUpperP95Ms <= POLICY.observationP95Ms && overheadShare <= POLICY.observationShare && !violations;
    return { status: state.status, experimentId: EXPERIMENT_ID, sourceHash: state.sourceHash, policy: POLICY, cases: rows.length, reviewed: reviewed.length, identityMatches, observations, warned: warned.length, unwarned: unwarned.length, actionablePrecision: precision, falsePositiveRate: fpr, observationUpperP95Ms, overheadShare, violations, detectionLagP95Ms: percentile(warned.filter(r => r.review.incident).map(r => r.firstWarningMs - r.review.incidentOffsetMs)), verdict: violations ? "fail" : !complete ? "insufficient-data" : pass ? "ready-for-human-decision" : "fail", interventionsAuthorized: false, pending: rows.filter(r => !r.review) };
  }
}
module.exports = { EntropyReview, POLICY, EXPERIMENT_ID };
