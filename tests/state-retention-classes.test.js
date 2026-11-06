#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RETENTION_POLICIES, previewRetention, applyRetention, readProtectedRefs } = require("../src/state-retention.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("state-retention-classes-");
const now = Date.now();
function write(file, text, ageDays = 0) {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, { mode: 0o600 });
  fs.utimesSync(full, new Date(now - ageDays * 86400000), new Date(now - ageDays * 86400000));
}

write(".pi/cognitive-automation/reasoning/transcripts/old.json", JSON.stringify({ pad: "r".repeat(2000) }), 40);
write(".pi/cognitive-automation/reasoning/snapshots/old.json", JSON.stringify({ pad: "s".repeat(2000) }), 40);
write(".pi/subagents/workspaces/active/lease.json", JSON.stringify({ state: "active" }), 40);
write(".pi/subagents/workspaces/active/tree/file.txt", "active\n", 40);
write(".pi/subagents/workspaces/stale/lease.json", JSON.stringify({ state: "released" }), 40);
write(".pi/subagents/workspaces/stale/tree/file.txt", "stale\n", 40);
write(".pi/subagents/rpc-sessions/child/session.jsonl", "{}\n", 40);
write(".pi/planning/evidence.json", JSON.stringify({ pad: "p".repeat(2000) }), 400);
write(".pi/evidence-binder/claims.jsonl", "{}\n", 400);
write(".pi/toolchains/npm-cache/pkg.tgz", "cache", 40);
write(".pi/toolchains/blender-5.1.2-linux-x64/bin/blender", "pinned", 400);

const preview = previewRetention({ cwd, now });
for (const className of ["reasoning", "subagents", "planning", "evidence", "toolchain-cache", "toolchain-install"]) {
  assert(preview.classes[className], `${className} must be covered by retention`);
  assert(preview.footprint.classes[className], `${className} must appear in footprint`);
}
assert.equal(preview.classes.snapshot.files, 1, "reasoning snapshots remain in the snapshot class");
assert.equal(preview.classes.reasoning.files, 1, "reasoning excludes the snapshot subtree");
assert.equal(preview.classes.reasoning.candidates, 1);
assert.equal(preview.classes.subagents.candidates >= 1, true);
assert.equal(preview.candidates.some((row) => row.class === "subagents" && row.ref && row.protected), false);
const activeCandidate = preview.candidates.some((row) => row.class === "subagents" && row.contentHash);
assert.equal(activeCandidate, true);
assert.equal(preview.classes.planning.reportOnly, true);
assert.equal(preview.classes.planning.candidates, 0, "authored planning evidence is report-only");
assert.equal(preview.classes.evidence.reportOnly, true);
assert.equal(preview.classes.evidence.candidates, 0, "evidence binder records are report-only");
assert.equal(preview.classes["toolchain-install"].reportOnly, true);
assert.equal(preview.classes["toolchain-install"].candidates, 0, "pinned toolchains are never deletion candidates");
assert.equal(preview.classes["toolchain-cache"].reportOnly, false);
assert(preview.footprint.totalBytes > 0);
assert.equal(preview.footprint.classes.reasoning.overByteCap, false);
assert.equal(preview.boundaries.deletionPerformed, false);

const blocked = applyRetention({ cwd, className: "planning", manifestId: preview.manifestId, apply: true });
assert.equal(blocked.ok, false);
assert.equal(blocked.reason, "report-only-retention-class");
assert(fs.existsSync(path.join(cwd, ".pi", "planning", "evidence.json")));

const refs = readProtectedRefs(cwd);
assert(refs.has(".pi/subagents/workspaces/active"), "the active workspace lease is a protected lineage ref");
assert(!refs.has(".pi/subagents/workspaces/stale"), "a released workspace is not protected by an active lease");

const protectedPreview = previewRetention({ cwd, now, policies: { ...RETENTION_POLICIES, subagents: { maxFiles: 1, maxAgeDays: 1, maxBytes: 1024 } } });
const protectedRows = protectedPreview.classes.subagents;
assert(protectedRows.protected >= 1, "active workspace leases are protected from retention");
assert.equal(protectedRows.candidates >= 1, true, "released workspaces can still be reclaimed");

const customPolicies = { ...RETENTION_POLICIES, reasoning: { ...RETENTION_POLICIES.reasoning, reportOnly: true } };
const customPreview = previewRetention({ cwd, now, policies: customPolicies });
assert.equal(customPreview.classes.reasoning.reportOnly, true);
assert.equal(customPreview.classes.reasoning.candidates, 0, "a custom report-only policy suppresses deletion candidates");
const customBlocked = applyRetention({ cwd, className: "reasoning", manifestId: customPreview.manifestId, apply: true, policies: customPolicies });
assert.equal(customBlocked.ok, false);
assert.equal(customBlocked.reason, "report-only-retention-class");
assert(fs.existsSync(path.join(cwd, ".pi", "cognitive-automation", "reasoning", "transcripts", "old.json")));

console.log("state retention classes tests passed");
