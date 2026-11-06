"use strict";

const crypto = require("node:crypto");
const { DEFAULT_DELEGATE_MODEL } = require("./role-contracts");

const ROUTER_CLASSIFIER_VERSION = "role-router-v6";
const ROUTER_SUGGESTION_MIN_CONFIDENCE = 0.8;
const SAFE_WORKER_ROLE_ID = "worker";
const SAFE_WORKER_REASON_CODE = "bounded-readonly-worker-task";
const WORKER_SHADOW_CANARY_TOPOLOGY_ID = "worker-shadow-canary";
const WORKER_SHADOW_CANARY_MODEL = DEFAULT_DELEGATE_MODEL;
const WORKER_SHADOW_CANARY_THINKING_LEVEL = "low";
const WORKER_SHADOW_CANARY_SENSITIVE_PATH = /(?:^|[\s"'`/\\])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|gcloud|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|kubeconfig|shadow|passwd|[^/\\\s]+\.(?:pem|key|p12|pfx|keystore|jks|tfstate))(?=$|[\s"'`/\\])/i;
const WORKER_SHADOW_CANARY_POSITIONAL_VALUE = /\b(?:line|row|field|entry|index|offset)\s*(?:number\s*)?#?\s*\d+\b/i;
const SENSITIVE_CREDENTIAL_TERM = /\b(?:credentials?|secrets?|api[- ]?keys?|access[- ]?tokens?|personal[- ]?access[- ]?tokens?|auth(?:entication|orization)?[- ]?tokens?|bearer[- ]?tokens?|refresh[- ]?tokens?|session[- ]?tokens?|id[- ]?tokens?|jwts?|passwords?|passphrases?|private[- ]?keys?|ssh[- ]?keys?|signing[- ]?keys?|encryption[- ]?keys?|service[- ]?account[- ]?keys?|deploy[- ]?keys?|recovery[- ]?codes?|backup[- ]?codes?|recovery[- ]?phrases?|seed[- ]?phrases?|mnemonics?|totp[- ]?codes?|mfa[- ]?codes?|2fa[- ]?codes?|one[- ]?time[- ]?(?:passwords?|codes?)|session[- ]?cookies?|session[- ]?ids?)\b/i;
const NON_SECRET_CREDENTIAL_CONTEXT = /\b(?:credentials?|secrets?|keys?|tokens?|passwords?|passphrases?|codes?|cookies?|ids?)\s+(?:polic(?:y|ies)|handling|usage|validation|formats?|rotation|storage|management|logic|flows?|parsers?|documentation|docs?|code|implementation|support|behaviou?r|tests?|testing|coverage|counts?|budgets?|limits?|lengths?)\b/i;
const GENERIC_TOKEN_EXTRACTION = /\b(?:(?:expose|print|export|show|display|reveal|return|retrieve|fetch|copy|dump|provide|give|list)\s+(?:the\s+)?(?:(?:exact|actual|current|raw|plaintext|full|complete)\s+)?tokens?|(?:read|report|find|locate|lookup|look\s+up|get|tell\s+me|what\s+(?:is|are)|which\s+(?:is|are))\s+(?:the\s+)?(?:(?:exact|actual|current|raw|plaintext|full|complete)\s+)?tokens?|tokens?\s+(?:values?|contents?))\b(?!\s+(?:polic(?:y|ies)|handling|usage|validation|formats?|rotation|storage|management|logic|flows?|parsers?|documentation|docs?|code|implementation|support|behaviou?r|tests?|testing|coverage|counts?|budgets?|limits?|lengths?))/i;
const ROUTER_INTENTS = Object.freeze(["answer", "research", "plan", "review", "implement", "verify", "publish", "destructive", "no-route"]);
const ROUTER_MODES = Object.freeze(["off", "suggest", "shadow", "delegate"]);
const LEGACY_RUN_WARNING = "Legacy run mode maps to read-only shadow mode; choose delegate explicitly for owned execution.";
const INTENT_TO_TOPOLOGY = Object.freeze({
  research: "research-advisory",
  plan: "planning-advisory",
  review: "reviewer-verifier-gate",
  implement: "planner-coder-verifier",
  verify: "reviewer-verifier-gate",
});
const SHADOW_TOPOLOGY = Object.freeze({
  research: "research-advisory",
  plan: "planning-advisory",
  review: "review-advisory",
  implement: "planning-advisory",
  verify: "review-advisory",
});

function hashPrompt(prompt) { return crypto.createHash("sha256").update(String(prompt || "")).digest("hex"); }
function stripAutoRoleDiagnosticOutput(raw) {
  let inReport = false;
  const kept = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (/^\s*(?:warning:\s*)?auto roles\b.*\brun=toprun_[a-z0-9]+\b/i.test(line)) { inReport = true; continue; }
    if (inReport && (/^\s*[✓✗○◐↷•]\s+\S+\s+role=\S+\s+status=/u.test(line) || /^\s*error(?:\s+\S*)?\s*:/i.test(line))) continue;
    inReport = false;
    kept.push(line);
  }
  return kept.join("\n");
}
function containsSensitiveCredential(raw) {
  const text = String(raw || "");
  return SENSITIVE_CREDENTIAL_TERM.test(text) || GENERIC_TOKEN_EXTRACTION.test(text);
}
function credentialOperationRequested(raw) {
  const text = String(raw || "");
  if (!containsSensitiveCredential(text)) return false;
  const managementAction = /\b(?:rotate|replace|revoke)\b/i.test(text);
  const directExtractionAction = /\b(?:expose|print|export|show|display|reveal|return|retrieve|fetch|copy|dump|provide|give|list)\b/i.test(text) && !NON_SECRET_CREDENTIAL_CONTEXT.test(text);
  const qualifiedExtractionAction = /\b(?:read|report|find|locate|lookup|look\s+up|get|tell\s+me|what\s+(?:is|are)|which\s+(?:is|are))\b/i.test(text) && !NON_SECRET_CREDENTIAL_CONTEXT.test(text);
  return managementAction || directExtractionAction || qualifiedExtractionAction;
}
function selfHostingRoleRuntimeInvestigation(raw) {
  const text = String(raw || "");
  const runtimeBoundary = /\b(?:role[- ]?runtime|role[- ]?sidecar|auto[- ]?roles?|subagents?|submit_role_result|planner[- ]coder(?:[- ]verifier)?|planner-and-coder-role-runtime|(?:role|agent|auto[- ]?route|reasoning)[- ]topolog(?:y|ies))\b/i.test(text);
  const failureInvestigation = /\b(?:bugs?|debug|diagnos(?:e|is|tic)?|fail(?:ed|ing|ure|ures)?|non[- ]?completion|regressions?|reproduc(?:e|tion|ible)?|root\s+causes?|timeouts?|empty[- ]patch|budget[- _]?model[- _]?calls|fix|repair|remediat(?:e|ion))\b/i.test(text);
  return runtimeBoundary && failureInvestigation;
}
function normalizeRouterMode(raw) {
  const value = String(raw || "off").trim().toLowerCase();
  if (["run", "execute", "full", "auto", "on", "on-run", "1", "true"].includes(value)) return { mode: "shadow", legacy: true, warning: LEGACY_RUN_WARNING };
  if (["suggest", "suggestion", "preview", "dry-run", "dryrun"].includes(value)) return { mode: "suggest", legacy: false, warning: null };
  if (["shadow", "evaluate", "evaluation"].includes(value)) return { mode: "shadow", legacy: false, warning: null };
  if (["delegate", "delegated", "explicit"].includes(value)) return { mode: "delegate", legacy: false, warning: null };
  return { mode: "off", legacy: false, warning: null };
}
function result(prompt, intent, reasonCode, confidence, extra = {}) {
  const mutationRequested = intent === "implement";
  const automaticAllowed = !["publish", "destructive", "no-route"].includes(intent);
  return {
    classifierVersion: ROUTER_CLASSIFIER_VERSION,
    intent,
    reasonCode,
    confidence,
    promptHash: hashPrompt(prompt),
    mutationRequested,
    automaticAllowed,
    questionOnly: false,
    optOut: false,
    ...extra,
  };
}
function isQuestionOnly(raw, normalized) {
  if (!raw) return false;
  if (/^(?:would|could)\s+you\s+(?:implement|build|add|change|modify|edit|fix|repair|refactor|update|harden|commit|push|publish|deploy|install|delete|drop|destroy|wipe|rotate|replace|revoke)\b/i.test(raw)) return false;
  if (/^(?:what|why|when|where|who|which|how|is|are|was|were|does|do|did|should|would)\b/i.test(raw)) return true;
  if (/^(?:can|could|would)\s+you\s+(?:explain|describe|summari[sz]e|tell)\b/i.test(raw)) return true;
  if (/^could\b/i.test(raw) && !/^could\s+you\s+(?:implement|build|add|change|modify|edit|fix|repair|refactor|update|harden)\b/i.test(raw)) return true;
  if (/\b(?:explain|describe)\b/.test(normalized) && !/\b(?:implement|fix|repair|add|build|modify|edit|refactor|optimi[sz]e)\b/.test(normalized)) return true;
  return false;
}
function classifyRoleIntent(prompt, options = {}) {
  const raw = String(prompt || "").trim();
  const actionText = stripAutoRoleDiagnosticOutput(raw).trim();
  const q = actionText.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  if (!raw) return result(raw, "no-route", "empty-prompt", 1);
  if (/^[!/]/.test(actionText)) return result(raw, "no-route", "explicit-command", 1);
  if (/\b(?:do\s+not|don't|skip|disable|without|no)\s+(?:use\s+)?(?:auto[- ]?(?:roles?|route|routing)|topolog(?:y|ies)|subagents?)\b/i.test(actionText)) return result(raw, "no-route", "explicit-opt-out", 1, { optOut: true });
  const questionOnly = isQuestionOnly(actionText, q);
  const destructive = /\b(?:rm\s+-rf|delete|drop|destroy|wipe|erase|hard\s+reset|discard\s+(?:local\s+)?changes?|force[- ]?reset|overwrite\s+history)\b/i.test(actionText);
  const credentialAction = credentialOperationRequested(actionText);
  if (destructive || credentialAction) return result(raw, "destructive", credentialAction ? "credential-operation" : "destructive-operation", 0.99);
  if (questionOnly) return result(raw, "answer", "question-only", 0.96, { questionOnly: true });

  const publish = /\b(?:commit|push|publish|deploy|ship\s+(?:the\s+)?release|cut\s+(?:and\s+)?release|release\s+version|tag\s+(?:the\s+)?release|install\s+(?:the\s+)?package|package\s+install)\b/i.test(actionText);
  if (publish) return result(raw, "publish", /install/i.test(actionText) ? "package-install" : "publish-operation", 0.99);

  const affirmativeActionText = actionText.replace(/\b(?:do\s+not|don't)\s+(?:edit|modify|change|write|implement|build|fix|repair|refactor|remove)\b/gi, "").replace(/\bwithout\s+(?:making\s+)?changes?\b/gi, "");
  const implementation = /\b(?:implement|build|add|change|modify|edit|fix|repair|refactor|optimise|optimize|wire|integrate|producti[sz]e|update|make\s+(?:the\s+)?(?:failing\s+)?tests?\s+pass|harden|rewrite|remove|create)\b/i.test(affirmativeActionText);
  const planOnly = /\b(?:plan|design|propose|outline|strategy|rollout|migration)\b/i.test(actionText) && /\b(?:only|without\s+(?:making\s+)?changes?|do\s+not\s+edit|don't\s+edit)\b/i.test(actionText);
  if (selfHostingRoleRuntimeInvestigation(actionText)) return result(raw, implementation && !planOnly ? "implement" : "research", "self-hosting-role-runtime-investigation", 0.99, { automaticAllowed: false });
  if (implementation && !planOnly) return result(raw, "implement", "implementation-action", 0.92);

  if (/\b(?:plan|design|propose|outline|strategy|rollout|migration)\b/i.test(actionText)) return result(raw, "plan", "planning-action", 0.86);
  if (/\b(?:verify|validate|run\s+(?:the\s+)?(?:focused\s+|full\s+)?tests?|test\s+(?:the|this)|check\s+(?:that|whether))\b/i.test(actionText)) return result(raw, "verify", "verification-action", 0.88);
  if (/\b(?:review|audit|inspect|check)\b/i.test(actionText)) return result(raw, "review", "review-action", 0.84);
  if (/\b(?:research|investigate|debug|diagnose|triage|explore|find|trace|locate|map|lookup|look\s+up|report|read|list)\b/i.test(actionText)) return result(raw, "research", "research-action", 0.82);
  if (/\b(?:explain|describe|summari[sz]e|answer)\b/i.test(actionText)) return result(raw, "answer", "answer-action", 0.8);
  if (options.force === true) return result(raw, "research", "forced-readonly-classification", 0.5);
  return result(raw, "no-route", "no-action-match", 0.9);
}
function topologyHintFor(intent, prompt) {
  const raw = stripAutoRoleDiagnosticOutput(prompt);
  if (intent === "implement") {
    if (/\b(?:docs?|documentation|readme|guide|manual)\b/i.test(raw)) return "docs-update";
    if (/\b(?:refactor|cleanup|restructure|deduplicate)\b/i.test(raw)) return "refactor-with-safety-net";
    if (/\b(?:dependency|dependencies|lockfile|package upgrade)\b/i.test(raw)) return "dependency-upgrade";
    if (/\b(?:performance|latency|benchmark|hot path|slow)\b/i.test(raw)) return "performance-regression";
  }
  if (intent === "review" && /\b(?:security|auth|permission|injection|vulnerabilit|secret|credential|token)\b/i.test(raw)) return "security-review";
  if (["research", "review", "plan", "verify"].includes(intent) && /\b(?:ci|workflow|pipeline|test failure|failing test)\b/i.test(raw)) return "failing-ci-triage";
  if (intent === "plan" && /\brelease\b/i.test(raw)) return "release-prep";
  return null;
}
function safeWorkerRecommendation(prompt, classification = {}) {
  const raw = String(prompt || "").trim();
  if (!["research", "review"].includes(classification.intent) || classification.mutationRequested || classification.automaticAllowed === false) return null;
  const explicitlyReadOnly = /\b(?:read[- ]only|do\s+not\s+(?:edit|modify|change|write)|don't\s+(?:edit|modify|change|write)|without\s+(?:making\s+)?changes?|no\s+(?:file\s+)?changes?)\b/i.test(raw);
  const boundedScope = /\b(?:bounded|exact|single|specific|named|only|one)\b/i.test(raw) || /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+(?:\.[\w.-]+)?(?:\s|$)/.test(raw);
  const lookupAction = /\b(?:find|locate|lookup|look\s+up|report|read|list|inspect|check)\b/i.test(raw);
  const complexOrBroad = /\b(?:all|every|entire|whole|across|recursive|recursively|investigate|debug|diagnose|triage|root\s+cause|review|audit|security|correctness|regression|compare|design|plan|implement|fix|repair|refactor|verify|benchmark|performance|architecture)\b/i.test(raw);
  const sensitiveCredential = containsSensitiveCredential(raw);
  if (!explicitlyReadOnly || !boundedScope || !lookupAction || complexOrBroad || sensitiveCredential) return null;
  return {
    recommendationKind: "role",
    recommendedRoleId: SAFE_WORKER_ROLE_ID,
    recommendationReasonCode: SAFE_WORKER_REASON_CODE,
    automaticExecutionAllowed: false,
  };
}
function workerShadowCanaryScopeSafe(task) {
  const text = String(task || "").trim();
  return Boolean(text) && !WORKER_SHADOW_CANARY_SENSITIVE_PATH.test(text) && !WORKER_SHADOW_CANARY_POSITIONAL_VALUE.test(text);
}
function buildWorkerShadowCanaryTopology() {
  return {
    topologyId: WORKER_SHADOW_CANARY_TOPOLOGY_ID,
    name: "Worker Shadow Canary",
    description: "One bounded read-only DeepSeek-V4.1-Flash/low worker whose result remains separate from the parent turn.",
    nodes: [{ id: "worker", roleId: SAFE_WORKER_ROLE_ID, task: "Complete this bounded read-only lookup exactly as scoped: {{task}}", contextPolicy: "task-only", executionMode: "subagent" }],
    edges: [],
    terminalNodes: ["worker"],
    concurrencyLimit: 1,
    failurePolicy: "fail-fast",
    aggregationPolicy: "terminal",
    partialPolicy: "forbid",
    memoryPolicy: "none",
    metadata: { explicitOnly: true, autoRoutePolicy: "never", publishCapable: false, workerShadowCanary: true },
    tags: ["worker", "read-only", "shadow-canary"],
  };
}
function authorizeWorkerShadowCanary(decision = {}, controls = {}) {
  const reject = (reasonCode) => ({ authorized: false, reasonCode, decision });
  if (controls.enabled !== true) return reject("worker-shadow-canary-disabled");
  if (controls.childSession === true) return reject("worker-shadow-canary-child-session");
  if (controls.hasUI !== true) return reject("worker-shadow-canary-headless");
  if (controls.effectiveStage !== "R0" || controls.fieldPilotEnabled !== true) return reject("worker-shadow-canary-rollout-blocked");
  if (controls.runtimeV2Available !== true || controls.mutationMode !== "off" || controls.sidecarEnabled !== true) return reject("worker-shadow-canary-containment-blocked");
  if (decision.mode !== "suggest" || decision.classified !== true || decision.matched !== true) return reject("worker-shadow-canary-mode-blocked");
  if (decision.reasonCode !== SAFE_WORKER_REASON_CODE || decision.recommendationKind !== "role" || decision.recommendedRoleId !== SAFE_WORKER_ROLE_ID) return reject("worker-shadow-canary-task-ineligible");
  if (!workerShadowCanaryScopeSafe(decision.task)) return reject("worker-shadow-canary-sensitive-scope");
  if (decision.execute !== false || decision.topologyId != null || decision.automaticExecutionAllowed !== false || decision.advisoryOnly !== true || decision.explicitInvocation === true || decision.automaticAllowed !== true || decision.mutationRequested === true || decision.mutationAuthority === true) return reject("worker-shadow-canary-task-unsafe");
  if (decision.recommendedModel !== WORKER_SHADOW_CANARY_MODEL || decision.recommendedThinkingLevel !== WORKER_SHADOW_CANARY_THINKING_LEVEL) return reject("worker-shadow-canary-profile-mismatch");
  if (decision.workspacePolicy !== "shared-readonly" || decision.mutationPolicy !== "forbidden" || decision.roleRecommendation?.roleId !== SAFE_WORKER_ROLE_ID || decision.roleRecommendation?.autoRoutePolicy !== "suggest" || decision.roleRecommendation?.execute !== false || decision.roleRecommendation?.advisoryOnly !== true) return reject("worker-shadow-canary-role-unsafe");
  return {
    authorized: true,
    reasonCode: "worker-shadow-canary-authorized",
    decision: {
      ...decision,
      topologyId: WORKER_SHADOW_CANARY_TOPOLOGY_ID,
      baseTopologyId: WORKER_SHADOW_CANARY_TOPOLOGY_ID,
      execute: true,
      automaticExecutionAllowed: true,
      advisoryOnly: true,
      mutationAuthority: false,
      workerShadowCanary: true,
      workerShadowCanaryReasonCode: "worker-shadow-canary-authorized",
    },
  };
}
function available(topologyId, choices) { return !Array.isArray(choices) || choices.length === 0 || choices.includes(topologyId); }
function pickTopology(intent, mode, choices, requested, hint) {
  const preferred = mode === "shadow" ? SHADOW_TOPOLOGY[intent] : ((requested && intent === "implement") ? requested : hint || INTENT_TO_TOPOLOGY[intent]);
  if (preferred && available(preferred, choices)) return preferred;
  const fallbacks = mode === "shadow" ? ["research-advisory", "planning-advisory", "reviewer-verifier-gate"] : ["planner-coder-verifier", "reviewer-verifier-gate", "planning-advisory", "research-advisory"];
  return fallbacks.find((id) => available(id, choices)) || null;
}
function decideRoleRoute(prompt, options = {}) {
  const normalized = normalizeRouterMode(options.mode);
  const mode = normalized.mode;
  if (mode === "off") return { classifierVersion: ROUTER_CLASSIFIER_VERSION, mode, classified: false, execute: false, reasonCode: "mode-off", legacyModeWarning: normalized.warning };
  const classification = classifyRoleIntent(prompt, options);
  classification.topologyHint = topologyHintFor(classification.intent, prompt);
  const base = { ...classification, mode, classified: true, execute: false, topologyId: null, mutationAuthority: false, advisoryOnly: mode !== "delegate", incompleteMutation: false, automaticExecutionAllowed: false, explicitInvocation: options.explicitInvocation === true, legacyModeWarning: normalized.warning };
  if (!classification.automaticAllowed) return base;
  const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : ROUTER_SUGGESTION_MIN_CONFIDENCE;
  if (classification.confidence < minConfidence) return { ...base, reasonCode: "below-relevance-threshold", relevanceThreshold: minConfidence };
  const workerRecommendation = mode === "suggest" && options.safeWorkerRecommendations !== false ? safeWorkerRecommendation(prompt, classification) : null;
  if (workerRecommendation) return { ...base, ...workerRecommendation, reasonCode: workerRecommendation.recommendationReasonCode };
  const requestedTopology = options.topologyId || (classification.intent === "implement" && !classification.topologyHint ? options.defaultTopologyId : null);
  const topologyId = pickTopology(classification.intent, mode, options.availableTopologies, requestedTopology, classification.topologyHint);
  if (!topologyId) return { ...base, reasonCode: classification.intent === "answer" ? "answer-in-parent" : "no-compatible-topology" };
  if (mode === "suggest") return { ...base, topologyId };
  if (mode === "shadow") return { ...base, topologyId, execute: true, automaticExecutionAllowed: true, advisoryOnly: true, mutationAuthority: false, incompleteMutation: classification.mutationRequested, reasonCode: classification.mutationRequested ? "shadow-advisory-for-mutation" : classification.reasonCode };
  return { ...base, topologyId, execute: true, automaticExecutionAllowed: true, advisoryOnly: false, mutationAuthority: classification.mutationRequested, reasonCode: classification.reasonCode };
}
function compactRouterDecision(decision = {}, { outcomeLink = null } = {}) {
  return {
    classifierVersion: decision.classifierVersion || ROUTER_CLASSIFIER_VERSION,
    intent: decision.intent || "no-route",
    topologyId: decision.topologyId || null,
    recommendationKind: decision.recommendationKind || null,
    recommendedRoleId: decision.recommendedRoleId || null,
    recommendedModel: decision.recommendedModel || null,
    recommendedThinkingLevel: decision.recommendedThinkingLevel || null,
    workspacePolicy: decision.workspacePolicy || null,
    mutationPolicy: decision.mutationPolicy || null,
    reasonCode: decision.reasonCode || "unknown",
    confidence: Number(decision.confidence || 0),
    promptHash: decision.promptHash || hashPrompt(""),
    mode: decision.mode || "off",
    classified: decision.classified === true,
    matched: decision.matched === true,
    execute: decision.execute === true,
    automaticExecutionAllowed: decision.automaticExecutionAllowed === true,
    workerShadowCanary: decision.workerShadowCanary === true,
    outcomeLink: outcomeLink || null,
  };
}
function evaluateRouterCorpus(corpus = []) {
  let correct = 0; let optOutViolations = 0; let forbiddenAutomaticExecutions = 0; let questionMutationRoutes = 0; let implementationIncapableRoutes = 0;
  for (const row of corpus) {
    const classification = classifyRoleIntent(row.prompt);
    if (classification.intent === row.intent) correct += 1;
    const shadow = decideRoleRoute(row.prompt, { mode: "shadow", availableTopologies: ["planning-advisory", "reviewer-verifier-gate", "planner-coder-verifier", "research-advisory"] });
    if (/\b(?:do\s+not|skip|disable|without|no)\s+(?:use\s+)?(?:auto[- ]?(?:roles?|route|routing)|topolog(?:y|ies)|subagents?)\b/i.test(row.prompt) && (classification.intent !== "no-route" || shadow.execute)) optOutViolations += 1;
    if (row.automaticAllowed === false && shadow.execute) forbiddenAutomaticExecutions += 1;
    if (classification.questionOnly && (classification.mutationRequested || shadow.mutationAuthority)) questionMutationRoutes += 1;
    if (row.intent === "implement" && shadow.execute && !shadow.mutationAuthority && !shadow.advisoryOnly) implementationIncapableRoutes += 1;
  }
  return { total: corpus.length, correct, precision: corpus.length ? correct / corpus.length : 1, optOutViolations, forbiddenAutomaticExecutions, questionMutationRoutes, implementationIncapableRoutes };
}

module.exports = {
  ROUTER_CLASSIFIER_VERSION,
  ROUTER_SUGGESTION_MIN_CONFIDENCE,
  ROUTER_INTENTS,
  ROUTER_MODES,
  LEGACY_RUN_WARNING,
  INTENT_TO_TOPOLOGY,
  SHADOW_TOPOLOGY,
  SAFE_WORKER_ROLE_ID,
  SAFE_WORKER_REASON_CODE,
  WORKER_SHADOW_CANARY_TOPOLOGY_ID,
  WORKER_SHADOW_CANARY_MODEL,
  WORKER_SHADOW_CANARY_THINKING_LEVEL,
  safeWorkerRecommendation,
  workerShadowCanaryScopeSafe,
  buildWorkerShadowCanaryTopology,
  authorizeWorkerShadowCanary,
  topologyHintFor,
  hashPrompt,
  normalizeRouterMode,
  classifyRoleIntent,
  decideRoleRoute,
  compactRouterDecision,
  evaluateRouterCorpus,
};
