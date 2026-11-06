#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { snapshotMaintenancePlan, applySnapshotMaintenance } = require("../src/session-branches.js");

function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const yes = argv.includes("--yes");
  const value = (name) => argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
  return {
    apply,
    yes,
    maxSnapshots: value("--max-snapshots") == null ? undefined : Number(value("--max-snapshots")),
    olderThanMs: value("--older-than-ms") == null ? undefined : Number(value("--older-than-ms")),
    maxSnapshotBytes: value("--max-snapshot-bytes") == null ? undefined : Number(value("--max-snapshot-bytes")),
  };
}
function compact(root, plan, result) {
  return { root: path.relative(process.cwd(), root) || ".", policy: plan.policy, summary: plan.summary, result: { dryRun: result.dryRun, applied: result.applied, rewritten: result.rewritten.length, removed: result.removed.length, hardenedFiles: result.hardenedFiles.length, hardenedDirs: result.hardenedDirs.length, errors: result.errors } };
}
function run(options = {}) {
  if (options.apply && !options.yes) throw new Error("Apply requires both --apply and --yes after reviewing the preview.");
  const roots = options.roots || [path.join(process.cwd(), ".pi", "cognitive-automation", "branches"), path.join(process.cwd(), ".pi", "session-branches")];
  return roots.map((root) => {
    const plan = snapshotMaintenancePlan(root, options);
    const result = applySnapshotMaintenance(plan, { dryRun: !options.apply });
    return compact(root, plan, result);
  });
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify({ schemaVersion: 1, stores: run(parseArgs()) }, null, 2)}\n`); }
  catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }
}

module.exports = { parseArgs, run };
