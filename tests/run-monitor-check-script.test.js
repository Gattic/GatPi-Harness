#!/usr/bin/env node
"use strict";

// Deterministic checks for scripts/run-monitor-check.js. The script performs
// monitor sampling and target probes without Pi, without user messages, and
// without model calls.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createMonitor, readMonitor } = require("../src/run-monitor.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const script = path.join(__dirname, "..", "scripts", "run-monitor-check.js");
const sessionId = "session-script-check";
const cwd = tmpFixture("pi-run-monitor-script-");

function writeJob(jobId, options = {}) {
  const dir = path.join(cwd, ".pi", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify({
    jobId,
    name: "script check job",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    managedUsage: { eligible: true, starts: 1 },
  }));
  if (options.log) fs.writeFileSync(path.join(dir, `${jobId}.log`), options.log);
  if (options.exitCode !== undefined) fs.writeFileSync(path.join(dir, `${jobId}.exit`), `${options.exitCode}\n`);
}

function writeRun(runId, options = {}) {
  const dir = path.join(cwd, ".pi", "run-deck");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({
    runId,
    name: "script check run",
    command: null,
    jobId: null,
    pid: null,
    logPath: null,
    jobLog: null,
    pidPattern: null,
    status: options.status || "running",
    startedAt: new Date().toISOString(),
    notes: [],
    latest: null,
  }));
}

function run(args) {
  return spawnSync(process.execPath, [script, "--cwd", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PI_RUN_MONITOR_INTENT_TELEMETRY: "0", PI_EXTENSION_TELEMETRY: "0" },
  });
}

// One active monitor is sampled and probed as JSON.
writeJob("job-script-active");
const active = createMonitor(cwd, { kind: "bg_run", targetId: "job-script-active", ownerSessionId: sessionId, intervalMs: 60_000, timeoutMs: 60_000 });
const activeRun = run(["--monitor", active.monitorId, "--session", sessionId, "--json"]);
assert.equal(activeRun.status, 0, activeRun.stderr);
const activeResult = JSON.parse(activeRun.stdout);
assert.equal(activeResult.monitorId, active.monitorId);
assert.equal(activeResult.status, "active");
assert.equal(activeResult.probe.targetStatus, "running");
assert.equal(activeResult.probe.active, true);
assert.equal(activeResult.scriptCheck, null, "active monitors are not marked terminal");

// Terminal monitors receive a persisted script probe with fresh target evidence.
writeJob("job-script-settled", { exitCode: 4, log: "secret log line\n" });
const settled = createMonitor(cwd, { kind: "bg_run", targetId: "job-script-settled", ownerSessionId: sessionId, intervalMs: 60_000, timeoutMs: 60_000 });
const settledRun = run(["--monitor", settled.monitorId, "--session", sessionId, "--json"]);
assert.equal(settledRun.status, 0, settledRun.stderr);
const settledResult = JSON.parse(settledRun.stdout);
assert.equal(settledResult.status, "settled");
assert.equal(settledResult.probe.exitCode, 4);
assert.equal(settledResult.scriptCheck.exitCode, 4);
assert.equal(settledResult.scriptCheck.targetStatus, "exited");
assert.doesNotMatch(settledRun.stdout, /secret log line/, "the checker never emits log text");
assert.equal(readMonitor(cwd, settled.monitorId).scriptCheck.exitCode, 4, "the probe is persisted on the monitor");

const textRun = run(["--monitor", settled.monitorId, "--session", sessionId]);
assert.equal(textRun.status, 0, textRun.stderr);
assert.match(textRun.stdout, /\[settled\] bg_run:job-script-settled/);
assert.match(textRun.stdout, /script-check=exited \(exit 4\)/);

// A run_deck monitor receives the same script probe; a finished run has no
// process liveness and no invented exit code.
writeRun("run-script-finished", { status: "finished" });
const runMonitor = createMonitor(cwd, { kind: "run_deck", targetId: "run-script-finished", ownerSessionId: sessionId, intervalMs: 60_000, timeoutMs: 60_000 });
const runDeckRun = run(["--monitor", runMonitor.monitorId, "--session", sessionId, "--json"]);
assert.equal(runDeckRun.status, 0, runDeckRun.stderr);
const runDeckResult = JSON.parse(runDeckRun.stdout);
assert.equal(runDeckResult.status, "settled");
assert.equal(runDeckResult.probe.targetStatus, "finished");
assert.equal(runDeckResult.probe.alive, null);
assert.equal(runDeckResult.scriptCheck.targetStatus, "finished");
assert.equal(runDeckResult.scriptCheck.exitCode, null);

// Session and all selectors return one entry per active monitor. A monitor
// owned by another session is excluded from --session but included in --all.
writeJob("job-script-other");
const other = createMonitor(cwd, { kind: "bg_run", targetId: "job-script-other", ownerSessionId: "session-other", intervalMs: 60_000, timeoutMs: 60_000 });
const sessionRun = run(["--session", sessionId, "--json"]);
assert.equal(sessionRun.status, 0, sessionRun.stderr);
const sessionResults = JSON.parse(sessionRun.stdout);
assert.equal(sessionResults.length, 1);
assert.equal(sessionResults[0].monitorId, active.monitorId);

const allRun = run(["--all", "--json"]);
assert.equal(allRun.status, 0, allRun.stderr);
const allResults = JSON.parse(allRun.stdout);
assert.deepEqual(allResults.map((result) => result.monitorId).sort(), [active.monitorId, other.monitorId].sort());

// Watch exits immediately when the selected monitor is already terminal.
const terminalWatch = run(["--monitor", settled.monitorId, "--session", sessionId, "--watch", "--interval-ms", "1", "--timeout-ms", "1000", "--json"]);
assert.equal(terminalWatch.status, 0, terminalWatch.stderr);

// Watch exits 3 at its observation deadline while the target remains active.
const timeoutWatch = run(["--monitor", active.monitorId, "--session", sessionId, "--watch", "--interval-ms", "1000", "--timeout-ms", "1000", "--json"]);
assert.equal(timeoutWatch.status, 3);
assert.match(timeoutWatch.stderr, /deadline reached/);
const watchLines = timeoutWatch.stdout.trim().split("\n");
assert.equal(watchLines.length, 2, "watch JSON is emitted as one document per line");
for (const line of watchLines) JSON.parse(line);

// Usage errors fail closed without checking anything.
const missingValue = run(["--monitor"]);
assert.equal(missingValue.status, 2);
assert.match(missingValue.stderr, /requires a value/);
const unknownOption = run(["--nope"]);
assert.equal(unknownOption.status, 2);
assert.match(unknownOption.stderr, /unknown option/);
const conflictingAllSession = run(["--all", "--session", sessionId, "--json"]);
assert.equal(conflictingAllSession.status, 2);
assert.match(conflictingAllSession.stderr, /--all cannot be combined with --session/);
const conflictingAllMonitor = run(["--all", "--monitor", active.monitorId, "--json"]);
assert.equal(conflictingAllMonitor.status, 2);
assert.match(conflictingAllMonitor.stderr, /--all cannot be combined with --monitor/);

// A missing monitor and a monitor whose target state disappeared both fail
// closed with exit 2 instead of inventing a result.
const missingMonitorRun = run(["--monitor", "monitor-missing", "--json"]);
assert.equal(missingMonitorRun.status, 2);
assert.match(missingMonitorRun.stderr, /monitor not found/);
writeJob("job-script-missing-target");
const missingTarget = createMonitor(cwd, { kind: "bg_run", targetId: "job-script-missing-target", ownerSessionId: sessionId, intervalMs: 60_000, timeoutMs: 60_000 });
fs.rmSync(path.join(cwd, ".pi", "jobs", "job-script-missing-target.json"));
const missingTargetRun = run(["--monitor", missingTarget.monitorId, "--session", sessionId, "--json"]);
assert.equal(missingTargetRun.status, 2);
assert.match(missingTargetRun.stderr, /job not found/);

const source = fs.readFileSync(script, "utf8");
assert.doesNotMatch(source, /sendUserMessage|@earendil-works|pi-coding-agent/, "the checker is independent of Pi model APIs");

fs.rmSync(cwd, { recursive: true, force: true });
console.log("run-monitor check script tests passed");
