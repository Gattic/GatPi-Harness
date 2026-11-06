"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { createPiIntegrationBoundary, RecordingSink } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-lifecycle-");
  const storage = new FileIntegrationStorage(path.join(tmp, ".pi", "boundary"));
  let boundary = createPiIntegrationBoundary({ storage, sink: new RecordingSink(), verification: { enabled: false }, orchestration: { enabled: false }, branching: { cwd: tmp, enabled: false } });
  boundary.trace.emit({ category: "session", name: "startup" });
  boundary.memory.remember({ type: "strategic", title: "Task", content: "simulate lifecycle", verification: "inferred" });
  boundary.context.upsert({ layer: "L2", title: "Prompt", content: "before prompt", verification: "assumed" });
  boundary.entropy.observe({ type: "objective", text: "before prompt" });
  boundary.anchoring.diff("a", "b", "x.txt");
  boundary.trace.emit({ category: "compaction", name: "compact" });
  boundary.memory.persist(); boundary.context.persist();
  boundary.trace.emit({ category: "session", name: "shutdown" });

  boundary = createPiIntegrationBoundary({ storage, sink: new RecordingSink(), verification: { enabled: false }, orchestration: { enabled: false }, branching: { cwd: tmp, enabled: false } });
  assert.equal(boundary.memory.retrieve("lifecycle").entries.length, 1, "memory restored after reload-like reconstruction");
  assert(boundary.context.pack({ tokenBudget: 100, query: "prompt" }).text.includes("Prompt"), "context restored after reload-like reconstruction");
  assert(storage.readJsonl("trace/events").length >= 2, "trace lifecycle events persisted");
  console.log("adapter-lifecycle tests passed");
})();
