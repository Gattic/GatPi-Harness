"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CognitiveCoordinator } = require("../src/cognitive-architecture");
const { ReasoningRuntime } = require("../src/reasoning-runtime");

const runtime = new ReasoningRuntime();
assert.throws(() => runtime.createPlan({ objective: "no leaks", privateReasoning: "secret", chain_of_thought: "hidden", scratchpad: "do not expose" }), /private reasoning fields/);
const plan = runtime.createPlan({ objective: "no leaks", steps: [] });
const checkpoint = runtime.createCheckpoint({ publicSummary: "public", scratchpad: "private scratch" });
const packet = runtime.resultPacket();
assert.equal(plan.privateReasoning, undefined);
assert.equal(plan.chain_of_thought, undefined);
assert.equal(plan.scratchpad, undefined);
assert(checkpoint.scratchpadRef);
assert(!JSON.stringify(packet).includes("private scratch"), "public result packet must not expose private scratchpads");

const coordinator = new CognitiveCoordinator();
assert.equal(coordinator.arbitrate({ verification: { ok: true, confidence: 1, reflection: "looks good" } }).decision, "needs_evidence", "self-reflection/confidence must not be accepted as proof");
assert.equal(coordinator.arbitrate({ verification: { ok: false } }).decision, "revise");

const source = fs.readFileSync(path.join(process.cwd(), "src", "cognitive-architecture.js"), "utf8");
assert(!source.includes("Delegate implementation to executor"), "legacy internal planner script must not return canned reasoning pipeline");
assert(!source.includes("implementation passed isolated adversarial verification"), "legacy arbitration must not accept without explicit evidence");
assert(!source.includes("long-horizon-reasoning"), "harness must not advertise hard-coded long-horizon reasoning capability");

console.log("reasoning-policy tests passed");
