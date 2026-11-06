#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { TELEMETRY_SCHEMA_VERSION } = require("../src/extension-telemetry");
const { OUTCOME_SCHEMA_VERSION } = require("../src/outcome-schema");
const { SCHEMA_VERSION: SESSION_MINER_SCHEMA_VERSION, CLASSIFIER_VERSION: SESSION_MINER_CLASSIFIER_VERSION, COHORT_CONTRACT_VERSION, SESSION_KIND_POLICY_VERSION } = require("../src/session-miner");
const { versionedTelemetryCohort, evaluatePhase7Scorecard, renderPhase7Markdown } = require("../src/phase7-release-scorecard");
const { validatePhase7Freeze } = require("../scripts/generate-phase7-scorecard");
const { SESSION_AUDIT_SCHEMA_VERSION, SESSION_AUDIT_CLASSIFIER_VERSION, SESSION_AUDIT_KIND_POLICY_VERSION } = require("../scripts/freeze-phase7-release");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const event = (timestamp, extension = "reasoning-runtime", version = "v-current", kind = "command", outcome = "succeeded") => ({ timestamp, extension, version, kind, outcome });
const telemetry = [
  event("2026-07-01T00:00:00Z", "old", "v-old"),
  event("2026-07-10T00:00:00Z"),
  event("2026-07-24T00:00:00Z", "prompt-suggestions", "v-current", "prompt-suggestion"),
];
const cohort = versionedTelemetryCohort(telemetry, { sinceAt: "2026-07-10T00:00:00Z" });
assert.equal(cohort.eventCount, 2);
assert.equal(cohort.observedDays, 14);
assert.equal(cohort.sufficient, true);
assert.equal(cohort.rateDenominatorEligible, false, "metadata-only events cannot be attributed to interactive vs smoke sessions without a privacy-breaking join");
assert.equal(cohort.classification, "metadata-events-not-joined-to-session-kind");
assert.equal(cohort.versions.length, 2);
assert.equal(cohort.privacy.metadataOnly, true);

const base = {
  generatedAt: "2026-07-26T00:00:00Z",
  freeze: { sourceVersion: "source-v1", configVersion: "config-v1", cohortStartAt: "2026-07-26T00:00:00Z", runtimeSourceHash: "a".repeat(64) },
  telemetryEvents: [event("2026-07-26T01:00:00Z")],
  sessionAudit: { cohort: { sourceVersion: "source-v1", configVersion: "config-v1", currentSessionExcluded: true, observedInteractiveDays: 0, eligibleForFourteenDayDecision: false }, sessions: { classifications: { interactive: 0, "test-or-smoke": 2 }, analyzedFiles: 2, invalidRows: 0 } },
  roleBenchmark: { promotion: { overallPassed: true, maxEligibleStage: "R4" } },
  rolePilot: { status: "finished", verdict: "pass", metrics: { modelCalls: 2, toolCalls: 3, toolResults: 3, typedTermination: true, totalDurationMs: 21000 }, evidence: [] },
  roleAudit: { roleRuns: { total: 1 }, findings: { falseSuccessTerminalErrors: 0, modelBudgetOverruns: 0, toolAccountingMismatches: 0, timedOutMutatingRuns: 0 } },
  roleRollout: { requestedStage: "R5", requestedStageSource: "environment", stageAuthority: "configured-environment", eligibleStage: "R4", evidenceAuthorizedStage: "R4", evidenceOverride: true, effectiveStage: "R5", benchmarkReport: "/private/report.json", benchmarkManifestHash: "manifest", benchmarkRuntimeSourceHash: "runtime-source", benchmarkEvidenceStatus: "current-benchmark-evidence" },
  inventory: { extensions: 48, declaredTools: 67, activeTools: 59, degraded: 0, conflicts: 0, unexplained: 0, portfolioReconciled: true, portfolioRecords: 48, toolDecisions: 67 },
  live: {
    semanticOutcomeParity: true,
    semgrep: { smokePassed: true, infrastructureErrorRate: null },
    obsidian: { authReady: true, curationReady: true, dryRunPassed: true },
    testRunnerNotApplicable: true,
    context: { deterministicReductionPct: 91.75, correctnessPassed: true },
    promptTelemetry: { metadataOnly: true, events: 10 },
    privacy: { actionable: 0, telemetryRedactionPassed: true },
  },
};
const deferred = evaluatePhase7Scorecard(base);
assert.equal(deferred.summary.decision, "no-go-deferred");
assert.equal(deferred.release.irreversiblePortfolioChangesAllowed, false);
assert.equal(deferred.release.automaticMutatingDelegationAllowed, false);
assert.equal(deferred.metrics.find((row) => row.id === "semgrep").status, "insufficient-data");
assert.equal(deferred.metrics.find((row) => row.id === "cognitive-context").status, "insufficient-data");
const renderedDeferred = renderPhase7Markdown(deferred);
assert.match(renderedDeferred, /NO-GO-DEFERRED/);
assert.ok(!renderedDeferred.endsWith("\n\n"), "rendered scorecard must not contain a trailing blank line");
assert.equal(deferred.roleRollout.benchmarkEvidencePresent, true);
assert.equal(deferred.roleRollout.benchmarkRuntimeSourceHash, "runtime-source");
assert.equal(deferred.roleRollout.benchmarkEvidenceStatus, "current-benchmark-evidence");
assert.equal(deferred.roleRollout.stageAuthority, "configured-environment");
assert.equal(deferred.roleRollout.evidenceAuthorizedStage, "R4");
assert.equal(deferred.roleRollout.evidenceOverride, true);
assert.equal(deferred.roleRollout.benchmarkReport, undefined);
assert.doesNotMatch(JSON.stringify(deferred), /private prompt|session\.jsonl|\/home\/|\/private\/report/);
const shippable = evaluatePhase7Scorecard({ ...base, rateDenominatorEligible: true, freeze: { ...base.freeze, cohortStartAt: "2026-07-10T00:00:00Z" }, telemetryEvents: telemetry.slice(1), sessionAudit: { ...base.sessionAudit, cohort: { ...base.sessionAudit.cohort, observedInteractiveDays: 14, eligibleForFourteenDayDecision: true } }, live: { ...base.live, semgrep: { smokePassed: true, infrastructureErrorRate: 0 } } });
assert.equal(shippable.summary.decision, "ship");

const tmp = tmpFixture("pi-phase7-audit-");
const snapshotOutput = path.join(tmp, "registry-snapshot.json");
execFileSync("node", [path.join(root, "scripts", "snapshot-extension-audit-registry.js"), `--output=${snapshotOutput}`], { cwd: root, stdio: "pipe" });
const snapshot = JSON.parse(fs.readFileSync(snapshotOutput, "utf8"));
assert.equal(snapshot.cwd, undefined);
assert.ok(snapshot.roots.every((row) => !Object.hasOwn(row, "root")));
assert.ok(snapshot.extensions.every((row) => !Object.hasOwn(row, "file") && !Object.hasOwn(row, "relativeFile") && !Object.hasOwn(row, "imports")));
assert.ok(!fs.readFileSync(snapshotOutput, "utf8").includes(root), "registry snapshot must not persist repository paths");
assert.equal(fs.statSync(snapshotOutput).mode & 0o777, 0o600);
const sessions = path.join(tmp, "sessions");
fs.mkdirSync(sessions);
const at = "2026-07-26T01:00:00Z";
const before = "2026-07-24T01:00:00Z";
function writeSession(name, rows) { fs.writeFileSync(path.join(sessions, `${name}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`); }
writeSession("current", [{ type: "session", id: "current", cwd: "/private/current", timestamp: at }, { type: "message", timestamp: at, message: { role: "user", content: "PRIVATE_CURRENT_PROMPT" } }, { type: "message", timestamp: at, message: { role: "assistant", content: "private" } }]);
writeSession("interactive", [{ type: "session", id: "interactive", cwd: "/workspace", timestamp: at }, { type: "message", timestamp: at, message: { role: "user", content: "/fixture-command\nImplement the requested release gate carefully." } }, { type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "fixture_tool", arguments: { secret: "PRIVATE_ARGUMENT" } }] } }, { type: "message", timestamp: at, message: { role: "toolResult", toolCallId: "x", toolName: "fixture_tool", isError: false, content: "PRIVATE_OUTPUT" } }]);
writeSession("smoke", [{ type: "session", id: "smoke", cwd: "/workspace", timestamp: at }, { type: "message", timestamp: at, message: { role: "user", content: "say only ok" } }, { type: "message", timestamp: at, message: { role: "assistant", content: "ok" } }]);
writeSession("before", [{ type: "session", id: "before", cwd: "/workspace", timestamp: before }, { type: "message", timestamp: before, message: { role: "user", content: "older work" } }, { type: "message", timestamp: before, message: { role: "assistant", content: "done" } }]);
const registry = path.join(tmp, "registry.json");
fs.writeFileSync(registry, JSON.stringify({ roots: [{ scope: "fixture", root: "/private/root", exists: true }], extensions: [{ name: "fixture", scope: "fixture", file: path.join(tmp, "ext", "index.ts"), relativeFile: "ext/index.ts", tools: ["fixture_tool"], commands: [], events: [] }, { name: "command-fixture", scope: "fixture", file: path.join(tmp, "command-ext", "index.ts"), relativeFile: "command-ext/index.ts", tools: [], commands: ["fixture-command"], events: [] }], conflicts: {} }));
const output = path.join(tmp, "audit", "latest.json");
execFileSync("python3", [path.join(root, "scripts", "audit-pi-sessions.py"), "--sessions", sessions, "--repo", tmp, "--registry", registry, "--output", output, "--exclude-session", "current", "--since-at", "2026-07-25T00:00:00Z", "--source-version", "source-v1", "--config-version", "config-v1"], { cwd: root, stdio: "pipe", env: { ...process.env, PI_SESSION_FILE: "" } });
const audit = JSON.parse(fs.readFileSync(output, "utf8"));
assert.equal(audit.schemaVersion, SESSION_AUDIT_SCHEMA_VERSION);
assert.equal(audit.classifierVersion, SESSION_AUDIT_CLASSIFIER_VERSION);
assert.equal(audit.sessionKindPolicyVersion, SESSION_AUDIT_KIND_POLICY_VERSION);
assert.equal(audit.cohort.classifierVersion, SESSION_AUDIT_CLASSIFIER_VERSION);
assert.equal(audit.cohort.sessionKindPolicyVersion, SESSION_AUDIT_KIND_POLICY_VERSION);
assert.equal(audit.sessions.discoveredFiles, 4);
assert.equal(audit.sessions.scannedFiles, 3);
assert.equal(audit.sessions.analyzedFiles, 2);
assert.deepEqual(audit.sessions.classifications, { interactive: 1, "test-or-smoke": 1 });
assert.equal(audit.cohort.currentSessionExcluded, true);
assert.equal(audit.sessions.requestedActiveAuditSessionCount, 1);
assert.equal(audit.sessions.excludedActiveAuditSessionCount, 1);
assert.equal(audit.sessions.unmatchedActiveAuditSessionCount, 0);
assert.equal(audit.sessions.excludedActiveAuditSessions, undefined, "session identifiers must not be persisted");
assert.ok(audit.extensions.every((row) => !Object.hasOwn(row, "file")), "source paths must not be persisted in the aggregate audit");
const commandAdoption = audit.extensions.find((row) => row.name === "command-fixture");
assert.equal(commandAdoption.interactiveCommandSessions, 1);
assert.equal(commandAdoption.interactiveAdoptionSessions, 1);
assert.equal(commandAdoption.interactiveSessionAdoptionRate, 1, "classified adoption includes command-only sessions rather than tool calls alone");
assert.equal(audit.cohort.sourceVersion, "source-v1");
assert.equal(audit.cohort.configVersion, "config-v1");
assert.equal(audit.cohort.observedInteractiveDays, 0);
assert.equal(audit.cohort.eligibleForFourteenDayDecision, false, "elapsed wall-clock time without 14 observed interactive days is insufficient");
assert.equal(fs.statSync(output).mode & 0o777, 0o600);
const persisted = fs.readFileSync(output, "utf8");
for (const forbidden of ["PRIVATE_CURRENT_PROMPT", "PRIVATE_ARGUMENT", "PRIVATE_OUTPUT", "/private/root", "/private/current", "ext/index.ts"]) assert.ok(!persisted.includes(forbidden), `audit must not persist ${forbidden}`);
const unmatchedOutput = path.join(tmp, "audit", "unmatched.json");
execFileSync("python3", [path.join(root, "scripts", "audit-pi-sessions.py"), "--sessions", sessions, "--repo", tmp, "--registry", registry, "--output", unmatchedOutput, "--exclude-session", "prefix_current", "--source-version", "source-v1", "--config-version", "config-v1"], { cwd: root, stdio: "pipe", env: { ...process.env, PI_SESSION_FILE: "" } });
const unmatched = JSON.parse(fs.readFileSync(unmatchedOutput, "utf8"));
assert.equal(unmatched.cohort.currentSessionExcluded, false, "a prefixed/nonmatching exclusion cannot claim the active session was excluded");
assert.equal(unmatched.sessions.requestedActiveAuditSessionCount, 1);
assert.equal(unmatched.sessions.excludedActiveAuditSessionCount, 0);
assert.equal(unmatched.sessions.unmatchedActiveAuditSessionCount, 1);
assert.equal(unmatched.sessions.scannedFiles, 4);

const compatibleFreeze = {
  schemaVersion: 1,
  sourceVersion: "source-v1",
  configVersion: "config-v1",
  runtimeSourceHash: "a".repeat(64),
  settingsHash: "b".repeat(64),
  telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
  outcomeSchemaVersion: OUTCOME_SCHEMA_VERSION,
  cohortContractVersion: COHORT_CONTRACT_VERSION,
  sessionMinerSchemaVersion: SESSION_MINER_SCHEMA_VERSION,
  sessionMinerClassifierVersion: SESSION_MINER_CLASSIFIER_VERSION,
  sessionKindPolicyVersion: SESSION_KIND_POLICY_VERSION,
  sessionAuditSchemaVersion: SESSION_AUDIT_SCHEMA_VERSION,
  sessionAuditClassifierVersion: SESSION_AUDIT_CLASSIFIER_VERSION,
  sessionAuditKindPolicyVersion: SESSION_AUDIT_KIND_POLICY_VERSION,
};
const compatibleAudit = {
  schemaVersion: SESSION_AUDIT_SCHEMA_VERSION,
  classifierVersion: SESSION_AUDIT_CLASSIFIER_VERSION,
  sessionKindPolicyVersion: SESSION_AUDIT_KIND_POLICY_VERSION,
  cohort: { sourceVersion: "source-v1", configVersion: "config-v1", classifierVersion: SESSION_AUDIT_CLASSIFIER_VERSION, sessionKindPolicyVersion: SESSION_AUDIT_KIND_POLICY_VERSION },
};
assert.equal(validatePhase7Freeze({ freeze: compatibleFreeze, currentRuntimeHash: compatibleFreeze.runtimeSourceHash, currentSettingsHash: compatibleFreeze.settingsHash, sessionAudit: compatibleAudit }).valid, true);
assert.throws(() => validatePhase7Freeze({ freeze: compatibleFreeze, currentRuntimeHash: "c".repeat(64), currentSettingsHash: compatibleFreeze.settingsHash, sessionAudit: compatibleAudit }), /runtimeSourceHash/);
assert.throws(() => validatePhase7Freeze({ freeze: compatibleFreeze, currentRuntimeHash: compatibleFreeze.runtimeSourceHash, currentSettingsHash: "c".repeat(64), sessionAudit: compatibleAudit }), /settingsHash/);
assert.throws(() => validatePhase7Freeze({ freeze: compatibleFreeze, currentRuntimeHash: compatibleFreeze.runtimeSourceHash, currentSettingsHash: compatibleFreeze.settingsHash, sessionAudit: { ...compatibleAudit, classifierVersion: "stale-classifier" } }), /audit.classifierVersion/);
assert.throws(() => validatePhase7Freeze({ freeze: compatibleFreeze, currentRuntimeHash: compatibleFreeze.runtimeSourceHash, currentSettingsHash: compatibleFreeze.settingsHash, sessionAudit: { ...compatibleAudit, cohort: { ...compatibleAudit.cohort, configVersion: "stale-config" } } }), /audit.cohort.configVersion/);

console.log("phase7 release tests passed");
