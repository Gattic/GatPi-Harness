#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(process.cwd(), ".pi", "extensions", "code-context", "index.ts");
const source = fs.readFileSync(file, "utf8");
assert.match(source, /name:\s*"code_context"/);
for (const operation of ["repoMap", "search", "symbolGet", "symbolRelations", "buildQuery", "changeImpact", "diagnostics"]) assert.ok(source.includes(`"${operation}"`), `missing operation ${operation}`);
assert.match(source, /src", "code-context-service\.js/);
for (const lifecycle of ["session_start", "session_compact", "session_shutdown", "tool_call", "tool_result"]) assert.ok(source.includes(`\"${lifecycle}\"`), `missing lifecycle ${lifecycle}`);
assert.match(source, /shouldMarkStaleFromTool/);
assert.match(source, /touchedFilesFromTool/);
assert.doesNotMatch(source, /before_agent_start/, "initial rollout must not inject source automatically");
assert.doesNotMatch(source, /execFile|spawn|ripgrep|codegraph query/, "extension must remain a thin registration layer");
assert.match(source, /gatingSafe=false/);
console.log("code-context extension tests passed");
