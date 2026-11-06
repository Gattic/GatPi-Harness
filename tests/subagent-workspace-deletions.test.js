"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { SubagentWorkspaceManager, repositoryFingerprint } = require("../src/subagent-workspaces");
const { SubagentPatchService } = require("../src/subagent-patches");
const { tmpFixture } = require("./helpers/tmp-fixture");

for (const operation of ["delete", "rename"]) test(`${operation} proposals seed read-only review and downstream workspaces`, async () => {
  const cwd = tmpFixture("pi-workspace-deletion-");
  try {
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    git(["init", "-q"]);
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(cwd, "old.sh"), "#!/bin/sh\nprintf fixture\\n\n");
    fs.chmodSync(path.join(cwd, "old.sh"), 0o755);
    fs.writeFileSync(path.join(cwd, "kept.txt"), "unchanged\n");
    git(["add", ".gitignore", "old.sh", "kept.txt"]); git(["commit", "-qm", "fixture"]);
    const before = repositoryFingerprint(cwd);
    const manager = new SubagentWorkspaceManager({ cwd });
    const producer = manager.acquire({ subagentId: "producer", parentSessionId: "fixture", task: operation, writeZones: ["old.sh", "new.sh"] });
    if (operation === "delete") fs.unlinkSync(path.join(producer.cwd, "old.sh"));
    else fs.renameSync(path.join(producer.cwd, "old.sh"), path.join(producer.cwd, "new.sh"));
    const proposal = manager.capture(producer, { status: "succeeded" });
    manager.release(producer);
    assert(proposal.patchBytes > 0);

    const review = manager.acquire({ subagentId: "review", parentSessionId: "fixture", task: "Review exact seeded candidate", seedPatches: [proposal], writeZones: [] });
    assert.equal(fs.existsSync(path.join(review.cwd, "old.sh")), false);
    if (operation === "rename") {
      assert.equal(fs.readFileSync(path.join(review.cwd, "new.sh"), "utf8"), fs.readFileSync(path.join(cwd, "old.sh"), "utf8"));
      assert.equal(fs.statSync(path.join(review.cwd, "new.sh")).mode & 0o100, 0o100);
    }
    const reviewed = manager.capture(review, { status: "succeeded" });
    assert.equal(reviewed.patchHash, proposal.patchHash, "review preserves the deletion/rename patch exactly");
    assert.equal(reviewed.candidateFileHash, proposal.candidateFileHash);
    fs.writeFileSync(path.join(review.cwd, "old.sh"), "unauthorized recreation\n");
    assert.throws(() => manager.capture(review), error => error.code === "SUBAGENT_WORKSPACE_WRITE_ZONE", "absence is part of the read-only snapshot");
    manager.release(review, { remove: true });

    const downstream = manager.acquire({ subagentId: "downstream", parentSessionId: "fixture", task: "Continue with declared ownership", seedPatches: [proposal], writeZones: ["followup.txt"] });
    fs.writeFileSync(path.join(downstream.cwd, "followup.txt"), "authorized follow-up\n");
    const combined = manager.capture(downstream, { status: "succeeded" });
    assert(combined.changedPaths.some(entry => entry.path === "old.sh"));
    assert(combined.changedPaths.some(entry => entry.path === "followup.txt"));
    assert.equal(fs.existsSync(path.join(downstream.cwd, "old.sh")), false);
    manager.release(downstream, { remove: true });
    assert.deepEqual(repositoryFingerprint(cwd), before, "seed and review operations leave parent bytes, status and modes unchanged");

    const patches = new SubagentPatchService({ cwd });
    await assert.rejects(() => patches.apply(patches.preview(proposal), { explicit: true, verify: async () => ({ status: "failed", evidence: [] }) }), error => error.code === "SUBAGENT_PATCH_VERIFICATION_FAILED");
    assert.deepEqual(repositoryFingerprint(cwd), before, "failed verification restores both ends of the rename, including executable mode");
    manager.release(producer, { remove: true });
    if (operation === "rename") {
      const unowned = manager.acquire({ subagentId: "unowned-source", parentSessionId: "fixture", task: "Reject a rename from an unowned source", writeZones: ["new.sh"] });
      fs.renameSync(path.join(unowned.cwd, "old.sh"), path.join(unowned.cwd, "new.sh"));
      assert.throws(() => manager.capture(unowned), error => error.code === "SUBAGENT_WORKSPACE_WRITE_ZONE");
      manager.release(unowned, { remove: true });
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
