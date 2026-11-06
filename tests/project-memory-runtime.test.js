"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { buildScorecard, loadJson } = require("../src/memory-effectiveness");
const { projectMemoryRuntimeConfig } = require("../src/project-memory-runtime");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("project-memory-runtime-"); const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault"); const scoreDir = path.join(cwd, ".pi", "memory-effectiveness"); fs.mkdirSync(scoreDir, { recursive: true }); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const source = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") }); assert.equal(source.revision, `content:${source.configHash.slice(7)}`, "source identity is content-addressed and remains stable when the enclosing Git commit changes HEAD");
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), decision: "ship", highestAuthorizedStage: "M5", source, evidenceQualification: { reviewedGoldQualified: true }, scores: { privacyBoundary: { status: "pass" }, migrationRollback: { status: "pass" }, realCuration: { status: "pass" } }, aggregates: { retrieval: { precisionAt5: 1, recallAt5: 1, contamination: 0 }, performance: { localRecallP95Ms: 1 }, field: { currentFactStaleRate: 0, exactVersionUses: 30, independentSessions: 10, observedDays: 14, automaticSavePrecision: 1 }, saves: { precision: 1 }, curation: { conflictReviewPassed: true, successRate: 1, timeoutRate: 0 }, privacy: { unresolvedHighSeverity: 0 } } };
// These fixtures exercise scorecard/manual authority, independently of the
// operator automatic defaults covered by project-memory-automatic.test.js.
// PI_PROJECT_MEMORY_POSTURE=env keeps this fixture on environment precedence so
// the repository's declared posture does not leak into the authority assertions.
const env = { ...process.env, PI_PROJECT_MEMORY_POSTURE: "env", PI_OBSIDIAN_VAULT: vault, PI_OBSIDIAN_ALLOW_OUTSIDE: "1", PI_PROJECT_MEMORY_STAGE: "M5", PI_PROJECT_MEMORY_AUTO_SAVE: "1", PI_PROJECT_MEMORY_AUTOMATIC: "0" };
function write(card) { fs.writeFileSync(path.join(scoreDir, "scorecard.json"), `${JSON.stringify(card)}\n`, { mode: 0o600 }); }
write({ ...evidence, source: { revision: "stale", configHash: "sha256:deadbeef" } });
const stale = projectMemoryRuntimeConfig(cwd, env); assert.equal(stale.scorecard.fresh, false); assert.equal(stale.rollout.effectiveStage, "M0"); assert.equal(stale.rollout.controls.automaticVerifiedUpserts, false); assert(stale.scorecard.freshnessReasons.includes("source-revision-mismatch")); assert(stale.scorecard.freshnessReasons.includes("config-hash-mismatch")); assert.equal(stale.selection.source, "configured"); assert.equal(stale.readiness.projectMemoryReads.ready, true); assert.equal(stale.readiness.projectMemoryExplicitWrites.ready, false); assert.equal(stale.readiness.automaticBehaviorAuthorized.ready, false);
write(evidence); const fresh = projectMemoryRuntimeConfig(cwd, env); assert.equal(fresh.scorecard.fresh, true); assert.equal(fresh.rollout.effectiveStage, "M5"); assert.equal(fresh.rollout.controls.automaticVerifiedUpserts, true); assert.equal(fresh.readiness.projectMemoryReads.ready, true); assert.equal(fresh.readiness.projectMemoryExplicitWrites.ready, true); assert.equal(fresh.readiness.automaticBehaviorAuthorized.ready, true); assert.equal(fresh.adapter.selection.selectionId, fresh.selection.selectionId);
assert.equal(stale.readiness.vaultConfirmation.confirmed, true);
assert.equal(stale.readiness.vaultConfirmation.source, "configured");
assert.equal(fresh.readiness.canonicalProjectFolder.status, "missing");
assert.equal(fresh.canonicalProjectFolder.exists, false);
const projectFolder = path.join(vault, "Memory", "Projects", fresh.canonicalProjectFolder.name);
fs.mkdirSync(projectFolder, { recursive: true });
const provisioned = projectMemoryRuntimeConfig(cwd, env);
assert.equal(provisioned.canonicalProjectFolder.exists, true);
assert.equal(provisioned.readiness.canonicalProjectFolder.status, "ready");
const fallback = projectMemoryRuntimeConfig(cwd, { ...env, PI_OBSIDIAN_VAULT: undefined, PI_OBSIDIAN_DEFAULT_ROOT: path.join(tmp, "fallback-root") }, { discoveredCandidates: [] });
assert.equal(fallback.selection.source, "default-managed");
assert.equal(fallback.readiness.vaultConfirmation.confirmed, false);
assert.equal(fallback.readiness.vaultConfirmation.status, "unconfirmed");
// Freshness and passing synthetic metrics are not reviewed-gold qualification.
const manifest = loadJson(path.join(__dirname, "fixtures", "memory-effectiveness", "manifest.json"));
const synthetic = buildScorecard({
  manifest, source,
  retrievalResults: manifest.retrievalCases.map((row) => ({ id: row.id, rankedIds: [...row.relevantIds] })),
  saveResults: manifest.saveCases.map((row) => ({ id: row.id, outcome: row.expected })),
  performance: evidence.aggregates.performance,
  migration: { rollbackPassed: true, fixtures: 1 },
  privacy: { evidenceQualified: true, unresolvedHighSeverity: 0, unresolvedActionable: 0 },
});
assert.equal(synthetic.highestAuthorizedStage, "M0");
assert.equal(synthetic.evidenceQualification.reviewedGoldQualified, false);
assert.equal(synthetic.scores.retrievalPrecisionAt5.status, "pass");
assert.equal(synthetic.scores.retrievalPrecisionAt5.gateEligible, false);
write(synthetic);
const syntheticRuntime = projectMemoryRuntimeConfig(cwd, { ...env, PI_PROJECT_MEMORY_STAGE: "M2", PI_PROJECT_MEMORY_WRITES: "1" });
assert.equal(syntheticRuntime.scorecard.fresh, true);
assert.equal(syntheticRuntime.rollout.effectiveStage, "M1", "fresh synthetic metrics cannot authorize M2 without reviewed gold");
assert.equal(syntheticRuntime.rollout.promotionBlocked, true);
assert.equal(syntheticRuntime.rollout.controls.taskRecall, false);
assert.equal(projectMemoryRuntimeConfig(cwd, { ...env, PI_PROJECT_MEMORY_STAGE: undefined }).rollout.effectiveStage, "M0", "the scorecard's default stage is preserved");

// Even an optimistic stage claim and all passing metrics cannot replace the
// explicit qualification produced by the reviewed-gold validation pipeline.
for (const qualification of [undefined, {}, { reviewedGoldQualified: false }, { reviewedGoldQualified: "true" }, { reviewedGoldQualified: 1 }]) {
  write({ ...evidence, evidenceQualification: qualification });
  for (const stage of ["M2", "M3", "M4", "M5"]) {
    const denied = projectMemoryRuntimeConfig(cwd, { ...env, PI_PROJECT_MEMORY_STAGE: stage, PI_PROJECT_MEMORY_WRITES: "1" });
    assert.equal(denied.scorecard.fresh, true);
    assert.equal(denied.rollout.evidenceEligibleStage, "M1");
    assert.equal(denied.rollout.effectiveStage, "M1");
    assert.equal(denied.rollout.promotionBlocked, true);
    assert.equal(denied.readiness.automaticBehaviorAuthorized.ready, false);
    for (const control of ["taskRecall", "candidateCapture", "reviewQueueWrites", "hermesCuration", "automaticVerifiedUpserts"]) {
      assert.equal(denied.rollout.controls[control], false, `${stage} cannot grant ${control} without reviewed gold`);
    }
  }
  const manualUnqualified = projectMemoryRuntimeConfig(cwd, { ...env, PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1" });
  assert.equal(manualUnqualified.rollout.effectiveStage, "M1");
  assert.equal(manualUnqualified.adapter.writeEnabled, true, "reviewed gold is not required for manual M1 saves");
  assert.equal(manualUnqualified.rollout.controls.taskRecall, false);
}
write({ ...evidence, aggregates: { ...evidence.aggregates, retrieval: { ...evidence.aggregates.retrieval, precisionAt5: 0.89 } } });
assert.equal(projectMemoryRuntimeConfig(cwd, env).rollout.effectiveStage, "M1", "reviewed gold does not bypass retrieval thresholds");

write({ ...evidence, generatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }); const expired = projectMemoryRuntimeConfig(cwd, env); assert.equal(expired.scorecard.fresh, false); assert(expired.scorecard.freshnessReasons.includes("scorecard-expired")); assert.equal(expired.rollout.effectiveStage, "M0");
// Explicit manual M1 is separate from (and never repairs) stale field evidence.
const manualEnv = { ...env, PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1" };
const manual = projectMemoryRuntimeConfig(cwd, manualEnv);
assert.equal(manual.scorecard.fresh, false);
assert.equal(manual.rollout.evidenceEligibleStage, "M0");
assert.equal(manual.rollout.effectiveStage, "M1");
assert.equal(manual.rollout.stageAuthority, "explicit-m1-opt-in");
assert.equal(manual.adapter.writeEnabled, true);
assert.equal(manual.readiness.automaticBehaviorAuthorized.ready, false);
for (const control of ["taskRecall", "automaticCapture", "candidateCapture", "reviewQueueWrites", "hermesCuration", "automaticVerifiedUpserts", "cognitiveConsolidation", "retentionApply"]) {
  assert.equal(manual.rollout.controls[control], false, `manual M1 does not grant ${control}`);
}
for (const override of [
  { PI_PROJECT_MEMORY_STAGE: "M0" },
  { PI_PROJECT_MEMORY_STAGE: "M2" },
  { PI_PROJECT_MEMORY_STAGE: "M5" },
  { PI_PROJECT_MEMORY_WRITES: undefined },
  { PI_PROJECT_MEMORY_WRITES: "true" },
  { PI_PROJECT_MEMORY_WRITES: "0" },
  { PI_PROJECT_MEMORY: "0" },
]) {
  const denied = projectMemoryRuntimeConfig(cwd, { ...manualEnv, ...override });
  assert.equal(denied.rollout.effectiveStage, "M0", JSON.stringify(override));
  assert.equal(denied.adapter.writeEnabled, false);
}
fs.unlinkSync(path.join(scoreDir, "scorecard.json"));
assert.equal(projectMemoryRuntimeConfig(cwd, manualEnv).rollout.effectiveStage, "M1", "manual opt-in does not fabricate a scorecard");
assert.equal(projectMemoryRuntimeConfig(cwd, { ...manualEnv, PI_OBSIDIAN_VAULT: path.join(tmp, "missing") }).adapter.writeEnabled, false, "opt-in does not create or bypass a missing vault");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("project memory runtime tests passed");
