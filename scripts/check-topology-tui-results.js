"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROADMAP_PLAN_SCHEMA, validateJsonSchema } = require("../src/role-result-schemas");
const { planFingerprint } = require("../src/roadmap-plan-application");

const REQUIRED_GRAPHS = {
  "project-planner-coder-verifier": { plan: "planner", code: "coder", verify: "verifier" },
  "project-subagent-smoke": { worker: "researcher" },
};

function validateTopologyTuiRuns(runs) {
  // The caller supplies a new, isolated storage directory. No prior successful
  // run, fallback, or unrelated graph may satisfy this invocation's gate.
  assert.equal(runs.length, 2, "expected exactly two fresh topology runs");
  const summaries = [];
  for (const [topologyId, nodes] of Object.entries(REQUIRED_GRAPHS)) {
    const matches = runs.filter((run) => run.topologyId === topologyId);
    assert.equal(matches.length, 1, `${topologyId}: expected exactly one run`);
    const run = matches[0];
    assert.equal(run.status, "succeeded", `${topologyId}: run did not succeed`);
    assert.deepEqual(run.errors, [], `${topologyId}: run contains errors`);
    assert.equal(run.fallbackOf, undefined, `${topologyId}: fallback is not primary success`);
    assert.equal(run.results?.length, Object.keys(nodes).length, `${topologyId}: missing/extra node results`);
    assert.equal(run.nodeStates?.length, Object.keys(nodes).length, `${topologyId}: missing/extra node states`);
    for (const [nodeId, role] of Object.entries(nodes)) {
      const results = run.results.filter((result) => result.nodeId === nodeId);
      const states = run.nodeStates.filter((state) => state.nodeId === nodeId);
      assert.equal(results.length, 1, `${topologyId}/${nodeId}: missing/duplicate result`);
      assert.equal(states.length, 1, `${topologyId}/${nodeId}: missing/duplicate state`);
      assert.equal(results[0].role, role, `${topologyId}/${nodeId}: unexpected role`);
      assert.equal(states[0].roleId, role, `${topologyId}/${nodeId}: unexpected state role`);
      assert.equal(results[0].status, "succeeded", `${topologyId}/${nodeId}: result did not succeed`);
      assert.equal(states[0].status, "succeeded", `${topologyId}/${nodeId}: node did not execute successfully`);
    }
    if (nodes.plan) {
      const plan = run.results.find((result) => result.nodeId === "plan").payload?.roadmapPlan;
      assert.deepEqual(validateJsonSchema(ROADMAP_PLAN_SCHEMA, plan), [], `${topologyId}: missing/invalid roadmapPlan`);
      assert.equal(run.roadmapApplications?.length, 1, `${topologyId}: missing roadmap application`);
      const application = run.roadmapApplications[0];
      assert.equal(application.applied, true, `${topologyId}: roadmap not applied`);
      assert.equal(application.plannerNodeId, "plan");
      assert.equal(application.beforeNodeId, "code");
      assert.equal(application.planFingerprint, planFingerprint(plan), `${topologyId}: applied a different plan`);
      assert.ok(application.roadmapId, `${topologyId}: missing applied roadmap identity`);
      assert.equal(run.roadmapReconciliations?.length, 1, `${topologyId}: missing roadmap reconciliation`);
      const reconciliation = run.roadmapReconciliations[0];
      assert.equal(reconciliation.plannerNodeId, "plan");
      assert.equal(reconciliation.roadmapId, application.roadmapId);
      assert.equal(reconciliation.reconciled, true);
      assert.equal(reconciliation.reconciliationStatus, "succeeded");
      assert.equal(reconciliation.topologyStatus, "succeeded");
      assert.ok(["completed", "already-completed"].includes(reconciliation.outcome), `${topologyId}: roadmap not completed`);
      const verification = run.results.find((result) => result.nodeId === "verify").payload?.verification;
      assert.equal(verification?.status, "passed", `${topologyId}: verifier verdict not passed`);
      assert.ok(Array.isArray(verification.evidence) && verification.evidence.length > 0, `${topologyId}: verifier evidence missing`);
    }
    summaries.push({ runId: run.runId, topologyId, status: run.status, nodes: Object.keys(nodes) });
  }
  return summaries;
}

if (require.main === module) {
  try {
    const [directory, evidenceFile] = process.argv.slice(2);
    assert.ok(directory && evidenceFile, "usage: node check-topology-tui-results.js <fresh-runs-directory> <evidence-file>");
    const runs = fs.readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
    // Preserve the bounded, fixture-only packets even when semantic validation fails.
    fs.writeFileSync(evidenceFile, `${JSON.stringify(runs, null, 2)}\n`, { mode: 0o600 });
    const summaries = validateTopologyTuiRuns(runs);
    console.log(JSON.stringify({ outcome: "passed", runs: summaries, evidenceFile }));
  } catch (error) {
    console.error(`topology TUI semantic acceptance failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateTopologyTuiRuns };
