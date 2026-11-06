#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  snapshotManagedWork,
  managedWorkDependencies,
  pendingManagedWork,
  waitForManagedWork,
} = require("../src/managed-background.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function tmp() { return tmpFixture("pi-loop-background-"); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function writeJob(cwd, id) {
  writeJson(path.join(cwd, ".pi", "jobs", `${id}.json`), {
    jobId: id,
    name: "test background work",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
}
function finishJob(cwd, id, code = 0) {
  fs.writeFileSync(path.join(cwd, ".pi", "jobs", `${id}.exit`), `${code}\n`);
}
function writeRun(cwd, id, jobId, options = {}) {
  writeJson(path.join(cwd, ".pi", "run-deck", `${id}.json`), {
    runId: id,
    name: "test deck run",
    jobId,
    pid: options.pid === undefined ? process.pid : options.pid,
    logPath: null,
    jobLog: null,
    pidPattern: null,
    status: options.status || "running",
    startedAt: new Date().toISOString(),
    notes: [],
    latest: null,
  });
}

async function main() {
  const bgCwd = tmp();
  const bgBaseline = snapshotManagedWork(bgCwd);
  writeJob(bgCwd, "job-loop-bg");
  const bgDependencies = managedWorkDependencies(bgBaseline, snapshotManagedWork(bgCwd));
  assert.deepEqual(bgDependencies, [{ kind: "bg_run", id: "job-loop-bg" }]);
  assert.equal(pendingManagedWork(bgCwd, bgDependencies).length, 1, "active bg_run must block the next iteration");
  let bgPolls = 0;
  const bgWait = await waitForManagedWork(bgCwd, bgDependencies, {
    pollMs: 10,
    sleep: async () => { bgPolls++; finishJob(bgCwd, "job-loop-bg"); },
  });
  assert.equal(bgWait.outcome, "settled");
  assert.equal(bgPolls, 1, "bg_run wait must poll until its exit file appears");
  assert.equal(pendingManagedWork(bgCwd, bgDependencies).length, 0);

  const deckCwd = tmp();
  const deckBaseline = snapshotManagedWork(deckCwd);
  writeJob(deckCwd, "job-loop-deck");
  writeRun(deckCwd, "run-loop-deck", "job-loop-deck");
  const deckDependencies = managedWorkDependencies(deckBaseline, snapshotManagedWork(deckCwd));
  assert.deepEqual(deckDependencies, [{ kind: "run_deck", id: "run-loop-deck", jobId: "job-loop-deck" }], "run_deck launch must deduplicate its underlying bg_run job");
  assert.equal(pendingManagedWork(deckCwd, deckDependencies).length, 1, "active run_deck must block the next iteration");
  let deckPolls = 0;
  const deckWait = await waitForManagedWork(deckCwd, deckDependencies, {
    pollMs: 10,
    sleep: async () => { deckPolls++; finishJob(deckCwd, "job-loop-deck"); },
  });
  assert.equal(deckWait.outcome, "settled");
  assert.equal(deckPolls, 1, "run_deck wait must poll until its managed job exits");
  assert.equal(pendingManagedWork(deckCwd, deckDependencies).length, 0);

  const attachedCwd = tmp();
  const attachedBaseline = snapshotManagedWork(attachedCwd);
  writeRun(attachedCwd, "run-attached-unknown", null, { pid: null });
  const attachedDependencies = managedWorkDependencies(attachedBaseline, snapshotManagedWork(attachedCwd));
  assert.deepEqual(attachedDependencies, [{ kind: "run_deck", id: "run-attached-unknown", jobId: null }]);
  let attachedPolls = 0;
  const attachedWait = await waitForManagedWork(attachedCwd, attachedDependencies, {
    pollMs: 10,
    sleep: async () => {
      attachedPolls++;
      writeRun(attachedCwd, "run-attached-unknown", null, { pid: null, status: "finished" });
    },
  });
  assert.equal(attachedWait.outcome, "settled");
  assert.equal(attachedPolls, 1, "attached deck without PID evidence must wait for explicit finish");

  const scopedCwd = tmp();
  writeJob(scopedCwd, "job-preexisting");
  const scopedBaseline = snapshotManagedWork(scopedCwd);
  writeJob(scopedCwd, "job-new-iteration");
  const scopedDependencies = managedWorkDependencies(scopedBaseline, snapshotManagedWork(scopedCwd));
  assert.deepEqual(scopedDependencies, [{ kind: "bg_run", id: "job-new-iteration" }], "unrelated pre-existing work must not freeze the loop");

  let continueChecks = 0;
  const cancelledWait = await waitForManagedWork(scopedCwd, scopedDependencies, {
    pollMs: 10,
    shouldContinue: () => continueChecks++ === 0,
    sleep: async () => {},
  });
  assert.equal(cancelledWait.outcome, "cancelled", "loop-stop/state cancellation must end polling without queueing a continuation");

  console.log("automation loop background wait tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
