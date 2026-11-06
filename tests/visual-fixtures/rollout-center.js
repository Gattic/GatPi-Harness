"use strict";

const { renderRolloutCenterFrame } = require("../../src/rollout-center-view");

const provenance = [{ ref: "rollout:fixture:one", sourceId: "fixture", recordType: "scorecard", schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", fingerprint: "sha256:fixture", evidenceRef: "evidence-fixture", freshness: "current" }];
const capability = (capabilityId, stage, tech, policy, field) => ({
  capabilityId, currentStage: stage,
  technicalReadiness: { status: tech, reasonCodes: [] },
  policyAuthorization: { status: policy, mutationAllowed: false, automationAllowed: false, reasonCodes: [] },
  fieldProof: { status: field, evidenceClass: "deterministic", sampleSize: 0, observedDays: 0, exactIdentity: false, lastObservedAt: null, evidenceRefs: [], reasonCodes: [] },
  rollbackControl: { status: "available", controlIds: ["fixture-control"], reasonCodes: [] },
  nextObservation: { status: "permitted", actionCode: "collect-readonly-evidence", surfaceId: "fixture-status", prohibitedEffects: ["mutation"] },
  provenance,
});
const snapshot = {
  schemaVersion: 1, snapshotId: "rollout_fixture", generatedAt: "2026-01-01T00:00:00.000Z", posture: "observation-only",
  counts: { stale: 0 },
  capabilities: [
    capability("role-runtime", "R0", "ready", "read-only", "insufficient-data"),
    capability("project-memory", "M0", "degraded", "advisory-only", "stale"),
    capability("verification-center", "operational", "ready", "read-only", "insufficient-data"),
  ],
};

function capture(input = {}) {
  const width = Number(input.width) || 72;
  return { width, lines: renderRolloutCenterFrame(snapshot, { selectedIndex: 0, filter: "all", mode: input.mode || "detail" }, width) };
}

module.exports = { capture, snapshot };
