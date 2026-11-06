#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createRepositoryMap, estimateTokens, candidateScore, terms, taskQueries, toMapCard, conceptDiverseCards } = require("../src/repository-map.js");

const input = {
  task: "fix exactTarget configuration failure",
  revision: "r1",
  freshness: "fresh",
  gatingSafe: true,
  budgetTokens: 900,
  changedPaths: ["src/changed.js"],
  graphCandidates: [
    { provider: "codegraph", id: "central", symbolId: "central", name: "central", path: "src/central.js", signature: "function unrelatedCentral()", graphScore: 1, freshness: "fresh", gatingSafe: true },
    { provider: "codegraph", id: "exact", symbolId: "exact", name: "exactTarget", path: "src/exact.js", signature: "function exactTarget(config)", graphScore: 0.05, freshness: "fresh", gatingSafe: true },
    { provider: "codegraph", id: "exact-helper", symbolId: "exact-helper", name: "exactHelper", path: "src/exact.js", signature: "function exactHelper()", graphScore: 0.01, freshness: "fresh", gatingSafe: true },
    { provider: "codegraph", id: "generated", symbolId: "generated", name: "exactTarget", path: "generated/exact.js", signature: "function exactTarget(config) { return aVeryLongBodyThatMustNotAppear(); }", graphScore: 1, sourceKind: "generated", freshness: "fresh", gatingSafe: true },
  ],
  architectureCards: [{ provider: "project-intelligence", id: "root", symbolId: "root", path: "README.md", signature: "project architecture", freshness: "fresh", gatingSafe: true }],
};
assert.deepEqual(taskQueries("Keep Chat Focus navigation active after editor replacement").slice(0, 3), ["chat-focus", "chat", "focus"]);
assert.ok(taskQueries("Add safe chat focus switching").includes("switch"), "query expansion normalizes inflected action words");
assert.ok(taskQueries("Propagate command failures to the pi -p exit code").includes("exit-code"), "query expansion retains later high-signal phrases within the default plan");
assert.ok(terms("switching").has("switch"));
assert.ok(terms(".pi/extensions/chat-focus/index.ts").has("chat"));
assert.ok(terms("exactTarget").has("target"));
const first = createRepositoryMap(input);
const second = createRepositoryMap(input);
assert.deepEqual(first, second, "map output must be deterministic");
assert.ok(first.items.some((card) => card.symbolId === "exact"), "high-confidence exact term must be retained");
assert.equal(first.exactMatchRetained, true);
assert.equal(first.strategyId, "repository-map-v1", "expanded ranking remains opt-in after a failed offline gate");
assert.ok(first.items.every((card) => card.snippet === undefined), "Level 1 cards must not include source bodies");
const expanded = createRepositoryMap({ ...input, queryExpansion: true });
assert.equal(expanded.strategyId, "repository-map-v2");
assert.equal(new Set(expanded.items.map((card) => card.path)).size, expanded.items.length, "opt-in Level 1 maps keep one highest-ranked card per path");
assert.ok(first.items.every((card) => card.sourceKind !== "generated"), "generated cards are excluded by default");
assert.ok(first.serializedTokens <= first.budgetTokens, "reported serialized tokens must stay within budget");
assert.ok(estimateTokens(first) <= first.budgetTokens + 30, "serialized object must honor the strict envelope with only estimator rounding/metadata allowance");
assert.ok(candidateScore(input.graphCandidates[1], input).score > candidateScore(input.graphCandidates[0], input).score, "task relevance should beat task-weak centrality");
const oneTerm = candidateScore({ path: "src/chat.js", name: "chat", signature: "chat" }, { task: "chat focus navigation", queryExpansion: true });
assert.ok(oneTerm.components.task <= 1 / 3, "a generic one-word identifier does not receive the compound exact-identifier bonus in a multi-concept task");
const multiTerm = candidateScore({ path: "src/chat-focus.js", name: "chatFocus", signature: "chat focus", queryCoverage: 0.75 }, { task: "chat focus navigation", queryExpansion: true });
assert.ok(multiTerm.score > oneTerm.score, "expanded ranking must not saturate on a single exact term");
const aggregatedQueries = candidateScore({ path: "src/subagents.js", signature: "switchSession", queryTerms: ["safe", "switch"] }, { task: "safe chat focus switching", queryExpansion: true });
assert.ok(aggregatedQueries.components.task >= 0.5, "path-level query evidence survives selection of a single provider symbol");
const lexicalAggregate = candidateScore({ provider: "ripgrep", path: "docs/notes.md", signature: "command", queryTerms: ["command", "failure", "exit", "code"], queryCoverage: 1 }, { task: "command failure exit code", queryExpansion: true });
assert.equal(lexicalAggregate.components.task, 0.25, "aggregated lexical queries remain relationship evidence without double-counting generic search hits in the base task score");
assert.deepEqual(lexicalAggregate.matchedTerms, ["command", "failure", "exit", "code"]);
const diversityInput = { task: "safe chat focus switching", queryExpansion: true, freshness: "fresh", gatingSafe: true };
const reasoningCard = toMapCard({ provider: "codegraph", path: "src/reasoning.js", name: "chatFocus", queryTerms: ["safe", "chat", "focus"], graphScore: 0.7, freshness: "fresh", gatingSafe: true }, diversityInput);
const genericCard = toMapCard({ provider: "ripgrep", path: "src/generic.js", signature: "safe", queryTerms: ["safe"], score: 0.99, freshness: "fresh", gatingSafe: true }, diversityInput);
const switchingCard = toMapCard({ provider: "ripgrep", path: "src/subagents.js", signature: "switchSession", queryTerms: ["safe", "switch"], score: 0.9, freshness: "fresh", gatingSafe: true }, diversityInput);
assert.deepEqual(conceptDiverseCards([reasoningCard, genericCard, switchingCard], diversityInput.task).slice(0, 2).map((card) => card.path), ["src/reasoning.js", "src/subagents.js"], "expanded ranking rewards uncovered task concepts instead of repeating one generic term");
const interfaceCard = toMapCard({ provider: "codegraph", path: "src/interface.js", name: "interface", graphScore: 0.2, dependencySupport: 0.8, freshness: "fresh", gatingSafe: true }, diversityInput);
const ownerA = toMapCard({ provider: "ripgrep", path: "src/owner-a.js", signature: "safe", score: 0.7, dependencyTargets: ["src/interface.js"], freshness: "fresh", gatingSafe: true }, diversityInput);
const ownerB = toMapCard({ provider: "ripgrep", path: "src/owner-b.js", signature: "chat", score: 0.6, dependencyTargets: ["src/interface.js"], freshness: "fresh", gatingSafe: true }, diversityInput);
assert.deepEqual(conceptDiverseCards([reasoningCard, genericCard, interfaceCard, ownerA, ownerB], diversityInput.task).slice(0, 4).map((card) => card.path), ["src/reasoning.js", "src/interface.js", "src/owner-a.js", "src/owner-b.js"], "a strongly supported local interface reserves bounded call-site coverage after the base rank-1 result");
assert.ok(multiTerm.reasons.some((reason) => reason.startsWith("task=")));
const lexicalStrength = candidateScore({ path: "src/command-runner.js", provider: "ripgrep", score: 0.9, signature: "command" }, { task: "propagate command failures", queryExpansion: true });
assert.ok(lexicalStrength.components.graph >= 0.9, "expanded maps retain bounded provider lexical strength");
const withGenerated = createRepositoryMap({ ...input, includeGenerated: true, budgetTokens: 1500 });
assert.ok(withGenerated.items.some((card) => card.sourceKind === "generated"));
console.log("repository map tests passed");
