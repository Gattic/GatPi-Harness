"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  LearningStore,
  hasSecretLikeText,
  createOutcome,
  outcomeRater,
  executionOutcomeToLearningInput,
  createProposal,
  reviewProposal,
  reviewProposalWithLocalChecks,
  localPolicyCheck,
  delegatedApplyPlan,
  transitionProposal,
  minePatterns,
  mineFailurePatterns,
  learningSelfBenchmarkPlan,
  contextAttributionReport,
  verificationCommandWords,
  ingestLearningSources,
  proposeImprovements,
} = require("../src/learning-loop");
const { sha256, buildLoopOutcomePacket, ExecutionOutcomeStore } = require("../src/execution-outcome");
const { tmpFixture } = require("./helpers/tmp-fixture");

function tmp() { return tmpFixture("pi-learning-loop-"); }
assert.deepEqual(verificationCommandWords("node tests/learning-loop.test.js"), ["node", "tests/learning-loop.test.js"]);
assert.throws(() => verificationCommandWords("node ok.js && rm -rf /"), /without shell operators/);

const secret = "sk-1234567890abcdefghijklmnop";
const redactedOutcome = createOutcome({
  source: "manual",
  summary: `user: hi\nassistant: ok\nuser: token ${secret}\nassistant: done\nAPI_KEY=${secret}`,
  task: { summary: "Store safe learning outcome" },
  signals: { status: "succeeded", evidenceLevel: "claim" },
});
assert.equal(redactedOutcome.privacy.containsSecret, true);
assert.equal(redactedOutcome.privacy.containsTranscript, true);
assert.doesNotMatch(JSON.stringify(redactedOutcome), new RegExp(secret));
assert.match(redactedOutcome.summary, /\[REDACTED/);
assert.ok(redactedOutcome.classifications.includes("unsupported-success"));
assert.ok(redactedOutcome.rating.qualityScore < 0.5);
assert.equal(hasSecretLikeText("skeletonPolicy"), false, "ordinary words beginning with sk should not be secret-like");
assert.ok(createOutcome({ summary: "skill metric", classifications: ["skill-underperformance"] }).classifications.includes("skill-underperformance"));
const retrievalOutcome = createOutcome({ summary: "retrieval candidate", signals: { status: "succeeded", evidenceLevel: "tool-output" }, retrieval: { strategyId: "repo-map-v1", queryId: "q1", runId: "run1", pairId: "pair1", rolloutMode: "advisory", metrics: { cost: 0.1, latencyMs: 50, tokens: 400 }, fallbackToBroadRead: true } });
assert.equal(retrievalOutcome.retrieval.strategyId, "repo-map-v1");
const retrievalAttribution = contextAttributionReport([retrievalOutcome], { minimumPaired: 2 });
assert.equal(retrievalAttribution.attribution, "explicit-retrieval-strategy");
assert.equal(retrievalAttribution.rows[0].pairedOutcomes, 1);
assert.equal(retrievalAttribution.rows[0].broadReadFallbacks, 1);
assert.equal(retrievalAttribution.rows[0].advisoryOnly, true);
const ratedPreview = outcomeRater({ summary: "failed verification", signals: { status: "domain-negative", evidenceLevel: "tool-output" } });
const timedOutPreview = outcomeRater({ summary: "bounded operation timed out", signals: { status: "timed_out", evidenceLevel: "tool-output" } });
assert.equal(timedOutPreview.outcome.signals.status, "timed-out");
assert(timedOutPreview.classifications.includes("execution-timeout"));
assert.ok(ratedPreview.classifications.includes("verification-failure"));
assert.ok(ratedPreview.rating.learningValue > 0.5);
const notApplicablePreview = outcomeRater({ summary: "no repository-defined tests apply", classifications: ["tool-failure", "verification-failure"], signals: { status: "not-applicable", evidenceLevel: "tool-output", verificationOk: false, toolErrors: 3 } });
assert.equal(notApplicablePreview.outcome.signals.status, "not-applicable");
assert.doesNotMatch(notApplicablePreview.classifications.join(","), /tool-failure|verification-failure/, "not-applicable outcomes must not seed failure patterns even when stale counters/classifications are present");

const verified = createOutcome({
  source: "verification",
  task: { summary: "Run full validation", repo: "/tmp/repo" },
  summary: "scripts/check-all.sh passed",
  signals: { status: "succeeded", evidenceLevel: "full-check", verificationOk: true, commands: ["bash scripts/check-all.sh"] },
  artifacts: { evidenceRefs: ["proof_1"], changedFiles: ["src/foo.js"] },
}, { now: "2026-05-21T00:00:00.000Z" });
assert.ok(verified.classifications.includes("verified-success"));
assert.equal(verified.rating.evidenceScore, 1);
const verifiedAgain = createOutcome({
  source: "verification",
  task: { summary: "Run full validation", repo: "/tmp/repo" },
  summary: "scripts/check-all.sh passed",
  signals: { status: "succeeded", evidenceLevel: "full-check", verificationOk: true, commands: ["bash scripts/check-all.sh"] },
  artifacts: { evidenceRefs: ["proof_1"], changedFiles: ["src/foo.js"] },
}, { now: "2027-01-01T00:00:00.000Z" });
assert.equal(verified.outcomeId, verifiedAgain.outcomeId, "outcome ids are deterministic over normalized content");

const storeRoot = tmp();
const store = new LearningStore({ cwd: storeRoot, clock: () => "2026-05-21T01:00:00.000Z" });
const stored = store.recordOutcome(verified);
assert.equal(store.listOutcomes().length, 1);
const duplicate = store.recordOutcome(verified);
assert.equal(duplicate.duplicate, true);
assert.equal(store.listOutcomes().length, 1, "outcome recording is idempotent by outcomeId");
assert.equal(store.listOutcomes({ classification: "verified-success" })[0].outcomeId, stored.outcomeId);
assert.equal(store.status().outcomes, 1);
assert.ok(store.decisions().some((d) => d.type === "outcome.recorded"));
assert.ok(store.decisions().some((d) => d.type === "outcome.duplicate"));

const executionPacket = buildLoopOutcomePacket({
  runId: "loop_learning_fixture",
  sourceSchemaVersion: 3,
  sourceRecord: { id: "loop_learning_fixture", status: "completed" },
  terminalState: "completed",
  taskHash: sha256("private execution prompt"),
  workflow: { steps: [{ kind: "iteration", status: "succeeded" }], toolNames: ["test_runner"], retries: 0 },
  evidenceRefs: ["evidence_learning_fixture"],
  metrics: { iterations: 1, toolCalls: 1, modelCalls: 1 },
  projectKeyHash: sha256("pi:fixture"),
  producerVersion: "test-fixture",
  evidenceClass: "exact-version-field",
  cohortId: "cohort-learning",
  arm: "candidate",
  sessionIdHash: sha256("session-learning"),
  settledAt: "2026-05-21T01:00:00.000Z",
});
const executionInput = executionOutcomeToLearningInput(executionPacket);
assert.equal(executionInput.source, "execution");
assert.doesNotMatch(JSON.stringify(executionInput), /private execution prompt/);
const executionOutcome = store.recordOutcome(executionInput);
assert.equal(store.recordOutcome(executionInput).duplicate, true);
assert.equal(store.listOutcomes({ source: "execution" }).length, 1, "one packet creates at most one learning outcome");
assert.equal(executionOutcome.task.repo, executionPacket.provenance.projectKeyHash, "learning stores only the project-key hash");
assert.equal(executionOutcome.evidenceClass, "exact-version-field");
assert.equal(executionOutcome.cohort.id, "cohort-learning");
const compoundingRecords = store.compoundingRecords();
assert.equal(compoundingRecords.outcomes.find((row) => row.outcomeId === executionOutcome.outcomeId).cohort.arm, "candidate");
assert.equal(compoundingRecords.outcomes.find((row) => row.outcomeId === executionOutcome.outcomeId).packetId, executionPacket.packetId);
assert.equal(JSON.stringify(compoundingRecords).includes(executionOutcome.summary), false, "compounding records omit outcome/task bodies");
const packetRoot = tmp();
new ExecutionOutcomeStore({ cwd: packetRoot }).save(executionPacket);
const packetLearningStore = new LearningStore({ cwd: packetRoot });
assert.equal(ingestLearningSources(packetRoot, "execution", { store: packetLearningStore }).recorded, 1);
assert.equal(ingestLearningSources(packetRoot, "execution", { store: packetLearningStore }).duplicates, 1);

const proposalInput = {
  kind: "test",
  title: "Add focused learning-loop store tests",
  problemStatement: "A verified outcome touched source without a focused test.",
  evidenceRefs: [stored.outcomeId, "proof_1"],
  affectedFiles: ["src/learning-loop.js"],
  suggestedChange: { summary: "Add deterministic store tests.", testDraft: { fixture: `TOKEN=${secret}` } },
  verificationPlan: { commands: ["node tests/learning-loop.test.js"] },
};
const proposal = store.createProposal(proposalInput);
const sameProposal = createProposal(proposalInput, { now: "2030-01-01T00:00:00.000Z" });
assert.equal(proposal.proposalId, sameProposal.proposalId, "proposal ids are deterministic over normalized content");
assert.equal(store.getProposal(proposal.proposalId).status, "draft");
assert.doesNotMatch(JSON.stringify(proposal), new RegExp(secret));
assert.match(JSON.stringify(proposal), /\[REDACTED/);
const decisionsBeforeSummary = store.decisions().length;
const summaryPreview = store.memorySummary(proposal.proposalId);
assert.equal(summaryPreview.preview, true);
assert.equal(summaryPreview.candidate.written, false);
assert.equal(summaryPreview.candidate.learningFile, null);
assert.equal(fs.existsSync(path.join(storeRoot, ".pi", "learning-loop", "memory-summaries")), false, "memory summary preview writes no candidate directory");
assert.equal(store.decisions().length, decisionsBeforeSummary, "memory summary preview writes no decision row");
const summaryWritten = store.memorySummary(proposal.proposalId, { write: true });
assert.equal(summaryWritten.preview, false);
assert.equal(summaryWritten.candidate.written, true);
assert.equal(fs.existsSync(summaryWritten.candidate.learningFile), true);
assert.equal(fs.existsSync(summaryWritten.candidate.curatorFile), true);
assert.equal(store.decisions().at(-1).type, "memory-summary.generated");
assert.throws(() => transitionProposal(proposal, { action: "approve" }), /ready_for_review/);

const reviewed = store.reviewProposal(proposal.proposalId, {
  evidence: { ok: true, reason: "outcome and proof refs exist" },
  privacy: { ok: true, reason: "redacted proposal" },
  policy: { ok: true, reason: "no direct mutation" },
  impact: { ok: true, reason: "targeted test command listed" },
});
assert.equal(reviewed.status, "ready_for_review");
assert.equal(reviewed.review.ready, true);
const approved = store.transitionProposal(proposal.proposalId, { action: "approve", actor: "test", note: "looks safe" });
assert.equal(approved.status, "approved");
assert.equal(store.applyProposal(proposal.proposalId).dryRun, true);
assert.equal(delegatedApplyPlan(approved).mutationByLearningLoop, false);
assert.throws(() => store.transitionProposal(proposal.proposalId, { action: "apply" }), /requires verification evidence/);
const applied = store.applyProposal(proposal.proposalId, { recordApplied: true, evidenceRefs: ["proof_apply"], verified: true });
assert.equal(applied.status, "applied");
assert.ok(store.decisions().some((d) => d.type === "proposal.apply"));
assert.ok(store.listOutcomes({ source: "proposal" }).some((o) => o.classifications.includes("proposal-applied")));

const dismissible = store.createProposal({ kind: "config", title: "Temporary config idea", problemStatement: "not enough evidence" });
const dismissed = store.transitionProposal(dismissible.proposalId, { action: "dismiss", reason: "weak evidence" });
assert.equal(dismissed.status, "dismissed");
assert.equal(store.listProposals({ status: "dismissed" }).length, 1);
assert.ok(store.listOutcomes({ source: "proposal" }).some((o) => o.classifications.includes("proposal-dismissed")));

const outcomes = [
  createOutcome({ summary: "success no focused test", signals: { status: "succeeded", evidenceLevel: "tool-output" }, artifacts: { changedFiles: ["src/a.js"] } }),
  createOutcome({ summary: "success no focused test again", signals: { status: "succeeded", evidenceLevel: "tool-output" }, artifacts: { changedFiles: ["src/b.js"] } }),
  createOutcome({ summary: "claim only", signals: { status: "succeeded", evidenceLevel: "claim" } }),
  createOutcome({ summary: "claim only again", signals: { status: "succeeded", evidenceLevel: "claim" } }),
  createOutcome({ summary: "verified workflow", signals: { status: "succeeded", evidenceLevel: "verification", verificationOk: true, commands: ["node tests/a.test.js"] } }),
  createOutcome({ summary: "verified workflow again", signals: { status: "succeeded", evidenceLevel: "verification", verificationOk: true, commands: ["node tests/b.test.js"] } }),
  createOutcome({ summary: "slow prompt", signals: { status: "succeeded", evidenceLevel: "tool-output", latencyMs: 5000 } }),
  createOutcome({ summary: "slow prompt again", signals: { status: "succeeded", evidenceLevel: "tool-output", latencyMs: 7000 } }),
];
const patterns = minePatterns(outcomes, { minOutcomesForPattern: 2 });
const patternsAgain = minePatterns(outcomes, { minOutcomesForPattern: 2 });
assert.deepEqual(patterns.map((p) => p.patternId), patternsAgain.map((p) => p.patternId), "pattern ids are deterministic");
assert.ok(patterns.every((p) => p.fingerprint));
assert.ok(patterns.some((p) => p.classification === "missing-test"));
assert.ok(patterns.some((p) => p.classification === "unsupported-success"));
assert.ok(patterns.some((p) => p.classification === "verified-success"));
assert.ok(patterns.some((p) => p.classification === "latency-risk"));
const failurePatterns = mineFailurePatterns(outcomes, { minOutcomesForPattern: 2 });
assert.ok(failurePatterns.length === 0, "failure-pattern-miner should not invent failures from successful outcomes");
const repeatedFailures = mineFailurePatterns([
  createOutcome({ summary: "verifier failed", signals: { status: "domain-negative", evidenceLevel: "verification", verificationOk: false } }),
  createOutcome({ summary: "verifier failed again", signals: { status: "domain-negative", evidenceLevel: "verification", verificationOk: false } }),
], { minOutcomesForPattern: 2 });
assert.ok(repeatedFailures.some((p) => p.classification === "verification-failure" && p.miner === "failure-pattern-miner"));
const storedPatterns = store.recordPatterns(patterns);
assert.equal(storedPatterns.recorded.length, patterns.length);
assert.equal(store.recordPatterns(patterns).duplicates.length, patterns.length);
assert.equal(store.listPatterns({ classification: "missing-test" }).length, 1);
assert.equal(store.status().patterns, patterns.length);
const proposals = proposeImprovements(patterns, { testCommands: ["node tests/learning-loop.test.js"], changedFiles: ["src/learning-loop.js"] });
assert.ok(proposals.some((p) => p.kind === "test" && p.suggestedChange.testDraft));
assert.ok(proposals.some((p) => p.kind === "prompt" && p.suggestedChange.promptDraft));
assert.ok(proposals.some((p) => p.kind === "skill" && p.suggestedChange.skillDraft));
assert.ok(proposals.some((p) => p.kind === "config" && p.suggestedChange.configDraft));
assert.ok(proposals.every((p) => p.risk.requiresUserApproval));
const sessionCandidateProposals = proposeImprovements([
  { patternId: "session_tool", classification: "session-candidate:id:tool-failure", summary: "candidate persisted", evidenceRefs: ["session-report-1"], count: 2 },
  { patternId: "session_workflow", classification: "session-candidate:id:workflow-repetition", summary: "candidate persisted", evidenceRefs: ["session-report-2"], count: 2 },
]);
assert.equal(sessionCandidateProposals[0].kind, "prompt", "persistent session tool failures should route to reviewed prompt/tool guidance");
assert.equal(sessionCandidateProposals[1].kind, "skill", "persistent repeated workflows should route to a reviewed skill candidate");

const benchmarkPlan = learningSelfBenchmarkPlan(process.cwd());
assert.ok(benchmarkPlan.commands.includes("node tests/learning-loop.test.js"));
const benchmarkPreview = store.benchmark({ run: false });
assert.equal(benchmarkPreview.ran, false);
assert.ok(store.decisions().some((d) => d.type === "benchmark.planned"));

const reviewedWithGates = reviewProposalWithLocalChecks(proposal, { cwd: storeRoot });
assert.equal(reviewedWithGates.status, "ready_for_review");
assert.equal(reviewedWithGates.review.checks.evidence.integration, "evidence-binder");
assert.equal(reviewedWithGates.review.checks.policy.integration, "policy-gate/runtime-policy");
assert.equal(localPolicyCheck(proposal, { cwd: storeRoot }).ok, true);

const verifyRoot = tmp();
const verifyStore = new LearningStore({ cwd: verifyRoot, clock: () => "2026-05-21T03:00:00.000Z" });
const verifyCandidate = verifyStore.createProposal({
  kind: "test",
  title: "Verify learning-loop proposal evidence capture",
  problemStatement: "A proposal needs command evidence before any applied claim.",
  evidenceRefs: ["outcome_verify"],
  affectedFiles: ["src/learning-loop.js"],
  verificationPlan: { commands: ["node -e \"console.log('learning verify ok')\""] },
});
const verifiedCandidate = verifyStore.verifyProposal(verifyCandidate.proposalId, { timeoutMs: 10_000 });
assert.equal(verifiedCandidate.verificationResult.ok, true);
assert.equal(verifiedCandidate.verificationResult.status, "verified");
assert.ok(verifiedCandidate.verificationResult.evidenceRefs[0].startsWith("evidence_"));
assert.ok(fs.existsSync(path.join(verifyRoot, ".pi", "evidence-binder", "packets", `${verifiedCandidate.verificationResult.evidenceRefs[0]}.json`)), "verification should capture an Evidence Binder packet");
assert.ok(verifyStore.decisions().some((d) => d.type === "proposal.verified" && d.ok === true));
assert.ok(verifyStore.listOutcomes({ source: "verification" }).some((o) => o.artifacts.evidenceRefs.includes(verifiedCandidate.verificationResult.evidenceRefs[0])));

fs.mkdirSync(path.join(verifyRoot, ".pi", "verification-center"), { recursive: true });
fs.writeFileSync(path.join(verifyRoot, ".pi", "verification-center", "latest.json"), JSON.stringify({
  profile: "changed",
  commands: [{ command: "node", args: ["tests/learning-loop.test.js"] }],
  evidence: { id: "proof_learning_latest", ok: true, confidence: 0.93, changeSet: { changedFiles: ["src/learning-loop.js"] } },
}, null, 2));
const latestOnly = verifyStore.createProposal({ kind: "config", title: "Capture latest verifier evidence", problemStatement: "Verification Center has the relevant proof.", evidenceRefs: ["proof_learning_latest"] });
const latestVerified = verifyStore.verifyProposal(latestOnly.proposalId, { captureLatestVerification: true });
assert.equal(latestVerified.verificationResult.ok, true);
assert.equal(latestVerified.verificationResult.latestVerificationCaptured, true);

const ingestRoot = tmp();
fs.mkdirSync(path.join(ingestRoot, ".pi", "evidence-binder"), { recursive: true });
fs.writeFileSync(path.join(ingestRoot, ".pi", "evidence-binder", "evidence.jsonl"), `${JSON.stringify({ id: "evidence_x", ok: true })}\n`);
fs.writeFileSync(path.join(ingestRoot, ".pi", "evidence-binder", "claims.jsonl"), `${JSON.stringify({ result: { ok: false, unsupported: [{}] } })}\n`);
fs.mkdirSync(path.join(ingestRoot, ".pi", "goal-state"), { recursive: true });
fs.writeFileSync(path.join(ingestRoot, ".pi", "goal-state", "repo.json"), JSON.stringify({ goals: [{ id: "goal_1", goal: "ship", status: "blocked", iteration: 1 }] }));
fs.mkdirSync(path.join(ingestRoot, ".pi", "runtime-doctor"), { recursive: true });
fs.writeFileSync(path.join(ingestRoot, ".pi", "runtime-doctor", "latest.json"), JSON.stringify({ warnings: ["slow latency"] }));
fs.mkdirSync(path.join(ingestRoot, ".pi", "memory-curator"), { recursive: true });
fs.writeFileSync(path.join(ingestRoot, ".pi", "memory-curator", "latest.json"), JSON.stringify({ candidates: [{ action: "forget stale duplicate" }] }));
fs.mkdirSync(path.join(ingestRoot, ".pi", "policy-enforcer"), { recursive: true });
fs.writeFileSync(path.join(ingestRoot, ".pi", "policy-enforcer", "latest.json"), JSON.stringify({ denied: 1 }));
fs.mkdirSync(path.join(ingestRoot, ".pi", "privacy-guard"), { recursive: true });
fs.writeFileSync(path.join(ingestRoot, ".pi", "privacy-guard", "latest-scan.json"), JSON.stringify({ ok: false, summary: { actionable: 1, ignored: 0 }, findings: [{}] }));
const ingestStore = new LearningStore({ cwd: ingestRoot, clock: () => "2026-05-21T04:00:00.000Z" });
const ingestedNewSources = ingestLearningSources(ingestRoot, "all", { store: ingestStore });
for (const source of ["evidence", "goal", "runtime", "memory", "policy", "privacy"]) assert.ok(ingestedNewSources.results.some((r) => r.source === source && r.outcome), `missing ${source} ingestion`);
assert.ok(ingestStore.listOutcomes({ source: "privacy" })[0].classifications.includes("privacy-risk"));

const verifyIngestRoot = tmp();
const verifyCenterDir = path.join(verifyIngestRoot, ".pi", "verification-center");
fs.mkdirSync(verifyCenterDir, { recursive: true });
const verifyIngestStore = new LearningStore({ cwd: verifyIngestRoot });
fs.writeFileSync(path.join(verifyCenterDir, "latest.json"), JSON.stringify({ profile: "quick", commands: [], evidence: { id: "proof_na", ok: null, status: "not-applicable", reason: "empty change set - nothing to verify", changeSet: { changedFiles: [] } } }));
const naIngest = ingestLearningSources(verifyIngestRoot, "verification", { store: verifyIngestStore });
assert.equal(naIngest.results[0].skipped, true, "not-applicable verification evidence records no outcome");
assert.match(naIngest.results[0].reason, /not applicable/);
assert.equal(verifyIngestStore.listOutcomes({ source: "verification" }).length, 0);
const skillCoverageGapFiles = ["scripts/install-agent-skills.sh", "src/reasoning-runtime.js", "src/skill-synthesis.js"];
fs.writeFileSync(path.join(verifyCenterDir, "latest.json"), JSON.stringify({ profile: "quick", commands: [], evidence: { id: "proof_gap", ok: false, status: "no-verifiers", reason: "no verifier commands discovered", changeSet: { changedFiles: skillCoverageGapFiles } } }));
const gapIngest = ingestLearningSources(verifyIngestRoot, "verification", { store: verifyIngestStore });
assert.ok(gapIngest.results[0].outcome, "coverage gaps still record an outcome");
const gapOutcome = verifyIngestStore.listOutcomes({ source: "verification" })[0];
assert.ok(gapOutcome.classifications.includes("verification-coverage-gap"));
assert.ok(!gapOutcome.classifications.includes("verification-failure"), "a coverage gap is not a verification failure");
assert.ok(!gapOutcome.classifications.includes("skill-underperformance"), "unmatched skill verifiers are not failed skill behavior");
assert.match(gapOutcome.summary, /NO-VERIFIERS \(coverage gap, fail-closed\)/);
assert.deepEqual(gapOutcome.artifacts.changedFiles, skillCoverageGapFiles);
fs.writeFileSync(path.join(verifyCenterDir, "latest.json"), JSON.stringify({ profile: "quick", commands: ["node tests/x.test.js"], evidence: { id: "proof_fail", ok: false, status: "fail", changeSet: { changedFiles: ["src/a.js"] }, verifiers: [{ id: "unit", ok: false }] } }));
const failIngest = ingestLearningSources(verifyIngestRoot, "verification", { store: verifyIngestStore });
assert.ok(failIngest.results[0].outcome);
assert.ok(verifyIngestStore.listOutcomes({ source: "verification" }).some((o) => o.classifications.includes("verification-failure")), "real verifier failures still classify as verification-failure");

fs.writeFileSync(path.join(verifyRoot, "target.txt"), "hello\n");
const approvedPatchProposal = verifyStore.createProposal({ kind: "test", title: "Refactor proposal source", problemStatement: "Needs a reviewed edit/ast_refactor plan", evidenceRefs: ["evidence_x"], affectedFiles: ["target.txt"], applicationPlan: { mode: "ast_refactor", rollback: "checkpoint" }, verificationPlan: { commands: ["node tests/learning-loop.test.js"] } });
verifyStore.reviewProposal(approvedPatchProposal.proposalId, { evidence: { ok: true }, privacy: { ok: true }, policy: { ok: true }, impact: { ok: true } });
verifyStore.transitionProposal(approvedPatchProposal.proposalId, { action: "approve", actor: "test" });
const patchPacket = verifyStore.createRefactorProposal(approvedPatchProposal.proposalId);
assert.equal(patchPacket.packet.dryRun, true);
assert.equal(patchPacket.packet.targetTool, "edit/ast_refactor");
assert.equal(patchPacket.packet.refactorInputs[0].mode, "preview");
assert.ok(fs.existsSync(patchPacket.file));
assert.match(patchPacket.file, /\.pi[\\/]learning-loop[\\/]refactor-proposals/);
assert.equal(fs.existsSync(path.join(verifyRoot, ".pi", "semantic-patches")), false, "learning proposals do not recreate retired semantic-patch state");
const experiment = verifyStore.createExperiment(approvedPatchProposal.proposalId);
assert.equal(experiment.advisoryOnly, true);
assert.ok(experiment.suggestedCommands.some((c) => c.includes("topology")));
const experimentEvidence = verifyStore.createExperiment(approvedPatchProposal.proposalId, { runBenchmark: true, timeoutMs: 1000 });
assert.ok(experimentEvidence.evidenceRefs[0].startsWith("evidence_"));
const attribution = verifyStore.contextAttribution({ limit: 100 });
assert.equal(attribution.kind, "context-attribution-optimizer");
const router = verifyStore.modelRouter({ limit: 100, minEvidence: 3 });
assert.equal(router.kind, "adaptive-model-router");
assert.ok(router.routes.every((route) => ["insufficient_evidence", "needs_review", "ready_for_review"].includes(route.readiness)));
const memorySummary = verifyStore.memorySummary(approvedPatchProposal.proposalId);
assert.equal(memorySummary.summary.kind, "proposal");
assert.equal(memorySummary.preview, true);
assert.equal(memorySummary.candidate.curatorFile, null);

const failedReview = reviewProposal(createProposal({ kind: "prompt", title: "Bad prompt", problemStatement: "missing evidence" }), {
  evidence: { ok: false, reason: "no evidence refs" },
  privacy: { ok: true },
  policy: { ok: true },
  impact: { ok: true },
});
assert.equal(failedReview.status, "draft");
assert.equal(failedReview.review.ready, false);
assert.equal(failedReview.review.failed[0].name, "evidence");

console.log("learning-loop tests passed");
