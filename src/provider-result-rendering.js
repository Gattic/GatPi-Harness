"use strict";

// Model-facing projection for CodeGraph, Semgrep, and AST results.
//
// Those providers return CLI text or provider JSON that is useful in full but
// expensive to show the model. Every tool here therefore keeps the complete
// record in tool-result details and emits a bounded retrieval view as content:
// one line per card, a provider verdict, and an explicit omission hint. This is
// the same contract code_context already follows through
// compactRetrievalEnvelope, so a single renderer covers every retrieval path.

const { createRetrievalEnvelope, compactRetrievalEnvelope } = require("./code-context-contracts.js");

const DEFAULT_BUDGET_TOKENS = Object.freeze({
  codegraph_query: 700,
  codegraph_affected: 300,
  codegraph_context: 700,
  semgrep_scan: 700,
  semgrep_codegraph: 800,
  ast_search: 600,
});

const DEFAULT_RENDER_LIMITS = Object.freeze({
  codegraph_query: 20,
  codegraph_affected: 30,
  codegraph_context: 20,
  semgrep_scan: 20,
  semgrep_codegraph: 20,
  ast_search: 50,
});

const DEFAULT_CLI_LINE_LIMITS = Object.freeze({ status: 30, sync: 20, files: 30, doctor: 40 });

const SEVERITY_SCORE = Object.freeze({ ERROR: 1, WARNING: 0.7, INFO: 0.4 });
const SOURCE_MARKER = /^\*\*Source Code\*\*/m;

function estimateTextTokens(text) { return Math.ceil(Buffer.byteLength(String(text == null ? "" : text), "utf8") / 4); }

function inline(value, max = 160) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function severityScore(severity) { return SEVERITY_SCORE[String(severity || "").toUpperCase()] || 0.4; }

// Retrieval envelopes are the single shape every provider returns, so one
// renderer and one budget policy apply to CodeGraph, Semgrep, and AST alike.
function providerEnvelope(input = {}) {
  const envelope = createRetrievalEnvelope({
    provider: input.provider,
    itemType: input.itemType || "card",
    strategyId: input.strategyId,
    freshness: input.freshness,
    gatingSafe: input.gatingSafe === true,
    degradation: input.degradation,
    items: input.items || [],
    elapsedMs: input.elapsedMs,
    bytesRetrieved: input.bytesRetrieved,
    bytesReturned: input.bytesReturned,
    tokensRetrieved: input.tokensRetrieved,
    preserveOrder: input.preserveOrder === true,
    metrics: { candidatesRetrieved: input.candidatesRetrieved ?? (input.items || []).length },
  });
  // Re-rendering must retain the record constructor: treating diagnostics as
  // generic cards would discard their message and severity on normalization.
  envelope.itemType = input.itemType || "card";
  return envelope;
}

function tokenBudget(options = {}, operation = options.operation) {
  const value = Number(options.budgetTokens);
  return Number.isFinite(value) && value > 0 ? Math.max(96, Math.floor(value)) : DEFAULT_BUDGET_TOKENS[operation] || 700;
}

// Clip a display field on UTF-8 boundaries, never the retained provider record.
function fitBytes(value, maxBytes, suffix = "…") {
  const text = String(value || "");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let result = "";
  let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > room) break;
    result += char;
    size += bytes;
  }
  return result + (maxBytes >= Buffer.byteLength(suffix) ? suffix : "");
}

function recordResultRendering(details, text, rawText, options = {}) {
  details.rendering = { rawChars: String(rawText || "").length, modelChars: text.length, budgetTokens: options.verbose ? 0 : tokenBudget(options), estimatedTokens: estimateTextTokens(text) };
}

function renderingMetrics(envelope, text, budgetTokens, returned = envelope.metrics.candidatesReturned) {
  Object.assign(envelope.metrics, { candidatesReturned: returned, omittedItems: envelope.items.length - returned, bytesReturned: Buffer.byteLength(text), tokensReturned: estimateTextTokens(text), budgetTokens });
  return text;
}

// Pack ranked cards first, then account for the entire serialized view, including
// verdicts, counts and refinement hints. Details retain all cards and long fields.
function renderWithinBudget(envelope, options = {}) {
  const operation = options.operation;
  const maxItems = Math.max(1, Number(options.maxItems || DEFAULT_RENDER_LIMITS[operation] || 20));
  const budgetTokens = tokenBudget(options);
  const maxBytes = budgetTokens * 4;
  const rawFooter = (options.footer || []).filter(Boolean).join("\n");
  const footer = fitBytes(rawFooter, Math.floor(maxBytes * 0.45), "… [report shortened; details retained]");
  const view = { ...envelope, metrics: { ...envelope.metrics }, items: envelope.items.slice(0, maxItems).map((item) => ({ ...item, signature: inline(item.signature, 160), message: inline(item.message, 160) })) };
  if (view.degradation) view.degradation = { ...view.degradation, message: inline(view.degradation.message, 120) };
  const refineHint = options.refineHint || "refine the query or raise budgetTokens";
  const render = () => {
    const omitted = envelope.items.length - view.items.length;
    view.truncated = envelope.truncated || omitted > 0 || footer !== rawFooter;
    const lines = [compactRetrievalEnvelope(view, { maxItems })];
    if (footer) lines.push(footer);
    if (omitted) lines.push(`- … ${omitted} more result(s) omitted to stay within ${budgetTokens} tokens; ${refineHint}`);
    return lines.join("\n");
  };
  const measured = () => {
    let text = render();
    // Settle the self-describing token count before testing the final budget.
    for (let i = 0; i < 4 && view.metrics.tokensReturned !== estimateTextTokens(text); i++) {
      view.metrics.tokensReturned = estimateTextTokens(text);
      text = render();
    }
    return text;
  };
  let text = measured();
  while (estimateTextTokens(text) > budgetTokens && view.items.length) {
    view.items.pop();
    text = measured();
  }
  if (estimateTextTokens(text) > budgetTokens) {
    // At very small budgets the verdict and a large footer can fill the view
    // even without cards. Keep the authority/counts ahead of shortened prose.
    const verdict = `${envelope.provider} (${envelope.freshness}, ${envelope.gatingSafe ? "gating-safe" : "advisory"})`;
    const degraded = envelope.degradation ? `\ndegraded ${envelope.degradation.code}` : "";
    text = fitBytes(`${verdict}\ncandidates 0/${envelope.metrics.candidatesRetrieved}${degraded}\n${envelope.items.length} omitted; refine query/budgetTokens\n${footer}`, maxBytes, "… [details retained]");
    view.truncated = true;
  }
  envelope.truncated = view.truncated;
  return renderingMetrics(envelope, text, budgetTokens, view.items.length);
}

function codegraphQueryItems(rows, metadata = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const top = Math.max(1, ...list.map((row) => Number(row?.score || 0)));
  return list.map((row) => {
    const node = row?.node || row || {};
    const score = Math.max(0, Math.min(1, Number(row?.score || 0) / top));
    return {
      provider: "codegraph",
      path: node.filePath || row?.filePath || row?.path,
      symbolId: node.id || row?.id,
      kind: node.kind || "symbol",
      signature: node.name ? `${node.name}${node.signature || ""}` : node.qualifiedName,
      range: node.startLine ? { startLine: node.startLine, startColumn: Number(node.startColumn || 0) + 1, endLine: node.endLine || node.startLine, endColumn: Number(node.endColumn || 0) + 1 } : undefined,
      score,
      scoreReasons: [score >= 1 ? "top_rank" : "ranked"],
      freshness: metadata.freshness,
      gatingSafe: metadata.gatingSafe === true,
      provenance: [{ provider: "codegraph", operation: "query" }],
    };
  });
}

function codegraphQueryEnvelope(input = {}) {
  const metadata = input.metadata || {};
  const rows = Array.isArray(input.rows) ? input.rows : [];
  return providerEnvelope({
    provider: "codegraph",
    itemType: "card",
    strategyId: "codegraph:query",
    freshness: metadata.freshness,
    gatingSafe: metadata.gatingSafe,
    degradation: metadata.degradation,
    items: codegraphQueryItems(rows, metadata),
    candidatesRetrieved: rows.length,
    elapsedMs: input.elapsedMs,
    bytesRetrieved: input.bytesRetrieved,
  });
}

function codegraphAffectedEnvelope(input = {}) {
  const metadata = input.metadata || {};
  const parsed = input.parsed || {};
  const tests = Array.isArray(parsed.affectedTests) ? parsed.affectedTests : [];
  const changedFiles = Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [];
  const envelope = providerEnvelope({
    provider: "codegraph",
    itemType: "test",
    strategyId: "codegraph:affected",
    freshness: metadata.freshness,
    // Affected-test hints are advisory by contract, never a gating input.
    gatingSafe: false,
    degradation: metadata.degradation,
    items: tests.map((test) => ({ provider: "codegraph", path: test, testId: test, kind: "test", signature: "affected test", status: "recommended", freshness: metadata.freshness, gatingSafe: false, provenance: [{ provider: "codegraph", operation: "affected" }] })),
    candidatesRetrieved: tests.length,
    preserveOrder: true,
    elapsedMs: input.elapsedMs,
    bytesRetrieved: input.bytesRetrieved,
  });
  envelope.changedFiles = changedFiles;
  envelope.dependentsTraversed = Math.max(0, Number(parsed.totalDependentsTraversed || 0));
  return envelope;
}

function splitExploreOutput(text) {
  const value = String(text == null ? "" : text);
  const match = value.match(SOURCE_MARKER);
  if (!match) return { summary: value, source: "" };
  return { summary: value.slice(0, match.index), source: value.slice(match.index) };
}

function exploreBlastRadiusItems(summary, metadata = {}) {
  const items = [];
  const bullet = /^- `([^`]+)` \(([^:)]+):(\d+)\)/;
  for (const line of String(summary || "").split(/\r?\n/)) {
    const match = line.match(bullet);
    if (!match) continue;
    const [, name, file, lineNumber] = match;
    items.push({
      provider: "codegraph",
      path: file.trim(),
      symbolId: name.trim(),
      kind: "definition",
      signature: name.trim(),
      range: { startLine: Number(lineNumber), endLine: Number(lineNumber) },
      score: 1,
      scoreReasons: ["blast_radius"],
      freshness: metadata.freshness,
      gatingSafe: metadata.gatingSafe === true,
      provenance: [{ provider: "codegraph", operation: "explore" }],
    });
  }
  return items;
}

function exploreRelationshipSummary(summary) {
  const counts = {};
  let section = null;
  for (const line of String(summary || "").split(/\r?\n/)) {
    const header = line.match(/^\*\*([A-Za-z ]+):\*\*$/);
    if (header) { section = header[1].trim().toLowerCase(); counts[section] = counts[section] || { shown: 0, more: 0 }; continue; }
    if (!section) continue;
    const more = line.match(/^\.\.\. and (\d+) more$/);
    if (more) { counts[section].more += Number(more[1]); continue; }
    if (/^- /.test(line)) counts[section].shown += 1;
  }
  return counts;
}

function exploreHeadline(summary) {
  const found = String(summary || "").match(/^Found (\d+) symbols? across (\d+) files?\.$/m);
  if (!found) return null;
  return `found ${found[1]} symbol(s) across ${found[2]} file(s)`;
}

function exploreNarrative(summary, options = {}) {
  const keepBullets = options.keepBullets === true;
  const maxLines = Math.max(1, Number(options.maxLines || 12));
  const lines = String(summary || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => keepBullets || !/^- /.test(line))
    .map((line) => line.replace(/^>+\s*/, ""));
  const kept = lines.slice(0, maxLines);
  if (lines.length > kept.length) kept.push(`… ${lines.length - kept.length} more line(s)`);
  return kept;
}

function codegraphContextEnvelope(input = {}) {
  const metadata = input.metadata || {};
  const split = splitExploreOutput(input.text);
  const envelope = providerEnvelope({
    provider: "codegraph",
    itemType: "card",
    strategyId: "codegraph:explore",
    freshness: metadata.freshness,
    gatingSafe: metadata.gatingSafe,
    degradation: metadata.degradation,
    items: exploreBlastRadiusItems(split.summary, metadata),
    preserveOrder: true,
    elapsedMs: input.elapsedMs,
    bytesRetrieved: input.bytesRetrieved,
  });
  envelope.exploreHeadline = exploreHeadline(split.summary);
  envelope.relationships = exploreRelationshipSummary(split.summary);
  envelope.exploreSummary = split.summary;
  envelope.sourceChars = split.source.length;
  envelope.source = split.source;
  return envelope;
}

function renderCodegraphContext(envelope, options = {}) {
  const footer = [];
  const relationships = envelope.relationships || {};
  const sections = Object.entries(relationships).map(([name, counts]) => `${name}=${counts.shown}${counts.more ? `+${counts.more}` : ""}`);
  if (sections.length) footer.push(`relationships: ${sections.join(" ")}`);
  for (const line of options.footer || []) if (line) footer.push(line);
  const sourceChars = Number(envelope.sourceChars || 0);
  const includeSource = options.includeSource === true;
  if (!includeSource && sourceChars) footer.push(`source omitted (${sourceChars} chars); pass includeSource=true to expand the verbatim section`);
  const budgetTokens = tokenBudget(options, "codegraph_context");
  const reserve = includeSource && sourceChars ? Math.floor(budgetTokens * 0.4) : 0;
  const refineHint = "raise maxFiles/budgetTokens, add includeSource=true for verbatim source, or narrow the task";
  if (envelope.exploreHeadline) footer.push(`scope: ${envelope.exploreHeadline}`);
  if (!envelope.items.length) footer.push(...exploreNarrative(envelope.exploreSummary, { keepBullets: true, maxLines: options.maxLines || 12 }));
  const base = renderWithinBudget(envelope, { ...options, operation: "codegraph_context", budgetTokens: budgetTokens - reserve, footer, refineHint });
  if (!includeSource || !sourceChars) return renderingMetrics(envelope, base, budgetTokens);
  const source = String(envelope.source || "");
  const room = Math.max(0, budgetTokens * 4 - Buffer.byteLength(base) - 1);
  const bounded = fitBytes(source, room, "\n… source shortened; full source in details");
  if (bounded !== source) envelope.truncated = true;
  return renderingMetrics(envelope, bounded ? `${base}\n${bounded}` : base, budgetTokens);
}

function semgrepFindingItems(findings, metadata = {}) {
  // Provider output is file-ordered, but the budget keeps a prefix: severity has
  // to decide what survives, so the highest-severity findings render first and
  // the informational ones are the ones dropped.
  const ranked = (Array.isArray(findings) ? findings : []).slice().sort((a, b) => severityScore(b?.severity) - severityScore(a?.severity));
  return ranked.map((finding) => ({
    provider: "semgrep",
    path: finding.path,
    kind: "diagnostic",
    severity: String(finding.severity || "INFO").toLowerCase(),
    code: finding.checkId,
    signature: finding.checkId,
    message: finding.message,
    range: finding.start ? { startLine: Number(finding.start.line || 1), startColumn: Number(finding.start.col || 1), endLine: Number(finding.end?.line || finding.start.line || 1), endColumn: Number(finding.end?.col || finding.start.col || 1) } : undefined,
    score: severityScore(finding.severity),
    scoreReasons: [`severity_${String(finding.severity || "INFO").toLowerCase()}`],
    freshness: metadata.freshness || "fresh",
    gatingSafe: metadata.gatingSafe === true,
    provenance: [{ provider: "semgrep", operation: metadata.operation || "scan" }],
  }));
}

function semgrepScanEnvelope(input = {}) {
  const metadata = input.metadata || {};
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const summary = input.summary || {};
  const envelope = providerEnvelope({
    provider: "semgrep",
    itemType: "diagnostic",
    strategyId: "semgrep:scan",
    freshness: metadata.freshness || "fresh",
    gatingSafe: metadata.gatingSafe === true,
    degradation: metadata.degradation,
    items: semgrepFindingItems(findings, metadata),
    candidatesRetrieved: Number(summary.findings || findings.length),
    preserveOrder: true,
    elapsedMs: input.elapsedMs,
    bytesRetrieved: input.bytesRetrieved,
  });
  envelope.scanStatus = input.scanStatus || summary.status || "unknown";
  envelope.severityCounts = summary.severityCounts || {};
  envelope.topChecks = Array.isArray(summary.topChecks) ? summary.topChecks : [];
  envelope.files = Number(summary.files || 0);
  envelope.truncatedFindings = summary.truncatedFindings || null;
  return envelope;
}

function renderSemgrep(envelope, options = {}) {
  const footer = [];
  const severity = Object.entries(envelope.severityCounts || {}).map(([name, count]) => `${name}=${count}`);
  footer.push(`scan=${envelope.scanStatus} findings=${envelope.metrics.candidatesRetrieved} files=${envelope.files || 0}${severity.length ? ` severity=${severity.join(",")}` : ""}`);
  const checks = (envelope.topChecks || []).slice(0, 5).map((row) => `${row.checkId}=${row.count}`);
  if (checks.length) footer.push(`top rules: ${checks.join(", ")}`);
  if (envelope.truncatedFindings) footer.push(`provider returned ${envelope.truncatedFindings.returned} of ${envelope.truncatedFindings.total} finding(s)`);
  for (const line of options.footer || []) if (line) footer.push(line);
  return renderWithinBudget(envelope, { ...options, footer, refineHint: "raise maxFindings/budgetTokens or narrow files/include" });
}

function semgrepCodegraphEnvelope(input = {}) {
  const metadata = input.metadata || {};
  const graph = input.graph || {};
  const envelope = semgrepScanEnvelope({ ...input, metadata: { ...metadata, gatingSafe: false } });
  envelope.strategyId = "semgrep:codegraph";
  envelope.affectedTests = Array.isArray(graph.tests) ? graph.tests : [];
  envelope.graphStatus = graph.status || "skipped";
  envelope.graphFreshness = graph.freshness || "unknown";
  envelope.graphDegradation = graph.degradation || null;
  envelope.files = Array.isArray(input.files) ? input.files.length : envelope.files;
  return envelope;
}

function renderSemgrepCodegraph(envelope, options = {}) {
  const footer = [];
  const tests = Array.isArray(envelope.affectedTests) ? envelope.affectedTests : [];
  footer.push(`codegraph=${envelope.graphStatus} affectedTests=${tests.length}${tests.length ? `: ${tests.slice(0, 8).join(", ")}${tests.length > 8 ? "…" : ""}` : ""}`);
  footer.push(`graph freshness=${envelope.graphFreshness}; advisory${envelope.graphDegradation ? `; degraded ${envelope.graphDegradation.code}: ${inline(envelope.graphDegradation.message, 100)}` : ""}`);
  for (const line of options.footer || []) if (line) footer.push(line);
  return renderSemgrep(envelope, { ...options, footer });
}

function astMatchItems(matches, metadata = {}) {
  return (Array.isArray(matches) ? matches : []).map((match, index) => ({
    provider: "ast",
    path: match.file,
    kind: match.kind || "text",
    symbolId: match.name,
    signature: match.preview ? `${match.name} — ${inline(match.preview, 140)}` : match.name,
    range: match.loc ? { startLine: match.loc.start.line, startColumn: match.loc.start.column, endLine: match.loc.end?.line || match.loc.start.line, endColumn: match.loc.end?.column || match.loc.start.column } : undefined,
    score: Math.max(0.1, 1 - index / Math.max(1, (matches || []).length)),
    scoreReasons: ["lexical_match"],
    freshness: metadata.freshness || "fresh",
    gatingSafe: false,
    provenance: [{ provider: "ast", operation: metadata.operation || "search" }],
  }));
}

function astSearchEnvelope(input = {}) {
  const matches = Array.isArray(input.matches) ? input.matches : [];
  const envelope = providerEnvelope({
    provider: "ast",
    itemType: "card",
    strategyId: "ast:search",
    freshness: input.freshness || "fresh",
    // Lexical heuristics are never compiler-resolved, so this is always advisory.
    gatingSafe: false,
    degradation: input.degradation,
    items: astMatchItems(matches, input.metadata || {}),
    candidatesRetrieved: Number(input.totalMatches ?? matches.length),
    preserveOrder: true,
    elapsedMs: input.elapsedMs,
  });
  envelope.matchLimit = Number(input.matchLimit || matches.length);
  envelope.truncatedMatches = Boolean(input.truncatedMatches);
  // Reaching the match limit already makes the result set incomplete; the
  // separate flag records why, so a render trim does not hide it.
  if (envelope.truncatedMatches) envelope.truncated = true;
  return envelope;
}

function renderAstSearch(envelope, options = {}) {
  const footer = [`lexical heuristics only; not compiler-resolved`];
  if (envelope.truncatedMatches) footer.push(`match limit ${envelope.matchLimit} reached; refine pattern, include, or exclude`);
  for (const line of options.footer || []) if (line) footer.push(line);
  return renderWithinBudget(envelope, { ...options, footer, refineHint: "refine pattern/include/exclude or raise maxResults" });
}

function renderCodegraphAffected(envelope, options = {}) {
  return renderWithinBudget(envelope, { ...options, operation: "codegraph_affected", footer: [`changed files: ${(envelope.changedFiles || []).slice(0, 10).join(", ") || "none"}; dependents traversed=${envelope.dependentsTraversed || 0}`, ...(options.footer || [])], refineHint: "raise depth/budgetTokens or pass a narrower files list" });
}

function renderProviderEnvelope(envelope, options = {}) {
  const operation = { "codegraph:query": "codegraph_query", "codegraph:affected": "codegraph_affected", "codegraph:explore": "codegraph_context", "semgrep:scan": "semgrep_scan", "semgrep:codegraph": "semgrep_codegraph", "ast:search": "ast_search" }[envelope.strategyId];
  const budgetTokens = options.maxChars ? Math.min(tokenBudget(options, operation), Math.max(96, Math.floor(options.maxChars / 4))) : tokenBudget(options, operation);
  const renderOptions = { ...options, operation, budgetTokens };
  switch (envelope.strategyId) {
    case "codegraph:affected": return renderCodegraphAffected(envelope, renderOptions);
    case "codegraph:explore": return renderCodegraphContext(envelope, renderOptions);
    case "semgrep:scan": return renderSemgrep(envelope, renderOptions);
    case "semgrep:codegraph": return renderSemgrepCodegraph(envelope, renderOptions);
    case "ast:search": return renderAstSearch(envelope, renderOptions);
    default: return renderWithinBudget(envelope, renderOptions);
  }
}

// Non-JSON CLI reports (status, sync, file lists) are bounded by lines instead
// of an envelope: they are operator diagnostics, not retrieval candidates.
function renderCliText(text, options = {}) {
  const operation = options.operation || "status";
  const maxLines = Math.max(1, Number(options.maxLines || DEFAULT_CLI_LINE_LIMITS[operation] || 30));
  const lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    kept.push(line);
    if (kept.length >= maxLines) break;
  }
  const omitted = Math.max(0, lines.filter((line) => line.trim()).length - kept.length);
  const footer = [...(options.footer || [])];
  if (omitted) footer.push(`- … ${omitted} more line(s) omitted; use verbose=true for the full report`);
  return fitBytes([...kept, ...footer.filter(Boolean)].join("\n"), tokenBudget(options) * 4, "\n… report shortened; full report in details or verbose=true");
}

module.exports = {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_RENDER_LIMITS,
  DEFAULT_CLI_LINE_LIMITS,
  SEVERITY_SCORE,
  SOURCE_MARKER,
  estimateTextTokens,
  tokenBudget,
  fitBytes,
  renderingMetrics,
  recordResultRendering,
  inline,
  severityScore,
  providerEnvelope,
  renderWithinBudget,
  codegraphQueryItems,
  codegraphQueryEnvelope,
  codegraphAffectedEnvelope,
  splitExploreOutput,
  exploreBlastRadiusItems,
  exploreRelationshipSummary,
  exploreHeadline,
  exploreNarrative,
  codegraphContextEnvelope,
  renderCodegraphContext,
  renderCodegraphAffected,
  renderProviderEnvelope,
  semgrepFindingItems,
  semgrepScanEnvelope,
  renderSemgrep,
  semgrepCodegraphEnvelope,
  renderSemgrepCodegraph,
  astMatchItems,
  astSearchEnvelope,
  renderAstSearch,
  renderCliText,
};
