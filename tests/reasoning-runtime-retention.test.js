"use strict";

const assert = require("node:assert/strict");
const { ReasoningRuntime, AUTOMATED_RETENTION, rotateSnapshotKeys } = require("../src/reasoning-runtime.js");

const runtime = new ReasoningRuntime({});
runtime.createPlan({ objective: "Bound reasoning runtime growth", steps: ["inspect", "bound"] });
for (let index = 0; index < 12; index++) runtime.recordExecutorAction({ summary: `Executor action ${index}`, command: "node scripts/check-all.sh", outcome: "ok" });
for (let index = 0; index < 5; index++) runtime.recordVerifierEvidence({ claim: `Automated claim ${index}`, ok: true, status: "passed", kind: "automated", method: "verification-adapter", verifier: "cognitive-automation" });

const before = runtime.metrics();
assert.equal(before.automatedExecutorActions, 12);
assert.equal(before.automatedVerifierEvidence, 5);
assert.equal(before.byType.plan, 1);

const dry = runtime.pruneAutomatedVerification({ keep: 3, keepExecutorActions: 4 });
assert.equal(dry.dryRun, true);
assert.equal(dry.automatedExecutorActions, 12);
assert.equal(dry.removed.length, 8 + 2, "dry run reports the executor actions and verifier evidence it would remove");
assert.equal(runtime.metrics().artifacts, before.artifacts, "dry run does not mutate");

const applied = runtime.pruneAutomatedVerification({ keep: 3, keepExecutorActions: 4, dryRun: false });
assert.equal(applied.dryRun, false);
assert.equal(applied.automatedExecutorActions, 12);
assert.equal(applied.remaining, 1 + 4 + 3, "one plan, four executor actions, and three verifier evidence artifacts remain");
const after = runtime.metrics();
assert.equal(after.automatedExecutorActions, 4);
assert.equal(after.automatedVerifierEvidence, 3);
assert.equal(after.byType.plan, 1, "non-automated artifacts are never pruned");
assert.equal(after.byType.executor_action, 4);

// A bound above current volume is a no-op.
const quiet = runtime.pruneAutomatedVerification({ keep: 10, keepExecutorActions: 100, dryRun: false });
assert.equal(quiet.removed.length, 0);
assert.equal(quiet.remaining, after.artifacts);

// Feedback that requests a change to a pruned action is removed with it, so no
// artifact keeps a dangling target.
const cascade = new ReasoningRuntime({});
const actions = Array.from({ length: 4 }, (_, index) => cascade.recordExecutorAction({ summary: `Action ${index}`, command: "node scripts/check-all.sh", outcome: "failed" }));
const evidence = cascade.recordVerifierEvidence({ claim: "Action 0 failed", ok: false, status: "failed", kind: "automated", method: "verification-adapter", verifier: "cognitive-automation" });
cascade.addVerifierFeedback({ evidenceId: evidence.id, targetArtifactId: actions[0].id, status: "needs_revision", message: "Retry action 0" });
cascade.addVerifierFeedback({ evidenceId: evidence.id, targetArtifactId: actions[3].id, status: "needs_revision", message: "Retry the newest action" });
assert.equal(cascade.metrics().byType.verifier_feedback, 2);
const cascadeResult = cascade.pruneAutomatedVerification({ keep: 10, keepExecutorActions: 2, dryRun: false });
assert.equal(cascade.metrics().byType.executor_action, 2, "the two oldest actions are pruned");
assert.equal(cascade.metrics().byType.verifier_feedback, 1, "only the feedback for the surviving action remains");
const feedback = cascade.listArtifacts({ type: "verifier_feedback" });
assert.equal(feedback[0].targetArtifactId, actions[3].id);
assert(cascadeResult.removed.some((row) => row.id === actions[0].id));
assert(!cascade.links.some((link) => link.toId === actions[0].id || link.fromId === actions[0].id));

// Malformed bounds fail safe to the documented default instead of pruning
// everything.
const guarded = new ReasoningRuntime({});
for (let index = 0; index < 5; index++) guarded.recordExecutorAction({ summary: `Guarded action ${index}`, command: "node test", outcome: "ok" });
const malformed = guarded.pruneAutomatedVerification({ keepExecutorActions: "not-a-number", keep: -1, dryRun: true });
assert.equal(malformed.keep, AUTOMATED_RETENTION.evidence);
assert.equal(malformed.keepExecutorActions, AUTOMATED_RETENTION.executorActions);
assert.equal(malformed.removed.length, 0, "a malformed bound never authorizes deletion");
const zeroBound = guarded.pruneAutomatedVerification({ keepExecutorActions: 0, dryRun: true });
assert.equal(zeroBound.removed.length, 5, "an explicit zero bound is still honored");

// Pre-prune backups are written on every automated pass. Rotation bounds them
// without touching backups that an earlier session already left on disk.
const tracked = [];
const removed = [];
const remove = (key) => removed.push(key);
assert.deepEqual(rotateSnapshotKeys(tracked, "snap-1", 3, remove), []);
assert.deepEqual(rotateSnapshotKeys(tracked, "snap-2", 3, remove), []);
assert.deepEqual(rotateSnapshotKeys(tracked, "snap-3", 3, remove), []);
assert.deepEqual(removed, [], "nothing is dropped before the bound is reached");
assert.deepEqual(rotateSnapshotKeys(tracked, "snap-4", 3, remove), ["snap-1"], "the oldest tracked backup is dropped");
assert.deepEqual(tracked, ["snap-2", "snap-3", "snap-4"]);
assert.deepEqual(rotateSnapshotKeys(tracked, "snap-5", 1, remove), ["snap-2", "snap-3", "snap-4"], "a lower bound drops down to the newest backup");
assert.deepEqual(tracked, ["snap-5"]);
assert.deepEqual(rotateSnapshotKeys(tracked, "snap-5", 1, remove), [], "a repeated key is never deleted while it is the current backup");
assert.deepEqual(tracked, ["snap-5"], "a repeated key does not grow the tracked set");
const freshProcess = [];
assert.deepEqual(rotateSnapshotKeys(freshProcess, "snap-6", 2, remove), [], "a new process tracks only its own backups");
assert.deepEqual(removed, ["snap-1", "snap-2", "snap-3", "snap-4"], "no pre-existing backup is ever removed by rotation");
const zeroKept = [];
assert.deepEqual(rotateSnapshotKeys(zeroKept, "snap-7", 0, remove), [], "a zero bound still terminates and never drops the current backup");
assert.deepEqual(zeroKept, ["snap-7"]);
const malformedKept = ["snap-a"];
assert.deepEqual(rotateSnapshotKeys(malformedKept, "snap-b", Number.NaN, remove), ["snap-a"], "a malformed bound falls back to one instead of looping");
assert.deepEqual(malformedKept, ["snap-b"]);

console.log("reasoning runtime retention tests passed");
