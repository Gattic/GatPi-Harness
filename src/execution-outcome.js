"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { FileIntegrationStorage } = require("./file-integration-storage");
const {
  CANONICAL_OUTCOMES,
  normalizeOutcome,
  normalizeLoopOutcome,
  normalizeGoalOutcome,
} = require("./outcome-schema");

const EXECUTION_OUTCOME_SCHEMA_VERSION = 1;
const SOURCE_KINDS = new Set(["automation-loop", "goal"]);
const TASK_CLASSES = new Set(["implementation", "verification", "research", "unknown"]);
const EVIDENCE_CLASSES = new Set(["deterministic", "synthetic", "migration", "exact-version-field", "user-reviewed-gold"]);
const COHORT_ARMS = new Set(["control", "candidate", "unassigned"]);
const FORBIDDEN_KEYS = new Set([
  "prompt", "nextprompt", "rawhermesoutput", "assistanttext", "assistantoutput",
  "transcript", "reasoning", "privatereasoning", "commandargs", "commandarguments",
  "tooloutput", "rawtooloutput", "controllertext", "message", "messages", "content",
]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "packetId", "source", "task", "outcome", "reasonCodes", "workflow",
  "evidenceRefs", "artifactRefs", "metrics", "provenance", "privacy", "settledAt",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_REFERENCE = /\b(?:evidence|proof|claim)_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}\b/g;
const SECRET_PATTERNS = [
  new RegExp("\\b(?:sk|pk|ghp|github_pat|glpat|xox[baprs]|ya29|hf)[-_][-_A-Za-z0-9]{12,}\\b", "i"),
  new RegExp("AIza[-_A-Za-z0-9]{20,}"),
  new RegExp("(?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\\s*[:=]\\s*[^\\s'\\\"]{8,}", "i"),
];
const ABSOLUTE_PATH_PATTERNS = [
  new RegExp("(?:^|[\\s\\\"'(])\\/(?!\\/)[^\\s\\\"')]+"),
  new RegExp("(?:^|[\\s\\\"'(])[A-Za-z]:\\\\[^\\s\\\"')]+"),
];
const LIMITS = Object.freeze({
  depth: 8,
  text: 512,
  reasonCodes: 32,
  steps: 64,
  toolNames: 64,
  evidenceRefs: 64,
  artifactRefs: 64,
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex")}`; }
function code(value, fallback = "unknown") {
  const normalized = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return normalized || fallback;
}
function finiteCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : 0;
}
function normalizedHash(value, label) {
  const candidate = String(value || "").toLowerCase();
  if (!SHA256.test(candidate)) throw new Error(`${label} must be a sha256 hash`);
  return candidate;
}
function sourceRecordHash(sourceRecord, explicitHash) {
  return explicitHash ? normalizedHash(explicitHash, "source.sourceRecordHash") : sha256(sourceRecord == null ? {} : sourceRecord);
}
function normalizeReference(value, label) {
  const text = String(value || "");
  if (!SAFE_ID.test(text)) throw new Error(`${label} must be a safe identifier`);
  return text;
}
function normalizeTimestamp(value, label = "settledAt") {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}
function normalizeArtifact(input = {}) {
  const artifact = {
    kind: code(input.kind, "artifact"),
    id: normalizeReference(input.id, "artifact.id"),
    hash: normalizedHash(input.hash, "artifact.hash"),
  };
  return artifact;
}
function normalizeStep(input = {}, index = 0) {
  const step = {
    index: Number.isInteger(input.index) && input.index >= 0 ? input.index : index,
    kind: code(input.kind, "unknown"),
    role: input.role == null ? null : normalizeReference(input.role, "workflow.steps.role"),
    status: normalizeOutcome(input.status, "unknown"),
  };
  return step;
}
function normalizePrivacy(input = {}) {
  const privacy = {
    promptStored: false,
    assistantOutputStored: false,
    transcriptStored: false,
    commandArgumentsStored: false,
    privateReasoningStored: false,
  };
  for (const key of Object.keys(privacy)) if (input[key] === true) throw new Error(`privacy.${key} must be false`);
  return privacy;
}
function packetIdentity(input) {
  return {
    sourceKind: input.source.kind,
    runId: input.source.runId,
    sourceRecordHash: input.source.sourceRecordHash,
    terminalState: input.source.terminalState || input.outcome,
  };
}
function executionPacketId(input) { return `execout_${sha256(packetIdentity(input)).slice("sha256:".length, "sha256:".length + 32)}`; }

function scanForbidden(value, key = "packet", depth = 0) {
  if (depth > LIMITS.depth) throw new Error(`${key} exceeds maximum nesting depth`);
  if (typeof value === "string") {
    if (value.length > LIMITS.text) throw new Error(`${key} exceeds ${LIMITS.text} characters`);
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) throw new Error(`${key} contains secret-like data`);
    if (ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(value))) throw new Error(`${key} contains an absolute path`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) scanForbidden(value[index], `${key}[${index}]`, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_KEYS.has(normalized)) throw new Error(`${key}.${field} is forbidden in execution outcomes`);
    scanForbidden(child, `${key}.${field}`, depth + 1);
  }
}
function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value || {})) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
}
function assertList(value, max, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} items`);
}

function normalizeExecutionOutcomePacket(input = {}) {
  scanForbidden(input);
  assertKeys(input, TOP_LEVEL_KEYS, "packet");
  const sourceInput = input.source || {};
  assertKeys(sourceInput, new Set(["kind", "runId", "sourceSchemaVersion", "sourceRecordHash", "terminalState"]), "source");
  if (!SOURCE_KINDS.has(sourceInput.kind)) throw new Error("source.kind must be automation-loop or goal");
  const source = {
    kind: sourceInput.kind,
    runId: normalizeReference(sourceInput.runId, "source.runId"),
    sourceSchemaVersion: Math.max(1, Math.floor(Number(sourceInput.sourceSchemaVersion || 1))),
    sourceRecordHash: normalizedHash(sourceInput.sourceRecordHash, "source.sourceRecordHash"),
    terminalState: code(sourceInput.terminalState || input.outcome, "unknown"),
  };
  const taskInput = input.task || {};
  assertKeys(taskInput, new Set(["hash", "class"]), "task");
  const task = { hash: normalizedHash(taskInput.hash, "task.hash"), class: TASK_CLASSES.has(taskInput.class) ? taskInput.class : "unknown" };
  const outcome = normalizeOutcome(input.outcome, "unknown");
  if (!CANONICAL_OUTCOMES.includes(outcome)) throw new Error("outcome must be canonical");
  const reasonCodes = input.reasonCodes || [];
  assertList(reasonCodes, LIMITS.reasonCodes, "reasonCodes");
  const workflowInput = input.workflow || {};
  assertKeys(workflowInput, new Set(["steps", "toolNames", "retries"]), "workflow");
  const steps = workflowInput.steps || [];
  const toolNames = workflowInput.toolNames || [];
  assertList(steps, LIMITS.steps, "workflow.steps");
  assertList(toolNames, LIMITS.toolNames, "workflow.toolNames");
  const workflow = {
    steps: steps.map(normalizeStep),
    toolNames: [...new Set(toolNames.map((name) => { const text = String(name || ""); if (!SAFE_TOOL.test(text)) throw new Error("workflow.toolNames contains an unsafe name"); return text; }))].sort(),
    retries: finiteCount(workflowInput.retries),
  };
  const evidenceRefs = input.evidenceRefs || [];
  const artifactRefs = input.artifactRefs || [];
  assertList(evidenceRefs, LIMITS.evidenceRefs, "evidenceRefs");
  assertList(artifactRefs, LIMITS.artifactRefs, "artifactRefs");
  const metricsInput = input.metrics || {};
  assertKeys(metricsInput, new Set(["iterations", "toolCalls", "toolErrors", "modelCalls", "durationMs", "contextAdded"]), "metrics");
  const provenanceInput = input.provenance || {};
  assertKeys(provenanceInput, new Set(["producerVersion", "projectKeyHash", "evidenceClass", "cohortId", "sessionIdHash", "arm"]), "provenance");
  const cohortId = provenanceInput.cohortId == null ? null : normalizeReference(provenanceInput.cohortId, "provenance.cohortId");
  const sessionIdHash = provenanceInput.sessionIdHash == null ? null : normalizedHash(provenanceInput.sessionIdHash, "provenance.sessionIdHash");
  const arm = COHORT_ARMS.has(provenanceInput.arm) ? provenanceInput.arm : "unassigned";
  const requestedEvidenceClass = EVIDENCE_CLASSES.has(provenanceInput.evidenceClass) ? provenanceInput.evidenceClass : "deterministic";
  const normalizedEvidenceClass = requestedEvidenceClass === "exact-version-field" && !(cohortId && sessionIdHash && ["control", "candidate"].includes(arm)) ? "deterministic" : requestedEvidenceClass;
  const packet = {
    schemaVersion: EXECUTION_OUTCOME_SCHEMA_VERSION,
    packetId: String(input.packetId || ""),
    source,
    task,
    outcome,
    reasonCodes: [...new Set(reasonCodes.map((reason) => { const value = code(reason, "unknown"); if (!SAFE_CODE.test(value)) throw new Error("reasonCodes contains an unsafe code"); return value; }))].sort(),
    workflow,
    evidenceRefs: [...new Set(evidenceRefs.map((id) => normalizeReference(id, "evidenceRefs")))].sort(),
    artifactRefs: artifactRefs.map(normalizeArtifact).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
    metrics: {
      iterations: finiteCount(metricsInput.iterations),
      toolCalls: finiteCount(metricsInput.toolCalls),
      toolErrors: finiteCount(metricsInput.toolErrors),
      modelCalls: finiteCount(metricsInput.modelCalls),
      durationMs: finiteCount(metricsInput.durationMs),
      contextAdded: metricsInput.contextAdded == null ? null : finiteCount(metricsInput.contextAdded),
    },
    provenance: {
      producerVersion: normalizeReference(provenanceInput.producerVersion || "unknown", "provenance.producerVersion"),
      projectKeyHash: normalizedHash(provenanceInput.projectKeyHash, "provenance.projectKeyHash"),
      evidenceClass: normalizedEvidenceClass,
      cohortId,
      sessionIdHash,
      arm,
    },
    privacy: normalizePrivacy(input.privacy),
    settledAt: normalizeTimestamp(input.settledAt),
  };
  const expectedId = executionPacketId(packet);
  if (packet.packetId && packet.packetId !== expectedId) throw new Error("packetId does not match stable packet identity");
  packet.packetId = expectedId;
  scanForbidden(packet);
  return packet;
}
function validateExecutionOutcomePacket(input) {
  try { return { ok: true, packet: normalizeExecutionOutcomePacket(input), issues: [] }; }
  catch (error) { return { ok: false, packet: null, issues: [error.message] }; }
}

function buildExecutionOutcomePacket(input = {}) {
  const source = input.source || {};
  const sourceKind = source.kind || input.sourceKind;
  const sourceRecord = input.sourceRecord;
  const outcome = sourceKind === "automation-loop"
    ? normalizeLoopOutcome(source.terminalState || input.terminalState || input.outcome, input)
    : sourceKind === "goal"
      ? normalizeGoalOutcome(source.terminalState || input.terminalState || input.outcome, input)
      : normalizeOutcome(input.outcome, "unknown");
  return normalizeExecutionOutcomePacket({
    schemaVersion: EXECUTION_OUTCOME_SCHEMA_VERSION,
    source: {
      kind: sourceKind,
      runId: source.runId || input.runId,
      sourceSchemaVersion: source.sourceSchemaVersion || input.sourceSchemaVersion || 1,
      sourceRecordHash: sourceRecordHash(sourceRecord, source.sourceRecordHash || input.sourceRecordHash),
      terminalState: source.terminalState || input.terminalState || outcome,
    },
    task: {
      hash: input.task?.hash || input.taskHash || sha256(input.taskText || ""),
      class: input.task?.class || input.taskClass || "unknown",
    },
    outcome,
    reasonCodes: input.reasonCodes || [],
    workflow: input.workflow || {},
    evidenceRefs: input.evidenceRefs || [],
    artifactRefs: input.artifactRefs || [],
    metrics: input.metrics || {},
    provenance: {
      producerVersion: input.provenance?.producerVersion || input.producerVersion || "unknown",
      projectKeyHash: input.provenance?.projectKeyHash || input.projectKeyHash || sha256(input.projectKey || "unknown"),
      evidenceClass: input.provenance?.evidenceClass || input.evidenceClass,
      cohortId: input.provenance?.cohortId || input.cohortId,
      sessionIdHash: input.provenance?.sessionIdHash || input.sessionIdHash,
      arm: input.provenance?.arm || input.arm,
    },
    privacy: input.privacy || {},
    settledAt: input.settledAt,
  });
}
function buildLoopOutcomePacket(input = {}) { return buildExecutionOutcomePacket({ ...input, source: { ...(input.source || {}), kind: "automation-loop" } }); }
function buildGoalOutcomePacket(input = {}) { return buildExecutionOutcomePacket({ ...input, source: { ...(input.source || {}), kind: "goal" } }); }

function taskClass(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(?:verify|verification|test|check|lint|build)\b/.test(value)) return "verification";
  if (/\b(?:research|investigate|compare|study|analy[sz]e)\b/.test(value)) return "research";
  if (/\b(?:implement|fix|refactor|add|create|update|change|code)\b/.test(value)) return "implementation";
  return "unknown";
}
function elapsedDuration(start, end) {
  const left = Date.parse(start || 0);
  const right = Date.parse(end || 0);
  return Number.isFinite(left) && Number.isFinite(right) && right >= left ? right - left : 0;
}
function collectEvidenceReferences(values) {
  const refs = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(EVIDENCE_REFERENCE)) refs.add(match[0]);
      return;
    }
    if (Array.isArray(value)) return value.slice(0, 100).forEach((item) => visit(item, depth + 1));
    if (typeof value === "object") for (const child of Object.values(value).slice(0, 100)) visit(child, depth + 1);
  };
  visit(values);
  return [...refs].slice(0, LIMITS.evidenceRefs);
}
function hashedArtifacts(values, kind) {
  const artifacts = new Map();
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string" && value.trim()) {
      const hash = sha256(value);
      const id = `${kind}_${hash.slice("sha256:".length, "sha256:".length + 24)}`;
      artifacts.set(id, { kind, id, hash });
      return;
    }
    if (Array.isArray(value)) return value.slice(0, 100).forEach((item) => visit(item, depth + 1));
    if (typeof value === "object") for (const child of Object.values(value).slice(0, 100)) visit(child, depth + 1);
  };
  visit(values);
  return [...artifacts.values()].slice(0, LIMITS.artifactRefs);
}
function loopToolNames(history = []) {
  return [...new Set(history.flatMap((record) => Object.keys(record?.tools || {})).filter((name) => SAFE_TOOL.test(String(name))))].slice(0, LIMITS.toolNames);
}
function buildLoopSettlementPacket(state = {}, options = {}) {
  const status = String(state.status || "unknown");
  const lifecycle = Array.isArray(state.lifecycleEvents) ? state.lifecycleEvents : [];
  const providerFailure = lifecycle.some((event) => event?.kind === "assistant-failure");
  const checkpointEvidence = (state.checkpoints || []).flatMap((checkpoint) => checkpoint?.evidence || []);
  const completionEvidence = state.completionEvidence || [];
  const evidenceRefs = collectEvidenceReferences([checkpointEvidence, completionEvidence]);
  const artifactRefs = hashedArtifacts([checkpointEvidence, completionEvidence], "checkpoint");
  const evidenceBearingPause = ["paused", "failed"].includes(status) && (evidenceRefs.length > 0 || artifactRefs.length > 0);
  if (!["completed", "max_iterations"].includes(status) && !providerFailure && !evidenceBearingPause) return null;
  const history = (state.history || []).slice(-LIMITS.steps);
  const reasonCodes = [status === "max_iterations" ? "maximum-iterations" : status, providerFailure ? "provider-failure" : null, state.completionMode ? `completion-${state.completionMode}` : null, ...(state.checkpoints || []).slice(-8).map((checkpoint) => checkpoint?.verdict ? `checkpoint-${checkpoint.verdict}` : null)].filter(Boolean);
  const terminalAt = state.completedAt || state.pausedAt || state.updatedAt;
  const sourceRecord = {
    schemaVersion: Number(state.schemaVersion || 3),
    runId: state.id,
    terminalState: status,
    iteration: finiteCount(state.iteration),
    assistantEntryId: state.outcomeSettlementEntryId || state.lastSettledEntryId || options.assistantEntryId || null,
    evidenceRefs,
    artifactHashes: artifactRefs.map((artifact) => artifact.hash),
    history: history.map((record) => ({ iteration: finiteCount(record.iteration), assistantStopReason: code(record.assistantStopReason, "unknown"), toolCalls: finiteCount(record.toolCalls), toolErrors: finiteCount(record.toolErrors) })),
  };
  return buildLoopOutcomePacket({
    runId: state.id,
    sourceSchemaVersion: Number(state.schemaVersion || 3),
    sourceRecord,
    terminalState: status,
    providerFailure,
    reasonCodes,
    taskHash: sha256(state.prompt || state.promptHash || state.id),
    taskClass: taskClass(state.prompt),
    workflow: {
      steps: history.map((record, index) => ({ index, kind: "iteration", role: null, status: record.toolErrors > 0 ? "domain-negative" : record.assistantStopReason === "error" ? "infrastructure-failed" : "succeeded" })),
      toolNames: loopToolNames(history),
      retries: finiteCount(state.stallCount),
    },
    evidenceRefs,
    artifactRefs,
    metrics: {
      iterations: finiteCount(state.iteration),
      toolCalls: history.reduce((sum, record) => sum + finiteCount(record.toolCalls), 0),
      toolErrors: history.reduce((sum, record) => sum + finiteCount(record.toolErrors), 0),
      modelCalls: history.length || finiteCount(state.iteration),
      durationMs: elapsedDuration(state.createdAt, terminalAt),
    },
    producerVersion: options.producerVersion || "automation-loop-v3",
    projectKeyHash: options.projectKeyHash || sha256(options.projectKey || "unknown"),
    evidenceClass: options.evidenceClass,
    cohortId: options.cohortId,
    sessionIdHash: options.sessionIdHash,
    arm: options.arm,
    settledAt: terminalAt,
  });
}
function buildGoalSettlementPacket(state = {}, options = {}) {
  const status = String(state.status || "unknown");
  const history = (state.history || []).slice(-LIMITS.steps);
  const evidenceRefs = collectEvidenceReferences([state.completionEvidenceIds, state.evidenceIds, history, state.observations]);
  const evidenceValues = [state.completionEvidenceIds || [], state.evidenceIds || []];
  const artifactRefs = hashedArtifacts(evidenceValues, "goal-evidence");
  const executed = history.some((record) => record?.executed === true || record?.actionResultCode || record?.action?.kind);
  if (status !== "completed" && !(["blocked", "failed"].includes(status) && (executed || evidenceRefs.length || artifactRefs.length))) return null;
  const providerFailure = history.some((record) => record?.errorKind === "hermes_command" || record?.providerFailure === true);
  const terminalAt = state.completedAt || state.updatedAt;
  const sourceRecord = {
    schemaVersion: Number(state.schemaVersion || 1),
    runId: state.id,
    terminalState: status,
    iteration: finiteCount(state.iteration),
    evidenceRefs,
    artifactHashes: artifactRefs.map((artifact) => artifact.hash),
    history: history.map((record, index) => ({ index, status: code(record?.status, "unknown"), executed: record?.executed === true, errorKind: record?.errorKind ? code(record.errorKind) : null, actionKind: record?.action?.kind ? code(record.action.kind) : null })),
  };
  return buildGoalOutcomePacket({
    runId: state.id,
    sourceSchemaVersion: Number(state.schemaVersion || 1),
    sourceRecord,
    terminalState: status,
    providerFailure,
    reasonCodes: [status, providerFailure ? "provider-failure" : null, executed ? "action-executed" : null, evidenceRefs.length || artifactRefs.length ? "evidence-linked" : null].filter(Boolean),
    taskHash: sha256(state.goal || state.id),
    taskClass: taskClass(state.goal),
    workflow: {
      steps: history.map((record, index) => ({ index, kind: record?.action?.kind || "iteration", role: null, status: record?.status === "completed" ? "succeeded" : record?.status === "failed" ? (record?.errorKind === "hermes_command" ? "infrastructure-failed" : "domain-negative") : record?.status === "blocked" ? "blocked" : record?.executed ? "succeeded" : "unknown" })),
      toolNames: executed ? ["pi-turn"] : [],
      retries: Math.max(0, finiteCount(state.iteration) - 1),
    },
    evidenceRefs,
    artifactRefs,
    metrics: {
      iterations: finiteCount(state.iteration),
      toolCalls: history.filter((record) => record?.executed === true || record?.actionResultCode).length,
      toolErrors: history.filter((record) => record?.status === "failed" || record?.error).length,
      modelCalls: finiteCount(state.iteration),
      durationMs: elapsedDuration(state.createdAt, terminalAt),
    },
    producerVersion: options.producerVersion || "goal-runner-v1",
    projectKeyHash: options.projectKeyHash || sha256(options.projectKey || "unknown"),
    evidenceClass: options.evidenceClass,
    cohortId: options.cohortId,
    sessionIdHash: options.sessionIdHash,
    arm: options.arm,
    settledAt: terminalAt,
  });
}

function executionRejectionCode(error) {
  const message = String(error?.message || "").toLowerCase();
  if (/secret-like/.test(message)) return "secret-like";
  if (/absolute path/.test(message)) return "absolute-path";
  if (/forbidden/.test(message)) return "forbidden-field";
  if (/maximum|exceeds/.test(message)) return "bounds";
  if (/hash|packetid|identity/.test(message)) return "identity";
  return "schema-invalid";
}
function indexRow(packet) {
  return {
    schemaVersion: 1,
    packetId: packet.packetId,
    sourceKind: packet.source.kind,
    runId: packet.source.runId,
    sourceRecordHash: packet.source.sourceRecordHash,
    terminalState: packet.source.terminalState,
    taskHash: packet.task.hash,
    outcome: packet.outcome,
    evidenceCount: packet.evidenceRefs.length,
    artifactCount: packet.artifactRefs.length,
    metrics: { ...packet.metrics },
    provenance: { evidenceClass: packet.provenance.evidenceClass, cohortId: packet.provenance.cohortId, sessionIdHash: packet.provenance.sessionIdHash, arm: packet.provenance.arm, producerVersion: packet.provenance.producerVersion },
    settledAt: packet.settledAt,
  };
}

class ExecutionOutcomeStore {
  constructor({ cwd = process.cwd(), stateDir, storage, prefix = "" } = {}) {
    this.cwd = cwd;
    this.stateDir = stateDir || path.join(cwd, ".pi", "execution-outcomes");
    this.storage = storage || new FileIntegrationStorage(this.stateDir);
    this.prefix = String(prefix || "").replace(/\/+$/, "");
  }
  key(name) { return this.prefix ? `${this.prefix}/${name}` : name; }
  packetKey(packetId) { return this.key(`packets/${normalizeReference(packetId, "packetId")}`); }
  save(input) {
    let packet;
    try { packet = normalizeExecutionOutcomePacket(input); }
    catch (error) { this.storage.appendJsonl(this.key("rejections"), { schemaVersion: 1, at: new Date().toISOString(), reasonCode: executionRejectionCode(error) }); throw error; }
    const key = this.packetKey(packet.packetId);
    const existing = this.storage.readJson(key, null);
    const existingNormalized = existing ? normalizeExecutionOutcomePacket(existing) : null;
    if (existingNormalized && stableStringify(existingNormalized) !== stableStringify(packet)) throw new Error(`execution outcome packet collision: ${packet.packetId}`);
    if (!existing) this.storage.writeJson(key, packet);
    const rows = this.storage.readJsonl(this.key("index")) || [];
    const indexed = rows.some((row) => row.packetId === packet.packetId);
    if (!indexed) this.storage.appendJsonl(this.key("index"), indexRow(packet));
    return { ok: true, outcome: existing || indexed ? "not-applicable" : "succeeded", packetId: packet.packetId, packet, duplicate: Boolean(existing), indexed: true, persisted: !existing };
  }
  get(packetId) {
    const packet = this.storage.readJson(this.packetKey(packetId), null);
    if (!packet) return null;
    const validation = validateExecutionOutcomePacket(packet);
    if (!validation.ok) throw new Error(`invalid stored execution outcome ${packetId}: ${validation.issues.join("; ")}`);
    return validation.packet;
  }
  list({ sourceKind, runId, outcome, after, limit = 100 } = {}) {
    const rows = this.storage.readJsonl(this.key("index")) || [];
    const selected = rows.filter((row) => (!sourceKind || row.sourceKind === sourceKind) && (!runId || row.runId === runId) && (!outcome || row.outcome === outcome) && (!after || String(row.settledAt) > String(after)));
    return selected.slice(-Math.max(0, Math.min(1000, Number(limit) || 100)));
  }
  packets(options = {}) { return this.list(options).map((row) => this.get(row.packetId)).filter(Boolean); }
  compoundingRecords({ limit = 1000 } = {}) {
    const packets = this.packets({ limit }).map((packet) => ({ packetId: packet.packetId, sourceKind: packet.source.kind, runId: packet.source.runId, outcome: packet.outcome, evidenceCount: packet.evidenceRefs.length, evidenceIds: [...packet.evidenceRefs], artifactCount: packet.artifactRefs.length, metrics: { ...packet.metrics }, provenance: { ...packet.provenance }, settledAt: packet.settledAt }));
    const rejections = (this.storage.readJsonl(this.key("rejections")) || []).slice(-Math.max(1, Math.min(5000, Number(limit) || 1000))).map((row) => ({ at: row.at, reasonCode: code(row.reasonCode, "schema-invalid") }));
    return { packets, rejections };
  }
  receiptKey(consumer) { return this.key(`dispatch/${code(consumer, "consumer")}`); }
  receipts(consumer) { return this.storage.readJsonl(this.receiptKey(consumer)) || []; }
  pending(consumer, options = {}) {
    const delivered = new Set(this.receipts(consumer).filter((row) => row.status === "succeeded").map((row) => row.packetId));
    return this.packets(options).filter((packet) => !delivered.has(packet.packetId));
  }
  async drain(consumer, handler, options = {}) {
    if (typeof handler !== "function") throw new Error("execution outcome drain requires a handler");
    const packets = this.pending(consumer, options);
    const results = [];
    for (const packet of packets) {
      try {
        const result = await handler(packet);
        this.storage.appendJsonl(this.receiptKey(consumer), { schemaVersion: 1, consumer: code(consumer, "consumer"), packetId: packet.packetId, status: "succeeded", handledAt: new Date().toISOString() });
        results.push({ packetId: packet.packetId, ok: true, duplicate: Boolean(result?.duplicate), result });
      } catch (error) {
        results.push({ packetId: packet.packetId, ok: false, errorCode: code(error?.code || error?.name || "handler-failed") });
      }
    }
    return { consumer: code(consumer, "consumer"), pending: packets.length, processed: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, duplicates: results.filter((row) => row.duplicate).length, results };
  }
}

module.exports = {
  EXECUTION_OUTCOME_SCHEMA_VERSION,
  SOURCE_KINDS,
  TASK_CLASSES,
  EXECUTION_OUTCOME_LIMITS: LIMITS,
  stableStringify,
  sha256,
  sourceRecordHash,
  executionPacketId,
  normalizeExecutionOutcomePacket,
  validateExecutionOutcomePacket,
  buildExecutionOutcomePacket,
  buildLoopOutcomePacket,
  buildGoalOutcomePacket,
  buildLoopSettlementPacket,
  buildGoalSettlementPacket,
  collectEvidenceReferences,
  executionRejectionCode,
  ExecutionOutcomeStore,
};
