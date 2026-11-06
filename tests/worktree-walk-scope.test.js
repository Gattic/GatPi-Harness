#!/usr/bin/env node
"use strict";

// Linked worktrees live under <repo>/.worktrees/<slug> and hold a different
// branch's copy of the same project. A walk rooted at the primary checkout
// must not absorb those copies; a walk rooted inside a worktree must still
// cover that worktree, because its root is never name-checked against the
// ignore list.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { inferCommands } = require("../src/test-runner.js");
const { createAstTools } = require("../src/ast-tools.js");
const { listFiles: listFallbackFiles } = require("../src/lsp-fallback.js");
const { collectDocs } = require("../src/docs-lookup.js");
const { walkTests } = require("../src/change-impact.js");
const { walkFiles: walkProjectFiles } = require("../src/project-intelligence.js");
const { listFiles: listSnapshotFiles } = require("../src/session-branches.js");
const { sourceFootprint } = require("../src/code-context-scale-gates.js");
const { captureTreeFingerprint } = require("../src/tree-fingerprint.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const sandbox = tmpFixture("pi-worktree-walk-scope-");
const checkout = path.join(sandbox, "checkout");
const worktree = path.join(checkout, ".worktrees", "task-a");
const nestedWorktree = path.join(worktree, ".worktrees", "task-b");

function write(relative, content) {
  const file = path.join(checkout, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function paths(rows) { return rows.map((row) => (typeof row === "string" ? row : row.path)); }
function nested(rows) { return paths(rows).filter((file) => file.split("/").includes(".worktrees")); }
function sorted(rows) { return [...paths(rows)].sort(); }

function fixture() {
  // Primary checkout.
  write("src/app.js", "const firstPartyMarker = 1;\nmodule.exports = firstPartyMarker;\n");
  write("tests/app.test.js", "require('../src/app.js');\n");
  write("docs/guide.md", "# Guide\n");
  // Linked worktree on another branch, with a nested worktree of its own.
  write(".worktrees/task-a/.git", "gitdir: /nonexistent/.git/worktrees/task-a\n");
  write(".worktrees/task-a/src/app.js", "const worktreeBranchMarker = 2;\n");
  write(".worktrees/task-a/tests/app.test.js", "require('../src/app.js');\n");
  write(".worktrees/task-a/docs/guide.md", "# Guide (task-a)\n");
  write(".worktrees/task-a/.worktrees/task-b/.git", "gitdir: /nonexistent/.git/worktrees/task-b\n");
  write(".worktrees/task-a/.worktrees/task-b/src/app.js", "const nestedWorktreeMarker = 3;\n");
  write(".worktrees/task-a/.worktrees/task-b/tests/b.test.js", "require('../src/app.js');\n");
}

function commandLines(cwd) {
  const plan = inferCommands(cwd, {});
  return Object.values(plan.profiles).flat().map((command) => command.commandLine);
}

(async () => {
  fixture();
  try {
    // --- Walks rooted at the primary checkout skip every worktree copy ------
    const commands = commandLines(checkout);
    assert.ok(commands.includes("node tests/app.test.js"), "primary checkout still discovers its own tests");
    assert.deepEqual(commands.filter((line) => line.includes(".worktrees")), [], "test_runner must not select another branch's tests");

    const ast = createAstTools();
    const astSearch = await ast.search({ cwd: checkout }, { kind: "identifier", pattern: "firstPartyMarker", maxResults: 20 });
    assert.deepEqual([...new Set(astSearch.details.matches.map((match) => match.file))], ["src/app.js"], "ast_search must not match worktree copies");
    assert.equal(astSearch.details.filesScanned, 2, "ast_search scans only this checkout's source files");

    const explicitAst = await ast.search({ cwd: checkout }, { path: ".worktrees/task-a", kind: "identifier", pattern: "worktreeBranchMarker", maxResults: 20 });
    assert.deepEqual([...new Set(explicitAst.details.matches.map((match) => match.file))], ["src/app.js"], "an explicit path into a worktree is still searched");

    assert.deepEqual(sorted(listFallbackFiles(checkout)), ["src/app.js", "tests/app.test.js"], "lsp fallback file list is scoped to this checkout");
    assert.deepEqual(paths(collectDocs(checkout, { source: "local" })), ["docs/guide.md"], "docs lookup ignores worktree docs");
    assert.deepEqual(walkTests(checkout), ["tests/app.test.js"], "change impact ignores worktree tests");
    assert.deepEqual(sorted(walkProjectFiles(checkout)), ["docs/guide.md", "src/app.js", "tests/app.test.js"], "project intelligence ignores worktree files");
    assert.deepEqual(sorted(listSnapshotFiles(checkout)), ["docs/guide.md", "src/app.js", "tests/app.test.js"], "branch snapshots ignore worktree files");
    assert.equal(sourceFootprint(checkout).sourceFiles, 2, "scale-gate footprint counts only this checkout's sources");

    const fingerprint = captureTreeFingerprint(checkout);
    assert.equal(fingerprint.revision.source, "filesystem-fallback", "fixture has no Git repository");
    assert.equal(fingerprint.revision.fileCount, 3, "filesystem fingerprint covers only this checkout");

    // --- Walks rooted inside a worktree still cover that worktree ----------
    const worktreeCommands = commandLines(worktree);
    assert.ok(worktreeCommands.includes("node tests/app.test.js"), "a worktree-root walk discovers its own tests");
    assert.deepEqual(worktreeCommands.filter((line) => line.includes(".worktrees")), [], "a worktree-root walk skips nested worktrees");

    const worktreeAst = await ast.search({ cwd: worktree }, { kind: "identifier", pattern: "worktreeBranchMarker", maxResults: 20 });
    assert.deepEqual([...new Set(worktreeAst.details.matches.map((match) => match.file))], ["src/app.js"], "a worktree-root ast_search sees its own sources");
    assert.equal(worktreeAst.details.filesScanned, 2, "a worktree-root ast_search skips nested worktrees");

    assert.deepEqual(sorted(listFallbackFiles(worktree)), ["src/app.js", "tests/app.test.js"], "worktree-root lsp fallback stays inside the worktree");
    assert.deepEqual(paths(collectDocs(worktree, { source: "local" })), ["docs/guide.md"], "worktree-root docs lookup stays inside the worktree");
    assert.deepEqual(walkTests(worktree), ["tests/app.test.js"], "worktree-root change impact stays inside the worktree");
    assert.deepEqual(sorted(walkProjectFiles(worktree)), ["docs/guide.md", "src/app.js", "tests/app.test.js"], "worktree-root project intelligence stays inside the worktree");
    assert.deepEqual(sorted(listSnapshotFiles(worktree)), ["docs/guide.md", "src/app.js", "tests/app.test.js"], "worktree-root snapshots stay inside the worktree");
    assert.equal(sourceFootprint(worktree).sourceFiles, 2, "worktree-root footprint stays inside the worktree");

    const worktreeFingerprint = captureTreeFingerprint(worktree);
    assert.equal(worktreeFingerprint.revision.source, "filesystem-fallback");
    assert.equal(worktreeFingerprint.revision.fileCount, 3, "worktree-root fingerprint stays inside the worktree");

    console.log("worktree walk scope tests passed");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
