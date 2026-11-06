#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { retainTraceFiles } = require("../src/trace-retention");
const { pruneDiagnosticJsonl, DIAGNOSTIC_POLICIES } = require("../src/file-integration-storage");
const { writePrivateJson } = require("../src/project-memory-decisions");
const args = process.argv.slice(2);
if (args.some((arg) => !["--apply", "--global"].includes(arg))) throw new Error("usage: node scripts/maintain-diagnostics.js [--apply] [--global]");
const cwd = process.cwd(); const apply = args.includes("--apply");
const roots = [["project-traces", path.join(cwd, ".pi", "traces")]];
if (args.includes("--global")) roots.push(["global-traces", path.join(os.homedir(), ".pi", "agent", "traces")]);
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), apply, traces: {}, diagnostics: {}, sessionFilesTouched: false, canonicalMemoryTouched: false };
for (const [label, root] of roots) {
  const { candidates, ...result } = retainTraceFiles(root, { cwd, apply });
  report.traces[label] = { ...result, candidateCount: candidates.length, candidateBytes: candidates.reduce((sum, row) => sum + row.bytes, 0) };
}
for (const name of ["events", "snapshots"]) {
  const file = path.join(cwd, ".pi", "cognitive-automation", "entropy", `${name}.jsonl`);
  if (!fs.existsSync(file)) continue;
  const beforeBytes = fs.lstatSync(file).size;
  report.diagnostics[`entropy-${name}`] = { beforeBytes, policy: DIAGNOSTIC_POLICIES.entropy, ...(apply ? pruneDiagnosticJsonl(file, DIAGNOSTIC_POLICIES.entropy) : {}) };
}
if (apply) writePrivateJson(path.join(cwd, ".pi", "diagnostic-maintenance", "latest.json"), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
