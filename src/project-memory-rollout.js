"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { FileIntegrationStorage } = require("./file-integration-storage");
const { sanitizeManagedStateValue } = require("./managed-state-sanitizer");
const { traceProjectPrefix } = require("./trace-retention");

const STAGES = Object.freeze(["M0", "M1", "M2", "M3", "M4", "M5"]);
const DEMOTION_THRESHOLD = 2;
function stageIndex(stage) { const index = STAGES.indexOf(stage); return index < 0 ? 0 : index; }
/**
 * The eligible stage comes only from a passive-telemetry evaluation. A missing
 * or malformed evaluation stays at M0: no claimed stage, artifact or metric
 * object can authorize a higher one.
 */
function acceptedEvaluation(evaluation) {
  return Boolean(evaluation && evaluation.kind === "rollout.evaluated" && STAGES.includes(evaluation.effectiveStage));
}
/** A predicate record or a decided record both carry a measured candidate. */
function candidateOf(evaluation) {
  if (!evaluation || (evaluation.kind !== "rollout.evaluated" && evaluation.kind !== "rollout.predicates")) return "M0";
  if (STAGES.includes(evaluation.candidateStage)) return evaluation.candidateStage;
  return STAGES.includes(evaluation.effectiveStage) ? evaluation.effectiveStage : "M0";
}
function eligibleStage(evaluation = null) {
  if (!acceptedEvaluation(evaluation)) return "M0";
  return STAGES.includes(evaluation.effectiveStage) ? evaluation.effectiveStage : "M0";
}
/** HOLD may only lower. An unset value is no cap; an unknown value is M0. */
function holdIndex(hold) {
  if (hold == null || hold === "") return STAGES.length - 1;
  const index = STAGES.indexOf(String(hold).trim());
  return index < 0 ? 0 : index;
}
/**
 * Promote immediately, demote only after two consecutive failing evaluations,
 * then cap by HOLD. Hysteresis state is the previous accepted stage and its
 * failure streak, both read back from the last emitted evaluation.
 */
function decideStage(evaluation, { previous = null, hold = null } = {}) {
  const candidateStage = candidateOf(evaluation);
  const candidateIndex = stageIndex(candidateStage);
  const previousStage = STAGES.includes(previous?.effectiveStage) ? previous.effectiveStage : "M0";
  let decidedIndex = stageIndex(previousStage);
  const previousConsecutiveFailures = Math.max(0, Number(previous?.consecutiveFailures) || 0);
  let consecutiveFailures = previousConsecutiveFailures;
  let promoted = false; let demoted = false;
  if (candidateIndex > decidedIndex) { decidedIndex = candidateIndex; consecutiveFailures = 0; promoted = true; }
  else if (candidateIndex < decidedIndex) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= DEMOTION_THRESHOLD) { decidedIndex = candidateIndex; consecutiveFailures = 0; demoted = true; }
  } else { consecutiveFailures = 0; }
  const capIndex = holdIndex(hold);
  const held = decidedIndex > capIndex;
  return {
    candidateStage,
    previousStage,
    decidedStage: STAGES[decidedIndex],
    effectiveStage: STAGES[Math.min(decidedIndex, capIndex)],
    promoted,
    demoted,
    consecutiveFailures,
    previousConsecutiveFailures,
    held,
    hold: hold == null || hold === "" ? null : STAGES[capIndex],
  };
}

function rolloutEvent({ evaluation, decision, now = Date.now() }) {
  return {
    schemaVersion: 1,
    event_id: `rolloutev_${crypto.randomUUID()}`,
    timestamp: new Date(now).toISOString(),
    category: "memory_rollout",
    name: "rollout.evaluated",
    severity: "info",
    correlation_id: crypto.randomUUID(),
    implementationRevision: evaluation?.implementationRevision || null,
    payload: {
      stage: decision.effectiveStage,
      candidateStage: decision.candidateStage,
      previousStage: decision.previousStage,
      decidedStage: decision.decidedStage,
      promoted: decision.promoted,
      demoted: decision.demoted,
      consecutiveFailures: decision.consecutiveFailures,
      previousConsecutiveFailures: decision.previousConsecutiveFailures,
      held: decision.held,
      hold: decision.hold,
      windowDays: evaluation?.windowDays ?? null,
      insufficient: evaluation?.insufficient || [],
      predicates: Object.fromEntries(Object.entries(evaluation?.predicates || {}).map(([name, value]) => [name, { status: value.status, reasons: value.reasons }])),
    },
  };
}

/**
 * Append one `rollout.evaluated` event. An injected sink wins; otherwise the
 * event is written to the project trace directory through the same private,
 * sanitized JSONL path the trace runtime uses. Emission failure never changes
 * the stage decision, so it is reported rather than thrown.
 */
function emitRolloutEvaluation({ cwd = process.cwd(), event, emit } = {}) {
  if (!event) return { emitted: false, reason: "no-event" };
  if (emit === false) return { emitted: false, reason: "disabled" };
  try {
    if (typeof emit === "function") { emit(event); return { emitted: true, sink: "injected" }; }
    if (emit && typeof emit.emit === "function") { emit.emit(event); return { emitted: true, sink: "injected" }; }
    const root = path.join(cwd, ".pi", "traces");
    new FileIntegrationStorage(root).appendJsonl(`${traceProjectPrefix(cwd)}rollout`, sanitizeManagedStateValue(event));
    return { emitted: true, sink: "trace-file" };
  } catch { return { emitted: false, reason: "emit-failed" }; }
}

function resolveProjectMemoryRollout(env = process.env, evaluation = null, options = {}) {
  const requested = STAGES.includes(env.PI_PROJECT_MEMORY_STAGE) ? env.PI_PROJECT_MEMORY_STAGE : "M0";
  const previous = options.previous !== undefined ? options.previous : evaluation?.previous ?? null;
  const decision = decideStage(evaluation, { previous, hold: env.PI_PROJECT_MEMORY_HOLD });
  const passiveEligibleStage = decision.decidedStage;
  // M1 is operator-consented, not telemetry-earned: a passive evaluation that
  // passes M0 authorizes M0, and only the explicit opt-in raises it to M1.
  const passiveIndex = stageIndex(passiveEligibleStage) === 1 ? 0 : stageIndex(passiveEligibleStage);
  const enabled = env.PI_PROJECT_MEMORY !== "0";
  // Manual saves need operator consent, not proof of autonomous efficacy. This
  // opt-in is deliberately exact: it cannot authorize any part of M2–M5.
  const explicitM1OptIn = enabled && requested === "M1" && env.PI_PROJECT_MEMORY_WRITES === "1";
  const eligible = STAGES[Math.max(passiveIndex, explicitM1OptIn ? 1 : 0)];
  // HOLD is applied last so it can also cap an operator opt-in.
  const effective = STAGES[Math.min(stageIndex(requested), stageIndex(eligible), holdIndex(env.PI_PROJECT_MEMORY_HOLD))];
  // Operator authority enables only selective capture/recall, not evidence-based
  // promotion, verified claims, Hermes curation, or maintenance.
  const operatorAutomatic = explicitM1OptIn && env.PI_PROJECT_MEMORY_AUTOMATIC === "1";
  const stageAuthority = operatorAutomatic ? "operator-opt-in" : explicitM1OptIn && passiveIndex === 0 ? "explicit-m1-opt-in" : acceptedEvaluation(evaluation) ? "passive-telemetry" : "fail-closed";
  const recallAuthorized = enabled && (stageIndex(effective) >= 2 || operatorAutomatic) && env.PI_PROJECT_MEMORY_READS !== "0" && env.PI_PROJECT_MEMORY_RECALL !== "0";
  // Shadow recall computes and logs candidates at M1 without injecting them, so
  // M2's recall bar is measurable before injection is enabled.
  const shadowRecallAuthorized = enabled && !recallAuthorized && stageIndex(effective) >= 1 && env.PI_PROJECT_MEMORY_READS !== "0" && env.PI_PROJECT_MEMORY_RECALL !== "0";
  const controls = {
    reads: enabled && stageIndex(effective) >= 0 && env.PI_PROJECT_MEMORY_READS !== "0",
    explicitWrites: enabled && stageIndex(effective) >= 1 && env.PI_PROJECT_MEMORY_WRITES !== "0",
    taskRecall: recallAuthorized,
    shadowRecall: shadowRecallAuthorized,
    automaticCapture: operatorAutomatic && env.PI_PROJECT_MEMORY_READS !== "0" && env.PI_PROJECT_MEMORY_AUTO_SAVE === "1",
    // Diagnostics do not grant M1 writes, M2 injection, or M3 candidate authority.
    diagnosticCapture: enabled && env.PI_PROJECT_MEMORY_DIAGNOSTICS === "1",
    // Shadow decisions are measurement-only and accrue from M1: proposals are
    // recorded as shadowed decisions (never applied or queued), so SD can be
    // observed without changing the explicit-write policy. Candidate capture
    // stays M3+ because it writes the review queue.
    shadowCandidates: enabled && stageIndex(effective) >= 1 && env.PI_PROJECT_MEMORY_CANDIDATES !== "0",
    candidateCapture: enabled && stageIndex(effective) >= 3 && env.PI_PROJECT_MEMORY_CANDIDATES !== "0",
    reviewQueueWrites: enabled && stageIndex(effective) >= 4 && env.PI_PROJECT_MEMORY_REVIEW_QUEUE !== "0",
    hermesCuration: enabled && stageIndex(effective) >= 4 && env.PI_PROJECT_MEMORY_HERMES !== "0",
    automaticVerifiedUpserts: enabled && stageIndex(effective) >= 5 && env.PI_PROJECT_MEMORY_AUTO_SAVE === "1",
    cognitiveConsolidation: enabled && env.PI_PROJECT_MEMORY_COGNITIVE_CONSOLIDATION === "1",
    retentionApply: enabled && env.PI_PROJECT_MEMORY_RETENTION_APPLY === "1",
  };
  return {
    schemaVersion: 1,
    requestedStage: requested,
    passiveEligibleStage,
    candidateStage: decision.candidateStage,
    previousStage: decision.previousStage,
    eligibleStage: eligible,
    effectiveStage: effective,
    promoted: decision.promoted,
    demoted: decision.demoted,
    consecutiveFailures: decision.consecutiveFailures,
    held: decision.held || stageIndex(eligible) > holdIndex(env.PI_PROJECT_MEMORY_HOLD),
    hold: decision.hold,
    stageAuthority,
    operatorAutomatic,
    fieldEffectiveness: operatorAutomatic ? "unproven" : "not-assessed",
    enabled,
    controls,
    promotionBlocked: stageIndex(requested) > stageIndex(eligible),
    insufficient: evaluation?.insufficient || [],
    decision: effective === "M5" ? "ship" : "no-go-deferred",
  };
}

module.exports = { STAGES, stageIndex, acceptedEvaluation, candidateOf, eligibleStage, holdIndex, decideStage, rolloutEvent, emitRolloutEvaluation, resolveProjectMemoryRollout };
