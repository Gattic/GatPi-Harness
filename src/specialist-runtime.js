"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { executableFingerprint, inSystemRuntime } = require("./specialist-primitives");
const hashes = new Map();
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

// Pin the installed dependency tree, not merely its launcher or package lock.
// Cached bytes are reused only while inode, size, mode, mtime AND ctime match.
function runtimeTreeDigest(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory() || root === "/" || root === process.env.HOME) throw new Error("SPECIALIST_RUNTIME_ROOT_INVALID");
  let count = 0, bytes = 0;
  const entries = [], buffer = Buffer.alloc(131072);
  function walk(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file, { bigint: true });
    if (++count > 40000 || (bytes += Number(stat.size)) > 8589934592) throw new Error("SPECIALIST_RUNTIME_TOO_LARGE");
    if (stat.isSymbolicLink()) {
      if (!fs.realpathSync(file).startsWith(`${root}${path.sep}`)) throw new Error("SPECIALIST_RUNTIME_LINK_ESCAPE");
      entries.push([relative, "link", fs.readlinkSync(file)]);
    } else if (stat.isDirectory()) {
      entries.push([relative, "directory", Number(stat.mode)]);
      for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    } else if (stat.isFile()) {
      const stamp = [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
      let cached = hashes.get(file);
      if (cached?.stamp !== stamp) {
        const hash = crypto.createHash("sha256"), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
        finally { fs.closeSync(fd); }
        const after = fs.lstatSync(file, { bigint: true });
        if ([after.dev, after.ino, after.size, after.mode, after.mtimeNs, after.ctimeNs].join(":") !== stamp) throw new Error("SPECIALIST_RUNTIME_CHANGED");
        cached = { stamp, digest: hash.digest("hex") };
        if (hashes.size >= 40000) hashes.clear();
        hashes.set(file, cached);
      }
      entries.push([relative, "file", Number(stat.mode), cached.digest]);
    } else throw new Error("SPECIALIST_RUNTIME_FILE_TYPE");
  }
  walk("");
  return sha(JSON.stringify(entries));
}
function runtimeBinding(runtime, { cwd } = {}) {
  if (!runtime || !/^[a-f0-9]{64}$/.test(runtime.sha256 || "")) throw new Error("SPECIALIST_PINNED_RUNTIME_REQUIRED");
  const root = runtime.root;
  if (typeof root !== "string" || (cwd && (fs.realpathSync(cwd) === root || fs.realpathSync(cwd).startsWith(`${root}${path.sep}`)))) throw new Error("SPECIALIST_RUNTIME_ROOT_INVALID");
  if (runtimeTreeDigest(root) !== runtime.sha256) throw new Error("SPECIALIST_RUNTIME_STALE");
  return { runtimeRoot: root };
}
function systemBinding(pin) {
  if (!pin || !path.isAbsolute(pin.path || "") || !/^[a-f0-9]{64}$/.test(pin.sha256 || "")) throw new Error("SPECIALIST_SYSTEM_PIN_REQUIRED");
  const actual = executableFingerprint(pin.path);
  if (!actual.available || actual.path !== pin.path || !inSystemRuntime(actual.path) || actual.sha256 !== pin.sha256) throw new Error("SPECIALIST_SYSTEM_EXECUTABLE_STALE");
  return actual.path;
}
module.exports = { runtimeTreeDigest, runtimeBinding, systemBinding };
