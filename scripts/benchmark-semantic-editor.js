#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { SemanticEditEngine, semanticDiff } = require("../src/semantic-editor");

function buildFile(functions = 300) {
  let out = '"use strict";\nconst fs = require("node:fs");\n\n';
  for (let i = 0; i < functions; i++) {
    out += `function fn${i}(value) {\n  const base = String(value || "${i}");\n  return base + ":${i}";\n}\n\n`;
  }
  out += "module.exports = {};\n";
  return out;
}

const content = buildFile(Number(process.argv[2] || 300));
const engine = new SemanticEditEngine();
const patches = [];
for (let i = 0; i < 50; i += 5) {
  const start = content.indexOf(`function fn${i}`);
  const end = content.indexOf("\n\n", start);
  patches.push(engine.createPatch({
    filePath: "bench.js",
    content,
    start,
    end,
    replacement: `function fn${i}(value) {\n  const base = String(value || "${i}").trim();\n  return base + ":${i}:patched";\n}`,
  }));
}

const drifted = content.replace('const fs = require("node:fs");', 'const path = require("node:path");\nconst fs = require("node:fs");');
const t0 = performance.now();
const result = engine.apply(drifted, patches, { filePath: "bench.js" });
const t1 = performance.now();
assert.equal(result.ok, true);
const d0 = performance.now();
const diff = semanticDiff(drifted, result.content, "bench.js");
const d1 = performance.now();

console.log(JSON.stringify({
  bytes: content.length,
  patches: patches.length,
  applyMs: +(t1 - t0).toFixed(3),
  diffMs: +(d1 - d0).toFixed(3),
  changes: diff.changes.length,
  metrics: engine.metrics(),
}, null, 2));
