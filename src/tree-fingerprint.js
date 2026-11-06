"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { configurationHash, revisionId } = require("./code-context-revision.js");

// .worktrees holds linked checkouts of the same repository on other branches;
// a filesystem fingerprint must cover only this checkout.
const FALLBACK_IGNORES = new Set([".git", ".pi", ".worktrees", "node_modules"]);
function boundedFileHash(file, size, maxBytes = 1024 * 1024) {
  const hash = crypto.createHash("sha256").update(String(size));
  if (size <= maxBytes) return hash.update(fs.readFileSync(file)).digest("hex");
  const half = Math.floor(maxBytes / 2); const head = Buffer.alloc(half); const tail = Buffer.alloc(maxBytes - half);
  const descriptor = fs.openSync(file, "r");
  try {
    const headRead = fs.readSync(descriptor, head, 0, head.length, 0);
    const tailRead = fs.readSync(descriptor, tail, 0, tail.length, Math.max(0, size - tail.length));
    return hash.update(head.subarray(0, headRead)).update(tail.subarray(0, tailRead)).digest("hex");
  } finally { fs.closeSync(descriptor); }
}
function filesystemRevision(cwd, maxFiles = 10_000) {
  const root = path.resolve(cwd);
  const rows = [];
  let truncated = false;
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (FALLBACK_IGNORES.has(name)) continue;
      if (rows.length >= maxFiles) { truncated = true; return; }
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (stat.isSymbolicLink()) rows.push([relative, "symlink", fs.readlinkSync(file)]);
      else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) rows.push([relative, stat.size, boundedFileHash(file, stat.size)]);
      if (truncated) return;
    }
  };
  walk(root);
  return {
    available: !truncated,
    source: "filesystem-fallback",
    head: null,
    statusFingerprint: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 24),
    configurationHash: "filesystem-v1",
    dirty: null,
    fileCount: rows.length,
    truncated,
  };
}

function streamingGitRevision(cwd, options = {}) {
  const worker = path.join(__dirname, "tree-fingerprint-worker.js");
  const runner = options.workerSpawnSync || spawnSync;
  const result = runner(process.execPath, [worker, path.resolve(cwd)], {
    encoding: "utf8",
    timeout: Number(options.timeoutMs) || 10 * 60_000,
    maxBuffer: 64 * 1024,
  });
  let revision;
  try { revision = JSON.parse(String(result?.stdout || "").trim()); }
  catch { revision = { available: false, error: String(result?.stderr || result?.error?.message || "tree fingerprint worker returned invalid output") }; }
  return {
    ...revision,
    configurationHash: configurationHash(options.configuration),
    statusFingerprint: revision.statusFingerprint || crypto.createHash("sha256").update("unavailable").digest("hex").slice(0, 24),
  };
}

function captureTreeFingerprint(cwd = process.cwd(), options = {}) {
  const gitRevision = streamingGitRevision(cwd, options);
  const revision = gitRevision.available ? gitRevision : filesystemRevision(cwd, options.maxFiles);
  return {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    fingerprint: revisionId(revision),
    revision,
    gatingSafe: revision.available === true,
  };
}

function compareTreeFingerprint(cwd = process.cwd(), evidence = null, options = {}) {
  const current = options.current || captureTreeFingerprint(cwd, options);
  const expected = String(evidence?.fingerprint || evidence?.treeFingerprint || "").trim();
  if (!expected) return { status: "missing-fingerprint", current, expected: null, currentTree: false, gatingSafe: false };
  if (!current.gatingSafe) return { status: "current-tree-unavailable", current, expected, currentTree: false, gatingSafe: false };
  const currentTree = expected === current.fingerprint;
  return { status: currentTree ? "current" : "stale-tree", current, expected, currentTree, gatingSafe: currentTree };
}

function treeFingerprintSummary(value = null) {
  return value ? {
    schemaVersion: Number(value.schemaVersion || 1),
    capturedAt: value.capturedAt || null,
    fingerprint: value.fingerprint || null,
    gatingSafe: value.gatingSafe === true,
  } : null;
}

module.exports = { captureTreeFingerprint, compareTreeFingerprint, streamingGitRevision, treeFingerprintSummary };
