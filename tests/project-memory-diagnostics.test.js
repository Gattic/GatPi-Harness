"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout");
const { ProjectMemoryCandidatePipeline } = require("../src/project-memory-candidates");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = tmpFixture("pi-memory-diagnostics-");
try {
  const rollout = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M5", PI_PROJECT_MEMORY_DIAGNOSTICS: "1", PI_PROJECT_MEMORY_AUTO_SAVE: "1" }, {});
  assert.equal(rollout.effectiveStage, "M0");
  assert.equal(rollout.controls.diagnosticCapture, true);
  for (const control of ["explicitWrites", "taskRecall", "candidateCapture", "reviewQueueWrites", "hermesCuration", "automaticVerifiedUpserts"]) assert.equal(rollout.controls[control], false, control);
  const pipeline = new ProjectMemoryCandidatePipeline({ cwd: root, rollout, projectMemory: { enabled: true, consider() { throw new Error("diagnostics must not invoke candidate/mutation authority"); } } });
  pipeline.observePrompt("Remember this project decision: PRIVATE_SENTINEL.");
  pipeline.observeCorrection("Actually, all canonical memory writes must require explicit apply.");
  const durable = [{ id: "entry-1", type: "procedural", title: "PRIVATE_SENTINEL", content: "Verify changes before publishing.", verification: "verified", tags: ["procedure"], provenance: { source: "explicit-review" } }, { id: "scratch", type: "episodic" }];
  pipeline.settle(durable);
  pipeline.settle([]);
  pipeline.settle(durable);
  const file = path.join(root, ".pi", "project-memory", "diagnostics.jsonl");
  const text = fs.readFileSync(file, "utf8"); const rows = text.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 5);
  assert.equal(rows[2].scanned, 2);
  assert.equal(rows[2].diagnosticOnly, true);
  assert.equal(rows[2].candidateHashes.length, 1, "the first settle reports the new durable candidate");
  assert.equal(rows[2].alreadySeen, 0);
  assert.equal(rows[3].scanned, 0, "zero-opportunity turns are measured, not omitted");
  assert.equal(rows[4].candidateHashes.length, 0, "a repeated candidate is not re-reported as new");
  assert.equal(rows[4].alreadySeen, 1);
  assert(rows.every((row) => row.automaticSave === false));
  const operator = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M1", PI_PROJECT_MEMORY_WRITES: "1", PI_PROJECT_MEMORY_AUTOMATIC: "1", PI_PROJECT_MEMORY_AUTO_SAVE: "1", PI_PROJECT_MEMORY_DIAGNOSTICS: "1" }, {});
  assert.equal(operator.stageAuthority, "operator-opt-in");
  const operatorPipeline = new ProjectMemoryCandidatePipeline({ cwd: path.join(root, "operator"), rollout: operator, projectMemory: { enabled: true, consider() { throw new Error("diagnostics must not invoke candidate/mutation authority"); } } });
  operatorPipeline.settle([]);
  const operatorRow = JSON.parse(fs.readFileSync(path.join(root, "operator", ".pi", "project-memory", "diagnostics.jsonl"), "utf8").trim());
  assert.equal(operatorRow.automaticSave, true, "diagnostics reflect the real automatic-save control");
  assert.doesNotMatch(text, /PRIVATE_SENTINEL|Verify changes|canonical memory writes/);
  const stateFile = path.join(root, ".pi", "project-memory", "candidate-state.json");
  assert.equal(fs.existsSync(stateFile), true, "dedupe state persists even without candidate authority");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.seenFingerprints.length, 0, "diagnostic-only settlement does not consume promotion fingerprints");
  assert.equal(state.diagnosticSeenFingerprints.length, 1);
  assert.match(state.diagnosticSeenFingerprints[0], /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SENTINEL|Verify changes|canonical memory writes/);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { buildLoopOutcomePacket, sha256 } = require("../src/execution-outcome");
  const packet = buildLoopOutcomePacket({ runId: "loop_diagnostic", sourceSchemaVersion: 3, sourceRecord: { id: "loop_diagnostic", status: "completed" }, terminalState: "completed", taskHash: sha256("private task"), evidenceRefs: ["evidence_fixture"], producerVersion: "fixture", projectKeyHash: sha256("project"), settledAt: new Date().toISOString() });
  pipeline.captureExecutionReference(packet);
  assert.equal(fs.existsSync(path.join(root, ".pi", "project-memory", "execution-candidates")), false, "diagnostic references are not M3 candidate capture");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)).kind, "execution-reference");
  for (const env of [{}, { PI_PROJECT_MEMORY_DIAGNOSTICS: "0" }, { PI_PROJECT_MEMORY: "0", PI_PROJECT_MEMORY_DIAGNOSTICS: "1" }]) assert.equal(resolveProjectMemoryRollout(env).controls.diagnosticCapture, false);
  const disabled = new ProjectMemoryCandidatePipeline({ cwd: path.join(root, "off"), rollout: resolveProjectMemoryRollout({}) });
  disabled.observePrompt("Remember this project decision."); disabled.settle([]);
  assert.equal(fs.existsSync(path.join(root, "off")), false);

  // Repeats never consume the new-candidate budget: with one slot per settle, a
  // durable candidate behind already-seen ones is still reported.
  const scanRoot = path.join(root, "scan");
  const scanRollout = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_DIAGNOSTICS: "1" });
  const scan = new ProjectMemoryCandidatePipeline({ cwd: scanRoot, rollout: scanRollout, maxPerSettle: 1 });
  const durableEntry = (index) => ({ id: `entry-${index}`, type: "procedural", title: `Procedure ${index}`, content: `Run the verification gate before publishing ${index}.`, verification: "verified", tags: ["procedure"], provenance: { source: "explicit-review" } });
  for (let pass = 0; pass < 4; pass++) scan.settle([durableEntry(0), durableEntry(1), durableEntry(2)]);
  const scanRows = fs.readFileSync(path.join(scanRoot, ".pi", "project-memory", "diagnostics.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((row) => row.kind === "settle");
  assert.equal(scanRows.length, 4);
  assert.deepEqual(scanRows.map((row) => row.candidateHashes.length), [1, 1, 1, 0], "each pass reports at most one new candidate, and later ones are not starved");
  assert.deepEqual(scanRows.map((row) => row.alreadySeen), [0, 1, 2, 3]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scanRoot, ".pi", "project-memory", "candidate-state.json"), "utf8")).diagnosticSeenFingerprints.length, 3);

  // Review requests are append-only, so they need explicit resolution
  // accounting; otherwise the backlog only ever grows.
  const { diagnosticReviewSummary } = require("../src/project-memory-store");
  const { resolveDiagnosticReview, readDiagnosticReviewRequests } = require("../src/project-memory-candidates");
  const reviewState = path.join(root, "review", ".pi", "project-memory");
  fs.mkdirSync(reviewState, { recursive: true });
  const reviewFile = path.join(reviewState, "diagnostics.jsonl");
  // Fixture timestamps are relative to this run: the diagnostic stream retains
  // only the last 30 days, so hard-coded dates silently expire mid-test and
  // make the resolution accounting depend on the wall clock.
  const reviewNow = Date.now();
  const reviewAt = (daysAgo) => new Date(reviewNow - daysAgo * 86400000).toISOString();
  const oldestRequestAt = reviewAt(9);
  const middleRequestAt = reviewAt(3);
  const newestRequestAt = reviewAt(1);
  const reviewRows = [
    { schemaVersion: 1, kind: "history", at: oldestRequestAt, status: "requires-explicit-curator-review", sourceHash: "sha256:a" },
    { schemaVersion: 1, kind: "procedure", at: middleRequestAt, status: "requires-explicit-curator-review", sourceHash: "sha256:b" },
    { schemaVersion: 1, kind: "explicit-request", at: newestRequestAt, status: "requires-explicit-curator", promptHash: "sha256:c" },
  ];
  fs.writeFileSync(reviewFile, `${reviewRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  assert.deepEqual({ rows: diagnosticReviewSummary(reviewState).rows, unresolved: diagnosticReviewSummary(reviewState).unresolved }, { rows: 3, unresolved: 3 });
  const pending = readDiagnosticReviewRequests(reviewState);
  assert.equal(pending.requests.length, 3);
  const preview = resolveDiagnosticReview({ stateDir: reviewState, keys: [pending.requests[0].key] });
  assert.equal(preview.outcome, "preview");
  assert.equal(preview.resolvable, 1);
  assert.equal(fs.readFileSync(reviewFile, "utf8").trim().split("\n").length, 3, "a preview writes no resolution row");
  const applied = resolveDiagnosticReview({ stateDir: reviewState, keys: [pending.requests[0].key], apply: true });
  assert.equal(applied.outcome, "resolved");
  assert.equal(applied.resolved, 1);
  const after = diagnosticReviewSummary(reviewState);
  assert.deepEqual({ rows: after.rows, resolved: after.resolved, unresolved: after.unresolved }, { rows: 3, resolved: 1, unresolved: 2 });
  assert.equal(after.oldestUnresolvedAt, middleRequestAt, "the oldest unresolved request moves forward after resolution");
  assert.equal(after.unresolvedByKind.history, undefined);
  const repeat = resolveDiagnosticReview({ stateDir: reviewState, keys: [pending.requests[0].key], apply: true });
  assert.equal(repeat.outcome, "not-applicable");
  assert.deepEqual(repeat.alreadyResolved, [pending.requests[0].key]);
  const unknown = resolveDiagnosticReview({ stateDir: reviewState, keys: ["history|never|sha256:z"], apply: true });
  assert.equal(unknown.outcome, "not-applicable");
  assert.deepEqual(unknown.unknownKeys, ["history|never|sha256:z"]);
  assert.equal(resolveDiagnosticReview({ stateDir: reviewState, keys: [] }).outcome, "rejected");
  // Caller-supplied input is bounded: a huge reason must not produce an
  // oversized diagnostic record, duplicate keys must not double-append, and a
  // long key list must not write an unbounded number of rows.
  const longReason = resolveDiagnosticReview({ stateDir: reviewState, keys: [pending.requests[1].key, pending.requests[1].key], reason: `\u0007${"x".repeat(5000)}`, apply: true });
  assert.equal(longReason.outcome, "resolved");
  assert.equal(longReason.resolved, 1, "a repeated key is resolved once");
  const written = fs.readFileSync(reviewFile, "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(written.reason.length, 120, "the resolution reason is capped");
  assert.doesNotMatch(written.reason, /[\u0000-\u001f]/, "control characters are stripped from the reason");
  assert.equal(written.resolves.key, pending.requests[1].key);
  const manyKeys = resolveDiagnosticReview({ stateDir: reviewState, keys: Array.from({ length: 200 }, (_, n) => `history|bulk-${n}|sha256:${n}`) });
  assert.equal(manyKeys.outcome, "preview");
  assert.equal(manyKeys.unknownKeys.length, 50, "the key list is capped before it is compared");
  assert.equal(fs.statSync(reviewFile).mode & 0o777, 0o600, "resolution rows keep the diagnostics file private");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("project memory diagnostic tests passed");
