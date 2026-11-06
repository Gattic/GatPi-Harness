"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MemoryJsonStorage, RecordingSink, createPiIntegrationBoundary } = require("../src/integration-boundary");
const { ExecutionCapture, Skill, FailurePattern, SkillSynthesisEngine, discoverNativeAgentSkills, captureFromTopologyRun, captureFromTrace, captureFromExecutionOutcome, skillFromCaptures, captureSimilarity, skillSimilarity, isUnsafeSkill, explicitSkillCommandName, skillSettlementOutcome } = require("../src/skill-synthesis");
const { sha256, buildLoopOutcomePacket } = require("../src/execution-outcome");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const topologyRun = {
    runId: "toprun_ok",
    topologyId: "planner-coder-verifier",
    status: "succeeded",
    durationMs: 1200,
    input: { task: "Fix failing parser tests" },
    results: [
      { nodeId: "plan", role: "planner", status: "succeeded", summary: "Plan parser repair" },
      { nodeId: "code", role: "coder", status: "succeeded", summary: "Patch parser" },
      { nodeId: "verify", role: "verifier", status: "succeeded", summary: "Tests passed", attempts: 1 },
    ],
    trace: [{ type: "topology.tool_call", payload: { tool: "read" } }, { type: "topology.tool_call", payload: { tool: "bash" } }],
    aggregation: { summary: "parser fixed and verified" },
    errors: [],
  };

  const capture = captureFromTopologyRun(topologyRun, { repository: { name: "pi-harness" }, verification: { ok: true, commands: ["node tests/parser.test.js"] } });
  assert(capture instanceof ExecutionCapture);
  assert.equal(capture.outcome, "succeeded");
  assert.equal(capture.toolSequence.length, 2);
  assert(capture.score > 0.7, "successful verified capture receives high score");

  const traceCapture = captureFromTrace([
    { category: "prompt_assembly", name: "before_agent_start", payload: { prompt: "Refactor prompt suggestions" } },
    { category: "tool_exposure", name: "tool_call", payload: { toolName: "read" } },
    { category: "file_edit", name: "tool_execution_end", payload: { toolName: "edit" } },
    { category: "verifier_result", name: "tests", payload: { ok: true } },
  ]);
  assert.equal(traceCapture.outcome, "succeeded");
  assert.equal(traceCapture.toolSequence.length, 2);

  const failed = new ExecutionCapture({ task: "Debug broken command", outcome: "failed", toolSequence: [{ tool: "bash" }], failures: [{ message: "tests failed" }], retries: 2 });
  assert(failed.score < capture.score, "failed captures score lower than successful captures");

  const skill = skillFromCaptures([capture], { name: "Parser repair workflow" });
  assert(skill instanceof Skill);
  assert.equal(skill.name, "Parser repair workflow");
  assert.equal(skill.status, "candidate");
  assert(skill.requiredTools.includes("read"));
  assert(skill.workflowSteps.some((s) => s.role === "verifier"));
  assert(skill.provenance.captureIds.includes(capture.captureId));

  const storage = new MemoryJsonStorage();
  const sink = new RecordingSink();
  const boundary = createPiIntegrationBoundary({ storage, sink, skills: { options: { loadNative: false } } });
  assert(boundary.skills, "integration boundary exposes skills adapter");
  assert(boundary.skills.listSkills({}).some((s) => s.skillId === "skill_curated_debug_verify"), "curated first-party skill pack is loaded");

  const nativeRoot = tmpFixture("pi-native-skills-");
  fs.mkdirSync(path.join(nativeRoot, "code-review"), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, "code-review", "SKILL.md"), "---\nname: code-review\ndescription: Review code changes safely\n---\n# Code Review\nCheck the diff and verify tests.\n");
  const native = discoverNativeAgentSkills({ cwd: nativeRoot, dirs: [nativeRoot] });
  const nativeCached = discoverNativeAgentSkills({ cwd: nativeRoot, dirs: [nativeRoot] });
  assert.equal(native.length, 1, "native Agent Skills are discovered from SKILL.md");
  assert.equal(nativeCached[0].skillId, native[0].skillId, "native Agent Skills discovery is deterministic and cacheable");
  assert.equal(native[0].governance.command, "/skill:code-review");
  const nativeBoundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), skills: { options: { loadCurated: false, nativeDirs: [nativeRoot] } } });
  const nativeSkill = nativeBoundary.skills.listSkills({ limit: Infinity }).find((s) => s.governance?.nativeAgentSkill && s.governance.command === "/skill:code-review");
  assert(nativeSkill, "native Agent Skills are registered as provider records");
  assert.equal(explicitSkillCommandName("/skill:code-review inspect this diff"), "code-review");
  assert.equal(explicitSkillCommandName("Review this diff"), null);
  assert.deepEqual(nativeBoundary.skills.resolveExplicitInvocation("/skill:code-review inspect this diff"), [nativeSkill.skillId], "explicit native skill commands resolve to the invoked provider record");
  assert.deepEqual(nativeBoundary.skills.resolveExplicitInvocation("Review this diff using any relevant guidance"), [], "natural-language advisory retrieval is not an explicit skill invocation");
  assert.deepEqual(nativeBoundary.skills.resolveExplicitInvocation("/skill:missing inspect this diff"), [], "unknown skill commands do not evaluate unrelated skills");
  const duplicateNativeRoot = tmpFixture("pi-native-skills-duplicate-");
  fs.mkdirSync(path.join(duplicateNativeRoot, "code-review"), { recursive: true });
  fs.writeFileSync(path.join(duplicateNativeRoot, "code-review", "SKILL.md"), "---\nname: code-review\ndescription: Another skill with the same command\n---\n# Duplicate Code Review\n");
  const duplicateNativeBoundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), skills: { options: { loadCurated: false, nativeDirs: [nativeRoot, duplicateNativeRoot] } } });
  assert.deepEqual(duplicateNativeBoundary.skills.resolveExplicitInvocation("/skill:code-review inspect this diff"), [], "ambiguous duplicate native skill records remain neutral instead of evaluating the wrong record");
  assert.deepEqual(skillSettlementOutcome({ stopReason: "stop" }), { eligible: true, ok: true, stopReason: "stop", toolError: false, failureSignal: false });
  assert.equal(skillSettlementOutcome({ stopReason: "toolUse" }).ok, true, "a terminating tool-use response may settle successfully");
  assert.equal(skillSettlementOutcome({ stopReason: "length" }).eligible, false, "output truncation stays neutral until continuation settles");
  assert.equal(skillSettlementOutcome({ stopReason: "error" }).eligible, false, "provider failures are not evidence against the invoked skill");
  assert.equal(skillSettlementOutcome({ stopReason: "aborted" }).eligible, false, "user aborts are neutral skill outcomes");
  assert.equal(skillSettlementOutcome({ stopReason: "stop", toolError: true }).ok, false);
  assert.equal(skillSettlementOutcome({ stopReason: "stop", failureSignal: true }).ok, false);

  const selectorRoot = tmpFixture("pi-native-selection-");
  for (const [dir, name, description] of [
    ["build", "build", "Configure C++ build systems and compiler settings"],
    ["durable-bug-hunt", "durable-bug-hunt", "Diagnose and repair bugs through evidence, durable attempts, and verification"],
    ["handoff", "handoff", "Write durable continuation notes for another agent"],
    ["code-review", "code-review", "Review code changes for correctness, safety, and maintainability"],
    ["security", "security", "Review security, secrets, auth, permissions, and vulnerabilities"],
    ["subsystem-plan", "subsystem-plan", "Create an execution program for a large subsystem"],
    ["audit", "audit", "Audit a subsystem for production readiness"],
    ["api-design", "api-design", "Design and evolve internal C++ APIs and module boundaries"],
    ["perf", "perf", "Profile, benchmark, and optimize C++ code with measured evidence"],
    ["observability", "observability", "Design structured logging and runtime diagnostics for C++ systems"],
    ["test-design", "test-design", "Design test strategies and regression test cases"],
    ["concurrency", "concurrency", "Design and review concurrent C++ threading, atomics, locks, and race safety"],
    ["frontier-math-proof-engineering", "frontier-math-proof-engineering", "Lean proof-engineering, certificate bridges, finite diagnostics, ledgers, and strict claim boundaries"],
    ["research-framework-design", "research-framework-design", "Design rigorous mathematical research frameworks"],
    ["experiment-gate-lifecycle", "experiment-gate-lifecycle", "Pre-register experiments, run validity gates, and record ship or no-go closure"],
  ]) {
    fs.mkdirSync(path.join(selectorRoot, dir), { recursive: true });
    fs.writeFileSync(path.join(selectorRoot, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  }
  const selectorBoundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), skills: { options: { loadCurated: false, nativeDirs: [selectorRoot] } } });
  const datasetDownloadTask = "Just like our pile data, download https://huggingface.co/datasets/HuggingFaceFW/fineweb and save it onto the drive labeled AI1.";
  const datasetTelemetry = selectorBoundary.skills.suggest(datasetDownloadTask, { minScore: 0, limit: 30 }).suggestions;
  for (const name of ["Native Agent Skill: durable-bug-hunt", "Native Agent Skill: test-design", "Native Agent Skill: audit", "Native Agent Skill: build", "Native Agent Skill: subsystem-plan", "Native Agent Skill: handoff", "Native Agent Skill: code-review", "Native Agent Skill: security"]) {
    const row = datasetTelemetry.find((s) => s.name === name);
    assert(row && row.score === 0 && row.why.selectionRule === "dataset-or-pretokenization-task", `dataset transfer tasks suppress stale selector ${name}`);
  }
  const pretokenizeTask = "We should do option 3: pretokenize the FineWeb parquet dataset into Glades .tok.bin shards.";
  const pretokenizeTelemetry = selectorBoundary.skills.suggest(pretokenizeTask, { minScore: 0, limit: 30 }).suggestions;
  for (const name of ["Native Agent Skill: durable-bug-hunt", "Native Agent Skill: handoff", "Native Agent Skill: audit", "Native Agent Skill: subsystem-plan", "Native Agent Skill: experiment-gate-lifecycle"]) {
    const row = pretokenizeTelemetry.find((s) => s.name === name);
    assert(row && row.score === 0 && row.why.selectionRule === "dataset-or-pretokenization-task", `pretokenization tasks suppress stale selector ${name}`);
  }
  const statusTelemetry = selectorBoundary.skills.suggest("Give a status report", { minScore: 0, limit: 30 }).suggestions;
  for (const name of ["Native Agent Skill: durable-bug-hunt", "Native Agent Skill: handoff", "Native Agent Skill: perf", "Native Agent Skill: code-review", "Native Agent Skill: subsystem-plan", "Native Agent Skill: build"]) {
    const row = statusTelemetry.find((s) => s.name === name);
    assert(row && row.score === 0 && row.why.selectionRule === "routine-status-report", `routine status reports suppress stale selector ${name}`);
  }
  assert(selectorBoundary.skills.suggest("Run a build smoke test for the FineWeb pretokenization worker").suggestions.some((s) => s.name === "Native Agent Skill: build"), "explicit build work near FineWeb still keeps build available");
  const smallDocTask = "Review the docs diff for consistency, then commit the markdown update.";
  const phaseDocTask = "Review the Phase XII diff for consistency, then commit the HDI reduction updates.";
  const smallDocSuggestions = selectorBoundary.skills.suggest(smallDocTask).suggestions;
  assert(!smallDocSuggestions.some((s) => ["Native Agent Skill: build", "Native Agent Skill: subsystem-plan", "Native Agent Skill: audit"].includes(s.name)), "small doc review+commit tasks suppress broad native skills");
  const suppressed = selectorBoundary.skills.suggest(phaseDocTask, { minScore: 0, limit: 10 }).suggestions;
  assert(suppressed.filter((s) => ["Native Agent Skill: build", "Native Agent Skill: subsystem-plan", "Native Agent Skill: audit"].includes(s.name)).every((s) => s.score === 0 && s.why.selectionRule === "small-doc-review-commit-task"), "suppressed skills expose selection-rule telemetry");
  const sourceReview = selectorBoundary.skills.suggest("Review the source diff for consistency, then commit the JS update.", { minScore: 0, limit: 10 }).suggestions;
  assert(sourceReview.filter((s) => ["Native Agent Skill: build", "Native Agent Skill: subsystem-plan", "Native Agent Skill: audit"].includes(s.name)).every((s) => s.why.selectionRule !== "small-doc-review-commit-task"), "generic source review+commit tasks are not classified as doc review+commit");
  const noisyDiffTask = "Review the skill-synthesis diff for edge cases, rerun tests, then commit the changes if clean.";
  const noisyTargets = ["Native Agent Skill: audit", "Native Agent Skill: perf", "Native Agent Skill: observability", "Native Agent Skill: test-design", "Native Agent Skill: research-framework-design"];
  assert(!selectorBoundary.skills.suggest(noisyDiffTask).suggestions.some((s) => noisyTargets.includes(s.name)), "routine diff review+test+commit tasks suppress noisy native selectors");
  const noisyTelemetry = selectorBoundary.skills.suggest(noisyDiffTask, { minScore: 0, limit: 20 }).suggestions;
  assert(noisyTargets.every((name) => noisyTelemetry.some((s) => s.name === name && s.score === 0 && s.why.selectionRule === "small-diff-review-commit-task")), "routine diff review+commit suppressions expose selector telemetry");
  const goalFailureTask = "Investigate why goal_20260525174336_tskoyq was blocked and fix the pi-harness runner.";
  const goalFailureTelemetry = selectorBoundary.skills.suggest(goalFailureTask, { minScore: 0, limit: 20 }).suggestions;
  for (const name of ["Native Agent Skill: audit", "Native Agent Skill: perf", "Native Agent Skill: observability"]) {
    const row = goalFailureTelemetry.find((s) => s.name === name);
    assert(row && row.score === 0 && row.why.selectionRule === "goal-or-skill-failure-investigation", "goal/skill failure investigations suppress stale native selectors");
  }
  assert(!selectorBoundary.skills.suggest("Majorly increase rendering performance with perf stat and nsys profiling").suggestions.some((s) => s.name === "Native Agent Skill: audit"), "performance profiling tasks do not imply audit work");
  assert(!selectorBoundary.skills.suggest("Majorly increase rendering performance with perf stat and nsys profiling").suggestions.some((s) => s.name === "Native Agent Skill: observability"), "performance profiling tasks do not imply observability work");
  assert(selectorBoundary.skills.suggest("Majorly increase rendering performance with perf stat and nsys profiling").suggestions.some((s) => s.name === "Native Agent Skill: perf"), "perf still matches explicit profiling tasks");
  assert(selectorBoundary.skills.suggest("Design structured logging and runtime diagnostics for the MCP server").suggestions.some((s) => s.name === "Native Agent Skill: observability"), "observability still matches explicit diagnostics tasks");
  assert(selectorBoundary.skills.suggest("Fix the C++ build system compile failure").suggestions.some((s) => s.name === "Native Agent Skill: build"), "build skill still matches build tasks");
  assert(selectorBoundary.skills.suggest("Create an execution program for a large subsystem refactor").suggestions.some((s) => s.name === "Native Agent Skill: subsystem-plan"), "subsystem-plan still matches large subsystem tasks");
  assert(selectorBoundary.skills.suggest("Audit the networking subsystem production readiness").suggestions.some((s) => s.name === "Native Agent Skill: audit"), "audit still matches explicit audit tasks");
  const apiBoundarySuggestions = selectorBoundary.skills.suggest("Design the RagdollAssetBridge API boundary and evolution plan").suggestions;
  assert(apiBoundarySuggestions.some((s) => s.name === "Native Agent Skill: api-design"), "api-design still matches explicit API boundary tasks");
  assert(!apiBoundarySuggestions.some((s) => s.name === "Native Agent Skill: audit"), "API boundary tasks do not imply audit work");
  assert(!apiBoundarySuggestions.some((s) => s.name === "Native Agent Skill: observability"), "API boundary tasks do not imply observability work");
  assert(selectorBoundary.skills.suggest("Design regression tests for skill selection edge cases").suggestions.some((s) => s.name === "Native Agent Skill: test-design"), "test-design still matches explicit test-design tasks");
  assert(selectorBoundary.skills.suggest("Review concurrent C++ thread safety around mutexes and std::atomic queues").suggestions.some((s) => s.name === "Native Agent Skill: concurrency"), "concurrency still matches explicit thread-safety tasks");
  assert(selectorBoundary.skills.suggest("Review concurrent C++ thread safety in the Lean proof worker mutexes", { minScore: 0, limit: 20 }).suggestions.some((s) => s.name === "Native Agent Skill: concurrency" && s.score > 0), "explicit thread-safety intent keeps concurrency available even near proof-engineering terms");
  assert(selectorBoundary.skills.suggest("Design a rigorous mathematical research framework for a conjecture").suggestions.some((s) => s.name === "Native Agent Skill: research-framework-design"), "research-framework-design still matches explicit research framework tasks");
  assert(selectorBoundary.skills.suggest("Run an experiment gate lifecycle: pre-register bars, execute prototype arms, record gate verdicts, then close ship or no-go").suggestions.some((s) => s.name === "Native Agent Skill: experiment-gate-lifecycle"), "experiment-gate-lifecycle matches explicit gated experiment tasks");
  const mathProofTask = "Implement the full-DB1 branch-equation normal-form probe targeting recurrence state/trace-defect variables, run validation, update docs/ledger, and commit. Use either the frontier-math-proof-engineering or research framework design skill when relevant";
  const mathProofTelemetry = selectorBoundary.skills.suggest(mathProofTask, { minScore: 0, limit: 20 }).suggestions;
  assert.equal(mathProofTelemetry[0]?.name, "Native Agent Skill: frontier-math-proof-engineering", "math proof-engineering implementation tasks prefer the proof-engineering skill");
  assert.equal(mathProofTelemetry[0]?.why.selectionRule, "math-proof-engineering-implementation-task", "proof-engineering preference is attributable in telemetry");
  for (const name of ["Native Agent Skill: concurrency", "Native Agent Skill: research-framework-design", "Native Agent Skill: experiment-gate-lifecycle"]) {
    const row = mathProofTelemetry.find((s) => s.name === name);
    assert(row && row.score === 0 && row.why.selectionRule === "math-proof-engineering-implementation-task", "math proof-engineering implementation tasks suppress stale concurrency/research-framework selectors");
  }
  const staleNativeTargets = ["Native Agent Skill: audit", "Native Agent Skill: api-design", "Native Agent Skill: observability"];
  const staleNativeRegressionCases = [
    ["skill failure evidence inspection", "Inspect the 3 recent native skill failures (native02f43aedab23, native29677b2ca517, native7b2da5e16804), summarize evidence/root causes, and recommend whether to patch selectors/tests."],
    ["routine diff review/test/commit", "Run the pi-harness test suite and review the skill-synthesis diff; if it passes and the gating logic looks right, commit the fix with a clear message."],
    ["generic phase implementation", "Implement Phase 1 from the ragdoll remediation plan, keep changes minimal, and run the relevant unit/runtime tests."],
    ["unit-test failure inspection", "Run the ragdoll unit tests and inspect any failures from the asset/sidecar refactor."],
  ];
  const staleNativeMisroutes = [];
  for (const [label, query] of staleNativeRegressionCases) {
    const rows = selectorBoundary.skills.suggest(query, { minScore: 0, limit: 20 }).suggestions;
    for (const name of staleNativeTargets) {
      const row = rows.find((s) => s.name === name);
      if (row && row.score > 0) staleNativeMisroutes.push({ label, name, score: Number(row.score.toFixed(3)), selectionRule: row.why.selectionRule || "none" });
    }
  }
  assert.deepEqual(staleNativeMisroutes, [], "recent stale native selector failure patterns should stay suppressed unless explicitly requested");

  const savedCapture = boundary.skills.capture(capture);
  assert.equal(savedCapture.captureId, capture.captureId);
  boundary.skills.capture(failed);
  const executionPacket = buildLoopOutcomePacket({ runId: "loop_skill_fixture", sourceSchemaVersion: 3, sourceRecord: { id: "loop_skill_fixture", status: "completed" }, terminalState: "completed", taskHash: sha256("private skill-capture prompt"), workflow: { steps: [{ kind: "iteration", status: "succeeded" }], toolNames: ["test_runner"], retries: 0 }, evidenceRefs: ["evidence_skill_fixture"], metrics: { iterations: 1, toolCalls: 1, modelCalls: 1 }, projectKeyHash: sha256("pi:fixture"), producerVersion: "test-fixture", settledAt: "2026-07-31T12:00:00.000Z" });
  const convertedExecution = captureFromExecutionOutcome(executionPacket);
  assert.equal(convertedExecution.prompt, null);
  assert.doesNotMatch(JSON.stringify(convertedExecution), /private skill-capture prompt/);
  const executionCapture = boundary.skills.captureExecutionOutcome(executionPacket);
  const duplicateExecutionCapture = boundary.skills.captureExecutionOutcome(executionPacket);
  assert.equal(duplicateExecutionCapture.duplicate, true);
  assert.equal(boundary.skills.listCaptures({ limit: Infinity }).filter((row) => row.captureId === executionCapture.captureId).length, 1, "one packet creates at most one skill capture");
  assert.equal(boundary.skills.listSkills({ limit: Infinity }).filter((row) => row.provenance?.captureIds?.includes(executionCapture.captureId)).length, 0, "settled capture never auto-synthesizes a skill");
  const synthesized = boundary.skills.synthesize({ minRepeats: 1, approve: true });
  assert(synthesized.skills.length >= 1);
  const savedSkill = synthesized.skills.find((s) => s.provenance.captureIds.includes(capture.captureId));
  assert(savedSkill, "synthesized skill includes successful capture provenance");

  const retrieved = boundary.skills.retrieve("Fix parser tests with planner coder verifier", { tools: ["read", "bash"], includeDrafts: true });
  assert(retrieved.skills.some((s) => s.skillId === savedSkill.skillId), "retrieval finds relevant synthesized skill");
  assert(retrieved.ranked[0].why, "retrieval explains score factors");

  const injection = boundary.skills.injectPacket(savedSkill.skillId);
  assert.equal(injection.kind, "skill.injection");
  assert(injection.guidance.includes("Plan parser repair"));

  const savedEventsBeforeEvaluate = storage.readJsonl("skills/events").filter((e) => e.type === "skill.saved" && e.skillId === savedSkill.skillId).length;
  const evaluated = boundary.skills.evaluate(savedSkill.skillId, { ok: true });
  const savedEventsAfterEvaluate = storage.readJsonl("skills/events").filter((e) => e.type === "skill.saved" && e.skillId === savedSkill.skillId).length;
  assert.equal(savedEventsAfterEvaluate, savedEventsBeforeEvaluate, "skill evaluation should not duplicate skill.saved index entries");
  assert(evaluated.successMetrics.attempts >= savedSkill.successMetrics.attempts);
  assert(evaluated.confidenceScore >= savedSkill.confidenceScore || evaluated.confidenceScore > 0.5);

  const approved = boundary.skills.approve(savedSkill.skillId, { minConfidence: 0.1 });
  assert.equal(approved.status, "approved");

  const replay = boundary.skills.replay(capture.captureId);
  assert.equal(replay.captureId, capture.captureId);
  assert(replay.steps.some((s) => s.type === "tool"), "capture replay exposes workflow/tool timeline");

  const ab = boundary.skills.abTest(savedSkill.skillId, "Fix parser tests", { score: 0.2 });
  assert.equal(ab.mode, "sandbox-advisory");
  assert.equal(ab.recommendation, "use-skill");

  const topology = boundary.skills.synthesizeTopologyTemplate(savedSkill.skillId);
  assert.equal(topology.metadata.synthesizedFromSkill, savedSkill.skillId);
  assert(topology.nodes.length >= 1);
  assert.equal(topology.schemaVersion, 3);
  assert.equal(topology.contractVersion, "role-v2");
  assert.equal(topology.metadata.requiresTypedResults, true);
  const implementationNodes = topology.nodes.filter((node) => node.mutationPolicy === "proposed-patch");
  if (implementationNodes.length) {
    assert(topology.metadata.roadmapPlanGate?.plannerNodeId, "synthesized implementation topology has a parent roadmap application gate");
    assert.deepEqual(new Set(topology.metadata.roadmapPlanGate.beforeNodeIds), new Set(implementationNodes.map((node) => node.id)));
    assert(topology.nodes.find((node) => node.id === topology.metadata.roadmapPlanGate.plannerNodeId)?.outputSchema?.required?.includes("roadmapPlan"));
  }
  for (const node of topology.nodes) {
    assert(node.roleContractVersion === "role-v2");
    assert(node.budget?.maxModelCalls >= 0 && node.budget?.maxToolCalls >= 0);
    assert(node.outputSchema?.type === "object");
    if (node.workspacePolicy === "handler-only") assert.equal(node.executionMode, "handler");
    else assert.equal(node.executionMode, "subagent");
    if (node.mutationPolicy !== "forbidden") assert.equal(node.workspacePolicy, "isolated-worktree");
  }

  const provider = boundary.skills.registerProvider({ providerId: "repo-provider", skills: [{ name: "Repo docs skill", description: "Update docs then verify evidence", category: "documentation", triggerConditions: ["docs"], workflowSteps: [{ description: "Edit docs" }, { description: "Verify docs evidence" }], validationStrategy: { kind: "evidence", requiredEvidence: ["docs review"] }, confidenceScore: 0.9 }] });
  assert.equal(provider.skills.length, 1, "extension-style providers can register curated skills");
  const comparison = boundary.skills.compare(savedSkill.skillId, provider.skills[0].skillId);
  assert([savedSkill.skillId, provider.skills[0].skillId, "undecided"].includes(comparison.winner));
  assert(Number.isFinite(comparison.similarity));
  assert(skillSimilarity(boundary.skills.getSkill(savedSkill.skillId), boundary.skills.getSkill(provider.skills[0].skillId)) >= 0);

  assert(captureSimilarity(capture, traceCapture) >= 0, "capture similarity is deterministic");
  assert.equal(isUnsafeSkill(new Skill({ name: "Unsafe", description: "bad", requiredTools: ["bash"], workflowSteps: [{ description: "run rm -rf /" }], validationStrategy: {} })).unsafe, true);
  const unsafeDescription = isUnsafeSkill(new Skill({ name: "Unsafe description", description: `Use ${["sk", "-", "S".repeat(24)].join("")}`, workflowSteps: [{ description: "Run the bounded check." }], validationStrategy: { command: "test" } }));
  assert(unsafeDescription.reasons.includes("provider-token"), "shared safety scans the complete durable skill projection, not only workflow steps");

  const rolled = boundary.skills.rollback(savedSkill.skillId, 1);
  assert.equal(rolled.status, "rolled_back");
  assert.equal(rolled.governance.rollbackToVersion, 1);

  const subCap = boundary.skills.captureSubagentResult({ subagent_id: "sub1", status: "succeeded", role: "reviewer", task: "Review patch", summary: "Patch reviewed", diagnostics: { duration_ms: 12, tool_calls: 1 } });
  assert.equal(subCap.source, "subagent-result");
  const goalCap = boundary.skills.captureGoalState({ id: "goal1", goal: "Ship feature", status: "completed", iteration: 2, history: [{ status: "running", nextPrompt: "inspect" }, { status: "completed", nextPrompt: "verify" }], observations: ["done"] });
  assert.equal(goalCap.outcome, "succeeded");
  const reasonCap = boundary.skills.captureReasoningReplay([{ id: "p", type: "plan", summary: "Plan" }, { id: "v", type: "verifier_evidence", summary: "ok", ok: true }]);
  assert.equal(reasonCap.source, "reasoning-replay");

  const deprecated = boundary.skills.deprecate(provider.skills[0].skillId);
  assert.equal(deprecated.status, "deprecated");
  const exported = boundary.skills.exportPacket();
  assert(exported.skills.length >= 1 && exported.captures.length >= 1, "skill export includes skills and captures");
  const importedBoundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), skills: { options: { loadCurated: false, loadNative: false } } });
  const imported = importedBoundary.skills.importPacket(exported);
  assert(imported.skills >= 1, "skill import restores exported skills");
  const snapshot = boundary.skills.snapshot({ note: "test" });
  assert(snapshot.snapshotId, "skill snapshot creates durable snapshot id");
  assert(boundary.skills.listSnapshots({ limit: 5 }).some((s) => s.snapshotId === snapshot.snapshotId), "skill snapshots are listed");
  const restored = boundary.skills.restoreSnapshot(snapshot.snapshotId);
  assert(restored.skills >= 1, "skill restore imports snapshot packet");
  const listedCaptureIds = boundary.skills.listCaptures({ limit: Infinity }).map((c) => c.captureId);
  assert.equal(listedCaptureIds.length, new Set(listedCaptureIds).size, "capture listing de-duplicates restored/imported capture index rows");
  assert.equal(boundary.skills.doctor().ok, true, "skill doctor reports healthy store");
  assert.equal(boundary.skills.compactEvents().compacted, true, "skill event log can be compacted when storage supports writeJsonl");

  const status = boundary.skills.status();
  assert(status.topSkills.length >= 1);
  const pruned = boundary.skills.prune({ keepSkills: 50, keepCaptures: 3 });
  assert(pruned.remainingCaptures <= 3, "skill pruning enforces capture retention");

  const patterns = boundary.skills.listFailurePatterns();
  assert(patterns.some((p) => p instanceof FailurePattern || p.signature), "failed captures create failure patterns");
  const firstPattern = patterns[0];
  const matchedPattern = boundary.skills.store.saveFailurePattern({ ...firstPattern.toJSON(), linkedCaptureIds: [...firstPattern.linkedCaptureIds, "cap_later_match"] });
  assert.equal(matchedPattern.patternId, firstPattern.patternId, "later matching failures retain one pattern identity");
  const mitigation = boundary.skills.recordFailurePatternOutcome(firstPattern.patternId, { mitigationReused: true, result: "succeeded", captureId: "cap_later_match", evidenceClass: "synthetic", evidenceIds: ["evidence_mitigation"] });
  assert.equal(mitigation.result, "succeeded");
  const compounding = boundary.skills.compoundingRecords({ limit: 1000 });
  assert(compounding.failureEvents.some((row) => row.type === "failure_pattern.matched"));
  assert(compounding.failureEvents.some((row) => row.type === "failure_pattern.post_mitigation" && row.mitigationReused && row.evidenceClass === "synthetic"));

  const metrics = boundary.skills.metrics();
  assert(metrics.skills >= 1);
  assert(metrics.captures >= 2);
  assert(storage.readJsonl("skills/captures").length >= 2, "captures are indexed for replay/listing");
  assert(sink.events.some((e) => e.type === "trace.event" && String(e.name).startsWith("skill.")), "skill events are traced");

  const draftCwd = tmpFixture("pi-hermes-skill-");
  const fakeHermes = path.join(draftCwd, "hermes"); fs.writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n"); fs.chmodSync(fakeHermes, 0o755);
  const hermesRun = async (args) => {
    const prompt = String(args[1] || "");
    if (prompt.includes("HERMES_ADVISORY_AUTH_OK")) return "HERMES_ADVISORY_AUTH_OK";
    if (prompt.includes("quarantined Agent Skills candidate")) return JSON.stringify({ schemaVersion: 1, name: "repeat-verified-workflow", description: "Use for repeated verified workflow tasks.", skillMarkdown: "---\nname: repeat-verified-workflow\ndescription: Use for repeated verified workflow tasks.\n---\n\n# Repeat verified workflow\n\n## Workflow\n\n1. Inspect public evidence.\n2. Run bounded verification.\n\n## Failure handling\n\nStop and inspect evidence before retrying.\n", files: [] });
    throw new Error("unexpected Hermes skill test call");
  };
  const draftBoundary = createPiIntegrationBoundary({ storage: new MemoryJsonStorage(), branching: { cwd: draftCwd }, hermes: { cwd: draftCwd, bin: fakeHermes, run: hermesRun }, skills: { cwd: draftCwd, options: { cwd: draftCwd, loadCurated: false, loadNative: false } } });
  for (let index = 1; index <= 3; index++) draftBoundary.skills.capture({ captureId: `cap_repeat_${index}`, task: "Repeat verified workflow", source: "execution-outcome", outcome: "succeeded", verification: { ok: true, evidenceIds: [`evidence-${index}`] }, workflowSteps: [{ kind: "inspect", description: "Inspect bounded evidence", status: "succeeded" }, { kind: "verify", description: "Run bounded verification", status: "succeeded" }], toolSequence: [{ tool: "read", ok: true }, { tool: "test_runner", ok: true }], replayRefs: { sourceRunId: `run-${index}` }, metrics: { latencyMs: 10, toolCalls: 2 } });
  const eligibleSynthesis = draftBoundary.skills.synthesize();
  assert.equal(eligibleSynthesis.skills.length, 1, "normal synthesis requires and accepts three independently verified successful executions");
  const skillCandidate = await draftBoundary.skills.draftAgentSkill(eligibleSynthesis.skills[0].skillId, { userAuthorized: true, probeAuth: true, sessionHash: "session-test" });
  assert.match(skillCandidate.candidateId, /^hermes_skill_/);
  assert.equal(skillCandidate.status, "quarantined");
  assert.equal(fs.existsSync(path.join(skillCandidate.directory, "SKILL.md")), true);
  assert.equal(fs.statSync(skillCandidate.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(skillCandidate.directory, "SKILL.md")).mode & 0o777, 0o600);
  const promotionPreview = draftBoundary.skills.promoteAgentSkill(skillCandidate.candidateId, { apply: false });
  assert.equal(promotionPreview.applied, false);
  assert.throws(() => draftBoundary.skills.promoteAgentSkill(skillCandidate.candidateId, { apply: true, userApproved: false }), (error) => error.code === "HERMES_SKILL_PROMOTION_APPROVAL_REQUIRED");
  const promoted = draftBoundary.skills.promoteAgentSkill(skillCandidate.candidateId, { apply: true, userApproved: true });
  assert.equal(promoted.applied, true);
  assert.equal(fs.existsSync(path.join(draftCwd, ".agents", "skills", "repeat-verified-workflow", "SKILL.md")), true);
  const promotedProvenance = JSON.parse(fs.readFileSync(path.join(skillCandidate.directory, "provenance.json"), "utf8"));
  assert.equal(promotedProvenance.status, "promoted");
  assert.equal(promotedProvenance.promotion.authority, "explicit-current-user");

  const disabled = createPiIntegrationBoundary({ enabled: false, storage: new MemoryJsonStorage() });
  assert.equal(disabled.skills.capture({ task: "x" }).enabled, false);
  assert.deepEqual(disabled.skills.retrieve("x").skills, []);

  console.log("skill-synthesis tests passed");
})();
