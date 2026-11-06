"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage.js");
const { HermesAdvisoryAdapter, validatePromptSuggestionPacket, validateSkillDraft } = require("../src/hermes-advisory.js");
const hermesReadiness = require("../src/hermes-readiness.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const cwd = tmpFixture("pi-hermes-advisory-");
  const binary = path.join(cwd, "hermes");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n"); fs.chmodSync(binary, 0o755);
  assert.equal(new HermesAdvisoryAdapter({ cwd, env: { ...process.env, PI_HERMES_ADVISORY: "0" } }).enabled, false);
  let malformedPlan = false;
  let promptSuggestionPrompt = "";
  let goalControllerPrompt = "";
  let goalControllerMode = "normal";
  let goalControllerRepairPrompt = "";
  const run = async (args) => {
    const prompt = String(args[1] || "");
    if (prompt.includes("HERMES_ADVISORY_AUTH_OK")) return "HERMES_ADVISORY_AUTH_OK";
    if (prompt.includes("HERMES_ADVISORY_CURATION_OK")) return "HERMES_ADVISORY_CURATION_OK";
    if (prompt.includes("Repair the following Hermes plan response")) return JSON.stringify({ schemaVersion: 1, summary: "repaired", steps: [{ id: "inspect", action: "Inspect public status", evidenceNeeded: ["status"] }], risks: [], completionEvidence: ["status"] });
    if (prompt.includes("Repair the following Hermes decide response")) { goalControllerRepairPrompt = prompt; return JSON.stringify({ schemaVersion: 3, status: "running", action: { kind: "inspect", targetKind: "status", targetRef: "goal-current", prompt: "Inspect the current project before proceeding." }, reasonCode: "inspect-current-project", requiresUserInput: false, completionEvidenceIds: [] }); }
    if (prompt.includes("read-only planning advisor")) {
      if (malformedPlan) { malformedPlan = false; return "not-json"; }
      return JSON.stringify({ schemaVersion: 1, summary: "bounded plan", steps: [{ id: "inspect", action: "Inspect public status", evidenceNeeded: ["status"] }], risks: ["stale evidence"], completionEvidence: ["status"] });
    }
    if (prompt.includes("read-only evidence reviewer")) return JSON.stringify({ schemaVersion: 1, verdict: "concerns", summary: "gap", findings: ["Missing field evidence"], evidenceGaps: ["cohort"], nextActions: ["Collect evidence"] });
    if (prompt.includes("summarizing bounded public evidence")) return JSON.stringify({ schemaVersion: 1, summary: "summary", supported: ["typed output"], unsupported: ["field efficacy"], nextActions: ["measure"] });
    if (prompt.includes("typed goal controller")) { goalControllerPrompt = prompt; return goalControllerMode === "redundant-project-question" ? JSON.stringify({ schemaVersion: 3, status: "running", action: { kind: "ask_user", question: "Which repository and absolute path should be modified?" }, reasonCode: "project-required", requiresUserInput: true, completionEvidenceIds: [] }) : JSON.stringify({ schemaVersion: 3, status: "running", action: { kind: "inspect", targetKind: "status", targetRef: "hermes-advisory", prompt: "Inspect Hermes advisory status without making changes." }, reasonCode: "inspect-status", requiresUserInput: false, completionEvidenceIds: [] }); }
    if (prompt.includes("suggesting the user's next prompt")) { promptSuggestionPrompt = prompt; return "Continue with the bounded verifier"; }
    if (prompt.includes("unverified project-memory candidates")) return JSON.stringify({ schemaVersion: 1, candidates: [{ kind: "decision", title: "Canonical authority", content: "Obsidian project notes remain canonical.", sourceHashes: ["sha256:source"], evidenceIds: ["evidence-1"], confidence: 0.8, expiresAt: null, conflicts: [] }] });
    if (prompt.includes("quarantined Agent Skills candidate")) return JSON.stringify({ schemaVersion: 1, name: "verified-workflow", description: "Use for repeated verified workflow tasks.", skillMarkdown: "---\nname: verified-workflow\ndescription: Use for repeated verified workflow tasks.\n---\n\n# Verified workflow\n\n## Workflow\n\n1. Inspect evidence.\n2. Verify the result.\n", files: [] });
    if (args[0] === "--version") return "fake-hermes 1.0";
    throw new Error(`unexpected fake Hermes call: ${args.join(" ")}`);
  };
  const promptPacket = {
    publicRecentContext: "[user] Repair contextual prompt suggestions.\n[assistant] Focused verification passed.",
    skillContext: null,
  };
  assert.deepEqual(validatePromptSuggestionPacket(promptPacket), promptPacket);
  assert.throws(() => validatePromptSuggestionPacket({ ...promptPacket, messages: [] }), /unsupported fields: messages/);
  assert.throws(() => validatePromptSuggestionPacket({ ...promptPacket, publicRecentContext: "x".repeat(12001) }), /at most 12000 characters/);
  const autoProbeCwd = tmpFixture("pi-hermes-advisory-auto-probe-");
  const autoProbeCalls = [];
  const autoProbeAdapter = new HermesAdvisoryAdapter({ cwd: autoProbeCwd, run: async (args, options) => { autoProbeCalls.push({ args, options }); return run(args); }, bin: binary, policy: { promptTimeoutMs: 1000, authProbeTimeoutMs: 1000 } });
  const autoProbeController = new AbortController();
  const autoProbeSuggestion = await autoProbeAdapter.promptSuggestion(promptPacket, { probeAuth: true, timeoutMs: 1, signal: autoProbeController.signal });
  assert.equal(autoProbeSuggestion.value, "Continue with the bounded verifier");
  assert.match(promptSuggestionPrompt, /Return ONLY one concise, complete prompt for the best next step/, "Hermes should use the original best-next-prompt instruction");
  assert.match(promptSuggestionPrompt, /It may be multiple lines when a structured prompt is genuinely more useful/, "Hermes should retain the original structured-prompt flavor");
  assert.match(promptSuggestionPrompt, /Recent chat context:\n\[user\] Repair contextual prompt suggestions\./, "Hermes should receive the restored bounded recent context in the original prompt shape");
  assert.doesNotMatch(promptSuggestionPrompt, /public-suggestion-packet|localSuggestion|stateCategory/, "v5 flavor-shaping packet instructions should not reach Hermes");
  assert.equal(autoProbeCalls.length, 2, "a fresh prompt refinement probes authentication once before requesting the suggestion");
  for (const { options } of autoProbeCalls) {
    assert.equal(options.timeoutMs, 0, "neither authentication nor suggestion may inherit configured or requested deadlines");
    assert.equal(options.signal, autoProbeController.signal, "deadline-free work remains cancellable");
  }
  assert.equal(autoProbeAdapter.status().advisoryDraftAllowed, true);

  const backoffCwd = tmpFixture("pi-hermes-advisory-force-backoff-");
  const backoffAdapter = new HermesAdvisoryAdapter({ cwd: backoffCwd, run, bin: binary });
  assert.equal((await backoffAdapter.probeAuth()).ready, true);
  hermesReadiness.recordOutcome(backoffCwd, { bin: binary }, { operation: "prompt", outcome: "failed", category: "transport", durationMs: 1 });
  await assert.rejects(() => backoffAdapter.plan({ task: "Inspect public status" }), (error) => {
    assert.equal(error.code, "HERMES_ADVISORY_NOT_READY");
    assert.equal(error.reasonCode, "backoff-active");
    assert.equal(typeof error.retryAfter, "string");
    return true;
  });
  const backoffSuggestion = await backoffAdapter.promptSuggestion(promptPacket);
  assert.equal(backoffSuggestion.value, "Continue with the bounded verifier", "automatic suggestions reach Hermes despite shared readiness backoff");
  for (let index = 0; index < 2; index++) hermesReadiness.recordOutcome(backoffCwd, { bin: binary }, { operation: "prompt", outcome: "timed-out", category: "timeout", durationMs: 10000 });
  assert.equal(hermesReadiness.readinessStatus(backoffCwd, { bin: binary }).backoffActive, true);
  assert.equal((await backoffAdapter.request("promptSuggestion", promptPacket, { force: false, timeoutMs: 10 })).value, backoffSuggestion.value, "direct typed requests cannot restore timeout lockouts");
  const boundedCalls = [];
  const boundedAdapter = new HermesAdvisoryAdapter({ cwd: backoffCwd, bin: binary, run: async (args, options) => { boundedCalls.push(options); return run(args); } });
  await boundedAdapter.probeAuth({ timeoutMs: 1000 });
  await boundedAdapter.plan({ task: "Inspect public status" }, { timeoutMs: 1000 });
  assert.deepEqual(boundedCalls.map((options) => options.timeoutMs), [1000, 1000], "other operations keep their deadlines");

  // Exercise the real process client through the typed boundary, with both
  // auth and refinement slower than the old requested/configured deadline.
  const slowCwd = tmpFixture("pi-hermes-slow-suggestion-");
  const slowBinary = path.join(slowCwd, "hermes");
  fs.writeFileSync(slowBinary, `#!/usr/bin/env node\nsetTimeout(() => console.log(process.argv.includes("Reply with exactly HERMES_ADVISORY_AUTH_OK.") ? "HERMES_ADVISORY_AUTH_OK" : "Inspect the next unfinished task"), 1100);\n`);
  fs.chmodSync(slowBinary, 0o755);
  const slowAdapter = new HermesAdvisoryAdapter({ cwd: slowCwd, bin: slowBinary, policy: { promptTimeoutMs: 1000, authProbeTimeoutMs: 1000 } });
  assert.equal((await slowAdapter.promptSuggestion(promptPacket, { probeAuth: true, timeoutMs: 1000 })).value, "Inspect the next unfinished task");
  const noProofAdapter = new HermesAdvisoryAdapter({ cwd: tmpFixture("pi-hermes-no-proof-"), bin: binary, run });
  await assert.rejects(() => noProofAdapter.promptSuggestion(promptPacket), (error) => error.reasonCode === "authentication-proof-missing");
  await assert.rejects(() => slowAdapter.promptSuggestion({ ...promptPacket, publicRecentContext: "Inspect /home/example/private/path" }), (error) => error.code === "HERMES_ADVISORY_INPUT_UNSAFE");

  const adapter = new HermesAdvisoryAdapter({ cwd, storage: new FileIntegrationStorage(path.join(cwd, ".pi", "hermes-advisory")), run, bin: binary, authority: { canonicalPromotionAllowed: false } });
  assert.equal(adapter.localReadiness().executable.ready, true);
  assert.equal((await adapter.probeAuth()).ready, true);
  assert.equal((await adapter.probeCuration()).ready, true);
  assert.equal(await adapter.version(), "fake-hermes 1.0");

  const plan = await adapter.plan({ task: "Audit public integration status", evidenceRefs: ["status"] });
  assert.equal(plan.value.steps[0].id, "inspect");
  const review = await adapter.review({ claimRefs: ["claim-1"], evidenceRefs: ["evidence-1"] });
  assert.equal(review.value.verdict, "concerns");
  const evidence = await adapter.summarizeEvidence({ evidenceRefs: ["evidence-1"] });
  assert.deepEqual(evidence.value.unsupported, ["field efficacy"]);
  const decision = await adapter.decide({ goalId: "goal-1", goal: "Inspect status", iteration: 0, recentActions: [], completionEvidenceIds: [] }, { validate: (value) => { assert.equal(value.schemaVersion, 3); return value; } });
  assert.equal(decision.value.action.kind, "inspect");
  assert.match(decision.value.action.prompt, /Hermes advisory status/);
  assert.match(goalControllerPrompt, /goal-decision schema-v3/);
  assert.match(goalControllerPrompt, /Pi will execute that prompt verbatim/);
  assert.match(goalControllerPrompt, /do not use placeholders or rely on harness-generated instructions/);
  assert.match(goalControllerPrompt, /executionContext identifies the target current project/);
  assert.match(goalControllerPrompt, /Do not ask the user for the repository path/);
  assert.match(goalControllerPrompt, /resource or thermal observations/);
  goalControllerMode = "redundant-project-question";
  const repairedDecision = await adapter.decide({ goalId: "goal-2", goal: "Implement terrain", iteration: 0, executionContext: { workspaceRef: "current-project", currentProjectAvailable: true }, recentActions: [], completionEvidenceIds: [] }, { validate: (value) => { if (value.action?.kind === "ask_user") { const error = new Error("ask_user cannot request the current project/repository path; inspect it instead"); error.code = "GOAL_DECISION_INSPECTABLE_USER_INPUT"; throw error; } return value; } });
  assert.equal(repairedDecision.value.action.kind, "inspect");
  assert.equal(repairedDecision.receipt.repairTurns, 1);
  assert.match(goalControllerRepairPrompt, /GOAL_DECISION_INSPECTABLE_USER_INPUT/);
  assert.match(goalControllerRepairPrompt, /errorMessage.*current project\/repository path/);
  const suggestion = await adapter.promptSuggestion(promptPacket);
  assert.equal(suggestion.value, "Continue with the bounded verifier");
  const curation = await adapter.curateCandidate({ projectKey: "pi:fixture:abc", topic: "authority", sources: [{ noteRef: "Decisions.md", contentHash: "sha256:source", excerpt: "Obsidian project notes remain canonical." }] });
  assert.equal(curation.value.candidates[0].verification, "unverified");
  assert.deepEqual(curation.value.candidates[0].sourceHashes, ["sha256:source"]);
  const draft = await adapter.draftSkillCandidate({ captureIds: ["cap-1", "cap-2", "cap-3"], independentSessions: 2, workflowSteps: ["Inspect", "Verify"], toolNames: ["read", "test_runner"], evidenceRefs: ["evidence-1"] });
  assert.equal(draft.value.name, "verified-workflow");
  assert.equal(validateSkillDraft(draft.value).name, "verified-workflow");

  malformedPlan = true;
  const repaired = await adapter.plan({ task: "Repair typed output", evidenceRefs: [] });
  assert.equal(repaired.receipt.repairTurns, 1);
  await assert.rejects(() => adapter.plan({ task: `Inspect /home/example/private/path`, evidenceRefs: [] }), (error) => error.code === "HERMES_ADVISORY_INPUT_UNSAFE");
  await assert.rejects(() => adapter.review({ evidence: [{ role: "assistant", content: "private transcript body that must not be sent to Hermes" }] }), (error) => error.code === "HERMES_ADVISORY_INPUT_UNSAFE");
  await assert.rejects(() => adapter.plan({ task: "Run verification", commandArgs: ["--secret=value"] }), (error) => error.code === "HERMES_ADVISORY_INPUT_UNSAFE" && error.reasons.includes("forbidden-provider-field"));
  const timeoutCwd = tmpFixture("pi-hermes-advisory-timeout-retry-after-");
  const timeoutPolicy = { failureBackoffMs: 5000 };
  hermesReadiness.recordOutcome(timeoutCwd, { bin: binary, policy: timeoutPolicy }, { operation: "prompt", outcome: "timed-out", category: "timeout", durationMs: 10000 });
  const timeoutAdapter = new HermesAdvisoryAdapter({ cwd: timeoutCwd, bin: binary, policy: timeoutPolicy, run: async () => { throw new Error("provider deadline timeout"); } });
  const timeoutStartedAt = Date.now();
  await assert.rejects(
    () => timeoutAdapter.decide({ goalId: "goal-timeout", goal: "Inspect bounded state", iteration: 1, recentActions: [], completionEvidenceIds: [] }, { requireAuthProof: false }),
    (error) => {
      assert.equal(error.category, "timeout");
      assert.equal(typeof error.retryAfter, "string", "a repeated timeout exposes the readiness retry deadline to its consumer");
      assert(Date.parse(error.retryAfter) >= timeoutStartedAt + 4500);
      return true;
    },
  );
  const failing = new HermesAdvisoryAdapter({ cwd, bin: binary, run: async () => { throw Object.assign(new Error("provider failed"), { stderr: "RAW_PROVIDER_SECRET" }); } });
  await assert.rejects(() => failing.plan({ task: "Inspect bounded state" }), (error) => !error.stderr && !/RAW_PROVIDER_SECRET/.test(error.message));

  assert.throws(() => adapter.recordAcceptance({ receiptId: "unknown-receipt", accepted: true }), /does not identify/);
  assert.throws(() => adapter.recordCurationReview({ receiptId: plan.receipt.receiptId, decision: "accept" }), /does not identify/);
  adapter.recordAcceptance({ receiptId: plan.receipt.receiptId, accepted: true, sessionHash: "session-1" });
  adapter.recordCurationReview({ receiptId: curation.receipt.receiptId, decision: "accept", sessionHash: "session-1" });
  const status = adapter.status();
  assert.equal(status.providerReady, true);
  assert.equal(status.canonicalPromotionAllowed, false);
  assert.equal(status.automaticMutationAllowed, false);
  assert.equal(status.metrics.privacyViolations, 3, "blocked provider packets are counted without persisting their content");
  assert(status.metrics.succeeded >= 7);
  assert.equal(adapter.events({ limit: 100 }).every((event) => !("prompt" in event) && !("output" in event)), true);

  console.log("hermes advisory tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
