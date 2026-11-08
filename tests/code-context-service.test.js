#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCodeContextService, normalizedGraphScore, localSourceDependencies, annotateDependencySupport } = require("../src/code-context-service.js");
const { createCard, createRetrievalEnvelope } = require("../src/code-context-contracts.js");
const { BuildGraph } = require("../src/build-graph.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const providerRows = [{ graphScore: 100 }, { graphScore: 80 }, { graphScore: 60 }];
  assert.equal(normalizedGraphScore(providerRows, 0), 1);
  assert.ok(normalizedGraphScore(providerRows, 1) < 1 && normalizedGraphScore(providerRows, 1) > normalizedGraphScore(providerRows, 2), "provider rank/relative score normalization prevents graph-score saturation");
  const tmp = tmpFixture("pi-code-context-service-");
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "answer.js"), "function answer() {\n  return 42;\n}\n");
  fs.writeFileSync(path.join(tmp, "src", "owner.js"), "const answer = require('./answer');\n");
  assert.deepEqual(localSourceDependencies(tmp, "src/owner.js"), ["src/answer.js"]);
  const ownerCandidate = { path: "src/owner.js", queryCoverage: 0.5 };
  const dependencyCandidate = { path: "src/answer.js", queryCoverage: 0.1 };
  assert.equal(annotateDependencySupport(tmp, [[ownerCandidate, dependencyCandidate]]), 1);
  assert.equal(dependencyCandidate.dependencySupport, 0.5, "task-relevant importers contribute bounded dependency support to already-retrieved candidates");
  assert.deepEqual(ownerCandidate.dependencyTargets, ["src/answer.js"], "reverse owner evidence is retained for bounded interface-cluster diversification");
  const lexicalCalls = [];
  const lexical = { async search(_root, params) { lexicalCalls.push(params); const card = createCard({ provider: "ripgrep", path: "src/answer.js", symbolId: "answer", kind: "text", signature: "answer", score: 1, scoreReasons: ["exact_identifier"], freshness: "fresh", gatingSafe: true }); return createRetrievalEnvelope({ provider: "ripgrep", freshness: "fresh", gatingSafe: true, items: [card, card] }); } };
  const codegraph = { async queryStructured() { return { candidates: [{ provider: "codegraph", path: "src/answer.js", symbolId: "function:answer", name: "answer", signature: "function answer()", graphScore: 0.7, freshness: "fresh", gatingSafe: true }], freshness: { stale: false, gatingSafe: true }, degradation: null }; } };
  codegraph.relationsStructured = async (_ctx, params) => ({ items: [{ provider: "codegraph", path: "src/owner.js", fromId: "owner", toId: params.symbol, relationKind: "calls", direction: "incoming", freshness: "fresh", gatingSafe: false }], freshness: { freshness: "fresh" }, degradation: null });
  const lsp = {
    async definition() { return { details: { backend: "fallback", freshness: "unknown", gatingSafe: false, degradation: { code: "lexical_fallback", message: "advisory" }, definitions: [{ file: "src/answer.js", name: "answer", loc: { start: { line: 1, column: 1 }, end: { line: 1, column: 18 } } }] } }; },
    async diagnostics() { return { details: { backend: "compiler", freshness: "fresh", gatingSafe: true, diagnostics: [{ file: "src/answer.js", line: 2, column: 3, severity: "warning", code: "W1", message: "example" }] } }; },
    async closeAll() {},
  };
  const buildGraph = new BuildGraph({ repository: tmp, revision: "r1" });
  buildGraph.setProviderStatus({ provider: "fixture-build", available: true, freshness: "fresh", gatingSafe: true });
  buildGraph.addFact({ provider: "fixture-build", subject: "src/answer.js", predicate: "owned-by-target", object: "target:app", configuration: "Debug", freshness: "fresh", gatingSafe: true, path: "src/answer.js" });
  buildGraph.addFact({ provider: "fixture-build", subject: "src/answer.js", predicate: "owned-by-target", object: "target:app", configuration: "Release", freshness: "fresh", gatingSafe: true, path: "src/answer.js" });
  const buildLoader = () => ({ graph: buildGraph, fingerprint: buildGraph.fingerprint(), providers: {} });
  const telemetryEvents = [];
  const service = createCodeContextService({ lexical, codegraph, lsp, architecture: () => [createCard({ provider: "architecture", path: "src/answer.js", symbolId: "answer", kind: "text", signature: "answer", score: 0.4, freshness: "fresh", gatingSafe: true })], buildLoader, mode: "advisory", telemetry: { emit(event) { telemetryEvents.push(event); } } });
  const map = await service.execute({ cwd: tmp }, "repoMap", { task: "answer", budgetTokens: 800 });
  assert.ok(map.items.some((card) => /answer/.test(card.signature)));
  assert.ok(map.items.every((card) => card.snippet === undefined));
  assert.deepEqual(Object.keys(map.diagnostics), ["schemaVersion", "queryGeneration", "candidateGeneration", "ranking", "packing"]);
  assert.equal(map.diagnostics.queryGeneration.status, "completed");
  assert.equal(map.diagnostics.candidateGeneration.rawCandidates, 5);
  assert.equal(map.diagnostics.candidateGeneration.duplicatesRemoved, 1);
  assert.equal(map.diagnostics.ranking.candidatesRanked, 4);
  assert.equal(map.diagnostics.packing.status, "completed");
  assert.equal(map.providerDiagnostics.length, 2);
  assert.ok(telemetryEvents.some((event) => event.name === "candidates.retrieved" && event.payload.count === 5));
  const expandedMap = await service.execute({ cwd: tmp }, "repoMap", { task: "answer alpha", queryExpansion: true, budgetTokens: 800 });
  assert.ok(lexicalCalls.some((call) => call.distinctPaths === true), "expanded maps request provider-side path diversity");
  assert.equal(new Set(expandedMap.items.map((card) => card.path)).size, expandedMap.items.length);
  const related = await service.execute({ cwd: tmp }, "symbolRelations", { symbol: "answer", direction: "incoming" });
  assert.equal(related.items[0].fromId, "owner");
  assert.equal(related.items[0].toId, "answer");
  assert.equal(related.items[0].relationKind, "calls");
  assert.equal(related.gatingSafe, false);

  const subproject = path.join(tmp, "src");
  const graphBinary = path.join(tmp, "fixture-codegraph");
  fs.writeFileSync(graphBinary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const project = args[0] === 'status' ? args[1] : args[args.indexOf('-p') + 1];
if (project !== ${JSON.stringify(subproject)}) {
  console.error('wrong project root: ' + project);
  process.exit(1);
}
if (args[0] === 'status') console.log('initialized');
else if (args[0] === 'callers') console.log(JSON.stringify({ callers: [{ name: 'owner', filePath: 'owner.js', startLine: 1 }] }));
else process.exit(1);
`);
  fs.chmodSync(graphBinary, 0o755);
  const subprojectService = createCodeContextService({ codegraphOptions: { bin: graphBinary, timeoutMs: 1000 }, lsp, mode: "advisory" });
  try {
    for (const projectPath of ["src", "./src", subproject]) {
      const request = { path: projectPath, symbol: "answer", direction: "incoming" };
      const result = await subprojectService.execute({ cwd: tmp }, "symbolRelations", request);
      assert.equal(result.items.length, 1, `relations must use the selected subproject once: ${projectPath}; ${JSON.stringify(result.degradation)}`);
      assert.equal(result.items[0].path, "owner.js");
      assert.equal(request.path, projectPath, "path resolution does not mutate the request");
    }
    const result = await subprojectService.execute({ cwd: subproject }, "symbolRelations", { symbol: "answer", direction: "incoming" });
    assert.equal(result.items[0].path, "owner.js", "omitted path uses cwd");
  } finally { await subprojectService.close(); }

  const searched = await service.execute({ cwd: tmp }, "search", { query: "answer" });
  assert.equal(searched.provider, "ripgrep");
  const card = await service.execute({ cwd: tmp }, "symbolGet", { file: "src/answer.js", line: 1, column: 10, detail: "card" });
  assert.equal(card.gatingSafe, false, "fallback cards remain advisory");
  const missingBodyPath = await service.execute({ cwd: tmp }, "symbolGet", { symbolId: "answer", detail: "body" });
  assert.equal(missingBodyPath.outcome, "not-applicable");
  assert.equal(missingBodyPath.degradation.code, "source_path_required");
  assert.match(missingBodyPath.degradation.message, /detail=card first/);
  const bodyRequest = { file: "src/answer.js", symbolId: "answer", detail: "body", range: { startLine: 1, endLine: 2 } };
  const body = await service.execute({ cwd: tmp }, "symbolGet", bodyRequest);
  assert.match(body.items[0].snippet, /return 42/);
  const referenced = await service.execute({ cwd: tmp }, "symbolGet", bodyRequest);
  assert.equal(referenced.refReused, true);
  assert.equal(referenced.items[0].snippet, undefined);
  service.compact([]);
  const resent = await service.execute({ cwd: tmp }, "symbolGet", bodyRequest);
  assert.equal(resent.refReused, false);
  assert.match(resent.items[0].snippet, /return 42/);
  service.invalidate(["src/answer.js"]);
  assert.equal((await service.execute({ cwd: tmp }, "symbolGet", bodyRequest)).refReused, false);
  const build = await service.execute({ cwd: tmp }, "buildQuery", { entities: ["src/answer.js"], relation: "owner", configuration: "Debug" });
  assert.equal(build.items.length, 1);
  assert.equal(build.items[0].configuration, "Debug");
  assert.equal(build.graphFingerprint, buildGraph.fingerprint());
  const diagnostics = await service.execute({ cwd: tmp }, "diagnostics", { files: ["src/answer.js"] });
  assert.equal(diagnostics.items[0].code, "W1");
  assert.match(service.render(map), /retrieval/);
  assert.match(service.render(map), /stages query=completed/);
  await assert.rejects(service.execute({ cwd: tmp }, "search", { path: "../outside", query: "x" }), /session project scope/);
  const disabled = createCodeContextService({ lexical, codegraph, lsp, architecture: () => [], buildLoader, mode: "off" });
  assert.equal((await disabled.execute({ cwd: tmp }, "search", { query: "x" })).degradation.code, "disabled");
  await service.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("code-context service tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
