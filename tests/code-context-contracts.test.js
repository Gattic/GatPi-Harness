#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  createCard,
  createRelation,
  createDiagnostic,
  createTest,
  createBuildFact,
  createProviderStatus,
  createRetrievalEnvelope,
  validateEnvelope,
  sourceKindForPath,
  stableRecordCompare,
  compactRetrievalEnvelope,
} = require("../src/code-context-contracts.js");

const base = { provider: "lsp", path: "src/example.js", kind: "definition", signature: "function answer()", freshness: "fresh", gatingSafe: true, score: 0.9, scoreReasons: ["exact_identifier"], range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 18 } };
const first = createCard(base);
const second = createCard({ ...base, elapsedMs: 999, generatedAt: "tomorrow" });
assert.equal(first.id, second.id, "volatile timing fields must not change card identity");
assert.equal(first.gatingSafe, true);
assert.equal(createCard({ ...base, freshness: "stale", gatingSafe: true }).gatingSafe, false);
assert.throws(() => createCard({ provider: "lsp", path: "../secret" }), /repository-relative/);
const aggregated = createCard({ ...base, queryTerms: ["safe", "safe", "switch"], queryMatchCount: 2, queryCoverage: 1.5 });
assert.deepEqual(aggregated.queryTerms, ["safe", "switch"]);
assert.equal(aggregated.queryMatchCount, 2);
assert.equal(aggregated.queryCoverage, 1, "path-level retrieval evidence survives contract normalization with bounded coverage");
assert.equal(sourceKindForPath("vendor/lib/a.cc"), "vendored");
assert.equal(sourceKindForPath("src/generated/model.pb.cc"), "generated");
assert.equal(sourceKindForPath("build/app.o"), "build_output");

assert.equal(createRelation({ provider: "codegraph", fromId: "a", toId: "b", relationKind: "calls" }).relationKind, "calls");
assert.equal(createDiagnostic({ provider: "clangd", path: "src/a.cc", message: "bad", severity: "ERROR" }).severity, "error");
assert.equal(createTest({ provider: "runner", path: "tests/a.test.js", status: "passed" }).kind, "test");
assert.equal(createBuildFact({ provider: "cmake", subject: "app", predicate: "produces", object: "bin/app" }).subject, "app");
assert.equal(createProviderStatus({ provider: "lsp", freshness: "unknown", gatingSafe: true }).gatingSafe, false);

const envelope = createRetrievalEnvelope({ provider: "lsp", strategyId: "exact", revision: "r1", freshness: "fresh", gatingSafe: true, items: [first, createCard({ ...base, path: "src/z.js", score: 0.2 })], metrics: { candidatesRetrieved: 4, tokensReturned: 20 } });
assert.equal(envelope.items.length, 2);
assert.equal(envelope.metrics.candidatesRetrieved, 4);
assert.equal(envelope.gatingSafe, true);
assert.equal(envelope.items.slice().sort(stableRecordCompare)[0].path, "src/example.js");
const preserved = createRetrievalEnvelope({ provider: "repository-map", freshness: "fresh", gatingSafe: true, preserveOrder: true, items: [createCard({ ...base, path: "src/novel.js", score: 0.2 }), first] });
assert.deepEqual(preserved.items.map((item) => item.path), ["src/novel.js", "src/example.js"], "concept-diverse repository ranking can preserve an explicitly ordered result set");
const malformed = createRetrievalEnvelope({ provider: "broken", items: [{ path: "src/a.js" }] });
assert.equal(malformed.gatingSafe, false);
assert.equal(malformed.degradation.code, "malformed_provider_output");
assert.match(malformed.errors[0], /provider/);
const invalidShape = validateEnvelope({ provider: "broken", items: null });
assert.equal(invalidShape.ok, false);
assert.match(compactRetrievalEnvelope(envelope), /src\/example\.js:3:1/);
assert.match(compactRetrievalEnvelope(envelope), /exact_identifier/);

console.log("code-context contracts tests passed");
