#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createLspAdapter, extractSymbolsFromText } = require("../src/lsp-adapter.js");
const { createTestRunner, inferCommands, selectCommands, normalizeTestRunnerParams } = require("../src/test-runner.js");
const { createAstTools, parseNodes } = require("../src/ast-tools.js");
const { createDocsLookup, searchDocs } = require("../src/docs-lookup.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function tmpdir() { return tmpFixture("pi-coding-tools-test-"); }
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function write(file, text) { mkdirp(path.dirname(file)); fs.writeFileSync(file, text); }

(async () => {
  const cwd = tmpdir();
  write(path.join(cwd, "src", "math.js"), `function add(a, b) { return a + b; }\nconst twice = (x) => add(x, x);\nmodule.exports.add = add;\n`);
  write(path.join(cwd, "tests", "math.test.js"), `const assert = require("node:assert/strict");\nconst { add } = require("../src/math.js");\nassert.equal(add(2, 3), 5);\n`);
  write(path.join(cwd, "docs", "api.md"), `# API\n\nUse add(a, b) to add two numbers.\n`);
  const ctx = { cwd };

  const symbols = extractSymbolsFromText("src/math.js", fs.readFileSync(path.join(cwd, "src", "math.js"), "utf8"));
  assert.ok(symbols.some((s) => s.name === "add"), "lsp symbol extraction should find add");
  const lsp = createLspAdapter({ maxResults: 20 });
  const refs = await lsp.references(ctx, { symbol: "add", files: ["src/math.js", "tests/math.test.js"] });
  assert.ok(refs.details.references.length >= 2, "lsp references should find lexical references");

  const normalizedRunnerInput = normalizeTestRunnerParams({ operation: "list_profiles", profile: "focused", files: "tests/math.test.js" });
  assert.equal(normalizedRunnerInput.operation, "listProfiles");
  assert.equal(normalizedRunnerInput.profile, "changed");
  assert.deepEqual(normalizedRunnerInput.files, ["tests/math.test.js"]);
  assert.throws(() => normalizeTestRunnerParams({ operation: "guess" }), /Use one of: status, listProfiles, infer, run, rerunFailures/);

  const inferred = inferCommands(cwd, { files: "tests/math.test.js" });
  assert.ok(inferred.profiles.changed.some((c) => c.command === "node"), "test_runner should accept one file or an array and infer the direct node command");
  const staleSelection = selectCommands(cwd, { commandId: "missing:id", profile: "changed" });
  assert.equal(staleSelection.notApplicable, true);
  assert.equal(staleSelection.reasonCode, "stale-command-id");
  assert.match(staleSelection.reason, /operation=infer/);
  assert.throws(() => selectCommands(cwd, { command: "node tests/math.test.js", profile: "changed" }), /custom commands are disabled/);
  const runner = createTestRunner({ timeoutMs: 30000 });
  const run = await runner.run(ctx, { files: ["tests/math.test.js"], profile: "changed" });
  assert.equal(run.details.summary.failed, 0, "test_runner should pass sample test");
  assert.ok(fs.existsSync(path.join(cwd, ".pi", "test-runner", "latest.json")), "test_runner should write latest evidence");

  const nodes = parseNodes("src/math.js", fs.readFileSync(path.join(cwd, "src", "math.js"), "utf8"));
  assert.ok(nodes.some((n) => n.kind === "call" && n.name === "add"), "ast parser should find call nodes");
  const ast = createAstTools({ maxResults: 20 });
  const found = await ast.search(ctx, { kind: "call", pattern: "add", files: ["src/math.js"] });
  assert.ok(found.details.summary.matches >= 1, "ast_search should find add call");
  assert.equal(found.details.backend, "regex");
  assert.equal(found.details.gatingSafe, false);
  assert.match(found.content[0].text, /not compiler-resolved/, "the model-facing view keeps the advisory nature visible");
  assert.match(found.details.advisory, /not parsed, scope-aware/);
  assert.match(found.content[0].text, /src\/math.js:\d+:\d+/);
  assert(!found.content[0].text.includes('"loc"'), "model output uses compact matches rather than verbose location objects");
  const preview = await ast.refactor(ctx, { mode: "preview", kind: "identifier", pattern: "twice", replacement: "double", files: ["src/math.js"] });
  assert.equal(preview.details.summary.replacements, 1, "ast_refactor preview should count replacements");
  const applied = await ast.refactor(ctx, { mode: "apply", kind: "identifier", pattern: "twice", replacement: "double", files: ["src/math.js"] });
  assert.equal(applied.details.applied, true, "ast_refactor apply should apply");
  assert.match(fs.readFileSync(path.join(cwd, "src", "math.js"), "utf8"), /const double/);
  const rolled = await ast.rollback(ctx, { checkpointId: applied.details.checkpointId });
  assert.equal(rolled.details.ok, true, "ast_refactor rollback should restore checkpoint");
  assert.match(fs.readFileSync(path.join(cwd, "src", "math.js"), "utf8"), /const twice/);

  const rawDocs = searchDocs(cwd, { query: "add two numbers", source: "local" });
  assert.ok(rawDocs.results.some((r) => r.path === "docs/api.md"), "docs search should find local docs");
  const docs = createDocsLookup({ maxResults: 10 });
  const lookup = await docs.search(ctx, { query: "add two numbers", source: "local" });
  assert.ok(lookup.details.results.length >= 1, "docs_lookup should return search results");
  const read = await docs.read(ctx, { file: "docs/api.md", limit: 5 });
  assert.match(read.details.text, /Use add/);
  await assert.rejects(docs.read(ctx, { path: "..", file: "README.md" }), /must stay inside the session project scope/, "Pi docs routing must not weaken docs_lookup confinement");
  const docsExtensionSource = fs.readFileSync(path.join(process.cwd(), ".pi", "extensions", "docs-lookup", "index.ts"), "utf8");
  assert.match(docsExtensionSource, /\$PI_SOURCE_ROOT\/packages\/coding-agent\/README\.md/);
  assert.match(docsExtensionSource, /do not weaken docs_lookup confinement with PI_DOCS_ALLOW_OUTSIDE/);

  console.log("coding workflow tool tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
