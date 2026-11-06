"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-stale-clean-");
fs.mkdirSync(path.join(tmp, ".pi", "cognitive-automation"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".pi", "cognitive-automation", "layered-context.json"), JSON.stringify({ version: 1, blocks: [
  { id: "stale", title: "Current cognitive route", content: "{\"error\":\"runtime.arch.coordinate is not a function\"}" },
  { id: "keep", title: "Integration boundary", content: "keep me" },
] }, null, 2));
fs.writeFileSync(path.join(tmp, ".pi", "cognitive-automation", "cognitive-memory.json"), JSON.stringify({ version: 1, entries: [
  { id: "m1", type: "episodic", title: "Assistant turn", content: "Role architecture output failed" },
  { id: "m2", type: "semantic", title: "Keep", content: "reasoning runtime" },
] }, null, 2));

const out = execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "clean-stale-reasoning-state.js")], { cwd: tmp, encoding: "utf8" });
const result = JSON.parse(out);
assert.equal(result.contextRemoved.length, 1);
assert.equal(result.memoryRemoved.length, 1);
const context = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "cognitive-automation", "layered-context.json"), "utf8"));
const memory = JSON.parse(fs.readFileSync(path.join(tmp, ".pi", "cognitive-automation", "cognitive-memory.json"), "utf8"));
assert(!JSON.stringify(context).includes("runtime.arch.coordinate"));
assert(!JSON.stringify(memory).includes("Role architecture output"));
assert(context.blocks.some((b) => b.title === "Reasoning runtime architecture"));
assert(memory.entries.some((e) => e.title === "Reasoning runtime architecture"));
console.log("stale-reasoning-cleanup tests passed");
