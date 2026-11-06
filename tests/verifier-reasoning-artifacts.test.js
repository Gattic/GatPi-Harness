"use strict";
const assert = require("node:assert/strict");
const { Verifier } = require("../src/verification-pipeline");
const { MemoryJsonStorage, createPiIntegrationBoundary } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-verifier-reasoning-");
  const verifier = new Verifier({
    id: "fail-unit",
    kind: "unit",
    files: ["**/*"],
    run: async () => ({ ok: false, output: "expected failure", error: "unit failed" }),
  });
  const boundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), verification: { enabled: true, verifiers: [verifier], options: { requiredKinds: [] } } });
  const evidenceResult = await boundary.verification.verify({ cwd: tmp, patchSet: { id: "p1", files: ["x.js"] }, changeSet: { changedFiles: ["x.js"], before: {}, after: {} } });
  assert.equal(evidenceResult.ok, false);

  const evidence = boundary.reasoning.recordVerifierEvidence({ claim: "patch p1 passes unit verifier", ok: evidenceResult.ok, kind: "unit", method: "verification-pipeline", observations: [evidenceResult.summary || evidenceResult.error || JSON.stringify(evidenceResult)], artifacts: [evidenceResult.evidenceFile], verifier: "fail-unit" });
  const feedback = boundary.reasoning.addVerifierFeedback({ evidenceId: evidence.id, status: "needs_revision", message: "unit verifier failed", requiredActions: ["fix unit failure", "rerun verifier"] });
  const failure = boundary.reasoning.analyzeFailure({ failure: evidenceResult, evidenceIds: [evidence.id], summary: "Verifier rejected patch p1" });

  assert.equal(evidence.type, "verifier_evidence");
  assert.equal(evidence.ok, false);
  assert.equal(feedback.type, "verifier_feedback");
  assert.equal(feedback.evidenceId, evidence.id);
  assert.equal(failure.type, "failure_analysis");
  assert(failure.correctiveActions.length >= 1);
  assert(boundary.reasoning.replay().some((step) => step.type === "failure_analysis"));
  console.log("verifier-reasoning-artifacts tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
