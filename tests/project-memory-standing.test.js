"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-project-standing-");
const project = path.join(tmp, "project");
const vault = path.join(tmp, "vault");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(vault, { recursive: true });
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
const store = new ProjectMemoryStore({ cwd: project, vault, writeEnabled: true, clock });

const saved = store.upsert({ kind: "constraint", title: "Use integration boundary", content: "All cognitive extension calls must use integration-boundary adapters.", verification: "verified", sourceFingerprints: ["test:standing"], evidenceIds: ["evidence:standing"] }, { apply: true, explicit: true });
assert.equal(saved.outcome, "saved");
const decisionsBeforePreview = store.decisions.list({ limit: Infinity }).length;
const noteBeforePreview = fs.readFileSync(store.notePath("constraint"), "utf8");
const preview = store.setStanding({ entryId: saved.entry.id, standing: true }, { apply: false, explicit: true });
assert.equal(preview.outcome, "preview");
assert.equal(preview.applied, false);
assert.equal(store.decisions.list({ limit: Infinity }).length, decisionsBeforePreview, "standing preview writes no decision row");
assert.equal(fs.readFileSync(store.notePath("constraint"), "utf8"), noteBeforePreview, "standing preview leaves canonical note byte-identical");

const pinned = store.setStanding({ entryId: saved.entry.id, standing: true }, { apply: true, explicit: true });
assert.equal(pinned.outcome, "pinned");
assert.equal(pinned.applied, true);
const projection = store.standingProjection({ limit: 12, maxChars: 1600 });
assert.equal(projection.outcome, "succeeded");
assert.equal(projection.items.length, 1);
assert.equal(projection.items[0].id, saved.entry.id);
assert.equal(projection.items[0].verification, "verified");
assert(!JSON.stringify(projection).includes(vault), "standing projection exposes canonical IDs, not vault paths");

const duplicate = store.setStanding({ entryId: saved.entry.id, standing: true }, { apply: true, explicit: true });
assert.equal(duplicate.outcome, "deduped");
const unpinned = store.setStanding({ entryId: saved.entry.id, standing: false }, { apply: true, explicit: true });
assert.equal(unpinned.outcome, "unpinned");
assert.equal(store.standingProjection().items.length, 0);

assert.equal(store.setStanding({ entryId: saved.entry.id, standing: true }, { apply: true, explicit: true }).outcome, "pinned");
const successor = store.upsert({ kind: "constraint", title: "Use the strict integration boundary", content: "All extension calls must use the current integration-boundary adapters.", verification: "verified", supersedes: [saved.entry.id] }, { apply: true, explicit: true });
assert.equal(successor.outcome, "saved");
assert.equal(store.standingProjection().items.some((item) => item.id === saved.entry.id), false, "superseded entries are removed from standing context");
assert.equal(store.setStanding({ entryId: saved.entry.id, standing: true }, { apply: true, explicit: true }).reason, "conflict", "superseded entries cannot be pinned again");
assert.equal(store.setStanding({ entryId: successor.entry.id, standing: true }, { apply: true, explicit: true }).outcome, "pinned");
const contradiction = store.upsert({ kind: "risk", title: "Integration boundary contradiction", content: "A reviewed conflict remains unresolved for this standing constraint.", verification: "verified", contradicts: [successor.entry.id] }, { apply: true, explicit: true });
assert.equal(contradiction.outcome, "saved");
assert.equal(store.standingProjection().items.some((item) => item.id === successor.entry.id), false, "contradicted entries fail closed out of standing context");
const expired = store.upsert({ kind: "constraint", title: "Expired standing candidate", content: "This historical constraint is no longer active.", verification: "verified", expiresAt: "2025-01-01T00:00:00.000Z" }, { apply: true, explicit: true });
assert.equal(expired.outcome, "saved");
assert.equal(store.setStanding({ entryId: expired.entry.id, standing: true }, { apply: true, explicit: true }).reason, "stale", "expired entries cannot become standing context");

const unverified = store.upsert({ kind: "constraint", title: "Unverified instruction", content: "This item must not become standing context.", verification: "unverified" }, { apply: true, explicit: true });
assert.equal(unverified.outcome, "saved-labeled");
const rejected = store.setStanding({ entryId: unverified.entry.id, standing: true }, { apply: true, explicit: true });
assert.equal(rejected.outcome, "rejected");
assert.equal(rejected.reason, "unverified");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("project memory standing tests passed");
