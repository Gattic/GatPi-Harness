"use strict";

const { listBuiltInRoleTopologies } = require("./role-topologies");
const { DEFAULT_ROLE_CONTRACTS } = require("./role-contracts");

const GOAL_DECISION_SCHEMA_VERSION = 3;
const GOAL_DECISION_STATUSES = new Set(["running", "completed", "blocked", "failed"]);
const GOAL_ACTION_KINDS = new Set(["run_topology", "run_verifier", "inspect", "ask_user"]);
const VERIFIER_PROFILES = new Set(["quick", "changed", "full"]);
const INSPECT_TARGET_KINDS = new Set(["file", "symbol", "status", "evidence", "goal", "roadmap", "diff"]);
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const MAX_HERMES_PROMPT = 100_000;
const MAX_QUESTION = 800;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function assertExactKeys(value, allowed, required, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required`);
}
function safeCode(value, label) {
  const text = String(value || "").trim().toLowerCase();
  if (!SAFE_CODE.test(text)) throw new Error(`${label} must be a safe code`);
  return text;
}
function safeId(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_ID.test(text)) throw new Error(`${label} must be a safe identifier`);
  return text;
}
function safeRef(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_REF.test(text) || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.split("/").includes("..")) throw new Error(`${label} must be a bounded relative reference`);
  return text;
}
function evidenceIds(values) {
  if (!Array.isArray(values)) throw new Error("completionEvidenceIds must be an array");
  if (values.length > 64) throw new Error("completionEvidenceIds exceeds 64 items");
  return [...new Set(values.map((id) => safeId(id, "completionEvidenceIds")))];
}
function hermesPrompt(value) {
  const prompt = String(value || "");
  if (!prompt.trim() || prompt.length > MAX_HERMES_PROMPT) throw new Error(`action.prompt must be 1-${MAX_HERMES_PROMPT} characters`);
  return prompt;
}

function validateGoalAction(input) {
  assertObject(input, "action");
  const kind = String(input.kind || "");
  if (!GOAL_ACTION_KINDS.has(kind)) throw new Error(`unknown goal action: ${kind || "missing"}`);
  if (kind === "run_topology") {
    assertExactKeys(input, new Set(["kind", "topologyId", "inputRef", "prompt"]), ["kind", "topologyId", "inputRef", "prompt"], "action");
    return { kind, topologyId: safeId(input.topologyId, "action.topologyId"), inputRef: safeId(input.inputRef, "action.inputRef"), prompt: hermesPrompt(input.prompt) };
  }
  if (kind === "run_verifier") {
    assertExactKeys(input, new Set(["kind", "profile", "inputRef", "prompt"]), ["kind", "profile", "inputRef", "prompt"], "action");
    const profile = String(input.profile || "");
    if (!VERIFIER_PROFILES.has(profile)) throw new Error(`action.profile must be one of ${[...VERIFIER_PROFILES].join("|")}`);
    return { kind, profile, inputRef: safeId(input.inputRef, "action.inputRef"), prompt: hermesPrompt(input.prompt) };
  }
  if (kind === "inspect") {
    assertExactKeys(input, new Set(["kind", "targetKind", "targetRef", "prompt"]), ["kind", "targetKind", "targetRef", "prompt"], "action");
    const targetKind = String(input.targetKind || "");
    if (!INSPECT_TARGET_KINDS.has(targetKind)) throw new Error(`action.targetKind must be one of ${[...INSPECT_TARGET_KINDS].join("|")}`);
    return { kind, targetKind, targetRef: safeRef(input.targetRef, "action.targetRef"), prompt: hermesPrompt(input.prompt) };
  }
  assertExactKeys(input, new Set(["kind", "question"]), ["kind", "question"], "action");
  const question = String(input.question || "").trim();
  if (!question || question.length > MAX_QUESTION) throw new Error(`action.question must be 1-${MAX_QUESTION} characters`);
  return { kind, question };
}

function validateGoalDecisionV3(value) {
  assertObject(value, "goal decision");
  assertExactKeys(value, new Set(["schemaVersion", "status", "action", "reasonCode", "requiresUserInput", "completionEvidenceIds"]), ["schemaVersion", "status", "action", "reasonCode", "requiresUserInput", "completionEvidenceIds"], "goal decision");
  if (Number(value.schemaVersion) !== GOAL_DECISION_SCHEMA_VERSION) throw new Error(`goal decision schemaVersion must be ${GOAL_DECISION_SCHEMA_VERSION}`);
  const status = String(value.status || "");
  if (!GOAL_DECISION_STATUSES.has(status)) throw new Error(`goal decision has unknown status: ${status}`);
  if (typeof value.requiresUserInput !== "boolean") throw new Error("goal decision requiresUserInput must be a boolean");
  const action = value.action == null ? null : validateGoalAction(value.action);
  const completionEvidenceIds = evidenceIds(value.completionEvidenceIds);
  if (status === "running" && !action) throw new Error("running goal decision requires an action");
  if (["completed", "blocked", "failed"].includes(status) && action !== null) throw new Error(`${status} goal decision requires action:null`);
  if (status === "completed" && completionEvidenceIds.length === 0) throw new Error("completed goal decision requires completionEvidenceIds");
  if (action?.kind === "ask_user" && value.requiresUserInput !== true) throw new Error("ask_user action requires requiresUserInput:true");
  if (value.requiresUserInput === true && action?.kind !== "ask_user") throw new Error("requiresUserInput:true requires an ask_user action");
  return { schemaVersion: GOAL_DECISION_SCHEMA_VERSION, status, action, reasonCode: safeCode(value.reasonCode, "goal decision.reasonCode"), requiresUserInput: value.requiresUserInput, completionEvidenceIds };
}

function asksForCurrentProjectLocation(question) {
  const text = String(question || "");
  return [
    /\b(?:which|what)\s+(?:project|repository|repo)\b/i,
    /\b(?:project|repository|repo)\b.{0,100}\b(?:absolute\s+)?path\b/i,
    /\b(?:absolute\s+)?path\b.{0,100}\b(?:project|repository|repo)\b/i,
    /\bwhere\s+is\s+(?:the\s+)?(?:project|repository|repo)\b/i,
  ].some((pattern) => pattern.test(text));
}

function validateGoalDecisionForContext(value, context = {}) {
  const decision = validateGoalDecisionV3(value);
  if (context.currentProjectAvailable === true && decision.action?.kind === "ask_user" && asksForCurrentProjectLocation(decision.action.question)) {
    const error = new Error("ask_user cannot request the current project/repository path; choose an inspect action or an approved topology action in the current project");
    error.code = "GOAL_DECISION_INSPECTABLE_USER_INPUT";
    throw error;
  }
  const expectedInputRef = String(context.goalId || "").trim();
  if (expectedInputRef && ["run_topology", "run_verifier"].includes(decision.action?.kind) && decision.action.inputRef !== expectedInputRef) {
    const error = new Error(`${decision.action.kind} action.inputRef must exactly equal packet.goalId (${expectedInputRef})`);
    error.code = "GOAL_DECISION_INPUT_REF_MISMATCH";
    throw error;
  }
  return decision;
}

function parseGoalDecision(value, options = {}) {
  return options.currentProjectAvailable === true ? validateGoalDecisionForContext(value, options) : validateGoalDecisionV3(value);
}

function builtInTopologyMap() { return new Map(listBuiltInRoleTopologies().map((topology) => [topology.topologyId, topology])); }
function topologyMutationCapable(topology) {
  const contracts = new Map(DEFAULT_ROLE_CONTRACTS.map((role) => [role.roleId, role]));
  return (topology?.nodes || []).some((node) => contracts.get(node.roleId)?.mutationPolicy === "proposed-patch");
}
function topologyAuthority(topologyId, state = {}) {
  const topology = builtInTopologyMap().get(topologyId);
  if (!topology) return { allowed: false, reasonCode: "topology-not-allowlisted", topologyId, mutationCapable: null, mutationApproved: false };
  const mutationCapable = topologyMutationCapable(topology);
  const approved = new Set(state.actionAuthority?.approvedTopologyIds || []);
  const mutationApproved = !mutationCapable || approved.has(topologyId);
  return { allowed: mutationApproved, reasonCode: mutationApproved ? "topology-allowlisted" : "topology-mutation-approval-required", topologyId, mutationCapable, mutationApproved };
}

function dispatchGoalAction(action, state = {}) {
  const normalized = validateGoalAction(action);
  const startedAt = Date.now();
  if (normalized.kind === "run_topology") {
    if (normalized.inputRef !== state.id) return { ok: false, dispatchMode: "rejected", reasonCode: "goal-input-ref-mismatch", latencyMs: Date.now() - startedAt, action: normalized };
    const authority = topologyAuthority(normalized.topologyId, state);
    if (!authority.allowed) return { ok: false, dispatchMode: "rejected", reasonCode: authority.reasonCode, authority, latencyMs: Date.now() - startedAt, action: normalized };
    return { ok: true, dispatchMode: "hermes-prompt", reasonCode: "hermes-prompt-topology", authority, prompt: normalized.prompt, promptSource: "hermes", latencyMs: Date.now() - startedAt, action: normalized };
  }
  if (normalized.kind === "run_verifier") {
    if (normalized.inputRef !== state.id) return { ok: false, dispatchMode: "rejected", reasonCode: "goal-input-ref-mismatch", latencyMs: Date.now() - startedAt, action: normalized };
    return { ok: true, dispatchMode: "hermes-prompt", reasonCode: "hermes-prompt-verifier", prompt: normalized.prompt, promptSource: "hermes", latencyMs: Date.now() - startedAt, action: normalized };
  }
  if (normalized.kind === "inspect") return { ok: true, dispatchMode: "hermes-prompt", reasonCode: "hermes-prompt-inspect", prompt: normalized.prompt, promptSource: "hermes", latencyMs: Date.now() - startedAt, action: normalized };
  return { ok: true, dispatchMode: "ask-user", reasonCode: "user-input-required", question: normalized.question, latencyMs: Date.now() - startedAt, action: normalized };
}

module.exports = {
  GOAL_DECISION_SCHEMA_VERSION,
  GOAL_DECISION_STATUSES,
  GOAL_ACTION_KINDS,
  VERIFIER_PROFILES,
  INSPECT_TARGET_KINDS,
  validateGoalAction,
  validateGoalDecisionV3,
  validateGoalDecisionForContext,
  parseGoalDecision,
  topologyMutationCapable,
  topologyAuthority,
  dispatchGoalAction,
};
