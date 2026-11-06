"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildHermesIntegrationScorecard } = require("../src/hermes-integration-scorecard.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function jsonl(file, rows) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`); }
const empty = tmpFixture("pi-hermes-scorecard-empty-");
const deferred = buildHermesIntegrationScorecard({ cwd: empty });
assert.equal(deferred.decision, "NO-GO-DEFERRED");
assert.equal(deferred.gates.assistant.status, "insufficient-data");
assert.equal(deferred.experimentStatus.E3ParallelEvidence, "NULL-RESULT");
assert.equal(deferred.authority.automaticMutationAllowed, false);

const cwd = tmpFixture("pi-hermes-scorecard-pass-");
const base = Date.parse("2026-08-01T00:00:00.000Z");
const events = [];
for (let index = 0; index < 30; index++) events.push({ schemaVersion: 1, receiptId: `receipt-${index}`, at: new Date(base + index * 12 * 60 * 60 * 1000).toISOString(), sourceVersion: "exact-test-v1", operation: index % 2 ? "plan" : "review", outcome: "succeeded", category: "ready", durationMs: 1000 + index, schemaValid: true, repairTurns: 0, privacyViolations: 0, mutation: "none", sessionHash: `sha256:session-${index % 10}`, identityKey: "fake-hermes:provider:model", accepted: null });
for (let index = 0; index < 10; index++) events.push({ schemaVersion: 1, receiptId: `receipt-${index}`, at: new Date(base + index * 1000 + 1).toISOString(), sourceVersion: "exact-test-v1", operation: index % 2 ? "plan" : "review", outcome: index < 8 ? "accepted" : "rejected", category: "user-disposition", durationMs: 0, schemaValid: true, repairTurns: 0, privacyViolations: 0, mutation: "none", sessionHash: null, identityKey: "fake-hermes:provider:model", accepted: index < 8 });
for (let index = 0; index < 10; index++) events.push({ schemaVersion: 1, receiptId: `curation-${index}`, at: new Date(base + index * 1000).toISOString(), sourceVersion: "exact-test-v1", operation: "curateCandidate", outcome: index === 9 ? "timed-out" : "succeeded", category: index === 9 ? "timeout" : "ready", durationMs: 2000, schemaValid: index !== 9, repairTurns: 0, privacyViolations: 0, mutation: "none", sessionHash: `sha256:memory-${index}`, identityKey: "fake-hermes:provider:model", accepted: null });
jsonl(path.join(cwd, ".pi", "hermes-advisory", "events.jsonl"), events);
const obsidianStateFile = path.join(cwd, ".pi", "obsidian", "state.json"); fs.mkdirSync(path.dirname(obsidianStateFile), { recursive: true }); fs.writeFileSync(obsidianStateFile, JSON.stringify({ events: Array.from({ length: 10 }, (_, index) => ({ at: new Date(base + index * 1000 + 2).toISOString(), operation: "hermes-review-outcome", curationReceiptId: `curation-${index}`, decision: index < 9 ? "accept" : "reject", receiptBound: true })) }));
jsonl(path.join(cwd, ".pi", "cognitive-automation", "skills", "metrics.jsonl"), [{ type: "skill.hermes_draft", skillId: "skill-1", candidateId: "hermes_skill_123456789abc", receiptId: "receipt-skill" }]);
const candidateDir = path.join(cwd, ".pi", "hermes-skill-candidates", "hermes_skill_123456789abc"); fs.mkdirSync(candidateDir, { recursive: true });
fs.writeFileSync(path.join(candidateDir, "SKILL.md"), "---\nname: scorecard-skill\ndescription: Use for scorecard fixture workflows.\n---\n\n# Scorecard skill\n\n1. Verify evidence.\n");
fs.writeFileSync(path.join(candidateDir, "provenance.json"), JSON.stringify({ schemaVersion: 1, status: "quarantined", createdAt: "2026-08-01T00:00:00Z", hermesReceiptId: "receipt-skill", hermesSourceVersion: "exact-test-v1" }));
const { CompoundingEffectivenessAdapter } = require("../src/compounding-effectiveness.js");
const compoundingFile = new CompoundingEffectivenessAdapter({ cwd }).latestFile;
fs.mkdirSync(path.dirname(compoundingFile), { recursive: true });
fs.writeFileSync(compoundingFile, JSON.stringify({ gates: { C5: { status: "pass" } } }));
const passed = buildHermesIntegrationScorecard({ cwd, advisorySourceVersion: "exact-test-v1" });
assert.equal(passed.gates.assistant.status, "pass");
assert.equal(passed.gates.memory.status, "pass");
assert.equal(passed.gates.skills.status, "pass");
assert.equal(passed.decision, "advisory-field-gates-passed-manual-only");
assert.equal(passed.authority.automaticRoutingAllowed, false);
assert.equal(passed.authority.automaticRoutingReason, "E3-NULL-RESULT");
assert.equal(passed.authority.automaticCanonicalPromotionAllowed, false);
assert.equal(passed.authority.automaticMutationAllowed, false);
assert.equal(passed.privacy.recordedViolations, 0);
fs.writeFileSync(compoundingFile, JSON.stringify({ gates: { C5: { status: "insufficient-data" } } }));
const insufficient = buildHermesIntegrationScorecard({ cwd, advisorySourceVersion: "exact-test-v1" });
assert.equal(insufficient.experimentStatus.C5MemoryLearning, "insufficient-data");
assert.equal(insufficient.authority.automaticSkillDraftAllowed, false);
fs.rmSync(compoundingFile);
assert.equal(buildHermesIntegrationScorecard({ cwd, advisorySourceVersion: "exact-test-v1" }).experimentStatus.C5MemoryLearning, "NULL-RESULT");
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log("Hermes integration scorecard tests passed");
