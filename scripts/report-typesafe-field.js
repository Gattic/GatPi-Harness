#!/usr/bin/env node
"use strict";

// Summarize the metadata-only TypeSafe field records that every project's Pi
// sessions write to the shared turnRecordDir() (~/.pi/agent/typesafe/), and
// judge the field bars. With --record <field-shadow|field-on>, record the
// verdict on the open pre-registered experiments in this repository's ledger.

const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { fieldReport, recordFieldGate, turnRecordDir } = require("../src/typesafe-evaluation");

const gate = process.argv.includes("--record") ? process.argv[process.argv.indexOf("--record") + 1] : null;
const report = fieldReport(new FileIntegrationStorage(turnRecordDir()).readJsonl("turns"));
console.log(JSON.stringify(report, null, 2));

if (gate) {
  try {
    const recorded = recordFieldGate(path.join(__dirname, ".."), report, gate);
    console.log(`recorded ${gate}: ${recorded.verdict} on ${recorded.experiments.join(", ")}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
