"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateTopologyTuiRuns } = require("../scripts/check-topology-tui-results");
const { planFingerprint } = require("../src/roadmap-plan-application");
const { tmpFixture } = require("./helpers/tmp-fixture");

const plan = { title: "Fixture plan", milestones: [{ title: "Implementation", goals: ["Verify fixture"] }] };
function packet(topologyId, nodes) {
  return {
    runId: `run-${topologyId}`, topologyId, status: "succeeded", errors: [],
    results: Object.entries(nodes).map(([nodeId, role]) => ({ nodeId, role, status: "succeeded", payload: {} })),
    nodeStates: Object.entries(nodes).map(([nodeId, roleId]) => ({ nodeId, roleId, status: "succeeded" })),
  };
}
const implementation = packet("project-planner-coder-verifier", { plan: "planner", code: "coder", verify: "verifier" });
implementation.results[0].payload.roadmapPlan = plan;
implementation.results[2].payload.verification = { status: "passed", evidence: ["Fixture checked"] };
implementation.roadmapApplications = [{ applied: true, plannerNodeId: "plan", beforeNodeId: "code", roadmapId: "fixture-roadmap", planFingerprint: planFingerprint(plan) }];
implementation.roadmapReconciliations = [{ reconciled: true, plannerNodeId: "plan", roadmapId: "fixture-roadmap", reconciliationStatus: "succeeded", topologyStatus: "succeeded", outcome: "completed" }];
const researcher = packet("project-subagent-smoke", { worker: "researcher" });
const success = [implementation, researcher];
const clone = (value) => JSON.parse(JSON.stringify(value));
assert.equal(validateTopologyTuiRuns(success).length, 2);
assert.equal(validateTopologyTuiRuns([...success].reverse()).length, 2, "file ordering cannot change acceptance");
assert.throws(() => validateTopologyTuiRuns([researcher]), /exactly two/, "researcher-only success is insufficient");
assert.throws(() => validateTopologyTuiRuns([researcher, clone(researcher)]), /exactly one run/, "two researcher packets cannot stand in for implementation");
assert.throws(() => validateTopologyTuiRuns([...success, clone(implementation)]), /exactly two/, "stale/duplicate successful runs cannot mask failure");

const corruptions = [
  ["original false pass", (run) => { run.status = "failed"; run.errors = [{ message: "$.roadmapPlan missing required property" }]; run.results[0].status = "failed"; run.nodeStates[1].status = "blocked"; run.nodeStates[2].status = "blocked"; }],
  ["blocked coder with optimistic run status", (run) => { run.nodeStates[1].status = "blocked"; }],
  ["skipped verifier", (run) => { run.nodeStates[2].status = "skipped"; }],
  ["failed verifier result", (run) => { run.results[2].status = "failed"; }],
  ["missing coder result", (run) => { run.results.splice(1, 1); }],
  ["duplicate planner instead of coder", (run) => { run.results[1] = clone(run.results[0]); }],
  ["wrong coder role", (run) => { run.results[1].role = "researcher"; }],
  ["missing roadmapPlan despite success status", (run) => { delete run.results[0].payload.roadmapPlan; }],
  ["invalid roadmapPlan", (run) => { run.results[0].payload.roadmapPlan.milestones = []; }],
  ["missing roadmap application", (run) => { run.roadmapApplications = []; }],
  ["different plan applied", (run) => { run.roadmapApplications[0].planFingerprint = "stale"; }],
  ["missing roadmap reconciliation", (run) => { run.roadmapReconciliations = []; }],
  ["failed roadmap reconciliation", (run) => { run.roadmapReconciliations[0].reconciled = false; }],
  ["unrelated roadmap reconciliation", (run) => { run.roadmapReconciliations[0].roadmapId = "another-roadmap"; }],
  ["unchecked verifier verdict", (run) => { run.results[2].payload.verification.status = "unchecked"; }],
  ["missing verifier evidence", (run) => { run.results[2].payload.verification.evidence = []; }],
  ["successful fallback", (run) => { run.fallbackOf = "failed-implementation"; }],
  ["residual errors", (run) => { run.errors.push({ message: "failed execution" }); }],
];
for (const [name, corrupt] of corruptions) {
  const runs = clone(success);
  corrupt(runs[0]);
  assert.throws(() => validateTopologyTuiRuns(runs), undefined, name);
}
const failedResearcher = clone(success);
failedResearcher[1].nodeStates[0].status = "blocked";
assert.throws(() => validateTopologyTuiRuns(failedResearcher), /node did not execute/, "implementation success cannot mask a blocked researcher either");

const tmp = tmpFixture("pi-topology-tui-oracle-");
try {
  const directory = path.join(tmp, "runs");
  fs.mkdirSync(directory);
  const evidenceFile = path.join(tmp, "evidence.json");
  const runCli = () => spawnSync(process.execPath, [path.join(__dirname, "../scripts/check-topology-tui-results.js"), directory, evidenceFile], { encoding: "utf8", timeout: 10000 });
  const save = (runs) => runs.forEach((run, index) => fs.writeFileSync(path.join(directory, `${index}.json`), JSON.stringify(run)));
  save(success);
  assert.equal(runCli().status, 0, "CLI accepts the two fully successful graphs");
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile, "utf8")), success);
  for (const [name, corrupt] of corruptions) {
    const runs = clone(success);
    corrupt(runs[0]);
    save(runs);
    const result = runCli();
    assert.equal(result.status, 1, `CLI fails closed: ${name}`);
    assert.match(result.stderr, /semantic acceptance failed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile, "utf8")), runs, "failed packets are retained, not hidden");
  }
  fs.writeFileSync(path.join(directory, "0.json"), "{invalid");
  assert.equal(runCli().status, 1, "malformed stored evidence is a failure");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`topology TUI acceptance tests passed (${corruptions.length} negative cases, CLI and graph-specific gates)`);
