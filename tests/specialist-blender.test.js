"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash } = require("../src/role-contracts");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { baseline } = require("../src/subagent-tasks");
const { MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter, SubagentTasksAdapter } = require("../src/integration-boundary");
const { runDomain, guardMutation, containmentProbe } = require("../src/specialist-tools");
const { blenderVerifier, domainCapabilities } = require("../src/specialist-verifiers");
const { VIEW_NAMES, validatePreview } = require("../src/specialist-vision");

(async () => {
  const script = fs.readFileSync(path.join(__dirname, "fixtures/specialist-cube.py"), "utf8");
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: script });
  if (!process.env.PI_TEST_BLENDER_RUNTIME) {
    console.log("SKIP native Blender fixture: PI_TEST_BLENDER_RUNTIME must name an explicitly approved runtime JSON; syntax only checked");
    return;
  }
  // The runner below is provider-free; do not inherit real role model preferences.
  process.env.PI_ROLE_MODEL_3D_MODELER = "fixture/approved";
  process.env.PI_ROLE_MODEL_3D_CRITIC = "fixture/approved";
  const runtime = JSON.parse(fs.readFileSync(process.env.PI_TEST_BLENDER_RUNTIME, "utf8"));
  const blenderAi = process.env.PI_TEST_BLENDERAI_ROOT ? { root: process.env.PI_TEST_BLENDERAI_ROOT, sha256: require("../src/specialist-runtime").runtimeTreeDigest(process.env.PI_TEST_BLENDERAI_ROOT) } : null;
  const animation = blenderAi ? { object: "Cube", frames: [1, 13, 25] } : null;
  const recipe = fs.readFileSync(path.join(__dirname, "fixtures/specialist-animation.json"), "utf8");
  const capability = domainCapabilities({ blenderRuntime: runtime }).modeling;
  assert.equal(capability.available, true, JSON.stringify(capability));
  assert.equal(containmentProbe().available, true, "configured native acceptance must not silently skip unusable containment");
  const cwd = tmpFixture("pi-native-asset-");
  let passed = false;
  try {
    const git = args => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n"); fs.writeFileSync(path.join(cwd, "README.md"), "Owned native cube fixture.\n");
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "fixture"]);
    const base = baseline(cwd), role = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "3d-modeler");
    const asset = { units: "meters", axes: "Z-up", maxVertices: 128, maxTriangles: 24, maxMaterials: 4, maxTexturePixels: 0, maxBones: 0, maxBytes: 1048576 };
    const graph = { schemaVersion: 2, graphId: "native-cube", concurrency: 1, context: { id: "context", baselineFingerprint: base.baselineFingerprint, requirementIds: ["R1"], sources: ["README.md"], assumptions: [], conventions: [], testEntryPoints: ["native-asset"], exclusions: [] }, tasks: [{ taskId: "asset", roleId: role.roleId, contractRevision: roleRevisionHash(role), requirementIds: ["R1"], objective: "Create an editable two-meter cube and a matching GLB, retain animation through export when requested.", exclusions: [], taskKind: "asset", dependsOn: [], readZones: ["README.md", "assets/"], writeZones: ["assets/"], resources: [], ...base, contextPacketId: "context", domainInput: { ...asset, format: "glb", brief: "An untextured two-meter cube, editable native source and standard GLB export." }, acceptanceCriteria: [{ id: "native", kind: "executable", verifierId: "native-asset", expected: "passed", required: true }] }] };
    let candidateCwd, producerRuns = 0, producerRunLimit = 1, expectedReviewRole = "3d-critic", reviewerVerdict = "passed", reviewRoles = [];
    const runner = new SubagentRunner({ execute: async ({ record, context }) => {
      if (record.role === "3d-modeler") {
        producerRuns += 1;
        assert.ok(producerRuns <= producerRunLimit, `The fixed native fixture must pass on its first candidate; inspect the retained criterion receipt on failure (${producerRuns} > ${producerRunLimit}).`);
        candidateCwd = context.cwd;
        assert.deepEqual(record.roleContract.settings.blenderRuntime, runtime, "producer inherits the independent checker's reviewed binding");
        const file = blenderAi ? "assets/recipe.json" : "assets/create.py", content = blenderAi ? recipe : script;
        guardMutation({ cwd: candidateCwd, contract: record.roleContract, tool: "write", input: { path: file, content } });
        fs.mkdirSync(path.join(candidateCwd, "assets"), { recursive: true }); fs.writeFileSync(path.join(candidateCwd, file), content);
        const input = { cwd: candidateCwd, contract: record.roleContract, operation: blenderAi ? "blenderai-dispatch" : "blender-script", file, outputs: ["assets/cube.blend", "assets/cube.glb"], signal: context.signal };
        const generated = await runDomain(input);
        assert.equal(generated.ok, true, generated.stderr);
        if (blenderAi) {
          assert.deepEqual(record.roleContract.settings.blenderAi, blenderAi);
          const invalidFile = "assets/denied.json";
          for (const name of ["unknown_tool", "execute_python_reviewed", "delete_selected_objects"]) {
            fs.writeFileSync(path.join(candidateCwd, invalidFile), JSON.stringify({ calls: [{ name, arguments: {} }] }));
            const denied = await runDomain({ ...input, file: invalidFile, outputs: ["assets/denied.blend"] });
            assert.equal(denied.ok, false, name);
            assert.equal(fs.existsSync(path.join(candidateCwd, "assets/denied.blend")), false);
          }
          fs.unlinkSync(path.join(candidateCwd, invalidFile));
          await assert.rejects(() => runDomain({ ...input, contract: { ...record.roleContract, settings: { ...record.roleContract.settings, blenderAi: { ...blenderAi, sha256: "0".repeat(64) } } } }), /RUNTIME_STALE/);
        }
      } else {
        reviewRoles.push(record.role);
        assert.equal(record.role, expectedReviewRole);
        if (expectedReviewRole === "3d-critic") {
          assert.equal(context.images.length, 1);
          const packet = JSON.parse(record.task);
          validatePreview({ ...context.images[0], digest: packet.previewDigest, views: packet.views });
          // The critic can only judge what the preview shows: canonical orthographic
          // views framed to the subject, not a small oblique blob.
          assert.ok(packet.previewCoverage >= 0.15, `preview must frame the subject, got ${packet.previewCoverage}`);
        } else assert.equal(context.images.length, 0, "measured acceptance must not send a contact sheet to the reviewer");
      }
      const submission = { summary: "Provider-free native asset fixture; visual feedback is deliberately not supplied.", findings: [], evidence: [{ kind: "fixture", summary: "Real contained DCC execution; model responses and advisory review are fixtures." }], verification: { status: record.role === "3d-modeler" ? "passed" : reviewerVerdict, evidence: ["Executable native acceptance is independent of non-blocking visual feedback."] } };
      if (record.role === "3d-critic") {
        const packet = JSON.parse(record.task);
        submission.visualCritique = { artifactDigest: packet.artifactDigest, previewDigest: packet.previewDigest, verdict: "accept", observations: VIEW_NAMES.map(view => ({ view, observation: "Native rendered view supplied to fixture critic; not live aesthetic approval." })), corrections: [], limitations: ["Provider-free response; no live visual judgment."] };
      }
      const result = createRoleResultEnvelope({ contract: record.roleContract, subagentId: record.id, submission });
      return { summary: result.summary, final_response: result.summary, submitted_result: result, termination: result.termination };
    } });
    const storage = new MemoryJsonStorage(), topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd, roadmapPlanApplier: async () => ({ applied: true, roadmapId: "fixture" }), roadmapPlanReconciler: async () => ({ reconciled: true }) } });
    const definition = { glb: "assets/cube.glb", native: "assets/cube.blend", budget: asset, runtime, blenderAi, animation };
    const model = { provider: "fixture", id: "approved", input: ["text", "image"], api: "openai-responses", baseUrl: "https://fixture.invalid", contextWindow: 1024, maxTokens: 128, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.2 } };
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi/specialist-task-policy.json"), JSON.stringify({ schemaVersion: 2, verifiers: [{ id: "native-asset", type: "blender", ...definition }] }));
    const service = new SubagentTasksAdapter({ cwd, enabled: true, policyFile: ".pi/specialist-task-policy.json", storage, topologies, subagents: new SubagentService({ cwd, runner }), evidenceStore: new MemoryEvidenceStore(storage) });
    const piContext = { model, thinkingLevel: "high" };
    assert.equal(service.enabled, true);
    assert.equal(service.capabilities().domains.modeling.available, true);
    assert.equal(service.capabilities().roles.find(role => role.roleId === "3d-modeler").availability, "requires-task-contract");
    const preflight = service.preflight(graph, { piContext });
    assert.equal(preflight.allowed, true, JSON.stringify(preflight));
    const ambiguous = structuredClone(graph);
    ambiguous.tasks[0].acceptanceCriteria.push({ ...ambiguous.tasks[0].acceptanceCriteria[0], id: "duplicate-checker" });
    assert.equal(service.preflight(ambiguous, { piContext }).allowed, false, "producer must have one unambiguous native checker binding");
    const result = await service.run(graph, { piContext });
    const saved = storage.readJson(`specialist-tasks/${result.runId}`, null);
    const receipts = saved.tasks.asset.attempts.flatMap(attempt => attempt.receipts);
    if (result.status !== "accepted-proposal") console.error(JSON.stringify({ result, receipts }, null, 2));
    if (result.status !== "accepted-proposal" && process.env.PI_TEST_BLENDER_EVIDENCE) fs.writeFileSync(`${process.env.PI_TEST_BLENDER_EVIDENCE}.failed`, JSON.stringify({ result, receipts }, null, 2) + "\n", { flag: "wx" });
    assert.equal(result.status, "accepted-proposal", JSON.stringify({ errors: topologies.getRun(result.runId)?.errors, receipts }));
    assert.deepEqual(service.evidence({ runId: result.runId, taskId: "asset" }), receipts);
    const nativeReceipt = receipts.find(receipt => receipt.criterionId === "native");
    assert.equal(nativeReceipt.status, "passed");
    assert.deepEqual(nativeReceipt.configuration.runtime, runtime);
    assert.equal(nativeReceipt.preview.mimeType, "image/png");
    assert.deepEqual(nativeReceipt.preview.views, VIEW_NAMES);
    assert.equal(nativeReceipt.visualReview.status, "passed");
    assert.deepEqual(reviewRoles, ["3d-critic"], "the default path invokes exactly the vision critic");
    assert.equal(nativeReceipt.acceptanceMode, undefined, "a critic-mode receipt carries a visual critique, not a measured marker");
    assert(receipts.every(receipt => receipt.status === "passed"), "visual feedback is not an acceptance gate");
    if (blenderAi) {
      assert.equal(JSON.parse(nativeReceipt.diagnostic).animationSamples, 3);
      assert.equal(service.capabilities().domains.blenderAi.available, true);
      await service.feedback({ runId: result.runId, taskId: "asset", artifactDigest: result.tasks.tasks[0].artifactDigest, text: "Try a slower turntable for the next iteration." });
      assert.equal(service.status(result.runId).tasks[0].state, "accepted-proposal");
    }
    assert.deepEqual(baseline(cwd), base, "native asset production never mutates the parent");
    assert.equal((await blenderVerifier({ ...definition, budget: { ...asset, maxVertices: 1 } }).run({ cwd: candidateCwd })).ok, false);
    await assert.rejects(() => blenderVerifier({ ...definition, glb: "assets/missing.glb" }).run({ cwd: candidateCwd }), /ENOENT/);
    // Keep the same geometry but make every export face transparent: PNG existence
    // or an opaque RGB background must not satisfy the nonempty-preview criterion.
    const glb = fs.readFileSync(path.join(candidateCwd, definition.glb)), jsonBytes = glb.readUInt32LE(12);
    const document = JSON.parse(glb.subarray(20, 20 + jsonBytes).toString());
    if (blenderAi) {
      const still = { ...document, animations: [] }, encoded = Buffer.from(JSON.stringify(still));
      const body = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32); encoded.copy(body);
      const header = Buffer.from(glb.subarray(0, 20)), tail = glb.subarray(20 + jsonBytes);
      header.writeUInt32LE(20 + body.length + tail.length, 8); header.writeUInt32LE(body.length, 12);
      fs.writeFileSync(path.join(candidateCwd, "assets/still.glb"), Buffer.concat([header, body, tail]));
      const stillCheck = await blenderVerifier({ ...definition, glb: "assets/still.glb" }).run({ cwd: candidateCwd });
      assert.equal(stillCheck.ok, false);
      assert.match(stillCheck.stderr, /animation-has-no-motion/);
    }
    document.materials = [{ alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0] } }];
    for (const mesh of document.meshes) for (const primitive of mesh.primitives) primitive.material = 0;
    const json = Buffer.from(JSON.stringify(document)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
    json.copy(padded);
    const header = Buffer.from(glb.subarray(0, 20)), tail = glb.subarray(20 + jsonBytes);
    header.writeUInt32LE(20 + padded.length + tail.length, 8); header.writeUInt32LE(padded.length, 12);
    fs.writeFileSync(path.join(candidateCwd, "assets/transparent.glb"), Buffer.concat([header, padded, tail]));
    const transparent = await blenderVerifier({ ...definition, glb: "assets/transparent.glb" }).run({ cwd: candidateCwd });
    assert.equal(transparent.ok, false);
    assert.match(transparent.stderr, /empty-render/);

    // Measured acceptance: the same asset task, but the anatomy verdict comes from a
    // pinned checker that reads the exported artifact. The native checker stays bound
    // for the runtime, budgets and round-trip; the vision critique is not invoked.
    const checker = [
      "import json, struct, sys",
      "raw = open(sys.argv[1], 'rb').read()",
      "assert struct.unpack_from('<I', raw, 0)[0] == 0x46546C67, 'not-a-glb'",
      "length = struct.unpack_from('<I', raw, 12)[0]",
      "document = json.loads(raw[20:20 + length])",
      "counts = [len(mesh['primitives']) for mesh in document['meshes']]",
      "print('PI_MEASURED:' + json.dumps({'meshes': len(document['meshes']), 'primitives': sum(counts)}))",
      "assert len(document['meshes']) == 1, 'expected one cube mesh'",
    ].join("\n") + "\n";
    // A second pinned checker that measures a property the cube does not have, so the
    // measured path is exercised against a criterion that must fail.
    const strictChecker = [
      "import json, struct, sys",
      "raw = open(sys.argv[1], 'rb').read()",
      "length = struct.unpack_from('<I', raw, 12)[0]",
      "document = json.loads(raw[20:20 + length])",
      "assert len(document['meshes']) == 2, 'expected two meshes, found %d' % len(document['meshes'])",
    ].join("\n") + "\n";
    const sha = file => `sha256:${require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(cwd, file))).digest("hex")}`;
    fs.mkdirSync(path.join(cwd, "checkers"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "checkers/measure.py"), checker);
    fs.writeFileSync(path.join(cwd, "checkers/strict.py"), strictChecker);
    git(["add", "checkers"]); git(["commit", "-qm", "measured checkers"]);
    const measuredBase = baseline(cwd);
    fs.writeFileSync(path.join(cwd, ".pi/specialist-task-policy.json"), JSON.stringify({ schemaVersion: 2, verifiers: [
      { id: "native-asset", type: "blender", ...definition },
      { id: "cube-shape", type: "command", command: "/usr/bin/python3", args: ["/workspace/checkers/measure.py", "/workspace/assets/cube.glb"], protectedFiles: [{ path: "checkers/measure.py", digest: sha("checkers/measure.py") }] },
      { id: "cube-strict", type: "command", command: "/usr/bin/python3", args: ["/workspace/checkers/strict.py", "/workspace/assets/cube.glb"], protectedFiles: [{ path: "checkers/strict.py", digest: sha("checkers/strict.py") }] },
    ] }));
    const measuredService = new SubagentTasksAdapter({ cwd, enabled: true, policyFile: ".pi/specialist-task-policy.json", storage, topologies, subagents: new SubagentService({ cwd, runner }), evidenceStore: new MemoryEvidenceStore(storage) });
    const measuredGraphFor = (graphId, criterionIds) => {
      const g = structuredClone(graph);
      g.graphId = graphId;
      g.context.baselineFingerprint = measuredBase.baselineFingerprint;
      g.tasks[0].baseRevision = measuredBase.baseRevision;
      g.tasks[0].baselineFingerprint = measuredBase.baselineFingerprint;
      g.tasks[0].readZones = ["README.md", "checkers/", "assets/"];
      g.tasks[0].acceptanceMode = "measured";
      for (const [id, verifierId] of criterionIds) g.tasks[0].acceptanceCriteria.push({ id, kind: "executable", verifierId, expected: "passed", required: true });
      return g;
    };
    const measuredGraph = measuredGraphFor("native-cube-measured", [["measured-shape", "cube-shape"]]);
    const withoutMeasured = structuredClone(measuredGraph);
    withoutMeasured.tasks[0].acceptanceCriteria = withoutMeasured.tasks[0].acceptanceCriteria.filter(c => c.verifierId === "native-asset");
    assert.equal(measuredService.preflight(withoutMeasured, { piContext }).allowed, false, "measured acceptance without a measured checker must not preflight");
    assert(measuredService.preflight(withoutMeasured, { piContext }).reasons.includes("asset:measured-acceptance-needs-measured-checker"));
    const measuredPreflight = measuredService.preflight(measuredGraph, { piContext });
    assert.equal(measuredPreflight.allowed, true, JSON.stringify(measuredPreflight));
    producerRuns = 0; expectedReviewRole = "patch-reviewer"; reviewRoles = [];
    const measured = await measuredService.run(measuredGraph, { piContext });
    const measuredSaved = storage.readJson(`specialist-tasks/${measured.runId}`, null);
    const measuredReceipts = measuredSaved.tasks.asset.attempts.flatMap(attempt => attempt.receipts);
    assert.equal(measured.status, "accepted-proposal", JSON.stringify({ errors: topologies.getRun(measured.runId)?.errors, receipts: measuredReceipts }));
    assert.equal(measuredReceipts.length, 2, "both bound checkers produce an acceptance receipt");
    assert(measuredReceipts.every(receipt => receipt.status === "passed"));
    assert(measuredReceipts.every(receipt => receipt.visualReview === undefined), "measured acceptance carries no vision critique");
    assert(measuredReceipts.every(receipt => receipt.acceptanceMode === "measured"), "measured receipts are marked as measured, not as visual approval");
    assert.equal(measuredReceipts.find(receipt => receipt.criterionId === "measured-shape").capability, "registered-executable-check");
    assert.deepEqual(reviewRoles, ["patch-reviewer"], "measured acceptance reviews the patch without invoking the vision critic");
    assert.deepEqual(baseline(cwd), measuredBase, "measured acceptance never mutates the parent");

    // Dropping the critique must not drop the other two gates. A failing measured
    // criterion blocks acceptance and is reported as a failed criterion, not as
    // infrastructure; the independent reviewer still inspects the attempt.
    producerRuns = 0; producerRunLimit = 3; reviewRoles = [];
    const failing = await measuredService.run(measuredGraphFor("native-cube-measured-failing", [["measured-strict", "cube-strict"]]), { piContext });
    const failingSaved = storage.readJson(`specialist-tasks/${failing.runId}`, null);
    const failingAttempts = failingSaved.tasks.asset.attempts;
    assert.notEqual(failing.status, "accepted-proposal", "a failing measured criterion must never be accepted");
    assert.equal(failing.application, "not-applied");
    for (const attempt of failingAttempts) {
      const byCriterion = Object.fromEntries(attempt.receipts.map(receipt => [receipt.criterionId, receipt]));
      assert.equal(byCriterion.native.status, "passed", "the native round-trip check still passes on the same artifact");
      assert.equal(byCriterion["measured-strict"].status, "failed", "the failing measured criterion is reported as failed, not blocked");
      assert.equal(byCriterion["measured-strict"].exitCode, 1);
      assert.match(byCriterion["measured-strict"].diagnostic, /expected two meshes/);
      assert(attempt.receipts.every(receipt => receipt.reviewSubagentId), "measured attempts are still independently reviewed");
      assert(attempt.receipts.every(receipt => receipt.visualReview === undefined), "no vision critique is fabricated for a failing measured attempt");
      assert(attempt.receipts.every(receipt => receipt.acceptanceMode === "measured"), "a failing measured attempt stays marked as measured");
    }
    assert(failingAttempts.length >= 2, "a failed measured criterion feeds the producer correction loop");
    assert(!reviewRoles.includes("3d-critic"), "a failing measured attempt never falls back to the vision critic");

    // The independent review is not advisory in measured mode: a reviewer that
    // reports a failed verification turns every passing check into a failed receipt.
    producerRuns = 0; reviewerVerdict = "failed"; reviewRoles = [];
    const reviewFailed = await measuredService.run(measuredGraphFor("native-cube-measured-review-failed", [["measured-shape", "cube-shape"]]), { piContext });
    reviewerVerdict = "passed";
    const reviewFailedSaved = storage.readJson(`specialist-tasks/${reviewFailed.runId}`, null);
    const reviewFailedReceipts = reviewFailedSaved.tasks.asset.attempts.flatMap(attempt => attempt.receipts);
    assert.notEqual(reviewFailed.status, "accepted-proposal", "a failed independent review must never be accepted");
    assert.equal(reviewFailed.application, "not-applied");
    assert(reviewFailedReceipts.length > 0);
    assert(reviewFailedReceipts.every(receipt => receipt.status === "failed"), "the review verdict, not the checker exit code, decides the receipt");
    assert(reviewFailedReceipts.every(receipt => receipt.exitCode === 0), "the underlying checkers still exited zero");
    assert(reviewFailedReceipts.every(receipt => receipt.reviewSubagentId), "each receipt is bound to the reviewer subagent");
    assert(reviewFailedReceipts.every(receipt => receipt.visualReview === undefined), "the review path never emits a visual critique");
    assert(!reviewRoles.includes("3d-critic"), "a failed review never falls back to the vision critic");

    // An unavailable measured checker must stop the run before any producer attempt:
    // it may not degrade to the native check alone or to the critic path.
    const unregistered = measuredGraphFor("native-cube-measured-unregistered", [["measured-ghost", "cube-ghost"]]);
    const unregisteredPreflight = measuredService.preflight(unregistered, { piContext });
    assert.equal(unregisteredPreflight.allowed, false);
    assert(unregisteredPreflight.reasons.includes("asset:measured-acceptance-needs-measured-checker"));
    assert(unregisteredPreflight.reasons.includes("asset:verifier-unavailable:cube-ghost"));
    producerRuns = 0;
    await assert.rejects(() => measuredService.run(unregistered, { piContext }), /TASK_PREFLIGHT_BLOCKED/);
    assert.equal(producerRuns, 0, "a blocked preflight never starts a producer run");

    // A registered checker is pinned by digest: editing it after registration
    // invalidates the policy instead of silently measuring something else.
    fs.appendFileSync(path.join(cwd, "checkers/measure.py"), "# edited after registration\n");
    const driftedBase = baseline(cwd);
    const drifted = measuredGraphFor("native-cube-measured-drifted", [["measured-shape", "cube-shape"]]);
    drifted.context.baselineFingerprint = driftedBase.baselineFingerprint;
    drifted.tasks[0].baseRevision = driftedBase.baseRevision;
    drifted.tasks[0].baselineFingerprint = driftedBase.baselineFingerprint;
    const driftedPreflight = measuredService.preflight(drifted, { piContext });
    assert.equal(driftedPreflight.allowed, false);
    assert.deepEqual(driftedPreflight.reasons, ["asset:TASK_ORACLE_SOURCE_DRIFT"], "only the pinned-checker drift blocks this graph");
    git(["checkout", "--", "checkers/measure.py"]);
    assert.deepEqual(baseline(cwd), measuredBase, "restoring the pinned checker restores the baseline");
    assert.equal(measuredService.preflight(measuredGraph, { piContext }).allowed, true, "the same graph is allowed again once the checker matches its pin");

    const attemptSummary = run => storage.readJson(`specialist-tasks/${run.runId}`, null).tasks.asset.attempts.map(attempt => ({
      attemptId: attempt.id,
      state: attempt.state,
      receipts: attempt.receipts.map(receipt => ({ criterionId: receipt.criterionId, status: receipt.status, exitCode: receipt.exitCode, capability: receipt.capability, reviewed: Boolean(receipt.reviewSubagentId), visualReview: receipt.visualReview?.status ?? null, acceptanceMode: receipt.acceptanceMode ?? null })),
    }));
    if (process.env.PI_TEST_BLENDER_EVIDENCE) fs.writeFileSync(process.env.PI_TEST_BLENDER_EVIDENCE, JSON.stringify({
      schemaVersion: 1,
      scope: "provider-free native fixture; not visual approval or live model acceptance",
      runtime,
      criticPath: { result, receipts, attemptSummary: attemptSummary(result) },
      measured: { result: measured, receipts: measuredReceipts, attemptSummary: attemptSummary(measured) },
      measuredFailingCriterion: { result: failing, attemptSummary: attemptSummary(failing) },
      measuredFailedReview: { result: reviewFailed, attemptSummary: attemptSummary(reviewFailed) },
      measuredUnavailableChecker: {
        unregisteredVerifier: { preflightAllowed: unregisteredPreflight.allowed, reasons: unregisteredPreflight.reasons, producerRuns: 0, runBlocked: true },
        pinnedSourceDrift: { preflightAllowed: driftedPreflight.allowed, reasons: driftedPreflight.reasons, restoredPreflightAllowed: measuredService.preflight(measuredGraph, { piContext }).allowed },
      },
      visionGate: { criticModeRoles: ["3d-critic"], measuredModeRoles: ["patch-reviewer"], criticInvocationsInMeasuredRuns: 0, criticReceiptsCarryVisualReview: true, measuredReceiptsCarryAcceptanceMode: "measured" },
      parentUnchanged: true,
      negatives: ["ambiguous-checker", "vertex-budget", "missing-glb", "transparent-preview", "measured-without-measured-checker", "measured-failing-criterion", "measured-failed-review", "measured-unregistered-checker", "measured-pinned-checker-drift", ...(blenderAi ? ["denied-dispatch", "stale-addon", "missing-animation"] : [])],
      transparentPreview: { ok: transparent.ok, exitCode: transparent.exitCode, output: transparent.stderr },
      blenderAi,
      animation,
      humanFeedback: "non-blocking",
      liveInference: false,
    }, null, 2) + "\n", { flag: "wx" });
    passed = true;
    console.log("✓ real contained cube creation, editable native round-trip, export/reimport, geometry/render checks; non-blocking feedback, optional pinned BlenderAI animation dispatch; measured acceptance skips the vision critique while the executable checks and the independent review stay mandatory");
  } finally {
    if (passed) fs.rmSync(cwd, { recursive: true, force: true });
    else console.error(`Native failure fixture retained: ${cwd}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
