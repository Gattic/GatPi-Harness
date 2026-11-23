#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { tmpFixture } = require("./helpers/tmp-fixture");

const GATE = path.join(__dirname, "..", "scripts", "check-memory-evidence.sh");
const DAY = 864e5;
const isoDaysAgo = (days, minute = 0) => new Date(Date.now() - days * DAY - minute * 60000).toISOString();

function writeFixture({ saves = [], autos = [], settles = [], recalls = [], shadows = [] } = {}) {
  const dir = tmpFixture("pi-memory-evidence-gate-");
  fs.mkdirSync(path.join(dir, ".pi", "traces"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "project-memory"), { recursive: true });
  const write = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (saves.length || autos.length) write(path.join(dir, ".pi", "project-memory", "decisions.jsonl"), [...saves, ...autos]);
  if (settles.length) write(path.join(dir, ".pi", "project-memory", "diagnostics.jsonl"), settles);
  if (recalls.length || shadows.length) write(path.join(dir, ".pi", "traces", "project--session.jsonl"), [...recalls, ...shadows]);
  return dir;
}

function completeRecords() {
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

test("gate exits non-zero when the evidence window is incomplete", () => {
  const dir = writeFixture();
  const run = spawnSync("bash", [GATE, dir], { encoding: "utf8" });
  assert.equal(run.status, 1, "incomplete window fails the gate");
  assert.match(run.stderr, /strict: incomplete criteria: S1, R, SD, C, A/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gate exits zero when every criterion is complete", () => {
  const dir = writeFixture(completeRecords());
  const run = spawnSync("bash", [GATE, dir], { encoding: "utf8" });
  assert.equal(run.status, 0, "complete window passes the gate");
  assert.doesNotMatch(run.stderr, /incomplete criteria/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gate propagates the exit code with --json passthrough", () => {
  const dir = writeFixture();
  const run = spawnSync("bash", [GATE, "--json", dir], { encoding: "utf8" });
  assert.equal(run.status, 1, "json mode still fails the pipeline");
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.criteria.length, 5);
  assert.match(run.stderr, /strict: incomplete criteria:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("check-all.sh wires the strict gate behind PI_MEMORY_EVIDENCE_STRICT", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-all.sh"), "utf8");
  assert.match(script, /PI_MEMORY_EVIDENCE_STRICT/);
  assert.match(script, /scripts\/check-memory-evidence\.sh/);
  assert.equal(fs.statSync(GATE).mode & 0o111, 0o111, "gate wrapper is executable");
});
