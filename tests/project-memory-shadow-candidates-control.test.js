"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout");

const evaluation = (stage) => ({ kind: "rollout.evaluated", effectiveStage: stage, insufficient: [] });
// Writes/reads are operator grants; they must not affect the stage gates below.
const base = { PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_READS: "1" };

test("shadowCandidates is off at M1", () => {
  const rollout = resolveProjectMemoryRollout({ ...base, PI_PROJECT_MEMORY_STAGE: "M1" });
  assert.equal(rollout.effectiveStage, "M1");
  assert.equal(rollout.controls.shadowCandidates, false);
  assert.equal(rollout.controls.candidateCapture, false);
});

test("shadowCandidates is on at M2 while candidateCapture stays off", () => {
  const rollout = resolveProjectMemoryRollout({ ...base, PI_PROJECT_MEMORY_STAGE: "M2" }, evaluation("M2"));
  assert.equal(rollout.effectiveStage, "M2");
  assert.equal(rollout.controls.shadowCandidates, true, "M2 measures shadow decisions");
  assert.equal(rollout.controls.candidateCapture, false, "M2 does not grant M3 candidate capture");
});

test("shadowCandidates and candidateCapture stay independent at M3", () => {
  const rollout = resolveProjectMemoryRollout({ ...base, PI_PROJECT_MEMORY_STAGE: "M3" }, evaluation("M3"));
  assert.equal(rollout.effectiveStage, "M3");
  assert.equal(rollout.controls.shadowCandidates, true);
  assert.equal(rollout.controls.candidateCapture, true);
});

test("PI_PROJECT_MEMORY_CANDIDATES=0 disables shadowCandidates at M2", () => {
  const rollout = resolveProjectMemoryRollout(
    { ...base, PI_PROJECT_MEMORY_STAGE: "M2", PI_PROJECT_MEMORY_CANDIDATES: "0" },
    evaluation("M2"),
  );
  assert.equal(rollout.effectiveStage, "M2");
  assert.equal(rollout.controls.shadowCandidates, false);
  assert.equal(rollout.controls.candidateCapture, false);
});

test("the candidates env gate does not raise shadowCandidates at M1", () => {
  const rollout = resolveProjectMemoryRollout({ ...base, PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_CANDIDATES: "1" });
  assert.equal(rollout.effectiveStage, "M1");
  assert.equal(rollout.controls.shadowCandidates, false);
});

test("PI_PROJECT_MEMORY=0 disables shadowCandidates at M2", () => {
  const rollout = resolveProjectMemoryRollout(
    { ...base, PI_PROJECT_MEMORY_STAGE: "M2", PI_PROJECT_MEMORY: "0" },
    evaluation("M2"),
  );
  assert.equal(rollout.controls.shadowCandidates, false);
});
