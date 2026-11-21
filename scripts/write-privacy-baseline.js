#!/usr/bin/env node
"use strict";

// Writes the one-time grandfather baseline for the passive privacy gate. Only
// record-format highs present at baseline are grandfathered; later highs gate.

const fs = require("node:fs");
const path = require("node:path");
const { scan } = require("../src/privacy-guard-scan");
const { buildPrivacyBaseline } = require("../src/privacy-baseline");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { writePrivateJson } = require("../src/project-memory-decisions");

const root = path.resolve(__dirname, "..");
const cwd = path.resolve(process.env.PI_AUDIT_CWD || process.cwd());
const configuredDeadline = Number(process.env.PI_PROJECT_MEMORY_SCAN_DEADLINE_MS);
const deadlineMs = Number.isFinite(configuredDeadline) && configuredDeadline > 0 ? configuredDeadline : 10000;
const baselineFile = path.join(cwd, ".pi", "privacy-guard", "privacy-baseline.json");

const result = scan(cwd, undefined, { rawSessionPermissions: true, deadlineMs });
if (result.coverage?.complete !== true) {
  process.stderr.write(`refusing to write an incomplete baseline: coverage ${JSON.stringify(result.coverage?.complete)}\n`);
  process.exit(1);
}
const sourceRevision = currentMemorySourceEvidence({ implementationRoot: root }).revision;
const baseline = buildPrivacyBaseline(result, { sourceRevision });
fs.mkdirSync(path.dirname(baselineFile), { recursive: true, mode: 0o700 });
if (fs.existsSync(baselineFile)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.renameSync(baselineFile, path.join(path.dirname(baselineFile), `privacy-baseline-${stamp}.json`));
}
writePrivateJson(baselineFile, baseline);
process.stdout.write(`${JSON.stringify({ ok: true, baselineFile: path.relative(cwd, baselineFile), counts: baseline.counts, recordFileHashes: baseline.recordFileHashes.length, permissionPostureCompliant: baseline.permissionPostureCompliant }, null, 2)}\n`);
