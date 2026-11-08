#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { scanExtensionRegistry } = require("../src/extension-registry");
const {
  PORTFOLIO_SCHEMA_VERSION,
  OBSERVATION_MIN_DAYS,
  COMMAND_ONLY_MODEL_TOOLS,
  portfolioRecords,
  modelToolEnabled,
  observationWindow,
  portfolioReport,
  reliableCoreDisplacement,
  toolDecisions,
  renderPortfolioRecordMarkdown,
} = require("../src/extension-portfolio");
const root = path.resolve(__dirname, "..");
const inventory = scanExtensionRegistry({
  cwd: root,
  settings: false,
  extensionPaths: [path.join(root, ".pi", "extensions"), path.join(root, "extensions")],
  runtime: { available: false, tools: [], commands: [] },
});
const telemetry = { eventCount: 90, firstAt: "2026-07-25T20:58:38.186Z", lastAt: "2026-07-26T08:30:45.132Z" };
const report = portfolioReport(inventory, telemetry);
assert.equal(PORTFOLIO_SCHEMA_VERSION, 4);
assert.equal(report.summary.extensions, 52);
assert.equal(report.summary.tools, 71);
assert.equal(report.summary.defaultActiveToolsBefore, 66, "parent-visible baseline includes native codemode, the optional-tool activation control, and the sectioned-write append tool, and excludes child-only role tools");
assert.equal(report.summary.defaultActiveToolsAfter, 65, "the manual output compactor remains command-only");
assert.equal(report.summary.defaultSurfaceReduction, 1);
assert.equal(report.summary.reconciled, true);
for (const removed of ["semantic-patch-workbench", "workflow-conductor", "plan-fanout", "topology-catalog"]) assert(!portfolioRecords().some((record) => record.extensionId === removed), `${removed} is retired rather than retained behind compatibility gates`);
assert.deepEqual(report.reconciliation, { missingRecords: [], staleRecords: [], missingToolDecisions: [], staleToolDecisions: [] });
assert.equal(new Set(portfolioRecords().map((record) => record.extensionId)).size, inventory.extensions.length);
for (const record of portfolioRecords()) {
  for (const field of ["owner", "problem", "trigger", "canonical", "overlap", "mutationClass", "privacyClass", "successMetric", "lifecycle", "modelExposure"]) assert.ok(record[field], `${record.extensionId}.${field} is required`);
  assert.ok(Array.isArray(record.dependencies));
  assert.ok(Array.isArray(record.tools));
}
for (const record of report.records) {
  assert.ok(record.measurement && record.decision && record.rollbackMigration, `${record.extensionId} carries measurement, lifecycle decision, and rollback/migration data`);
  assert.equal(record.measurement.usageAndValueSeparated, true);
  assert.equal(record.rollbackMigration.existingStatePreserved, true);
  assert.equal(record.rollbackMigration.commandCompatibilityRetained, true);
}

const commandOnly = toolDecisions().filter((item) => item.decision === "experimental-command-only");
assert.deepEqual(commandOnly.map((item) => item.tool), Object.keys(COMMAND_ONLY_MODEL_TOOLS).sort());
assert.equal(toolDecisions().find((item) => item.tool === "memory_curator").decision, "keep-explicit");
assert.equal(toolDecisions().find((item) => item.tool === "run_monitor").decision, "keep-observation-pending");
const specialist = toolDecisions().find((item) => item.tool === "specialist_tasks");
assert.equal(specialist.extensionId, "reasoning-runtime");
assert.equal(specialist.decision, "keep");
assert.equal(specialist.modelExposure, "default");
assert.match(specialist.canonical, /specialist_tasks for artifact-bound task graphs and transactional application/);
assert.match(specialist.trigger, /executable acceptance/);
for (const tool of ["bash", "role_domain"]) {
  const decision = toolDecisions().find((item) => item.tool === tool);
  assert.equal(decision.extensionId, "role-sidecar");
  assert.equal(decision.decision, "keep-child-only");
  assert.equal(decision.modelExposure, "child-only");
}
assert.equal(modelToolEnabled("role-sidecar", {}), false, "sidecar shell/domain tools must not enable the sidecar on the parent surface");
for (const item of commandOnly) {
  assert.equal(modelToolEnabled(item.extensionId, {}), false, `${item.tool} is not model-visible by default`);
  assert.equal(modelToolEnabled(item.extensionId, { [item.optInEnv]: "1" }), true, `${item.tool} has a narrow rollback opt-in`);
  assert.equal(modelToolEnabled(item.extensionId, { PI_PORTFOLIO_EXPERIMENTAL_TOOLS: "1" }), true, `${item.tool} has a fleet rollback opt-in`);
  const source = fs.readFileSync(path.join(root, ".pi", "extensions", item.extensionId, "index.ts"), "utf8");
  assert.match(source, new RegExp(`modelToolEnabled\\(\\"${item.extensionId}\\"\\)`));
  assert.match(source, /if \(MODEL_TOOL_ENABLED\) pi\.registerTool/);
}

assert.equal(report.observation.sufficient, false);
assert.equal(report.summary.observationStatus, "insufficient-data");
assert.equal(report.observation.observedHours, 11.54);
assert.equal(observationWindow({ firstAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-31T00:00:00Z" }).sufficient, true);
assert.equal(report.policy.experimentalPromptGuidance, "none");
assert.equal(report.policy.noNewDefaultToolWithoutUniqueTrigger, true);
assert.equal(report.policy.lowUseWithoutEligibleOpportunities, "insufficient-data");
assert.equal(report.summary.lifecycleAuthority, "no-go-deferred");
assert.ok(!JSON.stringify(report).includes(root), "portfolio report excludes source paths and payload bodies");

const matureAudit = {
  privacy: { aggregateOnly: true },
  cohort: { sinceAt: "2026-06-25T00:00:00Z", sourceVersion: "source-v2", configVersion: "config-v2", classifierVersion: "classifier-v2", sessionKindPolicyVersion: "kind-v2", currentSessionExcluded: true, observedInteractiveDays: 31 },
  sessions: { classifications: { interactive: 40 }, interactiveUserTurns: 200, earliestAt: "2026-06-25T00:00:00Z", latestAt: "2026-07-26T00:00:00Z" },
  extensions: [{ name: "repo-context", eligibleInteractiveSessionsSinceBirth: 10, interactiveAdoptionSessions: 8, interactiveActions: 22 }],
};
const opportunityTelemetry = { eventCount: 20, firstAt: "2026-06-25T00:00:00Z", lastAt: "2026-07-26T00:00:00Z", interactiveCohort: { currentSessionExcluded: true }, opportunities: { rows: [
  { version: "v1", sourceFingerprint: "source_aaaaaaaaaaaaaaaa", reviewed: true, extension: "obsidian", triggerId: "research-vault-intent", eligibility: "eligible", acted: true, value: "helpful", coreDisplacement: "not-applicable", sessionKind: "interactive", count: 16 },
  { version: "v1", sourceFingerprint: "source_aaaaaaaaaaaaaaaa", reviewed: true, extension: "obsidian", triggerId: "research-vault-intent", eligibility: "eligible", acted: true, value: "not-helpful", coreDisplacement: "not-applicable", sessionKind: "interactive", count: 4 },
] } };
const measured = portfolioReport(inventory, opportunityTelemetry, matureAudit);
assert.equal(measured.observation.gatingSafe, true);
assert.equal(measured.summary.measuredAdoptionRecords, 1);
assert.equal(measured.summary.measuredOpportunityRecords, 1);
assert.equal(measured.measurement.adoption.find((row) => row.extensionId === "repo-context").adoptionRate, 0.8);
assert.equal(measured.measurement.opportunities.find((row) => row.extensionId === "obsidian").valueStatus, "high-value");
assert.equal(measured.records.find((row) => row.extensionId === "repo-context").measurement.usage.usageStatus, "high-use");
assert.equal(measured.records.find((row) => row.extensionId === "chat-focus").measurement.utility.status, "unsupported", "no eligible opportunities is not relabeled as low value");
assert.equal(measured.records.find((row) => row.extensionId === "obsidian").decision.authority, "no-go-deferred", "opportunities without extension-specific low-use evidence cannot authorize retirement review");

const directTelemetry = {
  schemaVersion: 6,
  eventCount: 120,
  firstAt: "2026-06-25T00:00:00Z",
  lastAt: "2026-07-26T00:00:00Z",
  interactiveCohort: {
    sessions: 40,
    observedDays: 31,
    firstAt: "2026-06-25T00:00:00Z",
    lastAt: "2026-07-26T00:00:00Z",
    tokenCoverage: 1,
    currentSessionExcluded: true,
    gatingSafe: true,
    rows: [{ extension: "repo-context", sessions: 32, actions: 50 }],
  },
  opportunities: { rows: [] },
};
const directMeasured = portfolioReport(inventory, directTelemetry, {});
assert.equal(directMeasured.observation.source, "privacy-tokenized-extension-telemetry");
assert.equal(directMeasured.observation.gatingSafe, true);
assert.equal(directMeasured.measurement.adoption.find((row) => row.extensionId === "repo-context").adoptionRate, 0.8);
assert.equal(directMeasured.measurement.adoptionDenominator, "privacy-tokenized-interactive-sessions-in-telemetry-cohort");
assert.equal(directMeasured.summary.lifecycleAuthority, "no-go-deferred", "30 days without extension-specific opportunities is not retirement evidence");
const lowUseOpportunityTelemetry = {
  ...directTelemetry,
  interactiveCohort: { ...directTelemetry.interactiveCohort, rows: [{ extension: "run-monitor", sessions: 2, actions: 2 }] },
  opportunities: { rows: [{ version: "v1", sourceFingerprint: "source_aaaaaaaaaaaaaaaa", reviewed: false, extension: "run-monitor", triggerId: "managed-long-run-monitor-intent", eligibility: "eligible", acted: false, value: "unknown", coreDisplacement: "shell-used", sessionKind: "interactive", count: 20 }] },
};
const retirementReview = portfolioReport(inventory, lowUseOpportunityTelemetry, {});
const runMonitorDecision = retirementReview.records.find((row) => row.extensionId === "run-monitor");
assert.equal(runMonitorDecision.measurement.usage.usageStatus, "low-use");
assert.equal(runMonitorDecision.measurement.utility.gatingSafe, true);
assert.equal(runMonitorDecision.decision.authority, "review-required", "mature current-session-excluded fixed-trigger opportunities may authorize human review only");
assert.equal(retirementReview.summary.retirementReviewRecords, 1);
const displacementCohort = { classifierVersion: "c1", sessionKindPolicyVersion: "k1", windowDays: 30, fixtureHash: "fixture", policyVersion: "p1" };
const displacement = reliableCoreDisplacement(
  { cohort: { ...displacementCohort, strategyId: "baseline" }, interactiveUserTurns: 100, signals: { "repo_context:git-status-log": 20, "unreviewed:shell": 100 } },
  { cohort: { ...displacementCohort, strategyId: "candidate" }, interactiveUserTurns: 100, signals: { "repo_context:git-status-log": 10, "unreviewed:shell": 0 } },
);
assert.equal(displacement.status, "measured");
assert.equal(displacement.rows.find((row) => row.signal === "repo_context:git-status-log").reductionRate, 0.5);
assert.equal(displacement.rows.some((row) => row.signal === "unreviewed:shell"), false, "arbitrary shell commands are excluded from reliable-core displacement");
assert.equal(reliableCoreDisplacement({ cohort: { ...displacementCohort, strategyId: "same" }, interactiveUserTurns: 10 }, { cohort: { ...displacementCohort, strategyId: "same" }, interactiveUserTurns: 10 }).status, "insufficient-data");

const reasoning = report.records.find((row) => row.extensionId === "reasoning-runtime");
assert.match(reasoning.canonical, /plan fan-out/);
assert.match(reasoning.canonical, /recipe administration/);

const roadmapDocumentation = renderPortfolioRecordMarkdown(report.records.find((row) => row.extensionId === "roadmap"));
assert.match(roadmapDocumentation, /## Read-only viewers/, "viewer documentation belongs to the canonical renderer, not a handwritten generated-page edit");
assert.match(roadmapDocumentation, /first 500 entries \/ 64 KiB/, "regeneration preserves the published viewer bounds");
execFileSync(process.execPath, [path.join(root, "scripts", "render-extension-portfolio.js"), "--check"], { cwd: root, stdio: "pipe" });
const portfolioIndex = fs.readFileSync(path.join(root, "docs", "extension-portfolio", "README.md"), "utf8");
assert(portfolioIndex.includes(`- Tool decisions: ${report.summary.tools}\n`), "generated census reflects the current portfolio");
assert(portfolioIndex.includes(`- Default active model tools: ${report.summary.defaultActiveToolsBefore} -> ${report.summary.defaultActiveToolsAfter} (reduction ${report.summary.defaultSurfaceReduction})\n`), "generated parent census uses the current inventory, not a frozen tool count");
console.log("extension-portfolio tests passed");
