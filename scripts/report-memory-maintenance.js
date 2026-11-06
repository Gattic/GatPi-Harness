#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { MemoryMaintenanceAdapter } = require("../src/integration-boundary");

function parse(argv) {
  const options = { preview: false, write: true, cwd: process.cwd() };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--preview") options.preview = true;
    else if (arg === "--no-write") options.write = false;
    else if (arg === "--cwd") options.cwd = path.resolve(argv[++index] || process.cwd());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.preview) throw new Error("memory maintenance is preview-only; pass --preview");
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  const adapter = new MemoryMaintenanceAdapter({ enabled: process.env.PI_MEMORY_MAINTENANCE_ENABLED !== "0", cwd: options.cwd });
  const report = adapter.preview({ write: options.write });
  process.stdout.write(`${JSON.stringify({ reportId: report.reportId, generatedAt: report.generatedAt, candidateCount: report.candidateCount, accounting: report.accounting.counts, coverage: { complete: report.coverage.complete, unavailableProviders: report.coverage.unavailableProviders, candidateTruncated: report.coverage.candidateTruncated, timeTruncated: report.coverage.timeTruncated }, boundaries: report.boundaries, storage: report.storage || null }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
