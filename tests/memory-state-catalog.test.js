"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { catalog, publicMap, classifyRecords, curationPlan, search, lineage, conflicts, prunePreview, isForbiddenPromotionPath } = require("../src/memory-state-catalog");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("memory-state-catalog-");
const cognitive = path.join(cwd, ".pi", "cognitive-automation"); fs.mkdirSync(cognitive, { recursive: true });
const entries = [
  { id: "architecture-1", type: "semantic", title: "Canonical authority", content: "Obsidian is canonical durable project memory", tags: ["architecture"], verification: "verified", updatedAt: 10, provenance: { source: "explicit" }, links: { related: ["objective-1"] } },
  { id: "objective-1", type: "episodic", title: "Current objective", content: "Implement bounded project memory", tags: ["objective"], verification: "inferred", updatedAt: 9, provenance: { source: "pi-input" } },
  { id: "verifier-1", type: "procedural", title: "Verifier passed", content: "Routine check passed", tags: ["procedure"], verification: "verified", updatedAt: 8, provenance: { source: "verification-adapter" } },
  { id: "anchor-1", type: "procedural", title: "Files changed", content: "Routine file-change anchor", tags: ["procedure"], verification: "verified", updatedAt: 7, provenance: { source: "anchoring-adapter" } },
  { id: "conflict-1", type: "semantic", title: "Old authority", content: "A contradicted claim", tags: ["decision"], verification: "contradicted", updatedAt: 6, provenance: { source: "explicit" }, contradicts: ["architecture-1"] },
  { id: "expired-iso", type: "semantic", title: "Expired authority", content: "An old durable rule", tags: ["architecture"], verification: "verified", updatedAt: 5, expiresAt: "2020-01-01T00:00:00.000Z", provenance: { source: "explicit" } },
];
fs.writeFileSync(path.join(cognitive, "cognitive-memory.json"), JSON.stringify({ entries }));
for (let index = 0; index < 1500; index++) fs.writeFileSync(path.join(cognitive, `record-${String(index).padStart(4, "0")}.json`), "{}\n");
fs.writeFileSync(path.join(cognitive, "large.md"), "a".repeat(3_100_000));
const traceDir = path.join(cognitive, "trace"); fs.mkdirSync(traceDir); fs.writeFileSync(path.join(traceDir, "architecture-run.json"), "x".repeat(120_000));

const state = catalog(cwd);
assert.equal(state.metadata.complete, true);
assert.equal(state.files, 1503, "metadata inventory has no 1,000-file or size cutoff");
assert.equal(state.bytes, state.inventory.files.reduce((sum, file) => sum + file.bytes, 0));
const map = publicMap(cwd);
assert.equal(map.files, 1503);
assert.equal(JSON.stringify(map).includes(cwd), false, "public map uses scoped labels rather than local paths");

const classified = classifyRecords(cwd);
assert.equal(classified.find((row) => row.recordId === "architecture-1").action, "promote-review");
assert.equal(classified.find((row) => row.recordId === "verifier-1").action, "keep");
assert.match(classified.find((row) => row.recordId === "verifier-1").reasons.join(" "), /excluded/);
assert.equal(classified.find((row) => row.recordId === "anchor-1").action, "keep");
assert.equal(classified.find((row) => row.recordId === "expired-iso").action, "forget-review", "ISO expiry timestamps cannot be promoted as durable memory");
assert(classified.find((row) => row.recordId === "expired-iso").reasons.includes("expired"));
assert.equal(curationPlan(cwd).candidates.some((row) => row.recordId === "architecture-run.json"), false, "whole runtime files are never promoted");
assert.equal(isForbiddenPromotionPath(path.join(traceDir, "architecture-run.json")), true);

const ranked = search(cwd, "canonical durable authority");
assert.equal(ranked.matches[0].recordId, "architecture-1");
assert.equal(ranked.matches[0].phrase, false);
assert.equal(search(cwd, "Obsidian is canonical").matches[0].phrase, true);
assert.deepEqual(search(cwd, "canonical durable authority").matches.map((row) => row.recordId), ["architecture-1", "expired-iso", "conflict-1"]);
assert.deepEqual(search(cwd, "no_such_memory_term").matches, [], "verification alone cannot make an unrelated record a search hit");
assert.equal(lineage(cwd, "architecture-1").links[0].recordId, "objective-1");
assert.equal(conflicts(cwd)[0].recordId, "conflict-1");
const prune = prunePreview(cwd);
assert.equal(prune.preview, true);
assert.equal(prune.candidates.some((row) => row.action === "subsystem-retention-review"), true);
assert.equal(prune.coverage.complete, true);

fs.rmSync(cwd, { recursive: true, force: true });
console.log("memory state catalog tests passed");
