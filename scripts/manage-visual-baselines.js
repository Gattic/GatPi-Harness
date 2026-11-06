#!/usr/bin/env node
"use strict";

const { previewBaseline, applyBaseline } = require("../src/visual-baselines");

function parse(argv) {
  const operation = argv[0];
  const caseId = argv[1];
  const value = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) || null;
  return {
    operation,
    caseId,
    approvalRef: value("--approval-ref"),
    actualRef: value("--artifact-ref"),
    yes: argv.includes("--yes"),
  };
}

async function main() {
  const input = parse(process.argv.slice(2));
  if (!input.caseId || !new Set(["preview", "apply"]).has(input.operation)) throw new Error("Usage: node scripts/manage-visual-baselines.js preview|apply <case-id> [--artifact-ref=<ref>] [--yes --approval-ref=<id>]");
  const result = input.operation === "preview"
    ? await previewBaseline({ cwd: process.cwd(), caseId: input.caseId, actualRef: input.actualRef })
    : await applyBaseline({ cwd: process.cwd(), caseId: input.caseId, actualRef: input.actualRef, apply: true, yes: input.yes, approvalRef: input.approvalRef });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const raw = String(error?.message || error);
  const message = /^[A-Za-z0-9 .:_-]{1,200}$/.test(raw) ? raw : `visual baseline operation failed${error?.code ? ` (${String(error.code).replace(/[^A-Za-z0-9_-]/g, "")})` : ""}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
