"use strict";

const assert = require("node:assert/strict");
const {
  ROLE_CONTRACT_VERSION,
  ROLE_CONTRACT_SCHEMA_VERSION,
  DEFAULT_ROLE_CONTRACTS,
  validateRoleContract,
  createCustomReadOnlyContract,
  narrowRoleContract,
  roleRevisionHash,
  roleDescriptor,
  resolveRequiredTools,
  selectRoleInferenceProfile,
  roleModelEnvName,
  roleThinkingEnvName,
} = require("../src/role-contracts");
const { AgentRoleRegistry } = require("../src/multi-agent-topologies");
const { ROADMAP_GOAL_MAX_LENGTH, ANALYSIS_PLANNER_OUTPUT_SCHEMA, validateJsonSchema, validateRoleSubmission, completionPolicyErrors, createRoleResultEnvelope, validateRoleResultEnvelope } = require("../src/role-result-schemas");

const forbiddenPseudoTools = new Set(["rg", "diff", "search", "browser", "test", "lint", "typecheck", "benchmark"]);

assert.equal(ROLE_CONTRACT_SCHEMA_VERSION, 2);
assert.equal(ROLE_CONTRACT_VERSION, "role-v2");
assert(DEFAULT_ROLE_CONTRACTS.length >= 11, "the conservative default role matrix is registered centrally");
for (const contract of DEFAULT_ROLE_CONTRACTS) {
  const validated = validateRoleContract(contract);
  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.contractVersion, "role-v2");
  assert(validated.outputSchema, `${contract.roleId} has a typed output schema`);
  assert(validated.completionPolicy?.requireSubmittedResult, `${contract.roleId} requires typed result submission`);
  if (validated.budget === null) {
    assert.equal(validated.modelPolicy.mode, "inherit", `${contract.roleId} is an unbudgeted specialist`);
    assert.equal(validated.modelPolicy.thinkingLevel, "inherit");
  } else {
    assert(Number.isFinite(validated.budget.maxModelCalls), `${contract.roleId} has a model-call budget`);
    assert(Number.isFinite(validated.budget.maxToolCalls), `${contract.roleId} has a tool-call budget`);
  }
  assert(validated.modelPolicy && validated.modelPolicy.thinkingLevel, `${contract.roleId} has an explicit thinking policy`);
  for (const tool of validated.toolPolicy.allowedTools) assert(!forbiddenPseudoTools.has(tool), `${contract.roleId} must not request unavailable pseudo-tool ${tool}`);
}

const registry = new AgentRoleRegistry();
const coder = registry.get("coder");
assert.equal(coder.workspacePolicy, "isolated-worktree");
assert.equal(coder.mutationPolicy, "proposed-patch");
assert(coder.toolPolicy.allowedTools.includes("submit_role_result"));
assert.equal(coder.completionPolicy.requireEvidence, true);
assert.equal(coder.completionPolicy.requireVerificationVerdict, true);
assert.match(coder.systemPrompt, /baseline-satisfied.*exact inherited changedPaths/i, "proposed-patch roles receive the explicit inherited-baseline disposition contract");
const researcher = registry.get("researcher");
const verifier = registry.get("verifier");
assert.equal(researcher.budget.wallClockMs, 300000, "researcher budgets leave bounded headroom for evidence synthesis before planning");
assert.equal(coder.budget.wallClockMs, 480000, "coder budgets leave bounded headroom for repository-wide verification");
assert.equal(verifier.budget.wallClockMs, 540000, "verifier budgets leave bounded headroom for repository-wide verification");
assert.match(verifier.systemPrompt, /workspaceDisposition is baseline-satisfied.*role_diff has no child-local patch/i, "verifiers are instructed to check an inherited baseline even when no child patch exists");
const explicitNoPatch = createRoleResultEnvelope({ contract: coder, subagentId: "coder-no-patch", submission: { summary: "Implementation found no repository change to retain after verification.", findings: [], evidence: [{ kind: "command", summary: "Checked the isolated workspace diff." }], artifacts: [], proposedPatch: null, verification: { status: "passed", evidence: ["isolated workspace diff is empty"] } } });
assert.equal(validateRoleResultEnvelope(explicitNoPatch, { contract: coder, subagentId: "coder-no-patch" }).ok, true, "the child envelope permits an explicit null until the parent performs authoritative workspace capture");
assert(validateJsonSchema({ type: "object", required: ["title"], properties: { title: { type: "string" } } }, { title: null }).some((error) => error.includes("expected string")), "null remains invalid for required non-nullable fields");
assert.deepEqual(coder.allowedTools, coder.toolPolicy.allowedTools, "legacy role aliases remain derived from the canonical contract");
const planner = registry.get("planner");
const plannerSummary = "Plan the bounded implementation from repository evidence.";
const plannerEvidence = [{ kind: "path", path: "src/example.js", summary: "Inspected the implementation boundary." }];
assert.match(planner.systemPrompt, /roadmapPlan/);
assert.match(planner.systemPrompt, /at least 32 meaningful characters/);
assert(planner.outputSchema.properties.roadmapPlan, "planner output accepts a public executable roadmap hierarchy");
assert.equal(planner.completionPolicy.minimumSummaryChars, 32);
assert.equal(planner.completionPolicy.requireEvidence, true);
assert.equal(planner.budget.wallClockMs, 240000, "high planners retain bounded correction headroom after evidence collection");
assert.equal(planner.budget.maxResultChars, 18000, "planner result capacity fits observed evidence-backed roadmap submissions without increasing model-call retries");
const plannerResultBudgetReplay = {
  summary: plannerSummary,
  findings: [{ type: "scope", detail: "Keep the implementation and verification phases explicit." }],
  evidence: plannerEvidence,
  roadmapPlan: {
    title: "Bounded incident-derived implementation plan",
    milestones: Array.from({ length: 5 }, (_, milestone) => ({
      title: `Phase ${milestone + 1}`,
      goals: Array.from({ length: 10 }, (_, goal) => `Goal ${goal + 1}: ${"bounded implementation evidence ".repeat(10)}`),
    })),
  },
};
const plannerResultAtOldLimit = validateRoleSubmission(plannerResultBudgetReplay, { schema: planner.outputSchema, maxResultChars: 12000 });
assert.equal(plannerResultAtOldLimit.ok, false, "the frozen planner failure shape reproduces the former 12000-character rejection");
assert(plannerResultAtOldLimit.errors.some((error) => error.includes("exceeds 12000")));
const plannerResultAtCurrentLimit = validateRoleSubmission(plannerResultBudgetReplay, { schema: planner.outputSchema, maxResultChars: planner.budget.maxResultChars });
assert.equal(plannerResultAtCurrentLimit.ok, true, "the same bounded planner result is accepted without another model call");
assert(JSON.stringify(plannerResultAtCurrentLimit.result).length <= planner.budget.maxResultChars);
const advisoryPlannerResult = validateRoleSubmission({ summary: plannerSummary, findings: [], evidence: plannerEvidence }, { schema: planner.outputSchema });
assert.equal(advisoryPlannerResult.ok, true, "roadmapPlan remains optional for evidence-backed advisory planner results");
const executablePlannerResult = validateRoleSubmission({ summary: plannerSummary, findings: [], evidence: plannerEvidence, roadmapPlan: { title: "Release plan", milestones: [{ title: "Phase 0", goals: ["Freeze evidence"] }] } }, { schema: planner.outputSchema });
assert.equal(executablePlannerResult.ok, true);
assert.equal(executablePlannerResult.result.roadmapPlan.milestones[0].goals[0], "Freeze evidence", "normalization preserves the bounded public hierarchy");
assert.equal(validateRoleSubmission({ summary: "x", findings: [], evidence: [] }, { schema: planner.outputSchema }).ok, false, "trivial evidence-free planner output is rejected by the canonical schema");
assert(completionPolicyErrors({ summary: plannerSummary, findings: [], evidence: [{}] }, planner).some((error) => error.includes("supporting detail")), "an empty evidence object does not satisfy planner completion");
assert(completionPolicyErrors({ summary: "A sufficiently long planner summary backed by evidence.", findings: [], evidence: plannerEvidence, roadmapPlan: { title: "noop2", milestones: [{ title: "noop", goals: ["noop"] }] } }, planner).some((error) => error.includes("roadmapPlan")), "no-op roadmap labels are rejected as placeholders");
const maximumGoalResult = validateRoleSubmission({ summary: plannerSummary, findings: [], evidence: plannerEvidence, roadmapPlan: { title: "Bounded", milestones: [{ title: "Phase 0", goals: ["x".repeat(ROADMAP_GOAL_MAX_LENGTH)] }] } }, { schema: planner.outputSchema });
assert.equal(maximumGoalResult.ok, true, "the canonical roadmap goal bound is accepted");
const oversizedGoalResult = validateRoleSubmission({ summary: plannerSummary, findings: [], evidence: plannerEvidence, roadmapPlan: { title: "Oversized", milestones: [{ title: "Phase 0", goals: ["x".repeat(ROADMAP_GOAL_MAX_LENGTH + 1)] }] } }, { schema: planner.outputSchema });
assert.equal(oversizedGoalResult.ok, false, "roadmap goals above the shared boundary are rejected");
const invalidPlannerResult = validateRoleSubmission({ summary: plannerSummary, findings: [], evidence: plannerEvidence, roadmapPlan: { title: "Broken", milestones: [{ title: "Phase 0", goals: [] }] } }, { schema: planner.outputSchema });
assert.equal(invalidPlannerResult.ok, false, "executable milestones require at least one goal");
const analysisPlanResult = validateRoleSubmission({ summary: "Scope", findings: [], evidence: [], analysisPlan: { title: "Four angles", assignments: ["research", "compare", "check", "gaps"].map((id) => ({ id, angle: id, objective: `Handle ${id}` })) } }, { schema: ANALYSIS_PLANNER_OUTPUT_SCHEMA });
assert.equal(analysisPlanResult.ok, true, "public analysis decomposition survives role-v2 normalization");
const evidenceAuditor = registry.get("evidence-auditor");
assert.equal(evidenceAuditor.workspacePolicy, "shared-readonly");
assert.equal(evidenceAuditor.mutationPolicy, "forbidden");
assert(!evidenceAuditor.toolPolicy.allowedTools.includes("bash"));
const audited = validateRoleSubmission({ summary: "Audited", findings: [], evidence: [], claims: [{ id: "c1", statement: "Claim", status: "accepted", evidenceRefs: ["e1"] }], evidenceRefs: [{ id: "e1", kind: "source", source: "src/a.js", locator: "L1" }], auditDecisions: [{ claimId: "c1", decision: "accepted", rationale: "Direct support", evidenceRefs: ["e1"] }], rejectedClaims: [], unresolvedGaps: [], coverage: { expectedCategories: ["research"], observedCategories: ["research"], missingCategories: [], ratio: 1 } }, { schema: evidenceAuditor.outputSchema });
assert.equal(audited.ok, true, "evidence auditor accepts bounded structured evidence");
const unknownEvidenceField = validateRoleSubmission({ ...audited.result, evidenceRefs: [{ id: "e1", kind: "source", source: "src/a.js", privateTranscript: "forbidden" }] }, { schema: evidenceAuditor.outputSchema });
assert.equal(unknownEvidenceField.ok, false, "unknown evidence fields fail closed");
const tooManyClaims = validateRoleSubmission({ ...audited.result, claims: Array.from({ length: 49 }, (_, index) => ({ id: `c${index}`, statement: `Claim ${index}`, evidenceRefs: ["e1"] })) }, { schema: evidenceAuditor.outputSchema, maxResultChars: 50000 });
assert.equal(tooManyClaims.ok, false, "structured evidence arrays remain bounded independently of the total result-size cap");
const reviewer = registry.get("reviewer");
assert.equal(reviewer.workspacePolicy, "shared-readonly");
assert.equal(registry.get("coder").autoRoutePolicy, "delegate", "automatic delegate policy uses the current vocabulary");
assert.equal(reviewer.completionPolicy.requireEvidence, true);
assert.equal(reviewer.completionPolicy.requireVerificationVerdict, true);
assert.equal(reviewer.budget.maxModelCalls, 8, "broad read-only reviews reserve enough bounded model calls to submit a typed result");
assert.match(reviewer.systemPrompt, /Reserve the final model call|path-scoped follow-ups/, "reviewers receive explicit budget-conservation guidance");
assert.equal(registry.get("coordinator").workspacePolicy, "handler-only");
assert.equal(typeof registry.get("coordinator").handler, "function");
assert.equal(typeof narrowRoleContract(registry.get("coordinator"), { outputSchema: registry.get("coordinator").outputSchema }).handler, "function", "policy narrowing preserves handler-only execution functions");
assert.deepEqual(registry.get("worker").toolPolicy.allowedTools, ["read", "grep", "find", "ls", "submit_role_result"], "worker is explicitly fail-closed instead of inheriting all built-ins");
assert.equal(registry.get("worker").autoRoutePolicy, "suggest", "worker may be recommended but never automatically executed");
assert.equal(registry.get("worker").workspacePolicy, "shared-readonly");
assert.equal(registry.get("worker").mutationPolicy, "forbidden");
assert.throws(() => registry.register({ roleId: "bad", outputSchema: null }), /output schema/i);
registry.register({ roleId: "custom-review", description: "First normalized custom role" });
assert.throws(() => registry.register({ roleId: "Custom Review", description: "Ambiguous normalized custom role" }), /ambiguous normalized/i);
assert.throws(() => validateRoleContract({ ...coder, roleId: "empty-policy", toolPolicy: { allowedTools: [], deniedTools: [] } }), /submit_role_result/i, "RPC contracts cannot accidentally launch without their required submit tool");

const custom = createCustomReadOnlyContract({ roleId: "Security Review", systemPrompt: "Inspect authentication boundaries." });
assert.equal(custom.roleId, "security-review");
assert.equal(custom.workspacePolicy, "shared-readonly");
assert.equal(custom.mutationPolicy, "forbidden");
assert.deepEqual(custom.toolPolicy.allowedTools, ["read", "grep", "find", "ls", "submit_role_result"]);
assert(custom.budget.maxResultChars <= 12000);
const boundedCustom = createCustomReadOnlyContract({ roleId: "bounded", systemPrompt: "Inspect a bounded custom concern.", budget: { maxModelCalls: 999, maxToolCalls: 999, wallClockMs: 9999999, maxResultChars: 999999 } });
assert.deepEqual({ maxModelCalls: boundedCustom.budget.maxModelCalls, maxToolCalls: boundedCustom.budget.maxToolCalls, wallClockMs: boundedCustom.budget.wallClockMs, maxResultChars: boundedCustom.budget.maxResultChars }, { maxModelCalls: 6, maxToolCalls: 48, wallClockMs: 180000, maxResultChars: 12000 });
assert.throws(() => createCustomReadOnlyContract({ roleId: "!!!", systemPrompt: "x" }), /letters or numbers/i);

const narrowed = narrowRoleContract(coder, {
  toolPolicy: { allowedTools: ["read", "edit", "submit_role_result"], deniedTools: ["bash", "write"] },
  budget: { maxModelCalls: 4, maxToolCalls: 20 },
});
assert.deepEqual(narrowed.toolPolicy.allowedTools, ["read", "edit", "submit_role_result"]);
assert.equal(narrowed.budget.maxModelCalls, 4);
assert.throws(() => narrowRoleContract(coder, { budget: { maxModelCalls: 2 } }), /at least three model calls.*reserved/i, "model-backed roles retain inspection, initial submission, and final correction calls");
assert.throws(() => narrowRoleContract(coder, { toolPolicy: { allowedTools: [...coder.toolPolicy.allowedTools, "role_diff"] } }), /broadens/i);
assert.throws(() => narrowRoleContract(coder, { toolPolicy: { allowedTools: [...coder.toolPolicy.allowedTools, "role_diff"] }, policyElevation: { reviewed: true, reason: "topology contract permits diff inspection" } }), /broadens|elevation/i);
assert.throws(() => narrowRoleContract(registry.get("reviewer"), { modelPolicy: { ...registry.get("reviewer").modelPolicy, thinkingLevel: "low" } }), /broadens/i);
assert.throws(() => narrowRoleContract(registry.get("reviewer"), { modelPolicy: { ...registry.get("reviewer").modelPolicy, thinkingLevel: "low" }, policyElevation: { reviewed: true, reason: "reviewed role inference experiment" } }), /broadens|elevation/i);
assert.throws(() => narrowRoleContract(registry.get("reviewer"), { workspacePolicy: "isolated-worktree" }), /broadens/i);
assert.throws(() => narrowRoleContract(registry.get("reviewer"), { workspacePolicy: "isolated-worktree", policyElevation: { reviewed: true, reason: "review upstream isolated patch" } }), /broadens|elevation/i);
assert.equal(registry.get("patch-reviewer").workspacePolicy, "isolated-worktree", "isolated patch review uses a distinct registered role rather than policy elevation");

assert.deepEqual(resolveRequiredTools({ ...registry.get("reviewer"), toolPolicy: { allowedTools: [], deniedTools: [] } }, ["read", "submit_role_result"]), { requested: [], available: [], missing: [] }, "an empty allowlist means no tools");
const resolution = resolveRequiredTools(registry.get("reviewer"), ["read", "grep", "find", "ls", "role_diff", "submit_role_result"]);
assert.equal(resolution.missing.length, 0);
assert.throws(() => resolveRequiredTools(registry.get("reviewer"), ["read", "submit_role_result"], { throwOnMissing: true }), /missing required role tools/i);

assert.deepEqual(selectRoleInferenceProfile(
  { mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" },
  { inheritedModel: "provider/parent", inheritedThinkingLevel: "high", env: {} },
), { selectedModel: "provider/parent", fallbackModel: "provider/parent", selectedThinkingLevel: "high", modelPolicySource: "inherit", thinkingPolicySource: "inherit" });
assert.deepEqual(selectRoleInferenceProfile(
  { mode: "preferred", preference: "provider/role", fallback: "inherit", thinkingLevel: "medium" },
  { inheritedModel: "provider/parent", inheritedThinkingLevel: "high", env: {} },
), { selectedModel: "provider/role", fallbackModel: "provider/parent", selectedThinkingLevel: "medium", modelPolicySource: "preferred", thinkingPolicySource: "contract" });
const roleEnv = { PI_ROLE_MODEL_EVIDENCE_AUDITOR: "provider/auditor", PI_ROLE_THINKING_EVIDENCE_AUDITOR: "xhigh" };
assert.deepEqual(selectRoleInferenceProfile(
  { mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" },
  { roleId: "evidence-auditor", inheritedModel: "provider/parent", inheritedThinkingLevel: "low", env: roleEnv },
), { selectedModel: "provider/auditor", fallbackModel: "provider/parent", selectedThinkingLevel: "xhigh", modelPolicySource: "environment", thinkingPolicySource: "environment" });
assert.equal(roleModelEnvName("evidence-auditor"), "PI_ROLE_MODEL_EVIDENCE_AUDITOR");
assert.equal(roleThinkingEnvName("evidence-auditor"), "PI_ROLE_THINKING_EVIDENCE_AUDITOR");
assert.throws(() => selectRoleInferenceProfile({ mode: "preferred", preference: "provider/role:low", fallback: "inherit", thinkingLevel: "low" }, { inheritedModel: "provider/parent", inheritedThinkingLevel: "high", env: {} }), /thinkingLevel separately/i);
assert.throws(() => selectRoleInferenceProfile({ mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" }, { roleId: "worker", inheritedModel: "provider/parent", inheritedThinkingLevel: "high", env: { PI_ROLE_THINKING_WORKER: "turbo" } }), /invalid thinking level/i);
assert.throws(() => selectRoleInferenceProfile({ mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" }, { inheritedModel: "provider/parent", env: {} }), /resolved thinking level/i);
assert.throws(() => validateRoleContract({ ...coder, roleId: "bad-thinking", modelPolicy: { ...coder.modelPolicy, thinkingLevel: "turbo" } }), /invalid thinking policy/i);

const descriptor = roleDescriptor(registry.get("worker"));
assert.match(descriptor.revision, /^sha256:[a-f0-9]{64}$/);
assert.equal(descriptor.systemPrompt, undefined, "role discovery does not expose system prompts");
const workerRevision = roleRevisionHash(registry.get("worker"));
const promptOnly = narrowRoleContract(registry.get("worker"), { systemPrompt: "Inspect only the explicitly named path." });
assert.notEqual(roleRevisionHash(promptOnly), workerRevision, "task-scope refinements change the privacy-safe role revision without exposing prompt text");
const refinement = registry.refine("worker", { toolPolicy: { allowedTools: ["read", "submit_role_result"], deniedTools: ["edit", "write", "bash", "grep", "find", "ls"] }, budget: { maxToolCalls: 8 }, systemPrompt: "Inspect only the explicitly named file." }, { reviewed: true, reason: "bounded fixture refinement" });
assert.equal(refinement.changed, true);
assert.deepEqual(registry.get("worker").toolPolicy.allowedTools, ["read", "submit_role_result"]);
assert.equal(registry.history("worker").length, 1);
assert(registry.history("worker")[0].changedFields.includes("taskScope"));
assert(!JSON.stringify(registry.history("worker")).includes("Inspect only"), "role history stores metadata rather than prompt bodies");
assert.throws(() => registry.refine("worker", { toolPolicy: { allowedTools: ["read", "bash", "submit_role_result"] } }, { reviewed: true, reason: "attempted broadening" }), /broadens/i);
const rolledBack = registry.rollbackRefinement("worker", workerRevision, { reviewed: true });
assert.equal(rolledBack.rolledBack, true);
assert.equal(roleRevisionHash(registry.get("worker")), workerRevision);

console.log("role contract tests passed");
