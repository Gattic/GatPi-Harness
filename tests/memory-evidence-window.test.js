#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { computeEvidenceWindow } = require("../scripts/memory-evidence-window.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const NOW = Date.parse("2026-11-23T12:00:00Z");
const at = (day, hour = 12) => `${day}T${String(hour).padStart(2, "0")}:00:00Z`;
const settle = (day, hour = 12) => ({ kind: "settle", at: at(day, hour) });
const recall = (day, hour = 12) => ({ category: "memory_retrieval", name: "recall.completed", timestamp: at(day, hour) });
const shadow = (day, hour = 12) => ({ category: "memory_decision", name: "shadow.outcome", timestamp: at(day, hour), payload: { agreed: true, applied: false, proposalHash: "sha256:abc" } });
const save = (day, hour = 12, extra = {}) => ({ action: "saved", automatic: false, verification: "verified", at: at(day, hour), ...extra });

test("window covers exactly 14 UTC days ending today", () => {
  const result = computeEvidenceWindow({ now: NOW });
  assert.equal(result.windowDays, 14);
  assert.equal(result.days.length, 14);
  assert.equal(result.start, "2026-11-10");
  assert.equal(result.end, "2026-11-23");
  assert.deepEqual(result.days.slice(0, 2), ["2026-11-10", "2026-11-11"]);
  assert.deepEqual(result.days.slice(-2), ["2026-11-22", "2026-11-23"]);
});

test("C is days-bound when previews cover 8 of 14 days", () => {
  const diagnostics = [];
  for (const day of ["2026-11-14", "2026-11-15", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]) {
    diagnostics.push(settle(day), settle(day, 13), settle(day, 14));
  }
  const result = computeEvidenceWindow({ now: NOW, diagnostics });
  const c = result.criteria.find((row) => row.key === "C");
  assert.equal(c.count, 24);
  assert.equal(c.need, 14);
  assert.equal(c.observedDays, 8);
  assert.equal(c.daysNeed, 14);
  assert.equal(c.daysRemaining, 6);
  assert.equal(c.earliest, "2026-11-29");
  assert.equal(c.perDay["2026-11-14"], 3);
  assert.equal(c.perDay["2026-11-16"], 0);
});

test("R counts completions and distinct days", () => {
  const traces = [recall("2026-11-22", 10), recall("2026-11-22", 11), recall("2026-11-22", 12), recall("2026-11-23", 9), recall("2026-11-23", 10)];
  const result = computeEvidenceWindow({ now: NOW, traces });
  const r = result.criteria.find((row) => row.key === "R");
  assert.equal(r.count, 5);
  assert.equal(r.observedDays, 2);
  assert.equal(r.daysRemaining, 12);
  assert.equal(r.earliest, "2026-12-05");
});

test("S1, SD and A clear their day floors once their counts are met", () => {
  const decisions = [];
  const traces = [];
  for (const day of ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]) {
    decisions.push(save(day, 9), save(day, 10), save(day, 11));
    traces.push(shadow(day, 9), shadow(day, 10), shadow(day, 11));
  }
  for (const day of computeEvidenceWindow({ now: NOW }).days) decisions.push(save(day, 9, { automatic: true }));
  const result = computeEvidenceWindow({ now: NOW, decisions, traces });
  for (const key of ["S1", "SD", "A"]) {
    const row = result.criteria.find((criterion) => criterion.key === key);
    assert.equal(row.daysRemaining, 0, `${key} day floor`);
    assert.equal(row.earliest, "2026-11-23");
  }
  assert.equal(result.criteria.find((row) => row.key === "S1").count, 21);
  assert.equal(result.criteria.find((row) => row.key === "SD").count, 21);
  assert.equal(result.criteria.find((row) => row.key === "A").count, 14);
});

test("events on days outside the 14-day grid are excluded", () => {
  const traces = [
    recall("2026-11-09", 12), // oldest partial day of the rolling window: not shown
    recall("2026-11-10", 0), // first grid day
    recall("2026-11-23", 12), // today, at now
  ];
  const result = computeEvidenceWindow({ now: NOW, traces });
  const r = result.criteria.find((row) => row.key === "R");
  assert.equal(r.count, 2);
  assert.equal(r.perDay["2026-11-09"], undefined);
  assert.equal(r.perDay["2026-11-10"], 1);
  assert.equal(r.perDay["2026-11-23"], 1);
});

test("future-dated events are excluded", () => {
  const result = computeEvidenceWindow({ now: NOW, traces: [recall("2026-11-23", 13)] });
  assert.equal(result.criteria.find((row) => row.key === "R").count, 0);
});

test("day bucketing is UTC, not local time", () => {
  const result = computeEvidenceWindow({ now: NOW, traces: [recall("2026-11-22", 23), recall("2026-11-23", 0)] });
  const r = result.criteria.find((row) => row.key === "R");
  assert.equal(r.perDay["2026-11-22"], 1);
  assert.equal(r.perDay["2026-11-23"], 1);
});

test("--json prints the window result as JSON", () => {
  const dir = tmpFixture("pi-memory-window-json-");
  fs.mkdirSync(path.join(dir, ".pi", "traces"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "project-memory"), { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(dir, ".pi", "traces", "project--session.jsonl"), `${JSON.stringify({ category: "memory_retrieval", name: "recall.completed", timestamp: nowIso, payload: { durationMs: 1 } })}\n`);
  fs.writeFileSync(path.join(dir, ".pi", "project-memory", "decisions.jsonl"), `${JSON.stringify({ action: "saved", automatic: false, verification: "verified", at: nowIso })}\n`);
  const output = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "memory-evidence-window.js"), "--json", dir], { encoding: "utf8" });
  const parsed = JSON.parse(output);
  assert.equal(parsed.windowDays, 14);
  assert.equal(parsed.days.length, 14);
  assert.equal(parsed.criteria.length, 5);
  const r = parsed.criteria.find((row) => row.key === "R");
  assert.equal(r.count, 1);
  assert.equal(r.observedDays, 1);
  assert.equal(r.daysRemaining, 13);
  assert.equal(parsed.criteria.find((row) => row.key === "S1").count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
