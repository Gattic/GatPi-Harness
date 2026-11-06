"use strict";
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { createCheckpoint, revertCheckpoint, listCheckpoints, formatCheckpoints, STATE_DIR } = require("../src/safe-try.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const repo = tmpFixture("pi-safe-try-");
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
fs.writeFileSync(path.join(repo, "a.js"), "base\n");
execSync("git add -A && git commit -qm init", { cwd: repo });

// Dirty state at checkpoint time: modified tracked file + untracked file.
fs.writeFileSync(path.join(repo, "a.js"), "attempt-1\n");
fs.writeFileSync(path.join(repo, "new.txt"), "keep me\n");
const cp = createCheckpoint(repo, "before risky change");
assert.ok(cp.id);
assert.deepEqual(Object.keys(cp).sort(), ["id", "untrackedCount", "untrackedSample"].sort());
assert.equal(cp.untrackedCount, 1);
assert.deepEqual(cp.untrackedSample, ["new.txt"]);
const storedCp = JSON.parse(fs.readFileSync(path.join(repo, STATE_DIR, cp.id, "checkpoint.json"), "utf8"));
assert.equal(storedCp.label, "before risky change");
assert.deepEqual(storedCp.untracked, ["new.txt"], "complete untracked paths remain in on-disk metadata");

// The risky change: further edits, a new file, and deleting the untracked one.
fs.writeFileSync(path.join(repo, "a.js"), "attempt-2-broken\n");
fs.writeFileSync(path.join(repo, "extra.txt"), "made after checkpoint\n");
fs.unlinkSync(path.join(repo, "new.txt"));

const reverted = revertCheckpoint(repo, cp.id);
assert.equal(fs.readFileSync(path.join(repo, "a.js"), "utf8"), "attempt-1\n", "tracked file restored to checkpoint state");
assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "keep me\n", "untracked file at checkpoint time is restored");
assert.ok(fs.existsSync(path.join(repo, "extra.txt")), "files created after the checkpoint are never deleted");
assert.equal(reverted.untrackedRestoredCount, 1);
assert.deepEqual(reverted.untrackedRestoredSample, ["new.txt"]);
assert.equal(reverted.newFilesSinceCheckpointCount, 1);
assert.deepEqual(reverted.newFilesSinceCheckpointSample, ["extra.txt"], "new files are sampled for manual review");

// Checkpoint on a clean tree reverts modifications back to HEAD state.
execSync("git add -A && git commit -qm wip", { cwd: repo });
const cleanCp = createCheckpoint(repo, "clean point");
fs.writeFileSync(path.join(repo, "a.js"), "scribble\n");
revertCheckpoint(repo, cleanCp.id);
assert.equal(fs.readFileSync(path.join(repo, "a.js"), "utf8"), "attempt-1\n");

const checkpoints = listCheckpoints(repo);
assert.equal(checkpoints.length, 2);
assert.ok(checkpoints.every((checkpoint) => !("untracked" in checkpoint)));
assert.match(formatCheckpoints(checkpoints), /untracked snapshot:/);
assert.throws(() => revertCheckpoint(repo, "nope"), /not found/i);

// A large generated tree must not become an unbounded model-visible tool result.
const largeRepo = tmpFixture("pi-safe-try-large-");
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: largeRepo });
fs.writeFileSync(path.join(largeRepo, "tracked.txt"), "base\n");
execSync("git add -A && git commit -qm init", { cwd: largeRepo });
const largeUntrackedCount = 2_000;
for (let i = 0; i < largeUntrackedCount; i += 1) {
  const dir = path.join(largeRepo, "generated", `group-${String(Math.floor(i / 50)).padStart(4, "0")}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `item-${String(i).padStart(5, "0")}-${"x".repeat(180)}.json`;
  fs.writeFileSync(path.join(dir, name), "{}\n");
}
const largeCp = createCheckpoint(largeRepo, "large generated tree");
const modelVisibleCheckpoint = JSON.stringify(largeCp, null, 2);
assert.equal(largeCp.untrackedCount, largeUntrackedCount);
assert.equal(largeCp.untrackedSample.length, 20);
assert.ok(!("untracked" in largeCp));
assert.ok(Buffer.byteLength(modelVisibleCheckpoint) < 16 * 1024, "checkpoint tool result stays bounded");
const storedLargeCp = JSON.parse(fs.readFileSync(path.join(largeRepo, STATE_DIR, largeCp.id, "checkpoint.json"), "utf8"));
assert.equal(storedLargeCp.untracked.length, largeUntrackedCount, "on-disk metadata retains every path");
assert.deepEqual(largeCp.untrackedSample, storedLargeCp.untracked.slice(0, 20));
const listedLarge = listCheckpoints(largeRepo);
assert.ok(Buffer.byteLength(JSON.stringify(listedLarge, null, 2)) < 16 * 1024, "list tool details stay bounded");
assert.ok(Buffer.byteLength(formatCheckpoints(listedLarge)) < 16 * 1024, "list tool text stays bounded");
fs.writeFileSync(path.join(largeRepo, "post-checkpoint.txt"), "new\n");
const revertedLarge = revertCheckpoint(largeRepo, largeCp.id);
assert.equal(revertedLarge.untrackedRestoredCount, largeUntrackedCount);
assert.equal(revertedLarge.untrackedRestoredSample.length, 20);
assert.equal(revertedLarge.newFilesSinceCheckpointCount, 1);
assert.deepEqual(revertedLarge.newFilesSinceCheckpointSample, ["post-checkpoint.txt"]);
assert.ok(Buffer.byteLength(JSON.stringify(revertedLarge, null, 2)) < 16 * 1024, "revert tool result stays bounded");

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(largeRepo, { recursive: true, force: true });
console.log("safe-try tests passed");
