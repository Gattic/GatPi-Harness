"use strict";

// Session mining (2026-07): `cmake --build` was hand-typed 858x/month and
// project test binaries 1,043x/month, with 35 default-timeout kills and 61
// SIGABRT crashes that led to manual gdb sessions. This library gives the
// build -> filtered-test ritual a first-class, pinned/detected fast path with
// build-length timeouts and automatic crash backtraces.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { normalizeTestResult } = require("./test-result-normalizer.js");
const {
  ownProcessGroup,
  acquireManagedWorker,
  resourceGuardConfig,
  watchOwnedProcessGroupRss,
} = require("./resource-guard.js");

const DEFAULT_BUILD_TIMEOUT_MS = Number(process.env.PI_BUILD_TIMEOUT_MS || 15 * 60_000);
const DEFAULT_TEST_TIMEOUT_MS = Number(process.env.PI_TEST_TIMEOUT_MS || 10 * 60_000);
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
const MAX_OUTPUT_BUFFER_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_PROGRESS_OUTPUT_CHARS = 2_000;
const DEFAULT_LARGE_REPO_TRANSLATION_UNITS = 300;
const DEFAULT_LARGE_NON_NATIVE_REPO_SOURCE_FILES = 500;
const DEFAULT_LARGE_REPO_MAX_JOBS = 4;
const DEFAULT_NATIVE_MAX_JOBS = 8;
const DEFAULT_LARGE_REPO_MEMORY_PER_JOB_MB = 2048;
const DEFAULT_NATIVE_MEMORY_PER_JOB_MB = 1024;
const DEFAULT_LARGE_NON_NATIVE_MEMORY_MB = 4096;
const DEFAULT_NON_NATIVE_MEMORY_MB = 1024;
const DEFAULT_MINIMUM_START_MEMORY_MB = 4096;
const NATIVE_SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".cu", ".m", ".mm"]);
const NON_NATIVE_SOURCE_EXTENSIONS = new Set([".cjs", ".go", ".java", ".js", ".jsx", ".kt", ".kts", ".mjs", ".rs", ".scala", ".swift", ".ts", ".tsx"]);
const SKIP_SOURCE_DIRS = new Set([
  "git", "pi", "claude", "codex", "build", "out", "dist", "nodemodules", "cache",
  "next", "coverage", "target", "gradle", "idea", "superpowers", "worktrees",
  "venv", "vendor", "vendored", "thirdparty", "external", "extern", "deps",
]);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function repositoryRelativePath(cwd, file) {
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, "/");
}

function inspectBuildScript(file) {
  try {
    const source = fs.readFileSync(file, "utf8").slice(0, 256 * 1024);
    const executableLines = source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
    const nativeBuild = /(?:^|\n)\s*(?:cmake\s+--build\b|(?:g?make|ninja)\b|meson\s+compile\b)/m.test(executableLines);
    const buildsProject = nativeBuild || /(?:^|\n)\s*(?:cargo\s+build\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b)/m.test(executableLines);
    return { buildsProject, nativeBuild, invokesNproc: /\bnproc\b/.test(executableLines) };
  } catch {
    return { buildsProject: false, nativeBuild: false, invokesNproc: false };
  }
}

function normalizeConfigure(cwd, value) {
  if (!value) return null;
  const raw = typeof value === "string" ? { script: value } : value;
  if (!raw.script) return null;
  const script = path.isAbsolute(raw.script) ? raw.script : path.resolve(cwd, raw.script);
  const inspected = inspectBuildScript(script);
  const argsByTarget = raw.argsByTarget && typeof raw.argsByTarget === "object" && !Array.isArray(raw.argsByTarget)
    ? Object.fromEntries(Object.entries(raw.argsByTarget)
        .filter(([, args]) => Array.isArray(args))
        .map(([target, args]) => [String(target), args.map(String)]))
    : {};
  return {
    script,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    argsByTarget,
    buildsProject: raw.buildsProject ?? inspected.buildsProject,
    nativeBuild: raw.nativeBuild ?? inspected.nativeBuild,
    invokesNproc: inspected.invokesNproc,
  };
}

function resolveConfigureArguments(config, options = {}) {
  if (Array.isArray(options.configureArgs)) {
    return { args: options.configureArgs.map(String), source: "call", targetArgsApplied: false };
  }
  const projectArgs = config.configure?.args || [];
  const target = options.target == null ? null : String(options.target);
  const targetArgs = target ? (config.configure?.argsByTarget?.[target] || []) : [];
  return {
    args: [...projectArgs, ...targetArgs],
    source: targetArgs.length ? (projectArgs.length ? "project+target" : "project-target") : (projectArgs.length ? "project" : "script-default"),
    targetArgsApplied: targetArgs.length > 0,
  };
}

function inferBuildDirectory(command, args = []) {
  if (path.basename(String(command || "")).toLowerCase() !== "cmake") return null;
  const index = args.indexOf("--build");
  return index >= 0 && args[index + 1] && !String(args[index + 1]).startsWith("-") ? String(args[index + 1]) : null;
}

function findTestBinaries(cwd, limit = 8) {
  const roots = [path.join(cwd, "build"), path.join(cwd, "unit-tests", "build")];
  const found = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (found.length >= limit) break;
      if (/tests?$/.test(name) && isExecutable(path.join(root, name)))
        found.push(repositoryRelativePath(cwd, path.join(root, name)) || path.join(root, name));
    }
  }
  return found;
}

function resolveBuildConfig(cwd = process.cwd()) {
  const pinnedRaw = readJson(path.join(cwd, ".pi", "project.json"), {}) || {};
  const minimumStartMemoryMb = pinnedRaw.build?.minimumStartMemoryMb;
  if (minimumStartMemoryMb !== undefined && (!Number.isSafeInteger(minimumStartMemoryMb) || minimumStartMemoryMb <= 0)) {
    throw new Error("Invalid .pi/project.json build.minimumStartMemoryMb: expected a positive integer in MiB.");
  }
  const pinnedConfigure = normalizeConfigure(cwd, pinnedRaw.configure);
  if (pinnedRaw.build?.command || pinnedRaw.test || pinnedConfigure?.buildsProject) {
    const buildArgs = pinnedRaw.build?.args || [];
    return {
      source: "pinned",
      minimumStartMemoryMb,
      configure: pinnedConfigure,
      build: pinnedRaw.build?.command
        ? {
            command: pinnedRaw.build.command,
            args: buildArgs,
            targets: pinnedRaw.build.targets || [],
            targetArg: pinnedRaw.build.targetArg ?? null,
            timeoutMs: pinnedRaw.build.timeoutMs || DEFAULT_BUILD_TIMEOUT_MS,
            maxJobs: pinnedRaw.build.maxJobs || null,
            directory: pinnedRaw.build.directory || inferBuildDirectory(pinnedRaw.build.command, buildArgs),
          }
        : null,
      test: pinnedRaw.test
        ? { command: pinnedRaw.test.command, args: pinnedRaw.test.args || [], binaries: pinnedRaw.test.binaries || [], filterArg: pinnedRaw.test.filterArg !== false, timeoutMs: pinnedRaw.test.timeoutMs || DEFAULT_TEST_TIMEOUT_MS }
        : null,
      guidance: null,
    };
  }

  if (fs.existsSync(path.join(cwd, "CMakeLists.txt"))) {
    const configureScript = ["configure.sh", ".configure.sh"].map((s) => path.join(cwd, s)).find((f) => fs.existsSync(f));
    const binaries = findTestBinaries(cwd);
    return {
      source: "detected",
      minimumStartMemoryMb,
      configure: pinnedConfigure || normalizeConfigure(cwd, configureScript ? { script: configureScript } : null),
      build: { command: "cmake", args: ["--build", "build"], targets: [], targetArg: "--target", timeoutMs: DEFAULT_BUILD_TIMEOUT_MS, maxJobs: null, directory: "build" },
      test: { command: null, args: [], binaries, filterArg: true, timeoutMs: DEFAULT_TEST_TIMEOUT_MS },
      guidance: binaries.length ? null : "No test binaries found under build/; pin them in .pi/project.json test.binaries.",
    };
  }

  const scripts = readJson(path.join(cwd, "package.json"), {})?.scripts || {};
  if (scripts.build || scripts.test) {
    return {
      source: "detected",
      minimumStartMemoryMb,
      configure: null,
      build: scripts.build ? { command: "npm", args: ["run", "build"], targets: [], targetArg: null, timeoutMs: DEFAULT_BUILD_TIMEOUT_MS, maxJobs: null, directory: null } : null,
      test: scripts.test ? { command: "npm", args: ["test", "--"], binaries: [], filterArg: true, timeoutMs: DEFAULT_TEST_TIMEOUT_MS } : null,
      guidance: null,
    };
  }

  return {
    source: "none",
    minimumStartMemoryMb,
    configure: null,
    build: null,
    test: null,
    guidance: "No build system detected. Pin commands in .pi/project.json, e.g. {\"build\":{\"command\":\"cmake\",\"args\":[\"--build\",\"build\"]},\"test\":{\"binaries\":[\"build/my-tests\"]}}.",
  };
}

function pinnedBuildFacts(cwd = process.cwd()) {
  const config = resolveBuildConfig(cwd);
  const facts = [];
  const common = { provider: "project-config", configuration: "default", freshness: "fresh", gatingSafe: true, confidence: config.source === "pinned" ? 0.85 : 0.55, provenance: [{ provider: "build-runner", operation: "resolveBuildConfig" }] };
  const commandHash = (value) => crypto.createHash("sha256").update(JSON.stringify(value || null)).digest("hex").slice(0, 16);
  if (config.build) {
    const buildTarget = "project-build:default";
    const targets = config.build.targets?.length ? config.build.targets : ["default"];
    for (const target of targets) facts.push({ ...common, subject: buildTarget, predicate: "produces", object: `build-target:${target}`, contentHash: commandHash({ command: config.build.command, args: config.build.args, target }) });
  }
  if (config.configure?.script) facts.push({ ...common, subject: `generator:${path.basename(config.configure.script)}`, predicate: "generates", object: "configuration:default", contentHash: commandHash(config.configure.script) });
  if (config.test) {
    for (const binary of config.test.binaries || []) {
      const factPath = repositoryRelativePath(cwd, binary);
      facts.push({ ...common, subject: `test-target:${path.basename(binary)}`, predicate: "tests", object: "project-build:default", ...(factPath ? { path: factPath } : {}), contentHash: commandHash(binary) });
    }
    if (config.test.command) facts.push({ ...common, subject: "test-target:default", predicate: "tests", object: "project-build:default", contentHash: commandHash({ command: config.test.command, args: config.test.args }) });
  }
  return { provider: "project-config", available: config.source !== "none", source: config.source, capabilities: ["pinned-commands", "test-targets"], facts, degradation: config.source === "none" ? { code: "not_configured", message: config.guidance, retryable: false } : null };
}

function positiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}

function readSystemMemory() {
  let totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  try {
    const values = {};
    for (const line of fs.readFileSync("/proc/meminfo", "utf8").split(/\r?\n/)) {
      const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/i.exec(line);
      if (match) values[match[1]] = Number(match[2]) * 1024;
    }
    totalBytes = values.MemTotal || totalBytes;
    availableBytes = values.MemAvailable || availableBytes;
  } catch {}

  try {
    const maxRaw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    const currentRaw = fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim();
    const maxBytes = maxRaw === "max" ? null : Number(maxRaw);
    const currentBytes = Number(currentRaw);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && Number.isFinite(currentBytes)) {
      totalBytes = Math.min(totalBytes, maxBytes);
      availableBytes = Math.min(availableBytes, Math.max(0, maxBytes - currentBytes));
    }
  } catch {}

  return { totalMb: Math.floor(totalBytes / 1024 / 1024), availableMb: Math.floor(availableBytes / 1024 / 1024) };
}

function normalizedDirName(name) {
  return String(name || "").toLowerCase().replace(/[._-]/g, "");
}

function inspectRepoScale(cwd, extensions, threshold, countName) {
  const stack = [cwd];
  let files = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_SOURCE_DIRS.has(normalizedDirName(entry.name))) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        files += 1;
        if (files > threshold) return { large: true, [countName]: files, capped: true };
      }
    }
  }
  return { large: false, [countName]: files, capped: false };
}

function inspectNativeRepoScale(cwd, threshold = DEFAULT_LARGE_REPO_TRANSLATION_UNITS) {
  return inspectRepoScale(cwd, NATIVE_SOURCE_EXTENSIONS, threshold, "translationUnits");
}

function inspectNonNativeRepoScale(cwd, threshold = DEFAULT_LARGE_NON_NATIVE_REPO_SOURCE_FILES) {
  return inspectRepoScale(cwd, NON_NATIVE_SOURCE_EXTENSIONS, threshold, "sourceFiles");
}

function isNativeBuild(cwd, config) {
  const command = path.basename(String(config.build?.command || "")).toLowerCase();
  return ["cmake", "make", "gmake", "ninja", "meson"].includes(command)
    || Boolean(config.configure?.nativeBuild)
    || (!config.build?.command && fs.existsSync(path.join(cwd, "CMakeLists.txt")));
}

function planBuildParallelism(cwd, config, options = {}) {
  const native = isNativeBuild(cwd, config);
  const env = options.env || process.env;
  const threshold = native
    ? positiveInteger(env.PI_BUILD_LARGE_REPO_FILES, DEFAULT_LARGE_REPO_TRANSLATION_UNITS)
    : DEFAULT_LARGE_NON_NATIVE_REPO_SOURCE_FILES;
  const scale = options.scale || (native
    ? inspectNativeRepoScale(cwd, threshold)
    : inspectNonNativeRepoScale(cwd, threshold));
  const memory = options.memory || readSystemMemory();
  const defaultMemoryPerJobMb = native
    ? (scale.large ? DEFAULT_LARGE_REPO_MEMORY_PER_JOB_MB : DEFAULT_NATIVE_MEMORY_PER_JOB_MB)
    : (scale.large ? DEFAULT_LARGE_NON_NATIVE_MEMORY_MB : DEFAULT_NON_NATIVE_MEMORY_MB);
  const memoryPerJobMb = native
    ? positiveInteger(env.PI_BUILD_MEMORY_PER_JOB_MB, defaultMemoryPerJobMb)
    : defaultMemoryPerJobMb;
  const defaultReserveMb = Math.max(2048, Math.min(4096, Math.floor((memory.totalMb || 0) * 0.25)));
  const reserveMb = positiveInteger(env.PI_BUILD_RESERVE_MEMORY_MB, defaultReserveMb);
  const minimumStartMemoryMb = config.minimumStartMemoryMb ?? DEFAULT_MINIMUM_START_MEMORY_MB;
  const lowMemory = Number.isFinite(memory.availableMb) && memory.availableMb < minimumStartMemoryMb;
  const allowed = !lowMemory || env.PI_BUILD_ALLOW_LOW_MEMORY === "1";

  if (!native) {
    return {
      managed: false,
      allowed,
      jobs: null,
      memoryAvailableMb: memory.availableMb ?? null,
      memoryTotalMb: memory.totalMb || null,
      reserveMb,
      estimatedBuildMemoryMb: memoryPerJobMb,
      minimumStartMemoryMb,
      largeRepo: scale.large,
      sourceFiles: scale.sourceFiles,
      sourceFilesCapped: scale.capped,
      reason: scale.large ? "large non-native repository" : "non-native build",
    };
  }

  const cpuLimit = positiveInteger(options.cpuCount, positiveInteger(typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length, 1));
  const usableMemoryMb = Math.max(0, (memory.availableMb || 0) - reserveMb);
  const memoryLimit = memory.availableMb ? Math.max(1, Math.floor(usableMemoryMb / memoryPerJobMb)) : (scale.large ? 2 : 4);
  const sizeLimit = scale.large
    ? positiveInteger(env.PI_BUILD_LARGE_REPO_MAX_JOBS, DEFAULT_LARGE_REPO_MAX_JOBS)
    : positiveInteger(env.PI_BUILD_NATIVE_MAX_JOBS, DEFAULT_NATIVE_MAX_JOBS);
  const configLimit = positiveInteger(config.build?.maxJobs, Number.MAX_SAFE_INTEGER);
  const environmentLimit = positiveInteger(env.PI_BUILD_MAX_JOBS, Number.MAX_SAFE_INTEGER);
  const inheritedLimit = positiveInteger(env.CMAKE_BUILD_PARALLEL_LEVEL, Number.MAX_SAFE_INTEGER);
  const jobs = Math.max(1, Math.min(cpuLimit, memoryLimit, sizeLimit, configLimit, environmentLimit, inheritedLimit));
  return {
    managed: true,
    allowed,
    jobs,
    cpuLimit,
    memoryLimit,
    sizeLimit,
    memoryAvailableMb: memory.availableMb ?? null,
    memoryTotalMb: memory.totalMb || null,
    reserveMb,
    memoryPerJobMb,
    minimumStartMemoryMb,
    largeRepo: scale.large,
    translationUnits: scale.translationUnits,
    translationUnitsCapped: scale.capped,
    reason: scale.large ? "large native repository" : "native build",
  };
}

function cappedJobs(value, jobs) {
  return String(Math.min(positiveInteger(value, jobs), jobs));
}

function applyBuildParallelism(command, args, jobs) {
  const tool = path.basename(String(command || "")).toLowerCase();
  if (!["cmake", "make", "gmake", "ninja", "meson"].includes(tool)) return [...args];
  const output = [];
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    let match = /^--parallel(?:=(\d+))?$/.exec(arg);
    if (match) {
      found = true;
      if (match[1]) output.push(`--parallel=${cappedJobs(match[1], jobs)}`);
      else if (/^\d+$/.test(String(args[index + 1] || ""))) output.push("--parallel", cappedJobs(args[++index], jobs));
      else output.push("--parallel", String(jobs));
      continue;
    }
    match = /^-j(\d*)$/.exec(arg);
    if (match) {
      found = true;
      if (match[1]) output.push(`-j${cappedJobs(match[1], jobs)}`);
      else if (/^\d+$/.test(String(args[index + 1] || ""))) output.push("-j", cappedJobs(args[++index], jobs));
      else output.push(`-j${jobs}`);
      continue;
    }
    match = /^--jobs(?:=(\d+))?$/.exec(arg);
    if (match) {
      found = true;
      if (match[1]) output.push(`--jobs=${cappedJobs(match[1], jobs)}`);
      else if (/^\d+$/.test(String(args[index + 1] || ""))) output.push("--jobs", cappedJobs(args[++index], jobs));
      else output.push("--jobs", String(jobs));
      continue;
    }
    output.push(arg);
  }
  if (!found) {
    const flag = tool === "cmake" ? ["--parallel", String(jobs)] : [`-j${jobs}`];
    const separator = output.indexOf("--");
    if (separator >= 0) output.splice(separator, 0, ...flag);
    else output.push(...flag);
  }
  return output;
}

function boundedMakeFlags(value, jobs) {
  const tokens = String(value || "").split(/\s+/).filter(Boolean);
  const kept = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-j" || token === "--jobs") {
      if (/^\d+$/.test(tokens[index + 1] || "")) index += 1;
      continue;
    }
    if (/^(?:-j\d+|--jobs=\d+|--jobserver-(?:auth|fds)=)/.test(token)) continue;
    kept.push(token);
  }
  return [...kept, `-j${jobs}`].join(" ");
}

function buildEnvironment(plan) {
  if (!plan.managed) return {};
  return {
    PI_BUILD_JOBS: String(plan.jobs),
    CMAKE_BUILD_PARALLEL_LEVEL: String(plan.jobs),
    MAKEFLAGS: boundedMakeFlags(process.env.MAKEFLAGS, plan.jobs),
    MESON_NUM_PROCESSES: String(plan.jobs),
  };
}

function clip(text) {
  const value = String(text || "");
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n[...output truncated...]` : value;
}

async function execute(command, args, cwd, timeoutMs, env = {}, options = {}) {
  const startedAt = Date.now();
  const signal = options.signal;
  const onProgress = options.onProgress;
  const phase = options.phase || "command";
  const maxBuffer = positiveInteger(options.maxBuffer, MAX_OUTPUT_BUFFER_BYTES);
  const killGraceMs = Math.max(0, Number.isFinite(Number(options.killGraceMs)) ? Number(options.killGraceMs) : DEFAULT_PROCESS_KILL_GRACE_MS);
  const progressIntervalMs = positiveInteger(options.progressIntervalMs, DEFAULT_PROGRESS_INTERVAL_MS);
  const baseResult = {
    command,
    args,
    status: -1,
    ok: false,
    crashed: false,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
    peakRssBytes: 0,
    rssLimitBytes: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    error: null,
  };
  if (signal?.aborted) {
    return Promise.resolve({ ...baseResult, cancelled: true, error: `aborted before start: ${command}` });
  }

  let worker;
  try { worker = await acquireManagedWorker(); }
  catch (error) { return { ...baseResult, error: String(error?.message || error), resourceLimitExceeded: true }; }
  try { return await new Promise((resolve) => {
    let child;
    try {
      // A detached process group lets cancellation and deadlines terminate
      // repository scripts together with any compiler grandchildren.
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ...baseResult, durationMs: Date.now() - startedAt, error: String(error?.message || error) });
      return;
    }
    child.stdin?.end();

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTail = "";
    let stderrTail = "";
    let exitCode = null;
    let exitSignal = null;
    let spawnError = null;
    let timedOut = false;
    let cancelled = false;
    let overflowStream = null;
    let resourceLimitExceeded = false;
    let rssMonitor = null;
    let peakRssBytes = 0;
    const guardConfig = resourceGuardConfig(options.resourceGuard || {});
    let settled = false;
    let lastProgressAt = 0;
    let deadlineTimer = null;
    let forceKillTimer = null;
    let pipeCloseTimer = null;
    let progressTimer = null;

    const trimProgressTail = (value) => value.length > MAX_PROGRESS_OUTPUT_CHARS
      ? value.slice(-MAX_PROGRESS_OUTPUT_CHARS)
      : value;
    const destroyPipes = () => {
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
    };
    const killTree = (killSignal) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, killSignal); } catch {}
      }
      try { child.kill(killSignal); } catch {}
    };
    const clearTimer = (timer) => { if (timer) clearTimeout(timer); };
    const clearTimers = () => {
      clearTimer(deadlineTimer);
      clearTimer(forceKillTimer);
      clearTimer(pipeCloseTimer);
      if (progressTimer) clearInterval(progressTimer);
      const usage = rssMonitor?.stop();
      peakRssBytes = Math.max(peakRssBytes, Number(usage?.peakRssBytes || 0));
    };
    const emitProgress = (force = false) => {
      if (settled || typeof onProgress !== "function") return;
      const now = Date.now();
      if (!force && now - lastProgressAt < progressIntervalMs) return;
      lastProgressAt = now;
      try {
        const pending = onProgress({
          status: "running",
          phase,
          command,
          args,
          elapsedMs: now - startedAt,
          stdoutTail,
          stderrTail,
        });
        pending?.catch?.(() => {});
      } catch {}
    };
    const armForceKill = (graceMs = killGraceMs) => {
      clearTimer(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        killTree("SIGKILL");
        destroyPipes();
      }, graceMs);
      forceKillTimer.unref?.();
    };
    const onAbort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      killTree("SIGTERM");
      armForceKill();
      emitProgress(true);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener?.("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      const status = Number.isInteger(exitCode) ? exitCode : -1;
      let error = spawnError ? String(spawnError.message || spawnError) : null;
      if (!error && cancelled) error = `aborted: ${command}`;
      if (!error && timedOut) error = `timed out after ${timeoutMs}ms: ${command}`;
      if (!error && overflowStream) error = `${overflowStream} maxBuffer length exceeded: ${command}`;
      if (!error && resourceLimitExceeded) error = `owned process-group RSS exceeded ${guardConfig.rssLimitBytes} bytes: ${command}`;
      resolve({
        command,
        args,
        status,
        signal: exitSignal,
        ok: status === 0 && !spawnError && !timedOut && !cancelled && !overflowStream && !resourceLimitExceeded,
        crashed: status === 134 || exitSignal === "SIGABRT",
        timedOut,
        cancelled,
        outputLimitExceeded: Boolean(overflowStream),
        resourceLimitExceeded,
        peakRssBytes,
        rssLimitBytes: guardConfig.rssLimitBytes,
        durationMs: Date.now() - startedAt,
        stdout: clip(stdout),
        stderr: clip(stderr),
        error,
      });
    };
    const collect = (streamName) => (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const chunks = streamName === "stdout" ? stdoutChunks : stderrChunks;
      const currentBytes = streamName === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxBuffer - currentBytes);
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      const keptBytes = Math.min(buffer.length, remaining);
      if (streamName === "stdout") {
        stdoutBytes += keptBytes;
        stdoutTail = trimProgressTail(stdoutTail + buffer.toString("utf8"));
      } else {
        stderrBytes += keptBytes;
        stderrTail = trimProgressTail(stderrTail + buffer.toString("utf8"));
      }
      if (buffer.length > remaining && !overflowStream) {
        overflowStream = streamName;
        killTree("SIGKILL");
        destroyPipes();
      }
      emitProgress();
    };

    if (process.platform !== "win32") {
      try {
        const ownership = ownProcessGroup(child);
        rssMonitor = watchOwnedProcessGroupRss(ownership, {
          limitBytes: guardConfig.rssLimitBytes,
          pollMs: guardConfig.rssPollMs,
          onSample: (usage) => { peakRssBytes = Math.max(peakRssBytes, usage.peakRssBytes); },
          onExceeded: (usage) => {
            if (settled || resourceLimitExceeded) return;
            resourceLimitExceeded = true;
            peakRssBytes = Math.max(peakRssBytes, usage.peakRssBytes);
            killTree("SIGTERM");
            armForceKill(guardConfig.termGraceMs);
            emitProgress(true);
          },
        });
      } catch {}
    }

    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    child.on("error", (error) => {
      spawnError = error;
      settle();
    });
    child.on("exit", (code, childSignal) => {
      exitCode = code;
      exitSignal = childSignal;
      clearTimer(deadlineTimer);
      if (!timedOut && !cancelled && !resourceLimitExceeded) clearTimer(forceKillTimer);
      // Do not let a grandchild that inherited stdout/stderr keep the promise
      // pending after the owned process has exited.
      pipeCloseTimer = setTimeout(destroyPipes, Math.min(1_000, killGraceMs));
      pipeCloseTimer.unref?.();
    });
    child.on("close", (code, childSignal) => {
      if (exitCode === null) exitCode = code;
      if (exitSignal === null) exitSignal = childSignal;
      settle();
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        armForceKill();
        emitProgress(true);
      }, timeoutMs);
      deadlineTimer.unref?.();
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (typeof onProgress === "function") {
      progressTimer = setInterval(() => emitProgress(true), progressIntervalMs);
      progressTimer.unref?.();
      emitProgress(true);
    }
  }); } finally { await worker.release(); }
}

async function executeBuildScript(script, args, cwd, timeoutMs, plan, options = {}) {
  let shimDir = null;
  const env = buildEnvironment(plan);
  try {
    if (plan.managed && process.env.PI_BUILD_NPROC_SHIM !== "0") {
      shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-build-jobs-"));
      const shim = path.join(shimDir, "nproc");
      fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' '${plan.jobs}'\n`, { mode: 0o755 });
      env.PATH = `${shimDir}${path.delimiter}${process.env.PATH || ""}`;
    }
    return await execute("sh", [script, ...args], cwd, timeoutMs, env, options);
  } finally {
    if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
  }
}

function normalizeRunOutput(run, cwd) {
  const normalized = normalizeTestResult({ ...run, exitCode: run.status, commandLine: [run.command, ...(run.args || [])].join(" ") }, { root: cwd, stateDir: ".pi/build-runner/raw", maxLines: 200 });
  return { ...run, stdout: normalized.output, stderr: "", outputRef: normalized.outputRef, normalized: { ...normalized, output: undefined } };
}

async function captureBacktrace(binary, args, cwd, options = {}) {
  const gdb = await execute(
    "gdb",
    ["-batch", "-ex", "run", "-ex", "bt", "--args", binary, ...args],
    cwd,
    120_000,
    {},
    { ...options, phase: "backtrace", maxBuffer: 10 * 1024 * 1024 },
  );
  if (gdb.error && !gdb.stdout && !gdb.stderr) return null;
  const text = `${gdb.stdout || ""}\n${gdb.stderr || ""}`;
  if (/No stack|not in executable format|No executable file specified/.test(text)) return null;
  const idx = text.indexOf("#0");
  return idx >= 0 ? clip(text.slice(idx)) : clip(text.slice(-4000));
}

async function runBuildLocked(cwd, options, config) {
  if (!config.build && !config.configure?.buildsProject) return { ok: false, skipped: true, guidance: config.guidance || "No build command configured." };
  const parallelism = planBuildParallelism(cwd, config);
  if (!parallelism.allowed) {
    return {
      ok: false,
      skipped: true,
      parallelism,
      guidance: `Build deferred to avoid an OOM: ${parallelism.memoryAvailableMb} MiB RAM is available, below the ${parallelism.minimumStartMemoryMb} MiB build-start minimum. Free memory, adjust build.minimumStartMemoryMb in .pi/project.json, or set PI_BUILD_ALLOW_LOW_MEMORY=1 to force an attempt.`,
    };
  }

  const configureArguments = resolveConfigureArguments(config, options);
  const missingBuildDirectory = config.build?.directory && !fs.existsSync(path.resolve(cwd, config.build.directory));
  const shouldRunScript = Boolean(config.configure?.script) && (
    options.configure === true
    || options.configureArgs?.length
    || (options.configure !== false && configureArguments.targetArgsApplied)
    || !config.build
    || (options.configure !== false && missingBuildDirectory)
    || (options.configure !== false && !options.target && config.configure.buildsProject)
  );
  if (shouldRunScript) {
    const phase = config.configure.buildsProject ? "build-script" : "configure";
    const configured = await executeBuildScript(
      config.configure.script,
      configureArguments.args,
      cwd,
      options.timeoutMs || config.build?.timeoutMs || DEFAULT_BUILD_TIMEOUT_MS,
      parallelism,
      { ...options, phase },
    );
    if (!configured.ok || (config.configure.buildsProject && (!options.target || !config.build))) {
      return {
        ...normalizeRunOutput(configured, cwd),
        phase,
        source: config.source,
        parallelism,
        script: repositoryRelativePath(cwd, config.configure.script) || config.configure.script,
        configureArgsSource: configureArguments.source,
        configureArgsCount: configureArguments.args.length,
      };
    }
  }

  if (!config.build) return { ok: false, skipped: true, guidance: "The configure script completed but no build command is configured.", parallelism };
  let args = [...config.build.args];
  if (options.target && config.build.targetArg) args.push(config.build.targetArg, options.target);
  else if (options.target) args.push(options.target);
  if (parallelism.managed) args = applyBuildParallelism(config.build.command, args, parallelism.jobs);
  const run = await execute(
    config.build.command,
    args,
    cwd,
    options.timeoutMs || config.build.timeoutMs,
    buildEnvironment(parallelism),
    { ...options, phase: "build" },
  );
  return {
    ...normalizeRunOutput(run, cwd),
    phase: "build",
    source: config.source,
    parallelism,
    ...(shouldRunScript ? { configureArgsSource: configureArguments.source, configureArgsCount: configureArguments.args.length } : {}),
  };
}

async function runBuild(cwd = process.cwd(), options = {}) {
  let config;
  try {
    config = resolveBuildConfig(cwd);
  } catch (error) {
    return { ok: false, skipped: true, phase: "configuration", guidance: String(error?.message || error) };
  }
  return runBuildLocked(cwd, options, config);
}

async function runTestsManaged(cwd = process.cwd(), options = {}) {
  const config = resolveBuildConfig(cwd);
  if (!config.test) return { ok: false, skipped: true, guidance: config.guidance || "No test command configured." };
  const filter = options.filter ? [String(options.filter)] : [];
  const runs = [];
  const skippedBinaries = [];
  if (config.test.command) {
    const commandRun = await execute(
      config.test.command,
      [...config.test.args, ...(config.test.filterArg ? filter : [])],
      cwd,
      options.timeoutMs || config.test.timeoutMs,
      {},
      { ...options, phase: "test" },
    );
    runs.push(normalizeRunOutput(commandRun, cwd));
  }
  for (const binary of config.test.binaries) {
    const absolute = path.isAbsolute(binary) ? binary : path.join(cwd, binary);
    // Pinned binaries in unbuilt trees are skipped, not failed: root build/
    // directories come and go on large repos.
    if (!fs.existsSync(absolute)) {
      skippedBinaries.push(binary);
      continue;
    }
    const binaryArgs = config.test.filterArg ? filter : [];
    let run = await execute(
      absolute,
      binaryArgs,
      cwd,
      options.timeoutMs || config.test.timeoutMs,
      {},
      { ...options, phase: "test" },
    );
    // Session mining found 44 immediate identical retries — humans doing
    // flake detection by hand. Retry a plain failure once and classify.
    if (!run.ok && !run.crashed && !run.timedOut && !run.cancelled && !run.outputLimitExceeded && options.retryFlaky !== false) {
      const retry = await execute(
        absolute,
        binaryArgs,
        cwd,
        options.timeoutMs || config.test.timeoutMs,
        {},
        { ...options, phase: "test-retry" },
      );
      if (retry.ok) run = { ...retry, flaky: true, firstFailure: { status: run.status, stderr: run.stderr } };
    }
    if (run.crashed && options.backtrace !== false && !options.signal?.aborted) {
      run.backtrace = await captureBacktrace(absolute, binaryArgs, cwd, options);
    }
    runs.push(normalizeRunOutput(run, cwd));
  }
  if (!runs.length) return { ok: false, skipped: true, guidance: config.guidance || "No test binaries found; pin them in .pi/project.json.", skippedBinaries };
  return { ok: runs.every((run) => run.ok), source: config.source, runs, skippedBinaries };
}

async function runTests(cwd = process.cwd(), options = {}) {
  return runTestsManaged(cwd, options);
}

function formatRunProgress(progress) {
  const elapsed = Math.max(0, Math.round(Number(progress?.elapsedMs || 0) / 1000));
  const phase = progress?.phase || "build";
  const activity = `running ${phase}`;
  const output = [progress?.stdoutTail, progress?.stderrTail]
    .filter(Boolean)
    .join("\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(Boolean)
    .slice(-12)
    .join("\n");
  return `${activity} (${elapsed}s)${output ? `\n${output}` : ""}`;
}

function formatRunResult(result) {
  if (result.skipped) return `skipped: ${result.guidance}`;
  if (result.runs) {
    const body = result.runs
      .map((run) => {
        const state = run.ok
          ? (run.flaky ? "ok (FLAKY: failed once, passed on retry)" : "ok")
          : run.cancelled ? "CANCELLED"
            : run.timedOut ? "TIMED OUT"
              : run.crashed ? "CRASHED (native abort)" : "FAILED";
        const head = `${state} ${path.basename(run.command)} ${run.args.join(" ")} (${Math.round(run.durationMs / 1000)}s, exit ${run.status})`;
        const tail = run.ok ? "" : `\n${run.stderr || run.stdout}`.trimEnd();
        const bt = run.backtrace ? `\nbacktrace:\n${run.backtrace}` : "";
        return `${head}${tail}${bt}`;
      })
      .join("\n\n");
    const skippedNote = result.skippedBinaries?.length ? `\n\nskipped (not built): ${result.skippedBinaries.join(", ")}` : "";
    return `${body}${skippedNote}`;
  }
  const resources = result.parallelism?.managed
    ? `, jobs ${result.parallelism.jobs}${result.parallelism.largeRepo ? " memory-capped large repo" : " memory-capped"}`
    : result.parallelism?.largeRepo ? ", memory-checked large repo" : "";
  const state = result.ok ? "ok" : result.cancelled ? "CANCELLED" : result.timedOut ? "TIMED OUT" : "FAILED";
  const head = `${state} ${result.phase || "build"} (${Math.round(result.durationMs / 1000)}s, exit ${result.status}${resources})`;
  if (result.ok) return head;
  const failure = [result.error, result.stderr || result.stdout].filter(Boolean).join("\n");
  return `${head}${failure ? `\n${failure}` : ""}`.trimEnd();
}

module.exports = {
  resolveBuildConfig,
  pinnedBuildFacts,
  inspectBuildScript,
  resolveConfigureArguments,
  inspectNativeRepoScale,
  inspectNonNativeRepoScale,
  planBuildParallelism,
  applyBuildParallelism,
  runBuild,
  runTests,
  formatRunProgress,
  formatRunResult,
};
