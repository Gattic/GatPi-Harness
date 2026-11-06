"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { SubagentRunner, SubagentService } = require("../src/subagents");
const { SubagentTaskService, baseline } = require("../src/subagent-tasks");
const { SubagentTaskState } = require("../src/subagent-task-state");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { containmentProbe } = require("../src/specialist-tools");
const { processIdentity } = require("../src/resource-guard");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  if (!containmentProbe().available) { console.log("SKIP task recovery: containment unavailable"); return; }
  const cwd = tmpFixture("pi-task-recovery-");
  const controller = new AbortController();
  let childResult;
  try {
    const fixture = path.join(cwd, "rpc.js");
    fs.writeFileSync(fixture, `let buffer="";process.stdin.on("data",chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf("\\n"))>=0){const msg=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(["set_auto_retry","set_auto_compaction","prompt"].includes(msg.type))process.stdout.write(JSON.stringify({type:"response",id:msg.id,command:msg.type,success:true})+"\\n");}});`);
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(cwd, "value.txt"), "base\n");
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "fixture"]);
    const base = baseline(cwd), coder = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "coder");
    const graph = { schemaVersion: 2, graphId: "recovery", concurrency: 1, context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R2"], sources: ["value.txt"], assumptions: [], conventions: [], testEntryPoints: ["value-check"], exclusions: [] }, tasks: [{ taskId: "produce", requirementIds: ["R2"], roleId: "coder", contractRevision: roleRevisionHash(coder), objective: "Set value.txt to correct.", exclusions: [], taskKind: "implementation", dependsOn: [], readZones: ["value.txt"], writeZones: ["value.txt"], resources: [], ...base, contextPacketId: "context", acceptanceCriteria: [{ id: "value", kind: "executable", verifierId: "value-check", expected: "passed", required: true }] }] };
    let producers = 0;
    const runner = new SubagentRunner({ execute: async ({ record, context }) => {
      if (record.role === "coder") { producers++; fs.writeFileSync(path.join(context.cwd, "value.txt"), "correct\n"); }
      const submission = { summary: "Provider-free recovery proposal with independent evidence.", findings: [], evidence: [{ kind: "fixture", summary: "Checked the exact recovered candidate." }], verification: { status: "passed", evidence: ["Fixture review; executable acceptance is separate."] } };
      const result = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: result.summary, final_response: result.summary, submitted_result: result, termination: result.termination };
    } });
    const storage = new MemoryJsonStorage(), subagents = new SubagentService({ cwd, runner });
    const topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture-roadmap" }), roadmapPlanReconciler: async () => ({ reconciled: true }) } });
    const tasks = new SubagentTaskService({ cwd, storage, subagents, topologies, evidenceStore: new MemoryEvidenceStore(storage), verifiers: { "value-check": { run: ({ cwd: candidate }) => ({ ok: fs.readFileSync(path.join(candidate, "value.txt"), "utf8") === "correct\n", exitCode: 0 }) } } });
    const runId = "restart-fixture", bound = tasks.bindGraph(graph);
    const state = new SubagentTaskState({ storage, runId, graph: bound });
    const attemptId = state.start("produce").tasks.produce.attempts[0].id;
    storage.writeJson("specialist-task-index", [{ runId, graphDigest: bound.digest, reservedStorageBytes: 0, reservedEvidenceBytes: 2097152, startedAt: state.snapshot().startedAt }]);
    const role = structuredClone(coder); role.settings.taskPolicy = { readZones: ["value.txt"], writeZones: ["value.txt"] };
    let spawned;
    const ready = new Promise(resolve => { spawned = resolve; });
    childResult = new SubagentRunner().runInRpcSubprocess({ id: "recovery-owned-child", roleContract: role, toolPolicy: role.toolPolicy, budget: { wallClockMs: 10000 } }, "provider-free fixture", { cwd, thinkingLevel: "high", signal: controller.signal, rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true }, onProcessSpawn: identity => { state.process("produce", attemptId, identity); spawned(identity); } }).catch(error => error);
    const identity = await ready;
    await assert.rejects(() => tasks.run(graph, { runId, resume: true }), /PROCESSES_STILL_ACTIVE/);
    assert.equal(producers, 0); assert.equal(state.snapshot().tasks.produce.attempts.length, 1);
    controller.abort(); assert.equal((await childResult).code, "SUBAGENT_ABORTED");
    assert.equal(processIdentity(identity.processGroupId), null);
    // Simulate loss of the close journal entry, not a fictitious process exit.
    assert.equal(state.snapshot().processes[0].closed, false);
    const resumed = await tasks.run(graph, { runId, resume: true, piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(resumed.status, "accepted-proposal"); assert.equal(producers, 1);
    assert.equal(state.snapshot().processes[0].closed, true);
    assert.equal(resumed.tasks.tasks[0].attempts[0].reason, "restart-requires-process-reconciliation");
    assert.equal(resumed.tasks.tasks[0].attempts[1].previousAttemptId, attemptId);
    assert.equal(resumed.tasks.tasks[0].attempts.length, 2); assert.equal(resumed.tasks.actual.cost, null);
    assert.throws(() => state.settle("produce", attemptId, { status: "accepted-proposal", receipts: [] }), /TERMINAL_IMMUTABLE/);
    assert.deepEqual(baseline(cwd), base);
    console.log("✓ live orphan blocks resume; closed namespace reconciles once without duplicate accounting or late acceptance");
  } finally { controller.abort(); if (childResult) await childResult; fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
