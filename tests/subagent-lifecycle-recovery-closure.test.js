"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { SubagentAdapter } = require("../src/integration-boundary");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-subagent-recovery-closure-");
fs.writeFileSync(path.join(tmp, "a.txt"), "base\n");
execFileSync("git", ["init", "-q"], { cwd: tmp });
execFileSync("git", ["add", "."], { cwd: tmp });
execFileSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-qm", "base"], { cwd: tmp });

// The resumed attempt must produce a real workspace patch so it can settle.
const runner = new SubagentRunner({ execute: async ({ context }) => {
  fs.writeFileSync(path.join(context.cwd, "a.txt"), "resumed change\n");
  return { summary: "resumed run complete", final_response: "resumed run complete", model_calls: 1, tool_calls: 0, tool_results: 0, tool_failures: 0 };
} });
const service = new SubagentService({ cwd: tmp, runner });

function markRunning(record, workspace) {
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  service.store.save({ ...record, status: "running", startedAt, updatedAt: startedAt, owner: undefined, ...(workspace ? { workspace } : {}) });
}

(async () => {
  const created = service.createSubagent({ parentSessionId: "session-workspace", role: "worker", task: "Fixture isolated task", workspacePolicy: "isolated-worktree", mutationPolicy: "proposed-patch" });
  const lease = service.workspaceManager.acquire({ subagentId: created.id, parentSessionId: "session-workspace", task: "Fixture isolated task" });
  fs.writeFileSync(path.join(lease.cwd, "a.txt"), "changed by orphan\n");
  markRunning(service.store.get(created.id), { policy: "isolated-worktree", state: "active", path: lease.workspaceDir, cwd: lease.cwd, parentRevision: lease.parentRevision });

  const [healed] = service.recoverInterruptedRuns({ parentSessionId: "session-workspace" });
  assert.equal(healed.status, "failed");
  assert.equal(healed.termination.code, "supervisor_lost");
  assert.equal(healed.workspace.state, "retained");
  assert.equal(healed.workspace.retained, true);
  assert(healed.workspace.patchBytes > 0, "partial work captured");
  assert.deepEqual(healed.workspace.changedPaths, ["a.txt"]);
  assert(fs.existsSync(path.join(lease.workspaceDir, "capture.json")), "capture persisted for preview");
  assert.equal(service.workspaceManager.readLease(lease.workspaceDir).state, "retained", "workspace lease closed");
  const preview = service.previewSubagentPatch({ subagentId: created.id });
  assert.deepEqual(preview.changedPaths, ["a.txt"]);
  assert.equal(service.status({ parentSessionId: "session-workspace" }).active, 0);

  const branch = service.branchManager.store.loadBranch(healed.branchId);
  const agent = branch.agents.find((entry) => entry.agentId === created.id);
  assert.equal(agent.active, false, "branch agent lease completed");
  assert.equal(branch.metrics.verifierSuccess, 0, "failed verification recorded");
  assert.equal(service.branchManager.store.loadSnapshot(branch.headSnapshotId).metadata.kind, "subagent.failed");

  // Same-task resume must not hit the stale workspace lease.
  const resumed = service.resumeSubagent({ subagentId: created.id, task: "Fixture isolated task" });
  const launch = service.launchSubagent({ subagentId: resumed.id });
  assert.equal(launch.launched, true);
  const resumedResult = await service.waitSubagent({ subagentId: resumed.id, timeoutMs: 10000 });
  assert.equal(resumedResult.status, "succeeded");

  // Branch closure applies even when no workspace was ever leased.
  const plain = service.createSubagent({ parentSessionId: "session-plain", role: "worker", task: "plain orphan" });
  markRunning(service.store.get(plain.id));
  const [plainHealed] = service.recoverInterruptedRuns({ parentSessionId: "session-plain" });
  assert.equal(plainHealed.status, "failed");
  const plainBranch = service.branchManager.store.loadBranch(plainHealed.branchId);
  assert.equal(plainBranch.agents.find((entry) => entry.agentId === plain.id).active, false);
  assert.equal(service.branchManager.store.loadSnapshot(plainBranch.headSnapshotId).metadata.kind, "subagent.failed");

  // The boundary adapter used by session_start exposes the same reconciliation.
  const adapter = new SubagentAdapter({ cwd: tmp, store: service.store, branchManager: service.branchManager, runner });
  const adapterStartedAt = new Date(Date.now() - 60_000).toISOString();
  service.store.save({ schemaVersion: 3, id: "sub_adapter000000", parentSessionId: "session-adapter", role: "worker", status: "running", createdAt: adapterStartedAt, startedAt: adapterStartedAt, updatedAt: adapterStartedAt, budget: { wallClockMs: 60_000 }, workspacePolicy: "shared-readonly", diagnostics: {} });
  assert.equal(adapter.recoverInterruptedRuns({ parentSessionId: "session-adapter" }).length, 1, "boundary adapter reconciles orphans for session_start");
  assert.equal(adapter.getSubagent({ subagentId: "sub_adapter000000" }).status, "failed");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("subagent lifecycle recovery closure tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
