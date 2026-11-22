"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { ProjectMemoryRecall, recallTelemetryPayload } = require("../src/project-memory-recall");
const { ProjectMemoryIndex } = require("../src/project-memory-index");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("project-memory-recall-telemetry-");
const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault");
fs.mkdirSync(cwd); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const now = Date.parse("2026-11-20T00:00:00Z");
const clock = () => new Date(now);
const store = new ProjectMemoryStore({ cwd, vault, writeEnabled: true, clock });
store.upsert({ kind: "constraint", title: "Recall scope rule", content: "Recall stays inside the project vault.", verification: "verified" }, { apply: true, explicit: true });

const recaller = new ProjectMemoryRecall({ cwd, store, now: () => now });
const result = recaller.recall("recall scope", { limit: 5 });
assert.equal(result.items.length, 1, "the stored constraint is recalled");
assert.equal(result.outOfScopeCount, 0, "an unscoped recall cannot report foreign matches");

const payload = recallTelemetryPayload(result, { injected: true });
assert.equal(payload.name, "recall.completed");
assert.equal(typeof payload.durationMs, "number");
assert.equal(payload.candidateCount, result.candidates);
assert.equal(payload.returnedCount, result.items.length);
assert.deepEqual(payload.returnedHashes, result.items.map((item) => item.evidence.contentHash));
assert.equal(payload.outOfScopeCount, 0);
assert.equal(payload.injected, true);
assert.equal(payload.sourceKind, result.sourceKind);

// Shadow measurement: recall that never reached the context is still recorded,
// but must not be counted as injected.
assert.equal(recallTelemetryPayload(result).injected, false);

// A refused recall keeps its counts so the gate can tell "ran and returned
// nothing" apart from "no telemetry at all".
const failed = recallTelemetryPayload({ items: [], candidates: 0, durationMs: 0, reason: "canonical-integrity-failed" });
assert.equal(failed.name, "recall.failed");
assert.equal(failed.errorSummary, "canonical-integrity-failed");
assert.equal(failed.returnedCount, 0);
assert.equal(failed.injected, false);

// An explicit scope is passed through to the index. Store entries carry no root
// attribution, and an unattributed entry never satisfies a requested scope.
const scopedRecall = recaller.recall("recall scope", { limit: 5, root: "root-a" });
assert.equal(scopedRecall.items.length, 0);
assert.equal(scopedRecall.outOfScopeCount, 1, "the unattributed matching entry is reported out of scope");

// Index-level contract: only entries matching the query terms count as
// out-of-scope, and a scoped result never contains another root's entries.
const entries = [
  { root: "root-a", id: "a", kind: "constraint", title: "Recall scope rule", content: "Recall stays inside root A.", verification: "verified", updatedAt: new Date(now).toISOString() },
  { root: "root-b", id: "b", kind: "constraint", title: "Recall scope rule", content: "Recall stays inside root B.", verification: "verified", updatedAt: new Date(now).toISOString() },
  { root: "root-b", id: "unrelated", kind: "constraint", title: "Unrelated", content: "Nothing to do with the query.", verification: "verified", updatedAt: new Date(now).toISOString() },
];
const scoped = new ProjectMemoryIndex({ entries, now: () => now }).search("recall scope", { limit: 5, root: "root-a" });
assert.deepEqual(scoped.items.map((row) => row.id), ["a"]);
assert.equal(scoped.outOfScope, 1, "only the foreign entry that matched the query is counted");
assert.equal(new ProjectMemoryIndex({ entries, now: () => now }).search("recall scope", { limit: 5 }).outOfScope, 0);

// The extension must run shadow recall without injecting it, and must only
// format the advisory block when injection is authorized.
const extensionSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
assert.match(extensionSource, /controls\?\.shadowRecall/);
assert.match(extensionSource, /const projectMemoryRecallRuns = projectMemoryRecallEnabled \|\| projectMemoryShadowRecall;/);
assert.match(extensionSource, /const projectMemoryAdvisory = projectMemoryRecallEnabled \?/);
assert.match(extensionSource, /if \(projectMemoryRecallRuns\) \{/);

// End-to-end gate contract: the emitted payload must survive the trace layer with
// capturePayloads:false and satisfy the R predicate's completeness check. The
// evaluator then reports only the volume shortfall, never an incomplete payload.
const { TraceRuntime, FileTraceStorage, ReplayIndex } = require("../src/trace-observability");
const { evaluateRollout } = require("../src/memory-rollout-telemetry");
const traceRoot = tmpFixture("project-memory-recall-gate-");
const storage = new FileTraceStorage({ root: traceRoot, sessionId: "recall-gate", compressPayloadBytes: 1_000_000, capturePayloads: false });
const trace = new TraceRuntime({ storage, sessionId: "recall-gate" });
trace.emit({ category: "memory_retrieval", name: "recall.completed", subsystem: "code-context", session_id: "session-1", payload: recallTelemetryPayload(result, { injected: false }) });
const gateEvents = ReplayIndex.readEvents(storage.path());
assert.equal(gateEvents.length, 1);
assert.equal(gateEvents[0].payload.injected, false, "shadow recall stays measurable under the default privacy posture");
assert.equal(typeof gateEvents[0].payload.durationMs, "number");
assert(Array.isArray(gateEvents[0].payload.returnedHashes));
assert.equal(Number.isInteger(gateEvents[0].payload.outOfScopeCount), true);
const evaluated = evaluateRollout({ sources: { traces: gateEvents }, evaluatedAt: new Date() });
assert.equal(evaluated.predicates.R.status, "insufficient");
assert.equal(evaluated.predicates.R.reasons[0], "recall-samples-below-minimum", "completeness is satisfied; only sample volume is short");
storage.close(); fs.rmSync(traceRoot, { recursive: true, force: true });

console.log("project-memory recall telemetry tests passed");
