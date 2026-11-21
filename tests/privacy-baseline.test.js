"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildPrivacyBaseline } = require("../src/privacy-baseline");
const { scanPrivacy, collectRolloutSources } = require("../src/memory-rollout-telemetry");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "write-privacy-baseline.js");

// Unit shape: only record-format highs are grandfathered, by content handle.
const baseline = buildPrivacyBaseline({
  findings: [
    { file: "project-state:abc123", severity: "high", pattern: "openai-key" },
    { file: "project-state:abc123", severity: "high", pattern: "api-key-assignment" },
    { file: "project-state:def456", severity: "medium", pattern: "full-transcript-hint" },
  ],
  permissionPosture: { compliant: true },
}, { sourceRevision: "content:abc", now: Date.parse("2026-11-21T00:00:00Z") });
assert.equal(baseline.schemaVersion, 1);
assert.equal(baseline.kind, "privacy-baseline");
assert.equal(baseline.baselineAt, "2026-11-21T00:00:00.000Z");
assert.deepEqual(baseline.counts, { actionable: 3, high: 2, medium: 1 });
assert.deepEqual(baseline.recordFileHashes, ["project-state:abc123"], "a medium finding is never grandfathered");
assert.deepEqual(baseline.codeHighHandles, []);
assert.equal(baseline.permissionPostureCompliant, true);
assert.equal(buildPrivacyBaseline({ findings: [], permissionPosture: { compliant: false } }).permissionPostureCompliant, false);
assert.equal(buildPrivacyBaseline({}).counts.actionable, 0);

// End to end: the script scans runtime state, refuses an incomplete scan, and
// writes a private baseline whose handles grandfather the current highs.
const cwd = tmpFixture("privacy-baseline-");
fs.mkdirSync(path.join(cwd, ".pi", "project-memory"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".pi", "project-memory", "decisions.jsonl"), `${JSON.stringify({ note: "api_key: sk-abcdefghijklmnopqrstuvwx" })}\n`);
const home = tmpFixture("privacy-baseline-home-");
fs.mkdirSync(path.join(home, ".pi", "agent", "sessions"), { recursive: true, mode: 0o700 });
const env = { ...process.env, HOME: home };
const run = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
assert.equal(run.status, 0, run.stderr);
const output = JSON.parse(run.stdout);
assert.equal(output.ok, true);
assert.equal(output.counts.high >= 2, true);
assert.equal(output.permissionPostureCompliant, true);
const baselineFile = path.join(cwd, ".pi", "privacy-guard", "privacy-baseline.json");
assert.equal(fs.statSync(baselineFile).mode & 0o777, 0o600);
const written = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
assert.equal(written.kind, "privacy-baseline");
assert(written.recordFileHashes.length >= 1);
assert(!JSON.stringify(written).includes(cwd), "the baseline carries no absolute path");

// The written baseline satisfies the passive B predicate for the same scan.
const scan = scanPrivacy(cwd, env);
const sources = collectRolloutSources({ cwd, privacy: scan, baseline: written, nowMs: Date.parse(written.baselineAt) });
assert.equal(scan.complete, true);
assert.equal(written.recordFileHashes.includes(scan.findings.find((row) => row.severity === "high").file), true);

// A rewrite keeps the previous baseline under a timestamped name.
const rewritten = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
assert.equal(rewritten.status, 0, rewritten.stderr);
const retained = fs.readdirSync(path.join(cwd, ".pi", "privacy-guard")).filter((name) => /^privacy-baseline-\d{4}-/.test(name));
assert.equal(retained.length, 1, "the previous baseline is retained, not overwritten");

// An incomplete scan must not produce a baseline.
const incomplete = spawnSync(process.execPath, [script], { cwd, env: { ...env, PI_PROJECT_MEMORY_SCAN_DEADLINE_MS: "1" }, encoding: "utf8" });
assert.notEqual(incomplete.status, 0);
assert.match(incomplete.stderr, /incomplete baseline/);

assert.ok(sources.diagnostics !== undefined);

console.log("privacy baseline tests passed");
