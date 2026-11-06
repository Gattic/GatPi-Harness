"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { createPiIntegrationBoundary, RecordingSink } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-cognitive-persist-");
const storage = new FileIntegrationStorage(path.join(tmp, ".pi", "cognitive-automation"));
let boundary = createPiIntegrationBoundary({ storage, sink: new RecordingSink(), orchestration: { enabled: false }, verification: { enabled: false }, branching: { enabled: false } });
boundary.memory.remember({ type: "semantic", title: "Persisted", content: "adapter storage survives reconstruction", verification: "verified", confidence: 0.9 });
boundary.context.upsert({ layer: "L1", title: "Persisted context", content: "stored through file integration storage", verification: "verified", protected: true });
const plan = boundary.reasoning.createPlan({ objective: "Persist reasoning scaffold", steps: ["save", "reload"] });
boundary.reasoning.createCheckpoint({ kind: "reflection", publicSummary: "Persistence checkpoint", artifactIds: [plan.id], scratchpad: "private note must not appear in artifacts" });
boundary.memory.persist();
boundary.context.persist();
boundary.reasoning.persist();

boundary = createPiIntegrationBoundary({ storage, sink: new RecordingSink(), orchestration: { enabled: false }, verification: { enabled: false }, branching: { enabled: false } });
assert.equal(boundary.memory.retrieve("reconstruction").entries.length, 1);
assert(boundary.context.pack({ tokenBudget: 100, query: "storage" }).text.includes("Persisted context"));
assert(boundary.reasoning.artifacts({ type: "plan" }).some((a) => a.id === plan.id), "reasoning artifacts survive reconstruction");
assert(!JSON.stringify(boundary.reasoning.artifacts()).includes("private note"), "private scratchpad text is not exposed after reconstruction");
console.log("cognitive-extension-persistence tests passed");
