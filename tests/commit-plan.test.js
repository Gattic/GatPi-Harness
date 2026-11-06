"use strict";
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { proposeCommitPlan, applyCommitGroup, formatCommitPlan, isHarnessRuntimeState } = require("../src/commit-plan.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const repo = tmpFixture("pi-commit-plan-");
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "auth.js"), "a\n");
fs.writeFileSync(path.join(repo, "README.md"), "r\n");
execSync("git add -A && git commit -qm init", { cwd: repo });

// Changes: a source+test pair, a docs change, and an unrelated script.
fs.writeFileSync(path.join(repo, "src", "auth.js"), "a2\n");
fs.writeFileSync(path.join(repo, "tests", "auth.test.js"), "t\n");
fs.writeFileSync(path.join(repo, "docs", "guide.md"), "g\n");
fs.writeFileSync(path.join(repo, "README.md"), "r2\n");
fs.writeFileSync(path.join(repo, "deploy.sh"), "#!/bin/sh\n");

// Harness runtime state and CMakeLists must be handled specially.
fs.mkdirSync(path.join(repo, ".pi", "traces"), { recursive: true });
fs.writeFileSync(path.join(repo, ".pi", "traces", "t.jsonl"), "{}\n");
fs.mkdirSync(path.join(repo, ".pi", "extensions", "fixture"), { recursive: true });
fs.writeFileSync(path.join(repo, ".pi", "extensions", "fixture", "index.ts"), "export default () => {};\n");
fs.writeFileSync(path.join(repo, "CMakeLists.txt"), "project(x)\n");

const plan = proposeCommitPlan(repo);
assert.ok(plan.groups.every((group) => group.files.every((file) => !isHarnessRuntimeState(file))), ".pi runtime state is never proposed for commit");
assert.ok(plan.groups.some((group) => group.files.includes(".pi/extensions/fixture/index.ts")), "project extension source remains committable");
const cmakeGroup = plan.groups.find((group) => group.files.includes("CMakeLists.txt"));
assert.ok(!/documentation/.test(cmakeGroup.title), "CMakeLists.txt is not documentation");
assert.ok(plan.groups.length >= 2, "changes are split into multiple groups");
const authGroup = plan.groups.find((group) => group.files.includes("src/auth.js"));
assert.ok(authGroup.files.includes("tests/auth.test.js"), "source and its test are grouped together");
const docsGroup = plan.groups.find((group) => group.files.includes("docs/guide.md"));
assert.ok(docsGroup.files.includes("README.md"), "doc changes group together");
assert.ok(!authGroup.files.includes("deploy.sh"), "unrelated script is not in the source group");
assert.ok(plan.groups.every((group) => group.suggestedMessage.length > 0));
assert.match(formatCommitPlan(plan), /src\/auth\.js/);

// Applying a group rejects runtime, outside, and stale paths before invoking Git.
assert.throws(() => applyCommitGroup(repo, [".pi/traces/t.jsonl"], "Bad runtime state"), /refuses harness runtime state/);
assert.throws(() => applyCommitGroup(repo, ["unchanged.txt"], "Bad stale path"), /not current committable changes/);
assert.throws(() => applyCommitGroup(repo, ["../outside.txt"], "Bad outside path"), /must stay inside/);
// Applying a current planned group commits exactly its files.
const result = applyCommitGroup(repo, authGroup.files, "Update auth with test");
assert.equal(result.ok, true);
const show = execSync("git show --stat --oneline HEAD", { cwd: repo, encoding: "utf8" });
assert.match(show, /Update auth with test/);
assert.match(show, /src\/auth\.js/);
assert.ok(!/deploy\.sh/.test(show), "unlisted files are not committed");
const remaining = proposeCommitPlan(repo);
assert.ok(remaining.groups.every((group) => !group.files.includes("src/auth.js")));

// Guard rails: empty file list and empty message are refused.
assert.throws(() => applyCommitGroup(repo, [], "msg"), /files/i);
assert.throws(() => applyCommitGroup(repo, ["README.md"], "  "), /message/i);

// Clean tree yields an empty plan with guidance.
execSync("git add -A && git commit -qm rest", { cwd: repo });
const clean = proposeCommitPlan(repo);
assert.equal(clean.groups.length, 0);
assert.match(clean.guidance, /clean/i);

console.log("commit-plan tests passed");
