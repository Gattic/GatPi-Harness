"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BRANCH_TYPES,
  SessionBranchManager,
  SnapshotStore,
  BranchVisualizer,
  diffFileStates,
  readFileState,
  restoreFileState,
  isPrivateSnapshotPath,
  sanitizeSnapshotForStorage,
  snapshotMaintenancePlan,
  applySnapshotMaintenance,
} = require("../src/session-branches");
const { tmpFixture } = require("./helpers/tmp-fixture");

(() => {
  const tmp = tmpFixture("pi-branches-");
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".pi", "cognitive-automation"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { value: 1 };\n");
  fs.writeFileSync(path.join(tmp, ".env"), "PRIVATE_FIXTURE=live\n");
  fs.writeFileSync(path.join(tmp, ".pi", "cognitive-automation", "cognitive-memory.json"), "PRIVATE_TRANSCRIPT_FIXTURE\n");

  const mgr = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi/session-branches")) });
  assert(BRANCH_TYPES.includes("experimental") && BRANCH_TYPES.includes("multi-agent"));

  const main = mgr.createBranch({ type: "verification", name: "main", metadata: { prompt: "PRIVATE_PROMPT", safeKind: "fixture" }, states: { memoryState: { facts: ["base"], transcript: [{ role: "user", content: "PRIVATE_TRANSCRIPT" }], token: "sk-1234567890abcdefghijklmnop" }, contextState: { tokens: 100 }, verifierState: { ok: true, successRate: 1 } } });
  const baseSnapshot = mgr.store.loadSnapshot(main.headSnapshotId);
  assert.equal(fs.statSync(mgr.store.branchFile(main.id)).mode & 0o777, 0o600, "branch records are private");
  assert.equal(fs.statSync(path.dirname(mgr.store.branchFile(main.id))).mode & 0o777, 0o700, "branch directories are private");
  assert.equal(fs.statSync(path.join(mgr.store.snapshotDir(main.headSnapshotId), "snapshot.json")).mode & 0o777, 0o600, "snapshot records are private");
  assert.equal(baseSnapshot.memoryState.transcript, undefined, "transcript-shaped recovery state is removed");
  assert.doesNotMatch(JSON.stringify(baseSnapshot), /PRIVATE_TRANSCRIPT|sk-1234567890abcdefghijklmnop/, "recovery state redacts transcript and secret material");
  assert(Object.prototype.hasOwnProperty.call(baseSnapshot.filesystemState.files, "src/app.js"));
  assert(!Object.prototype.hasOwnProperty.call(baseSnapshot.filesystemState.files, ".env"), "filesystem snapshots exclude environment files");
  assert(!Object.keys(baseSnapshot.filesystemState.files).some((file) => file.startsWith(".pi/cognitive-automation/")), "filesystem snapshots exclude private cognitive runtime state");
  const legacy = sanitizeSnapshotForStorage({ id: "legacy", filesystemState: { fingerprint: "old", files: { ".env.local": { exists: true, content: "PRIVATE" }, ".pi/cognitive-automation/memory.json": { exists: true, content: "TRANSCRIPT" }, "src/app.js": baseSnapshot.filesystemState.files["src/app.js"], "../escaped.txt": { exists: true, content: "ESCAPED" }, "alias/../src/app.js": { exists: true, content: "DUPLICATE" } } } });
  assert.deepEqual(Object.keys(legacy.filesystemState.files), ["src/app.js"], "legacy snapshots drop private, unsafe, and duplicate normalized paths before persistence");
  restoreFileState(tmp, { ".env": { exists: true, text: true, content: "PRIVATE_FIXTURE=historical\n" } });
  assert.equal(fs.readFileSync(path.join(tmp, ".env"), "utf8"), "PRIVATE_FIXTURE=live\n", "historical snapshots cannot restore private environment state");
  assert.equal(isPrivateSnapshotPath("alias/../.pi/cognitive-automation/cognitive-memory.json"), true, "dot-segment aliases cannot bypass private-path classification");
  assert.deepEqual(readFileState(tmp, ["alias/../.pi/cognitive-automation/cognitive-memory.json"]), {}, "private aliases are not captured");
  const escapedFile = path.join(path.dirname(tmp), `${path.basename(tmp)}-escaped.txt`);
  assert.throws(() => readFileState(tmp, [`../${path.basename(escapedFile)}`]), (error) => error?.code === "PI_SNAPSHOT_PATH_UNSAFE");
  assert.throws(() => readFileState(tmp, ["C:drive-relative.txt"]), (error) => error?.code === "PI_SNAPSHOT_PATH_UNSAFE");
  assert.throws(() => restoreFileState(tmp, { [`../${path.basename(escapedFile)}`]: { exists: true, text: true, content: "ESCAPED" } }), (error) => error?.code === "PI_SNAPSHOT_PATH_UNSAFE");
  assert.equal(fs.existsSync(escapedFile), false, "rollback cannot write outside cwd");
  const outsideDir = tmpFixture("pi-branches-outside-");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "PRIVATE_OUTSIDE");
  fs.symlinkSync(outsideDir, path.join(tmp, "linked-outside"), "dir");
  assert.throws(() => readFileState(tmp, ["linked-outside/secret.txt"]), (error) => error?.code === "PI_SNAPSHOT_PATH_UNSAFE");
  assert.throws(() => restoreFileState(tmp, { "linked-outside/new.txt": { exists: true, text: true, content: "ESCAPED" } }), (error) => error?.code === "PI_SNAPSHOT_PATH_UNSAFE");
  assert.equal(fs.existsSync(path.join(outsideDir, "new.txt")), false, "rollback cannot follow directory symlinks");
  fs.unlinkSync(path.join(tmp, "linked-outside"));
  fs.rmSync(outsideDir, { recursive: true, force: true });

  fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { value: 2 };\n");
  const experimental = mgr.createBranch({ fromBranchId: main.id, type: "experimental", name: "change value", states: { contextState: { tokens: 250, entropyScore: 0.2 }, verifierState: { ok: true, benchmarkDeltas: { latencyMs: { delta: -3 } } } } });
  assert.equal(experimental.parentBranchId, main.id, "lineage links parent branch");
  assert(experimental.lineage.includes(main.id), "lineage records ancestors");
  const exported = mgr.exportBranch(experimental.id);
  assert.equal(exported.exportPolicy, "metadata-only; recovery payload remains local");
  assert.equal(exported.snapshots[0].recoveryState, "local-only-redacted");
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_|filesystemState|memoryState|contextState|toolState|content/, "exports contain lineage and aggregate state only, never recovery payload");
  assert(experimental.score.score > 0.5, "branch score combines verifier/entropy/benchmark signals");

  mgr.rollback(experimental.id, baseSnapshot.id);
  assert.equal(fs.readFileSync(path.join(tmp, "src/app.js"), "utf8"), "module.exports = { value: 1 };\n", "rollback restores filesystem checkpoint");

  fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { value: 10 };\n");
  const left = mgr.createBranch({ fromBranchId: main.id, type: "speculative", name: "left", states: { memoryState: { decisions: ["left"] }, verifierState: { ok: true } } });
  fs.writeFileSync(path.join(tmp, "src/other.js"), "exports.ok = true;\n");
  const right = mgr.createBranch({ fromBranchId: main.id, type: "verification", name: "right", states: { memoryState: { decisions: ["right"] }, verifierState: { ok: true } } });

  const comparison = mgr.compare(left.id, right.id);
  assert(comparison.leftDelta.changed.includes("src/app.js"));
  assert(comparison.rightDelta.changed.includes("src/other.js"));

  const merged = mgr.merge(left.id, right.id, { apply: true });
  assert.equal(merged.ok, true, "non-overlapping semantic merge succeeds");
  assert(fs.existsSync(path.join(tmp, "src/other.js")), "merged filesystem can be applied");
  assert.equal(fs.readFileSync(path.join(tmp, "src/app.js"), "utf8"), "module.exports = { value: 10 };\n");

  fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { value: 20 };\n");
  const c1 = mgr.createBranch({ fromBranchId: main.id, type: "experimental", name: "conflict one" });
  mgr.instantRollback(baseSnapshot.id, { removeExtra: true });
  fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { value: 30 };\n");
  const c2 = mgr.createBranch({ fromBranchId: main.id, type: "experimental", name: "conflict two" });
  const conflict = mgr.merge(c1.id, c2.id);
  assert.equal(conflict.ok, false, "concurrent incompatible edits are detected");
  assert(conflict.conflicts.some((c) => c.file === "src/app.js"));

  const auto = mgr.autoBranch({ text: "run rm -rf /tmp/x", entropyScore: 0.1 }, { contextState: { reason: "risky" } });
  assert.equal(auto.type, "rollback", "risky operations are isolated automatically");

  const lease = mgr.assignAgent(auto.id, "agent-a", { tools: ["read"] });
  assert.equal(lease.active, true);
  assert.equal(mgr.completeAgentWork(auto.id, "agent-a", { ok: true }), true, "agent work can only be marked verified explicitly");
  mgr.quarantine(auto.id, "simulated failure");
  assert.equal(mgr.requireBranch(auto.id).status, "quarantined", "failed branches can be quarantined");

  const replay = mgr.replay(left.id);
  assert(replay.length >= 1 && replay[0].snapshot.filesystemState, "checkpoints are replayable");
  assert(mgr.visualizeTree().includes(main.id), "branch tree visualization renders lineage");
  assert(BranchVisualizer.divergence(comparison).includes("semantic distance"), "divergence visualization renders comparison");

  const d = diffFileStates(baseSnapshot.filesystemState.files, mgr.store.loadSnapshot(left.headSnapshotId).filesystemState.files);
  assert(d.changed.includes("src/app.js"));

  const protectedFile = path.join(mgr.store.snapshotDir(main.headSnapshotId), "snapshot.json");
  const protectedLegacy = JSON.parse(fs.readFileSync(protectedFile, "utf8"));
  protectedLegacy.filesystemState.files[".pi/cognitive-automation/private.json"] = { exists: true, text: true, content: "PRIVATE_TRANSCRIPT", bytes: 18 };
  fs.writeFileSync(protectedFile, `${JSON.stringify(protectedLegacy, null, 2)}\n`, { mode: 0o644 });
  fs.chmodSync(protectedFile, 0o644);
  const orphanDir = path.join(mgr.store.dir, "snapshots", "orphan");
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphanFile = path.join(orphanDir, "snapshot.json");
  fs.writeFileSync(orphanFile, JSON.stringify({ ...protectedLegacy, id: "orphan", at: "2020-01-01T00:00:00.000Z", branchId: "missing" }));
  fs.chmodSync(orphanFile, 0o644);
  const maintenance = snapshotMaintenancePlan(mgr.store.dir, { olderThanMs: 0, maxSnapshots: 100 });
  assert(maintenance.rewrites.some((item) => item.id === main.headSnapshotId && item.privateBefore === 1), "protected lineage snapshots are sanitized rather than deleted");
  assert(maintenance.removals.some((item) => item.id === "orphan"), "unreferenced old snapshots are cleanup candidates");
  const maintained = applySnapshotMaintenance(maintenance, { dryRun: false });
  assert.equal(maintained.applied, true);
  assert.equal(fs.existsSync(orphanFile), false);
  assert.equal(fs.statSync(protectedFile).mode & 0o777, 0o600);
  assert(!Object.keys(JSON.parse(fs.readFileSync(protectedFile, "utf8")).filesystemState.files).some((file) => file.startsWith(".pi/")));

  const cappedStore = new SnapshotStore(path.join(tmp, ".pi", "capped-branches"), { maxSnapshotBytes: 1024 });
  assert.throws(() => cappedStore.saveSnapshot({ id: "too-big", filesystemState: { files: { "src/huge.js": { exists: true, text: true, content: "x".repeat(3000), bytes: 3000 } } } }), /snapshot JSON exceeds/, "new snapshots obey the configured byte cap");

  console.log("session-branches tests passed");
})();
