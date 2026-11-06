"use strict";

const TASK_MODALITY_VERSION = "task-modality-v2";
const USER_TASK_ENTRY_TYPE = "reasoning-runtime.user-task";
const TASK_MODALITIES = Object.freeze(["investigation", "planning", "implementation", "verification", "publish", "credential", "destructive", "answer", "unclassified"]);

// Non-protected modalities that a TypeSafe judgment may choose. Protected
// modalities (publish, credential, destructive) are always decided locally.
const JUDGED_MODALITY_DESCRIPTIONS = Object.freeze({
  answer: "Answer a question or explain something from existing knowledge, without investigating files or changing anything",
  investigation: "Inspect, research, debug, or review existing code, files, or state and report findings, without changing them",
  planning: "Design or propose a plan, strategy, or approach and present it, without implementing it",
  implementation: "Make changes: write, edit, fix, refactor, configure, or build code, files, or settings",
  verification: "Check, test, or validate existing work and report whether it passes, without repairing it",
});

// Test/build completion is a mutation request even when it is phrased as a
// goal rather than a verb ("make all tests pass", "get the build green").
// Without these forms a report-style prompt such as "Review the parser and
// make all tests pass" was classified as investigation, so the injected
// scaffold told the model that mutation was not requested and the turn ended
// with a report instead of the repair.
const MUTATION_RE = /\b(?:implement|build|add|change|modify|edit|fix|repair|refactor|optimise|optimize|wire|integrate|update|harden|rewrite|remove|create|make\s+(?:[\w'.-]+\s+){0,3}tests?\s+pass|(?:get|ensure|keep)\s+(?:[\w'.-]+\s+){0,3}(?:tests?\s+(?:pass|passing|green)|build\s+(?:green|passing|working)))\b/i;
const PLAN_RE = /\b(?:plan|design|propose|outline|strategy|rollout|migration)\b/i;
const VERIFY_RE = /\b(?:verify|validate|run\s+(?:the\s+)?(?:focused\s+|full\s+)?tests?|test\s+(?:the|this)|check\s+(?:that|whether)|collect\s+(?:the\s+)?evidence)\b/i;
const INVESTIGATE_RE = /\b(?:research|investigate|debug|diagnose|triage|explore|find|trace|locate|map|review|audit|inspect|analy[sz]e)\b/i;
const PUBLISH_RE = /\b(?:commit|push|publish|deploy|ship\s+(?:the\s+)?release|cut\s+(?:and\s+)?release|release\s+version|tag\s+(?:the\s+)?release|install\s+(?:the\s+)?package|package\s+install)\b/i;
const DESTRUCTIVE_RE = /\b(?:rm\s+-rf|delet(?:e|ing)|drop(?:ping)?|destroy(?:ing)?|wip(?:e|ing)|eras(?:e|ing)|hard\s+reset|discard\s+(?:local\s+)?changes?|force[- ]?reset|overwrite\s+history)\b/i;
const CREDENTIAL_RE = /\b(?:rotate|replace|revoke|expose|print|export|create|issue)\b[^.\n]{0,80}\b(?:credentials?|secrets?|api[- ]?keys?|passwords?|tokens?)\b/i;
// Scoped restrictions (e.g. "do not edit the SDK") remain constraints, not a
// blanket prohibition on the rest of an explicitly authorized implementation.
const READ_ONLY_RE = /\bread[- ]only\b|\b(?:without\s+(?:(?:making\s+)?changes?|edits?|editing|implementing)|(?:do\s+not|don't)\s+(?:edit|change|modify|repair|fix|implement)|no\s+(?:edits?|changes?|repairs?))(?:\s+(?:anything|any\s+(?:files?|code)|files?|code|the\s+code|it))?(?=\s*(?:[.,;!?]|$))/i;
const COMPLETION_RE = /\b(?:finish|complete|execute)\b|\b(?:continue|resume)\s+(?:implementing|implementation|executing|the\s+implementation)\b/i;
const REPORT_RE = /^(?:please\s+)?(?:plan\b|review\b|report\b|explain\b|what\b|how\b|outline\b|design\b|propose\b)/i;
const CONTINUE_RE = /^(?:please\s+)?(?:continue|carry on|keep going|proceed|resume)(?:\s+(?:with\s+)?(?:the\s+)?(?:existing\s+|current\s+|remaining\s+)?(?:implementation|plan|work|task))?[.!]?$/i;

// Only a concrete previous user task can resolve an otherwise content-free
// continuation. This preserves its restrictions; it never creates permission.
function resolveTaskObjective(prompt, { parentTask } = {}) {
  const request = String(prompt || "").trim();
  const parent = String(parentTask?.objective || "").trim();
  return CONTINUE_RE.test(request) && parent && !CONTINUE_RE.test(parent) ? parent : request;
}

function taskObjectiveFromSession(entries = []) {
  // Pi also persists extension-authored prompts as role=user. Only input-hook
  // records establish user provenance; transcript role or summaries cannot.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== USER_TASK_ENTRY_TYPE) continue;
    const text = String(entry.data?.objective || "").trim();
    if (text && !CONTINUE_RE.test(text)) return text;
  }
  return "";
}
const CONSTRAINT_RE = /(?:^|[.!?;]\s+)([^.!?;]*(?:must|never|only|without|do\s+not|don't|require[sd]?|keep|preserve|avoid|before|after)[^.!?;]*[.!?]?)/gi;

function fixedResult(prompt, modality, reasonCode, confidence, extra = {}) {
  const protectedAction = ["publish", "credential", "destructive"].includes(modality);
  return {
    version: TASK_MODALITY_VERSION,
    modality,
    reasonCode,
    confidence,
    // "unclassified" claims neither: the request decides what is authorized.
    readOnly: ["investigation", "planning", "verification", "answer"].includes(modality),
    mutationAllowed: modality === "implementation",
    repairAllowed: modality === "implementation",
    automaticDelegationAllowed: !protectedAction,
    requiresConfirmation: protectedAction,
    ...extra,
  };
}

// Judgments are advisory: explicit actions/restrictions and a known parent
// continuation take precedence. Labels do not grant operational permissions.
function classifyTaskModality(prompt, options = {}) {
  const raw = resolveTaskObjective(prompt, options);
  if (!raw) return fixedResult(raw, "answer", "empty", 1);
  // Factual questions mention actions without requesting them. Classify any
  // following request separately; polite "Can/Could you ...?" requests still
  // follow the action rules below rather than this status-question rule.
  const statusQuestion = raw.match(/^(?:please\s+)?(?:did|have|has|had|is|are|was|were)\b[^?]*\?\s*/i);
  if (statusQuestion) {
    const request = raw.slice(statusQuestion[0].length).trim();
    return request ? classifyTaskModality(request, { judged: options.judged }) : fixedResult(raw, "answer", "status-question", 0.94);
  }
  const actionText = raw.replace(/\b(?:do\s+not|don't|never|without)\b[^.;!?\n]*/gi, "").replace(/^[.;!?\s]+/, "");
  if (CREDENTIAL_RE.test(actionText)) return fixedResult(raw, "credential", "credential-action", 0.99);
  if (DESTRUCTIVE_RE.test(actionText)) return fixedResult(raw, "destructive", "destructive-action", 0.99);
  if (PUBLISH_RE.test(actionText)) return fixedResult(raw, "publish", "publish-action", 0.99);
  const readOnly = READ_ONLY_RE.test(raw);
  if (readOnly) {
    const modality = VERIFY_RE.test(raw) ? "verification" : INVESTIGATE_RE.test(raw) ? "investigation" : PLAN_RE.test(raw) ? "planning" : "answer";
    return fixedResult(raw, modality, "explicit-read-only", 1);
  }
  if (CONTINUE_RE.test(String(prompt || "").trim())) {
    if (raw !== String(prompt || "").trim()) {
      const parentPolicy = options.parentTask?.policy;
      const judged = parentPolicy && Object.hasOwn(JUDGED_MODALITY_DESCRIPTIONS, parentPolicy.modality) ? parentPolicy : undefined;
      return classifyTaskModality(raw, { judged });
    }
    return fixedResult(raw, "unclassified", "continuation-needs-parent", 0);
  }
  if (!actionText.replace(/[.;!?\s]/g, "")) return fixedResult(raw, "unclassified", "constraints-only", 0);
  const followingAction = actionText.split(/[.;!?\n]+|\b(?:and|then)\b/i).slice(1).some((clause) => {
    const request = clause.trim().replace(/^please\s+/i, "");
    return MUTATION_RE.exec(request)?.index === 0 || COMPLETION_RE.exec(request)?.index === 0;
  });
  const reportOnly = REPORT_RE.test(actionText) && !followingAction;
  if (!reportOnly && (MUTATION_RE.test(actionText) || COMPLETION_RE.test(actionText))) return fixedResult(raw, "implementation", "implementation-action", 0.94);
  if (reportOnly) {
    const modality = /^(?:please\s+)?(?:plan|outline|design|propose)\b/i.test(raw) ? "planning" : INVESTIGATE_RE.test(raw) ? "investigation" : "answer";
    return fixedResult(raw, modality, "explicit-report", 0.94);
  }
  if (options.judged) {
    const { modality, confidence } = options.judged;
    if (!modality) return fixedResult(raw, "unclassified", "judgment-unavailable", 0);
    if (!Object.hasOwn(JUDGED_MODALITY_DESCRIPTIONS, modality)) throw new Error(`judged modality is not judgeable: ${modality}`);
    return fixedResult(raw, modality, "typesafe-judgment", Number(confidence) || 0);
  }
  if (VERIFY_RE.test(raw)) return fixedResult(raw, "verification", "verification-only", 0.94);
  if (PLAN_RE.test(raw)) return fixedResult(raw, "planning", "planning-only", 0.93);
  if (INVESTIGATE_RE.test(raw)) return fixedResult(raw, "investigation", "investigation-action", 0.9);
  return fixedResult(raw, "answer", "answer-or-unknown", 0.75);
}

function extractPublicConstraints(prompt) {
  const text = String(prompt || "").replace(/\s+/g, " ").trim();
  const constraints = [];
  for (const match of text.matchAll(CONSTRAINT_RE)) {
    const value = String(match[1] || "").trim();
    if (value && !constraints.includes(value)) constraints.push(value);
  }
  return constraints.slice(0, 8);
}

const STEPS = Object.freeze({
  investigation: [
    ["inspect", "Inspect relevant state and gather read-only evidence"],
    ["analyze", "Analyze likely causes without changing files or state"],
    ["report", "Report findings, uncertainty, and next options"],
  ],
  planning: [
    ["scope", "Restate the objective and constraints"],
    ["design", "Develop options, risks, sequencing, and rollback"],
    ["report", "Present a plan without implementing it"],
  ],
  implementation: [
    ["inspect", "Inspect current behavior and relevant constraints"],
    ["change", "Implement every required outcome in dependency-ready increments"],
    ["verify", "Verify affected outcomes; continue remaining authorized work"],
  ],
  verification: [
    ["scope", "Identify the claim and applicable verification commands"],
    ["verify", "Run checks and collect public evidence without repairing failures"],
    ["report", "Report pass, fail, blocked, or not-applicable exactly"],
  ],
  publish: [
    ["inspect", "Inspect publish readiness without publishing"],
    ["confirm", "Request explicit confirmation for the exact publish action"],
    ["publish", "Publish only after confirmation and report remote evidence"],
  ],
  credential: [
    ["inspect", "Inspect credential-operation prerequisites without exposing values"],
    ["confirm", "Request explicit confirmation for the exact credential action"],
    ["act", "Perform only the confirmed action and report metadata-only evidence"],
  ],
  destructive: [
    ["inspect", "Inspect scope, impact, backups, and safer alternatives"],
    ["confirm", "Request explicit confirmation for the exact destructive action"],
    ["act", "Perform only the confirmed action and report bounded evidence"],
  ],
  answer: [
    ["understand", "Restate the question and relevant constraints"],
    ["answer", "Answer from available public evidence"],
    ["qualify", "State uncertainty and optional next steps"],
  ],
  unclassified: [
    ["scope", "Restate the request and its explicit constraints"],
    ["work", "Do only what the request asks"],
    ["report", "Report the result with supporting evidence"],
  ],
});

function buildTaskScaffold(prompt, options = {}) {
  const objective = resolveTaskObjective(prompt, options) || "current task";
  const classification = classifyTaskModality(prompt, options);
  const constraints = extractPublicConstraints(objective);
  const steps = STEPS[classification.modality].map(([id, description]) => ({ id, description, status: "pending" }));
  return {
    objective,
    modality: classification.modality,
    constraints,
    summary: `Public ${classification.modality} scaffold containing only shareable artifacts.`,
    steps,
    risks: ["stale context", "unverified result", classification.requiresConfirmation ? "action without explicit confirmation" : "scope drift"],
    successCriteria: [
      "the objective and explicit constraints are preserved",
      classification.reasonCode === "explicit-read-only" ? "no mutation or repair step is introduced" : classification.mutationAllowed ? "all required outcomes are reconciled; only authorized mutation is performed" : "derived modality is advisory; any mutation must be explicitly requested",
      classification.requiresConfirmation ? "the protected action is separately confirmed" : "public evidence supports the result",
    ],
    source: "model-scaffold",
    policy: classification,
  };
}

function buildTaskDecomposition(prompt, options = {}) {
  const task = resolveTaskObjective(prompt, options) || "current task";
  const classification = classifyTaskModality(prompt, options);
  const subtasks = STEPS[classification.modality].map(([id, title]) => ({ id, title, status: "pending", mutating: classification.mutationAllowed && id === "change", requiresConfirmation: classification.requiresConfirmation && id === "confirm" }));
  return { task, modality: classification.modality, constraints: extractPublicConstraints(task), subtasks, ordering: subtasks.map((item) => item.id), parallelizable: [], policy: classification };
}

function containsUnauthorizedMutationStep(value) {
  const classification = value?.policy || classifyTaskModality(value?.task || value?.objective || "");
  if (classification.mutationAllowed) return false;
  const items = value?.steps || value?.subtasks || [];
  const text = JSON.stringify(items);
  const mutating = /\b(?:apply|edit|modify|change\s+(?:the\s+)?(?:code|files?|state)|fix|repair|implement|write|delete|publish|push|commit|deploy|rotate|revoke)\b/i.test(text);
  if (!classification.requiresConfirmation) return mutating;
  const confirmAt = items.findIndex((item) => item.id === "confirm" || item.requiresConfirmation === true);
  const actionAt = items.findIndex((item) => ["publish", "act"].includes(item.id));
  return confirmAt < 0 || actionAt < 0 || confirmAt >= actionAt;
}

module.exports = { TASK_MODALITY_VERSION, USER_TASK_ENTRY_TYPE, TASK_MODALITIES, JUDGED_MODALITY_DESCRIPTIONS, classifyTaskModality, resolveTaskObjective, taskObjectiveFromSession, extractPublicConstraints, buildTaskScaffold, buildTaskDecomposition, containsUnauthorizedMutationStep };
