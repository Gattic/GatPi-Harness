"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Verifier } = require("../src/verification-pipeline");
const {
  MemoryJsonStorage,
  RecordingSink,
  SessionStorageAttributionAdapter,
  roleResultContractLimits,
  createPiIntegrationBoundary,
} = require("../src/integration-boundary");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { EvidenceStore } = require("../src/evidence-binder");
const { tmpFixture } = require("./helpers/tmp-fixture");

assert.deepEqual(roleResultContractLimits(), { roadmapGoalMaxLength: 400, evidenceTextMaxLength: 2000, evidenceIdMaxLength: 128, evidenceItemsMax: 64, claimsMax: 48, analysisAssignmentsMax: 8, synthesisItemsMax: 32 }, "role result limits are exposed through the integration boundary");

(async () => {
  const storage = new MemoryJsonStorage();
  const sink = new RecordingSink();
  const tmp = tmpFixture("pi-boundary-");
  fs.writeFileSync(path.join(tmp, "file.js"), "function a() { return 1; }\n");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]); fs.writeFileSync(path.join(tmp, ".gitignore"), ".pi/\nsessions/\n"); git(["add", "file.js", ".gitignore"]); git(["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(tmp, "file.js"), "function a() { return 2; }\n");
  const sessionRoot = path.join(tmp, "sessions"); fs.mkdirSync(sessionRoot); fs.writeFileSync(path.join(sessionRoot, "fixture.jsonl"), `${JSON.stringify({ message: { role: "user", content: "adapter fixture" } })}\n`);
  const sessionStorageAdapter = new SessionStorageAttributionAdapter();
  const sessionStorage = await sessionStorageAdapter.attribute({ root: sessionRoot, observedAt: "2026-08-09T00:00:00.000Z" });
  assert.equal(sessionStorage.inventory.discoveredFiles, 1, "session storage attribution is exposed through the integration boundary");
  assert.equal(sessionStorage.pressure.mutation.sessionsChanged, false);
  assert.equal(sessionStorageAdapter.inspect({ root: sessionRoot }).privacy.contentRead, false, "metadata-only pressure inspection is exposed independently of content attribution");

  const verifier = new Verifier({
    id: "unit",
    kind: "unit",
    files: ["**/*"],
    run: async () => ({ ok: true, output: "ok" }),
  });

  const goalEvidenceStore = new EvidenceStore({ cwd: tmp });
  const goalProof = goalEvidenceStore.saveEvidence({ id: "evidence-boundary-goal", createdAt: "2026-07-31T12:00:01.000Z", ok: true, summary: "goal proof" });
  const pi = createPiIntegrationBoundary({
    storage,
    sink,
    verification: { verifiers: [verifier], options: { requiredKinds: ["unit"] } },
    branching: { cwd: tmp },
    goalEvidence: { cwd: tmp, store: goalEvidenceStore },
    learning: { cwd: tmp, root: path.join(tmp, ".pi", "learning-loop") },
  });
  assert.equal(pi.skillIntake.status().sourceMode, "local-staged-pinned-only", "governed skill intake is exposed through the integration boundary");
  assert.equal(pi.skillIntake.status().publishOperation, false);

  const trace = pi.trace.emit({ category: "session", name: "start" });
  assert.equal(trace.name, "start");
  assert.equal(storage.readJsonl("trace/events").length, 1, "trace persistence flows through injected storage");
  pi.trace.emit({ category: "session", name: "middle" });
  pi.trace.emit({ category: "session", name: "end" });
  const tracePruneDry = pi.trace.prune({ keep: 2, dryRun: true });
  assert.equal(tracePruneDry.wouldRemove, 1, "trace prune previews event retention");
  const tracePrune = pi.trace.prune({ keep: 2, dryRun: false });
  assert.equal(tracePrune.removed, 1, "trace prune removes old persisted trace events");
  assert.equal(storage.readJsonl("trace/events").length, 2, "trace prune rewrites jsonl retention window");

  const remembered = pi.memory.remember({ type: "semantic", title: "Boundary", content: "Pi core calls adapters, not library internals.", verification: "verified", confidence: 0.9 });
  assert.equal(remembered.accepted, true);
  assert.equal(pi.memory.retrieve("adapter boundary").entries.length, 1);
  pi.memory.persist();
  assert.equal(storage.readJson("cognitive-memory").entries.length, 1, "memory persists through injected storage");

  pi.context.upsert({ layer: "L1", title: "Contract", content: "Use integration adapters for context.", verification: "verified", protected: true });
  const pack = pi.context.pack({ tokenBudget: 100, query: "integration adapters" });
  assert(pack.text.includes("Contract"));
  pi.context.persist();
  assert.equal(storage.readJson("layered-context").blocks.length, 1, "context persists through injected storage");

  const diff = pi.anchoring.diff("function a() { return 1; }\n", "function a() { return 2; }\n", "file.js");
  assert(diff.changes.length > 0, "file anchoring/semantic diff works independently");

  const capturedChangeSet = await pi.verification.captureChangeSet({ cwd: tmp, files: ["file.js"] });
  assert.match(capturedChangeSet.fingerprint, /^change-set-v2:sha256:/, "working-tree capture is exposed through the verification adapter");
  assert.equal(capturedChangeSet.before, undefined, "the adapter does not expose aggregate source maps");
  const evidence = await pi.verification.verify({ cwd: tmp, patchSet: { id: "p", files: ["file.js"] }, changeSet: capturedChangeSet });
  assert.equal(evidence.ok, true, "verification adapter runs with injected verifier");
  assert(evidence.evidenceFile.startsWith("memory://"), "verification evidence uses injected memory storage");
  assert.equal(pi.visualVerification.readiness({ profile: "full" }).status, "not-applicable", "visual verification is exposed through the integration boundary");
  assert.equal((await pi.visualVerification.run({ profile: "full" })).status, "not-applicable");
  const rolloutStatus = pi.rolloutCenter.status();
  assert.equal(rolloutStatus.posture, "observation-only", "rollout aggregation crosses the integration boundary");
  assert.equal(rolloutStatus.privacy.containsAbsolutePaths, false);

  const entropy = pi.entropy.observe({ type: "objective", text: "keep adapters clean", contextBudgetTokens: 200 });
  assert(Number.isFinite(entropy.metrics.entropyScore));
  assert.equal(storage.readJsonl("entropy/events").length, 1, "entropy events use injected persistence");

  const settledPacket = pi.executionOutcomes.buildLoop({
    runId: "loop_boundary_fixture",
    sourceSchemaVersion: 3,
    sourceRecord: { id: "loop_boundary_fixture", status: "completed" },
    terminalState: "completed",
    taskText: "adapter contract fixture",
    taskClass: "verification",
    workflow: { steps: [], toolNames: ["verification_center"], retries: 0 },
    evidenceRefs: [], artifactRefs: [], metrics: {}, producerVersion: "boundary-test", projectKey: "pi:fixture",
    settledAt: "2026-07-31T12:00:00.000Z",
  });
  const settledSave = pi.executionOutcomes.save(settledPacket);
  assert.equal(settledSave.persisted, true, "execution outcome packets persist only through their boundary adapter");
  assert.equal(storage.readJsonl("execution-outcomes/index").length, 1, "outcome adapter uses injected storage");
  assert.equal(pi.executionOutcomes.packets().length, 1);
  const goalProofCheck = pi.goalEvidence.validateCompletion({ evidenceIds: [goalProof.id], goalCreatedAt: "2026-07-31T12:00:00.000Z" });
  assert.equal(goalProofCheck.ok, true, "goal proof checks flow through a body-free integration-boundary adapter");
  assert.equal("evidence" in goalProofCheck.results[0], false);
  const learningOutcome = pi.learning.captureExecutionOutcome(settledPacket);
  assert.equal(learningOutcome.source, "execution", "lazy learning adapter accepts settled packets without a top-level import cycle");
  const skillCapture = pi.skills.captureExecutionOutcome(settledPacket);
  assert.match(skillCapture.captureId, /^cap_exec_/, "skill adapter captures only normalized execution metadata");
  assert.equal(pi.skills.captureExecutionOutcome(settledPacket).duplicate, true);
  const provenance = pi.provenance.build({ seedIds: [settledPacket.packetId], depth: 3, maxNodes: 100, maxEdges: 200 });
  assert.equal(provenance.boundaries.metadataOnly, true, "unified provenance is exposed as a metadata-only boundary adapter");
  assert(provenance.nodes.some((node) => node.id === `execution:${settledPacket.packetId}`));
  assert.doesNotMatch(JSON.stringify(provenance), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "provenance omits absolute paths");
  const maintenance = pi.memoryMaintenance.preview({ write: false, maxCandidates: 20 });
  assert.equal(maintenance.preview, true, "maintenance preview is exposed through the integration boundary");
  assert.equal(maintenance.boundaries.memoryWritten, false);
  const compounding = pi.compounding.generate({ write: false });
  assert.equal(compounding.decision, "no-go-deferred", "compounding scorecards cannot raise rollout authority");
  assert.equal(compounding.highestAuthorizedProjectMemoryStage, "M0");
  assert.equal(compounding.cohorts.comparison.status, "insufficient-data");
  const drained = await pi.executionOutcomes.drain("boundary-fixture", () => ({ ok: true }));
  assert.equal(drained.processed, 1, "execution adapter exposes idempotent consumer draining");
  assert.equal((await pi.executionOutcomes.drain("boundary-fixture", () => ({ ok: true }))).processed, 0);

  const reasoning = pi.reasoning.createPlan({ objective: "Implement an adapter boundary", steps: ["define contracts", "verify evidence"] });
  assert.equal(reasoning.type, "plan", "reasoning adapter records explicit plan artifacts");
  const orchestration = await pi.orchestration.coordinate("Implement an adapter boundary", { steps: ["define contracts"] });
  assert.equal(orchestration.kind, "reasoning.scaffold", "legacy orchestration name now creates scaffold artifacts only");

  assert.equal(pi.topologies.listRoles().find((role) => role.roleId === "coder").contractVersion, "role-v2", "integration boundary exposes canonical role-v2 contracts");
  assert(pi.topologies.listTopologies().some((topology) => topology.topologyId === "planner-coder-verifier" && topology.metadata?.provenance?.source === "builtin"), "integration boundary installs safe built-in topology defaults");
  assert(pi.topologies.discoverRoles().some((role) => role.roleId === "patch-reviewer" && role.workspacePolicy === "isolated-worktree"));
  assert(pi.topologies.discoverRoles().every((role) => role.systemPrompt === undefined), "role discovery omits model prompts");
  const workerRecommendation = pi.topologies.recommendRole("worker", { env: { PI_ROLE_MODEL_WORKER: "openai-codex/gpt-6-astra", PI_ROLE_THINKING_WORKER: "low" } });
  assert.deepEqual(workerRecommendation, { schemaVersion: 1, roleId: "worker", model: "openai-codex/gpt-6-astra", thinkingLevel: "low", workspacePolicy: "shared-readonly", mutationPolicy: "forbidden", autoRoutePolicy: "suggest", execute: false, advisoryOnly: true }, "integration boundary exposes the configured worker profile as a non-executing recommendation");
  assert.throws(() => pi.topologies.recommendRole("reviewer", { env: { PI_ROLE_MODEL_REVIEWER: "openai-codex/gpt-6-astra", PI_ROLE_THINKING_REVIEWER: "xhigh" } }), /not eligible for suggest-only recommendation/);
  assert.equal(pi.topologies.engine.subagentExecutor.service, pi.subagents.service, "topology workers reuse the boundary subagent service and its injected state store");
  assert.deepEqual(pi.topologies.roadmapHandoffs({
    runId: "toprun-parent-handoff",
    topologyId: "planner-coder-verifier",
    status: "failed",
    roadmapApplications: [{ applied: true, plannerNodeId: "plan", roadmapId: "roadmap-parent-handoff", parentRoadmapId: "roadmap-parent", parentItemId: "item-parent", planFingerprint: "plan-fingerprint", roadmapFingerprint: "roadmap-fingerprint", itemCount: 6 }],
    roadmapReconciliations: [{ plannerNodeId: "plan", topologyStatus: "failed", reconciliationStatus: "succeeded", outcome: "shelved", roadmapId: "roadmap-parent-handoff", itemCount: 6 }],
  }), [{
    runId: "toprun-parent-handoff",
    topologyId: "planner-coder-verifier",
    plannerNodeId: "plan",
    roadmapId: "roadmap-parent-handoff",
    parentRoadmapId: "roadmap-parent",
    parentItemId: "item-parent",
    planFingerprint: "plan-fingerprint",
    roadmapFingerprint: "roadmap-fingerprint",
    topologyStatus: "failed",
    reconciliationStatus: "succeeded",
    outcome: "shelved",
    itemCount: 6,
    requiresParentFollowThrough: true,
  }], "integration boundary preserves the exact compact roadmap binding needed by parent follow-through");
  assert.equal(pi.topologies.roadmapHandoffs({
    runId: "toprun-complete-handoff",
    topologyId: "planner-coder-verifier",
    status: "succeeded",
    roadmapApplications: [{ applied: true, plannerNodeId: "plan", roadmapId: "roadmap-complete" }],
    roadmapReconciliations: [{ plannerNodeId: "plan", reconciliationStatus: "succeeded", outcome: "completed" }],
  })[0].requiresParentFollowThrough, false, "completed delegated hierarchies do not request redundant parent reconciliation");
  assert.equal(typeof pi.subagents.preflight, "function");
  assert.equal(typeof pi.subagents.launchSubagent, "function");
  assert.equal(typeof pi.subagents.waitSubagent, "function");
  assert.equal(typeof pi.subagents.steerSubagent, "function");
  assert.equal(typeof pi.subagents.interruptSubagent, "function");
  assert.equal(typeof pi.subagents.continueSubagent, "function");
  assert.equal(typeof pi.sessionSearch.search, "function");
  assert.equal(pi.memorySafety.scan("verified durable note").safe, true);
  assert.equal(typeof pi.subagents.previewSubagentPatch, "function", "integration boundary exposes explicit patch preview");
  assert.equal(typeof pi.subagents.applySubagentPatch, "function", "integration boundary exposes explicit verified patch apply");

  const branch = pi.branching.createBranch({ type: "verification", name: "boundary-check", states: { memoryState: pi.memory.metrics(), contextState: entropy.metrics, verifierState: evidence } });
  assert(branch.id.startsWith("br_"));
  assert.equal(pi.branching.list().length, 1, "branching uses injected branch store");

  const fileBacked = createPiIntegrationBoundary({ storage: new FileIntegrationStorage(path.join(tmp, ".pi", "boundary-file-storage")), sink: new RecordingSink(), branching: { cwd: tmp } });
  const fileBranch = fileBacked.branching.createBranch({ type: "multi-agent", name: "file-backed-list", states: { contextState: { transcript: [{ role: "user", content: "PRIVATE_BRANCH_TRANSCRIPT" }], decision: "safe summary" } } });
  assert.equal(fileBacked.branching.list().length, 1, "file-backed branch stores are listable after reload/navigation");
  assert.doesNotMatch(JSON.stringify(fileBacked.branching.getSnapshot(fileBranch.headSnapshotId)), /PRIVATE_BRANCH_TRANSCRIPT/, "storage-backed branch snapshots use the same recovery sanitizer");
  const exportPacket = fileBacked.branching.exportBranch(fileBranch.id);
  assert.equal(exportPacket.exportPolicy, "metadata-only; recovery payload remains local");
  assert.doesNotMatch(JSON.stringify(exportPacket), /safe summary|contextState|filesystemState/, "branch exports never expose local recovery state");
  const cleanupPreview = fileBacked.branching.cleanup({ apply: false, olderThanMs: 0 });
  assert.equal(cleanupPreview.result.dryRun, true);
  assert.equal(cleanupPreview.plan.policy.lineageProtected, true);

  assert(sink.events.some((e) => e.type === "trace.event"), "logging/tracing flows through injected sink");

  const disabled = createPiIntegrationBoundary({ enabled: false, storage: new MemoryJsonStorage(), sink: new RecordingSink(), branching: { cwd: tmp } });
  assert.equal(disabled.trace.emit({ name: "x" }).enabled, false);
  assert.equal(disabled.memory.remember({}).enabled, false);
  assert.equal(disabled.memorySafety.scan("x").safe, false);
  assert.equal(disabled.sessionSearch.search("query").outcome, "disabled");
  assert.equal(disabled.context.pack({}).blocks.length, 0);
  assert.equal(disabled.anchoring.diff("a", "b").enabled, false);
  assert.equal((await disabled.verification.verify({})).enabled, false);
  assert.equal(disabled.visualVerification.readiness({}).enabled, false);
  assert.equal(disabled.rolloutCenter.snapshot().enabled, false);
  assert.equal(disabled.entropy.observe({}).enabled, false);
  assert.equal(disabled.executionOutcomes.save({}).enabled, false);
  assert.deepEqual(disabled.executionOutcomes.list(), []);
  assert.equal(disabled.goalController.dispatch({ kind: "inspect", targetKind: "status", targetRef: "goal-current" }, {}).ok, false);
  assert.equal(disabled.goalEvidence.validateCompletion({ evidenceIds: [goalProof.id] }).ok, false);
  assert.equal(disabled.learning.status().enabled, false);
  assert.equal(disabled.provenance.status().enabled, false);
  assert.equal(disabled.memoryMaintenance.status().enabled, false);
  assert.equal(disabled.compounding.status().enabled, false);
  assert.equal((await disabled.orchestration.coordinate("x")).enabled, false);
  assert.deepEqual(disabled.branching.list(), []);

  console.log("integration-boundary tests passed");
})();
