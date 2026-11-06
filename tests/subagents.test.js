"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { SessionBranchManager, SnapshotStore } = require("../src/session-branches");
const { SubagentService, SubagentRunner, MERGE_POLICIES } = require("../src/subagents");
const { DEFAULT_DELEGATE_MODEL } = require("../src/role-contracts");
const { AgentRoleRegistry } = require("../src/multi-agent-topologies");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const originalSubagentFullSnapshots = process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS;
  const originalSubagentSnapshotMode = process.env.PI_SUBAGENT_BRANCH_SNAPSHOT_MODE;
  delete process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS;
  delete process.env.PI_SUBAGENT_BRANCH_SNAPSHOT_MODE;

  const tmp = tmpFixture("pi-subagents-");
  fs.writeFileSync(path.join(tmp, "README.md"), "base\n");
  const branchManager = new SessionBranchManager({ cwd: tmp, store: new SnapshotStore(path.join(tmp, ".pi/session-branches")) });
  const parent = branchManager.createBranch({ type: "verification", name: "parent", states: { contextState: { sessionId: "sess_1" } } });
  const capturedPrompts = [];
  const service = new SubagentService({ cwd: tmp, branchManager, config: { maxDepth: 2, maxConcurrentPerParent: 2, defaultWallClockMs: 1000 }, runner: new SubagentRunner({ execute: async ({ record, prompt }) => { capturedPrompts.push(prompt); return { summary: `summary ${record.role}`, final_response: `done ${record.task}`, artifacts: [{ kind: "note", text: "artifact" }], proposed_parent_updates: [{ type: "note", text: "proposal" }], tool_calls: 1 }; } }) });

  assert(MERGE_POLICIES.includes("summary_only"));
  const sub = service.createSubagent({ parentSessionId: "sess_1", parentTrajectoryId: parent.id, parentBranchId: parent.id, branchFrom: { branchId: parent.id, snapshotId: parent.headSnapshotId, messageId: "msg_1" }, role: "researcher", task: "inspect repo", budget: { maxSteps: 2 }, metadata: { source: "test", prompt: "PRIVATE_BRANCH_PROMPT_FIXTURE" }, mergePolicy: "none" });
  assert.equal(sub.status, "created");
  assert.equal(sub.parentSessionId, "sess_1");
  assert.equal(sub.parentBranchId, parent.id);
  assert.equal(sub.trajectoryId, sub.branchId);
  const childBranch = branchManager.requireBranch(sub.branchId);
  assert.equal(childBranch.type, "multi-agent");
  assert.equal(childBranch.parentBranchId, parent.id);
  assert.equal(childBranch.metadata.subagentId, sub.id);
  assert.equal(childBranch.metadata.branchFrom.messageId, "msg_1");
  assert.equal(childBranch.agents[0].agentId, sub.id);
  const childCreationSnapshot = branchManager.store.loadSnapshot(childBranch.headSnapshotId);
  assert.deepEqual(Object.keys(childCreationSnapshot.filesystemState.files), [], "subagent creation should use metadata-only branch snapshots by default");
  assert.equal(childCreationSnapshot.contextState.subagent.subagentId, sub.id);
  assert.equal(childCreationSnapshot.contextState.subagent.task, undefined, "subagent snapshots omit raw task text");
  assert.equal(typeof childCreationSnapshot.contextState.subagent.taskHash, "string");
  assert(!JSON.stringify(childBranch).includes("inspect repo"), "branch provenance stores a task hash rather than raw task text");
  assert(!JSON.stringify(childBranch).includes("PRIVATE_BRANCH_PROMPT_FIXTURE"), "branch provenance rejects arbitrary prompt metadata");
  const durableCreateRecord = fs.readFileSync(service.store.recordFile(sub.id), "utf8");
  assert(!durableCreateRecord.includes("inspect repo") && !durableCreateRecord.includes("PRIVATE_BRANCH_PROMPT_FIXTURE"), "durable subagent records store task/prompt hashes rather than task or prompt text");

  const result = await service.runSubagent({ subagentId: sub.id });
  assert.equal(result.status, "succeeded");
  assert.equal(result.subagent_id, sub.id);
  assert.equal(result.branch_id, sub.branchId);
  assert.equal(result.trajectory_id, sub.branchId);
  assert.equal(result.diagnostics.tool_calls, 1);
  assert.equal(service.getSubagent({ subagentId: sub.id }).result.final_response, "done inspect repo");
  assert.equal(service.getSubagent({ subagentId: sub.id }).result.task, undefined, "durable result envelopes omit raw delegated tasks");
  assert.equal(fs.statSync(service.store.recordFile(sub.id)).mode & 0o777, 0o600, "subagent records are private");
  assert.equal(fs.statSync(service.store.resultFile(sub.id)).mode & 0o777, 0o600, "subagent results are private");
  assert.equal(fs.statSync(service.store.recordsDir).mode & 0o777, 0o700, "subagent state directories are private");
  assert.match(capturedPrompts.at(-1), /Do not spawn additional subagents, call create_subagent, or invoke slash-command skills/, "subagent prompts should prevent recursive skill/subagent fanout");
  assert.equal(branchManager.requireBranch(sub.branchId).agents[0].active, false);
  const replay = branchManager.replay(sub.branchId);
  assert(replay.length >= 3, "subagent steps are normal branch checkpoints");
  assert(replay.every((step) => Object.keys(step.snapshot.filesystemState.files).length === 0), "subagent lifecycle checkpoints should remain metadata-only by default");
  const replayText = JSON.stringify(replay);
  assert(!replayText.includes("done inspect repo") && !replayText.includes('"final_response"'), "branch snapshots retain a bounded summary, not raw child output");
  assert(!replayText.includes('"task":"inspect repo"'), "branch snapshots do not retain raw task text");

  const noneMerge = service.mergeSubagentResult({ subagentId: sub.id, targetSessionId: "sess_1", mergePolicy: "none" });
  assert.equal(noneMerge.parentUpdate, null);
  const fullMerge = service.mergeSubagentResult({ subagentId: sub.id, targetSessionId: "sess_1", mergePolicy: "full_result" });
  assert.equal(fullMerge.parentUpdate.result.final_response, "done inspect repo", "the explicit parent update still returns the requested full result");
  const parentMergeSnapshot = branchManager.store.loadSnapshot(branchManager.requireBranch(parent.id).headSnapshotId);
  assert.equal(parentMergeSnapshot.contextState.subagentMerge.result.final_response, undefined, "durable branch snapshots compact full-result merges");
  assert.equal(parentMergeSnapshot.contextState.subagentMerge.result.status, "succeeded");
  const patchMerge = service.mergeSubagentResult({ subagentId: sub.id, targetSessionId: "sess_1", mergePolicy: "proposed_patch" });
  assert.equal(patchMerge.parentUpdate.artifacts.length, 1, "the explicit merge return preserves requested artifact details");
  const parentPatchSnapshot = branchManager.store.loadSnapshot(branchManager.requireBranch(parent.id).headSnapshotId);
  assert.equal(parentPatchSnapshot.contextState.subagentMerge.artifacts, undefined, "branch snapshots replace artifact bodies with metadata");
  assert.equal(parentPatchSnapshot.contextState.subagentMerge.proposed_parent_updates, undefined, "branch snapshots replace proposed update bodies with metadata");
  assert.equal(parentPatchSnapshot.contextState.subagentMerge.artifactCount, 1);

  const fanoutService = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 4 }, runner: new SubagentRunner({ execute: async ({ record }) => ({ summary: `fanout ${record.role}`, final_response: `fanout done ${record.task}` }) }) });
  const fanout = Array.from({ length: 4 }, (_, i) => fanoutService.createSubagent({ parentSessionId: "sess_fanout", parentBranchId: parent.id, role: `critic-${i}`, task: `critique dimension ${i}` }));
  assert.equal(fanout.length, 4, "critique-style 4-way fanout should fit the default concurrency envelope");
  await Promise.all(fanout.map((s) => fanoutService.runSubagent({ subagentId: s.id })));
  for (const s of fanout) assert(branchManager.replay(s.branchId).every((step) => Object.keys(step.snapshot.filesystemState.files).length === 0), "4-way fanout subagent branch checkpoints should not snapshot the repo by default");

  const sub2 = service.createSubagent({ parentSessionId: "sess_1", parentBranchId: parent.id, role: "summarizer", task: "summarize", mergePolicy: "summary_only" });
  await service.runSubagent({ subagentId: sub2.id });
  const mergedParent = branchManager.requireBranch(parent.id);
  assert(mergedParent.checkpoints.length > 1, "summary_only merge appends an explicit parent checkpoint");
  assert.equal(service.listSubagents({ parentSessionId: "sess_1" }).length, 2);

  const failService = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 10 }, runner: new SubagentRunner({ execute: async () => { throw new Error("boom"); } }) });
  const failing = failService.createSubagent({ parentSessionId: "sess_2", parentBranchId: parent.id, task: "fail isolated" });
  const failed = await failService.runSubagent({ subagentId: failing.id });
  assert.equal(failed.status, "failed");
  assert.equal(branchManager.requireBranch(parent.id).status, "active", "parent branch is not failed by child failure");

  const cancel = service.createSubagent({ parentSessionId: "sess_3", parentBranchId: parent.id, task: "cancel me" });
  await service.cancelSubagent({ subagentId: cancel.id, reason: "test cancel" });
  assert.equal(service.getSubagent({ subagentId: cancel.id }).status, "cancelled");
  assert.equal(service.getSubagent({ subagentId: cancel.id }).result.status, "cancelled");

  const oldFullSnapshots = process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS;
  try {
    process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS = "1";
    const fullSnapshotSub = service.createSubagent({ parentSessionId: "sess_fullsnap", parentBranchId: parent.id, task: "full snapshot opt-in" });
    const fullSnapshot = branchManager.store.loadSnapshot(branchManager.requireBranch(fullSnapshotSub.branchId).headSnapshotId);
    assert(Object.prototype.hasOwnProperty.call(fullSnapshot.filesystemState.files, "README.md"), "full subagent branch snapshots remain available by explicit opt-in");
    await service.cancelSubagent({ subagentId: fullSnapshotSub.id, reason: "test cleanup" });
  } finally {
    if (oldFullSnapshots === undefined) delete process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS; else process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS = oldFullSnapshots;
  }

  assert.throws(() => service.createSubagent({ parentSessionId: "sess_depth", parentSubagentId: sub.id, depth: 2, task: "nested delegation" }), /nested subagent delegation is disabled/);
  const limited = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 1 } });
  limited.createSubagent({ parentSessionId: "sess_limit", parentBranchId: parent.id, task: "one" });
  assert.throws(() => limited.createSubagent({ parentSessionId: "sess_limit", parentBranchId: parent.id, task: "two" }), /maximum concurrent/);

  const timeoutService = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 10 }, runner: new SubagentRunner({ execute: () => new Promise((resolve) => setTimeout(() => resolve({ final_response: "late" }), 50)) }) });
  const slow = timeoutService.createSubagent({ parentSessionId: "sess_timeout", parentBranchId: parent.id, task: "slow", budget: { wallClockMs: 5 } });
  const timed = await timeoutService.runSubagent({ subagentId: slow.id });
  assert.equal(timed.status, "timed_out");

  const invalidModeService = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 10 }, runner: new SubagentRunner() });
  const invalidModeSub = invalidModeService.createSubagent({ parentSessionId: "sess_invalid_mode", parentBranchId: parent.id, task: "obsolete execution mode" });
  await assert.rejects(() => invalidModeService.runSubagent({ subagentId: invalidModeSub.id, context: { executionMode: "pi-fork" } }), (error) => error.code === "SUBAGENT_EXECUTION_MODE_INVALID", "obsolete replacement-session execution fails before launch");

  const status = service.status({ parentSessionId: "sess_1" });
  assert.equal(status.total, 2);
  assert(status.byStatus.succeeded >= 2);
  assert(service.events({ limit: Infinity }).some((e) => e.type === "subagent.completed"));
  const exportFile = path.join(tmp, "subagents-export.json");
  const exported = service.exportSubagents({ parentSessionId: "sess_1", file: exportFile });
  assert.equal(exported.records.length, 2);
  assert(fs.existsSync(exportFile));
  const old = service.createSubagent({ parentSessionId: "sess_prune", parentBranchId: parent.id, task: "old final" });
  await service.cancelSubagent({ subagentId: old.id });
  const pruned = service.pruneSubagents({ parentSessionId: "sess_prune", keepRecent: 0 });
  assert.equal(pruned.pruned, 1);
  assert.equal(service.listSubagents({ parentSessionId: "sess_prune" }).length, 0);

  const fakeRpc = path.join(tmp, "fake-rpc.js");
  const fakeRpcArgv = path.join(tmp, "fake-rpc-argv.json");
  const fakeRpcEnv = path.join(tmp, "fake-rpc-env.json");
  fs.writeFileSync(fakeRpc, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(fakeRpcArgv)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(fakeRpcEnv)}, JSON.stringify({ PI_SUBAGENT_TOOL_RUNNER: process.env.PI_SUBAGENT_TOOL_RUNNER, PI_SUBAGENT_RPC_DEPTH: process.env.PI_SUBAGENT_RPC_DEPTH, PI_SUBAGENT_PARENT_ID: process.env.PI_SUBAGENT_PARENT_ID }));
let buffer = "";
const messages = [];
function emit(x) { process.stdout.write(JSON.stringify(x) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const raw = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.type === "prompt") {
      emit({ type: "response", id: msg.id, command: "prompt", success: true });
      messages.push({ role: "user", content: [{ type: "text", text: msg.message }], timestamp: Date.now() });
      messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "NOISY_TOOL_OUTPUT_SHOULD_NOT_LEAK" }], timestamp: Date.now() });
      messages.push({ role: "assistant", content: [{ type: "text", text: "rpc subagent final" }], usage: { input: 4, output: 5, totalTokens: 9, cost: { total: 0 } }, timestamp: Date.now() });
      emit({ type: "agent_end", messages });
    } else if (msg.type === "get_state") {
      emit({ type: "response", id: msg.id, command: "get_state", success: true, data: { sessionFile: "/tmp/fake-subagent-session.jsonl", isStreaming: false } });
    } else if (msg.type === "get_messages") {
      emit({ type: "response", id: msg.id, command: "get_messages", success: true, data: { messages } });
    }
  }
});
`);
  const rpcService = new SubagentService({ cwd: tmp, branchManager, config: { maxConcurrentPerParent: 10, defaultWallClockMs: 1000 }, runner: new SubagentRunner() });
  const rpcSub = rpcService.createSubagent({ parentSessionId: "sess_rpc", parentBranchId: parent.id, task: "run through rpc sidecar", toolPolicy: { allowedTools: ["read", "grep"] } });
  const rpcResult = await rpcService.runSubagent({ subagentId: rpcSub.id, context: { executionMode: "tool-rpc", cwd: tmp, model: { provider: "anthropic", id: "claude-test" }, thinkingLevel: "high", rpc: { command: process.execPath, argsPrefix: [fakeRpc] } } });
  assert.equal(rpcResult.status, "succeeded");
  assert.match(rpcResult.final_response, /rpc subagent final/);
  assert.doesNotMatch(rpcResult.final_response, /run through rpc sidecar|NOISY_TOOL_OUTPUT_SHOULD_NOT_LEAK/, "RPC subagent result should return final assistant findings, not the full tool transcript");
  assert.equal(rpcResult.diagnostics.model_calls, 1);
  assert.equal(rpcResult.diagnostics.modelCalls, 1);
  assert.equal(rpcResult.diagnostics.tool_calls, 0, "orphan tool results are not counted as tool executions");
  assert.equal(rpcResult.diagnostics.toolResults, 1);
  assert.equal(rpcResult.diagnostics.toolFailures, 0);
  assert.equal(rpcResult.diagnostics.unmatchedToolResultIds.length, 1);
  assert.equal(rpcResult.diagnostics.pi_session_file, "/tmp/fake-subagent-session.jsonl", "completed subagents should retain their Pi session file for chat focus switching");
  assert.equal(rpcResult.diagnostics.rpc_session_dir, path.join(tmp, ".pi", "subagents", "rpc-sessions", rpcSub.id));
  assert.equal(rpcResult.diagnostics.token_usage.totalTokens, 9);
  assert.equal(rpcResult.diagnostics.errors.length, 0);
  assert(rpcResult.diagnostics.queue_wait_ms >= 0, "uncontended queue timing is non-negative but may cross a millisecond boundary");
  assert(rpcResult.diagnostics.execution_duration_ms >= 0);
  assert.equal(rpcResult.diagnostics.totalDurationMs, rpcResult.diagnostics.queueWaitMs + rpcResult.diagnostics.executionDurationMs, "total duration is exactly queue wait plus child execution");
  assert.equal(rpcResult.diagnostics.wall_clock_budget_ms, 1000);
  assert.equal(fs.statSync(rpcResult.diagnostics.rpc_session_dir).mode & 0o777, 0o700, "RPC session directory is private after execution");
  const fakeRpcArgs = JSON.parse(fs.readFileSync(fakeRpcArgv, "utf8"));
  assert(fakeRpcArgs.includes("--mode") && fakeRpcArgs.includes("rpc"), "RPC sidecar starts Pi in rpc mode");
  assert(fakeRpcArgs.includes("--session-dir") && fakeRpcArgs.some((a) => String(a).includes(path.join(".pi", "subagents", "rpc-sessions", rpcSub.id))), "RPC sidecar uses per-subagent session dir");
  assert(fakeRpcArgs.includes("--no-extensions"), "RPC sidecars disable extension discovery by default to keep critique/research fanout lightweight and non-recursive");
  const explicitExtensions = args => args.flatMap((arg, i) => arg === "-e" ? [args[i + 1]] : []);
  const multiLoginExtension = path.resolve(__dirname, "../extensions/multi-login/index.ts");
  assert.deepEqual(explicitExtensions(fakeRpcArgs), [multiLoginExtension], "even roleless children load only approved provider registration");
  assert(fakeRpcArgs.includes("--model") && fakeRpcArgs.includes(DEFAULT_DELEGATE_MODEL), "RPC sidecar defaults to the canonical delegate model independently of the parent model");
  assert(fakeRpcArgs.includes("--thinking") && fakeRpcArgs.includes("high"), "RPC sidecar inherits current thinking level explicitly");
  assert(fakeRpcArgs.includes("--tools") && fakeRpcArgs.includes("read,grep"), "RPC sidecar honors subagent tool allowlist");
  assert(fakeRpcArgs.includes("--no-skills"), "RPC sidecars disable skill discovery by default to prevent recursive skill/subagent fanout");
  const policyArgs = rpcService.runner.rpcArgs({ id: "role-policy", role: "reviewer", systemPrompt: "Review without editing", modelPreference: "anthropic/role-model", toolPolicy: { allowedTools: ["read", "grep"], deniedTools: ["edit", "write"] } }, { cwd: tmp, model: { provider: "anthropic", id: "parent-model" } }).args;
  assert(policyArgs.includes("--append-system-prompt") && policyArgs.includes("Review without editing"), "role instructions are appended at the provider system-prompt level");
  assert(policyArgs.includes("anthropic/role-model"), "registered role model preference overrides the parent model");
  assert(policyArgs.includes("read,grep"), "registered role tools are enforced in the RPC CLI");
  const workerContract = new AgentRoleRegistry().get("worker");
  const oldWorkerModel = process.env.PI_ROLE_MODEL_WORKER;
  const oldWorkerThinking = process.env.PI_ROLE_THINKING_WORKER;
  process.env.PI_ROLE_MODEL_WORKER = DEFAULT_DELEGATE_MODEL;
  process.env.PI_ROLE_THINKING_WORKER = "low";
  let workerLaunch;
  try {
    workerLaunch = rpcService.runner.rpcArgs({ id: "role-worker", role: workerContract.roleId, roleContract: workerContract, systemPrompt: workerContract.systemPrompt, toolPolicy: workerContract.toolPolicy, budget: workerContract.budget }, { cwd: tmp, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "xhigh" });
  } finally {
    if (oldWorkerModel === undefined) delete process.env.PI_ROLE_MODEL_WORKER; else process.env.PI_ROLE_MODEL_WORKER = oldWorkerModel;
    if (oldWorkerThinking === undefined) delete process.env.PI_ROLE_THINKING_WORKER; else process.env.PI_ROLE_THINKING_WORKER = oldWorkerThinking;
  }
  assert(workerLaunch.args.includes("--model") && workerLaunch.args.includes(DEFAULT_DELEGATE_MODEL), "easy worker launches on the canonical delegate model even from a Sol parent");
  assert(workerLaunch.args.includes("--thinking") && workerLaunch.args.includes("low"), "easy worker launches at low thinking");
  assert.deepEqual(explicitExtensions(workerLaunch.args), [multiLoginExtension, path.resolve(__dirname, "../extensions/role-sidecar/index.ts")], "providers register before the isolated role, without ambient extensions");
  assert.equal(workerLaunch.env.PI_ROLE_EXPECTED_MODEL, DEFAULT_DELEGATE_MODEL);
  assert.equal(workerLaunch.env.PI_ROLE_EXPECTED_THINKING_LEVEL, "low");
  assert.equal(workerLaunch.provenance.selectedThinkingLevel, "low");
  assert.equal(workerLaunch.provenance.thinkingPolicySource, "environment");
  const fakeRpcEnvVars = JSON.parse(fs.readFileSync(fakeRpcEnv, "utf8"));
  assert.equal(fakeRpcEnvVars.PI_SUBAGENT_TOOL_RUNNER, undefined, "RPC sidecar does not expose a nested subagent fallback mode");
  assert.equal(fakeRpcEnvVars.PI_SUBAGENT_RPC_DEPTH, "1", "RPC sidecar increments nesting depth for recursive spawn guard");
  assert.equal(fakeRpcEnvVars.PI_SUBAGENT_PARENT_ID, rpcSub.id, "RPC sidecar receives parent subagent id");

  const oldRpcLoadExtensions = process.env.PI_SUBAGENT_RPC_LOAD_EXTENSIONS;
  process.env.PI_SUBAGENT_RPC_LOAD_EXTENSIONS = "1";
  const loadExtSub = rpcService.createSubagent({ parentSessionId: "sess_rpc_loadext", parentBranchId: parent.id, task: "run with extensions opt-in" });
  await rpcService.runSubagent({ subagentId: loadExtSub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc] } } });
  const loadExtArgs = JSON.parse(fs.readFileSync(fakeRpcArgv, "utf8"));
  if (oldRpcLoadExtensions === undefined) delete process.env.PI_SUBAGENT_RPC_LOAD_EXTENSIONS; else process.env.PI_SUBAGENT_RPC_LOAD_EXTENSIONS = oldRpcLoadExtensions;
  assert(loadExtArgs.includes("--no-extensions"), "legacy extension opt-ins cannot widen the canonical child surface");

  const noExtSub = rpcService.createSubagent({ parentSessionId: "sess_rpc_noext", parentBranchId: parent.id, task: "run without extensions" });
  await rpcService.runSubagent({ subagentId: noExtSub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc], noExtensions: true } } });
  const noExtArgs = JSON.parse(fs.readFileSync(fakeRpcArgv, "utf8"));
  assert(noExtArgs.includes("--no-extensions"), "RPC sidecar can still disable extension discovery explicitly");

  const oldRpcLoadSkills = process.env.PI_SUBAGENT_RPC_LOAD_SKILLS;
  process.env.PI_SUBAGENT_RPC_LOAD_SKILLS = "1";
  const loadSkillsSub = rpcService.createSubagent({ parentSessionId: "sess_rpc_loadskills", parentBranchId: parent.id, task: "run with skills opt-in" });
  await rpcService.runSubagent({ subagentId: loadSkillsSub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc] } } });
  const loadSkillsArgs = JSON.parse(fs.readFileSync(fakeRpcArgv, "utf8"));
  if (oldRpcLoadSkills === undefined) delete process.env.PI_SUBAGENT_RPC_LOAD_SKILLS; else process.env.PI_SUBAGENT_RPC_LOAD_SKILLS = oldRpcLoadSkills;
  assert(loadSkillsArgs.includes("--no-skills"), "legacy skill opt-ins cannot widen the canonical child surface");

  const oldRpcNoExt = process.env.PI_SUBAGENT_RPC_NO_EXTENSIONS;
  process.env.PI_SUBAGENT_RPC_NO_EXTENSIONS = "1";
  const envNoExtSub = rpcService.createSubagent({ parentSessionId: "sess_rpc_env_noext", parentBranchId: parent.id, task: "run without extensions from env" });
  await rpcService.runSubagent({ subagentId: envNoExtSub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc] } } });
  const envNoExtArgs = JSON.parse(fs.readFileSync(fakeRpcArgv, "utf8"));
  if (oldRpcNoExt === undefined) delete process.env.PI_SUBAGENT_RPC_NO_EXTENSIONS; else process.env.PI_SUBAGENT_RPC_NO_EXTENSIONS = oldRpcNoExt;
  assert(envNoExtArgs.includes("--no-extensions"), "RPC sidecars always disable ambient extension discovery");

  const oldRpcDepth = process.env.PI_SUBAGENT_RPC_DEPTH;
  process.env.PI_SUBAGENT_RPC_DEPTH = "1";
  const depthSub = rpcService.createSubagent({ parentSessionId: "sess_rpc_depth", parentBranchId: parent.id, task: "nested rpc should be blocked" });
  const depthResult = await rpcService.runSubagent({ subagentId: depthSub.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [fakeRpc] } } });
  if (oldRpcDepth === undefined) delete process.env.PI_SUBAGENT_RPC_DEPTH; else process.env.PI_SUBAGENT_RPC_DEPTH = oldRpcDepth;
  assert.equal(depthResult.status, "failed");
  assert.match(depthResult.final_response, /RPC nesting limit exceeded/);

  const throttledRpc = path.join(tmp, "throttled-rpc.js");
  const throttledStarts = path.join(tmp, "throttled-starts.txt");
  fs.writeFileSync(throttledRpc, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(throttledStarts)}, String(Date.now()) + "\\n");
let buffer = "";
const messages = [];
function emit(x) { process.stdout.write(JSON.stringify(x) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const raw = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.type === "prompt") {
      emit({ type: "response", id: msg.id, command: "prompt", success: true });
      messages.push({ role: "user", content: [{ type: "text", text: msg.message }], timestamp: Date.now() });
      messages.push({ role: "assistant", content: [{ type: "text", text: "throttled rpc final" }], timestamp: Date.now() });
      setTimeout(() => emit({ type: "agent_end", messages }), 80);
    } else if (msg.type === "get_state") {
      emit({ type: "response", id: msg.id, command: "get_state", success: true, data: { sessionFile: "/tmp/throttled-rpc-session.jsonl", isStreaming: false } });
    } else if (msg.type === "get_messages") {
      emit({ type: "response", id: msg.id, command: "get_messages", success: true, data: { messages } });
    }
  }
});
`);
  const defaultConcurrencyRpc = path.join(tmp, "default-concurrency-rpc.js");
  const defaultConcurrencyStarts = path.join(tmp, "default-concurrency-starts.txt");
  const defaultConcurrencyRelease = path.join(tmp, "default-concurrency-release");
  fs.writeFileSync(defaultConcurrencyRpc, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(defaultConcurrencyStarts)}, String(process.pid) + "\\n");
let buffer = "";
const messages = [];
function emit(x) { process.stdout.write(JSON.stringify(x) + "\\n"); }
function finishWhenReleased() {
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(defaultConcurrencyRelease)})) return;
    clearInterval(timer);
    emit({ type: "agent_end", messages });
  }, 10);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const raw = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.type === "prompt") {
      emit({ type: "response", id: msg.id, command: "prompt", success: true });
      messages.push({ role: "assistant", content: [{ type: "text", text: "default concurrency rpc final" }], timestamp: Date.now() });
      finishWhenReleased();
    } else if (msg.type === "get_state") {
      emit({ type: "response", id: msg.id, command: "get_state", success: true, data: { sessionFile: "/tmp/default-concurrency-rpc-session.jsonl", isStreaming: false } });
    } else if (msg.type === "get_messages") {
      emit({ type: "response", id: msg.id, command: "get_messages", success: true, data: { messages } });
    }
  }
});
`);
  const oldDefaultRpcConcurrency = process.env.PI_SUBAGENT_RPC_CONCURRENCY;
  delete process.env.PI_SUBAGENT_RPC_CONCURRENCY;
  const defaultConcurrencySubs = Array.from({ length: 4 }, (_, i) => rpcService.createSubagent({ parentSessionId: "sess_rpc_default_concurrency", parentBranchId: parent.id, task: `default concurrency ${i}` }));
  const defaultConcurrencyRuns = Promise.all(defaultConcurrencySubs.map((s) => rpcService.runSubagent({ subagentId: s.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [defaultConcurrencyRpc], timeoutMs: 2000 } } })));
  await delay(300);
  const defaultStarts = fs.existsSync(defaultConcurrencyStarts) ? fs.readFileSync(defaultConcurrencyStarts, "utf8").trim().split(/\n+/).filter(Boolean) : [];
  fs.writeFileSync(defaultConcurrencyRelease, "1");
  await defaultConcurrencyRuns;
  if (oldDefaultRpcConcurrency === undefined) delete process.env.PI_SUBAGENT_RPC_CONCURRENCY; else process.env.PI_SUBAGENT_RPC_CONCURRENCY = oldDefaultRpcConcurrency;
  assert.equal(defaultStarts.length, 2, "default RPC sidecar concurrency should bound fanout to two simultaneous sidecars");

  const oldRpcConcurrency = process.env.PI_SUBAGENT_RPC_CONCURRENCY;
  process.env.PI_SUBAGENT_RPC_CONCURRENCY = "1";
  const throttleA = rpcService.createSubagent({ parentSessionId: "sess_rpc_throttle", parentBranchId: parent.id, task: "throttle a" });
  const throttleB = rpcService.createSubagent({ parentSessionId: "sess_rpc_throttle", parentBranchId: parent.id, task: "throttle b" });
  const throttledResults = await Promise.all([
    rpcService.runSubagent({ subagentId: throttleA.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [throttledRpc], timeoutMs: 1000 } } }),
    rpcService.runSubagent({ subagentId: throttleB.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [throttledRpc], timeoutMs: 1000 } } }),
  ]);
  if (oldRpcConcurrency === undefined) delete process.env.PI_SUBAGENT_RPC_CONCURRENCY; else process.env.PI_SUBAGENT_RPC_CONCURRENCY = oldRpcConcurrency;
  const starts = fs.readFileSync(throttledStarts, "utf8").trim().split(/\n+/).map(Number);
  assert.equal(starts.length, 2, "both throttled RPC sidecars should have started");
  assert(starts[1] - starts[0] >= 50, "RPC sidecar concurrency limit should serialize starts when set to 1");
  const immediateQueueWaitMs = throttledResults[0].diagnostics.queue_wait_ms;
  const serializedQueueWaitMs = throttledResults[1].diagnostics.queue_wait_ms;
  assert.equal(throttledResults[0].diagnostics.queueWaitMs, immediateQueueWaitMs, "queue-wait diagnostic aliases agree for the immediate sidecar");
  assert.equal(throttledResults[1].diagnostics.queueWaitMs, serializedQueueWaitMs, "queue-wait diagnostic aliases agree for the serialized sidecar");
  assert(Number.isFinite(immediateQueueWaitMs) && immediateQueueWaitMs >= 0, "the immediate sidecar reports a valid non-negative queue wait");
  assert(serializedQueueWaitMs >= 50, "the serialized sidecar reports the enforced queue delay");
  assert(serializedQueueWaitMs - immediateQueueWaitMs >= 40, "queued RPC diagnostics distinguish serialization delay from immediate acquisition overhead");

  const rejectingRpc = path.join(tmp, "rejecting-rpc.js");
  fs.writeFileSync(rejectingRpc, `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const idx = buffer.indexOf("\\n");
  if (idx < 0) return;
  const msg = JSON.parse(buffer.slice(0, idx));
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: "prompt", success: false, error: "rejected prompt" }) + "\\n");
});
`);
  const rejected = rpcService.createSubagent({ parentSessionId: "sess_rpc_fail", parentBranchId: parent.id, task: "reject rpc" });
  const rejectedResult = await rpcService.runSubagent({ subagentId: rejected.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [rejectingRpc], noExtensions: true, timeoutMs: 1000 } } });
  assert.equal(rejectedResult.status, "failed");
  assert.match(rejectedResult.final_response, /rejected prompt/);

  const stubbornRpc = path.join(tmp, "stubborn-rpc.js");
  const stubbornPidFile = path.join(tmp, "stubborn-rpc.pid");
  fs.writeFileSync(stubbornRpc, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(stubbornPidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const stubborn = rpcService.createSubagent({ parentSessionId: "sess_rpc_stubborn", parentBranchId: parent.id, task: "stubborn rpc" });
  const stubbornResult = await rpcService.runSubagent({ subagentId: stubborn.id, context: { executionMode: "tool-rpc", cwd: tmp, rpc: { command: process.execPath, argsPrefix: [stubbornRpc], noExtensions: true, timeoutMs: 200 } } });
  assert.equal(stubbornResult.status, "timed_out");
  assert.equal(stubbornResult.diagnostics.wall_clock_budget_ms, 200);
  assert(stubbornResult.diagnostics.execution_duration_ms >= 190);
  assert.equal(stubbornResult.diagnostics.rpc_session_dir, path.join(tmp, ".pi", "subagents", "rpc-sessions", stubborn.id), "timed-out runs retain the child session directory for recovery");
  const stubbornPid = Number(fs.readFileSync(stubbornPidFile, "utf8"));
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await delay(1500);
    assert.equal(isAlive(stubbornPid), false, "timed-out RPC sidecar should be SIGKILLed if it ignores SIGTERM");
  } finally {
    try { process.kill(stubbornPid, "SIGKILL"); } catch {}
  }

  if (process.platform !== "win32") {
    const outsideState = path.join(tmp, "outside-subagent-state.json");
    fs.writeFileSync(outsideState, "unchanged", { mode: 0o644 });
    fs.chmodSync(outsideState, 0o644); // Pin the asserted baseline independently of the process umask.
    const linkedRecord = service.store.recordFile("sub_symlink_state");
    fs.mkdirSync(path.dirname(linkedRecord), { recursive: true });
    fs.symlinkSync(outsideState, linkedRecord);
    assert.throws(() => service.store.save({ id: "sub_symlink_state", status: "succeeded" }), /unsafe|real file|symbolic/i, "subagent state writes refuse symlink destinations");
    assert.equal(fs.readFileSync(outsideState, "utf8"), "unchanged");
    assert.equal(fs.statSync(outsideState).mode & 0o777, 0o644, "subagent state refusal never chmods a symlink target");
  }

  if (originalSubagentFullSnapshots === undefined) delete process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS; else process.env.PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS = originalSubagentFullSnapshots;
  if (originalSubagentSnapshotMode === undefined) delete process.env.PI_SUBAGENT_BRANCH_SNAPSHOT_MODE; else process.env.PI_SUBAGENT_BRANCH_SNAPSHOT_MODE = originalSubagentSnapshotMode;

  console.log("subagents tests passed");
})();
