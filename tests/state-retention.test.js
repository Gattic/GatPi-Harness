"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RETENTION_POLICIES, previewRetention, applyRetention, rollbackRetention } = require("../src/state-retention");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("state-retention-"); const trace = path.join(cwd, ".pi", "traces"); fs.mkdirSync(trace, { recursive: true });
for (let index = 0; index < 10; index++) { const file = path.join(trace, `trace-${index}.jsonl`); fs.writeFileSync(file, `${String(index).repeat(2000)}\n`, { mode: 0o600 }); fs.utimesSync(file, new Date(Date.now() - (index + 1) * 86400000), new Date(Date.now() - (index + 1) * 86400000)); }
const debugDir = path.join(cwd, ".pi", "debug-ledger"); fs.mkdirSync(debugDir, { recursive: true }); fs.writeFileSync(path.join(debugDir, "protected.json"), JSON.stringify({ attempts: [{ evidence: [".pi/traces/trace-9.jsonl"] }] }));
const reasoningSnapshots = path.join(cwd, ".pi", "cognitive-automation", "reasoning", "snapshots"); fs.mkdirSync(reasoningSnapshots, { recursive: true });
for (let index = 0; index < 3; index++) { const file = path.join(reasoningSnapshots, `snapshot-${index}.json`); fs.writeFileSync(file, JSON.stringify({ index, pad: "x".repeat(2000) }), { mode: 0o600 }); fs.utimesSync(file, new Date(Date.now() - (index + 40) * 86400000), new Date(Date.now() - (index + 40) * 86400000)); }
const sessionDir = path.join(cwd, ".pi", "agent", "sessions"); fs.mkdirSync(sessionDir, { recursive: true }); const session = path.join(sessionDir, "session.jsonl"); fs.writeFileSync(session, "raw session remains byte-identical\n"); const sessionBefore = fs.readFileSync(session);
const policies = { ...RETENTION_POLICIES, trace: { maxFiles: 2, maxAgeDays: 3, maxBytes: 5_000 } };
const thresholdNow = fs.statSync(path.join(trace, "trace-2.jsonl")).mtimeMs + 3 * 86400000;
const preview = previewRetention({ cwd, policies, now: thresholdNow });
assert.equal(preview.complete, true);
assert.equal(preview.boundaries.rawSessionsInScope, false);
assert.equal(preview.classes.trace.files, 10);
assert.equal(preview.classes.trace.protected, 1);
assert.ok(preview.classes.trace.candidates >= 5);
assert.equal(preview.classes.snapshot.files, 3, "reasoning snapshots are covered by retention");
assert.equal(preview.classes.snapshot.candidates, 3, "stale reasoning snapshots are reclaimable candidates");
assert.equal(JSON.stringify(preview).includes(cwd), false, "public retention preview contains no local paths");
assert.equal(fs.readdirSync(trace).length, 10, "preview never mutates");
const dry = applyRetention({ cwd, manifestId: preview.manifestId, className: "trace", apply: false, policies });
assert.equal(dry.outcome, "preview");
const unreviewed = applyRetention({ cwd, className: "trace", apply: true, policies });
assert.equal(unreviewed.reason, "retention-preview-manifest-required");
assert.equal(fs.readdirSync(trace).length, 10, "retention apply cannot bypass a separately reviewed manifest");
const applied = applyRetention({ cwd, manifestId: preview.manifestId, className: "trace", apply: true, policies });
assert.equal(applied.outcome, "applied");
assert.ok(fs.readdirSync(trace).length <= 5, "fixture state is reduced by at least 50%");
assert.equal(fs.existsSync(path.join(trace, "trace-9.jsonl")), true, "debug-referenced evidence is protected");
assert.equal(fs.readFileSync(session).equals(sessionBefore), true);
const rollbackPreview = rollbackRetention({ cwd, manifestId: preview.manifestId, apply: false });
assert.equal(rollbackPreview.ok, true);
assert.equal(rollbackRetention({ cwd, manifestId: preview.manifestId, apply: true }).outcome, "rolled-back");
assert.equal(fs.readdirSync(trace).length, 10);
assert.equal(fs.readFileSync(session).equals(sessionBefore), true);

console.log("state retention tests passed");
