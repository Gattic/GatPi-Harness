#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { normalizeRequiredProviders, providerReadiness, providerGateViolations } = require("../src/provider-readiness.js");

assert.deepEqual(normalizeRequiredProviders(["Semgrep", "codegraph", "semgrep", "visual"]), ["codegraph", "semgrep", "visual"]);
assert.deepEqual(normalizeRequiredProviders("semgrep,codegraph"), ["codegraph", "semgrep"]);
assert.throws(() => normalizeRequiredProviders(["unknown-provider"]), /Unknown required provider/);

const optionalMissing = providerReadiness("semgrep", { applicable: true, ready: false, reason: "missing-binary" });
assert.equal(optionalMissing.status, "degraded");
assert.equal(optionalMissing.outcome, "not-applicable");
assert.equal(optionalMissing.advisory, true);
assert.equal(optionalMissing.blocking, false);
assert.equal(optionalMissing.gatingSafe, false);

const requiredMissing = providerReadiness("semgrep", { required: true, applicable: true, ready: false, reason: "missing-binary", errorCode: "ENOENT" });
assert.equal(requiredMissing.status, "required-unavailable");
assert.equal(requiredMissing.outcome, "infrastructure-failed");
assert.equal(requiredMissing.blocking, true);
assert.equal(providerGateViolations([optionalMissing]).length, 0);
assert.deepEqual(providerGateViolations([requiredMissing]), [{ policy: "required-provider-readiness", provider: "semgrep", reason: "semgrep is required but unavailable (missing-binary)", errorCode: "ENOENT" }]);

const optionalReady = providerReadiness("codegraph", { applicable: true, ready: true, reason: "initialized" });
assert.equal(optionalReady.outcome, "succeeded");
assert.equal(optionalReady.advisory, true);
assert.equal(optionalReady.gatingSafe, false, "an optional provider never becomes proof merely because it is available");
const requiredReady = providerReadiness("codegraph", { required: true, applicable: true, ready: true, reason: "initialized" });
assert.equal(requiredReady.gatingSafe, true);

const noFiles = providerReadiness("semgrep", { required: true, applicable: false, ready: false, reason: "no-files" });
assert.equal(noFiles.status, "not-applicable");
assert.equal(noFiles.blocking, false, "an explicit provider gate does not fail when the operation itself is not applicable");

console.log("provider readiness checks passed");
