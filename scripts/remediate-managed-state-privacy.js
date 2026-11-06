#!/usr/bin/env node
"use strict";

const {
  planManagedStateRemediation,
  applyManagedStateRemediation,
  formatManagedStateRemediationPlan,
} = require("../src/managed-state-remediation");

const args = process.argv.slice(2);
const cwd = process.cwd();
const files = args.filter((arg) => arg.startsWith("--file=")).map((arg) => arg.slice("--file=".length)).filter(Boolean);
const apply = args.includes("--apply") && args.includes("--yes");
const manifestId = args.find((arg) => arg.startsWith("--manifest="))?.slice("--manifest=".length);

if (apply && !manifestId) throw new Error("--apply --yes requires --manifest=<preview-id>");

if (apply) {
  const result = applyManagedStateRemediation({ cwd, manifestId, apply: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.summary.blockedFiles) process.exitCode = 2;
} else {
  const plan = planManagedStateRemediation({ cwd, files: files.length ? files : undefined });
  process.stdout.write(`${formatManagedStateRemediationPlan(plan)}\nmanifest: ${plan.manifest}\n`);
  if (plan.summary.blockedFiles) process.exitCode = 2;
}
