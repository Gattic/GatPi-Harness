#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  createCodegraphAdapter,
  codegraphAffectedTests,
  codegraphDoctor,
  freshness,
  normalizeProjectFile,
  parseCliArgs,
  recordMutation,
  recordSyncState,
  shouldMarkStaleFromTool,
  touchedFilesFromTool,
} = require("../src/codegraph-adapter.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-codegraph-test-");
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "foo.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(tmp, "tests", "foo.test.js"), "require('../src/foo');\n");
fs.writeFileSync(path.join(tmp, ".gitignore"), ".pi/\n");
for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "-qm", "fixture"]]) assert.equal(spawnSync("git", args, { cwd: tmp }).status, 0);

assert.equal(normalizeProjectFile(tmp, "src/foo.js"), "src/foo.js");
assert.throws(() => normalizeProjectFile(tmp, "../outside.js"), /Affected file must stay inside/);
assert.equal(shouldMarkStaleFromTool("edit", { path: "src/foo.js" }).stale, true);
assert.equal(shouldMarkStaleFromTool("bash", { command: "rg foo" }).stale, false);
assert.equal(shouldMarkStaleFromTool("bash", { command: "sed -i s/a/b/ src/foo.js" }).stale, true);
assert.deepEqual(touchedFilesFromTool(tmp, "write", { path: "src/foo.js" }), ["src/foo.js"]);
for (const input of [{}, { mode: "preview" }, { operation: "status" }, { input: { mode: "preview" } }]) assert.equal(shouldMarkStaleFromTool("ast_refactor", input).stale, false);
assert.equal(shouldMarkStaleFromTool("ast_refactor", { mode: "apply" }, { summary: { files: 0 } }).stale, false);
assert.equal(shouldMarkStaleFromTool("ast_refactor", { input: { mode: "apply" } }, { summary: { files: 1 } }).stale, true);
assert.equal(shouldMarkStaleFromTool("ast_refactor", { operation: "rollback" }, { restored: [{ ok: false }] }).stale, false);
assert.equal(shouldMarkStaleFromTool("ast_refactor", { operation: "rollback" }, { restored: [{ ok: true }, { ok: false }] }).stale, true);
assert.deepEqual(parseCliArgs('--max-files 7 "find context"'), { opts: { maxFiles: "7" }, positional: ["find context"] });
assert.deepEqual(parseCliArgs('--verbose --budget-tokens=120 --include-source foo'), { opts: { verbose: true, budgetTokens: 120, includeSource: true }, positional: ["foo"] });
assert.throws(() => parseCliArgs('--quiet'), /Unknown CodeGraph option.*--verbose/);

const unproven = freshness(tmp);
assert.equal(unproven.freshness, "unknown");
assert.equal(unproven.gatingSafe, false);
assert.equal(unproven.degradation.code, "index_revision_unproven");
recordMutation(tmp, { toolName: "write", changedFiles: ["src/foo.js"], reason: "test mutation" });
assert.equal(freshness(tmp).stale, true);
recordSyncState(tmp, "sync", { command: "codegraph sync", stdout: "ok", stderr: "" });
assert.equal(freshness(tmp).stale, false);
assert.equal(freshness(tmp).gatingSafe, true);
fs.writeFileSync(path.join(tmp, "src", "foo.js"), "module.exports = 2;\n");
const stale = freshness(tmp);
assert.equal(stale.freshness, "stale");
assert.equal(stale.gatingSafe, false);
assert.equal(stale.pendingChanges.modified, 1);
assert.ok(stale.revisionId.includes("+"));

const missing = codegraphDoctor(tmp, { bin: path.join(tmp, "missing-codegraph"), timeoutMs: 200 });
assert.equal(missing.binary.found, false);
assert.ok(missing.risks.some((r) => /not installed|not on PATH/.test(r)));

const fake = path.join(tmp, "fake-codegraph.js");
fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "affected") console.log(JSON.stringify({ tests: ["tests/foo.test.js"], other: ["src/foo.js"] }));
else if (args[0] === "status") {
  // The real CLI runs \`git status\`; without this it can take and orphan the index lock.
  if (process.env.GIT_OPTIONAL_LOCKS !== "0") { console.error("status would refresh the Git index"); process.exitCode = 1; }
  else console.log("initialized");
}
else if (args[0] === "query") {
  if (args.at(-1) === "malformed") console.log("not-json");
  else if (args.at(-1) === "large") console.log(JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ score: 80 - i, node: { name: "handler" + i, filePath: "src/foo.js", startLine: i + 1, privateField: "provider-only-".repeat(100) } }))));
  else console.log("[]");
}
else if (args[0] === "callers" || args[0] === "callees") {
  if (args.at(-1) === "malformed") console.log('{}');
  else if (args.at(-1) === "missing") console.log('Symbol "missing" not found');
  else if (args.at(-1) === "bad-row") console.log(JSON.stringify({ [args[0]]: [{}] }));
  else console.log(JSON.stringify({ symbol: args.at(-1), [args[0]]: [{ name: args[0] === 'callers' ? 'caller' : 'callee', filePath: 'src/foo.js', startLine: 1 }] }));
}
else if (args[0] === "explore") console.log("explored context");
else if (args[0] === "files") console.log("src/foo.js");
else if (args[0] === "--version" || args[0] === "version") console.log("fake-codegraph 1.0.0");
else { console.error(\`unknown command '\${args[0] || ""}'\`); process.exitCode = 1; }
`);
fs.chmodSync(fake, 0o755);
// The adapter must disable optional Git locks for the CLI whatever the inherited environment says.
process.env.GIT_OPTIONAL_LOCKS = "1";
recordSyncState(tmp, "sync", { command: "codegraph sync", stdout: "ok", stderr: "" });
const affected = codegraphAffectedTests(tmp, ["src/foo.js"], { bin: fake, timeoutMs: 1000 });
assert.equal(affected.ok, true);
assert.deepEqual(affected.tests, ["tests/foo.test.js"]);
assert.equal(affected.freshness, "fresh");
assert.equal(affected.gatingSafe, false, "affected-test suggestions remain advisory even when the index is fresh");
assert.equal(affected.authority, "advisory-affected-tests");
assert.ok(affected.revisionId);
assert.equal(typeof affected.pendingChanges.total, "number");
const healthy = codegraphDoctor(tmp, { bin: fake, timeoutMs: 1000 });
assert.equal(healthy.binary.found, true);
assert.equal(healthy.initialized, true);

(async () => {
  const adapter = createCodegraphAdapter({ bin: fake, timeoutMs: 1000 });
  const results = await Promise.all([
    adapter.status({ cwd: tmp }, {}),
    adapter.query({ cwd: tmp }, { search: "foo" }),
    adapter.context({ cwd: tmp }, { task: "foo", maxFiles: 7 }),
    adapter.affected({ cwd: tmp }, { files: ["src/foo.js"] }),
    adapter.files({ cwd: tmp }, {}),
  ]);
  for (const result of results) {
    for (const field of ["freshness", "revision", "revisionId", "pendingChanges", "degradation", "gatingSafe", "authority"]) assert.ok(Object.hasOwn(result.details, field), `missing ${field}`);
  }
  assert.match(results[0].content[0].text, /CodeGraph adapter freshness: fresh/);
  assert.doesNotMatch(results[0].content[0].text, /would refresh the Git index/);
  assert.match(results[2].content[0].text, /explored context/);
  assert.match(results[2].content[0].text, /fresh, gating-safe/);
  assert.equal(results[2].details.operation, "explore");
  assert.deepEqual(results[2].details.args, ["explore", "-p", tmp, "--max-files", "7", "foo"]);
  assert.equal(results[0].details.freshnessStatus, healthy.freshnessVerdict.status, "status and doctor consume the same adapter freshness verdict");
  assert.equal(results[0].details.revisionId, healthy.freshnessVerdict.revisionId);
  assert.equal(results[0].details.gatingSafe, healthy.freshnessVerdict.gatingSafe);
  const shortStatus = await adapter.status({ cwd: tmp }, { maxLines: 1 });
  assert.equal(shortStatus.content[0].text.split("\n").length, 2, "status includes its verdict within the report line limit plus omission notice");
  assert.match(shortStatus.content[0].text, /CodeGraph adapter freshness: fresh/);
  assert.equal(results[3].details.gatingSafe, false);
  assert.equal(results[3].details.authority, "advisory-affected-tests");
  const boundedAdapter = createCodegraphAdapter({ bin: fake, timeoutMs: 1000, outputMaxBytes: 1024 });
  const large = await boundedAdapter.query({ cwd: tmp }, { search: "large" });
  assert.equal(large.details.items.length, 80, "parse full provider JSON, not the display-truncated prefix");
  assert.equal(JSON.parse(large.details.raw).length, 80, "complete provider records survive compact rendering");
  assert.match(large.details.raw, /privateField/);
  const formatted = await boundedAdapter.query({ cwd: tmp }, { search: "large", json: false, budgetTokens: 120 });
  assert.equal(formatted.details.schemaVersion, 1, "format options cannot bypass the retrieval envelope");
  assert(formatted.details.metrics.tokensReturned <= 120, "the requested budget applies to every compact query");
  const quiet = await adapter.affected({ cwd: tmp }, { files: ["src/foo.js"], quiet: true, budgetTokens: 120 });
  assert.equal(quiet.details.schemaVersion, 1, "affected results use the same envelope even with old format input");
  assert.match(quiet.content[0].text, /tests\/foo.test.js/);
  assert(large.details.rendering.rawChars > large.details.rendering.modelChars);
  const verbose = await boundedAdapter.query({ cwd: tmp }, { search: "large", verbose: true });
  assert.equal(verbose.content[0].text, verbose.details.raw, "verbose returns the raw provider output");
  const malformed = await adapter.query({ cwd: tmp }, { search: "malformed" });
  assert.equal(malformed.details.gatingSafe, false);
  assert.equal(malformed.details.advisory, true);
  assert.equal(malformed.details.authority, "advisory-index");
  assert.equal(malformed.details.degradation.code, "malformed_codegraph_json");
  assert.match(malformed.content[0].text, /malformed_codegraph_json/);
  const relations = await adapter.relationsStructured({ cwd: tmp }, { symbol: "foo", direction: "both" });
  assert.equal(relations.items.length, 2);
  assert(relations.items.some(row => row.direction === "incoming" && row.toId === "foo"));
  assert(relations.items.some(row => row.direction === "outgoing" && row.fromId === "foo"));
  assert(relations.items.every(row => !row.gatingSafe));
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbol: "foo", depth: 2 })).degradation.code, "unsupported_relation_request");
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbol: "foo", relationKinds: ["imports"] })).degradation.code, "unsupported_relation_request");
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbol: "malformed" })).degradation.code, "malformed_codegraph_json");
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbol: "bad-row" })).degradation.code, "malformed_codegraph_json");
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbol: "missing" })).degradation.code, "symbol_not_found");
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbolId: "function:opaque" })).degradation.code, "unsupported_relation_request");
  fs.writeFileSync(path.join(tmp, "src", "foo.js"), "module.exports = 3;\n");
  const staleEmpty = await adapter.queryStructured({ cwd: tmp }, { search: "absent" });
  assert.deepEqual(staleEmpty.candidates, []);
  assert.equal(staleEmpty.freshness.status, "stale");
  assert.equal(staleEmpty.degradation.code, "stale_index", "an empty stale query must carry explicit degradation");
  assert.equal(staleEmpty.gatingSafe, false);
  assert.equal((await adapter.relationsStructured({ cwd: tmp }, { symbol: "foo" })).degradation.code, "stale_index");
  console.log("codegraph adapter checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
