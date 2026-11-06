"use strict";

const { clone, digest, invariant, USAGE_KEYS, validId } = require("./subagent-task-contracts");
const { MAX_ASSET_ATTEMPTS } = require("./specialist-vision");
const TERMINAL = new Set(["accepted-proposal", "failed", "blocked", "cancelled"]);
const zero = () => Object.fromEntries(USAGE_KEYS.map(k => [k, 0]));
const unknownAttemptUsage = () => Object.fromEntries(USAGE_KEYS.map(key => [key, key === "attempts" ? 1 : null]));
function recordUsage(run, task, actual) {
  for (const key of USAGE_KEYS) {
    invariant(actual[key] === null || (Number.isFinite(actual[key]) && actual[key] >= 0), "TASK_ACCOUNTING_INVALID");
    for (const owner of [run, task]) owner.actual[key] = actual[key] == null || owner.actual[key] == null ? null : owner.actual[key] + actual[key];
  }
}

// Immutable attempts and observations. Scheduling remains the topology engine's job.
class SubagentTaskState {
  constructor({ storage, runId, graph, now = () => Date.now() }) {
    invariant(storage?.readJson && storage?.writeJson && validId(runId), "TASK_STORAGE_INVALID");
    this.storage = storage; this.key = `specialist-tasks/${runId}`; this.now = now;
    const previous = storage.readJson(this.key, null);
    if (previous) {
      invariant(previous.schemaVersion === 2, "TASK_STATE_VERSION_UNSUPPORTED");
      invariant(previous.graphDigest === graph.digest, "TASK_RESUME_GRAPH_DRIFT");
    } else {
      storage.writeJson(this.key, { schemaVersion: 2, runId, graphId: graph.graphId, graphDigest: graph.digest, runtimeRevision: graph.runtimeRevision, revision: 0, startedAt: now(), actual: zero(), tasks: Object.fromEntries(graph.tasks.map(spec => [spec.taskId, { taskId: spec.taskId, roleId: spec.roleId, dependsOn: clone(spec.dependsOn), criteria: clone(spec.acceptanceCriteria), requirementIds: clone(spec.requirementIds), specDigest: digest(spec), state: "planned", actual: zero(), attempts: [], feedback: [], artifact: null, reason: null }])) });
    }
  }
  snapshot() { return clone(this.storage.readJson(this.key)); }
  update(expectedRevision, change) {
    const state = this.snapshot();
    invariant(state.revision === expectedRevision, "TASK_STATE_STALE");
    change(state); state.revision++;
    this.storage.writeJson(this.key, state);
    return clone(state);
  }
  start(taskId, dependencyArtifacts = []) {
    return this.update(this.snapshot().revision, next => {
      const task = next.tasks[taskId];
      invariant(task && ["planned", "correction-needed"].includes(task.state), "TASK_ATTEMPT_NOT_READY");
      const attempt = { id: `${taskId}.attempt-${task.attempts.length + 1}`, previousAttemptId: task.attempts.at(-1)?.id || null, state: "implementing", startedAt: this.now(), dependencyArtifacts: clone(dependencyArtifacts), artifact: null, receipts: [], measurements: null, reason: null };
      task.attempts.push(attempt); task.state = "implementing"; task.reason = null; task.artifact = null; task.invalidated = false;
    });
  }
  artifact(taskId, attemptId, manifest) {
    return this.update(this.snapshot().revision, next => {
      const task = next.tasks[taskId], attempt = task?.attempts.at(-1);
      invariant(attempt?.id === attemptId && attempt.state === "implementing", "TASK_ARTIFACT_STATE_INVALID");
      invariant(manifest?.complete === true && manifest.taskId === taskId && manifest.attemptId === attemptId && manifest.digest && manifest.bytes > 0, "TASK_ARTIFACT_REQUIRED");
      attempt.artifact = clone(manifest); task.artifact = clone(manifest);
      attempt.state = task.state = "artifact-ready";
    });
  }
  verifying(taskId, attemptId, artifactDigest) {
    return this.update(this.snapshot().revision, next => {
      const task = next.tasks[taskId], attempt = task?.attempts.at(-1);
      invariant(attempt?.id === attemptId && attempt.state === "artifact-ready" && attempt.artifact?.digest === artifactDigest, "TASK_VERIFICATION_REQUIRES_ARTIFACT");
      attempt.state = task.state = "verifying";
    });
  }
  settle(taskId, attemptId, { status, receipts = [], reason = null, actual = unknownAttemptUsage(), measurements = null }) {
    const state = this.snapshot(), old = state.tasks[taskId]?.attempts.find(a => a.id === attemptId);
    if (old && TERMINAL.has(old.state)) { invariant(old.state === status && old.reason === reason && digest(old.actual) === digest(actual) && digest(old.measurements) === digest(measurements) && digest(old.receipts) === digest(receipts), "TASK_TERMINAL_IMMUTABLE"); return state; }
    return this.update(state.revision, next => {
      const task = next.tasks[taskId], attempt = task?.attempts.at(-1);
      invariant(attempt?.id === attemptId && ["implementing", "artifact-ready", "verifying"].includes(attempt.state), "TASK_SETTLEMENT_STALE");
      invariant(TERMINAL.has(status), "TASK_SETTLEMENT_INVALID");
      if (status === "accepted-proposal") invariant(attempt.state === "verifying" && receipts.length > 0 && receipts.every(r => r.status === "passed" && r.artifactDigest === attempt.artifact.digest) && task.criteria.filter(c => c.required).every(c => receipts.filter(r => r.criterionId === c.id).length === 1), "TASK_ACCEPTANCE_UNPROVEN");
      recordUsage(next, task, actual);
      Object.assign(attempt, { state: status, receipts: clone(receipts), actual: clone(actual), measurements: clone(measurements), reason, finishedAt: this.now() });
      task.state = status; task.reason = reason;
    });
  }
  correction(taskId) {
    return this.update(this.snapshot().revision, next => {
      const task = next.tasks[taskId], last = task?.attempts.at(-1);
      invariant(last?.state === "failed" && last.reason === "verification-failed", "TASK_CORRECTION_NOT_PRODUCT_FAILURE");
      task.state = "correction-needed"; task.artifact = null;
      for (const other of Object.values(next.tasks)) if (other.attempts.some(a => a.dependencyArtifacts.includes(last.artifact?.digest))) {
        other.state = "blocked"; other.reason = "dependency-artifact-stale";
      }
    });
  }
  feedback(taskId, artifactDigest, feedback) {
    return this.update(this.snapshot().revision, next => {
      const task = next.tasks[taskId];
      invariant(task?.artifact?.digest === artifactDigest && !task.invalidated, "TASK_FEEDBACK_ARTIFACT_STALE");
      task.feedback.push({ ...clone(feedback), artifactDigest });
    });
  }
  invalidate(taskIds, reason) {
    return this.update(this.snapshot().revision, next => {
      for (const taskId of taskIds) {
        const task = next.tasks[taskId];
        invariant(task && task.state !== "accepted-applied", "TASK_INVALIDATION_INVALID");
        task.invalidations ||= [];
        task.invalidations.push({ artifactDigest: task.artifact?.digest || null, previousState: task.state, reason, at: this.now() });
        task.invalidated = true; task.state = "blocked"; task.reason = reason;
      }
    });
  }
  recover() {
    return this.update(this.snapshot().revision, next => {
      for (const task of Object.values(next.tasks)) if (["implementing", "artifact-ready", "verifying"].includes(task.state)) {
        const attempt = task.attempts.at(-1), actual = unknownAttemptUsage();
        Object.assign(attempt, { state: "blocked", reason: "restart-requires-process-reconciliation", actual, finishedAt: this.now() });
        recordUsage(next, task, actual);
        task.state = "blocked"; task.reason = attempt.reason;
      }
      for (const task of Object.values(next.tasks)) {
        const application = task.applications?.at(-1);
        if (application?.state !== "running") continue;
        const actual = { ...zero(), toolCalls: null, wallTimeMs: null, storageBytes: null };
        Object.assign(application, { state: "interrupted", actual, reason: "application-reconciliation-required", finishedAt: this.now() });
        recordUsage(next, task, actual);
        task.state = "blocked"; task.reason = application.reason;
      }
    });
  }
  process(taskId, attemptId, identity, closed = false) {
    return this.update(this.snapshot().revision, next => {
      invariant(next.tasks[taskId]?.attempts.some(attempt => attempt.id === attemptId), "TASK_PROCESS_ATTEMPT_MISSING");
      next.processes ||= [];
      const previous = next.processes.find(process => process.subagentId === identity.subagentId);
      if (previous) {
        invariant(previous.processGroupId === identity.processGroupId && previous.startTime === identity.startTime, "TASK_PROCESS_IDENTITY_CHANGED");
        if (closed) previous.closed = true;
      } else next.processes.push({ taskId, attemptId, ...identity, closed });
    });
  }
  blockUnstarted(nodeStates) {
    return this.update(this.snapshot().revision, next => {
      for (const node of nodeStates) {
        const task = next.tasks[node.nodeId];
        if (task?.state === "planned" && ["blocked", "skipped", "failed"].includes(node.status)) { task.state = "blocked"; task.reason = node.reason || "dependency-not-ready"; }
      }
    });
  }
  resumeReconciled() {
    return this.update(this.snapshot().revision, next => {
      invariant((next.processes || []).every(process => process.closed), "TASK_PROCESSES_NOT_RECONCILED");
      for (const task of Object.values(next.tasks)) {
        if (task.reason === "application-reconciliation-required" || (task.roleId === "3d-modeler" && task.attempts.length >= MAX_ASSET_ATTEMPTS)) continue;
        if (task.state === "blocked" && !task.attempts.length) { task.state = "planned"; task.reason = null; }
        else if (["blocked", "failed"].includes(task.state)) { task.state = "correction-needed"; task.reason = null; }
      }
      next.resumedAt = this.now();
    });
  }
  startApplication(taskId, artifactDigest) {
    return this.update(this.snapshot().revision, next => {
      const task = next.tasks[taskId];
      invariant(task?.state === "accepted-proposal" && task.artifact?.digest === artifactDigest, "TASK_APPLICATION_NOT_READY");
      task.applications ||= [];
      invariant(!task.applications.some(a => a.state === "running"), "TASK_APPLICATION_RECONCILIATION_REQUIRED");
      task.applications.push({ id: `${taskId}.application-${task.applications.length + 1}`, artifactDigest, state: "running", actual: null, receipts: [], startedAt: this.now() });
    });
  }
  settleApplication(taskId, applicationId, { status, actual, receipts = [], reason = null, applied = null, recoveryReference = null }) {
    const state = this.snapshot(), settlementDigest = digest({ status, actual, receipts, reason, applied, recoveryReference });
    const previous = state.tasks[taskId]?.applications?.find(a => a.id === applicationId);
    if (previous && previous.state !== "running") { invariant(previous.settlementDigest === settlementDigest, "TASK_APPLICATION_TERMINAL_IMMUTABLE"); return state; }
    return this.update(state.revision, next => {
      const task = next.tasks[taskId], application = task?.applications?.at(-1);
      invariant(application?.id === applicationId && application.state === "running" && ["passed", "failed"].includes(status), "TASK_APPLICATION_SETTLEMENT_INVALID");
      recordUsage(next, task, actual);
      Object.assign(application, { state: status, actual: clone(actual), receipts: clone(receipts), reason, recoveryReference: recoveryReference || applied?.recoveryFile || null, settlementDigest, finishedAt: this.now() });
      if (reason === "application-reconciliation-required") { task.state = "blocked"; task.reason = reason; }
      if (status === "passed") {
        const required = task.criteria.filter(c => c.required);
        const patchBound = task.artifact?.disposition === "baseline-satisfied" ? applied?.disposition === "baseline-satisfied" && applied.patchHash === null : /^[a-f0-9]{64}$/.test(task.artifact?.patchHash || "") && applied?.patchHash === task.artifact.patchHash;
        invariant(task.state === "accepted-proposal" && task.artifact?.digest === application.artifactDigest && applied?.applied === true && patchBound && required.length > 0 && receipts.length === required.length && required.every(c => receipts.filter(r => r.criterionId === c.id && r.status === "passed" && r.artifactDigest === task.artifact.digest).length === 1), "TASK_APPLY_STATE_INVALID");
        task.state = "accepted-applied";
        task.application = { previewId: applied.previewId, appliedAt: applied.appliedAt, patchHash: applied.patchHash, recoveryReference: applied.recoveryFile || null };
      }
    });
  }
  publicSnapshot() {
    const state = this.snapshot();
    return {
      schemaVersion: state.schemaVersion, runId: state.runId, graphId: state.graphId, graphDigest: state.graphDigest, runtimeRevision: state.runtimeRevision, freshness: "not-rechecked", processes: state.processes || [], revision: state.revision, actual: state.actual,
      tasks: Object.values(state.tasks).map(task => ({
        taskId: task.taskId, roleId: task.roleId, dependsOn: task.dependsOn, requirementIds: task.requirementIds, state: task.state, reason: task.reason, actual: task.actual,
        criteria: task.criteria.map(c => ({ ...c, status: task.invalidated ? "stale" : task.attempts.at(-1)?.receipts.find(r => r.criterionId === c.id)?.status || "missing" })),
        attempts: task.attempts.map(a => ({ id: a.id, previousAttemptId: a.previousAttemptId, state: a.state, reason: a.reason, startedAt: a.startedAt, finishedAt: a.finishedAt, artifactDigest: a.artifact?.digest || null, receiptIds: a.receipts.map(r => r.proofId), actual: a.actual, measurements: a.measurements || null })),
        feedbackCount: task.feedback.length,
        applications: (task.applications || []).map(({ receipts, ...application }) => ({ ...application, proofIds: receipts.map(r => r.proofId) })), artifactDigest: task.artifact?.digest || null,
      })),
    };
  }
}
module.exports = { SubagentTaskState, zero };
