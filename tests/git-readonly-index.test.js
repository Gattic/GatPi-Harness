"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { captureGitRevision } = require("../src/tree-fingerprint-worker.js");
const { readChangeSet } = require("../src/code-context-revision.js");
const { discoverWorkingTreeFiles } = require("../src/verification-change-set.js");
const { buildRepoContext } = require("../src/repo-context.js");
const { contentIdentity } = require("../src/code-content-cache.js");
const { currentGitFacts } = require("../src/project-memory-recall.js");
const { proposeCommitPlan } = require("../src/commit-plan.js");
const { repositoryFingerprint } = require("../src/subagent-workspaces.js");
const { freshness } = require("../src/codegraph-adapter.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function fixture(t) {
  const cwd = tmpFixture("pi-git-readonly-index-");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (args, optionalLocks = "1") => {
    const result = spawnSync("git", args, {
      cwd, encoding: "utf8", env: {
        ...process.env, GIT_OPTIONAL_LOCKS: optionalLocks,
        GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(["init", "-q"]);
  for (const name of ["clean.txt", "modified.txt"]) fs.writeFileSync(path.join(cwd, name), "base\n");
  git(["add", "."]); git(["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n");
  git(["add", "staged.txt"]);
  fs.writeFileSync(path.join(cwd, "modified.txt"), "changed\n");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n");
  // A clean file with stale stat data forces ordinary status to refresh the
  // index, without requiring a huge fixture or a timing-dependent kill.
  const changedTime = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(cwd, "clean.txt"), changedTime, changedTime);
  return { cwd, git, index: path.join(cwd, ".git", "index"), lock: path.join(cwd, ".git", "index.lock") };
}

const readers = [
  ["streaming fingerprint", async cwd => assert.equal((await captureGitRevision(cwd)).dirty, true)],
  ["revision reader", cwd => assert.equal(readChangeSet(cwd).changes.length, 3)],
  ["verification discovery", async cwd => assert.equal((await discoverWorkingTreeFiles(cwd)).length, 3)],
  ["repository context", cwd => assert.equal(buildRepoContext(cwd).git.totalChanged, 3)],
  ["content cache", cwd => assert.equal(contentIdentity(cwd, "clean.txt").dirty, false)],
  ["project memory", cwd => assert.equal(currentGitFacts(cwd).dirty, true)],
  ["commit preview", cwd => assert.equal(proposeCommitPlan(cwd).entries.length, 3)],
  ["subagent fingerprint", cwd => assert.equal(repositoryFingerprint(cwd).files, 4)],
  ["CodeGraph freshness", cwd => assert.equal(freshness(cwd).pendingChanges.total, 3)],
];

for (const [name, read] of readers) {
  test(`${name} does not refresh or unlock the caller's index`, async t => {
    const { cwd, git, index, lock } = fixture(t);
    const previous = process.env.GIT_OPTIONAL_LOCKS;
    process.env.GIT_OPTIONAL_LOCKS = "1";
    t.after(() => {
      if (previous === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
      else process.env.GIT_OPTIONAL_LOCKS = previous;
    });
    const before = fs.readFileSync(index);
    const staged = git(["ls-files", "--stage"]);
    await read(cwd);
    assert.deepEqual(fs.readFileSync(index), before, "read-only Git must not persist a stat-cache refresh");
    assert.equal(fs.existsSync(lock), false);
    assert.equal(git(["ls-files", "--stage"]), staged, "staging must be unchanged");

    const sentinel = "owned by another writer\n";
    fs.writeFileSync(lock, sentinel, { flag: "wx" });
    await read(cwd);
    assert.equal(fs.readFileSync(lock, "utf8"), sentinel, "readers must never remove a writer's lock");
    assert.deepEqual(fs.readFileSync(index), before);
  });
}

test("disabling optional locks does not bypass mandatory writer locks", t => {
  const { cwd, git, index, lock } = fixture(t);
  const before = fs.readFileSync(index);
  fs.writeFileSync(lock, "owned test lock\n", { flag: "wx" });
  const blocked = spawnSync("git", ["add", "modified.txt"], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /index\.lock/);
  assert.deepEqual(fs.readFileSync(index), before);
  fs.unlinkSync(lock);
  git(["add", "modified.txt"], "0");
  assert.match(git(["diff", "--cached", "--name-only"]), /modified\.txt/);
});
