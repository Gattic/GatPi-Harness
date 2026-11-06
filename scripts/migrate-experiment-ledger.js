#!/usr/bin/env node
"use strict";
const { migrateExperimentLedger } = require("../src/experiment-ledger");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) throw new Error("usage: node scripts/migrate-experiment-ledger.js [--apply]");
const result = migrateExperimentLedger(process.cwd(), { apply: args.includes("--apply") });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.blocked) process.exitCode = 1;
