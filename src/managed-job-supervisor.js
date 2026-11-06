"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  ownProcessGroup,
  processGroupAlive,
  resourceGuardConfig,
  terminateOwnedProcessGroup,
  watchOwnedProcessGroupRss,
} = require("./resource-guard.js");

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readLaunch(file) {
  const launch = JSON.parse(fs.readFileSync(file, "utf8"));
  try { fs.rmSync(file, { force: true }); } catch {}
  if (!launch || launch.schemaVersion !== 1 || !launch.command || !launch.cwd || !launch.exitFile || !launch.logFile || !launch.guardFile) {
    throw new Error("invalid managed job launch record");
  }
  return launch;
}

function signalExitCode(signal) {
  return 128 + Number(os.constants.signals?.[signal] || 0);
}

async function supervise(launchFile) {
  const launch = readLaunch(launchFile);
  const config = resourceGuardConfig(launch.resourceGuard || {});
  const logFd = fs.openSync(launch.logFile, "a", 0o600);
  let child;
  let ownership;
  let monitor;
  let terminationPromise;
  let stopReason;
  let childCode = null;
  let childSignal = null;
  let lastGuardWrite = 0;
  const state = {
    schemaVersion: 1,
    supervisorPid: process.pid,
    phase: "starting",
    rssLimitBytes: config.rssLimitBytes,
    rssPollMs: config.rssPollMs,
    termGraceMs: config.termGraceMs,
    currentRssBytes: 0,
    peakRssBytes: 0,
    processGroupMembers: 0,
    terminationReason: null,
    signals: [],
  };
  const writeState = (force = false) => {
    const now = Date.now();
    if (!force && now - lastGuardWrite < Math.max(250, config.rssPollMs)) return;
    lastGuardWrite = now;
    try { writePrivateJson(launch.guardFile, state); } catch {}
  };
  const logGuard = (message) => {
    try { fs.writeSync(logFd, `[pi resource guard] ${message}\n`); } catch {}
  };
  const finishExit = (code) => {
    try { fs.writeFileSync(launch.exitFile, `${Number.isInteger(code) ? code : 1}\n`, { mode: 0o600 }); } catch {}
  };
  const requestTermination = (reason, usage) => {
    if (!stopReason) stopReason = reason;
    if (usage) {
      state.currentRssBytes = usage.rssBytes;
      state.peakRssBytes = Math.max(state.peakRssBytes, usage.peakRssBytes || usage.rssBytes);
      state.processGroupMembers = usage.members;
    }
    state.terminationReason = stopReason;
    if (!ownership) return Promise.resolve({ signals: [], termSent: false, killSent: false });
    if (terminationPromise) return terminationPromise;
    state.phase = "terminating";
    writeState(true);
    logGuard(`${reason}; sending SIGTERM to owned process group ${ownership.processGroupId}`);
    monitor?.stop();
    terminationPromise = terminateOwnedProcessGroup(ownership, {
      graceMs: config.termGraceMs,
      pollMs: Math.min(100, config.rssPollMs),
    }).then((result) => {
      state.signals = result.signals;
      if (result.killSent) logGuard(`owned process group ignored SIGTERM for ${config.termGraceMs}ms; sent SIGKILL`);
      return result;
    });
    return terminationPromise;
  };

  const onSignal = () => { void requestTermination("explicit-stop"); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  writeState(true);

  try {
    if (stopReason) throw Object.assign(new Error("managed job stopped before launch"), { name: "AbortError" });
    child = spawn("sh", ["-c", launch.command], {
      cwd: launch.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    ownership = ownProcessGroup(child);
    state.commandPid = child.pid;
    state.processGroupId = child.pid;
    state.phase = "running";
    state.startedAt = new Date().toISOString();
    writeState(true);

    const childClosed = new Promise((resolve) => {
      child.on("error", (error) => {
        logGuard(`command launch failed: ${error?.message || String(error)}`);
        childCode = 127;
        resolve();
      });
      child.on("close", (code, signal) => {
        childCode = Number.isInteger(code) ? code : null;
        childSignal = signal || null;
        resolve();
      });
    });

    monitor = watchOwnedProcessGroupRss(ownership, {
      limitBytes: config.rssLimitBytes,
      pollMs: config.rssPollMs,
      onSample: (usage) => {
        state.currentRssBytes = usage.rssBytes;
        state.peakRssBytes = Math.max(state.peakRssBytes, usage.peakRssBytes || usage.rssBytes);
        state.processGroupMembers = usage.members;
        writeState();
      },
      onExceeded: (usage) => {
        logGuard(`RSS ${usage.rssBytes} bytes exceeded ${usage.limitBytes}-byte limit`);
        void requestTermination("rss-limit", usage);
      },
    });

    await childClosed;
    if (terminationPromise) await terminationPromise;
    else if (processGroupAlive(child.pid)) await requestTermination("descendant-cleanup");

    const sample = monitor?.stop() || {};
    state.peakRssBytes = Math.max(state.peakRssBytes, Number(sample.peakRssBytes || 0));
    state.currentRssBytes = 0;
    state.processGroupMembers = 0;
    state.phase = "finished";
    state.finishedAt = new Date().toISOString();
    writeState(true);

    if (stopReason === "rss-limit") finishExit(137);
    else if (stopReason === "explicit-stop") finishExit(signalExitCode("SIGTERM"));
    else if (Number.isInteger(childCode)) finishExit(childCode);
    else if (childSignal) finishExit(signalExitCode(childSignal));
    else finishExit(1);
  } catch (error) {
    const aborted = error?.name === "AbortError" && stopReason === "explicit-stop";
    state.phase = "finished";
    state.finishedAt = new Date().toISOString();
    state.error = aborted ? null : String(error?.message || error);
    state.terminationReason = stopReason || (aborted ? "explicit-stop" : "supervisor-error");
    writeState(true);
    if (!aborted) logGuard(`supervisor failed: ${state.error}`);
    finishExit(aborted ? signalExitCode("SIGTERM") : 1);
  } finally {
    monitor?.stop();
    try { fs.closeSync(logFd); } catch {}
  }
}

const launchFile = process.argv[2];
if (!launchFile) process.exitCode = 2;
else supervise(path.resolve(launchFile)).catch(() => { process.exitCode = 1; });
