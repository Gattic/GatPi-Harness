#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STATUS_SCHEMA = "git-status-stream-v2";
const MAX_STATUS_RECORD_BYTES = 1024 * 1024;

function updateFrame(hash, label, value) {
  const name = Buffer.from(String(label));
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(String(name.length)); hash.update(":"); hash.update(name);
  hash.update(String(data.length)); hash.update(":"); hash.update(data);
}

function splitFields(value, count) {
  let rest = value;
  for (let index = 0; index < count; index++) {
    const at = rest.indexOf(" ");
    if (at < 0) return null;
    rest = rest.slice(at + 1);
  }
  return rest;
}

function statusPath(record) {
  const type = record[0];
  if (type === "?") return record.slice(2);
  if (type === "1") return splitFields(record.slice(2), 7);
  if (type === "2") return splitFields(record.slice(2), 8);
  if (type === "u") return splitFields(record.slice(2), 9);
  return null;
}

async function filesystemIdentity(root, file) {
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`status path escaped repository: ${file}`);
  let stat;
  try { stat = await fs.promises.lstat(full); } catch { return "missing"; }
  if (stat.isSymbolicLink()) return `symlink:${await fs.promises.readlink(full)}`;
  if (stat.isDirectory()) return "directory";
  if (!stat.isFile()) return "special";
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
  return `file:${stat.size}:sha256:${hash.digest("hex")}`;
}

async function fingerprintStatusStream(chunks, { cwd = process.cwd(), contentIdentity = (file) => filesystemIdentity(cwd, file) } = {}) {
  const hash = crypto.createHash("sha256");
  updateFrame(hash, "schema", STATUS_SCHEMA);
  let pending = Buffer.alloc(0);
  let statusBytes = 0;
  let fileCount = 0;
  let awaitingRenameSource = false;

  const consume = async (recordBuffer) => {
    statusBytes += recordBuffer.length + 1;
    updateFrame(hash, "status", recordBuffer);
    if (awaitingRenameSource) { awaitingRenameSource = false; return; }
    const record = recordBuffer.toString("utf8");
    const file = statusPath(record);
    if (!file) return;
    fileCount++;
    updateFrame(hash, "path", file);
    updateFrame(hash, "content", await contentIdentity(file));
    if (record[0] === "2") awaitingRenameSource = true;
  };

  for await (const value of chunks) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let delimiter;
    while ((delimiter = pending.indexOf(0)) >= 0) {
      const record = pending.subarray(0, delimiter);
      pending = pending.subarray(delimiter + 1);
      if (record.length) await consume(record);
    }
    if (pending.length > MAX_STATUS_RECORD_BYTES) throw new Error("git status record exceeded bounded parser limit");
  }
  if (pending.length) throw new Error("unterminated git status record");
  if (awaitingRenameSource) throw new Error("rename status omitted its source path");
  return {
    available: true,
    source: STATUS_SCHEMA,
    statusFingerprint: hash.digest("hex").slice(0, 24),
    dirty: fileCount > 0,
    fileCount,
    statusBytes,
  };
}

function runGit(cwd, args, { maxBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.length, remaining);
      }
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < maxBytes) stderr += chunk.toString("utf8").slice(0, maxBytes - stderr.length); });
    child.on("error", (error) => resolve({ ok: false, error: error.message, stdout: "" }));
    child.on("close", (code, signal) => resolve({ ok: code === 0, error: code === 0 ? null : stderr.trim() || `git exited ${code ?? signal}`, stdout: Buffer.concat(stdout).toString("utf8") }));
  });
}

async function captureGitRevision(cwd) {
  const root = path.resolve(cwd);
  const headResult = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  // Status may be interrupted; never acquire an optional index refresh lock.
  const child = spawn("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length); });
  const exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: -1, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const revision = await fingerprintStatusStream(child.stdout, { cwd: root });
    const status = await exit;
    if (status.code !== 0) return { available: false, error: status.error || stderr.trim() || `git status exited ${status.code ?? status.signal}` };
    return { ...revision, head: headResult.ok ? headResult.stdout.trim() || null : null };
  } catch (error) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await exit;
    return { available: false, error: String(error?.message || error), head: headResult.ok ? headResult.stdout.trim() || null : null };
  }
}

async function main() {
  const cwd = process.argv[2] || process.cwd();
  const result = await captureGitRevision(cwd);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.available) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ available: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

module.exports = { STATUS_SCHEMA, captureGitRevision, filesystemIdentity, fingerprintStatusStream, statusPath };
