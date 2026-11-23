#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { computeEvidenceWindow, incompleteCriteria } = require("../scripts/memory-evidence-window.js");
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

const DAY_MS = 864e5;
const isoDaysAgo = (days, minute = 0) => new Date(Date.now() - days * DAY_MS - minute * 60000).toISOString();
function writeStrictFixture({ saves = [], autos = [], settles = [], recalls = [], shadows = [] }) {
  const dir = tmpFixture("pi-memory-window-strict-");
  fs.mkdirSync(path.join(dir, ".pi", "traces"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "project-memory"), { recursive: true });
  const write = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (saves.length || autos.length) write(path.join(dir, ".pi", "project-memory", "decisions.jsonl"), [...saves, ...autos]);
  if (settles.length) write(path.join(dir, ".pi", "project-memory", "diagnostics.jsonl"), settles);
  if (recalls.length || shadows.length) write(path.join(dir, ".pi", "traces", "project--session.jsonl"), [...recalls, ...shadows]);
  return dir;
}
function completeFixture() {
  const saves = []; const autos = []; const settles = []; const recalls = []; const shadows = [];
  for (let day = 0; day < 7; day++) for (let i = 0; i < 3; i++) saves.push({ action: "saved", automatic: false, verification: "verified", at: isoDaysAgo(day, i) });
  for (let day = 0; day < 14; day++) {
    for (let i = 0; i < 3; i++) {
      autos.push({ action: "saved", automatic: true, verification: "verified", applied: true, at: isoDaysAgo(day, i) });
      recalls.push({ category: "memory_retrieval", name: "recall.completed", timestamp: isoDaysAgo(day, 10 + i) });
    }
    settles.push({ kind: "settle", at: isoDaysAgo(day, 20) });
  }
  for (let day = 0; day < 7; day++) for (let i = 0; i < 3; i++) shadows.push({ category: "memory_decision", name: "shadow.outcome", timestamp: isoDaysAgo(day, 30 + i), payload: { agreed: true, applied: false, proposalHash: "sha256:abc" } });
  return { saves, autos, settles, recalls, shadows };
}
const toSources = (fixture) => ({ decisions: [...fixture.saves, ...fixture.autos], traces: [...fixture.recalls, ...fixture.shadows], diagnostics: fixture.settles });

test("incompleteCriteria reports only the short criteria", () => {
  const saves = [];
  for (let day = 0; day < 7; day++) for (let i = 0; i < 3; i++) saves.push({ action: "saved", automatic: false, verification: "verified", at: isoDaysAgo(day, i) });
  const partial = computeEvidenceWindow({ decisions: saves });
  assert.deepEqual(incompleteCriteria(partial), ["R", "SD", "C", "A"]);
  const complete = computeEvidenceWindow(toSources(completeFixture()));
  assert.deepEqual(incompleteCriteria(complete), []);
});

test("--strict exits non-zero and prints the failing keys", () => {
  const dir = writeStrictFixture({});
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "memory-evidence-window.js"), "--strict", dir], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /strict: incomplete criteria: S1, R, SD, C, A/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--strict exits zero when every criterion is complete", () => {
  const dir = writeStrictFixture(completeFixture());
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "memory-evidence-window.js"), "--strict", dir], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.stderr, /incomplete criteria/);
  fs.rmSync(dir, { recursive: true, force: true });
});
