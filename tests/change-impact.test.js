#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChangeImpact, walkTests, stem, moduleKeys, lexicalRelationship } = require("../src/change-impact.js");
const { BuildGraph } = require("../src/build-graph.js");
const { TestEvidenceIndex } = require("../src/test-evidence-index.js");
const { isTestPath, testCommandsForPaths } = require("../src/test-paths.js");
const { spawnSync } = require("node:child_process");
const { workingTreeRevision, revisionId } = require("../src/code-context-revision.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-change-impact-");
  for (const dir of ["src", "tests"]) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  for (const file of ["src/a.js", "src/b.js", "src/auth.js", "src/security-token.js", "src/chat-focus.js", "src/alpha-module.js", "src/beta-module.js", "tests/a.test.js", "tests/b.test.mjs", "tests/auth.test.js", "tests/security-token.test.js", "tests/chat-focus.test.js", "tests/test_py.py", "tests/item_test.go", "tests/native-tests"]) fs.writeFileSync(path.join(tmp, file), "// fixture\n");
  fs.writeFileSync(path.join(tmp, "tests/chat-focus.test.js"), "require('../src/chat-focus.js');\n");
  fs.writeFileSync(path.join(tmp, "tests/corroborated.test.js"), "const alphaModule = betaModule;\n");
  fs.mkdirSync(path.join(tmp, ".claude", "worktrees", "stale", "tests"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "worktrees", "stale", "tests", "ghost.test.js"), "// stale worktree\n");
  assert.ok(!walkTests(tmp).some((test) => test.startsWith(".claude/")), "stale Claude worktrees are excluded from test selection");
  const graph = new BuildGraph({ repository: tmp, revision: "r1" });
  graph.setProviderStatus({ provider: "fixture-build", available: true, freshness: "fresh", gatingSafe: true });
  graph.addFact({ provider: "fixture-build", subject: "src/b.js", predicate: "owned-by-target", object: "target:b", configuration: "Debug", freshness: "fresh", gatingSafe: true, path: "src/b.js" });
  graph.addFact({ provider: "fixture-build", subject: "test-target:b", predicate: "tests", object: "target:b", configuration: "Debug", freshness: "fresh", gatingSafe: true, path: "tests/b.test.mjs" });
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".pi/\n.claude/\n");
  for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "-qm", "fixture"]]) assert.equal(spawnSync("git", args, { cwd: tmp }).status, 0);
  const evidence = new TestEvidenceIndex(tmp);
  evidence.ingest([{ test: "tests/a.test.js", entity: "src/a.js", relation: "covered", confidence: 0.99, durationMs: 5000, configuration: "Debug", revision: revisionId(workingTreeRevision(tmp, { configuration: "Debug" })) }]);
  const bySource = { "src/a.js": ["tests/a.test.js"], "src/b.js": ["tests/b.test.mjs"], "src/auth.js": ["tests/auth.test.js"], "src/security-token.js": [] };
  const result = await createChangeImpact(tmp, {
    changedPaths: ["src/a.js", "src/b.js", "src/auth.js", "src/security-token.js"],
    tests: ["tests/a.test.js", "tests/b.test.mjs", "tests/auth.test.js"],
    configuration: "Debug",
    maximumRuntime: 1,
    semgrepFindings: [{ path: "src/auth.js", severity: "ERROR" }, { path: "src/security-token.js", severity: "ERROR" }],
  }, {
    build: { graph }, evidenceIndex: evidence,
    codegraphSnapshot: { initialized: true, freshness: { stale: false, gatingSafe: true } },
    codegraphAffected: async (source) => ({ ok: true, tests: bySource[source] || [] }),
  });
  assert.ok(result.mustRun.some((edge) => edge.provider === "test-evidence" && edge.test === "tests/a.test.js"), "direct coverage is must-run");
  assert.ok(result.selectedTests.includes("tests/a.test.js"), "runtime budget never drops must-run tests");
  assert.ok(result.highConfidence.some((edge) => edge.source === "src/b.js" && edge.test === "tests/b.test.mjs"));
  assert.ok(result.uncoveredRisk.some((risk) => risk.source === "src/security-token.js"));
  const gold = new Set(["src/a.js->tests/a.test.js", "src/b.js->tests/b.test.mjs", "src/auth.js->tests/auth.test.js"]);
  const predicted = new Set(result.allEdges.filter((edge) => edge.gatingSafe).map((edge) => `${edge.source}->${edge.test}`));
  const truePositives = Array.from(predicted).filter((item) => gold.has(item)).length;
  assert.equal(truePositives / gold.size, 1, "overall and high-risk affected-test recall must be 100% on the gold fixture");
  assert.ok(truePositives / predicted.size >= 0.70, "affected-test precision must be at least 70% on the gold fixture");
  assert.ok(result.allEdges.filter((edge) => edge.source === "src/a.js" && edge.provider === "codegraph").every((edge) => edge.test === "tests/a.test.js"), "graph tests remain source-specific");
  assert.equal(result.baselinePolicy.neverSuppressBaseline, true);
  assert(result.allEdges.filter(edge => edge.provider === "codegraph").every(edge => !edge.gatingSafe), "advisory provider authority is never upgraded by freshness alone");
  assert.ok(result.commands.some((command) => command.command === "node" && command.args[0] === "tests/a.test.js"));
  assert.equal(stem("src/build-runner.js"), "buildrunner");
  assert.equal(stem("tests/build-runner.test.js"), "buildrunner");
  assert.deepEqual(moduleKeys(".pi/extensions/chat-focus/index.ts"), ["chatfocus"]);
  assert.equal(lexicalRelationship("src/chat-focus.js", "tests/chat-focus.test.js").relation, "module-name");
  const moduleReference = lexicalRelationship("src/chat-focus.js", "tests/registry.test.js", "const chatFocus = true;");
  assert.equal(moduleReference.relation, "module-reference");
  assert.ok(moduleReference.confidence < 0.75, "uncorroborated content mentions remain advisory");
  const directoryCoverage = lexicalRelationship(".pi/extensions/runtime-doctor/index.ts", "tests/extension-import-boundary.test.js", "walk(path.join(process.cwd(), '.pi', 'extensions')); fs.readdirSync(dir);");
  assert.equal(directoryCoverage.relation, "directory-coverage");
  assert.ok(directoryCoverage.confidence >= 0.75, "fresh directory-wide extension tests are selected as additive contract checks");
  const lexicalOnly = await createChangeImpact(tmp, { changedPaths: ["src/chat-focus.js"], tests: ["tests/chat-focus.test.js"] }, { build: { graph }, codegraphSnapshot: { initialized: true, freshness: { stale: false, gatingSafe: true } }, codegraphAffected: async () => ({ ok: true, tests: [] }) });
  assert.deepEqual(lexicalOnly.selectedTests, ["tests/chat-focus.test.js"], "fresh deterministic lexical relationships augment baseline tests");
  assert.ok(lexicalOnly.highConfidence.some((item) => item.provider === "lexical" && item.relationPath[1] === "lexical:module-name"));
  const corroborated = await createChangeImpact(tmp, { changedPaths: ["src/alpha-module.js", "src/beta-module.js"], tests: ["tests/corroborated.test.js"] }, { build: { graph }, codegraphSnapshot: { initialized: true, freshness: { stale: false, gatingSafe: true } }, codegraphAffected: async () => ({ ok: true, tests: [] }) });
  assert.deepEqual(corroborated.selectedTests, ["tests/corroborated.test.js"], "two changed-source references corroborate an otherwise advisory lexical edge");
  assert.ok(corroborated.highConfidence.some((item) => item.provider === "lexical-corroborated"));

  const stale = await createChangeImpact(tmp, { changedPaths: ["src/a.js"], tests: ["tests/a.test.js"] }, { build: { graph }, codegraphSnapshot: { initialized: true, freshness: { stale: true, gatingSafe: false } }, codegraphAffected: async () => ({ ok: true, tests: ["tests/a.test.js"] }) });
  assert.ok(stale.graphOnly.some((edge) => edge.freshness === "stale"));
  assert.ok(!stale.mustRun.some((edge) => edge.provider === "codegraph"), "stale graph edges cannot become must-run");

  for (const file of ["tests/x.test.cjs", "tests/x.test.mjs", "tests/test_x.py", "pkg/x_test.go", "tests/x.rs", "build/native-tests"]) assert.equal(isTestPath(file), true, file);
  assert.equal(isTestPath("docs/superpowers/specs/design.md"), false, "documentation specs are not executable tests");
  const commands = testCommandsForPaths(["tests/x.test.mjs", "tests/test_x.py", "pkg/x_test.go", "tests/x.rs", "build/native-tests"], { binaryPaths: ["build/native-tests"] });
  assert.deepEqual(new Set(commands.map((command) => command.command)), new Set(["node", "pytest", "go", "cargo", "build/native-tests"]));
  console.log("change impact tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
