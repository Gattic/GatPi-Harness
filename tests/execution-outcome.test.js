"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXECUTION_OUTCOME_LIMITS,
  sha256,
  buildLoopOutcomePacket,
  buildGoalOutcomePacket,
  buildLoopSettlementPacket,
  buildGoalSettlementPacket,
  validateExecutionOutcomePacket,
  ExecutionOutcomeStore,
} = require("../src/execution-outcome");
const { tmpFixture } = require("./helpers/tmp-fixture");

function base(overrides = {}) {
  return {
    runId: "loop_20260731_abcdef",
    sourceSchemaVersion: 3,
    sourceRecord: { id: "loop_20260731_abcdef", status: "completed", revision: 4 },
    terminalState: "completed",
    taskHash: sha256("private task text is hashed before this boundary"),
    taskClass: "implementation",
    workflow: {
      steps: [{ index: 0, kind: "iteration", role: null, status: "succeeded" }],
      toolNames: ["verification_center"],
      retries: 1,
    },
    evidenceRefs: ["evidence_fixture_1"],
    artifactRefs: [{ kind: "verification", id: "proof_fixture_1", hash: sha256("proof") }],
    metrics: { iterations: 2, toolCalls: 4, toolErrors: 0, modelCalls: 2, durationMs: 1000 },
    producerVersion: "automation-loop-v3",
    projectKeyHash: sha256("pi:fixture:hash"),
    settledAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

const loop = buildLoopOutcomePacket(base());
assert.equal(loop.schemaVersion, 1);
assert.match(loop.packetId, /^execout_[a-f0-9]{32}$/);
assert.equal(loop.source.kind, "automation-loop");
assert.equal(loop.outcome, "succeeded");
assert.equal(loop.privacy.promptStored, false);
assert.equal(loop.provenance.evidenceClass, "deterministic");
assert.equal(loop.provenance.arm, "unassigned");
assert.equal(loop.metrics.contextAdded, null, "unmeasured context cost is not normalized to zero");
assert.equal(JSON.stringify(loop).includes("private task text"), false, "task text is never persisted");
assert.deepEqual(validateExecutionOutcomePacket(loop).issues, []);

const goal = buildGoalOutcomePacket(base({ runId: "goal_fixture", sourceSchemaVersion: 2, sourceRecord: { id: "goal_fixture", status: "blocked" }, terminalState: "blocked", taskClass: "verification" }));
assert.equal(goal.source.kind, "goal");
assert.equal(goal.outcome, "blocked");
assert.notEqual(goal.packetId, loop.packetId);

const providerFailure = buildLoopOutcomePacket(base({ terminalState: "failed", providerFailure: true, reason: "provider error", reasonCodes: ["provider-failure"] }));
assert.equal(providerFailure.outcome, "infrastructure-failed");
const maxIterations = buildLoopOutcomePacket(base({ terminalState: "max_iterations", reasonCodes: ["maximum-iterations"] }));
assert.equal(maxIterations.outcome, "timed-out");

for (const [label, mutate, pattern] of [
  ["forbidden prompt", (packet) => { packet.workflow.steps[0].prompt = "do not persist"; }, /forbidden/],
  ["secret", (packet) => { packet.reasonCodes = ["token=super-secret-value"]; }, /secret-like/],
  ["absolute path", (packet) => { packet.provenance.producerVersion = "/home/example/private"; }, /absolute path/],
  ["privacy lie", (packet) => { packet.privacy.promptStored = true; }, /must be false/],
  ["unsafe tool", (packet) => { packet.workflow.toolNames = ["tool name with spaces"]; }, /unsafe name/],
  ["unstable id", (packet) => { packet.packetId = "execout_deadbeef"; }, /stable packet identity/],
]) {
  const packet = JSON.parse(JSON.stringify(loop));
  mutate(packet);
  const result = validateExecutionOutcomePacket(packet);
  assert.equal(result.ok, false, label);
  assert.match(result.issues.join(" "), pattern, label);
}

const oversized = JSON.parse(JSON.stringify(loop));
oversized.workflow.steps = Array.from({ length: EXECUTION_OUTCOME_LIMITS.steps + 1 }, (_, index) => ({ index, kind: "iteration", role: null, status: "succeeded" }));
assert.equal(validateExecutionOutcomePacket(oversized).ok, false, "oversized collections fail closed");

const tmp = tmpFixture("pi-execution-outcome-");
const store = new ExecutionOutcomeStore({ cwd: tmp });
const first = store.save(loop);
const second = store.save(loop);
assert.equal(first.persisted, true);
assert.equal(first.outcome, "succeeded");
assert.equal(second.persisted, false);
assert.equal(second.duplicate, true);
assert.equal(second.outcome, "not-applicable");
assert.equal(store.list().length, 1, "duplicate source settlement produces one index row");
assert.deepEqual(store.get(loop.packetId), loop);
assert.equal(store.packets().length, 1);
const cohortPacket = buildLoopOutcomePacket(base({ runId: "loop_cohort_fixture", sourceRecord: { id: "loop_cohort_fixture", status: "completed" }, evidenceClass: "exact-version-field", cohortId: "cohort-fixture", sessionIdHash: sha256("session-fixture"), arm: "candidate", metrics: { ...base().metrics, contextAdded: 321 } }));
store.save(cohortPacket);
assert.equal(store.get(cohortPacket.packetId).provenance.cohortId, "cohort-fixture");
assert.equal(store.get(cohortPacket.packetId).metrics.contextAdded, 321);
const rejectedPacket = JSON.parse(JSON.stringify(loop)); rejectedPacket.workflow.steps[0].prompt = "PRIVATE_REJECTED_PROMPT";
assert.throws(() => store.save(rejectedPacket), /forbidden/);
const compounding = store.compoundingRecords();
assert.equal(compounding.rejections.at(-1).reasonCode, "forbidden-field");
assert.equal(JSON.stringify(compounding).includes("PRIVATE_REJECTED_PROMPT"), false, "rejection telemetry stores only a controlled reason code");
const reloadedStore = new ExecutionOutcomeStore({ cwd: tmp });
assert.equal(reloadedStore.save(loop).persisted, false, "reload replay remains idempotent");
assert.equal(reloadedStore.list().length, 2);

const root = path.join(tmp, ".pi", "execution-outcomes");
const packetFile = path.join(root, "packets", `${loop.packetId}.json`);
const indexFile = path.join(root, "index.jsonl");
assert.equal(fs.statSync(root).mode & 0o077, 0, "state root is private");
assert.equal(fs.statSync(packetFile).mode & 0o077, 0, "packet is private");
assert.equal(fs.statSync(indexFile).mode & 0o077, 0, "index is private");
const indexText = fs.readFileSync(indexFile, "utf8");
assert.doesNotMatch(indexText, /workflow|toolNames|artifactRefs|private task text/, "index remains metadata-only");
assert.equal(fs.existsSync(path.join(tmp, ".pi", "learning-loop")), false, "packet persistence does not create learning state");
assert.equal(fs.existsSync(path.join(tmp, ".pi", "skills")), false, "packet persistence does not create skill state");
assert.equal(fs.existsSync(path.join(tmp, ".pi", "project-memory")), false, "packet persistence does not create memory candidates");

const sameIdentity = buildLoopOutcomePacket(base());
assert.equal(sameIdentity.packetId, loop.packetId, "packet IDs are deterministic for source identity and terminal state");

const privatePrompt = `Implement from /home/private/repo without leaking sk-1234567890abcdefghijklmnop`;
const settledLoop = buildLoopSettlementPacket({
  schemaVersion: 3,
  id: "loop_settled_fixture",
  prompt: privatePrompt,
  status: "completed",
  iteration: 1,
  history: [{ iteration: 1, assistantStopReason: "stop", toolCalls: 1, toolErrors: 0, tools: { verification_center: 1 } }],
  completionEvidence: ["evidence_loop_fixture"],
  createdAt: "2026-07-31T12:00:00.000Z",
  completedAt: "2026-07-31T12:00:01.000Z",
}, { assistantEntryId: "assistant_fixture", projectKey: "/home/private/repo" });
assert.equal(settledLoop.outcome, "succeeded");
assert.deepEqual(settledLoop.evidenceRefs, ["evidence_loop_fixture"]);
assert.doesNotMatch(JSON.stringify(settledLoop), /home\/private|sk-123456|Implement from/, "settlement packet excludes prompt, secret, and absolute path bodies");
const providerPaused = buildLoopSettlementPacket({ schemaVersion: 3, id: "loop_provider_fixture", prompt: "recover", status: "paused", iteration: 1, lifecycleEvents: [{ kind: "assistant-failure", assistantStopReason: "error" }], createdAt: "2026-07-31T12:00:00.000Z", pausedAt: "2026-07-31T12:00:01.000Z" });
assert.equal(providerPaused.outcome, "infrastructure-failed");
const evidencePause = buildLoopSettlementPacket({ schemaVersion: 3, id: "loop_pause_fixture", prompt: "wait", status: "paused", iteration: 1, checkpoints: [{ verdict: "fail", evidence: ["private diagnostic without an ID"] }], createdAt: "2026-07-31T12:00:00.000Z", pausedAt: "2026-07-31T12:00:01.000Z" });
assert.equal(evidencePause.outcome, "blocked");
assert.equal(evidencePause.artifactRefs.length, 1, "non-ID evidence is represented only by a hash");
assert.equal(buildLoopSettlementPacket({ id: "loop_empty_pause", prompt: "wait", status: "paused", iteration: 1 }), null, "uninstructive pauses are ignored");

const settledGoal = buildGoalSettlementPacket({ schemaVersion: 1, id: "goal_settled_fixture", goal: privatePrompt, status: "completed", iteration: 2, history: [{ status: "running", executed: true, nextPrompt: privatePrompt, rawHermesOutput: privatePrompt }, { status: "completed", executed: false }], completionEvidenceIds: ["proof_goal_fixture"], createdAt: "2026-07-31T12:00:00.000Z", updatedAt: "2026-07-31T12:00:02.000Z" }, { projectKey: "/home/private/repo" });
assert.equal(settledGoal.outcome, "succeeded");
assert.doesNotMatch(JSON.stringify(settledGoal), /home\/private|sk-123456|Implement from|rawHermesOutput|nextPrompt/);
assert.equal(buildGoalSettlementPacket({ id: "goal_empty_cancel", goal: "cancel", status: "cancelled", iteration: 0 }), null);
assert.equal(buildGoalSettlementPacket({ id: "goal_untouched_block", goal: "block", status: "blocked", iteration: 1, history: [{ status: "blocked", executed: false }] }), null);
assert.equal(buildGoalSettlementPacket({ id: "goal_action_block", goal: "block", status: "blocked", iteration: 1, history: [{ status: "running", executed: true }], createdAt: "2026-07-31T12:00:00.000Z", updatedAt: "2026-07-31T12:00:01.000Z" }).outcome, "blocked");

(async () => {
  let handled = 0;
  const drained = await store.drain("fixture-consumer", () => { handled += 1; return { ok: true }; });
  const replayed = await store.drain("fixture-consumer", () => { handled += 1; });
  assert.equal(drained.processed, 2);
  assert.equal(replayed.processed, 0);
  assert.equal(handled, 2, "consumer receipts make dispatch idempotent");
  assert.equal(fs.statSync(path.join(root, "dispatch", "fixture-consumer.jsonl")).mode & 0o077, 0, "dispatch receipts are private");
  console.log("execution-outcome tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
