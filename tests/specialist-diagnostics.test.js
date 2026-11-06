"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DEFAULT_ROLE_CONTRACTS, roleDescriptor, roleRevisionHash } = require("../src/role-contracts");
const { DIAGNOSTIC_OPERATIONS, diagnosticPlan, diagnosticPreflight, diagnosticCapabilities } = require("../src/specialist-diagnostics");
const { runDomain, sandboxCommand, containmentProbe, executable } = require("../src/specialist-tools");
const { digest, validateTaskGraph } = require("../src/subagent-task-contracts");
const { SubagentTaskService, baseline } = require("../src/subagent-tasks");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { verifyDossier } = require("../src/specialist-verifiers");
const { createDiagnosticEvidenceCollector } = require("../src/diagnostic-evidence");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const cwd = tmpFixture("pi-specialist-diagnostics-");
  let passed = false;
  try {
    const role = id => structuredClone(DEFAULT_ROLE_CONTRACTS.find(r => r.roleId === id));
    for (const id of ["reliability-investigator", "code-profiler"]) {
      const contract = role(id);
      assert.equal(contract.autoRoutePolicy, "never");
      assert.equal(contract.workspacePolicy, "shared-readonly");
      assert.equal(contract.mutationPolicy, "forbidden");
      assert.equal(contract.budget, null);
      assert(contract.toolPolicy.allowedTools.includes("role_domain"));
      assert(contract.toolPolicy.deniedTools.includes("bash"));
      assert.equal(roleDescriptor(contract).availability, "requires-task-contract");
    }
    assert.match(role("reliability-investigator").systemPrompt, /GDB.*native crashes/);
    for (const name of ["Valgrind", "Nsight Systems", "perf-stat", "python-cprofile", "node-cpu-profile"]) assert(role("code-profiler").systemPrompt.includes(name), name);
    assert.match(role("code-profiler").systemPrompt, /preregistered experiments/);
    const capabilities = diagnosticCapabilities();
    if (!capabilities["time-profile"].available) {
      console.log(`SKIP diagnostic execution fixtures: ${capabilities["time-profile"].reasons}`); passed = true; return;
    }
    fs.copyFileSync("/usr/bin/true", path.join(cwd, "target"));
    const targetHash = digest(fs.readFileSync(path.join(cwd, "target"))).slice(7);
    function contractFor(operation, file = "target", overrides = {}, id = "code-profiler") {
      const contract = role(id);
      contract.settings.domainInput = { execution: { authorization: "Run only this owned synthetic fixture, without host attachment or network.", target: file, sha256: digest(fs.readFileSync(path.join(cwd, file))).slice(7), args: [], operations: [operation], timeoutMs: 15000, ...overrides } };
      contract.settings.taskPolicy = { readZones: [file], writeZones: [] };
      return contract;
    }
    const time = contractFor("time-profile");
    const plan = contract => diagnosticPlan({ contract, cwd, operation: "time-profile", file: "target" });
    assert.equal(plan(time).config.args[0], "/usr/bin/time");
    const mutate = fn => { const changed = structuredClone(time); fn(changed); return changed; };
    for (const fn of [
      c => delete c.settings.domainInput.execution.authorization,
      c => c.settings.domainInput.execution.authorization = "  ",
      c => c.settings.domainInput.execution.sha256 = "z".repeat(64),
      c => c.settings.domainInput.execution.timeoutMs = 120001,
      c => c.settings.domainInput.execution.timeoutMs = 1.5,
      c => c.settings.domainInput.execution.args = ["bad\0arg"],
      c => c.settings.domainInput.execution.args = Array(33).fill("arg"),
      c => c.settings.domainInput.execution.command = "sh",
      c => c.settings.domainInput.execution.operations = ["time-profile", "time-profile"],
      c => c.settings.domainInput.execution.gpuDevices = ["/dev/null"],
      c => c.settings.domainInput.execution.operations = ["shell"],
      c => delete c.settings.taskPolicy,
      c => c.settings.taskPolicy.readZones = [],
      c => c.settings.taskPolicy.writeZones = ["target"],
      c => c.settings.domainInput.execution.sha256 = "0".repeat(64),
    ]) assert.throws(() => plan(mutate(fn)), /SPECIALIST_/);
    const literal = plan(mutate(c => c.settings.domainInput.execution.args = ["$(touch stolen)", "; rm -rf /", "two words"]));
    assert.deepEqual(literal.config.args.slice(-3), ["$(touch stolen)", "; rm -rf /", "two words"], "no shell parsing");
    assert.throws(() => diagnosticPlan({ contract: time, cwd, operation: "gdb-backtrace", file: "target" }), /OPERATION_DENIED/);
    fs.symlinkSync("target", path.join(cwd, "alias"));
    const aliased = contractFor("time-profile", "alias");
    assert.throws(() => diagnosticPlan({ contract: aliased, cwd, operation: "time-profile", file: "alias" }), /ALIASED/);
    fs.mkdirSync(path.join(cwd, "runtime"));
    fs.copyFileSync("/usr/bin/true", path.join(cwd, "runtime/nsys"));
    fs.chmodSync(path.join(cwd, "runtime/nsys"), 0o755);
    const nsysRuntime = { root: path.join(cwd, "runtime"), executable: "nsys", sha256: targetHash };
    const ns = contractFor("nsys-profile", "target", { nsysRuntime });
    const nsPlan = diagnosticPlan({ contract: ns, cwd, operation: "nsys-profile", file: "target" });
    assert.equal(nsPlan.config.args[0], "/runtime/nsys");
    assert(nsPlan.config.args.includes("--sample=none"));
    assert(nsPlan.config.args.includes("--cpuctxsw=none"));
    assert(nsPlan.config.args.includes("--trace=nvtx,osrt"));
    assert.deepEqual(nsPlan.gpuDevices, []);
    const launch = sandboxCommand({ cwd, command: nsPlan.command, args: nsPlan.args, runtimeRoot: nsPlan.runtimeRoot, readZones: ["target"], outputBytes: 16777216 });
    assert(launch.args.includes("--unshare-all"));
    assert(launch.args.includes("--clearenv"));
    assert(!launch.args.includes("--dev-bind"));
    const profiledLaunch = sandboxCommand({ cwd, command: nsPlan.command, args: nsPlan.args, runtimeRoot: nsPlan.runtimeRoot, readZones: ["target"], outputBytes: 16777216, privateShm: true, hardwareMetadata: true });
    assert(profiledLaunch.args.includes("15728640"));
    assert(profiledLaunch.args.includes("1048576"));
    assert(profiledLaunch.args.join(" ").includes("--ro-bind /sys /sys"));
    assert(profiledLaunch.args.join(" ").includes("--tmpfs /dev/shm"));
    assert(!profiledLaunch.args.join(" ").includes("--bind /dev/shm"));
    assert.throws(() => sandboxCommand({ cwd, command: "/usr/bin/true", gpuDevices: ["/dev/null"] }), /GPU_GRANT_INVALID/);
    const stale = structuredClone(ns); stale.settings.domainInput.execution.nsysRuntime.sha256 = "0".repeat(64);
    assert(diagnosticPreflight(stale, cwd).some(reason => reason.includes("RUNTIME_STALE")));
    const unreviewed = structuredClone(ns); unreviewed.settings.domainInput.execution.nsysRuntime.root = path.dirname(cwd);
    assert(diagnosticPreflight(unreviewed, cwd).some(reason => reason.includes("RUNTIME_ROOT_INVALID")));
    assert.deepEqual(diagnosticPreflight({ settings: { domainInput: {} } }, cwd), []);
    assert.deepEqual(Object.keys(capabilities), Object.keys(DIAGNOSTIC_OPERATIONS));
    for (const cap of Object.values(capabilities)) { assert.equal(cap.installingProbe, false); assert.equal(cap.requiresExecutionAuthorization, true); }
    assert(!fs.existsSync(path.join(cwd, "stolen")));
    console.log("✓ diagnostic roles, recommendations, ownership, pins, argv and GPU boundaries");

    if (!containmentProbe().available) {
      console.log("SKIP native diagnostics and task integration: usable bubblewrap required"); passed = true; return;
    }
    const timeResult = await runDomain({ cwd, contract: time, operation: "time-profile", file: "target", command: "/usr/bin/false", args: [], writable: true, gpuDevices: ["/dev/null"] });
    assert.equal(timeResult.ok, true, JSON.stringify(timeResult));
    assert.match(timeResult.stderr, /Maximum resident set size/);
    assert.equal(timeResult.diagnosticEvidence.targetSha256, targetHash);
    assert.deepEqual(timeResult.diagnosticEvidence.gpuDevices, [], "tool call cannot replace parent grants");
    fs.writeFileSync(path.join(cwd, "script.py"), "import os, sys\nassert not os.path.exists('/workspace/.git/config')\nassert not os.environ.get('PI_DIAGNOSTIC_PRIVATE_FIXTURE')\nprint('workload', sum(i*i for i in range(20000)))\n");
    fs.writeFileSync(path.join(cwd, "script.js"), "let sum = 0; for (let i=0;i<200000;i++) sum += Math.sqrt(i); console.log('workload', sum);\n");
    for (const [operation, file, expected] of [["python-cprofile", "script.py", /function calls/], ["node-cpu-profile", "script.js", /selfSamples/]]) {
      if (!capabilities[operation].available) { console.log(`SKIP ${operation}: ${capabilities[operation].reasons}`); continue; }
      const result = await runDomain({ cwd, operation, file, contract: contractFor(operation, file) });
      assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.stdout, expected);
    }
    fs.writeFileSync(path.join(cwd, "wait.py"), "import time\ntime.sleep(20)\n");
    const timed = await runDomain({ cwd, operation: "python-cprofile", file: "wait.py", contract: contractFor("python-cprofile", "wait.py", { timeoutMs: 250 }) });
    assert.equal(timed.ok, false); assert.equal(timed.termination, "timeout");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => runDomain({ cwd, operation: "time-profile", file: "target", contract: time, signal: controller.signal }), /CANCELLED/);
    fs.writeFileSync(path.join(cwd, "loud.py"), "print('x' * 100000)\n");
    const loud = await runDomain({ cwd, operation: "python-cprofile", file: "loud.py", contract: contractFor("python-cprofile", "loud.py") });
    assert.equal(loud.ok, false); assert.equal(loud.termination, "output-limit");
    assert(Buffer.byteLength(loud.stdout) + Buffer.byteLength(loud.stderr) <= 65536);

    if (executable("cc")) {
      fs.writeFileSync(path.join(cwd, "fixture.c"), '#include <stdlib.h>\n#include <string.h>\nint main(int argc, char **argv) { if (argc > 1 && !strcmp(argv[1], "crash")) abort(); volatile char *p = malloc(16); if (argc > 1 && !strcmp(argv[1], "memory")) { p[16] = 1; return 0; } volatile long sum = 0; for (int i=0;i<100000;i++) sum += i; free((void*)p); return 0; }\n');
      execFileSync("cc", ["-g", "-O0", "-o", "native", "fixture.c"], { cwd });
      for (const [operation, args, expected] of [
        ["gdb-backtrace", ["crash"], /SIGABRT|signal SIGABRT/],
        ["valgrind-memcheck", ["memory"], /Invalid write/],
        ["valgrind-callgrind", [], /PROGRAM TOTALS/],
        ["valgrind-massif", [], /Massif/],
        ["strace-summary", [], /syscall/],
        ["perf-stat", [], /task-clock/],
      ]) {
        if (!capabilities[operation].available) { console.log(`SKIP ${operation}: ${capabilities[operation].reasons}`); continue; }
        const contract = contractFor(operation, "native", { args }, operation === "gdb-backtrace" ? "reliability-investigator" : "code-profiler");
        const result = await runDomain({ cwd, operation, file: "native", contract });
        const output = result.stdout + result.stderr;
        if (operation === "perf-stat" && !result.ok && /permission|Operation not permitted|Access to performance monitoring|No such file or directory/i.test(output)) {
          assert.equal(result.ok, false); console.log(`SKIP native perf counters: host does not permit collection (${result.exitCode})`); continue;
        }
        assert.match(output, expected, JSON.stringify(result));
        if (operation === "gdb-backtrace") { assert.match(output, /main .*fixture.c/); assert.equal(result.ok, false, "a captured crash is not a passing execution"); }
        else if (operation === "valgrind-memcheck") { assert.equal(result.ok, false); assert.equal(result.exitCode, 97); }
        else assert.equal(result.ok, true, JSON.stringify(result));
      }
    } else console.log("SKIP native crash/memory/counter fixtures: compiler unavailable");
    console.log("✓ contained native diagnostics, runtime profiles, timeouts, cancellation and output limits");

    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "fixture baseline"]);
    const base = baseline(cwd), storage = new MemoryJsonStorage();
    let observed = null, captured = null, clock = Date.now();
    const runner = new SubagentRunner({ execute: async ({ record }) => {
      const collector = createDiagnosticEvidenceCollector({ subagentId: record.id, contract: record.roleContract });
      const submission = { summary: "The authorized synthetic workload has bounded resource observations, not a performance acceptance claim.", findings: [], evidence: [{ summary: "Native role_domain resource report for target." }], verification: { status: "passed", evidence: ["Independent fixture review of declared scope; measurement truth is not machine certified."] } };
      if (record.role === "code-profiler") {
        observed = await runDomain({ cwd, operation: "time-profile", file: "target", contract: record.roleContract });
        assert.equal(observed.ok, true, JSON.stringify(observed));
        collector.observe({ type: "tool_execution_start", toolName: "role_domain", toolCallId: "native-measurement", args: { operation: "time-profile", file: "target" } });
        collector.observe({ type: "tool_execution_end", toolName: "role_domain", toolCallId: "native-measurement", result: { details: observed } });
        captured = collector.snapshot();
        submission.dossier = { assumptions: [], claims: [{ id: "c", statement: "GNU time collected resource observations for the declared target.", status: "observed", assumptionIds: [], evidenceIds: ["e"], limitationIds: ["l"], proofObligationIds: [] }], evidenceRefs: [{ id: "e", source: "role_domain:time-profile", locator: "stderr:Maximum resident set size", observation: "A bounded peak RSS report was returned." }], limitations: [{ id: "l", statement: "One synthetic execution; no speedup, production latency, GPU or independent verification claim." }], proofObligations: [] };
      }
      if (record.role === "reviewer") {
        const packet = JSON.parse(record.task.split("\n\nUpstream topology context:")[0]);
        assert.deepEqual(packet.runtimeDiagnostics, captured, "review receives original supervised results, not producer prose");
        assert.equal(packet.runtimeDiagnostics[0].stderr, observed.stderr);
        assert.equal(packet.artifact.diagnosticEvidenceDigest, digest(captured));
        assert.equal(packet.executableChecks.length, 1);
        const check = packet.executableChecks[0];
        assert.equal(check.phase, "executable"); assert.equal(check.status, "passed");
        assert.deepEqual(service.readReceipt(check.proofId), check, "checker receipt already exists before review");
        assert.deepEqual(record.roleContract.settings.taskPolicy.writeZones, []);
        assert(!record.roleContract.toolPolicy.allowedTools.includes("role_domain"), "review inspects originals without rerunning the target");
        clock += 1000;
      }
      const submitted = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination, diagnosticEvidence: collector.snapshot() };
    } });
    const topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture" }), roadmapPlanReconciler: async () => ({ reconciled: true, outcome: "completed" }) } });
    const service = new SubagentTaskService({ cwd, storage, topologies, now: () => clock, subagents: new SubagentService({ cwd, runner }), evidenceStore: new MemoryEvidenceStore(storage), verifiers: { dossier: { run: verifyDossier } } });
    const graph = { schemaVersion: 2, graphId: "diagnostic-fixture", concurrency: 1, context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R1"], sources: ["target"], assumptions: [], conventions: [], testEntryPoints: [], exclusions: [] }, tasks: [{ taskId: "measure", requirementIds: ["R1"], roleId: "code-profiler", contractRevision: roleRevisionHash(role("code-profiler")), objective: "Measure the synthetic fixture once using GNU time.", exclusions: [], taskKind: "analysis", dependsOn: [], readZones: ["target"], writeZones: [], resources: [], ...base, contextPacketId: "context", domainInput: time.settings.domainInput, acceptanceCriteria: [{ id: "structure", kind: "executable", verifierId: "dossier", expected: "passed", required: true }] }] };
    validateTaskGraph(graph, DEFAULT_ROLE_CONTRACTS);
    assert.equal(service.preflight(graph).allowed, true);
    const invalid = structuredClone(graph); invalid.tasks[0].domainInput.execution.sha256 = "0".repeat(64);
    assert(service.preflight(invalid).reasons.some(reason => reason.includes("TARGET_STALE")));
    const missing = structuredClone(graph); delete missing.tasks[0].domainInput.execution;
    assert.throws(() => service.preflight(missing), /DOMAIN_INPUT_INVALID/);
    const result = await service.run(graph, { piContext: { model: { provider: "fixture", id: "parent" }, thinkingLevel: "high" } });
    assert.equal(result.status, "accepted-proposal", JSON.stringify(topologies.getRun(result.runId)?.errors));
    assert(observed?.diagnosticEvidence);
    const accepted = service.evidence(result.runId, "measure")[0];
    assert.equal(accepted.phase, "acceptance");
    assert.equal(Date.parse(accepted.finishedAt), clock, "acceptance settles after review, not at the earlier checker time");
    assert(Date.parse(service.readReceipt(accepted.executableProofId).finishedAt) < Date.parse(accepted.finishedAt));
    assert.deepEqual(accepted.diagnosticEvidenceIds, captured.map(r => r.id));
    assert.equal(service.readReceipt(accepted.executableProofId).phase, "executable");
    assert.equal(service.readReceipt(accepted.executableProofId).status, "passed");
    const producer = service.subagents.getSubagent({ subagentId: captured[0].subagentId });
    assert.deepEqual(producer.result.diagnosticEvidence, captured, "original output is persisted outside the submission");
    producer.result.diagnosticEvidence[0].stderr += "tampered";
    service.subagents.store.saveResult(producer.result);
    const staleResult = await service.run(graph, { resume: true, runId: result.runId, piContext: { model: { provider: "fixture", id: "parent" }, thinkingLevel: "high" } });
    assert.notEqual(staleResult.status, "accepted-proposal");
    assert.match(JSON.stringify(topologies.getRun(staleResult.runId)?.errors), /DIAGNOSTIC_EVIDENCE_DIGEST_INVALID/);
    assert.deepEqual(baseline(cwd), base, "profiling never mutates the parent project");
    console.log("✓ code-profiler task preflight, actual tool execution and dossier acceptance (fixture-driven inference)");
    passed = true;
  } finally {
    if (passed) fs.rmSync(cwd, { recursive: true, force: true });
    else console.error(`Diagnostic failure fixture retained: ${cwd}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
