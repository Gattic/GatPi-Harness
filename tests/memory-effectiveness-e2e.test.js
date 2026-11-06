"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadJson, buildScorecard } = require("../src/memory-effectiveness");
const { ProjectMemoryIndex } = require("../src/project-memory-index");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { openThread, recordAttempt, resolveThread } = require("../src/debug-ledger");
const { recallFixes } = require("../src/fix-recall");
const { tmpFixture } = require("./helpers/tmp-fixture");

const manifest = loadJson(path.join(__dirname, "fixtures", "memory-effectiveness", "manifest.json")); const now = Date.now();
const index = new ProjectMemoryIndex({ now: () => now, entries: [
  { id: "prior-memory-audit", kind: "history", title: "Session memory Obsidian effectiveness investigation", content: "Prior audit of session memory saving recall and Obsidian effectiveness.", verification: "verified", updatedAt: new Date(now).toISOString() },
  { id: "canonical-obsidian-decision", kind: "decision", title: "Canonical durable authority", content: "Obsidian project memory is the canonical durable authority.", verification: "verified", updatedAt: new Date(now - 1).toISOString() },
  { id: "root-a-constraint", kind: "constraint", title: "Project constraint", content: "Project constraint belongs only to root A.", verification: "verified", updatedAt: new Date(now - 2).toISOString() },
] });
const retrievalResults = [];
for (const item of manifest.retrievalCases.filter((row) => row.id !== "known-fix-verbose-thread")) { const found = index.search(item.queryTerms.join(" "), { limit: 5 }); retrievalResults.push({ id: item.id, rankedIds: found.items.map((row) => row.id) }); }
const fixCwd = tmpFixture("memory-effectiveness-fix-"); const thread = openThread(fixCwd, "Hermes advisory timeout after fresh install");
for (let index = 0; index < 30; index++) recordAttempt(fixCwd, thread.threadId, { hypothesis: `verbose unrelated arm ${index}`, change: `unrelated change ${index}`, observation: `unrelated observation ${index}`, verdict: "no-change" });
recordAttempt(fixCwd, thread.threadId, { hypothesis: "readiness proof expired", change: "refresh current proof and retry off path", observation: "Hermes advisory completed", verdict: "fixed" }); resolveThread(fixCwd, thread.threadId, "refresh current readiness proof before off-path retry");
const fix = recallFixes(fixCwd, "hermes recall timeout fresh install", { record: false, limit: 5 }); retrievalResults.push({ id: "known-fix-verbose-thread", rankedIds: fix.matches.map((row) => row.id === thread.threadId ? "hermes-timeout-thread" : row.id) });

const tmp = tmpFixture("memory-effectiveness-save-"); const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault"); fs.mkdirSync(cwd); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true }); const store = new ProjectMemoryStore({ cwd, vault, writeEnabled: true });
const verified = store.upsert({ kind: "decision", title: "Verified decision", content: "Obsidian is canonical project memory.", verification: "verified" }, { apply: true, explicit: true });
const unverified = store.upsert({ kind: "constraint", title: "Explicit preference", content: "Prefer compact summaries.", verification: "unverified" }, { apply: true, explicit: true });
const duplicate = store.upsert({ kind: "decision", title: "Verified decision", content: "Obsidian is canonical project memory.", verification: "verified" }, { apply: true, explicit: true });
const conflict = store.upsert({ kind: "decision", title: "Verified decision", content: "A conflicting authority claim.", verification: "verified" }, { apply: true, explicit: true });
const transient = store.upsert({ kind: "history", title: "Current branch", content: "Current Git branch is feature.", verification: "verified" }, { apply: true, explicit: true });
const recovered = store.consider({ kind: "history", title: "Recovered failure", content: "The build failed and recovered after retry.", verification: "verified" }, { automatic: true, apply: true });
const secret = store.upsert({ kind: "history", title: "Secret", content: `sk-${"A".repeat(32)}`, verification: "verified" }, { apply: true, explicit: true });
const transcript = store.upsert({ kind: "history", title: "Transcript", content: '<pi-session-transcript>[redacted synthetic marker]</pi-session-transcript>', verification: "verified" }, { apply: true, explicit: true });
const saveResults = [verified, unverified, duplicate, conflict, transient, recovered, secret, transcript].map((result, index) => ({ id: manifest.saveCases[index].id, outcome: result.outcome }));
const durations = []; for (let run = 0; run < 30; run++) durations.push(index.search("session memory Obsidian effectiveness", { limit: 5 }).durationMs); durations.sort((a, b) => a - b);
const scorecard = buildScorecard({ manifest, source: { revision: "fixture", configHash: "fixture", activeSessionExclusion: { requested: 1, matched: 1, excluded: 1, unmatched: 0 } }, retrievalResults, saveResults, performance: { localRecallP95Ms: durations[Math.ceil(durations.length * 0.95) - 1], localRecallSamples: durations.length }, field: { independentSessions: 0, observedDays: 0, currentFactStaleRate: 0 }, privacy: { evidenceId: "privacy-evidence:fixture", scanId: "privacy-scan:fixture", evidenceQualified: true, unresolvedHighSeverity: 0, unresolvedActionable: 0, reviewedCandidates: 8, candidateCount: 8 }, curation: { attempts: 1, successRate: 1, timeoutRate: 0, p95Ms: 10 }, migration: { previewPassed: true, rollbackPassed: true, fixtures: 1 } });
assert.equal(scorecard.scores.retrievalPrecisionAt5.status, "pass");
assert.equal(scorecard.scores.retrievalRecallAt5.status, "pass");
assert.equal(scorecard.aggregates.retrieval.cases.find((row) => row.id === "repeated-memory-audit").passed, true);
assert.equal(scorecard.scores.explicitSavePrecision.status, "pass");
assert.equal(scorecard.scores.localRecallP95Ms.status, "pass");
assert.equal(scorecard.scores.exactVersionSessions.status, "insufficient-data");
assert.equal(scorecard.decision, "no-go-deferred");
assert.equal(scorecard.automaticBehaviorAuthorized, false);

console.log("memory effectiveness end-to-end tests passed");
