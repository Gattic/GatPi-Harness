"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROUTER_CLASSIFIER_VERSION,
  ROUTER_SUGGESTION_MIN_CONFIDENCE,
  ROUTER_INTENTS,
  ROUTER_MODES,
  SAFE_WORKER_ROLE_ID,
  SAFE_WORKER_REASON_CODE,
  WORKER_SHADOW_CANARY_TOPOLOGY_ID,
  WORKER_SHADOW_CANARY_MODEL,
  WORKER_SHADOW_CANARY_THINKING_LEVEL,
  safeWorkerRecommendation,
  buildWorkerShadowCanaryTopology,
  authorizeWorkerShadowCanary,
  normalizeRouterMode,
  classifyRoleIntent,
  decideRoleRoute,
  compactRouterDecision,
  evaluateRouterCorpus,
} = require("../src/role-router");

assert.match(ROUTER_CLASSIFIER_VERSION, /^role-router-v\d+$/);
assert.equal(ROUTER_SUGGESTION_MIN_CONFIDENCE, 0.8);
assert.deepEqual(ROUTER_MODES, ["off", "suggest", "shadow", "delegate"]);
assert.deepEqual(ROUTER_INTENTS, ["answer", "research", "plan", "review", "implement", "verify", "publish", "destructive", "no-route"]);
assert.deepEqual(normalizeRouterMode("run"), { mode: "shadow", legacy: true, warning: "Legacy run mode maps to read-only shadow mode; choose delegate explicitly for owned execution." });
assert.equal(normalizeRouterMode("delegate").mode, "delegate");

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "role-router-corpus.json"), "utf8"));
assert(corpus.length >= 45, "the reviewed synthetic/redacted corpus remains at least as large as the 45 audited suggestions");
const quality = evaluateRouterCorpus(corpus);
assert(quality.precision >= 0.90, `classifier precision ${quality.precision} must meet the 90% gate`);
assert.equal(quality.optOutViolations, 0);
assert.equal(quality.forbiddenAutomaticExecutions, 0);
assert.equal(quality.questionMutationRoutes, 0);
assert.equal(quality.implementationIncapableRoutes, 0);

const question = classifyRoleIntent("What changed in the dependency update?");
assert.equal(question.intent, "answer");
assert.equal(question.mutationRequested, false);
assert.equal(Object.hasOwn(question, "prompt"), false, "classification packets never retain prompt text");
const reviewFix = classifyRoleIntent("Review and fix the security token race");
assert.equal(reviewFix.intent, "implement", "requested actions outrank security/review nouns");
assert.equal(reviewFix.mutationRequested, true);
const pastedAutoRoleWarning = `Also note in this session I received this output, investigate it (I didnt restart pi yet during this session):
Warning: Auto roles failed: run=toprun_bf15d26bb725 topology=auto-performance-regression status=failed durationMs=213492 nodes=4 errors=2 mode=sequential concurrency=1 failure=fail-fast partial=forbid aggregation=last
✓ profile role=researcher status=succeeded durationMs=93485 evidence=7
✗ plan role=planner status=timed-out durationMs=120004 evidence=0 inputs=1/1 reason=AGENT_TIMEOUT
○ optimize role=coder status=blocked durationMs=0 evidence=0 reason=fail-fast
○ compare role=verifier status=blocked durationMs=0 evidence=0 reason=fail-fast
error plan: agent timeout exceeded (120000ms)
error : agent timeout exceeded (120000ms)`;
const pastedWarningClassification = classifyRoleIntent(pastedAutoRoleWarning);
assert.equal(pastedWarningClassification.intent, "research", "pasted auto-role node labels do not become user implementation intent");
assert.equal(pastedWarningClassification.mutationRequested, false);
const optedOut = classifyRoleIntent("Do not use auto roles; implement the fix");
assert.equal(optedOut.intent, "no-route");
assert.equal(optedOut.reasonCode, "explicit-opt-out");
const publish = classifyRoleIntent("Commit and push the release");
assert.equal(publish.automaticAllowed, false);

const availableTopologies = ["planning-advisory", "reviewer-verifier-gate", "planner-coder-verifier", "research-advisory"];
const pastedWarningRoute = decideRoleRoute(pastedAutoRoleWarning, { mode: "delegate", availableTopologies: [...availableTopologies, "performance-regression"] });
assert.equal(pastedWarningRoute.topologyId, "research-advisory");
assert.equal(pastedWarningRoute.mutationAuthority, false);
assert.equal(pastedWarningRoute.reasonCode, "research-action");
const requestedDiagnosticFix = decideRoleRoute(`Fix the router bug shown here:\n${pastedAutoRoleWarning.split("\n").slice(1).join("\n")}`, { mode: "delegate", availableTopologies: [...availableTopologies, "performance-regression"] });
assert.equal(requestedDiagnosticFix.intent, "implement", "an explicit repair request remains implementation intent");
assert.equal(requestedDiagnosticFix.topologyId, "planner-coder-verifier", "pasted performance labels do not select a performance topology");
const selfHostingRuntimeFix = decideRoleRoute("Investigate the remaining coder noncompletion in planner-and-coder-role-runtime, reproduce it, add a regression test, and implement the fix.", { mode: "delegate", availableTopologies });
assert.equal(selfHostingRuntimeFix.intent, "implement", "the parent retains mutation ownership for a requested runtime fix");
assert.equal(selfHostingRuntimeFix.reasonCode, "self-hosting-role-runtime-investigation");
assert.equal(selfHostingRuntimeFix.automaticAllowed, false, "the runtime under investigation cannot automatically delegate its own repair");
assert.equal(selfHostingRuntimeFix.execute, false);
assert.equal(selfHostingRuntimeFix.topologyId, null);
assert.equal(selfHostingRuntimeFix.mutationAuthority, false);
const ordinaryCoderFix = decideRoleRoute("Fix coder completion in the checkout application", { mode: "delegate", availableTopologies });
assert.equal(ordinaryCoderFix.execute, true, "application code mentioning a coder is not mistaken for role-runtime self-repair");
const ordinaryTopologyFix = decideRoleRoute("Fix the network topology regression in the checkout application", { mode: "delegate", availableTopologies });
assert.equal(ordinaryTopologyFix.execute, true, "application topology work is not mistaken for role-runtime self-repair");
const off = decideRoleRoute("Implement the parser", { mode: "off", availableTopologies });
assert.equal(off.classified, false);
assert.equal(off.execute, false);
const suggested = decideRoleRoute("Implement the parser", { mode: "suggest", availableTopologies });
assert.equal(suggested.execute, false);
assert.equal(suggested.topologyId, "planner-coder-verifier");
const docsSuggestion = decideRoleRoute("Update the runtime documentation", { mode: "suggest", availableTopologies: [...availableTopologies, "docs-update"] });
assert.equal(docsSuggestion.intent, "implement");
assert.equal(docsSuggestion.topologyId, "docs-update", "action classification remains implement while the documentation noun selects a capable recipe");
const securitySuggestion = decideRoleRoute("Review token handling for injection risks", { mode: "suggest", availableTopologies: [...availableTopologies, "security-review"] });
assert.equal(securitySuggestion.intent, "review");
assert.equal(securitySuggestion.topologyId, "security-review");
const shadow = decideRoleRoute("Implement the parser", { mode: "shadow", availableTopologies });
assert.equal(shadow.execute, true);
assert.equal(shadow.topologyId, "planning-advisory");
assert.equal(shadow.advisoryOnly, true);
assert.equal(shadow.incompleteMutation, true);
assert.equal(shadow.mutationAuthority, false);
const implicitDelegate = decideRoleRoute("Implement the parser", { mode: "delegate", availableTopologies });
assert.equal(implicitDelegate.execute, true, "delegate mode follows through from an ordinary matched prompt");
assert.equal(implicitDelegate.automaticExecutionAllowed, true);
assert.equal(implicitDelegate.reasonCode, "implementation-action");
const explicitDelegate = decideRoleRoute("Implement the parser", { mode: "delegate", explicitInvocation: true, availableTopologies });
assert.equal(explicitDelegate.execute, true);
assert.equal(explicitDelegate.topologyId, "planner-coder-verifier");
assert.equal(explicitDelegate.mutationAuthority, true);
const lowConfidence = decideRoleRoute("Handle this task", { mode: "suggest", force: true, availableTopologies });
assert.equal(lowConfidence.execute, false);
assert.equal(lowConfidence.topologyId, null);
assert.equal(lowConfidence.reasonCode, "below-relevance-threshold", "low-confidence suggestions are suppressed rather than injected");
const forbidden = decideRoleRoute("Publish the package", { mode: "delegate", explicitInvocation: true, availableTopologies });
assert.equal(forbidden.execute, false);
assert.equal(forbidden.automaticAllowed, false);

const safeWorkerPrompt = "Read only config/harness-defaults.env and report the exact PI_ROLE_MUTATION value; do not edit files.";
const safeWorkerClassification = classifyRoleIntent(safeWorkerPrompt);
assert.equal(safeWorkerClassification.intent, "research");
assert.deepEqual(safeWorkerRecommendation(safeWorkerPrompt, safeWorkerClassification), {
  recommendationKind: "role",
  recommendedRoleId: SAFE_WORKER_ROLE_ID,
  recommendationReasonCode: SAFE_WORKER_REASON_CODE,
  automaticExecutionAllowed: false,
});
const workerSuggestion = decideRoleRoute(safeWorkerPrompt, { mode: "suggest", availableTopologies });
assert.equal(workerSuggestion.recommendedRoleId, "worker");
assert.equal(workerSuggestion.reasonCode, "bounded-readonly-worker-task");
assert.equal(workerSuggestion.topologyId, null, "safe worker recommendations do not silently substitute a topology");
assert.equal(workerSuggestion.execute, false);
assert.equal(workerSuggestion.mutationAuthority, false);
assert.equal(workerSuggestion.automaticExecutionAllowed, false);
const canaryCandidate = {
  ...workerSuggestion,
  matched: true,
  task: safeWorkerPrompt,
  recommendedModel: WORKER_SHADOW_CANARY_MODEL,
  recommendedThinkingLevel: WORKER_SHADOW_CANARY_THINKING_LEVEL,
  workspacePolicy: "shared-readonly",
  mutationPolicy: "forbidden",
  roleRecommendation: { roleId: "worker", autoRoutePolicy: "suggest", execute: false, advisoryOnly: true },
};
const canaryControls = { enabled: true, childSession: false, hasUI: true, effectiveStage: "R0", fieldPilotEnabled: true, runtimeV2Available: true, mutationMode: "off", sidecarEnabled: true };
const workerShadowTopology = buildWorkerShadowCanaryTopology();
assert.equal(workerShadowTopology.topologyId, WORKER_SHADOW_CANARY_TOPOLOGY_ID);
assert.deepEqual(workerShadowTopology.nodes, [{ id: "worker", roleId: "worker", task: "Complete this bounded read-only lookup exactly as scoped: {{task}}", contextPolicy: "task-only", executionMode: "subagent" }]);
assert.deepEqual(workerShadowTopology.metadata, { explicitOnly: true, autoRoutePolicy: "never", publishCapable: false, workerShadowCanary: true });
assert.equal(workerShadowTopology.concurrencyLimit, 1);
const canaryAuthorization = authorizeWorkerShadowCanary(canaryCandidate, canaryControls);
assert.equal(WORKER_SHADOW_CANARY_MODEL, "local/DeepSeek-V4.1-Flash-1017");
assert.equal(WORKER_SHADOW_CANARY_THINKING_LEVEL, "low");
assert.equal(canaryAuthorization.authorized, true);
assert.equal(canaryAuthorization.decision.topologyId, WORKER_SHADOW_CANARY_TOPOLOGY_ID);
assert.equal(canaryAuthorization.decision.execute, true);
assert.equal(canaryAuthorization.decision.automaticExecutionAllowed, true);
assert.equal(canaryAuthorization.decision.workerShadowCanary, true);
for (const [override, reasonCode] of [
  [{ enabled: false }, "worker-shadow-canary-disabled"],
  [{ childSession: true }, "worker-shadow-canary-child-session"],
  [{ hasUI: false }, "worker-shadow-canary-headless"],
  [{ effectiveStage: "R1" }, "worker-shadow-canary-rollout-blocked"],
  [{ fieldPilotEnabled: false }, "worker-shadow-canary-rollout-blocked"],
  [{ runtimeV2Available: false }, "worker-shadow-canary-containment-blocked"],
  [{ mutationMode: "isolated" }, "worker-shadow-canary-containment-blocked"],
  [{ sidecarEnabled: false }, "worker-shadow-canary-containment-blocked"],
]) {
  assert.deepEqual(authorizeWorkerShadowCanary(canaryCandidate, { ...canaryControls, ...override }), { authorized: false, reasonCode, decision: canaryCandidate });
}
for (const model of ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"]) {
  assert.equal(authorizeWorkerShadowCanary({ ...canaryCandidate, recommendedModel: model }, canaryControls).reasonCode, "worker-shadow-canary-profile-mismatch");
}
assert.equal(authorizeWorkerShadowCanary({ ...canaryCandidate, recommendedThinkingLevel: "medium" }, canaryControls).reasonCode, "worker-shadow-canary-profile-mismatch");
assert.equal(authorizeWorkerShadowCanary({ ...canaryCandidate, mutationPolicy: "proposed-patch" }, canaryControls).reasonCode, "worker-shadow-canary-role-unsafe");
for (const task of [
  "Read only .env and report the exact value; do not edit files.",
  "Read only ~/.ssh/id_rsa and report its contents; do not edit files.",
  "Read only ~/.docker/config.json and report the exact auth value; do not edit files.",
  "Read only certs/server.pem and report its contents; do not edit files.",
  "Read only config/example.json and report line 4; do not edit files.",
]) assert.equal(authorizeWorkerShadowCanary({ ...canaryCandidate, task }, canaryControls).reasonCode, "worker-shadow-canary-sensitive-scope");
assert.equal(authorizeWorkerShadowCanary({ ...canaryCandidate, execute: true }, canaryControls).reasonCode, "worker-shadow-canary-task-unsafe");
const safeCheckSuggestion = decideRoleRoute("Check only config/harness-defaults.env for the exact PI_ROLE_MUTATION value; read-only, no file changes.", { mode: "suggest", availableTopologies });
assert.equal(safeCheckSuggestion.intent, "review");
assert.equal(safeCheckSuggestion.recommendedRoleId, "worker", "bounded checking is eligible despite the generic review intent");
for (const sensitivePrompt of [
  "Read only config/secrets.json and report the exact API key; do not edit files.",
  "Read only config/tokens.json and report the exact access token; do not edit files.",
  "Read only config/passwords.json and report the exact password; do not edit files.",
  "Report the exact token from the named auth fixture.",
  "Return the token from the named auth fixture.",
  "What is the exact API key in config/secrets.json?",
  "What is the API key in config/secrets.json?",
  "What is the token in the named auth fixture?",
  "Read the password from the named test account.",
  "Report the access token from config/oauth.json.",
  "Return the auth token from the named fixture.",
  "Show the personal access token from the account fixture.",
  "Display the seed phrase from the named wallet fixture.",
  "Report the current TOTP code from the test account.",
  "Show the raw SSH key from the named deployment file.",
  "Return the signing key from config/signing.json.",
  "Display the recovery code stored in the specific account fixture.",
  "Export the session cookie from the current browser fixture.",
  "Retrieve the bearer token from config/oauth.json.",
  "Print the passphrase from the named test account.",
]) {
  const sensitiveClassification = classifyRoleIntent(sensitivePrompt);
  assert.equal(sensitiveClassification.intent, "destructive");
  assert.equal(sensitiveClassification.reasonCode, "credential-operation");
  assert.equal(sensitiveClassification.automaticAllowed, false);
  for (const mode of ["suggest", "shadow"]) {
    const sensitiveDecision = decideRoleRoute(sensitivePrompt, { mode, availableTopologies });
    assert.equal(sensitiveDecision.recommendedRoleId, undefined, "credential extraction is never a role recommendation");
    assert.equal(sensitiveDecision.topologyId, null, "credential extraction never receives a topology");
    assert.equal(sensitiveDecision.execute, false);
    assert.equal(sensitiveDecision.automaticAllowed, false);
    assert.equal(sensitiveDecision.reasonCode, "credential-operation");
  }
}
const tokenCountSuggestion = decideRoleRoute("Read only metrics/tokens.json and report the exact token count; do not edit files.", { mode: "suggest", availableTopologies });
assert.equal(tokenCountSuggestion.recommendedRoleId, "worker", "non-credential token metrics remain eligible for bounded read-only work");
for (const discussionPrompt of [
  "Read only docs/password-policy.md and report the password policy behavior; do not edit files.",
  "Read only docs/api-keys.md and report API key usage; do not edit files.",
]) {
  const discussionClassification = classifyRoleIntent(discussionPrompt);
  assert.notEqual(discussionClassification.reasonCode, "credential-operation", "credential policy and usage discussions are not secret extraction");
  assert.equal(discussionClassification.automaticAllowed, true);
}
const workerRecommendationDisabled = decideRoleRoute(safeWorkerPrompt, { mode: "suggest", safeWorkerRecommendations: false, availableTopologies });
assert.equal(workerRecommendationDisabled.recommendedRoleId, undefined, "rollout gate can disable worker recommendations without enabling execution");
assert.equal(workerRecommendationDisabled.topologyId, "research-advisory");
const complexResearch = decideRoleRoute("Investigate why the parser stalls across the repository; read only and do not edit files.", { mode: "suggest", availableTopologies });
assert.equal(complexResearch.recommendedRoleId, undefined, "complex or broad research stays on the research topology");
assert.equal(complexResearch.topologyId, "research-advisory");
const workerShadow = decideRoleRoute(safeWorkerPrompt, { mode: "shadow", availableTopologies });
assert.equal(workerShadow.recommendedRoleId, undefined, "worker rollout is recommendation-only outside suggest mode");
assert.equal(workerShadow.topologyId, "research-advisory");

const compactWorker = compactRouterDecision({ ...workerSuggestion, matched: true, recommendedModel: "openai-codex/gpt-6-astra", recommendedThinkingLevel: "low", workspacePolicy: "shared-readonly", mutationPolicy: "forbidden" });
assert.equal(compactWorker.recommendedRoleId, "worker");
assert.equal(compactWorker.recommendedModel, "openai-codex/gpt-6-astra");
assert.equal(compactWorker.recommendedThinkingLevel, "low");
assert.equal(compactWorker.classified, true);
assert.equal(compactWorker.matched, true);
assert.equal(compactWorker.execute, false);
assert.equal(compactWorker.automaticExecutionAllowed, false);
assert.equal(compactWorker.workerShadowCanary, false);
assert.equal(JSON.stringify(compactWorker).includes(safeWorkerPrompt), false, "compact recommendations never retain prompt text");
const compactCanary = compactRouterDecision({ ...canaryAuthorization.decision, matched: true });
assert.equal(compactCanary.execute, true);
assert.equal(compactCanary.automaticExecutionAllowed, true);
assert.equal(compactCanary.workerShadowCanary, true);

const compact = compactRouterDecision(explicitDelegate, { outcomeLink: "toprun_123" });
assert.equal(compact.classifierVersion, ROUTER_CLASSIFIER_VERSION);
assert.equal(compact.intent, "implement");
assert.equal(compact.outcomeLink, "toprun_123");
assert.match(compact.promptHash, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(compact).includes("Implement the parser"), false);
assert.deepEqual(Object.keys(compact).sort(), ["automaticExecutionAllowed", "classified", "classifierVersion", "confidence", "execute", "intent", "matched", "mode", "mutationPolicy", "outcomeLink", "promptHash", "reasonCode", "recommendationKind", "recommendedModel", "recommendedRoleId", "recommendedThinkingLevel", "topologyId", "workerShadowCanary", "workspacePolicy"].sort());

console.log("role router tests passed");
