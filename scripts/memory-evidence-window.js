#!/usr/bin/env node
"use strict";
/**
 * Read-only 14-day evidence window for the passive memory rollout gates.
 * Prints one row per UTC day with the count of qualifying records for
 * S1/R/SD/C/A, then the counts and distinct-day shortfalls per criterion.
 * `--json` emits the same result as machine-readable JSON.
 * It writes nothing, reads no config, and never seeds or backdates rows.
 */
const fs = require("node:fs");
const path = require("node:path");
const { collectRolloutSources, DAY, WINDOW_DAYS } = require("../src/memory-rollout-telemetry");

function computeEvidenceWindow({ decisions = [], traces = [], diagnostics = [], now = Date.now() } = {}) {
  const inWindow = (at) => { const t = Date.parse(at); return Number.isFinite(t) && t <= now && t >= now - WINDOW_DAYS * DAY; };
  const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
  const days = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push(new Date(now - i * DAY).toISOString().slice(0, 10));
  const gridDays = new Set(days);
  const inGrid = (at) => gridDays.has(dayOf(at));
  const criteria = [
    { key: "S1", need: 20, daysNeed: 7, rows: decisions.filter((row) => row.action === "saved" && row.automatic !== true && inWindow(row.at) && inGrid(row.at)), at: (row) => row.at },
    { key: "R", need: 30, daysNeed: 14, rows: traces.filter((event) => event.category === "memory_retrieval" && event.name === "recall.completed" && inWindow(event.timestamp) && inGrid(event.timestamp)), at: (event) => event.timestamp },
    { key: "SD", need: 20, daysNeed: 7, rows: traces.filter((event) => event.category === "memory_decision" && event.name === "shadow.outcome" && inWindow(event.timestamp) && inGrid(event.timestamp)), at: (event) => event.timestamp },
    { key: "C", need: 14, daysNeed: 14, rows: diagnostics.filter((row) => row.kind === "settle" && inWindow(row.at) && inGrid(row.at)), at: (row) => row.at },
    { key: "A", need: 30, daysNeed: 14, rows: decisions.filter((row) => row.action === "saved" && row.automatic === true && row.applied !== false && inWindow(row.at) && inGrid(row.at)), at: (row) => row.at },
  ];
  for (const criterion of criteria) {
    criterion.perDay = new Map(days.map((day) => [day, 0]));
    for (const row of criterion.rows) {
      const day = dayOf(criterion.at(row));
      if (criterion.perDay.has(day)) criterion.perDay.set(day, criterion.perDay.get(day) + 1);
    }
    criterion.observedDays = days.filter((day) => criterion.perDay.get(day) > 0).length;
    criterion.daysRemaining = Math.max(0, criterion.daysNeed - criterion.observedDays);
  }
  return {
    windowDays: WINDOW_DAYS,
    start: days[0],
    end: days[days.length - 1],
    generatedAt: new Date(now).toISOString(),
    days,
    criteria: criteria.map((criterion) => ({
      key: criterion.key,
      need: criterion.need,
      daysNeed: criterion.daysNeed,
      count: criterion.rows.length,
      observedDays: criterion.observedDays,
      daysRemaining: criterion.daysRemaining,
      earliest: new Date(now + criterion.daysRemaining * DAY).toISOString().slice(0, 10),
      perDay: Object.fromEntries(criterion.perDay),
    })),
  };
}

function renderText(result) {
  console.log(`14-day evidence window (UTC): ${result.start} → ${result.end}`);
  console.log("");
  console.log(`day         ${result.criteria.map((c) => c.key.padStart(3)).join(" ")}`);
  for (const day of result.days) {
    const cells = result.criteria.map((c) => String(c.perDay[day]).padStart(3)).join(" ");
    console.log(`${day}  ${cells}`);
  }
  console.log("");
  console.log("criterion  count/need  days/need  days remaining  earliest floor");
  for (const c of result.criteria) {
    console.log(`${c.key.padEnd(10)} ${String(c.count).padStart(4)}/${String(c.need).padEnd(4)} ${String(c.observedDays).padStart(4)}/${String(c.daysNeed).padEnd(4)} ${String(c.daysRemaining).padStart(10)}      ${c.daysRemaining === 0 ? "met" : c.earliest}`);
  }
  console.log("");
  console.log("days remaining assumes one qualifying day per calendar day; evidence older than the window drops out, so a skipped day moves the floor forward.");
  console.log("rows cover 14 UTC calendar days; the evaluator uses a rolling 14x24h window, so an event in the oldest partial day is counted by the gate but not shown here.");
}

function incompleteCriteria(result) {
  return result.criteria.filter((criterion) => criterion.count < criterion.need || criterion.observedDays < criterion.daysNeed).map((criterion) => criterion.key);
}

function main(argv) {
  const json = argv.includes("--json");
  const strict = argv.includes("--strict");
  const cwdArg = argv.find((arg) => !arg.startsWith("--"));
  const cwd = path.resolve(cwdArg || process.cwd());
  if (!fs.existsSync(path.join(cwd, ".pi"))) {
    console.error(`No .pi evidence directory under ${cwd}; run this from the project that hosts the memory rollout.`);
    return 1;
  }
  const sources = collectRolloutSources({ cwd, nowMs: Date.now(), privacy: null, baseline: null });
  const result = computeEvidenceWindow({ decisions: sources.decisions, traces: sources.traces, diagnostics: sources.diagnostics });
  if (json) console.log(JSON.stringify(result, null, 2));
  else renderText(result);
  const incomplete = incompleteCriteria(result);
  if (strict && incomplete.length) console.error(`strict: incomplete criteria: ${incomplete.join(", ")}`);
  return strict && incomplete.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { computeEvidenceWindow, incompleteCriteria, renderText };
