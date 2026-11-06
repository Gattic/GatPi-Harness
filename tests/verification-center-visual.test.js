"use strict";

const assert = require("node:assert/strict");
const { Verifier, VerifiedExecutionPipeline } = require("../src/verification-pipeline");
const { VisualVerificationAdapter } = require("../src/integration-boundary");
const { providerReadiness, providerGateViolations } = require("../src/provider-readiness");

(async () => {
  const cwd = process.cwd();
  const adapter = new VisualVerificationAdapter({ cwd });
  const plan = adapter.plan({ profile: "changed", changedFiles: ["src/rollout-center-view.js"] });
  assert.equal(plan.ready, true);
  assert.equal(plan.cases.length, 3);
  const verifier = new Verifier({
    id: "visual-fixtures",
    kind: "visual",
    cacheable: false,
    files: ["src/rollout-center-view.js"],
    run: async () => {
      const visual = await adapter.run({ profile: "changed", changedFiles: ["src/rollout-center-view.js"] });
      return { ok: visual.ok === true, visual, artifacts: [], metrics: { visualCases: visual.resultCount } };
    },
  });
  const pipeline = new VerifiedExecutionPipeline({ verifiers: [verifier], requiredKinds: ["visual"], maxRetries: 0 });
  const evidence = await pipeline.verify({ cwd, patchSet: { id: "visual-test" }, changeSet: { changedFiles: ["src/rollout-center-view.js"], before: { "src/rollout-center-view.js": "before" }, after: { "src/rollout-center-view.js": "after" }, fingerprint: "visual-change" } });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.verifiers[0].kind, "visual");
  assert.equal(evidence.verifiers[0].visual.status, "pass");
  assert.equal(JSON.stringify(evidence).includes("Rollout Center |"), false, "verification evidence contains no captured frame lines");

  const optional = providerReadiness("visual", { required: false, applicable: true, ready: false, reason: "binary-unavailable" });
  assert.equal(optional.blocking, false);
  assert.equal(optional.status, "degraded");
  const required = providerReadiness("visual", { required: true, applicable: true, ready: false, reason: "binary-unavailable" });
  assert.equal(required.blocking, true);
  assert.equal(providerGateViolations([required])[0].provider, "visual");

  console.log("verification center visual tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
