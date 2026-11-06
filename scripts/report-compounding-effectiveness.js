#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createPiIntegrationBoundary } = require("../src/integration-boundary");
const { FileIntegrationStorage } = require("../src/file-integration-storage");

function parse(argv) {
  const options = { cwd: process.cwd(), write: true, cohortId: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-write") options.write = false;
    else if (arg === "--cwd") options.cwd = path.resolve(argv[++index] || process.cwd());
    else if (arg === "--cohort") options.cohortId = String(argv[++index] || "").trim() || null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  const storage = new FileIntegrationStorage(path.join(options.cwd, ".pi", "cognitive-automation"));
  const boundary = createPiIntegrationBoundary({
    storage,
    branching: { cwd: options.cwd },
    learning: { cwd: options.cwd },
    goalEvidence: { cwd: options.cwd },
    memoryMaintenance: { cwd: options.cwd },
    provenance: { cwd: options.cwd },
    compounding: { cwd: options.cwd },
    pilots: { enabled: true, cwd: options.cwd },
    skills: { options: { cwd: options.cwd, loadNative: false, loadCurated: false } },
  });
  const report = boundary.compounding.generate({ write: options.write, cohortId: options.cohortId });
  process.stdout.write(`${JSON.stringify({ scorecardId: report.scorecardId, generatedAt: report.generatedAt, decision: report.decision, highestAuthorizedProjectMemoryStage: report.highestAuthorizedProjectMemoryStage, experiment: report.experiment, gateStatuses: Object.fromEntries(Object.entries(report.gates || {}).map(([key, value]) => [key, value.status])), comparisonStatus: report.cohorts?.comparison?.status, coverage: { complete: report.coverage?.complete, unavailableProviders: report.coverage?.unavailableProviders || [], truncated: report.coverage?.truncated }, storage: report.storage || null }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
