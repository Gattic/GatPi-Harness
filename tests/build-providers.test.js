#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { discoverCompilationDatabases, loadCompilationDatabases } = require("../src/build-graph-compile-commands.js");
const { discoverCmakeReplies, loadCmakeFileApi } = require("../src/build-graph-cmake-file-api.js");
const { loadBuildGraph } = require("../src/build-graph.js");

const root = path.resolve(__dirname, "fixtures", "build-graph", "project");
const databases = discoverCompilationDatabases(root);
assert.deepEqual(databases.map((file) => path.relative(root, file).replace(/\\/g, "/")), ["compile_commands.json"]);
const compile = loadCompilationDatabases(root);
assert.equal(compile.available, true);
assert.equal(compile.commands.length, 2, "duplicate source commands/configurations must be preserved");
assert.equal(new Set(compile.commands.map((command) => command.configuration)).size, 2);
assert.ok(compile.commands.some((command) => command.defines.includes("-DAPI_TOKEN=<redacted>")));
assert.ok(compile.commands.every((command) => !JSON.stringify(command).includes("secret-value")));
assert.ok(compile.commands.some((command) => command.output === "build/debug/main.o"));

const replies = discoverCmakeReplies(root);
assert.equal(replies.length, 1);
const cmake = loadCmakeFileApi(root);
assert.equal(cmake.available, true);
assert.equal(cmake.targets.length, 3);
assert.ok(cmake.facts.some((fact) => fact.predicate === "owned-by-target" && fact.object === "cmake-target:app" && fact.configuration === "Debug"));
assert.ok(cmake.facts.some((fact) => fact.predicate === "owned-by-target" && fact.configuration === "Release"));
assert.ok(cmake.facts.some((fact) => fact.predicate === "generates" && fact.object === "generated/version.cpp"));
assert.ok(cmake.facts.some((fact) => fact.predicate === "produces" && fact.object === "build/bin/app-debug"));
assert.ok(cmake.targets.every((target) => !JSON.stringify(target).includes("API_TOKEN")), "secret-like defines must not reach normalized summaries");

const loaded = loadBuildGraph(root);
assert.ok(loaded.graph.facts.size >= compile.facts.length + cmake.facts.length);
assert.ok(loaded.graph.providerStatuses().some((status) => status.provider === "compile-commands" && status.available));
assert.ok(loaded.graph.providerStatuses().some((status) => status.provider === "cmake-file-api" && status.available));
console.log("build provider tests passed");
