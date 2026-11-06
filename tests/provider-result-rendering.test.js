"use strict";
const assert = require("node:assert/strict");
const {
  DEFAULT_BUDGET_TOKENS,
  estimateTextTokens,
  renderWithinBudget,
  codegraphQueryEnvelope,
  codegraphContextEnvelope,
  renderCodegraphContext,
  semgrepScanEnvelope,
  renderSemgrep,
  semgrepCodegraphEnvelope,
  renderSemgrepCodegraph,
  astSearchEnvelope,
  renderAstSearch,
  renderCliText,
} = require("../src/provider-result-rendering.js");

// A retrieval view is bounded by a token budget, not by a character cap, and it
// says what it dropped instead of silently shrinking the result.
const rows = Array.from({ length: 60 }, (_, index) => ({
  score: 60 - index,
  node: { id: `n${index}`, name: `symbol_${index}`, kind: "function", filePath: `src/file-${index}.js`, startLine: index + 1, startColumn: 0, endLine: index + 2, endColumn: 4, signature: "(alpha, beta, gamma, delta)" },
}));
const queryEnvelope = codegraphQueryEnvelope({ rows, metadata: { freshness: "fresh", gatingSafe: true } });
assert.equal(queryEnvelope.items.length, 60, "the envelope keeps the full provider record");
assert.equal(queryEnvelope.items[0].signature.startsWith("symbol_0"), true, "rank order is preserved");

const queryView = renderWithinBudget(queryEnvelope, { operation: "codegraph_query", budgetTokens: 260, refineHint: "raise limit/budgetTokens" });
assert(estimateTextTokens(queryView) <= 260, `bounded view fits the budget (${estimateTextTokens(queryView)} tokens)`);
assert(queryEnvelope.metrics.omittedItems > 0, "the omission count is recorded on the envelope");
assert(queryEnvelope.truncated === true);
assert.match(queryView, /more result\(s\) omitted to stay within 260 tokens/);
assert.match(queryView, /raise limit\/budgetTokens/, "the hint says how to widen the view");
assert.match(queryView, /candidates \d+\/60/, "the header still reports how many candidates existed");
assert.equal(queryEnvelope.items.length, 60, "rendering works on a copy, so details keep every item");

const defaultView = renderWithinBudget(queryEnvelope, { operation: "codegraph_query" });
assert(estimateTextTokens(defaultView) <= DEFAULT_BUDGET_TOKENS.codegraph_query, "the default budget applies when none is passed");

// A task-focused explore returns signatures by default; verbatim source is the
// expensive part and is only appended when explicitly requested.
const exploreText = [
  "Found 2 symbols across 2 files.",
  "",
  "**Callers:**",
  "- `a` (src/a.js:12)",
  "- `b` (src/b.js:40)",
  "... and 4 more",
  "",
  "**Source Code**",
  "function a() { return 1; }",
  "function b() { return 2; }",
].join("\n");
const contextEnvelope = codegraphContextEnvelope({ text: exploreText, metadata: { freshness: "fresh", gatingSafe: true } });
assert(contextEnvelope.sourceChars > 0);
assert.equal(contextEnvelope.items[0].path, "src/a.js");
const contextDefault = renderCodegraphContext(contextEnvelope, { operation: "codegraph_context" });
assert.doesNotMatch(contextDefault, /function a\(\)/, "verbatim source is omitted by default");
assert.match(contextDefault, /source omitted \(\d+ chars\); pass includeSource=true/);
const contextExpanded = renderCodegraphContext(contextEnvelope, { operation: "codegraph_context", includeSource: true, budgetTokens: 700 });
assert.match(contextExpanded, /function a\(\)/, "includeSource=true expands the verbatim section");
assert(estimateTextTokens(contextExpanded) <= 700, "even the expanded view stays inside the budget");
assert.match(contextDefault, /relationships: callers=2\+4/, "relationship counts stay visible");
assert.match(contextDefault, /scope: found 2 symbol\(s\) across 2 file\(s\)/);

// Findings are ranked by severity so the budget keeps the actionable ones and
// the per-rule/per-severity counts still describe the whole scan.
const findings = [
  ...Array.from({ length: 12 }, (_, index) => ({ checkId: "info.rule", path: `src/i${index}.js`, severity: "INFO", message: "informational", start: { line: 1, col: 1 } })),
  ...Array.from({ length: 3 }, (_, index) => ({ checkId: "warning.rule", path: `src/w${index}.js`, severity: "WARNING", message: "warning", start: { line: 2, col: 1 } })),
  { checkId: "error.rule", path: "src/e.js", severity: "ERROR", message: "error", start: { line: 3, col: 1 } },
];
const scanEnvelope = semgrepScanEnvelope({
  findings,
  summary: { findings: findings.length, files: 16, severityCounts: { ERROR: 1, WARNING: 3, INFO: 12 }, topChecks: [{ checkId: "info.rule", count: 12 }, { checkId: "warning.rule", count: 3 }, { checkId: "error.rule", count: 1 }] },
  scanStatus: "ok",
});
assert.equal(scanEnvelope.items[0].severity, "error", "the highest severity renders first");
assert.equal(scanEnvelope.items.at(-1).severity, "info", "informational findings are the ones dropped");
const scanView = renderSemgrep(scanEnvelope, { operation: "semgrep_scan", budgetTokens: 240 });
assert(estimateTextTokens(scanView) <= 240, `semgrep view fits the budget (${estimateTextTokens(scanView)} tokens)`);
assert.match(scanView, /scan=ok findings=16 files=16/);
assert.match(scanView, /severity=ERROR=1,WARNING=3,INFO=12/, "severity counts describe the whole scan, not just the rendered slice");
assert.match(scanView, /top rules: info\.rule=12, warning\.rule=3, error\.rule=1/);
assert.match(scanView, /more result\(s\) omitted/);

const combinedEnvelope = semgrepCodegraphEnvelope({ findings, summary: { findings: findings.length, severityCounts: { ERROR: 1 } }, scanStatus: "findings", graph: { status: "ok", tests: ["tests/a.test.js", "tests/b.test.js"] }, files: ["src/e.js"] });
assert.equal(combinedEnvelope.items.length, findings.length, "combined scan retains the findings");
assert.equal(combinedEnvelope.scanStatus, "findings");
const combinedView = renderSemgrepCodegraph(combinedEnvelope, { operation: "semgrep_codegraph", budgetTokens: 300 });
assert.match(combinedView, /codegraph=ok affectedTests=2: tests\/a\.test\.js, tests\/b\.test\.js/, "advisory test hints stay visible alongside findings");

// AST: a reached match limit is reported with a refinement hint rather than
// pretending the result set is complete.
const matches = Array.from({ length: 80 }, (_, index) => ({ file: `src/m${index}.js`, kind: "identifier", name: "handler", preview: "const handler = create();", loc: { start: { line: index + 1, column: 1 }, end: { line: index + 1, column: 20 } } }));
const astEnvelope = astSearchEnvelope({ matches, matchLimit: 80, truncatedMatches: true });
const astView = renderAstSearch(astEnvelope, { operation: "ast_search" });
assert.match(astView, /match limit 80 reached; refine pattern, include, or exclude/);
assert.match(astView, /lexical heuristics only; not compiler-resolved/, "the advisory nature stays visible");
assert(estimateTextTokens(astView) <= DEFAULT_BUDGET_TOKENS.ast_search, `ast view fits the budget (${estimateTextTokens(astView)} tokens)`);
assert(astEnvelope.metrics.omittedItems > 0);

const astComplete = renderAstSearch(astSearchEnvelope({ matches: matches.slice(0, 2), matchLimit: 50 }), { operation: "ast_search" });
assert.doesNotMatch(astComplete, /match limit/, "no limit hint when the search was complete");

// Non-JSON CLI reports are line-bounded and say where the rest went.
const cli = renderCliText(["line 1", "", "line 2", "line 3", "line 4"].join("\n"), { operation: "status", maxLines: 2, command: "codegraph status" });
assert.equal(cli.split("\n").length, 3, "two kept lines plus one omission hint");
assert.match(cli, /line 1\nline 2\n- … 2 more line\(s\) omitted; use verbose=true/);
assert.equal(renderCliText("only line", { operation: "sync" }), "only line", "a short report is returned unchanged");

// A single oversized card, an empty degraded result, and unstructured explore
// text must obey the same budget as ordinary multi-card results.
for (const count of [0, 1, 40]) {
  const envelope = codegraphQueryEnvelope({ rows: rows.slice(0, count), metadata: { freshness: "stale", gatingSafe: false, degradation: { code: "stale_index", message: "stale ".repeat(300) } } });
  if (count) envelope.items[0].signature = "巨大".repeat(3000);
  const text = renderWithinBudget(envelope, { operation: "codegraph_query", budgetTokens: 180, footer: ["readiness: unknown " + "detail ".repeat(400)] });
  assert(estimateTextTokens(text) <= 180, `budget includes all text, including long fields (count=${count})`);
  assert.match(text, /stale.*advisory/);
  assert.match(text, /degraded stale_index/);
  assert.equal(envelope.metrics.tokensReturned, estimateTextTokens(text), "metrics count the entire returned view");
  assert.equal(envelope.metrics.bytesReturned, Buffer.byteLength(text));
  assert.equal(envelope.metrics.candidatesReturned + envelope.metrics.omittedItems, count);
}
const unstructured = codegraphContextEnvelope({ text: "narrative ".repeat(5000), metadata: { freshness: "unknown", gatingSafe: false } });
assert(estimateTextTokens(renderCodegraphContext(unstructured, { budgetTokens: 180 })) <= 180);
const largeSource = codegraphContextEnvelope({ text: exploreText + "\n" + "巨大".repeat(5000), metadata: { freshness: "fresh" } });
assert(estimateTextTokens(renderCodegraphContext(largeSource, { budgetTokens: 180, includeSource: true })) <= 180, "UTF-8 source plus omission notice fits budget");

console.log("provider-result-rendering tests passed");
