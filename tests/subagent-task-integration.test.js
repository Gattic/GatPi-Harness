"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { SubagentTaskService, baseline } = require("../src/subagent-tasks");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { validateTaskGraph } = require("../src/subagent-task-contracts");
const { SubagentWorkspaceManager } = require("../src/subagent-workspaces");
const { createRoadmap, saveRoadmap, loadRoadmap } = require("../.pi/extensions/roadmap/roadmap-state");
const { tmpFixture } = require("./helpers/tmp-fixture");
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim(); }
(async () => {
  const cwd = tmpFixture("pi-task-integration-");
  try {
    git(cwd, ["init", "-q"]); fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(cwd, "README.md"), "Fixture\n"); git(cwd, ["add", "."]); git(cwd, ["commit", "-qm", "fixture"]);
    const base = baseline(cwd), events = [];
    const parentRoadmap = saveRoadmap(cwd, createRoadmap("Parent application outcome", ["Integrate and apply the accepted proposal"]));
    let releaseBranches, activeBranches = 0, peakBranches = 0;
    const bothStarted = new Promise(resolve => { releaseBranches = resolve; });
    const criterion = name => ({ id: `${name}-check`, kind: "executable", verifierId: `${name}-check`, expected: "passed", required: true });
    const makeTask = name => ({ taskId: name, roleId: "coder", contractRevision: roleRevisionHash(DEFAULT_ROLE_CONTRACTS.find(r => r.roleId === "coder")), requirementIds: [name], taskKind: "implementation", objective: `Produce ${name}.txt in the isolated candidate.`, exclusions: [], dependsOn: [], readZones: ["README.md", `${name}.txt`], writeZones: [`${name}.txt`], resources: [], ...base, contextPacketId: "shared-context", acceptanceCriteria: [criterion(name)] });
    const left = makeTask("left"), right = makeTask("right"), joined = { ...makeTask("joined"), roleId: "integrator", contractRevision: roleRevisionHash(DEFAULT_ROLE_CONTRACTS.find(r => r.roleId === "integrator")), taskKind: "integration", readZones: ["README.md", "left.txt", "right.txt", "joined.txt"], dependsOn: ["left", "right"].map(taskId => ({ taskId, requiredArtifactKind: "patch", readinessCondition: "accepted-proposal" })), acceptanceCriteria: [criterion("left"), criterion("right"), criterion("joined")] };
    const graph = { schemaVersion: 2, graphId: "parallel", concurrency: 2, tasks: [left, right, joined], context: { id: "shared-context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["left", "right", "joined"], sources: ["README.md"], assumptions: [], conventions: [], testEntryPoints: ["left-check", "right-check", "joined-check"], exclusions: [] } };
    validateTaskGraph(graph, DEFAULT_ROLE_CONTRACTS);
    const uncovered = structuredClone(graph); uncovered.tasks[2].acceptanceCriteria = [criterion("joined")];
    assert.throws(() => validateTaskGraph(uncovered, DEFAULT_ROLE_CONTRACTS), /FINAL_COVERAGE_INCOMPLETE/);
    const runner = new SubagentRunner({ execute: async ({ record, context }) => {
      const id = record.metadata.nodeId;
      events.push(id);
      if (["coder", "integrator"].includes(record.role)) {
        if (["left", "right"].includes(id)) {
          activeBranches++; peakBranches = Math.max(peakBranches, activeBranches);
          if (activeBranches === 2) releaseBranches();
          let timeout;
          try { await Promise.race([bothStarted, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("independent branches did not overlap")), 5000); })]); }
          finally { clearTimeout(timeout); activeBranches--; }
        }
        if (id === "joined") {
          assert.equal(fs.readFileSync(path.join(context.cwd, "left.txt"), "utf8"), "left\n");
          assert.equal(fs.readFileSync(path.join(context.cwd, "right.txt"), "utf8"), "right\n");
          assert(events.includes("left-review") && events.includes("right-review"), "integration waits for both accepted producer artifacts");
        }
        fs.writeFileSync(path.join(context.cwd, `${id}.txt`), `${id}\n`);
      }
      const submission = { summary: "An isolated fixture proposal or an independent read-only candidate review.", findings: [], evidence: [{ summary: "Checked the exact isolated candidate." }], verification: { status: "passed", evidence: ["Review is advisory; executable checks are separate."] }, ...(["coder", "integrator"].includes(record.role) ? { proposedPatch: { changedPaths: [`${id}.txt`] } } : {}) };
      const submitted = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
    } });
    const subagents = new SubagentService({ cwd, runner }), storage = new MemoryJsonStorage();
    const topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd } });
    const verifiers = Object.fromEntries(["left", "right", "joined"].map(name => [`${name}-check`, { run: ({ cwd: root }) => ({ ok: fs.readFileSync(path.join(root, `${name}.txt`), "utf8") === `${name}\n`, exitCode: 0 }) }]));
    const service = new SubagentTaskService({ cwd, storage, subagents, topologies, verifiers, evidenceStore: new MemoryEvidenceStore(storage) });
    const result = await service.run(graph, { piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(result.status, "accepted-proposal", JSON.stringify(topologies.getRun(result.runId)?.errors));
    assert.equal(result.tasks.tasks.length, 3); assert(result.tasks.tasks.every(task => task.state === "accepted-proposal"));
    assert.equal(peakBranches, 2, "both independent producers run concurrently under the graph cap");
    const proposalRoadmap = loadRoadmap(cwd);
    assert.equal(proposalRoadmap.id, parentRoadmap.id);
    assert.equal(proposalRoadmap.items[0].status, parentRoadmap.items[0].status, "proposal acceptance never completes the parent application outcome");
    assert.match(proposalRoadmap.items[0].subtasks[0].title, /^Accepted artifact proposals/);
    assert(proposalRoadmap.items[0].subtasks[0].items.every(item => item.status === "done"));
    assert.deepEqual(baseline(cwd), base);
    const state = storage.readJson(`specialist-tasks/${result.runId}`);
    const captures = ["left", "right", "joined"].map(id => { const sub = subagents.getSubagent({ subagentId: state.tasks[id].artifact.producerSubagentId }); return subagents.workspaceManager.readCapture(sub.workspace.path); });
    assert.equal(captures[2].includedPatchHashes.length, 2);
    const manager = new SubagentWorkspaceManager({ cwd });
    const stacked = manager.acquire({ subagentId: "stacked-seeds", parentSessionId: "stacked", task: "Do not apply covered ancestors twice", seedPatches: captures });
    assert.equal(fs.readFileSync(path.join(stacked.cwd, "joined.txt"), "utf8"), "joined\n"); manager.release(stacked, { remove: true });
    const applied = await service.apply({ runId: result.runId, graph, taskId: "joined", artifactDigest: state.tasks.joined.artifact.digest, explicit: true });
    assert.equal(applied.state, "accepted-applied");
    for (const name of ["left", "right", "joined"]) assert.equal(fs.readFileSync(path.join(cwd, `${name}.txt`), "utf8"), `${name}\n`);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  console.log("parallel task integration, complete final coverage, stacked ancestry and explicit apply tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
