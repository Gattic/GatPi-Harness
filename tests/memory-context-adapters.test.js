"use strict";
const assert = require("node:assert/strict");
const { MemoryJsonStorage, RecordingSink, CognitiveMemoryAdapter, LayeredContextAdapter, ProjectMemoryAdapter } = require("../src/integration-boundary");
const { isDiagnosticTextMetadata } = require("../src/managed-state-sanitizer");

const storage = new MemoryJsonStorage();
const sink = new RecordingSink();
const memory = new CognitiveMemoryAdapter({ storage, sink });
assert.equal(memory.remember({ type: "semantic", title: "Adapter", content: "Adapters isolate Pi core from memory internals.", verification: "verified", confidence: 0.9 }).accepted, true);
assert.equal(memory.retrieve("Pi core adapters").entries.length, 1);
assert.equal(memory.findWhere((e) => e.title === "Adapter").length, 1);
// Recency scans must reach newly appended entries; head-limited scans only see
// the oldest matches.
const recency = new CognitiveMemoryAdapter({ storage: new MemoryJsonStorage() });
for (const [index, content] of ["Alpha release checklist.", "Bravo rollback drill.", "Charlie migration preview.", "Delta schema audit.", "Echo cache warmup."].entries()) recency.remember({ type: "procedural", title: `Entry ${index}`, content, tags: ["procedure"], verification: "verified", provenance: { source: "explicit-review" } });
assert.deepEqual(recency.findWhere((e) => e.type === "procedural", 2).map((e) => e.title), ["Entry 0", "Entry 1"], "findWhere keeps its oldest-first semantics");
assert.deepEqual(recency.findRecent((e) => e.type === "procedural", 2).map((e) => e.title), ["Entry 3", "Entry 4"], "findRecent returns the newest matches in stored order");
assert.equal(recency.findRecent((e) => e.type === "procedural").length, 5);
assert.equal(recency.findRecent((e) => e.type === "procedural", 0).length, 0);
assert.equal(recency.findRecent(() => false, 5).length, 0);
memory.persist();
assert.equal(storage.readJson("cognitive-memory").entries.length, 1);

const historicalValue = "H".repeat(24);
const historicalStorage = new MemoryJsonStorage({ "cognitive-memory": { version: 1, entries: [{ type: "episodic", title: "Assistant turn", content: `api_key=${historicalValue}`, provenance: { source: "pi-message" } }], audit: [] } });
const hydratedMemory = new CognitiveMemoryAdapter({ storage: historicalStorage });
assert.equal(hydratedMemory.metrics().totalEntries, 1);
assert(!historicalStorage.readJson("cognitive-memory").entries[0].content.includes(historicalValue), "historical memory is sanitized during hydration before another write can restore it");
assert(isDiagnosticTextMetadata(historicalStorage.readJson("cognitive-memory").entries[0].content), "assistant-turn hydration retains metadata instead of response text");

const context = new LayeredContextAdapter({ storage, sink });
assert.equal(context.upsert({ layer: "L1", title: "Boundary", content: "Context is packed through an adapter.", verification: "verified", protected: true }).accepted, true);
assert(context.pack({ tokenBudget: 100, query: "adapter" }).text.includes("Boundary"));
context.persist();
assert.equal(storage.readJson("layered-context").blocks.length, 1);

const selection = { schemaVersion: 1, selectionId: "vaultsel_fixture", projectKey: "pi:fixture:root", path: "/runtime-only/vault", pathHash: "sha256:fixture", source: "configured", configured: true, exists: false, marker: false, readable: false, writable: false, ambiguous: false, candidateCount: 1, reasons: ["vault-missing"] };
const readiness = { projectMemoryReads: { ready: false }, projectMemoryExplicitWrites: { ready: false }, automaticBehaviorAuthorized: { ready: false } };
const projectMemory = new ProjectMemoryAdapter({ enabled: false, selection, readiness });
assert.equal(projectMemory.status().selectionId, selection.selectionId);
assert.equal(projectMemory.recall("fixture").projectKey, selection.projectKey);
assert.equal(JSON.stringify(projectMemory.status()).includes("/runtime-only/vault"), false, "adapter metadata omits runtime-only full vault paths");
console.log("memory-context-adapters tests passed");
