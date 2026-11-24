#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { composeReadiness } = require("../scripts/memory-readiness.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const SCRIPT = path.join(__dirname, "..", "scripts", "memory-readiness.js");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Shift an ISO day (YYYY-MM-DD) by whole days, in UTC like the CLI. */
function addDays(isoDay, days) {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function statusFixture({ s1 = "insufficient", r = "insufficient", candidate = "M1", requested = "M1" } = {}) {
  return {
    now: Date.parse("2026-11-23T12:00:00Z"),
    sources: { decisions: [], traces: [], diagnostics: [] },
    gates: [
      { name: "S1", count: s1 === "pass" ? 20 : 2, need: 20, days: s1 === "pass" ? 7 : 1, daysNeed: 7, extra: "verified 2, precision 1.000" },
      { name: "R", count: r === "pass" ? 30 : 6, need: 30, days: r === "pass" ? 14 : 1, daysNeed: 14, extra: "sessions 3" },
      { name: "SD", count: 1, need: 20, days: 1, daysNeed: 7, extra: "" },
      { name: "C", count: 216, need: 14, days: 9, daysNeed: 14, extra: "" },
      { name: "A", count: 0, need: 30, days: 0, daysNeed: 14, extra: "" },
    ],
    evaluation: {
      candidateStage: candidate,
      predicates: {
        D: { status: "pass" }, P: { status: "pass" }, B: { status: "pass" },
        S1: { status: s1 }, R: { status: r },
        SD: { status: "insufficient" }, C: { status: "insufficient" }, A: { status: "insufficient" },
      },
    },
    rollout: { requestedStage: requested, eligibleStage: candidate, effectiveStage: candidate },
  };
}

function windowFixture() {
  return {
    windowDays: 14,
    start: "2026-11-10",
    end: "2026-11-23",
    criteria: [
      { key: "S1", observedDays: 1, daysNeed: 7, daysRemaining: 6, earliest: "2026-11-29" },
      { key: "R", observedDays: 1, daysNeed: 14, daysRemaining: 13, earliest: "2026-12-06" },
      { key: "SD", observedDays: 1, daysNeed: 7, daysRemaining: 6, earliest: "2026-11-29" },
      { key: "C", observedDays: 9, daysNeed: 14, daysRemaining: 5, earliest: "2026-11-28" },
      { key: "A", observedDays: 0, daysNeed: 14, daysRemaining: 14, earliest: "2026-12-07" },
    ],
  };
}

function writeFixture() {
  const dir = tmpFixture("pi-memory-readiness-");
  // The CLI derives its window from the current clock, so fixture records are
  // dated relative to now. A literal date silently falls out of the 14-day
  // window once it ages, which turns every count assertion into a calendar bug.
  const at = new Date(Date.now() - DAY_MS).toISOString();
  fs.mkdirSync(path.join(dir, ".pi", "traces"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "project-memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi", "project-memory", "decisions.jsonl"), [
    { action: "saved", automatic: false, verification: "verified", at },
    { action: "saved", automatic: false, verification: "verified", at },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, ".pi", "traces", "project--session.jsonl"), Array.from({ length: 6 }, () => ({
    category: "memory_retrieval",
    name: "recall.completed",
    timestamp: at,
    payload: { durationMs: 1, returnedHashes: [], outOfScopeCount: 0, injected: false, sessionIdHash: "abc" },
  })).map((row) => JSON.stringify(row)).join("\n") + "\n");
  return dir;
}

test("composeReadiness reports D/P/B and each gate's count, days and earliest floor", () => {
  const result = composeReadiness(statusFixture(), windowFixture());
  assert.deepEqual(result.gates.map((gate) => gate.name), ["D", "P", "B", "S1", "R", "SD", "C", "A"]);
  const s1 = result.gates.find((gate) => gate.name === "S1");
  assert.equal(s1.count, 2);
  assert.equal(s1.need, 20);
  assert.equal(s1.days, 1);
  assert.equal(s1.daysNeed, 7);
  assert.equal(s1.daysRemaining, 6);
  assert.equal(s1.earliest, "2026-11-29");
  const r = result.gates.find((gate) => gate.name === "R");
  assert.equal(r.count, 6);
  assert.equal(r.daysRemaining, 13);
  assert.equal(r.earliest, "2026-12-06");
  assert.equal(result.m2Eligible, false);
  assert.equal(result.promotionReady, false);
  assert.deepEqual(result.blockers, ["S1", "R"]);
});

test("M2 eligibility requires S1 and R, while the requested stage caps promotion", () => {
  const eligibleButCapped = composeReadiness(statusFixture({ s1: "pass", r: "pass", candidate: "M2", requested: "M1" }), windowFixture());
  assert.equal(eligibleButCapped.m2Eligible, true);
  assert.equal(eligibleButCapped.promotionReady, false);
  assert.deepEqual(eligibleButCapped.blockers, []);

  const promoted = composeReadiness(statusFixture({ s1: "pass", r: "pass", candidate: "M2", requested: "M2" }), windowFixture());
  assert.equal(promoted.promotionReady, true);

  const blocked = composeReadiness(statusFixture({ s1: "pass", r: "insufficient", candidate: "M1" }), windowFixture());
  assert.equal(blocked.m2Eligible, false);
  assert.deepEqual(blocked.blockers, ["R"]);
});

test("the daily readiness CLI reports counts and days remaining, and --strict fails while M2 is not ready", () => {
  const dir = writeFixture();
  const json = spawnSync(process.execPath, [SCRIPT, dir, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0);
  const result = JSON.parse(json.stdout);
  assert.equal(result.window.days, 14);
  assert.equal(result.stage.requested, result.stage.effective);
  const s1 = result.gates.find((gate) => gate.name === "S1");
  assert.equal(s1.count, 2);
  assert.equal(s1.need, 20);
  assert.equal(s1.daysRemaining, 6);
  // The floor is derived from the live window, so pin the derivation instead of
  // a literal date that would only hold on one calendar day.
  assert.equal(s1.earliest, addDays(result.window.end, s1.daysRemaining), "the S1 floor is the window end plus its remaining days");
  assert.ok(s1.earliest > result.window.end, "a shortfall floors the gate in the future");
  const r = result.gates.find((gate) => gate.name === "R");
  assert.equal(r.count, 6);
  assert.equal(r.daysRemaining, 13);
  assert.equal(result.m2Eligible, false);

  const strict = spawnSync(process.execPath, [SCRIPT, dir, "--strict"], { encoding: "utf8" });
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /strict: M2 not ready \(blocked by /);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the readiness CLI fails closed without a .pi evidence directory", () => {
  const dir = tmpFixture("pi-memory-readiness-empty-");
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No \.pi evidence directory/);
  fs.rmSync(dir, { recursive: true, force: true });
});
