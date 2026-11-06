"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openExperiment, recordGate, migrateExperimentLedger, showExperiment, EXPERIMENT_SCHEMA_VERSION } = require("../src/experiment-ledger");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-migration-shapes-");
try {
  const opened = openExperiment(cwd, "z-valid-history", { bars: ["Preserve historical evidence"] });
  const valid = recordGate(cwd, opened.experimentId, { gate: "E0", verdict: "pass", metrics: "fixture only" });
  const legacy = { ...valid, schemaVersion: 1 };
  const dir = path.join(cwd, ".pi", "experiment-ledger"), goodFile = path.join(dir, `${legacy.experimentId}.json`);
  const original = JSON.stringify(legacy);
  fs.writeFileSync(goodFile, original);
  const badRecords = [null, [], false, 17, "legacy", ...[null, [], false, 17, "gate"].map(gate => ({ ...legacy, gates: [gate] }))];
  const malformed = badRecords.map((value, index) => {
    const experimentId = `exp-a-malformed-${index}`;
    const record = value && !Array.isArray(value) && typeof value === "object" ? { ...value, experimentId } : value;
    const file = path.join(dir, `${experimentId}.json`), text = JSON.stringify(record);
    fs.writeFileSync(file, text);
    return { file, text, experimentId };
  });
  function assertBlocked(result) {
    assert.equal(result.blocked, malformed.length);
    for (const { file, text, experimentId } of malformed) {
      assert.deepEqual(result.records.find(row => row.experimentId === experimentId), { experimentId, outcome: "blocked", reason: "unrecognized-legacy-contract" });
      assert.equal(fs.readFileSync(file, "utf8"), text, "malformed input bytes must be preserved");
    }
  }
  const preview = migrateExperimentLedger(cwd);
  assertBlocked(preview);
  assert.equal(preview.records.at(-1).outcome, "eligible", "malformed entries must not prevent scanning later valid records");
  assert.equal(preview.migrated, 0);
  assert.equal(fs.readFileSync(goodFile, "utf8"), original);
  assert(!fs.existsSync(path.join(dir, "migration-originals")), "preview must not write archives");

  const applied = migrateExperimentLedger(cwd, { apply: true });
  assertBlocked(applied);
  assert.equal(applied.migrated, 1);
  const migrated = showExperiment(cwd, legacy.experimentId);
  assert.equal(migrated.schemaVersion, EXPERIMENT_SCHEMA_VERSION);
  for (const key of ["createdAt", "updatedAt", "status", "gates"]) assert.deepEqual(migrated[key], legacy[key]);
  const backups = fs.readdirSync(path.join(dir, "migration-originals"));
  assert.equal(backups.length, 1, "only valid migrated records are archived");
  assert.equal(fs.readFileSync(path.join(dir, "migration-originals", backups[0]), "utf8"), original);
  const repeated = migrateExperimentLedger(cwd, { apply: true });
  assertBlocked(repeated);
  assert.equal(repeated.migrated, 0, "blocked entries remain blocked without remigrating valid history");
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
console.log("experiment ledger migration shape tests passed");
