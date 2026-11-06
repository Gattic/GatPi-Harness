#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { collectScaleGateEvidence } = require("../src/code-context-scale-gates.js");

const ROOT = path.resolve(__dirname, "..");
function parseArgs(argv) {
  const out = { output: ".pi/code-context/benchmarks/scale-gate-latest.json", iterations: 10, repositoryCount: 1, classifiedDeepQueries: 0, conceptualIssueMisses: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; const next = () => argv[++index];
    if (arg === "--output") out.output = next(); else if (arg.startsWith("--output=")) out.output = arg.slice(9);
    else if (arg === "--iterations") out.iterations = Number(next()); else if (arg.startsWith("--iterations=")) out.iterations = Number(arg.slice(13));
    else if (arg === "--repository-count") out.repositoryCount = Number(next()); else if (arg.startsWith("--repository-count=")) out.repositoryCount = Number(arg.slice(19));
    else if (arg === "--semantic-startup-p95-ms") out.semanticStartupP95Ms = Number(next()); else if (arg.startsWith("--semantic-startup-p95-ms=")) out.semanticStartupP95Ms = Number(arg.slice(26));
    else if (arg === "--classified-deep-queries") out.classifiedDeepQueries = Number(next()); else if (arg.startsWith("--classified-deep-queries=")) out.classifiedDeepQueries = Number(arg.slice(26));
    else if (arg === "--conceptual-misses") out.conceptualIssueMisses = Number(next()); else if (arg.startsWith("--conceptual-misses=")) out.conceptualIssueMisses = Number(arg.slice(20));
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}
function atomicJson(root, file, value) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("scale-gate output must stay inside the repository");
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, absolute);
  return relative.replace(/\\/g, "/");
}
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log("usage: node scripts/probe-code-context-scale-gates.js [--iterations N] [--output FILE] [--repository-count N] [--semantic-startup-p95-ms N] [--classified-deep-queries N] [--conceptual-misses N]"); return; }
  const report = collectScaleGateEvidence(ROOT, options);
  report.reportPath = atomicJson(ROOT, options.output, report);
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main();
module.exports = { parseArgs, atomicJson };
