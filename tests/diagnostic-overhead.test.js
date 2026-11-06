#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { benchmark } = require("../scripts/benchmark-diagnostic-overhead");
const { tmpFixture } = require("./helpers/tmp-fixture");
const cwd = tmpFixture("diagnostic-overhead-test-");
try {
  const report = benchmark({ cwd, samples: 20, warmup: 2 });
  assert.equal(report.samples, 20);
  assert.equal(report.fieldEvidence, false);
  assert.equal(report.fieldObservationTimeShare, null);
  assert.equal(report.interventionsAuthorized, false);
  assert.match(report.sourceHash, /^sha256:[a-f0-9]{64}$/);
  for (const row of [report.controlPersistenceDisabled, report.candidatePrivatePersistence, report.pairedPersistenceIncrement]) assert(Number.isFinite(row.p95Ms));
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".pi")), [], "disposable microbenchmark traces do not accumulate");
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
console.log("diagnostic overhead tests passed");
