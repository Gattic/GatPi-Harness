"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { scanExtensionRegistry } = require("./extension-registry");
const { readExtensionTelemetry } = require("./extension-telemetry");
const { portfolioReport } = require("./extension-portfolio");
const { resolveRoleRuntimeConfig } = require("./role-runtime-rollout");
const { projectMemoryRuntimeConfig } = require("./project-memory-runtime");
const { CompoundingEffectivenessAdapter } = require("./compounding-effectiveness");
const { listThreadSummaries } = require("./debug-ledger");
const { listExperimentSummaries, experimentLedgerCoverage } = require("./experiment-ledger");
const { listRunSummaries } = require("./run-deck");
const { EvidenceStore } = require("./evidence-binder");
const { VisualVerificationAdapter } = require("./visual-verification");
const { captureTreeFingerprint, compareTreeFingerprint, treeFingerprintSummary } = require("./tree-fingerprint");

const ROLLOUT_CENTER_SCHEMA_VERSION = 1;
const MAX_CAPABILITIES = 32;
const MAX_PROVENANCE = 16;
const MAX_OPERATIONS = 25;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FORBIDDEN_KEY = /(?:prompt|transcript|reasoning|command|args|stdout|stderr|output|content|body|path|cwd|secret|token|password|note|hypothesis|title|summary|message)/i;
const PRIVACY_ASSERTION_KEYS = new Set(["containsImageBodies", "containsTranscripts", "containsReasoning", "containsRawOutputs", "containsSecrets", "containsAbsolutePaths"]);
const ABSOLUTE_PATH_VALUE = new RegExp("(?:^|[\\s\"'])(?:/[^\\s\"']+|[A-Za-z]:\\\\\\\\)");

function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function safeId(value, prefix = "ref") { const text = String(value || "").trim(); return SAFE_ID.test(text) ? text : `${prefix}_${hash(text || prefix).slice(0, 20)}`; }
function readJson(file, fallback = null, maxBytes = 4 * 1024 * 1024) {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function countBy(items, field) { const out = {}; for (const item of items) out[item?.[field] || "unknown"] = (out[item?.[field] || "unknown"] || 0) + 1; return out; }
function freshness(generatedAt, maxAgeMs, now = Date.now()) {
  const value = Date.parse(String(generatedAt || ""));
  if (!Number.isFinite(value)) return "unknown";
  if (value > now + 5 * 60_000) return "future-dated";
  return now - value > maxAgeMs ? "stale-time" : "current";
}
function provenance(sourceId, recordType, input = {}) {
  const ref = `rollout:${safeId(sourceId, "source")}:${safeId(input.recordId || recordType, "record")}`;
  return { ref, sourceId: safeId(sourceId, "source"), recordType: safeId(recordType, "record"), schemaVersion: Number(input.schemaVersion) || null, generatedAt: input.generatedAt || null, fingerprint: input.fingerprint ? safeId(input.fingerprint, "fingerprint") : null, evidenceRef: input.evidenceRef ? safeId(input.evidenceRef, "evidence") : null, freshness: input.freshness || "unknown" };
}
function nextObservation(actionCode, surfaceId, status = "permitted", prohibitedEffects = []) { return { status, actionCode, surfaceId, prohibitedEffects: [...new Set(prohibitedEffects)].slice(0, 12) }; }
function rollback(status, controlIds) { return { status, controlIds: controlIds.map((item) => safeId(item, "control")).slice(0, 16), reasonCodes: [] }; }
function technical(status, reasonCodes = []) { return { status, reasonCodes: reasonCodes.map((item) => safeId(item, "reason")).slice(0, 16) }; }
function policy(status, mutationAllowed, automationAllowed, reasonCodes = []) { return { status, mutationAllowed: mutationAllowed === true, automationAllowed: automationAllowed === true, reasonCodes: reasonCodes.map((item) => safeId(item, "reason")).slice(0, 16) }; }
function proof(status, input = {}) { return { status, evidenceClass: input.evidenceClass ? safeId(input.evidenceClass, "class") : null, sampleSize: Math.max(0, Number(input.sampleSize) || 0), observedDays: Math.max(0, Number(input.observedDays) || 0), exactIdentity: input.exactIdentity === true, lastObservedAt: input.lastObservedAt || null, evidenceRefs: (input.evidenceRefs || []).map((item) => safeId(item, "evidence")).slice(0, 32), reasonCodes: (input.reasonCodes || []).map((item) => safeId(item, "reason")).slice(0, 16) }; }

function roleCapability(cwd, env) {
  const state = resolveRoleRuntimeConfig(env, { cwd });
  const fieldPassed = state.fieldEvidenceStatus === "current-live-field-evidence";
  const workerCanaryActive = state.selectedVersion === 2 && state.workerShadowCanaryEnabled === true && state.fieldPilotEnabled === true && state.effectiveStage === "R0" && state.autoRouteMode === "suggest" && state.mutationMode === "off" && state.sidecarEnabled === true;
  return {
    capabilityId: "role-runtime", currentStage: state.effectiveStage,
    technicalReadiness: technical(state.selectedVersion === 2 && state.sidecarEnabled ? "ready" : "degraded", [state.compatibilityMode, state.sidecarEnabled ? "sidecar-enabled" : "sidecar-disabled"]),
    policyAuthorization: policy(state.effectiveStage === "R0" ? "read-only" : state.mutationMode === "off" ? "advisory-only" : "authorized", state.mutationMode !== "off" && !["R0", "R1"].includes(state.effectiveStage), workerCanaryActive, [state.evidenceOverride ? "configured-stage-authority" : state.promotionAuthorized ? "requested-stage-authorized" : "requested-stage-clamped", state.autoRouteMode, workerCanaryActive ? "worker-shadow-canary" : "generic-automatic-routing-blocked"]),
    fieldProof: proof(fieldPassed ? "passed" : "insufficient-data", { evidenceClass: fieldPassed ? "exact-version-field" : "deterministic", sampleSize: state.fieldEligibleRuns, exactIdentity: fieldPassed, reasonCodes: [state.benchmarkEvidenceStatus, state.fieldEvidenceStatus], evidenceRefs: [state.benchmarkManifestHash].filter(Boolean) }),
    rollbackControl: rollback("available", ["PI_ROLE_ROLLOUT_STAGE", "PI_ROLE_RUNTIME_VERSION", "PI_ROLE_MUTATION", "PI_ROLE_WORKER_SHADOW_CANARY", "PI_TOPOLOGY_AUTO_ROUTE"]),
    nextObservation: nextObservation(fieldPassed ? "review-role-field-proof" : "collect-role-readonly-field", fieldPassed ? "role-runtime-status" : "role-field-pilot", "permitted", ["role-mutation", "generic-automatic-routing", "stage-promotion"]),
    provenance: [provenance("role-runtime", "rollout", { schemaVersion: state.schemaVersion, recordId: state.effectiveStage, fingerprint: state.benchmarkRuntimeSourceHash, freshness: fieldPassed ? "current" : "unknown" })],
  };
}

function memoryCapability(cwd, env) {
  const runtime = projectMemoryRuntimeConfig(cwd, env);
  const rollout = runtime.rollout;
  const scoreFresh = runtime.scorecard.fresh === true;
  return {
    capabilityId: "project-memory", currentStage: rollout.effectiveStage,
    technicalReadiness: technical(runtime.readiness?.projectMemoryReads?.ready ? "ready" : "degraded", [runtime.selection?.ambiguous ? "vault-selection-ambiguous" : runtime.selection?.exists ? "vault-present" : "vault-unavailable", scoreFresh ? "scorecard-current" : "scorecard-stale"]),
    policyAuthorization: policy(rollout.controls.explicitWrites ? "authorized" : rollout.controls.reads ? "read-only" : "advisory-only", rollout.controls.explicitWrites, rollout.controls.automaticVerifiedUpserts, [rollout.promotionBlocked ? "requested-stage-clamped" : "stage-authorized", rollout.controls.diagnosticCapture ? "diagnostic-capture-enabled" : "diagnostic-capture-disabled", rollout.decision]),
    fieldProof: proof(scoreFresh && rollout.effectiveStage === "M5" ? "passed" : scoreFresh ? "insufficient-data" : "stale", { evidenceClass: "exact-version-field", exactIdentity: rollout.effectiveStage === "M5", evidenceRefs: [runtime.scorecard.manifestHash].filter(Boolean), reasonCodes: runtime.scorecard.freshnessReasons }),
    rollbackControl: rollback("available", ["PI_PROJECT_MEMORY_STAGE", "PI_PROJECT_MEMORY", "PI_PROJECT_MEMORY_DIAGNOSTICS", "PI_PROJECT_MEMORY_WRITES", "PI_PROJECT_MEMORY_AUTO_SAVE"]),
    nextObservation: nextObservation(scoreFresh ? "collect-project-memory-field" : "refresh-project-memory-scorecard", scoreFresh ? "memory-scorecard" : "memory-effectiveness-report", "permitted", ["automatic-memory-write", "stage-promotion", "retention-apply"]),
    provenance: [provenance("project-memory", "scorecard", { schemaVersion: runtime.scorecard.schemaVersion, recordId: runtime.scorecard.manifestHash || "missing", fingerprint: runtime.scorecard.sourceRevision, evidenceRef: runtime.scorecard.manifestHash, freshness: scoreFresh ? "current" : "stale-time" })],
  };
}

function compoundingCapability(cwd, enabled) {
  const state = new CompoundingEffectivenessAdapter({ enabled, cwd }).status();
  const latest = state.latest;
  const gateEntries = Object.entries(latest?.gateStatuses || {}).filter(([gate]) => /^C[0-5]$/.test(gate)).sort((a, b) => a[0].localeCompare(b[0]));
  const gateStatuses = gateEntries.map(([, status]) => status);
  const hasNull = gateStatuses.includes("null-result");
  const passed = gateEntries.length === 6 && gateEntries.every(([, status]) => status === "pass");
  const currentStage = gateEntries.at(-1)?.[0] || "C0";
  return {
    capabilityId: "compounding-effectiveness", currentStage,
    technicalReadiness: technical(state.enabled ? "ready" : "blocked", [state.enabled ? "adapter-enabled" : "adapter-disabled"]),
    policyAuthorization: policy("advisory-only", false, false, ["field-rollout-not-authorized", "project-memory-stage-unchanged"]),
    fieldProof: proof(passed ? "passed" : hasNull ? "null-result" : "insufficient-data", { evidenceClass: "exact-version-field", exactIdentity: passed, lastObservedAt: latest?.generatedAt || null, evidenceRefs: [latest?.scorecardId].filter(Boolean), reasonCodes: gateStatuses.length ? gateStatuses : ["scorecard-missing"] }),
    rollbackControl: rollback("available", ["PI_COMPOUNDING_EFFECTIVENESS_ENABLED", "PI_EXECUTION_OUTCOME_LEARNING", "PI_EXECUTION_OUTCOME_SKILLS"]),
    nextObservation: nextObservation(passed ? "review-compounding-proof" : "collect-preregistered-compounding-cohort", "compounding-scorecard", "permitted", ["experiment-launch", "project-memory-promotion", "proposal-apply"]),
    provenance: [provenance("compounding-effectiveness", "scorecard", { schemaVersion: state.schemaVersion, recordId: latest?.scorecardId || "missing", evidenceRef: latest?.scorecardId, generatedAt: latest?.generatedAt, freshness: latest ? freshness(latest.generatedAt, 7 * 24 * 60 * 60_000) : "unknown" })],
  };
}

function phase7Capability(cwd) {
  const card = readJson(path.join(cwd, "docs", "phase7-release-scorecard.json"), {}) || {};
  const statuses = (card.metrics || []).map((metric) => metric.status);
  const release = card.release?.decision || card.summary?.decision || "no-go-deferred";
  return {
    capabilityId: "phase7-release", currentStage: "P7",
    technicalReadiness: technical(card.schemaVersion === 1 ? "ready" : "unknown", [card.schemaVersion === 1 ? "scorecard-readable" : "scorecard-missing"]),
    policyAuthorization: policy(release === "ship" ? "authorized" : "blocked", false, false, [release]),
    fieldProof: proof(statuses.includes("fail") ? "failed" : statuses.includes("insufficient-data") || release === "no-go-deferred" ? "insufficient-data" : "passed", { evidenceClass: "exact-version-field", sampleSize: card.cohort?.eventCount, observedDays: card.cohort?.observedDays, exactIdentity: card.cohort?.sufficient === true && card.cohort?.rateDenominatorEligible === true, lastObservedAt: card.generatedAt, evidenceRefs: [card.scorecardId].filter(Boolean), reasonCodes: [release] }),
    rollbackControl: rollback("available", ["PI_ROLE_ROLLOUT_STAGE", "PI_ROLE_RUNTIME_VERSION", "PI_PROJECT_MEMORY_STAGE"]),
    nextObservation: nextObservation(release === "ship" ? "human-release-review" : "await-versioned-field-cohort", "phase7-scorecard", "permitted", ["irreversible-release", "automatic-mutating-delegation"]),
    provenance: [provenance("phase7-release", "scorecard", { schemaVersion: card.schemaVersion, recordId: card.scorecardId || "missing", evidenceRef: card.scorecardId, generatedAt: card.generatedAt, fingerprint: card.freeze?.runtimeSourceHash, freshness: freshness(card.generatedAt, 30 * 24 * 60 * 60_000) })],
  };
}

function extensionCapability(cwd, env) {
  let inventory = null; let telemetry = null; let portfolio = null; const reasons = [];
  try { inventory = scanExtensionRegistry({ cwd, env, settings: false, extensionPaths: [path.join(cwd, ".pi", "extensions"), path.join(cwd, "extensions")] }); } catch { reasons.push("inventory-provider-failed"); }
  try { telemetry = readExtensionTelemetry({ cwd }); } catch { reasons.push("telemetry-provider-failed"); }
  try { if (inventory && telemetry) portfolio = portfolioReport(inventory, telemetry, {}, { env }); } catch { reasons.push("portfolio-provider-failed"); }
  const reconciled = portfolio?.summary?.reconciled === true;
  const fieldReady = telemetry?.interactiveCohort?.gatingSafe === true;
  return {
    capabilityId: "extension-portfolio", currentStage: portfolio?.observation?.sufficient ? "observed" : "observation",
    technicalReadiness: technical(inventory && Number(inventory.summary?.degraded || 0) === 0 && Number(inventory.summary?.conflicts || 0) === 0 ? "ready" : inventory ? "degraded" : "unknown", [...reasons, reconciled ? "portfolio-reconciled" : "portfolio-not-reconciled"]),
    policyAuthorization: policy("advisory-only", false, false, ["extension-ops-inventory-authority"]),
    fieldProof: proof(fieldReady ? "passed" : "insufficient-data", { evidenceClass: "exact-version-field", sampleSize: telemetry?.interactiveCohort?.sessions, observedDays: telemetry?.interactiveCohort?.observedDays, exactIdentity: fieldReady, lastObservedAt: telemetry?.lastAt, reasonCodes: [fieldReady ? "interactive-cohort-qualified" : "interactive-cohort-incomplete"] }),
    rollbackControl: rollback("available", ["extension-disable-gates", "settings-extension-list"]),
    nextObservation: nextObservation(fieldReady ? "review-extension-field-proof" : "collect-extension-opportunities", "extension-ops", "permitted", ["extension-retirement", "model-tool-promotion"]),
    provenance: [provenance("extension-registry", "inventory", { schemaVersion: inventory?.schemaVersion, recordId: `extensions-${inventory?.summary?.extensions || 0}`, generatedAt: inventory?.generatedAt, freshness: inventory ? "current" : "unknown" }), provenance("extension-telemetry", "cohort", { schemaVersion: telemetry?.schemaVersion, recordId: `events-${telemetry?.eventCount || 0}`, generatedAt: telemetry?.lastAt, freshness: telemetry?.lastAt ? freshness(telemetry.lastAt, 30 * 24 * 60 * 60_000) : "unknown" })],
  };
}

function verificationCapabilities(cwd, env) {
  const latest = readJson(path.join(cwd, ".pi", "verification-center", "latest.json"), null);
  const evidence = latest?.evidence || null;
  const current = evidence ? compareTreeFingerprint(cwd, evidence.tree) : null;
  const technicalStatus = !evidence ? "degraded" : !current?.gatingSafe || evidence.ok !== true ? "degraded" : "ready";
  const verification = {
    capabilityId: "verification-center", currentStage: "operational",
    technicalReadiness: technical(technicalStatus, [evidence ? current?.status || "evidence-present" : "evidence-missing", evidence?.status || "unknown"]),
    policyAuthorization: policy("read-only", false, false, ["explicit-verification-only"]),
    fieldProof: proof("insufficient-data", { evidenceClass: "deterministic", sampleSize: evidence?.verifiers?.length || 0, exactIdentity: false, lastObservedAt: evidence?.createdAt, evidenceRefs: [evidence?.id].filter(Boolean), reasonCodes: [evidence ? "deterministic-technical-proof-only" : "field-proof-missing"] }),
    rollbackControl: rollback("available", ["PI_VERIFICATION_CENTER", "PI_COGNITIVE_AUTO_VERIFY"]),
    nextObservation: nextObservation(technicalStatus === "ready" ? "inspect-current-verification" : "run-explicit-verification", "verification-center", "permitted", ["source-mutation", "baseline-update"]),
    provenance: [provenance("verification-center", "evidence", { schemaVersion: 1, recordId: evidence?.id || "missing", evidenceRef: evidence?.id, generatedAt: evidence?.createdAt, fingerprint: evidence?.tree?.fingerprint, freshness: current?.status || "unknown" })],
  };
  let visualPlan;
  try { visualPlan = new VisualVerificationAdapter({ cwd, env, enabled: env.PI_VISUAL_VERIFICATION !== "0" }).plan({ profile: "full" }); } catch { visualPlan = { configured: false, applicable: false, ready: false, status: "degraded", cases: [], issues: ["visual-plan-failed"] }; }
  const visualResults = evidence?.visual?.results || evidence?.visualResults || [];
  const visualPassed = visualResults.length > 0 && visualResults.every((result) => result.ok === true);
  const visualFailed = visualResults.some((result) => result.ok === false);
  const visual = {
    capabilityId: "visual-verification", currentStage: visualPlan.configured ? "configured" : "unconfigured",
    technicalReadiness: technical(!visualPlan.configured ? "not-applicable" : visualFailed || !visualPlan.ready ? "degraded" : "ready", [visualPlan.status, visualFailed ? "latest-visual-failure" : visualPassed ? "latest-visual-pass" : "visual-proof-missing", ...(visualPlan.issues || [])]),
    policyAuthorization: policy("advisory-only", false, false, ["explicit-provider-gate-only", "baseline-mutation-separate"]),
    fieldProof: proof(visualPlan.configured ? "insufficient-data" : "not-applicable", { evidenceClass: "deterministic", sampleSize: visualResults.length, exactIdentity: false, lastObservedAt: evidence?.createdAt, evidenceRefs: visualResults.map((result) => result.caseId), reasonCodes: [visualPassed ? "deterministic-technical-proof-only" : visualFailed ? "technical-proof-failed" : "visual-proof-incomplete"] }),
    rollbackControl: rollback("available", ["PI_VISUAL_VERIFICATION", "visual-case-configuration"]),
    nextObservation: nextObservation(!visualPlan.configured ? "configure-visual-cases" : visualPassed ? "inspect-visual-proof" : "run-explicit-visual-verification", "verification-center", "permitted", ["baseline-update", "source-mutation"]),
    provenance: [provenance("visual-verification", "provider-plan", { schemaVersion: visualPlan.schemaVersion, recordId: `cases-${visualPlan.cases?.length || 0}`, generatedAt: null, fingerprint: visualPlan.cases?.map((item) => item.configHash).join(":"), freshness: "current" })],
  };
  return [verification, visual];
}

function operationalEvidence(cwd) {
  let debugThreads = []; let experiments = []; let experimentCoverage = null; let runs = []; let binder = null; const unavailableSources = [];
  try { debugThreads = listThreadSummaries(cwd, { status: "open", limit: MAX_OPERATIONS }); } catch { unavailableSources.push("debug-ledger"); }
  try { experiments = listExperimentSummaries(cwd, { status: "open", limit: MAX_OPERATIONS }); experimentCoverage = experimentLedgerCoverage(cwd); } catch { unavailableSources.push("experiment-ledger"); }
  try { runs = listRunSummaries(cwd, { limit: MAX_OPERATIONS }); } catch { unavailableSources.push("run-deck"); }
  try { const status = new EvidenceStore({ cwd }).status({ limit: 10 }); binder = { evidenceCount: status.evidenceCount, latestEvidenceId: status.latest?.id || null, latestStatus: status.latest?.freshness?.status || null, latestOk: status.latest?.ok === true }; } catch { unavailableSources.push("evidence-binder"); }
  return { debugThreads, experiments, experimentCoverage, runs, evidenceBinder: binder, unavailableSources };
}

function assertRolloutSnapshotMetadataOnly(value, at = "snapshot") {
  if (value == null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") {
    if (value.length > 512 || ABSOLUTE_PATH_VALUE.test(value)) throw new Error(`unsafe rollout metadata at ${at}`);
    return true;
  }
  if (Array.isArray(value)) { if (value.length > 200) throw new Error(`rollout metadata bound exceeded at ${at}`); value.forEach((item, index) => assertRolloutSnapshotMetadataOnly(item, `${at}[${index}]`)); return true; }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { if (FORBIDDEN_KEY.test(key) && !PRIVACY_ASSERTION_KEYS.has(key)) throw new Error(`forbidden rollout metadata key at ${at}.${key}`); assertRolloutSnapshotMetadataOnly(child, `${at}.${key}`); }
    return true;
  }
  throw new Error(`invalid rollout metadata at ${at}`);
}

function buildRolloutSnapshot({ cwd = process.cwd(), env = process.env, now = () => new Date() } = {}) {
  const root = path.resolve(cwd);
  const tree = treeFingerprintSummary(captureTreeFingerprint(root));
  const providers = [
    () => extensionCapability(root, env),
    () => roleCapability(root, env),
    () => memoryCapability(root, env),
    () => compoundingCapability(root, env.PI_COMPOUNDING_EFFECTIVENESS_ENABLED !== "0"),
    () => phase7Capability(root),
  ];
  const capabilities = []; const unavailableSources = [];
  for (const provider of providers) { try { capabilities.push(provider()); } catch (error) { unavailableSources.push(safeId(error?.code || "source-provider-failed", "source")); } }
  try { capabilities.push(...verificationCapabilities(root, env)); } catch { unavailableSources.push("verification-center"); }
  const operations = operationalEvidence(root);
  unavailableSources.push(...operations.unavailableSources);
  const generatedAt = now().toISOString();
  const boundedCapabilities = capabilities.slice(0, MAX_CAPABILITIES).map((item) => ({ ...item, provenance: (item.provenance || []).slice(0, MAX_PROVENANCE) }));
  const snapshot = {
    schemaVersion: ROLLOUT_CENTER_SCHEMA_VERSION,
    snapshotId: "pending",
    generatedAt,
    tree,
    posture: "observation-only",
    capabilities: boundedCapabilities,
    operations: { debugThreads: operations.debugThreads, experiments: operations.experiments, runs: operations.runs, evidenceBinder: operations.evidenceBinder },
    coverage: { unavailableSources: [...new Set(unavailableSources)].sort(), experimentLedger: operations.experimentCoverage, capabilityLimit: MAX_CAPABILITIES, provenancePerCapabilityLimit: MAX_PROVENANCE, operationLimit: MAX_OPERATIONS },
    counts: { technical: countBy(boundedCapabilities.map((item) => item.technicalReadiness), "status"), policy: countBy(boundedCapabilities.map((item) => item.policyAuthorization), "status"), fieldProof: countBy(boundedCapabilities.map((item) => item.fieldProof), "status"), stale: boundedCapabilities.filter((item) => item.provenance.some((row) => String(row.freshness).startsWith("stale"))).length },
    privacy: { metadataOnly: true, containsImageBodies: false, containsTranscripts: false, containsReasoning: false, containsRawOutputs: false, containsSecrets: false, containsAbsolutePaths: false },
  };
  snapshot.snapshotId = `rollout_${hash({ tree: tree?.fingerprint, capabilities: boundedCapabilities, operations: snapshot.operations }).slice(0, 24)}`;
  assertRolloutSnapshotMetadataOnly(snapshot);
  return snapshot;
}

class RolloutCenterAdapter {
  constructor({ enabled = true, cwd = process.cwd(), env = process.env, clock = () => new Date() } = {}) { this.enabled = enabled !== false; this.cwd = path.resolve(cwd); this.env = env; this.clock = clock; this.lastSnapshot = null; }
  snapshot(options = {}) {
    if (!this.enabled) return { schemaVersion: 1, enabled: false, skipped: true, posture: "disabled", capabilities: [] };
    const snapshot = buildRolloutSnapshot({ cwd: options.cwd || this.cwd, env: options.env || this.env, now: this.clock });
    this.lastSnapshot = snapshot;
    const statuses = options.statuses ? new Set(options.statuses) : null;
    const capabilityIds = options.capabilityIds ? new Set(options.capabilityIds) : null;
    if (!statuses && !capabilityIds) return snapshot;
    return { ...snapshot, capabilities: snapshot.capabilities.filter((item) => (!capabilityIds || capabilityIds.has(item.capabilityId)) && (!statuses || statuses.has(item.technicalReadiness.status) || statuses.has(item.fieldProof.status) || item.provenance.some((row) => statuses.has(row.freshness)))) };
  }
  capability(capabilityId) { const snapshot = this.snapshot(); return snapshot.capabilities.find((item) => item.capabilityId === capabilityId) || null; }
  provenance(ref) { const snapshot = this.lastSnapshot || this.snapshot(); for (const capability of snapshot.capabilities) { const record = capability.provenance.find((item) => item.ref === ref); if (record) return { capabilityId: capability.capabilityId, record }; } return null; }
  status() { const snapshot = this.snapshot(); return { schemaVersion: 1, enabled: true, snapshotId: snapshot.snapshotId, generatedAt: snapshot.generatedAt, posture: snapshot.posture, capabilityCount: snapshot.capabilities.length, counts: snapshot.counts, coverage: snapshot.coverage, privacy: snapshot.privacy }; }
}

module.exports = { ROLLOUT_CENTER_SCHEMA_VERSION, RolloutCenterAdapter, buildRolloutSnapshot, assertRolloutSnapshotMetadataOnly, freshness };
