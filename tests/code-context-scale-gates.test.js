#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SCALE_BARS, percentile, sourceFootprint, evaluateScaleGates } = require("../src/code-context-scale-gates.js");
const { parseArgs, atomicJson } = require("../scripts/probe-code-context-scale-gates.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
assert.equal(percentile([], 0.95), null);
const fast = evaluateScaleGates({ lexical: { warmP95Ms: 25, failures: [] }, semanticStartupP95Ms: null }, { repositoryCount: 1 });
assert.equal(fast.eligible, false);
assert.equal(fast.decision, "block-batch-7");
assert.equal(fast.gates.zoekt.measured, true);
assert.equal(fast.gates.scip.measured, false, "missing semantic measurements must not become a synthetic zero");
assert.equal(fast.gates.deepAnalysis.eligible, false);
const slowLexical = evaluateScaleGates({ lexical: { warmP95Ms: SCALE_BARS.lexicalWarmP95Ms + 1, failures: [] } }, {});
assert.deepEqual(slowLexical.eligibleProviders, ["zoekt"]);
const slowSemantic = evaluateScaleGates({ lexical: { warmP95Ms: 10, failures: [] }, semanticStartupP95Ms: SCALE_BARS.semanticStartupP95Ms + 1 }, {});
assert.deepEqual(slowSemantic.eligibleProviders, ["scip"]);
const demand = evaluateScaleGates({ lexical: { warmP95Ms: 10, failures: [] } }, { repositoryCount: 2, classifiedDeepQueries: 1, conceptualIssueMisses: 1 });
assert.deepEqual(demand.eligibleProviders, ["centralizedMultiRepository", "deepAnalysis", "embeddings"]);

const root = tmpFixture("pi-scale-gates-");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
fs.mkdirSync(path.join(root, ".pi", "extensions", "sample"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(root, "vendor", "ignored.js"), "ignored\n");
fs.writeFileSync(path.join(root, ".pi", "extensions", "sample", "index.ts"), "export default 1;\n");
const footprint = sourceFootprint(root);
assert.equal(footprint.sourceFiles, 2, "first-party .pi/extensions source is counted while vendor/runtime trees are excluded");

assert.deepEqual(parseArgs(["--iterations=3", "--repository-count", "2", "--semantic-startup-p95-ms=2500", "--classified-deep-queries=4", "--conceptual-misses", "5", "--output", ".pi/out.json"]), { output: ".pi/out.json", iterations: 3, repositoryCount: 2, classifiedDeepQueries: 4, conceptualIssueMisses: 5, semanticStartupP95Ms: 2500 });
const written = atomicJson(root, "evidence/report.json", { ok: true });
assert.equal(written, "evidence/report.json");
assert.equal(JSON.parse(fs.readFileSync(path.join(root, written), "utf8")).ok, true);
assert.throws(() => atomicJson(root, "../outside.json", {}), /inside the repository/);

console.log("code-context scale-gate tests passed");
