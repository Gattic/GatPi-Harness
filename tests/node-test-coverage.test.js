#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTestRunner } = require("../src/test-runner");
const { TestEvidenceIndex } = require("../src/test-evidence-index");
const { workingTreeRevision, revisionId } = require("../src/code-context-revision");
const { coverageEntities, MAX_BYTES } = require("../src/node-test-coverage");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const root = tmpFixture("pi-coverage-test-");
  try {
    fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 42;\n");
    fs.writeFileSync(path.join(root, "src/unused.js"), "module.exports = 0;\n");
    fs.writeFileSync(path.join(root, "tests/value.test.js"), "require('node:assert/strict').equal(require('../src/value'), 42);\n");
    for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "-qm", "fixture"]]) assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    const runner = createTestRunner();
    const input = { profile: "changed", files: ["tests/value.test.js"], coverage: true, configuration: "unit" };
    const inferred = await runner.infer({ cwd: root }, input);
    const result = await runner.run({ cwd: root }, { ...input, commandId: inferred.details.selected[0].id });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.runs[0].coverage.status, "collected");
    assert.equal(result.details.runs[0].coverage.accepted, 1);
    assert.equal(result.details.runs[0].coverage.gatingSafe, true);
    const current = revisionId(workingTreeRevision(root, { configuration: "unit" }));
    const index = new TestEvidenceIndex(root);
    assert.equal(index.queryEntity("src/value.js", { revision: current, configuration: "unit" })[0].gatingSafe, true);
    assert.equal(index.queryEntity("src/unused.js", { revision: current, configuration: "unit" }).length, 0, "unexecuted modules are not inferred from imports or filenames");
    assert.equal(index.queryEntity("src/value.js", { revision: current, configuration: "other" }).length, 0);
    fs.appendFileSync(path.join(root, "src/value.js"), "// changed\n");
    assert.equal(index.queryEntity("src/value.js", { revision: revisionId(workingTreeRevision(root, { configuration: "unit" })), configuration: "unit" })[0].gatingSafe, false);
    const without = await runner.run({ cwd: root }, { files: input.files });
    assert.equal(without.details.runs[0].coverage, undefined, "coverage is explicitly opt-in");
    fs.writeFileSync(path.join(root, "tests/value.test.js"), "require('../src/value'); throw new Error('fixture-failure');\n");
    const failure = await runner.run({ cwd: root }, input);
    assert.equal(failure.details.ok, false);
    assert.equal(failure.details.runs[0].coverage.gatingSafe, false, "coverage does not turn a failed test into passing evidence");
    const bounded = path.join(root, "raw"); fs.mkdirSync(bounded);
    fs.writeFileSync(path.join(bounded, "oversize.json"), "{}");
    fs.truncateSync(path.join(bounded, "oversize.json"), MAX_BYTES + 1);
    assert.throws(() => coverageEntities(root, bounded), /coverage-byte-limit/);
    const persisted = fs.readFileSync(path.join(root, ".pi/code-context/test-evidence.json"), "utf8");
    assert(!persisted.includes("module.exports") && !persisted.includes(root), "evidence contains no source bodies or absolute paths");
    console.log("Node test coverage workflow tests passed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
