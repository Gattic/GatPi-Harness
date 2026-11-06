"use strict";

const assert = require("node:assert/strict");
const { loadManifest, runBenchmark } = require("../scripts/benchmark-parallel-evidence-topology");

(async () => {
  const manifest = loadManifest();
  assert.equal(manifest.cases.length, 3);
  const report = await runBenchmark();
  assert.equal(report.ok, true);
  assert.equal(report.safety.candidateFullyReadOnly, true);
  assert.equal(report.safety.routerPolicy, "suggest-only");
  assert.equal(report.safety.partialPolicy, "report");
  assert(report.cases.every((item) => item.candidate.coverageRatio === 1));
  assert(report.cases.every((item) => item.candidate.contradictionsDetected === 1));
  assert(report.cases.every((item) => item.candidate.gapsDetected === 1));
  assert(report.cases.every((item) => item.candidate.unsupportedAccepted === 0));
  assert(report.cases.every((item) => item.candidate.rejectedClaims >= 1), "the auditor explicitly rejects seeded unsupported claims");
  assert(report.cases.every((item) => item.deterministicParity));
  assert(report.cases.every((item) => item.candidate.uniqueEvidence > item.control.uniqueEvidence));
  assert.match(report.evidenceBoundary, /does not establish live model quality/);
  assert(!JSON.stringify(report).includes(manifest.cases[0].task), "benchmark reports retain task hashes rather than task text");
  console.log("parallel evidence benchmark tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
