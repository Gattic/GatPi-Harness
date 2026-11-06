#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { toolMutationSnapshot } = require("../src/codegraph-adapter.js");
const { revisionId } = require("../src/code-context-revision.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const sandbox = tmpFixture("pi-codegraph-snapshot-async-");
const repo = path.join(sandbox, "repo");
const nested = path.join(repo, ".worktrees", "task");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "foo.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n.worktrees/\n");
for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "-qm", "fixture"]]) assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
fs.mkdirSync(nested, { recursive: true });

(async () => {
  let passed = false;
  try {
    // A deliberately slow git runner: each call yields for 60ms. The snapshot
    // must await these calls without blocking timers on the event loop.
    const calls = [];
    const slowGit = async (_file, args) => {
      calls.push(args);
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (args[0] === "worktree") return { stdout: `worktree ${repo}\0worktree ${nested}\0`, stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "0123456789abcdef\n", stderr: "" };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };

    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 20);
    const snapshot = await toolMutationSnapshot(repo, "bash", { command: "git status" }, { allowOutsideCwd: false, autoSync: false }, { execFile: slowGit });
    clearTimeout(timer);

    assert.equal(timerFired, true, "a slow git snapshot must not block the event loop");
    assert.deepEqual([...snapshot.keys()].sort(), [repo, nested].sort());
    for (const project of [repo, nested]) {
      const entry = snapshot.get(project);
      assert.equal(entry.available, true);
      assert.equal(entry.head, "0123456789abcdef");
      assert.equal(entry.mutationFingerprint, revisionId(entry));
    }
    assert.equal(calls.filter((args) => args[0] === "status").length, 2, "each project gets its own working-tree revision");

    passed = true;
    console.log("codegraph async mutation snapshot checks passed");
  } finally {
    if (passed) fs.rmSync(sandbox, { recursive: true, force: true });
    else console.error(`Preserved failing snapshot fixture: ${sandbox}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
