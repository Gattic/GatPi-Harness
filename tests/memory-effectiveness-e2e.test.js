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
const ROOT_A = "root-a"; const ROOT_B = "root-b";
// Ranked recall must choose among competing candidates, not return the only entry
// that matches. Each case seeds a top-5 that must be exactly its relevant set while
// distractors that also cover the query terms are pushed out of the window. The
// distractors are newer, so a scoring regression cannot hide behind a recency tie.
const memory = (root, id, kind, title, content, ageMs) => ({ root, id, kind, title, content, verification: "verified", updatedAt: new Date(now - ageMs).toISOString() });
const index = new ProjectMemoryIndex({ now: () => now, entries: [
  // repeated-memory-audit: five entries cover all four query terms, two distractors cover three.
  memory(ROOT_A, "prior-memory-audit", "history", "Session memory Obsidian effectiveness investigation", "Prior audit of session memory saving recall and Obsidian effectiveness.", 9000),
  memory(ROOT_A, "compaction-effectiveness", "history", "Compaction effectiveness", "Compaction effectiveness review of session memory and obsidian export.", 8000),
  memory(ROOT_A, "memory-cache-sizing", "risk", "Memory cache sizing", "Memory cache sizing for obsidian notes; session effectiveness unknown.", 7000),
  memory(ROOT_A, "obsidian-vault-layout", "procedure", "Obsidian vault layout", "Obsidian vault folders hold session notes; memory effectiveness not evaluated.", 6000),
  memory(ROOT_A, "session-transcript-pruning", "procedure", "Session transcript pruning", "Session transcript pruning bounds memory growth; obsidian effectiveness unmeasured.", 5000),
  memory(ROOT_A, "risk-memory-pressure", "risk", "Memory pressure", "Memory pressure from session logs; obsidian notes trimmed.", 0),
  memory(ROOT_A, "risk-effectiveness-gap", "risk", "Effectiveness gap", "Effectiveness gap in obsidian reporting; memory unmeasured.", 1000),
  memory(ROOT_A, "procedure-session-audit", "procedure", "Session audit", "Session audit of obsidian exports.", 2000),
  // canonical-authority: five entries cover all three terms, one distractor covers two.
  memory(ROOT_A, "canonical-obsidian-decision", "decision", "Canonical durable authority", "Obsidian project memory is the canonical durable authority.", 9000),
  memory(ROOT_A, "authority-delegation", "decision", "Authority delegation", "Authority delegation across sessions; the canonical store is durable across restarts.", 8000),
  memory(ROOT_A, "durable-store-choice", "decision", "Durable store choice", "Durable store choice; the canonical vault holds authority claims.", 7000),
  memory(ROOT_A, "canonical-naming", "procedure", "Canonical naming", "Canonical naming rules for durable notes; authority stays with the vault.", 6000),
  memory(ROOT_A, "authority-boundaries", "constraint", "Authority boundaries", "Authority boundaries between canonical memory and durable notes.", 5000),
  memory(ROOT_A, "session-authority", "history", "Session authority", "Session authority is advisory; canonical memory wins.", 0),
  memory(ROOT_A, "risk-durable-retention", "risk", "Durable retention risk", "Durable retention risk for archived notes.", 1000),
  memory(ROOT_A, "procedure-canonical-export", "procedure", "Canonical export procedure", "Canonical export procedure for vault notes.", 2000),
  // same-name-project-isolation: root A's five constraints carry the exact phrase, and
  // root B holds identically named constraints that must never enter root A's window.
  memory(ROOT_A, "root-a-constraint", "constraint", "Project constraint", "Project constraint belongs only to root A.", 9000),
  memory(ROOT_A, "root-a-build-constraint", "constraint", "Project constraint build", "Project constraint build applies only to root A.", 8000),
  memory(ROOT_A, "root-a-review-constraint", "constraint", "Project constraint review", "Project constraint review applies only to root A.", 7000),
  memory(ROOT_A, "root-a-release-constraint", "risk", "Project constraint release", "Project constraint release applies only to root A.", 6000),
  memory(ROOT_A, "root-a-merge-constraint", "constraint", "Project constraint merge", "Project constraint merge applies only to root A.", 5000),
  memory(ROOT_A, "root-a-cache-rule", "procedure", "Cache rule", "Constraint on project cache is advisory.", 0),
  memory(ROOT_A, "root-a-merge-rule", "procedure", "Merge rule", "Constraint on project merge is advisory.", 1000),
  memory(ROOT_B, "root-b-constraint", "constraint", "Project constraint", "Project constraint belongs only to root B.", 0),
  memory(ROOT_B, "root-b-build-constraint", "constraint", "Project constraint build", "Project constraint build applies only to root B.", 1000),
] });
const unscoped = index.search("project constraint", { limit: 5 });
assert.ok(unscoped.items.some((row) => row.id === "root-b-constraint"), "the unscoped index surfaces the same-named project's constraint, so the scoped isolation case can actually fail");
const retrievalResults = [];
for (const item of manifest.retrievalCases.filter((row) => row.id !== "known-fix-verbose-thread")) {
  const found = index.search(item.queryTerms.join(" "), { limit: 5, root: item.scopeRoot });
  assert.ok(found.candidates > item.requiredTopK, `${item.id} must rank against more candidates than requiredTopK (${found.candidates} vs ${item.requiredTopK})`);
  assert.ok(found.items.every((row) => row.root === item.scopeRoot), `${item.id} must stay inside its project root`);
  retrievalResults.push({ id: item.id, rankedIds: found.items.map((row) => row.id) });
}
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
// The aggregate bars tolerate a single miss out of sixteen relevant ids, so assert
// every case individually: a case that silently drops its relevant set must fail.
for (const row of scorecard.aggregates.retrieval.cases) assert.equal(row.passed, true, `${row.id} must retrieve its relevant set within requiredTopK`);
assert.equal(scorecard.scores.explicitSavePrecision.status, "pass");
assert.equal(scorecard.scores.localRecallP95Ms.status, "pass");
assert.equal(scorecard.scores.exactVersionSessions.status, "insufficient-data");
assert.equal(scorecard.decision, "no-go-deferred");
assert.equal(scorecard.authority, "reporting-only");
assert.equal(scorecard.automaticBehaviorAuthorized, undefined, "the scorecard no longer authorizes automatic behavior");

console.log("memory effectiveness end-to-end tests passed");
