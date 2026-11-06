#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { BuildGraph } = require("../src/build-graph.js");
const { MemoryBuildGraphStore, FileBuildGraphStore } = require("../src/build-graph-store.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const graph = new BuildGraph({ repository: "/repo", revision: "r1" });
graph.setProviderStatus({ provider: "fixture", available: true, freshness: "fresh", gatingSafe: true, capabilities: ["owners"] });
graph.addFact({ provider: "fixture", subject: "src/a.cpp", predicate: "owned-by-target", object: "target:app", configuration: "Debug", freshness: "fresh", gatingSafe: true, path: "src/a.cpp" });
graph.addFact({ provider: "fixture", subject: "src/a.cpp", predicate: "owned-by-target", object: "target:app", configuration: "Release", freshness: "fresh", gatingSafe: true, path: "src/a.cpp" });
graph.addFact({ provider: "fixture", subject: "target:app", predicate: "depends-on", object: "target:lib", configuration: "Debug", freshness: "fresh", gatingSafe: true });
graph.addFact({ provider: "fixture", subject: "target:lib", predicate: "produces", object: "build/lib.a", configuration: "Debug", freshness: "fresh", gatingSafe: true });
assert.equal(graph.allFacts().length, 4, "configuration-specific facts must not collapse");
assert.equal(graph.query({ entity: "src/a.cpp", relation: "owner", configuration: "Debug" }).facts[0].object, "target:app");
assert.equal(graph.query({ entity: "target:app", relation: "deps", configuration: "Debug", maximumDepth: 2 }).facts[0].object, "target:lib");
assert.equal(graph.query({ entity: "target:lib", relation: "rdeps", configuration: "Debug" }).facts[0].subject, "target:app");
assert.ok(graph.cardsForPath("src/a.cpp", "Debug")[0].signature.includes("[Debug]"));
const fingerprint = graph.fingerprint();
assert.equal(fingerprint.length, 24);

const memory = new MemoryBuildGraphStore();
memory.write({ repo: "/repo", revision: "r1" }, graph);
assert.equal(memory.read({ repo: "/repo", revision: "r1" }).fingerprint(), fingerprint);
const tmp = tmpFixture("pi-build-graph-store-");
const files = new FileBuildGraphStore(tmp);
const saved = files.write("fixture", graph);
assert.ok(fs.existsSync(saved.file));
assert.equal(fs.statSync(saved.file).mode & 0o077, 0, "build graph cache must be private");
assert.equal(files.read("fixture").fingerprint(), fingerprint);
assert.equal(files.list().length, 1);
assert.equal(files.remove("fixture"), true);
console.log("build graph tests passed");
