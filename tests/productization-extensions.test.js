#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function text(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function assertContains(file, needle) { assert.ok(text(file).includes(needle), `${file} should include ${needle}`); }

const verification = ".pi/extensions/verification-center/index.ts";
for (const command of ["verify-status", "verify-plan", "verify-run", "verify-evidence", "verify-baseline", "verify-doctor", "verify-policy", "verify-watch"]) {
  assertContains(verification, `pi.registerCommand("${command}"`);
}
assertContains(verification, "name: \"verification_center\"");
assertContains(verification, "Type.Literal(\"learning\")");
assertContains(verification, "learningSelfBenchmarkPlan");
assertContains(verification, "src\", \"integration-boundary.js");
assertContains(verification, "createPiIntegrationBoundary");

for (const retired of [".pi/extensions/semantic-patch-workbench", ".pi/extensions/workflow-conductor", ".pi/extensions/plan-fanout", ".pi/extensions/topology-catalog"]) assert.equal(fs.existsSync(path.join(root, retired)), false, `${retired} is retired without a compatibility layer`);
assertContains("src/integration-boundary/memory.js", "SemanticEditEngine");
assertContains("src/lsp-adapter.js", "semantic-editor.js");

const doctor = ".pi/extensions/runtime-doctor/index.ts";
for (const command of ["doctor", "doctor-latency", "doctor-memory", "doctor-context", "doctor-extensions", "doctor-hot-path", "doctor-export", "doctor-cleanup-preview", "doctor-cleanup-apply", "doctor-cleanup-policy", "doctor-cleanup-history", "doctor-sessions-preview", "doctor-sessions-apply"]) {
  assertContains(doctor, `pi.registerCommand("${command}"`);
}
assertContains(doctor, "name: \"runtime_doctor\"");
assertContains(doctor, "latestTraceFiles");
assertContains(doctor, "latencyReport");
assertContains(doctor, "hardenActiveSessionFile");
assertContains(doctor, "sessionPermissionsApply");

assertContains("docs/productization-extensions.md", "Verification Center");
assertContains("docs/productization-extensions.md", "Runtime Doctor");

const chatFocus = ".pi/extensions/chat-focus/index.ts";
for (const command of ["chat-focus", "chat-back", "chat-list"]) assertContains(chatFocus, `pi.registerCommand("${command}"`);
assertContains(chatFocus, '{ placement: "belowEditor" }');
assertContains("docs/productization-extensions.md", "Chat Focus");

const reasoningRuntime = ".pi/extensions/reasoning-runtime/index.ts";
for (const command of ["topology-recipes", "topology-install", "topology-recommend", "topology-lint", "topology-upgrade", "subagent-fanout"]) assertContains(reasoningRuntime, `pi.registerCommand("${command}"`);
assertContains(reasoningRuntime, "operation: Type.Optional(Type.String({ description: \"Operation: preflight, fanout");
assertContains(reasoningRuntime, "Type.Literal(\"recipes\")");
assertContains(reasoningRuntime, "planFanoutForContext");
assertContains("src/topology-recipes.js", "validateRoleAwareTopology");

const stabilizer = ".pi/extensions/runtime-doctor/index.ts";
for (const command of ["stabilize", "stabilize-plan", "stabilize-context", "stabilize-memory", "stabilize-branches", "stabilize-reset-noise", "stabilize-cleanup-preview", "stabilize-cleanup-apply"]) assertContains(stabilizer, `pi.registerCommand("${command}"`);
assertContains(stabilizer, "name: \"session_stabilizer\"");
assertContains(stabilizer, "cleanupPreview");
assertContains(doctor, "cleanupPreview");

const privacy = ".pi/extensions/privacy-guard/index.ts";
const privacyScan = "src/privacy-guard-scan.js";
for (const command of ["privacy-status", "privacy-scan", "privacy-trace-audit", "privacy-memory-audit", "privacy-redaction-test", "privacy-review", "privacy-policy", "privacy-purge"]) assertContains(privacy, `pi.registerCommand("${command}"`);
assertContains(privacy, "name: \"privacy_guard\"");
assertContains(privacy, "includeIgnored");
assertContains(privacy, "integration-boundary.js");
assertContains(privacy, "PrivacyGuardScanAdapter");
assertContains("src/integration-boundary.js", "PrivacyGuardScanAdapter");
assertContains(privacyScan, "ignoredFindings");
assertContains(privacyScan, "source/documentation vocabulary, not runtime state");
assertContains(privacyScan, "isBranchSnapshotFile");
assertContains(privacyScan, "private-snapshot-path");
assertContains(privacyScan, 'join(cwd, ".pi", "session-branches")');
assertContains(privacyScan, 'join(cwd, ".pi", "extension-telemetry")');
assertContains(privacyScan, 'join(cwd, ".pi", "session-audit")');
assertContains(privacyScan, 'join(cwd, ".pi", "session-mining")');
for (const stateRoot of ["hermes-advisory", "hermes-skill-candidates", "obsidian"]) assertContains(privacyScan, `join(cwd, ".pi", "${stateRoot}")`);
const privacyApi = require(path.join(root, privacyScan));
assert(["hermes-advisory", "hermes-skill-candidates", "obsidian"].every((name) => privacyApi.defaultRoots(root).some((value) => value.endsWith(path.join(".pi", name)))), "new Hermes/Obsidian runtime roots participate in default privacy scans");
assert.equal(privacyApi.scanText(path.join(root, ".pi", "hermes-skill-candidates", "fixture", "SKILL.md"), '{"role":"assistant","content":"full transcript"}').findings[0]?.pattern, "full-transcript-hint", "runtime skill candidates cannot bypass transcript detection as source-like Markdown");
assertContains(privacyScan, "sessionPermissionPosture");
assertContains(privacyScan, "contentReadFromRawSessions");
assertContains(privacyScan, "coverage: coverageSummary");
assertContains(privacyScan, "stateFingerprint");
assertContains(privacyScan, "rootStatus");
assertContains(privacyScan, "absentRoots");
assertContains(privacyScan, "reviewHandle");
assertContains(privacyScan, "PRIVATE_SNAPSHOT_PATH_RE");
assert.ok(!text(privacyScan).includes('readFileSync(file, "utf8")'), "branch snapshot privacy scans must stay on the streaming inventory path");
assertContains(privacyScan, "unsafe-session-permissions");
assertContains(privacyScan, "publicFinding");

const reasoningRuntimeExtension = ".pi/extensions/reasoning-runtime/index.ts";
for (const command of ["branch-export", "branch-cleanup-preview", "branch-cleanup-apply", "compounding-status", "compounding-scorecard"]) assertContains(reasoningRuntimeExtension, `pi.registerCommand("${command}"`);
assertContains(reasoningRuntimeExtension, "metadata-only branch lineage");
assertContains(reasoningRuntimeExtension, "fullScaffoldInjected");
assertContains(reasoningRuntimeExtension, "autoRouteStableKey");

const promptSuggestionPolicy = "src/prompt-suggestion-policy.js";
assertContains(promptSuggestionPolicy, "refinementPolicy");
assertContains(promptSuggestionPolicy, "minAcceptanceRate");
assertContains(promptSuggestionPolicy, "maxFailureRate");
assert.doesNotMatch(fs.readFileSync(promptSuggestionPolicy, "utf8"), /maxTimeoutRate|bootstrapIntervalMs/, "prompt suggestions must not restore timeout-derived admission locks");
assertContains(promptSuggestionPolicy, "minAttempts: 20");

const memory = ".pi/extensions/memory-explorer/index.ts";
for (const command of ["memory-map", "memory-search", "memory-lineage", "memory-provenance", "memory-provenance-export", "memory-maintenance-preview", "memory-conflicts", "memory-prune-preview", "memory-forget", "memory-export-safe", "memory-promote", "memory-demote", "memory-durable-status", "memory-recall"]) assertContains(memory, `pi.registerCommand("${command}"`);
assertContains(memory, "name: \"memory_explorer\"");
assertContains(memory, "PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS");
assertContains(memory, "adapter.preview({ write: false })");
assertContains(memory, "Preview memory maintenance without writing a report or applying cleanup");
assertContains(memory, "Type.Literal(\"provenance\")");
assertContains(memory, "Type.Literal(\"maintenancePreview\")");

const projectProfiler = ".pi/extensions/project-intelligence/index.ts";
for (const command of ["project-profile", "project-init-pi", "project-recommend", "project-safe-commands", "project-write-config"]) assertContains(projectProfiler, `pi.registerCommand("${command}"`);
assertContains(projectProfiler, "name: \"project_profiler\"");
assertContains(projectProfiler, ".pi/project.json");
assertContains(projectProfiler, "const existing = readJson(file, {})");
assertContains(projectProfiler, "{ ...existing, version: 1");

const testGapPlanner = ".pi/extensions/test-gap-planner/index.ts";
for (const command of ["test-gaps", "test-plan", "test-impact", "test-generate-skeletons", "test-risk"]) assertContains(testGapPlanner, `pi.registerCommand("${command}"`);
assertContains(testGapPlanner, "name: \"test_gap_planner\"");
assertContains(testGapPlanner, "changedFiles");

const memoryCurator = ".pi/extensions/memory-explorer/index.ts";
for (const command of ["memory-review", "memory-curate-plan", "memory-apply-forget", "memory-dedupe", "memory-promote-architecture", "memory-expire-stale", "memory-save"]) assertContains(memoryCurator, `pi.registerCommand("${command}"`);
assertContains(memoryCurator, "name: \"memory_curator\"");
assertContains(memoryCurator, "checkpoint");

const policyGate = ".pi/extensions/policy-enforcer/index.ts";
for (const command of ["policy-status", "policy-check", "policy-denylist", "policy-allowlist", "policy-simulate", "policy-enforce"]) assertContains(policyGate, `pi.registerCommand("${command}"`);
assertContains(policyGate, "name: \"policy_gate\"");
assertContains("src/runtime-policy.js", "evaluateShellCommand");
assertContains("src/shell-policy.js", "rm\\s+-");

const performanceOptimizer = ".pi/extensions/runtime-doctor/index.ts";
for (const command of ["perf-profile", "perf-hot-path", "perf-regression", "perf-compare", "perf-baseline", "perf-after", "perf-report", "perf-fix-plan", "perf-apply-safe"]) assertContains(performanceOptimizer, `pi.registerCommand("${command}"`);
assertContains(performanceOptimizer, "name: \"performance_optimizer\"");
assertContains(performanceOptimizer, "PI_PROMPT_SUGGESTIONS_REFINE=off");

const ciPr = ".pi/extensions/ci-pr-companion/index.ts";
for (const command of ["ci-status", "ci-failures", "pr-summary", "pr-review", "pr-risk", "pr-verify"]) assertContains(ciPr, `pi.registerCommand("${command}"`);
assertContains(ciPr, "name: \"ci_pr_companion\"");
assertContains(ciPr, "normalizeOperation");
assertContains(ciPr, "status: \"ciStatus\"");
assertContains(ciPr, "ghAvailable");

const codeContext = ".pi/extensions/code-context/index.ts";
assertContains(codeContext, "name: \"code_context\"");
assertContains(codeContext, "src\", \"code-context-service.js");
assertContains(codeContext, "session_shutdown");
assertContains("docs/productization-extensions.md", "### Code Context");
assertContains("docs/integration-boundary.md", "Progressive code-context retrieval boundary");
assertContains("docs/runtime-configuration.md", "PI_CODE_CONTEXT_MODE");
assertContains("README.md", "code_context");

const lsp = ".pi/extensions/lsp/index.ts";
for (const command of ["lsp-status", "lsp-diagnostics", "lsp-symbols", "lsp-definition", "lsp-references", "lsp-hover", "lsp-rename-preview", "lsp-rename-apply"]) assertContains(lsp, `pi.registerCommand("${command}"`);
assertContains(lsp, "name: \"lsp\"");
assertContains(lsp, "src\", \"lsp-adapter.js");

const testRunner = ".pi/extensions/test-runner/index.ts";
for (const command of ["test-runner-status", "test-runner-profiles", "test-runner-infer", "test-runner-run", "test-runner-rerun-failures"]) assertContains(testRunner, `pi.registerCommand("${command}"`);
assertContains(testRunner, "name: \"test_runner\"");
assertContains(testRunner, "normalizeTestRunnerParams");
assertContains(testRunner, "Type.Union([Type.String(), Type.Array(Type.String())]");
assertContains(testRunner, "src\", \"test-runner.js");

const astTools = ".pi/extensions/ast-tools/index.ts";
for (const command of ["ast-status", "ast-search", "ast-refactor-preview", "ast-refactor-apply", "ast-refactor-rollback"]) assertContains(astTools, `pi.registerCommand("${command}"`);
assertContains(astTools, "name: \"ast_search\"");
assertContains(astTools, "name: \"ast_refactor\"");
assertContains(astTools, "src\", \"ast-tools.js");

const docsLookup = ".pi/extensions/docs-lookup/index.ts";
for (const command of ["docs-status", "docs-lookup", "docs-read", "docs-package"]) assertContains(docsLookup, `pi.registerCommand("${command}"`);
assertContains(docsLookup, "name: \"docs_lookup\"");
assertContains(docsLookup, "src\", \"docs-lookup.js");

const outputCompactor = ".pi/extensions/output-compactor/index.ts";
for (const command of ["output-compact", "output-compactor-status"]) assertContains(outputCompactor, `pi.registerCommand("${command}"`);
assertContains(outputCompactor, "name: \"output_compactor\"");
assertContains(outputCompactor, "PI_OUTPUT_COMPACTOR_MODE");
assertContains(outputCompactor, "PI_OUTPUT_COMPACTOR_CANARY_TOOLS");
for (const tool of ["evidence_binder", "run_deck", "verification_center"]) assertContains(outputCompactor, tool);
assertContains(outputCompactor, "featureSignal(\"output-compactor\"");
assertContains("src/result-rendering.js", "compactToolContent");

const overflowRecovery = ".pi/extensions/context-overflow-recovery/index.ts";
for (const command of ["compact-rescue", "compaction-recovery-status"]) assertContains(overflowRecovery, `pi.registerCommand("${command}"`);
assertContains(overflowRecovery, 'pi.on("session_before_compact"');
assertContains(overflowRecovery, 'pi.on("session_compact"');
assertContains(overflowRecovery, 'transport: "sse"');
assertContains(overflowRecovery, "compactionRecoveryDetection");
assertContains(overflowRecovery, "delete require.cache");
assertContains(overflowRecovery, "minimalRecoveryCompaction");
assertContains(overflowRecovery, "CONTINUATION_PROMPT");
assertContains(overflowRecovery, "buildLocalRecoverySummary");
assertContains("src/context-overflow-recovery.js", "buildLocalRecoverySummary");

const policyEnforcer = ".pi/extensions/policy-enforcer/index.ts";
for (const command of ["policy-enforcer-status", "policy-mode", "policy-approvals", "policy-approve", "policy-approve-directory", "policy-revoke"]) assertContains(policyEnforcer, `pi.registerCommand("${command}"`);
assertContains(policyEnforcer, "name: \"policy_enforcer\"");
assertContains("src/policy-enforcement.js", "enforceToolCall");

const projectIntel = ".pi/extensions/project-intelligence/index.ts";
for (const command of ["project-index", "project-symbols", "project-tests-map", "project-deps"]) assertContains(projectIntel, `pi.registerCommand("${command}"`);
assertContains(projectIntel, "name: \"project_intelligence\"");
assertContains("src/project-intelligence.js", "createProjectIndex");

const evidenceBinder = ".pi/extensions/evidence-binder/index.ts";
for (const command of ["evidence-status", "evidence-capture-verification", "claim-check", "evidence-report"]) assertContains(evidenceBinder, `pi.registerCommand("${command}"`);
assertContains(evidenceBinder, "name: \"evidence_binder\"");
assertContains(evidenceBinder, "captureVerification returns outcome=not-applicable");
assertContains(evidenceBinder, "missing prerequisites are never tool failures");
assertContains(evidenceBinder, "normalizeOperation");
assertContains(evidenceBinder, "PI_EVIDENCE_BINDER_WARN === \"1\"");
assertContains(evidenceBinder, "if (!s.evidenceCount) return");
assertContains("src/evidence-binder.js", "bindClaims");
assertContains("src/evidence-binder.js", "verification_evidence_missing");

for (const contextExtension of [".pi/extensions/repo-context/index.ts", ".pi/extensions/run-deck/index.ts", ".pi/extensions/debug-ledger/index.ts", ".pi/extensions/experiment-ledger/index.ts", ".pi/extensions/obsidian/index.ts"]) {
  assertContains(contextExtension, "createContextInjector");
  assertContains(contextExtension, ".reset()");
}
assertContains("src/pi-extension-kit.js", "DEFAULT_CONTEXT_INJECTION_MAX_CHARS");
assertContains("extensions/hermes-advisory/index.ts", "HermesAdvisoryAdapter");

const extensionOps = ".pi/extensions/extension-ops-center/index.ts";
for (const command of ["extensions-report", "extensions-inventory", "extensions-portfolio", "extensions-conflicts", "extensions-smoke-plan", "extensions-canaries", "extensions-docs"]) assertContains(extensionOps, `pi.registerCommand("${command}"`);
assertContains(extensionOps, "name: \"extension_ops\"");
assertContains(extensionOps, "Type.Literal(\"compare\")");
assertContains(extensionOps, "Type.Literal(\"canaries\")");
assertContains("src/extension-registry.js", "scanExtensionRegistry");
assertContains("src/extension-canaries.js", "operationCanaryPlan");

const rolloutCenter = ".pi/extensions/rollout-center/index.ts";
assertContains(rolloutCenter, 'pi.registerCommand("rollout-center"');
assertContains(rolloutCenter, "createPiIntegrationBoundary");
assertContains(rolloutCenter, "renderRolloutCenterFrame");
assertContains("src/integration-boundary.js", "RolloutCenterAdapter");
assertContains("src/integration-boundary.js", "VisualVerificationAdapter");
assertContains("src/visual-verification.js", "class VisualVerificationAdapter");
assertContains("src/visual-baselines.js", "baseline apply requires apply=true and yes=true");
assertContains("docs/productization-extensions.md", "Rollout Center");
assertContains("docs/runtime-configuration.md", "PI_VISUAL_VERIFICATION");

const toolSurfaceRouter = "extensions/tool-surface-router/index.ts";
assertContains(toolSurfaceRouter, "tool-surface");
assertContains(toolSurfaceRouter, 'pi.on("input"');
assertContains(toolSurfaceRouter, "setActiveTools");
assertContains("src/tool-surface-router.js", "toolReadiness");
const toolChurnGuard = "extensions/tool-churn-guard/index.ts";
assertContains(toolChurnGuard, "tool-churn-status");
assertContains(toolChurnGuard, 'pi.on("tool_result"');
assertContains("src/tool-churn-guard.js", "repeated-process-poll");

const roadmap = ".pi/extensions/roadmap/index.ts";
for (const command of ["roadmap", "roadmap-panel", "roadmap-start", "roadmap-subtask", "roadmap-replace", "roadmap-add", "roadmap-active", "roadmap-adopt", "roadmap-done", "roadmap-verify", "roadmap-block", "roadmap-skip", "roadmap-close", "roadmap-shelve", "roadmap-resume", "roadmap-archive", "roadmap-link", "roadmap-next", "roadmap-import-reasoning", "roadmap-report", "roadmap-export", "roadmap-clear"]) assertContains(roadmap, `pi.registerCommand("${command}"`);
assertContains(roadmap, "name: \"roadmap_update\"");
assertContains(".pi/extensions/roadmap/roadmap-state.js", "reasoning-runtime.json");
assertContains(".pi/extensions/roadmap/roadmap-state.js", "sourceArtifactId");
assertContains(".pi/extensions/roadmap/roadmap-state.js", "addSubtaskRoadmap");
assertContains(".pi/extensions/roadmap/roadmap-state.js", "ROADMAP_VERSION = 3");
assertContains(".pi/extensions/roadmap/roadmap-state.js", "roadmapMutationEnvelope");
assertContains("src/roadmap-telemetry.js", "ROADMAP_COHORT_VERSION");
assertContains(".gitignore", ".pi/roadmap/");

const learningLoop = ".pi/extensions/learning-loop-coordinator/index.ts";
for (const command of ["learning-status", "learning-scorecard", "learning-scorecard-status", "learning-record-outcome", "learning-ingest", "learning-scan-sessions", "learning-session-report", "learning-outcomes", "learning-rate-outcome", "learning-patterns", "learning-propose", "learning-inbox", "learning-show", "learning-review", "learning-approve", "learning-dismiss", "learning-apply", "learning-verify", "learning-benchmark", "learning-context-attribution", "learning-model-router", "learning-experiment", "learning-refactor-propose", "learning-memory-summary", "learning-export", "learning-doctor"]) assertContains(learningLoop, `pi.registerCommand("${command}"`);
assertContains(learningLoop, "name: \"learning_loop\"");
assertContains(learningLoop, "PI_LEARNING_AUTO_INGEST");
assertContains(learningLoop, "autoApply: false");
assertContains(learningLoop, "Type.Literal(\"scorecard\")");
assertContains(learningLoop, "Type.Literal(\"compoundingStatus\")");
assertContains(learningLoop, "PI_COMPOUNDING_EFFECTIVENESS_ENABLED");
assertContains(learningLoop, "new FileIntegrationStorage(join(cwd, \".pi\", \"execution-outcomes\"))");
assertContains("src/learning-loop.js", "class LearningStore");
assertContains("src/learning-loop.js", "reviewProposalWithLocalChecks");
assertContains("src/learning-loop.js", "ingestLearningSources");
assertContains("src/learning-loop.js", "patternLedgerFile");
assertContains("src/learning-loop.js", "mineFailurePatterns");
assertContains("src/learning-loop.js", "learningSelfBenchmarkPlan");
assertContains("src/learning-loop.js", "delegatedApplyPlan");
assertContains("src/learning-loop.js", "contextAttributionReport");
assertContains("src/learning-loop.js", "adaptiveModelRouterReport");
assertContains("src/learning-loop.js", "experimentPlanFromProposal");
assertContains("src/learning-loop.js", "runExperimentPlan");
assertContains("src/learning-loop.js", "refactorProposalPacket");
assertContains("src/learning-loop.js", "durableMemorySummary");
assertContains("src/learning-loop.js", "writeMemorySummaryCandidate");
assertContains("src/session-miner.js", "mineAgentSessions");
assertContains("src/session-miner.js", "sessionMiningOutcomes");
assertContains("scripts/mine-agent-sessions.js", "--record-outcomes");
assertContains(".gitignore", ".pi/learning-loop/");
assertContains(".gitignore", ".pi/session-mining/");
assertContains(".gitignore", ".pi/verification-center/");
assertContains(".gitignore", ".pi/memory-curator/");

const automationLoop = ".pi/extensions/automation-loop/index.ts";
for (const command of ["loop", "ralph-loop", "loop-status", "loop-list", "loop-log", "loop-pause", "loop-resume", "loop-stop", "cancel-ralph", "loop-help"]) assertContains(automationLoop, `pi.registerCommand("${command}"`);
assertContains(automationLoop, "name: \"automation_loop\"");
assertContains(automationLoop, "agent_settled");
assertContains("src/automation-loop.js", "class AutomationLoopStore");
assertContains("src/automation-loop.js", "evaluateSettlement");
assertContains(".gitignore", ".pi/automation-loop/");

const runMonitor = "extensions/run-monitor/index.ts";
for (const command of ["monitor-start", "monitor-status", "monitor-check", "monitor-stop", "monitors"]) assertContains(runMonitor, `pi.registerCommand("${command}"`);
assertContains(runMonitor, "name: \"run_monitor\"");
assertContains(runMonitor, 'pi.on("session_shutdown"');
assertContains(runMonitor, 'markIntentActed(ctx, observer === "command")');
assertContains(runMonitor, '}, "command");');
assertContains("src/run-monitor.js", "function checkMonitor");
assertContains("src/run-monitor.js", "function probeMonitor");
assertContains("scripts/run-monitor-check.js", "--watch");
assertContains(runMonitor, "run-monitor-check.js");
assertContains("docs/run-monitor.md", "## Script checks");
assertContains("docs/productization-extensions.md", "### Run Monitor");
assertContains("docs/runtime-configuration.md", "PI_RUN_MONITOR_INTERVAL_MS");
assertContains("docs/runtime-configuration.md", "PI_RUN_MONITOR_INTENT_TELEMETRY");
assertContains(".gitignore", ".pi/run-monitor/");

assertContains("src/runtime-policy.js", "evaluatePolicy");
assertContains(".pi/extensions/goal/goal-runner.js", "evaluatePolicy");
assertContains("src/multi-agent-topologies.js", "topology.policy_denied");
assertContains("src/multi-agent-topologies.js", "compactToolContent");

for (const recipe of ["refactor-with-safety-net", "dependency-upgrade", "failing-ci-triage", "performance-regression", "release-prep"]) assertContains("src/role-topologies.js", recipe);

for (const heading of ["Recurring cross-agent session miner", "Rollout Center", "Ralph-style Automation Loop", "Run Monitor", "Session Stabilizer", "Privacy Guard", "Memory Explorer", "Project Profiler", "Test Gap Planner", "Memory Curator", "Policy Gate", "Performance Optimizer", "Code Context", "General Coding Workflow Tools", "Output Compactor", "Context Overflow Recovery", "Policy Enforcer", "Project Intelligence", "Evidence Binder", "Extension Ops Center", "Tool Surface Router", "Tool Churn Guard", "Roadmap", "Learning Loop Coordinator", "Expanded Topology Workflow Pack"]) assertContains("docs/productization-extensions.md", heading);
for (const tool of ["lsp", "test_runner", "ast_search", "ast_refactor", "docs_lookup"]) assertContains("README.md", tool);
for (const stateDir of [".pi/code-context/", ".pi/test-runner/", ".pi/ast-refactor/"]) assertContains(".gitignore", stateDir);
assertContains("scripts/check-extensions-smoke.sh", "node scripts/extension-smoke-runner.js all");
assertContains("scripts/extension-smoke-runner.js", "discoverExtensionEntries");
assertContains("scripts/extension-smoke-runner.js", "SMOKE PASS mode=rpc");
assertContains("scripts/extension-smoke-runner.js", "PI_EXTENSION_SMOKE_MODEL_TIMEOUT_MS");
assertContains("docs/workflow-pack.md", "Onboard a new repository");
assertContains("docs/workflow-pack.md", "/roadmap-start");
assertContains("docs/workflow-pack.md", "/learning-ingest verification");
assertContains("docs/workflow-pack.md", "/learning-propose --min=1");
assertContains("docs/workflow-pack.md", "/learning-benchmark");
assertContains("docs/workflow-pack.md", "/learning-refactor-propose");

console.log("productization extension checks passed");
