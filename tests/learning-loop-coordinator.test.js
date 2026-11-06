#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  LearningStore,
  createOutcome,
  minePatterns,
  proposeImprovements,
  reviewProposalWithLocalChecks,
  applyProposalDryRun,
  ingestLearningSources,
} = require("../src/learning-loop");
const { tmpFixture } = require("./helpers/tmp-fixture");

const source = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "learning-loop-coordinator", "index.ts"), "utf8");
assert.match(source, /const AUTO_INGEST = process\.env\.PI_LEARNING_AUTO_INGEST !== "0"/);
assert.match(source, /instrumentExtensionCommands/, "learning-loop commands should emit privacy-safe invocation outcomes");
assert.match(source, /PI_LEARNING_AUTO_INGEST_SOURCES \|\| "verification"/, "legacy aggregate goal ingestion is no longer the default");
assert.match(source, /ExecutionOutcomeAdapter, LearningLoopAdapter/, "settled execution ingestion uses integration-boundary adapters");
assert.match(source, /PI_EXECUTION_OUTCOME_LEARNING/, "packet-to-learning dispatch has an independent rollback flag");
assert.match(source, /pi\.on\("session_start"/, "packet index drains at session start");
assert.match(source, /drainSettledExecutions/, "packet index drains through an idempotent consumer receipt");
assert.match(source, /Type\.Literal\("execution"\)/, "execution is an allowlisted learning source");
assert.ok(source.indexOf('if (AUTO_INGEST)') >= 0, "auto ingestion must remain explicitly gated");
assert.match(source, /if \(AUTO_INGEST\) \{[\s\S]*pi\.on\("agent_end"/, "legacy aggregate auto-ingestion remains gated separately from packet draining");
assert.doesNotMatch(source, /pi\.on\("agent_start"/);
assert.doesNotMatch(source, /require\([^\n]*execution-outcome/, "coordinator does not import the outcome store directly");
assert.match(source, /autoApply: false/);
assert.match(source, /learning-apply/);
assert.match(source, /learning-verify/);
assert.match(source, /learning-scan-sessions/);
assert.match(source, /learning-session-report/);
assert.match(source, /learning-patterns/);
assert.match(source, /learning-rate-outcome/);
assert.match(source, /learning-benchmark/);
assert.match(source, /learning-context-attribution/);
assert.match(source, /learning-model-router/);
assert.match(source, /learning-experiment/);
assert.match(source, /learning-refactor-propose/);
assert.match(source, /learning-memory-summary/);
assert.match(source, /Type\.Literal\("verify"\)/);
assert.match(source, /Type\.Literal\("sessionScan"\)/);
assert.match(source, /Type\.Literal\("sessionReport"\)/);
assert.match(source, /Type\.Literal\("minePatterns"\)/);
assert.match(source, /Type\.Literal\("benchmark"\)/);
assert.match(source, /Type\.Literal\("contextAttribution"\)/);
assert.match(source, /Type\.Literal\("modelRouter"\)/);
assert.match(source, /Type\.Literal\("refactorPropose"\)/);
assert.match(source, /recordPatterns\(patterns\)/);
assert.match(source, /record-applied/);
assert.match(source, /dry-run/);

const tmp = tmpFixture("pi-learning-coordinator-");
const store = new LearningStore({ cwd: tmp, clock: () => "2026-05-21T02:00:00.000Z" });
fs.mkdirSync(path.join(tmp, ".pi", "verification-center"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".pi", "verification-center", "latest.json"), JSON.stringify({
  profile: "changed",
  commands: [{ command: "node", args: ["tests/learning-loop.test.js"] }],
  evidence: { id: "proof_latest", ok: true, confidence: 0.91, changeSet: { changedFiles: ["src/learning-loop.js"] } },
}, null, 2));
const ingested = ingestLearningSources(tmp, "verification", { store });
assert.equal(ingested.recorded, 1);
assert.equal(store.listOutcomes({ source: "verification" }).length, 1);

const outcomeA = store.recordOutcome(createOutcome({
  source: "verification",
  task: { summary: "Run targeted learning loop check" },
  summary: "targeted test passed after source edit",
  signals: { status: "succeeded", evidenceLevel: "tool-output", commands: ["node tests/learning-loop.test.js"] },
  artifacts: { changedFiles: ["src/learning-loop.js"], evidenceRefs: ["proof_a"] },
}));
const outcomeB = store.recordOutcome(createOutcome({
  source: "verification",
  task: { summary: "Run targeted learning loop check again" },
  summary: "targeted test passed after source edit again",
  signals: { status: "succeeded", evidenceLevel: "tool-output", commands: ["node tests/learning-loop.test.js"] },
  artifacts: { changedFiles: ["src/learning-loop.js"], evidenceRefs: ["proof_b"] },
}));
assert.notEqual(outcomeA.outcomeId, outcomeB.outcomeId);

const patterns = minePatterns(store.listOutcomes(), { minOutcomesForPattern: 2 });
const proposals = proposeImprovements(patterns, { changedFiles: ["src/learning-loop.js"], testCommands: ["node tests/learning-loop.test.js"] });
assert.ok(proposals.length >= 1, "coordinator flow should create proposal candidates from mined outcomes");
const proposal = store.createProposal(proposals[0]);
const reviewed = reviewProposalWithLocalChecks(proposal, { cwd: tmp });
assert.equal(reviewed.review.ready, true);
assert.equal(reviewed.status, "ready_for_review");
const dryRun = applyProposalDryRun(reviewed);
assert.equal(dryRun.dryRun, true);
assert.match(dryRun.message, /Dry run only/);
assert.ok(store.status().outcomes >= 2);

console.log("learning-loop coordinator behavior tests passed");
