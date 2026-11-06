"use strict";

const assert = require("node:assert/strict");
const { renderRolloutCenterFrame, visibleLength } = require("../src/rollout-center-view");
const { snapshot } = require("./visual-fixtures/rollout-center");

for (const width of [40, 72, 120]) {
  for (const mode of ["summary", "detail", "provenance"]) {
    const lines = renderRolloutCenterFrame(snapshot, { selectedIndex: 0, filter: "all", mode }, width);
    assert(lines.length > 3);
    assert(lines.every((line) => visibleLength(line) <= width), `all lines fit width ${width}`);
    assert.equal(lines[0].length, width);
  }
}
const attention = renderRolloutCenterFrame(snapshot, { filter: "attention" }, 72).join("\n");
assert.match(attention, /Project memory/);
assert.doesNotMatch(attention, /Verification\s+\|/, "passing verification is filtered out of attention view");
const stale = renderRolloutCenterFrame(snapshot, { filter: "stale" }, 40).join("\n");
assert.match(stale, /No capabilities match/);
console.log("rollout center view tests passed");
