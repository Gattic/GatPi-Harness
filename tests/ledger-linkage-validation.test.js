#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  openExperiment,
  recordGate,
  linkDebugThread,
  openExperimentsSummary,
  showExperiment,
  migrateExperimentLedger,
} = require("../src/experiment-ledger.js");
const { openThread, showThread, openThreadsSummary } = require("../src/debug-ledger.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-ledger-linkage-");

const experiment = openExperiment(cwd, "Linkage fixture", { bars: ["loss <= 1.0", "no NaN"], arms: ["baseline"] });
const thread = openThread(cwd, "Linkage debug fixture");
const linked = linkDebugThread(cwd, experiment.experimentId, thread.threadId);
assert.deepEqual(linked.debugThreadIds, [thread.threadId]);
assert.deepEqual(showThread(cwd, thread.threadId).experimentIds, [experiment.experimentId]);

const gated = recordGate(cwd, experiment.experimentId, { gate: "E0", verdict: "pass", metrics: "fixture", debugThreadId: thread.threadId });
assert.deepEqual(gated.debugThreadIds, [thread.threadId]);
assert.throws(() => recordGate(cwd, experiment.experimentId, { gate: "E1", verdict: "maybe" }), /requires a verdict/);
assert.throws(() => recordGate(cwd, experiment.experimentId, { gate: "E1" }), /requires a verdict/);
assert.throws(() => recordGate(cwd, "exp-missing", { gate: "E1", verdict: "pass" }), /not found/);

const unregistered = openExperiment(cwd, "No bars fixture");
assert.throws(() => recordGate(cwd, unregistered.experimentId, { gate: "E0", verdict: "pass" }), /pre-registered bars/);
assert.throws(() => openExperiment(cwd, "Bad bars", { bars: ["ok", 7] }), /only strings/);
assert.throws(() => openExperiment(cwd, "Long bars", { bars: ["x".repeat(501)] }), /500 characters/);

assert.match(openExperimentsSummary(cwd), /debug: linkage-debug-fixture/);
for (let index = 0; index < 12; index++) {
  openThread(cwd, `Summary thread ${index}`);
  openExperiment(cwd, `Summary experiment ${index}`, { bars: ["bounded"] });
}
const threadSummary = openThreadsSummary(cwd);
assert.match(threadSummary, /\+3 more open threads/);
const experimentSummary = openExperimentsSummary(cwd);
assert.match(experimentSummary, /\+4 more: \/exp-list open/);

const legacy = { ...showExperiment(cwd, experiment.experimentId), schemaVersion: undefined, experimentId: "exp-legacy-linkage", title: "Legacy linkage", debugThreadIds: undefined };
fs.writeFileSync(path.join(cwd, ".pi", "experiment-ledger", `${legacy.experimentId}.json`), `${JSON.stringify(legacy, null, 2)}\n`);
assert.equal(migrateExperimentLedger(cwd, { apply: true }).migrated, 1);
assert.deepEqual(showExperiment(cwd, "exp-legacy-linkage").debugThreadIds, []);

const legacyV2 = { ...showExperiment(cwd, experiment.experimentId), schemaVersion: 2, experimentId: "exp-legacy-v2", title: "Legacy v2", debugThreadIds: undefined };
fs.writeFileSync(path.join(cwd, ".pi", "experiment-ledger", `${legacyV2.experimentId}.json`), `${JSON.stringify(legacyV2, null, 2)}\n`);
const v2Migration = migrateExperimentLedger(cwd, { apply: true });
assert.equal(v2Migration.migrated, 1);
const migratedV2 = showExperiment(cwd, "exp-legacy-v2");
assert.equal(migratedV2.schemaVersion, 3);
assert.deepEqual(migratedV2.bars, legacyV2.bars, "migration preserves pre-registered bars");
assert.deepEqual(migratedV2.debugThreadIds, []);
assert.equal(migratedV2.migration.fromSchemaVersion, 2);

console.log("ledger linkage and validation tests passed");
