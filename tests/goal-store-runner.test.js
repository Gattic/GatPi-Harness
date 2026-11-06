"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { GoalStore } = require("../.pi/extensions/goal/goal-store.js");
const { GoalRunner, extractFirstJsonObject, validateDecision, isUnsafeNextPrompt, pendingPromptHasBranchOutput, createFixtureHermesAsk, commandOutput, publicGoalPacket } = require("../.pi/extensions/goal/goal-runner.js");
const { HermesAdvisoryAdapter } = require("../src/integration-boundary.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function runningPrompt(prompt, reasonCode = "continue") { return { schemaVersion: 3, status: "running", action: { kind: "inspect", targetKind: "status", targetRef: "goal-current", prompt }, reasonCode, requiresUserInput: false, completionEvidenceIds: [] }; }
function terminal(status, reasonCode, completionEvidenceIds = []) { return { schemaVersion: 3, status, action: null, reasonCode, requiresUserInput: false, completionEvidenceIds }; }
function hermesFailure(category, message = `Hermes advisory decide failed: ${category}`, extra = {}) { return Object.assign(new Error(message), { code: "HERMES_ADVISORY_REQUEST_FAILED", category, reasonCode: category, ...extra }); }

async function tempDir() {
  return tmpFixture("pi-goal-test-");
}

function fakeCtx() {
  const branch = [];
  return {
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branch,
    },
    async sendUserMessage(prompt) {
      branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } });
      branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `done: ${prompt}` }] } });
    },
    async waitForIdle() {},
  };
}

function fakeCtxWithoutWait() {
  const ctx = fakeCtx();
  delete ctx.waitForIdle;
  return ctx;
}

async function testStorePersistsAndCancels() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const state = await store.create("ship feature", { maxIterations: 7, id: "g1" });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.status, "running");
  assert.equal(state.maxIterations, 7);
  assert.equal((await store.getActive()).id, "g1");
  const cancelled = await store.cancelActive("test cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.observations.at(-1), /test cancel/);
  assert.equal(await store.getActive(), undefined);
  const archive = await store.archiveFinalStatuses(["cancelled"]);
  assert.equal(archive.archived, 1);
  assert.equal((await store.readAll()).length, 0);
}

async function testStoreMetricsAndPrune() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const completed = await store.create("done", { id: "m1" });
  completed.status = "completed";
  completed.iteration = 2;
  await store.save(completed);
  const blocked = await store.create("blocked", { id: "m2" });
  blocked.status = "blocked";
  blocked.iteration = 1;
  blocked.controllerRepairTurns = 1;
  blocked.history = [{ reasonCode: "goal-input-ref-mismatch", action: { kind: "inspect", prompt: "Inspect current status." }, actionResultCode: "dispatch-rejected", actionLatencyMs: 7, proofRejectionReason: "evidence-not-registered" }];
  await store.save(blocked);
  const metrics = await store.getMetrics({ includeArchive: false });
  assert.equal(metrics.total, 2);
  assert.equal(metrics.byStatus.completed, 1);
  assert.equal(metrics.byStatus.blocked, 1);
  assert.equal(metrics.averageIterations, 1.5);
  assert.equal(metrics.actionKinds.inspect, 1);
  assert.equal(metrics.dispatchMismatches, 1);
  assert.equal(metrics.proofRejections["evidence-not-registered"], 1);
  assert.equal(metrics.extraControllerTurns, 1);
  assert.equal(metrics.actionLatencyMs.max, 7);
  const pruned = await store.pruneFinalGoals(1);
  assert.equal(pruned.archived, 1);
  assert.equal((await store.readAll()).length, 1);
}

async function testFixtureHermesAsk() {
  const dir = await tempDir();
  const file = path.join(dir, "decisions.jsonl");
  await fs.writeFile(file, `${JSON.stringify(runningPrompt("one"))}\n${JSON.stringify(terminal("blocked", "fixture-blocked"))}\n`);
  const ask = createFixtureHermesAsk(file);
  assert.match(await ask(), /"one"/);
  assert.match(await ask(), /"blocked"/);
  assert.match(await ask(), /"blocked"/);
}

async function testParsingAndValidation() {
  const parsed = extractFirstJsonObject(`noise ${JSON.stringify(runningPrompt("run tests"))} tail`);
  const decision = validateDecision(parsed);
  assert.equal(decision.status, "running");
  assert.equal(decision.schemaVersion, 3);
  assert.equal(decision.action.kind, "inspect");
  assert.throws(() => validateDecision({ ...parsed, status: "maybe" }), /unknown status/);
  assert.throws(() => extractFirstJsonObject("no json"), /No valid JSON/);
}

async function testRunnerExecutesUntilVerifiedCompletion() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const decisions = [runningPrompt("inspect files and run tests", "need-evidence"), terminal("completed", "tests-passed", ["evidence-tests"])];
  const runner = new GoalRunner({ store, evidenceAdapter: { validateCompletion: async () => ({ ok: true, reason: "passing-evidence", results: [] }) }, hermesAsk: async () => JSON.stringify(decisions.shift()) });
  const initial = await store.create("make tests pass", { id: "g2", maxIterations: 5 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "completed");
  assert.equal(final.iteration, 2);
  assert.match(final.observations.join("\n"), /inspect files and run tests/);
}

async function testRunnerQueuesAndAutoResumesWithoutWaitForIdle() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const decisions = [runningPrompt("inspect files and run tests", "need-evidence"), terminal("completed", "tests-passed", ["evidence-tests"])];
  const runner = new GoalRunner({ store, evidenceAdapter: { validateCompletion: async () => ({ ok: true, reason: "passing-evidence", results: [] }) }, hermesAsk: async () => JSON.stringify(decisions.shift()) });
  const ctx = fakeCtxWithoutWait();
  const initial = await store.create("make tests pass", { id: "g9", maxIterations: 5 });
  const queued = await runner.run(initial, ctx);
  assert.equal(queued.status, "running");
  assert.equal(queued.iteration, 1);
  assert.equal(Boolean(queued.pendingPrompt), true);
  assert.equal(pendingPromptHasBranchOutput(queued, ctx), true);
  const final = await runner.resume(ctx);
  assert.equal(final.status, "completed");
  assert.equal(final.iteration, 2);
  assert.equal(final.pendingPrompt, undefined);
  assert.match(final.history.at(-2).result, /done: inspect files and run tests/);
}

async function testRunnerFinalizesAfterTerminalSaveWithoutDefaultHermesSync() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const finalized = [];
  let hermesCalls = 0;
  const runner = new GoalRunner({
    store,
    onFinalized: async (state) => {
      const persisted = await store.get(state.id);
      assert.equal(persisted.status, state.status, "onFinalized runs after the terminal state is saved");
      finalized.push(state.id);
    },
    hermesAsk: async () => {
      hermesCalls += 1;
      return JSON.stringify(terminal("blocked", "need-user"));
    },
  });
  assert.equal("syncFinalSummary" in runner, false, "raw Hermes final-summary sync is removed rather than retained as a compatibility path");
  const initial = await store.create("blocked goal", { id: "g-finalized", maxIterations: 2 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.deepEqual(finalized, ["g-finalized"]);
  assert.equal(hermesCalls, 1, "default finalization does not add a Hermes summary call");
}

async function testRunnerRepairsMalformedHermesJsonOnce() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  let calls = 0;
  const runner = new GoalRunner({
    store,
    hermesAsk: async () => {
      calls += 1;
      if (calls === 1) return "not json";
      return JSON.stringify(terminal("blocked", "need-user"));
    },
  });
  const initial = await store.create("blocked goal", { id: "g3", maxIterations: 5 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.equal(calls, 2);
}

async function testRunnerRepairsRedundantCurrentProjectQuestion() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const prompts = [];
  const decisions = [
    { schemaVersion: 3, status: "running", action: { kind: "ask_user", question: "Which project/repository should be modified, and what is its absolute path? Also specify the game engine and version." }, reasonCode: "project-required", requiresUserInput: true, completionEvidenceIds: [] },
    runningPrompt("Inspect the current project files to identify the engine and terrain implementation before making changes.", "inspect-current-project"),
  ];
  const runner = new GoalRunner({
    store,
    hermesAsk: async (_cwd, prompt) => {
      prompts.push(prompt);
      return JSON.stringify(decisions.shift());
    },
  });
  const state = await store.create("Implement morphable terrain", { id: "goal-current-project", approvedTopologyIds: ["planner-coder-verifier"] });
  const result = await runner.askHermesDecision(state);
  assert.equal(result.decision.action.kind, "inspect");
  assert.equal(result.repairTurns, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /cannot request the current project\/repository path/);
}

async function testRunnerRepairsMismatchedTopologyInputRef() {
  const dir = await tempDir();
  const binary = path.join(dir, "hermes");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n");
  await fs.chmod(binary, 0o755);
  let controllerPrompt = "";
  let repairPrompt = "";
  const hermes = new HermesAdvisoryAdapter({
    cwd: dir,
    bin: binary,
    run: async (args) => {
      const prompt = String(args[1] || "");
      if (prompt.includes("HERMES_ADVISORY_AUTH_OK")) return "HERMES_ADVISORY_AUTH_OK";
      if (prompt.includes("Repair the following Hermes decide response")) {
        repairPrompt = prompt;
        return JSON.stringify({ schemaVersion: 3, status: "running", action: { kind: "run_topology", topologyId: "planner-coder-verifier", inputRef: "goal-input-ref-repair", prompt: "Run the approved planner-coder-verifier topology for this goal." }, reasonCode: "run-approved-topology", requiresUserInput: false, completionEvidenceIds: [] });
      }
      if (prompt.includes("typed goal controller")) {
        controllerPrompt = prompt;
        return JSON.stringify({ schemaVersion: 3, status: "running", action: { kind: "run_topology", topologyId: "planner-coder-verifier", inputRef: "current-project", prompt: "Run the approved planner-coder-verifier topology for this goal." }, reasonCode: "run-approved-topology", requiresUserInput: false, completionEvidenceIds: [] });
      }
      throw new Error("unexpected fake Hermes request");
    },
  });
  const store = new GoalStore({ cwd: dir });
  const runner = new GoalRunner({ store, hermes, traceRuntime: { emit() {} } });
  const state = await store.create("repair a mismatched topology input reference", { id: "goal-input-ref-repair", approvedTopologyIds: ["planner-coder-verifier"] });
  const result = await runner.askHermesDecision(state);
  assert.equal(result.repairTurns, 1, "the advisory repair path corrects the mismatched topology input reference");
  assert.equal(result.decision.action.inputRef, state.id);
  assert.match(controllerPrompt, /action\.inputRef must exactly equal packet\.goalId/);
  assert.match(repairPrompt, /GOAL_DECISION_INPUT_REF_MISMATCH/);
  assert.match(repairPrompt, /packet\.goalId/);
}

async function testRunnerRetriesInitialTimeoutThenContinues() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const savedStatuses = [];
  const save = store.save.bind(store);
  store.save = async (state) => { savedStatuses.push(state.status); return save(state); };
  let calls = 0;
  const runner = new GoalRunner({
    store,
    evidenceAdapter: { validateCompletion: async () => ({ ok: true, reason: "passing-evidence", results: [] }) },
    traceRuntime: { emit() {} },
    hermesAsk: async () => {
      calls += 1;
      if (calls === 1) throw hermesFailure("timeout");
      if (calls === 2) return JSON.stringify(runningPrompt("Inspect current Haven load state.", "inspect-haven"));
      return JSON.stringify(terminal("completed", "verified", ["evidence-current"]));
    },
  });
  const initial = await store.create("retry initial controller timeout", { id: "g-timeout-retry", maxIterations: 3 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "completed");
  assert.equal(calls, 3, "one initial retry is followed by the next normal controller iteration");
  assert.equal(savedStatuses.includes("blocked"), false, "the recoverable timeout never persists terminal blocked state");
  assert.equal(final.history.filter((record) => record.attemptedActionKind === "inspect").length, 1, "the recovered decision dispatches exactly once");
  assert.equal(final.history.some((record) => record.errorCategory === "timeout"), false, "a recovered timeout does not create terminal failure history");
}

async function testRunnerWaitsForReadinessRetryAfterBeforeInitialRetry() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const waits = [];
  const traces = [];
  let now = Date.parse("2026-09-03T05:46:28.346Z");
  const retryAfter = new Date(now + 60_000).toISOString();
  let calls = 0;
  const runner = new GoalRunner({
    store,
    evidenceAdapter: { validateCompletion: async () => ({ ok: true, reason: "passing-evidence", results: [] }) },
    traceRuntime: { emit(event) { traces.push(event); } },
    now: () => now,
    wait: async (delayMs) => { waits.push(delayMs); now += delayMs; },
    hermesAsk: async () => {
      calls += 1;
      if (calls === 1) throw hermesFailure("timeout", undefined, { retryAfter });
      assert.equal(now, Date.parse(retryAfter), "the retry must not reach Hermes before readiness retryAfter");
      return JSON.stringify(terminal("completed", "verified", ["evidence-current"]));
    },
  });
  const initial = await store.create("defer initial controller retry", { id: "g-timeout-retry-after", maxIterations: 2 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "completed");
  assert.equal(calls, 2, "the readiness wait does not consume a controller attempt");
  assert.deepEqual(waits, [60_000], "the retry waits for the exact remaining readiness cooldown");
  assert.equal(final.history.some((record) => record.errorCategory === "backoff-active"), false, "readiness backoff is not persisted as a terminal goal failure");
  const retryTrace = traces.find((event) => event.name === "goal.hermes_timeout_retry");
  assert.equal(retryTrace?.payload?.retryAfter, retryAfter);
  assert.equal(retryTrace?.payload?.retryDelayMs, 60_000);
}

async function testRunnerBlocksAfterInitialTimeoutRetryExhaustion() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  let calls = 0;
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => { calls += 1; throw hermesFailure("timeout"); },
  });
  const initial = await store.create("exhaust initial timeout retry", { id: "g-timeout-exhausted", maxIterations: 3 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.equal(calls, 2, "initial timeout retry is bounded to two total attempts");
  assert.equal(final.history.length, 1, "only the exhausted failure is persisted");
  assert.equal(final.history[0].errorKind, "hermes_command");
  assert.equal(final.history[0].errorCategory, "timeout");
  assert.equal(final.history[0].controllerAttempts, 2);
  assert.match(final.observations.join("\n"), /decide failed: timeout/);
}

async function testRunnerUsesControllerTimeoutForTwoConsecutiveTimeouts() {
  const dir = await tempDir();
  const binary = path.join(dir, "hermes");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n");
  await fs.chmod(binary, 0o755);
  const controllerTimeouts = [];
  const hermes = new HermesAdvisoryAdapter({
    cwd: dir,
    bin: binary,
    run: async (args, options) => {
      if (String(args[1] || "").includes("HERMES_ADVISORY_AUTH_OK")) return "HERMES_ADVISORY_AUTH_OK";
      controllerTimeouts.push(options.timeoutMs);
      throw Object.assign(new Error("provider deadline timeout"), { code: "ETIMEDOUT" });
    },
  });
  const store = new GoalStore({ cwd: dir });
  const runner = new GoalRunner({ store, hermes, traceRuntime: { emit() {} } });
  const initial = await store.create("exhaust the bounded controller retry", { id: "g-controller-timeout-budget", maxIterations: 3 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.deepEqual(controllerTimeouts, [30_000, 30_000], "both controller attempts receive the independent thirty-second timeout budget");
  assert.equal(final.history[0].controllerAttempts, 2, "the larger timeout does not add a third controller attempt");
  assert.equal(final.history[0].errorCategory, "timeout");
}

async function testRunnerDoesNotRetryLaterHermesTimeout() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  let calls = 0;
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify(runningPrompt("Inspect current Haven load state.", "inspect-haven"));
      throw hermesFailure("timeout");
    },
  });
  const initial = await store.create("later timeout is terminal", { id: "g-later-timeout", maxIterations: 3 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.equal(final.iteration, 2);
  assert.equal(calls, 2, "only the initial controller decision receives a timeout retry");
  assert.equal(final.history.at(-1).errorCategory, "timeout");
  assert.equal(final.history.at(-1).controllerAttempts, 1);
}

async function testRunnerClassifiesHermesCommandFailure() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const error = hermesFailure("transport", "Command failed: hermes chat");
  error.killed = true;
  error.signal = "SIGTERM";
  let calls = 0;
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => { calls += 1; throw error; },
  });
  const initial = await store.create("blocked by hermes", { id: "g8", maxIterations: 1 });
  const final = await runner.run(initial, fakeCtx());
  const observations = final.observations.join("\n");
  assert.equal(final.status, "blocked");
  assert.equal(calls, 1, "non-timeout controller failures are not retried");
  assert.match(observations, /Hermes controller command failed/);
  assert.match(observations, /process killed/);
  assert.doesNotMatch(observations, /malformed JSON/);
  assert.equal(final.history.at(-1).errorKind, "hermes_command");
  assert.equal(final.history.at(-1).errorCategory, "transport");
  assert.equal(final.history.at(-1).controllerAttempts, 1);
}

async function testRunnerRejectsImmediateCompletionWithoutHarnessEvidence() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => JSON.stringify(terminal("completed", "verified-files", ["unregistered-evidence"])),
  });
  const initial = await store.create("premature completion", { id: "g6", maxIterations: 5 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.match(final.observations.join("\n"), /Completion rejected: goal-evidence-adapter-unavailable/);
}

async function testRunnerRejectsCompletionWithoutEvidence() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => JSON.stringify(terminal("completed", "looks-done", ["unregistered-evidence"])),
  });
  const initial = await store.create("vague completion", { id: "g5", maxIterations: 5 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.match(final.observations.join("\n"), /Completion rejected/);
}

function testSafetyPolicy() {
  const cwd = process.cwd();
  assert.match(isUnsafeNextPrompt("run rm -rf build", cwd), /removal/);
  assert.match(isUnsafeNextPrompt("sudo apt update", cwd), /sudo/);
  assert.match(isUnsafeNextPrompt("write /refactor", cwd), /outside repo: \/refactor/);
  assert.match(isUnsafeNextPrompt(`write ${cwd}-outside/file.txt`, cwd), /outside repo/);
  assert.equal(isUnsafeNextPrompt("list files with find . -type f", cwd), undefined);
  assert.equal(isUnsafeNextPrompt("edit only minimal necessary Lean/doc files", cwd), undefined);
  assert.equal(isUnsafeNextPrompt("do not write /refactor; inspect logs instead", cwd), undefined);
  assert.equal(isUnsafeNextPrompt(`Important: a previous similar goal was blocked by a write-like path outside the repo (/refactor), so do not write outside ${cwd} and do not use /refactor. Save the report to ${cwd}/.pi/perf-recon-2026-05-25.md.`, cwd), undefined);
}

function testHermesCommandHelpers() {
  const packet = publicGoalPacket({ id: "goal-public", goal: "Inspect integration status", status: "running", iteration: 2, maxIterations: 5, actionAuthority: { approvedTopologyIds: ["planner-coder-verifier"] }, observations: ["private raw tool output"], history: [{ iteration: 1, status: "running", attemptedActionKind: "inspect", dispatchMode: "typed", actionResultCode: "succeeded", result: "private result", rawHermesOutput: "private provider output", completionEvidenceIds: ["evidence-1"] }] }, "/tmp/ExampleGame");
  assert.equal(packet.goalId, "goal-public");
  assert.equal(packet.executionContext.projectName, "ExampleGame");
  assert.equal(packet.executionContext.workspaceRef, "current-project");
  assert.deepEqual(packet.approvedTopologyIds, ["planner-coder-verifier"]);
  assert.equal(packet.recentActions[0].actionResultCode, "succeeded");
  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /\/tmp\/ExampleGame/, "goal provider packets identify the current project without exposing its absolute path");
  assert.doesNotMatch(serialized, /private raw tool output|private result|private provider output/, "goal provider packets exclude observations and raw outputs");
  assert.doesNotMatch(serialized, /session|continue/, "goal provider packets never request durable Hermes conversations");

  const error = new Error("Command failed: hermes advisory");
  error.killed = true;
  error.signal = "SIGTERM";
  error.stderr = "provider secret raw output";
  assert.match(commandOutput(error), /process killed/);
  assert.doesNotMatch(commandOutput(error), /provider secret raw output/);
  assert.match(commandOutput(error), /signal=SIGTERM/);
}

async function testRunnerBlocksUnsafePromptBeforeExecution() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  let executed = false;
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => JSON.stringify(runningPrompt("run rm -rf build", "cleanup")),
  });
  const ctx = fakeCtx();
  ctx.sendUserMessage = async () => { executed = true; };
  const initial = await store.create("unsafe", { id: "g7", maxIterations: 2 });
  const final = await runner.run(initial, ctx);
  assert.equal(final.status, "blocked");
  assert.equal(executed, false);
  assert.match(final.observations.join("\n"), /unsafe autonomous action/);
}

async function testRunnerBlocksAtMaxIterations() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const runner = new GoalRunner({
    store,
    traceRuntime: { emit() {} },
    hermesAsk: async () => JSON.stringify(runningPrompt("keep going", "not-done")),
  });
  const initial = await store.create("never done", { id: "g4", maxIterations: 2 });
  const final = await runner.run(initial, fakeCtx());
  assert.equal(final.status, "blocked");
  assert.equal(final.iteration, 2);
  assert.match(final.observations.at(-1), /Max iteration limit reached/);
}

(async () => {
  await testStorePersistsAndCancels();
  await testStoreMetricsAndPrune();
  await testFixtureHermesAsk();
  await testParsingAndValidation();
  await testRunnerExecutesUntilVerifiedCompletion();
  await testRunnerQueuesAndAutoResumesWithoutWaitForIdle();
  await testRunnerFinalizesAfterTerminalSaveWithoutDefaultHermesSync();
  await testRunnerRepairsMalformedHermesJsonOnce();
  await testRunnerRepairsRedundantCurrentProjectQuestion();
  await testRunnerRepairsMismatchedTopologyInputRef();
  await testRunnerRetriesInitialTimeoutThenContinues();
  await testRunnerWaitsForReadinessRetryAfterBeforeInitialRetry();
  await testRunnerBlocksAfterInitialTimeoutRetryExhaustion();
  await testRunnerUsesControllerTimeoutForTwoConsecutiveTimeouts();
  await testRunnerDoesNotRetryLaterHermesTimeout();
  await testRunnerClassifiesHermesCommandFailure();
  await testRunnerRejectsImmediateCompletionWithoutHarnessEvidence();
  await testRunnerRejectsCompletionWithoutEvidence();
  testSafetyPolicy();
  testHermesCommandHelpers();
  await testRunnerBlocksUnsafePromptBeforeExecution();
  await testRunnerBlocksAtMaxIterations();
  console.log("goal-store-runner tests passed");
})();
