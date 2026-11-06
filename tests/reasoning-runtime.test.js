"use strict";
const assert = require("node:assert/strict");
const { MemoryJsonStorage, ReasoningRuntimeAdapter } = require("../src/integration-boundary");
const { ReasoningRuntime, ARTIFACT_TYPES, stripPrivateReasoning } = require("../src/reasoning-runtime");

const storage = new MemoryJsonStorage();
const runtime = new ReasoningRuntime({ storage });

assert.throws(() => runtime.createPlan({ objective: "refactor", steps: [], chainOfThought: "private" }), /private reasoning fields/, "private reasoning fields are rejected before persistence");
assert.throws(() => runtime.createPlan({ steps: [] }), /invalid reasoning artifact/, "malformed plan artifacts are rejected");
const plan = runtime.createPlan({ objective: "refactor", steps: ["inspect", { id: "s2", description: "edit" }] });
assert.equal(plan.type, ARTIFACT_TYPES.PLAN);
assert.equal(plan.steps.length, 2);

const decomposition = runtime.decomposeTask({ task: "refactor", subtasks: ["runtime", "tests"] });
const hypothesis = runtime.trackHypothesis({ statement: "old architecture simulates reasoning", falsifiers: ["no internal planner"] });
const decision = runtime.recordDecision({ decision: "model reasons; harness records artifacts", evidenceIds: [hypothesis.id] });
assert.throws(() => runtime.recordExecutorAction({ action: "edit", privateReasoning: "hidden" }), /private reasoning fields/);
const action = runtime.recordExecutorAction({ action: "edit", planStepId: "s2", outputs: { files: ["src/reasoning-runtime.js"] } });
assert.throws(() => runtime.recordVerifierEvidence({ claim: "tests pass", kind: "test" }), /invalid reasoning artifact/);
const evidence = runtime.recordVerifierEvidence({ claim: "tests pass", ok: false, kind: "test", method: "node", observations: ["missing docs"] });
const feedback = runtime.addVerifierFeedback({ evidenceId: evidence.id, targetArtifactId: plan.id, message: "add docs", requiredActions: ["document operational model"] });
const checkpoint = runtime.createCheckpoint({ kind: "reflection", publicSummary: "Need docs", scratchpad: "private working notes", artifactIds: [plan.id, evidence.id] });
const comparison = runtime.compareBranches({ left: plan, right: decomposition, criteria: ["verified evidence", { name: "lower risk", evaluate: () => ({ winner: "left", reason: "smaller change" }) }] });
const failure = runtime.analyzeFailure({ failure: { command: "test" }, evidenceIds: [evidence.id], actionIds: [action.id], hypothesisIds: [hypothesis.id] });
const hugeVerifierOutput = "Unit Test Success ".repeat(200_000);
const compactEvidence = runtime.recordVerifierEvidence({ claim: hugeVerifierOutput, ok: false, kind: "automated", method: "verification-adapter", verifier: hugeVerifierOutput, observations: [hugeVerifierOutput], artifacts: ["proof_large.json"] });
const compactFailure = runtime.analyzeFailure({ failure: { id: "proof_large", ok: false, verifiers: [{ id: "unit", ok: false, output: hugeVerifierOutput }] }, evidenceIds: [compactEvidence.id], summary: "Large verifier failed." });
const memory = runtime.updateMemory({ content: "Only store verified summaries", sourceArtifactIds: [decision.id, evidence.id], verification: "verified" });

assert.equal(feedback.type, ARTIFACT_TYPES.VERIFIER_FEEDBACK);
assert.equal(checkpoint.scratchpad, undefined, "scratchpad contents are separated from public result artifacts");
assert(checkpoint.scratchpadRef, "checkpoint references private scratchpad without exposing it");
assert.equal(comparison.conclusion, "left");
assert(failure.correctiveActions.length >= 1);
assert(compactEvidence.claim.length <= 4000, "verifier claims are bounded before entering runtime state");
assert(compactEvidence.verifier.length <= 512, "verifier identifiers cannot bypass evidence compaction");
assert(compactEvidence.observations[0].length <= 4000, "verifier observations are bounded before entering runtime state");
assert(compactFailure.failure.verifiers[0].output.length <= 2000, "failure analysis never embeds full verifier output");
assert(JSON.stringify(compactFailure).length < 10_000, "a multi-megabyte verifier result becomes a compact reasoning artifact");
assert.equal(memory.type, ARTIFACT_TYPES.MEMORY_UPDATE);
assert(runtime.resultPacket().scratchpadRefs.length === 1);
assert(!JSON.stringify(runtime.publicArtifacts()).includes("private working notes"), "public packet does not expose scratchpad text");
assert.equal(runtime.exportPacket().version, 1);
assert(runtime.replay().some((s) => s.type === ARTIFACT_TYPES.PLAN));
assert(runtime.metrics().byType[ARTIFACT_TYPES.PLAN] >= 1, "metrics include counts by artifact type");
const autoEvidence = runtime.recordVerifierEvidence({ claim: "Automatic verification for file", ok: false, kind: "automated", method: "verification-adapter", verifier: "cognitive-automation", observations: ["failed"] });
const autoFeedback = runtime.addVerifierFeedback({ evidenceId: autoEvidence.id, status: "needs_revision", message: "fix" });
const autoFailure = runtime.analyzeFailure({ failure: { ok: false }, evidenceIds: [autoEvidence.id], summary: "Automatic verification failed." });
const dryAutoPrune = runtime.pruneAutomatedVerification({ keep: 0, dryRun: true });
assert(dryAutoPrune.removed.some((r) => r.id === autoEvidence.id), "automated verification prune previews evidence removal");
assert(runtime.getArtifact(autoEvidence.id), "dry-run prune does not mutate reasoning artifacts");
const autoPrune = runtime.pruneAutomatedVerification({ keep: 0, dryRun: false });
assert(autoPrune.removed.some((r) => r.id === autoFeedback.id) && autoPrune.removed.some((r) => r.id === autoFailure.id), "automated verification prune removes linked feedback/failure artifacts");
assert.equal(runtime.getArtifact(autoEvidence.id), null);

for (let i = 0; i < 5; i++) runtime.createPlan({ objective: `auto ${i}`, steps: [], source: "model-scaffold" });
const pruned = runtime.prune({ maxAutoScaffold: 2 });
assert(pruned.removed.length >= 3, "prune removes old automatic scaffold artifacts");
assert(runtime.publicArtifacts({ type: ARTIFACT_TYPES.DECISION_RECORD }).some((a) => a.id === decision.id), "prune preserves decision records");
assert.deepEqual(stripPrivateReasoning({ a: 1, scratchpad: "x", nested: { cot: "y", b: 2 } }), { a: 1, nested: { b: 2 } });

runtime.persist();
const restored = new ReasoningRuntime({ storage });
assert(restored.publicArtifacts().length >= 9, "runtime scaffolding persists artifacts");

const adapter = new ReasoningRuntimeAdapter({ storage: new MemoryJsonStorage() });
const scaffold = adapter.coordinate("do work", { steps: ["plan"] });
Promise.resolve(scaffold).then((result) => {
  assert.equal(result.kind, "reasoning.scaffold");
  assert.equal(result.plan.type, ARTIFACT_TYPES.PLAN);
  console.log("reasoning-runtime tests passed");
}).catch((err) => { console.error(err); process.exit(1); });
