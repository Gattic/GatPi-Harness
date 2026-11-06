"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { MemoryJsonStorage, RecordingSink, createPiIntegrationBoundary } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-disabled-");
  const storage = new MemoryJsonStorage();
  const sink = new RecordingSink();
  const boundary = createPiIntegrationBoundary({ enabled: false, storage, sink, branching: { cwd: tmp } });
  boundary.trace.emit({ name: "x" });
  boundary.memory.remember({ type: "semantic", content: "x" });
  boundary.context.upsert({ layer: "L1", content: "x" });
  boundary.anchoring.diff("a", "b", "x.txt");
  await boundary.verification.verify({ cwd: tmp });
  boundary.entropy.observe({ type: "objective", text: "x" });
  await boundary.orchestration.coordinate("x");
  boundary.branching.createBranch({ type: "verification" });
  assert.equal(storage.map.size, 0, "disabled boundary writes no JSON state");
  assert.equal(storage.appended.size, 0, "disabled boundary appends no event state");
  assert.equal(sink.events.length, 0, "disabled boundary emits no sink events");
  assert.deepEqual(fs.readdirSync(tmp), [], "disabled boundary creates no filesystem artifacts");
  console.log("disabled-side-effects tests passed");
})();
