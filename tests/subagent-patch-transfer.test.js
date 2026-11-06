"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { SubagentWorkspaceManager } = require("../src/subagent-workspaces");
const { SubagentPatchService } = require("../src/subagent-patches");
const { tmpFixture } = require("./helpers/tmp-fixture");

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Pi Test", GIT_AUTHOR_EMAIL: "pi@example.invalid", GIT_COMMITTER_NAME: "Pi Test", GIT_COMMITTER_EMAIL: "pi@example.invalid" } }).trim(); }
const fixtureRoots = [];
function repo() { const cwd = tmpFixture("pi-role-patch-"); fixtureRoots.push(cwd); git(cwd, ["init", "-q"]); fs.writeFileSync(path.join(cwd, "app.txt"), "base\n"); git(cwd, ["add", "."]); git(cwd, ["commit", "-qm", "base"]); return cwd; }
function proposed(cwd, id = "sub_patch") { const manager = new SubagentWorkspaceManager({ cwd }); const lease = manager.acquire({ subagentId: id, parentSessionId: "sess", task: "propose patch" }); fs.writeFileSync(path.join(lease.cwd, "app.txt"), "child change\n"); fs.writeFileSync(path.join(lease.cwd, "new.txt"), "new file\n"); return { manager, lease, capture: manager.capture(lease, { status: "succeeded" }) }; }

(async () => {
  {
    const cwd = repo();
    const { capture } = proposed(cwd);
    const patches = new SubagentPatchService({ cwd });
    const preview = patches.preview(capture);
    assert.equal(preview.status, "ready");
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "base\n", "preview never applies filesystem changes");
    assert(preview.changedPaths.includes("app.txt"));
    assert(preview.changedPaths.includes("new.txt"));
    await assert.rejects(() => patches.apply(preview), (error) => error.code === "SUBAGENT_PATCH_EXPLICIT_APPLY_REQUIRED");
    const applied = await patches.apply(preview, { explicit: true, verify: async () => ({ status: "passed", evidence: ["synthetic verification"] }) });
    assert.equal(applied.applied, true);
    assert.equal(applied.verification.status, "passed");
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "child change\n");
    assert.equal(fs.readFileSync(path.join(cwd, "new.txt"), "utf8"), "new file\n");
  }

  {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "app.txt"), "parent dirty\n");
    fs.writeFileSync(path.join(cwd, "notes.md"), "parent untracked\n");
    const manager = new SubagentWorkspaceManager({ cwd });
    const lease = manager.acquire({ subagentId: "sub_dirty", parentSessionId: "sess", task: "change dirty parent snapshot" });
    fs.writeFileSync(path.join(lease.cwd, "app.txt"), "child atop dirty parent\n");
    fs.writeFileSync(path.join(lease.cwd, "notes.md"), "child changed untracked parent file\n");
    const capture = manager.capture(lease, { status: "succeeded" });
    const patches = new SubagentPatchService({ cwd });
    const preview = patches.preview(capture);
    await patches.apply(preview, { explicit: true, verify: async () => ({ status: "passed", evidence: [] }) });
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "child atop dirty parent\n");
    assert.equal(fs.readFileSync(path.join(cwd, "notes.md"), "utf8"), "child changed untracked parent file\n");
  }

  {
    const cwd = repo();
    const { capture } = proposed(cwd, "sub_stale");
    fs.writeFileSync(path.join(cwd, "app.txt"), "parent drift\n");
    const patches = new SubagentPatchService({ cwd });
    assert.throws(() => patches.preview(capture), (error) => error.code === "SUBAGENT_PATCH_STALE_PARENT");
  }

  {
    const cwd = repo();
    const { capture } = proposed(cwd, "sub_tamper");
    fs.appendFileSync(capture.patchFile, "tampered\n");
    const patches = new SubagentPatchService({ cwd });
    assert.throws(() => patches.preview(capture), (error) => error.code === "SUBAGENT_PATCH_HASH_MISMATCH");
  }

  {
    const cwd = repo();
    const patches = new SubagentPatchService({ cwd });
    assert.throws(() => patches.preview({ parentRoot: cwd, parentRevision: git(cwd, ["rev-parse", "HEAD"]), parentStatusFingerprint: "x", patchFile: path.join(cwd, "x.patch"), patchHash: "x", patchBytes: 0, changedPaths: [{ path: "../outside.txt" }] }), (error) => error.code === "SUBAGENT_PATCH_PATH_ESCAPE");
  }

  {
    const cwd = repo();
    const { capture } = proposed(cwd, "sub_verify_fail");
    const patches = new SubagentPatchService({ cwd });
    const preview = patches.preview(capture);
    await assert.rejects(() => patches.apply(preview, { explicit: true, verify: async () => ({ status: "failed", evidence: ["synthetic fail"] }) }), (error) => error.code === "SUBAGENT_PATCH_VERIFICATION_FAILED");
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "base\n", "failed post-apply verification rolls parent files back byte-for-byte");
    assert.equal(fs.existsSync(path.join(cwd, "new.txt")), false);
  }

  for (const verdict of ["failed", "passed"]) {
    const cwd = repo(), { capture } = proposed(cwd, `concurrent-${verdict}`);
    const patches = new SubagentPatchService({ cwd }), preview = patches.preview(capture);
    let failure;
    try { await patches.apply(preview, { explicit: true, verify: async () => {
      fs.writeFileSync(path.join(cwd, "app.txt"), "concurrent author change\n");
      fs.writeFileSync(path.join(cwd, "unrelated.txt"), "unrelated concurrent change\n");
      return { status: verdict, evidence: [] };
    } }); } catch (error) { failure = error; }
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "concurrent author change\n", `rollback preserves the intervening author at ${cwd}`);
    assert.equal(failure?.code, "SUBAGENT_PATCH_ROLLBACK_CONFLICT");
    assert.equal(fs.existsSync(path.join(cwd, "new.txt")), false, "unchanged owned paths still roll back");
    assert.equal(fs.readFileSync(path.join(cwd, "unrelated.txt"), "utf8"), "unrelated concurrent change\n");
    const recovery = JSON.parse(fs.readFileSync(path.join(cwd, failure.details.recoveryFile), "utf8"));
    assert.equal(Buffer.from(recovery.backups.find(entry => entry.relative === "app.txt").contentBase64, "base64").toString(), "base\n");
    assert.deepEqual(recovery.conflicts, ["app.txt"]);
  }

  {
    const cwd = repo(), { capture } = proposed(cwd, "serialized");
    const patches = new SubagentPatchService({ cwd }), preview = patches.preview(capture);
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const continueVerification = new Promise(resolve => { finish = resolve; });
    const first = patches.apply(preview, { explicit: true, verify: async () => { entered(); await continueVerification; return { status: "failed", evidence: [] }; } });
    try {
      await started;
      await assert.rejects(() => patches.apply(preview, { explicit: true }), error => error.code === "MANAGED_WORKER_CAPACITY");
    } finally { finish(); await assert.rejects(() => first, error => error.code === "SUBAGENT_PATCH_VERIFICATION_FAILED"); }
    assert.equal((await patches.apply(preview, { explicit: true, verify: async () => ({ status: "passed", evidence: [] }) })).applied, true, "the apply lease is released after rollback");
  }
  {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "removed.txt"), "tracked then deleted\n"); git(cwd, ["add", "."]); git(cwd, ["commit", "-qm", "deletion baseline"]);
    fs.unlinkSync(path.join(cwd, "removed.txt")); fs.symlinkSync("app.txt", path.join(cwd, "loose-link")); fs.writeFileSync(path.join(cwd, ".env"), "fixture-only-private\n");
    const { capture } = proposed(cwd, "dirty-deletion"), patches = new SubagentPatchService({ cwd });
    assert.throws(() => patches.preview({ ...capture, schemaVersion: 1 }), error => error.code === "SUBAGENT_PATCH_CANDIDATE_UNBOUND");
    const preview = patches.preview(capture);
    await assert.rejects(() => patches.apply(preview, { explicit: true, maxRecoveryBytes: 1 }), error => error.code === "SUBAGENT_PATCH_RECOVERY_BUDGET");
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "base\n");
    await patches.apply(preview, { explicit: true, verify: async () => ({ status: "passed", evidence: [] }) });
    assert.equal(fs.existsSync(path.join(cwd, "removed.txt")), false);
    assert.equal(fs.readlinkSync(path.join(cwd, "loose-link")), "app.txt");
    assert.equal(fs.readFileSync(path.join(cwd, ".env"), "utf8"), "fixture-only-private\n");
  }
  {
    const cwd = repo(), manager = new SubagentWorkspaceManager({ cwd });
    const lease = manager.acquire({ subagentId: "exec-mode", parentSessionId: "fixture", task: "Propose an executable-bit change" });
    fs.chmodSync(path.join(lease.cwd, "app.txt"), 0o755);
    const capture = manager.capture(lease, { status: "succeeded" }), patches = new SubagentPatchService({ cwd });
    await patches.apply(patches.preview(capture), { explicit: true, verify: async () => ({ status: "passed", evidence: [] }) });
    assert.equal(fs.statSync(path.join(cwd, "app.txt")).mode & 0o100, 0o100);
    assert.match(git(cwd, ["diff", "--summary"]), /mode change 100644 => 100755 app\.txt/);
  }
  {
    const cwd = repo(), { capture } = proposed(cwd, "index-drift");
    const patches = new SubagentPatchService({ cwd }), preview = patches.preview(capture);
    await assert.rejects(() => patches.apply(preview, { explicit: true, verify: async () => { git(cwd, ["add", "app.txt"]); return { status: "passed", evidence: [] }; } }), error => error.code === "SUBAGENT_PATCH_ROLLBACK_CONFLICT");
    assert.equal(git(cwd, ["show", ":app.txt"]), "child change");
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "child change\n", "foreign staging is preserved for explicit reconciliation");
  }
  {
    const cwd = repo(), { capture } = proposed(cwd, "retention");
    const patches = new SubagentPatchService({ cwd }), preview = patches.preview(capture);
    for (let index = 0; index < 20; index++) fs.writeFileSync(path.join(patches.dir, `${preview.id}.transaction-${index.toString(16).padStart(16, "0")}.json`), "{}\n", { mode: 0o600 });
    await assert.rejects(() => patches.apply(preview, { explicit: true }), error => error.code === "SUBAGENT_PATCH_RECOVERY_RETENTION");
    assert.equal(fs.readFileSync(path.join(cwd, "app.txt"), "utf8"), "base\n");
    assert.equal(fs.readdirSync(patches.dir).filter(name => name.includes(".transaction-")).length, 20, "retention never silently deletes historical recovery records");
  }
  {
    // An add-only patch backs nothing up, so its recovery budget stays small even
    // when the file it creates is large. The post-apply snapshot must still read
    // that file, otherwise a multi-megabyte asset patch is written to the parent
    // and then flagged for reconciliation instead of completing.
    const cwd = repo(), manager = new SubagentWorkspaceManager({ cwd });
    const lease = manager.acquire({ subagentId: "sub_add_large", parentSessionId: "sess", task: "propose a large new asset" });
    const bytes = Buffer.alloc(512 * 1024, 7);
    fs.mkdirSync(path.join(lease.cwd, "assets"), { recursive: true });
    fs.writeFileSync(path.join(lease.cwd, "assets", "dog.glb"), bytes);
    const capture = manager.capture(lease, { status: "succeeded" }), patches = new SubagentPatchService({ cwd });
    const preview = patches.preview(capture);
    assert(preview.changedPathHashes.some(entry => entry.path === "assets/dog.glb" && entry.bytes === bytes.length));
    const applied = await patches.apply(preview, { explicit: true, maxRecoveryBytes: 64 * 1024, verify: async () => ({ status: "passed", evidence: [] }) });
    assert.equal(applied.applied, true, "an add-only patch larger than its recovery budget still completes");
    assert.equal(fs.statSync(path.join(cwd, "assets", "dog.glb")).size, bytes.length);
    const journal = JSON.parse(fs.readFileSync(path.join(cwd, applied.recoveryFile), "utf8"));
    assert.equal(journal.status, "applied");
    assert.equal(journal.backups.find(entry => entry.relative === "assets/dog.glb").exists, false, "a new path is never backed up");
  }
  {
    // Overwriting an existing large file still needs a recovery budget that can
    // hold it: the snapshot relaxation must not weaken backup enforcement.
    const cwd = repo(), manager = new SubagentWorkspaceManager({ cwd });
    const bytes = Buffer.alloc(512 * 1024, 3);
    fs.mkdirSync(path.join(cwd, "assets"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "assets", "dog.glb"), bytes);
    const lease = manager.acquire({ subagentId: "sub_overwrite_large", parentSessionId: "sess", task: "overwrite an existing asset" });
    fs.writeFileSync(path.join(lease.cwd, "assets", "dog.glb"), Buffer.alloc(bytes.length, 9));
    const capture = manager.capture(lease, { status: "succeeded" }), patches = new SubagentPatchService({ cwd });
    await assert.rejects(() => patches.apply(patches.preview(capture), { explicit: true, maxRecoveryBytes: 64 * 1024 }), error => error.code === "SUBAGENT_PATCH_RECOVERY_BUDGET");
    assert.deepEqual(fs.readFileSync(path.join(cwd, "assets", "dog.glb")), bytes, "the parent asset is untouched when the backup cannot be afforded");
  }
  for (const cwd of fixtureRoots) fs.rmSync(cwd, { recursive: true, force: true });
  console.log("subagent patch transfer tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
