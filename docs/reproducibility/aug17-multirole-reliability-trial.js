#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../../");
const { applyHarnessEnvironmentDefaults } = require(path.join(root, "src/harness-environment.js"));
applyHarnessEnvironmentDefaults({ root });
process.env.PI_ROLE_RUNTIME_VERSION = "2";
process.env.PI_ROLE_MUTATION = "off";
process.env.PI_ROLE_ROLLOUT_STAGE = "R0";
process.env.PI_ROLE_FIELD_PILOT = "1";
process.env.PI_TOPOLOGY_AUTO_ROUTE = "suggest";
process.env.PI_SUBAGENT_RPC_CONCURRENCY = "2";

const { AgentRoleRegistry } = require(path.join(root, "src/multi-agent-topologies.js"));
const { SubagentStore, SubagentService } = require(path.join(root, "src/subagents.js"));
const { SessionBranchManager, SnapshotStore } = require(path.join(root, "src/session-branches.js"));
const { ROLE_RUN_SCHEMA_VERSION, sanitizeRoleRunRecord } = require(path.join(root, "src/role-run-provenance.js"));
const { classifyRoleTerminal, determineRoleRunEligibility, summarizeRoleFieldEvidence } = require(path.join(root, "src/role-field-evidence.js"));
const { runtimeSourceFingerprint } = require(path.join(root, "src/runtime-source-fingerprint.js"));

const experimentId = String(process.env.PI_AUG17_EXPERIMENT_ID || "exp-full-reliability-plan-august-17");
const runKey = `aug17-multirole-full-plan-${Date.now()}`;
const stateRoot = path.join(root, ".pi", "role-runtime", "pilots", runKey);
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(stateRoot, 0o700);

const source = runtimeSourceFingerprint(root);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const beforeStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
const registry = new AgentRoleRegistry();
const store = new SubagentStore({ cwd: root, dir: path.join(stateRoot, "subagents") });
const branchManager = new SessionBranchManager({ cwd: root, store: new SnapshotStore(path.join(stateRoot, "branches")) });
const service = new SubagentService({ cwd: root, store, branchManager, config: { maxConcurrentPerParent: 64 } });

const profiles = {
  worker: ["openai-codex/gpt-5.6-luna", "low"],
  researcher: ["openai-codex/gpt-5.6-sol", "medium"],
  planner: ["openai-codex/gpt-5.6-sol", "xhigh"],
  reviewer: ["openai-codex/gpt-5.6-sol", "xhigh"],
  "evidence-auditor": ["openai-codex/gpt-5.6-sol", "xhigh"],
};

const specs = [
  { id: "worker-profile", role: "worker", task: "Read only config/harness-defaults.env. Report the exact PI_ROLE_MODEL_WORKER and PI_ROLE_THINKING_WORKER values with repository-path evidence.", required: ["openai-codex/gpt-5.6-luna", "low", "config/harness-defaults.env"], sources: ["config/harness-defaults.env"] },
  { id: "worker-schema", role: "worker", task: "Read only src/role-run-provenance.js. Report the exact ROLE_RUN_SCHEMA_VERSION and cite the repository path.", required: ["4", "src/role-run-provenance.js"], sources: ["src/role-run-provenance.js"] },
  { id: "worker-controls", role: "worker", task: "Read only config/harness-defaults.env. Report the exact PI_ROLE_MUTATION, PI_ROLE_ROLLOUT_STAGE, and PI_TOPOLOGY_AUTO_ROUTE values with path evidence.", required: ["off", "R0", "suggest", "config/harness-defaults.env"], sources: ["config/harness-defaults.env"] },
  { id: "worker-reviewer-budget", role: "worker", task: "Read only src/role-contracts.js. Report the reviewer maxModelCalls value and cite the repository path.", required: ["8", "src/role-contracts.js"], sources: ["src/role-contracts.js"] },
  { id: "worker-validator", role: "worker", task: "Read only src/subagent-result-validator.js. Report the canonical error code mapped from provider_error and cite the repository path.", required: ["SUBAGENT_PROVIDER_ERROR", "src/subagent-result-validator.js"], sources: ["src/subagent-result-validator.js"] },
  { id: "worker-planner-profile", role: "worker", task: "Read only config/harness-defaults.env. Report the planner model and thinking level with path evidence.", required: ["openai-codex/gpt-5.6-sol", "xhigh", "config/harness-defaults.env"], sources: ["config/harness-defaults.env"] },
  { id: "worker-profile-repeat", role: "worker", task: "Read only config/harness-defaults.env. Report the exact worker model and thinking level, with repository-path evidence and no unrelated claims.", required: ["openai-codex/gpt-5.6-luna", "low", "config/harness-defaults.env"], sources: ["config/harness-defaults.env"] },
  { id: "worker-schema-repeat", role: "worker", task: "Read only src/role-run-provenance.js. Return the role-run schema version and source path, with no unrelated claims.", required: ["4", "src/role-run-provenance.js"], sources: ["src/role-run-provenance.js"] },

  { id: "research-profiles-a", role: "researcher", task: "Compare only config/harness-defaults.env and src/role-contracts.js. Report the worker and researcher model/thinking profiles and cite both paths. Distinguish configured facts from inference.", required: ["gpt-5.6-luna", "low", "gpt-5.6-sol", "medium", "config/harness-defaults.env", "src/role-contracts.js"], sources: ["config/harness-defaults.env", "src/role-contracts.js"] },
  { id: "research-logging-a", role: "researcher", task: "Inspect only src/subagents.js and src/subagent-result-validator.js. Summarize how failed role runs persist termination and diagnostic accounting, citing both paths.", required: ["termination", "diagnostics", "src/subagents.js", "src/subagent-result-validator.js"], sources: ["src/subagents.js", "src/subagent-result-validator.js"] },
  { id: "research-rollout-a", role: "researcher", task: "Inspect only config/harness-defaults.env and src/role-runtime-rollout.js. Report the current role mutation, rollout, router, and read-only pilot settings and cite both paths.", required: ["off", "R0", "suggest", "PI_ROLE_FIELD_PILOT", "config/harness-defaults.env", "src/role-runtime-rollout.js"], sources: ["config/harness-defaults.env", "src/role-runtime-rollout.js"] },
  { id: "research-concurrency-a", role: "researcher", task: "Inspect only config/harness-defaults.env and docs/subagents.md. Report the canonical RPC sidecar concurrency and confirm that separate sessions have no shared job-count admission limit, citing both paths.", required: ["2", "PI_SUBAGENT_RPC_CONCURRENCY", "no shared job-count admission limit", "config/harness-defaults.env", "docs/subagents.md"], sources: ["config/harness-defaults.env", "docs/subagents.md"] },
  { id: "research-profiles-b", role: "researcher", task: "Independently verify the worker and researcher role model/thinking profiles using config/harness-defaults.env and src/role-contracts.js. Cite both paths and report uncertainty explicitly.", required: ["gpt-5.6-luna", "low", "gpt-5.6-sol", "medium", "config/harness-defaults.env", "src/role-contracts.js"], sources: ["config/harness-defaults.env", "src/role-contracts.js"] },
  { id: "research-logging-b", role: "researcher", task: "Independently inspect src/subagents.js and src/subagent-result-validator.js for failed-run termination and accounting persistence. Cite both paths.", required: ["termination", "diagnostics", "src/subagents.js", "src/subagent-result-validator.js"], sources: ["src/subagents.js", "src/subagent-result-validator.js"] },
  { id: "research-rollout-b", role: "researcher", task: "Independently verify current role rollout containment from config/harness-defaults.env and src/role-runtime-rollout.js. Cite both paths.", required: ["off", "R0", "suggest", "PI_ROLE_FIELD_PILOT", "config/harness-defaults.env", "src/role-runtime-rollout.js"], sources: ["config/harness-defaults.env", "src/role-runtime-rollout.js"] },
  { id: "research-concurrency-b", role: "researcher", task: "Independently verify canonical RPC concurrency and the absence of a shared job-count admission limit from config/harness-defaults.env and docs/subagents.md. Cite both paths.", required: ["2", "PI_SUBAGENT_RPC_CONCURRENCY", "no shared job-count admission limit", "config/harness-defaults.env", "docs/subagents.md"], sources: ["config/harness-defaults.env", "docs/subagents.md"] },

  { id: "plan-stale-record-a", role: "planner", task: "Create a bounded read-only implementation plan for detecting and reporting abandoned running subagent records without deleting them. Inspect src/subagents.js and docs/subagents.md, cite both, and include roadmapPlan milestones and goals. Do not mutate files.", required: ["src/subagents.js", "docs/subagents.md"], sources: ["src/subagents.js", "docs/subagents.md"], requireRoadmap: true },
  { id: "plan-field-cohort-a", role: "planner", task: "Create a bounded read-only implementation plan for repeatable current-source role field audits. Inspect scripts/audit-role-runtime.js and src/role-field-evidence.js, cite both, and include roadmapPlan milestones and goals. Do not mutate files.", required: ["scripts/audit-role-runtime.js", "src/role-field-evidence.js"], sources: ["scripts/audit-role-runtime.js", "src/role-field-evidence.js"], requireRoadmap: true },
  { id: "plan-concurrency-a", role: "planner", task: "Create a bounded read-only implementation plan for an unwrapped two-sidecar concurrency regression. Inspect tests/subagents.test.js and src/resource-guard.js, cite both, and include roadmapPlan milestones and goals. Do not mutate files.", required: ["tests/subagents.test.js", "src/resource-guard.js"], sources: ["tests/subagents.test.js", "src/resource-guard.js"], requireRoadmap: true },
  { id: "plan-stale-record-b", role: "planner", task: "Independently plan a non-destructive abandoned-subagent reporting feature using src/subagents.js and docs/subagents.md. Cite both and return roadmapPlan milestones/goals. Do not mutate files.", required: ["src/subagents.js", "docs/subagents.md"], sources: ["src/subagents.js", "docs/subagents.md"], requireRoadmap: true },
  { id: "plan-field-cohort-b", role: "planner", task: "Independently plan repeatable schema-v4 field cohort collection using scripts/audit-role-runtime.js and src/role-field-evidence.js. Cite both and return roadmapPlan milestones/goals. Do not mutate files.", required: ["scripts/audit-role-runtime.js", "src/role-field-evidence.js"], sources: ["scripts/audit-role-runtime.js", "src/role-field-evidence.js"], requireRoadmap: true },
  { id: "plan-concurrency-b", role: "planner", task: "Independently plan a direct foreground concurrency regression using tests/subagents.test.js and src/resource-guard.js. Cite both and return roadmapPlan milestones/goals. Do not mutate files.", required: ["tests/subagents.test.js", "src/resource-guard.js"], sources: ["tests/subagents.test.js", "src/resource-guard.js"], requireRoadmap: true },

  { id: "review-profile-a", role: "reviewer", task: "Review only the worker and reviewer inference-profile consistency across config/harness-defaults.env, src/role-contracts.js, and tests/role-reasoning-policy.test.js. Report evidence-backed findings without inventing defects and cite all three paths.", required: ["gpt-5.6-luna", "low", "gpt-5.6-sol", "xhigh", "config/harness-defaults.env", "src/role-contracts.js", "tests/role-reasoning-policy.test.js"], sources: ["config/harness-defaults.env", "src/role-contracts.js", "tests/role-reasoning-policy.test.js"] },
  { id: "review-telemetry-a", role: "reviewer", task: "Review only schema-v4 role-run telemetry and its privacy tests in src/role-run-provenance.js and tests/role-runtime-benchmark.test.js. Report evidence-backed findings and cite both paths.", required: ["4", "src/role-run-provenance.js", "tests/role-runtime-benchmark.test.js"], sources: ["src/role-run-provenance.js", "tests/role-runtime-benchmark.test.js"] },
  { id: "review-profile-b", role: "reviewer", task: "Independently review worker/reviewer model and thinking consistency across config/harness-defaults.env, src/role-contracts.js, and tests/role-reasoning-policy.test.js. Cite all three paths and do not invent defects.", required: ["gpt-5.6-luna", "low", "gpt-5.6-sol", "xhigh", "config/harness-defaults.env", "src/role-contracts.js", "tests/role-reasoning-policy.test.js"], sources: ["config/harness-defaults.env", "src/role-contracts.js", "tests/role-reasoning-policy.test.js"] },
  { id: "review-telemetry-b", role: "reviewer", task: "Independently review schema-v4 role-run provenance and privacy coverage in src/role-run-provenance.js and tests/role-runtime-benchmark.test.js. Cite both paths.", required: ["4", "src/role-run-provenance.js", "tests/role-runtime-benchmark.test.js"], sources: ["src/role-run-provenance.js", "tests/role-runtime-benchmark.test.js"] },

  { id: "audit-profiles-a", role: "evidence-auditor", task: "Audit two labeled claims using only config/harness-defaults.env: claim-true says worker uses openai-codex/gpt-5.6-luna at low thinking; claim-false says reviewer uses Luna at low thinking. Return claims, evidenceRefs, auditDecisions accepting claim-true and rejecting claim-false, plus required coverage fields. Cite the path.", required: ["claim-true", "claim-false", "config/harness-defaults.env"], sources: ["config/harness-defaults.env"], decisions: { "claim-true": "accepted", "claim-false": "rejected" } },
  { id: "audit-controls-a", role: "evidence-auditor", task: "Audit two labeled claims using src/role-run-provenance.js and config/harness-defaults.env: schema-true says ROLE_RUN_SCHEMA_VERSION is 4; mutation-false says PI_ROLE_MUTATION is isolated. Return claims, evidenceRefs, auditDecisions accepting schema-true and rejecting mutation-false, plus required coverage fields. Cite both paths.", required: ["schema-true", "mutation-false", "src/role-run-provenance.js", "config/harness-defaults.env"], sources: ["src/role-run-provenance.js", "config/harness-defaults.env"], decisions: { "schema-true": "accepted", "mutation-false": "rejected" } },
  { id: "audit-profiles-b", role: "evidence-auditor", task: "Independently audit using only config/harness-defaults.env: claim-true says worker is Luna/low; claim-false says reviewer is Luna/low. Return typed claims, evidenceRefs, accepting/rejecting auditDecisions, rejectedClaims, unresolvedGaps, and coverage. Cite the path.", required: ["claim-true", "claim-false", "config/harness-defaults.env"], sources: ["config/harness-defaults.env"], decisions: { "claim-true": "accepted", "claim-false": "rejected" } },
  { id: "audit-controls-b", role: "evidence-auditor", task: "Independently audit using src/role-run-provenance.js and config/harness-defaults.env: schema-true says role-run schema is 4; mutation-false says role mutation is isolated. Return typed accepting/rejecting decisions, rejectedClaims, unresolvedGaps, and coverage. Cite both paths.", required: ["schema-true", "mutation-false", "src/role-run-provenance.js", "config/harness-defaults.env"], sources: ["src/role-run-provenance.js", "config/harness-defaults.env"], decisions: { "schema-true": "accepted", "mutation-false": "rejected" } },
];
const requestedCaseIds = new Set(String(process.env.PI_AUG17_TRIAL_CASE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const activeSpecs = requestedCaseIds.size ? specs.filter((spec) => requestedCaseIds.has(spec.id)) : specs;
if (requestedCaseIds.size > 0 && requestedCaseIds.size !== activeSpecs.length) throw new Error("PI_AUG17_TRIAL_CASE_IDS contains an unknown case");
if (activeSpecs.length === 0 || activeSpecs.length % 2 !== 0) throw new Error("August 17 trial requires a nonempty even case count");

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] : null;
}
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function camel(diagnostics, camelName, snakeName) { return diagnostics?.[camelName] ?? diagnostics?.[snakeName]; }
function resolveChildSessionFile(file, directory) {
  if (typeof file === "string" && fs.existsSync(file)) return file;
  if (typeof directory !== "string" || !fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(directory, name)).find((candidate) => fs.existsSync(candidate)) || null;
}
function firstSessionTimestamp(file) {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n").find(Boolean);
    return Date.parse(JSON.parse(first).timestamp);
  } catch { return NaN; }
}
function hasForbiddenKey(value) {
  const forbidden = new Set(["prompt", "systemPrompt", "task", "transcript", "messages", "toolOutput", "privateReasoning", "final_response", "finalResponse", "providerPayload"]);
  let found = false;
  const visit = (item) => {
    if (found || !item || typeof item !== "object") return;
    if (Array.isArray(item)) return item.forEach(visit);
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) { found = true; return; }
      visit(child);
    }
  };
  visit(value);
  return found;
}
function claimSupport(submitted, allowedSources) {
  const refs = new Map((submitted?.evidenceRefs || []).map((ref) => [String(ref?.id || ""), ref]));
  const accepted = (submitted?.claims || []).filter((claim) => claim?.status === "accepted");
  let unsupported = 0;
  for (const claim of accepted) {
    const linked = (claim.evidenceRefs || []).map((id) => refs.get(String(id))).filter(Boolean);
    if (!linked.length || !linked.some((ref) => allowedSources.some((source) => String(ref.source || "").includes(source)))) unsupported += 1;
  }
  return unsupported;
}
function decisionParity(submitted, expected = {}) {
  if (!Object.keys(expected).length) return true;
  const decisions = new Map((submitted?.auditDecisions || []).map((row) => [String(row?.claimId || ""), row?.decision]));
  return Object.entries(expected).every(([claimId, decision]) => decisions.get(claimId) === decision);
}

async function concurrencyProbe() {
  const probeRoot = path.join(stateRoot, "concurrency-probe");
  fs.mkdirSync(probeRoot, { recursive: true, mode: 0o700 });
  const startsFile = path.join(probeRoot, "starts.jsonl");
  const releaseFile = path.join(probeRoot, "release");
  const fakeRpc = path.join(probeRoot, "blocking-rpc.js");
  fs.writeFileSync(fakeRpc, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(startsFile)}, JSON.stringify({ at: Date.now(), pid: process.pid }) + "\\n");
let buffer = "";
const messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "probe complete" }], timestamp: Date.now() }];
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function endWhenReleased() { const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(releaseFile)})) return; clearInterval(timer); emit({ type: "agent_end", messages }); }, 10); }
process.stdin.on("data", (chunk) => { buffer += chunk.toString("utf8"); for (;;) { const index = buffer.indexOf("\\n"); if (index < 0) break; const raw = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!raw) continue; const event = JSON.parse(raw); if (event.type === "prompt") { emit({ type: "response", id: event.id, success: true }); endWhenReleased(); } else if (event.type === "get_state") emit({ type: "response", id: event.id, success: true, data: { sessionFile: null, isStreaming: false } }); else if (event.type === "get_messages") emit({ type: "response", id: event.id, success: true, data: { messages } }); } });
`, { mode: 0o600 });
  const probeStore = new SubagentStore({ cwd: root, dir: path.join(probeRoot, "subagents") });
  const probeBranches = new SessionBranchManager({ cwd: root, store: new SnapshotStore(path.join(probeRoot, "branches")) });
  const probeService = new SubagentService({ cwd: root, store: probeStore, branchManager: probeBranches, config: { maxConcurrentPerParent: 8 } });
  const children = Array.from({ length: 4 }, (_, index) => probeService.createSubagent({ parentSessionId: "aug17-concurrency-probe", task: `probe-${index}` }));
  const promises = children.map((child) => probeService.runSubagent({ subagentId: child.id, context: { executionMode: "tool-rpc", cwd: root, rpc: { command: process.execPath, argsPrefix: [fakeRpc], noSession: true, noExtensions: true, noSkills: true, timeoutMs: 10000 } } }));
  const deadline = Date.now() + 5000;
  let beforeRelease = 0;
  while (Date.now() < deadline) {
    beforeRelease = fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").trim().split(/\n+/).filter(Boolean).length : 0;
    if (beforeRelease >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fs.writeFileSync(releaseFile, "release\n", { mode: 0o600 });
  const results = await Promise.all(promises);
  const starts = fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").trim().split(/\n+/).filter(Boolean) : [];
  if (fs.existsSync(startsFile)) fs.chmodSync(startsFile, 0o600);
  return {
    configuredRpcConcurrency: Number(process.env.PI_SUBAGENT_RPC_CONCURRENCY),
    startsBeforeRelease: beforeRelease,
    totalStarts: starts.length,
    succeeded: results.filter((result) => result.status === "succeeded").length,
    finalStatuses: results.map((result) => result.status),
    passed: beforeRelease === 2 && starts.length === 4 && results.every((result) => result.status === "succeeded"),
  };
}

const rows = [];
const sanitizedRuns = [];
async function execute(spec, index) {
  const contract = registry.get(spec.role);
  const parentSessionId = `${runKey}-${index}`;
  const subagent = service.createSubagent({
    parentSessionId,
    role: contract.roleId,
    task: spec.task,
    roleContract: contract,
    systemPrompt: contract.systemPrompt,
    toolPolicy: contract.toolPolicy,
    modelPolicy: contract.modelPolicy,
    workspacePolicy: contract.workspacePolicy,
    mutationPolicy: contract.mutationPolicy,
    budget: contract.budget,
    mergePolicy: "none",
    metadata: { roleResolution: "registered", experimentId },
  });
  const result = await service.runSubagent({
    subagentId: subagent.id,
    context: {
      cwd: root,
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      executionMode: "tool-rpc",
      rpc: { sessionDir: path.join(stateRoot, "child-sessions", subagent.id), concurrency: 2 },
    },
  });
  const record = service.store.get(subagent.id);
  const diagnostics = result.diagnostics || {};
  const submitted = result.submitted_result || {};
  const publicResult = JSON.stringify(submitted);
  const expectedProfile = profiles[spec.role];
  const selectedModel = camel(diagnostics, "selectedModel", "selected_model");
  const effectiveModel = camel(diagnostics, "effectiveModel", "effective_model");
  const selectedThinkingLevel = camel(diagnostics, "selectedThinkingLevel", "selected_thinking_level");
  const effectiveThinkingLevel = camel(diagnostics, "effectiveThinkingLevel", "effective_thinking_level");
  const toolCalls = finite(camel(diagnostics, "toolCalls", "tool_calls"));
  const toolResults = finite(camel(diagnostics, "toolResults", "tool_results"));
  const modelCalls = finite(camel(diagnostics, "modelCalls", "model_calls"));
  const toolFailures = finite(camel(diagnostics, "toolFailures", "tool_failures"));
  const blockedToolCalls = finite(diagnostics.blockedToolCalls);
  const accountedToolResults = finite(diagnostics.accountedToolResults ?? toolResults);
  const queueWaitMs = finite(camel(diagnostics, "queueWaitMs", "queue_wait_ms"));
  const executionDurationMs = finite(camel(diagnostics, "executionDurationMs", "execution_duration_ms"));
  const totalDurationMs = finite(camel(diagnostics, "totalDurationMs", "total_duration_ms"));
  const reportedChildSessionFile = camel(diagnostics, "piSessionFile", "pi_session_file");
  const childSessionDir = camel(diagnostics, "rpcSessionDir", "rpc_session_dir");
  const childSessionFile = resolveChildSessionFile(reportedChildSessionFile, childSessionDir);
  const childResolved = typeof childSessionFile === "string" && fs.existsSync(childSessionFile);
  const typedValid = result.status === "succeeded"
    && result.schemaVersion === 2
    && result.contractVersion === "role-v2"
    && result.termination?.code === "submitted"
    && submitted.status === "succeeded";
  const accountingValid = toolCalls != null && toolResults != null && accountedToolResults != null && toolCalls === accountedToolResults
    && Array.isArray(diagnostics.unmatchedToolCallIds || diagnostics.unmatched_tool_call_ids)
    && (diagnostics.unmatchedToolCallIds || diagnostics.unmatched_tool_call_ids).length === 0;
  const telemetryPresent = [modelCalls, toolCalls, toolResults, toolFailures, queueWaitMs, executionDurationMs, totalDurationMs].every((value) => value != null)
    && Boolean(result.termination?.code) && typeof result.termination?.message === "string";
  const profileParity = selectedModel === expectedProfile[0] && effectiveModel === expectedProfile[0]
    && selectedThinkingLevel === expectedProfile[1] && effectiveThinkingLevel === expectedProfile[1];
  const expectedPassed = result.status === "succeeded"
    && spec.required.every((value) => publicResult.includes(value))
    && (!spec.requireRoadmap || Boolean(submitted.roadmapPlan?.milestones?.length))
    && decisionParity(submitted, spec.decisions);
  const unsupportedAcceptedClaims = claimSupport(submitted, spec.sources);
  const mutationViolation = result.proposedPatch != null || diagnostics.workspace?.policy !== "shared-readonly" || diagnostics.workspace?.changedPaths?.length > 0;
  const errors = Array.isArray(diagnostics.errors) ? diagnostics.errors : [];
  const failureLoggingComplete = result.status === "succeeded" || (Boolean(result.status) && Boolean(result.termination?.code) && Boolean(result.termination?.message) && errors.length > 0 && childResolved);
  const terminalCategory = classifyRoleTerminal({ status: result.status, termination: result.termination, typedResultValid: typedValid });
  const roleRun = sanitizeRoleRunRecord({
    schemaVersion: ROLE_RUN_SCHEMA_VERSION,
    roleRunSchemaVersion: ROLE_RUN_SCHEMA_VERSION,
    roleRuntimeVersion: 2,
    contractVersion: "role-v2",
    resultSchemaVersion: 2,
    runtimeSourceHash: source.hash,
    at: record.finishedAt,
    source: "aug17-current-source-live-trial-full-reliability-plan",
    roleId: spec.role,
    roleResolution: "registered",
    status: result.status,
    terminalCategory,
    typedResultValid: typedValid,
    accountingValid,
    mutationMode: "shared-readonly",
    fixture: false,
    eligibleLive: true,
    eligibilityReason: "eligible-live-read-only",
    parentSessionId,
    subagentId: subagent.id,
    branchId: subagent.branchId,
    modelPreference: contract.modelPreference,
    selectedModel,
    effectiveModel,
    fallbackModel: camel(diagnostics, "fallbackModel", "fallback_model"),
    modelPolicySource: camel(diagnostics, "modelPolicySource", "model_policy_source"),
    selectedThinkingLevel,
    effectiveThinkingLevel,
    thinkingPolicySource: camel(diagnostics, "thinkingPolicySource", "thinking_policy_source"),
    effectiveProfileObserved: diagnostics.effectiveProfileObserved === true,
    childSessionResolved: childResolved,
    toolPolicy: contract.toolPolicy,
    workspace: { policy: "shared-readonly", retained: false, changedPaths: [] },
    childSessionFile,
    childSessionDir,
    termination: result.termination,
    budget: contract.budget,
    modelCalls,
    toolCalls,
    toolResults,
    toolFailures,
    blockedToolCalls,
    accountedToolResults,
    queueWaitMs,
    executionDurationMs,
    totalDurationMs,
    wallClockBudgetMs: finite(camel(diagnostics, "wallClockBudgetMs", "wall_clock_budget_ms")),
    taskHash: sha256(spec.task),
    resultHash: sha256(JSON.stringify({ status: result.status, termination: result.termination?.code, submitted })),
  });
  const eligibility = determineRoleRunEligibility(roleRun);
  sanitizedRuns.push(roleRun);
  const row = {
    index,
    caseId: spec.id,
    role: spec.role,
    status: result.status,
    termination: result.termination?.code || null,
    typedValid,
    accountingValid,
    telemetryPresent,
    profileParity,
    expectedPassed,
    unsupportedAcceptedClaims,
    mutationViolation,
    failureLoggingComplete,
    childResolved,
    childSession: childSessionFile ? path.relative(stateRoot, childSessionFile) : null,
    eligibleTelemetry: eligibility.eligible,
    eligibilityReason: eligibility.reason,
    selectedModel,
    effectiveModel,
    selectedThinkingLevel,
    effectiveThinkingLevel,
    modelCalls,
    toolCalls,
    toolResults,
    toolFailures,
    blockedToolCalls,
    accountedToolResults,
    queueWaitMs,
    executionDurationMs,
    totalDurationMs,
    childStartedAtMs: childResolved ? firstSessionTimestamp(childSessionFile) : null,
    finishedAtMs: Date.parse(record.finishedAt),
  };
  rows.push(row);
  process.stdout.write(`${JSON.stringify({ index, caseId: spec.id, role: spec.role, status: row.status, termination: row.termination, typedValid, accountingValid, profileParity, expectedPassed, durationMs: totalDurationMs })}\n`);
  return row;
}

(async () => {
  const concurrency = await concurrencyProbe();
  process.stdout.write(`${JSON.stringify({ concurrencyProbe: concurrency })}\n`);
  const batches = [];
  for (let offset = 0; offset < activeSpecs.length; offset += 2) {
    const started = Date.now();
    const pair = await Promise.all([execute(activeSpecs[offset], offset), execute(activeSpecs[offset + 1], offset + 1)]);
    const wallMs = Date.now() - started;
    const overlapMs = Math.max(0, Math.min(...pair.map((row) => row.finishedAtMs)) - Math.max(...pair.map((row) => row.childStartedAtMs)));
    batches.push({ batch: offset / 2, indexes: pair.map((row) => row.index), wallMs, overlapMs, overlapped: overlapMs > 0 });
  }
  rows.sort((a, b) => a.index - b.index);
  sanitizedRuns.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const afterStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const fieldEvidence = summarizeRoleFieldEvidence(sanitizedRuns, { runtimeSourceHash: source.hash, generatedAt: new Date().toISOString() });
  const byRole = {};
  for (const role of Object.keys(profiles)) {
    const roleRows = rows.filter((row) => row.role === role);
    byRole[role] = {
      total: roleRows.length,
      succeeded: roleRows.filter((row) => row.status === "succeeded").length,
      successRate: roleRows.length ? roleRows.filter((row) => row.status === "succeeded").length / roleRows.length : null,
      expectedAnswerRate: roleRows.length ? roleRows.filter((row) => row.expectedPassed).length / roleRows.length : null,
      p95DurationMs: percentile(roleRows.map((row) => row.totalDurationMs), 0.95),
    };
  }
  const successCount = rows.filter((row) => row.status === "succeeded").length;
  const timeoutCount = rows.filter((row) => row.status === "timed_out").length;
  const nonSuccess = rows.filter((row) => row.status !== "succeeded");
  const summary = {
    schemaVersion: 1,
    experimentId,
    candidate: {
      change: "full reliability plan: role-specific strict schemas, exact completion guidance, blocked-call accounting, failure provenance, and stale lifecycle controls",
      predecessorEvidence: ".pi/role-runtime/pilots/aug17-multirole-fix1-1786970338612/report.json",
    },
    generatedAt: new Date().toISOString(),
    gitHead: head,
    runtimeSourceHash: source.hash,
    runtimeFileCount: source.fileCount,
    execution: { outerManager: "none", directForeground: true, rpcConcurrency: 2, batchSize: 2 },
    exactRuns: rows.length,
    succeeded: successCount,
    failed: rows.filter((row) => row.status === "failed").length,
    timedOut: timeoutCount,
    successRate: successCount / rows.length,
    timeoutRate: timeoutCount / rows.length,
    typedValidityRate: rows.filter((row) => row.typedValid).length / rows.length,
    accountingParityRate: rows.filter((row) => row.accountingValid).length / rows.length,
    telemetryPresenceRate: rows.filter((row) => row.telemetryPresent).length / rows.length,
    profileParityRate: rows.filter((row) => row.profileParity).length / rows.length,
    expectedAnswerRate: rows.filter((row) => row.expectedPassed).length / rows.length,
    childSessionResolutionRate: rows.filter((row) => row.childResolved).length / rows.length,
    eligibleTelemetryRate: rows.filter((row) => row.eligibleTelemetry).length / rows.length,
    unsupportedAcceptedClaims: rows.reduce((sum, row) => sum + row.unsupportedAcceptedClaims, 0),
    falseSuccesses: rows.filter((row) => row.status === "succeeded" && !row.typedValid).length,
    mutationViolations: rows.filter((row) => row.mutationViolation).length,
    failureLoggingCompleteRate: nonSuccess.length ? nonSuccess.filter((row) => row.failureLoggingComplete).length / nonSuccess.length : 1,
    nonterminalRecords: service.store.list().filter((record) => !["succeeded", "failed", "timed_out", "cancelled"].includes(record.status)).length,
    parentTreeChanged: beforeStatus !== afterStatus,
    p50DurationMs: percentile(rows.map((row) => row.totalDurationMs), 0.5),
    p95DurationMs: percentile(rows.map((row) => row.totalDurationMs), 0.95),
    totalModelCalls: rows.reduce((sum, row) => sum + (row.modelCalls || 0), 0),
    totalToolCalls: rows.reduce((sum, row) => sum + (row.toolCalls || 0), 0),
    totalToolResults: rows.reduce((sum, row) => sum + (row.toolResults || 0), 0),
    totalToolFailures: rows.reduce((sum, row) => sum + (row.toolFailures || 0), 0),
    byRole,
    concurrency: {
      deterministicProbe: concurrency,
      livePairs: batches.length,
      livePairsOverlapped: batches.filter((batch) => batch.overlapped).length,
      liveOverlapRate: batches.filter((batch) => batch.overlapped).length / batches.length,
      p50OverlapMs: percentile(batches.map((batch) => batch.overlapMs), 0.5),
      p95PairWallMs: percentile(batches.map((batch) => batch.wallMs), 0.95),
    },
    fieldEvidence,
    rows,
    batches,
    privacy: {
      containsTasks: false,
      containsPrompts: false,
      containsTranscripts: false,
      containsToolOutput: false,
      containsPrivateReasoning: false,
      forbiddenKeysPresent: false,
    },
  };
  summary.privacy.forbiddenKeysPresent = hasForbiddenKey({ rows: summary.rows, batches: summary.batches, fieldEvidence: summary.fieldEvidence, roleRuns: sanitizedRuns });
  const detailedFile = path.join(stateRoot, "report.json");
  const roleRunsFile = path.join(stateRoot, "role-runs.jsonl");
  fs.writeFileSync(roleRunsFile, `${sanitizedRuns.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  fs.writeFileSync(detailedFile, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(roleRunsFile, 0o600);
  fs.chmodSync(detailedFile, 0o600);
  const fullCohort = activeSpecs.length === specs.length;
  const roleRatesPass = Object.values(byRole).filter((role) => role.total > 0).every((role) => role.successRate >= 0.75);
  const expectedHead = String(process.env.PI_AUG17_EXPECTED_HEAD || "");
  if (!expectedHead) throw new Error("PI_AUG17_EXPECTED_HEAD is required for exact-source provenance");
  const commonPassed = head === expectedHead
    && rows.length === activeSpecs.length
    && summary.unsupportedAcceptedClaims === 0
    && summary.falseSuccesses === 0
    && summary.mutationViolations === 0
    && summary.accountingParityRate === 1
    && summary.telemetryPresenceRate === 1
    && summary.profileParityRate === 1
    && summary.childSessionResolutionRate === 1
    && summary.eligibleTelemetryRate === 1
    && summary.privacy.forbiddenKeysPresent === false
    && concurrency.passed
    && summary.concurrency.liveOverlapRate === 1
    && summary.failureLoggingCompleteRate === 1
    && summary.nonterminalRecords === 0
    && summary.parentTreeChanged === false;
  const passed = commonPassed && (fullCohort
    ? rows.length >= 30 && summary.successRate >= 0.90 && summary.timeoutRate <= 0.05 && roleRatesPass && summary.p95DurationMs <= 120000 && summary.typedValidityRate >= 0.95 && summary.expectedAnswerRate >= 0.90
    : summary.successRate === 1 && summary.timeoutRate === 0 && summary.typedValidityRate === 1 && summary.expectedAnswerRate === 1);
  const publicSummary = {
    output: path.relative(root, detailedFile),
    roleRuns: path.relative(root, roleRunsFile),
    verdict: passed ? "pass" : "fail",
    trialKind: fullCohort ? "full" : "pilot",
    gitHead: summary.gitHead,
    runtimeSourceHash: summary.runtimeSourceHash,
    exactRuns: summary.exactRuns,
    succeeded: summary.succeeded,
    failed: summary.failed,
    timedOut: summary.timedOut,
    successRate: summary.successRate,
    timeoutRate: summary.timeoutRate,
    typedValidityRate: summary.typedValidityRate,
    accountingParityRate: summary.accountingParityRate,
    telemetryPresenceRate: summary.telemetryPresenceRate,
    profileParityRate: summary.profileParityRate,
    expectedAnswerRate: summary.expectedAnswerRate,
    childSessionResolutionRate: summary.childSessionResolutionRate,
    eligibleTelemetryRate: summary.eligibleTelemetryRate,
    unsupportedAcceptedClaims: summary.unsupportedAcceptedClaims,
    falseSuccesses: summary.falseSuccesses,
    mutationViolations: summary.mutationViolations,
    failureLoggingCompleteRate: summary.failureLoggingCompleteRate,
    nonterminalRecords: summary.nonterminalRecords,
    parentTreeChanged: summary.parentTreeChanged,
    p50DurationMs: summary.p50DurationMs,
    p95DurationMs: summary.p95DurationMs,
    byRole: summary.byRole,
    concurrency: summary.concurrency,
    fieldEvidence: { sample: summary.fieldEvidence.sample, metrics: summary.fieldEvidence.metrics, gatePassed: summary.fieldEvidence.gatePassed },
    privacy: summary.privacy,
  };
  process.stdout.write(`${JSON.stringify(publicSummary)}\n`);
  process.exitCode = passed ? 0 : 1;
})().catch((error) => {
  const failureFile = path.join(stateRoot, "fatal-error.json");
  fs.writeFileSync(failureFile, `${JSON.stringify({ name: error?.name, code: error?.code, message: error?.message, stack: String(error?.stack || "").split("\n").slice(0, 12) }, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
