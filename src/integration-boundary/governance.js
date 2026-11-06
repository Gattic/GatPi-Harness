"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { MemoryJsonStorage, NullSink, clone, noopResult } = require("./common.js");
const { ExecutionOutcomeStore, buildGoalOutcomePacket, buildGoalSettlementPacket, buildLoopOutcomePacket, buildLoopSettlementPacket, validateExecutionOutcomePacket } = require("../execution-outcome");
const { FileIntegrationStorage } = require("../file-integration-storage");
const { dispatchGoalAction, parseGoalDecision, topologyAuthority, validateGoalAction, validateGoalDecisionForContext, validateGoalDecisionV3 } = require("../goal-controller-actions");
const { DEFAULT_BASE_URL: TYPESAFE_DEFAULT_BASE_URL, createTypeSafeClient } = require("../typesafe-client");
const { buildTurnRecord, turnRecordDir } = require("../typesafe-evaluation");
const { buildTurnRequest, decideTurn, redactTurnPrompt, turnJudgmentModes } = require("../typesafe-turn-judgment");
const { EvidenceStore } = require("../verification-pipeline");

class GoalControllerAdapter {
  constructor({ enabled = true } = {}) { this.enabled = enabled !== false; }
  parseDecision(value, options = {}) {
    if (!this.enabled) throw new Error("goal controller adapter is disabled");
    return parseGoalDecision(value, options);
  }
  validateDecisionV3(value) {
    if (!this.enabled) throw new Error("goal controller adapter is disabled");
    return validateGoalDecisionV3(value);
  }
  validateDecisionForContext(value, context = {}) {
    if (!this.enabled) throw new Error("goal controller adapter is disabled");
    return validateGoalDecisionForContext(value, context);
  }
  validateAction(value) {
    if (!this.enabled) throw new Error("goal controller adapter is disabled");
    return validateGoalAction(value);
  }
  dispatch(action, state = {}) {
    if (!this.enabled) return { ...noopResult("goalController.dispatch"), ok: false, dispatchMode: "rejected", reasonCode: "goal-controller-disabled" };
    return dispatchGoalAction(action, state);
  }
  authority(topologyId, state = {}) {
    if (!this.enabled) return { allowed: false, reasonCode: "goal-controller-disabled", topologyId, mutationCapable: null, mutationApproved: false };
    return topologyAuthority(topologyId, state);
  }
}

class GoalEvidenceAdapter {
  constructor({ enabled = true, cwd = process.cwd(), root, store } = {}) {
    this.enabled = enabled !== false;
    this.cwd = cwd;
    this.root = root;
    this.store = store || null;
  }
  evidenceStore() {
    if (!this.enabled) return null;
    if (!this.store) {
      const { EvidenceStore: GoalEvidenceStore } = require("../evidence-binder");
      this.store = new GoalEvidenceStore({ cwd: this.cwd, ...(this.root ? { root: this.root } : {}) });
    }
    return this.store;
  }
  validateCompletion({ evidenceIds = [], goalCreatedAt, expectedFingerprints = {} } = {}) {
    if (!this.enabled) return { ...noopResult("goalEvidence.validateCompletion"), ok: false, reason: "goal-evidence-disabled", results: [] };
    return this.evidenceStore().validateEvidenceIds(evidenceIds, { requireOk: true, minCreatedAt: goalCreatedAt, expectedFingerprints, includeEvidence: false });
  }
  provenanceRecords({ limit = 200 } = {}) {
    if (!this.enabled) return { evidence: [] };
    return { evidence: this.evidenceStore().listEvidence({ limit }).map((item) => ({ id: item.id, createdAt: item.createdAt, ok: item.ok === true, fingerprint: item.fingerprint, source: item.source })) };
  }
}

class LearningLoopAdapter {
  constructor({ enabled = true, cwd = process.cwd(), root, store } = {}) {
    this.enabled = enabled !== false;
    this.cwd = cwd;
    this.root = root || path.join(cwd, ".pi", "learning-loop");
    this.store = store || null;
  }
  learning() {
    if (!this.enabled) return null;
    if (!this.store) {
      const { LearningStore } = require("../learning-loop");
      this.store = new LearningStore({ cwd: this.cwd, root: this.root });
    }
    return this.store;
  }
  captureExecutionOutcome(packet) {
    if (!this.enabled) return noopResult("learning.captureExecutionOutcome");
    const { executionOutcomeToLearningInput } = require("../learning-loop");
    return this.learning().recordOutcome(executionOutcomeToLearningInput(packet));
  }
  compoundingRecords(options) { return this.enabled ? this.learning().compoundingRecords(options) : { outcomes: [], patterns: [], proposals: [], decisions: [] }; }
  provenanceRecords({ limit = 200 } = {}) {
    if (!this.enabled) return { outcomes: [], patterns: [], proposals: [], decisions: [] };
    const store = this.learning();
    const outcomes = store.listOutcomes({ limit }).map((item) => ({ outcomeId: item.outcomeId, createdAt: item.createdAt, source: item.source, fingerprint: item.fingerprint, signals: { status: item.signals?.status || "unknown" }, artifacts: { evidenceRefs: (item.artifacts?.evidenceRefs || []).slice(0, 64), traceRefs: (item.artifacts?.traceRefs || []).slice(0, 64) } }));
    const patterns = store.listPatterns({ limit }).map((item) => ({ patternId: item.patternId, observedAt: item.observedAt, status: item.status, fingerprint: item.fingerprint, outcomeIds: (item.outcomeIds || item.sourceOutcomeIds || item.linkedOutcomeIds || []).slice(0, 64) }));
    const proposals = store.listProposals({ limit }).map((item) => ({ proposalId: item.proposalId, createdAt: item.createdAt, status: item.status, evidenceRefs: (item.evidenceRefs || []).slice(0, 64), verificationResult: { evidenceRefs: (item.verificationResult?.evidenceRefs || []).slice(0, 64) }, patternIds: (item.patternIds || item.sourcePatternIds || []).slice(0, 64), outcomeIds: (item.outcomeIds || item.sourceOutcomeIds || []).slice(0, 64) }));
    return { outcomes, patterns, proposals, decisions: store.decisions({ limit }).map((item) => ({ type: item.type, outcomeId: item.outcomeId, patternId: item.patternId, proposalId: item.proposalId, status: item.status, ok: item.ok, evidenceRefs: (item.evidenceRefs || []).slice(0, 64), at: item.at })) };
  }
  status() { return this.enabled ? this.learning().status() : noopResult("learning.status"); }
}

class ExecutionOutcomeAdapter {
  constructor({ enabled = true, cwd = process.cwd(), stateDir, storage, prefix } = {}) {
    this.enabled = enabled !== false;
    this.store = this.enabled ? new ExecutionOutcomeStore({ cwd, stateDir, storage, prefix }) : null;
  }
  buildLoop(input) { return this.enabled ? buildLoopOutcomePacket(input) : noopResult("executionOutcomes.buildLoop"); }
  buildGoal(input) { return this.enabled ? buildGoalOutcomePacket(input) : noopResult("executionOutcomes.buildGoal"); }
  buildLoopSettlement(state, options) { return this.enabled ? buildLoopSettlementPacket(state, options) : null; }
  buildGoalSettlement(state, options) { return this.enabled ? buildGoalSettlementPacket(state, options) : null; }
  validate(input) { return this.enabled ? validateExecutionOutcomePacket(input) : { ...noopResult("executionOutcomes.validate"), ok: false, issues: ["disabled"] }; }
  save(input) { return this.enabled ? this.store.save(input) : noopResult("executionOutcomes.save"); }
  get(packetId) { return this.enabled ? this.store.get(packetId) : null; }
  list(options) { return this.enabled ? this.store.list(options) : []; }
  packets(options) { return this.enabled ? this.store.packets(options) : []; }
  compoundingRecords(options) { return this.enabled ? this.store.compoundingRecords(options) : { packets: [], rejections: [] }; }
  provenanceRecords({ limit = 200 } = {}) { return { packets: this.enabled ? this.store.packets({ limit }) : [] }; }
  pending(consumer, options) { return this.enabled ? this.store.pending(consumer, options) : []; }
  drain(consumer, handler, options) { return this.enabled ? this.store.drain(consumer, handler, options) : Promise.resolve(noopResult("executionOutcomes.drain")); }
}

const TYPESAFE_TURN_RECORDS_KEEP = 5000;

function promptHash(text) { return crypto.createHash("sha256").update(String(text || "").trim()).digest("hex"); }

class SystemOneAdapter {
  // persist: write field records to the shared turnRecordDir(env); otherwise
  // they stay in memory.
  constructor({ enabled = true, persist = false, storage = null, sink = new NullSink(), env = process.env, client = null, clock = () => new Date().toISOString() } = {}) {
    const { modes, invalidSettings, childSession } = turnJudgmentModes(env);
    this.enabled = enabled;
    this.modes = modes;
    this.invalidSettings = invalidSettings;
    this.childSession = childSession;
    this.storage = storage || (persist ? new FileIntegrationStorage(turnRecordDir(env)) : new MemoryJsonStorage());
    this.sink = sink;
    this.client = client || createTypeSafeClient({ env, model: env.PI_JEV_MODEL || undefined });
    this.clock = clock;
    this.turn = null;
    this.sequence = 0;
    this.outcomes = {};
  }
  active() { return this.enabled && this.modes.intent !== "off"; }
  startTurn({ text, source } = {}) {
    this.turn = null;
    if (!this.active()) return null;
    const raw = String(text || "").trim();
    if (!raw || raw.startsWith("/") || source === "extension") return null;
    const request = buildTurnRequest({ redactedPrompt: redactTurnPrompt(raw) });
    if (!request) return null;
    const promise = this.client.systemOne(request).then((result) => this.settle(result));
    this.turn = { id: ++this.sequence, textHash: promptHash(raw), promise };
    return promise;
  }
  settle(result) {
    let settled;
    if (!result.ok) settled = { ok: false, reason: result.reason, status: result.status ?? null, latencyMs: result.latencyMs };
    else {
      try { settled = { ok: true, model: result.model, inputTokens: result.inputTokens, latencyMs: result.latencyMs, decision: decideTurn(result.answers) }; }
      catch (error) { this.sink.error("typesafe decision failed", { error: error.message }); settled = { ok: false, reason: "internal-error", latencyMs: result.latencyMs }; }
    }
    const outcome = settled.ok ? "ok" : settled.reason;
    this.outcomes[outcome] = (this.outcomes[outcome] || 0) + 1;
    this.sink.emit({ type: "typesafe.turn", outcome, latencyMs: settled.latencyMs });
    return settled;
  }
  turnFor(text) { return this.turn && this.turn.textHash === promptHash(text) ? this.turn.promise : null; }
  currentTurn() { return this.turn?.promise || null; }
  service() { return Object.freeze({ modes: this.modes, turnFor: (text) => this.turnFor(text), currentTurn: () => this.currentTurn() }); }
  recordTurn(input = {}) {
    if (!this.active()) return noopResult("typesafe.recordTurn");
    const record = buildTurnRecord({ ...input, at: this.clock(), modes: this.modes });
    this.storage.appendJsonl("turns", record);
    return record;
  }
  turnRecords() { return this.storage.readJsonl("turns"); }
  pruneTurnRecords({ keep = TYPESAFE_TURN_RECORDS_KEEP } = {}) {
    const rows = this.turnRecords();
    if (rows.length <= keep) return { total: rows.length, removed: 0 };
    this.storage.writeJsonl("turns", rows.slice(-keep));
    return { total: rows.length, removed: rows.length - keep };
  }
  readiness() {
    return {
      enabled: this.enabled,
      active: this.active(),
      modes: this.modes,
      invalidSettings: this.invalidSettings,
      childSession: this.childSession,
      keyPresent: this.client.keyPresent,
      model: this.client.model,
      baseUrl: this.client.baseUrl === TYPESAFE_DEFAULT_BASE_URL ? "default" : "custom",
      timeoutMs: this.client.timeoutMs,
      outcomes: { ...this.outcomes },
    };
  }
  async probe() {
    const models = await this.client.listModels();
    const answer = await this.client.systemOne({ state: { request: "Synthetic readiness probe: please summarize this paragraph." }, questions: { probe: { type: "noul", instructions: "Does the `request` ask for a summary?" } } });
    return { ok: models.ok && answer.ok, models: models.ok ? models.models : null, modelsReason: models.ok ? null : models.reason, pinnedModel: this.client.model, answeredBy: answer.ok ? answer.model : null, answerReason: answer.ok ? null : answer.reason, latencyMs: answer.latencyMs };
  }
}

class TraceAdapter {
  constructor({ enabled = true, storage = new MemoryJsonStorage(), storageKey = "trace/events", sink = new NullSink(), clock = () => Date.now() } = {}) {
    this.enabled = enabled; this.storage = storage; this.storageKey = storageKey; this.sink = sink; this.clock = clock; this.events = [];
  }
  emit(event) {
    if (!this.enabled) return noopResult("trace.emit");
    const e = { id: event.id || `trace_${this.events.length + 1}`, at: this.clock(), severity: event.severity || "info", ...event };
    this.events.push(e); this.storage.appendJsonl(this.storageKey, e); this.sink.emit({ type: "trace.event", category: e.category, name: e.name, severity: e.severity });
    return e;
  }
  async span(base, fn) {
    if (!this.enabled) return fn();
    const start = this.clock(); const opened = this.emit({ ...base, name: `${base.name}.start` });
    try { const result = await fn(); this.emit({ ...base, name: `${base.name}.end`, parentId: opened.id, durationMs: this.clock() - start }); return result; }
    catch (error) { this.emit({ ...base, name: `${base.name}.error`, parentId: opened.id, severity: "error", error: error.message, durationMs: this.clock() - start }); throw error; }
  }
  recent(limit = 50) { return this.events.slice(-limit); }
  export() { return clone(this.events); }
  prune({ keep = 2000, dryRun = true } = {}) {
    const rows = this.storage.readJsonl?.(this.storageKey) || [];
    const keepCount = Math.max(0, Number(keep) || 0);
    const removeCount = Math.max(0, rows.length - keepCount);
    if (!this.storage.writeJsonl) return { dryRun, supported: false, total: rows.length, keep: keepCount, wouldRemove: removeCount, removed: 0 };
    if (!dryRun && removeCount > 0) {
      const kept = rows.slice(-keepCount);
      this.storage.writeJsonl(this.storageKey, kept);
      const keptIds = new Set(kept.map((e) => e.id).filter(Boolean));
      this.events = this.events.filter((e) => !e.id || keptIds.has(e.id)).slice(-keepCount);
    }
    return { dryRun, supported: true, total: rows.length, keep: keepCount, wouldRemove: removeCount, removed: dryRun ? 0 : removeCount, remaining: dryRun ? rows.length : Math.min(rows.length, keepCount) };
  }
}

module.exports = {
  GoalControllerAdapter,
  GoalEvidenceAdapter,
  LearningLoopAdapter,
  ExecutionOutcomeAdapter,
  TYPESAFE_TURN_RECORDS_KEEP,
  promptHash,
  SystemOneAdapter,
  TraceAdapter,
};
