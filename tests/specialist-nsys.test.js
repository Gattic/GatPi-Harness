"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { runDomain } = require("../src/specialist-tools");
const { digest } = require("../src/subagent-task-contracts");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  if (!process.env.PI_TEST_NSYS_RUNTIME) {
    console.log("SKIP native Nsight Systems: set PI_TEST_NSYS_RUNTIME to an approved runtime binding JSON");
    return;
  }
  const cwd = tmpFixture("pi-specialist-nsys-");
  let passed = false;
  try {
    const runtime = JSON.parse(fs.readFileSync(process.env.PI_TEST_NSYS_RUNTIME, "utf8"));
    fs.copyFileSync("/usr/bin/sleep", path.join(cwd, "target"));
    const contract = structuredClone(DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "code-profiler"));
    contract.settings.domainInput = { execution: { authorization: "Profile only this owned synthetic sleep fixture with CPU/NVTX tracing; no GPU access.", target: "target", sha256: digest(fs.readFileSync(path.join(cwd, "target"))).slice(7), args: ["0.1"], operations: ["nsys-profile"], timeoutMs: 30000, nsysRuntime: runtime } };
    contract.settings.taskPolicy = { readZones: ["target"], writeZones: [] };
    const result = await runDomain({ cwd, operation: "nsys-profile", file: "target", contract });
    fs.writeFileSync(path.join(cwd, "result.json"), JSON.stringify(result, null, 2));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.stdout + result.stderr, /nsys-rep/);
    assert.match(result.stdout + result.stderr, /OS Runtime Summary|osrt_sum/);
    assert.match(result.stdout, /nanosleep/, "require actual workload observations, not just a report filename");
    assert.deepEqual(result.diagnosticEvidence.gpuDevices, []);
    console.log("✓ native Nsight Systems CPU/OS runtime collection and nanosleep observation (no CUDA/GPU claim)");
    passed = true;
  } finally {
    if (passed) fs.rmSync(cwd, { recursive: true, force: true });
    else console.error(`Nsight failure fixture retained: ${cwd}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
