"use strict";
const assert = require("node:assert/strict");
const { compactToolContent, renderTopologyRun, renderRetrievalEnvelope, summarizeValue } = require("../src/result-rendering");
const { createCard, createRetrievalEnvelope } = require("../src/code-context-contracts");

const run = { runId: "r1", topologyId: "t1", status: "partial", durationMs: 12, aggregation: { content: "PRIVATE_AGGREGATION_BODY", payload: { claims: [{ id: "c1" }], evidenceRefs: [] } }, execution: { mode: "dag", concurrencyLimit: 4, failurePolicy: "continue-on-error", partialPolicy: "report", aggregationPolicy: "last" }, results: [{ nodeId: "a", status: "succeeded", content: "PRIVATE_RESULT_BODY_" + "x".repeat(1000) }], nodeStates: [{ nodeId: "a", roleId: "researcher", status: "succeeded", durationMs: 10, evidenceCount: 4 }, { nodeId: "audit", roleId: "evidence-auditor", status: "blocked", reason: "join-threshold-not-met", durationMs: 0, evidenceCount: 0, successfulInputs: 2, requiredInputs: 3 }], joinDecisions: [{ nodeId: "audit", mode: "min-success", successfulInputs: 2, minimumSuccessfulInputs: 3, satisfied: false, degraded: true }] };
const rendered = renderTopologyRun(run);
assert.match(rendered, /topology t1: partial/);
assert.match(rendered, /concurrency=4/);
assert.match(rendered, /audit.*blocked/);
assert.match(rendered, /join audit: min-success/);
assert(!rendered.includes("PRIVATE_RESULT_BODY"), "normal topology rendering excludes result bodies");
assert(!rendered.includes("PRIVATE_AGGREGATION_BODY"), "normal topology rendering excludes aggregation bodies");
assert.match(rendered, /claims=1/);
assert.ok(rendered.length < JSON.stringify(run).length, "topology run should compact");
const compact = compactToolContent({ toolName: "run_topology", content: [{ type: "text", text: JSON.stringify(run) }], details: run, maxChars: 500 });
assert.match(compact, /nodes: 2/);
const summary = summarizeValue({ a: "b".repeat(1000), xs: [1, 2, 3, 4] }, { maxString: 20 });
assert.equal(summary.type, "object");
assert.equal(summary.xs.length, 4);

const retrieval = createRetrievalEnvelope({
  provider: "lsp",
  strategyId: "exact",
  freshness: "fresh",
  gatingSafe: true,
  items: [createCard({ provider: "lsp", path: "src/a.js", kind: "definition", signature: "function a()", score: 1, scoreReasons: ["exact"], freshness: "fresh", gatingSafe: true, contentRef: "sha256:a" })],
});
const retrievalText = renderRetrievalEnvelope(retrieval);
assert.match(retrievalText, /src\/a\.js/);
assert.match(retrievalText, /function a\(\)/);
assert.match(retrievalText, /ref=sha256:a/);
assert.match(retrievalText, /why=exact/);
assert.match(compactToolContent({ toolName: "code_context", details: retrieval }), /gating-safe/);
console.log("result-rendering tests passed");
