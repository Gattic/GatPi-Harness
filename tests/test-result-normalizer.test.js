#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { compactOutput, normalizeTestResult, normalizeTestResults } = require("../src/test-result-normalizer.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-test-normalizer-");
const output = ["\u001b[31mFAIL example\u001b[0m", "warning: repeat 1", "warning: repeat 2", "Expected: 42", "Actual: 41", "    at test (/repo/test.js:1:1)", "    at test (/repo/test.js:1:1)", "AssertionError [ERR_ASSERTION]", "50% progress"].join("\n");
const result = normalizeTestResult({ id: "node:test", ok: false, commandLine: "node tests/a.test.js", exitCode: 1, durationMs: 12, output }, { root: tmp });
assert.equal(result.status, "failed");
assert.equal(result.failureKind, "assertion");
assert.equal(result.expected, "42");
assert.equal(result.actual, "41");
assert.equal(result.topFrames.length, 1);
assert.ok(result.outputRef && fs.existsSync(path.join(tmp, result.outputRef.path)));
assert.equal(fs.statSync(path.join(tmp, result.outputRef.path)).mode & 0o077, 0);
assert.doesNotMatch(result.output, /\u001b/);
assert.doesNotMatch(result.output, /50% progress/);
assert.equal((result.output.match(/warning:/g) || []).length, 1);
const successes = compactOutput(["ok 1 - a", "ok 2 - b", "ok 3 - c", "ok 4 - d", "ok 5 - e"].join("\n"));
assert.match(successes, /additional passing/);
const summary = normalizeTestResults([{ ok: true, command: "true", durationMs: 1 }, { ok: false, command: "false", durationMs: 2, output: "failed" }], { root: tmp });
assert.deepEqual(summary.summary, { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 3 });
console.log("test result normalizer tests passed");
