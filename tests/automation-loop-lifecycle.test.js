#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AutomationLoopStore,
  assistantSettlementDisposition,
  buildLoopPrompt,
  createLoopState,
  evaluateSettlement,
  parseLoopDelivery,
  validateLoopDelivery,
  waitForQueuedAgentStart,
} = require("../src/automation-loop.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function tmp() { return tmpFixture("pi-automation-loop-lifecycle-"); }

// Pi can emit multiple low-level agent_end events while retrying. The extension
// now listens only to agent_settled, so only the recovered terminal assistant is
// eligible to consume a loop iteration.
const state = createLoopState({ id: "retry-loop", sessionId: "retry-session", prompt: "Fix until verified", maxIterations: 4, maxStalls: 2, iterationStartFingerprint: "fp0" });
const retryMessages = [
  { id: "error-1", text: "", stopReason: "error" },
  { id: "error-2", text: "", stopReason: "error" },
];
for (const assistant of retryMessages) {
  assert.deepEqual(assistantSettlementDisposition(assistant), { action: "pause", stopReason: "error" });
}
const recovered = { id: "recovered", text: "recovered after retry", stopReason: "stop" };
assert.deepEqual(assistantSettlementDisposition(recovered), { action: "settle", stopReason: "stop" });
const settled = evaluateSettlement(state, {
  assistantEntryId: recovered.id,
  assistantText: recovered.text,
  assistantStopReason: recovered.stopReason,
  settlementBoundary: "agent_settled",
  progressFingerprint: "fp1",
  nextEntryCount: 8,
  toolCalls: 2,
  toolErrors: 0,
}, { now: "2026-07-14T20:00:00.000Z" });
assert.equal(settled.action, "continue");
assert.equal(settled.state.iteration, 2);
assert.equal(settled.state.history.length, 1, "retry failures must not create loop-history iterations");
assert.equal(settled.state.history[0].assistantStopReason, "stop");
assert.equal(settled.state.history[0].settlementBoundary, "agent_settled");

// A continuation is accepted only while its loop, iteration, prompt, and token
// still match. Pausing invalidates the pending token and a later delivery is
// dropped idempotently.
const store = new AutomationLoopStore({ cwd: tmp(), clock: () => "2026-07-14T20:01:00.000Z" });
let persisted = store.create({ id: "delivery-loop", sessionId: "delivery-session", prompt: "Continue safely", maxIterations: 5, maxStalls: 3 });
const legacy = parseLoopDelivery(buildLoopPrompt(persisted));
assert.deepEqual(validateLoopDelivery(persisted, legacy), { ok: true, reason: "legacy-current" }, "current command/resume prompts remain compatible");

const token = "d".repeat(24);
persisted = store.queueContinuation(persisted.id, { iteration: 1, token });
assert.equal(validateLoopDelivery(persisted, legacy).reason, "legacy-superseded-by-token", "legacy prompts cannot replace a token-bound pending delivery");
const prompt = buildLoopPrompt(persisted, { delivery: { token } });
const delivery = parseLoopDelivery(prompt);
assert.deepEqual(validateLoopDelivery(persisted, delivery), { ok: true, reason: "current" });
const paused = store.pause(persisted.id, "review required");
assert.equal(paused.pendingContinuation, null);
assert.equal(paused.continuationEvents.length, 1);
assert.equal(paused.continuationEvents[0].outcome, "dropped");
assert.equal(validateLoopDelivery(paused, delivery).reason, "loop-inactive");
const recordedAgain = store.recordContinuationDrop(paused.id, { iteration: delivery.iteration, token: delivery.token, reason: "loop-inactive" });
assert.equal(recordedAgain.continuationEvents.length, 1, "the same stale token must not create duplicate drop telemetry");

// Rejecting a malformed or cross-session copy must not consume the pending
// token before the genuine queued input arrives.
const rejectionStore = new AutomationLoopStore({ cwd: tmp(), clock: () => "2026-07-14T20:01:30.000Z" });
let rejectionState = rejectionStore.create({ id: "rejection-loop", sessionId: "right-session", prompt: "Deliver once" });
const rejectionToken = "7".repeat(24);
rejectionState = rejectionStore.queueContinuation(rejectionState.id, { iteration: 1, token: rejectionToken });
const rejected = rejectionStore.recordContinuationDrop(rejectionState.id, { iteration: 1, token: rejectionToken, reason: "wrong-session" });
assert.equal(rejected.pendingContinuation.token, rejectionToken, "a rejected copy must not invalidate the genuine pending delivery");

// A provider failure that remains terminal at agent_settled pauses safely and
// preserves the iteration budget for a human-authorized resume.
const failureStore = new AutomationLoopStore({ cwd: tmp(), clock: () => "2026-07-14T20:02:00.000Z" });
const failure = failureStore.create({ id: "provider-loop", sessionId: "provider-session", prompt: "Recover" });
const providerPaused = failureStore.pauseForAssistantFailure(failure.id, "aborted");
assert.equal(providerPaused.status, "paused");
assert.equal(providerPaused.iteration, 1);
assert.equal(providerPaused.history.length, 0);
assert.equal(providerPaused.lifecycleEvents[0].kind, "assistant-failure");
assert.equal(providerPaused.lifecycleEvents[0].assistantStopReason, "aborted");

// Schema-v2 state has no continuation/lifecycle fields. It remains readable and
// upgrades atomically on the next write.
const migrationCwd = tmp();
const migrationStore = new AutomationLoopStore({ cwd: migrationCwd, clock: () => "2026-07-14T20:03:00.000Z" });
const oldState = createLoopState({ id: "old-loop", sessionId: "old-session", prompt: "Legacy" });
oldState.schemaVersion = 2;
delete oldState.pendingContinuation;
delete oldState.continuationEvents;
delete oldState.lifecycleEvents;
fs.mkdirSync(path.dirname(migrationStore.file(oldState.id)), { recursive: true });
fs.writeFileSync(migrationStore.file(oldState.id), `${JSON.stringify(oldState)}\n`, { mode: 0o600 });
const upgraded = migrationStore.queueContinuation(oldState.id, { iteration: 1, token: "e".repeat(24) });
assert.equal(upgraded.schemaVersion, 3);
assert.ok(upgraded.pendingContinuation);
assert.deepEqual(upgraded.continuationEvents, []);
assert.deepEqual(upgraded.lifecycleEvents, []);

async function checkQueuedStartupHandshake() {
  let idle = true;
  const startingCtx = { isIdle: () => idle, sessionManager: { getBranch: () => [] } };
  const started = await waitForQueuedAgentStart(startingCtx, 0, {
    timeoutMs: 100,
    clock: (() => { let tick = 0; return () => ++tick; })(),
    yieldTurn: async () => { idle = false; },
  });
  assert.equal(started, "started");

  const completedCtx = {
    isIdle: () => true,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [] } }] },
  };
  assert.equal(await waitForQueuedAgentStart(completedCtx, 0, { timeoutMs: 100 }), "completed");
}

checkQueuedStartupHandshake().then(() => {
  console.log("automation loop lifecycle checks passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
