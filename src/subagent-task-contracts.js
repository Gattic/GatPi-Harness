"use strict";

const path = require("node:path");
const { runtimeSourceFingerprint } = require("./runtime-source-fingerprint");
const { pathForbidden, safeRelative } = require("./subagent-workspaces");
const { roleRevisionHash } = require("./role-contracts");
const { canonical, digest, inZone, overlaps, validateJsonSchema } = require("./specialist-contracts");

const SCHEMA_VERSION = 2;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const USAGE_KEYS = ["attempts", "modelCalls", "toolCalls", "wallTimeMs", "tokens", "cost", "storageBytes"];
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function invariant(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
function keys(value, allowed, code) { invariant(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), code); }
function validId(value) { return typeof value === "string" && ID.test(value); }
function ids(values, { empty = false } = {}) { return Array.isArray(values) && values.length <= 64 && (empty || values.length > 0) && values.every(validId) && new Set(values).size === values.length; }
function zones(values, empty = true) { return Array.isArray(values) && values.length <= 64 && (empty || values.length > 0) && values.every(v => typeof v === "string" && v === safeRelative(v) && !pathForbidden(v.replace(/\/$/, "")) && !/[?*]/.test(v) && !v.split("/").includes(".")); }
function validateTaskSpec(input, roles) {
  keys(input, ["taskId", "requirementIds", "roleId", "contractRevision", "objective", "exclusions", "taskKind", "dependsOn", "readZones", "writeZones", "resources", "baseRevision", "baselineFingerprint", "contextPacketId", "acceptanceCriteria", "domainInput", "acceptanceMode"], "TASK_SPEC_INVALID");
  invariant(input.acceptanceMode === undefined || input.acceptanceMode === "measured", "TASK_ACCEPTANCE_MODE_INVALID");
  invariant(validId(input.taskId || "") && input.taskId !== "task-plan" && ids(input.requirementIds), "TASK_ID_INVALID");
  const role = roles.find(r => r.roleId === input.roleId);
  invariant(role && role.workspacePolicy !== "handler-only", "TASK_ROLE_UNAVAILABLE");
  // Only the asset producer has a vision-critique gate to replace. Declaring the mode
  // on any other role would read as "the critic was skipped" while changing nothing.
  invariant(input.acceptanceMode === undefined || role.roleId === "3d-modeler", "TASK_ACCEPTANCE_MODE_UNSUPPORTED");
  invariant(input.contractRevision === roleRevisionHash(role), "TASK_CONTRACT_STALE");
  invariant(typeof input.objective === "string" && input.objective.trim().length > 0 && input.objective.length <= 4000, "TASK_OBJECTIVE_INVALID");
  invariant(Array.isArray(input.exclusions) && input.exclusions.length <= 32 && input.exclusions.every(v => typeof v === "string" && v.length <= 500), "TASK_EXCLUSIONS_INVALID");
  invariant(["implementation", "integration", "research", "asset", "analysis"].includes(input.taskKind), "TASK_KIND_INVALID");
  invariant(zones(input.readZones) && zones(input.writeZones, role.mutationPolicy !== "proposed-patch"), "TASK_ZONES_INVALID");
  invariant(role.mutationPolicy === "proposed-patch" || input.writeZones.length === 0, "TASK_READONLY_WRITES");
  invariant(ids(input.resources, { empty: true }), "TASK_RESOURCES_INVALID");
  invariant(typeof input.baseRevision === "string" && /^[a-f0-9]{40,64}$/.test(input.baseRevision) && DIGEST.test(input.baselineFingerprint || ""), "TASK_BASELINE_INVALID");
  invariant(validId(input.contextPacketId || ""), "TASK_CONTEXT_INVALID");
  invariant(Array.isArray(input.dependsOn) && input.dependsOn.length <= 64, "TASK_DEPENDENCIES_INVALID");
  for (const d of input.dependsOn) {
    keys(d, ["taskId", "requiredArtifactKind", "readinessCondition"], "TASK_DEPENDENCY_INVALID");
    invariant(validId(d.taskId || "") && d.readinessCondition === "accepted-proposal" && ["patch", "dossier", "asset"].includes(d.requiredArtifactKind), "TASK_DEPENDENCY_INVALID");
  }
  invariant(new Set(input.dependsOn.map(d => d.taskId)).size === input.dependsOn.length, "TASK_DUPLICATE_DEPENDENCY");
  invariant(Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length > 0 && input.acceptanceCriteria.length <= 32, "TASK_CRITERIA_INVALID");
  for (const c of input.acceptanceCriteria) {
    keys(c, ["id", "kind", "verifierId", "expected", "required"], "TASK_CRITERION_INVALID");
    invariant(validId(c.id || "") && validId(c.verifierId || "") && c.kind === "executable" && c.expected === "passed" && typeof c.required === "boolean", "TASK_CRITERION_INVALID");
  }
  invariant(new Set(input.acceptanceCriteria.map(c => c.id)).size === input.acceptanceCriteria.length && input.acceptanceCriteria.some(c => c.required && c.kind === "executable"), "TASK_CRITERIA_INVALID");
  if (role.inputSchema) {
    invariant(validateJsonSchema(role.inputSchema, input.domainInput).length === 0, "TASK_DOMAIN_INPUT_INVALID");
    if (input.domainInput?.proofMode === "certificate") invariant(input.domainInput.certificateTarget?.kind === "bezout-gcd", "TASK_CERTIFICATE_TARGET_REQUIRED");
    if (input.domainInput?.proofMode === "lean") invariant(input.domainInput.leanTarget, "TASK_LEAN_TARGET_REQUIRED");
  } else invariant(input.domainInput == null, "TASK_DOMAIN_INPUT_UNEXPECTED");
  return clone(input);
}
function validateTaskGraph(input, roles) {
  keys(input, ["schemaVersion", "graphId", "tasks", "context", "concurrency"], "TASK_GRAPH_INVALID");
  invariant(input.schemaVersion === SCHEMA_VERSION && validId(input.graphId || ""), "TASK_GRAPH_VERSION_INVALID");
  invariant(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 16, "TASK_GRAPH_SIZE_INVALID");
  invariant(Number.isInteger(input.concurrency) && input.concurrency >= 1 && input.concurrency <= 2, "TASK_CONCURRENCY_INVALID");
  const tasks = input.tasks.map(t => validateTaskSpec(t, roles));
  const byId = new Map(tasks.map(t => [t.taskId, t]));
  invariant(byId.size === tasks.length, "TASK_GRAPH_DUPLICATE_ID");
  const ancestors = new Map();
  function visit(task, visiting = new Set()) {
    invariant(!visiting.has(task.taskId), "TASK_GRAPH_CYCLE");
    if (ancestors.has(task.taskId)) return ancestors.get(task.taskId);
    visiting.add(task.taskId);
    const found = new Set();
    for (const d of task.dependsOn) {
      invariant(byId.has(d.taskId), "TASK_DEPENDENCY_MISSING");
      found.add(d.taskId);
      for (const a of visit(byId.get(d.taskId), visiting)) found.add(a);
    }
    visiting.delete(task.taskId); ancestors.set(task.taskId, found); return found;
  }
  tasks.forEach(t => visit(t));
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i], b = tasks[j];
    const dependent = ancestors.get(a.taskId).has(b.taskId) || ancestors.get(b.taskId).has(a.taskId);
    const conflict = a.writeZones.some(x => [...b.readZones, ...b.writeZones].some(y => overlaps(x, y))) || b.writeZones.some(x => a.readZones.some(y => overlaps(x, y))) || a.resources.some(r => b.resources.includes(r));
    invariant(dependent || !conflict, "TASK_DEPENDENCY_REQUIRED");
    invariant(a.baseRevision === b.baseRevision && a.baselineFingerprint === b.baselineFingerprint, "TASK_BASELINE_MISMATCH");
  }
  const writers = tasks.filter(task => task.writeZones.length > 0);
  if (writers.length > 1) {
    const terminals = writers.filter(task => !writers.some(other => ancestors.get(other.taskId).has(task.taskId)));
    invariant(terminals.length === 1 && terminals[0].taskKind === "integration" && terminals[0].roleId === "integrator" && writers.every(task => task === terminals[0] || ancestors.get(terminals[0].taskId).has(task.taskId)), "TASK_FINAL_INTEGRATOR_REQUIRED");
    const finalChecks = new Set(terminals[0].acceptanceCriteria.filter(c => c.required).map(c => `${c.kind}:${c.verifierId}`));
    invariant(writers.every(task => task.acceptanceCriteria.filter(c => c.required).every(c => finalChecks.has(`${c.kind}:${c.verifierId}`))), "TASK_FINAL_COVERAGE_INCOMPLETE");
  }
  keys(input.context, ["id", "baselineFingerprint", "requirementIds", "sources", "assumptions", "conventions", "testEntryPoints", "exclusions"], "TASK_CONTEXT_INVALID");
  invariant(validId(input.context.id || "") && ids(input.context.requirementIds), "TASK_CONTEXT_INVALID");
  for (const field of ["sources", "assumptions", "conventions", "testEntryPoints", "exclusions"]) invariant(Array.isArray(input.context[field]) && input.context[field].length <= 64 && input.context[field].every(v => typeof v === "string" && v.length <= 1000), "TASK_CONTEXT_INVALID");
  invariant(Buffer.byteLength(JSON.stringify(input.context)) <= 24000 && tasks.every(t => t.contextPacketId === input.context.id && t.baselineFingerprint === input.context.baselineFingerprint && t.requirementIds.every(id => input.context.requirementIds.includes(id))), "TASK_CONTEXT_MISMATCH");
  invariant(input.context.requirementIds.every(id => tasks.some(task => task.requirementIds.includes(id))), "TASK_REQUIRED_SCOPE_OMITTED");
  // A resumed graph must not silently adopt different runtime or checker code.
  const runtimeRevision = digest({ node: process.version, platform: process.platform, arch: process.arch, source: runtimeSourceFingerprint(path.resolve(__dirname, "..")).hash });
  return { ...clone(input), tasks, runtimeRevision, digest: digest({ ...input, runtimeRevision }) };
}
module.exports = { SCHEMA_VERSION, validId, DIGEST, USAGE_KEYS, canonical, digest, clone, invariant, inZone, overlaps, validateTaskSpec, validateTaskGraph };
