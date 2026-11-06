#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  parseArgs,
  runFixtureBenchmark,
  evaluatePromotionBars,
} = require("../scripts/benchmark-role-runtime.js");
const {
  ROLLOUT_STAGES,
  resolveRoleRuntimeConfig,
  assertRoleRuntimeExecutionAllowed,
} = require("../src/role-runtime-rollout.js");
const { runtimeSourceFingerprint } = require("../src/runtime-source-fingerprint.js");
const { freezePhase7 } = require("../scripts/freeze-phase7-release.js");
const {
  ROLE_RUN_FIELDS,
  sanitizeRoleRunRecord,
  compactRoleToolOutcome,
  roleToolResultOverride,
} = require("../src/role-run-provenance.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const manifest = path.join(__dirname, "fixtures", "role-runtime", "manifest.json");
assert.deepEqual(parseArgs(["--fixture-only", "--manifest", manifest]), { fixtureOnly: true, manifest, output: null, help: false });
assert.throws(() => parseArgs(["--real-project"]), /fixture-only|opt-in/i);

const benchmarkNow = new Date().toISOString();
const first = runFixtureBenchmark({ manifest, now: benchmarkNow, cwd: root });
const second = runFixtureBenchmark({ manifest, now: benchmarkNow, cwd: root });
assert.deepEqual(first, second, "fixture benchmark output is deterministic for a fixed manifest and timestamp");
assert.equal(first.schemaVersion, 1);
assert.equal(first.benchmark, "pi-role-runtime-v2");
assert.equal(first.fixtureOnly, true);
assert.match(first.runtimeSourceHash, /^[a-f0-9]{64}$/);
assert(first.runtimeFileCount > 0);
assert.equal(first.runtimeSourceHash, runtimeSourceFingerprint(root).hash, "benchmark binds the shared current runtime fingerprint");
const freezeTmp = tmpFixture("pi-phase7-freeze-");
const settingsFile = path.join(freezeTmp, "settings.json");
fs.writeFileSync(settingsFile, "{}\n");
const previousSettingsFile = process.env.PI_SETTINGS_FILE;
process.env.PI_SETTINGS_FILE = settingsFile;
const frozen = freezePhase7({ cwd: root, output: path.join(freezeTmp, "freeze.json") });
if (previousSettingsFile === undefined) delete process.env.PI_SETTINGS_FILE;
else process.env.PI_SETTINGS_FILE = previousSettingsFile;
assert.equal(frozen.value.runtimeSourceHash, first.runtimeSourceHash, "freeze and benchmark use the same runtime fingerprint");
assert.equal(frozen.value.runtimeFileCount, first.runtimeFileCount);
assert.equal(fs.statSync(frozen.file).mode & 0o777, 0o600);
assert.equal(first.metrics.execution.falseSuccesses, 0);
assert.equal(first.metrics.execution.falseFailures, 0);
assert.equal(first.metrics.budgets.unreportedOverruns, 0);
assert.equal(first.metrics.tools.callResultParity, true);
assert.equal(first.metrics.policy.forbiddenToolCalls, 0);
assert.equal(first.metrics.policy.unavailableToolLaunches, 0);
assert.equal(first.metrics.isolation.parentMutationsBeforeApply, 0);
assert.equal(first.metrics.typedOutputs.succeededValidityRate, 1);
assert(first.metrics.readOnly.validCompletionRate >= 0.9);
assert(first.metrics.readOnly.timeoutRate <= 0.05);
assert(first.metrics.mutation.expectedPatchAndVerificationRate >= 0.9);
assert(first.metrics.router.precision >= 0.9);
assert(first.metrics.router.recall >= 0.9);
assert.equal(first.metrics.router.noAutoExecutionRate, 1);
assert(first.metrics.latency.readOnly.total.p95 < 120000);
assert.equal(first.metrics.privacy.findings, 0);
assert.equal(first.promotion.overallPassed, true);
assert.equal(first.promotion.maxEligibleStage, "R4", "deterministic gates authorize advisory promotion but not optional delegation");
for (const gate of ["executionTruth", "budgetEnforcement", "toolDiagnostics", "policy", "isolation", "typedOutputs", "readOnlyReliability", "mutationReliability", "router", "latency", "privacy"]) assert.equal(first.promotion.gates[gate].passed, true, gate);
assert.equal(first.promotion.gates.realProjectPilot.passed, false);
assert.equal(evaluatePromotionBars({ ...first.metrics, execution: { ...first.metrics.execution, falseSuccesses: 1 } }).gates.executionTruth.passed, false);

assert.deepEqual(ROLLOUT_STAGES, ["R0", "R1", "R2", "R3", "R4", "R5"]);
const fieldEvidence = {
  schemaVersion: 1,
  benchmark: "role-field-evidence-v1",
  generatedAt: benchmarkNow,
  runtimeSourceHash: first.runtimeSourceHash,
  fixtureOnly: false,
  source: { activeSession: { requested: 1, matched: 1, excluded: 1 }, scanComplete: true, parseErrors: 0 },
  sample: { eligibleLiveReadOnly: 30 },
  cohort: { exact: true, distinctKeys: 1, key: "field-cohort" },
  gatePassed: true,
  maxEligibleStage: "R4",
};
const deterministicOnly = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: null });
assert.equal(deterministicOnly.effectiveStage, "R0", "fixture-only evidence cannot authorize field rollout");
assert.equal(deterministicOnly.fieldEvidenceStatus, "missing-or-invalid-field-evidence");

const promoted = resolveRoleRuntimeConfig({
  PI_ROLE_RUNTIME_VERSION: "2",
  PI_ROLE_MUTATION: "isolated",
  PI_TOPOLOGY_AUTO_ROUTE: "suggest",
  PI_ROLE_SIDECAR: "1",
  PI_ROLE_ROLLOUT_STAGE: "R5",
}, { benchmarkReport: first, fieldEvidenceReport: fieldEvidence });
assert.equal(promoted.selectedVersion, 2);
assert.equal(promoted.requestedStage, "R5");
assert.equal(promoted.effectiveStage, "R5");
assert.equal(promoted.stageAuthority, "configured-environment");
assert.equal(promoted.evidenceAuthorizedStage, "R4");
assert.equal(promoted.evidenceOverride, true);
assert.equal(promoted.promotionAuthorized, true);
assert.equal(promoted.stateMigrationRequired, false);
assert.equal(promoted.preserveV2StateOnRollback, true);

const benchmarkDefault = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: fieldEvidence });
assert.equal(benchmarkDefault.requestedStage, "R4", "qualifying deterministic plus live field evidence promotes only through the advisory ceiling by default");
assert.equal(benchmarkDefault.requestedStageSource, "benchmark-and-field-default");
assert.equal(benchmarkDefault.effectiveStage, "R4");
assert.equal(benchmarkDefault.promotionAuthorized, true);
assert.equal(benchmarkDefault.benchmarkEvidenceStatus, "current-benchmark-evidence");
assert.equal(benchmarkDefault.fieldEvidenceStatus, "current-live-field-evidence");
assert.equal(benchmarkDefault.fieldEligibleRuns, 30);
const configuredRouter = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2", PI_TOPOLOGY_AUTO_ROUTE: "shadow" }, { benchmarkReport: first, fieldEvidenceReport: fieldEvidence });
assert.equal(configuredRouter.requestedAutoRouteMode, "shadow");
assert.equal(configuredRouter.autoRouteMode, "shadow", "the configured router mode is authoritative");
const explicitDelegation = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2", PI_ROLE_MUTATION: "isolated", PI_ROLE_ROLLOUT_STAGE: "R5", PI_TOPOLOGY_AUTO_ROUTE: "delegate" }, { benchmarkReport: null, fieldEvidenceReport: null });
assert.equal(explicitDelegation.effectiveStage, "R5", "an explicit configured stage enables operator-authorized delegation without relabeling missing evidence");
assert.equal(explicitDelegation.autoRouteMode, "delegate");
assert.equal(explicitDelegation.evidenceAuthorizedStage, "R0");
assert.equal(explicitDelegation.evidenceOverride, true);
assert.equal(explicitDelegation.benchmarkEvidenceStatus, "missing-or-invalid-report");
assert.equal(explicitDelegation.fieldEvidenceStatus, "missing-or-invalid-field-evidence");
const insufficientField = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: { ...fieldEvidence, gatePassed: false, maxEligibleStage: "R0", sample: { eligibleLiveReadOnly: 29 } } });
assert.equal(insufficientField.effectiveStage, "R0");
assert.equal(insufficientField.fieldEvidenceStatus, "field-bars-failed-or-insufficient-sample");
const activeNotExcluded = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: { ...fieldEvidence, source: { ...fieldEvidence.source, activeSession: { requested: 1, matched: 0, excluded: 0 } } } });
assert.equal(activeNotExcluded.effectiveStage, "R0");
assert.equal(activeNotExcluded.fieldEvidenceStatus, "field-scan-incomplete-or-active-session-not-excluded");
const staleField = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: { ...fieldEvidence, generatedAt: "2020-01-01T00:00:00.000Z" } });
assert.equal(staleField.effectiveStage, "R0");
assert.equal(staleField.fieldEvidenceStatus, "stale-or-invalid-field-timestamp");
const wrongFieldSource = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: { ...fieldEvidence, runtimeSourceHash: "0".repeat(64) } });
assert.equal(wrongFieldSource.effectiveStage, "R0");
assert.equal(wrongFieldSource.fieldEvidenceStatus, "field-runtime-source-hash-mismatch");
const staleBenchmark = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: { ...first, generatedAt: "2020-01-01T00:00:00.000Z" }, fieldEvidenceReport: fieldEvidence });
assert.equal(staleBenchmark.effectiveStage, "R0", "stale evidence cannot authorize automatic promotion");
assert.equal(staleBenchmark.benchmarkEvidenceStatus, "stale-or-invalid-timestamp");
const futureBenchmark = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: first, fieldEvidenceReport: fieldEvidence, nowMs: Date.parse(benchmarkNow) - (10 * 60 * 1000) });
assert.equal(futureBenchmark.effectiveStage, "R0", "future-dated evidence beyond clock skew cannot authorize promotion");
assert.equal(futureBenchmark.benchmarkEvidenceStatus, "stale-or-invalid-timestamp");
const wrongManifest = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: { ...first, manifestHash: "0".repeat(64) }, fieldEvidenceReport: fieldEvidence });
assert.equal(wrongManifest.effectiveStage, "R0", "benchmark evidence must match the current fixture manifest");
assert.equal(wrongManifest.benchmarkEvidenceStatus, "manifest-hash-mismatch");
const wrongSource = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: { ...first, runtimeSourceHash: "0".repeat(64) }, fieldEvidenceReport: fieldEvidence });
assert.equal(wrongSource.effectiveStage, "R0", "benchmark evidence must match the current runtime source");
assert.equal(wrongSource.benchmarkEvidenceStatus, "runtime-source-hash-mismatch");
const containmentDefault = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: null });
assert.equal(containmentDefault.requestedStage, "R0");
assert.equal(containmentDefault.requestedStageSource, "containment-default");
assert.equal(containmentDefault.effectiveStage, "R0", "missing benchmark evidence remains contained");
assert.equal(containmentDefault.autoRouteMode, "off", "library auto-routing defaults fail closed when harness defaults are not loaded");
const invalidRouter = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2", PI_TOPOLOGY_AUTO_ROUTE: "invalid" }, { benchmarkReport: null, fieldEvidenceReport: null });
assert.equal(invalidRouter.autoRouteMode, "off", "invalid router configuration also fails closed");
assert.equal(containmentDefault.workerShadowCanaryEnabled, false, "library config remains opt-in when harness defaults are not loaded");
const canaryDefault = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2", PI_ROLE_WORKER_SHADOW_CANARY: "1" }, { benchmarkReport: null });
assert.equal(canaryDefault.workerShadowCanaryEnabled, true, "the guarded harness flag enables the worker shadow canary without promoting rollout");
assert.equal(canaryDefault.effectiveStage, "R0");
const failedBenchmark = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2" }, { benchmarkReport: { benchmark: "pi-role-runtime-v2", schemaVersion: 1, manifestHash: "failed", promotion: { overallPassed: false, maxEligibleStage: "R5" } } });
assert.equal(failedBenchmark.requestedStageSource, "containment-default");
assert.equal(failedBenchmark.eligibleStage, "R0");
assert.equal(failedBenchmark.effectiveStage, "R0", "a failed or internally inconsistent report cannot authorize automatic promotion");
assert.equal(failedBenchmark.benchmarkReport, null);
const explicitRollback = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2", PI_ROLE_ROLLOUT_STAGE: "R0" }, { benchmarkReport: first, fieldEvidenceReport: fieldEvidence });
assert.equal(explicitRollback.requestedStageSource, "environment");
assert.equal(explicitRollback.effectiveStage, "R0", "explicit stage rollback wins immediately");

const rollback = resolveRoleRuntimeConfig({
  PI_ROLE_RUNTIME_VERSION: "1",
  PI_ROLE_MUTATION: "off",
  PI_TOPOLOGY_AUTO_ROUTE: "off",
  PI_ROLE_SIDECAR: "0",
  PI_ROLE_ROLLOUT_STAGE: "R0",
});
assert.equal(rollback.selectedVersion, 1);
assert.equal(rollback.compatibilityMode, "legacy-v1");
assert.equal(rollback.mutationMode, "off");
assert.equal(rollback.autoRouteMode, "off");
assert.equal(rollback.sidecarEnabled, false);
assert.equal(rollback.stateMigrationRequired, false);
assert.throws(() => assertRoleRuntimeExecutionAllowed({ config: rollback, topology: { roleRuntimeVersion: 2, nodes: [] } }), /disabled|version 1/i);
assert.throws(() => assertRoleRuntimeExecutionAllowed({ config: { ...promoted, mutationMode: "off" }, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "coder" }] } }), /mutation.*off/i);
assert.doesNotThrow(() => assertRoleRuntimeExecutionAllowed({ config: explicitDelegation, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "coder" }] }, enforceRollout: true }), "configured R5 plus isolated mutation enables mutating role execution");
assert.throws(() => assertRoleRuntimeExecutionAllowed({ config: { ...promoted, effectiveStage: "R0", fixtureExecution: false, fieldPilotEnabled: false }, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "reviewer" }] }, enforceRollout: true }), /R0|fixture|pilot/i);
assert.doesNotThrow(() => assertRoleRuntimeExecutionAllowed({ config: { ...promoted, effectiveStage: "R0", fixtureExecution: true }, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "reviewer" }] }, enforceRollout: true }));
assert.doesNotThrow(() => assertRoleRuntimeExecutionAllowed({ config: { ...promoted, effectiveStage: "R0", fixtureExecution: false, fieldPilotEnabled: true }, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "reviewer" }] }, enforceRollout: true }), "explicit R0 field pilot permits only read-only execution");
assert.throws(() => assertRoleRuntimeExecutionAllowed({ config: { ...promoted, effectiveStage: "R0", fixtureExecution: false, fieldPilotEnabled: true }, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "coder" }] }, enforceRollout: true }), /R0|pilot/i);
assert.throws(() => assertRoleRuntimeExecutionAllowed({ config: { ...promoted, effectiveStage: "R1" }, topology: { roleRuntimeVersion: 2, nodes: [{ roleId: "coder" }] }, enforceRollout: true }), /R2/i);

const marker = "PRIVATE_PROMPT_TRANSCRIPT_FILE_BODY_MUST_NOT_SURVIVE";
const compact = sanitizeRoleRunRecord({
  schemaVersion: 4,
  roleRunSchemaVersion: 4,
  roleRuntimeVersion: 2,
  contractVersion: "role-v2",
  resultSchemaVersion: 2,
  runtimeSourceHash: first.runtimeSourceHash,
  at: "2026-07-22T00:00:00.000Z",
  source: "benchmark",
  roleId: "reviewer",
  status: "succeeded",
  terminalCategory: "succeeded",
  typedResultValid: true,
  accountingValid: true,
  mutationMode: "shared-readonly",
  fixture: false,
  eligibleLive: true,
  eligibilityReason: "eligible-live-read-only",
  taskHash: "a".repeat(64),
  resultHash: "b".repeat(64),
  selectedModel: "openai-codex/gpt-5.6-sol",
  effectiveModel: "openai-codex/gpt-5.6-sol",
  modelPolicySource: "environment",
  selectedThinkingLevel: "xhigh",
  effectiveThinkingLevel: "xhigh",
  thinkingPolicySource: "environment",
  budget: { maxModelCalls: 2, maxToolCalls: 4, prompt: marker },
  termination: { code: "submitted", stopReason: "stop", message: marker },
  toolPolicy: { allowedTools: ["read"], deniedTools: ["write"], prompt: marker },
  workspace: { policy: "shared-readonly", retained: false, pathHash: null, changedPaths: [], fileBody: marker },
  prompt: marker,
  transcript: marker,
  messages: [{ content: marker }],
  fileBody: marker,
  diagnostics: { content: marker },
});
assert(Object.keys(compact).every((key) => ROLE_RUN_FIELDS.includes(key)));
assert.equal(JSON.stringify(compact).includes(marker), false);
assert.deepEqual(compact.budget, { maxModelCalls: 2, maxToolCalls: 4 });
assert.deepEqual(compact.termination, { code: "submitted", stopReason: "stop" });
assert.deepEqual({ roleRunSchemaVersion: compact.roleRunSchemaVersion, terminalCategory: compact.terminalCategory, typedResultValid: compact.typedResultValid, accountingValid: compact.accountingValid, mutationMode: compact.mutationMode, eligibleLive: compact.eligibleLive }, { roleRunSchemaVersion: 4, terminalCategory: "succeeded", typedResultValid: true, accountingValid: true, mutationMode: "shared-readonly", eligibleLive: true });
assert.deepEqual({ selectedModel: compact.selectedModel, effectiveModel: compact.effectiveModel, selectedThinkingLevel: compact.selectedThinkingLevel, effectiveThinkingLevel: compact.effectiveThinkingLevel, thinkingPolicySource: compact.thinkingPolicySource }, { selectedModel: "openai-codex/gpt-5.6-sol", effectiveModel: "openai-codex/gpt-5.6-sol", selectedThinkingLevel: "xhigh", effectiveThinkingLevel: "xhigh", thinkingPolicySource: "environment" });

const failedOutcome = compactRoleToolOutcome({
  schemaVersion: 2,
  contractVersion: "role-v2",
  subagent_id: "sub_failed",
  role: "reviewer",
  status: "failed",
  termination: { code: "provider_error", stopReason: "error", message: marker },
  summary: "Role failed at the provider boundary.",
  task: marker,
  final_response: marker,
  diagnostics: { modelCalls: 1, toolCalls: 0, errors: [{ message: marker }] },
});
assert.equal(failedOutcome.status, "failed");
assert.deepEqual(failedOutcome.termination, { code: "provider_error", stopReason: "error" });
assert.equal(JSON.stringify(failedOutcome).includes(marker), false, "model-facing role outcomes omit tasks, raw child output, and diagnostic bodies");
const privateSummary = compactRoleToolOutcome({ status: "succeeded", summary: `Result at /home/synthetic/private with ${["sk", "-", "R".repeat(24)].join("")}`, termination: { code: "submitted" } });
assert(!privateSummary.summary.includes("/home/synthetic") && !privateSummary.summary.includes("sk-"), "model-facing role summaries redact secrets and absolute paths");
const failedToolEvent = { toolName: "create_subagent", content: [{ type: "text", text: JSON.stringify(failedOutcome) }], details: { executed: true, status: failedOutcome.status, termination: failedOutcome.termination, result: failedOutcome }, isError: false };
assert.deepEqual(roleToolResultOverride(failedToolEvent), { content: failedToolEvent.content, details: failedToolEvent.details, isError: true }, "semantic role failure becomes an error tool result without losing canonical metadata");
assert.equal(roleToolResultOverride({ ...failedToolEvent, details: { executed: true, result: { ...failedOutcome, status: "succeeded" } } }), undefined);
assert.equal(roleToolResultOverride({ toolName: "create_subagent", details: { status: "failed", result: failedOutcome }, content: [] }), undefined, "status inspection is not misclassified as execution failure");
assert.equal(roleToolResultOverride({ toolName: "run_topology", details: { status: "failed" }, content: [] })?.isError, true, "failed child-backed topologies are not counted as successful tools");
assert.equal(roleToolResultOverride({ toolName: "run_topology", details: { status: "timed_out" }, content: [] })?.isError, true, "timed-out mutation/topology results are never counted as successful tools");

const outputRoot = tmpFixture("pi-role-benchmark-");
const output = path.join(outputRoot, "nested", "report.json");
execFileSync(process.execPath, [path.join(root, "scripts", "benchmark-role-runtime.js"), "--fixture-only", "--manifest", manifest, "--output", output], { cwd: root, stdio: "pipe" });
assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
assert.equal(fs.statSync(output).mode & 0o777, 0o600);
const saved = JSON.parse(fs.readFileSync(output, "utf8"));
assert.equal(saved.promotion.overallPassed, true);
assert.equal(JSON.stringify(saved).includes("synthetic provider failure"), false, "reports never copy transcript/error bodies");

const reasoningSource = fs.readFileSync(path.join(root, ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
const topologySource = fs.readFileSync(path.join(root, "src", "multi-agent-topologies.js"), "utf8");
const doctorSource = fs.readFileSync(path.join(root, ".pi", "extensions", "runtime-doctor", "index.ts"), "utf8");
assert(reasoningSource.includes("resolveRoleRuntimeConfig") && reasoningSource.includes("ROLE_MUTATION_MODE"));
assert(fs.readFileSync(path.join(root, "src", "role-runtime-rollout.js"), "utf8").includes("PI_ROLE_MUTATION"));
assert(topologySource.includes("assertRoleRuntimeExecutionAllowed"));
assert(doctorSource.includes("roleRuntimeReport") && doctorSource.includes("compatibilityMode"));

console.log("role runtime benchmark tests passed");
