"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { SubagentTaskService, baseline } = require("../src/subagent-tasks");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

const roles = DEFAULT_ROLE_CONTRACTS;
const coder = roles.find(role => role.roleId === "coder");
function graphFor(base) {
  return {
    schemaVersion: 2,
    graphId: "retention-fixture",
    concurrency: 1,
    context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R1"], sources: ["value.txt"], assumptions: [], conventions: [], testEntryPoints: ["value-check"], exclusions: [] },
    tasks: [{
      taskId: "produce", requirementIds: ["R1"], roleId: "coder", contractRevision: roleRevisionHash(coder), objective: "Set value.txt to 'correct'.", exclusions: [], taskKind: "implementation", dependsOn: [], readZones: [], writeZones: ["value.txt"], resources: [], ...base, contextPacketId: "context",
      acceptanceCriteria: [{ id: "value", kind: "executable", verifierId: "value-check", expected: "passed", required: true }],
    }],
  };
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
}

(async () => {
  const cwd = tmpFixture("pi-specialist-retention-");
  try {
    git(cwd, ["init", "-q"]);
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(cwd, "value.txt"), "base\n");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-qm", "fixture"]);
    const before = baseline(cwd);

    let producers = 0, reviews = 0;
    const runner = new SubagentRunner({ execute: async ({ record, context }) => {
      if (record.role === "coder") {
        producers++;
        fs.writeFileSync(path.join(context.cwd, "value.txt"), producers === 1 ? "wrong\n" : "correct\n");
      } else {
        reviews++;
        assert.equal(record.role, "patch-reviewer");
      }
      const submitted = createRoleResultEnvelope({
        contract: record.roleContract,
        subagentId: record.id,
        submission: {
          summary: "Bounded retention fixture candidate or independent review.",
          findings: [],
          evidence: [{ kind: "fixture", summary: "Inspected the isolated candidate." }],
          verification: { status: "passed", evidence: ["Fixture review; executable acceptance remains independent."] },
          ...(record.role === "coder" ? { proposedPatch: { changedPaths: ["value.txt"] } } : {}),
        },
      });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
    } });

    const storage = new MemoryJsonStorage();
    const subagents = new SubagentService({ cwd, runner });
    const topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture-roadmap" }), roadmapPlanReconciler: async () => ({ reconciled: true, outcome: "completed" }) } });
    // The first attempt reserves roughly 8 MiB of transient headroom. A second
    // attempt must be admitted after the first attempt's workspace is released.
    const tasks = new SubagentTaskService({
      cwd, storage, subagents, topologies,
      evidenceStore: new MemoryEvidenceStore(storage),
      verifiers: { "value-check": { run: ({ cwd: candidate }) => { const value = fs.readFileSync(path.join(candidate, "value.txt"), "utf8"); return { ok: value === "correct\n", exitCode: value === "correct\n" ? 0 : 1 }; } } },
      retentionBytes: 12 * 1024 * 1024,
    });

    const input = graphFor(before);
    assert.equal(tasks.preflight(input).allowed, true);
    const result = await tasks.run(input, { piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(result.status, "accepted-proposal", JSON.stringify(topologies.getRun(result.runId)?.errors));
    assert.equal(producers, 2, "the fixture must require a correction attempt");
    assert.equal(reviews, 2);
    assert.equal(result.tasks.tasks[0].attempts.length, 2);

    const entry = storage.readJson("specialist-task-index").find(run => run.runId === result.runId);
    assert(entry, "the run must remain in the retention index");
    const retainedStorage = entry.retainedStorageBytes ?? entry.reservedStorageBytes;
    const retainedEvidence = entry.retainedEvidenceBytes ?? entry.reservedEvidenceBytes;
    assert(retainedStorage >= 0 && retainedStorage < 2 * 1024 * 1024, `retained workspace accounting must reflect released headroom, got ${retainedStorage}`);
    assert(retainedEvidence > 0 && retainedEvidence < 4 * 1024 * 1024, `retained evidence accounting must be bounded, got ${retainedEvidence}`);
    assert.equal(storage.readJson("specialist-task-index").length, 1, "one retained run packet");
    assert.deepEqual(baseline(cwd), before, "retention accounting never mutates the parent");

    // A historical entry carries only the old accumulated reservation. Admission
    // must reconcile it from retained artifacts without rewriting that historical
    // value, and the new retained fields must take precedence.
    const legacyReservation = 510 * 1024 * 1024;
    const legacyIndex = storage.readJson("specialist-task-index").map(entry => ({ runId: entry.runId, graphDigest: entry.graphDigest, reservedStorageBytes: legacyReservation, reservedEvidenceBytes: 2 * 1024 * 1024, startedAt: entry.startedAt }));
    storage.writeJson("specialist-task-index", legacyIndex);
    const secondInput = graphFor(before);
    secondInput.graphId = "retention-fixture-2";
    assert.equal(tasks.preflight(secondInput).allowed, true);
    const second = await tasks.run(secondInput, { piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(second.status, "accepted-proposal", JSON.stringify(topologies.getRun(second.runId)?.errors));
    const reconciledLegacy = storage.readJson("specialist-task-index").find(entry => entry.runId === result.runId);
    assert.equal(reconciledLegacy.reservedStorageBytes, legacyReservation, "historical reservation bytes remain unchanged");
    assert(reconciledLegacy.retainedStorageBytes >= 0 && reconciledLegacy.retainedStorageBytes < 2 * 1024 * 1024, "reconciled accounting reflects retained artifacts");
    assert.equal(storage.readJson("specialist-task-index").length, 2, "the second run is admitted and retained");
    const metrics = tasks.metrics();
    assert(metrics.retainedStorageBytes >= 0 && metrics.retainedStorageBytes < 4 * 1024 * 1024, `metrics must report effective retained bytes, got ${metrics.retainedStorageBytes}`);
    assert.deepEqual(baseline(cwd), before, "reconciliation never mutates the parent");
    console.log("✓ specialist retention releases transient headroom, persists only retained artifacts, and reconciles legacy reservations without rewriting history");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
