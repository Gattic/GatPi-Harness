"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function realpathOrResolve(value) {
  const resolved = path.resolve(value || process.cwd());
  try { return fs.realpathSync.native(resolved); } catch {}
  try { return fs.realpathSync(resolved); } catch {}
  return resolved;
}

function gitRoot(cwd = process.cwd()) {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return stdout ? realpathOrResolve(stdout) : null;
  } catch {
    return null;
  }
}

function safeName(name) {
  return String(name || "repo").replace(/[^a-zA-Z0-9._-]/g, "_") || "repo";
}

function shortHash(value, length = 12) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function projectIdentity(cwd = process.cwd()) {
  const git = gitRoot(cwd);
  const root = git || realpathOrResolve(cwd);
  const name = safeName(path.basename(root) || "repo");
  const rootHash = shortHash(root);
  return {
    name,
    root,
    rootHash,
    isGit: Boolean(git),
    projectKey: `pi:${name}:${rootHash}`,
    legacyProjectKey: `pi:${name}`,
  };
}

module.exports = { projectIdentity, gitRoot, realpathOrResolve, safeName, shortHash };
