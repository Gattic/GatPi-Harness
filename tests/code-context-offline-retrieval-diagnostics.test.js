#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { parseArgs, classifyCandidates } = require("../scripts/diagnose-code-context-offline-retrieval.js");
assert.equal(parseArgs(["--count=5"]).count, 5);
assert.throws(() => parseArgs(["--count=0"]), /1 through 30/);
const captured = [
  { provider: "ripgrep", query: "alpha", candidate: { path: "src/alpha.js", name: "alpha", signature: "alpha" } },
  { provider: "codegraph", query: "beta", candidate: { path: "src/beta.js", name: "beta", signature: "beta", graphScore: 0.5 } },
];
const rows = classifyCandidates(["src/alpha.js", "src/beta.js", "src/missing.js"], captured, ["src/alpha.js"], "fix alpha beta");
assert.equal(rows[0].classification, "hit");
assert.equal(rows[1].classification, "ranking-or-packing-miss");
assert.equal(rows[2].classification, "candidate-generation-miss");
assert.deepEqual(rows[0].providers, ["ripgrep"]);
console.log("code-context offline retrieval diagnostics tests passed");
