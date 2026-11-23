#!/usr/bin/env node
"use strict";
/**
 * Read-only summary of .pi/project-memory/diagnostics.jsonl and the R/C/S1/A
 * rollout counters. diagnostics.jsonl supplies C (settle previews) and the
 * diagnostic row composition; it carries no recall or save events, so R is
 * read from traces and S1/A from decisions.jsonl. Prints each gate's
 * count/need, days/need, days remaining and earliest floor, plus the C
 * stability/accounting/safety details. It writes nothing and never seeds or
 * backdates evidence. `--json` emits the same result for logging.
 */
const path = require("node:path");
const { buildStatus } = require("./memory-evidence-status.js");
const { computeEvidenceWindow } = require("./memory-evidence-window.js");
const { DAY, WINDOW_DAYS } = require("../src/memory-rollout-telemetry");

const GATES = ["S1", "R", "C", "A"];
const inWindow = (at, now) => { const t = Date.parse(at); return Number.isFinite(t) && t <= now && t >= now - WINDOW_DAYS * DAY; };
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

function buildSummary({ cwd = process.cwd(), now = Date.now() } = {}) {
  const status = buildStatus({ cwd, now });
  const window = computeEvidenceWindow({ decisions: status.sources.decisions, traces: status.sources.traces, diagnostics: status.sources.diagnostics, now });
  const diagnostics = status.sources.diagnostics || [];
  const kinds = {};
  for (const row of diagnostics) kinds[row.kind || "unknown"] = (kinds[row.kind || "unknown"] || 0) + 1;
  const settles = diagnostics.filter((row) => row.kind === "settle");
  const settleInWindow = settles.filter((row) => inWindow(row.at, now));
  const gates = GATES.map((name) => {
    const source = status.gates.find((gate) => gate.name === name);
    const row = window.criteria.find((criterion) => criterion.key === name);
    return {
      name,
      status: status.evaluation.predicates[name]?.status ?? "n/a",
      count: source?.count ?? 0,
      need: source?.need ?? 0,
      days: row?.observedDays ?? source?.days ?? 0,
      daysNeed: row?.daysNeed ?? source?.daysNeed ?? 0,
      daysRemaining: row?.daysRemaining ?? Math.max(0, (source?.daysNeed ?? 0) - (source?.days ?? 0)),
      earliest: row?.earliest ?? null,
      extra: source?.extra ?? "",
    };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    window: { days: window.windowDays, start: window.start, end: window.end },
    diagnostics: {
      path: path.join(status.cwd, ".pi", "project-memory", "diagnostics.jsonl"),
      rows: diagnostics.length,
      kinds,
      settle: settles.length,
      settleInWindow: settleInWindow.length,
      settleDaysInWindow: new Set(settleInWindow.map((row) => dayOf(row.at))).size,
    },
    gates,
  };
}

function renderSummary(result) {
  console.log("Memory diagnostics summary (read-only)");
  console.log(`diagnostics: ${result.diagnostics.path} (${result.diagnostics.rows} rows)`);
  const composition = Object.entries(result.diagnostics.kinds).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind} ${count}`).join(" · ");
  console.log(`composition: ${composition || "none"}`);
  console.log(`window ${result.window.days}d (${result.window.start} → ${result.window.end}) · settle rows in window ${result.diagnostics.settleInWindow} (${result.diagnostics.settleDaysInWindow} days)`);
  console.log("source: C from diagnostics.jsonl; R from traces; S1/A from decisions.jsonl (diagnostics has no recall/save rows)");
  console.log("");
  console.log("gate  status        count/need   days/need   days-left  earliest  details");
  for (const gate of result.gates) {
    const count = gate.need ? `${gate.count}/${gate.need}` : "—";
    const days = gate.daysNeed ? `${gate.days}/${gate.daysNeed}` : "—";
    const left = gate.daysRemaining == null ? "—" : String(gate.daysRemaining);
    console.log(`${gate.name.padEnd(4)} ${gate.status.padEnd(12)} ${count.padEnd(11)} ${days.padEnd(10)} ${left.padStart(9)}  ${gate.earliest ?? "—"}  ${gate.extra}`);
  }
}

function main(argv) {
  const json = argv.includes("--json");
  const cwdArg = argv.find((arg) => !arg.startsWith("--"));
  const cwd = path.resolve(cwdArg || process.cwd());
  let result;
  try { result = buildSummary({ cwd }); }
  catch (error) { console.error(error.message); return 1; }
  if (json) console.log(JSON.stringify(result, null, 2));
  else renderSummary(result);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { buildSummary, renderSummary };
