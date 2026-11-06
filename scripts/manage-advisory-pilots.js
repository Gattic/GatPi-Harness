#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createPiIntegrationBoundary, FileIntegrationStorage } = require("../src/integration-boundary");
const { COHORT_ID } = require("../src/advisory-skill-pilot");
const { opportunityReviewReport } = require("../src/extension-opportunity-review");
const { telemetrySessionToken } = require("../src/extension-telemetry");
const { showExperiment, recordGate } = require("../src/experiment-ledger");

function run(operation = "status", { cwd = process.cwd(), env = process.env } = {}) {
  if (!["init", "status", "record-verdicts"].includes(operation)) throw new Error("usage: node scripts/manage-advisory-pilots.js init|status|record-verdicts");
  const boundary = createPiIntegrationBoundary({ storage: new FileIntegrationStorage(path.join(cwd, ".pi", "cognitive-automation")), branching: { cwd }, skills: { cwd, options: { cwd } }, pilots: { enabled: true, cwd }, typesafe: { enabled: false } });
  if (operation === "init") boundary.skillPilot.initialize();
  const token = env.PI_SESSION_ID ? telemetrySessionToken(env.PI_SESSION_ID, { cwd }) : undefined;
  const reports = { skill: boundary.skillPilot.report(), legacyDiagnostics: { portfolio: opportunityReviewReport(cwd, { excludeSessionToken: token }), entropy: boundary.entropy.review.report() } };
  if (operation === "record-verdicts") {
    const verdict = reports.skill.verdict === "pass" ? "pass" : reports.skill.verdict === "fail" ? "fail" : "null-result";
    const metrics = JSON.stringify({ arms: Object.fromEntries(Object.entries(reports.skill.arms || {}).map(([arm, row]) => [arm, { assigned: row.assigned, resolved: row.resolved, pending: row.pending }])), improvementLowerBound: reports.skill.improvementLowerBound, costs: reports.skill.costs, action: reports.skill.action });
    const gate = "machine-verification-delivery", previous = showExperiment(cwd, COHORT_ID).gates.filter(row => row.gate === gate).at(-1);
    if (previous?.verdict !== verdict || previous?.metrics !== metrics) recordGate(cwd, COHORT_ID, { gate, verdict, metrics, gpuHours: 0, note: "Frozen executable checks; no human or model outcome ratings. A terminal pass can enable only the exact advisory reminder. No synthesis, routing, publication, or entropy intervention authority." });
  }
  return reports;
}
if (require.main === module) { try { console.log(JSON.stringify(run(process.argv[2]), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { run };
