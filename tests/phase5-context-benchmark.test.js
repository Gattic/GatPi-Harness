#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { BASELINE, runBenchmark } = require("../scripts/benchmark-phase5-context.js");

const result = runBenchmark();
assert.equal(BASELINE.averageChars, 6147, "benchmark stays anchored to the recorded metadata-only Phase 5 baseline");
assert.equal(result.ok, true, JSON.stringify(result, null, 2));
assert(result.post.reductionPct >= 60, `expected >=60% injection reduction, got ${result.post.reductionPct}%`);
assert(result.post.averageChars <= 2459, `post-change average ${result.post.averageChars} exceeds ship bar`);
assert.equal(result.checks.objectiveRetention, true);
assert.equal(result.checks.constraintRetention, true);
assert.equal(result.checks.runtimeRetention, true);
assert.equal(result.checks.stableRouterGuidance, true);
assert.equal(result.checks.duplicateTurnSuppressed, true);
assert.equal(result.post.routerGuidance, 1);

console.log("phase5 context benchmark passed");
