#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");
const {
  SCOPE_ENV,
  projectScope,
  configuredRoots,
  directoryGrants,
  owningRoot,
  assertProjectScope,
  stateInventory,
  readStateFile,
  readLogs,
  describeScope,
} = require("../src/project-scope.js");
const { createTestRunner } = require("../src/test-runner.js");
const { projectPath: codeContextProjectPath } = require("../src/code-context-service.js");
const { createDocsLookup } = require("../src/docs-lookup.js");

const fixture = tmpFixture("pi-project-scope-");
const primary = path.join(fixture, "ExampleGame");
const second = path.join(fixture, "ExampleUniverse");
const unrelated = path.join(fixture, "unrelated");
for (const directory of [primary, second, unrelated]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(primary, "package.json"), "{}\n");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function approvals(cwd, entries) {
  write(path.join(cwd, ".pi", "policy-enforcer", "approvals.json"), `${JSON.stringify({ version: 1, approvals: entries }, null, 2)}\n`);
}
function grant(overrides = {}) {
  return {
    key: "approval_test",
    request: { kind: "directory-write", sourceRoot: fs.realpathSync(primary), path: fs.realpathSync(second) },
    reason: "test",
    approvedAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

// 1. Default scope: only the working directory.
assert.deepEqual(projectScope(primary, { env: {} }).roots.map((root) => root.source), ["working-directory"]);
assert.equal(owningRoot(projectScope(primary, { env: {} }), second), null, "an undeclared second directory is not in scope");

// 2. PI_HARNESS_PROJECT_DIRS declares an explicit second directory; invalid
// entries are reported rather than silently widening the scope.
const env = { [SCOPE_ENV]: [second, path.join(fixture, "missing"), path.join(primary, "package.json")].join(path.delimiter) };
const configured = configuredRoots(primary, env);
assert.deepEqual(configured.roots.map((root) => root.path), [fs.realpathSync(second)]);
assert.deepEqual(configured.invalid.map((row) => row.reason), ["missing", "not-a-directory"]);
const scope = projectScope(primary, { env });
assert.deepEqual(scope.paths, [fs.realpathSync(primary), fs.realpathSync(second)]);
assert.equal(scope.roots[1].source, "configured");
assert.deepEqual(describeScope(scope).invalid.map((row) => row.reason), ["missing", "not-a-directory"]);

// 3. The owning root is the deepest containing root, so a nested directory
// resolves to its own project instead of the containing session directory.
fs.mkdirSync(path.join(second, "nested", "src"), { recursive: true });
assert.equal(owningRoot(scope, path.join(second, "nested", "file.js")).path, fs.realpathSync(second));
assert.equal(owningRoot(scope, path.join(unrelated, "file.js")), null);

// 4. Scope assertion: allowed inside a declared root, denied outside, and the
// denial names the configuration rather than silently allowing the path.
assert.equal(assertProjectScope(primary, second, { env }).root.path, fs.realpathSync(second));
assert.equal(assertProjectScope(primary, path.join(second, "does-not-exist.js"), { env }).root.path, fs.realpathSync(second));
assert.throws(() => assertProjectScope(primary, unrelated, { env }), (error) => error.code === "PROJECT_SCOPE_DENIED" && error.message.includes(SCOPE_ENV));
assert.equal(assertProjectScope(primary, unrelated, { env, allowOutside: true }).root.source, "allow-outside", "explicit allow-outside keeps its escape hatch");
assert.equal(assertProjectScope(primary, path.join(primary, "src", "a.js"), { env }).root.source, "working-directory");

// 5. /policy-approve-directory grants are reused as scope, with the same
// integrity checks the policy enforcer applies.
approvals(primary, []);
assert.equal(directoryGrants(primary).roots.length, 0, "an empty approval store grants nothing");
approvals(primary, [grant()]);
const granted = projectScope(primary, { env: {} });
assert.deepEqual(granted.roots.map((root) => root.source), ["working-directory", "policy-grant"]);
assert.equal(granted.roots[1].approvalKey, "approval_test");
assert.equal(assertProjectScope(primary, path.join(second, "src"), { env: {} }).root.path, fs.realpathSync(second));

approvals(primary, [grant({ expiresAt: new Date(Date.now() - 60_000).toISOString() })]);
assert.equal(directoryGrants(primary).roots.length, 0, "expired grants do not widen the scope");
approvals(primary, [grant({ request: { kind: "directory-write", sourceRoot: fs.realpathSync(unrelated), path: fs.realpathSync(second) } })]);
assert.equal(directoryGrants(primary).roots.length, 0, "another project's grant is not this project's authority");
approvals(primary, [grant({ request: { kind: "directory-write", sourceRoot: fs.realpathSync(primary), path: path.join(fixture, "gone") } })]);
assert.equal(directoryGrants(primary).roots.length, 0, "a missing grant destination is rejected");
const linked = path.join(fixture, "linked-second");
fs.symlinkSync(second, linked);
approvals(primary, [grant({ request: { kind: "directory-write", sourceRoot: fs.realpathSync(primary), path: linked } })]);
const redirected = directoryGrants(primary);
assert.equal(redirected.roots.length, 0, "a grant redirected through a symlink is rejected");
assert.equal(redirected.invalid[0].reason, "redirected-symlink");
approvals(primary, [grant({ request: { kind: "write", path: fs.realpathSync(second) } })]);
assert.equal(directoryGrants(primary).roots.length, 0, "exact-request approvals are not directory authority");
approvals(primary, []);

// 6. State inventory and bounded state-file reads.
write(path.join(second, ".pi", "test-runner", "latest.json"), `${JSON.stringify({ ok: true })}\n`);
write(path.join(second, ".pi", "traces", "abc.jsonl"), `${JSON.stringify({ event: "tool" })}\n`);
write(path.join(second, ".pi", "policy-enforcer", "approvals.json"), "{\"approvals\":[]}\n");
// Deterministic ordering: log selection is by mtime, and equal-millisecond
// writes would otherwise make the assertion depend on tie-breaking.
const now = Date.now();
fs.utimesSync(path.join(second, ".pi", "test-runner", "latest.json"), new Date(now - 90_000), new Date(now - 90_000));
fs.utimesSync(path.join(second, ".pi", "traces", "abc.jsonl"), new Date(now - 10_000), new Date(now - 10_000));
const inventory = stateInventory(second, { maxEntries: 2 });
assert.equal(inventory.exists, true);
assert.equal(inventory.entryCount, 3);
assert.equal(inventory.entries.length, 2, "inventory output is bounded");
assert.equal(inventory.truncated, true);
assert.ok(inventory.totalBytes > 0);
assert.ok(inventory.entries.every((entry) => entry.newestAt && Number.isFinite(entry.bytes)));

const read = readStateFile(second, "test-runner/latest.json", { maxBytes: 1024 });
assert.equal(read.path, ".pi/test-runner/latest.json");
assert.equal(read.text, `${JSON.stringify({ ok: true })}\n`);
assert.equal(read.truncated, false);
const boundedRead = readStateFile(second, "test-runner/latest.json", { maxBytes: 4 });
assert.equal(boundedRead.truncated, true, "a large state file is truncated, not fully loaded");
assert.equal(boundedRead.text.length, 4);

write(path.join(second, "outside.txt"), "outside\n");
assert.throws(() => readStateFile(second, "../outside.txt"), (error) => error.code === "PROJECT_SCOPE_DENIED");
assert.throws(() => readStateFile(second, path.join(second, "outside.txt")), (error) => error.code === "PROJECT_SCOPE_DENIED");
fs.symlinkSync(path.join(second, ".pi", "test-runner", "latest.json"), path.join(second, ".pi", "linked.json"));
assert.throws(() => readStateFile(second, "linked.json"), /symlink/, "state reads never follow symlinks");
assert.throws(() => readStateFile(second, "test-runner"), /regular file/, "directories are not readable state files");

// 7. Log tails: newest first, bounded lines, and only diagnostic state dirs.
write(path.join(second, ".pi", "traces", "older.jsonl"), "old-1\nold-2\n");
const older = new Date(Date.now() - 120_000);
fs.utimesSync(path.join(second, ".pi", "traces", "older.jsonl"), older, older);
const logs = readLogs(second, { maxFiles: 1, maxLines: 1, maxBytes: 4096 });
assert.equal(logs.entries.length, 1);
assert.equal(logs.entries[0].path, ".pi/traces/abc.jsonl");
assert.deepEqual(logs.entries[0].lines, [JSON.stringify({ event: "tool" })]);
assert.ok(logs.sources.includes("traces"));
assert.ok(!logs.sources.includes("policy-enforcer"), "non-log state directories are not offered as logs");
assert.equal(logs.candidateCount, 3);
assert.equal(logs.truncated, true, "candidate truncation is reported when maxFiles hides older logs");
const recent = readLogs(second, { maxFiles: 5, sinceMs: Date.now() - 60_000 });
assert.ok(recent.entries.some((entry) => entry.path === ".pi/traces/abc.jsonl"));
assert.ok(!recent.entries.some((entry) => entry.path === ".pi/traces/older.jsonl"), "the since filter excludes older logs");

(async () => {
  // 8. Harness tools treat a scope directory as a real project and keep their
  // state under that project's own .pi directory.
  process.env[SCOPE_ENV] = second;
  const docs = createDocsLookup();
  assert.equal((await docs.status({ cwd: primary }, { path: second })).details.projectPath, path.resolve(second));
  assert.equal(codeContextProjectPath({ cwd: primary }, second), path.resolve(second));
  assert.throws(() => codeContextProjectPath({ cwd: primary }, unrelated), (error) => error.code === "PROJECT_SCOPE_DENIED");

  write(path.join(second, "tests", "alpha.test.js"), "require('node:assert/strict').equal(1, 1);\n");
  const runner = createTestRunner({ timeoutMs: 20000 });
  const run = await runner.run({ cwd: primary }, { path: second, profile: "quick" });
  assert.equal(run.details.projectPath, path.resolve(second));
  assert.equal(run.details.ok, true, JSON.stringify(run.details.summary));
  const stateFile = path.join(second, ".pi", "test-runner", "latest.json");
  assert.equal(fs.existsSync(stateFile), true, "test-runner state follows the second project directory");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).projectPath, path.resolve(second));

  // 9. Existing behavior is unchanged when no second directory is declared.
  delete process.env[SCOPE_ENV];
  const isolated = createTestRunner({ timeoutMs: 20000 });
  await assert.rejects(
    () => isolated.status({ cwd: primary }, { path: unrelated }),
    (error) => error.code === "PROJECT_SCOPE_DENIED" && error.message.includes(SCOPE_ENV),
    "an undeclared directory stays outside the scope",
  );
  process.stdout.write("project-scope tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
