#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { normalizeDiagnostic, normalizeDiagnostics, diagnosticKey } = require("../src/diagnostic-normalizer.js");

const row = { provider: "clangd", file: "src/a.cpp", line: 3, column: 4, severity: "WARNING", code: "unused", message: "\u001b[33munused value\u001b[0m" };
const normalized = normalizeDiagnostic(row, { revision: "r1" });
assert.equal(normalized.path, "src/a.cpp");
assert.equal(normalized.severity, "warning");
assert.equal(normalized.message, "unused value");
assert.equal(normalized.range.startLine, 3);
assert.equal(normalized.key, diagnosticKey(normalized));
const result = normalizeDiagnostics([row, { ...row }, { ...row, code: "other" }], { revision: "r1" });
assert.equal(result.diagnostics.length, 2);
assert.equal(result.deduplicated, 1);
const delta = normalizeDiagnostics([row, { ...row, code: "new" }], { revision: "r2", sinceRevision: "r1", previous: result.diagnostics });
assert.equal(delta.diagnostics.length, 1);
assert.equal(delta.diagnostics[0].code, "new");
const malformed = normalizeDiagnostics([{ provider: "x", message: "missing path" }]);
assert.equal(malformed.errors.length, 1);
console.log("diagnostic normalizer tests passed");
