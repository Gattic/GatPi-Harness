"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { digest } = require("../src/subagent-task-contracts");
const { SubagentTaskService, baseline, loadTaskPolicy } = require("../src/subagent-tasks");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { bezoutVerifier, staticElfVerifier, blenderVerifier, domainCapabilities } = require("../src/specialist-verifiers");
const { containmentProbe, executable } = require("../src/specialist-tools");
const { tmpFixture } = require("./helpers/tmp-fixture");
function dossier(source, observation, certificate) {
  return { assumptions: [], limitations: [{ id: "scope", statement: "Only the pinned certificate or literal static observations are machine checked; this is not general proof or dynamic analysis." }], proofObligations: [], claims: [{ id: "claim", statement: observation, status: "inferred", assumptionIds: [], evidenceIds: ["source"], limitationIds: ["scope"], proofObligationIds: [] }], evidenceRefs: [{ id: "source", source, locator: source.endsWith(".elf") ? "readelf:line:1" : "task:certificateTarget", observation }], ...(certificate ? { certificate } : {}) };
}
(async () => {
  if (!containmentProbe().available || !executable("readelf")) { console.log("SKIP domain fixtures: required containment/static tool unavailable"); return; }
  const cwd = tmpFixture("pi-specialist-domains-");
  try {
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
    fs.copyFileSync("/usr/bin/true", path.join(cwd, "target.elf"));
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "fixture baseline"]);
    const target = { kind: "bezout-gcd", a: "84", b: "30", gcd: "6" }, targetHash = digest(fs.readFileSync(path.join(cwd, "target.elf"))).slice(7);
    const base = baseline(cwd);
    let mathematicalAttempts = 0, productionCalls = 0;
    const runner = new SubagentRunner({ execute: async ({ record }) => {
      const submission = { summary: "A provider-free domain proposal with independently checked scoped evidence.", findings: [], evidence: [{ kind: "fixture", summary: "A bounded domain fixture, not live model capability evidence." }], verification: { status: "passed", evidence: ["Fixture independent review; executable acceptance is separate."] } };
      if (record.role === "mathematical-researcher") {
        productionCalls++; mathematicalAttempts++;
        submission.dossier = dossier("task:certificateTarget", "gcd(84,30)=6", { kind: "bezout-gcd", targetDigest: digest(target), u: mathematicalAttempts === 1 ? "0" : "-1", v: mathematicalAttempts === 1 ? "0" : "3" });
      } else if (record.role === "reverse-engineer") { productionCalls++; submission.dossier = dossier("target.elf", "ELF Header:"); }
      else assert.equal(record.role, "reviewer");
      const submitted = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
    } });
    const storage = new MemoryJsonStorage(), evidenceStore = new MemoryEvidenceStore(storage);
    const topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture-roadmap" }), roadmapPlanReconciler: async () => ({ reconciled: true, outcome: "completed" }) } });
    const assetBudget = { units: "meters", axes: "Z-up", maxVertices: 100, maxTriangles: 100, maxMaterials: 1, maxTexturePixels: 0, maxBones: 0, maxBytes: 10000 };
    const service = new SubagentTaskService({ cwd, storage, topologies, subagents: new SubagentService({ cwd, runner }), evidenceStore, verifiers: { gcd: bezoutVerifier(target), elf: staticElfVerifier({ target: "target.elf", sha256: targetHash, roundTripSection: ".interp" }), asset: blenderVerifier({ glb: "assets/model.glb", native: "assets/model.blend", budget: assetBudget }) } });
    function graph(roleId, domainInput, verifierId) {
      const role = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === roleId);
      return { schemaVersion: 2, graphId: `fixture-${verifierId}`, concurrency: 1, context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R1"], sources: ["target.elf"], assumptions: [], conventions: [], testEntryPoints: [verifierId], exclusions: [] }, tasks: [{ taskId: "produce", requirementIds: ["R1"], roleId, contractRevision: roleRevisionHash(role), objective: "Complete the bounded explicitly declared domain fixture.", exclusions: [], taskKind: roleId === "3d-modeler" ? "asset" : "research", dependsOn: [], readZones: ["target.elf"], writeZones: roleId === "3d-modeler" ? ["assets/"] : [], resources: [], ...base, contextPacketId: "context", domainInput, acceptanceCriteria: [{ id: "domain", kind: "executable", verifierId, expected: "passed", required: true }] }] };
    }
    const math = graph("mathematical-researcher", { question: "Prove gcd(84,30)=6.", definitions: ["Positive integer greatest common divisor."], assumptions: [], proofMode: "certificate", certificateTarget: target }, "gcd");
    const result = await service.run(math, { piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(result.status, "accepted-proposal", JSON.stringify(topologies.getRun(result.runId)?.errors));
    assert.equal(mathematicalAttempts, 2, "a false certificate fails and a corrected exact certificate passes");
    const attempt = service.status(result.runId).tasks[0].attempts;
    assert.equal(attempt[0].state, "failed"); assert.equal(attempt[1].state, "accepted-proposal");
    const wrongTarget = structuredClone(math); wrongTarget.tasks[0].domainInput.certificateTarget.gcd = "3";
    assert(service.preflight(wrongTarget).reasons.some(reason => reason.includes("bound-certificate")));
    const lean = structuredClone(math); lean.tasks[0].domainInput.proofMode = "lean";
    assert.throws(() => service.preflight(lean), /LEAN_TARGET_REQUIRED/);
    lean.tasks[0].domainInput.leanTarget = { path: "Expected.lean", sha256: "0".repeat(64), declaration: "goal", candidateDeclaration: "result", imports: ["Init"], allowedAxioms: [] };
    assert(service.preflight(lean).reasons.some(reason => reason.includes("pinned-formal-checker")));
    const reverse = graph("reverse-engineer", { target: "target.elf", sha256: targetHash, authorization: "Inspect this locally owned benign fixture; never execute it.", technique: "static" }, "elf");
    const reversed = await service.run(reverse, { piContext: { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(reversed.status, "accepted-proposal", JSON.stringify(topologies.getRun(reversed.runId)?.errors));
    assert.equal((await staticElfVerifier({ target: "target.elf", sha256: targetHash }).run({ cwd, dossier: dossier("target.elf", "fabricated symbol at invented offset") })).ok, false);
    const beforeBlocked = productionCalls;
    const wrongHash = structuredClone(reverse); wrongHash.tasks[0].domainInput.sha256 = "0".repeat(64);
    assert.equal(service.preflight(wrongHash).allowed, false);
    const asset = graph("3d-modeler", { brief: "A bounded editable cube and standard GLB export.", ...assetBudget, format: "glb" }, "asset");
    if (!domainCapabilities().modeling.available) assert(service.preflight(asset).reasons.some(reason => reason.includes("blender")), "missing Blender is an explicit blocker, never an installation trigger");
    assert.equal(productionCalls, beforeBlocked);
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const policyFile = path.join(cwd, ".pi", "specialist-task-policy.json");
    fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 2, verifiers: [{ id: "gcd", type: "bezout", target }] }));
    const loaded = loadTaskPolicy(cwd, ".pi/specialist-task-policy.json");
    assert.equal(loaded.verifiers.gcd.capability, "mathematical-certificate");
    assert.equal(loaded.accountingReservation, undefined);
    fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 2, approvedModel: {}, verifiers: [] }));
    assert.throws(() => loadTaskPolicy(cwd, ".pi/specialist-task-policy.json"), /POLICY_INVALID/, "obsolete model accounting fields are rejected");
    assert.deepEqual(baseline(cwd), base, "read-only domain fixtures leave the parent unchanged");
    console.log("✓ exact certificate correction, pinned static observations, domain blockers and reviewed policy");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
