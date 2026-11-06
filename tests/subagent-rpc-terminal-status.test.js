"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionBranchManager, SnapshotStore } = require("../src/session-branches");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { validateRpcCompletion } = require("../src/subagent-result-validator");
const { tmpFixture } = require("./helpers/tmp-fixture");

function assistant(stopReason, text = "", extra = {}) {
  return { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, timestamp: Date.now(), ...extra };
}

for (const [stopReason, code] of [["error", "provider_error"], ["aborted", "aborted"], ["length", "output_limit"]]) {
  const checked = validateRpcCompletion({ agentEnd: { type: "agent_end" }, messages: [assistant(stopReason)] });
  assert.equal(checked.ok, false);
  assert.equal(checked.termination.code, code);
}
assert.equal(validateRpcCompletion({ agentEnd: {}, messages: [assistant("stop")] }).termination.code, "empty_result");
assert.equal(validateRpcCompletion({ agentEnd: {}, messages: [assistant("stop", "complete")] }).ok, true);
assert.equal(validateRpcCompletion({ agentEnd: {}, messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "submit-1", name: "submit_role_result", arguments: {} }] }, { role: "toolResult", toolCallId: "submit-1", toolName: "submit_role_result", isError: false, content: [{ type: "text", text: JSON.stringify({ summary: "typed result" }) }] }] }).ok, true, "a valid terminating structured result with exact call/result accounting is accepted");

(async () => {
  const tmp = tmpFixture("pi-subagent-terminal-");
  fs.writeFileSync(path.join(tmp, "README.md"), "fixture\n");
  const branchManager = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi", "session-branches")) });
  const parent = branchManager.createBranch({ type: "verification", name: "parent" });
  const fakeRpc = path.join(tmp, "terminal-rpc.js");
  fs.writeFileSync(fakeRpc, `
const scenario = process.argv[2];
let buffer = "";
let continued = false;
let messages = [];
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function assistant(stopReason, text = "") { return { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, timestamp: Date.now() }; }
function finish() {
  if (scenario === "error") messages = [assistant("error")];
  else if (scenario === "aborted") messages = [assistant("aborted")];
  else if (scenario === "length" || scenario === "length-cont") messages = [assistant("length", "partial")];
  else if (scenario === "empty") messages = [assistant("stop")];
  else if (scenario === "structured") messages = [{ role: "assistant", content: [{ type: "toolCall", id: "submit-1", name: "submit_role_result", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() }, { role: "toolResult", toolCallId: "submit-1", toolName: "submit_role_result", isError: false, content: [{ type: "text", text: JSON.stringify({ summary: "typed result" }) }], timestamp: Date.now() }];
  else messages = [assistant("stop", "valid final")];
  emit({ type: "agent_end", messages, willRetry: false });
  if (scenario === "duplicate") setTimeout(() => emit({ type: "agent_end", messages, willRetry: false }), 5);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const raw = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.type === "prompt") {
      emit({ type: "response", id: message.id, command: "prompt", success: true });
      if (scenario === "load-failure") { emit({ type: "extension_error", extensionPath: "/synthetic/role-sidecar.ts", event: "load", error: "synthetic action method during extension loading" }); setTimeout(() => process.exit(17), 5); }
      else if (scenario !== "hang") finish();
    }
    else if (message.type === "follow_up") {
      emit({ type: "response", id: message.id, command: "follow_up", success: true });
      if (scenario === "length-cont" && !continued) { continued = true; messages.push(assistant("stop", "continued final")); emit({ type: "agent_end", messages, willRetry: false }); }
    } else if (message.type === "get_state") {
      emit({ type: "response", id: message.id, command: "get_state", success: scenario !== "malformed-state", data: scenario === "malformed-state" ? undefined : { sessionFile: "/tmp/synthetic-terminal-session.jsonl", isStreaming: false }, error: scenario === "malformed-state" ? "state unavailable" : undefined });
    } else if (message.type === "get_messages") emit({ type: "response", id: message.id, command: "get_messages", success: true, data: { messages } });
    else if (message.type === "abort") emit({ type: "response", command: "abort", success: true });
  }
});
`);

  const service = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 30, defaultWallClockMs: 1500 }, runner: new SubagentRunner() });
  async function run(scenario, budget = {}, options = {}) {
    const sub = service.createSubagent({ parentSessionId: `session-${scenario}-${Date.now()}`, parentBranchId: parent.id, task: scenario, budget });
    return service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", cwd: tmp, signal: options.signal, rpc: { command: process.execPath, argsPrefix: [fakeRpc, scenario], timeoutMs: options.timeoutMs || 1500 } } });
  }

  for (const [scenario, code] of [["error", "provider_error"], ["aborted", "aborted"], ["length", "output_limit"], ["empty", "empty_result"], ["malformed-state", "rpc_protocol"], ["load-failure", "extension_load"]]) {
    const result = await run(scenario);
    assert.equal(result.status, scenario === "aborted" ? "cancelled" : "failed", `${scenario} must not succeed`);
    assert.equal(result.termination.code, code);
    assert.equal(service.store.getResult(result.subagent_id).termination.code, code, "the persisted envelope keeps the canonical termination code");
  }
  async function runExecutionTimeout() {
    const timeoutMs = 40;
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const realNow = Date.now;
    let now = realNow();
    const deadlines = [];
    let executionReady;
    const executionArmed = new Promise((resolve) => { executionReady = resolve; });
    const controller = new AbortController();
    const restoreClock = () => {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      Date.now = realNow;
    };
    const watchdog = realSetTimeout(() => { restoreClock(); controller.abort(); }, 5000);
    let running;
    try {
      // Hold virtual time during real child startup. The matching prompt ACK
      // must clear the first deadline and arm the execution deadline.
      Date.now = () => now;
      global.setTimeout = (callback, delay, ...args) => {
        if (delay !== timeoutMs) return realSetTimeout(callback, delay, ...args);
        const timer = { cleared: false, expire: () => callback(...args), unref() {} };
        deadlines.push(timer);
        if (deadlines.length === 2) executionReady(timer);
        return timer;
      };
      global.clearTimeout = (timer) => {
        if (deadlines.includes(timer)) timer.cleared = true;
        else realClearTimeout(timer);
      };
      running = run("hang", {}, { timeoutMs, signal: controller.signal }).finally(() => realClearTimeout(watchdog));
      const deadline = await Promise.race([
        executionArmed,
        running.then((result) => { throw new Error(`fixture settled before execution deadline was armed: ${result.status}`); }),
      ]);
      assert.equal(deadlines.length, 2);
      assert.equal(deadlines[0].cleared, true, "prompt acceptance clears the startup deadline");
      assert.equal(deadline.cleared, false);
      now += timeoutMs;
      deadline.expire();
      return running;
    } finally {
      // Process-group teardown must use real clocks/timers, even on failure.
      restoreClock();
      controller.abort();
      if (!running) realClearTimeout(watchdog);
    }
  }
  const timedOut = await runExecutionTimeout();
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.termination.code, "wall_clock");
  assert.equal(timedOut.diagnostics.wallClockBudgetMs, 40);
  assert.equal(timedOut.diagnostics.startupDurationMs, 0);
  assert.equal(timedOut.diagnostics.promptDurationMs, 40);
  assert.equal(service.store.getResult(timedOut.subagent_id).termination.code, "wall_clock");
  const controller = new AbortController();
  const cancelling = run("hang", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const cancelled = await cancelling;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.termination.code, "cancelled");

  const continued = await run("length-cont", { maxLengthContinuations: 1, maxModelCalls: 2 });
  assert.equal(continued.status, "succeeded");
  assert.match(continued.final_response, /continued final/);
  assert.equal(continued.diagnostics.modelCalls, 2);
  const valid = await run("valid");
  assert.equal(valid.status, "succeeded");
  assert.equal(valid.termination.stopReason, "stop");
  const structured = await run("structured");
  assert.equal(structured.status, "succeeded");
  assert.equal(structured.termination.code, "submitted");
  const duplicate = await run("duplicate");
  assert.equal(duplicate.status, "succeeded");
  assert.equal(service.store.getResult(duplicate.subagent_id).status, "succeeded", "late duplicate terminal events cannot replace the persisted result");

  console.log("subagent RPC terminal status tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
