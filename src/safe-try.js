"use strict";

// Session mining (2026-07): 31 reverts and repeated "made it worse" attempts.
// Lightweight try/revert checkpoints: snapshot the working tree before a
// risky attempt, restore it in one call if the attempt makes things worse.
// Restores are non-destructive: files created after the checkpoint are
// reported, never deleted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const STATE_DIR = ".pi/safe-try";
const UNTRACKED_SAMPLE_LIMIT = 20;

function git(cwd, args, allowFail = false) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${String(result.stderr || "").trim() || result.status}`);
  return result.status === 0 ? String(result.stdout || "") : null;
}

function checkpointDir(cwd, id) {
  return path.join(cwd, STATE_DIR, id);
}

function readMeta(cwd, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(checkpointDir(cwd, id), "checkpoint.json"), "utf8"));
  } catch {
    return null;
  }
}

function untrackedFiles(cwd) {
  return (git(cwd, ["ls-files", "--others", "--exclude-standard"]) || "")
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.startsWith(".pi/"));
}

function summarizeCheckpoint(meta) {
  const untracked = Array.isArray(meta.untracked) ? meta.untracked : [];
  return {
    id: meta.id,
    untrackedCount: untracked.length,
    untrackedSample: untracked.slice(0, UNTRACKED_SAMPLE_LIMIT),
  };
}

function createCheckpoint(cwd = process.cwd(), label = "checkpoint") {
  if (!git(cwd, ["rev-parse", "--git-dir"], true)) throw new Error("safe-try requires a git repository");
  const id = `try-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const dir = checkpointDir(cwd, id);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  // stash create captures tracked modifications without touching the tree;
  // empty output means the tracked tree matches HEAD.
  const stashSha = (git(cwd, ["stash", "create", label], true) || "").trim() || null;
  if (stashSha) git(cwd, ["update-ref", "-m", `safe-try ${id}`, `refs/safe-try/${id}`, stashSha]);
  const untracked = untrackedFiles(cwd);
  for (const file of untracked) {
    const dest = path.join(dir, "files", file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(cwd, file), dest);
  }
  const meta = {
    id,
    label: String(label || "checkpoint"),
    at: new Date().toISOString(),
    head: (git(cwd, ["rev-parse", "HEAD"], true) || "").trim() || null,
    stashSha,
    untracked,
  };
  fs.writeFileSync(path.join(dir, "checkpoint.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return summarizeCheckpoint(meta);
}

function revertCheckpoint(cwd = process.cwd(), id) {
  const meta = readMeta(cwd, String(id || "").trim());
  if (!meta) throw new Error(`checkpoint not found: ${id}. Use listCheckpoints/try-list to see ids.`);
  const beforeUntracked = new Set([...meta.untracked]);
  const newFilesSinceCheckpoint = untrackedFiles(cwd).filter((file) => !beforeUntracked.has(file));
  // Restore tracked files to their checkpoint state (stash tree, or HEAD when
  // the tracked tree was clean at checkpoint time).
  const source = meta.stashSha || meta.head;
  if (source) git(cwd, ["restore", "--worktree", "--staged", "--source", source, "--", "."]);
  // Restore untracked files captured at checkpoint time.
  for (const file of meta.untracked) {
    const src = path.join(checkpointDir(cwd, meta.id), "files", file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(cwd, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return {
    id: meta.id,
    restored: true,
    untrackedRestoredCount: meta.untracked.length,
    untrackedRestoredSample: meta.untracked.slice(0, UNTRACKED_SAMPLE_LIMIT),
    newFilesSinceCheckpointCount: newFilesSinceCheckpoint.length,
    newFilesSinceCheckpointSample: newFilesSinceCheckpoint.slice(0, UNTRACKED_SAMPLE_LIMIT),
  };
}

function listCheckpoints(cwd = process.cwd()) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(cwd, STATE_DIR));
  } catch {
    return [];
  }
  return names
    .map((name) => readMeta(cwd, name))
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map(summarizeCheckpoint);
}

function formatCheckpoints(checkpoints) {
  if (!checkpoints.length) return "No safe-try checkpoints";
  return checkpoints.map((cp) => {
    const sample = cp.untrackedSample.length ? `; sample: ${cp.untrackedSample.join(", ")}` : "";
    return `${cp.id} (untracked snapshot: ${cp.untrackedCount}${sample})`;
  }).join("\n");
}

module.exports = { createCheckpoint, revertCheckpoint, listCheckpoints, formatCheckpoints, STATE_DIR };
