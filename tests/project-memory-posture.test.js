"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readProjectMemoryPosture, applyProjectMemoryPosture } = require("../src/project-memory-posture.js");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout.js");
const { projectMemoryRuntimeConfig } = require("../src/project-memory-runtime.js");
const { createPiIntegrationBoundary } = require("../src/integration-boundary.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function fixture(posture) {
  const root = tmpFixture("memory-posture-");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  if (posture !== undefined) fs.writeFileSync(path.join(root, "config", "memory-posture.json"), typeof posture === "string" ? posture : JSON.stringify(posture));
  return root;
}

// No declared posture: inherited stage exports keep their documented precedence.
const absentRoot = fixture(undefined);
assert.equal(readProjectMemoryPosture({ root: absentRoot }).present, false);
const absentEnv = { PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0" };
const absent = applyProjectMemoryPosture(absentEnv, { root: absentRoot });
assert.deepEqual(absent.env, absentEnv, "absent posture leaves the environment untouched");
assert.equal(resolveProjectMemoryRollout(absent.env).effectiveStage, "M0");

// A declared M1 posture outranks stale inherited exports.
const declaredRoot = fixture({ schemaVersion: 1, stage: "M1", writes: true, automatic: true, autoSave: true, recordedAt: "2026-10-25", rationale: "operator-authorized selective capture" });
const declared = readProjectMemoryPosture({ root: declaredRoot });
assert.equal(declared.present, true);
assert.equal(declared.invalid, false);
assert.deepEqual(declared.overrides, {
  PI_PROJECT_MEMORY_STAGE: "M1",
  PI_PROJECT_MEMORY_WRITES: "1",
  PI_PROJECT_MEMORY_AUTOMATIC: "1",
  PI_PROJECT_MEMORY_AUTO_SAVE: "1",
});
const staleEnv = { PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_AUTOMATIC: "1" };
const applied = applyProjectMemoryPosture(staleEnv, { root: declaredRoot });
assert.equal(applied.env.PI_PROJECT_MEMORY_STAGE, "M1");
assert.equal(applied.env.PI_PROJECT_MEMORY_AUTO_SAVE, "1");
const rollout = resolveProjectMemoryRollout(applied.env);
assert.equal(rollout.effectiveStage, "M1");
assert.equal(rollout.stageAuthority, "operator-opt-in");
assert.equal(rollout.operatorAutomatic, true);
assert.equal(rollout.fieldEffectiveness, "unproven");
assert.equal(rollout.controls.explicitWrites, true);
assert.equal(rollout.controls.taskRecall, true);
assert.equal(rollout.controls.automaticCapture, true);
for (const control of ["candidateCapture", "reviewQueueWrites", "hermesCuration", "automaticVerifiedUpserts"]) {
  assert.equal(rollout.controls[control], false, `${control} is not granted by the declared M1 posture`);
}

// The unconditional kill switch still wins: posture never declares it.
const killed = resolveProjectMemoryRollout({ ...applied.env, PI_PROJECT_MEMORY: "0" });
assert.equal(killed.enabled, false);
assert.equal(killed.controls.reads, false);
assert.equal(killed.controls.automaticCapture, false);
assert.equal(killed.controls.taskRecall, false);

// PI_PROJECT_MEMORY_POSTURE=env restores environment precedence for a session that
// deliberately overrides one stage key without editing the recorded posture.
const envPrecedence = applyProjectMemoryPosture({ ...staleEnv, PI_PROJECT_MEMORY_POSTURE: "env" }, { root: declaredRoot });
assert.equal(envPrecedence.posture.envPrecedence, true);
assert.equal(envPrecedence.env.PI_PROJECT_MEMORY_STAGE, "M0");
assert.equal(envPrecedence.env.PI_PROJECT_MEMORY_AUTO_SAVE, "0");
const perSession = resolveProjectMemoryRollout(envPrecedence.env);
assert.equal(perSession.effectiveStage, "M0");
assert.equal(perSession.controls.automaticCapture, false);
assert.equal(perSession.controls.explicitWrites, false, "the overridden M0 stage grants no writes even with PI_PROJECT_MEMORY_WRITES=1");

// Invalid declarations fail safe: the file is reported and env precedence remains.
for (const [label, content, reason] of [
  ["invalid-json", "{not json", "invalid-json"],
  ["invalid-schema", JSON.stringify({ stage: "M1" }), "invalid-schema"],
  ["invalid-stage", JSON.stringify({ schemaVersion: 1, stage: "M9" }), "invalid-stage"],
  ["null-value", "null", "invalid-schema"],
  ["array-value", "[]", "invalid-schema"],
  ["invalid-writes", JSON.stringify({ schemaVersion: 1, stage: "M1", writes: "true" }), "invalid-writes"],
  ["invalid-automatic", JSON.stringify({ schemaVersion: 1, stage: "M1", automatic: 1 }), "invalid-automatic"],
  ["invalid-auto-save", JSON.stringify({ schemaVersion: 1, stage: "M1", autoSave: "1" }), "invalid-auto-save"],
]) {
  const root = fixture(content);
  const posture = readProjectMemoryPosture({ root });
  assert.equal(posture.present, true, label);
  assert.equal(posture.invalid, true, label);
  assert.equal(posture.reason, reason, label);
  assert.deepEqual(posture.overrides, {}, `${label} declares no overrides`);
  assert.deepEqual(applyProjectMemoryPosture(staleEnv, { root }).env, staleEnv, `${label} does not override the environment`);
}

// A file that exists but cannot be read is reported as present-but-invalid
// rather than as an absent declaration.
const directoryRoot = fixture(undefined);
fs.mkdirSync(path.join(directoryRoot, "config", "memory-posture.json"));
const directoryPosture = readProjectMemoryPosture({ root: directoryRoot });
assert.equal(directoryPosture.present, true);
assert.equal(directoryPosture.invalid, true);
assert.match(directoryPosture.reason, /^read-failed:/);
assert.deepEqual(applyProjectMemoryPosture(staleEnv, { root: directoryRoot }).env, staleEnv);

// Oversized declarations are rejected without being parsed.
const oversizedRoot = fixture(`{"schemaVersion":1,"stage":"M1","rationale":"${"x".repeat(70 * 1024)}"}`);
const oversizedPosture = readProjectMemoryPosture({ root: oversizedRoot });
assert.equal(oversizedPosture.invalid, true);
assert.equal(oversizedPosture.reason, "oversized");
assert.deepEqual(applyProjectMemoryPosture(staleEnv, { root: oversizedRoot }).env, staleEnv);

// Absent declared fields keep environment precedence for that key only.
const partialRoot = fixture({ schemaVersion: 1, stage: "M1", writes: true });
const partial = applyProjectMemoryPosture({ PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0" }, { root: partialRoot });
assert.equal(partial.env.PI_PROJECT_MEMORY_STAGE, "M1");
assert.equal(partial.env.PI_PROJECT_MEMORY_WRITES, "1");
assert.equal(partial.env.PI_PROJECT_MEMORY_AUTO_SAVE, "0", "an undeclared autoSave keeps the environment value");
assert.equal(partial.posture.overrides.PI_PROJECT_MEMORY_AUTOMATIC, undefined);

// The kill switch disables every control, including the separately opted-in
// consolidation and retention-apply controls.
const killedAll = resolveProjectMemoryRollout({ ...applied.env, PI_PROJECT_MEMORY: "0", PI_PROJECT_MEMORY_COGNITIVE_CONSOLIDATION: "1", PI_PROJECT_MEMORY_RETENTION_APPLY: "1" });
assert.equal(killedAll.enabled, false);
assert.equal(killedAll.controls.cognitiveConsolidation, false);
assert.equal(killedAll.controls.retentionApply, false);

// Runtime resolution: a stale scorecard blocks evidence promotion but not the
// declared operator posture.
const runtimeCwd = tmpFixture("memory-posture-runtime-");
const vault = path.join(runtimeCwd, "vault");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
fs.mkdirSync(path.join(runtimeCwd, ".pi", "memory-effectiveness"), { recursive: true });
fs.writeFileSync(path.join(runtimeCwd, ".pi", "memory-effectiveness", "scorecard.json"), JSON.stringify({ schemaVersion: 1, highestAuthorizedStage: "M0", generatedAt: "2026-08-14T00:00:00.000Z", source: { revision: "stale", configHash: "stale" } }));
const runtime = projectMemoryRuntimeConfig(runtimeCwd, { ...staleEnv, PI_OBSIDIAN_VAULT: vault }, { root: declaredRoot });
assert.equal(runtime.rollout.effectiveStage, "M1");
assert.equal(runtime.rollout.stageAuthority, "operator-opt-in");
assert.equal(runtime.scorecard.fresh, false, "stale scorecard is still reported");
assert(runtime.scorecard.freshnessReasons.includes("scorecard-expired"));
assert.equal(runtime.posture.present, true);
assert.equal(runtime.posture.declared.PI_PROJECT_MEMORY_STAGE, "M1");

// The runtime kill switch wins over the declared posture, and an invalid
// declaration is surfaced instead of silently applied.
const runtimeKilled = projectMemoryRuntimeConfig(runtimeCwd, { ...staleEnv, PI_OBSIDIAN_VAULT: vault, PI_PROJECT_MEMORY: "0" }, { root: declaredRoot });
assert.equal(runtimeKilled.rollout.enabled, false);
assert.equal(runtimeKilled.rollout.controls.reads, false);
assert.equal(runtimeKilled.rollout.controls.explicitWrites, false);
assert.equal(runtimeKilled.rollout.controls.automaticCapture, false);
assert.equal(runtimeKilled.adapter.writeEnabled, false);
const runtimeInvalid = projectMemoryRuntimeConfig(runtimeCwd, { ...staleEnv, PI_OBSIDIAN_VAULT: vault }, { root: fixture("{not json") });
assert.equal(runtimeInvalid.posture.invalid, true);
assert.equal(runtimeInvalid.posture.reason, "invalid-json");
assert.deepEqual(runtimeInvalid.posture.declared, {});
assert.equal(runtimeInvalid.rollout.effectiveStage, "M0", "an invalid declaration falls back to environment precedence");

// The advisory skill pilot is stage-gated by its own env copy. Passing the raw
// process env made it resolve M0 while the declared posture said M1, so the
// pilot could never run at the stage the operator actually authorized.
const pilotCwd = tmpFixture("memory-posture-pilot-");
try {
  const bareEnv = { ...staleEnv };
  delete bareEnv.PI_PROJECT_MEMORY_STAGE; delete bareEnv.PI_PROJECT_MEMORY_WRITES;
  delete bareEnv.PI_PROJECT_MEMORY_AUTOMATIC; delete bareEnv.PI_PROJECT_MEMORY_AUTO_SAVE;
  delete bareEnv.PI_PROJECT_MEMORY_POSTURE;
  const boundary = createPiIntegrationBoundary({ cwd: pilotCwd, env: bareEnv, pilots: { enabled: true, cwd: pilotCwd } });
  assert.equal(boundary.skillPilot.env.PI_PROJECT_MEMORY_STAGE, "M1", "the pilot must see the resolved posture, not the raw environment");
  assert.equal(boundary.skillPilot.env.PI_PROJECT_MEMORY_AUTO_SAVE, "1");
  const envPrecedence = createPiIntegrationBoundary({ cwd: pilotCwd, env: { ...bareEnv, PI_PROJECT_MEMORY_POSTURE: "env" }, pilots: { enabled: true, cwd: pilotCwd } });
  assert.equal(envPrecedence.skillPilot.env.PI_PROJECT_MEMORY_STAGE, undefined, "PI_PROJECT_MEMORY_POSTURE=env still restores environment precedence");
} finally { fs.rmSync(pilotCwd, { recursive: true, force: true }); }

console.log("project memory posture tests passed");
