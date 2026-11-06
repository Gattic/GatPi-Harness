"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { SessionBranchManager, SnapshotStore } = require("../src/session-branches");
const { SubagentService, SubagentRunner, withRpcConcurrency } = require("../src/subagents");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { messageDiagnostics, normalizeBudget, budgetViolation, validateRpcCompletion, createRpcBudgetTracker } = require("../src/subagent-result-validator");
const { tmpFixture } = require("./helpers/tmp-fixture");

const budget = normalizeBudget({ maxSteps: 2, maxToolCalls: 3, maxQueueWaitMs: 40, maxResultChars: 20 }, { wallClockMs: 1000 });
assert.equal(budget.maxSteps, 2);
assert.equal(budget.maxModelCalls, 2, "legacy maxSteps is enforced as maxModelCalls");
assert.equal(budget.maxToolCalls, 3);

const messages = [
  { role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read" }, { type: "toolCall", id: "call-b", name: "find" }, { type: "toolCall", id: "call-c", name: "grep" }], usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.1 } } },
  { role: "toolResult", toolCallId: "call-a", toolName: "read", isError: false, content: [] },
  { role: "toolResult", toolCallId: "call-b", toolName: "find", isError: true, content: [] },
  { role: "toolResult", toolCallId: "orphan", toolName: "grep", isError: false, content: [] },
  { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { totalTokens: 1 } },
];
const diagnostics = messageDiagnostics(messages);
assert.equal(diagnostics.modelCalls, 2);
assert.equal(diagnostics.toolCalls, 3, "tool results must not double-count executions");
assert.equal(diagnostics.toolResults, 3);
assert.equal(diagnostics.toolFailures, 1);
assert.deepEqual(diagnostics.unmatchedToolCallIds, ["call-c"]);
assert.deepEqual(diagnostics.unmatchedToolResultIds, ["orphan"]);
assert.equal(diagnostics.tokenUsage.totalTokens, 6);
assert.equal(diagnostics.tokenUsage.input, null, "missing per-message usage cannot be silently summed as zero");
assert.equal(diagnostics.tokenUsage.cost.total, null, "partial cost data is not a complete cost observation");
assert.equal(messageDiagnostics([{ role: "assistant", content: [] }]).tokenUsage.totalTokens, null);
const repeatedReads = messageDiagnostics([{ role: "assistant", content: [1, 2].map(id => ({ type: "toolCall", id: `read-${id}`, name: "read", arguments: { path: "/private/source/fixture.js", offset: 1, limit: 50 } })) }]);
assert.deepEqual(repeatedReads.sourceReads, { requested: 2, uniqueRequests: 1, repeatedRequests: 1 });
assert(!JSON.stringify(repeatedReads).includes("/private/source/fixture.js"), "read telemetry retains counts, never source paths or arguments");
assert.equal(budgetViolation(diagnostics, budget), null, "the configured limit is inclusive");
assert.equal(budgetViolation({ ...diagnostics, modelCalls: 3 }, budget).code, "SUBAGENT_BUDGET_MODEL_CALLS");
assert.equal(budgetViolation({ ...diagnostics, toolCalls: 4 }, budget).code, "SUBAGENT_BUDGET_TOOL_CALLS");
const streamTracker = createRpcBudgetTracker({ maxModelCalls: 8, maxToolCalls: 4 });
streamTracker.observe({ type: "tool_execution_start", toolCallId: "stream-a" });
streamTracker.observe({ type: "tool_execution_end", toolCallId: "stream-a", isError: false });
streamTracker.observe({ type: "tool_execution_start", toolCallId: "stream-b" });
streamTracker.observe({ type: "tool_execution_end", toolCallId: "stream-b", isError: true });
assert.deepEqual({ toolCalls: streamTracker.snapshot().toolCalls, toolResults: streamTracker.snapshot().toolResults, toolFailures: streamTracker.snapshot().toolFailures, unmatched: streamTracker.snapshot().unmatchedToolCallIds }, { toolCalls: 2, toolResults: 2, toolFailures: 1, unmatched: [] }, "stream budget failures retain completed tool-result accounting");
assert.equal(validateRpcCompletion({ agentEnd: {}, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "123456789012345678901" }] }], budget }).termination.code, "budget_output");
const reviewerContract = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "reviewer");
const reviewerSubmission = createRoleResultEnvelope({ contract: reviewerContract, subagentId: "reviewer-budget", submission: { summary: "Review completed without correctness or regression defects.", findings: [], evidence: [{ kind: "diff", summary: "Inspected the bounded patch." }], verification: { status: "passed", evidence: ["bounded patch inspected"] } } });
const reviewerMessages = [];
for (let index = 1; index <= 6; index++) {
  reviewerMessages.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `review-${index}`, name: "role_diff" }] });
  reviewerMessages.push({ role: "toolResult", toolCallId: `review-${index}`, toolName: "role_diff", isError: false, content: [] });
}
reviewerMessages.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "review-submit", name: "submit_role_result" }] });
reviewerMessages.push({ role: "toolResult", toolCallId: "review-submit", toolName: "submit_role_result", isError: false, details: { result: reviewerSubmission }, content: [] });
const reviewerCompletion = validateRpcCompletion({ agentEnd: {}, messages: reviewerMessages, budget: reviewerContract.budget, roleContract: reviewerContract, requireRoleResultV2: true, subagentId: "reviewer-budget" });
assert.equal(reviewerCompletion.ok, true, "reviewers can inspect across six model turns and reserve a seventh for typed submission");
assert.equal(reviewerCompletion.diagnostics.modelCalls, 7);
const incomplete = validateRpcCompletion({ agentEnd: {}, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "unfinished", name: "read" }, { type: "text", text: "claimed success" }] }], budget });
assert.equal(incomplete.ok, false);
assert.equal(incomplete.termination.code, "incomplete_tool_use", "unmatched tool calls can never count as success");

(async () => {
  let releaseFirst;
  const first = withRpcConcurrency(1, async () => new Promise((resolve) => { releaseFirst = resolve; }));
  await delay(10);
  await assert.rejects(() => withRpcConcurrency(1, async () => "late", { maxQueueWaitMs: 20 }), (error) => error.code === "SUBAGENT_QUEUE_TIMEOUT");
  const queuedAbort = new AbortController();
  const cancelled = withRpcConcurrency(1, async () => "never", { signal: queuedAbort.signal });
  queuedAbort.abort();
  await assert.rejects(() => cancelled, (error) => error.name === "AbortError");
  releaseFirst("released");
  await first;

  const queueStarted = Date.now();
  let releaseQueuedBlocker;
  const blocker = withRpcConcurrency(1, async () => new Promise((resolve) => { releaseQueuedBlocker = resolve; }));
  const queued = withRpcConcurrency(1, async ({ queueWaitMs }) => { await delay(30); return { queueWaitMs, executionMs: 30 }; }, { maxQueueWaitMs: 200 });
  await delay(50);
  releaseQueuedBlocker();
  await blocker;
  const queuedResult = await queued;
  assert(queuedResult.queueWaitMs >= 40);
  assert(Date.now() - queueStarted >= 70, "queue wait and execution are distinct intervals");

  const tmp = tmpFixture("pi-subagent-budget-");
  fs.writeFileSync(path.join(tmp, "README.md"), "fixture\n");
  const branchManager = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi", "session-branches")) });
  const parent = branchManager.createBranch({ type: "verification", name: "parent" });
  const fakeRpc = path.join(tmp, "budget-rpc.js");
  fs.writeFileSync(fakeRpc, `
const scenario = process.argv[2];
let buffer = "";
const messages = [{ role: "assistant", content: [{ type: "text", text: "delayed final" }], stopReason: "stop", timestamp: Date.now() }];
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const raw = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.type === "prompt") {
      emit({ type: "response", id: message.id, command: "prompt", success: true });
      if (scenario === "model") for (let i = 0; i < 3; i++) emit({ type: "message_start", message: { role: "assistant", timestamp: Date.now() + i } });
      else if (scenario === "tools") for (let i = 0; i < 3; i++) emit({ type: "tool_execution_start", toolCallId: "tool-" + i, toolName: "read", args: {} });
      else if (scenario === "output") emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "123456789012345678901" } });
      else if (scenario === "delayed") setTimeout(() => emit({ type: "agent_end", messages, willRetry: false }), 180);
    } else if (message.type === "get_state") emit({ type: "response", id: message.id, command: "get_state", success: true, data: { sessionFile: "/tmp/synthetic-budget-session.jsonl", isStreaming: false } });
    else if (message.type === "get_messages") emit({ type: "response", id: message.id, command: "get_messages", success: true, data: { messages } });
    else if (message.type === "abort") emit({ type: "response", command: "abort", success: true });
  }
});
`);
  const service = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 20, defaultWallClockMs: 1000 }, runner: new SubagentRunner() });
  async function runBudgetScenario(scenario, value) {
    const sub = service.createSubagent({ parentSessionId: `budget-${scenario}`, parentBranchId: parent.id, task: scenario, budget: value });
    return service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc, scenario], timeoutMs: 1000 } } });
  }
  const modelOver = await runBudgetScenario("model", { maxModelCalls: 2 });
  assert.equal(modelOver.status, "failed");
  assert.equal(modelOver.termination.code, "budget_model_calls");
  assert.equal(modelOver.diagnostics.modelCalls, 3);
  const toolOver = await runBudgetScenario("tools", { maxToolCalls: 2 });
  assert.equal(toolOver.status, "failed");
  assert.equal(toolOver.termination.code, "budget_tool_calls");
  assert.equal(toolOver.diagnostics.toolCalls, 3);
  assert.equal(toolOver.diagnostics.boundedToolOvershoot, 1);
  const outputOver = await runBudgetScenario("output", { maxResultChars: 20 });
  assert.equal(outputOver.status, "failed");
  assert.equal(outputOver.termination.code, "budget_output");

  const launchFailureSub = service.createSubagent({ parentSessionId: "launch-failure", parentBranchId: parent.id, task: "launch failure", budget: { wallClockMs: 1_000, maxQueueWaitMs: 1_000 } });
  const launchFailure = await service.runSubagent({ subagentId: launchFailureSub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: path.join(tmp, "missing-rpc-command"), timeoutMs: 1_000 } } });
  assert.equal(launchFailure.status, "failed");
  assert.equal(launchFailure.termination.code, "rpc_launch");

  const rssLimitedSub = service.createSubagent({ parentSessionId: "rss-limited", parentBranchId: parent.id, task: "rss-limited", budget: { wallClockMs: 1_000, maxQueueWaitMs: 1_000 } });
  const rssLimited = await service.runSubagent({
    subagentId: rssLimitedSub.id,
    context: {
      executionMode: "tool-rpc",
      cwd: tmp,
      rpc: {
        command: process.execPath,
        argsPrefix: [fakeRpc, "delayed"],
        timeoutMs: 1_000,
        resourceGuard: { rssLimitMb: 1, rssPollMs: 10, termGraceMs: 30 },
      },
    },
  });
  assert.equal(rssLimited.status, "failed");
  assert.equal(rssLimited.termination.code, "rss_limit");
  assert.ok(rssLimited.diagnostics.peakRssBytes > rssLimited.diagnostics.rssLimitBytes, "RPC sidecars report the owned process-group RSS breach");

  const delayedSubs = [0, 1].map((index) => service.createSubagent({ parentSessionId: "queue-does-not-spend-execution", parentBranchId: parent.id, task: `delayed-${index}`, budget: { wallClockMs: 250, maxQueueWaitMs: 700 } }));
  const delayedResults = await Promise.all(delayedSubs.map((sub) => service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc, "delayed"], concurrency: 1, timeoutMs: 250 } } })));
  assert(delayedResults.every((result) => result.status === "succeeded"), `queued runs retain their full child execution wall-clock budget: ${JSON.stringify(delayedResults.map((result) => ({ status: result.status, termination: result.termination, diagnostics: result.diagnostics })))}`);
  assert(delayedResults[1].diagnostics.queueWaitMs >= 150);
  assert(delayedResults[1].diagnostics.executionDurationMs >= 150);
  assert(delayedResults[1].diagnostics.totalDurationMs > 250, "the queued run may exceed its execution budget in total without timing out");
  assert.equal(delayedResults[1].diagnostics.totalDurationMs, delayedResults[1].diagnostics.queueWaitMs + delayedResults[1].diagnostics.executionDurationMs);

  const cancellationService = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 20, defaultWallClockMs: 1000 }, runner: new SubagentRunner({ execute: async () => { await delay(80); return { final_response: "late success", summary: "late" }; } }) });
  const cancelSub = cancellationService.createSubagent({ parentSessionId: "cancel-running", parentBranchId: parent.id, task: "cancel" });
  const controller = new AbortController();
  const cancellationRun = cancellationService.runSubagent({ subagentId: cancelSub.id, context: { signal: controller.signal } });
  await delay(10);
  controller.abort();
  const cancelledResult = await cancellationRun;
  assert.equal(cancelledResult.status, "cancelled");
  await delay(100);
  assert.equal(cancellationService.store.getResult(cancelSub.id).status, "cancelled", "late runner completion cannot overwrite cancellation");

  console.log("subagent budget enforcement tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
