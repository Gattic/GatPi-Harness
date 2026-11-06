#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const files = fs.readdirSync(path.join(root, "src")).filter((file) => file.endsWith(".js"));
const fileSet = new Set(files);
const graph = new Map();
for (const file of files) {
  const text = fs.readFileSync(path.join(root, "src", file), "utf8");
  const dependencies = [];
  const pattern = /require\("\.\/([^"]+)"\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    let dependency = match[1];
    if (!dependency.endsWith(".js")) dependency += ".js";
    if (fileSet.has(dependency)) dependencies.push(dependency);
  }
  graph.set(file, Array.from(new Set(dependencies)));
}

const cycles = [];
const settled = new Set();
function visit(node, stack, onStack) {
  onStack.add(node);
  stack.push(node);
  for (const dependency of graph.get(node) || []) {
    if (onStack.has(dependency)) {
      const start = stack.indexOf(dependency);
      cycles.push(stack.slice(start).concat(dependency));
    } else if (!settled.has(dependency)) {
      visit(dependency, stack, onStack);
    }
  }
  stack.pop();
  onStack.delete(node);
  settled.add(node);
}
for (const file of files) if (!settled.has(file)) visit(file, [], new Set());

assert.deepEqual(cycles, [], `require cycles must be zero:\n${cycles.map((cycle) => cycle.join(" -> ")).join("\n")}`);
console.log(`require-cycles tests passed (${files.length} modules, 0 cycles)`);
