"use strict";

// Shared process, containment and filesystem primitives for specialist tools.
// Extracted so runtime/diagnostics/rea/verifiers no longer import specialist-tools
// (which lazily imports them back, forming require cycles).

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const crypto = require("node:crypto");
const { acquireManagedWorker, ownProcessGroup, terminateOwnedProcessGroup, watchOwnedProcessGroupRss, resourceGuardConfig } = require("./resource-guard");
const { safeRelative, pathForbidden } = require("./subagent-workspaces");
const { validateGpuDevices } = require("./specialist-gpu");

function executable(name, env = process.env) {
  const candidates = path.isAbsolute(name) ? [name] : String(env.PATH || "").split(path.delimiter).map(dir => path.join(dir, name));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
  return null;
}
function executableFingerprint(command) {
  const file = executable(command);
  if (!file) return { available: false, reason: "executable-unavailable" };
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 1073741824) return { available: false, reason: "executable-size-unbounded" };
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(131072);
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) return { available: false, reason: "executable-changed-during-fingerprint" };
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { available: false, reason: "executable-changed-during-fingerprint" };
    return { available: true, path: file, bytes: before.size, sha256: hash.digest("hex") };
  } catch { return { available: false, reason: "executable-unreadable" }; }
  finally { if (fd != null) fs.closeSync(fd); }
}
function inSystemRuntime(file) { return typeof file === "string" && (file.startsWith("/usr/") || file.startsWith("/bin/")); }
function blenderRuntimeBinding(runtime, { cwd } = {}) {
  if (!runtime) throw new Error("SPECIALIST_BLENDER_RUNTIME_REQUIRED");
  if (typeof runtime.root !== "string" || !path.isAbsolute(runtime.root) || path.resolve(runtime.root) !== runtime.root || typeof runtime.executable !== "string" || safeRelative(runtime.executable) !== runtime.executable || pathForbidden(runtime.executable) || !/^[a-f0-9]{64}$/.test(runtime.sha256 || "")) throw new Error("SPECIALIST_BLENDER_RUNTIME_INVALID");
  let root, binary;
  try {
    root = fs.realpathSync(runtime.root);
    binary = fs.realpathSync(path.join(root, runtime.executable));
    if (root !== runtime.root || !fs.statSync(root).isDirectory() || binary !== path.join(root, runtime.executable)) throw new Error("alias");
  } catch { throw new Error("SPECIALIST_BLENDER_RUNTIME_UNAVAILABLE"); }
  const workspace = cwd && fs.realpathSync(cwd);
  if (root === "/" || root === process.env.HOME || !binary.startsWith(`${root}${path.sep}`) || (workspace && (root === workspace || workspace.startsWith(`${root}${path.sep}`)))) throw new Error("SPECIALIST_BLENDER_RUNTIME_ROOT_INVALID");
  const fingerprint = executableFingerprint(binary);
  if (!fingerprint.available) throw new Error("SPECIALIST_BLENDER_EXECUTABLE_UNAVAILABLE");
  if (fingerprint.sha256 !== runtime.sha256) throw new Error("SPECIALIST_BLENDER_EXECUTABLE_STALE");
  return { command: binary, runtimeRoot: root, fingerprint };
}
function confinedFile(cwd, relative) {
  if (typeof relative !== "string" || safeRelative(relative) !== relative || pathForbidden(relative)) throw new Error("SPECIALIST_PATH_DENIED");
  const root = fs.realpathSync(cwd), file = fs.realpathSync(path.join(root, relative));
  if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile()) throw new Error("SPECIALIST_PATH_DENIED");
  return file;
}
function sandboxCommand({ cwd, command, args = [], writable = false, runtimeRoot, addonRoot, readZones, writeZones = [], outputBytes, gpuDevices = [], hardwareMetadata = false, privateShm = false, env = process.env }) {
  const bwrap = executable("bwrap", env), binary = executable(command, env);
  if (!bwrap || !binary) throw new Error("SPECIALIST_TOOL_UNAVAILABLE");
  const root = fs.realpathSync(cwd);
  const argv = ["--die-with-parent", "--unshare-all", "--new-session", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--size", String(privateShm ? 15728640 : 16777216), "--tmpfs", "/tmp", "--dir", "/home", "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin:/runtime/bin", "--setenv", "LANG", "C.UTF-8"];
  // Nsight's process waiter needs POSIX semaphores. Carve private shared memory
  // out of the existing scratch allowance; never bind the host's /dev/shm.
  if (privateShm) argv.push("--size", "1048576", "--tmpfs", "/dev/shm");
  for (const device of validateGpuDevices(gpuDevices)) argv.push("--dev-bind", device, device);
  // perf discovers the sysfs root via statfs/mounts; subtree-only mounts make
  // it resolve PMUs beneath the wrong root. Nsight also requires CPU topology.
  if (hardwareMetadata) {
    if (!fs.existsSync("/sys/bus/event_source/devices")) throw new Error("SPECIALIST_HARDWARE_METADATA_UNAVAILABLE");
    argv.push("--ro-bind", "/sys", "/sys");
  }
  for (const dir of ["/usr", "/bin", "/lib", "/lib64"]) if (fs.existsSync(dir)) argv.push("--ro-bind", dir, dir);
  let sandboxBinary = binary;
  if (!inSystemRuntime(binary) && !runtimeRoot) throw new Error("SPECIALIST_RUNTIME_ROOT_REQUIRED");
  if (runtimeRoot) {
    const runtime = fs.realpathSync(runtimeRoot);
    if ((!inSystemRuntime(binary) && !binary.startsWith(`${runtime}${path.sep}`)) || runtime === "/" || runtime === process.env.HOME || root === runtime || root.startsWith(`${runtime}${path.sep}`)) throw new Error("SPECIALIST_RUNTIME_ROOT_INVALID");
    argv.push("--ro-bind", runtime, "/runtime");
    if (!inSystemRuntime(binary)) sandboxBinary = `/runtime/${path.relative(runtime, binary)}`;
  }
  if (addonRoot) {
    const addon = fs.realpathSync(addonRoot);
    if (addon !== addonRoot || addon === "/" || addon === process.env.HOME || root === addon || root.startsWith(`${addon}${path.sep}`)) throw new Error("SPECIALIST_BLENDERAI_ROOT_INVALID");
    argv.push("--ro-bind", addon, "/blenderai/blender_mcp_assistant");
  }
  if (readZones) {
    argv.push("--dir", "/workspace");
    for (const zone of [...new Set([...readZones, ...writeZones])].sort((a, b) => a.length - b.length)) {
      const relative = zone.replace(/\/$/, "");
      if (safeRelative(relative) !== relative || pathForbidden(relative)) throw new Error("SPECIALIST_ZONE_INVALID");
      const source = path.join(root, relative);
      if (!fs.existsSync(source)) continue;
      if (!fs.realpathSync(source).startsWith(`${root}${path.sep}`)) throw new Error("SPECIALIST_ZONE_ESCAPE");
      argv.push(writable && writeZones.includes(zone) ? "--bind" : "--ro-bind", source, `/workspace/${relative}`);
    }
  } else {
    argv.push(writable ? "--bind" : "--ro-bind", root, "/workspace");
    if (fs.existsSync(path.join(root, ".git"))) argv.push("--ro-bind", path.join(root, ".git"), "/workspace/.git");
  }
  if (outputBytes != null) {
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 4096 || outputBytes > 16777216) throw new Error("SPECIALIST_OUTPUT_QUOTA_INVALID");
    argv.push("--size", String(outputBytes), "--tmpfs", "/output");
  }
  argv.push("--remount-ro", "/", "--remount-ro", "/dev", "--chdir", "/workspace", "--", sandboxBinary, ...args);
  return { command: bwrap, args: argv, cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}
async function runContained(input) {
  if (input.signal?.aborted) throw Object.assign(new Error("SPECIALIST_CANCELLED"), { name: "AbortError" });
  const launch = sandboxCommand(input);
  const timeoutMs = input.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) throw new Error("SPECIALIST_TIMEOUT_INVALID");
  const maxBytes = input.maxOutputBytes ?? 65536;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 33554432) throw new Error("SPECIALIST_OUTPUT_LIMIT_INVALID");
  const startedAt = new Date().toISOString(), guard = resourceGuardConfig(input.resourceGuard);
  const worker = await acquireManagedWorker();
  try {
    if (input.signal?.aborted) throw Object.assign(new Error("SPECIALIST_CANCELLED"), { name: "AbortError" });
    return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let ownership, monitor, timer, stopping, launchError, termination = null;
    let stdout = "", stderr = "", bytes = 0, retainedBytes = 0;
    const stop = reason => {
      termination ||= reason;
      if (ownership) stopping ||= terminateOwnedProcessGroup(ownership, { graceMs: guard.termGraceMs });
    };
    const abort = () => stop("cancelled");
    // A failed spawn has no PID and emits its errno asynchronously. Establish
    // ownership only after spawn, and retain the lease until close on failure.
    child.once("error", error => { launchError = error; });
    const append = (target, text) => {
      const remaining = maxBytes - retainedBytes;
      // Invalid input can expand into replacement characters. Bound the decoded
      // text too, without cutting a valid character at the retention boundary.
      const retained = Buffer.byteLength(text) <= remaining ? text : new StringDecoder("utf8").write(Buffer.from(text).subarray(0, remaining));
      retainedBytes += Buffer.byteLength(retained);
      if (target === "stdout") stdout += retained; else stderr += retained;
    };
    const collect = (target, stream) => {
      const decoder = new StringDecoder("utf8");
      let truncated = false;
      stream.on("data", chunk => {
        // Raw-byte accounting includes bytes still buffered in either decoder.
        const retained = chunk.subarray(0, Math.max(0, maxBytes - bytes));
        bytes += chunk.length;
        truncated ||= retained.length < chunk.length;
        append(target, decoder.write(retained));
        if (bytes > maxBytes) stop("output-limit");
      });
      stream.once("end", () => {
        const tail = decoder.end();
        // A quota cut is not malformed input: omit its incomplete final code point.
        if (!truncated) append(target, tail);
      });
    };
    collect("stdout", child.stdout); collect("stderr", child.stderr);
    child.once("spawn", () => {
      try { ownership = ownProcessGroup(child); }
      catch (error) { launchError = error; child.kill("SIGKILL"); return; }
      monitor = watchOwnedProcessGroupRss(ownership, { includeDescendants: true, limitBytes: guard.rssLimitBytes, pollMs: guard.rssPollMs, onExceeded: () => stop("rss-limit") });
      timer = setTimeout(() => stop("timeout"), timeoutMs);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      const metrics = monitor?.stop();
      if (stopping) await stopping;
      if (launchError) { reject(launchError); return; }
      resolve({ ok: exitCode === 0 && !signal && !termination, exitCode, signal, termination, stdout, stderr, outputBytes: bytes, startedAt, finishedAt: new Date().toISOString(), ...metrics });
    });
  }); } finally { await worker.release(); }
}
function assertWriteAllocation(cwd, policy, writes) {
  const root = fs.realpathSync(cwd), blockBytes = fs.statfsSync(root).bsize;
  let bytes = 0, count = 0;
  const seen = new Set(), missingDirectories = new Set();
  const statOrMissing = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  const allocation = stat => Math.max(stat.size, Number(stat.blocks || 0) * 512, stat.isDirectory() ? blockBytes : 0) + 256;
  const check = () => { if (!Number.isSafeInteger(policy.storageBytes) || count > 1000 || bytes > policy.storageBytes) throw new Error("SPECIALIST_STORAGE_BUDGET_EXHAUSTED"); };
  const walk = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const stat = statOrMissing(file);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error("SPECIALIST_WRITE_SYMLINK_DENIED");
    if (!stat.isFile() && !stat.isDirectory()) throw new Error("SPECIALIST_WRITE_TYPE_DENIED");
    bytes += allocation(stat); count++; check();
    if (stat.isDirectory()) for (const entry of fs.readdirSync(file)) walk(path.join(file, entry));
  };
  for (const zone of policy.writeZones) walk(path.join(root, zone));
  for (const { name, size } of writes) {
    if (typeof name !== "string" || safeRelative(name) !== name || pathForbidden(name) || !policy.writeZones.some(zone => name === zone || (zone.endsWith("/") && name.startsWith(zone)))) throw new Error("SPECIALIST_WRITE_PATH_DENIED");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("SPECIALIST_STORAGE_BUDGET_EXHAUSTED");
    const target = path.join(root, name), previous = statOrMissing(target);
    if (previous && !previous.isFile()) throw new Error("SPECIALIST_WRITE_TYPE_DENIED");
    for (let directory = path.dirname(target); directory !== root; directory = path.dirname(directory)) {
      const stat = statOrMissing(directory);
      if (!stat) missingDirectories.add(directory);
      else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SPECIALIST_WRITE_SYMLINK_DENIED");
    }
    bytes += Math.ceil(size / blockBytes) * blockBytes + 256 - (previous ? allocation(previous) : 0);
    if (!previous) count++;
  }
  bytes += missingDirectories.size * (blockBytes + 256); count += missingDirectories.size; check();
}
function guardMutation({ cwd, contract, tool, input }) {
  const policy = contract.settings?.taskPolicy;
  if (!policy) return;
  const name = input.path || input.file || input.filePath;
  if (typeof name !== "string" || safeRelative(name) !== name || pathForbidden(name)) throw new Error("SPECIALIST_WRITE_PATH_DENIED");
  const content = Buffer.isBuffer(input.content) ? input.content : String(input.content || "");
  const size = tool === "write" ? Buffer.byteLength(content) : fs.lstatSync(path.join(cwd, name)).size + Math.max(0, Buffer.byteLength(String(input.newText || "")) - Buffer.byteLength(String(input.oldText || "")));
  assertWriteAllocation(cwd, policy, [{ name, size }]);
}
function containmentProbe() {
  const binary = executable("bwrap");
  if (!binary) return { available: false, reason: "bwrap-unavailable" };
  const launch = sandboxCommand({ cwd: process.cwd(), command: "/usr/bin/true" });
  const result = spawnSync(launch.command, launch.args, { timeout: 3000, encoding: "utf8", env: launch.env });
  return { available: result.status === 0, reason: result.status === 0 ? null : "bwrap-unusable" };
}

module.exports = { executable, executableFingerprint, inSystemRuntime, blenderRuntimeBinding, confinedFile, sandboxCommand, runContained, assertWriteAllocation, guardMutation, containmentProbe };
