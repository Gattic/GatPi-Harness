#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jobStatus } = require("../src/bg-jobs.js");
const { recordManagedProcessEvent, managedProcessMetrics } = require("../src/managed-process-metrics.js");
const {
  createMonitor,
  checkMonitor,
  probeMonitor,
  recordMonitorProbe,
  stopMonitor,
  requireMonitor,
  readMonitor,
  listMonitors,
  formatMonitor,
  classifyMonitorIntent,
} = require("../src/run-monitor.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

assert.equal(classifyMonitorIntent("Notify me periodically when job-build settles").eligible, true);
assert.equal(classifyMonitorIntent("Monitor this long-running training process").eligible, true);
assert.equal(classifyMonitorIntent("Review the monitor implementation").eligible, false, "feature discussion without a managed target is not an opportunity");
assert.equal(classifyMonitorIntent("Run the tests").eligible, false);

function tmp() {
  return tmpFixture("pi-run-monitor-");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJob(cwd, jobId, options = {}) {
  writeJson(path.join(cwd, ".pi", "jobs", `${jobId}.json`), {
    jobId,
    name: options.name || "monitored test job",
    pid: options.pid === undefined ? process.pid : options.pid,
    startedAt: new Date().toISOString(),
    managedUsage: { eligible: true, starts: 1 },
  });
  if (options.log) fs.writeFileSync(path.join(cwd, ".pi", "jobs", `${jobId}.log`), options.log);
  if (options.exitCode !== undefined) fs.writeFileSync(path.join(cwd, ".pi", "jobs", `${jobId}.exit`), `${options.exitCode}\n`);
}

function writeRun(cwd, runId, options = {}) {
  const file = path.join(cwd, ".pi", "run-deck", `${runId}.json`);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  writeJson(file, {
    ...existing,
    runId,
    name: options.name || "monitored test run",
    command: null,
    jobId: null,
    pid: options.pid === undefined ? null : options.pid,
    logPath: options.logPath || null,
    jobLog: null,
    pidPattern: null,
    status: options.status || "running",
    startedAt: new Date().toISOString(),
    notes: [],
    latest: null,
  });
}

const cwd = tmp();
const ownerSessionId = "session-monitor-test";

// A pattern monitor checks immediately, stays quiet while active, then reaches
// one terminal edge when the bounded log tail matches.
writeJob(cwd, "job-pattern", { log: "starting\n" });
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function rejectWholeLogReads(file, ...args) {
  if (String(file).endsWith(".log")) throw new Error("monitor must use a bounded tail read");
  return originalReadFileSync.call(this, file, ...args);
};
let patternMonitor;
let matched;
try {
  patternMonitor = createMonitor(cwd, {
    kind: "bg_run",
    targetId: "job-pattern",
    ownerSessionId,
    intervalMs: 2_000,
    timeoutMs: 60_000,
    pattern: "READY step=3",
    now: 1_000,
  });
  assert.equal(patternMonitor.status, "active");
  assert.equal(patternMonitor.checks, 1, "start performs one immediate sample");
  fs.appendFileSync(path.join(cwd, ".pi", "jobs", "job-pattern.log"), "READY step=3\n");
  matched = checkMonitor(cwd, patternMonitor.monitorId, { ownerSessionId, now: 3_000 });
} finally {
  fs.readFileSync = originalReadFileSync;
}
assert.equal(matched.status, "matched");
assert.equal(matched.last.matched, true);
assert.match(formatMonitor(matched), /pattern matched/);
assert.equal(checkMonitor(cwd, patternMonitor.monitorId, { ownerSessionId, now: 5_000 }).checks, 2, "terminal monitors are not sampled again");

// Process settlement is independent of pattern matching and records the exit.
writeJob(cwd, "job-settled", { exitCode: 7 });
const settled = createMonitor(cwd, {
  kind: "bg_run",
  targetId: "job-settled",
  ownerSessionId,
  now: 10_000,
});
assert.equal(settled.status, "settled");
assert.equal(settled.last.exitCode, 7);
assert.match(settled.reason, /exit 7/);
recordManagedProcessEvent(cwd, "bg_run", "job-settled", "settlement-notified");
recordManagedProcessEvent(cwd, "bg_run", "job-settled", "settlement-notified");
assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "jobs", "job-settled.json"), "utf8")).managedUsage.settlementNotifications, 1, "settlement notification is captured exactly once");

// A deadline is an observation timeout, not a target failure. The target stays
// alive and can still be inspected with bg_run after the monitor stops.
writeJob(cwd, "job-timeout");
const timeoutMonitor = createMonitor(cwd, {
  kind: "bg_run",
  targetId: "job-timeout",
  ownerSessionId,
  intervalMs: 1_000,
  timeoutMs: 1_000,
  now: 20_000,
});
assert.equal(timeoutMonitor.status, "active");
const timedOut = checkMonitor(cwd, timeoutMonitor.monitorId, { ownerSessionId, now: 21_001 });
assert.equal(timedOut.status, "timed_out");
assert.match(timedOut.reason, /target was still active/);
assert.equal(jobStatus(cwd, "job-timeout").status, "running", "monitor timeout never stops the target");

// Attached run_deck targets with unknown liveness stay active until explicitly
// finished, matching the existing managed-background contract.
writeRun(cwd, "run-attached-monitor");
const runMonitor = createMonitor(cwd, {
  kind: "run_deck",
  targetId: "run-attached-monitor",
  ownerSessionId,
  now: 30_000,
});
assert.equal(runMonitor.status, "active");
writeRun(cwd, "run-attached-monitor", { status: "finished" });
const runSettled = checkMonitor(cwd, runMonitor.monitorId, { ownerSessionId, now: 31_000 });
assert.equal(runSettled.status, "settled");
assert.equal(runSettled.last.targetStatus, "finished");

// The script probe also handles run_deck targets and persists their terminal
// state without inventing an exit code.
const runProbe = probeMonitor(cwd, runMonitor.monitorId, { ownerSessionId });
assert.equal(runProbe.probe.active, false);
assert.equal(runProbe.probe.targetStatus, "finished");
assert.equal(runProbe.probe.alive, null);
assert.equal(runProbe.probe.exitCode, null);
const runRecorded = recordMonitorProbe(cwd, runMonitor.monitorId, runProbe.probe, { ownerSessionId, now: 32_000 });
assert.equal(runRecorded.scriptCheck.targetStatus, "finished");
assert.equal(runRecorded.scriptCheck.exitCode, null);
assert.match(formatMonitor(runRecorded), /script-check=finished/);

// Explicit stop affects only the monitor, and records are session-isolated.
writeJob(cwd, "job-stop");
const stoppable = createMonitor(cwd, {
  kind: "bg_run",
  targetId: "job-stop",
  ownerSessionId,
  now: 40_000,
});
const stopped = stopMonitor(cwd, stoppable.monitorId, { ownerSessionId, now: 41_000 });
assert.equal(stopped.status, "stopped");
assert.equal(jobStatus(cwd, "job-stop").status, "running");
assert.throws(() => requireMonitor(cwd, stoppable.monitorId, { ownerSessionId: "another-session" }), /different Pi session/);
assert.equal(listMonitors(cwd, { ownerSessionId: "another-session" }).length, 0);
assert.equal(listMonitors(cwd, { ownerSessionId }).length, 5);

// Bounded owner ids compare consistently against the original session id.
writeJob(cwd, "job-long-owner");
const longOwnerSessionId = `session-${"x".repeat(250)}`;
const longOwnerMonitor = createMonitor(cwd, { kind: "bg_run", targetId: "job-long-owner", ownerSessionId: longOwnerSessionId });
assert.equal(longOwnerMonitor.ownerSessionId.length, 200);
assert.equal(requireMonitor(cwd, longOwnerMonitor.monitorId, { ownerSessionId: longOwnerSessionId }).monitorId, longOwnerMonitor.monitorId);
assert(listMonitors(cwd, { ownerSessionId: longOwnerSessionId }).some((monitor) => monitor.monitorId === longOwnerMonitor.monitorId));
recordManagedProcessEvent(cwd, "bg_run", "job-long-owner", "monitor-attached", { eventKey: longOwnerMonitor.monitorId });

// IDs and bounded literal patterns are validated before state is written.
assert.throws(() => createMonitor(cwd, { kind: "bg_run", targetId: "../../etc/passwd", ownerSessionId }), /invalid bg_run target id/);
assert.throws(() => createMonitor(cwd, { kind: "bg_run", targetId: "job-stop", ownerSessionId, pattern: "x".repeat(501) }), /pattern exceeds 500 characters/);
const monitorMode = fs.statSync(path.join(cwd, ".pi", "run-monitor", `${stoppable.monitorId}.json`)).mode & 0o777;
assert.equal(monitorMode, 0o600, "monitor state is private");
const metrics = managedProcessMetrics(cwd);
assert.equal(metrics.byKind.bg_run.monitorAttachments, 5);
assert.equal(metrics.byKind.run_deck.monitorAttachments, 1);
assert.equal(metrics.byKind.bg_run.settlementNotifications, 1);
assert.equal(metrics.byKind.bg_run.monitorAttachmentRate, 1);
assert.equal(metrics.byKind.bg_run.settlementNotificationRate, 0.2);
assert.equal(metrics.byKind.bg_run.gaps.unnotifiedMonitors, 4);

// Terminal edges are verified by a script probe; the monitor library never
// carries wake claims or sends user messages.
const probeCwd = tmp();
writeJob(probeCwd, "job-probe-settled", { exitCode: 0, log: "secret log line\n" });
const probeRecord = createMonitor(probeCwd, { kind: "bg_run", targetId: "job-probe-settled", ownerSessionId, now: 50_000 });
assert.equal(probeRecord.status, "settled");
const probe = probeMonitor(probeCwd, probeRecord.monitorId, { ownerSessionId });
assert.equal(probe.status, "settled");
assert.equal(probe.probe.targetStatus, "exited");
assert.equal(probe.probe.exitCode, 0);
assert.equal(probe.scriptCheck, null);
assert.doesNotMatch(JSON.stringify(probe), /secret log line/, "probes never include log text");
const recorded = recordMonitorProbe(probeCwd, probeRecord.monitorId, probe.probe, { ownerSessionId, now: 51_000 });
assert.equal(recorded.scriptCheck.targetStatus, "exited");
assert.equal(recorded.scriptCheck.exitCode, 0);
assert.equal(recorded.scriptCheck.at, new Date(51_000).toISOString());
assert.match(formatMonitor(recorded), /script-check=exited \(exit 0\)/);

// A matched monitor stays terminal while its target is still active; the script
// probe records that distinction instead of inventing settlement.
writeJob(probeCwd, "job-probe-matched", { log: "READY\n" });
const matchedProbe = createMonitor(probeCwd, { kind: "bg_run", targetId: "job-probe-matched", ownerSessionId, pattern: "READY", now: 52_000 });
assert.equal(matchedProbe.status, "matched");
const matchedProbeResult = probeMonitor(probeCwd, matchedProbe.monitorId, { ownerSessionId });
assert.equal(matchedProbeResult.probe.active, true);
recordMonitorProbe(probeCwd, matchedProbe.monitorId, matchedProbeResult.probe, { ownerSessionId, now: 53_000 });
assert.match(formatMonitor(readMonitor(probeCwd, matchedProbe.monitorId)), /script-check=running/);

// Older records may carry the removed wake claim. Reading strips it and the
// next write migrates the record instead of preserving the inert field.
const legacyCwd = tmp();
writeJob(legacyCwd, "job-legacy-wake", { exitCode: 0 });
const legacy = createMonitor(legacyCwd, { kind: "bg_run", targetId: "job-legacy-wake", ownerSessionId, now: 54_000 });
const legacyFile = path.join(legacyCwd, ".pi", "run-monitor", `${legacy.monitorId}.json`);
const legacyRecord = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
legacyRecord.wake = { at: new Date(55_000).toISOString(), outcome: "queued" };
fs.writeFileSync(legacyFile, `${JSON.stringify(legacyRecord, null, 2)}\n`);
assert.equal(readMonitor(legacyCwd, legacy.monitorId).wake, undefined, "read strips the obsolete wake claim");
const legacyProbe = probeMonitor(legacyCwd, legacy.monitorId, { ownerSessionId });
recordMonitorProbe(legacyCwd, legacy.monitorId, legacyProbe.probe, { ownerSessionId, now: 56_000 });
assert.equal(JSON.parse(fs.readFileSync(legacyFile, "utf8")).wake, undefined, "the next write persists the migration");
fs.rmSync(legacyCwd, { recursive: true, force: true });

fs.rmSync(probeCwd, { recursive: true, force: true });

const librarySource = fs.readFileSync(path.join(__dirname, "..", "src", "run-monitor.js"), "utf8");
assert.doesNotMatch(librarySource, /claimMonitorWake|formatMonitorWake|sendUserMessage/, "monitor checks never send model messages");
// Extension-level guardrails: polling is lifecycle-owned, and terminal edges
// run the deterministic script checker instead of sending model messages.
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "extensions", "run-monitor", "index.ts"), "utf8");
assert.match(extensionSource, /execFile\b/);
assert.doesNotMatch(extensionSource, /execFileSync/, "script checks must not block the event loop");
assert.match(extensionSource, /scripts", "run-monitor-check\.js"/);
assert.match(extensionSource, /inFlight/, "overlapping checks for one monitor are serialized");
assert.doesNotMatch(extensionSource, /sendUserMessage/, "monitor checks never send model messages");
assert.doesNotMatch(extensionSource, /AutomationLoopStore|claimMonitorWake|formatMonitorWake/);
assert.match(extensionSource, /pi\.on\("session_start"/);
assert.match(extensionSource, /pi\.on\("session_shutdown"/);
assert.match(extensionSource, /setInterval/);
assert.match(extensionSource, /timer\.unref/);
assert.match(extensionSource, /name: "run_monitor"/);
assert.match(extensionSource, /managed-long-run-monitor-intent/);
assert.match(extensionSource, /featureSignal\(ctx, "settlement-notified"/);
assert.match(extensionSource, /pi\.on\("agent_settled"/);

const awarenessSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "harness-awareness", "index.ts"), "utf8");
assert.match(awarenessSource, /run_monitor watches an existing bg_run\/run_deck target/);
assert.match(awarenessSource, /script-backed checks never start a model turn/);
assert.doesNotMatch(extensionSource, /sendMessage\s*\(/);
assert.doesNotMatch(extensionSource, /triggerTurn|deliverAs: "steer"/);

console.log("run monitor tests passed");
