"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_SOURCE_DIRS = Object.freeze(["src", ".pi/extensions", "extensions"]);
const RUNTIME_SOURCE_FILES = Object.freeze(["config/harness-defaults.env"]);
const RUNTIME_SOURCE_PATTERN = /\.(?:js|ts|json)$/;
// Vendored dependencies are not project runtime source. Hashing them made the
// subagent runtimeRevision depend on package contents (131 of 386 files here).
const RUNTIME_IGNORED_DIRS = Object.freeze(new Set(["node_modules", ".git", ".worktrees", "dist", "build", "coverage", "vendor", "__pycache__"]));

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stableStringify(value)).digest("hex");
}
function filesUnder(root, relative, out = []) {
  const target = path.join(root, relative);
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return out; }
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!RUNTIME_IGNORED_DIRS.has(entry.name)) filesUnder(root, child, out);
    } else if (entry.isFile() && RUNTIME_SOURCE_PATTERN.test(entry.name)) out.push(child);
  }
  return out;
}
function hashFiles(root, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files.slice().sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
function runtimeSourceFingerprint(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const files = [...RUNTIME_SOURCE_DIRS.flatMap((dir) => filesUnder(root, dir)), ...RUNTIME_SOURCE_FILES.filter((file) => {
    try { return fs.lstatSync(path.join(root, file)).isFile(); } catch { return false; }
  })];
  return { root, files, fileCount: files.length, hash: hashFiles(root, files) };
}

module.exports = {
  RUNTIME_SOURCE_DIRS,
  RUNTIME_SOURCE_FILES,
  RUNTIME_IGNORED_DIRS,
  stableStringify,
  sha256,
  filesUnder,
  hashFiles,
  runtimeSourceFingerprint,
};
