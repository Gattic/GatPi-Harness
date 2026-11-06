"use strict";

const STAGES = Object.freeze(["M0", "M1", "M2", "M3", "M4", "M5"]);
function stageIndex(stage) { const index = STAGES.indexOf(stage); return index < 0 ? 0 : index; }
function stageAt(index) { return STAGES[Math.max(0, Math.min(STAGES.length - 1, Number(index) || 0))]; }
function boolean(value) { return value === true; }
function eligibleStage(evidence = {}) {
  let index = 0;
  if (boolean(evidence.deterministicPassed) && boolean(evidence.privacyPassed) && boolean(evidence.rollbackPassed)) index = 1;
  // Passing synthetic metrics alone do not qualify automatic recall or later stages.
  if (index >= 1 && boolean(evidence.reviewedGoldQualified) && Number(evidence.recallPrecisionAt5) >= 0.9 && Number(evidence.recallAt5) >= 0.9 && Number(evidence.localRecallP95Ms) <= 50 && Number(evidence.crossProjectContamination || 0) === 0 && Number(evidence.currentFactStaleRate || 0) === 0) index = 2;
  if (index >= 2 && boolean(evidence.shadowDecisionPassed)) index = 3;
  if (index >= 3 && boolean(evidence.realFixtureCurationPassed) && boolean(evidence.conflictReviewPassed)) index = 4;
  if (index >= 4 && Number(evidence.exactVersionUses) >= 30 && Number(evidence.independentSessions) >= 10 && Number(evidence.observedDays) >= 14 && Number(evidence.explicitSavePrecision) >= 0.95 && Number(evidence.automaticSavePrecision) >= 0.98 && Number(evidence.curationSuccessRate) >= 0.9 && Number(evidence.curationTimeoutRate) <= 0.1 && Number(evidence.unresolvedHighPrivacyCandidates || 0) === 0) index = 5;
  return stageAt(index);
}
function resolveProjectMemoryRollout(env = process.env, evidence = {}) {
  const requested = STAGES.includes(env.PI_PROJECT_MEMORY_STAGE) ? env.PI_PROJECT_MEMORY_STAGE : "M0";
  const evidenceEligibleStage = eligibleStage(evidence);
  const enabled = env.PI_PROJECT_MEMORY !== "0";
  // Manual saves need operator consent, not proof of autonomous efficacy. This
  // opt-in is deliberately exact: it cannot authorize any part of M2–M5.
  const explicitM1OptIn = enabled && requested === "M1" && env.PI_PROJECT_MEMORY_WRITES === "1";
  const eligible = stageAt(Math.max(stageIndex(evidenceEligibleStage), explicitM1OptIn ? 1 : 0));
  const effective = stageAt(Math.min(stageIndex(requested), stageIndex(eligible)));
  // Operator authority enables only selective capture/recall, not evidence-based
  // promotion, verified claims, Hermes curation, or maintenance.
  const operatorAutomatic = explicitM1OptIn && env.PI_PROJECT_MEMORY_AUTOMATIC === "1";
  const stageAuthority = operatorAutomatic ? "operator-opt-in" : explicitM1OptIn && evidenceEligibleStage === "M0" ? "explicit-m1-opt-in" : "scorecard";
  const controls = {
    reads: enabled && stageIndex(effective) >= 0 && env.PI_PROJECT_MEMORY_READS !== "0",
    explicitWrites: enabled && stageIndex(effective) >= 1 && env.PI_PROJECT_MEMORY_WRITES !== "0",
    taskRecall: enabled && (stageIndex(effective) >= 2 || operatorAutomatic) && env.PI_PROJECT_MEMORY_READS !== "0" && env.PI_PROJECT_MEMORY_RECALL !== "0",
    automaticCapture: operatorAutomatic && env.PI_PROJECT_MEMORY_READS !== "0" && env.PI_PROJECT_MEMORY_AUTO_SAVE === "1",
    // Diagnostics do not grant M1 writes, M2 injection, or M3 candidate authority.
    diagnosticCapture: enabled && env.PI_PROJECT_MEMORY_DIAGNOSTICS === "1",
    candidateCapture: enabled && stageIndex(effective) >= 3 && env.PI_PROJECT_MEMORY_CANDIDATES !== "0",
    reviewQueueWrites: enabled && stageIndex(effective) >= 4 && env.PI_PROJECT_MEMORY_REVIEW_QUEUE !== "0",
    hermesCuration: enabled && stageIndex(effective) >= 4 && env.PI_PROJECT_MEMORY_HERMES !== "0",
    automaticVerifiedUpserts: enabled && stageIndex(effective) >= 5 && env.PI_PROJECT_MEMORY_AUTO_SAVE === "1",
    cognitiveConsolidation: enabled && env.PI_PROJECT_MEMORY_COGNITIVE_CONSOLIDATION === "1",
    retentionApply: enabled && env.PI_PROJECT_MEMORY_RETENTION_APPLY === "1",
  };
  return { schemaVersion: 1, requestedStage: requested, evidenceEligibleStage, eligibleStage: eligible, effectiveStage: effective, stageAuthority, operatorAutomatic, fieldEffectiveness: operatorAutomatic ? "unproven" : "not-assessed", enabled, controls, promotionBlocked: stageIndex(requested) > stageIndex(eligible), decision: effective === "M5" ? "ship" : "no-go-deferred" };
}
module.exports = { STAGES, stageIndex, eligibleStage, resolveProjectMemoryRollout };
