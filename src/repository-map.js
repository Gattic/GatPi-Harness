"use strict";

const path = require("node:path");
const { createCard, createRetrievalEnvelope, deterministicId, sourceKindForPath } = require("./code-context-contracts.js");

const WEIGHTS = Object.freeze({ task: 0.30, mentioned: 0.18, changed: 0.12, failure: 0.12, graph: 0.12, build: 0.08, test: 0.05, recent: 0.03 });
const EXPANDED_WEIGHTS = Object.freeze({ ...WEIGHTS, dependency: 0 });
const QUERY_STOP_WORDS = new Set(["a", "an", "and", "the", "to", "for", "from", "with", "without", "after", "before", "between", "per", "once", "not", "now", "add", "fix", "keep", "make", "teach", "repair", "wait"]);
const QUERY_IGNORED_WORDS = new Set(["src", "test", "tests", "index", "js", "ts", "json"]);
function normalizedWord(value) {
  const word = String(value || "").toLowerCase();
  if (word.length > 5 && word.endsWith("ing")) {
    let base = word.slice(0, -3);
    if (/([b-df-hj-np-tv-z])\1$/.test(base)) base = base.slice(0, -1);
    return base;
  }
  if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}
function words(value) { const expanded = String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"); const out = []; for (const token of expanded.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/g) || []) for (const part of token.split(/[._-]+/)) { const normalized = normalizedWord(part); if (normalized.length >= 2 && !QUERY_STOP_WORDS.has(normalized) && !QUERY_IGNORED_WORDS.has(normalized)) out.push(normalized); } return out; }
function rawTerms(value) { return new Set(String(value || "").toLowerCase().match(/[a-z_$][a-z0-9_$.-]*/g) || []); }
function terms(value) { const out = new Set(); const expanded = String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"); for (const token of expanded.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/g) || []) { const parts = token.split(/[._-]+/).map(normalizedWord).filter((part) => part.length >= 2 && !QUERY_STOP_WORDS.has(part) && !QUERY_IGNORED_WORDS.has(part)); for (const part of parts) out.add(part); if (parts.length > 1) out.add(parts.join("")); } return out; }
function taskQueries(value, limit = 16) { const tokens = words(value); const queries = []; const add = (query) => { if (query && !queries.includes(query)) queries.push(query); }; if (tokens.length >= 2) add(`${tokens[0]}-${tokens[1]}`); for (const token of tokens) add(token); for (let index = 1; index < tokens.length; index += 1) { add(`${tokens[index - 1]}-${tokens[index]}`); add(`${tokens[index - 1]}${tokens[index]}`); } return queries.slice(0, Math.max(1, Math.min(16, Number(limit) || 16))); }
function overlapScore(a, b) { const A = terms(a), B = terms(b); if (!A.size || !B.size) return 0; let hits = 0; for (const term of A) if (B.has(term)) hits++; return hits / Math.max(1, A.size); }
function listed(value, candidate) { const list = new Set((value || []).map((item) => String(item).toLowerCase())); return list.has(String(candidate.path || "").toLowerCase()) || list.has(String(candidate.symbolId || candidate.name || "").toLowerCase()); }
function estimateTokens(value) { return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4); }
function candidateText(candidate) { return [candidate.path, candidate.name, candidate.symbolId, candidate.signature, candidate.kind, ...(candidate.relations || [])].filter(Boolean).join(" "); }
function candidateScore(candidate, input) {
  const text = candidateText(candidate);
  const termParser = input.queryExpansion === true ? terms : rawTerms;
  const taskTerms = termParser(input.task);
  const textTerms = termParser(text);
  const queryTerms = input.queryExpansion === true ? new Set((candidate.queryTerms || []).flatMap((value) => Array.from(terms(value)))) : new Set();
  const evidenceTerms = new Set([...textTerms, ...queryTerms]);
  const exactTerms = Array.from(taskTerms).filter((term) => evidenceTerms.has(term));
  const scoringTerms = candidate.provider === "ripgrep" ? Array.from(taskTerms).filter((term) => textTerms.has(term)) : exactTerms;
  const exactIdentifier = [candidate.name, candidate.symbolId].filter(Boolean).some((value) => { const identifierTerms = terms(value); return (taskTerms.size === 1 || identifierTerms.size > 1) && taskTerms.has(String(value).toLowerCase()); });
  const termCoverage = scoringTerms.length / Math.max(1, taskTerms.size);
  const queryCoverage = candidate.provider === "ripgrep" ? 0 : Math.max(0, Math.min(1, Number(candidate.queryCoverage || 0)));
  const expandedTaskScore = Math.max(Math.min(1, termCoverage + (exactIdentifier ? 0.15 : 0)), queryCoverage);
  const implementationRelevance = input.queryExpansion === true && /^(?:src|extensions|\.pi\/extensions)\//.test(String(candidate.path || "")) ? 0.5 : 0;
  const components = {
    task: input.queryExpansion === true ? expandedTaskScore : exactIdentifier ? 1 : termCoverage,
    mentioned: listed(input.seeds, candidate) || listed(input.mentionedSymbols, candidate) ? 1 : Number(candidate.mentionedProximity || 0),
    changed: listed(input.changedPaths, candidate) ? 1 : Number(candidate.changedProximity || 0),
    failure: listed(input.failurePaths, candidate) || listed(input.diagnosticPaths, candidate) ? 1 : Number(candidate.failureProximity || 0),
    graph: Math.max(0, Math.min(1, Number(input.queryExpansion === true && candidate.provider === "ripgrep" ? candidate.score || 0 : candidate.graphScore || candidate.centrality || 0))),
    dependency: Math.max(0, Math.min(1, Number(candidate.dependencySupport || 0))),
    build: Math.max(0, Math.min(1, Math.max(Number(candidate.buildRelevance || 0), implementationRelevance))),
    test: Math.max(0, Math.min(1, Number(candidate.testProximity || 0))),
    recent: listed(input.recentSelections, candidate) ? 1 : Number(candidate.recentRelevance || 0),
  };
  const weights = input.queryExpansion === true ? EXPANDED_WEIGHTS : WEIGHTS;
  const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * Math.max(0, Math.min(1, components[key] || 0)), 0);
  const reasons = Object.entries(components).filter(([, value]) => value > 0).map(([key, value]) => `${key}=${Number(value).toFixed(3)}`);
  if (scoringTerms.length || exactIdentifier) reasons.unshift("exact_term");
  return { score, reasons, exact: scoringTerms.length > 0 || exactIdentifier, components, matchedTerms: exactTerms, dependencyTargets: candidate.dependencyTargets || [] };
}
function toMapCard(candidate, input) {
  const pathValue = candidate.path || candidate.file || candidate.filePath;
  const ranked = candidateScore({ ...candidate, path: pathValue }, input);
  const sourceKind = candidate.sourceKind || sourceKindForPath(pathValue);
  const card = createCard({
    provider: candidate.provider || "repository-map",
    strategyId: input.strategyId || (input.queryExpansion === true ? "repository-map-v2" : "repository-map-v1"),
    revision: input.revision,
    configuration: input.configuration,
    path: pathValue,
    sourceKind,
    symbolId: candidate.symbolId || candidate.id || candidate.name,
    kind: candidate.kind === "file" ? "file" : "symbol",
    range: candidate.range,
    signature: String(candidate.signature || candidate.name || candidate.qualifiedName || path.basename(pathValue || "repository")).slice(0, 1000),
    score: ranked.score,
    scoreReasons: ranked.reasons,
    contentHash: candidate.contentHash,
    freshness: candidate.freshness || input.freshness || "unknown",
    degradation: candidate.degradation,
    gatingSafe: candidate.gatingSafe === true,
    provenance: candidate.provenance || [{ provider: candidate.provider || "repository-map", operation: "candidate" }],
  });
  Object.defineProperty(card, "matchedTerms", { value: ranked.matchedTerms, enumerable: false });
  Object.defineProperty(card, "dependencySupport", { value: ranked.components.dependency, enumerable: false });
  Object.defineProperty(card, "dependencyTargets", { value: ranked.dependencyTargets, enumerable: false });
  return card;
}
function conceptDiverseCards(cards, task) {
  const taskTermCount = Math.max(1, terms(task).size);
  const covered = new Set();
  const remaining = [...cards];
  const selected = [];
  if (remaining.length) {
    const first = remaining.shift();
    Object.defineProperty(first, "selectionAdjusted", { value: Number(first.score || 0), enumerable: false, configurable: true });
    selected.push(first);
    for (const term of first.matchedTerms || []) covered.add(term);
  }
  const centralIndex = remaining.reduce((best, card, index) => Number(card.dependencySupport || 0) > Number(remaining[best]?.dependencySupport || 0) ? index : best, 0);
  const central = remaining[centralIndex];
  if (central && Number(central.dependencySupport || 0) >= 0.5) {
    remaining.splice(centralIndex, 1);
    Object.defineProperty(central, "selectionAdjusted", { value: Number(central.score || 0) + 0.12 * Number(central.dependencySupport || 0), enumerable: false, configurable: true });
    selected.push(central);
    for (const term of central.matchedTerms || []) covered.add(term);
    const owners = remaining.filter((card) => /^(?:src|extensions|\.pi\/extensions)\//.test(String(card.path || "")) && (card.dependencyTargets || []).includes(central.path)).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.path || "").localeCompare(String(b.path || ""))).slice(0, 2);
    for (const owner of owners) {
      remaining.splice(remaining.indexOf(owner), 1);
      Object.defineProperty(owner, "selectionAdjusted", { value: Number(owner.score || 0), enumerable: false, configurable: true });
      selected.push(owner);
      for (const term of owner.matchedTerms || []) covered.add(term);
    }
  }
  while (remaining.length) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const card = remaining[index];
      const matched = card.matchedTerms || [];
      const novel = matched.filter((term) => !covered.has(term)).length;
      const redundant = Math.max(0, matched.length - novel);
      const adjusted = Number(card.score || 0) + 0.10 * novel / taskTermCount - 0.04 * redundant / taskTermCount + 0.12 * Number(card.dependencySupport || 0);
      if (adjusted > bestAdjusted || adjusted === bestAdjusted && String(card.path || "").localeCompare(String(remaining[bestIndex]?.path || "")) < 0) { bestAdjusted = adjusted; bestIndex = index; }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    Object.defineProperty(chosen, "selectionAdjusted", { value: bestAdjusted, enumerable: false, configurable: true });
    selected.push(chosen);
    for (const term of chosen.matchedTerms || []) covered.add(term);
  }
  return selected;
}
function packCards(cards, budgetTokens, exactId) {
  const selected = [];
  let used = 0;
  const exact = exactId ? cards.find((card) => card.id === exactId) : null;
  if (exact) { const size = estimateTokens(exact); if (size <= budgetTokens) { selected.push(exact); used += size; } }
  for (const card of cards) {
    if (card.id === exact?.id) continue;
    const size = estimateTokens(card);
    if (used + size > budgetTokens) continue;
    selected.push(card); used += size;
  }
  return { selected, estimatedTokens: used };
}
function stageStatus(degraded, count) { return degraded ? "degraded" : count > 0 ? "completed" : "empty"; }
function createRepositoryMap(input = {}) {
  const budgetTokens = Math.max(128, Number(input.budgetTokens || 1200));
  const candidateGroups = [input.architectureCards, input.lexicalCards, input.graphCandidates, input.semanticCards, input.buildCards, input.diagnosticCards, input.testCards];
  const candidates = [];
  for (const group of candidateGroups) for (const candidate of group || []) candidates.push(candidate);
  const seen = new Set();
  const cards = [];
  let duplicateCandidates = 0;
  let excludedCandidates = 0;
  for (const candidate of candidates) {
    const key = `${candidate.path || candidate.file || ""}:${candidate.symbolId || candidate.id || candidate.name || ""}:${candidate.signature || ""}`;
    if (seen.has(key)) { duplicateCandidates++; continue; }
    seen.add(key);
    const sourceKind = candidate.sourceKind || sourceKindForPath(candidate.path || candidate.file);
    if (!input.includeGenerated && sourceKind === "generated" || !input.includeVendored && ["vendored", "dependency", "build_output"].includes(sourceKind)) { excludedCandidates++; continue; }
    cards.push(toMapCard(candidate, input));
  }
  cards.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.path?.localeCompare(b.path || "") || String(a.symbolId || "").localeCompare(String(b.symbolId || "")) || a.id.localeCompare(b.id));
  const pathSeen = new Set(); const pathDiverseCards = cards.filter((card) => { if (!card.path || pathSeen.has(card.path)) return false; pathSeen.add(card.path); return true; });
  const rankedCards = input.queryExpansion === true ? conceptDiverseCards(pathDiverseCards, input.task) : cards;
  const exact = rankedCards.find((card) => card.scoreReasons.includes("exact_term"));
  const overhead = 100;
  const packed = packCards(rankedCards, Math.max(1, budgetTokens - overhead), exact?.id);
  const envelope = createRetrievalEnvelope({ provider: "repository-map", strategyId: input.strategyId || (input.queryExpansion === true ? "repository-map-v2" : "repository-map-v1"), revision: input.revision, configuration: input.configuration, freshness: input.freshness || "unknown", gatingSafe: input.gatingSafe === true, items: packed.selected, preserveOrder: input.queryExpansion === true, candidatesRetrieved: candidates.length, tokensReturned: packed.estimatedTokens, truncated: packed.selected.length < rankedCards.length, degradation: input.degradation });
  Object.defineProperty(envelope, "rankingDebug", { value: rankedCards.slice(0, 100).map((card, index) => ({ rank: index + 1, path: card.path, score: card.score, adjusted: card.selectionAdjusted, matchedTerms: card.matchedTerms || [], dependencySupport: card.dependencySupport || 0, dependencyTargets: card.dependencyTargets || [], provider: card.provider })), enumerable: false });
  envelope.level = 1;
  envelope.budgetTokens = budgetTokens;
  envelope.estimatedTokens = packed.estimatedTokens;
  envelope.serializedTokens = estimateTokens(envelope);
  while (envelope.serializedTokens > budgetTokens && envelope.items.length > 1) {
    const removable = envelope.items.findLastIndex((card) => card.id !== exact?.id);
    if (removable < 0) break;
    envelope.items.splice(removable, 1);
    envelope.metrics.candidatesReturned = envelope.items.length;
    envelope.estimatedTokens = envelope.items.reduce((sum, card) => sum + estimateTokens(card), 0);
    envelope.metrics.tokensReturned = envelope.estimatedTokens;
    envelope.serializedTokens = estimateTokens(envelope);
  }
  if (envelope.serializedTokens > budgetTokens && envelope.items.length === 1) {
    const card = envelope.items[0];
    card.signature = String(card.signature || "").slice(0, Math.max(16, Number(card.signature?.length || 0) - (envelope.serializedTokens - budgetTokens) * 4));
    envelope.serializedTokens = estimateTokens(envelope);
  }
  envelope.exactMatchRetained = Boolean(exact && envelope.items.some((card) => card.id === exact.id));
  envelope.diagnostics = {
    schemaVersion: 1,
    queryGeneration: {
      status: input.queryDiagnostics?.degraded ? "degraded" : Number(input.queryDiagnostics?.generatedQueries || 0) > 0 ? "completed" : "empty",
      strategy: input.queryExpansion === true ? "deterministic-expansion" : "verbatim",
      generatedQueries: Math.max(0, Number(input.queryDiagnostics?.generatedQueries || 0)),
      providerRequests: Math.max(0, Number(input.queryDiagnostics?.providerRequests || 0)),
      degradedRequests: Math.max(0, Number(input.queryDiagnostics?.degradedRequests || 0)),
    },
    candidateGeneration: {
      status: stageStatus(Boolean(input.degradation), candidates.length),
      rawCandidates: candidates.length,
      uniqueCandidates: seen.size,
      duplicatesRemoved: duplicateCandidates,
      sourceKindExcluded: excludedCandidates,
      eligibleCandidates: cards.length,
    },
    ranking: {
      status: stageStatus(false, rankedCards.length),
      candidatesRanked: rankedCards.length,
      pathDiversityRemoved: Math.max(0, cards.length - rankedCards.length),
      exactMatches: rankedCards.filter((card) => card.scoreReasons.includes("exact_term")).length,
      topScore: rankedCards.length ? Number(rankedCards[0].score || 0) : null,
    },
    packing: {
      status: envelope.serializedTokens > budgetTokens ? "budget-overrun" : stageStatus(false, envelope.items.length),
      budgetTokens,
      selectedCandidates: envelope.items.length,
      omittedCandidates: Math.max(0, rankedCards.length - envelope.items.length),
      estimatedTokens: envelope.estimatedTokens,
      serializedTokens: envelope.serializedTokens,
      exactMatchRetained: envelope.exactMatchRetained,
      truncated: envelope.truncated,
    },
  };
  envelope.mapId = deterministicId("map", { task: input.task, revision: input.revision, ids: envelope.items.map((card) => card.id), budgetTokens });
  return envelope;
}

module.exports = { WEIGHTS, EXPANDED_WEIGHTS, QUERY_STOP_WORDS, normalizedWord, words, rawTerms, terms, taskQueries, overlapScore, estimateTokens, candidateScore, toMapCard, conceptDiverseCards, packCards, createRepositoryMap };
