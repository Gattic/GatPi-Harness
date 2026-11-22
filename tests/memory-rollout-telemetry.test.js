"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("../src/trace-observability");
const { collectRolloutSources, evaluateProjectMemoryRollout, evaluateRollout } = require("../src/memory-rollout-telemetry");
const { decideStage } = require("../src/project-memory-rollout");
const { tmpFixture } = require("./helpers/tmp-fixture");

const NOW = "2026-11-21T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const REVISION = "content:abc";
function daysAgo(n) { return new Date(NOW_MS - n * 86400000).toISOString(); }
const sessions = Array.from({ length: 10 }, (_, index) => sha256(`session-${index}`).slice(0, 16));

function baseSources(overrides = {}) {
  const traces = [];
  for (let i = 0; i < 30; i += 1) {
    const key = sessions[i % 10];
    traces.push({ category: "memory_retrieval", name: "recall.completed", timestamp: daysAgo(i % 14), session_id: `raw-${i}`, payload: { durationMs: 20, candidateCount: 3, returnedCount: 1, returnedHashes: [`hash_${key}`], outOfScopeCount: 0, injected: false, sessionIdHash: key } });
  }
  for (let i = 0; i < 20; i += 1) traces.push({ category: "memory_decision", name: "shadow.outcome", timestamp: daysAgo(i % 7), session_id: `raw-${i}`, payload: { agreed: true, applied: false, proposalHash: `proposal_${i}`, sessionIdHash: sessions[i % 5] } });
  traces.push({ category: "memory_curation", name: "curation.completed", timestamp: daysAgo(1), payload: { outcome: "success", durationMs: 120 } });
  const decisions = [];
  for (let i = 0; i < 20; i += 1) {
    const key = sessions[i % 10];
    decisions.push({ action: "saved", automatic: false, verification: "verified", sessionIdHash: key, evidenceIds: i < 5 ? [`hash_${key}`] : [], at: daysAgo(i % 7) });
  }
  for (let i = 0; i < 30; i += 1) decisions.push({ action: "saved", automatic: true, verification: "verified", sessionIdHash: sessions[i % 10], evidenceIds: [], at: daysAgo(i % 14) });
  const diagnostics = [{ kind: "write", at: daysAgo(0), sanitized: true, inspected: 7, bypassedRecords: 0 }];
  for (let i = 0; i < 14; i += 1) diagnostics.push({ kind: "settle", at: daysAgo(i), scanned: 3, candidateHashes: ["c1", "c2", "c3"], reasonCounts: { new: 3 }, diagnosticOnly: true, vaultReady: true });
  return {
    traces,
    decisions,
    diagnostics,
    fullSuite: { ok: true, status: "succeeded", failed: 0, testFiles: 328, discoveredTestFiles: 328, generatedAt: daysAgo(1), sourceRevision: REVISION },
    privacy: { findings: [], permissionPosture: { compliant: true }, complete: true },
    baseline: { baselineAt: daysAgo(40), recordFileHashes: [] },
    ...overrides,
  };
}
function evaluate(sources, extra = {}) {
  const predicates = evaluateRollout({ sources, evaluatedAt: NOW, implementationRevision: REVISION });
  return { ...predicates, ...decideStage(predicates, { previous: extra.previous ?? null, hold: extra.hold ?? null }) };
}

// A tree with complete instrumentation reaches M5 in one evaluation.
const full = evaluate(baseSources());
assert.deepEqual(full.insufficient, [], `no predicate is insufficient: ${JSON.stringify(full.predicates)}`);
for (const name of ["D", "P", "B", "S1", "R", "SD", "C", "A"]) assert.equal(full.predicates[name].status, "pass", `${name} passes`);
assert.equal(full.candidateStage, "M5");
assert.equal(full.effectiveStage, "M5");
assert.equal(full.promoted, true);
assert.equal(full.predicates.R.metrics.citationRate, 0.5, "five of ten sessions cite a returned handle");

// Deterministic gate: missing, failing, partial, stale and mismatched records.
assert.equal(evaluate(baseSources({ fullSuite: null })).predicates.D.reasons[0], "full-suite-record-missing");
assert.equal(evaluate(baseSources({ fullSuite: { ...baseSources().fullSuite, failed: 1, ok: false, status: "failed" } })).predicates.D.status, "fail");
assert.equal(evaluate(baseSources({ fullSuite: { ...baseSources().fullSuite, testFiles: 300 } })).predicates.D.reasons[0], "full-suite-partial");
assert.equal(evaluate(baseSources({ fullSuite: { ...baseSources().fullSuite, generatedAt: daysAgo(8) } })).predicates.D.reasons[0], "test-evidence-stale");
const mismatched = evaluateRollout({ sources: baseSources(), evaluatedAt: NOW, implementationRevision: "content:other" });
assert.equal(mismatched.predicates.D.reasons[0], "revision-mismatch");

// Permissions and privacy baseline.
assert.equal(evaluate(baseSources({ privacy: { findings: [], permissionPosture: { compliant: false }, complete: true } })).predicates.P.status, "fail");
assert.equal(evaluate(baseSources({ privacy: null })).predicates.P.reasons[0], "permission-posture-unavailable");
assert.equal(evaluate(baseSources({ baseline: null })).predicates.B.reasons[0], "privacy-baseline-missing");
const recordHandle = "project-state:0123456789ab";
const newHigh = evaluate(baseSources({ privacy: { findings: [{ severity: "high", file: recordHandle }], permissionPosture: { compliant: true }, complete: true } }));
assert.equal(newHigh.predicates.B.reasons[0], "new-record-highs");
const grandfathered = evaluate(baseSources({ baseline: { baselineAt: daysAgo(40), recordFileHashes: [recordHandle] }, privacy: { findings: [{ severity: "high", file: recordHandle }], permissionPosture: { compliant: true }, complete: true } }));
assert.equal(grandfathered.predicates.B.status, "pass", "a grandfathered record high does not gate");
assert.equal(evaluate(baseSources({ privacy: { findings: [], permissionPosture: { compliant: true }, complete: false } })).predicates.B.reasons[0], "privacy-scan-incomplete", "an incomplete scan is not evidence");
assert.equal(evaluate(baseSources({ diagnostics: [{ kind: "settle", at: daysAgo(1) }] })).predicates.B.reasons[0], "write-audit-missing");
const bypass = evaluate(baseSources({ diagnostics: [{ kind: "write", at: daysAgo(0), sanitized: false, bypassedRecords: 1 }, ...baseSources().diagnostics.slice(1)] }));
assert.equal(bypass.predicates.B.reasons[0], "sanitizer-bypass");
const staleAudit = evaluate(baseSources({ diagnostics: [{ kind: "write", at: daysAgo(20), sanitized: true }, ...baseSources().diagnostics.slice(1)] }));
assert.equal(staleAudit.predicates.B.reasons[0], "write-audit-missing", "an audit outside the window is not evidence");

// Explicit save precision.
const nineteenSaves = baseSources().decisions.filter((row) => row.automatic === false).slice(0, 19);
assert.equal(evaluate(baseSources({ decisions: nineteenSaves })).predicates.S1.reasons[0], "explicit-saves-below-minimum");
const unverifiedSaves = baseSources().decisions.filter((row) => row.automatic === false).map((row, index) => (index < 2 ? { ...row, verification: "unverified" } : row));
assert.equal(evaluate(baseSources({ decisions: unverifiedSaves })).predicates.S1.reasons[0], "explicit-save-precision-below-bar");
// Rows written before the `automatic` field existed carry no flag; automatic
// capture records `automatic: true`, so a missing flag is an explicit save.
const legacySaves = baseSources().decisions.filter((row) => row.automatic === false).slice(0, 20).map(({ automatic, ...row }) => row);
assert.equal(evaluate(baseSources({ decisions: legacySaves })).predicates.S1.status, "pass", "rows without an automatic flag count as explicit saves");
const automaticOnly = baseSources().decisions.filter((row) => row.automatic === true);
assert.equal(evaluate(baseSources({ decisions: automaticOnly })).predicates.S1.reasons[0], "explicit-saves-below-minimum", "automatic saves never count as explicit");

console.log("memory rollout telemetry predicate tests passed");

// Recall quality: latency, scope, citation, sample minimums and payload shape.
const slowRecall = baseSources().traces.map((event) => (event.name === "recall.completed" ? { ...event, payload: { ...event.payload, durationMs: 60 } } : event));
assert.equal(evaluate(baseSources({ traces: slowRecall })).predicates.R.reasons[0], "recall-latency-above-bar");
const scopeLeak = baseSources().traces.map((event, index) => (index === 0 && event.name === "recall.completed" ? { ...event, payload: { ...event.payload, outOfScopeCount: 1 } } : event));
assert.equal(evaluate(baseSources({ traces: scopeLeak })).predicates.R.reasons[0], "recall-out-of-scope");
const noCitations = baseSources().decisions.map((row) => ({ ...row, evidenceIds: [] }));
assert.equal(evaluate(baseSources({ decisions: noCitations })).predicates.R.reasons[0], "recall-citation-below-bar");
const shortRecall = baseSources().traces.filter((event) => event.name !== "recall.completed").concat(baseSources().traces.filter((event) => event.name === "recall.completed").slice(0, 29));
assert.equal(evaluate(baseSources({ traces: shortRecall })).predicates.R.reasons[0], "recall-samples-below-minimum");
const missingLatency = baseSources().traces.map((event) => (event.name === "recall.completed" ? { ...event, payload: { ...event.payload, durationMs: null } } : event));
assert.equal(evaluate(baseSources({ traces: missingLatency })).predicates.R.reasons[0], "recall-payload-incomplete");

// Shadow agreement.
const shortShadow = baseSources().traces.filter((event) => event.name !== "shadow.outcome").concat(baseSources().traces.filter((event) => event.name === "shadow.outcome").slice(0, 19));
assert.equal(evaluate(baseSources({ traces: shortShadow })).predicates.SD.reasons[0], "shadow-samples-below-minimum");
const disagreeing = baseSources().traces.map((event, index) => (event.name === "shadow.outcome" && index % 5 === 0 ? { ...event, payload: { ...event.payload, agreed: false } } : event));
const sdResult = evaluate(baseSources({ traces: disagreeing })).predicates.SD;
assert.equal(sdResult.reasons[0], "shadow-agreement-below-bar");
assert.equal(sdResult.metrics.agreement, 0.8, "four of twenty disagree");
const appliedShadow = baseSources().traces.map((event) => (event.name === "shadow.outcome" ? { ...event, payload: { ...event.payload, applied: true } } : event));
assert.equal(evaluate(baseSources({ traces: appliedShadow })).predicates.SD.reasons[0], "shadow-payload-incomplete");

// Curation previews: volume, stability, accounting and diagnostic-only safety.
const fewPreviews = baseSources().diagnostics.filter((row) => row.kind !== "settle").concat(baseSources().diagnostics.filter((row) => row.kind === "settle").slice(0, 13));
assert.equal(evaluate(baseSources({ diagnostics: fewPreviews })).predicates.C.reasons[0], "curation-previews-below-minimum");
const unstablePreviews = baseSources().diagnostics.map((row, index) => (row.kind === "settle" && index === 5 ? { ...row, candidateHashes: ["c1", "c2", "c4"] } : row));
assert.equal(evaluate(baseSources({ diagnostics: unstablePreviews })).predicates.C.reasons[0], "curation-candidates-unstable");
const misaccounted = baseSources().diagnostics.map((row, index) => (row.kind === "settle" && index < 3 ? { ...row, scanned: 4 } : row));
assert.equal(evaluate(baseSources({ diagnostics: misaccounted })).predicates.C.reasons[0], "curation-accounting-below-bar");
const scheduledMutation = baseSources().diagnostics.map((row, index) => (row.kind === "settle" && index === 2 ? { ...row, diagnosticOnly: false } : row));
assert.equal(evaluate(baseSources({ diagnostics: scheduledMutation })).predicates.C.reasons[0], "curation-not-diagnostic-only");

// Automatic save precision.
const twentyNineAutos = baseSources().decisions.filter((row) => row.automatic !== true).concat(baseSources().decisions.filter((row) => row.automatic === true).slice(0, 29));
assert.equal(evaluate(baseSources({ decisions: twentyNineAutos })).predicates.A.reasons[0], "automatic-saves-below-minimum");
const impreciseAutos = baseSources().decisions.map((row, index) => (row.automatic === true && index % 15 === 0 ? { ...row, verification: "unverified" } : row));
assert.equal(evaluate(baseSources({ decisions: impreciseAutos })).predicates.A.reasons[0], "automatic-save-precision-below-bar");
const weakCuration = baseSources().traces.map((event) => (event.name === "curation.completed" ? { ...event, payload: { outcome: "error", durationMs: 900 } } : event));
assert.equal(evaluate(baseSources({ traces: weakCuration })).predicates.A.reasons[0], "curation-success-below-bar");

// Hysteresis: promotion is immediate, demotion needs two consecutive failures.
const promoted = evaluate(baseSources(), { previous: { effectiveStage: "M0", consecutiveFailures: 0 } });
assert.equal(promoted.effectiveStage, "M5");
assert.equal(promoted.promoted, true);
const failing = baseSources({ fullSuite: null });
const firstFailure = evaluate(failing, { previous: { effectiveStage: "M3", consecutiveFailures: 0 } });
assert.equal(firstFailure.candidateStage, "M0");
assert.equal(firstFailure.effectiveStage, "M3", "one failing evaluation changes nothing");
assert.equal(firstFailure.demoted, false);
assert.equal(firstFailure.consecutiveFailures, 1);
const secondFailure = evaluate(failing, { previous: { effectiveStage: firstFailure.effectiveStage, consecutiveFailures: firstFailure.consecutiveFailures } });
assert.equal(secondFailure.effectiveStage, "M0", "the second failure demotes");
assert.equal(secondFailure.demoted, true);
assert.equal(secondFailure.consecutiveFailures, 0, "the streak resets after demotion");
const recovered = evaluate(baseSources(), { previous: { effectiveStage: "M0", consecutiveFailures: 1 } });
assert.equal(recovered.consecutiveFailures, 0, "a passing evaluation clears the streak");

// HOLD may only lower the effective stage.
const held = evaluate(baseSources(), { hold: "M1" });
assert.equal(held.effectiveStage, "M1");
assert.equal(held.held, true);
assert.equal(held.candidateStage, "M5", "the measured candidate is still reported");
assert.equal(evaluate(baseSources(), { hold: "M4" }).effectiveStage, "M4");
assert.equal(evaluate(baseSources(), { hold: "bogus" }).effectiveStage, "M0", "an unrecognized hold is fail-closed to M0");
assert.equal(evaluate(baseSources(), { hold: "M0" }).effectiveStage, "M0", "HOLD=M0 forces M0");

// Collector: reads project-local records and skips trace files outside the window.
const cwd = tmpFixture("rollout-telemetry-");
const traceDir = path.join(cwd, ".pi", "traces");
const stateDir = path.join(cwd, ".pi", "project-memory");
const testDir = path.join(cwd, ".pi", "test-runner");
fs.mkdirSync(traceDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(path.join(traceDir, "proj-session-a.jsonl"), `${JSON.stringify({ category: "memory_retrieval", name: "recall.completed", timestamp: daysAgo(1), payload: { injected: false } })}\n`);
const oldTrace = path.join(traceDir, "proj-session-old.jsonl");
fs.writeFileSync(oldTrace, `${JSON.stringify({ category: "memory_retrieval", name: "recall.completed", timestamp: daysAgo(30), payload: { injected: false } })}\n`);
const past = new Date(NOW_MS - 30 * 86400000);
fs.utimesSync(oldTrace, past, past);
fs.writeFileSync(path.join(stateDir, "decisions.jsonl"), `${JSON.stringify({ action: "saved", at: daysAgo(1) })}\n`);
fs.writeFileSync(path.join(stateDir, "diagnostics.jsonl"), `${JSON.stringify({ kind: "write", at: daysAgo(0), sanitized: true })}\n`);
fs.writeFileSync(path.join(testDir, "full-latest.json"), JSON.stringify({ ok: true, status: "succeeded", failed: 0, testFiles: 1, discoveredTestFiles: 1, generatedAt: daysAgo(1), sourceRevision: REVISION }));
const collected = collectRolloutSources({ cwd, privacy: { findings: [] }, baseline: { baselineAt: daysAgo(40) }, nowMs: NOW_MS });
assert.equal(collected.traces.length, 1, "the stale trace file is skipped");
assert.equal(collected.decisions.length, 1);
assert.equal(collected.diagnostics.length, 1);
assert.equal(collected.fullSuite.ok, true);
assert.deepEqual(collected.privacy, { findings: [] });
assert.equal(collected.baseline.baselineAt, daysAgo(40));
const collectedEval = evaluateRollout({ sources: collected, evaluatedAt: NOW, implementationRevision: REVISION });
assert.equal(collectedEval.predicates.D.status, "pass", "a collected record evaluates without transformation");

console.log("memory rollout telemetry predicate, hysteresis and collector tests passed");

// Runtime evaluation: fail-closed on absent records, cached inside the window,
// emitting exactly one rollout.evaluated event per fresh evaluation.
const emptyCwd = tmpFixture("rollout-empty-");
const empty = evaluateProjectMemoryRollout({ cwd: emptyCwd, env: {}, now: NOW_MS, privacy: null, baseline: null, cacheMs: 0, emit: false });
assert.equal(empty.kind, "rollout.evaluated");
assert.equal(empty.candidateStage, "M0");
assert.equal(empty.effectiveStage, "M0");
assert.equal(empty.predicates.D.reasons[0], "full-suite-record-missing");
assert(empty.insufficient.includes("P") && empty.insufficient.includes("B"), "a missing scan and baseline are insufficient");
assert.equal(empty.emission.emitted, false, "emission can be disabled explicitly");

const live = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: false });
assert.equal(live.predicates.D.status, "pass");
assert.equal(live.predicates.P.status, "pass");
assert.equal(live.predicates.B.status, "pass");
assert.equal(live.candidateStage, "M1", "passing M0 is the most the passive evaluation can authorize");

// A fresh evaluation emits one event carrying the decided stage and predicates.
const emitted = [];
const spy = (event) => emitted.push(event);
const withEmit = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: spy });
assert.equal(withEmit.emission.emitted, true);
assert.equal(withEmit.emission.sink, "injected");
assert.equal(emitted.length, 1);
assert.equal(emitted[0].category, "memory_rollout");
assert.equal(emitted[0].name, "rollout.evaluated");
assert.equal(emitted[0].implementationRevision, REVISION);
assert.equal(emitted[0].payload.stage, withEmit.effectiveStage);
assert.equal(emitted[0].payload.candidateStage, withEmit.candidateStage);
assert.equal(emitted[0].payload.previousStage, withEmit.previousStage);
assert.equal(typeof emitted[0].payload.predicates.D.status, "string");
assert.deepEqual(emitted[0].payload.insufficient, withEmit.insufficient);

// A stage transition is explainable from the emitted event alone: replaying the
// recorded previous state, candidate and hold reproduces the recorded stage.
const replay = decideStage(
  { kind: "rollout.evaluated", candidateStage: emitted[0].payload.candidateStage },
  { previous: { effectiveStage: emitted[0].payload.previousStage, consecutiveFailures: emitted[0].payload.previousConsecutiveFailures }, hold: emitted[0].payload.hold },
);
assert.equal(replay.effectiveStage, emitted[0].payload.stage, "the event alone explains the decided stage");
assert.equal(replay.promoted, emitted[0].payload.promoted);
assert.equal(replay.demoted, emitted[0].payload.demoted);
assert.equal(replay.consecutiveFailures, emitted[0].payload.consecutiveFailures);
assert.equal(replay.held, emitted[0].payload.held);
assert.equal(typeof emitted[0].payload.predicates.D.status, "string", "the event carries the predicate statuses");

// A cached read reuses the evaluation and emits nothing.
const cachedFirst = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 60000, emit: false });
const cachedAgain = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS + 1000, implementationRevision: REVISION, privacy: null, baseline: null, cacheMs: 60000, emit: spy });
assert.equal(cachedAgain.effectiveStage, cachedFirst.effectiveStage);
assert.equal(cachedAgain.emission.reason, "cached");
assert.equal(emitted.length, 1, "a cached read emits no event");

// Emission failure is reported and never changes the decision.
const broken = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: () => { throw new Error("sink down"); } });
assert.equal(broken.emission.emitted, false);
assert.equal(broken.emission.reason, "emit-failed");
assert.equal(broken.effectiveStage, withEmit.effectiveStage);

// The default sink appends a sanitized, revision-stamped line to the trace dir.
const emitCwd = tmpFixture("rollout-emit-");
const fileEval = evaluateProjectMemoryRollout({ cwd: emitCwd, env: {}, now: NOW_MS, privacy: null, baseline: null, cacheMs: 0 });
assert.equal(fileEval.emission.emitted, true);
assert.equal(fileEval.emission.sink, "trace-file");
const traceFiles = fs.readdirSync(path.join(emitCwd, ".pi", "traces")).filter((name) => name.endsWith("rollout.jsonl"));
assert.equal(traceFiles.length, 1);
const eventLines = fs.readFileSync(path.join(emitCwd, ".pi", "traces", traceFiles[0]), "utf8").split("\n").filter(Boolean);
assert.equal(eventLines.length, 1);
const written = JSON.parse(eventLines[0]);
assert.equal(written.name, "rollout.evaluated");
assert.equal(written.payload.stage, fileEval.effectiveStage);
assert.equal(written.implementationRevision, fileEval.implementationRevision);
assert(!JSON.stringify(written).includes(emitCwd), "the event carries no absolute path");

// The emitted event is the hysteresis input: one failure keeps the stage.
fs.appendFileSync(path.join(traceDir, "proj-session-a.jsonl"), `${JSON.stringify({ name: "rollout.evaluated", timestamp: new Date(NOW_MS + 5000).toISOString(), payload: { stage: "M3", consecutiveFailures: 0 } })}\n`);
const hysteresis = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS + 6000, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: false });
assert.equal(hysteresis.previousStage, "M3", "the newest emitted evaluation is the hysteresis state");
assert.equal(hysteresis.effectiveStage, "M3", "one failing evaluation does not demote");
assert.equal(hysteresis.consecutiveFailures, 1);
assert.equal(hysteresis.demoted, false);

// A second consecutive failure demotes, and the streak resets.
fs.appendFileSync(path.join(traceDir, "proj-session-a.jsonl"), `${JSON.stringify({ name: "rollout.evaluated", timestamp: new Date(NOW_MS + 7000).toISOString(), payload: { stage: "M3", consecutiveFailures: 1 } })}\n`);
const demoted = evaluateProjectMemoryRollout({ cwd, env: {}, now: NOW_MS + 8000, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: false });
assert.equal(demoted.effectiveStage, "M1");
assert.equal(demoted.demoted, true);
assert.equal(demoted.consecutiveFailures, 0);

// HOLD caps a hysteresis-held stage and cannot raise it.
fs.appendFileSync(path.join(traceDir, "proj-session-a.jsonl"), `${JSON.stringify({ name: "rollout.evaluated", timestamp: new Date(NOW_MS + 9000).toISOString(), payload: { stage: "M3", consecutiveFailures: 0 } })}\n`);
const holdCapped = evaluateProjectMemoryRollout({ cwd, env: { PI_PROJECT_MEMORY_HOLD: "M1" }, now: NOW_MS + 10000, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: false });
assert.equal(holdCapped.effectiveStage, "M1");
assert.equal(holdCapped.held, true);
assert.equal(holdCapped.hold, "M1");
const forced = evaluateProjectMemoryRollout({ cwd, env: { PI_PROJECT_MEMORY_HOLD: "M0" }, now: NOW_MS + 10000, implementationRevision: REVISION, privacy: { findings: [], permissionPosture: { compliant: true }, complete: true }, baseline: { baselineAt: daysAgo(40), recordFileHashes: [] }, cacheMs: 0, emit: false });
assert.equal(forced.effectiveStage, "M0", "HOLD=M0 forces fail-closed M0");
assert.equal(forced.held, true);

console.log("memory rollout runtime evaluation tests passed");
