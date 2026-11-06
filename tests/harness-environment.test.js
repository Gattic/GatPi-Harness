"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseHarnessEnvironment,
  readHarnessEnvironment,
  applyHarnessEnvironmentDefaults,
  conflictOverride,
  REDACTED,
} = require("../src/harness-environment.js");
const { resolveRoleRuntimeConfig } = require("../src/role-runtime-rollout.js");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout.js");

assert.deepEqual(parseHarnessEnvironment("# comment\nPI_ONE=1\nexport PI_MODE=suggest\nPI_MODEL=openai-codex/gpt-6-astra\n"), {
  PI_ONE: "1",
  PI_MODE: "suggest",
  PI_MODEL: "openai-codex/gpt-6-astra",
});
assert.throws(() => parseHarnessEnvironment("SECRET=value\n"), /invalid harness environment entry/);
assert.throws(() => parseHarnessEnvironment("PI_ONE=$PRIVATE\n"), /invalid harness environment entry/);
assert.throws(() => parseHarnessEnvironment("PI_ONE=/tmp/model;echo-owned\n"), /invalid harness environment entry/);
assert.throws(() => parseHarnessEnvironment("PI_ONE=1\nPI_ONE=2\n"), /duplicate harness environment key/);

const loaded = readHarnessEnvironment({ root: path.join(__dirname, "..") });
for (const [key, expected] of Object.entries({
  PI_POLICY_ENFORCER_MODE: "block",
  PI_CODEMODE: "1",
  PI_TRACE_CAPTURE_PAYLOADS: "0",
  PI_PROJECT_MEMORY_STAGE: "M1",
  PI_PROJECT_MEMORY_WRITES: "1",
  PI_PROJECT_MEMORY_AUTOMATIC: "1",
  PI_PROJECT_MEMORY_AUTO_SAVE: "1",
  PI_PROJECT_MEMORY_DIAGNOSTICS: "1",
  PI_TOPOLOGY_AUTO_ROUTE: "off",
  PI_ROLE_MUTATION: "isolated",
  PI_ROLE_ROLLOUT_STAGE: "R5",
  PI_ROLE_FIELD_PILOT: "0",
  PI_MULTI_AGENT_TOPOLOGIES_ENABLED: "1",
  PI_SPECIALIST_TASKS_ENABLED: "1",
  PI_ROLE_WORKER_SHADOW_CANARY: "0",
  PI_SUBAGENT_RPC_CONCURRENCY: "2",
  PI_COGNITIVE_AUTO_VERIFY: "0",
  PI_COGNITIVE_TIMING: "1",
  PI_LEARNING_AUTO_INGEST: "1",
  PI_LEARNING_AUTO_INGEST_SOURCES: "verification,topology,skill,evidence,execution,runtime,policy,privacy",
  PI_CODEGRAPH_AUTO_SYNC: "1",
  PI_SEMGREP_ADVISORY: "0",
  PI_OBSIDIAN_AUTO_STATUS: "1",
  PI_MANAGED_PROCESS_MAX_RSS_MB: "6144",
  PI_COMPACTION_PROACTIVE: "1",
  PI_COMPACTION_PROACTIVE_PERCENT: "80",
  PI_COMPACTION_PROACTIVE_MAX_CHARS: "8388608",
  PI_OUTPUT_COMPACTOR_MODE: "canary",
  PI_OUTPUT_COMPACTOR_MODEL_TOOL: "0",
  PI_ROLE_MODEL_PLANNER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_PLANNER: "high",
  PI_ROLE_MODEL_RESEARCHER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_RESEARCHER: "medium",
  PI_ROLE_MODEL_REVIEWER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_REVIEWER: "high",
  PI_ROLE_MODEL_CODER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_CODER: "high",
  PI_ROLE_MODEL_VERIFIER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_VERIFIER: "low",
  PI_ROLE_MODEL_REFACTORER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_REFACTORER: "high",
  PI_ROLE_MODEL_BENCHMARK: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_BENCHMARK: "medium",
  PI_ROLE_MODEL_EVIDENCE_AUDITOR: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_EVIDENCE_AUDITOR: "high",
  PI_ROLE_MODEL_WORKER: "local/DeepSeek-V4.1-Flash-1017",
  PI_ROLE_THINKING_WORKER: "low",
})) assert.equal(loaded.values[key], expected, `${key} guarded default`);
for (const role of ["COORDINATOR", "MEMORY_CURATOR", "SKILL_INTAKE_HANDLER", "TOOL_SPECIALIST"]) {
  assert.equal(loaded.values[`PI_ROLE_MODEL_${role}`], undefined, `${role} remains model-free`);
  assert.equal(loaded.values[`PI_ROLE_THINKING_${role}`], undefined, `${role} remains thinking-free`);
}
const roleRuntime = resolveRoleRuntimeConfig(loaded.values, { cwd: path.join(__dirname, ".."), benchmarkReport: null, fieldEvidenceReport: null });
assert.equal(roleRuntime.effectiveStage, "R5");
assert.equal(roleRuntime.stageAuthority, "configured-environment");
assert.equal(roleRuntime.evidenceAuthorizedStage, "R0");
assert.equal(roleRuntime.evidenceOverride, true);
assert.equal(roleRuntime.mutationMode, "isolated");
assert.equal(roleRuntime.autoRouteMode, "off");
assert.equal(roleRuntime.sidecarEnabled, true);

const memory = resolveProjectMemoryRollout(loaded.values);
assert.equal(memory.effectiveStage, "M1");
assert.equal(memory.evidenceEligibleStage, "M0", "defaults do not fabricate field evidence");
assert.equal(memory.stageAuthority, "operator-opt-in");
assert.equal(memory.fieldEffectiveness, "unproven");
assert.equal(memory.controls.explicitWrites, true);
assert.equal(memory.controls.taskRecall, true);
assert.equal(memory.controls.automaticCapture, true);
for (const control of ["candidateCapture", "reviewQueueWrites", "hermesCuration", "automaticVerifiedUpserts", "cognitiveConsolidation", "retentionApply"]) {
  assert.equal(memory.controls[control], false, `${control} is not granted by operator automatic defaults`);
}
for (const override of [{ PI_PROJECT_MEMORY_STAGE: "M0" }, { PI_PROJECT_MEMORY_WRITES: "0" }, { PI_PROJECT_MEMORY: "0" }, { PI_PROJECT_MEMORY_STAGE: "M2" }]) {
  const memoryEnv = { ...override };
  const defaults = applyHarnessEnvironmentDefaults({ root: path.join(__dirname, ".."), env: memoryEnv });
  for (const [key, value] of Object.entries(override)) {
    assert.equal(memoryEnv[key], value);
    assert(defaults.preserved.includes(key) || !(key in defaults.defaults));
  }
  const rollout = resolveProjectMemoryRollout(memoryEnv);
  assert.equal(rollout.controls.explicitWrites, false, "default opt-in cannot override rollback or authorize M2");
  assert.equal(rollout.effectiveStage, "M0");
}

const env = { PI_MULTI_AGENT_TOPOLOGIES_ENABLED: "0", PI_SPECIALIST_TASKS_ENABLED: "0", PI_TOPOLOGY_AUTO_ROUTE: "off", PI_TRACE_CAPTURE_PAYLOADS: "", PI_COMPACTION_PROACTIVE: "0", PI_ROLE_MODEL_WORKER: "provider/custom-worker", PI_ROLE_THINKING_WORKER: "minimal" };
const applied = applyHarnessEnvironmentDefaults({ root: path.join(__dirname, ".."), env });
assert.equal(env.PI_TOPOLOGY_AUTO_ROUTE, "off", "explicit environment overrides are preserved");
for (const key of ["PI_MULTI_AGENT_TOPOLOGIES_ENABLED", "PI_SPECIALIST_TASKS_ENABLED"]) {
  assert.equal(env[key], "0", `${key} explicit launch rollback beats manual defaults`);
  assert(applied.preserved.includes(key));
}
assert.equal(env.PI_TRACE_CAPTURE_PAYLOADS, "", "an explicitly empty environment value is still an override");
assert.equal(env.PI_COMPACTION_PROACTIVE, "0", "explicit proactive-compaction rollback beats repository defaults");
assert.equal(env.PI_ROLE_MODEL_WORKER, "provider/custom-worker", "explicit worker model beats repository defaults");
assert.equal(env.PI_ROLE_THINKING_WORKER, "minimal", "explicit worker thinking beats repository defaults");
assert(applied.preserved.includes("PI_TOPOLOGY_AUTO_ROUTE"));
assert(applied.preserved.includes("PI_TRACE_CAPTURE_PAYLOADS"));
assert(!applied.conflicts.some((row) => row.key === "PI_TOPOLOGY_AUTO_ROUTE"), "an override equal to the canonical default is not a conflict");
assert(applied.conflicts.some((row) => row.key === "PI_COMPACTION_PROACTIVE" && row.canonical === "1" && row.override === "0"));
const conflicting = applyHarnessEnvironmentDefaults({ root: path.join(__dirname, ".."), env: { PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0" } });
assert.deepEqual(conflicting.conflicts, [
  { key: "PI_PROJECT_MEMORY_STAGE", canonical: "M1", override: "M0" },
  { key: "PI_PROJECT_MEMORY_AUTO_SAVE", canonical: "1", override: "0" },
], "inherited stage overrides are reported instead of silently preserved");
assert(conflicting.preserved.includes("PI_PROJECT_MEMORY_STAGE"));
assert(applied.applied.includes("PI_TRACE_ENABLED"));

// Conflict values are persisted in managed state, so paths and secret-shaped
// overrides are redacted instead of copied into the posture record.
assert.equal(conflictOverride("PI_PROJECT_MEMORY_STAGE", "M0"), "M0");
assert.equal(conflictOverride("PI_ROLE_MODEL_WORKER", "provider/custom-worker"), "provider/custom-worker");
assert.equal(conflictOverride("PI_COGNITIVE_STORAGE_ROOT", "/home/person/private"), REDACTED, "absolute paths are not recorded");
assert.equal(conflictOverride("PI_TYPESAFE_API_KEY", "abc123"), REDACTED, "secret-shaped keys are redacted");
assert.equal(conflictOverride("PI_PROJECT_MEMORY_STAGE", "M0 with spaces"), REDACTED, "free-form values are redacted");
const redacted = applyHarnessEnvironmentDefaults({ root: path.join(__dirname, ".."), env: { PI_ROLE_MODEL_WORKER: "/home/person/private/model" } });
assert.equal(redacted.conflicts.find((row) => row.key === "PI_ROLE_MODEL_WORKER")?.override, REDACTED);
assert.doesNotMatch(JSON.stringify(redacted.conflicts), /\/home\/person\/private/);

const extension = fs.readFileSync(path.join(__dirname, "..", "extensions", "00-harness-defaults", "index.ts"), "utf8");
assert.match(extension, /applyHarnessEnvironmentDefaults/);
assert(extension.indexOf("applyHarnessEnvironmentDefaults") < extension.indexOf("export default function"), "defaults apply at module load before extension factories run");
assert.match(extension, /harness-defaults-status/);
assert.match(extension, /readProjectMemoryPosture/, "the defaults extension reports the declared posture");
assert.match(extension, /applyProjectMemoryPosture/, "the defaults extension resolves the recorded posture");

console.log("harness environment tests passed");
