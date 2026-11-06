"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { codegraphAffectedTests, codegraphProjectSnapshot } = require("./codegraph-adapter.js");
const { loadBuildGraph } = require("./build-graph.js");
const { normalizeRepositoryPath, readChangeSet, revisionId, workingTreeRevision } = require("./code-context-revision.js");
const { isTestPath, testCommandsForPaths } = require("./test-paths.js");

function walkTests(root, options = {}) { const out = []; const ignore = new Set([".git", ".pi", ".claude", ".worktrees", "node_modules", "build", "dist", "target", "vendor", "coverage"]); function walk(relative) { if (out.length >= (options.maxTests || 2000)) return; let names = []; try { names = fs.readdirSync(path.join(root, relative)); } catch { return; } for (const name of names) { if (ignore.has(name)) continue; const file = relative ? `${relative}/${name}` : name; let stat; try { stat = fs.statSync(path.join(root, file)); } catch { continue; } if (stat.isDirectory()) walk(file); else if (stat.isFile() && isTestPath(file, options.customPatterns)) out.push(file); } } walk(""); return out.sort(); }
function stem(file) { return path.basename(file).replace(/\.(?:test|spec)\.[^.]+$/, "").replace(/\.[^.]+$/, "").replace(/^test_/, "").replace(/_test$/, "").replace(/[^A-Za-z0-9]+/g, "").toLowerCase(); }
function moduleKeys(file) { const normalized = String(file || "").replace(/\\/g, "/"); const keys = new Set(); const base = stem(normalized); if (base && base !== "index") keys.add(base); if (base === "index") { const parent = path.basename(path.dirname(normalized)).replace(/[^A-Za-z0-9]+/g, "").toLowerCase(); if (parent) keys.add(parent); } return Array.from(keys).filter((key) => key.length >= 3); }
function readBoundedText(root, file, maximumBytes = 64 * 1024) { try { const fd = fs.openSync(path.join(root, file), "r"); try { const buffer = Buffer.alloc(Math.max(1, maximumBytes)); const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); return buffer.subarray(0, bytes).toString("utf8"); } finally { fs.closeSync(fd); } } catch { return ""; } }
function lexicalRelationship(source, test, content = "") { const sourceKeys = moduleKeys(source); const testKeys = moduleKeys(test); const exactKey = sourceKeys.find((key) => testKeys.includes(key)); if (exactKey) return { relation: "module-name", confidence: 0.82, evidence: exactKey }; const normalizedSource = String(source).replace(/\\/g, "/").replace(/\.[^.\/]+$/, "").toLowerCase(); const normalizedContent = String(content).replace(/\\/g, "/").toLowerCase(); if (normalizedSource && normalizedContent.includes(normalizedSource)) return { relation: "source-path-reference", confidence: 0.9, evidence: normalizedSource }; const compactContent = normalizedContent.replace(/[^a-z0-9]+/g, ""); const referencedKey = sourceKeys.find((key) => key.length >= 4 && compactContent.includes(key)); if (referencedKey) return { relation: "module-reference", confidence: 0.74, evidence: referencedKey }; const sourcePath = String(source).replace(/\\/g, "/"); const extensionRoot = sourcePath.startsWith(".pi/extensions/") ? ".pi/extensions" : sourcePath.startsWith("extensions/") ? "extensions" : null; const scansExtensionRoot = extensionRoot === ".pi/extensions" ? compactContent.includes("piextensions") : extensionRoot === "extensions" ? compactContent.includes("extensions") : false; if (scansExtensionRoot && ["readdirSync", "walk(", "extensionEntries("].some((needle) => content.includes(needle))) return { relation: "directory-coverage", confidence: 0.78, evidence: extensionRoot }; return null; }
function riskForSource(source, findings = []) { let score = 1; const reasons = []; if (/auth|security|crypto|token|secret|permission|policy|payment/i.test(source)) { score += 4; reasons.push("security-sensitive path"); } const rows = findings.filter((finding) => (finding.path || finding.file) === source); if (rows.length) { score += Math.min(4, rows.length); reasons.push(`${rows.length} static finding(s)`); } return { score, high: score >= 4, reasons, findings: rows }; }
function edge(input) { return { source: input.source, test: input.test, provider: input.provider, relationPath: input.relationPath || [input.source, input.relation || "affects", input.test], configuration: input.configuration || "default", confidence: Math.max(0, Math.min(1, Number(input.confidence || 0))), freshness: input.freshness || "unknown", degradation: input.degradation || null, gatingSafe: input.gatingSafe === true && input.freshness === "fresh" && !input.degradation, estimatedRuntimeMs: Math.max(0, Number(input.estimatedRuntimeMs || 1000)), evidenceId: input.evidenceId || null };
}
function addEdge(rows, input) { if (!input.test || !isTestPath(input.test, input.customPatterns) && !input.binary) return; rows.push(edge(input)); }
function dedupeEdges(rows) { const map = new Map(); for (const item of rows) { const key = `${item.source}:${item.test}:${item.provider}:${item.configuration}:${item.relationPath.join(">")}`; const current = map.get(key); if (!current || item.confidence > current.confidence) map.set(key, item); } return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence || a.source.localeCompare(b.source) || a.test.localeCompare(b.test) || a.provider.localeCompare(b.provider)); }
function corroborateLexicalEdges(rows) { const byTest = new Map(); for (const item of rows) { if (item.provider !== "lexical" || item.relationPath?.[1] !== "lexical:module-reference" || !item.gatingSafe || item.freshness !== "fresh" || item.degradation) continue; const group = byTest.get(item.test) || []; group.push(item); byTest.set(item.test, group); } for (const [test, group] of byTest) { const sources = Array.from(new Set(group.map((item) => item.source))).sort(); if (sources.length < 2) continue; rows.push(edge({ source: sources[0], test, provider: "lexical-corroborated", relationPath: [...sources, "lexical:changed-source-corroboration", test], confidence: 0.78, freshness: "fresh", gatingSafe: true, estimatedRuntimeMs: Math.min(...group.map((item) => item.estimatedRuntimeMs || 1000)) })); } return rows; }
async function createChangeImpact(root, input = {}, providers = {}) {
  const cwd = path.resolve(root);
  const currentRevision = workingTreeRevision(cwd, { configuration: input.configuration });
  const revision = revisionId(currentRevision);
  const changes = (input.changedPaths?.length ? input.changedPaths : readChangeSet(cwd).changedPaths).map((file) => normalizeRepositoryPath(cwd, file));
  const tests = input.tests || walkTests(cwd, input);
  const contentScanLimit = Math.max(0, Math.min(tests.length, Number(input.lexicalContentScanLimit ?? 500)));
  const testContents = new Map(tests.slice(0, contentScanLimit).map((test) => [test, readBoundedText(cwd, test, Number(input.lexicalContentMaxBytes || 64 * 1024))]));
  const rows = [];
  const threshold = Number(input.confidenceThreshold || 0.75);
  const graphSnapshot = providers.codegraphSnapshot || codegraphProjectSnapshot(cwd, { timeoutMs: input.codegraphTimeoutMs || 1500 });
  const graphFresh = graphSnapshot.freshness?.stale === false;
  const graphAffected = providers.codegraphAffected || ((source) => codegraphAffectedTests(cwd, [source], { timeoutMs: input.codegraphTimeoutMs || 3000 }));
  const build = providers.build || loadBuildGraph(cwd, { configuration: input.configuration });
  for (const source of changes) {
    if (isTestPath(source, input.customPatterns)) addEdge(rows, { source, test: source, provider: "change-set", relation: "changed-test", confidence: 1, freshness: "fresh", gatingSafe: true, estimatedRuntimeMs: providers.evidenceIndex?.estimatedRuntime(source) });
    for (const test of tests) { const relationship = lexicalRelationship(source, test, testContents.get(test) || ""); if (relationship) addEdge(rows, { source, test, provider: "lexical", relation: relationship.relation, relationPath: [source, `lexical:${relationship.relation}`, test], confidence: relationship.confidence, freshness: "fresh", gatingSafe: true, estimatedRuntimeMs: providers.evidenceIndex?.estimatedRuntime(test) }); }
    let affected = { tests: [], ok: false, skipped: true };
    try { affected = await graphAffected(source); } catch (error) { affected = { tests: [], ok: false, degradation: { code: "codegraph_error", message: error.message } }; }
    for (const test of affected.tests || []) addEdge(rows, { source, test, provider: "codegraph", relation: "affected", relationPath: [source, "codegraph:affected", test], confidence: graphFresh ? 0.8 : 0.45, freshness: graphFresh ? "fresh" : "stale", gatingSafe: graphFresh && affected.ok !== false && affected.gatingSafe === true, degradation: affected.degradation, estimatedRuntimeMs: providers.evidenceIndex?.estimatedRuntime(test) });
    const owners = build.graph.allFacts({ configuration: input.configuration }).filter((fact) => fact.subject === source && fact.predicate === "owned-by-target");
    for (const owner of owners) for (const testFact of build.graph.allFacts({ configuration: owner.configuration }).filter((fact) => fact.predicate === "tests" && fact.object === owner.object)) {
      const test = testFact.path || String(testFact.subject).replace(/^test-target:/, "");
      addEdge(rows, { source, test, provider: testFact.provider, relationPath: [source, "owned-by-target", owner.object, "tested-by", test], configuration: owner.configuration, confidence: Math.min(owner.confidence || 1, testFact.confidence || 1) * 0.92, freshness: owner.freshness, gatingSafe: owner.gatingSafe && testFact.gatingSafe, degradation: owner.degradation || testFact.degradation, estimatedRuntimeMs: providers.evidenceIndex?.estimatedRuntime(test), binary: !path.extname(test) });
    }
    for (const semantic of (input.semanticEdges || []).filter((item) => item.source === source)) addEdge(rows, { ...semantic, source, provider: semantic.provider || "lsp", relation: semantic.relation || "semantic-reference", confidence: semantic.confidence || 0.85, estimatedRuntimeMs: semantic.estimatedRuntimeMs || providers.evidenceIndex?.estimatedRuntime(semantic.test) });
    for (const dynamic of providers.evidenceIndex?.queryEntity(source, { configuration: input.configuration || "default", revision: currentRevision.available ? revision : null }) || []) addEdge(rows, { source, test: dynamic.test, provider: "test-evidence", relation: dynamic.relation, relationPath: [dynamic.test, dynamic.relation, source], configuration: dynamic.configuration, confidence: dynamic.confidence, freshness: dynamic.freshness || "fresh", gatingSafe: dynamic.gatingSafe !== false, estimatedRuntimeMs: dynamic.estimatedRuntimeMs, evidenceId: dynamic.id });
    for (const historical of (input.historicalEdges || []).filter((item) => item.source === source)) addEdge(rows, { ...historical, source, provider: "historical", relation: historical.relation || "co-change", confidence: Math.min(0.49, Number(historical.confidence || 0.4)), freshness: historical.freshness || "fresh", gatingSafe: false });
  }
  corroborateLexicalEdges(rows);
  const edges = dedupeEdges(rows);
  const mustRun = edges.filter((item) => item.gatingSafe && (item.provider === "change-set" || item.provider === "test-evidence" && item.confidence >= 0.95));
  const mustKeys = new Set(mustRun.map((item) => `${item.source}:${item.test}:${item.provider}:${item.configuration}`));
  const highConfidence = edges.filter((item) => item.gatingSafe && item.confidence >= threshold && !mustKeys.has(`${item.source}:${item.test}:${item.provider}:${item.configuration}`));
  const graphOnly = edges.filter((item) => item.provider === "codegraph" && (!item.gatingSafe || item.confidence < threshold));
  const historical = edges.filter((item) => item.provider === "historical");
  const findings = input.semgrepFindings || [];
  const uncoveredRisk = changes.map((source) => ({ source, risk: riskForSource(source, findings), owners: build.graph.allFacts({ configuration: input.configuration }).filter((fact) => fact.subject === source && fact.predicate === "owned-by-target").map((fact) => fact.object) })).filter((item) => item.risk.high && !edges.some((candidate) => candidate.source === item.source && candidate.gatingSafe));
  const maximumRuntime = input.maximumRuntime == null ? Infinity : Math.max(0, Number(input.maximumRuntime));
  const selected = [...mustRun];
  let selectedRuntimeMs = mustRun.reduce((sum, item) => sum + item.estimatedRuntimeMs, 0);
  for (const item of highConfidence) { if (selected.some((row) => row.test === item.test)) continue; if (selectedRuntimeMs + item.estimatedRuntimeMs > maximumRuntime) continue; selected.push(item); selectedRuntimeMs += item.estimatedRuntimeMs; }
  const selectedTests = Array.from(new Set(selected.map((item) => item.test))).sort();
  const commands = testCommandsForPaths(selectedTests, { customTests: input.customTests, binaryPaths: input.binaryPaths, customPatterns: input.customPatterns });
  const status = !changes.length ? "not-applicable" : !tests.length && !commands.length ? "no-verifiers" : edges.length ? "ok" : "unknown";
  return { schemaVersion: 1, revision, changedPaths: changes, changedSymbols: input.changedSymbols || [], status, mustRun, highConfidence, graphOnly, historical, uncoveredRisk, allEdges: edges.slice(0, input.maximumResults || 1000), selectedTests, selectedRuntimeMs, commands, baselinePolicy: { additiveOnly: true, neverSuppressBaseline: true }, providers: { codegraph: { freshness: graphSnapshot.freshness, ok: graphSnapshot.initialized }, build: build.graph.providerStatuses() } };
}

module.exports = { walkTests, stem, moduleKeys, readBoundedText, lexicalRelationship, riskForSource, edge, dedupeEdges, corroborateLexicalEdges, createChangeImpact };
