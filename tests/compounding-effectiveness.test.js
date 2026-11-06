"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CompoundingEffectivenessAdapter, assertMetadataOnly } = require("../src/compounding-effectiveness");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("compounding-effectiveness-");
const sourceHash = `sha256:${"a".repeat(64)}`;
const session = (value) => `sha256:${value.repeat(64).slice(0, 64)}`;
const baseEvaluations = [
  { evaluationId: "eval-deterministic", at: "2026-07-01T00:00:00.000Z", skillId: "skill-one", version: 2, sourceHash, exactVersion: true, evidenceClass: "deterministic", routingMode: "explicit", result: "succeeded", evidenceIds: ["evidence-one"], latencyMs: 100, toolCalls: 2, modelCalls: 1, contextAdded: 100 },
];
const providers = {
  skills: () => ({
    captures: [{ captureId: "cap-one", source: "execution", outcome: "succeeded", verificationOk: true, evidenceIds: ["evidence-one"], metrics: { latencyMs: 80, toolCalls: 2, modelCalls: 1, contextAdded: 100 }, taskBody: "PRIVATE_TASK_BODY" }],
    skills: [{ skillId: "skill-one", version: 2, status: "candidate", sourceHash, sourceTrust: "reviewed", captureIds: ["cap-one"], field: { status: "insufficient-data", exactVersionUses: 0, observedDays: 0, independentSessions: 0 }, approvals: { routing: "not-approved", publishing: "not-approved" } }],
    evaluations: baseEvaluations,
    failurePatterns: [{ patternId: "failure-one", signature: "sig-one", linkedCaptureIds: ["cap-one"], createdAt: "2026-07-01T00:00:00.000Z" }],
    failureEvents: [{ type: "failure_pattern.discovered", patternId: "failure-one", linkedCaptureCount: 1, newLinkedCaptures: 1, evidenceClass: "deterministic", at: "2026-07-01T00:00:00.000Z" }, { type: "failure_pattern.post_mitigation", patternId: "failure-one", mitigationReused: true, result: "succeeded", evidenceClass: "exact-version-field", sessionIdHash: session("f"), evidenceIds: ["evidence-one"], at: "2026-07-02T00:00:00.000Z" }],
  }),
  learning: () => ({
    outcomes: [{ outcomeId: "outcome-one", createdAt: "2026-07-01T00:00:00.000Z", source: "execution", evidenceClass: "deterministic", cohort: { id: null, arm: null, sessionIdHash: null }, status: "succeeded", verificationOk: true, userCorrectionDetected: false, evidenceIds: ["evidence-one"], classifications: ["verified-success"] }],
    patterns: [{ patternId: "pattern-one", kind: "repeated-success", outcomeIds: ["outcome-one"], evidenceIds: ["evidence-one"] }],
    proposals: [{ proposalId: "proposal-one", status: "applied", evidenceIds: ["outcome-one", "pattern-one", "evidence-one"], reviewReady: true, verificationOk: true }],
    decisions: [{ type: "proposal.applied", proposalId: "proposal-one", status: "applied", ok: true, evidenceIds: ["evidence-one"] }],
  }),
  execution: () => ({ packets: [{ packetId: "execout-one", sourceKind: "goal", runId: "goal-one", outcome: "succeeded", evidenceCount: 1, evidenceIds: ["evidence-one"], artifactCount: 0, metrics: { durationMs: 120, modelCalls: 1, toolCalls: 2, contextAdded: 100 }, provenance: { evidenceClass: "deterministic", cohortId: null, sessionIdHash: null, arm: "unassigned" }, settledAt: "2026-07-01T00:00:00.000Z" }], rejections: [{ reasonCode: "forbidden-field", at: "2026-07-01T00:00:00.000Z" }] }),
  maintenance: () => ({ reports: [
    { reportId: "report-one", generatedAt: "2026-07-01T00:00:00.000Z", candidateIds: ["candidate-one"], accounting: { new: ["candidate-one"], persistent: [], resolved: [], counts: { new: 1, persistent: 0, resolved: 0 } }, stageMetrics: { durationMs: 10, modelCalls: 0, toolCalls: 0, contextAdded: 0 }, boundaries: { retentionApplied: false, permissionsApplied: false, memoryWritten: false, notesWritten: false, sourceDeleted: false } },
    { reportId: "report-two", generatedAt: "2026-07-02T00:00:00.000Z", candidateIds: ["candidate-one"], accounting: { new: [], persistent: ["candidate-one"], resolved: [], counts: { new: 0, persistent: 1, resolved: 0 } }, stageMetrics: { durationMs: 12, modelCalls: 0, toolCalls: 0, contextAdded: 0 }, boundaries: { retentionApplied: false, permissionsApplied: false, memoryWritten: false, notesWritten: false, sourceDeleted: false } },
  ] }),
  provenance: () => ({ nodes: [{ id: "evidence:evidence-one", kind: "evidence", missing: false }, { id: "evidence:evidence-c0", kind: "evidence", missing: false }, { id: "evidence:evidence-c1", kind: "evidence", missing: false }, { id: "evidence:evidence-policy", kind: "evidence", missing: false }, { id: "skill-version:skill-one@2", kind: "skill-version", missing: false }], edges: [{ id: "edge-one", from: "evidence:evidence-one", to: "skill-version:skill-one@2", type: "supports" }], diagnostics: [], coverage: { complete: true } }),
  goalActions: () => ({ actions: [{ actionKind: "inspect", resultCode: "ok", at: "2026-07-01T00:00:00.000Z", metrics: { durationMs: 30, modelCalls: 1, toolCalls: 1, contextAdded: 50 } }] }),
  intakeRuns: () => ({ runs: [{ runId: "intake-one", status: "succeeded", at: "2026-07-01T00:00:00.000Z", metrics: { durationMs: 200, modelCalls: 4, toolCalls: 0, contextAdded: 200 } }] }),
  memoryScorecard: () => ({ aggregates: { retrieval: { precisionAt5: 1, returnedAt5: 4, contamination: 0 }, field: { currentFactStaleRate: 0 }, privacy: { unresolvedHighSeverity: 0, reviewedCandidates: 1 } }, scores: { retrievalPrecisionAt5: { status: "pass" }, currentFactStaleRate: { status: "insufficient-data", sampleSize: 0 }, crossProjectContamination: { status: "pass" } }, decision: "no-go-deferred", highestAuthorizedStage: "M0" }),
  claimMetrics: () => ({ records: 2, claims: 10, unsupported: 1 }),
  policyMetrics: () => ({ unresolvedHighSeverity: 0, reviewedFindings: 1, evidenceClass: "user-reviewed-gold", evidenceIds: ["evidence-policy"] }),
};

const adapter = new CompoundingEffectivenessAdapter({ cwd, providers, clock: () => new Date("2026-07-31T00:00:00.000Z") });
const report = adapter.generate({ write: false });
assert.equal(report.schemaVersion, 1);
assert.equal(report.decision, "no-go-deferred");
assert.equal(report.highestAuthorizedProjectMemoryStage, "M0");
assert.equal(report.experiment.status, "pre-registered", "unregistered exact-version rows do not start the field experiment");
assert.equal(report.automaticBehaviorAuthorized, false);
assert.equal(report.routingChangeAuthorized, false);
assert.equal(report.cohorts.comparison.status, "insufficient-data");
assert.equal(report.cohorts.comparison.reasonCode, "cohort-id-required");
assert.equal(report.gates.C2.status, "insufficient-data");
assert.equal(report.gates.C3.status, "insufficient-data");
assert.equal(report.gates.C4.status, "insufficient-data");
assert.equal(report.gates.C5.status, "insufficient-data");
assert.equal(report.metrics.skills.verifiedCapturesByExactVersion[0].verifiedCaptures, 1);
assert.equal(report.metrics.skills.usesByExactVersionSourceAndRouting[0].accepted, 1);
assert.equal(report.metrics.learningFunnel.rates.outcomeToPattern.value, 1);
assert.equal(report.metrics.learningFunnel.rates.appliedToFieldProven.status, "insufficient-data");
assert.equal(report.metrics.evidence.unsupportedClaimRate.value, 0.1);
assert.equal(report.metrics.memory.staleRate.status, "insufficient-data");
assert.equal(report.metrics.maintenance.stableCandidateRate.value, 1);
assert.equal(report.metrics.maintenance.applied.status, "insufficient-data");
assert.equal(report.metrics.stagePerformance.packet.durationMs.p95.value, 120);
assert.equal(report.evidenceClassCounts.deterministic > 0, true);
assert.equal(JSON.stringify(report).includes("PRIVATE_TASK_BODY"), false);
assert.equal(JSON.stringify(report).includes(cwd), false);
assertMetadataOnly(report);
assert.equal(fs.existsSync(path.join(cwd, ".pi", "learning-loop", "scorecards")), false, "no-write generation does not create scorecard state");

const written = adapter.generate({ gateEvidence: { C0: { ok: true, evidenceClass: "deterministic", evidenceIds: ["evidence-c0"] }, C1: { ok: true, evidenceClass: "synthetic", evidenceIds: ["evidence-c1"] } } });
assert.equal(written.gates.C0.status, "pass");
assert.equal(written.gates.C1.status, "pass");
assert.equal(written.evidenceClassCounts.synthetic, 1);
assert.equal(written.metrics.skills.failureLearning.postMitigationSuccess.value, 1);
assert.equal(adapter.generate({ write: false, gateEvidence: { C0: { ok: true, evidenceClass: "deterministic", evidenceIds: ["evidence-missing"] } } }).gates.C0.reasonCode, "evidence-not-found");
assert.equal(written.storage.private, true);
assert.equal(fs.statSync(path.join(cwd, written.storage.relativeLocation)).mode & 0o777, 0o600);
assert.equal(adapter.status().latest.decision, "no-go-deferred");

const cohortId = "exp-memory-learning-compounding-efficacy-field";
const cohortRows = [
  { evaluationId: "control-one", at: "2026-07-01T00:00:00.000Z", skillId: "skill-one", version: 2, sourceHash, exactVersion: true, evidenceClass: "exact-version-field", cohortId, arm: "control", sessionIdHash: session("1"), routingMode: "explicit", result: "failed", evidenceIds: [], latencyMs: 100, modelCalls: 2, toolCalls: 4, contextAdded: 100 },
  { evaluationId: "control-two", at: "2026-07-02T00:00:00.000Z", skillId: "skill-one", version: 2, sourceHash, exactVersion: true, evidenceClass: "exact-version-field", cohortId, arm: "control", sessionIdHash: session("2"), routingMode: "explicit", result: "succeeded", evidenceIds: ["evidence-control"], latencyMs: 100, modelCalls: 2, toolCalls: 4, contextAdded: 100 },
  { evaluationId: "candidate-one", at: "2026-07-03T00:00:00.000Z", skillId: "skill-one", version: 2, sourceHash, exactVersion: true, evidenceClass: "exact-version-field", cohortId, arm: "candidate", sessionIdHash: session("3"), routingMode: "explicit", result: "succeeded", evidenceIds: ["evidence-candidate-one"], latencyMs: 105, modelCalls: 2, toolCalls: 4, contextAdded: 105 },
  { evaluationId: "candidate-two", at: "2026-07-04T00:00:00.000Z", skillId: "skill-one", version: 2, sourceHash, exactVersion: true, evidenceClass: "exact-version-field", cohortId, arm: "candidate", sessionIdHash: session("4"), routingMode: "explicit", result: "succeeded", evidenceIds: ["evidence-candidate-two"], latencyMs: 105, modelCalls: 2, toolCalls: 4, contextAdded: 105 },
];
const cohortAdapter = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: cohortRows }) } });
const cohort = cohortAdapter.generate({ write: false, cohortId });
assert.equal(cohort.cohorts.comparison.status, "computed");
assert.equal(cohort.experiment.status, "collecting");
assert.equal(cohort.cohorts.comparison.passBar, true);
assert.equal(cohort.gates.C5.status, "pass");
assert.equal(cohort.cohorts.comparison.verifiedSuccess.delta, 0.5);
assert.equal(cohort.cohorts.comparison.unsupportedClaimRate.status, "insufficient-data", "missing user-reviewed labels are not inferred from evidence-link absence");
assert.equal(cohort.evidenceClassCounts["exact-version-field"], 5);
assert.equal(cohort.routingChangeAuthorized, false, "a passing scorecard gate never auto-authorizes routing");
const claimRows = cohortRows.map((row) => ({ ...row, result: "succeeded", unsupportedClaimDetected: row.arm === "control", userReviewEvidenceIds: [`gold-${row.evaluationId}`] }));
const claimImprovement = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: claimRows }) } }).generate({ write: false, cohortId });
assert.equal(claimImprovement.cohorts.comparison.unsupportedClaimRate.delta, -1);
assert.equal(claimImprovement.gates.C5.status, "pass", "user-reviewed unsupported-claim improvement can satisfy the preregistered efficacy bar");
const privacyRegression = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: claimRows }), memoryScorecard: () => ({ aggregates: { retrieval: {}, privacy: { unresolvedHighSeverity: 1, reviewedCandidates: 1 } }, scores: {}, decision: "no-go-deferred", highestAuthorizedStage: "M0" }) } }).generate({ write: false, cohortId });
assert.equal(privacyRegression.gates.C5.status, "fail");
assert.equal(privacyRegression.gates.C5.privacyViolations, 1);
for (const verdict of ["insufficient-data", "fail"]) {
  const pilotGuard = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: claimRows, reviewedPilot: { cohortId, verdict } }) } }).generate({ write: false, cohortId });
  assert.equal(pilotGuard.gates.C5.status, verdict, "the generic comparison cannot bypass pilot sample, exposure, identity or human-review gates");
  assert.equal(pilotGuard.gates.C3.status, verdict);
}
const unregistered = cohortAdapter.generate({ write: false, cohortId: "cohort-unregistered" });
assert.equal(unregistered.cohorts.comparison.reasonCode, "cohort-not-preregistered");

const invalidCohortAdapter = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: cohortRows.map((row, index) => index === 0 ? { ...row, exactVersion: false } : row) }) } });
const invalidCohort = invalidCohortAdapter.generate({ write: false, cohortId });
assert.equal(invalidCohort.cohorts.comparison.status, "insufficient-data");
assert.equal(invalidCohort.cohorts.comparison.reasonCode, "exact-version-identity-required");

const matureRows = Array.from({ length: 60 }, (_, index) => ({ evaluationId: `mature-${index}`, at: `2026-07-${String((index % 30) + 1).padStart(2, "0")}T00:00:00.000Z`, skillId: "skill-one", version: 2, sourceHash, exactVersion: true, evidenceClass: "exact-version-field", cohortId, arm: index < 30 ? "control" : "candidate", sessionIdHash: session(String(index % 10)), routingMode: "explicit", result: "succeeded", evidenceIds: [`evidence-mature-${index}`], latencyMs: 100, modelCalls: 2, toolCalls: 4, contextAdded: 100 }));
const mature = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: matureRows }) } }).generate({ write: false, cohortId });
assert.equal(mature.gates.C3.status, "pass", "mature exact-version identity, coverage, sessions, days, privacy, and quality non-regression satisfy C3");
assert.equal(mature.gates.C5.status, "fail", "non-regression alone does not satisfy the preregistered improvement bar");
assert.equal(mature.routingChangeAuthorized, false);
const missingPolicy = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: matureRows }), policyMetrics: () => ({ unresolvedHighSeverity: null, reviewedFindings: 0, evidenceClass: "user-reviewed-gold", evidenceIds: [] }) } }).generate({ write: false, cohortId });
assert.equal(missingPolicy.gates.C3.status, "insufficient-data");
assert.equal(missingPolicy.gates.C3.policyMeasured, false);
const missingCostRows = cohortRows.map((row) => row.arm === "candidate" ? { ...row, contextAdded: null } : row);
const missingCost = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: missingCostRows }) } }).generate({ write: false, cohortId });
assert.equal(missingCost.gates.C5.status, "insufficient-data");
assert.equal(missingCost.gates.C5.reasonCode, "cost-measurement-required");
const missingPrivacy = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: cohortRows }), memoryScorecard: () => ({ aggregates: { retrieval: {} }, scores: {}, decision: "no-go-deferred", highestAuthorizedStage: "M0" }) } }).generate({ write: false, cohortId });
assert.equal(missingPrivacy.gates.C5.status, "insufficient-data");
assert.equal(missingPrivacy.gates.C5.reasonCode, "privacy-measurement-required");
const machineOnly = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, skills: () => ({ ...providers.skills(), evaluations: [], machineVerificationPilot: { verdict: "pass", automaticReminderEnabled: true, humanReviewRequired: false } }) } }).generate({ write: false, cohortId });
assert.equal(machineOnly.machineVerificationPilot.automaticReminderEnabled, true);
assert.equal(machineOnly.gates.C3.status, "insufficient-data", "delivery completeness cannot masquerade as general skill quality");
assert.equal(machineOnly.highestAuthorizedProjectMemoryStage, "M0");
assert.equal(machineOnly.automaticBehaviorAuthorized, false);

const maintenanceDates = ["01", "05", "10", "15"];
const maintenanceCohort = maintenanceDates.map((day, index) => ({ reportId: `maintenance-${index}`, generatedAt: `2026-07-${day}T00:00:00.000Z`, candidateIds: ["candidate-stable"], accounting: { new: index === 0 ? ["candidate-stable"] : [], persistent: index === 0 ? [] : ["candidate-stable"], resolved: [], counts: { new: index === 0 ? 1 : 0, persistent: index === 0 ? 0 : 1, resolved: 0 } }, stageMetrics: { durationMs: 10, modelCalls: 0, toolCalls: 0, contextAdded: 0 }, boundaries: { retentionApplied: false, permissionsApplied: false, memoryWritten: false, notesWritten: false, sourceDeleted: false } }));
const maintenanceGate = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, maintenance: () => ({ reports: maintenanceCohort }) } }).generate({ write: false });
assert.equal(maintenanceGate.gates.C4.status, "pass");
assert.equal(maintenanceGate.metrics.maintenance.scheduledMutationViolations.value, 0);
assert.equal(maintenanceGate.metrics.maintenance.resolutionAccountingRate.value, 1);

const shadowPackets = Array.from({ length: 20 }, (_, index) => ({ packetId: `execout-shadow-${index}`, sourceKind: "goal", runId: `goal-shadow-${index}`, outcome: "succeeded", evidenceCount: 1, evidenceIds: ["evidence-one"], artifactCount: 0, metrics: { durationMs: 100, modelCalls: 1, toolCalls: 1, contextAdded: 10 }, provenance: { evidenceClass: "exact-version-field", arm: "unassigned" }, settledAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }));
const shadowOutcomes = Array.from({ length: 20 }, (_, index) => ({ outcomeId: `outcome-shadow-${index}`, packetId: `execout-shadow-${index}`, createdAt: shadowPackets[index].settledAt, source: "execution", evidenceClass: "exact-version-field", cohort: { id: null, arm: null, sessionIdHash: null }, status: "succeeded", verificationOk: true, userCorrectionDetected: false, evidenceIds: ["evidence-one"], classifications: ["verified-success"] }));
const shadow = new CompoundingEffectivenessAdapter({ cwd, providers: { ...providers, execution: () => ({ packets: shadowPackets, rejections: [] }), learning: () => ({ ...providers.learning(), outcomes: shadowOutcomes }) } }).generate({ write: false });
assert.equal(shadow.gates.C2.status, "pass");
assert.equal(shadow.gates.C2.evidenceCoverage, 1);
assert.equal(shadow.gates.C2.classificationCorrectionRate, 0);

const unsafeCwd = tmpFixture("compounding-symlink-root-");
const external = tmpFixture("compounding-external-");
fs.symlinkSync(external, path.join(unsafeCwd, ".pi"));
assert.throws(() => new CompoundingEffectivenessAdapter({ cwd: unsafeCwd }), /non-symlinked project state path/);

console.log("compounding effectiveness tests passed");
