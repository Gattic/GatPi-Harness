#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { scan } = require("../src/privacy-guard-scan.js");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source.js");
const {
  buildPrivacyRolloutEvidence,
  validatePrivacyRolloutEvidence,
  loadPrivacyReviews,
  writePrivacyRolloutEvidence,
} = require("../src/memory-effectiveness-privacy.js");

const cwd = process.cwd();
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const backupRoot = value("--backup-root");
const apply = args.includes("--write") && args.includes("--yes");
if (apply && !backupRoot) throw new Error("--write --yes requires --backup-root=<private-remediation-backup-root>");

const evidenceFile = path.join(cwd, ".pi", "privacy-guard", "rollout-evidence.json");
const reviewsFile = path.join(cwd, ".pi", "privacy-guard", "rollout-reviews.json");
const primaryScan = scan(cwd, undefined, { includeGlobal: true, rawSessionPermissions: true });
const backupScan = backupRoot ? scan(cwd, [path.resolve(backupRoot)], {}) : { scope: {}, roots: [], rootStatus: [], coverage: {}, summary: {}, findings: [], truncated: true, resultTruncated: true };
const source = currentMemorySourceEvidence({ implementationRoot: cwd });
const evidence = buildPrivacyRolloutEvidence({ primaryScan, backupScan, source, reviews: loadPrivacyReviews(reviewsFile) });
const validation = validatePrivacyRolloutEvidence(evidence, source);
if (!validation.ok) throw new Error(`generated privacy evidence failed validation: ${validation.reasons.join(",")}`);
if (apply) writePrivacyRolloutEvidence(evidenceFile, evidence);

process.stdout.write(`${JSON.stringify({
  ok: evidence.summary.qualified,
  written: apply,
  evidenceId: evidence.evidenceId,
  scanId: evidence.scanId,
  candidateSetId: evidence.candidateSetId,
  summary: evidence.summary,
  coverage: {
    primaryFiles: evidence.primary.coverage.scannedFiles,
    primaryBytes: evidence.primary.coverage.scannedBytes,
    backupFiles: evidence.backup.coverage.scannedFiles,
    backupBytes: evidence.backup.coverage.scannedBytes,
  },
  permissionCompliant: evidence.primary.permissionPosture?.compliant === true,
  validationReasons: validation.reasons,
}, null, 2)}\n`);
