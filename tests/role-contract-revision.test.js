#!/usr/bin/env node
"use strict";

// Pins the upgrade property documented in docs/subagents.md: skill awareness is
// part of a role's system prompt, so it participates in the contract revision.
// A typed record or specialist task graph created against an older revision must
// fail closed instead of silently running a different prompt. Offline only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionBranchManager, SnapshotStore } = require("../src/session-branches");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { validateTaskSpec } = require("../src/subagent-task-contracts");
const { tmpFixture } = require("./helpers/tmp-fixture");

const STALE = `sha256:${"0".repeat(64)}`;

function staleTypedRecord(service, subagentId, contract, { keepContract = false } = {}) {
  const record = service.store.get(subagentId);
  Object.assign(record, {
    status: "succeeded",
    roleContractVersion: contract.contractVersion,
    roleRevision: STALE,
    roleContract: keepContract ? contract : null,
    systemPrompt: keepContract ? contract.systemPrompt : null,
  });
  service.store.save(record);
  return record;
}

(async () => {
  const tmp = tmpFixture("pi-role-revision-");
  fs.writeFileSync(path.join(tmp, "README.md"), "base\n");
  const branchManager = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi/session-branches")) });
  const parent = branchManager.createBranch({ type: "verification", name: "parent", states: { contextState: { sessionId: "sess_rev" } } });
  const service = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 4 }, runner: new SubagentRunner({ execute: async () => ({ summary: "ok", final_response: "ok" }) }) });
  const verifier = DEFAULT_ROLE_CONTRACTS.find((contract) => contract.roleId === "verifier");

  // A typed record pinned to a revision that no builtin contract satisfies fails
  // closed: the runtime will not silently substitute the current prompt.
  const stale = service.createSubagent({ parentSessionId: "sess_rev", parentBranchId: parent.id, role: "verifier", task: "Verify the change." });
  staleTypedRecord(service, stale.id, verifier);
  assert.throws(
    () => service.continueSubagent({ subagentId: stale.id, task: "Continue verification." }),
    (error) => error.code === "SUBAGENT_ROLE_CONTRACT_UNAVAILABLE",
    "a typed record without a resolvable contract revision must fail closed on continuation",
  );

  // A record that persisted its contract object keeps running that contract, so
  // it stays continuable even though the revision no longer matches.
  const persisted = service.createSubagent({ parentSessionId: "sess_rev", parentBranchId: parent.id, role: "verifier", task: "Verify the persisted change." });
  staleTypedRecord(service, persisted.id, verifier, { keepContract: true });
  const continued = service.continueSubagent({ subagentId: persisted.id, task: "Continue with the persisted contract." });
  const continuedRuntime = service.materializeRuntimeRecord(service.store.get(continued.id));
  assert.equal(continued.role, "verifier");
  assert(continuedRuntime.roleContract, "the persisted contract survives continuation");
  assert.match(continuedRuntime.systemPrompt, /Harness skill awareness:/, "a persisted contract keeps its awareness block");

  // The current revision resolves, and the continued attempt carries awareness.
  const current = service.createSubagent({ parentSessionId: "sess_rev", parentBranchId: parent.id, role: "verifier", task: "Verify the current revision." });
  const currentRecord = service.store.get(current.id);
  Object.assign(currentRecord, { status: "succeeded", roleContractVersion: verifier.contractVersion, roleRevision: roleRevisionHash(verifier), roleContract: null, systemPrompt: null });
  service.store.save(currentRecord);
  const resolved = service.continueSubagent({ subagentId: current.id, task: "Continue on the current revision." });
  const resolvedRuntime = service.materializeRuntimeRecord(service.store.get(resolved.id));
  assert.equal(resolved.role, "verifier");
  assert.equal(resolvedRuntime.roleContract.roleId, "verifier", "the current revision resolves to the builtin contract");
  assert.equal(resolvedRuntime.systemPrompt.split("Harness skill awareness:").length - 1, 1, "the resolved contract carries awareness exactly once");

  // Specialist task graphs pin contractRevision and reject a stale one.
  assert.throws(
    () => validateTaskSpec({
      taskId: "task-a",
      requirementIds: ["req-1"],
      roleId: "coder",
      contractRevision: STALE,
      objective: "Implement the declared change.",
    }, DEFAULT_ROLE_CONTRACTS),
    (error) => error.code === "TASK_CONTRACT_STALE",
    "a stale task contract revision must be rejected",
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("role contract revisions: stale continuation, persisted contract, current revision and stale task graph checked");
})();
