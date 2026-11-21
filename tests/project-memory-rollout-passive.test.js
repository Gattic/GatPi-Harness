"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { STAGES, decideStage, eligibleStage, emitRolloutEvaluation, resolveProjectMemoryRollout, rolloutEvent } = require("../src/project-memory-rollout");

const evaluation = (stage, extra = {}) => ({ kind: "rollout.evaluated", effectiveStage: stage, insufficient: [], ...extra });

// Fail closed: only a well-formed passive evaluation can authorize a stage.
assert.equal(eligibleStage(), "M0");
assert.equal(eligibleStage(null), "M0");
assert.equal(eligibleStage({}), "M0");
assert.equal(eligibleStage({ kind: "scorecard", effectiveStage: "M5" }), "M0");
assert.equal(eligibleStage({ kind: "rollout.evaluated", effectiveStage: "bogus" }), "M0");
assert.equal(eligibleStage({ kind: "rollout.evaluated" }), "M0");
for (const stage of STAGES) assert.equal(eligibleStage(evaluation(stage)), stage);

// A missing evaluation keeps every requested stage at M0.
const bare = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M5", PI_PROJECT_MEMORY_AUTO_SAVE: "1" });
assert.equal(bare.passiveEligibleStage, "M0");
assert.equal(bare.effectiveStage, "M0");
assert.equal(bare.stageAuthority, "fail-closed");
assert.equal(bare.promotionBlocked, true);
for (const control of ["explicitWrites", "taskRecall", "candidateCapture", "reviewQueueWrites", "hermesCuration", "automaticVerifiedUpserts"]) {
  assert.equal(bare.controls[control], false, `no telemetry cannot grant ${control}`);
}

// A passing passive evaluation authorizes exactly the stage it measured.
const m3 = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M3" }, evaluation("M3", { insufficient: ["A"] }));
assert.equal(m3.effectiveStage, "M3");
assert.equal(m3.stageAuthority, "passive-telemetry");
assert.equal(m3.promotionBlocked, false);
assert.equal(m3.controls.candidateCapture, true);
assert.equal(m3.controls.reviewQueueWrites, false, "M3 does not grant M4 controls");
assert.deepEqual(m3.insufficient, ["A"], "insufficient predicates are reported with the rollout");

// Requested above measured: clamped, blocked, and reported.
const clamped = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M5" }, evaluation("M2"));
assert.equal(clamped.effectiveStage, "M2");
assert.equal(clamped.promotionBlocked, true);
assert.equal(clamped.controls.automaticVerifiedUpserts, false);
assert.equal(clamped.decision, "no-go-deferred");

// M1 is operator-consented, never telemetry-earned.
const m1Measured = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1" }, evaluation("M1"));
assert.equal(m1Measured.passiveEligibleStage, "M1");
assert.equal(m1Measured.effectiveStage, "M0", "a passive M1 alone does not enable writes");
assert.equal(m1Measured.controls.explicitWrites, false);
const m1OptIn = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1" }, evaluation("M1"));
assert.equal(m1OptIn.effectiveStage, "M1");
assert.equal(m1OptIn.stageAuthority, "explicit-m1-opt-in");
assert.equal(m1OptIn.controls.explicitWrites, true);
assert.equal(m1OptIn.controls.taskRecall, false, "the opt-in cannot authorize recall");
const m2RequestedOptIn = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M2", PI_PROJECT_MEMORY_WRITES: "1" }, evaluation("M1"));
assert.equal(m2RequestedOptIn.effectiveStage, "M0", "the opt-in is exact to M1");
assert.equal(m2RequestedOptIn.controls.explicitWrites, false);

// A measured M2+ is not capped by the absent M1 opt-in: reaching it required
// real explicit saves, so writes are already authorized by the telemetry.
const measuredM2 = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M2" }, evaluation("M2"));
assert.equal(measuredM2.effectiveStage, "M2");
assert.equal(measuredM2.controls.explicitWrites, true);
assert.equal(measuredM2.controls.taskRecall, true);

// HOLD reaches the rollout through the evaluation; the environment cannot raise it.
const held = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M4", PI_PROJECT_MEMORY_HOLD: "M5" }, evaluation("M2", { held: true, hold: "M2" }));
assert.equal(held.effectiveStage, "M2", "a hold inside the evaluation caps eligibility");
assert.equal(held.controls.reviewQueueWrites, false);

// Operator automatic authority is unchanged and still limited to M1 controls.
const automatic = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_AUTOMATIC: "1", PI_PROJECT_MEMORY_AUTO_SAVE: "1" });
assert.equal(automatic.effectiveStage, "M1");
assert.equal(automatic.stageAuthority, "operator-opt-in");
assert.equal(automatic.controls.automaticCapture, true);
assert.equal(automatic.controls.taskRecall, true);
assert.equal(automatic.controls.candidateCapture, false);
assert.equal(resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_AUTOMATIC: "1", PI_PROJECT_MEMORY: "0" }).effectiveStage, "M0", "the kill switch still wins");

// HOLD may only lower, and an unrecognized HOLD is fail-closed to M0.
const holdM0 = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M4", PI_PROJECT_MEMORY_HOLD: "M0" }, evaluation("M4"));
assert.equal(holdM0.effectiveStage, "M0");
assert.equal(holdM0.held, true);
assert.equal(holdM0.hold, "M0");
assert.equal(holdM0.controls.candidateCapture, false);
assert.equal(holdM0.passiveEligibleStage, "M4", "the hold does not hide the measured stage");
const holdM2 = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M4", PI_PROJECT_MEMORY_HOLD: "M2" }, evaluation("M4"));
assert.equal(holdM2.effectiveStage, "M2");
assert.equal(holdM2.held, true);
assert.equal(holdM2.controls.candidateCapture, false);
const holdCannotRaise = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M5", PI_PROJECT_MEMORY_HOLD: "M5" }, evaluation("M2"));
assert.equal(holdCannotRaise.effectiveStage, "M2", "HOLD never raises eligibility");
assert.equal(holdCannotRaise.held, false);
const holdBogus = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M4", PI_PROJECT_MEMORY_HOLD: "bogus" }, evaluation("M4"));
assert.equal(holdBogus.effectiveStage, "M0");
assert.equal(holdBogus.held, true);
assert.equal(holdBogus.hold, "M0");
const holdCapsOptIn = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_HOLD: "M0" }, evaluation("M1"));
assert.equal(holdCapsOptIn.effectiveStage, "M0", "HOLD also caps an operator opt-in");
assert.equal(holdCapsOptIn.controls.explicitWrites, false);

// Shadow recall: M1 computes and logs recall without injecting it, so M2's
// recall bar is measurable while injection is still inactive.
const m1Shadow = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1" }, evaluation("M1"));
assert.equal(m1Shadow.effectiveStage, "M1");
assert.equal(m1Shadow.controls.shadowRecall, true);
assert.equal(m1Shadow.controls.taskRecall, false, "shadow recall never injects");
const m0NoShadow = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1" }, evaluation("M0"));
assert.equal(m0NoShadow.effectiveStage, "M0", "M1 without the operator opt-in stays M0");
assert.equal(m0NoShadow.controls.shadowRecall, false, "shadow recall starts at M1");
const m2Injects = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M2" }, evaluation("M2"));
assert.equal(m2Injects.controls.taskRecall, true);
assert.equal(m2Injects.controls.shadowRecall, false, "an injected stage needs no shadow run");
assert.equal(resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_RECALL: "0" }, evaluation("M1")).controls.shadowRecall, false, "PI_PROJECT_MEMORY_RECALL=0 disables shadow recall");
assert.equal(resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY: "0" }, evaluation("M1")).controls.shadowRecall, false, "the kill switch disables shadow recall");

// Hysteresis: promote immediately, demote only after two consecutive failures.
const promote = decideStage(evaluation("M3"), { previous: null });
assert.equal(promote.decidedStage, "M3");
assert.equal(promote.promoted, true);
assert.equal(promote.consecutiveFailures, 0);
const firstFailure = decideStage(evaluation("M1"), { previous: { effectiveStage: "M3", consecutiveFailures: 0 } });
assert.equal(firstFailure.decidedStage, "M3", "one failure does not demote");
assert.equal(firstFailure.demoted, false);
assert.equal(firstFailure.consecutiveFailures, 1);
const secondFailure = decideStage(evaluation("M1"), { previous: { effectiveStage: "M3", consecutiveFailures: 1 } });
assert.equal(secondFailure.decidedStage, "M1");
assert.equal(secondFailure.demoted, true);
assert.equal(secondFailure.consecutiveFailures, 0, "the streak resets after demotion");
const streakReset = decideStage(evaluation("M3"), { previous: { effectiveStage: "M3", consecutiveFailures: 1 } });
assert.equal(streakReset.consecutiveFailures, 0, "a matching evaluation clears the streak");
const malformed = decideStage({ kind: "scorecard", effectiveStage: "M5" }, { previous: { effectiveStage: "M3", consecutiveFailures: 0 } });
assert.equal(malformed.candidateStage, "M0", "only an evaluation record yields a candidate");
assert.equal(malformed.consecutiveFailures, 1);
assert.equal(malformed.effectiveStage, "M3");

// Emission: an injected sink receives the event; a failing sink is reported.
const injected = [];
const injectedResult = emitRolloutEvaluation({ event: rolloutEvent({ evaluation: evaluation("M2"), decision: decideStage(evaluation("M2")) }), emit: (event) => injected.push(event) });
assert.equal(injectedResult.emitted, true);
assert.equal(injectedResult.sink, "injected");
assert.equal(injected.length, 1);
assert.equal(injected[0].name, "rollout.evaluated");
assert.equal(injected[0].category, "memory_rollout");
assert.equal(injected[0].payload.stage, "M2");
assert.deepEqual(injected[0].payload.predicates, {}, "a bare evaluation reports no predicate detail");
assert.equal(emitRolloutEvaluation({ event: injected[0], emit: false }).reason, "disabled");
const failing = emitRolloutEvaluation({ event: injected[0], emit: () => { throw new Error("down"); } });
assert.equal(failing.emitted, false);
assert.equal(failing.reason, "emit-failed");

// The default sink appends one sanitized line under the project trace dir.
const emitCwd = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-sink-"));
const written = emitRolloutEvaluation({ cwd: emitCwd, event: rolloutEvent({ evaluation: evaluation("M2"), decision: decideStage(evaluation("M2")) }) });
assert.equal(written.emitted, true);
assert.equal(written.sink, "trace-file");
const writtenFiles = fs.readdirSync(path.join(emitCwd, ".pi", "traces")).filter((name) => name.endsWith("rollout.jsonl"));
assert.equal(writtenFiles.length, 1);
const writtenLines = fs.readFileSync(path.join(emitCwd, ".pi", "traces", writtenFiles[0]), "utf8").split("\n").filter(Boolean);
assert.equal(writtenLines.length, 1);
const writtenEvent = JSON.parse(writtenLines[0]);
assert.equal(writtenEvent.name, "rollout.evaluated");
assert.equal(writtenEvent.payload.stage, "M2");
assert(!JSON.stringify(writtenEvent).includes(emitCwd), "the event carries no absolute path");

console.log("passive rollout stage tests passed");
