"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runtimeTreeDigest, runtimeBinding } = require("../src/specialist-runtime");
const { containmentProbe, runDomain } = require("../src/specialist-tools");
const { leanVerifier } = require("../src/specialist-lean");
const { reaVerifier } = require("../src/specialist-rea");
const { SubagentTaskService, baseline, loadTaskPolicy } = require("../src/subagent-tasks");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { digest } = require("../src/subagent-task-contracts");
const { tmpFixture } = require("./helpers/tmp-fixture");
function dossier(source, locator, observation) {
  return { assumptions: [], limitations: [{ id: "scope", statement: "Provider-free exact target acceptance only; no live-model quality, general mathematical correctness, dynamic target behavior or human approval." }], proofObligations: [], claims: [{ id: "claim", statement: observation, status: "inferred", assumptionIds: [], evidenceIds: ["source"], limitationIds: ["scope"], proofObligationIds: [] }], evidenceRefs: [{ id: "source", source, locator, observation }] };
}
(async () => {
  const pins = tmpFixture("pi-domain-pins-");
  try {
    fs.writeFileSync(path.join(pins, "dependency"), "first");
    const pin = { root: pins, sha256: runtimeTreeDigest(pins) };
    runtimeBinding(pin);
    const original = fs.statSync(path.join(pins, "dependency"));
    fs.writeFileSync(path.join(pins, "dependency"), "other");
    fs.utimesSync(path.join(pins, "dependency"), original.atime, original.mtime);
    assert.throws(() => runtimeBinding(pin), /STALE/, "dependency bytes cannot hide behind an unchanged launcher/lock or restored mtime");
    fs.symlinkSync("/etc/passwd", path.join(pins, "escape"));
    assert.throws(() => runtimeTreeDigest(pins), /LINK_ESCAPE/);
    assert.throws(() => leanVerifier({}), /LEAN_TARGET_INVALID/);
    assert.throws(() => reaVerifier({ operation: "disassemble_all" }), /REA_POLICY_INVALID/);
  } finally { fs.rmSync(pins, { recursive: true, force: true }); }
  console.log("✓ runtime dependency drift, link confinement and unsupported domain policy rejection");
  if (!process.env.PI_TEST_DOMAIN_POLICY) { console.log("SKIP native Lean/REA acceptance: explicit reviewed test runtime policy required"); return; }
  assert(containmentProbe().available, "native acceptance requires containment; cannot silently skip");
  const tools = JSON.parse(fs.readFileSync(process.env.PI_TEST_DOMAIN_POLICY, "utf8"));
  const cwd = tmpFixture("pi-domain-acceptance-");
  const saved = { checks: [], receipts: [] };
  try {
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(cwd, "Expected.lean"), "import Init\naxiom goal : Nat.gcd 84 30 = 6\n");
    fs.writeFileSync(path.join(cwd, "Propext.lean"), "import Init\naxiom goal : forall (p q : Prop), (p ↔ q) -> p = q\n");
    fs.copyFileSync("/usr/bin/true", path.join(cwd, "target.elf"));
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "owned domain fixture"]);
    const target = { path: "Expected.lean", sha256: digest(fs.readFileSync(path.join(cwd, "Expected.lean"))).slice(7), declaration: "goal", candidateDeclaration: "result", imports: ["Init"], allowedAxioms: [] };
    const leanDefinition = { id: "lean", type: "lean", ...tools.lean, target };
    const reaDefinition = { id: "rea", type: "rea", ...tools.rea, target: "target.elf", sha256: digest(fs.readFileSync(path.join(cwd, "target.elf"))).slice(7), authorization: "Owned benign ELF fixture; static headers only; never execute or use network.", operation: "file_headers", roundTripSection: ".interp" };
    const lean = leanVerifier(leanDefinition), rea = reaVerifier(reaDefinition);
    const mathDossier = source => ({ ...dossier(target.path, "lean:result", "Exact gcd target, pending independent kernel acceptance."), leanProof: { targetDigest: digest(target), source } });
    const goodSource = "import Init\ntheorem result : Nat.gcd 84 30 = 6 := by decide\n";
    for (const [name, source, diagnostic] of [
      ["false-proof", "import Init\ntheorem result : Nat.gcd 84 30 = 7 := by decide\n", /./],
      ["wrong-proposition", "import Init\ntheorem result : 1 + 1 = 2 := rfl\n", /target proposition mismatch/],
      ["sorry", "import Init\ntheorem result : Nat.gcd 84 30 = 6 := by sorry\n", /unapproved axiom.*sorryAx/],
      ["extra-axiom", "import Init\naxiom forged : Nat.gcd 84 30 = 6\ntheorem result : Nat.gcd 84 30 = 6 := forged\n", /unapproved axiom.*forged/],
      ["unapproved-import", "import Std\ntheorem result : Nat.gcd 84 30 = 6 := by decide\n", /unapproved import/],
      ["missing-trusted-import", "prelude\ntheorem result : forall (p : Prop), p -> p := fun p h => h\n", /unapproved import/],
      ["forged-output", 'import Init\n#eval IO.println "PI_LEAN_KERNEL_ACCEPTED"\ntheorem result : Nat.gcd 84 30 = 6 := by sorry\n', /unapproved axiom.*sorryAx/],
    ]) {
      const result = await lean.run({ cwd, dossier: mathDossier(source) });
      assert.equal(result.ok, false, name); assert.match(result.stderr || result.stdout, diagnostic, name);
      saved.checks.push({ name, rejected: true, diagnostic: (result.stderr || result.stdout).slice(0, 2000) });
    }
    const propextTarget = { ...target, path: "Propext.lean", sha256: digest(fs.readFileSync(path.join(cwd, "Propext.lean"))).slice(7), allowedAxioms: ["propext"] };
    const propextProof = { ...dossier("Propext.lean", "lean:result", "The declared proposition uses only approved propositional extensionality."), leanProof: { targetDigest: digest(propextTarget), source: "import Init\ntheorem result : forall (p q : Prop), (p ↔ q) -> p = q := fun p q h => propext h\n" } };
    const withAxiom = await leanVerifier({ ...leanDefinition, target: propextTarget }).run({ cwd, dossier: propextProof });
    assert.equal(withAxiom.ok, true, withAxiom.stderr || withAxiom.stdout);
    saved.checks.push({ name: "explicit-standard-axiom-allowlist", passed: true, evidence: withAxiom.domainEvidence });
    const wrongDigest = mathDossier(goodSource); wrongDigest.leanProof.targetDigest = `sha256:${"0".repeat(64)}`;
    assert.equal((await lean.run({ cwd, dossier: wrongDigest })).ok, false);
    assert.throws(() => leanVerifier({ ...leanDefinition, runtime: { ...tools.lean.runtime, sha256: "0".repeat(64) } }), /RUNTIME_STALE/);
    const storage = new MemoryJsonStorage(), evidenceStore = new MemoryEvidenceStore(storage);
    let service, expectedReaDossier;
    const runner = new SubagentRunner({ execute: async ({ record }) => {
      const submission = { summary: "Provider-free specialist domain proposal with independent native acceptance.", findings: [], evidence: [{ kind: "fixture", summary: "Real installed tools, deterministic producer fixture; not live model evidence." }], verification: { status: "passed", evidence: ["Independent fixture review; native executable gate remains mandatory."] } };
      if (record.role === "mathematical-researcher") submission.dossier = mathDossier(goodSource);
      else if (record.role === "reverse-engineer") {
        const observed = await runDomain({ cwd, contract: record.roleContract, operation: "rea-inspect", file: "target.elf" });
        assert(observed.ok, observed.stderr);
        const output = JSON.parse(observed.stdout), line = output.lines.findIndex(line => /file format elf/.test(line));
        assert(line >= 0);
        expectedReaDossier = dossier("target.elf", `${output.locatorPrefix}${line + 1}`, output.lines[line].trim());
        submission.dossier = expectedReaDossier;
      } else assert.equal(record.role, "reviewer");
      const result = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: result.summary, final_response: result.summary, submitted_result: result, termination: result.termination };
    } });
    const topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture-roadmap" }), roadmapPlanReconciler: async () => ({ reconciled: true, outcome: "completed" }) } });
    service = new SubagentTaskService({ cwd, storage, topologies, subagents: new SubagentService({ cwd, runner }), evidenceStore, verifiers: { lean, rea } });
    const base = baseline(cwd);
    const graph = (roleId, domainInput, verifierId) => {
      const role = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === roleId);
      return { schemaVersion: 2, graphId: `native-${verifierId}`, concurrency: 1, context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R1"], sources: ["Expected.lean", "target.elf"], assumptions: [], conventions: [], testEntryPoints: [verifierId], exclusions: [] }, tasks: [{ taskId: "produce", requirementIds: ["R1"], roleId, contractRevision: roleRevisionHash(role), objective: "Return the exact bounded domain artifact for independent acceptance.", exclusions: [], taskKind: "research", dependsOn: [], readZones: ["Expected.lean", "target.elf"], writeZones: [], resources: [], ...base, contextPacketId: "context", domainInput, acceptanceCriteria: [{ id: "domain", kind: "executable", verifierId, expected: "passed", required: true }] }] };
    };
    const math = graph("mathematical-researcher", { question: "Prove the exact pinned gcd statement.", definitions: ["Natural-number gcd"], assumptions: [], proofMode: "lean", leanTarget: target }, "lean");
    const reverse = graph("reverse-engineer", { target: reaDefinition.target, sha256: reaDefinition.sha256, authorization: reaDefinition.authorization, technique: "static", reaOperation: "file_headers" }, "rea");
    for (const input of [math, reverse]) {
      assert.equal(service.preflight(input).allowed, true, JSON.stringify(service.preflight(input).reasons));
      const result = await service.run(input, { piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
      assert.equal(result.status, "accepted-proposal", JSON.stringify({ result, errors: topologies.getRun(result.runId)?.errors }));
      const receipts = service.evidence(result.runId, "produce");
      assert.equal(receipts.length, 1); assert.equal(receipts[0].status, "passed");
      assert.equal(receipts[0].artifactDigest, service.status(result.runId).tasks[0].artifactDigest);
      assert(receipts[0].domainEvidence); saved.receipts.push(...receipts);
    }
    assert.equal(service.capabilities().domains.formalProof.available, true);
    assert.equal(service.capabilities().domains.reaReverseEngineering.available, true);
    const fake = structuredClone(expectedReaDossier); fake.evidenceRefs[0].observation = "invented ELF observation";
    assert.equal((await rea.run({ cwd, dossier: fake })).ok, false);
    saved.checks.push({ name: "fabricated-rea-evidence", rejected: true });
    const mismatch = structuredClone(reverse); mismatch.tasks[0].domainInput.reaOperation = "symbols";
    assert(service.preflight(mismatch).reasons.includes("produce:bound-rea-checker-unavailable"));
    mismatch.tasks[0].domainInput.reaOperation = "file_headers"; mismatch.tasks[0].domainInput.authorization = "different authorization";
    assert(service.preflight(mismatch).reasons.includes("produce:bound-rea-checker-unavailable"));
    const wrongTarget = structuredClone(math); wrongTarget.tasks[0].domainInput.leanTarget.declaration = "other";
    assert(service.preflight(wrongTarget).reasons.includes("produce:pinned-formal-checker-unavailable"));
    const boundRole = { settings: { ...service.producerSettings(DEFAULT_ROLE_CONTRACTS.find(r => r.roleId === "reverse-engineer"), reverse.tasks[0]), domainInput: reverse.tasks[0].domainInput, taskPolicy: { readZones: ["target.elf"], writeZones: [] } } };
    await assert.rejects(() => runDomain({ cwd, contract: boundRole, operation: "rea-inspect", file: "Expected.lean" }), /OPERATION_DENIED/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(() => runDomain({ cwd, contract: boundRole, operation: "rea-inspect", file: "target.elf", signal: cancelled.signal }), /CANCELLED/);
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi/specialist-task-policy.json"), JSON.stringify({ schemaVersion: 2, verifiers: [leanDefinition, reaDefinition] }));
    const loaded = loadTaskPolicy(cwd, ".pi/specialist-task-policy.json");
    assert.equal(loaded.verifiers.lean.capability, "lean-proof"); assert.equal(loaded.verifiers.rea.capability, "rea-static");
    assert.deepEqual(baseline(cwd), base, "provider-free domain acceptance never mutates the parent");
    fs.appendFileSync(path.join(cwd, "Expected.lean"), "-- drift\n");
    assert.equal((await lean.run({ cwd, dossier: mathDossier(goodSource) })).ok, false);
    fs.appendFileSync(path.join(cwd, "target.elf"), "drift");
    await assert.rejects(() => rea.run({ cwd, dossier: expectedReaDossier }), /TARGET_NOT_AUTHORIZED/);
    saved.checks.push({ name: "target-source-authorization-operation-and-cancellation-bindings", rejected: true });
    saved.status = "passed";
    console.log("✓ real Lean kernel replay and REA static task acceptance, negative proofs/observations, policy binding and parent preservation");
  } catch (error) { saved.status = "failed"; saved.error = error.stack; throw error; }
  finally {
    if (process.env.PI_TEST_DOMAIN_EVIDENCE) fs.writeFileSync(process.env.PI_TEST_DOMAIN_EVIDENCE, JSON.stringify(saved, null, 2) + "\n");
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
