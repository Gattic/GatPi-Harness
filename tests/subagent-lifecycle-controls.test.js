"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { resolveSubagentPreflight, publicRecord, publicResult } = require("../src/subagent-lifecycle");
const { SessionBranchManager, SnapshotStore } = require("../src/session-branches");
const { SubagentRunner, SubagentService } = require("../src/subagents");
const { tmpFixture } = require("./helpers/tmp-fixture");

const worker = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "worker");
const request = { parentSessionId: "session-fixture", role: worker.roleId, roleContract: worker, task: "Inspect the bounded fixture", workspacePolicy: worker.workspacePolicy, mutationPolicy: worker.mutationPolicy, toolPolicy: worker.toolPolicy, modelPolicy: worker.modelPolicy, budget: worker.budget };
const options = { inheritedModel: "provider/model", inheritedThinkingLevel: "low", actualTools: worker.toolPolicy.allowedTools, activeCount: 0, maxConcurrentPerParent: 2, env: {} };
const first = resolveSubagentPreflight(request, options);
const second = resolveSubagentPreflight(request, options);
assert.equal(first.allowed, true);
assert.equal(first.launchDigest, second.launchDigest, "preflight digest is deterministic");
assert.deepEqual(first.sideEffects, { processes: 0, sessions: 0, records: 0, workspaces: 0, locks: 0, telemetryRows: 0, cacheWrites: 0 });
assert(!JSON.stringify(first).includes(request.task), "preflight exposes a task hash, not task text");
const denied = resolveSubagentPreflight({ ...request, capabilityCeiling: { allowedTools: ["read"] } }, options);
assert.equal(denied.allowed, false);
assert(denied.reasons.includes("tool-ceiling-denied"));
const nested = resolveSubagentPreflight({ ...request, parentSubagentId: "sub_parent", depth: 2 }, options);
assert.equal(nested.allowed, false);
assert(nested.reasons.includes("nested-delegation-denied"));

(async () => {
  const tmp = tmpFixture("pi-subagent-controls-");
  const branchManager = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi", "branches")) });
  const parent = branchManager.createBranch({ type: "verification", name: "parent", states: {} });
  const pending = new Map();
  const runner = new SubagentRunner({ execute: ({ record, context }) => new Promise((resolve, reject) => {
    const abort = () => { const error = new Error("aborted"); error.name = "AbortError"; error.code = "SUBAGENT_ABORTED"; error.termination = { code: record.controlState === "interrupt-requested" ? "interrupted" : "cancelled", stopReason: "aborted", messageCode: "control-request" }; reject(error); };
    if (context.signal?.aborted) return abort();
    context.signal?.addEventListener?.("abort", abort, { once: true });
    pending.set(record.id, { resolve, reject });
  }) });
  runner.steer = () => true;
  runner.interrupt = () => false;
  const service = new SubagentService({ cwd: tmp, branchManager, runner, config: { maxConcurrentPerParent: 4, defaultWallClockMs: 2000 } });
  const observed = [];
  const unsubscribe = service.subscribe((event) => observed.push(event));

  const created = service.createSubagent({ parentSessionId: "session-fixture", parentBranchId: parent.id, role: "worker", task: "Complete lifecycle fixture" });
  const launch = service.launchSubagent({ subagentId: created.id });
  assert.equal(launch.launched, true);
  await delay(5);
  const steer = service.steerSubagent({ subagentId: created.id, message: "Focus on the public contract" });
  assert.equal(steer.acknowledged, true);
  assert.match(steer.messageHash, /^sha256:[a-f0-9]{64}$/);
  pending.get(created.id).resolve({ summary: "Lifecycle fixture complete", final_response: "private child response", model_calls: 1, tool_calls: 0, tool_results: 0 });
  const result = await service.waitSubagent({ subagentId: created.id, timeoutMs: 1000 });
  assert.equal(result.status, "succeeded");
  const settled = service.getSubagent({ subagentId: created.id });
  assert(settled.processClosedAt);
  assert.match(settled.receiptId, /^receipt_[a-f0-9]{20}$/);
  assert.equal(settled.result.receiptId, settled.receiptId);
  assert(observed.some((event) => event.type === "subagent.process_closed"));
  assert(observed.some((event) => event.type === "subagent.steer_acknowledged"));
  assert(observed.every((event, index) => index === 0 || event.sequence > observed[index - 1].sequence), "public lifecycle events have monotonic replay order");
  assert(observed.findIndex((event) => event.type === "subagent.process_closed") < observed.findIndex((event) => event.type === "subagent.completed"), "process-close proof precedes terminal completion event");
  assert(!JSON.stringify(observed).includes("Focus on the public contract"), "events retain counts/hashes rather than steering text");

  const projected = publicRecord(settled, settled.result);
  assert.equal(projected.task, undefined);
  assert.equal(projected.systemPrompt, undefined);
  assert.equal(projected.workspace?.path, undefined);
  assert.equal(publicResult(settled.result).final_response, undefined);
  assert.equal(publicResult(settled.result).summary, "Lifecycle fixture complete");
  assert.deepEqual(publicResult({ status: "succeeded", workspaceDisposition: { status: "baseline-satisfied", changedPaths: ["src/example.js"], reason: "Inherited task-relevant changes already satisfy the delegated assignment." } }).workspaceDisposition, { status: "baseline-satisfied", changedPaths: ["src/example.js"], reason: "Inherited task-relevant changes already satisfy the delegated assignment." }, "public results preserve the bounded baseline disposition for downstream verification");
  const unsafePublicResult = publicResult({ status: "succeeded", summary: `Result at /home/synthetic/private with ${["sk", "-", "P".repeat(24)].join("")}`, findings: [{ summary: "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_MATERIAL\n-----END PRIVATE KEY-----" }] });
  assert(!JSON.stringify(unsafePublicResult).includes("/home/synthetic"));
  assert(!JSON.stringify(unsafePublicResult).includes("SYNTHETIC_PRIVATE_MATERIAL"), "public lifecycle DTOs redact secrets and absolute paths recursively");

  const interrupted = service.createSubagent({ parentSessionId: "session-interrupt", parentBranchId: parent.id, role: "worker", task: "Interrupt lifecycle fixture" });
  service.launchSubagent({ subagentId: interrupted.id });
  await delay(5);
  const interrupt = service.interruptSubagent({ subagentId: interrupted.id });
  assert.equal(interrupt.acknowledged, true);
  const interruptedResult = await service.waitSubagent({ subagentId: interrupted.id, timeoutMs: 1000 });
  assert.equal(interruptedResult.status, "cancelled");
  assert.equal(service.getSubagent({ subagentId: interrupted.id }).resumable, true);
  const resumed = service.resumeSubagent({ subagentId: interrupted.id, task: "Resume with bounded scope" });
  assert.equal(resumed.previousAttemptId, interrupted.id);
  assert.equal(resumed.rootAttemptId, interrupted.id);
  assert.equal(resumed.attempt, 2);

  const cancelled = service.createSubagent({ parentSessionId: "session-cancel", parentBranchId: parent.id, task: "Cancel before launch" });
  await service.cancelSubagent({ subagentId: cancelled.id, reason: "user requested cancellation" });
  const cancelledRecord = service.getSubagent({ subagentId: cancelled.id });
  assert.equal(cancelledRecord.status, "cancelled");
  assert(cancelledRecord.processClosedAt);
  assert.equal(cancelledRecord.cancelReason, undefined);
  assert.match(cancelledRecord.cancelReasonHash, /^sha256:/);

  assert.throws(() => service.createSubagent({ parentSessionId: "nested", parentSubagentId: created.id, depth: 2, task: "nested" }), (error) => error.code === "SUBAGENT_NESTED_DELEGATION_DENIED");
  unsubscribe();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("subagent lifecycle control tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
