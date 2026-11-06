#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { mineAgentSessions, formatSessionMiningReport, sessionMiningOutcomes } = require("../src/session-miner");
const { LearningStore } = require("../src/learning-loop");

function parse(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === "--full" || arg === "--force") out.force = true;
    else if (arg === "--record-outcomes") out.recordOutcomes = true;
    else if (arg === "--json") out.json = true;
    else if (arg.startsWith("--cwd=")) out.cwd = arg.slice(6);
    else if (arg.startsWith("--since-days=")) out.sinceDays = Number(arg.slice(13));
    else if (arg.startsWith("--max-bytes=")) out.maxBytes = Number(arg.slice(12));
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: node scripts/mine-agent-sessions.js [options]",
    "",
    "Privacy-safe incremental aggregate mining of:",
    "  ~/.claude/projects  ~/.codex/sessions  ~/.pi/agent/sessions",
    "",
    "Options:",
    "  --since-days=N       Rolling mtime window (default 30)",
    "  --max-bytes=N        Newest-file scan budget (default 1 GiB)",
    "  --full               Ignore the incremental cache",
    "  --record-outcomes    Add candidate outcomes to .pi/learning-loop",
    "  --cwd=PATH           Target harness repo/state root",
    "  --json               Print the redacted aggregate report as JSON",
  ].join("\n");
}

try {
  const args = parse(process.argv.slice(2));
  if (args.help) { console.log(usage()); process.exit(0); }
  const cwd = path.resolve(args.cwd || process.cwd());
  const report = mineAgentSessions({ cwd, sinceDays: args.sinceDays, maxBytes: args.maxBytes, force: args.force });
  let recorded = [];
  if (args.recordOutcomes) {
    const store = new LearningStore({ cwd });
    recorded = sessionMiningOutcomes(report).map((outcome) => store.recordOutcome(outcome));
  }
  if (args.json) console.log(JSON.stringify({ report, recordedOutcomeIds: recorded.map((row) => row.outcomeId) }, null, 2));
  else {
    console.log(formatSessionMiningReport(report));
    if (args.recordOutcomes) console.log(`\nlearning outcomes: ${recorded.length} (${recorded.filter((row) => row.duplicate).length} duplicate)`);
  }
} catch (error) {
  console.error(`session mining failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
