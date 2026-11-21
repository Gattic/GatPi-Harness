"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { ProjectMemoryDecisionStore } = require("../src/project-memory-decisions");
const { tmpFixture } = require("./helpers/tmp-fixture");

// Direct ledger contract: the session hash comes from a provider, so a boundary
// cached across sessions still records the session that produced each decision.
const directCwd = tmpFixture("project-memory-decision-provenance-");
let liveSessionHash = "a".repeat(16);
const direct = new ProjectMemoryDecisionStore({ cwd: directCwd, clock: () => new Date("2026-11-20T00:00:00Z"), sessionIdHash: () => liveSessionHash });
const explicit = direct.record({ projectKey: "pi:fixture:abcd", kind: "decision", action: "saved", reason: "explicit-save", verification: "verified" });
assert.equal(explicit.automatic, false);
assert.equal(explicit.sessionIdHash, "a".repeat(16));
liveSessionHash = "b".repeat(16);
const automatic = direct.record({ projectKey: "pi:fixture:abcd", kind: "decision", action: "saved", reason: "verified-durable", verification: "verified", automatic: true });
assert.equal(automatic.automatic, true);
assert.equal(automatic.sessionIdHash, "b".repeat(16), "the provider is read at record time, not at construction");
assert.notEqual(automatic.decisionId, explicit.decisionId, "provenance is part of decision identity");

// A caller-supplied hash wins, and a malformed hash is never persisted.
const pinned = direct.record({ projectKey: "pi:fixture:abcd", kind: "decision", action: "shadowed", reason: "shadow-mode", sessionIdHash: "c".repeat(16) });
assert.equal(pinned.sessionIdHash, "c".repeat(16));
const malformed = direct.record({ projectKey: "pi:fixture:abcd", kind: "decision", action: "rejected", reason: "transient", sessionIdHash: "not-a-hash" });
assert.equal(malformed.sessionIdHash, null);
assert.equal(malformed.automatic, false, "an unmarked write is never reported as automatic");

// End-to-end through the store: automatic writes and cited recall handles reach
// the ledger the rollout gates read.
const tmp = tmpFixture("project-memory-store-provenance-");
const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault");
fs.mkdirSync(cwd); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const store = new ProjectMemoryStore({ cwd, vault, writeEnabled: true, clock: () => new Date("2026-11-20T00:00:00Z"), sessionIdHash: () => "d".repeat(16) });
const cited = ["e".repeat(64), "f".repeat(64)];
const explicitSave = store.upsert({ kind: "decision", title: "Cited explicit save", content: "Saved with recalled handles cited.", verification: "verified", evidenceIds: cited }, { apply: true, explicit: true });
assert.equal(explicitSave.outcome, "saved");
assert.equal(explicitSave.decision.automatic, false);
assert.equal(explicitSave.decision.sessionIdHash, "d".repeat(16));
assert.deepEqual(explicitSave.decision.evidenceIds, cited, "cited recall handles persist into the decision");

const automaticSave = store.consider({ kind: "constraint", title: "Automatic constraint", content: "Captured automatically from a verified outcome.", verification: "verified" }, { automatic: true, apply: true });
assert.equal(automaticSave.outcome, "saved");
assert.equal(automaticSave.decision.automatic, true);
assert.equal(automaticSave.decision.sessionIdHash, "d".repeat(16));

const shadowed = store.upsert({ kind: "procedure", title: "Shadowed procedure", content: "Not applied at this stage.", verification: "unverified" }, { apply: false });
assert.equal(shadowed.outcome, "shadowed");
assert.equal(shadowed.decision.automatic, false, "a shadowed write is not an automatic save");

const ledger = fs.readFileSync(path.join(cwd, ".pi", "project-memory", "decisions.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
assert(ledger.every((row) => row.sessionIdHash === "d".repeat(16)), "every store decision records the session");
assert.equal(ledger.filter((row) => row.automatic).length, 1, "only the automatic save is marked automatic");
assert(!ledger.some((row) => JSON.stringify(row).includes("Saved with recalled handles cited")), "the ledger stores provenance, not content");

console.log("project-memory decision provenance tests passed");
