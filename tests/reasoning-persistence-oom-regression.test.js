"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { ReasoningRuntime } = require("../src/reasoning-runtime");
const { summarizeVerificationResult } = require("../src/verification-pipeline");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-reasoning-oom-regression-");
const storage = new FileIntegrationStorage(tmp, { maxJsonBytes: 16 * 1024 * 1024 });
const runtime = new ReasoningRuntime({ storage });
const repeatedUnitOutput = "Unit Test Success /repo/unit-tests/example.cpp[752]\n".repeat(55_000);
const repeatedErrorOutput = "expected diagnostic warning\n".repeat(4_000);

for (let i = 0; i < 183; i++) {
  const fullProof = {
    id: `proof_${i}`,
    ok: false,
    status: "fail",
    createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    evidenceFile: `/repo/.pi/cognitive-automation/verification/evidence/proof_${i}.json`,
    changeSet: { changedFiles: [`src/file-${i}.cpp`], fingerprint: `fingerprint-${i}` },
    verifiers: [{ id: "unit", kind: "unit", ok: false, durationMs: 8000, output: repeatedUnitOutput, error: repeatedErrorOutput, metrics: { exitCode: 1, diagnosticPayload: repeatedUnitOutput } }],
    policy: { ok: false, violations: [{ reason: "unverified edit: verifier failure" }] },
  };
  const summary = summarizeVerificationResult(fullProof);
  assert(JSON.stringify(summary).length < 10_000, "verification summaries remain small regardless of raw output size");
  const evidence = runtime.recordVerifierEvidence({
    claim: `Automatic verification for src/file-${i}.cpp`,
    ok: false,
    kind: "automated",
    method: "verification-adapter",
    verifier: "cognitive-automation",
    observations: [JSON.stringify(summary)],
    artifacts: [fullProof.evidenceFile],
  });
  runtime.addVerifierFeedback({ evidenceId: evidence.id, status: "needs_revision", message: "Automatic verifier failed." });
  runtime.analyzeFailure({ failure: fullProof, evidenceIds: [evidence.id], summary: "Automatic verification failed." });
}

runtime.persist();
const stateFile = storage.jsonPath("reasoning-runtime");
const stateBytes = fs.statSync(stateFile).size;
assert(stateBytes < 5 * 1024 * 1024, `183 repeated multi-megabyte failures should persist below 5 MiB, got ${stateBytes}`);
const restored = new ReasoningRuntime({ storage });
assert.equal(restored.metrics().byType.verifier_evidence, 183);
assert.equal(restored.metrics().byType.failure_analysis, 183);
assert(restored.publicArtifacts({ type: "failure_analysis", limit: 1 })[0].failure.verifiers[0].output.length <= 2000);

const extensionSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
assert(extensionSource.includes("failure: resultSummary"), "automatic failure analysis stores the compact proof summary");
assert(!extensionSource.includes("failure: result, evidenceIds"), "automatic failure analysis must not retain the full proof payload");
assert(extensionSource.includes("snapshotReasoningState"), "reasoning snapshots use the safe storage copy path");
assert(extensionSource.includes('trigger: "automatic-verification"'), "automatic retention is enforced during long-running sessions, not only at startup");

console.log("reasoning persistence OOM regression tests passed");
