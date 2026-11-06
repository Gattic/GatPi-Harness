"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const {
  validateGoalDecisionV3,
  validateGoalDecisionForContext,
  parseGoalDecision,
  dispatchGoalAction,
  topologyAuthority,
} = require("../src/goal-controller-actions.js");
const { EvidenceStore } = require("../src/evidence-binder.js");
const { GoalEvidenceAdapter } = require("../src/integration-boundary.js");
const { GoalStore } = require("../.pi/extensions/goal/goal-store.js");
const { GoalRunner } = require("../.pi/extensions/goal/goal-runner.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

async function tempDir() { return tmpFixture("pi-goal-actions-"); }
function v3(overrides = {}) {
  return {
    schemaVersion: 3,
    status: "running",
    action: { kind: "inspect", targetKind: "status", targetRef: "goal-current", prompt: "Inspect the current goal status without making changes." },
    reasonCode: "inspect-current-state",
    requiresUserInput: false,
    completionEvidenceIds: [],
    ...overrides,
  };
}
function ctx() {
  const branch = [];
  return {
    sessionManager: { getBranch: () => branch },
    async sendUserMessage(prompt) {
      branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } });
      branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "inspection settled" }] } });
    },
    async waitForIdle() {},
  };
}

function testStrictDecisionSchemaAndHermesPrompts() {
  const decision = validateGoalDecisionV3(v3());
  assert.equal(decision.schemaVersion, 3);
  assert.equal(decision.action.kind, "inspect");
  assert.match(decision.action.prompt, /current goal status/);
  assert.throws(() => validateGoalDecisionV3(v3({ surprise: true })), /surprise is not allowed/);
  assert.throws(() => validateGoalDecisionV3(v3({ action: { kind: "shell", command: "true" } })), /unknown goal action/);
  assert.throws(() => validateGoalDecisionV3(v3({ action: { kind: "compat_prompt", prompt: "inspect tests" } })), /unknown goal action/);
  assert.throws(() => validateGoalDecisionV3(v3({ action: { kind: "run_topology", topologyId: "reviewer-verifier-gate", inputRef: "goal-1", prompt: "Run the reviewer-verifier-gate topology.", task: "injected" } })), /action.task is not allowed/);
  assert.throws(() => validateGoalDecisionV3(v3({ action: { kind: "inspect", targetKind: "file", targetRef: "../secret", prompt: "Inspect the target file." } })), /bounded relative reference/);
  assert.throws(() => validateGoalDecisionV3(v3({ action: { kind: "inspect", targetKind: "status", targetRef: "goal-current" } })), /action.prompt is required/);
  assert.throws(() => validateGoalDecisionV3(v3({ status: "completed", action: null, completionEvidenceIds: [] })), /requires completionEvidenceIds/);
  assert.throws(() => validateGoalDecisionV3(v3({ requiresUserInput: true })), /requires an ask_user action/);
  assert.throws(() => validateGoalDecisionV3(v3({ action: { kind: "ask_user", question: "Proceed?" }, requiresUserInput: false })), /requires requiresUserInput:true/);

  const redundantProjectQuestion = v3({ action: { kind: "ask_user", question: "Which project/repository should be modified, and what is its absolute path?" }, reasonCode: "project-required", requiresUserInput: true });
  assert.equal(validateGoalDecisionV3(redundantProjectQuestion).action.kind, "ask_user", "the base schema remains context independent");
  assert.throws(() => validateGoalDecisionForContext(redundantProjectQuestion, { currentProjectAvailable: true }), (error) => error.code === "GOAL_DECISION_INSPECTABLE_USER_INPUT" && /current project\/repository path/.test(error.message));
  assert.equal(validateGoalDecisionForContext(v3({ action: { kind: "ask_user", question: "Should placed terrain consume inventory?" }, requiresUserInput: true }), { currentProjectAvailable: true }).action.kind, "ask_user", "genuine user preferences remain askable");

  const mismatchedTopologyInput = v3({ action: { kind: "run_topology", topologyId: "planner-coder-verifier", inputRef: "current-project", prompt: "Run the approved topology for this goal." } });
  assert.equal(validateGoalDecisionV3(mismatchedTopologyInput).action.inputRef, "current-project", "the base schema remains independent of the current goal packet");
  assert.throws(
    () => validateGoalDecisionForContext(mismatchedTopologyInput, { goalId: "goal-1" }),
    (error) => error.code === "GOAL_DECISION_INPUT_REF_MISMATCH" && /packet\.goalId/.test(error.message),
  );
  const matchedTopologyInput = v3({ action: { kind: "run_topology", topologyId: "planner-coder-verifier", inputRef: "goal-1", prompt: "Run the approved topology for this goal." } });
  assert.equal(validateGoalDecisionForContext(matchedTopologyInput, { goalId: "goal-1" }).action.inputRef, "goal-1");
  const mismatchedVerifierInput = v3({ action: { kind: "run_verifier", profile: "changed", inputRef: "current-project", prompt: "Run changed verification for this goal." } });
  assert.throws(
    () => validateGoalDecisionForContext(mismatchedVerifierInput, { goalId: "goal-1" }),
    (error) => error.code === "GOAL_DECISION_INPUT_REF_MISMATCH",
  );

  assert.throws(() => parseGoalDecision({ status: "running", nextPrompt: "inspect tests", reason: "legacy", completionCheck: "tests", requiresUserInput: false }), /not allowed|schemaVersion must be 3/);
}

function testTypedDispatchAndAuthority() {
  const state = { id: "goal-1", actionAuthority: { approvedTopologyIds: [] } };
  const verifierPrompt = "Run changed verification and preserve the resulting evidence IDs.";
  const verifier = dispatchGoalAction({ kind: "run_verifier", profile: "changed", inputRef: "goal-1", prompt: verifierPrompt }, state);
  assert.equal(verifier.ok, true);
  assert.equal(verifier.dispatchMode, "hermes-prompt");
  assert.equal(verifier.prompt, verifierPrompt);
  assert.equal(verifier.promptSource, "hermes");
  assert.equal(dispatchGoalAction({ kind: "run_verifier", profile: "changed", inputRef: "other", prompt: verifierPrompt }, state).reasonCode, "goal-input-ref-mismatch");

  const readOnly = topologyAuthority("reviewer-verifier-gate", state);
  assert.equal(readOnly.allowed, true);
  assert.equal(readOnly.mutationCapable, false);
  const mutating = topologyAuthority("planner-coder-verifier", state);
  assert.equal(mutating.allowed, false);
  assert.equal(mutating.reasonCode, "topology-mutation-approval-required");
  const approvedState = { ...state, actionAuthority: { approvedTopologyIds: ["planner-coder-verifier"] } };
  assert.equal(topologyAuthority("planner-coder-verifier", approvedState).allowed, true);
  const topologyPrompt = "Run planner-coder-verifier for the current goal and preserve evidence IDs.";
  const topologyDispatch = dispatchGoalAction({ kind: "run_topology", topologyId: "planner-coder-verifier", inputRef: "goal-1", prompt: topologyPrompt }, approvedState);
  assert.equal(topologyDispatch.ok, true);
  assert.equal(topologyDispatch.prompt, topologyPrompt);
  assert.equal(dispatchGoalAction({ kind: "run_topology", topologyId: "not-installed", inputRef: "goal-1", prompt: "Run not-installed." }, state).reasonCode, "topology-not-allowlisted");

  const ask = dispatchGoalAction({ kind: "ask_user", question: "Which target should be used?" }, state);
  assert.equal(ask.dispatchMode, "ask-user");
  assert.equal(ask.prompt, undefined);
}

async function testGoalEvidenceAdapterRejectsStaleFakeFailingAndTamperedProof() {
  const dir = await tempDir();
  const store = new EvidenceStore({ cwd: dir });
  const goalCreatedAt = "2026-07-31T12:00:00.000Z";
  const stale = store.saveEvidence({ id: "evidence-stale", createdAt: "2026-07-31T11:59:59.000Z", ok: true, summary: "old pass" });
  const passing = store.saveEvidence({ id: "evidence-passing", createdAt: "2026-07-31T12:00:01.000Z", ok: true, summary: "current pass" });
  const failing = store.saveEvidence({ id: "evidence-failing", createdAt: "2026-07-31T12:00:02.000Z", ok: false, summary: "current fail" });
  const tampered = store.saveEvidence({ id: "evidence-tampered", createdAt: "2026-07-31T12:00:03.000Z", ok: true, summary: "before tamper" });
  const tamperedFile = store.packetFile(tampered.id);
  const body = JSON.parse(await fs.readFile(tamperedFile, "utf8"));
  body.summary = "modified after registration";
  await fs.writeFile(tamperedFile, `${JSON.stringify(body, null, 2)}\n`);

  const adapter = new GoalEvidenceAdapter({ cwd: dir, store });
  const accepted = adapter.validateCompletion({ evidenceIds: [passing.id], goalCreatedAt });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.results[0].id, passing.id);
  assert.equal("evidence" in accepted.results[0], false, "goal proof API does not return evidence bodies");
  assert.equal(adapter.validateCompletion({ evidenceIds: [stale.id], goalCreatedAt }).reason, "evidence-predates-goal");
  assert.equal(adapter.validateCompletion({ evidenceIds: [failing.id], goalCreatedAt }).reason, "evidence-not-passing");
  assert.equal(adapter.validateCompletion({ evidenceIds: [tampered.id], goalCreatedAt }).reason, "evidence-fingerprint-mismatch");
  assert.equal(adapter.validateCompletion({ evidenceIds: ["evidence-fake"], goalCreatedAt }).reason, "evidence-not-registered");
  assert.equal(adapter.validateCompletion({ evidenceIds: [passing.id], goalCreatedAt, expectedFingerprints: { [passing.id]: "wrong" } }).reason, "evidence-expected-fingerprint-mismatch");
}

async function testRunnerUsesTypedActionsAndEvidenceIds() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const decisions = [
    v3({ action: { kind: "run_verifier", profile: "changed", inputRef: "goal-v2", prompt: "Run changed verification for this goal and preserve evidence-current." }, reasonCode: "run-focused-verification" }),
    v3({ status: "completed", action: null, reasonCode: "verified", completionEvidenceIds: ["evidence-current"] }),
  ];
  const evidenceCalls = [];
  const runner = new GoalRunner({
    store,
    hermesAsk: async () => JSON.stringify(decisions.shift()),
    evidenceAdapter: { validateCompletion(input) { evidenceCalls.push(input); return { ok: true, reason: "current-passing-evidence", results: [{ ok: true, id: "evidence-current" }] }; } },
  });
  const initial = await store.create("typed goal", { id: "goal-v2", maxIterations: 3 });
  const final = await runner.run(initial, ctx());
  assert.equal(final.status, "completed");
  assert.deepEqual(final.completionEvidenceIds, ["evidence-current"]);
  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0].goalCreatedAt, initial.createdAt);
  assert.equal(final.history[0].action.kind, "run_verifier");
  assert.equal(final.history[0].dispatchMode, "hermes-prompt");
  assert.equal(final.history[0].promptSource, "hermes");
  assert.equal(final.history[0].actionResultCode, "prompt-settled");
  assert.equal(final.history[1].actionResultCode, "completion-proof-accepted");
}

async function testRunnerRejectsLegacyDecisionShape() {
  const dir = await tempDir();
  const store = new GoalStore({ cwd: dir });
  const initial = await store.create("strict proof", { id: "goal-strict", maxIterations: 1 });
  const runner = new GoalRunner({ store, hermesAsk: async () => JSON.stringify({ status: "completed", nextPrompt: "", reason: "tests passed", completionCheck: "command output showed tests passed", requiresUserInput: false }) });
  const final = await runner.run(initial, ctx());
  assert.equal(final.status, "blocked");
  assert.equal(final.history.at(-1).errorKind, "malformed_hermes_json");
  assert.match(final.history.at(-1).error, /not allowed|schemaVersion must be 3/);
}

(async () => {
  testStrictDecisionSchemaAndHermesPrompts();
  testTypedDispatchAndAuthority();
  await testGoalEvidenceAdapterRejectsStaleFakeFailingAndTamperedProof();
  await testRunnerUsesTypedActionsAndEvidenceIds();
  await testRunnerRejectsLegacyDecisionShape();
  console.log("goal-controller-actions tests passed");
})();
