"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createObsidianAdapter, obsidianDoctor } = require("../src/obsidian-adapter");
const { projectMemoryRuntimeConfig } = require("../src/project-memory-runtime");
const { ProjectMemoryAdapter } = require("../src/integration-boundary");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("project-memory-readiness-consistency-");
const cwd = path.join(tmp, "repo");
const vault = path.join(tmp, "vault");
fs.mkdirSync(path.join(cwd, ".pi", "memory-effectiveness"), { recursive: true });
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });

const source = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") });
const scorecard = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  decision: "ship",
  highestAuthorizedStage: "M5",
  source,
  evidenceQualification: { reviewedGoldQualified: true },
  scores: { privacyBoundary: { status: "pass" }, migrationRollback: { status: "pass" }, realCuration: { status: "pass" } },
  aggregates: {
    retrieval: { precisionAt5: 1, recallAt5: 1, contamination: 0 },
    performance: { localRecallP95Ms: 1 },
    field: { currentFactStaleRate: 0, exactVersionUses: 30, independentSessions: 10, observedDays: 14, automaticSavePrecision: 1 },
    saves: { precision: 1 },
    curation: { conflictReviewPassed: true, successRate: 1, timeoutRate: 0 },
    privacy: { unresolvedHighSeverity: 0 },
  },
};
fs.writeFileSync(path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json"), `${JSON.stringify(scorecard)}\n`, { mode: 0o600 });

const env = { ...process.env, PI_PROJECT_MEMORY_POSTURE: "env", PI_OBSIDIAN_VAULT: vault, PI_OBSIDIAN_ALLOW_OUTSIDE: "1", PI_PROJECT_MEMORY_STAGE: "M5", PI_PROJECT_MEMORY_AUTO_SAVE: "1" };
const runtime = projectMemoryRuntimeConfig(cwd, env);
const obsidian = createObsidianAdapter({ vault, allowOutsideCwd: true, hermesEnabled: false, bin: "missing-obsidian-fixture" });

(async () => {
  const status = await obsidian.status({ cwd }, {});
  const doctor = obsidianDoctor(cwd, { vault, allowOutsideCwd: true, hermesEnabled: false, bin: "missing-obsidian-fixture" });
  const projectMemory = new ProjectMemoryAdapter(runtime.adapter);
  const durableStatus = projectMemory.status();

  for (const surface of [status.details.selection, doctor.selection, runtime.selection, durableStatus.selection]) {
    assert.equal(surface.selectionId, runtime.selection.selectionId);
    assert.equal(surface.projectKey, runtime.selection.projectKey);
    assert.equal(surface.pathHash, runtime.selection.pathHash);
  }
  assert.equal(runtime.readiness.vaultFilesystem.ready, true);
  assert.equal(runtime.readiness.projectMemoryReads.ready, true);
  assert.equal(runtime.readiness.projectMemoryExplicitWrites.ready, true);
  assert.equal(runtime.readiness.automaticBehaviorAuthorized.ready, true);

  const saved = projectMemory.save({ kind: "decision", title: "Readiness consistency", content: "All memory surfaces share one selection identity.", verification: "verified", sourceFingerprints: ["fixture:readiness"], evidenceIds: ["evidence_readiness_fixture"] }, { apply: true, explicit: true });
  assert.equal(saved.applied, true, "explicitly authorized save writes canonical memory");
  const recalled = projectMemory.recall("Readiness consistency", { cacheOnly: true, limit: 3 });
  assert.equal(recalled.cacheSourceMatch, true, "save rebuilds cache from the same canonical decision");
  assert.equal(recalled.items[0].title, "Readiness consistency");
  assert.equal(recalled.selectionId, runtime.selection.selectionId);
  assert.equal(recalled.projectKey, runtime.selection.projectKey);

  const m0 = projectMemoryRuntimeConfig(cwd, { ...env, PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0" });
  assert.equal(m0.rollout.effectiveStage, "M0");
  assert.equal(m0.readiness.projectMemoryReads.ready, true);
  assert.equal(m0.readiness.projectMemoryExplicitWrites.ready, false);
  assert.equal(m0.readiness.automaticBehaviorAuthorized.ready, false);

  const missingPath = path.join(tmp, "missing-configured-vault");
  const missing = projectMemoryRuntimeConfig(cwd, { ...env, PI_OBSIDIAN_VAULT: missingPath });
  const missingAdapter = createObsidianAdapter({ vault: missingPath, allowOutsideCwd: true });
  assert.equal(missing.selection.selectionId, missingAdapter.resolveVaultSelection({ cwd }).selectionId);
  assert.equal(missing.selection.source, "configured");
  assert.equal(missing.readiness.vaultFilesystem.status, "missing");

  const discoveredA = path.join(tmp, "discovered-a");
  const discoveredB = path.join(tmp, "discovered-b");
  fs.mkdirSync(path.join(discoveredA, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(discoveredB, ".obsidian"), { recursive: true });
  const discoveryEnv = { ...env, PI_OBSIDIAN_VAULT: "", PI_OBSIDIAN_DEFAULT_VAULT: path.join(tmp, "managed-default") };
  const discoveredCandidates = [{ path: discoveredA, exists: true, isVault: true }, { path: discoveredB, exists: true, isVault: true }];
  const ambiguous = projectMemoryRuntimeConfig(cwd, discoveryEnv, { discoveredCandidates });
  const ambiguousAdapter = createObsidianAdapter({ vault: null, defaultVault: path.join(tmp, "managed-default"), allowOutsideCwd: true });
  const ambiguousSelection = ambiguousAdapter.resolveVaultSelection({ cwd }, { discoveredCandidates });
  assert.equal(ambiguous.selection.selectionId, ambiguousSelection.selectionId);
  assert.equal(ambiguous.selection.ambiguous, true);
  assert.equal(ambiguous.adapter.enabled, false);

  const deniedEnv = { ...env, PI_OBSIDIAN_ALLOW_OUTSIDE: "0", PI_OBSIDIAN_VAULT: path.join(tmp, "denied") };
  const denied = projectMemoryRuntimeConfig(cwd, deniedEnv);
  const deniedAdapter = createObsidianAdapter({ vault: path.join(tmp, "denied"), allowOutsideCwd: false });
  assert.equal(denied.selection.selectionId, deniedAdapter.resolveVaultSelection({ cwd }).selectionId);
  assert.equal(denied.selection.source, "denied");
  assert.equal(denied.adapter.enabled, false);

  console.log("project-memory readiness consistency tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
