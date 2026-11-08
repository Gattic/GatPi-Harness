#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function text(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function assertContains(file, needle) { assert.ok(text(file).includes(needle), `${file} should include ${needle}`); }

const ext = ".pi/extensions/codegraph/index.ts";
const lib = "src/codegraph-adapter.js";
for (const command of ["codegraph-status", "codegraph-sync", "codegraph-query", "codegraph-context", "codegraph-affected", "codegraph-files", "codegraph-doctor"]) {
  assertContains(ext, `pi.registerCommand("${command}"`);
}
for (const tool of ["codegraph_status", "codegraph_query", "codegraph_context", "codegraph_affected", "codegraph_sync", "codegraph_doctor"]) {
  assertContains(ext, `name: "${tool}"`);
}
assert.ok(!text(ext).includes('name: "codegraph_files"'), "codegraph file-tree inspection remains command-only");
assertContains(ext, "src\", \"codegraph-adapter.js");
assertContains(ext, "tool_result");
assertContains(ext, "setTimeout");
assertContains(ext, "adapter.config.autoSync");
assertContains(ext, "scheduleAutoSync(projectPath)");
assertContains(ext, "toolMutationSnapshot");
assertContains(ext, "changedMutationProjects");
assertContains(ext, 'pi.on("session_shutdown"');
for (const required of ["PI_CODEGRAPH_BIN", "PI_CODEGRAPH_TIMEOUT_MS", "PI_CODEGRAPH_ALLOW_OUTSIDE", "PI_CODEGRAPH_AUTO_SYNC", "PI_CODEGRAPH_ADVISORY", "execFile", "truncateHead", "normalizeProjectFile", "stripAnsi", "friendlyMissingBinaryMessage", "friendlyNotInitializedMessage", "ensureCodegraphInitialized", "CODEGRAPH_NOT_INSTALLED", "CODEGRAPH_NOT_INITIALIZED", "provider-result-rendering", "renderWithinBudget", "codegraphQueryEnvelope", "codegraphAffectedEnvelope", "codegraphContextEnvelope", "codegraphDoctor", "recordMutation", "freshness", "resultMetadata", "pendingChanges", "revisionId", "advisory-affected-tests", "codegraphAffectedTests", '"explore"', '"--max-files"']) {
  assertContains(lib, required);
}
// Retrieval results must not reach the model as raw provider JSON: the complete
// record stays in details and the model-facing view is a bounded projection.
for (const tool of ["codegraph_query", "codegraph_affected", "codegraph_context"]) assertContains(ext, `name: "${tool}"`);
assertContains(ext, "verbose: VerboseField");
assertContains(ext, "budgetTokens: BudgetField");
assertContains(ext, "includeSource");
assert.ok(!text(ext).includes("JsonField") && !text(ext).includes("quiet:"), "raw format switches must not bypass retrieval envelopes");
assert.ok(!text(lib).includes("details.parsed ="), "parsed provider JSON is replaced by retrieval envelope items");
assert.ok(!text(lib).includes('["context", "-p"'), "adapter must not invoke the removed CodeGraph context command");
assertContains(ext, "maxFiles");
for (const obsolete of ["maxNodes", "maxCode", "noCode"]) assert.ok(!text(ext).includes(obsolete), `${ext} should not expose obsolete ${obsolete}`);
for (const file of [lib, ext, "wiki/extensions-and-commands.md", "docs/runtime-configuration.md", "docs/workflow-pack.md"]) {
  assert.ok(!text(file).includes("--no-code"), `${file} should not retain the removed CodeGraph context option`);
}
assert.ok(!text(lib).includes("--markdown"), `${lib} should not parse the removed CodeGraph context format option`);
assertContains("wiki/extensions-and-commands.md", "/codegraph-context [--max-files n] <task>");
assertContains("src/project-intelligence.js", "codegraphProjectSnapshot");
assertContains("src/project-intelligence.js", "codegraphAffectedTests");
assertContains(".pi/extensions/verification-center/index.ts", "codegraphVerificationAdvisory");
assertContains(".pi/extensions/runtime-doctor/index.ts", "codegraphDoctor");
assertContains("docs/productization-extensions.md", "CodeGraph Adapter");
assertContains("docs/runtime-configuration.md", "PI_CODEGRAPH_BIN=codegraph");
assertContains(".gitignore", ".pi/codegraph/");
assertContains("wiki/extensions-and-commands.md", "codegraph_query");
assertContains("scripts/extension-smoke-runner.js", "discoverExtensionEntries");
assertContains("scripts/extension-smoke-runner.js", '[".pi/extensions", "extensions"]');
console.log("codegraph extension checks passed");
