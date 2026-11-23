"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildSummary } = require("../scripts/memory-diagnostics-summary.js");

const SCRIPT = path.join(__dirname, "..", "scripts", "memory-diagnostics-summary.js");
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function writeRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function fixture({ now = NOW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-diagnostics-summary-"));
  const day = (n) => iso(now - n * DAY);
  writeRows(path.join(dir, ".pi/project-memory/diagnostics.jsonl"), [
    { kind: "settle", at: day(2), scanned: 1, candidateHashes: ["sha256:a"], reasonCounts: { eligible: 1 }, diagnosticOnly: true, vaultReady: true },
    { kind: "settle", at: day(1), scanned: 1, candidateHashes: ["sha256:a"], reasonCounts: { eligible: 1 }, diagnosticOnly: true, vaultReady: true },
    { kind: "settle", at: day(0), scanned: 1, candidateHashes: ["sha256:a"], reasonCounts: { eligible: 1 }, diagnosticOnly: true, vaultReady: true },
    { kind: "write", at: day(0), scope: "project-memory-state", sanitized: true, inspected: 7, records: 1, bypassedRecords: 0, bypassedFiles: 0, files: [] },
  ]);
  writeRows(path.join(dir, ".pi/project-memory/decisions.jsonl"), [
    { at: day(0), action: "saved", automatic: false, verification: "verified", sessionIdHash: "hash-s1", candidateHash: "sha256:a" },
    { at: day(0), action: "saved", automatic: false, verification: "verified", sessionIdHash: "hash-s1", candidateHash: "sha256:b" },
  ]);
  writeRows(path.join(dir, ".pi/traces/trace.jsonl"), Array.from({ length: 6 }, (_, index) => ({
    timestamp: day(0),
    category: "memory_retrieval",
    name: "recall.completed",
    session_id: `session-${index % 3}`,
    payload: { durationMs: 0.5, returnedHashes: ["sha256:a"], outOfScopeCount: 0, injected: false, sessionIdHash: `hash-${index % 3}` },
  })));
  return dir;
}

test("buildSummary aggregates diagnostics composition and R/C/S1/A counters", () => {
  const result = buildSummary({ cwd: fixture(), now: NOW });
  assert.equal(result.diagnostics.rows, 4);
  assert.deepEqual(result.diagnostics.kinds, { settle: 3, write: 1 });
  assert.equal(result.diagnostics.settleInWindow, 3);
  assert.equal(result.diagnostics.settleDaysInWindow, 3);
  const gates = Object.fromEntries(result.gates.map((gate) => [gate.name, gate]));
  assert.deepEqual(Object.keys(gates), ["S1", "R", "C", "A"]);

  assert.equal(gates.S1.count, 2);
  assert.equal(gates.S1.need, 20);
  assert.equal(gates.S1.days, 1);
  assert.equal(gates.S1.daysRemaining, 6);
  assert.equal(gates.S1.earliest, "2026-11-29");
  assert.equal(gates.S1.status, "insufficient");
  assert.match(gates.S1.extra, /verified 2, precision 1\.000/);

  assert.equal(gates.R.count, 6);
  assert.equal(gates.R.need, 30);
  assert.equal(gates.R.days, 1);
  assert.equal(gates.R.daysRemaining, 13);
  assert.equal(gates.R.earliest, "2026-12-06");
  assert.equal(gates.R.status, "insufficient");
  assert.match(gates.R.extra, /sessions 3/);

  assert.equal(gates.C.count, 3);
  assert.equal(gates.C.need, 14);
  assert.equal(gates.C.days, 3);
  assert.equal(gates.C.daysRemaining, 11);
  assert.equal(gates.C.earliest, "2026-12-04");
  assert.equal(gates.C.status, "insufficient");
  assert.equal(gates.C.extra, "unstable 0, accounted 3/3, safe 3/3");

  assert.equal(gates.A.count, 0);
  assert.equal(gates.A.need, 30);
  assert.equal(gates.A.days, 0);
  assert.equal(gates.A.daysRemaining, 14);
  assert.equal(gates.A.earliest, "2026-12-07");
  assert.equal(gates.A.status, "insufficient");
});

test("CLI emits progress and JSON from the diagnostics file", () => {
  const dir = fixture({ now: Date.now() });
  const jsonRun = spawnSync(process.execPath, [SCRIPT, dir, "--json"], { encoding: "utf8" });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const result = JSON.parse(jsonRun.stdout);
  assert.equal(result.diagnostics.rows, 4);
  const gates = Object.fromEntries(result.gates.map((gate) => [gate.name, gate]));
  assert.equal(gates.S1.count, 2);
  assert.equal(gates.S1.daysRemaining, 6);
  assert.equal(gates.R.count, 6);
  assert.equal(gates.R.daysRemaining, 13);
  assert.equal(gates.C.count, 3);
  assert.equal(gates.C.daysRemaining, 11);
  assert.equal(gates.A.count, 0);
  assert.equal(gates.A.daysRemaining, 14);

  const textRun = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /Memory diagnostics summary \(read-only\)/);
  assert.match(textRun.stdout, /source: C from diagnostics\.jsonl; R from traces; S1\/A from decisions\.jsonl/);
  assert.match(textRun.stdout, /S1\s+insufficient\s+2\/20/);
  assert.match(textRun.stdout, /C\s+insufficient\s+3\/14/);
});
