#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  affectedTestFiles,
  buildImportGraph,
  lexicalMatches,
  parseSpecifiers,
  reverseDependents,
  walkSourceFiles,
} = require("../src/test-selection.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-test-selection-");
function write(file, text) {
  const full = path.join(tmp, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

write("src/b.js", "module.exports = 2;\n");
write("src/a.js", "const b = require('./b.js');\nmodule.exports = b;\n");
write("src/lonely.js", "module.exports = 'lonely';\n");
write("src/other.js", "module.exports = 'other';\n");
write("src/orphan.js", "module.exports = 'orphan';\n");
write("tests/orphan.test.js", "// exercises behavior without importing the module directly\n");
write("tests/a.test.js", "require('../src/a.js');\n");
write("tests/other.test.js", "require('../src/other.js');\n");
write("tests/helper.js", "require('../src/b.js');\n");
write("tests/via-helper.test.js", "require('./helper.js');\n");
write("docs/lonely.md", "docs\n");
write("node_modules/pkg/index.js", "require('../../src/lonely.js');\n");
write(".pi/state/huge.json", "{}\n");
write(".pi/extensions/demo/index.ts", "import { a } from '../../../src/a.js';\n");

const walked = walkSourceFiles(tmp);
assert(walked.files.includes("src/a.js"));
assert(walked.files.includes(".pi/extensions/demo/index.ts"), "extension sources are code");
assert(!walked.files.some((file) => file.startsWith("node_modules/")), "vendored packages are not project code");
assert(!walked.files.some((file) => file.startsWith(".pi/") && !file.startsWith(".pi/extensions/")), "runtime state is not code");

assert.deepEqual(parseSpecifiers("const a = require('./a.js'); import x from './x.js'; import('./y.js');").sort(), ["./a.js", "./x.js", "./y.js"]);

const built = buildImportGraph(tmp);
const dependents = reverseDependents(built.graph);
assert(dependents.get("src/b.js").has("src/a.js"));
assert(dependents.get("src/b.js").has("tests/helper.js"));
assert(dependents.get("src/a.js").has(".pi/extensions/demo/index.ts"));

const tests = ["tests/a.test.js", "tests/other.test.js", "tests/via-helper.test.js"];

const transitive = affectedTestFiles({ cwd: tmp, changedFiles: ["src/b.js"], testFiles: tests, graph: built.graph });
assert.deepEqual(transitive.testFiles, ["tests/a.test.js", "tests/via-helper.test.js"], "selection follows the reverse import closure through helpers");
assert(transitive.strategies.includes("import-graph"));

const direct = affectedTestFiles({ cwd: tmp, changedFiles: ["tests/a.test.js"], testFiles: tests, graph: built.graph });
assert.deepEqual(direct.testFiles, ["tests/a.test.js"]);
assert(direct.strategies.includes("direct"));

const unrelated = affectedTestFiles({ cwd: tmp, changedFiles: ["src/lonely.js"], testFiles: tests, graph: built.graph });
assert.deepEqual(unrelated.testFiles, [], "a module with no importing test is not silently verified by an unrelated suite");
assert.deepEqual(unrelated.strategies, []);

write("src/large.js", `module.exports = "${"x".repeat(2000)}";\n`);
const bounded = walkSourceFiles(tmp, { maxBytes: 100 });
assert(bounded.skipped >= 1, "oversized source files are counted as skipped");
const incompleteGraph = buildImportGraph(tmp, { maxBytes: 100 });
assert.equal(incompleteGraph.complete, false, "an incomplete import graph must not claim complete coverage");
assert(incompleteGraph.skipped >= 1);

const lexical = lexicalMatches(["docs/lonely.md"], tests);
assert.deepEqual(lexical, [], "lexical matching is based on the file stem, not directory names");

const lexicalHit = lexicalMatches(["src/other.js"], tests);
assert.deepEqual(lexicalHit, ["tests/other.test.js"]);

const combined = affectedTestFiles({ cwd: tmp, changedFiles: ["src/other.js", "src/orphan.js"], testFiles: tests.concat("tests/orphan.test.js"), graph: built.graph });
assert(combined.testFiles.includes("tests/other.test.js"));
assert(combined.testFiles.includes("tests/orphan.test.js"));
assert(combined.strategies.includes("lexical"));

const emptyGraph = affectedTestFiles({ cwd: tmp, changedFiles: ["src/a.js"], testFiles: tests, graph: new Map([["src/a.js", []]]) });
assert.equal(emptyGraph.testFiles.length, 0);

console.log("test-selection tests passed");
