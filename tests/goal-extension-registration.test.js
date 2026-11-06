"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(".pi/extensions/goal/index.ts", "utf8");
const tuiSource = fs.readFileSync("scripts/check-goal-tui.sh", "utf8");
for (const command of ["goal", "goal-status", "goal-stop", "goal-resume", "goal-log", "goal-doctor", "goal-clear", "goal-archive", "goal-plan", "goal-export", "goal-prune", "goal-trace", "goal-metrics"]) {
  assert(source.includes(`pi.registerCommand("${command}"`), `${command} command should be registered`);
}
assert(source.includes('pi.on("session_shutdown"'), "goal runner should cancel on session shutdown");
assert(source.includes('pi.on("agent_end"'), "goal runner should auto-resume after agent turns");
assert(source.includes("PI_GOAL_AUTO_RESUME"), "goal auto-resume should be env-configurable");
assert(source.includes("ExecutionOutcomeAdapter"), "goal settlement capture should use the integration-boundary adapter");
assert(source.includes("outcomes.buildGoalSettlement"), "goal finalization should build a privacy-safe settlement packet");
assert.doesNotMatch(source, /PI_GOAL_SYNC_FINAL|hermes\.ask|HermesClient/, "goal finalization must not sync to Hermes");
assert.doesNotMatch(source, /require\(["'][^"']*execution-outcome/, "goal extension must not import the execution store directly");
assert.match(tuiSource, /"schemaVersion":3/, "goal TUI fixture should use the current decision schema");
assert.match(tuiSource, /"prompt":"Inspect fixture repository status without changing files\."/, "goal TUI fixture should provide a Hermes-authored executable prompt");
assert.doesNotMatch(tuiSource, /"schemaVersion":2/, "goal TUI fixture should not retain the obsolete decision schema");
console.log("goal-extension-registration tests passed");
