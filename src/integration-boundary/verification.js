"use strict";

const { MemoryJsonStorage, NullSink, clone, noopResult } = require("./common.js");
const { captureTreeFingerprint, compareTreeFingerprint, treeFingerprintSummary } = require("../tree-fingerprint.js");
const { captureWorkingTreeChangeSet } = require("../verification-change-set.js");
const { VerifiedExecutionPipeline, summarizeVerificationResult } = require("../verification-pipeline");

class MemoryVerificationCache {
  constructor() { this.map = new Map(); }
  key(verifier, impact, context) { return JSON.stringify({ verifier: verifier.fingerprint, fingerprint: context.fingerprint, changedFiles: impact.changedFiles, categories: impact.categories }); }
  get(key) { return this.map.get(key) || null; }
  set(key, value) { this.map.set(key, clone(value)); }
}

class MemoryEvidenceStore {
  constructor(storage = new MemoryJsonStorage(), keyPrefix = "verification/evidence") { this.storage = storage; this.keyPrefix = keyPrefix; }
  write(evidence) { const key = `${this.keyPrefix}/${evidence.id}`; this.storage.writeJson(key, evidence); return `memory://${key}`; }
  read(id) { if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(id || ""))) throw new Error("invalid evidence id"); return this.storage.readJson(`${this.keyPrefix}/${id}`, null); }
}

class MemoryVerificationMetrics {
  constructor(storage = new MemoryJsonStorage(), key = "verification/metrics") { this.storage = storage; this.key = key; this.state = storage.readJson(key, { runs: 0, passes: 0, failures: 0, retries: 0, regressions: 0, flaky: {}, validators: {} }); }
  record(evidence) { this.state.runs++; if (evidence.ok) this.state.passes++; else this.state.failures++; this.storage.writeJson(this.key, this.state); }
  snapshot() { return { ...this.state, passRate: this.state.runs ? this.state.passes / this.state.runs : 1, retryRate: this.state.runs ? this.state.retries / this.state.runs : 0, regressionFrequency: 0 }; }
}

class VerificationAdapter {
  constructor({ enabled = true, verifiers = [], policies, storage = new MemoryJsonStorage(), sink = new NullSink(), options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.sink = sink;
    this.pipeline = new VerifiedExecutionPipeline({
      verifiers,
      policies,
      cache: options.cache || new MemoryVerificationCache(),
      evidenceStore: options.evidenceStore || new MemoryEvidenceStore(storage),
      metrics: options.metrics || new MemoryVerificationMetrics(storage),
      requiredKinds: options.requiredKinds || [],
      feedbackSinks: [
        (e) => sink.emit({ type: "verification.evidence", ok: e.ok, id: e.id, confidence: e.confidence }),
        ...(options.feedbackSinks || []),
      ],
      ...options.pipelineOptions,
    });
  }
  captureChangeSet(request) { if (!this.enabled) return Promise.resolve(noopResult("verification.captureChangeSet")); return captureWorkingTreeChangeSet(request); }
  captureTreeFingerprint(cwd, options) { return this.enabled ? captureTreeFingerprint(cwd, options) : noopResult("verification.captureTreeFingerprint"); }
  compareTreeFingerprint(cwd, evidence, options) { return this.enabled ? compareTreeFingerprint(cwd, evidence, options) : noopResult("verification.compareTreeFingerprint"); }
  treeFingerprintSummary(value) { return this.enabled ? treeFingerprintSummary(value) : noopResult("verification.treeFingerprintSummary"); }
  verify(request) { if (!this.enabled) return Promise.resolve(noopResult("verification.verify")); return this.pipeline.verify(request); }
  execute(request) { if (!this.enabled) return Promise.resolve(noopResult("verification.execute")); return this.pipeline.execute(request); }
  summarize(result, options) { return summarizeVerificationResult(result, options); }
  metrics() { return this.pipeline.metrics.snapshot(); }
}

module.exports = {
  MemoryVerificationCache,
  MemoryEvidenceStore,
  MemoryVerificationMetrics,
  VerificationAdapter,
};
