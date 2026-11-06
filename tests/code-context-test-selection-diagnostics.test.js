#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { legacyStem, parseArgs, classifyTask, buildTaxonomy } = require("../scripts/diagnose-code-context-test-selection.js");

assert.equal(legacyStem("src/chat-focus.js"), "chatfocusjs", "taxonomy preserves the historical stem defect");
assert.deepEqual(parseArgs(["--output", ".pi/x.json"]).output, ".pi/x.json");
assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
const task = { taskId: "task-1", goldRevision: "abc", gold: { sourceFiles: ["src/chat-focus.js", ".pi/extensions/runtime-doctor/index.ts"], testFiles: ["tests/chat-focus.test.js", "tests/productization-extensions.test.js"] } };
const row = { taskId: "task-1", selectedTests: [], provenance: { mustRun: 0, highConfidence: 0, graphOnly: 0 } };
const readText = (_revision, test) => test.includes("productization") ? "const extension = '.pi/extensions/runtime-doctor/index.ts';" : "require('../src/chat-focus.js');";
const classified = classifyTask(task, row, readText);
assert.ok(classified.categories.includes("no-candidate-edges"));
assert.ok(classified.categories.includes("no-codegraph-test-edges"));
assert.ok(classified.categories.includes("stem-normalization-defect"));
assert.ok(classified.categories.includes("bounded-lexical-recoverable"));
assert.equal(classified.recoverableGoldTests, 2);
assert.deepEqual(classified.uncoveredGoldTests, []);
const report = buildTaxonomy({ tasks: [task] }, { testSelectionRuns: [row] }, readText);
assert.equal(report.tasks, 1);
assert.equal(report.goldTests, 2);
assert.equal(report.recoverableGoldTests, 2);
assert.equal(report.categoryTasks["stem-normalization-defect"], 1);
console.log("code-context test-selection diagnostics tests passed");
