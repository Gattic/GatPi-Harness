"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MemoryJsonStorage, EntropyAdapter, OrchestrationAdapter, BranchingAdapter } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const storage = new MemoryJsonStorage();
  const entropy = new EntropyAdapter({ storage });
  const snap = entropy.observe({ type: "objective", text: "keep boundary clean", contextBudgetTokens: 200 });
  assert(Number.isFinite(snap.metrics.entropyScore));
  assert.equal(storage.readJsonl("entropy/events").length, 1);

  const orchestration = new OrchestrationAdapter();
  const result = await orchestration.coordinate("Plan adapter contract", { steps: ["write artifact schema"] });
  assert.equal(result.kind, "reasoning.scaffold");
  assert.equal(result.plan.type, "plan");

  const tmp = tmpFixture("pi-adapter-branch-");
  fs.writeFileSync(path.join(tmp, "README.md"), "hello\n");
  const branching = new BranchingAdapter({ cwd: tmp, storage });
  const branch = branching.createBranch({ type: "verification", name: "contract" });
  assert(branch.id.startsWith("br_"));
  fs.writeFileSync(path.join(tmp, "README.md"), "hello left\n");
  const left = branching.createBranch({ fromBranchId: branch.id, type: "speculative", name: "left" });
  fs.writeFileSync(path.join(tmp, "other.md"), "right\n");
  const right = branching.createBranch({ fromBranchId: branch.id, type: "verification", name: "right" });
  const beforePreviewCount = branching.list().length;
  const preview = branching.previewMerge(left.id, right.id);
  assert.equal(preview.ok, true, "adapter can dry-run merge without creating a branch");
  assert.equal(branching.list().length, beforePreviewCount, "preview merge is non-mutating");
  const merged = branching.merge(left.id, right.id, { apply: false });
  assert.equal(merged.ok, true, "adapter can apply merge metadata");
  assert(merged.branch.id.startsWith("br_"));
  const checkpoint = branching.checkpoint(left.id, { metadata: { test: true } });
  const rolledBack = branching.rollback(left.id, checkpoint.id);
  assert.equal(rolledBack.id, checkpoint.id, "adapter exposes guarded rollback primitive");
  assert.equal(branching.list().length, 4);
  console.log("entropy-orchestration-branching-adapters tests passed");
})();
