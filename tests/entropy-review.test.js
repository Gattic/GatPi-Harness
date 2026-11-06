#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EntropyReview, EntropyAdapter, MemoryJsonStorage } = require("../src/integration-boundary");
const { openExperiment } = require("../src/experiment-ledger");
const { EvidenceStore } = require("../src/evidence-binder");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = tmpFixture("entropy-review-test-");
try {
  let now = Date.now();
  openExperiment(root, "entropy warning calibration pilot", { bars: ["human review only"] });
  const review = new EntropyReview({ cwd: root, clock: () => now, env: {} });
  review.initialize();
  const evidence = new EvidenceStore({ cwd: root });
  review.begin({ interactive: false, sessionId: "private", requestId: "smoke" });
  assert.equal(review.settle(), null);
  for (let i = 0; i < 40; i++) {
    review.begin({ interactive: true, sessionId: `PRIVATE_SESSION_${i}`, requestId: `r${i}` });
    const warned = i < 20;
    review.observe({ stabilization: { actions: warned ? [{ type: "request_failure_analysis", reason: "PRIVATE_REASON" }] : [] } }, 0.0001);
    const proof = evidence.saveEvidence({ id: `evidence_incident_${i}`, createdAt: new Date(now + 1).toISOString(), ok: true, summary: "Fixture review support" });
    now += 10;
    const row = review.settle();
    assert.equal(row.actions.length, Number(warned));
    const input = { reviewer: { kind: "human", id: "PRIVATE_REVIEWER" }, incident: warned, actionable: warned, privacyViolation: false, incidentOffsetMs: warned ? 0 : null, evidenceIds: [proof.id] };
    if (i === 0) {
      assert.throws(() => review.review(row.caseId, { ...input, reviewer: { kind: "model", id: "self" } }), /human/);
      assert.throws(() => review.review(row.caseId, { ...input, evidenceIds: ["missing"] }), /registered review evidence/);
      assert.throws(() => review.review(row.caseId, { ...input, incidentOffsetMs: 11 }), /within the task/);
    }
    review.review(row.caseId, input);
    assert.throws(() => review.review(row.caseId, input), /already reviewed/);
  }
  let report = review.report();
  assert.equal(report.warned, 20); assert.equal(report.unwarned, 20);
  assert.equal(report.actionablePrecision, 1); assert.equal(report.falsePositiveRate, 0);
  assert.equal(report.verdict, "ready-for-human-decision"); assert.equal(report.interventionsAuthorized, false);
  const entropy = new EntropyAdapter({ storage: new MemoryJsonStorage() }); entropy.review = review;
  review.begin({ interactive: true, sessionId: "adapter", requestId: "adapter" });
  entropy.observe({ type: "objective", text: "PRIVATE_DIAGNOSTIC_INPUT" });
  now += 10; const observed = review.settle();
  assert.equal(observed.observationCount, 1); assert(observed.observationMs >= 0);
  report = review.report(); assert.equal(report.verdict, "insufficient-data", "unreviewed tasks stay in the denominator");
  review.stop(); review.begin({ interactive: true, sessionId: "stop", requestId: "stop" }); assert.equal(review.settle(), null);
  const serialized = fs.readFileSync(path.join(root, ".pi/entropy-review/cohort.json"), "utf8");
  for (const marker of ["PRIVATE_SESSION", "PRIVATE_REVIEWER", "PRIVATE_REASON", "PRIVATE_DIAGNOSTIC_INPUT", root]) assert(!serialized.includes(marker));
  assert.equal(fs.statSync(path.join(root, ".pi/entropy-review/cohort.json")).mode & 0o777, 0o600);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("entropy review tests passed");
