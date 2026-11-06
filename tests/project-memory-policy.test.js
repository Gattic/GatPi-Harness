"use strict";
const assert = require("node:assert/strict");
const { classifyProjectMemoryCandidate } = require("../src/project-memory-policy");
function classify(content, options = {}, overrides = {}) { return classifyProjectMemoryCandidate({ kind: "decision", title: "Fixture", content, verification: "verified", ...overrides }, options); }
assert.equal(classify("Use Obsidian as canonical memory.", { explicit: true }).label, "saved");
assert.equal(classify("A user-reviewed but uncertain preference.", { explicit: true }, { verification: "unverified" }).label, "saved-labeled");
assert.deepEqual(classify("Current Git branch is main.", { explicit: true }).action, "reject");
assert.equal(classify("Tests passed.", { automatic: true }).action, "reject");
assert.equal(classify("The failure recovered and now passes.", { automatic: true }).action, "reject");
assert.equal(classify("Maybe this architecture is optimal.", { automatic: true }, { verification: "inferred" }).action, "review");
assert.equal(classify("A reviewed invariant controls writes.", { automatic: true }).action, "save");
assert.equal(classify(`Secret ${"sk-" + "A".repeat(32)}`, { explicit: true }).reason, "sensitive");
assert.equal(classify('<pi-session-transcript>[redacted synthetic marker]</pi-session-transcript>', { explicit: true }).reason, "full-transcript");
console.log("project memory policy tests passed");
