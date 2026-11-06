#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { buildHermesIntegrationScorecard, writeHermesIntegrationScorecard } = require("../src/hermes-integration-scorecard.js");
const args = new Set(process.argv.slice(2));
const cwdArg = process.argv.slice(2).find((arg) => arg.startsWith("--cwd="));
const cwd = path.resolve(cwdArg ? cwdArg.slice("--cwd=".length) : process.cwd());
if (args.has("--write") && !args.has("--yes")) {
  console.error("Refusing to persist scorecard without --write --yes");
  process.exit(2);
}
const result = args.has("--write") ? writeHermesIntegrationScorecard({ cwd }) : { output: null, card: buildHermesIntegrationScorecard({ cwd }) };
console.log(JSON.stringify({ output: result.output, ...result.card }, null, 2));
process.exitCode = result.card.decision === "NO-GO-DEFERRED" && args.has("--require-pass") ? 1 : 0;
