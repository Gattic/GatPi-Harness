"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const explorer = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "memory-explorer", "index.ts"), "utf8");
const reasoning = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
for (const adapter of ["SessionSearchAdapter", "MemoryContentSafetyAdapter", "ProjectMemoryAdapter"]) assert(explorer.includes(adapter));
for (const operation of ["sessionSearch", "sessionGet", "standing", "scanContent", "pin", "unpin", "correction"]) assert(explorer.includes(`Type.Literal("${operation}")`), `memory surface exposes ${operation}`);
assert(explorer.includes("sessionSearch(ctx.cwd, params.query") && explorer.includes("signal"), "session search receives bounded cancellation");
assert(explorer.includes("review-queue-not-authorized-at-rollout-stage"), "correction review remains rollout-gated");
assert(explorer.includes("explicit-writes-not-authorized-at-rollout-stage"), "standing mutation remains rollout-gated");
assert(reasoning.includes("standingProjectMemory") && reasoning.includes("formatStanding"), "standing memory is injected independently of task recall");
assert(reasoning.includes("observeCorrection?.(inputText)"), "correction observation uses the hash-only candidate pipeline");
assert(reasoning.includes('pi.registerCommand("subagent-preflight"'));
for (const command of ["subagent-steer", "subagent-interrupt", "subagent-wait", "subagent-continue", "subagent-resume"]) assert(reasoning.includes(`pi.registerCommand("${command}"`));
assert(!reasoning.includes("subagentCommandUsesFork"));
assert(!reasoning.includes('executionMode: "pi-fork"'));

console.log("memory/subagent plan extension source tests passed");
