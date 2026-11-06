"use strict";

const assert = require("node:assert/strict");
const { MemoryJsonStorage, createPiIntegrationBoundary } = require("../src/integration-boundary");
const { Skill, ExecutionCapture, skillFromCaptures } = require("../src/skill-synthesis");
const { normalizeSkillGovernance, normalizeSkillEvaluation, applyEvaluation, approvalGate, sha256 } = require("../src/skill-governance");

const legacy = new Skill({ skillId: "skill_legacy", name: "Legacy approved", description: "Reviewed legacy guidance", category: "general", status: "approved", workflowSteps: [{ description: "Inspect and verify evidence" }], validationStrategy: { kind: "evidence", requiredEvidence: ["verification"] }, confidenceScore: 0.9, provenance: { sources: ["legacy-import"] } });
assert.equal(legacy.governanceSchemaVersion, 2);
assert.equal(legacy.approvals.advisoryRetrieval, "allowed", "legacy approved maps only to advisory retrieval");
assert.equal(legacy.approvals.routing, "not-approved");
assert.equal(legacy.approvals.publishing, "not-approved");
assert.equal(legacy.evidenceState.field.status, "insufficient-data");
assert.equal(legacy.evidenceState.field.exactVersionUses, 0);

const boundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), skills: { options: { loadNative: false } } });
const curated = boundary.skills.getSkill("skill_curated_debug_verify");
assert.equal(curated.evidenceState.sourceTrust.status, "trusted");
assert.equal(curated.evidenceState.schema.status, "valid");
assert.equal(curated.evidenceState.sandbox.status, "not-run");
assert.equal(curated.evidenceState.localVerification.status, "insufficient-data");
assert.equal(curated.evidenceState.field.status, "insufficient-data", "curated fixtures are not field proof");
assert.equal(curated.approvals.routing, "not-approved");

const capture = new ExecutionCapture({ captureId: "cap_governance", source: "topology-run", runId: "toprun_governance", task: "Verify governance", outcome: "succeeded", verification: { ok: true }, workflowSteps: [{ kind: "verify", description: "Run focused verification", status: "succeeded" }], toolSequence: [{ tool: "test_runner", ok: true }] });
boundary.skills.capture(capture);
const synthesized = skillFromCaptures([capture], { skillId: "skill_synth_governance", name: "Governed synthesis" });
boundary.skills.store.saveSkill(synthesized);
let governed = boundary.skills.getSkill(synthesized.skillId);
assert.equal(governed.evidenceState.sourceTrust.status, "reviewed");
assert.equal(governed.evidenceState.localVerification.status, "passed");
assert.equal(governed.evidenceState.localVerification.captureCount, 1);
assert.equal(governed.evidenceState.field.status, "insufficient-data");
assert.equal(governed.approvals.routing, "not-approved");
assert.throws(() => boundary.skills.synthesizeTopologyTemplate(governed.skillId), /routing-not-approved/);

const approvedRouting = boundary.skills.approve(governed.skillId, { scope: "routing" });
assert.equal(approvedRouting.approvals.routing, "approved");
assert.equal(approvedRouting.approvals.publishing, "not-approved");
assert.doesNotThrow(() => boundary.skills.synthesizeTopologyTemplate(governed.skillId));
const revokedRouting = boundary.skills.approve(governed.skillId, { scope: "routing", decision: "revoke" });
assert.equal(revokedRouting.approvals.routing, "revoked");
assert.throws(() => boundary.skills.synthesizeTopologyTemplate(governed.skillId), /routing-not-approved/);
boundary.skills.approve(governed.skillId, { scope: "routing" });

const sourceHash = boundary.skills.getSkill(governed.skillId).evidenceState.sourceTrust.sourceHash;
const evaluated = boundary.skills.evaluate(governed.skillId, {
  ok: true,
  version: governed.version,
  sourceHash,
  captureId: capture.captureId,
  outcomeId: "outcome_governance_1",
  routingMode: "explicit",
  evidenceClass: "exact-version-field",
  cohortId: "cohort-governance",
  arm: "candidate",
  sessionIdHash: sha256("session-governance-1"),
  evidenceIds: ["evidence_governance_1"],
  unsupportedClaimDetected: false,
  userReviewEvidenceIds: ["evidence_gold_governance_1"],
  latencyMs: 12,
  toolCalls: 2,
  modelCalls: 1,
  task: "PRIVATE TASK BODY MUST BE HASHED",
});
assert.equal(evaluated.evidenceState.field.exactVersionUses, 1);
assert.equal(evaluated.evidenceState.field.independentSessions, 1);
assert.equal(evaluated.evidenceState.field.status, "insufficient-data");
const rows = boundary.skills.listEvaluations(governed.skillId);
assert.equal(rows.length, 1);
assert.equal(rows[0].skillId, governed.skillId);
assert.equal(rows[0].version, governed.version);
assert.equal(rows[0].evidenceClass, "exact-version-field");
assert.equal(rows[0].unsupportedClaimDetected, false);
assert.deepEqual(rows[0].userReviewEvidenceIds, ["evidence_gold_governance_1"]);
assert.equal(rows[0].contextAdded, null, "unmeasured context cost is not normalized to zero");
const incompleteField = normalizeSkillEvaluation(boundary.skills.getSkill(governed.skillId), { evidenceClass: "exact-version-field", version: governed.version, sourceHash }, "2026-07-31T01:00:00.000Z");
assert.equal(incompleteField.evidenceClass, "deterministic", "field evidence is downgraded without preregistered cohort/session identity");
assert.equal(rows[0].sourceHash, sourceHash);
assert.equal(rows[0].exactVersion, true);
assert.equal(rows[0].routingMode, "explicit");
assert.equal(rows[0].result, "succeeded");
assert.equal(rows[0].cohortId, "cohort-governance");
assert.equal(rows[0].arm, "candidate");
assert.match(rows[0].sessionIdHash, /^sha256:/);
assert.match(rows[0].taskHash, /^sha256:/);
assert.doesNotMatch(JSON.stringify(rows), /PRIVATE TASK BODY MUST BE HASHED|prompt|transcript|commandArgs|toolOutput/);

const mismatched = boundary.skills.evaluate(governed.skillId, { ok: true, version: governed.version, sourceHash: sha256("other-version"), evidenceClass: "exact-version-field", evidenceIds: ["evidence_wrong_version"] });
assert.equal(mismatched.evidenceState.field.exactVersionUses, 1, "another source hash does not count as exact-version field use");

const current = boundary.skills.getSkill(governed.skillId);
assert.throws(() => boundary.skills.approve(current.skillId, { scope: "publishing" }), /exact-version-not-field-proven/);
current.evidenceState.field.status = "field-proven";
current.evidenceState.field.exactVersionUses = 30;
current.evidenceState.field.observedDays = 14;
boundary.skills.store.saveSkill(current, { version: false });
const publishing = boundary.skills.approve(current.skillId, { scope: "publishing" });
assert.equal(publishing.approvals.publishing, "approved");
assert.equal(publishing.approvals.routing, "approved");

const imported = boundary.skills.registerProvider({ providerId: "external-import", skills: [{ skillId: "skill_untrusted_import", name: "Untrusted import", description: "Imported candidate", category: "general", status: "approved", workflowSteps: [{ description: "Inspect and verify evidence" }], validationStrategy: { kind: "evidence", requiredEvidence: ["verification"] }, confidenceScore: 0.95 }] }).skills[0];
assert.equal(imported.evidenceState.sourceTrust.status, "untrusted");
assert.equal(imported.approvals.advisoryRetrieval, "allowed", "legacy approved import remains advisory-compatible");
assert.equal(imported.approvals.routing, "not-approved");
assert.throws(() => boundary.skills.approve(imported.skillId, { scope: "routing" }), /source-not-trusted-or-reviewed/);
assert.throws(() => boundary.skills.synthesizeTopologyTemplate(imported.skillId), /source-not-trusted-or-reviewed|routing-not-approved/);

const invalid = boundary.skills.getSkill(imported.skillId);
invalid.evidenceState.schema.status = "invalid";
assert.equal(approvalGate(invalid, "routing").ok, false);

const fixture = { skillId: "skill_eval_fixture", version: 3, name: "Fixture", description: "Fixture", category: "general", workflowSteps: [], validationStrategy: { kind: "evidence" }, provenance: { sources: ["synthesis"], captureIds: [] }, successMetrics: {} };
const evaluationA = normalizeSkillEvaluation(fixture, { ok: true, evidenceClass: "exact-version-field", evidenceIds: ["evidence_a"], cohortId: "cohort-fixture", arm: "candidate", sessionIdHash: sha256("session-a") }, "2026-07-01T00:00:00.000Z");
const evaluationB = normalizeSkillEvaluation(fixture, { ok: true, evidenceClass: "exact-version-field", evidenceIds: ["evidence_b"], cohortId: "cohort-fixture", arm: "candidate", sessionIdHash: sha256("session-b") }, "2026-07-15T00:00:00.000Z");
applyEvaluation(fixture, evaluationB, [evaluationA]);
assert.equal(fixture.evidenceState.field.exactVersionUses, 2);
assert.equal(fixture.evidenceState.field.observedDays, 2);
assert.equal(fixture.evidenceState.field.independentSessions, 2);

const status = boundary.skills.status();
assert.equal(status.governanceSchemaVersion, 2);
assert.equal(status.fieldProven, 1);
assert(status.topSkills.every((skill) => skill.evidenceState && skill.approvals));
const exported = boundary.skills.exportPacket();
assert.equal(exported.version, 2);
assert.equal(exported.governanceSchemaVersion, 2);
assert(exported.skills.every((skill) => skill.governanceSchemaVersion === 2));
assert.equal(normalizeSkillGovernance(curated).evidenceState.field.status, "insufficient-data");

console.log("skill-governance tests passed");
