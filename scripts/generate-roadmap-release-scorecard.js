#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRoadmapFieldReport, readRoadmapTelemetry, roadmapCohortVersion } = require("../src/roadmap-telemetry");

function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function percent(value) { return value == null ? "n/a" : `${(value * 100).toFixed(2)}%`; }
function render(report) {
  const exact = report.exactVersion;
  return `# Roadmap remediation release scorecard\n\n**Generated:** ${report.generatedAt}\n**Source cohort:** \`${report.sourceVersion}\`\n**Fixture SHA-256:** \`${report.fixtureHash || "unavailable"}\`\n**Decision:** **${report.decision}**\n\n## Claim boundary\n\nHistorical evidence remains design/regression evidence. It is not merged into the exact-version field cohort and cannot authorize rollout. Raw session content is not read or stored by this report.\n\n## Deterministic gates\n\n- Status: **${report.gates.deterministic}**\n- Invariant violations: ${report.deterministic.invariantViolations ?? "not proven"}\n- Successful-operation application violations: ${report.deterministic.applicationViolations ?? "not proven"}\n- Mutation character reduction: ${percent(report.deterministic.mutationCharacterReduction)}\n- Mutation p99 characters: ${report.deterministic.mutationP99Characters ?? "not proven"}\n- Privacy forbidden-value findings: ${report.deterministic.privacyForbiddenValueFindings ?? "not proven"}\n\n## Exact-version field cohort\n\n- Independent interactive sessions: **${exact.sample.independentInteractiveSessions}/30**\n- Interactive operations: ${exact.sample.interactiveOperations}\n- Error rate: ${percent(exact.reliability.errorRate)}\n- Valid add-subtask attempts: ${exact.reliability.addSubtaskAttempts}\n- Invalid add-subtask requests excluded: ${exact.reliability.invalidAddSubtaskRequests}\n- Valid add-subtask success rate: ${percent(exact.reliability.addSubtaskSuccessRate)}\n- Mutation result p99: ${exact.efficiency.mutationResultP99Chars ?? "n/a"}\n- Active-session exclusion: ${exact.excludedActiveSession.requested ? `exact token; ${exact.excludedActiveSession.matchedEvents} event(s) removed` : "not requested for this offline report"}\n\n## Historical baseline (separate)\n\n- Eligible interactive sessions: ${report.historicalBaseline.eligibleInteractiveSessions}\n- Adoption: ${percent(report.historicalBaseline.adoptionRate)}\n- Tool error rate: ${percent(report.historicalBaseline.errorRate)}\n- Historical result characters: ${report.historicalBaseline.resultCharacters.toLocaleString()}\n- Large-roadmap median mutation result: ${report.historicalBaseline.largeRoadmapMedianMutationCharacters.toLocaleString()} characters\n\n## Gates\n\n- Deterministic: **${report.gates.deterministic}**\n- Independent field sample: **${report.gates.independentFieldSample}**\n- Field reliability: **${report.gates.fieldReliability}**\n- Active-session exclusion: **${report.gates.activeSessionExclusion}**\n- Telemetry privacy: **${report.gates.privacy}**\n\n## Blockers\n\n${report.blockers.length ? report.blockers.map((item) => `- ${item}`).join("\n") : "- None"}\n\nRollback remains available through \`PI_ROADMAP=0\`, schema-compatible archived state, and bounded explicit show/export.\n`;
}

const cwd = path.resolve(process.argv[2] || process.cwd());
const fixtureFile = path.join(cwd, "tests", "fixtures", "roadmap", "large-roadmap-manifest.json");
const fixtureText = fs.readFileSync(fixtureFile, "utf8");
const fixtureHash = crypto.createHash("sha256").update(fixtureText).digest("hex");
const deterministicFile = path.join(cwd, "docs", "roadmap-deterministic-verification.json");
const deterministic = readJson(deterministicFile, { status: "not-proven" });
const report = createRoadmapFieldReport({
  events: readRoadmapTelemetry(cwd),
  excludeSessionToken: process.env.PI_ROADMAP_ACTIVE_SESSION_TOKEN || undefined,
  cohortVersion: roadmapCohortVersion(cwd),
  fixtureHash,
  deterministic,
});
const reportFile = path.join(cwd, "docs", "roadmap-field-report.json");
const scorecardFile = path.join(cwd, "docs", "roadmap-release-scorecard.json");
const markdownFile = path.join(cwd, "docs", "roadmap-release-scorecard.md");
writeJson(reportFile, report);
writeJson(scorecardFile, { schemaVersion: report.schemaVersion, generatedAt: report.generatedAt, sourceVersion: report.sourceVersion, fixtureHash: report.fixtureHash, gates: report.gates, decision: report.decision, blockers: report.blockers, sample: report.exactVersion.sample });
fs.writeFileSync(markdownFile, render(report));
console.log(JSON.stringify({ reportFile, scorecardFile, markdownFile, decision: report.decision, blockers: report.blockers }, null, 2));
