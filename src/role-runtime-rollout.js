"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256, runtimeSourceFingerprint } = require("./runtime-source-fingerprint");

const ROLLOUT_STAGES = Object.freeze(["R0", "R1", "R2", "R3", "R4", "R5"]);
const AUTO_ROUTE_MODES = new Set(["off", "suggest", "shadow", "delegate"]);
const MUTATING_ROLES = new Set(["coder", "refactorer", "verifier", "benchmark", "memory-curator", "tool-specialist"]);
const DEFAULT_BENCHMARK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FIELD_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BENCHMARK_FUTURE_SKEW_MS = 5 * 60 * 1000;
const runtimeHashCache = new Map();
const manifestHashCache = new Map();

function readSafeJson(file) {
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}
function readBenchmarkReport(file) {
  const value = readSafeJson(file);
  return value?.benchmark === "pi-role-runtime-v2" && value?.schemaVersion === 1 ? value : null;
}
function readFieldEvidenceReport(file) {
  const value = readSafeJson(file);
  const report = value?.fieldEvidence || value;
  return report?.benchmark === "role-field-evidence-v1" && report?.schemaVersion === 1 ? report : null;
}
function normalizeStage(value, fallback = "R0") { const stage = String(value || fallback).toUpperCase(); return ROLLOUT_STAGES.includes(stage) ? stage : fallback; }
function normalizeVersion(value) { return String(value || "2") === "1" ? 1 : 2; }
function normalizeMutation(value, version) { if (version === 1) return "off"; return String(value || "isolated") === "off" ? "off" : "isolated"; }
function normalizeAutoRoute(value) { const mode = String(value || "off").toLowerCase(); return mode === "run" ? "shadow" : AUTO_ROUTE_MODES.has(mode) ? mode : "off"; }
function stageAtMost(requested, eligible) { return ROLLOUT_STAGES[Math.min(ROLLOUT_STAGES.indexOf(requested), ROLLOUT_STAGES.indexOf(eligible))]; }
function fileJsonHash(file) {
  const absolute = path.resolve(file);
  if (manifestHashCache.has(absolute)) return manifestHashCache.get(absolute);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("benchmark manifest is unsafe");
  const value = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const hash = sha256(value);
  manifestHashCache.set(absolute, hash);
  return hash;
}
function currentRuntimeHash(cwd) {
  const root = path.resolve(cwd || process.cwd());
  if (!runtimeHashCache.has(root)) runtimeHashCache.set(root, runtimeSourceFingerprint(root).hash);
  return runtimeHashCache.get(root);
}
function validateBenchmarkReport(report, options = {}) {
  if (!report || report.benchmark !== "pi-role-runtime-v2" || report.schemaVersion !== 1) return { ok: false, reason: "missing-or-invalid-report" };
  if (report.promotion?.overallPassed !== true || !ROLLOUT_STAGES.includes(report.promotion?.maxEligibleStage)) return { ok: false, reason: "promotion-bars-failed" };
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const generatedMs = Date.parse(String(report.generatedAt || ""));
  const requestedMaxAge = Number(options.maxAgeMs ?? process.env.PI_ROLE_RUNTIME_BENCHMARK_MAX_AGE_MS ?? DEFAULT_BENCHMARK_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(requestedMaxAge) && requestedMaxAge > 0 ? requestedMaxAge : DEFAULT_BENCHMARK_MAX_AGE_MS;
  if (!Number.isFinite(generatedMs) || generatedMs > nowMs + MAX_BENCHMARK_FUTURE_SKEW_MS || nowMs - generatedMs > maxAgeMs) return { ok: false, reason: "stale-or-invalid-timestamp" };
  const root = path.resolve(options.cwd || process.cwd());
  try {
    const manifestFile = options.benchmarkManifestPath || path.join(root, "tests", "fixtures", "role-runtime", "manifest.json");
    const expectedManifestHash = options.expectedBenchmarkManifestHash || fileJsonHash(manifestFile);
    if (!report.manifestHash || report.manifestHash !== expectedManifestHash) return { ok: false, reason: "manifest-hash-mismatch" };
    const expectedRuntimeSourceHash = options.runtimeSourceHash || currentRuntimeHash(root);
    if (!report.runtimeSourceHash || report.runtimeSourceHash !== expectedRuntimeSourceHash) return { ok: false, reason: "runtime-source-hash-mismatch" };
  } catch { return { ok: false, reason: "benchmark-evidence-unverifiable" }; }
  return { ok: true, reason: "current-benchmark-evidence" };
}

function validateFieldEvidenceReport(report, options = {}) {
  if (!report || report.benchmark !== "role-field-evidence-v1" || report.schemaVersion !== 1) return { ok: false, reason: "missing-or-invalid-field-evidence" };
  if (report.fixtureOnly !== false || report.gatePassed !== true || Number(report.sample?.eligibleLiveReadOnly || 0) < 30 || report.maxEligibleStage !== "R4") return { ok: false, reason: "field-bars-failed-or-insufficient-sample" };
  if (report.source?.activeSession?.requested !== 1 || report.source?.activeSession?.matched !== 1 || report.source?.activeSession?.excluded !== 1 || report.source?.scanComplete !== true || Number(report.source?.parseErrors || 0) !== 0) return { ok: false, reason: "field-scan-incomplete-or-active-session-not-excluded" };
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const generatedMs = Date.parse(String(report.generatedAt || ""));
  const requestedMaxAge = Number(options.maxAgeMs ?? process.env.PI_ROLE_RUNTIME_FIELD_MAX_AGE_MS ?? DEFAULT_FIELD_EVIDENCE_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(requestedMaxAge) && requestedMaxAge > 0 ? requestedMaxAge : DEFAULT_FIELD_EVIDENCE_MAX_AGE_MS;
  if (!Number.isFinite(generatedMs) || generatedMs > nowMs + MAX_BENCHMARK_FUTURE_SKEW_MS || nowMs - generatedMs > maxAgeMs) return { ok: false, reason: "stale-or-invalid-field-timestamp" };
  const expectedRuntimeSourceHash = options.runtimeSourceHash || currentRuntimeHash(options.cwd || process.cwd());
  if (!report.runtimeSourceHash || report.runtimeSourceHash !== expectedRuntimeSourceHash) return { ok: false, reason: "field-runtime-source-hash-mismatch" };
  if (report.cohort?.exact !== true || report.cohort?.distinctKeys !== 1) return { ok: false, reason: "field-cohort-mismatch" };
  return { ok: true, reason: "current-live-field-evidence" };
}

function resolveRoleRuntimeConfig(env = process.env, options = {}) {
  const selectedVersion = normalizeVersion(env.PI_ROLE_RUNTIME_VERSION);
  const benchmarkReportPath = options.benchmarkReportPath || env.PI_ROLE_RUNTIME_BENCHMARK_REPORT || path.join(".pi", "role-runtime", "benchmarks", "latest.json");
  const benchmarkReport = Object.prototype.hasOwnProperty.call(options, "benchmarkReport") ? options.benchmarkReport : readBenchmarkReport(path.resolve(options.cwd || process.cwd(), benchmarkReportPath));
  const benchmarkValidation = validateBenchmarkReport(benchmarkReport, {
    ...options,
    cwd: options.cwd || process.cwd(),
    maxAgeMs: options.maxAgeMs ?? env.PI_ROLE_RUNTIME_BENCHMARK_MAX_AGE_MS,
  });
  const fieldEvidenceReportPath = options.fieldEvidenceReportPath || env.PI_ROLE_RUNTIME_FIELD_REPORT || path.join(".pi", "role-runtime", "audits", "latest.json");
  const fieldEvidenceReport = Object.prototype.hasOwnProperty.call(options, "fieldEvidenceReport") ? options.fieldEvidenceReport : readFieldEvidenceReport(path.resolve(options.cwd || process.cwd(), fieldEvidenceReportPath));
  const fieldEvidenceValidation = validateFieldEvidenceReport(fieldEvidenceReport, { ...options, cwd: options.cwd || process.cwd(), maxAgeMs: options.fieldMaxAgeMs ?? env.PI_ROLE_RUNTIME_FIELD_MAX_AGE_MS });
  const benchmarkEligible = benchmarkValidation.ok;
  const fieldEligible = fieldEvidenceValidation.ok;
  const eligibleStage = benchmarkEligible && fieldEligible ? stageAtMost(benchmarkReport.promotion.maxEligibleStage, fieldEvidenceReport.maxEligibleStage) : "R0";
  const benchmarkDefaultStage = stageAtMost(eligibleStage, "R4");
  const explicitStageSelection = Object.prototype.hasOwnProperty.call(env, "PI_ROLE_ROLLOUT_STAGE");
  const requestedStageSource = explicitStageSelection ? "environment" : benchmarkEligible && fieldEligible ? "benchmark-and-field-default" : "containment-default";
  const requestedStage = normalizeStage(env.PI_ROLE_ROLLOUT_STAGE, requestedStageSource === "benchmark-and-field-default" ? benchmarkDefaultStage : "R0");
  const evidenceAuthorizedStage = stageAtMost(requestedStage, eligibleStage);
  const effectiveStage = selectedVersion === 1 ? "R0" : explicitStageSelection ? requestedStage : evidenceAuthorizedStage;
  const promotionAuthorized = requestedStage === effectiveStage;
  return {
    schemaVersion: 1,
    selectedVersion,
    compatibilityMode: selectedVersion === 1 ? "legacy-v1" : "current-v2",
    mutationMode: normalizeMutation(env.PI_ROLE_MUTATION, selectedVersion),
    autoRouteMode: normalizeAutoRoute(env.PI_TOPOLOGY_AUTO_ROUTE || env.PI_AUTO_ROLES),
    requestedAutoRouteMode: normalizeAutoRoute(env.PI_TOPOLOGY_AUTO_ROUTE || env.PI_AUTO_ROLES),
    sidecarEnabled: env.PI_ROLE_SIDECAR !== "0",
    workerShadowCanaryEnabled: env.PI_ROLE_WORKER_SHADOW_CANARY === "1",
    requestedStage,
    requestedStageSource,
    stageAuthority: selectedVersion === 1 ? "runtime-v1-rollback" : explicitStageSelection ? "configured-environment" : requestedStageSource,
    eligibleStage,
    evidenceAuthorizedStage,
    evidenceOverride: selectedVersion === 2 && explicitStageSelection && requestedStage !== evidenceAuthorizedStage,
    effectiveStage,
    promotionAuthorized,
    promotionReason: promotionAuthorized ? null : selectedVersion === 1 ? "runtime version 1 rollback forces R0" : `benchmark report authorizes ${eligibleStage}, not ${requestedStage}`,
    benchmarkReport: benchmarkEligible ? benchmarkReportPath : null,
    benchmarkManifestHash: benchmarkEligible ? benchmarkReport.manifestHash || null : null,
    benchmarkRuntimeSourceHash: benchmarkEligible ? benchmarkReport.runtimeSourceHash || null : null,
    benchmarkEvidenceStatus: benchmarkValidation.reason,
    fieldEvidenceReport: fieldEligible ? fieldEvidenceReportPath : null,
    fieldEvidenceStatus: fieldEvidenceValidation.reason,
    fieldEligibleRuns: fieldEvidenceReport?.sample?.eligibleLiveReadOnly || 0,
    fieldPilotEnabled: env.PI_ROLE_FIELD_PILOT === "1",
    fixtureOnlyAtR0: selectedVersion === 2 && effectiveStage === "R0" && env.PI_ROLE_FIELD_PILOT !== "1",
    fixtureExecution: Boolean(env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT || env.PI_ROLE_RUNTIME_FIXTURE === "1"),
    stateMigrationRequired: false,
    preserveV2StateOnRollback: true,
  };
}

function topologyMutates(topology = {}) {
  return (topology.nodes || []).some((node) => MUTATING_ROLES.has(node.roleId || node.role) || node.workspacePolicy === "isolated-worktree" || node.mutationPolicy && node.mutationPolicy !== "forbidden");
}
function topologyUsesSidecar(topology = {}) { return (topology.nodes || []).some((node) => (node.executionMode || "handler") === "subagent"); }
function assertRoleRuntimeExecutionAllowed({ config = resolveRoleRuntimeConfig(), topology = {}, enforceRollout = false } = {}) {
  const roleV2 = Number(topology.roleRuntimeVersion) === 2 || topology.contractVersion === "role-v2";
  const mutating = topologyMutates(topology);
  if (roleV2 && config.selectedVersion === 1) {
    const error = new Error("role runtime v2 execution is disabled while PI_ROLE_RUNTIME_VERSION=1");
    error.code = "ROLE_RUNTIME_V2_DISABLED";
    throw error;
  }
  if (enforceRollout && roleV2 && config.effectiveStage === "R0" && !config.fixtureExecution && !(config.fieldPilotEnabled === true && !mutating)) {
    const error = new Error("role runtime v2 live execution is disabled at rollout R0; use an explicit read-only field pilot or fixture evidence");
    error.code = "ROLE_ROLLOUT_STAGE_BLOCKED";
    throw error;
  }
  if (enforceRollout && mutating && config.effectiveStage === "R1") {
    const error = new Error("mutating role execution requires rollout R2 or later");
    error.code = "ROLE_ROLLOUT_STAGE_BLOCKED";
    throw error;
  }
  if (enforceRollout && mutating && (topology.nodes || []).length > 1 && config.effectiveStage === "R2") {
    const error = new Error("mutating topology execution requires rollout R3 or later");
    error.code = "ROLE_ROLLOUT_STAGE_BLOCKED";
    throw error;
  }
  if (mutating && config.mutationMode === "off") {
    const error = new Error("role mutation is off; set PI_ROLE_MUTATION=isolated for explicit isolated execution");
    error.code = "ROLE_MUTATION_DISABLED";
    throw error;
  }
  if (topologyUsesSidecar(topology) && !config.sidecarEnabled) {
    const error = new Error("role sidecar execution is disabled by PI_ROLE_SIDECAR=0");
    error.code = "ROLE_SIDECAR_DISABLED";
    throw error;
  }
  return { allowed: true, selectedVersion: config.selectedVersion, mutationMode: config.mutationMode, sidecarEnabled: config.sidecarEnabled };
}

function summarizeRoleStateSplit({ roleRecords = [], topologyRuns = [] } = {}) {
  const rows = [...roleRecords, ...topologyRuns];
  const currentV2 = rows.filter((row) => Number(row.roleRuntimeVersion) === 2 || row.contractVersion === "role-v2" || Number(row.resultSchemaVersion) === 2).length;
  return { currentV2, legacy: rows.length - currentV2, total: rows.length, split: currentV2 > 0 && currentV2 < rows.length };
}

module.exports = {
  ROLLOUT_STAGES,
  MUTATING_ROLES,
  DEFAULT_BENCHMARK_MAX_AGE_MS,
  DEFAULT_FIELD_EVIDENCE_MAX_AGE_MS,
  readBenchmarkReport,
  readFieldEvidenceReport,
  validateBenchmarkReport,
  validateFieldEvidenceReport,
  normalizeStage,
  resolveRoleRuntimeConfig,
  topologyMutates,
  assertRoleRuntimeExecutionAllowed,
  summarizeRoleStateSplit,
};
