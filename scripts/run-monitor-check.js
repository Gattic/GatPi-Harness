#!/usr/bin/env node
"use strict";

// Deterministic run-monitor checks for the Pi harness.
//
// This script inspects existing run-monitor records and their bg_run/run_deck
// targets. It never starts a Pi turn, sends a user message, or calls a model.
// The run-monitor extension invokes it on terminal edges so settlement checks
// are script-backed instead of model wake-ups. It is also safe to run directly
// from cron or a shell loop with --watch.

const path = require("node:path");
const {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  listMonitors,
  requireMonitor,
  readMonitor,
  checkMonitor,
  probeMonitor,
  recordMonitorProbe,
} = require(path.join(__dirname, "..", "src", "run-monitor.js"));

const USAGE = `Usage: node scripts/run-monitor-check.js [options]

Options:
  --cwd <path>          Repository directory (default: current directory)
  --monitor <id>        Check one monitor, including terminal probes
  --session <id>        Check active monitors owned by one Pi session
  --all                 Check every active monitor in the repository (default)
  --json                Emit structured JSON instead of one text line per monitor
                         (with --watch, emits one JSON document per line)
  --watch               Repeat checks until every selected monitor is terminal
  --interval-ms <n>     Watch interval (default ${DEFAULT_INTERVAL_MS}, clamped ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS})
  --timeout-ms <n>      Watch deadline (default ${DEFAULT_TIMEOUT_MS}, clamped ${MIN_INTERVAL_MS}..${MAX_TIMEOUT_MS})
  --help                Show this help

Exit codes: 0 checks completed, 2 usage/validation/check error, 3 watch deadline.`;

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    monitorId: null,
    sessionId: null,
    all: false,
    json: false,
    watch: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--cwd") options.cwd = value();
    else if (flag === "--monitor") options.monitorId = value();
    else if (flag === "--session") options.sessionId = value();
    else if (flag === "--all") options.all = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--watch") options.watch = true;
    else if (flag === "--interval-ms") options.intervalMs = value();
    else if (flag === "--timeout-ms") options.timeoutMs = value();
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  options.cwd = path.resolve(options.cwd);
  if (options.all && options.monitorId) throw new Error("--all cannot be combined with --monitor");
  if (options.all && options.sessionId) throw new Error("--all cannot be combined with --session");
  options.intervalMs = boundedNumber(options.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  options.timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_INTERVAL_MS, MAX_TIMEOUT_MS);
  return options;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function selectMonitors(cwd, options) {
  if (options.monitorId) {
    return [requireMonitor(cwd, options.monitorId, { ownerSessionId: options.sessionId })];
  }
  return listMonitors(cwd, { ownerSessionId: options.all ? null : options.sessionId, status: "active" });
}

function checkOne(cwd, monitor, options) {
  const ownerSessionId = monitor.ownerSessionId;
  if (monitor.status === "active") checkMonitor(cwd, monitor.monitorId, { ownerSessionId, now: options.now });
  const result = probeMonitor(cwd, monitor.monitorId, { ownerSessionId, now: options.now });
  if (result.status !== "active") {
    recordMonitorProbe(cwd, monitor.monitorId, result.probe, { ownerSessionId, now: options.now });
    result.scriptCheck = readMonitor(cwd, monitor.monitorId)?.scriptCheck || null;
  }
  return result;
}

function formatResult(result) {
  const parts = [
    `${result.monitorId} [${result.status}] ${result.kind}:${result.targetId}`,
    `checks=${result.checks}`,
  ];
  if (result.reason) parts.push(`reason=${result.reason}`);
  const exit = result.probe.exitCode == null ? "" : ` (exit ${result.probe.exitCode})`;
  parts.push(`target=${result.probe.targetStatus}${exit}`);
  if (result.scriptCheck) {
    const checkedExit = result.scriptCheck.exitCode == null ? "" : ` (exit ${result.scriptCheck.exitCode})`;
    parts.push(`script-check=${result.scriptCheck.targetStatus}${checkedExit}`);
  }
  return parts.join(" ");
}

function output(results, options) {
  if (options.json) {
    const payload = options.monitorId && results.length === 1 ? results[0] : results;
    console.log(options.watch ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
    return;
  }
  if (!results.length) {
    console.log("No active run monitors");
    return;
  }
  for (const result of results) console.log(formatResult(result));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const monitors = selectMonitors(options.cwd, options);
    const results = monitors.map((monitor) => checkOne(options.cwd, monitor, options));
    output(results, options);
    if (!options.watch) return 0;
    if (!results.some((result) => result.status === "active")) return 0;
    if (Date.now() >= deadline) {
      console.error("run monitor check deadline reached");
      return 3;
    }
    await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 2;
  });
