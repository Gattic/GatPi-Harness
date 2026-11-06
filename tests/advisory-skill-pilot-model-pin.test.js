"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { AdvisorySkillPilot, SkillSynthesisAdapter, MemoryJsonStorage } = require("../src/integration-boundary");
const { openExperiment } = require("../src/experiment-ledger");
const { hash } = require("../src/reviewed-evidence");
const { tmpFixture } = require("./helpers/tmp-fixture");

function createPilot(cwd) {
  const file = path.join(cwd, "SKILL.md");
  const skills = new SkillSynthesisAdapter({ cwd, storage: new MemoryJsonStorage(), options: { loadNative: false, loadCurated: false } });
  skills.registerProvider({ providerId: "fixture", skills: [{
    skillId: "skill_fixture_verify", name: "Fixture change-verify", description: "Verify changes", status: "approved",
    workflowSteps: [{ description: "Verify the change" }],
    provenance: { nativeSkillName: "change-verify", file, sourceHash: hash(fs.readFileSync(file, "utf8")) },
    approvals: { advisoryRetrieval: "allowed", routing: "not-approved", publishing: "not-approved" },
  }] });
  return new AdvisorySkillPilot({ cwd, skills, env: {} });
}

if (!isMainThread) {
  const pilot = createPilot(workerData.cwd);
  const sync = new Int32Array(workerData.sync), link = fs.linkSync;
  let waited = false;
  fs.linkSync = function(from, to) {
    // Both public prepare() calls must read the unpinned state before either
    // acquires the real storage lock. No sleeps or production test hooks.
    if (!waited && String(to).endsWith("machine-pilot.json.lock")) {
      waited = true;
      parentPort.postMessage({ kind: "ready", id: workerData.id });
      assert.notEqual(Atomics.wait(sync, workerData.id, 0, 10000), "timed-out", "enrollment barrier timed out");
    }
    return link.call(fs, from, to);
  };
  try {
    const result = pilot.prepare({ prompt: "Verify these changes", sessionId: `session-${workerData.id}`, requestId: `request-${workerData.id}`, interactive: true, ...workerData.identity });
    parentPort.postMessage({ kind: "done", id: workerData.id, result, active: pilot.active !== null });
  } finally { fs.linkSync = link; }
} else {
  async function enrollPair(secondIdentity, shouldBlock) {
    const cwd = tmpFixture("pi-model-pin-regression-");
    const workers = [];
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
      fs.writeFileSync(path.join(cwd, "SKILL.md"), "Verify changes without repairs.\n");
      fs.mkdirSync(path.join(cwd, "tests"));
      fs.writeFileSync(path.join(cwd, "tests/oracle.test.js"), "console.log('fixture');\n");
      openExperiment(cwd, "machine verification advisory v2");
      const pilot = createPilot(cwd);
      pilot.initialize();
      const firstIdentity = { model: { provider: "fixture", id: "model-a" }, thinkingLevel: "low" };
      const shared = new SharedArrayBuffer(8), sync = new Int32Array(shared), ready = new Set(), results = [];
      const release = id => { Atomics.store(sync, id, 1); Atomics.notify(sync, id); };
      await Promise.all([firstIdentity, secondIdentity].map((identity, id) => new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { cwd, id, identity, sync: shared } });
        workers.push(worker);
        worker.on("error", reject);
        worker.on("message", message => {
          if (message.kind === "ready") {
            ready.add(message.id);
            if (ready.size === 2) release(0);
          } else if (message.kind === "done") {
            results[message.id] = message;
            if (message.id === 0) release(1);
          }
        });
        worker.on("exit", code => code === 0 ? resolve() : reject(new Error(`worker ${id} exited ${code}`)));
      })));
      assert(results[0].result.caseId, "the first writer enrolls and pins its model");
      if (shouldBlock) {
        assert.deepEqual(results[1].result, { blocked: "model-cohort-changed" });
        assert.equal(results[1].active, false, "rejection must not activate a case or expose an advisory");
      } else {
        assert(results[1].result.caseId, "same-model concurrent sessions remain eligible");
        assert.equal(results[1].active, true);
      }
      const state = pilot.state();
      assert.equal(state.cases.length, shouldBlock ? 1 : 2);
      assert.equal(state.modelHash, hash(firstIdentity));
      assert(state.cases.every(row => row.modelHash === state.modelHash), "every enrolled case matches the pinned model and thinking level");
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
  (async () => {
    await enrollPair({ model: { provider: "fixture", id: "model-b" }, thinkingLevel: "low" }, true);
    await enrollPair({ model: { provider: "fixture", id: "model-a" }, thinkingLevel: "high" }, true);
    await enrollPair({ model: { provider: "fixture", id: "model-a" }, thinkingLevel: "low" }, false);
    console.log("advisory skill pilot model pin tests passed");
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
