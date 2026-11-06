"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MemoryJsonStorage, NullSink, clone, noopResult, safe } = require("./common.js");
const { EntropyMonitor } = require("../entropy-monitor");
const { DIAGNOSTIC_POLICIES } = require("../file-integration-storage");
const { sanitizeManagedDiagnosticState } = require("../managed-state-sanitizer");
const { ReasoningRuntime } = require("../reasoning-runtime");
const { DEFAULT_MAX_SNAPSHOT_BYTES, SessionBranchManager, applySnapshotMaintenance, sanitizeRecoveryValue, sanitizeSnapshotForStorage, snapshotMaintenancePlan } = require("../session-branches");

class EntropyPersistenceAdapter {
  constructor(storage = new MemoryJsonStorage(), prefix = "entropy") { this.storage = storage; this.prefix = prefix; }
  recordEvent(event) { this.storage.appendJsonl(`${this.prefix}/events`, sanitizeManagedDiagnosticState(event).value, DIAGNOSTIC_POLICIES.entropy); }
  // Runs on every observation, so the count is incremented rather than recomputed
  // from the unbounded snapshot history (an 88 MB re-read blocked turns for seconds).
  recordSnapshot(snapshot) { this.storage.appendJsonl(`${this.prefix}/snapshots`, sanitizeManagedDiagnosticState(snapshot).value, DIAGNOSTIC_POLICIES.entropy); this.storage.writeJson(`${this.prefix}/stats`, { count: (Number(this.loadStats().count) || 0) + 1 }); }
  loadSnapshots(limit = Infinity) { const xs = this.storage.readJsonl(`${this.prefix}/snapshots`); return Number.isFinite(limit) ? xs.slice(-limit) : xs; }
  loadStats() { return this.storage.readJson(`${this.prefix}/stats`, { count: 0 }); }
}

class EntropyAdapter {
  constructor({ enabled = true, storage = new MemoryJsonStorage(), sink = new NullSink(), options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.sink = sink;
    this.monitor = new EntropyMonitor({ ...options, persistence: options.persistence === false ? false : options.persistence || new EntropyPersistenceAdapter(storage) });
  }
  observe(event) {
    if (!this.enabled) return noopResult("entropy.observe");
    const started = performance.now();
    const r = this.monitor.observe(event);
    this.sink.emit({ type: "entropy.snapshot", entropy: r.metrics?.entropyScore, status: r.stabilization?.status });
    this.review?.observe(r, performance.now() - started);
    return r;
  }
  health() { return this.enabled ? this.monitor.health() : noopResult("entropy.health"); }
  dashboards(file) { return this.enabled ? this.monitor.dashboards(file) : noopResult("entropy.dashboards"); }
}

class ReasoningRuntimeAdapter {
  constructor({ enabled = true, storage = new MemoryJsonStorage(), storageKey = "reasoning-runtime", sink = new NullSink(), options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.storageKey = storageKey; this.sink = sink;
    this.runtime = new ReasoningRuntime({ storage, storageKey, sink, ...options });
  }
  createPlan(input) { if (!this.enabled) return noopResult("reasoning.createPlan"); return this.runtime.createPlan(input); }
  decomposeTask(input) { if (!this.enabled) return noopResult("reasoning.decomposeTask"); return this.runtime.decomposeTask(input); }
  trackHypothesis(input) { if (!this.enabled) return noopResult("reasoning.trackHypothesis"); return this.runtime.trackHypothesis(input); }
  recordDecision(input) { if (!this.enabled) return noopResult("reasoning.recordDecision"); return this.runtime.recordDecision(input); }
  recordExecutorAction(input) { if (!this.enabled) return noopResult("reasoning.recordExecutorAction"); return this.runtime.recordExecutorAction(input); }
  recordVerifierEvidence(input) { if (!this.enabled) return noopResult("reasoning.recordVerifierEvidence"); return this.runtime.recordVerifierEvidence(input); }
  addVerifierFeedback(input) { if (!this.enabled) return noopResult("reasoning.addVerifierFeedback"); return this.runtime.addVerifierFeedback(input); }
  updateMemory(input) { if (!this.enabled) return noopResult("reasoning.updateMemory"); return this.runtime.updateMemory(input); }
  createCheckpoint(input) { if (!this.enabled) return noopResult("reasoning.createCheckpoint"); return this.runtime.createCheckpoint(input); }
  compareBranches(input) { if (!this.enabled) return noopResult("reasoning.compareBranches"); return this.runtime.compareBranches(input); }
  analyzeFailure(input) { if (!this.enabled) return noopResult("reasoning.analyzeFailure"); return this.runtime.analyzeFailure(input); }
  prune(options) { if (!this.enabled) return noopResult("reasoning.prune"); return this.runtime.prune(options); }
  pruneAutomatedVerification(options) { if (!this.enabled) return noopResult("reasoning.pruneAutomatedVerification"); return this.runtime.pruneAutomatedVerification(options); }
  export(options) { return this.enabled ? this.runtime.exportPacket(options) : noopResult("reasoning.export"); }
  replay(options) { return this.enabled ? this.runtime.replay(options) : noopResult("reasoning.replay"); }
  artifacts(options) { return this.enabled ? this.runtime.publicArtifacts(options) : []; }
  persist() { if (!this.enabled) return noopResult("reasoning.persist"); return this.runtime.persist(); }
  packet() { return this.enabled ? this.runtime.resultPacket() : noopResult("reasoning.packet"); }
  // Backward-compatible name for older extension code. This records model-facing
  // scaffold artifacts only; it does not run hidden internal cognition.
  coordinate(task, options = {}) {
    if (!this.enabled) return Promise.resolve(noopResult("orchestration.coordinate"));
    const plan = this.createPlan({ objective: task, steps: options.steps || [], successCriteria: options.successCriteria || [], source: "model-or-user" });
    const decomposition = this.decomposeTask({ task, subtasks: options.subtasks || [] });
    const checkpoint = this.createCheckpoint({ kind: "plan", publicSummary: `Reasoning scaffold initialized for: ${String(task).slice(0, 160)}`, artifactIds: [plan.id, decomposition.id] });
    this.sink.emit({ type: "reasoning.coordinate", planId: plan.id, decompositionId: decomposition.id, checkpointId: checkpoint.id });
    return Promise.resolve({ enabled: true, kind: "reasoning.scaffold", task, plan, decomposition, checkpoint, artifacts: this.artifacts(), links: this.runtime.links.slice() });
  }
  metrics() { return this.runtime.metrics(); }
}

class OrchestrationAdapter extends ReasoningRuntimeAdapter {}

class MemoryBranchStore {
  constructor(storage = new MemoryJsonStorage(), prefix = "branches") { const requestedMax = Number(process.env.PI_BRANCH_SNAPSHOT_MAX_BYTES || DEFAULT_MAX_SNAPSHOT_BYTES); this.storage = storage; this.prefix = prefix; this.events = []; this.maxSnapshotBytes = Number.isFinite(requestedMax) && requestedMax >= 1024 ? requestedMax : DEFAULT_MAX_SNAPSHOT_BYTES; }
  snapshotDir(id) { return `${this.prefix}/snapshots/${id}`; }
  branchFile(id) { return `${this.prefix}/branches/${id}`; }
  saveSnapshot(snapshot) { const safe = sanitizeSnapshotForStorage(snapshot); const bytes = Buffer.byteLength(JSON.stringify(safe)); if (bytes > this.maxSnapshotBytes) { const error = new Error(`snapshot JSON exceeds ${this.maxSnapshotBytes} byte limit (${bytes})`); error.code = "PI_SNAPSHOT_SIZE_LIMIT"; throw error; } this.storage.writeJson(this.snapshotDir(safe.id), safe); return safe; }
  loadSnapshot(id) { return this.storage.readJson(this.snapshotDir(id), null); }
  saveBranch(branch) { this.storage.writeJson(this.branchFile(branch.id), sanitizeRecoveryValue(branch)); return branch; }
  loadBranch(id) { return this.storage.readJson(this.branchFile(id), null); }
  listBranches() {
    const branches = [];
    for (const [key, value] of this.storage.map || []) if (key.startsWith(`${this.prefix}/branches/`)) branches.push(clone(value));
    if (!branches.length && this.storage.root) {
      const fs = require("node:fs"); const path = require("node:path");
      const dir = path.join(this.storage.root, this.prefix, "branches");
      try { for (const file of fs.readdirSync(dir)) if (file.endsWith(".json")) branches.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))); } catch {}
    }
    return branches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  event(type, payload) { const event = { type, ...sanitizeRecoveryValue(payload) }; this.events.push(event); this.storage.appendJsonl(`${this.prefix}/events`, event); }
}

class BranchingAdapter {
  constructor({ enabled = true, cwd = process.cwd(), storage = new MemoryJsonStorage(), sink = new NullSink(), options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.sink = sink;
    this.store = options.store || new MemoryBranchStore(storage);
    this.manager = new SessionBranchManager({ cwd, store: this.store, ...options.managerOptions });
  }
  createSnapshot(state) { if (!this.enabled) return noopResult("branching.createSnapshot"); const r = this.manager.createSnapshot(state); this.sink.emit({ type: "branching.snapshot", id: r.id }); return r; }
  createBranch(request) { if (!this.enabled) return noopResult("branching.createBranch"); const r = this.manager.createBranch(request); this.sink.emit({ type: "branching.branch", id: r.id, branchType: r.type }); return r; }
  autoBranch(event, states) { if (!this.enabled) return noopResult("branching.autoBranch"); return this.manager.autoBranch(event, states); }
  getBranch(id) { return this.enabled ? this.store.loadBranch(id) : null; }
  getSnapshot(id) { return this.enabled ? this.store.loadSnapshot(id) : null; }
  checkpoint(branchId, states = {}) { if (!this.enabled) return noopResult("branching.checkpoint"); const r = this.manager.checkpoint(branchId, states); this.sink.emit({ type: "branching.checkpoint", branchId, snapshotId: r.id }); return r; }
  compare(leftBranchId, rightBranchId) { if (!this.enabled) return noopResult("branching.compare"); return this.manager.compare(leftBranchId, rightBranchId); }
  previewMerge(leftBranchId, rightBranchId) { if (!this.enabled) return noopResult("branching.previewMerge"); return this.manager.previewMerge(leftBranchId, rightBranchId); }
  merge(leftBranchId, rightBranchId, options = {}) { if (!this.enabled) return noopResult("branching.merge"); const r = this.manager.merge(leftBranchId, rightBranchId, options); this.sink.emit({ type: "branching.merge", leftBranchId, rightBranchId, ok: r.ok, conflicts: r.conflicts?.length || 0, applied: !!options.apply }); return r; }
  rollback(branchId, snapshotId = null, options = {}) { if (!this.enabled) return noopResult("branching.rollback"); const r = this.manager.rollback(branchId, snapshotId, options); this.sink.emit({ type: "branching.rollback", branchId, snapshotId: r.id }); return r; }
  list() { return this.enabled ? this.store.listBranches() : []; }
  exportBranch(id) { return this.enabled ? this.manager.exportBranch(id) : noopResult("branching.exportBranch"); }
  cleanup(options = {}) {
    if (!this.enabled) return noopResult("branching.cleanup");
    if (!this.storage.root) return { ok: false, outcome: "not-applicable", reason: "filesystem storage required" };
    const plan = snapshotMaintenancePlan(path.join(this.storage.root, this.store.prefix), options);
    return options.apply ? { plan: { schemaVersion: plan.schemaVersion, policy: plan.policy, summary: plan.summary }, result: applySnapshotMaintenance(plan, { dryRun: false }) } : { plan: { schemaVersion: plan.schemaVersion, policy: plan.policy, summary: plan.summary }, result: applySnapshotMaintenance(plan, { dryRun: true }) };
  }
  visualizeTree() { return this.enabled ? this.manager.visualizeTree() : ""; }
}

module.exports = {
  EntropyPersistenceAdapter,
  EntropyAdapter,
  ReasoningRuntimeAdapter,
  OrchestrationAdapter,
  MemoryBranchStore,
  BranchingAdapter,
};
