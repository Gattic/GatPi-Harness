"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionBranchManager, SnapshotStore } = require("../src/session-branches");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-subagent-rpc-deadlines-");
  const fixture = path.join(tmp, "rpc.js");
  fs.writeFileSync(fixture, `
const scenario = process.argv[2];
let buffer = "";
const messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "completed" }] }];
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n"); if (end < 0) break;
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (request.type === "prompt") {
      const accept = () => emit({ type: "response", id: request.id, command: "prompt", success: true });
      const complete = () => emit({ type: "agent_end", messages });
      if (scenario === "slow-accept") {
        setTimeout(() => { accept(); setTimeout(complete, 300); }, 300);
      } else if (scenario === "no-accept") {
        emit({ type: "response", id: "unrelated", command: "prompt", success: true });
        emit({ type: "agent_start" });
        complete(); // Even a terminal transcript cannot replace prompt acceptance.
      } else if (scenario === "duplicate-accept") {
        accept();
        setTimeout(accept, 300);
        setTimeout(complete, 600); // A reset on the duplicate would wrongly allow success.
      } else if (scenario === "reject") {
        emit({ type: "response", id: request.id, command: "prompt", success: false, error: "rejected" });
      }
    } else if (request.type === "get_state") {
      emit({ type: "response", id: request.id, command: "get_state", success: true, data: { isStreaming: false } });
    } else if (request.type === "get_messages") {
      emit({ type: "response", id: request.id, command: "get_messages", success: true, data: { messages } });
    }
  }
});
`);
  const branches = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi/session-branches")) });
  const parent = branches.createBranch({ type: "verification", name: "deadline regression" });
  const service = new SubagentService({ cwd: tmp, branchManager: branches, runner: new SubagentRunner() });
  async function run(scenario, signal) {
    const sub = service.createSubagent({ parentSessionId: `deadline-${scenario}`, parentBranchId: parent.id, task: scenario, budget: { wallClockMs: 500, maxQueueWaitMs: 700 } });
    const result = await service.runSubagent({ subagentId: sub.id, context: { cwd: tmp, executionMode: "tool-rpc", signal, rpc: { command: process.execPath, argsPrefix: [fixture, scenario] } } });
    assert.equal(result.diagnostics.wallClockBudgetMs, 500);
    return result;
  }

  const slow = await run("slow-accept");
  assert.equal(slow.status, "succeeded", "startup/prompt delivery must not spend the accepted prompt's execution allowance");
  assert(slow.diagnostics.startupDurationMs >= 250);
  assert(slow.diagnostics.promptDurationMs >= 250);
  assert(slow.diagnostics.executionDurationMs > 500, "individually bounded startup and execution may exceed one phase budget together");

  const missing = await run("no-accept");
  assert.equal(missing.status, "timed_out");
  assert.equal(missing.termination.code, "rpc_startup", "unrelated responses/events cannot cancel the startup bound");
  assert.equal(missing.diagnostics.promptDurationMs, 0);
  assert(missing.diagnostics.errors.some(error => error.code === "SUBAGENT_RPC_STARTUP_TIMEOUT"));

  const execution = await run("duplicate-accept");
  assert.equal(execution.status, "timed_out");
  assert.equal(execution.termination.code, "wall_clock", "duplicate acceptance must not renew the execution deadline");
  assert(execution.diagnostics.promptDurationMs >= 450);

  const rejected = await run("reject");
  assert.equal(rejected.status, "failed");
  assert(rejected.diagnostics.errors.some(error => error.code === "SUBAGENT_RPC_PROMPT_REJECTED"));
  assert.equal(rejected.diagnostics.promptDurationMs, 0);

  const controller = new AbortController();
  const cancellation = run("no-accept", controller.signal);
  const abortTimer = setTimeout(() => controller.abort(), 50);
  let cancelled;
  try { cancelled = await cancellation; } finally { clearTimeout(abortTimer); }
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.diagnostics.promptDurationMs, 0);

  for (const result of [slow, missing, execution, rejected, cancelled]) {
    assert.equal(result.diagnostics.executionDurationMs, result.diagnostics.startupDurationMs + result.diagnostics.promptDurationMs);
    assert.equal(result.diagnostics.totalDurationMs, result.diagnostics.queueWaitMs + result.diagnostics.executionDurationMs);
  }
  fs.rmSync(tmp, { recursive: true });
  console.log("subagent RPC deadline regression tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
