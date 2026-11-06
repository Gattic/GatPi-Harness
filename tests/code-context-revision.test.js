#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  parsePorcelainV2,
  readChangeSet,
  workingTreeRevision,
  revisionId,
  normalizeRepositoryPath,
} = require("../src/code-context-revision.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-code-context-revision-");
function git(args) {
  const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
git(["init", "-q"]);
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "old name.js"), "old\n");
fs.writeFileSync(path.join(tmp, "src", "delete.js"), "delete\n");
fs.writeFileSync(path.join(tmp, "src", "move-out.js"), "out\n");
fs.writeFileSync(path.join(tmp, "move-in.js"), "in\n");
git(["add", "."]);
git(["commit", "-qm", "fixture"]);
git(["mv", "src/old name.js", "src/new name.js"]);
fs.appendFileSync(path.join(tmp, "src", "new name.js"), "changed\n");
fs.unlinkSync(path.join(tmp, "src", "delete.js"));
fs.writeFileSync(path.join(tmp, "src", "untracked.js"), "new\n");

const set = readChangeSet(tmp, { configuration: { buildType: "debug" } });
assert.equal(set.available, true);
assert.equal(set.dirty, true);
assert.ok(set.head && set.head.length === 40);
assert.ok(set.changedPaths.includes("src/new name.js"));
assert.ok(set.changedPaths.includes("src/old name.js"), "rename source must be retained");
assert.ok(set.changedPaths.includes("src/delete.js"));
assert.ok(set.changedPaths.includes("src/untracked.js"));
const rename = set.changes.find((row) => row.kind === "renamed");
assert.equal(rename.path, "src/new name.js");
assert.equal(rename.originalPath, "src/old name.js");
assert.equal(rename.staged, true);
assert.equal(rename.unstaged, true);
assert.equal(set.changes.find((row) => row.kind === "untracked").sourceKind, "first_party");

const revision = workingTreeRevision(tmp, { configuration: { buildType: "debug" } });
assert.equal(revision.statusFingerprint, set.statusFingerprint);
assert.match(revisionId(revision), /^[a-f0-9]{40}\+[a-f0-9]{24}\+[a-f0-9]{24}$/);
assert.equal(normalizeRepositoryPath(tmp, "src\\new name.js"), "src/new name.js");
assert.throws(() => normalizeRepositoryPath(tmp, "../outside"), /inside repository/);

const raw = [
  "1 .M N... 100644 100644 100644 a b src/space file.js",
  "2 R. N... 100644 100644 100644 a b R100 src/new.js",
  "src/old.js",
  "? vendor/pkg/untracked.js",
  "u UU N... 100644 100644 100644 100644 a b c src/conflict.js",
  "",
].join("\0");
const parsed = parsePorcelainV2(raw, tmp);
assert.equal(parsed.find((row) => row.path === "src/space file.js").unstaged, true);
assert.equal(parsed.find((row) => row.path === "src/new.js").originalPath, "src/old.js");
assert.equal(parsed.find((row) => row.path === "vendor/pkg/untracked.js").sourceKind, "vendored");
assert.equal(parsed.find((row) => row.path === "src/conflict.js").kind, "unmerged");

const project = path.join(tmp, "src");
const scoped = readChangeSet(project);
assert.equal(scoped.available, true);
assert.deepEqual(scoped.changedPaths, ["delete.js", "new name.js", "old name.js", "untracked.js"]);
assert.equal(scoped.changes.find(row => row.kind === "renamed").originalPath, "old name.js");
assert.match(scoped.changes.find(row => row.path === "new name.js").contentHash, /^sha256:/, "nested project paths must hash the actual file");
fs.appendFileSync(path.join(project, "new name.js"), "another dirty edit\n");
const edited = readChangeSet(project);
assert.notEqual(edited.statusFingerprint, scoped.statusFingerprint);
fs.writeFileSync(path.join(tmp, "outside-project.js"), "unrelated\n");
assert.equal(readChangeSet(project).statusFingerprint, edited.statusFingerprint, "sibling mutations do not change a nested project's revision");
git(["mv", "src/move-out.js", "moved-out.js"]);
git(["mv", "move-in.js", "src/moved-in.js"]);
const crossing = readChangeSet(project);
assert.equal(crossing.changes.find(row => row.path === "move-out.js").kind, "deleted");
assert.equal(crossing.changes.find(row => row.path === "moved-in.js").kind, "added");
assert.ok(crossing.changedPaths.every(file => !file.startsWith("src/") && !file.startsWith("../")));

console.log("code-context revision tests passed");
