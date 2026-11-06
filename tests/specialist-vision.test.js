"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { SubagentTaskService, baseline } = require("../src/subagent-tasks");
const { digest } = require("../src/subagent-task-contracts");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { containmentProbe } = require("../src/specialist-tools");
const { MAX_ASSET_ATTEMPTS, VIEW_NAMES, validatePreview, validateCritique } = require("../src/specialist-vision");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const png = fs.readFileSync(path.join(__dirname, "fixtures/specialist-contact-sheet.png"));
  const preview = { mimeType: "image/png", data: png.toString("base64"), digest: digest(png), views: VIEW_NAMES };
  assert.equal(validatePreview(preview).type, "image");
  for (const invalid of [null, { ...preview, digest: digest("wrong") }, { ...preview, views: ["front"] }, { ...preview, data: "a".repeat(200000) }, { ...preview, data: "bm90LWEtcG5n" }]) assert.throws(() => validatePreview(invalid), /PREVIEW_INVALID/);
  const critic = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "3d-critic");
  assert.deepEqual(critic.allowedTools, ["submit_role_result"]);
  assert.equal(critic.mutationPolicy, "forbidden");
  assert.equal(critic.autoRoutePolicy, "never");
  assert.equal(critic.memoryPolicy, "none");
  const critiqueFor = (artifactDigest, verdict = "accept") => ({ artifactDigest, previewDigest: preview.digest, verdict, observations: VIEW_NAMES.map(view => ({ view, observation: "Synthetic panel observed; this fixture makes no aesthetic claim." })), corrections: verdict === "revise" ? [{ view: "front", issue: "The silhouette is too wide for the brief.", action: "Reduce the body width by half without changing its height." }] : [], limitations: ["Provider-free transport fixture, not visual-quality evidence."] });
  const critique = critiqueFor(digest("asset"));
  assert.equal(validateCritique(critique, critique.artifactDigest, preview.digest), null);
  assert.equal(validateCritique({ ...critique, verdict: "revise" }, critique.artifactDigest, preview.digest), "inconsistent-visual-verdict");
  assert.equal(validateCritique({ ...critique, verdict: "revise", corrections: [{ view: "front", issue: "Too wide", action: "   " }] }, critique.artifactDigest, preview.digest), "invalid-or-stale-visual-critique");
  assert.equal(validateCritique({ ...critique, observations: [critique.observations[0]] }, critique.artifactDigest, preview.digest), "incomplete-visual-coverage");
  if (!containmentProbe().available) { console.log("SKIP vision task integration: containment unavailable; pure contracts checked"); return; }

  const root = tmpFixture("pi-vision-critic-");
  const originalHome = process.env.HOME;
  let passed = false;
  let listener = null;
  try {
    const cwd = path.join(root, "repo"), runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(cwd); fs.mkdirSync(runtimeRoot);
    // Inject native checking and model responses only. Real task orchestration,
    // isolated workspaces, patch identity, receipts, correction and resume run below.
    fs.copyFileSync("/usr/bin/true", path.join(runtimeRoot, "blender"));
    fs.chmodSync(path.join(runtimeRoot, "blender"), 0o700);
    const runtime = { root: runtimeRoot, executable: "blender", sha256: digest(fs.readFileSync(path.join(runtimeRoot, "blender"))).slice(7) };
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(cwd, "README.md"), "Synthetic vision orchestration fixture.\n");
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "fixture"]);
    const base = baseline(cwd), role = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "3d-modeler");
    // Preflight gates the 3d-modeler contract on its declared Blender MCP
    // binding. This fixture exercises orchestration, not the MCP transport, so
    // it declares that server in an isolated HOME and serves its pinned port.
    const home = tmpFixture("pi-vision-home-");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { [role.settings.blenderMcp.server]: { command: "blender-mcp" } } }));
    process.env.HOME = home;
    listener = await new Promise(resolve => {
      const server = net.createServer();
      // A listener that already serves the port satisfies preflight; an
      // unbindable one is reported by preflight instead of hidden here.
      server.once("error", () => resolve(null));
      server.listen(role.settings.blenderMcp.port, "127.0.0.1", () => resolve(server));
    });
    const budget = { units: "meters", axes: "Z-up", maxVertices: 128, maxTriangles: 24, maxMaterials: 4, maxTexturePixels: 0, maxBones: 0, maxBytes: 10000 };
    const graph = { schemaVersion: 2, graphId: "vision-fixture", concurrency: 1, context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R1"], sources: ["README.md"], assumptions: [], conventions: [], testEntryPoints: ["native"], exclusions: [] }, tasks: [{ taskId: "asset", roleId: role.roleId, contractRevision: roleRevisionHash(role), requirementIds: ["R1"], objective: "Create a narrow cube matching the brief.", exclusions: [], taskKind: "asset", dependsOn: [], readZones: ["README.md"], writeZones: ["assets/"], resources: [], ...base, contextPacketId: "context", domainInput: { ...budget, brief: "A narrow cube", format: "glb" }, acceptanceCriteria: [{ id: "native", kind: "executable", verifierId: "native", expected: "passed", required: true }] }] };
    let scenario, produced, reviews, checks, producerIds, corrections;
    const controller = new AbortController();
    const producerFailures = new Set(["resume-producer-failure", "resume-invalidated"]);
    const runner = new SubagentRunner({ execute: async ({ record, context }) => {
      const submission = { summary: "Producer persuasion must not appear in the independent vision packet.", findings: [], evidence: [{ kind: "fixture", summary: "Injected model result; not a live vision inference." }], verification: { status: "passed", evidence: ["Synthetic fixture only."] } };
      if (record.role === "3d-modeler") {
        produced++; producerIds.push(record.id);
        assert.deepEqual(context.images, [], "critic images must never leak into another role's prompt");
        if (produced > 1) {
          const packet = JSON.parse(record.task.split("\n\nUpstream topology context:")[0]);
          const needsCritique = ["refine", "last-attempt-accept", "exhaust", "resume-producer-failure"].includes(scenario) || (["resume-critic-failure", "resume-invalidated"].includes(scenario) && produced === 2);
          if (needsCritique) {
            assert(record.task.includes("Reduce the body width by half"));
            assert(packet.correction.visualCritique);
            assert.equal(packet.correction.visualCritique.artifactDigest, packet.correction.artifactDigest, "critique and seeded candidate stay paired");
            corrections++;
          }
          if (scenario === "resume-critic-failure" && produced === 3) assert.equal(packet.correction.visualCritique, undefined, "do not attach an older candidate's critique to a newer candidate");
          const previousCandidate = scenario === "resume-producer-failure" && produced === 3 ? 1 : produced - 1;
          if (scenario === "resume-invalidated" && produced === 3) {
            assert.equal(fs.existsSync(path.join(context.cwd, "assets/model.blend")), false, "invalidated historical candidates are not restored");
            assert.equal(packet.correction.visualCritique, undefined);
          } else assert.equal(fs.readFileSync(path.join(context.cwd, "assets/model.blend"), "utf8"), String(previousCandidate), "refinement starts from the last usable candidate, including after restart");
          if (scenario === "resume-producer-failure" && produced === 3) assert.equal(packet.correction.previousAttemptId, "asset.attempt-1");
        }
        if (producerFailures.has(scenario) && produced === 2) throw Object.assign(new Error("fixture producer interrupted before artifact capture"), { code: "PROVIDER_ERROR" });
        fs.mkdirSync(path.join(context.cwd, "assets"), { recursive: true });
        for (const file of ["model.blend", "model.glb"]) fs.writeFileSync(path.join(context.cwd, "assets", file), String(produced));
      } else {
        assert.equal(record.role, "3d-critic"); reviews++;
        assert.equal(checks, produced - (producerFailures.has(scenario) && produced === 3 ? 1 : 0), "native checker precedes each visual critique");
        assert(!producerIds.includes(record.id));
        assert(!record.task.includes(submission.summary), "producer persuasion withheld");
        assert(!record.task.includes(preview.data), "image bytes are not embedded in prompt text");
        assert(!record.task.includes('"visualCritique"'), "previous critiques withheld");
        assert.deepEqual(context.images, [validatePreview(preview)], "actual image content reaches the runtime");
        assert.deepEqual(record.roleContract.settings.taskPolicy, { readZones: [], writeZones: [] });
        const packet = JSON.parse(record.task);
        assert.equal(packet.domainInput.brief, "A narrow cube");
        const verdict = scenario === "exhaust" || (["refine", "resume-producer-failure", "resume-critic-failure", "resume-invalidated"].includes(scenario) && produced === 1) || (scenario === "last-attempt-accept" && produced < MAX_ASSET_ATTEMPTS) ? "revise" : scenario === "unable" ? "unable" : "accept";
        submission.visualCritique = critiqueFor(packet.artifactDigest, verdict);
        if (scenario === "stale") submission.visualCritique.artifactDigest = digest("stale");
        if (scenario === "bad-preview-binding") submission.visualCritique.previewDigest = digest("stale-preview");
        if (scenario === "malformed") delete submission.visualCritique.observations;
        if (scenario === "provider-error" || (scenario === "resume-critic-failure" && produced === 2)) throw Object.assign(new Error("fixture provider failure"), { code: "PROVIDER_ERROR" });
        if (scenario === "cancel") { controller.abort(); throw Object.assign(new Error("fixture cancellation"), { name: "AbortError" }); }
      }
      const result = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: result.summary, final_response: result.summary, submitted_result: result, termination: result.termination };
    } });
    const storage = new MemoryJsonStorage();
    const createTasks = () => new SubagentTaskService({ cwd, storage, topologies: new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture" }), roadmapPlanReconciler: async () => ({ reconciled: true }) } }), subagents: new SubagentService({ cwd, runner }), evidenceStore: new MemoryEvidenceStore(storage), verifiers: { native: { capability: "blender-asset", command: path.join(runtimeRoot, "blender"), configuration: { runtime, budget, glb: "assets/model.glb", native: "assets/model.blend" }, run: async ({ cwd: candidate }) => {
      checks++;
      assert.equal(fs.readFileSync(path.join(candidate, "assets/model.glb"), "utf8"), String(produced));
      if (scenario === "native-failure" && produced === 1) return { ok: false, exitCode: 1, stderr: "fixture geometry mismatch" };
      const truncated = png.subarray(0, 24);
      return { ok: true, exitCode: 0, stdout: "fixture native check passed", preview: scenario === "missing-preview" ? null : scenario === "corrupt-preview" ? { ...preview, digest: digest("corrupt") } : scenario === "truncated-preview" ? { ...preview, data: truncated.toString("base64"), digest: digest(truncated) } : preview };
    } } } });
    let tasks = createTasks();
    const options = { piContext: { model: { provider: "fixture", id: "vision", input: ["text", "image"] }, thinkingLevel: "high" } };
    for (scenario of ["accept", "refine", "last-attempt-accept", "exhaust", "resume-producer-failure", "resume-critic-failure", "resume-invalidated", "native-failure", "missing-preview", "corrupt-preview", "truncated-preview", "stale", "bad-preview-binding", "malformed", "unable", "provider-error", "cancel"]) {
      produced = reviews = checks = corrections = 0; producerIds = [];
      let result = await tasks.run(graph, { ...options, runId: `vision-${scenario}`, ...(scenario === "cancel" ? { signal: controller.signal } : {}) });
      const interrupted = producerFailures.has(scenario) || scenario === "resume-critic-failure";
      if (interrupted) {
        assert.equal(result.status, "failed");
        assert.equal(produced, 2, "infrastructure failure must not automatically retry");
        assert.equal(storage.readJson(`specialist-tasks/${result.runId}`).tasks.asset.state, "blocked");
        if (scenario === "resume-invalidated") {
          // Recorded invalidations survive a failed replacement even though start()
          // clears the current invalidated flag and artifact pointer.
          const saved = storage.readJson(`specialist-tasks/${result.runId}`);
          saved.tasks.asset.invalidations = [{ artifactDigest: saved.tasks.asset.attempts[0].artifact.digest, reason: "dependency-artifact-stale", at: Date.now() }];
          storage.writeJson(`specialist-tasks/${result.runId}`, saved);
        }
        tasks = createTasks();
        result = await tasks.run(graph, { ...options, runId: result.runId, resume: true });
      }
      const saved = storage.readJson(`specialist-tasks/${result.runId}`).tasks.asset;
      const accepted = interrupted || ["accept", "refine", "last-attempt-accept", "native-failure"].includes(scenario);
      assert.equal(result.status, accepted ? "accepted-proposal" : scenario === "cancel" ? "cancelled" : "failed", JSON.stringify({ scenario, errors: tasks.topologies.getRun(result.runId)?.errors, saved }));
      assert.equal(produced, interrupted || ["exhaust", "last-attempt-accept"].includes(scenario) ? MAX_ASSET_ATTEMPTS : ["refine", "native-failure"].includes(scenario) ? 2 : 1);
      assert.equal(reviews, ["missing-preview", "corrupt-preview", "truncated-preview"].includes(scenario) ? 0 : scenario === "native-failure" ? 1 : produced - (producerFailures.has(scenario) ? 1 : 0));
      if (["refine", "last-attempt-accept", "exhaust"].includes(scenario)) assert.equal(corrections, produced - 1);
      assert.deepEqual(baseline(cwd), base, "parent tree remains unchanged");
      for (const attempt of saved.attempts) for (const receipt of attempt.receipts) {
        assert.equal(receipt.artifactDigest, attempt.artifact.digest);
        assert.deepEqual(tasks.readReceipt(receipt.proofId), receipt);
        assert.equal(tasks.readReceipt(receipt.executableProofId).status, scenario === "native-failure" && attempt === saved.attempts[0] ? "failed" : "passed");
      }
      if (accepted) {
        assert.equal(saved.attempts.at(-1).receipts[0].visualReview.status, "passed");
        assert.equal((await tasks.run(graph, { ...options, runId: result.runId, resume: true })).status, "accepted-proposal");
        assert.equal(checks, produced - (producerFailures.has(scenario) ? 1 : 0), "accepted resume reuses exact evidence without rerunning");
      } else if (scenario === "exhaust") {
        assert.equal(saved.reason, "refinement-limit");
        assert.equal((await tasks.run(graph, { ...options, runId: result.runId, resume: true })).status, "failed");
        assert.equal(tasks.status(result.runId).tasks[0].reason, "refinement-limit");
        assert.equal(produced, MAX_ASSET_ATTEMPTS, "resume cannot reset the refinement bound");
      } else if (scenario !== "cancel") assert.equal(saved.state, "blocked", scenario);
    }
    passed = true;
    console.log("✓ independent image critic, bound actionable corrections, acceptance, interrupted producer/critic resume, native failure, exhaustion/resume, missing/corrupt/stale/malformed evidence, unable, provider failure and cancellation");
  } finally {
    listener?.close();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Vision failure fixture retained: ${root}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
