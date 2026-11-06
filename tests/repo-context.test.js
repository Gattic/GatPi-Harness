"use strict";
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { buildRepoContext, formatRepoContext } = require("../src/repo-context.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

// Git repo with docs, commits, and changes.
const repo = tmpFixture("pi-repo-context-");
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Rules\n\nAlways run tests before claiming done.\nNever push to main.\n");
fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n\nA demo repo.\n");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "a.js"), "console.log(1)\n");
execSync("git add -A && git commit -qm 'first commit'", { cwd: repo });
fs.writeFileSync(path.join(repo, "src", "a.js"), "console.log(2)\n");
fs.writeFileSync(path.join(repo, "new.txt"), "x\n");

const ctx = buildRepoContext(repo);
assert.equal(ctx.git.isGit, true);
assert.ok(ctx.git.branch.length > 0);
assert.equal(ctx.git.changed.length, 2, "modified + untracked files are listed");
assert.equal(ctx.git.totalChanged, 2);
assert.equal(ctx.git.shownChanged, 2);
assert.equal(ctx.git.truncated, false);
assert.match(ctx.git.recentCommits[0], /first commit/);
assert.ok(ctx.docs.some((d) => d.file === "CLAUDE.md" && /Always run tests/.test(d.digest)));
assert.ok(ctx.layout.includes("src"));

const text = formatRepoContext(ctx);
assert.match(text, /branch:/);
assert.match(text, /first commit/);
assert.match(text, /CLAUDE\.md/);
assert.match(text, /new\.txt/);
assert.ok(text.length < 4000, `context stays compact, got ${text.length}`);

// Clean and capped repositories preserve the full count before display truncation.
const capped = tmpFixture("pi-repo-context-capped-");
execSync("git init -q", { cwd: capped });
for (let index = 0; index < 22; index++) fs.writeFileSync(path.join(capped, `file-${String(index).padStart(2, "0")}.txt`), "x\n");
const cappedCtx = buildRepoContext(capped);
assert.equal(cappedCtx.git.totalChanged, 22);
assert.equal(cappedCtx.git.shownChanged, 15);
assert.equal(cappedCtx.git.changed.length, 15);
assert.equal(cappedCtx.git.truncated, true);
assert.match(formatRepoContext(cappedCtx), /22 changed \(showing 15\)/);

const clean = tmpFixture("pi-repo-context-clean-");
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: clean });
fs.writeFileSync(path.join(clean, "tracked.txt"), "base\n");
execSync("git add -A && git commit -qm base", { cwd: clean });
const cleanCtx = buildRepoContext(clean);
assert.deepEqual({ total: cleanCtx.git.totalChanged, shown: cleanCtx.git.shownChanged, truncated: cleanCtx.git.truncated }, { total: 0, shown: 0, truncated: false });
assert.match(formatRepoContext(cleanCtx), /working tree: clean/);

// Rename rows count as one changed path and detached HEAD remains explicit.
execSync("git mv tracked.txt renamed.txt", { cwd: clean });
const renameCtx = buildRepoContext(clean);
assert.equal(renameCtx.git.totalChanged, 1);
assert.match(renameCtx.git.changed[0], /^R/);
execSync("git reset --hard -q HEAD && git checkout --detach -q", { cwd: clean });
const detachedCtx = buildRepoContext(clean);
assert.equal(detachedCtx.git.branch, "(detached)");

// Fresh git init with no commits (unborn branch) is still recognized as git.
const unborn = tmpFixture("pi-repo-context-unborn-");
execSync("git init -q", { cwd: unborn });
fs.writeFileSync(path.join(unborn, "a.txt"), "x\n");
const unbornCtx = buildRepoContext(unborn);
assert.equal(unbornCtx.git.isGit, true, "unborn-branch repos are still git repos");
assert.ok(unbornCtx.git.branch.length > 0, "unborn branch name is resolved");
assert.equal(unbornCtx.git.changed.length, 1);
assert.equal(unbornCtx.git.totalChanged, 1);

// Non-git directory degrades gracefully.
const plain = tmpFixture("pi-repo-context-plain-");
fs.writeFileSync(path.join(plain, "AGENTS.md"), "# Agent notes\nUse pnpm.\n");
const plainCtx = buildRepoContext(plain);
assert.equal(plainCtx.git.isGit, false);
assert.deepEqual({ total: plainCtx.git.totalChanged, shown: plainCtx.git.shownChanged, truncated: plainCtx.git.truncated }, { total: 0, shown: 0, truncated: false });
assert.ok(plainCtx.docs.some((d) => d.file === "AGENTS.md"));
assert.match(formatRepoContext(plainCtx), /not a git repo/i);

console.log("repo-context tests passed");
