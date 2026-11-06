"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  openExperiment,
  recordGate,
  closeExperiment,
  listExperiments,
  showExperiment,
  formatExperiment,
  openExperimentsSummary,
  listExperimentSummaries,
  EXPERIMENT_SCHEMA_VERSION,
  experimentLedgerCoverage,
  migrateExperimentLedger,
} = require("../src/experiment-ledger.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-experiment-ledger-");

const opened = openExperiment(tmp, "WhiSC coupling E-ladder", {
  hypothesis: "whitened symplectic coupling survives the E3 gate SORC failed",
  bars: "val@2500 <= 2.72; 0 grad-skips",
  arms: ["--whisc-coupling --rot-theta-max 0.07", "baseline"],
});
assert.equal(opened.experimentId, "exp-whisc-coupling-e-ladder");
assert.equal(opened.schemaVersion, EXPERIMENT_SCHEMA_VERSION);
assert.equal(opened.bars.length, 2);
const ledgerDir = path.join(tmp, ".pi", "experiment-ledger");
const ledgerFile = path.join(ledgerDir, `${opened.experimentId}.json`);
assert.equal(fs.statSync(ledgerDir).mode & 0o777, 0o700);
assert.equal(fs.statSync(ledgerFile).mode & 0o777, 0o600);
assert.equal(opened.arms.length, 2);
assert.equal(opened.status, "open");

const duplicate = openExperiment(tmp, "WhiSC coupling E-ladder!");
assert.equal(duplicate.duplicate, true, "re-opening the same title returns the existing thread");

const gated = recordGate(tmp, opened.experimentId, { gate: "E0", verdict: "pass", metrics: "bit-parity clean", gpuHours: 0.2, commit: "abc1234" });
recordGate(tmp, opened.experimentId, { gate: "E3", verdict: "pass", metrics: "val@2500 2.7104 vs bar 2.72; 0 skips", gpuHours: 3.4, runId: "run-whisc-e3-ab12" });
assert.equal(gated.gates[0].gate, "E0");
assert.throws(() => recordGate(tmp, opened.experimentId, { verdict: "pass" }), /requires a gate label/);
assert.throws(() => recordGate(tmp, "exp-missing", { gate: "E0" }), /not found/);

const shown = showExperiment(tmp, opened.experimentId);
assert.equal(shown.gates.length, 2);
assert.equal(shown.runIds[0], "run-whisc-e3-ab12");
assert.equal(shown.commits[0], "abc1234");
const formatted = formatExperiment(shown);
assert(formatted.includes("pre-registered bars: val@2500 <= 2.72; 0 grad-skips"));
assert(formatted.includes("E3 PASS"));
assert(formatted.includes("GPU-hours so far: 3.6"));

const summary = openExperimentsSummary(tmp);
assert(summary.includes("exp-whisc-coupling-e-ladder"));
assert(summary.includes("last: E3 PASS"));
assert.match(summary, /activate_tools or use \/exp-gate/, "the injectable summary names the activation path when the tool is not declared");
const summaries = listExperimentSummaries(tmp, { status: "open" });
assert.equal(summaries.length, 1);
assert.equal(summaries[0].gateCount, 2);
assert.equal(summaries[0].lastGate.verdict, "pass");
assert.equal(Object.hasOwn(summaries[0], "title"), false);
assert.equal(Object.hasOwn(summaries[0], "hypothesis"), false);
assert.equal(Object.hasOwn(summaries[0], "bars"), false);

const secret = "S".repeat(28);
recordGate(tmp, opened.experimentId, { gate: "privacy", verdict: "partial", note: `api_key=${secret}` });
assert(!fs.readFileSync(ledgerFile, "utf8").includes(secret), "durable experiment text is sanitized");

assert.throws(() => closeExperiment(tmp, opened.experimentId, { decision: "maybe" }), /requires a decision/);
const closed = closeExperiment(tmp, opened.experimentId, { decision: "ship", note: "promoted to flagship, runner.sh auto-injects flags" });
assert.equal(closed.status, "closed");
assert.equal(closed.decision, "ship");
assert.equal(openExperimentsSummary(tmp), "", "closed experiments stop injecting");
assert.equal(listExperiments(tmp, { status: "closed" }).length, 1);
assert(formatExperiment(closed).includes("resolution: promoted to flagship"));
fs.writeFileSync(path.join(ledgerDir, "exp-legacy.json"), JSON.stringify({ schemaVersion: 1, experimentId: "exp-legacy", status: "open" }), { mode: 0o600 });
assert.equal(listExperiments(tmp).some((item) => item.experimentId === "exp-legacy"), false, "obsolete ledger schemas are rejected rather than migrated");

assert.equal(experimentLedgerCoverage(tmp).legacy, 1);
assert.match(openExperimentsSummary(tmp), /1 excluded records/);
assert.equal(migrateExperimentLedger(tmp).blocked, 1, "incomplete legacy contracts cannot be guessed");
fs.rmSync(path.join(ledgerDir, "exp-legacy.json"));
const legacy = { ...shown, title: "Preserved history", schemaVersion: undefined, experimentId: "exp-preserved-history" };
const legacyFile = path.join(ledgerDir, `${legacy.experimentId}.json`);
const original = JSON.stringify(legacy);
fs.writeFileSync(legacyFile, original);
const preview = migrateExperimentLedger(tmp);
assert.equal(preview.records[0].outcome, "eligible");
assert.equal(fs.readFileSync(legacyFile, "utf8"), original, "preview is read-only");
assert.equal(migrateExperimentLedger(tmp, { apply: true }).migrated, 1);
const migrated = showExperiment(tmp, legacy.experimentId);
assert.deepEqual(migrated.gates, legacy.gates);
assert.equal(migrated.createdAt, legacy.createdAt);
assert.equal(migrated.updatedAt, legacy.updatedAt);
assert.equal(migrated.migration.evidenceRequalified, false);
assert.equal(migrated.status, "open");
assert.equal(experimentLedgerCoverage(tmp).legacy, 0);
assert.equal(migrateExperimentLedger(tmp, { apply: true }).migrated, 0, "migration is idempotent");
assert.equal(fs.readdirSync(path.join(ledgerDir, "migration-originals")).length, 1);
assert.throws(() => openExperiment(tmp, "WhiSC coupling E-ladder"), /already exists/, "closed history is never overwritten");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("experiment-ledger tests passed");
