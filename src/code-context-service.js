"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createLexicalSearchAdapter } = require("./lexical-search-adapter.js");
const { createCodegraphAdapter } = require("./codegraph-adapter.js");
const { createLspAdapter } = require("./lsp-adapter.js");
const { compactArchitectureCards } = require("./project-intelligence.js");
const { createRepositoryMap, taskQueries, words } = require("./repository-map.js");
const { loadBuildGraph } = require("./build-graph.js");
const { CodeContentCache, contentIdentity } = require("./code-content-cache.js");
const { CodeContextLedger } = require("./code-context-ledger.js");
const { createChangeImpact } = require("./change-impact.js");
const { TestEvidenceIndex } = require("./test-evidence-index.js");
const { createCodeContextTelemetry } = require("./code-context-telemetry.js");
const { resolveRolloutMode } = require("./code-context-rollout.js");
const { createCard, createDiagnostic, createRetrievalEnvelope, compactRetrievalEnvelope, deterministicId, sourceKindForPath } = require("./code-context-contracts.js");
const { readChangeSet, workingTreeRevision, revisionId } = require("./code-context-revision.js");

function isInside(root, candidate) { const relative = path.relative(root, candidate); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); }
function projectPath(ctx, input) { const root = path.resolve(ctx?.cwd || process.cwd()); const target = path.resolve(root, input || "."); if (!isInside(root, target)) throw new Error(`code_context path must stay inside cwd: ${input}`); return target; }
function locationRange(location = {}) { return location.range?.startLine ? location.range : location.loc ? { startLine: location.loc.start.line, startColumn: location.loc.start.column, endLine: location.loc.end.line, endColumn: location.loc.end.column } : undefined; }
function safeFile(root, file) { const absolute = path.resolve(root, String(file || "")); if (!file || !isInside(root, absolute)) throw new Error(`source path must stay inside project: ${file}`); return { absolute, relative: path.relative(root, absolute).replace(/\\/g, "/") }; }
function lineExtract(text, range, maxLines = 120) { const lines = String(text).split(/\r?\n/); const start = Math.max(1, Number(range?.startLine || 1)); const end = Math.min(lines.length, Number(range?.endLine || start + maxLines - 1), start + maxLines - 1); return { text: lines.slice(start - 1, end).join("\n"), range: { startLine: start, startColumn: 1, endLine: end, endColumn: (lines[end - 1] || "").length + 1 } }; }
function normalizedGraphScore(candidates, index) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const raw = Math.max(0, Number(rows[index]?.graphScore || rows[index]?.score || 0));
  const top = Math.max(0, Number(rows[0]?.graphScore || rows[0]?.score || 0));
  const relative = top > 0 ? Math.min(1, raw / top) : 0;
  const rank = 1 / (1 + Math.max(0, Number(index || 0)) * 0.25);
  return Math.max(0, Math.min(1, relative * 0.65 + rank * 0.35));
}
function resolveLocalDependency(root, ownerPath, request) {
  const raw = String(request || "");
  if (!raw.startsWith(".")) return null;
  const base = path.resolve(root, path.dirname(ownerPath), raw);
  if (!isInside(root, base)) return null;
  for (const file of [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.cjs`, path.join(base, "index.js"), path.join(base, "index.ts")]) {
    try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) return path.relative(root, file).replace(/\\/g, "/"); } catch {}
  }
  return null;
}
function localSourceDependencies(root, ownerPath) {
  const owner = path.resolve(root, ownerPath);
  if (!isInside(root, owner)) return [];
  let text;
  try { const stat = fs.lstatSync(owner); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) return []; text = fs.readFileSync(owner, "utf8"); } catch { return []; }
  const dependencies = new Set();
  for (const match of text.matchAll(/(?:require\(\s*|\bfrom\s+|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) { const dependency = resolveLocalDependency(root, ownerPath, match[1]); if (dependency) dependencies.add(dependency); }
  for (const match of text.matchAll(/require\(\s*join\(\s*LIB_ROOT\s*,([^)]*)\)\s*\)/g)) {
    const parts = Array.from(match[1].matchAll(/["']([^"']+)["']/g), (item) => item[1]);
    if (!parts.length) continue;
    const dependency = path.resolve(root, ...parts);
    try { const stat = fs.lstatSync(dependency); if (isInside(root, dependency) && stat.isFile() && !stat.isSymbolicLink()) dependencies.add(path.relative(root, dependency).replace(/\\/g, "/")); } catch {}
  }
  return Array.from(dependencies).sort();
}
function annotateDependencySupport(root, candidateGroups) {
  const byPath = new Map();
  for (const group of candidateGroups) for (const candidate of group || []) {
    const file = candidate.path || candidate.file || candidate.filePath;
    if (!file) continue;
    const rows = byPath.get(file) || [];
    rows.push(candidate);
    byPath.set(file, rows);
  }
  let supported = 0;
  for (const [ownerPath, ownerRows] of byPath) {
    const relevance = Math.max(...ownerRows.map((row) => Math.max(0, Math.min(1, Number(row.queryCoverage || 0)))));
    if (relevance < 0.20) continue;
    for (const dependency of localSourceDependencies(root, ownerPath)) {
      const targets = byPath.get(dependency);
      if (!targets) continue;
      for (const owner of ownerRows) owner.dependencyTargets = Array.from(new Set([...(owner.dependencyTargets || []), dependency])).sort();
      for (const target of targets) {
        const previous = Math.max(0, Math.min(1, Number(target.dependencySupport || 0)));
        target.dependencySupport = 1 - (1 - previous) * (1 - relevance);
      }
      supported++;
    }
  }
  return supported;
}
function lspCards(details, kind, revision) {
  const rows = details?.definitions || details?.references || details?.implementations || details?.symbols || [];
  return rows.map((row) => createCard({ provider: "lsp", strategyId: `lsp:${kind}`, revision, path: row.file, range: locationRange(row), symbolId: row.symbolId || row.name, kind, signature: row.signature || row.name || row.preview, score: details.backend === "live-lsp" ? 1 : 0.6, scoreReasons: [details.backend === "live-lsp" ? "compiler_resolved" : "lexical_fallback"], freshness: details.freshness || "unknown", degradation: details.degradation, gatingSafe: details.gatingSafe === true, provenance: [{ provider: "lsp", operation: kind }] }));
}
function createCodeContextService(options = {}) {
  const lexical = options.lexical || createLexicalSearchAdapter(options.lexicalOptions);
  const codegraph = options.codegraph || createCodegraphAdapter(options.codegraphOptions);
  const lsp = options.lsp || createLspAdapter(options.lspOptions);
  const architecture = options.architecture || compactArchitectureCards;
  const buildLoader = options.buildLoader || loadBuildGraph;
  const requestedMode = options.mode || process.env.PI_CODE_CONTEXT_MODE || "advisory";
  const telemetry = options.telemetry?.setContext ? options.telemetry : createCodeContextTelemetry(options.telemetry || {});
  let runtime = null;
  function startSession(ctx, activeEntries = []) {
    const root = projectPath(ctx, ".");
    const sessionId = ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.() || options.sessionId || "ephemeral";
    const cache = new CodeContentCache(root, options.cacheOptions);
    const ledger = new CodeContextLedger(root, { sessionId, stateRoot: cache.root });
    ledger.reconstruct(activeEntries);
    runtime = { root, sessionId, cache, ledger };
    telemetry.setContext?.({ sessionId: ledger.sessionId, projectId: ledger.projectId });
    return { ...ledger.summary(), cacheObjects: cache.list().length };
  }
  function runtimeFor(root) {
    if (!runtime || runtime.root !== root) startSession({ cwd: root }, []);
    return runtime;
  }
  async function search(ctx, params = {}, signal) {
    const root = projectPath(ctx, params.path);
    return lexical.search(root, params, signal);
  }
  async function repoMap(ctx, params = {}, signal) {
    const root = projectPath(ctx, params.path);
    const revision = revisionId(workingTreeRevision(root, { configuration: params.configuration }));
    const queryPlan = params.task ? params.queryExpansion === true ? taskQueries(params.task, params.queryLimit || 16) : [params.task] : [];
    const queryCoverageDenominator = params.queryExpansion === true ? Math.max(1, new Set(words(params.task)).size) : Math.max(1, queryPlan.length);
    const lexicalRoots = params.paths?.length ? [params.paths] : [["."], ...(params.queryExpansion === true && fs.existsSync(path.join(root, ".pi", "extensions")) ? [[".pi/extensions"]] : [])];
    const lexicalRequests = queryPlan.flatMap((query) => lexicalRoots.map((paths) => ({ query, paths })));
    const lexicalResults = await Promise.all(lexicalRequests.map((request) => lexical.search(root, { query: request.query, mode: "fixed", caseSensitive: false, distinctPaths: params.queryExpansion === true, paths: request.paths, sourceKinds: ["first_party"], limit: Math.max(15, Math.ceil(Number(params.candidateLimit || 100) / Math.max(1, lexicalRequests.length))), configuration: params.configuration }, signal).catch((error) => createRetrievalEnvelope({ provider: "ripgrep", items: [], degradation: { code: "lexical_unavailable", message: error.message, retryable: true } }))));
    const lexicalByPath = new Map(); for (const [index, result] of lexicalResults.entries()) for (const item of result.items || []) { const key = item.path || `${item.symbolId || item.id}:${item.range?.startLine || 0}`; const current = lexicalByPath.get(key) || { item, queries: new Set() }; current.queries.add(lexicalRequests[index]?.query); if (Number(item.score || 0) > Number(current.item.score || 0)) current.item = item; lexicalByPath.set(key, current); }
    const lexicalItems = Array.from(lexicalByPath.values()).map(({ item, queries }) => ({ ...item, queryTerms: Array.from(queries).sort(), queryMatchCount: queries.size, queryCoverage: queries.size / queryCoverageDenominator }));
    const lexicalDegradation = lexicalResults.find((result) => result.degradation)?.degradation || null;
    const lexicalResult = createRetrievalEnvelope({ provider: "ripgrep", items: lexicalItems, freshness: "fresh", gatingSafe: !lexicalDegradation, degradation: lexicalDegradation });
    const providerDiagnostics = [{ provider: "ripgrep", requests: lexicalResults.length, candidates: lexicalItems.length, degradedRequests: lexicalResults.filter((result) => result.degradation).length, freshness: lexicalResult.freshness, gatingSafe: lexicalResult.gatingSafe }];
    let graph = { candidates: [], degradation: null, freshness: { stale: true, gatingSafe: false } };
    if (queryPlan.length) {
      const graphResults = await Promise.all(queryPlan.map((search) => codegraph.queryStructured({ cwd: root }, { search, path: ".", limit: Math.max(15, Math.ceil(Number(params.graphLimit || 100) / queryPlan.length)) }, signal).catch((error) => ({ candidates: [], degradation: { code: error.code || "codegraph_unavailable", message: error.message, retryable: true }, freshness: { stale: true, gatingSafe: false } }))));
      const candidates = []; if (params.queryExpansion === true) { const byPath = new Map(); for (const [queryIndex, result] of graphResults.entries()) for (const [candidateIndex, candidate] of (result.candidates || []).entries()) { const key = candidate.path || `${candidate.symbolId || candidate.id || candidate.name}`; const normalizedCandidate = { ...candidate, rawGraphScore: Number(candidate.graphScore || candidate.score || 0), graphScore: normalizedGraphScore(result.candidates, candidateIndex), providerRank: candidateIndex + 1 }; const current = byPath.get(key) || { candidate: normalizedCandidate, queries: new Set() }; current.queries.add(queryPlan[queryIndex]); if (Number(normalizedCandidate.graphScore || 0) > Number(current.candidate.graphScore || 0)) current.candidate = normalizedCandidate; byPath.set(key, current); } for (const { candidate, queries } of byPath.values()) candidates.push({ ...candidate, queryTerms: Array.from(queries).sort(), queryMatchCount: queries.size, queryCoverage: queries.size / queryCoverageDenominator }); } else { const seen = new Set(); for (const result of graphResults) for (const candidate of result.candidates || []) { const key = `${candidate.path}:${candidate.symbolId || candidate.id || candidate.name}`; if (!seen.has(key)) { seen.add(key); candidates.push(candidate); } } }
      const degradation = graphResults.find((result) => result.degradation)?.degradation || null; const freshnessRows = graphResults.map((result) => result.freshness).filter(Boolean);
      graph = { candidates, degradation, freshness: { stale: !freshnessRows.length || freshnessRows.some((row) => row.stale !== false), gatingSafe: freshnessRows.length > 0 && freshnessRows.every((row) => row.gatingSafe === true) && !degradation } };
      providerDiagnostics.push({ provider: "codegraph", requests: graphResults.length, candidates: candidates.length, degradedRequests: graphResults.filter((result) => result.degradation).length, freshness: graph.freshness.stale ? "stale" : "fresh", gatingSafe: graph.freshness.gatingSafe });
    }
    const build = buildLoader(root, { configuration: params.configuration });
    const buildCards = build.graph.allFacts({ configuration: params.configuration }).slice(0, 200).map((fact) => ({ provider: fact.provider, id: fact.id, symbolId: fact.subject, path: fact.path || (fact.subject.includes("/") ? fact.subject : "README.md"), signature: `${fact.subject} --${fact.predicate}--> ${fact.object} [${fact.configuration}]`, freshness: fact.freshness, degradation: fact.degradation, gatingSafe: fact.gatingSafe, buildRelevance: [fact.subject, fact.object].some((value) => String(params.task || "").toLowerCase().includes(String(value).toLowerCase())) ? 1 : 0.25, configuration: fact.configuration, provenance: fact.provenance }));
    const providerDegradations = [lexicalDegradation, graph.degradation].filter(Boolean);
    const degradation = providerDegradations.length > 1 ? { code: "multiple_provider_degradation", message: "Multiple retrieval providers degraded; inspect provider diagnostics.", retryable: providerDegradations.some((row) => row.retryable) } : providerDegradations[0] || null;
    const architectureCards = architecture(root, { codegraph: false, semgrep: false });
    const candidateGroups = [architectureCards, lexicalResult.items, graph.candidates, buildCards];
    const dependencySupportedCandidates = params.queryExpansion === true ? annotateDependencySupport(root, candidateGroups) : 0;
    const mapInput = { task: params.task, queryExpansion: params.queryExpansion === true, seeds: params.seeds, mentionedSymbols: params.mentionedSymbols, changedPaths: params.changedPaths || readChangeSet(root).changedPaths, diagnosticPaths: params.diagnosticPaths, failurePaths: params.failurePaths, recentSelections: params.recentSelections, budgetTokens: params.budgetTokens, revision, configuration: params.configuration, freshness: graph.freshness?.stale ? "stale" : "fresh", gatingSafe: graph.freshness?.gatingSafe === true && !lexicalResult.degradation, degradation, queryDiagnostics: { generatedQueries: queryPlan.length, providerRequests: providerDiagnostics.reduce((sum, row) => sum + row.requests, 0), degradedRequests: providerDiagnostics.reduce((sum, row) => sum + row.degradedRequests, 0), degraded: providerDegradations.length > 0 }, architectureCards, lexicalCards: lexicalResult.items, graphCandidates: graph.candidates, buildCards, includeGenerated: params.includeGenerated, includeVendored: params.includeVendored };
    const map = createRepositoryMap(mapInput);
    map.providerDiagnostics = providerDiagnostics;
    map.diagnostics.ranking.dependencySupportedCandidates = dependencySupportedCandidates;
    return map;
  }
  async function symbolGet(ctx, params = {}, signal) {
    const root = projectPath(ctx, params.path);
    const revision = revisionId(workingTreeRevision(root, { configuration: params.configuration }));
    const detail = params.detail || "card";
    if (detail === "body") {
      const sourcePath = params.file || (params.symbol && typeof params.symbol === "object" ? params.symbol.path : null);
      if (!sourcePath) {
        const envelope = createRetrievalEnvelope({ provider: "source", strategyId: "symbol-body-invalid-input", revision, freshness: "unknown", gatingSafe: false, degradation: { code: "source_path_required", message: "code_context symbolGet detail=body requires file from a prior localized card. Use search or symbolGet detail=card first, then pass that card's path as file.", retryable: true }, items: [] });
        envelope.outcome = "not-applicable";
        envelope.status = "not-applicable";
        return envelope;
      }
      const target = safeFile(root, sourcePath);
      const state = runtimeFor(root);
      const identity = contentIdentity(root, target.relative);
      const scope = { revision, configuration: params.configuration || "default", path: target.relative, range: params.range, symbolId: params.symbolId, detail: "body", contentHash: identity.contentHash };
      const reusable = state.ledger.lookup(scope);
      if (reusable.reusable) {
        const card = createCard({ provider: "source", strategyId: "symbol-body-ref", revision, configuration: scope.configuration, path: target.relative, sourceKind: sourceKindForPath(target.relative), range: reusable.entry.range, symbolId: params.symbolId, kind: "definition", signature: params.signature || params.symbolId || path.basename(target.relative), contentHash: identity.contentHash, contentRef: reusable.contentRef, score: 1, scoreReasons: ["visible_unchanged_content_ref"], freshness: "fresh", gatingSafe: true, provenance: [{ provider: "source", operation: "symbolGet:ref" }] });
        const envelope = createRetrievalEnvelope({ provider: "source", strategyId: "symbol-body-ref", revision, freshness: "fresh", gatingSafe: true, items: [card] });
        envelope.refReused = true;
        return envelope;
      }
      const text = fs.readFileSync(target.absolute, "utf8");
      const extract = lineExtract(text, params.range, params.maxLines || 120);
      let card = createCard({ provider: "source", strategyId: "symbol-body-explicit", revision, configuration: scope.configuration, path: target.relative, sourceKind: sourceKindForPath(target.relative), range: extract.range, symbolId: params.symbolId, kind: "definition", signature: params.signature || params.symbolId || path.basename(target.relative), snippet: extract.text, contentHash: identity.contentHash, score: 1, scoreReasons: [reusable.known ? "content_not_visible_resend" : "explicit_body_request"], freshness: "fresh", gatingSafe: true, provenance: [{ provider: "source", operation: "symbolGet:body" }] });
      const cached = state.cache.put({ projectId: state.ledger.projectId, revision, configuration: scope.configuration, path: target.relative, range: extract.range, detail: "body", contentHash: identity.contentHash, card, extract: extract.text, explicitBody: true });
      card = createCard({ ...card, id: card.id, contentRef: cached.contentRef });
      // Nested results are not necessarily shown to the model by their caller.
      state.ledger.record({ ...scope, contentRef: cached.contentRef, visible: params.contentVisible !== false });
      const envelope = createRetrievalEnvelope({ provider: "source", strategyId: "symbol-body-explicit", revision, freshness: "fresh", gatingSafe: true, items: [card] });
      envelope.refReused = false;
      return envelope;
    }
    if (params.file) {
      const result = await lsp.definition({ cwd: root }, { ...params, path: "." }, signal);
      const cards = lspCards(result.details, "definition", revision);
      return createRetrievalEnvelope({ provider: "lsp", strategyId: "symbol-get", revision, freshness: result.details.freshness || "unknown", gatingSafe: result.details.gatingSafe === true, degradation: result.details.degradation, items: cards });
    }
    const graph = await codegraph.queryStructured({ cwd: root }, { search: params.symbolId || params.symbol || "", path: ".", limit: params.limit || 20 }, signal);
    const map = createRepositoryMap({ task: params.symbolId || params.symbol, budgetTokens: params.budgetTokens || 800, revision, graphCandidates: graph.candidates, freshness: graph.freshness.stale ? "stale" : "fresh", gatingSafe: graph.freshness.gatingSafe });
    map.provider = "codegraph";
    return map;
  }
  async function symbolRelations(ctx, params = {}, signal) {
    const root = projectPath(ctx, params.path);
    const revision = revisionId(workingTreeRevision(root, { configuration: params.configuration }));
    let graph;
    try { graph = await codegraph.relationsStructured({ cwd: root }, { ...params, path: "." }, signal); }
    catch (error) { graph = { items: [], freshness: { freshness: "unknown" }, degradation: { code: error.code || "codegraph_relations_unavailable", message: error.message, retryable: true } }; }
    const result = createRetrievalEnvelope({ provider: "codegraph", itemType: "relation", strategyId: "symbol-relations", revision, freshness: graph.freshness.freshness, gatingSafe: false, degradation: graph.degradation, items: graph.items });
    Object.assign(result, { relationKinds: ["calls"], direction: params.direction || "both", depth: 1, truncated: graph.truncated === true, advisory: true });
    if (graph.degradation?.code === "unsupported_relation_request") result.outcome = "not-applicable";
    return result;
  }
  async function buildQuery(ctx, params = {}) {
    const root = projectPath(ctx, params.path);
    const revision = revisionId(workingTreeRevision(root, { configuration: params.configuration }));
    const loaded = buildLoader(root, { configuration: params.configuration });
    const query = loaded.graph.query({ entities: params.entities, entity: params.entity, relation: params.relation || "owner", configuration: params.configuration, maximumDepth: params.maximumDepth, maximumResults: params.maximumResults || params.limit });
    const envelope = createRetrievalEnvelope({ provider: "build-graph", itemType: "buildFact", strategyId: `build:${query.relation}`, revision, configuration: params.configuration, freshness: query.providerStatuses.some((status) => status.freshness === "stale") ? "stale" : "fresh", gatingSafe: query.providerStatuses.filter((status) => status.available).every((status) => status.gatingSafe), items: query.facts });
    envelope.providerStatuses = query.providerStatuses;
    envelope.graphFingerprint = query.fingerprint;
    envelope.relation = query.relation;
    envelope.entities = query.entities;
    return envelope;
  }
  async function changeImpact(ctx, params = {}) {
    const root = projectPath(ctx, params.path);
    const rollout = resolveRolloutMode(root, requestedMode, { reportPath: options.benchmarkReport });
    const evidenceIndex = options.evidenceIndex || new TestEvidenceIndex(root);
    const impact = await createChangeImpact(root, params, { evidenceIndex, build: buildLoader(root, { configuration: params.configuration }) });
    const tests = impact.selectedTests.map((test) => ({ provider: "change-impact", path: test, testId: test, status: "recommended", freshness: "fresh", gatingSafe: true, provenance: impact.allEdges.filter((item) => item.test === test).map((item) => ({ provider: item.provider, operation: item.relationPath.join(" -> ") })) }));
    const envelope = createRetrievalEnvelope({ provider: "change-impact", itemType: "test", strategyId: `change-impact:${rollout.effective}`, revision: impact.revision, freshness: impact.providers.codegraph.freshness?.stale ? "stale" : "fresh", gatingSafe: false, items: tests });
    Object.assign(envelope, { rolloutMode: rollout.effective, rolloutGate: rollout, status: impact.status, changedPaths: impact.changedPaths, mustRun: impact.mustRun, highConfidence: impact.highConfidence, graphOnly: impact.graphOnly, historical: impact.historical, uncoveredRisk: impact.uncoveredRisk, selectedTests: impact.selectedTests, selectedRuntimeMs: impact.selectedRuntimeMs, commands: impact.commands, baselinePolicy: impact.baselinePolicy, providers: impact.providers });
    return envelope;
  }
  async function diagnostics(ctx, params = {}, signal) {
    const root = projectPath(ctx, params.path);
    const revision = revisionId(workingTreeRevision(root));
    const result = await lsp.diagnostics({ cwd: root }, { ...params, path: ".", files: params.files || params.scope }, signal);
    const items = (result.details.diagnostics || []).map((row) => createDiagnostic({ provider: row.provider || row.source || result.details.backend || "diagnostics", revision, path: row.path || row.file, range: row.range || { startLine: row.line || 1, startColumn: row.column || 1, endLine: row.endLine || row.line || 1, endColumn: row.endColumn || Number(row.column || 1) + 1 }, severity: row.severity, code: row.code, message: row.message, freshness: result.details.freshness || "fresh", degradation: result.details.degradation, gatingSafe: result.details.gatingSafe === true, provenance: [{ provider: result.details.backend || "diagnostics", operation: "diagnostics" }] }));
    return createRetrievalEnvelope({ provider: result.details.backend || "diagnostics", itemType: "diagnostic", strategyId: "diagnostics", revision, freshness: result.details.freshness || "fresh", degradation: result.details.degradation, gatingSafe: result.details.gatingSafe === true, items });
  }
  async function execute(ctx, operation, params = {}, signal) {
    const root = path.resolve(ctx?.cwd || params.root || process.cwd());
    const rollout = resolveRolloutMode(root, requestedMode, { reportPath: options.benchmarkReport });
    const activeMode = rollout.effective;
    const queryId = deterministicId("query", { operation, task: params.task, query: params.query, symbolId: params.symbolId, paths: params.paths, revision: params.revision, configuration: params.configuration });
    const strategyId = `${operation}:${activeMode}`;
    telemetry.emit("query.classified", { queryId, strategyId, operation, rolloutMode: activeMode, requestedMode: rollout.requested, rolloutAuthorized: rollout.authorized });
    if (operation === "repoMap") telemetry.emit("budget.planned", { queryId, strategyId, budgetTokens: params.budgetTokens || 1200, rolloutMode: activeMode });
    if (activeMode === "off") return createRetrievalEnvelope({ provider: "code-context", strategyId: "off", items: [], degradation: { code: "disabled", message: "PI_CODE_CONTEXT_MODE=off", retryable: false } });
    telemetry.emit("provider.started", { queryId, strategyId, provider: operation, rolloutMode: activeMode });
    const started = Date.now();
    try {
      let result;
      if (operation === "repoMap") result = await repoMap(ctx, params, signal);
      else if (operation === "search") result = await search(ctx, params, signal);
      else if (operation === "symbolGet") result = await symbolGet(ctx, params, signal);
      else if (operation === "symbolRelations") result = await symbolRelations(ctx, params, signal);
      else if (operation === "diagnostics") result = await diagnostics(ctx, params, signal);
      else if (operation === "buildQuery") result = await buildQuery(ctx, params);
      else if (operation === "changeImpact") result = await changeImpact(ctx, params);
      else throw new Error(`Unknown code_context operation: ${operation}`);
      result.rolloutMode ||= activeMode;
      result.rolloutGate ||= rollout;
      telemetry.emit("provider.completed", { queryId: result.queryId || queryId, strategyId: result.strategyId || strategyId, provider: result.provider, durationMs: Date.now() - started, candidatesReturned: result.items?.length || 0, degraded: Boolean(result.degradation), rolloutMode: activeMode });
      telemetry.emit("candidates.retrieved", { queryId: result.queryId || queryId, strategyId: result.strategyId || strategyId, count: result.diagnostics?.candidateGeneration?.rawCandidates ?? result.metrics?.candidatesRetrieved ?? result.items?.length ?? 0, stageStatus: result.diagnostics?.candidateGeneration?.status, rolloutMode: activeMode });
      telemetry.emit("candidates.deduped", { queryId: result.queryId || queryId, strategyId: result.strategyId || strategyId, count: result.diagnostics?.candidateGeneration?.eligibleCandidates ?? result.items?.length ?? 0, duplicatesRemoved: result.diagnostics?.candidateGeneration?.duplicatesRemoved, sourceKindExcluded: result.diagnostics?.candidateGeneration?.sourceKindExcluded, rolloutMode: activeMode });
      telemetry.emit("candidates.ranked", { queryId: result.queryId || queryId, strategyId: result.strategyId || strategyId, count: result.diagnostics?.ranking?.candidatesRanked ?? result.items?.length ?? 0, topScore: result.diagnostics?.ranking?.topScore, stageStatus: result.diagnostics?.ranking?.status, rolloutMode: activeMode });
      telemetry.emit("candidates.selected", { queryId: result.queryId || queryId, strategyId: result.strategyId || strategyId, count: result.diagnostics?.packing?.selectedCandidates ?? result.items?.length ?? 0, omitted: result.diagnostics?.packing?.omittedCandidates, stageStatus: result.diagnostics?.packing?.status, rolloutMode: activeMode });
      if (operation === "repoMap") telemetry.emit("context.packed", { queryId: result.queryId || queryId, strategyId: result.strategyId, budgetTokens: result.budgetTokens, serializedTokens: result.serializedTokens, count: result.items?.length || 0, rolloutMode: activeMode });
      if (operation === "symbolGet" && params.detail === "body") telemetry.emit(result.refReused ? "content.ref_reused" : "content.expanded", { queryId: result.queryId || queryId, strategyId: result.strategyId, refs: (result.items || []).map((item) => item.contentRef), paths: (result.items || []).map((item) => item.path), rolloutMode: activeMode });
      if (operation === "symbolGet" && result.items?.[0]?.path) telemetry.emit("edit.localized", { queryId: result.queryId || queryId, strategyId: result.strategyId, path: result.items[0].path, range: result.items[0].range, symbolId: result.items[0].symbolId, rolloutMode: activeMode });
      if (operation === "changeImpact") telemetry.emit("tests.proposed", { queryId: result.queryId || queryId, strategyId: result.strategyId, tests: result.selectedTests, mustRun: result.mustRun?.length || 0, highConfidence: result.highConfidence?.length || 0, rolloutMode: activeMode });
      if (result.degradation) telemetry.emit("provider.degraded", { queryId: result.queryId || queryId, strategyId: result.strategyId || strategyId, provider: result.provider, code: result.degradation.code, rolloutMode: activeMode });
      return result;
    } catch (error) {
      telemetry.emit("provider.degraded", { queryId, strategyId, provider: operation, code: error.code || "error", messageHash: deterministicId("error", error.message), durationMs: Date.now() - started, rolloutMode: activeMode });
      throw error;
    }
  }
  function invalidate(paths) { if (!runtime) return { invalidated: [] }; const result = runtime.ledger.invalidate(paths); runtime.ledger.persist(); return result; }
  function reconstruct(activeEntries) { if (!runtime) return { visibleRefs: [], entriesScanned: 0 }; return runtime.ledger.reconstruct(activeEntries || []); }
  function compact(activeEntries) { return reconstruct(activeEntries); }
  function cleanup(options = {}) { if (!runtime) return { apply: Boolean(options.apply), candidates: [] }; return runtime.cache.garbageCollect({ ...options, protectedRefs: runtime.ledger.protectedRefs() }); }
  function render(result, renderOptions) { return compactRetrievalEnvelope(result, renderOptions); }
  async function close() { if (runtime) runtime.ledger.persist(); await lsp.closeAll?.(); }
  return { mode: requestedMode, telemetry, lexical, codegraph, lsp, search, repoMap, symbolGet, symbolRelations, buildQuery, changeImpact, diagnostics, execute, render, startSession, invalidate, reconstruct, compact, cleanup, close };
}

module.exports = { createCodeContextService, projectPath, safeFile, lineExtract, normalizedGraphScore, resolveLocalDependency, localSourceDependencies, annotateDependencySupport, lspCards };
