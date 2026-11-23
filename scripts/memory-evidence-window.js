#!/usr/bin/env node
"use strict";
/**
 * Read-only 14-day evidence window for the passive memory rollout gates.
 * Prints one row per UTC day with the count of qualifying records for
 * S1/R/SD/C/A, then the counts and distinct-day shortfalls per criterion.
 * It writes nothing, reads no config, and never seeds or backdates rows.
 */
const fs = require("node:fs");
const path = require("node:path");
const { collectRolloutSources, DAY, WINDOW_DAYS } = require("../src/memory-rollout-telemetry");

const cwd = path.resolve(process.argv[2] || process.cwd());
if (!fs.existsSync(path.join(cwd, ".pi"))) {
  console.error(`No .pi evidence directory under ${cwd}; run this from the project that hosts the memory rollout.`);
  process.exit(1);
}

const now = Date.now();
const inWindow = (at) => { const t = Date.parse(at); return Number.isFinite(t) && t <= now && t >= now - WINDOW_DAYS * DAY; };
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const sources = collectRolloutSources({ cwd, nowMs: now, privacy: null, baseline: null });
const decisions = sources.decisions || [];
const traces = sources.traces || [];
const diagnostics = sources.diagnostics || [];

const criteria = [
  { key: "S1", need: 20, daysNeed: 7, rows: decisions.filter((row) => row.action === "saved" && row.automatic !== true && inWindow(row.at)), at: (row) => row.at },
  { key: "R", need: 30, daysNeed: 14, rows: traces.filter((event) => event.category === "memory_retrieval" && event.name === "recall.completed" && inWindow(event.timestamp)), at: (event) => event.timestamp },
  { key: "SD", need: 20, daysNeed: 7, rows: traces.filter((event) => event.category === "memory_decision" && event.name === "shadow.outcome" && inWindow(event.timestamp)), at: (event) => event.timestamp },
  { key: "C", need: 14, daysNeed: 14, rows: diagnostics.filter((row) => row.kind === "settle" && inWindow(row.at)), at: (row) => row.at },
  { key: "A", need: 30, daysNeed: 14, rows: decisions.filter((row) => row.action === "saved" && row.automatic === true && row.applied !== false && inWindow(row.at)), at: (row) => row.at },
];

const days = [];
for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push(new Date(now - i * DAY).toISOString().slice(0, 10));
for (const criterion of criteria) {
  criterion.perDay = new Map(days.map((day) => [day, 0]));
  for (const row of criterion.rows) {
    const day = dayOf(criterion.at(row));
    if (criterion.perDay.has(day)) criterion.perDay.set(day, criterion.perDay.get(day) + 1);
  }
  criterion.observedDays = days.filter((day) => criterion.perDay.get(day) > 0).length;
  criterion.daysRemaining = Math.max(0, criterion.daysNeed - criterion.observedDays);
}

console.log(`14-day evidence window (UTC): ${days[0]} → ${days.at(-1)}`);
console.log("");
console.log(`day         ${criteria.map((c) => c.key.padStart(3)).join(" ")}`);
for (const day of days) {
  const cells = criteria.map((c) => String(c.perDay.get(day)).padStart(3)).join(" ");
  console.log(`${day}  ${cells}`);
}
console.log("");
console.log("criterion  count/need  days/need  days remaining  earliest floor");
for (const c of criteria) {
  const earliest = new Date(now + c.daysRemaining * DAY).toISOString().slice(0, 10);
  console.log(`${c.key.padEnd(10)} ${String(c.rows.length).padStart(4)}/${String(c.need).padEnd(4)} ${String(c.observedDays).padStart(4)}/${String(c.daysNeed).padEnd(4)} ${String(c.daysRemaining).padStart(10)}      ${c.daysRemaining === 0 ? "met" : earliest}`);
}
console.log("");
console.log("days remaining assumes one qualifying day per calendar day; evidence older than the window drops out, so a skipped day moves the floor forward.");
