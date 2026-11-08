"use strict";
const assert = require("node:assert/strict");
const {
  DEFAULT_POLICIES,
  policyTools,
  policyFor,
  exemptionReason,
  boundToolResult,
} = require("../src/tool-output-bounds.js");

// The policy set must cover the tools that dominate local tool output.
for (const tool of ["read", "bash", "roadmap_update", "bg_run", "debug_ledger", "docs_lookup", "ast_refactor", "memory_curator", "create_subagent", "specialist_tasks", "test_gap_planner", "codegraph_context"]) {
  assert(policyFor(tool), `${tool} must have a policy`);
}
assert.equal(policyFor("edit"), null, "small tools stay unbounded");
assert.equal(policyFor("write"), null);
assert.deepEqual(policyTools(), policyTools().slice().sort(), "policy tools are reported in stable order");

function lines(count, width = 100, prefix = "line") {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1} ${"x".repeat(Math.max(0, width - prefix.length - 6))}`).join("\n");
}

// --- head cap: read keeps the start and points at the continuation offset ---
const readText = lines(400);
const readInput = { path: "src/big.js", offset: 100, limit: 400 };
const read = boundToolResult({ toolName: "read", content: [{ type: "text", text: readText }], input: readInput });
assert.equal(read.changed, true);
assert.equal(read.reason, "head");
assert(read.text.length <= DEFAULT_POLICIES.read.maxChars, "read output stays within its cap");
assert.match(read.text, /\[… \d+ chars omitted; continue with read path=src\/big\.js offset=\d+\]/);
const head = read.text.split("\n\n[…")[0];
assert(head.split("\n").length > 50, "the head keeps a useful prefix");
assert(!head.endsWith("x") || head.split("\n").every((line) => line.startsWith("line ")), "the head cuts on a line boundary");
const markerOffset = Number(/offset=(\d+)\]/.exec(read.text)[1]);
assert.equal(markerOffset, 100 + head.split("\n").length, "the continuation offset continues after the last rendered line");
assert(read.savedChars > 0);

// --- tail cap: bash keeps the end where failures and pi's footer live ---
const bashText = `${lines(300, 90, "noise")}\nERROR: the actual failure\n[Showing lines 1-300 of 300]`;
const bash = boundToolResult({ toolName: "bash", content: [{ type: "text", text: bashText }], input: { command: "make test" } });
assert.equal(bash.changed, true);
assert.equal(bash.reason, "tail");
assert(bash.text.length <= DEFAULT_POLICIES.bash.maxChars);
assert(bash.text.trimEnd().endsWith("[Showing lines 1-300 of 300]"), "the tail keeps pi's truncation footer");
assert.match(bash.text, /chars omitted from the start/);
assert.match(bash.text, /re-run with a narrower command/);

// --- structured cap: JSON payloads compact field-first ---
const matches = Array.from({ length: 120 }, (_, index) => ({ file: `src/file-${index}.js`, line: index + 1, kind: "function", snippet: `function f${index}() { return ${index}; }` }));
const astDetails = { generatedAt: new Date().toISOString(), projectPath: "/repo", matches, summary: { matches: matches.length, files: matches.length }, truncated: true };
const astText = JSON.stringify(astDetails, null, 2);
const ast = boundToolResult({ toolName: "ast_search", content: [{ type: "text", text: astText }], details: astDetails, input: { pattern: "function" } });
assert.equal(ast.changed, true);
assert.equal(ast.reason, "structured");
assert(ast.text.length < astText.length);
assert.match(ast.text, /"matches"/);

// --- roadmap_update head cap keeps the bounded page pointer ---
const roadmap = boundToolResult({ toolName: "roadmap_update", content: [{ type: "text", text: lines(120, 100, "item") }], input: { action: "show" } });
assert.equal(roadmap.changed, true);
assert(roadmap.text.length <= DEFAULT_POLICIES.roadmap_update.maxChars);
assert.match(roadmap.text, /roadmap_update action=show/);

// --- exemptions: never rewrite what the caller explicitly asked for ---
const long = lines(400);
assert.equal(exemptionReason({ content: [{ type: "text", text: long }], input: { verbose: true } }), "verbose");
assert.equal(exemptionReason({ content: [{ type: "text", text: long }], input: { maxChars: 20000 } }), "explicit-max-chars");
assert.equal(exemptionReason({ content: [{ type: "text", text: "x".repeat(3000) }], details: { rendering: { budgetTokens: 1200 } } }), "native-bounded");
assert.equal(exemptionReason({ content: [{ type: "image", data: "…" }, { type: "text", text: long }] }), "non-text-content");
assert.equal(exemptionReason({ content: [{ type: "text", text: long }], details: { rendering: { budgetTokens: 100 } } }), null, "an over-budget native view is still bounded");

const verbose = boundToolResult({ toolName: "read", content: [{ type: "text", text: long }], input: { verbose: true } });
assert.equal(verbose.changed, false);
assert.equal(verbose.text, long);

const imageRead = boundToolResult({ toolName: "read", content: [{ type: "image", data: "…" }, { type: "text", text: long }] });
assert.equal(imageRead.changed, false, "image attachments are never dropped by a text cap");

// --- no-ops ---
const short = boundToolResult({ toolName: "read", content: [{ type: "text", text: "short file" }], input: { path: "a.js" } });
assert.equal(short.changed, false);
assert.equal(short.reason, "within-budget");
const unknown = boundToolResult({ toolName: "edit", content: [{ type: "text", text: long }] });
assert.equal(unknown.changed, false);
assert.equal(unknown.reason, "no-policy");

// --- error results are bounded too, with the same continuation path ---
const failed = boundToolResult({ toolName: "bash", content: [{ type: "text", text: `${lines(300)}\nFAILED` }], input: { command: "x" }, isError: true });
assert.equal(failed.changed, true);
assert.match(failed.text, /chars omitted from the start/);

console.log("tool-output-bounds tests passed");
