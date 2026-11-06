"use strict";

/**
 * Model-side reasoning runtime scaffolding.
 *
 * This module deliberately does not implement private reasoning, chain-of-thought
 * simulation, or proof-by-verbosity. It stores explicit artifacts produced by a
 * reasoning model and connects them to executor actions, verifier evidence,
 * branch comparisons, reflection checkpoints, failure analysis, and memory
 * updates.
 */

const crypto = require("node:crypto");

const AUTOMATED_RETENTION = Object.freeze({ evidence: 120, executorActions: 2000 });
// Retention bounds must fail safe: a malformed or negative override falls back
// to the documented default instead of pruning the whole store.
function retentionBound(value, fallback) {
  const bound = Number(value);
  return Number.isFinite(bound) && bound >= 0 ? Math.floor(bound) : fallback;
}

// Automated retention writes one pre-prune backup per pass. Only backups the
// current process wrote are rotated, so a growth bound never deletes evidence
// left by an earlier session; reclaiming those stays an explicit decision.
function rotateSnapshotKeys(tracked, key, keep, remove) {
  // A malformed or zero bound must still terminate: the loop drains the tracked
  // set instead of spinning on an empty array.
  const bound = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 1;
  // Two passes can land in the same millisecond and reuse a key; the file is
  // already tracked, so there is nothing to rotate.
  if (tracked.includes(key)) return [];
  tracked.push(key);
  const dropped = [];
  // The current backup is never dropped: it is the safety copy for the prune
  // that just ran, so rotation stops when it reaches the front of the queue.
  while (tracked.length > bound && tracked[0] !== key) {
    const stale = tracked.shift();
    if (!stale) continue;
    remove(stale);
    dropped.push(stale);
  }
  return dropped;
}

const ARTIFACT_TYPES = Object.freeze({
  PLAN: "plan",
  TASK_DECOMPOSITION: "task_decomposition",
  HYPOTHESIS: "hypothesis",
  DECISION_RECORD: "decision_record",
  EXECUTOR_ACTION: "executor_action",
  VERIFIER_EVIDENCE: "verifier_evidence",
  VERIFIER_FEEDBACK: "verifier_feedback",
  MEMORY_UPDATE: "memory_update",
  REASONING_CHECKPOINT: "reasoning_checkpoint",
  BRANCH_COMPARISON: "branch_comparison",
  FAILURE_ANALYSIS: "failure_analysis",
});

const CHECKPOINT_KINDS = Object.freeze({
  PLAN: "plan",
  PRE_EXECUTION: "pre_execution",
  POST_EXECUTION: "post_execution",
  VERIFICATION: "verification",
  REFLECTION: "reflection",
  FAILURE: "failure",
  MEMORY: "memory",
});

function nowIso() { return new Date().toISOString(); }
function hash(value) { return crypto.createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function shortId(prefix, value) { return `${prefix}_${hash({ value, at: nowIso(), nonce: Math.random() }).slice(0, 12)}`; }
function arr(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function publicText(value) { return typeof value === "string" ? value : stableStringify(value); }
function artifactTimestamp(value) { const t = Date.parse(value?.createdAt || value?.updatedAt || 0); return Number.isFinite(t) ? t : 0; }
function autoScaffoldGroupKey(value) {
  if (value?.source !== "model-scaffold" && value?.metadata?.source !== "model-scaffold") return null;
  const text = value.objective || value.task || value.publicSummary || "";
  const normalized = String(text).replace(/^Reasoning scaffold initialized for:\s*/i, "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? `model-scaffold:${normalized}` : null;
}
function artifactRichness(value) {
  return [value.steps, value.subtasks, value.risks, value.successCriteria, value.dependencies, value.ordering, value.parallelizable, value.nextActions]
    .reduce((sum, field) => sum + (Array.isArray(field) ? field.length : 0), 0) + (value.summary ? 1 : 0) + (value.publicSummary ? 1 : 0);
}

const PRIVATE_REASONING_KEY_RE = /^(chainOfThought|chain_of_thought|cot|privateReasoning|private_reasoning|hiddenReasoning|hidden_reasoning|scratchpad)$/i;

function findPrivateReasoningFields(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((v, i) => findPrivateReasoningFields(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const found = [];
  for (const [key, val] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (PRIVATE_REASONING_KEY_RE.test(key)) found.push(next);
    else found.push(...findPrivateReasoningFields(val, next));
  }
  return found;
}

function stripPrivateReasoning(value) {
  if (Array.isArray(value)) return value.map(stripPrivateReasoning);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (PRIVATE_REASONING_KEY_RE.test(key)) continue;
    out[key] = stripPrivateReasoning(val);
  }
  return out;
}

function compactPublicValue(value, options = {}, depth = 0, seen = new Set()) {
  const maxStringChars = Math.max(128, Number(options.maxStringChars || 4000));
  const maxArrayItems = Math.max(1, Number(options.maxArrayItems || 50));
  const maxObjectKeys = Math.max(1, Number(options.maxObjectKeys || 80));
  const maxDepth = Math.max(1, Number(options.maxDepth || 8));
  if (typeof value === "string") {
    if (value.length <= maxStringChars) return value;
    const marker = `\n... [truncated ${value.length - maxStringChars} characters; total ${value.length}] ...\n`;
    const available = Math.max(0, maxStringChars - marker.length);
    const head = Math.ceil(available / 2);
    const tail = Math.floor(available / 2);
    return `${value.slice(0, head)}${marker}${tail ? value.slice(-tail) : ""}`;
  }
  if (value == null || typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[Array(${value.length}) omitted at depth ${depth}]` : `[Object omitted at depth ${depth}]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArrayItems).map((item) => compactPublicValue(item, { maxStringChars, maxArrayItems, maxObjectKeys, maxDepth }, depth + 1, seen));
    if (value.length > maxArrayItems) out.push({ omittedItems: value.length - maxArrayItems });
    seen.delete(value);
    return out;
  }
  const out = {};
  const entries = Object.entries(value).filter(([key]) => !PRIVATE_REASONING_KEY_RE.test(key));
  for (const [key, item] of entries.slice(0, maxObjectKeys)) out[key] = compactPublicValue(item, { maxStringChars, maxArrayItems, maxObjectKeys, maxDepth }, depth + 1, seen);
  if (entries.length > maxObjectKeys) out.omittedKeys = entries.length - maxObjectKeys;
  seen.delete(value);
  return out;
}

function validationError(message, details = {}) { const err = new Error(message); err.name = "ReasoningArtifactValidationError"; err.details = details; return err; }
function assertNoPrivateReasoning(input, { allowScratchpad = false } = {}) {
  const found = findPrivateReasoningFields(input).filter((p) => allowScratchpad && /(^|\.)scratchpad$/.test(p) ? false : true);
  if (found.length) throw validationError("private reasoning fields are not valid public artifact input", { fields: found });
}
function validateArtifactShape(type, value) {
  const errors = [];
  const requireText = (field) => { if (!String(value[field] || "").trim()) errors.push(`${type}.${field} is required`); };
  if (!Object.values(ARTIFACT_TYPES).includes(type)) errors.push(`unknown artifact type: ${type}`);
  if (type === ARTIFACT_TYPES.PLAN) { requireText("objective"); if (!Array.isArray(value.steps)) errors.push("plan.steps must be an array"); }
  if (type === ARTIFACT_TYPES.TASK_DECOMPOSITION) { requireText("task"); if (!Array.isArray(value.subtasks)) errors.push("task_decomposition.subtasks must be an array"); }
  if (type === ARTIFACT_TYPES.HYPOTHESIS) requireText("statement");
  if (type === ARTIFACT_TYPES.DECISION_RECORD) requireText("decision");
  if (type === ARTIFACT_TYPES.EXECUTOR_ACTION) requireText("action");
  if (type === ARTIFACT_TYPES.VERIFIER_EVIDENCE) { requireText("claim"); requireText("kind"); requireText("method"); if (value.kind === "unspecified") errors.push("verifier_evidence.kind must be explicit"); if (value.method === "unspecified") errors.push("verifier_evidence.method must be explicit"); if (typeof value.ok !== "boolean") errors.push("verifier_evidence.ok must be boolean"); }
  if (type === ARTIFACT_TYPES.MEMORY_UPDATE) requireText("content");
  if (type === ARTIFACT_TYPES.REASONING_CHECKPOINT) requireText("publicSummary");
  if (type === ARTIFACT_TYPES.VERIFIER_FEEDBACK && !value.evidenceId) errors.push("verifier_feedback.evidenceId is required");
  if (type === ARTIFACT_TYPES.FAILURE_ANALYSIS) requireText("summary");
  if (errors.length) throw validationError("invalid reasoning artifact", { type, errors });
  return true;
}

function artifact(type, input, options = {}) {
  assertNoPrivateReasoning(input || {}, options);
  const safe = stripPrivateReasoning(input || {});
  const value = {
    id: safe.id || shortId(type.replace(/_/g, "-"), safe),
    type,
    createdAt: safe.createdAt || nowIso(),
    updatedAt: safe.updatedAt || safe.createdAt || nowIso(),
    ...safe,
  };
  validateArtifactShape(type, value);
  return Object.freeze(value);
}

function createPlanArtifact(input = {}) {
  return artifact(ARTIFACT_TYPES.PLAN, {
    objective: input.objective || input.task || "",
    summary: input.summary || "",
    steps: arr(input.steps).map((s, i) => typeof s === "string" ? { id: `step-${i + 1}`, description: s, status: "pending" } : { status: "pending", ...stripPrivateReasoning(s) }),
    dependencies: arr(input.dependencies),
    risks: arr(input.risks),
    successCriteria: arr(input.successCriteria || input.acceptanceCriteria),
    assumptions: arr(input.assumptions),
    source: input.source || "model",
    status: input.status || "draft",
    ...input,
  });
}

function createTaskDecomposition(input = {}) {
  return artifact(ARTIFACT_TYPES.TASK_DECOMPOSITION, {
    task: input.task || input.objective || "",
    subtasks: arr(input.subtasks).map((s, i) => typeof s === "string" ? { id: `task-${i + 1}`, title: s, status: "pending" } : { status: "pending", ...stripPrivateReasoning(s) }),
    ordering: arr(input.ordering),
    parallelizable: arr(input.parallelizable),
    ...input,
  });
}

function createHypothesis(input = {}) {
  return artifact(ARTIFACT_TYPES.HYPOTHESIS, {
    statement: input.statement || "",
    status: input.status || "open",
    confidence: typeof input.confidence === "number" ? input.confidence : null,
    evidenceFor: arr(input.evidenceFor),
    evidenceAgainst: arr(input.evidenceAgainst),
    falsifiers: arr(input.falsifiers),
    ...input,
  });
}

function createDecisionRecord(input = {}) {
  return artifact(ARTIFACT_TYPES.DECISION_RECORD, {
    decision: input.decision || "",
    rationale: input.rationale || "",
    alternatives: arr(input.alternatives),
    tradeoffs: arr(input.tradeoffs),
    evidenceIds: arr(input.evidenceIds),
    status: input.status || "proposed",
    ...input,
  });
}

function createExecutorAction(input = {}) {
  return artifact(ARTIFACT_TYPES.EXECUTOR_ACTION, {
    action: input.action || input.kind || "unspecified",
    target: input.target || null,
    planStepId: input.planStepId || null,
    inputs: stripPrivateReasoning(input.inputs || {}),
    outputs: stripPrivateReasoning(input.outputs || {}),
    result: input.result || "pending",
    ...input,
  });
}

function createVerifierEvidence(input = {}) {
  assertNoPrivateReasoning(input || {});
  const compact = compactPublicValue(input);
  return artifact(ARTIFACT_TYPES.VERIFIER_EVIDENCE, {
    ...compact,
    claim: compactPublicValue(input.claim || "", { maxStringChars: 4000 }),
    ok: input.ok === true,
    kind: compactPublicValue(input.kind || "unspecified", { maxStringChars: 512 }),
    method: compactPublicValue(input.method || "unspecified", { maxStringChars: 512 }),
    observations: arr(input.observations).map((item) => compactPublicValue(item, { maxStringChars: 4000, maxArrayItems: 30, maxObjectKeys: 50, maxDepth: 6 })),
    artifacts: arr(input.artifacts).slice(0, 100).map((item) => compactPublicValue(item, { maxStringChars: 4000, maxArrayItems: 20, maxObjectKeys: 30, maxDepth: 4 })),
    confidence: typeof input.confidence === "number" ? input.confidence : null,
    verifier: compactPublicValue(input.verifier || "unknown", { maxStringChars: 512 }),
  });
}

function createMemoryUpdate(input = {}) {
  return artifact(ARTIFACT_TYPES.MEMORY_UPDATE, {
    scope: input.scope || "project",
    operation: input.operation || "upsert",
    content: input.content || "",
    sourceArtifactIds: arr(input.sourceArtifactIds),
    verification: input.verification || "unverified",
    ...input,
  });
}

function createReasoningCheckpoint(input = {}) {
  return artifact(ARTIFACT_TYPES.REASONING_CHECKPOINT, {
    kind: input.kind || CHECKPOINT_KINDS.REFLECTION,
    phase: input.phase || input.kind || CHECKPOINT_KINDS.REFLECTION,
    publicSummary: input.publicSummary || input.summary || "",
    scratchpadRef: input.scratchpadRef || null,
    artifactIds: arr(input.artifactIds),
    result: stripPrivateReasoning(input.result || {}),
    nextActions: arr(input.nextActions),
    ...input,
  });
}

class ReasoningScratchpad {
  constructor() { this.items = new Map(); }
  put(value, metadata = {}) {
    const item = { id: shortId("scratch", { value, metadata }), createdAt: nowIso(), metadata: stripPrivateReasoning(metadata), value };
    this.items.set(item.id, item);
    return { ref: item.id, createdAt: item.createdAt, metadata: item.metadata };
  }
  get(ref) { return this.items.get(ref) || null; }
  publicRefs() { return Array.from(this.items.values()).map((x) => ({ ref: x.id, createdAt: x.createdAt, metadata: x.metadata })); }
  clear(ref) { if (ref) return this.items.delete(ref); this.items.clear(); return true; }
}

class ReasoningRuntime {
  constructor({ storage = null, storageKey = "reasoning-runtime", sink = null, clock = nowIso } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.sink = sink;
    this.clock = clock;
    this.scratchpad = new ReasoningScratchpad();
    const saved = storage?.readJson?.(storageKey, null);
    this.artifacts = new Map((saved?.artifacts || []).map((a) => [a.id, a]));
    this.links = saved?.links || [];
  }

  persist() { this.storage?.writeJson?.(this.storageKey, { version: 1, artifacts: Array.from(this.artifacts.values()), links: this.links }); return { key: this.storageKey, artifacts: this.artifacts.size, links: this.links.length }; }
  emit(event) { this.sink?.emit?.({ type: "reasoning-runtime", ...event }); }
  addArtifact(item) {
    const safe = artifact(item.type || "artifact", item);
    const existing = this.findDuplicateAutoScaffold(safe);
    if (existing) {
      if (artifactRichness(safe) > artifactRichness(existing)) {
        const upgraded = Object.freeze({ ...safe, id: existing.id, createdAt: existing.createdAt, updatedAt: nowIso() });
        this.artifacts.set(existing.id, upgraded);
        this.emit({ action: "artifact.upgrade", artifactType: upgraded.type, id: upgraded.id });
        return upgraded;
      }
      return existing;
    }
    this.artifacts.set(safe.id, safe);
    this.emit({ action: "artifact", artifactType: safe.type, id: safe.id });
    return safe;
  }
  findDuplicateAutoScaffold(item) {
    const key = autoScaffoldGroupKey(item);
    if (!key) return null;
    return Array.from(this.artifacts.values()).find((a) => a.type === item.type && autoScaffoldGroupKey(a) === key) || null;
  }
  getArtifact(id) { return this.artifacts.get(id) || null; }
  listArtifacts({ type = null, limit = Infinity } = {}) { const xs = Array.from(this.artifacts.values()).filter((a) => !type || a.type === type); return xs.slice(-limit).map(clone); }
  link(fromId, toId, relation) { const l = { id: shortId("link", { fromId, toId, relation }), fromId, toId, relation, createdAt: nowIso() }; this.links.push(l); this.emit({ action: "link", relation, fromId, toId }); return l; }

  createPlan(input) { return this.addArtifact(createPlanArtifact(input)); }
  decomposeTask(input) { return this.addArtifact(createTaskDecomposition(input)); }
  trackHypothesis(input) { return this.addArtifact(createHypothesis(input)); }
  recordDecision(input) { return this.addArtifact(createDecisionRecord(input)); }
  recordExecutorAction(input) { return this.addArtifact(createExecutorAction(input)); }
  recordVerifierEvidence(input) { return this.addArtifact(createVerifierEvidence(input)); }
  updateMemory(input) { return this.addArtifact(createMemoryUpdate(input)); }

  createCheckpoint(input = {}) {
    const privateScratch = input.scratchpad;
    let scratchpadRef = input.scratchpadRef || null;
    if (privateScratch != null) scratchpadRef = this.scratchpad.put(privateScratch, { phase: input.phase || input.kind }).ref;
    const publicInput = { ...input, scratchpadRef };
    delete publicInput.scratchpad;
    return this.addArtifact(createReasoningCheckpoint(publicInput));
  }

  addVerifierFeedback({ evidenceId, targetArtifactId, status = "needs_revision", message = "", requiredActions = [] } = {}) {
    const evidence = evidenceId ? this.getArtifact(evidenceId) : null;
    const feedback = this.addArtifact(artifact(ARTIFACT_TYPES.VERIFIER_FEEDBACK, { evidenceId, targetArtifactId, status, message, requiredActions: arr(requiredActions), ok: evidence?.ok === true }));
    if (evidenceId) this.link(evidenceId, feedback.id, "supports_feedback");
    if (targetArtifactId) this.link(feedback.id, targetArtifactId, "requests_change_to");
    return feedback;
  }

  compareBranches({ left, right, criteria = [] } = {}) {
    const leftObj = typeof left === "string" ? this.getArtifact(left) : left;
    const rightObj = typeof right === "string" ? this.getArtifact(right) : right;
    const scores = arr(criteria).map((c) => {
      const name = typeof c === "string" ? c : c.name;
      const evaluate = typeof c === "object" && typeof c.evaluate === "function" ? c.evaluate : null;
      const result = evaluate ? evaluate(leftObj, rightObj) : { winner: "undecided", reason: "criterion recorded; external model/verifier must evaluate" };
      return { criterion: name, ...stripPrivateReasoning(result) };
    });
    const comparison = this.addArtifact(artifact(ARTIFACT_TYPES.BRANCH_COMPARISON, { left: leftObj?.id || left, right: rightObj?.id || right, criteria: arr(criteria).map((c) => typeof c === "string" ? c : c.name), scores, conclusion: scores.find((s) => s.winner && s.winner !== "undecided")?.winner || "undecided" }));
    return comparison;
  }

  analyzeFailure({ failure, evidenceIds = [], actionIds = [], hypothesisIds = [], summary = "" } = {}) {
    const evidence = arr(evidenceIds).map((id) => this.getArtifact(id)).filter(Boolean);
    const failedEvidence = evidence.filter((e) => e.ok === false);
    const analysis = this.addArtifact(artifact(ARTIFACT_TYPES.FAILURE_ANALYSIS, {
      failure: compactPublicValue(failure || {}, { maxStringChars: 2000, maxArrayItems: 50, maxObjectKeys: 80, maxDepth: 8 }),
      summary: summary || (failedEvidence.length ? "Verifier evidence indicates failure; model must revise using evidence." : "Failure recorded; evidence required."),
      evidenceIds: arr(evidenceIds),
      actionIds: arr(actionIds),
      hypothesisIds: arr(hypothesisIds),
      likelyCauses: [],
      correctiveActions: failedEvidence.map((e) => ({ evidenceId: e.id, action: "address verifier observation", observations: e.observations })),
    }));
    for (const id of [...arr(evidenceIds), ...arr(actionIds), ...arr(hypothesisIds)]) this.link(id, analysis.id, "contributes_to_failure_analysis");
    return analysis;
  }

  prune({ maxAutoScaffold = 60, maxAgeMs = null, now = Date.now(), dryRun = false } = {}) {
    const protectedTypes = new Set([ARTIFACT_TYPES.VERIFIER_EVIDENCE, ARTIFACT_TYPES.VERIFIER_FEEDBACK, ARTIFACT_TYPES.FAILURE_ANALYSIS, ARTIFACT_TYPES.DECISION_RECORD, ARTIFACT_TYPES.MEMORY_UPDATE]);
    const auto = Array.from(this.artifacts.values()).filter((a) => autoScaffoldGroupKey(a) && !protectedTypes.has(a.type)).sort((a, b) => artifactTimestamp(a) - artifactTimestamp(b));
    const remove = new Set();
    if (Number.isFinite(maxAutoScaffold) && auto.length > maxAutoScaffold) for (const a of auto.slice(0, auto.length - maxAutoScaffold)) remove.add(a.id);
    if (Number.isFinite(maxAgeMs)) for (const a of auto) if (now - artifactTimestamp(a) > maxAgeMs) remove.add(a.id);
    const removed = Array.from(remove).map((id) => this.artifacts.get(id)).filter(Boolean).map((a) => ({ id: a.id, type: a.type, summary: a.objective || a.task || a.publicSummary || a.type }));
    if (!dryRun) {
      for (const id of remove) this.artifacts.delete(id);
      this.links = this.links.filter((l) => !remove.has(l.fromId) && !remove.has(l.toId));
    }
    this.emit({ action: "prune", removed: removed.length, dryRun });
    return { removed, remaining: this.artifacts.size, dryRun };
  }

  pruneAutomatedVerification({ keep = AUTOMATED_RETENTION.evidence, keepExecutorActions = AUTOMATED_RETENTION.executorActions, dryRun = true } = {}) {
    const evidenceKeep = retentionBound(keep, AUTOMATED_RETENTION.evidence);
    const actionKeep = retentionBound(keepExecutorActions, AUTOMATED_RETENTION.executorActions);
    const evidence = Array.from(this.artifacts.values()).filter((a) => a.type === ARTIFACT_TYPES.VERIFIER_EVIDENCE && (a.verifier === "cognitive-automation" || a.method === "verification-adapter")).sort((a, b) => artifactTimestamp(a) - artifactTimestamp(b));
    const actions = Array.from(this.artifacts.values()).filter((a) => a.type === ARTIFACT_TYPES.EXECUTOR_ACTION).sort((a, b) => artifactTimestamp(a) - artifactTimestamp(b));
    const remove = new Set();
    for (const e of evidence.slice(0, Math.max(0, evidence.length - evidenceKeep))) {
      remove.add(e.id);
      for (const artifact of this.artifacts.values()) {
        if ((artifact.type === ARTIFACT_TYPES.VERIFIER_FEEDBACK && artifact.evidenceId === e.id) || (artifact.type === ARTIFACT_TYPES.FAILURE_ANALYSIS && (artifact.evidenceIds || []).includes(e.id))) remove.add(artifact.id);
      }
    }
    // Automated executor-action scaffolds are the dominant unbounded growth in
    // reasoning-runtime.json, so they get their own record bound.
    for (const a of actions.slice(0, Math.max(0, actions.length - actionKeep))) remove.add(a.id);
    // Feedback that requests a change to a pruned action would keep a dangling
    // target, so it is removed with the action it refers to.
    for (const artifact of this.artifacts.values()) {
      if (artifact.type === ARTIFACT_TYPES.VERIFIER_FEEDBACK && remove.has(artifact.targetArtifactId)) remove.add(artifact.id);
    }
    const removed = Array.from(remove).map((id) => this.artifacts.get(id)).filter(Boolean).map((a) => ({ id: a.id, type: a.type, at: a.createdAt, summary: a.claim || a.message || a.summary || a.type }));
    if (!dryRun) {
      for (const id of remove) this.artifacts.delete(id);
      this.links = this.links.filter((l) => !remove.has(l.fromId) && !remove.has(l.toId));
    }
    this.emit({ action: "prune-automated-verification", removed: removed.length, dryRun });
    return { dryRun, keep: evidenceKeep, keepExecutorActions: actionKeep, automatedEvidence: evidence.length, automatedExecutorActions: actions.length, removed, remaining: this.artifacts.size };
  }
  metrics() {
    const byType = {};
    const bySource = {};
    let automatedVerifierEvidence = 0;
    let automatedExecutorActions = 0;
    for (const a of this.artifacts.values()) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      const source = a.source || a.metadata?.source || "unknown";
      bySource[source] = (bySource[source] || 0) + 1;
      if (a.type === ARTIFACT_TYPES.VERIFIER_EVIDENCE && (a.verifier === "cognitive-automation" || a.method === "verification-adapter")) automatedVerifierEvidence++;
      if (a.type === ARTIFACT_TYPES.EXECUTOR_ACTION) automatedExecutorActions++;
    }
    return { artifacts: this.artifacts.size, links: this.links.length, scratchpadRefs: this.scratchpad.publicRefs().length, automatedVerifierEvidence, automatedExecutorActions, byType, bySource };
  }
  publicArtifacts(options = {}) { return this.listArtifacts(options).map(stripPrivateReasoning); }
  resultPacket() { return { artifacts: this.publicArtifacts(), links: clone(this.links), scratchpadRefs: this.scratchpad.publicRefs() }; }
  exportPacket(options = {}) {
    return { version: 1, exportedAt: nowIso(), ...this.resultPacket(), filters: stripPrivateReasoning(options || {}) };
  }
  replay({ limit = 50, type = null } = {}) {
    const artifacts = this.publicArtifacts({ type, limit });
    return artifacts.map((a, index) => ({ index, id: a.id, type: a.type, at: a.createdAt, summary: a.objective || a.task || a.decision || a.statement || a.claim || a.publicSummary || a.summary || a.action || a.type }));
  }
}

module.exports = {
  ARTIFACT_TYPES,
  AUTOMATED_RETENTION,
  retentionBound,
  rotateSnapshotKeys,
  CHECKPOINT_KINDS,
  ReasoningRuntime,
  ReasoningScratchpad,
  createPlanArtifact,
  createTaskDecomposition,
  createHypothesis,
  createDecisionRecord,
  createExecutorAction,
  createVerifierEvidence,
  createMemoryUpdate,
  createReasoningCheckpoint,
  stripPrivateReasoning,
  compactPublicValue,
  findPrivateReasoningFields,
  validateArtifactShape,
};
