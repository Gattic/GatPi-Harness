#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const extensionFile = path.join(root, ".pi", "extensions", "project-scope", "index.ts");
const source = fs.readFileSync(extensionFile, "utf8");

assert.match(source, /name:\s*"project_scope"/);
for (const operation of ["list", "state", "logs", "read"]) assert.ok(source.includes(`"${operation}"`), `missing operation ${operation}`);
assert.match(source, /src", "project-scope\.js/);
const { EXTENSION_IMPORT_ALLOWLIST } = require(path.join(root, "src", "extension-import-policy.js"));
assert.ok(EXTENSION_IMPORT_ALLOWLIST.includes("src/project-scope.js"), "the scope resolver is a documented extension-facing surface, not a forbidden internal");
assert.match(source, /registerCommand\("project-scope"/);
assert.match(source, /assertProjectScope/, "an out-of-scope path must be rejected, not silently read");
// The tool is an access surface, not a second implementation of state writers.
assert.doesNotMatch(source, /writeFileSync|mkdirSync|rmSync|appendFileSync/, "project_scope must stay read-only");
for (const bound of ["maxEntries", "maxFiles", "maxLines", "maxBytes", "sinceMinutes"]) assert.ok(source.includes(bound), `missing bound ${bound}`);

// Every path-confined analysis tool resolves through the same scope module, so
// a declared second directory cannot be accepted by one tool and rejected by
// another.
for (const [file, label] of [
  ["src/test-runner.js", "test_runner"],
  ["src/ast-tools.js", "AST"],
  ["src/docs-lookup.js", "docs_lookup"],
  ["src/code-context-service.js", "code_context"],
  ["src/lsp-adapter.js", "LSP"],
  ["src/semgrep-adapter.js", "Semgrep"],
  ["src/codegraph-adapter.js", "CodeGraph"],
]) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(text, /require\("\.\/project-scope\.js"\)/, `${file} must use the shared scope resolver`);
  assert.ok(text.includes(`label: "${label}"`), `${file} must keep an explicit denial label`);
}
for (const file of ["src/ast-tools.js", "src/docs-lookup.js", "src/lsp-adapter.js", "src/semgrep-adapter.js", "src/codegraph-adapter.js"]) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(text, /allowOutside: config\.allowOutsideCwd/, `${file} must preserve its explicit allow-outside escape`);
}

// Memory tools resolve a named project directory instead of the session cwd.
const memory = fs.readFileSync(path.join(root, ".pi", "extensions", "memory-explorer", "index.ts"), "utf8");
assert.match(memory, /scopedContext\(ctx, params\)/, "memory tools must rebind the project directory");
assert.equal((memory.match(/ctx = scopedContext\(ctx, params\)/g) || []).length, 2, "both memory tools honor the path selector");

console.log("project-scope extension tests passed");
