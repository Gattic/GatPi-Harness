"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DAY_MS,
  planSessionHygiene,
  applySessionPermissions,
  archiveSessionCandidates,
  hardenActiveSessionFile,
  listSessionFiles,
  sessionPermissionPosture,
  publicSessionHygienePlan,
  summarizeSessionFile,
} = require("../src/session-hygiene");
const { parseDuration, parseArgs, validateOptions } = require("../scripts/session-hygiene");
const { tmpFixture } = require("./helpers/tmp-fixture");

function writeSession(file, cwd, id, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const rows = [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "model_change", id: "aaaaaaaa", parentId: null, timestamp: "2026-01-01T00:00:00.001Z", provider: "test", modelId: "test" },
    { type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "2026-01-01T00:00:00.002Z", message: { role: "user", content: [{ type: "text", text: "probe" }], timestamp: 1 } },
    ...(options.assistant === false ? [] : [{ type: "message", id: "cccccccc", parentId: "bbbbbbbb", timestamp: "2026-01-01T00:00:00.003Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } }]),
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const old = new Date(Date.now() - 30 * DAY_MS);
  fs.utimesSync(file, old, old);
}

(() => {
  const tmp = tmpFixture("pi-session-hygiene-test-");
  const root = path.join(tmp, "agent", "sessions");
  const archiveRoot = path.join(tmp, "agent", "session-archive");
  const project = path.join(tmp, "project");
  const classifiedTempRoot = path.join(tmp, "classified-temp-root");
  const tempCwd = path.join(classifiedTempRoot, "pi-headless-smoke-hygiene");
  const tempFile = path.join(root, "--tmp-pi-headless-smoke-hygiene--", "temp.jsonl");
  const oneShotFile = path.join(root, "--project--", "one-shot.jsonl");
  const activeFile = path.join(root, "--project--", "active.jsonl");
  const migrationMarker = path.join(tmp, "agent", "session-permissions-v2.json");
  writeSession(tempFile, tempCwd, "temp-session");
  writeSession(oneShotFile, project, "one-shot-session");
  writeSession(activeFile, project, "active-session");

  const summary = summarizeSessionFile(oneShotFile);
  assert.equal(summary.valid, true);
  assert.equal(summary.users, 1);
  assert.equal(summary.assistants, 1);

  const safePlan = planSessionHygiene({ root, archiveRoot, migrationMarker, olderThanMs: 7 * DAY_MS, activeSessionFile: activeFile, tempRoot: classifiedTempRoot, now: Date.now() });
  assert.equal(safePlan.archiveCandidates.length, 1, "default archive selection is restricted to temporary cwd sessions");
  assert(safePlan.summary.entriesScanned > 0 && safePlan.policy.maxScanBytesPerFile > 0, "session scanning records bounded entry and per-file limits");
  assert.equal(safePlan.archiveCandidates[0].path, tempFile);
  assert(safePlan.permissionChanges.some((item) => item.path === oneShotFile && item.toMode === 0o600));
  assert(!safePlan.permissionChanges.some((item) => item.path === activeFile), "the active session file is excluded from the one-time migration");
  assert.equal(safePlan.migration.version, 2);
  assert.equal(safePlan.migration.alreadyApplied, false);
  assert.equal(safePlan.summary.activeFilesExcluded, 1);
  assert.equal(safePlan.summary.modeCounts.files["0644"], 3);
  assert.ok(safePlan.summary.modeCounts.directories["0755"] >= 1);
  assert.match(safePlan.permissionManifest.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(safePlan.permissionManifest.permissionChanges, safePlan.permissionChanges.length);
  const publicPlan = publicSessionHygienePlan(safePlan);
  assert.equal(publicPlan.scope.containsPaths, false);
  assert.doesNotMatch(JSON.stringify(publicPlan), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "public plan contains no raw paths");
  const beforePosture = sessionPermissionPosture({ root });
  assert.equal(beforePosture.nonPrivateFiles, 3);
  assert.equal(beforePosture.compliant, false);

  const missingPreview = applySessionPermissions(safePlan, { dryRun: false, previewPath: path.join(tmp, "missing-preview.json") });
  assert.equal(missingPreview.changed.length, 0);
  assert.equal(missingPreview.errors[0].code, "preview-mismatch", "permission apply requires a matching prior preview");
  assert.equal(fs.statSync(oneShotFile).mode & 0o777, 0o644);
  const preview = applySessionPermissions(safePlan, { dryRun: true });
  assert(preview.changedCount > 0);
  assert.deepEqual(preview.changed, [], "aggregate preview does not return per-session identifiers");
  assert.equal(preview.preview.fingerprint, safePlan.permissionManifest.fingerprint);
  assert.equal(preview.preview.persisted, false, "ordinary preview writes no manifest");
  assert.equal(fs.existsSync(safePlan.migration.previewPath), false, "ordinary preview leaves runtime state byte-identical");
  const persistedPreview = applySessionPermissions(safePlan, { dryRun: true, writePreview: true });
  assert.equal(persistedPreview.preview.persisted, true);
  assert.equal(fs.statSync(safePlan.migration.previewPath).mode & 0o777, 0o600, "explicit aggregate permission preview is private");
  const previewText = fs.readFileSync(safePlan.migration.previewPath, "utf8");
  assert.doesNotMatch(previewText, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "preview persists no raw paths");
  assert.doesNotMatch(previewText, /active-session|one-shot-session|temp-session/, "preview persists no session IDs");
  assert.equal(fs.statSync(oneShotFile).mode & 0o777, 0o644, "permission preview is non-mutating");
  const hardened = applySessionPermissions(safePlan, { dryRun: false });
  assert.equal(hardened.errors.length, 0);
  assert.equal(fs.statSync(oneShotFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(oneShotFile)).mode & 0o777, 0o700);
  assert.equal(hardened.migrationCompleted, true);
  assert.equal(fs.statSync(migrationMarker).mode & 0o777, 0o600, "the one-time migration marker is private");
  const repeated = planSessionHygiene({ root, archiveRoot, migrationMarker, activeSessionFile: activeFile, tempRoot: classifiedTempRoot });
  assert.equal(repeated.migration.alreadyApplied, true);
  assert.equal(repeated.permissionChanges.length, 0, "a completed one-time migration is not silently re-applied");

  fs.chmodSync(activeFile, 0o644);
  assert.equal(hardenActiveSessionFile(activeFile).changed, true);
  assert.equal(fs.statSync(activeFile).mode & 0o777, 0o600, "active sessions are hardened immediately");
  const afterPosture = sessionPermissionPosture({ root });
  assert.equal(afterPosture.nonPrivateFiles, 0);
  assert.equal(afterPosture.nonPrivateDirectories, 0);
  assert.equal(afterPosture.compliant, true);

  const archivePreview = archiveSessionCandidates(safePlan, { dryRun: true, batchId: "preview" });
  assert.equal(archivePreview.moved.length, 1);
  assert(fs.existsSync(tempFile), "archive preview does not move data");
  const archived = archiveSessionCandidates(safePlan, { dryRun: false, batchId: "applied" });
  assert.equal(archived.errors.length, 0);
  assert.equal(archived.moved.length, 1);
  assert(!fs.existsSync(tempFile));
  assert(fs.existsSync(archived.manifestPath));
  assert.equal(fs.statSync(archived.manifestPath).mode & 0o777, 0o600);
  const archivedFile = path.join(archiveRoot, archived.moved[0].destinationRelativePath);
  assert(fs.existsSync(archivedFile));
  assert.equal(fs.statSync(archivedFile).mode & 0o777, 0o600);

  assert.throws(() => planSessionHygiene({ root, archiveRoot, includeOneShot: true }), /explicit projectCwd/, "one-shot selection cannot be enabled globally");
  assert.throws(() => planSessionHygiene({ root, archiveRoot: path.join(root, "archive") }), /outside the active session root/, "archive output cannot be nested beneath live sessions");
  const oneShotPlan = planSessionHygiene({ root, archiveRoot, olderThanMs: 7 * DAY_MS, includeTemporary: false, includeOneShot: true, projectCwd: project, activeSessionFile: activeFile, tempRoot: classifiedTempRoot, now: Date.now() });
  assert.deepEqual(oneShotPlan.archiveCandidates.map((item) => item.path), [oneShotFile], "one-shot retention requires explicit project-scoped opt-in");
  assert(!oneShotPlan.archiveCandidates.some((item) => item.path === activeFile), "active session is never archived");
  fs.appendFileSync(oneShotFile, `${JSON.stringify({ type: "custom", id: "changed-after-preview" })}\n`);
  const staleArchive = archiveSessionCandidates(oneShotPlan, { dryRun: false, batchId: "stale-candidate" });
  assert.equal(staleArchive.moved.length, 0);
  assert.match(staleArchive.errors[0].error, /changed since preview/, "archive apply refuses sessions changed after planning");
  assert(fs.existsSync(oneShotFile));

  const bounded = listSessionFiles(root, 100, 1);
  assert.equal(bounded.truncated, true, "directory traversal is bounded independently of matching JSONL count");
  assert.equal(bounded.entriesScanned, 1);

  assert.equal(parseDuration("7d"), 7 * DAY_MS);
  const parsed = parseArgs(["--apply", "--archive", "--write-manifest", "--yes", "--include-one-shot", "--older-than=3d", "--project", project, "--max-entries=123", "--max-scan-bytes=456"]);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.archive, true);
  assert.equal(parsed.writeManifest, true);
  assert.equal(parsed.confirmed, true);
  assert.doesNotThrow(() => validateOptions(parsed));
  assert.throws(() => validateOptions(parseArgs(["--write-manifest"])), /requires --yes/, "manifest persistence requires explicit confirmation");
  assert.equal(parsed.includeOneShot, true);
  assert.equal(parsed.olderThanMs, 3 * DAY_MS);
  assert.equal(parsed.projectCwd, project);
  assert.equal(parsed.maxEntries, 123);
  assert.equal(parsed.maxScanBytesPerFile, 456);

  const repoRoot = path.resolve(__dirname, "..");
  for (const script of ["check-reasoning-tui-injection.sh", "check-subagent-tui.sh", "check-goal-tui.sh", "check-topology-tui.sh", "check-worker-shadow-canary-tui.sh", "check-prompt-suggestions-tui.sh"]) {
    const source = fs.readFileSync(path.join(repoRoot, "scripts", script), "utf8");
    assert(source.includes("--no-session"), `${script} must not pollute global Pi session storage`);
  }
  const reasoningTuiSource = fs.readFileSync(path.join(repoRoot, "scripts", "check-reasoning-tui-injection.sh"), "utf8");
  assert(reasoningTuiSource.includes("--no-extensions -e '$PWD/.pi/extensions/reasoning-runtime/index.ts'"), "the reasoning TUI smoke loads only its target extension so nested isolated worktrees cannot double-discover ancestor project extensions");

  console.log("session hygiene tests passed");
})();

(() => {
  const tmp = tmpFixture("pi-session-migration-safety-");
  const root = path.join(tmp, "sessions");
  const archiveRoot = path.join(tmp, "archive");
  const marker = path.join(tmp, "migration.json");
  const file = path.join(root, "project", "swap.jsonl");
  writeSession(file, path.join(tmp, "project"), "swap-session");
  const plan = planSessionHygiene({ root, archiveRoot, migrationMarker: marker, olderThanMs: 0 });
  const planned = plan.permissionChanges.find((item) => item.path === file);
  assert(planned?.identity?.ino, "permission preview records file identity for apply-time revalidation");
  const permissionPreview = applySessionPermissions(plan, { dryRun: true, writePreview: true });
  assert.equal(permissionPreview.errors.length, 0);
  const replacement = path.join(root, "project", "swap-replacement.jsonl");
  writeSession(replacement, path.join(tmp, "replacement"), "replacement-session");
  fs.renameSync(replacement, file);
  const swapped = applySessionPermissions(plan, { dryRun: false });
  assert(swapped.errors.some((item) => item.code === "path-changed-since-preview"), "permission apply refuses same-type inode swaps");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(marker), false, "a failed migration does not write its completion marker");

  const bounded = planSessionHygiene({ root, archiveRoot, migrationMarker: marker, maxFiles: 1, maxEntries: 1 });
  assert.equal(bounded.summary.truncated, true);
  const boundedApply = applySessionPermissions(bounded, { dryRun: false });
  assert(boundedApply.errors.some((item) => item.code === "unsafe-or-incomplete-plan"), "a truncated migration cannot be marked complete");

  const outside = path.join(tmp, "outside.jsonl");
  writeSession(outside, tmp, "outside");
  const activeLink = path.join(tmp, "active-link.jsonl");
  fs.symlinkSync(outside, activeLink);
  const activeResult = hardenActiveSessionFile(activeLink);
  assert.match(activeResult.error, /symbolic link|symlink/i);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644, "active-session fallback never chmods a symlink target");
})();

(() => {
  const tmp = tmpFixture("pi-session-archive-safety-");
  const root = path.join(tmp, "sessions");
  const archiveRoot = path.join(tmp, "archive");
  const marker = path.join(tmp, "migration.json");
  const candidate = path.join(root, "--tmp-archive-swap--", "candidate.jsonl");
  const outside = path.join(tmp, "outside.jsonl");
  writeSession(candidate, path.join(tmp, "temp"), "archive-swap");
  writeSession(outside, tmp, "outside-target");
  const plan = planSessionHygiene({ root, archiveRoot, migrationMarker: marker, olderThanMs: 0, tempRoot: tmp });
  assert.equal(plan.archiveCandidates.length, 1);
  fs.rmSync(candidate);
  fs.symlinkSync(outside, candidate);
  const result = archiveSessionCandidates(plan, { dryRun: false, batchId: "symlink-swap" });
  assert.equal(result.moved.length, 0);
  assert.match(result.errors[0].error, /real file|symbolic|identity/i, "archive apply refuses symlink swaps");
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644, "archive refusal never chmods a symlink target");
  assert.equal(fs.lstatSync(candidate).isSymbolicLink(), true);
})();
