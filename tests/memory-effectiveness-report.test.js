"use strict";

// The report script reads only declared measurements. Reviewed-gold and privacy
// rollout evidence artifacts are retired, so stale files must be ignored.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const reportScript = path.join(root, "scripts", "report-memory-effectiveness.js");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "memory-effectiveness", "manifest.json"), "utf8"));
const input = {
  retrievalResults: manifest.retrievalCases.map((row) => ({ id: row.id, rankedIds: [...row.relevantIds] })),
  saveResults: manifest.saveCases.map((row) => ({ id: row.id, outcome: row.expected })),
  performance: { localRecallP95Ms: 10, localRecallSamples: 10 },
  field: { independentSessions: 0, observedDays: 0, currentFactStaleRate: 0 },
  curation: { attempts: 0, successRate: 0, timeoutRate: 0, p95Ms: 0 },
  migration: { previewPassed: true, rollbackPassed: true, fixtures: 1 },
  privacy: { unresolvedHighSeverity: 0, unresolvedActionable: 0, candidateCount: 2 },
};

const cwd = tmpFixture("memory-effectiveness-report-");
fs.mkdirSync(path.join(cwd, "tests", "fixtures", "memory-effectiveness"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".pi", "memory-effectiveness"), { recursive: true });
fs.mkdirSync(path.join(cwd, ".pi", "privacy-guard"), { recursive: true });
fs.writeFileSync(path.join(cwd, "tests", "fixtures", "memory-effectiveness", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(cwd, ".pi", "memory-effectiveness", "input.json"), `${JSON.stringify(input, null, 2)}\n`);
// Retired artifact paths: their presence must not change the report.
fs.writeFileSync(path.join(cwd, ".pi", "memory-effectiveness", "reviewed-gold-evidence.json"), JSON.stringify({ evidenceQualified: true, summary: { qualified: true } }));
fs.writeFileSync(path.join(cwd, ".pi", "privacy-guard", "rollout-evidence.json"), JSON.stringify({ summary: { qualified: true } }));

function run() { return spawnSync(process.execPath, [reportScript], { cwd, env: { ...process.env }, encoding: "utf8" }); }
const success = run();
assert.equal(success.status, 0, success.stderr);
const output = JSON.parse(success.stdout);
assert.equal(output.ok, true);
assert.equal(output.authority, "reporting-only");
assert.equal(output.decision, "no-go-deferred");
assert.equal(output.reviewedGoldQualified, undefined, "reviewed-gold qualification is retired");
assert.equal(output.highestAuthorizedStage, undefined, "artifact stage authorization is retired");

const scorecardFile = path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json");
const scorecard = JSON.parse(fs.readFileSync(scorecardFile, "utf8"));
assert.equal(fs.statSync(scorecardFile).mode & 0o777, 0o600);
assert.equal(scorecard.authority, "reporting-only");
assert.equal(scorecard.source.revision, currentMemorySourceEvidence({ implementationRoot: root }).revision);
assert.equal(scorecard.scores.retrievalPrecisionAt5.status, "pass");
assert.equal(scorecard.scores.privacyBoundary.status, "pass");
assert.equal(scorecard.evidenceQualification, undefined);

// Unsafe declared input is still refused before anything is written.
fs.writeFileSync(path.join(cwd, ".pi", "memory-effectiveness", "input.json"), `${JSON.stringify({ ...input, field: { ...input.field, note: "C:\\Users\\someone\\secret.txt" } }, null, 2)}\n`);
const unsafe = run();
assert.notEqual(unsafe.status, 0);
assert.match(unsafe.stderr, /refusing unsafe scorecard/);

console.log("memory effectiveness report ingestion tests passed");
